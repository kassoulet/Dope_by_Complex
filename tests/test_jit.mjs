/*
 * The recompiler against the interpreter, on the real parts.
 *
 * Two copies of a part start identical.  One runs through the JIT, the other
 * through the interpreter for exactly the number of instructions the JIT
 * executed, with the timer interrupt delivered at the same points.  After each
 * run the registers, flags and (every few runs) the whole memory and the card
 * must be identical.  The first difference is reported with the address.
 *
 *   node tests/test_jit.mjs [runs per part]   (default 400 runs of 5000 instructions)
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findBlocks } from '../web/js/rnc.js';
import { PartRunner } from '../web/js/partvm.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const blocks = findBlocks(new Uint8Array(readFileSync(join(root, 'DOPE.EXE')))).map((b) => b.data);
const table = JSON.parse(readFileSync(join(root, 'web/data/parts.json'), 'utf8'));
const RUNS = Number(process.argv[2] || 400);
const only = process.argv[3] ? Number(process.argv[3]) : null;

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('ok   ' + name); } else { failed++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + detail)); }
};
const screen = (name) => {
  const d = inflateRawSync(readFileSync(join(root, 'web/data', name)));
  return { pixels: d.subarray(0, 64000), pal: d.subarray(64000, 64768) };
};
const FIELDS = ['ip', 'cf', 'pf', 'af', 'zf', 'sf', 'of', 'df', 'if'];

function compare(a, b, full) {
  const ca = a.m.cpu, cb = b.m.cpu;
  for (let i = 0; i < 8; i++) if (ca.r[i] !== cb.r[i]) return `r${i}: jit ${ca.r[i].toString(16)} interp ${cb.r[i].toString(16)}`;
  for (let i = 0; i < 6; i++) if (ca.sreg[i] !== cb.sreg[i]) return `sreg${i}: jit ${ca.sreg[i].toString(16)} interp ${cb.sreg[i].toString(16)}`;
  for (const f of FIELDS) if (ca[f] !== cb[f]) return `${f}: jit ${ca[f]} interp ${cb[f]}`;
  if (full) {
    const ma = ca.mem, mb = cb.mem;
    for (let i = 0; i < ma.length; i++) if (ma[i] !== mb[i]) return `memory ${i.toString(16)}: jit ${ma[i].toString(16)} interp ${mb[i].toString(16)}`;
    const pa = a.m.vga.pixels, pb = b.m.vga.pixels;
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return `card pixel ${i}: jit ${pa[i]} interp ${pb[i]}`;
    for (let i = 0; i < 768; i++) if (a.m.vga.pal[i] !== b.m.vga.pal[i]) return `DAC ${i}: jit ${a.m.vga.pal[i]} interp ${b.m.vga.pal[i]}`;
  }
  return null;
}

for (const p of table.parts) {
  if (only !== null && p.block !== only) continue;
  const mk = (jit) => new PartRunner(blocks[p.block], p, p.screen ? screen(p.screen) : null, null, { jit });
  const A = mk(true), B = mk(false);
  let err = null, at = 0, total = 0;
  for (let i = 0; i < RUNS && !err; i++) {
    // the same interrupt schedule on both: one tick every run, as the player does when catching up
    A.deliverTick(); B.deliverTick();
    const before = A.m.cpu.insts;
    A.run(5000);
    const k = A.m.cpu.insts - before;
    total += k;
    if (B.m.cpu.insts - 0 >= 0) B.run(k);
    at = i;
    err = compare(A, B, i % 25 === 24 || i === RUNS - 1);
    if (A.m.exited || B.m.exited) break;
  }
  ok(`block ${p.block}: jit == interpreter for ${(total / 1e6).toFixed(1)}M instructions (${A.jit.stats.compiled} blocks, ${A.jit.stats.invalidated} invalidated, ${A.jit.stats.interp} interpreted steps)`, !err, `run ${at}: ${err}`);
}
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
