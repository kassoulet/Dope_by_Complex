/*
 * The shared 3D engine (web/js/ports/engine3d.js) against block 3's code.
 *   node tests/test_engine3.mjs [--quick]
 * Every routine is run in the original on a copy of the machine at several
 * moments of the part and the port must write the same bytes.
 */
import { runPart, clone, callRoutine, diffRanges } from '../tools/oracle.mjs';
import * as E from '../web/js/ports/engine3d.js';

const CS = 0xf8b0;
const GS = (0x343d + 0xf7b) << 4; // the data segment of block 3 (loader relocated)
let passed = 0, failed = 0;
const ok = (name, cond, detail) => { if (cond) { passed++; console.log('ok   ' + name); } else { failed++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + detail)); } };
const hex = (n) => (n >>> 0).toString(16);
const w16 = (m, o) => m[o] | (m[o + 1] << 8);
const s16 = (v) => (v << 16) >> 16;
const d32 = (m, o) => (m[o] | (m[o + 1] << 8) | (m[o + 2] << 16) | (m[o + 3] << 24)) | 0;
function report(name, a, b) {
  const d = diffRanges(a, b);
  ok(name, d.length === 0, d.length ? `first difference at +${hex(d[0][0])}..${hex(d[0][1])}: port ${a[d[0][0]]} original ${b[d[0][0]]} (${d.length} ranges)` : '');
}
const sineOf = (m) => { const t = new Int16Array(0xa00); for (let i = 0; i < 0xa00; i++) t[i] = s16(w16(m, CS + 0x410 + 2 * i)); return t; };

const quick = process.argv.includes('--quick');
const ticks = quick ? [10, 200] : [10, 200, 450, 840, 1800, 2600, 3300];
for (const t of ticks) {
  const r = runPart(3, t);
  console.log(`-- block 3 after ${t} ticks`);
  const m = r.m.cpu.mem;
  const sin = sineOf(m);

  // 0x1fa8-style sine table from its own quarter
  report('buildSine (0x1400 bytes at cs:0x410)', new Uint8Array(E.buildSine(sin.subarray(0, 0x200)).buffer, 0, 0x1400), new Uint8Array(sin.buffer, 0, 0x1400));

  // 0x1ef6: the matrix, for the object angles currently in memory and for a few others
  for (const ang of [null, [0, 0, 0], [0x123, 0x456, 0x789], [0xfff, 0x800, 0x400], [0x200, 0x1fe, 0x3ff]]) {
    const a = clone(r);
    const m0 = a.m.cpu.mem;
    if (ang) for (let i = 0; i < 3; i++) { m0[CS + 0x1df0 + 2 * i] = ang[i] & 0xff; m0[CS + 0x1df1 + 2 * i] = ang[i] >> 8; }
    const angles = [0, 1, 2].map((i) => w16(m0, CS + 0x1df0 + 2 * i));
    const got = E.rotationMatrix(sin, ...angles);
    callRoutine(a, 0x1ef6, {});
    const want = new Int32Array(9);
    for (let i = 0; i < 9; i++) want[i] = d32(a.m.cpu.mem, CS + 0x1dcc + 4 * i);
    report(`rotationMatrix(${angles.map(hex).join(', ')})`, new Uint8Array(got.buffer), new Uint8Array(want.buffer));
  }
}

