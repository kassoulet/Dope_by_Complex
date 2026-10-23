/*
 * dope/difftrace2.mjs -- trace a whole part run from its boot, with the events
 * a replay in Unicorn needs (tools/diffcheck2.py).
 *
 *   node tools/difftrace2.mjs 6 --n 2000000 --ipt 100000 --out build/diff6
 *
 * Writes mem.bin (the memory at boot), state.json (registers at boot),
 * trace.bin (the state after each instruction, 16 int32 per row, as
 * difftrace.mjs), writes.json (every store: instruction, address, size,
 * value) and events.json:
 *   in:  [[instruction, port, size, value], ...]   what the port reads returned
 *   irq: [instruction, ...]                         timer interrupts taken before that instruction
 *   hle: [instruction, ...]                         int n instructions the rig handled itself
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { makePart } from './partrun.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const n = parseInt(process.argv[2], 10);
const N = parseInt(arg('n', '1000000'), 10);
const ipt = Number(arg('ipt', '100000'));
const out = arg('out', 'build/diff' + n);
mkdirSync(out, { recursive: true });

const { m } = makePart(n, { ipt });
const cpu = m.cpu;
const flags = () => (cpu.cf | (cpu.pf << 2) | (cpu.af << 4) | (cpu.zf << 6) | (cpu.sf << 7) | (cpu.df << 10) | (cpu.of << 11)) >>> 0;
const row = (rows, k) => {
  const b = k * 16;
  rows[b] = cpu.ip; rows[b + 1] = cpu.sreg[1]; rows[b + 2] = cpu.sreg[3]; rows[b + 3] = cpu.sreg[0];
  rows[b + 4] = cpu.sreg[4]; rows[b + 5] = cpu.sreg[5]; rows[b + 6] = cpu.sreg[2];
  for (let i = 0; i < 8; i++) rows[b + 7 + i] = cpu.r[i];
  rows[b + 15] = flags();
};
const start = new Int32Array(16); row(start, 0);
writeFileSync(out + '/state.json', JSON.stringify({ regs: Array.from(start), if: cpu.if }));
writeFileSync(out + '/mem.bin', m.mem);

let k = 0;
const ins = [], irq = [], hle = [], writes = [];
const origIn = cpu.in.bind(cpu);
cpu.in = (port, size) => { const v = origIn(port, size); ins.push([k, port, size, v >>> 0]); return v; };
for (const [name, size] of [['write8', 1], ['write16', 2], ['write32', 4]]) {
  const o = cpu[name].bind(cpu);
  cpu[name] = (a, v) => { if (writes.length < 1e6) writes.push([k, a & 0xfffff, size, size === 4 ? v >>> 0 : v & ((1 << (size * 8)) - 1)]); o(a, v); };
}
const oi = cpu.interrupt.bind(cpu);
cpu.interrupt = (nn) => {
  if (nn === 8 && cpu.ip !== undefined && m.ret && m.ret.ip === cpu.ip) { irq.push(k); return oi(nn); }
  const before = cpu.ip;
  oi(nn);
  if (cpu.ip === before + 0 || true) { /* software int handled in place has same ip */ }
  return;
};
// software interrupts the rig handles itself leave ip unchanged by the call: detect via onInt result
const onInt = cpu.onInt;
cpu.onInt = (nn, c) => { const r = onInt(nn, c); if (r === true) hle.push(k); return r; };

const rows = new Int32Array(16 * N);
for (; k < N && !m.exited; k++) {
  cpu.step(); m.tick();
  row(rows, k);
}
const used = rows.subarray(0, 16 * k);
writeFileSync(out + '/trace.bin', Buffer.from(used.buffer, 0, used.byteLength));
writeFileSync(out + '/writes.json', JSON.stringify(writes));
writeFileSync(out + '/events.json', JSON.stringify({ in: ins, irq, hle }));
console.log(`block ${n}: traced ${k} instructions, ${ins.length} port reads, ${irq.length} irqs, ${hle.length} hle ints`);
