/*
 * dope/part2frames.mjs -- render part 2 from DOPE.EXE, one frame per timer tick.
 *
 *   node tools/part2frames.mjs --frames 60 --out build/out/p2frames
 *   node tools/part2frames.mjs --frames 438 --out build/out/p2frames --png-every 10
 *
 * `tools/part2run.mjs` runs the part with the machine's timer free-running, so
 * the counter advances while a frame is being drawn: one blit then covers 100
 * to 200 counter values, and the animation state changes *during* the draw.
 * That is fine for "does the engine complete", but it cannot reproduce a frame
 * of the original.  Here the PIT is held off and the part's own frame hook
 * (cs:0x2580, the far pointer at cs:0x1a09) is called once, at the top of the
 * screen routine's wait for it.  The draw then runs with the state frozen, and
 * the counter advances by exactly one per blit -- one frame, as on the 486.
 *
 * The clock still advances (the VGA retrace bit is what the setup waits on),
 * but no timer interrupt is delivered, so the hook is the only thing that
 * moves the animation.  Nothing is emulated that the part does not do itself:
 * the picture is the part's own code writing A0000 through the rig's VGA.
 *
 * Frame files are named by the *global* frame number and the part's counter,
 * because the counter restarts at every `show` in the script:
 *
 *   f0001_c00001.idx   one byte per pixel, 320x200
 *   f0001_c00001.pal   the DAC at that instant (768 bytes, 6 bit)
 *   f0001_c00001.png   the same frame through that DAC
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Machine } from '../web/js/vm/machine.js';
import { encodePNG, indexedToRGB } from './png.mjs';
import { loadImage, PART_SEGMENT, ENTRY, COUNTER, BLOCK } from './part2run.mjs';

const W = 320;
const H = 200;
const SHOW_WAIT = 0x360c; // block 0x370c: wait for [cs:0x1924] != 0
const BLIT_END = 0x36f9;  // block 0x36f9: the instruction after the blit

/**
 * Run part 2 and hand every completed frame to `onFrame`.
 *
 * `onFrame({ index, counter, pixels, palette, machine })` is called right after
 * the blit to A0000, so `pixels` is what the card would scan out.  Return false
 * to stop early.
 */
export function renderPart2Frames(block, { maxFrames = 60, onFrame } = {}) {
  const image = loadImage(block, PART_SEGMENT);
  const m = new Machine();
  m.vga.layout = 'nopan';
  m.boot(image.mem, { part_segment: PART_SEGMENT, entry: ENTRY, counter_offset: COUNTER });
  m.cpu.sreg[5] = (PART_SEGMENT + 0x2ccd - 0x10) & 0xffff;
  const cpu = m.cpu;
  const cs = PART_SEGMENT * 16;

  // The part reloads the PIT from its own calibration; keep those writes away
  // from the machine so no interrupt is delivered between frames.  The VGA
  // clock is advanced by the loop below instead, for the retrace waits.
  const out8 = m.out8.bind(m);
  m.out8 = (port, value) => {
    if (port === 0x40 || port === 0x43) return; // PIT: no ticks
    out8(port, value);
  };
  m.pitDiv = 1e12;
  m.pitCount = 1e12;

  let index = 0;
  let stopped = false;
  const step = cpu.step.bind(cpu);
  cpu.step = function () {
    if (this.ip === SHOW_WAIT && cpu.read32(cs + 0x1924) === 0) {
      // Call the part's own frame hook the way its ISR does: a far call, whose
      // retf returns to the waiting instruction.
      const hook = cpu.read32(cs + 0x1a09);
      if ((hook >>> 16) === PART_SEGMENT) {
        this.push(this.sreg[1], 2);
        this.push(SHOW_WAIT, 2);
        this.ip = hook & 0xffff;
      }
    }
    if (this.ip === BLIT_END) {
      index++;
      const frame = {
        index,
        counter: cpu.read32(cs + 0x1928),
        pixels: m.vga.pixels.slice(0, W * H),
        palette: m.vga.pal.slice(),
        machine: m,
      };
      if (onFrame && onFrame(frame) === false) stopped = true;
    }
    step();
  };

  while (!stopped && index < maxFrames && !m.stopped && !m.exited) {
    cpu.step();
    m.clock++;
    m.vga.clock = m.clock;
  }
  return { frames: index, machine: m, exited: m.exited };
}

function main(argv) {
  const opts = { block: BLOCK, out: 'build/out/p2frames', frames: 60, pngEvery: 1, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--block') opts.block = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--frames') opts.frames = parseInt(argv[++i], 10);
    else if (a === '--png-every') opts.pngEvery = Math.max(1, parseInt(argv[++i], 10));
    else if (a === '--quiet') opts.quiet = true;
  }
  const block = new Uint8Array(readFileSync(opts.block));
  mkdirSync(opts.out, { recursive: true });
  const started = Date.now();
  let last = null;
  const result = renderPart2Frames(block, {
    maxFrames: opts.frames,
    onFrame(frame) {
      const stem = `f${String(frame.index).padStart(4, '0')}_c${String(frame.counter).padStart(5, '0')}`;
      writeFileSync(join(opts.out, stem + '.idx'), Buffer.from(frame.pixels));
      writeFileSync(join(opts.out, stem + '.pal'), Buffer.from(frame.palette));
      if (frame.index % opts.pngEvery === 0) {
        writeFileSync(join(opts.out, stem + '.png'),
          encodePNG(W, H, indexedToRGB(frame.pixels, frame.palette, W, H)));
      }
      last = frame;
      if (!opts.quiet) {
        let ink = 0;
        for (const v of frame.pixels) if (v) ink++;
        console.log(`frame ${frame.index}  counter ${frame.counter}  ink ${ink}` +
          `  ${(Date.now() - started) / 1000}s`);
      }
    },
  });
  if (!opts.quiet) {
    console.log(`stopped after ${result.frames} frames (counter ${last ? last.counter : 0})` +
      ` in ${((Date.now() - started) / 1000).toFixed(1)}s; exited ${result.exited}`);
  }
  return result.frames ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('part2frames.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
