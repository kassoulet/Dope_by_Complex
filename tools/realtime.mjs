/*
 * What the page's worker achieves in node: run a part against the wall clock,
 * one timer interrupt per 1/70.086 s, and count distinct pictures per second.
 *   node tools/realtime.mjs [seconds per part] [block...]
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { findBlocks } from '../web/js/rnc.js';
import { PartRunner, TICK_HZ } from './vm/partvm.js';

const secs = Number(process.argv[2] || 6);
const only = process.argv.slice(3).map(Number);
const blocks = findBlocks(new Uint8Array(readFileSync('DOPE.EXE'))).map((b) => b.data);
const table = JSON.parse(readFileSync('web/data/parts.json', 'utf8'));
for (const p of table.parts) {
  if (only.length && !only.includes(p.block)) continue;
  const scr = p.screen ? (() => { const d = inflateRawSync(readFileSync('web/data/' + p.screen)); return { pixels: d.subarray(0, 64000), pal: d.subarray(64000, 64768) }; })() : null;
  const r = new PartRunner(blocks[p.block], p, scr);
  // skip ahead 300 ticks quickly so we measure the part, not its setup
  for (let i = 0; i < 300; i++) { r.deliverTick(); r.run(1500); }
  const t0 = performance.now(), tick0 = r.tick;
  let pictures = 0, last = -1, insts0 = r.m.cpu.insts;
  const px = new Uint8Array(64000), pal = new Uint8Array(768);
  while (performance.now() - t0 < secs * 1000 && !r.exited) {
    const due = tick0 + Math.floor((performance.now() - t0) / 1000 * TICK_HZ);
    if (r.tick < due && r.deliverTick()) { r.run(4000); continue; }
    r.run(20000);
    r.snapshot(px, pal);
    let sum = 0; for (let i = 0; i < 64000; i += 7) sum = (sum * 31 + px[i]) | 0;
    if (sum !== last) { pictures++; last = sum; }
  }
  const dt = (performance.now() - t0) / 1000;
  console.log(`block ${p.block}: ${(pictures / dt).toFixed(1)} distinct pictures/s, ${((r.m.cpu.insts - insts0) / dt / 1e6).toFixed(0)} M instr/s (spins included), ticks ${r.tick - tick0} of ${(dt * TICK_HZ).toFixed(0)} due`);
}
