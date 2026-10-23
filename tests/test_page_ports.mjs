/*
 * The page really runs the ports: seek into parts 3, 5 and 7, pause, and the canvas the page shows
 * must be byte for byte the picture a port makes in node for the same tick (these three draw a
 * picture that depends on the clock only, so one render is enough to predict it).  The other parts
 * carry state from frame to frame (the fire of part 4, part 2's glow, part 6's lights), so for them
 * the test checks only that the page shows a picture from a port.
 *   node tests/test_page_ports.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep, ROOT } from './browser_lib.mjs';
import { findBlocks } from '../web/js/rnc.js';
import { PortRunner } from '../web/js/ports/index.js';
import { inflateRawSync } from 'node:zlib';

const TICK_HZ = 70.086;
const table = JSON.parse(readFileSync(join(ROOT, 'web/data/parts.json'), 'utf8'));
const blocks = findBlocks(new Uint8Array(readFileSync(join(ROOT, 'DOPE.EXE')))).map((b) => b.data);
const p1End = table.part1Ticks / TICK_HZ;
const starts = []; { let t = p1End; for (const p of table.parts) { starts.push(t); t += p.ticks / TICK_HZ; } }
const partAt = (sec) => { let k = 0; while (k + 1 < starts.length && sec >= starts[k + 1]) k++; return k; };

// the chain as the worker makes it: a part that continues on the previous screen starts from where that one ends
const ends = [];
function endScreen(k) {
  if (!ends[k]) {
    const r = new PortRunner(blocks[table.parts[k].block], table.parts[k], table.parts[k].screen ? endScreen(k - 1) : null);
    r.advanceTo(1e9);
    const { pixels, pal } = r.snapshot();
    ends[k] = { pixels, pal };
  }
  return ends[k];
}
function digestAt(k, tick) {
  const p = table.parts[k];
  const r = new PortRunner(blocks[p.block], p, p.screen ? endScreen(k - 1) : null);
  r.advanceTo(tick);
  const { pixels, pal } = r.snapshot();
  let h = 0x811c9dc5;
  const mix = (v) => { h ^= v; h = Math.imul(h, 0x01000193) >>> 0; };
  for (let i = 0; i < 64000; i++) {
    const c = pixels[i] * 3, R = pal[c], G = pal[c + 1], B = pal[c + 2];
    mix((R << 2) | (R >> 4)); mix((G << 2) | (G >> 4)); mix((B << 2) | (B >> 4)); mix(255);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

let passed = 0, failed = 0;
const ok = (name, cond, detail) => { if (cond) { passed++; console.log('ok   ' + name); } else { failed++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); } };
const state = `(() => { const d = window.__dope; return d ? { started: d.started, t: d.t, status: d.status, digest: d.digest, ink: d.ink } : null; })()`;

const { page, base, cleanup } = await launch();
try {
  await page.goto(base + '?autostart=1');
  await page.until(state, (s) => s && s.started && s.t > 0.2, 'the demo to start');
  // [part index, seconds into the part]: parts 3, 5, 7 are exact; 2, 4, 6 only have to be drawn by a port
  let prevTick = -1;
  for (const [k, into, exact] of [[1, 20, true], [3, 25, true], [5, 12, true], [0, 30, false], [2, 40, false], [4, 30, false]]) {
    const sec = starts[k] + into;
    await page.eval(`__dope.seek(${sec})`);
    await page.eval('__dope.pause()');
    const want = `part ${k + 2} (block ${table.parts[k].block}) ported to JavaScript`;
    const tickOf = (x) => { const m = /tick (\d+) of/.exec(x.status); return m ? Number(m[1]) : -1; };
    const s = await page.until(state, (x) => x && x.status.includes(want) && tickOf(x) > 0 && tickOf(x) !== prevTick && x.ink > 500, `part ${k + 2} to be drawn`, 60000);
    await sleep(600); // paused: the picture and its tick are final
    const s2 = await page.eval(state);
    ok(`part ${k + 2}: the page shows a port's picture`, s2.status.includes(want) && s2.ink > 500, s2.status);
    ok(`part ${k + 2}: no page error`, !/error/i.test(s2.status), s2.status);
    if (exact) {
      const tick = Number(/tick (\d+) of/.exec(s2.status)[1]);
      ok(`part ${k + 2} at tick ${tick}: the canvas is the port's picture, byte for byte`, s2.digest === digestAt(k, tick), `page ${s2.digest} node ${digestAt(k, tick)}`);
    }
    prevTick = Number(/tick (\d+) of/.exec(s2.status)[1]);
    void s; void partAt;
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  cleanup(failed ? 1 : 0);
} catch (e) { console.log('FAIL', e.message); cleanup(1); }
void inflateRawSync;
