/*
 * Part 3's port against the original over the whole part, in lock step.
 * Same scheme as test_port4_run: the timer interrupt is held back and delivered
 * 1,2,3,2,.. ticks at a time between the polygons and the compose (0x2cc6),
 * then both compose and the state (variables, DAC, off screen frame, picture)
 * is compared.   node tests/test_port3_run.mjs [max frames]
 */
globalThis.DBG = process.env.DBG;
import { newPart, diffRanges, screenOf, specOf } from '../tools/oracle.mjs';
import { Part3 } from '../web/js/ports/part3.js';
import { Part7 } from '../web/js/ports/part7.js';
import { Part5 } from '../web/js/ports/part5.js';
import { Part6 } from '../web/js/ports/part6.js';

// node tests/test_port3_run.mjs [max frames] [--block 7]
const args = process.argv.slice(2);
const bi = args.indexOf('--block');
const BLOCK = bi >= 0 ? Number(args.splice(bi, 2)[1]) : 3;
const MAX = Number(args[0] || 1e9);
const POLY = process.argv.includes('--poly'); // check polygon by polygon inside the frame (finds the first bad polygon)
const SET = {
  6: { p0: 0x2594, poly: 0x1fd1, dsfs: 0x25d8, gs: 0x667b, Part: Part6, drawn: 0x2e6e, done: 0x2e71, vars: [0x1620, 0x1780], rast: [0x1d98, 0x2780], extra: [[0, 0x210], [0x2ed9, 0x2f59], [0x3259, 0x325d]],
    scratch: [[0x1708, 0x1732], [0x1714, 0x1716], [0x1754, 0x1758], [0x25ba, 0x25be], [0x25d8, 0x25dc]] },
  5: { p0: 0x2318, poly: 0x1d51, dsfs: 0x235c, gs: 0x2685, Part: Part5, drawn: 0x2b88, done: 0x2b8b, vars: [0x1400, 0x1580], rast: [0x1b1c, 0x23f0], extra: [[0x374b, 0x395b]], scratch: [[0x1400, 0x1412], [0x1506, 0x1508], [0x14fa, 0x1524], [0x1c0, 0x1c0], [0x233e, 0x2342], [0x235c, 0x2360]] }, 3: { p0: 0x27d0, poly: 0x2211, dsfs: 0x2814, gs: 0x343d, Part: Part3, drawn: 0x2bc6, done: 0x2bc9, vars: [0x1800, 0x1a40], rast: [0x1fe4, 0x2830], scratch: [[0x1800, 0x1810], [0x1978, 0x197a], [0x196c, 0x1996], [0x1a20, 0x1a30], [0x27f6, 0x27fa], [0x2814, 0x2820]] },
  7: { p0: 0x27c8, poly: 0x2201, dsfs: 0x280c, gs: 0x3de1, Part: Part7, drawn: 0x316c, done: 0x316f, vars: [0x1800, 0x1a40], rast: [0x1fc8, 0x2820], scratch: [[0x1800, 0x1810], [0x1978, 0x197a], [0x196c, 0x1996], [0x1a20, 0x1a34], [0x27ee, 0x27f2], [0x280c, 0x2818]] } }[BLOCK];
const CS = 0xf8b0;
const r = newPart(BLOCK);
const m = r.m, c = m.cpu, mem = c.mem;
const image = mem.slice();

const scr = BLOCK === 5 || BLOCK === 6 ? screenOf(specOf(BLOCK)) : null;
const port = new SET.Part(image, scr ? { screen: scr.pixels, pal: scr.pal } : {});
const w = (o) => mem[CS + o] | (mem[CS + o + 1] << 8);
const SITE_DRAWN = SET.drawn, SITE_DONE = SET.done; // after `call 0x2920`, after `call 0x2c1c`
const pattern = [1, 2, 3, 2, 1, 3];
const fbBase = port.fbSeg << 4;

