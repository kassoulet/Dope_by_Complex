/*
 * Part 3's port against the original over the whole part, in lock step.
 * Same scheme as test_port4_run: the timer interrupt is held back and delivered
 * 1,2,3,2,.. ticks at a time between the polygons and the compose (0x2cc6),
 * then both compose and the state (variables, DAC, off screen frame, picture)
 * is compared.   node tests/test_port3_run.mjs [max frames]
 */
import { newPart, diffRanges, screenOf, specOf } from '../tools/oracle.mjs';
import { Part3 } from '../web/js/ports/part3.js';

const MAX = Number(process.argv[2] || 1e9);
const CS = 0xf8b0;
const r = newPart(3);
const m = r.m, c = m.cpu, mem = c.mem;
const image = mem.slice();

const port = new Part3(image);
const w = (o) => mem[CS + o] | (mem[CS + o + 1] << 8);
const SITE_DRAWN = 0x2bc6, SITE_DONE = 0x2bc9; // after `call 0x2920`, after `call 0x2c1c`
const pattern = [1, 2, 3, 2, 1, 3];
const fbBase = port.fbSeg << 4;

// scratch the port has no use for: the sort's end pointer, temporaries of 0x2a9b, a dead store of the polygon routine
const SCRATCH = [[0x1800, 0x1810], [0x1978, 0x197a], [0x196c, 0x1996], [0x1a20, 0x1a30], [0x27f6, 0x27fa], [0x2814, 0x2820]];
const masked = (a, base) => { const b = a.slice(); for (const [x, y] of SCRATCH) for (let i = Math.max(x, base); i < Math.min(y, base + b.length); i++) b[i - base] = 0; return b; };
function compare(frame) {
  const bad = [];
  const arr = (name, a, b, base = 0) => { const d = diffRanges(a, b); if (d.length) bad.push(`${name} differs at ${(base + d[0][0]).toString(16)}..${(base + d[0][1]).toString(16)} (${d.length} ranges): port ${a[d[0][0]]} original ${b[d[0][0]]}; others ${d.slice(1, 4).map((x) => (base + x[0]).toString(16))}`); };
  arr('variables 0x1800..0x1a40', masked(port.cs.subarray(0x1800, 0x1a40), 0x1800), masked(mem.subarray(CS + 0x1800, CS + 0x1a40), 0x1800), 0x1800);
  arr('rasteriser variables', masked(port.cs.subarray(0x1fe4, 0x2830), 0x1fe4), masked(mem.subarray(CS + 0x1fe4, CS + 0x2830), 0x1fe4), 0x1fe4);
  arr('frame buffer', port.fb, mem.subarray(fbBase, fbBase + 0x10000));
  arr('picture', port.vram, m.vga.pixels.subarray(0, 64000));
  arr('DAC', port.dac, m.vga.pal.subarray(0, 768));
  if (bad.length) { console.log(`FAIL at frame ${frame}, step ${port.step}:`); for (const b of bad.slice(0, 8)) console.log('   ' + b); return false; }
  return true;
}

let frame = 0, ok = true, phase = 0, guard = 0, k = 0;
const t0 = Date.now();
while (!c.halted && !m.exited && frame < MAX && ok) {
  if (c.sreg[1] === 0xf8b && c.ip === SITE_DRAWN && phase === 0) {
    const installed = (c.read32(0x20) >>> 16) === 0xf8b;
    port.draw3d();
    k = installed ? pattern[frame % pattern.length] : 0;
    for (let i = 0; i < k; i++) { r.deliverTick(); while (m.ret) c.step(); port.tick(); }
    phase = 1;
  } else if (c.sreg[1] === 0xf8b && c.ip === SITE_DONE && phase === 1) {
    port.compose();
    ok = compare(frame);
    port.scriptCheck();
    phase = 0; frame++;
    if (frame % 200 === 0) console.log(`  frame ${frame}, step ${port.step}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  c.step();
  if (++guard > 4e9) break;
}
console.log(ok ? `ok   ${frame} frames, step ${port.step}${port.done ? ' (done)' : ''}` : 'FAILED');
process.exit(ok ? 0 : 1);
