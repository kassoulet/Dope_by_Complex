/*
 * dope/part2run.mjs -- boot part 2 from its own block and run it in the rig.
 *
 *   node tools/part2run.mjs                                  # 10 blits, 4e9 instructions
 *   node tools/part2run.mjs --max-inst 8e9 --blits 20 --out build/out/p2
 *   node tools/part2run.mjs --dump-image build/out/p2.img    # the relocated image
 *
 * Unlike `tools/vmrun.mjs` this needs no snapshot: everything it uses comes out
 * of `build/block02_00f66c.bin`.  What the loader does to that block is now
 * known exactly (28 words, all `+ (part_segment - 0x10)`), and all of it is
 * reproduced here:
 *
 *   * 23 `push imm` immediates that are popped into ds/es/fs/gs (0x500, 0x194a,
 *     0x1984, ...).  Checked against the frozen part: every one matches.
 *   * the four entry pairs of the two sub-pixel phase tables at cs:0x400 and
 *     cs:0x408 (texture and shade segment per phase).
 *   * the object list at cs:0x1810: 0x3a byte records whose *first word* is the
 *     segment its geometry lives in (0x1e71 -> 0x2dec, 0x2121 -> 0x309c for a
 *     part at 0xf8b).  These two words are the two blobs of the credits.
 *
 * and one register the loader sets but the part never does: **gs must be the
 * part's data segment** (`part + 0x2ccd - 0x10`).  On entry nothing sets it,
 * and `0x354a` writes the polygon list terminator through it -- with gs wrong
 * that write lands in the part's code, the list is never terminated and the
 * sorter at `0x3585` walks memory for ever.  That is why an earlier rig run
 * executed 4e9 instructions without a single write to video memory.
 *
 * A frame is written when the blit at `0x36f6` (`rep movsd` from the screen
 * buffer to A0000) has finished -- `0x36f9` is the instruction after it -- so
 * the pictures are what the card would scan out at that instant, in the part's
 * own DAC.  The index bytes are written next to each PNG (`*.idx`) because the
 * fade ramp lives in the palette: comparing indices is how a frame is checked
 * against a reference without the ramp's phase getting in the way.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Machine } from '../web/js/vm/machine.js';
import { encodePNG, indexedToRGB } from './png.mjs';

export const BLOCK = 'build/block02_00f66c.bin';
export const PART_SEGMENT = 0xf8b;
export const ENTRY = 0x386c - 0x100;
export const COUNTER = 0x1928;

// Where the loader leaves things, from the frozen part (docs/RUNTIME.md).
export const DATA_SEGMENT = 0x2ccd; // the polygon list, `push 0x2ccd` in the code
export const OBJECT_LIST = 0x1810;
export const OBJECT_BYTES = 0x3a;
export const BLIT_END = 0x36f9; // the instruction after the blit's `rep movsd`

/** The part image as the loader would leave it, in a fresh megabyte of RAM. */
export function loadImage(block, segment = PART_SEGMENT) {
  const mem = new Uint8Array(1 << 20);
  mem.set(block.subarray(0x100), segment * 16);
  const add = segment - 0x10;
  const inBlock = (v) => v >= 0x100 && v * 16 + 0x10 < block.length;
  const bump = (at) => {
    const w = mem[at] | (mem[at + 1] << 8);
    if (!inBlock(w)) return false;
    const v = (w + add) & 0xffff;
    mem[at] = v & 0xff;
    mem[at + 1] = v >> 8;
    return true;
  };
  const base = segment * 16;
  let code = 0;
  for (let i = base; i < base + block.length - 0x100 - 6; i++) {
    if (mem[i] !== 0x68) continue; // push imm16
    const next = mem[i + 3];
    const pop = next === 0x1f || next === 0x07 ||
      (next === 0x0f && (mem[i + 4] === 0xa1 || mem[i + 4] === 0xa4 ||
        mem[i + 4] === 0xa8 || mem[i + 4] === 0xa9));
    if (pop && bump(i + 1)) code++;
  }
  let tables = 0;
  for (let k = 0; k < 4; k++) {
    if (bump(base + 0x400 + k * 2)) tables++;
    if (bump(base + 0x408 + k * 2)) tables++;
  }
  let objects = 0;
  for (let n = 0; n < 64; n++) {
    const at = base + OBJECT_LIST + n * OBJECT_BYTES;
    const w = mem[at] | (mem[at + 1] << 8);
    if (w === 0) break;
    if (w !== 0xffff) { bump(at); objects++; }
  }
  return { mem, code, tables, objects };
}

