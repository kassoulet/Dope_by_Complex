/*
 * dope/difftrace.mjs -- dump the rig's state at a point in part 2 and trace
 * what its CPU does next, for tools/diffcheck.py (Unicorn) to compare.
 *
 *   node tools/difftrace.mjs --at 26c6 --skip 0 --n 300000 --out build/diff
 *
 * Runs part 2 from its own block (as part2frames.mjs does) until cs:ip first
 * equals `--at` (after `--skip` earlier hits), writes build/diff/state.json
 * and mem.bin, then records the state after each of the next `--n`
 * instructions into trace.bin (Int32 rows of 16: ip cs ds es fs gs ss eax ecx
 * edx ebx esp ebp esi edi flags).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Machine } from './vm/machine.js';
import { loadImage, PART_SEGMENT, ENTRY, COUNTER, BLOCK } from './part2run.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const at = parseInt(arg('at', '26c6'), 16);
let skip = parseInt(arg('skip', '0'), 10);
const n = parseInt(arg('n', '300000'), 10);
const out = arg('out', 'build/diff');
mkdirSync(out, { recursive: true });

const block = new Uint8Array(readFileSync(BLOCK));
const image = loadImage(block, PART_SEGMENT);
const m = new Machine();
m.vga.layout = 'nopan';
m.boot(image.mem, { part_segment: PART_SEGMENT, entry: ENTRY, counter_offset: COUNTER });
m.cpu.sreg[5] = (PART_SEGMENT + 0x2ccd - 0x10) & 0xffff;
const cpu = m.cpu;
const out8 = m.out8.bind(m);
m.out8 = (p, v) => { if (p === 0x40 || p === 0x43) return; out8(p, v); };
m.pitDiv = 1e12; m.pitCount = 1e12;

const flags = () => (cpu.cf | (cpu.pf << 2) | (cpu.af << 4) | (cpu.zf << 6) | (cpu.sf << 7) | (cpu.df << 10) | (cpu.of << 11)) >>> 0;
const row = (o, rows, k) => {
  const b = k * 16;
  rows[b] = cpu.ip; rows[b + 1] = cpu.sreg[1]; rows[b + 2] = cpu.sreg[3]; rows[b + 3] = cpu.sreg[0];
  rows[b + 4] = cpu.sreg[4]; rows[b + 5] = cpu.sreg[5]; rows[b + 6] = cpu.sreg[2];
  for (let i = 0; i < 8; i++) rows[b + 7 + i] = cpu.r[i];
  rows[b + 15] = flags();
};

let steps = 0;
for (; steps < 4e9; steps++) {
  if (cpu.ip === at && skip-- <= 0) break;
  cpu.step(); m.clock++; m.vga.clock = m.clock;
}
if (cpu.ip !== at) { console.error('never reached ' + at.toString(16)); process.exit(1); }
const state = {}; row(null, Int32Array.prototype, 0);
const start = new Int32Array(16); row(null, start, 0);
writeFileSync(out + '/state.json', JSON.stringify({ steps, regs: Array.from(start) }));
writeFileSync(out + '/mem.bin', m.mem);
const rows = new Int32Array(16 * n);
const writes = [];
let curK = 0;
for (const [name, size] of [['write8', 1], ['write16', 2], ['write32', 4]]) {
  const orig = cpu[name].bind(cpu);
  cpu[name] = (a, v) => { if (writes.length < 4e5) writes.push([curK, a & 0xfffff, size, size === 4 ? v >>> 0 : v & ((1 << (size * 8)) - 1)]); orig(a, v); };
}
let k = 0;
for (; k < n; k++) {
  curK = k;
  cpu.step(); m.clock++; m.vga.clock = m.clock;
  row(null, rows, k);
}
writeFileSync(out + '/writes.json', JSON.stringify(writes));
writeFileSync(out + '/trace.bin', Buffer.from(rows.buffer));
console.log(`reached ${at.toString(16)} after ${steps} steps; traced ${n} instructions`);