// 0x1dd0: the vertex stage on whatever object the part is drawing at that moment (set up by the frame routine 0x2a9b)
for (const t of ticks) {
  const r = runPart(3, t);
  console.log(`-- block 3 vertex stage after ${t} ticks`);
  const m = r.m.cpu.mem;
  const sin = sineOf(m);
  for (let objIndex = 1; objIndex <= 4; objIndex++) {
    const a = clone(r);
    const m0 = a.m.cpu.mem;
    const rec = CS + 0x1810 + 0x3a * objIndex;
    const segW = w16(m0, rec);
    if (!segW) continue;
    const geo = m0.slice(segW << 4, (segW << 4) + 0x10000);
    // what 0x2a9b does before calling the vertex stage: object position, angles, focal, vertex base
    const cam = CS + 0x1810;
    const ang = [0, 1, 2].map((i) => (s16(w16(m0, rec + 0x1e + 2 * i)) + s16(w16(m0, cam + 0x1e + 2 * i))) >> 4);
    const pos = [0, 1, 2].map((i) => (d32(m0, rec + 6 + 4 * i) + d32(m0, cam + 6 + 4 * i)) | 0);
    const offs = [0, 1, 2].map((i) => d32(m0, rec + 0x2e + 4 * i));
    const focal = s16(w16(m0, rec + 4));
    const base = 0;
    const M = E.rotationMatrix(sin, ...ang);
    const gs = new Uint8Array(0x10000);
    E.transformObject(gs, geo, M, { base, offset: offs, pos, focal });
    // run the original the same way: set its variables, then call 0x1ef6 and 0x1dd0 with fs = the object
    for (let i = 0; i < 3; i++) { m0[CS + 0x1df0 + 2 * i] = ang[i] & 0xff; m0[CS + 0x1df1 + 2 * i] = (ang[i] >> 8) & 0xff; }
    const put32 = (o, v) => { for (let k = 0; k < 4; k++) m0[o + k] = (v >> (8 * k)) & 0xff; };
    put32(CS + 0x1982, pos[0]); put32(CS + 0x1986, pos[1]); put32(CS + 0x198a, pos[2]);
    put32(CS + 0x196c, offs[0]); put32(CS + 0x1970, offs[1]); put32(CS + 0x1974, offs[2]);
    put32(CS + 0x198e, focal); wr16(m0, CS + 0x19a2, base);
    callRoutine(a, 0x1ef6, {});
    callRoutine(a, 0x1dd0, { fs: segW, gs: (0x343d + 0xf7b) & 0xffff });
    const nv = w16(geo, 0);
    const want = a.m.cpu.mem.slice(GS, GS + 0x10000);
    // compare the five per vertex arrays over this object's vertices
    for (const [name, off] of [['tex', E.OFF.tex], ['env', E.OFF.env], ['sy,sx', E.OFF.sy], ['sz', E.OFF.sz]]) {
      const end = off + 4 * nv;
      report(`object ${objIndex} (${nv} vertices) ${name} array`, gs.slice(off, end), want.slice(off, end));
    }
  }
}
// 0x2987 and 0x2b95: faces and sort, for the active object and for all four records
for (const t of ticks) {
  const r = runPart(3, t);
  console.log(`-- block 3 faces and sort after ${t} ticks`);
  const m = r.m.cpu.mem;
  const sin = sineOf(m);
  for (const objIndex of [4, 1]) {
    const a = clone(r);
    const m0 = a.m.cpu.mem;
    const rec = CS + 0x1810 + 0x3a * objIndex;
    const segW = w16(m0, rec);
    const geo = m0.slice(segW << 4, (segW << 4) + 0x10000);
    const cam = CS + 0x1810;
    const ang = [0, 1, 2].map((i) => (s16(w16(m0, rec + 0x1e + 2 * i)) + s16(w16(m0, cam + 0x1e + 2 * i))) >> 4);
    const pos = [0, 1, 2].map((i) => (d32(m0, rec + 6 + 4 * i) + d32(m0, cam + 6 + 4 * i)) | 0);
    const offs = [0, 1, 2].map((i) => d32(m0, rec + 0x2e + 4 * i));
    const focal = s16(w16(m0, rec + 4));
    const cull = w16(m0, rec + 0x2c), sel = w16(m0, rec + 0x2a);
    // port: vertices, then faces, then sort
    const gs = new Uint8Array(0x10000);
    const o = { base: 0, count: 0, cull, selA: sel & 0xff, selB: sel >> 8 };
    E.transformObject(gs, geo, E.rotationMatrix(sin, ...ang), { base: 0, offset: offs, pos, focal });
    E.buildFaces(gs, geo, o);
    const n = o.count;
    wr32(gs, E.OFF.list + 4 * n, -1);
    E.radixSort(gs, n);
    // original: the frame routine's variables, then 0x1ef6, 0x1dd0, 0x2987, terminator, 0x2b95
    for (let i = 0; i < 3; i++) { m0[CS + 0x1df0 + 2 * i] = ang[i] & 0xff; m0[CS + 0x1df1 + 2 * i] = (ang[i] >> 8) & 0xff; }
    const put32 = (o2, v) => { for (let k = 0; k < 4; k++) m0[o2 + k] = (v >> (8 * k)) & 0xff; };
    put32(CS + 0x1982, pos[0]); put32(CS + 0x1986, pos[1]); put32(CS + 0x198a, pos[2]);
    put32(CS + 0x196c, offs[0]); put32(CS + 0x1970, offs[1]); put32(CS + 0x1974, offs[2]);
    put32(CS + 0x198e, focal); wr16(m0, CS + 0x19a2, 0); wr16(m0, CS + 0x19a4, 0); wr16(m0, CS + 0x19a6, cull);
    m0[CS + 0x19be] = sel & 0xff; m0[CS + 0x19bf] = 0; m0[CS + 0x19bc] = sel >> 8; m0[CS + 0x19bd] = 0;
    wr16(m0, CS + 0x2885, w16(geo, 2));
    const gsSeg = (0x343d + 0xf7b) & 0xffff;
    callRoutine(a, 0x1ef6, {});
    callRoutine(a, 0x1dd0, { fs: segW, gs: gsSeg });
    callRoutine(a, 0x2987, { fs: segW, gs: gsSeg });
    const cnt = w16(a.m.cpu.mem, CS + 0x19a4);
    ok(`object ${objIndex}: ${cnt} visible faces, as many as the original`, cnt === n, `port ${n} original ${cnt}`);
    a.m.cpu.mem.set([0xff, 0xff, 0xff, 0xff], GS + 4 * cnt);
    const before = a.m.cpu.mem.slice(GS, GS + 0x10000);
    // the faces part of the segment, before the sort
    const gs2 = gs.slice();
    report(`object ${objIndex}: face arrays (vertices of each visible face)`, new Uint8Array([...gs.slice(E.OFF.f0, E.OFF.f0 + 2 * n), ...gs.slice(E.OFF.f1, E.OFF.f1 + 2 * n), ...gs.slice(E.OFF.f2, E.OFF.f2 + 2 * n)]),
      new Uint8Array([...before.slice(E.OFF.f0, E.OFF.f0 + 2 * n), ...before.slice(E.OFF.f1, E.OFF.f1 + 2 * n), ...before.slice(E.OFF.f2, E.OFF.f2 + 2 * n)]));
    void gs2;
    callRoutine(a, 0x2b95, {}); // sorts using [0x19a4]
    const after = a.m.cpu.mem.slice(GS, GS + 0x10000);
    report(`object ${objIndex}: sorted face list (${n} entries)`, gs.slice(0, 4 * (n + 1)), after.slice(0, 4 * (n + 1)));
  }
}
// 0x2311: the rasteriser, polygon by polygon, in the order the frame draws them
import { Rasteriser, V3 as V } from '../web/js/ports/raster3.js';
for (const t of ticks) {
  const r = runPart(3, t);
  console.log(`-- block 3 rasteriser after ${t} ticks`);
  const m = r.m.cpu.mem;
  const sin = sineOf(m);
  const a = clone(r);
  const m0 = a.m.cpu.mem;
  const objIndex = 4;
  const rec = CS + 0x1810 + 0x3a * objIndex;
  const segW = w16(m0, rec);
  const cam = CS + 0x1810;
  const ang = [0, 1, 2].map((i) => (s16(w16(m0, rec + 0x1e + 2 * i)) + s16(w16(m0, cam + 0x1e + 2 * i))) >> 4);
  const pos = [0, 1, 2].map((i) => (d32(m0, rec + 6 + 4 * i) + d32(m0, cam + 6 + 4 * i)) | 0);
  const offs = [0, 1, 2].map((i) => d32(m0, rec + 0x2e + 4 * i));
  const focal = s16(w16(m0, rec + 4));
  const cull = w16(m0, rec + 0x2c), sel = w16(m0, rec + 0x2a);
  for (let i = 0; i < 3; i++) { m0[CS + 0x1df0 + 2 * i] = ang[i] & 0xff; m0[CS + 0x1df1 + 2 * i] = (ang[i] >> 8) & 0xff; }
  const put32 = (o2, v) => { for (let k = 0; k < 4; k++) m0[o2 + k] = (v >> (8 * k)) & 0xff; };
  put32(CS + 0x1982, pos[0]); put32(CS + 0x1986, pos[1]); put32(CS + 0x198a, pos[2]);
  put32(CS + 0x196c, offs[0]); put32(CS + 0x1970, offs[1]); put32(CS + 0x1974, offs[2]);
  put32(CS + 0x198e, focal); wr16(m0, CS + 0x19a2, 0); wr16(m0, CS + 0x19a4, 0); wr16(m0, CS + 0x19a6, cull);
  m0[CS + 0x19be] = sel & 0xff; m0[CS + 0x19bf] = 0; m0[CS + 0x19bc] = sel >> 8; m0[CS + 0x19bd] = 0;
  wr16(m0, CS + 0x2885, w16(m0.subarray(segW << 4), 2));
  const gsSeg = (0x343d + 0xf7b) & 0xffff;
  callRoutine(a, 0x1ef6, {});
  callRoutine(a, 0x1dd0, { fs: segW, gs: gsSeg });
  callRoutine(a, 0x2987, { fs: segW, gs: gsSeg });
  const cnt = w16(m0, CS + 0x19a4);
  m0.set([0xff, 0xff, 0xff, 0xff], GS + 4 * cnt);
  callRoutine(a, 0x2b95, {});
  // the original's state is now "just before 0x2920": polygons are drawn into the segment at cs:0x19d0
  const fbSeg = w16(m0, CS + 0x19d0);
  const gsBytes = m0.slice(GS, GS + 0x10000);
  const rows = new Uint16Array(256);
  for (let i = 0; i < 256; i++) rows[i] = w16(m0, CS + 2 * i);
  const fb = m0.slice(fbSeg << 4, (fbSeg << 4) + 0x10000);
  const cs = new Uint8Array(0x3000);
  cs.set(m0.subarray(CS, CS + 0x3000));
  const ras = new Rasteriser({ cs, gs: gsBytes, OFF: E.OFF, fb, rows });
  const dsTab = [0, 1, 2, 3].map((i) => w16(m0, CS + 0x400 + 2 * i)), fsTab = [0, 1, 2, 3].map((i) => w16(m0, CS + 0x408 + 2 * i));
  let bad = null, drawn = 0, clippedCount = 0;
  for (let k = 0; k < cnt && !bad; k++) {
    const slot = w16(gsBytes, 4 * k);
    const i0 = w16(gsBytes, E.OFF.f0 + 2 * slot), i1 = w16(gsBytes, E.OFF.f1 + 2 * slot), i2 = w16(gsBytes, E.OFF.f2 + 2 * slot);
    const dsSeg = dsTab[i2 & 3], fsSeg = fsTab[i1 & 3];
    const ds = m0.subarray(dsSeg << 4, (dsSeg << 4) + 0x10000), fs = m0.subarray(fsSeg << 4, (fsSeg << 4) + 0x10000);
    const dsC = new Uint8Array(ds), fsC = new Uint8Array(fs);
    wr16(a.m.cpu.mem, CS + 0x2814, dsSeg); wr16(a.m.cpu.mem, CS + 0x2816, fsSeg);
    ras.polygon(i0 & ~3, i1 & ~3, i2 & ~3, dsC, fsC);
    callRoutine(a, 0x2311, { si: i0 & ~3, di: i1 & ~3, bp: i2 & ~3, es: fbSeg, gs: gsSeg, ds: 0xf8b });
    drawn++;
    if (w16(a.m.cpu.mem, CS + 0x2810) !== 0) clippedCount++;
    const mw = a.m.cpu.mem;
    const fbw = mw.subarray(fbSeg << 4, (fbSeg << 4) + 0x10000);
    const dcs0 = [];
    for (let o = 0x1fe4; o < 0x2830; o++) { if (o >= 0x27f6 && o < 0x27fa) continue; if (cs[o] !== mw[CS + o]) dcs0.push(o); }
    if (dcs0.length) { bad = `polygon ${k}: variable cs:0x${hex(dcs0[0])} differs (port ${cs[dcs0[0]]} original ${mw[CS + dcs0[0]]}; ${dcs0.length} bytes, e.g. ${dcs0.slice(0, 8).map(hex).join(' ')})`; break; }
    const dfb = diffRanges(fb, fbw);
    if (dfb.length) {
      const px = dfb[0][0];
      const pts = [i0 & ~3, i1 & ~3, i2 & ~3].map((v) => { const dd = rdd(gsBytes, E.OFF.sy + v); return `(${s16(dd >> 16)},${s16(dd)})`; });
      bad = `polygon ${k}: frame buffer differs at +${hex(px)} = x ${px % 320} y ${Math.floor(px / 320)} (${dfb.length} ranges, port ${fb[px]} original ${fbw[px]}); corners ${pts.join(' ')} clip ${w16(mw, CS + 0x2810)} flat ${w16(mw, CS + 0x280e)}`;
      break;
    }
  }
  ok(`rasteriser: ${drawn} polygons of the sorted list (${clippedCount} through the clipping loop), frame buffer and variables identical`, !bad, bad);
}
function rdd(a, o) { return (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) | 0; }
function wr16(a, o, v) { a[o] = v & 0xff; a[o + 1] = (v >> 8) & 0xff; }
function wr32(a, o, v) { for (let k = 0; k < 4; k++) a[o + k] = (v >> (8 * k)) & 0xff; }
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
