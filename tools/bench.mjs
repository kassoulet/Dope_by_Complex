/*
 * How fast does a part run?  Instructions per second through the interpreter
 * and through the JIT, after the part has started drawing.
 *   node tools/bench.mjs [instructions per part, default 3e7]
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { findBlocks } from '../web/js/rnc.js';
import { PartRunner } from '../web/js/partvm.js';

const N = Number(process.argv[2] || 3e7);
const blocks = findBlocks(new Uint8Array(readFileSync('DOPE.EXE'))).map((b) => b.data);
const table = JSON.parse(readFileSync('web/data/parts.json', 'utf8'));
for (const p of table.parts) {
  const scr = p.screen ? (() => { const d = inflateRawSync(readFileSync('web/data/' + p.screen)); return { pixels: d.subarray(0, 64000), pal: d.subarray(64000, 64768) }; })() : null;
  const out = [];
  for (const jit of [false, true]) {
    const r = new PartRunner(blocks[p.block], p, scr, null, { jit });
    for (let i = 0; i < 600; i++) { r.deliverTick(); r.run(4000); } // get going
    const t0 = performance.now();
    const c0 = r.m.cpu.insts;
    let frames = 0;
    for (let i = 0; i < Math.min(N / 4000, 2400) && !r.exited; i++) { r.deliverTick(); r.run(4000); } // stay inside the part
    const dt = (performance.now() - t0) / 1000;
    out.push(`${jit ? 'jit' : 'interp'} ${((r.m.cpu.insts - c0) / dt / 1e6).toFixed(1)} MIPS` + (jit ? ` (${r.jit.stats.compiled} compiled, ${r.jit.stats.invalidated} invalidated, ${r.jit.stats.interp} interp steps)` : ''));
  }
  console.log(`block ${p.block}: ${out.join('   ')}`);
}
