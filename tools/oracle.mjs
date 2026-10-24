/*
 * dope/oracle.mjs -- the original code as a reference implementation.
 *
 * A port is checked against the machine code it came from: take the part's
 * state at some moment (memory, registers, card), run ONE original routine on
 * a copy of it, run the port on another copy, and compare everything the
 * routine could have written.  `callRoutine` is the first half of that.
 *
 *   const r = runPart(4, 1200);               // the part after 1200 ticks, interpreter, ipt 100000
 *   const a = clone(r);                       // copies of the whole machine
 *   callRoutine(a, 0x1c91, { near: true });   // run the original routine at block offset 0x1c91
 *   // ... run the port on clone(r).m.mem and compare
 *
 * All addresses are block file offsets (what a disassembly shows); the segment
 * offset is that minus 0x100.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { findBlocks } from '../web/js/rnc.js';
import { PartRunner, SEGMENT } from './vm/partvm.js';

let blocksCache = null;
export const blocks = () => (blocksCache ||= findBlocks(new Uint8Array(readFileSync('DOPE.EXE'))).map((b) => b.data));
export const table = () => JSON.parse(readFileSync('web/data/parts.json', 'utf8'));

export const specOf = (n) => table().parts.find((q) => q.block === n);
export function screenOf(spec) {
  if (!spec.screen) return null;
  const d = inflateRawSync(readFileSync('tests/data/' + spec.screen));
  return { pixels: d.subarray(0, 64000), pal: d.subarray(64000, 64768) };
}

/** A fresh runner for part `n` (interpreter: block exact timing). */
export function newPart(n) {
  const spec = specOf(n);
  return new PartRunner(blocks()[n], spec, screenOf(spec), null, { jit: false });
}

/** Run part `n` for `ticks` interrupts, `ipt` instructions apart (the schedule the pinned tests use). */
export function runPart(n, ticks, ipt = 100000) {
  const r = newPart(n);
  for (let i = 0; i < ticks && !r.exited; i++) { r.deliverTick(); r.run(ipt); }
  return r;
}

/** An independent copy of a runner: memory, CPU, card and timer state. */
export function clone(r) {
  const c = newPart(r.spec.block);
  const a = r.m, b = c.m;
  b.mem.set(a.mem);
  b.cpu.r.set(a.cpu.r);
  b.cpu.sreg.set(a.cpu.sreg);
  for (const f of ['ip', 'cf', 'pf', 'af', 'zf', 'sf', 'of', 'df', 'if', 'tf', 'insts']) b.cpu[f] = a.cpu[f];
  const va = a.vga, vb = b.vga;
  for (const f of ['pixels', 'pal', 'crtc', 'seq', 'gfx', 'attr']) vb[f].set(va[f]);
  for (const f of ['mode', 'dacIndex', 'dacPos', 'dacReadIndex', 'dacReadPos', 'crtcIndex', 'seqIndex', 'gfxIndex', 'attrIndex', 'attrFlip', 'misc', 'retraceFlip']) vb[f] = va[f];
  b.ret = a.ret ? { ...a.ret } : null;
  c.tick = r.tick;
  return c;
}

/**
 * Run the routine at block offset `at` to its return.  `regs` sets registers
 * first ({ ds, es, fs, gs, ax, bx, cx, dx, si, di, bp }); segment values are
 * absolute (already relocated).  `far` for a routine that ends in retf.
 * Returns the number of instructions executed.
 */
export function callRoutine(r, at, regs = {}, { far = false, max = 50e6 } = {}) {
  const c = r.m.cpu;
  const SENT = 0xfff0; // an address in the part's segment nothing executes
  const save = { ip: c.ip, cs: c.sreg[1] };
  c.sreg[1] = SEGMENT;
  if (far) c.push(SEGMENT, 2);
  c.push(SENT, 2);
  const idx = { ax: 0, cx: 1, dx: 2, bx: 3, sp: 4, bp: 5, si: 6, di: 7 };
  for (const [k, v] of Object.entries(regs)) {
    if (k in idx) c.r[idx[k]] = v >>> 0;
    else c.sreg[{ es: 0, cs: 1, ss: 2, ds: 3, fs: 4, gs: 5 }[k]] = v;
  }
  c.ip = at - 0x100;
  const start = c.insts;
  while (c.ip !== SENT) {
    c.step();
    if (c.insts - start > max) throw new Error('routine did not return');
  }
  void save;
  return c.insts - start;
}

/** First difference between two byte arrays over [from, to), or null. */
export function firstDiff(a, b, from = 0, to = a.length) {
  for (let i = from; i < to; i++) if (a[i] !== b[i]) return i;
  return null;
}

/** All differing ranges (merged when closer than `gap`), for a report. */
export function diffRanges(a, b, from = 0, to = a.length, gap = 16) {
  const out = [];
  let start = -1, last = -1;
  for (let i = from; i < to; i++) {
    if (a[i] !== b[i]) { if (start < 0) start = i; last = i; }
    else if (start >= 0 && i - last > gap) { out.push([start, last + 1]); start = -1; }
  }
  if (start >= 0) out.push([start, last + 1]);
  return out;
}