export function boot(image, meta) {
  const m = new Machine();
  // Mode 13h is a linear 320x200 screen here: no pixel panning (the part keeps
  // the panning register clear and moves the picture with the CRTC start).
  m.vga.layout = 'nopan';
  m.boot(image, meta);
  // The one register the loader sets and the part does not.
  m.cpu.sreg[5] = (meta.part_segment + DATA_SEGMENT - 0x10) & 0xffff;
  return m;
}

function main(argv) {
  const opts = {
    block: BLOCK, out: 'build/out/p2', blits: 10, maxInst: 4e9, quote: 0,
    dump: null, segment: PART_SEGMENT, quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--block') opts.block = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--blits') opts.blits = parseInt(argv[++i], 10);
    else if (a === '--max-inst') opts.maxInst = Number(argv[++i]);
    else if (a === '--segment') opts.segment = parseInt(argv[++i], 16);
    else if (a === '--quote') opts.quote = parseInt(argv[++i], 10);
    else if (a === '--dump-image') opts.dump = argv[++i];
    else if (a === '--quiet') opts.quiet = true;
  }

  const block = new Uint8Array(readFileSync(opts.block));
  const { mem, code, tables, objects } = loadImage(block, opts.segment);
  if (!opts.quiet) {
    console.log(`block ${opts.block}  ${block.length} bytes  part segment ${opts.segment.toString(16)}`);
    console.log(`loader relocation: ${code} code immediates, ${tables} phase entries, ${objects} object records`);
  }
  if (opts.dump) {
    writeFileSync(opts.dump, mem);
    console.log('wrote ' + opts.dump);
    return 0;
  }

  const m = boot(mem, { part_segment: opts.segment, entry: ENTRY, counter_offset: COUNTER });
  const cpu = m.cpu;
  mkdirSync(opts.out, { recursive: true });

  const step = cpu.step.bind(cpu);
  let blits = 0;
  let insts = 0;
  let drawSeen = false;
  const started = Date.now();
  cpu.step = function () {
    if (this.ip === 0x3310) drawSeen = true;
    if (this.ip === BLIT_END) {
      blits++;
      const counter = m.counter();
      const name = join(opts.out,
        `p2_${String(blits).padStart(3, '0')}_c${String(counter).padStart(5, '0')}`);
      const idx = Buffer.from(m.vga.pixels.subarray(0, 320 * 200));
      writeFileSync(name + '.idx', idx);
      writeFileSync(name + '.png', encodePNG(320, 200, indexedToRGB(idx, m.vga.pal, 320, 200)));
      if (!opts.quiet) {
        let nz = 0;
        for (const v of idx) if (v) nz++;
        console.log(`blit ${blits}  counter ${counter}  insts ${(insts / 1e6).toFixed(1)}M` +
          `  ${((Date.now() - started) / 1000).toFixed(1)}s  non-black ${nz}` +
          `  colours ${new Set(idx).size}`);
      }
    }
    step();
    insts++;
  };

  while (insts < opts.maxInst && blits < opts.blits && !m.stopped && !m.exited) {
    cpu.step();
    m.tick();
  }
  if (!opts.quiet) {
    console.log(`stopped after ${(insts / 1e6).toFixed(0)}M instructions: ${blits} blits` +
      `, counter ${m.counter()}, draw seen ${drawSeen}, exited ${m.exited}` +
      `, ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  writeFileSync(join(opts.out, 'run.txt'),
    `blits ${blits}\ninsts ${insts}\ncounter ${m.counter()}\ndraw_seen ${drawSeen}\n` +
    `exited ${m.exited}\ncode ${code}\ntables ${tables}\nobjects ${objects}\n`);
  return blits ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('part2run.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
