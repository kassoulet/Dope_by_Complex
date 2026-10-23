/*
 * dope/partrun.mjs -- run any demo part from its own block in the rig.
 *
 *   node tools/partrun.mjs 3 --frames 20 --out build/out/b3
 *   node tools/partrun.mjs 3 --ipt 20000 --max-inst 3e8
 *
 * The block is placed at the loader's segment, the 25-odd words the loader
 * relocates (tools/relocs.json, measured with tools/relocdiff.py against a
 * DOSBox-X snapshot of each part at its start) are patched, and the CPU starts
 * at the part's main function: the `push cs / call` run that ends in the
 * `int 21h` exit.  The timer is ours: one interrupt per `--ipt` instructions,
 * so the demo's clock is instructions, not wall time.  A frame is the picture
 * in A0000 once the part has written a screenful to it.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Machine } from '../web/js/vm/machine.js';
import { encodePNG, indexedToRGB } from './png.mjs';

export const SEGMENT = 0xf8b;

export function blockFile(n) {
  return 'build/' + readdirSync('build').find((f) => f.startsWith('block0' + n + '_'));
}

/** Start of the part's main: walk back from the exit over `push cs / call` runs. */
export function findEntry(block) {
  let exit = -1;
  for (let i = 0x200; i < block.length - 5; i++) {
    if ((block[i] === 0xb8 && block[i + 1] === 0 && block[i + 2] === 0x4c && block[i + 3] === 0xcd && block[i + 4] === 0x21) ||
        (block[i] === 0xb4 && block[i + 1] === 0x4c && block[i + 2] === 0x2e && block[i + 3] === 0xa0)) { exit = i; break; }
  }
  if (exit < 0) throw new Error('no exit found');
  let pos = exit;
  for (;;) {
    if (block[pos - 4] === 0x0e && block[pos - 3] === 0xe8) pos -= 4;
    else if (block[pos - 3] === 0xe8) pos -= 3;
    else break;
  }
  return pos;
}

export function loadImage(block, reloc, segment = SEGMENT) {
  const mem = new Uint8Array(1 << 20);
  mem.set(block.subarray(0x100), segment * 16);
  const add = segment - 0x10;
  for (const j of reloc) {
    const a = segment * 16 + j;
    const v = (mem[a] | (mem[a + 1] << 8)) + add;
    mem[a] = v & 0xff; mem[a + 1] = (v >> 8) & 0xff;
  }
  return mem;
}

/** The segment the part loads into gs (`push imm / pop gs`), which the loader leaves in gs. */
export function findGs(block) {
  for (let i = 0x100; i < block.length - 5; i++) {
    if (block[i] === 0x68 && block[i + 3] === 0x0f && block[i + 4] === 0xa9) return block[i + 1] | (block[i + 2] << 8);
  }
  return null;
}

export function makePart(n, { ipt = 20000, gs = null, screen = null, left = null } = {}) {
  const block = new Uint8Array(readFileSync(blockFile(n)));
  const relocs = JSON.parse(readFileSync('tools/relocs.json', 'utf8'))[String(n)];
  const mem = loadImage(block, relocs.reloc, SEGMENT, left);
  const entry = (relocs.entry ?? findEntry(block)) - 0x100;
  const m = new Machine();
  m.vga.layout = 'nopan';
  m.boot(mem, { part_segment: SEGMENT, entry, counter_offset: 0 });
  const g = gs !== null ? gs : (findGs(block) === null ? null : (findGs(block) + SEGMENT - 0x10) & 0xffff);
  if (g !== null) m.cpu.sreg[5] = g;
  // some parts keep their one-off setup in a far routine the loader calls first
  // (`cld / push cs / pop ds / call ... / retf`); run it, returning into the main entry
  if (relocs.init) {
    m.cpu.push(SEGMENT, 2); m.cpu.push(entry, 2);
    m.cpu.ip = relocs.init - 0x100;
  }
  // parts 5 and 6 never set the mode themselves: they inherit 13h from the part before
  if (n === 4 || n === 5 || n === 6) {
    m.vga.setMode(0x13);
    if (screen) { m.vga.pixels.set(screen.pixels, 0); m.vga.pal.set(screen.pal); }
  }
  const out8 = m.out8.bind(m);
  m.out8 = (p, v) => { if (p === 0x40 || p === 0x43) return; out8(p, v); };
  m.pitDiv = ipt; m.pitCount = ipt;
  return { m, entry };
}

function main(argv) {
  const n = parseInt(argv[0], 10);
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
  const frames = parseInt(opt('frames', '10'), 10);
  const ipt = Number(opt('ipt', '20000'));
  const maxInst = Number(opt('max-inst', '5e8'));
  const out = opt('out', 'build/out/b' + n);
  const gs = opt('gs', null);
  const quiet = argv.includes('--quiet');
  mkdirSync(out, { recursive: true });
  const initFile = opt('init', null);
  let screen = null;
  if (initFile) { const b = readFileSync(initFile); screen = { pixels: b.subarray(0, 64000), pal: b.subarray(64000, 64768) }; }
  const memInit = opt('mem-init', null);
  const left = memInit ? new Uint8Array(readFileSync(memInit)) : null;
  const { m, entry } = makePart(n, { ipt, gs: gs === null ? null : parseInt(gs, 16), screen, left });
  let ticks = 0;
  const oi = m.cpu.interrupt.bind(m.cpu);
  m.cpu.interrupt = (v) => { if (v === 8) ticks++; return oi(v); };
  console.log(`block ${n}: entry ${entry.toString(16)} (block ${(entry + 0x100).toString(16)})`);
  let written = 0, count = 0;
  const wv = m.writeVideo.bind(m);
  m.writeVideo = (o, v, s) => {
    wv(o, v, s);
    if (o < 64000) written += s;
    if (written >= 64000) {
      written = 0; count++;
      const px = m.vga.pixels.slice(0, 64000);
      let ink = 0; for (const b of px) if (b) ink++;
      if (count <= frames && !quiet) {
        writeFileSync(join(out, `f${String(count).padStart(4, '0')}.png`), encodePNG(320, 200, indexedToRGB(px, m.vga.pal, 320, 200)));
        console.log(`frame ${count}  inst ${(m.cpu.insts / 1e6).toFixed(1)}M  ink ${ink}`);
      }
    }
  };
  const t0 = Date.now();
  while (count < frames && m.cpu.insts < maxInst && !m.exited && !m.stopped) { m.cpu.step(); m.tick(); }
  const memDump = opt('mem-dump', null);
  if (memDump) writeFileSync(memDump, m.mem);
  const dump = opt('exit-dump', null);
  if (dump) {
    const b = Buffer.alloc(64768);
    b.set(m.vga.pixels.subarray(0, 64000), 0); b.set(m.vga.pal, 64000);
    writeFileSync(dump, b);
    writeFileSync(dump + '.json', JSON.stringify({ block: n, ticks, instructions: m.cpu.insts, exited: m.exited, frames: count, ipt }));
  }
  console.log(`ticks ${ticks}; stopped: ${count} frames, ${(m.cpu.insts / 1e6).toFixed(1)}M instructions, ${((Date.now() - t0) / 1000).toFixed(1)}s, exited ${m.exited}, log ${m.log.slice(0, 5)}`);
}
if (process.argv[1] && process.argv[1].endsWith('partrun.mjs')) main(process.argv.slice(2));
