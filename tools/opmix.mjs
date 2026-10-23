/*
 * Which instructions do the parts execute?  Histogram of opcodes (with the
 * ModRM reg field for group opcodes, and the operand size) over a stretch of
 * each part's run, to see what a faster executor has to cover.
 *   node tools/opmix.mjs [instructions per part]
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { findBlocks } from '../web/js/rnc.js';
import { PartRunner } from '../web/js/partvm.js';

const N = Number(process.argv[2] || 5e6);
const blocks = findBlocks(new Uint8Array(readFileSync('DOPE.EXE'))).map((b) => b.data);
const table = JSON.parse(readFileSync('web/data/parts.json', 'utf8'));
const total = new Map();
let all = 0;
for (const p of table.parts) {
  let screen = null;
  if (p.screen) { const d = inflateRawSync(readFileSync('web/data/' + p.screen)); screen = { pixels: d.subarray(0, 64000), pal: d.subarray(64000) }; }
  const r = new PartRunner(blocks[p.block], p, screen);
  const c = r.m.cpu;
  const mem = c.mem;
  const orig = c.opcode.bind(c);
  c.opcode = (b) => {
    let key = b.toString(16).padStart(2, '0');
    const ip = (c.sreg[1] << 4) + c.ip;
    if (b === 0x0f) key = '0f' + mem[ip & 0xfffff].toString(16).padStart(2, '0');
    else if ([0x80, 0x81, 0x83, 0xc0, 0xc1, 0xd0, 0xd1, 0xd2, 0xd3, 0xf6, 0xf7, 0xfe, 0xff].includes(b)) key += '/' + ((mem[ip & 0xfffff] >> 3) & 7);
    key += c.opsz === 4 ? ' o32' : '';
    if (c.rep) key += ' rep';
    total.set(key, (total.get(key) || 0) + 1);
    all++;
    return orig(b);
  };
  // skip the setup, then sample steady state
  for (let i = 0; i < 400; i++) { r.deliverTick(); r.run(5000); }
  for (let i = 0; i < N / 5000; i++) { r.deliverTick(); r.run(5000); }
}
const rows = [...total.entries()].sort((a, b) => b[1] - a[1]);
let cum = 0;
console.log('distinct', rows.length, 'total', all);
for (const [k, v] of rows.slice(0, 80)) { cum += v; console.log(k.padEnd(12), (100 * v / all).toFixed(2).padStart(6) + '%', (100 * cum / all).toFixed(1).padStart(6) + '%'); }