// scratch the port has no use for: the sort's end pointer, temporaries of 0x2a9b, a dead store of the polygon routine
const SCRATCH = SET.scratch;
const masked = (a, base) => { const b = a.slice(); for (const [x, y] of SCRATCH) for (let i = Math.max(x, base); i < Math.min(y, base + b.length); i++) b[i - base] = 0; return b; };
function compare(frame) {
  const bad = [];
  const arr = (name, a, b, base = 0) => { const d = diffRanges(a, b); if (d.length) bad.push(`${name} differs at ${(base + d[0][0]).toString(16)}..${(base + d[0][1]).toString(16)} (${d.length} ranges): port ${a[d[0][0]]} original ${b[d[0][0]]}; others ${d.slice(1, 4).map((x) => (base + x[0]).toString(16))}`); };
  arr('variables 0x1800..0x1a40', masked(port.cs.subarray(SET.vars[0], SET.vars[1]), SET.vars[0]), masked(mem.subarray(CS + SET.vars[0], CS + SET.vars[1]), SET.vars[0]), SET.vars[0]);
  arr('rasteriser variables', masked(port.cs.subarray(SET.rast[0], SET.rast[1]), SET.rast[0]), masked(mem.subarray(CS + SET.rast[0], CS + SET.rast[1]), SET.rast[0]), SET.rast[0]);
  for (const [x, y] of SET.extra || []) arr('cs tables', port.cs.subarray(x, y), mem.subarray(CS + x, CS + y), x);
  if (BLOCK === 7) arr('lookup buffer', port.image.subarray(port.texBase, port.texBase + 0x10000), mem.subarray(port.texBase, port.texBase + 0x10000));
  arr('frame buffer', port.fb, mem.subarray(fbBase, fbBase + 0x10000));
  arr('picture', port.vram, m.vga.pixels.subarray(0, 64000));
  arr('DAC', port.dac, m.vga.pal.subarray(0, 768));
  if (bad.length) { console.log(`FAIL at frame ${frame}, step ${port.step}:`); for (const b of bad.slice(0, 8)) console.log('   ' + b); return false; }
  return true;
}

