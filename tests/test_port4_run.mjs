/*
 * Part 4's port against the original over the whole part, in lock step.
 *
 * The original runs in the emulator from its first instruction.  Its timer
 * interrupt is held back and delivered by this test, a few ticks at a time (1,
 * 2, 3, 2, ...), exactly when the main loop gets back from the frame routine
 * 0x1c91.  So a frame is never interrupted, and the port, given the same
 * schedule (draw, tick k times, script), has to reproduce the original at
 * every one of those moments: all the variables, the DAC, the fire buffer, the
 * back buffer and the picture on the card, byte for byte.
 *
 *   node tests/test_port4_run.mjs [max frames]
 */
import { newPart, diffRanges, screenOf, specOf } from '../tools/oracle.mjs';
import { Part4 } from '../web/js/ports/part4.js';
import * as P from '../web/js/ports/part4.js';

const MAX = Number(process.argv[2] || 1e9);
const CS = 0xf8b0;
const r = newPart(4);
const m = r.m, c = m.cpu, mem = c.mem;
const image = mem.slice(); // as the loader leaves it, before any instruction
const scr = screenOf(specOf(4));
const port = new Part4(image, { screen: scr.pixels, pal: scr.pal });

// the places the main loop lands after `call 0x1c91`
const block = m.cpu.mem;
const sites = new Set();
for (let o = 0x1d00; o < 0x1f90; o++) {
  const b = (a) => block[CS + a];
  if (b(o) === 0xe8) {
    const rel = ((b(o + 1) | (b(o + 2) << 8)) << 16) >> 16;
    if (((o + 3 + rel) & 0xffff) === 0x1b91) sites.add((o + 3) & 0xffff);
  }
}
console.log('return sites of 0x1c91:', [...sites].map((x) => (x + 0x100).toString(16)).join(' '));

const w = (o) => mem[CS + o] | (mem[CS + o + 1] << 8);
const s16 = (v) => (v << 16) >> 16;
const pattern = [1, 2, 3, 2, 1, 3];
const names = ['isrTicks', 'angle', 'speed', 'phase', 'labPos', 'labVel', 'fade', 'fadeVel', 'fadeMin', 'fadeMax', 'scroll', 'camX'];
const addr = { isrTicks: 0x141e, angle: 0x1578, speed: 0x1576, phase: 0x1969, labPos: 0x196d, labVel: 0x196f, fade: 0x1971, fadeVel: 0x1973, fadeMin: 0x1a59, fadeMax: 0x1a62, scroll: 0x2113, camX: 0x2111 };

function compare(frame) {
  const bad = [];
  for (const n of names) {
    const want = n === 'labPos' || n === 'fadeMin' ? s16(w(addr[n])) : w(addr[n]);
    const have = n === 'labPos' || n === 'fadeMin' ? s16(port[n]) : port[n] & 0xffff;
    if (want !== have) bad.push(`${n}: port ${have} original ${want}`);
  }
  const drift = (mem[CS + 0x157a] | (mem[CS + 0x157b] << 8) | (mem[CS + 0x157c] << 16) | (mem[CS + 0x157d] << 24));
  if (drift !== port.drift) bad.push(`drift: port ${port.drift} original ${drift}`);
  const arr = (name, a, b) => { const d = diffRanges(a, b); if (d.length) bad.push(`${name} differs at ${d[0][0]}..${d[0][1]} (${d.length} ranges)`); };
  arr('fire buffer', port.fire, mem.subarray(P.SEG.fire, P.SEG.fire + 32000));
  arr('back buffer', port.back, mem.subarray(P.SEG.back, P.SEG.back + 64000));
  arr('picture', port.vram, m.vga.pixels.subarray(0, 64000));
  arr('DAC 0..239', port.dac.subarray(0, 720), m.vga.pal.subarray(0, 720));
  arr('DAC 240..255', port.dac.subarray(720, 768), m.vga.pal.subarray(720, 768));
  arr('p1 (cs:0x157e)', port.p1, mem.subarray(CS + 0x157e, CS + 0x157e + 48));
  if (bad.length) { console.log(`FAIL at frame ${frame}, tick ${port.ticks}, stage ${port.stage}:`); for (const b of bad.slice(0, 8)) console.log('   ' + b); return false; }
  return true;
}

let frame = 0, installed = false, ok = true, t0 = Date.now();
// the original installs its ISR itself (0x1569); the test delivers ticks only after that
const origStep = c.step.bind(c);
const delivered = () => port.ticks;
let guard = 0;
while (!c.halted && !m.exited && frame < MAX && ok) {
  const ipSeg = c.ip;
  if (sites.has(ipSeg) && c.sreg[1] === 0xf8b) {
    // the original has just finished a draw.  Is its ISR installed yet?
    installed = (c.read32(0x20) >>> 16) === 0xf8b;
    if (frame > 0 || true) {
      // the port draws the same frame, then both get k ticks
      port.draw();
    }
    const k = installed ? pattern[frame % pattern.length] : 0;
    for (let i = 0; i < k; i++) {
      r.deliverTick();
      while (m.ret) c.step(); // the ISR runs to its iret
      port.tick();
    }
    ok = compare(frame);
    if (ok) {
      port.script();
      frame++;
      if (frame % 200 === 0) console.log(`  frame ${frame}, tick ${port.ticks}, stage ${port.stage}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
  }
  c.step();
  if (++guard > 4e9) break;
}
if (ok && m.exited) { // the original has left: its last picture is the back layer alone
  const d = diffRanges(port.vram, m.vga.pixels.subarray(0, 64000));
  ok = d.length === 0 && port.done;
  console.log(ok ? '   the final picture (back layer to the screen) matches too' : `FAIL final picture: ${d.length} ranges differ, done=${port.done}`);
}
void origStep; void delivered;
console.log(ok ? `ok   ${frame} frames, ${port.ticks} ticks, port stage ${port.stage}${port.done ? ' (done)' : ''}: the port equals the original at every frame` : 'FAILED');
process.exit(ok ? 0 : 1);
