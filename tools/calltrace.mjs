/*
 * Which routines does a part call, and when?  Runs a part through the
 * interpreter and records every near/far call: target, how many times, first
 * and last tick, instructions spent inside (inclusive).
 *   node tools/calltrace.mjs <block> [ticks] [ipt]
 * Addresses are block file offsets (segment offset + 0x100).
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { findBlocks } from '../web/js/rnc.js';
import { PartRunner } from './vm/partvm.js';

const n = Number(process.argv[2]);
const ticks = Number(process.argv[3] || 600);
const ipt = Number(process.argv[4] || 100000);
const blocks = findBlocks(new Uint8Array(readFileSync('DOPE.EXE'))).map((b) => b.data);
const table = JSON.parse(readFileSync('web/data/parts.json', 'utf8'));
const p = table.parts.find((q) => q.block === n);
const scr = p.screen ? (() => { const d = inflateRawSync(readFileSync('web/data/' + p.screen)); return { pixels: d.subarray(0, 64000), pal: d.subarray(64000, 64768) }; })() : null;
const r = new PartRunner(blocks[n], p, scr, null, { jit: false });
const c = r.m.cpu, mem = c.mem;
const stats = new Map();
const stack = [];
const step = c.step.bind(c);
let isr = 0;
c.step = function () {
  const lin = ((c.sreg[1] << 4) + c.ip) & 0xfffff;
  let i = lin; while ([0x66, 0x67, 0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0xf2, 0xf3].includes(mem[i])) i++;
  const op = mem[i];
  const before = c.insts;
  const from = c.ip;
  let target = -1, kind = '';
  if (op === 0xe8) { target = (c.ip + (i - lin) + 3 + (((mem[i + 1] | (mem[i + 2] << 8)) << 16) >> 16)) & 0xffff; kind = 'near'; }
  const ret = op === 0xc3 || op === 0xcb || op === 0xc2 || op === 0xcf;
  const ok = step();
  if (target >= 0) { stack.push({ target, at: before, tick: r.tick }); }
  if (ret && stack.length) {
    const f = stack.pop();
    const k = (f.target + 0x100).toString(16);
    let s = stats.get(k);
    if (!s) { s = { calls: 0, insts: 0, first: f.tick, last: f.tick }; stats.set(k, s); }
    s.calls++; s.insts += c.insts - f.at; s.last = f.tick;
  }
  return ok;
};
for (let i = 0; i < ticks && !r.exited; i++) { r.deliverTick(); r.run(ipt); }
const rows = [...stats.entries()].sort((a, b) => b[1].insts - a[1].insts).slice(0, 30);
console.log('target   calls   inclusive instrs   first..last tick');
for (const [k, s] of rows) console.log(k.padEnd(8), String(s.calls).padStart(7), String(s.insts).padStart(14), `   ${s.first}..${s.last}`);
