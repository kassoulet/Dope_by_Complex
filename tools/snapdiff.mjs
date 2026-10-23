/*
 * dope/snapdiff.mjs -- compare the rig's memory with the DOSBox-X snapshot of a
 * part at the moment it installs its timer interrupt.
 *
 *   node tools/snapdiff.mjs 6 [--snap build/snap]
 *
 * Both are the same code from the same block, so any region that differs is
 * either state the loader provided (data we do not set up) or an interpreter
 * bug.  Prints the differing ranges, merged.
 */
import { readFileSync } from 'node:fs';
import { makePart } from './partrun.mjs';

const n = parseInt(process.argv[2], 10);
const i = process.argv.indexOf('--snap');
const snap = i < 0 ? 'build/snap' : process.argv[i + 1];
const mem = new Uint8Array(readFileSync(`${snap}/block${n}.mem`));
const meta = JSON.parse(readFileSync(`${snap}/block${n}.json`, 'utf8'));
const arg = (k) => { const j = process.argv.indexOf('--' + k); return j < 0 ? null : process.argv[j + 1]; };
const left = arg('mem-init') ? new Uint8Array(readFileSync(arg('mem-init'))) : null;
const sc = arg('init') ? readFileSync(arg('init')) : null;
const { m } = makePart(n, { ipt: 1e12, left, screen: sc ? { pixels: sc.subarray(0, 64000), pal: sc.subarray(64000, 64768) } : null });
const c = m.cpu;
let steps = 0;
while (steps < 5e7 && (c.read32(0x20) >>> 16) !== 0xf8b) { c.step(); m.tick(); steps++; }
console.log(`block ${n}: ISR installed after ${steps} instructions (vector ${c.read32(0x20).toString(16)}), snapshot isr ${meta.isr_off.toString(16)}`);
const ranges = [];
let start = -1;
const lo = 0xf8b0;               // the part and everything above it (below is DOS)
const hi = 0xa0000;
for (let a = lo; a <= hi; a++) {
  const d = a < hi && m.mem[a] !== mem[a];
  if (d && start < 0) start = a;
  if (!d && start >= 0) { ranges.push([start, a]); start = -1; }
}
// merge ranges closer than 16 bytes
const merged = [];
for (const r of ranges) {
  const last = merged[merged.length - 1];
  if (last && r[0] - last[1] < 16) last[1] = r[1]; else merged.push([r[0], r[1]]);
}
let total = 0;
for (const r of merged) total += r[1] - r[0];
console.log(`${merged.length} differing ranges, ${total} bytes (of the first 640 KB)`);
const seg = 0xf8b * 16;
for (const r of merged.slice(0, 40)) {
  console.log(`  ${r[0].toString(16)}..${r[1].toString(16)}  (${r[1] - r[0]} bytes)  part+${(r[0] - seg).toString(16)}`);
}
