/*
 * Part 4's port against the original code.
 *
 * For each routine: take the part at some moment (the emulator, interpreter,
 * block exact timing), run the ORIGINAL routine on one copy of the machine and
 * the PORT on the data of another copy, and compare what the routine writes.
 * The states are spread over the whole part, so every phase is covered.
 *
 *   node tests/test_port4.mjs [--quick]
 */
import { runPart, clone, callRoutine, diffRanges } from '../tools/oracle.mjs';
import * as P from '../web/js/ports/part4.js';

const CS = 0xf8b0; // linear address of the part's segment
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('ok   ' + name); } else { failed++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + detail)); }
};
const hex = (n) => n.toString(16);
const w16 = (m, o) => m[o] | (m[o + 1] << 8);
void 0; const same = (a, b) => a.length === b.length && diffRanges(a, b).length === 0;
function report(name, a, b) {
  const d = diffRanges(a, b);
  ok(name, d.length === 0, d.length ? `first difference at +${hex(d[0][0])}..${hex(d[0][1])}: port ${a[d[0][0]]} original ${b[d[0][0]]}` : '');
}

const quick = process.argv.includes('--quick');
const ticks = quick ? [3, 60, 700] : [3, 60, 400, 1500, 2300, 3300, 4800, 6300];

for (const t of ticks) {
  const r = runPart(4, t);
  const mem = r.m.cpu.mem;
  console.log(`-- state after ${t} ticks`);

  // 0x1a75: the ramp, with the step the hook would pass (fade position and its complement)
  for (const step of [0, 0x30, 0x400, 0x800, 0x1000, 0x2000, 0xffff, 0x8000]) {
    const a = clone(r);
    callRoutine(a, 0x1a75, { ax: 0, dx: step, bx: 0x15e9 });
    const want = a.m.cpu.mem.slice(CS + 0x15e9, CS + 0x15e9 + 64);
    report(`ramp(step 0x${hex(step)})`, P.ramp(step), want);
  }

  // 0x1fa8: the sine table (the state already holds one; rebuild it from its own first quarter)
  {
    const q = new Int16Array(0x200);
    for (let i = 0; i < 0x200; i++) q[i] = (w16(mem, CS + 2 * i) << 16) >> 16;
    const built = P.buildSine(q);
    const have = new Int16Array(0x900);
    for (let i = 0; i < 0x900; i++) have[i] = (w16(mem, CS + 2 * i) << 16) >> 16;
    report('buildSine (0x1200 bytes at cs:0)', new Uint8Array(built.buffer), new Uint8Array(have.buffer));
  }

  // 0x1bab: one fire step; the shift it works out, and the 32000 byte fire buffer it rewrites
  {
    const a = clone(r);
    const m0 = a.m.cpu.mem;
    const sine = new Int16Array(0x900);
    for (let i = 0; i < 0x900; i++) sine[i] = (w16(m0, CS + 2 * i) << 16) >> 16;
    const angle = w16(m0, CS + 0x1578);
    const drift = (m0[CS + 0x157a] | (m0[CS + 0x157b] << 8) | (m0[CS + 0x157c] << 16) | (m0[CS + 0x157d] << 24));
    const lastShift = w16(m0, CS + 0x1b0b);
    const fire = m0.slice(P.SEG.fire, P.SEG.fire + 32000);
    const wt = m0.subarray(P.SEG.warp, P.SEG.warp + 0x10000), map = m0.subarray(P.SEG.map, P.SEG.map + 0x10000), blend = m0.subarray(P.SEG.blend, P.SEG.blend + 0x10000);
    const shift = P.shiftFor(sine, angle, drift);
    const redraw = shift !== lastShift;
    if (redraw) P.warp(fire, wt, map, blend, shift);
    callRoutine(a, 0x1bab, {});
    report(`warp (shift 0x${hex(shift)}${redraw ? '' : ', unchanged: skipped'})`, fire, a.m.cpu.mem.slice(P.SEG.fire, P.SEG.fire + 32000));
    ok('shiftFor stores what the original stores', redraw ? w16(a.m.cpu.mem, CS + 0x1b0b) === shift : true);
  }

  // 0x15f3: the ILBM reader, on the picture in the block (decode into the 0x4eed buffer)
  {
    const a = clone(r);
    const m0 = a.m.cpu.mem;
    const src = m0.slice(P.seg(0x177a), P.seg(0x177a) + 0x10000);
    const got = P.decodeILBM(src, 0);
    callRoutine(a, 0x15f3, { ds: (0x177a + P.RELOC) & 0xffff, es: (0x4eed + P.RELOC) & 0xffff, si: 0 });
    const m1 = a.m.cpu.mem;
    const base = P.seg(0x4eed);
    report('decodeILBM: palette (es:0x10, 768 bytes)', got.pal, m1.slice(base + 0x10, base + 0x310));
    report('decodeILBM: picture (es:0x310, 64000 bytes)', got.pixels, m1.slice(base + 0x310, base + 0x310 + 64000));
  }

  // 0x1fe8 + 0x1ffc: clear the back buffer and draw the terrain
  {
    const a = clone(r);
    const m0 = a.m.cpu.mem;
    const back = m0.slice(P.SEG.back, P.SEG.back + 64000);
    const seg2 = (o) => w16(m0, CS + o) << 4;
    const heights = m0.slice(seg2(0x210d), seg2(0x210d) + 0x10000), colours = m0.slice(seg2(0x210f), seg2(0x210f) + 0x10000);
    const ycol = new Uint16Array(320), ccol = new Uint16Array(320);
    for (let i = 0; i < 320; i++) { ycol[i] = w16(m0, CS + 0x2121 + 2 * i); ccol[i] = w16(m0, CS + 0x23a1 + 2 * i); }
    P.clearBack(back);
    P.terrain(back, w16(m0, CS + 0x2113), w16(m0, CS + 0x2111), heights, colours, ycol, ccol);
    callRoutine(a, 0x1fe8, {});
    callRoutine(a, 0x1ffc, {});
    const m1 = a.m.cpu.mem;
    report('terrain: back buffer', back, m1.slice(P.SEG.back, P.SEG.back + 64000));
    const yw = new Uint8Array(ycol.buffer), wy = new Uint8Array(640);
    for (let i = 0; i < 640; i++) wy[i] = m1[CS + 0x2121 + i];
    report('terrain: occlusion buffer (cs:0x2121)', yw, wy);
    const cw = new Uint8Array(ccol.buffer), wc = new Uint8Array(640);
    for (let i = 0; i < 640; i++) wc[i] = m1[CS + 0x23a1 + i];
    // the original leaves cs:0x2121+0 (column 0 is never visited) and the colour of drawn columns untouched
    report('terrain: interpolated colours (cs:0x23a1)', cw, wc);
  }

  // 0x1c91: the whole picture (fire + back buffer + label), with the warp step left out
  for (const slideForce of [null, 0x20, 0x46, 0x4b]) {
    const a = clone(r);
    const m0 = a.m.cpu.mem;
    if (slideForce !== null) { m0[CS + 0x196d] = slideForce; m0[CS + 0x196e] = 0; }
    // make the warp a no-op in the original: pretend the shift is unchanged
    const sine = new Int16Array(0x900);
    for (let i = 0; i < 0x900; i++) sine[i] = (w16(m0, CS + 2 * i) << 16) >> 16;
    const shift = P.shiftFor(sine, w16(m0, CS + 0x1578), (m0[CS + 0x157a] | (m0[CS + 0x157b] << 8) | (m0[CS + 0x157c] << 16) | (m0[CS + 0x157d] << 24)));
    m0[CS + 0x1b0b] = shift & 0xff; m0[CS + 0x1b0c] = shift >> 8;
    const fire = m0.slice(P.SEG.fire, P.SEG.fire + 32000);
    const back = m0.slice(P.SEG.back, P.SEG.back + 64000);
    const labelSeg = (w16(m0, CS + 0x196b)) << 4;
    const label = m0.subarray(labelSeg, labelSeg + 0x30a + 0x46 * 44);
    const slide = (w16(m0, CS + 0x196d) << 16) >> 16;
    const out = new Uint8Array(64000);
    P.compose(fire, back, label, slide, out);
    callRoutine(a, 0x1c91, {});
    report(`compose (label slide ${slide})`, out, a.m.vga.pixels.slice(0, 64000));
  }

  // 0x1a99: the palette from the current P1/P2 and ramps in memory
  {
    const a = clone(r);
    const m0 = a.m.cpu.mem;
    const p1 = m0.slice(CS + 0x157e, CS + 0x157e + 48), p2 = m0.slice(CS + 0x15ae, CS + 0x15ae + 48);
    const rampA = m0.slice(CS + 0x15e9, CS + 0x15e9 + 64), rampB = m0.slice(CS + 0x1629, CS + 0x1629 + 64);
    callRoutine(a, 0x1a99, {});
    const want = a.m.cpu.mem.slice(CS + 0x1669, CS + 0x1669 + 720);
    report('mixPalette (palette table in memory)', P.mixPalette(p1, p2, rampA, rampB), want);
    report('mixPalette (what reached the DAC)', P.mixPalette(p1, p2, rampA, rampB), a.m.vga.pal.slice(0, 720));
  }
}
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
