/*
 * The rig's 32-bit divide, tested where part 2 uses it.
 *
 * Part 2's projection (block 0x1dfc/0x1e14) does
 *
 *     imul eax,[cs:0x191c]      ; 32 bit signed product
 *     idiv ebp                  ; EDX:EAX / signed depth
 *
 * and the dividend is negative for vertices in front of the camera.
 * `tools/vm/x86.js` combined EDX:EAX as an *unsigned* 64 bit number and only
 * then divided, which gives a quotient millions of times too large: the
 * renderer then filled 64 K pixel spans and a part 2 frame cost 3.5e8
 * instructions instead of 1.4e6.  These checks pin the signed pair.
 *
 *   node tests/test_x86.mjs
 */

import { Machine } from '../tools/vm/machine.js';

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('ok   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + detail)); }
}
function eq(name, got, want) {
  ok(name, got === want, `got ${got} want ${want}`);
}

/** Run `code` at 0100:0000 and return the CPU. */
function run(code) {
  const m = new Machine();
  m.mem.set(code, 0x1000);
  m.cpu.reset();
  for (let i = 0; i < 6; i++) m.cpu.sreg[i] = 0x0100;
  m.cpu.ip = 0;
  for (let i = 0; i < 5; i++) m.cpu.step();
  return m.cpu;
}

// mov eax,lo / mov edx,hi / mov ebp,divisor / idiv ebp / hlt
const idiv32 = (lo, hi, divisor) => run([
  0x66, 0xb8, lo & 0xff, (lo >> 8) & 0xff, (lo >> 16) & 0xff, (lo >>> 24) & 0xff,
  0x66, 0xba, hi & 0xff, (hi >> 8) & 0xff, (hi >> 16) & 0xff, (hi >>> 24) & 0xff,
  0x66, 0xbd, divisor & 0xff, (divisor >> 8) & 0xff, (divisor >> 16) & 0xff, (divisor >>> 24) & 0xff,
  0x66, 0xf7, 0xfd,
  0xf4,
]);

{
  // A real vertex from the first credits frame: X*4000 = -474,058,488,000 and
  // depth = -486,691,398, so the quotient is 974 and the remainder negative.
  const dividend = -474058488000n;
  const divisor = -486691398;
  const q = dividend / BigInt(divisor);
  const r = dividend % BigInt(divisor);
  const lo = Number(BigInt.asUintN(32, dividend));
  const hi = Number(BigInt.asUintN(32, dividend >> 32n));
  const cpu = idiv32(lo, hi, divisor);
  eq('32 bit signed idiv: negative dividend, negative divisor -> quotient', cpu.r[0] | 0, Number(q));
  eq('32 bit signed idiv: remainder has the dividend\'s sign', cpu.r[2] | 0, Number(r));
  ok('the quotient is a screen scale, not 2^32', (cpu.r[0] | 0) === 974, String(cpu.r[0] | 0));
}

{
  // The same pair with the high word cleared used to work, and still must.
  const cpu = idiv32(12345678, 0, 1000);
  eq('32 bit signed idiv: positive dividend', cpu.r[0] | 0, 12345);
  eq('32 bit signed idiv: positive remainder', cpu.r[2] | 0, 678);
}

{
  // The 16 bit path is separate code in div(); DX:AX = -100000, BX = -300,
  // so AX = 333 and DX = -100.
  const m = new Machine();
  m.mem.set([
    0xb8, 0x60, 0x79,       // ax = 0x7960
    0xba, 0xfe, 0xff,       // dx = 0xfffe  -> DX:AX = 0xfffe7960 = -100000
    0xbb, 0xd4, 0xfe,       // bx = 0xfed4  = -300
    0xf7, 0xfb,             // idiv bx
    0xf4,
  ], 0x1000);
  m.cpu.reset();
  for (let i = 0; i < 6; i++) m.cpu.sreg[i] = 0x0100;
  m.cpu.ip = 0;
  for (let i = 0; i < 4; i++) m.cpu.step();
  eq('16 bit signed idiv: quotient', m.cpu.r[0] & 0xffff, 333);
  eq('16 bit signed idiv: remainder', m.cpu.r[2] & 0xffff, 0xff9c);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