const hex = (n) => (n >>> 0).toString(16);
function polygonCheck(frameNo, first) {
  const ras = port.ras;
  if (first) port.gs.set(mem.subarray(((SET.gs + 0xf7b) & 0xffff) << 4, (((SET.gs + 0xf7b) & 0xffff) << 4) + 0x10000));
  const si = c.r[6] & 0xffff, di = c.r[7] & 0xffff, bp = c.r[5] & 0xffff;
  const dsSeg = w(SET.dsfs), fsSeg = w(SET.dsfs + 2);
  const ds = port.image.subarray(dsSeg << 4, (dsSeg << 4) + 0x10000), fs = fsSeg ? port.image.subarray(fsSeg << 4, (fsSeg << 4) + 0x10000) : null;
  ras.polygon(si, di, bp, ds, fs);
  const sp = c.r[4] & 0xffff;
  let g = 0;
  const cdqs = [];
  while (!((c.r[4] & 0xffff) === ((sp + 2) & 0xffff) && g > 0) && g < 5e7) {
    if (process.env.DBGIP && c.ip === Number(process.env.DBGIP) - 0x100) cdqs.push(`@${process.env.DBGIP}: ecx=${hex(c.r[1])} words ${[0x23e6, 0x23e8, 0x23ba, 0x23bc].map((a) => hex(mem[CS + a] | (mem[CS + a + 1] << 8))).join(',')}`);
    if (mem[CS + c.ip] === 0x99) cdqs.push(`${hex(c.ip + 0x100)}:eax=${hex(c.r[0])},ecx=${hex(c.r[1])},bx=${hex(c.r[3] & 0xffff)}`);
    c.step(); g++;
  }
  const bad = [];
  const d = diffRanges(port.fb, mem.subarray(fbBase, fbBase + 0x10000));
  if (d.length) bad.push(`frame buffer at ${hex(d[0][0])} (x ${d[0][0] % 320} y ${Math.floor(d[0][0] / 320)}; ${d.length} ranges, port ${port.fb[d[0][0]]} original ${mem[fbBase + d[0][0]]})`);
  const A = masked(port.cs.subarray(SET.rast[0], SET.rast[1]), SET.rast[0]), B = masked(mem.subarray(CS + SET.rast[0], CS + SET.rast[1]), SET.rast[0]);
  const dv = diffRanges(A, B);
  if (dv.length) bad.push(`variable ${hex(SET.rast[0] + dv[0][0])} port ${A[dv[0][0]]} original ${B[dv[0][0]]}`);
  if (bad.length) {
    const sy = (v) => { const o = SET.rast; void o; return v; };
    console.log(`FAIL polygon in frame ${frameNo}: si ${hex(si)} di ${hex(di)} bp ${hex(bp)} ds ${hex(dsSeg)} fs ${hex(fsSeg)} clip ${w(SET.dsfs - 4)} corners ${[0, 4, 8].map((k) => { const v = (mem[CS + SET.p0 + k] | (mem[CS + SET.p0 + k + 1] << 8) | (mem[CS + SET.p0 + k + 2] << 16) | (mem[CS + SET.p0 + k + 3] << 24)) | 0; return `(${v >> 16},${(v << 16) >> 16})`; }).join(' ')}: ` + bad.join('; '));
    void sy;
    console.log('   cdq events: ' + cdqs.join(' '));
    return false;
  }
  return true;
}
let polyFirst = true, polyOk = true;
let frame = 0, ok = true, phase = 0, guard = 0, k = 0;
const t0 = Date.now();
while (!c.halted && !m.exited && frame < MAX && ok && !port.ending) {
  if (POLY && c.sreg[1] === 0xf8b && c.ip === SET.poly) {
    if (!polygonCheck(frame, polyFirst)) { polyOk = false; break; }
    polyFirst = false;
    continue;
  }
  if (c.sreg[1] === 0xf8b && c.ip === SITE_DRAWN && phase === 0) {
    const installed = (c.read32(0x20) >>> 16) === 0xf8b;
    if (POLY) polyFirst = true; else port.draw3d();
    k = installed ? pattern[frame % pattern.length] : 0;
    for (let i = 0; i < k; i++) { r.deliverTick(); while (m.ret) c.step(); port.tick(); }
    phase = 1;
  } else if (c.sreg[1] === 0xf8b && c.ip === SITE_DONE && phase === 1) {
    port.compose();
    ok = POLY ? polyOk : compare(frame);
    port.scriptCheck();
    phase = 0; frame++;
    if (frame % 200 === 0) console.log(`  frame ${frame}, step ${port.step}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  c.step();
  if (++guard > 4e9) break;
}
// block 7 ends with a strip copied on the screen and a 350 tick wait: run that out too
if (ok && BLOCK === 7 && port.ending) {
  let strip = false, ticks = 0;
  for (let g = 0; g < 4e8 && !m.exited && !c.halted && ticks < 400; g++) {
    if (c.sreg[1] === 0xf8b && c.ip === 0x33a8 && !strip) { strip = true; const d = diffRanges(port.vram, m.vga.pixels.subarray(0, 64000)); console.log(d.length ? `FAIL strip: picture differs in ${d.length} ranges` : '   the picture with the final strip matches'); ok = ok && d.length === 0; }
    c.step();
    if (strip && g % 300 === 0) { r.deliverTick(); while (m.ret) c.step(); port.tick(); ticks++; if (port.done) break; }
  }
  const d = diffRanges(port.vram, m.vga.pixels.subarray(0, 64000));
  console.log(d.length ? `FAIL: picture at the end differs in ${d.length} ranges` : `   after ${ticks} ticks the port says done=${port.done}, the picture is the same`);
  ok = ok && d.length === 0 && port.done;
}
// block 5 ends with a palette cross fade to part 6's picture, paced by the card's retrace, not by the timer
if (ok && BLOCK === 5 && port.ending) {
  const cmp = (what) => {
    const dv = diffRanges(port.vram, m.vga.pixels.subarray(0, 64000)), dd = diffRanges(port.dac, m.vga.pal.subarray(0, 768));
    console.log(dv.length || dd.length ? `FAIL ${what}: picture ${dv.length} ranges, DAC ${dd.length} ranges (first at ${dd[0] ? dd[0][0] : '-'}: port ${dd[0] ? port.dac[dd[0][0]] : '-'} original ${dd[0] ? m.vga.pal[dd[0][0]] : '-'})` : `   ${what}: picture and DAC match`);
    ok = ok && !dv.length && !dd.length;
  };
  for (let g = 0; g < 4e8 && !(c.sreg[1] === 0xf8b && c.ip === 0x3705); g++) c.step();
  cmp('after the first mix and the combined picture');
  for (let g = 0; g < 4e8 && !(c.sreg[1] === 0xf8b && c.ip === 0x3746); g++) c.step();
  let n = 0;
  while (!port.done && n++ < 100) port.tick();
  cmp(`at the end (port: ${n} ticks of fading)`);
}
// block 6 ends by fading the palette to black, paced by the retrace
if (ok && BLOCK === 6 && port.ending) {
  for (let g = 0; g < 4e8 && !(c.sreg[1] === 0xf8b && c.ip === 0x3d71); g++) c.step();
  let n = 0;
  while (!port.done && n++ < 100) port.tick();
  const dv = diffRanges(port.vram, m.vga.pixels.subarray(0, 64000)), dd = diffRanges(port.dac, m.vga.pal.subarray(0, 768));
  console.log(dv.length || dd.length ? `FAIL at the end: picture ${dv.length} ranges, DAC ${dd.length} ranges` : `   after ${n} ticks of fading: picture and DAC match (the DAC is black)`);
  ok = ok && !dv.length && !dd.length;
}
console.log(ok ? `ok   ${frame} frames, step ${port.step}${port.done ? ' (done)' : ''}` : 'FAILED');
process.exit(ok ? 0 : 1);
