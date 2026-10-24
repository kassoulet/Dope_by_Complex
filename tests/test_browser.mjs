/*
 * Browser smoke check: the demo page in a real (headless) Chrome.
 *
 * Everything here goes through the page's own transport -- the same functions
 * the buttons and keys call -- so it tests what a visitor gets, not a stand-in:
 *
 *   * the audio thread really produces samples, not just a running context;
 *   * pause silences the output and freezes the picture;
 *   * seeking to 0:30 lands on part 1's frame for that instant (the canvas
 *     digest is compared with the node render of the same counter), and seeking
 *     to 2:00 and 6:00 lands on the right reconstructed part with music
 *     playing and no stall;
 *   * the loop at the end of the demo (7:15) restarts from the top;
 *   * ?vm=1 plays part 1 on its own and stops at its end.
 *
 * It drives Chrome over the DevTools protocol, so it needs no npm packages:
 * node 22 has a WebSocket client and fetch built in.
 *
 *   node tests/test_browser.mjs            # CHROME=/path/to/chrome to override
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Part1, W, H, counterAt, END_COUNTER } from '../web/js/part1.js';
import { TICK_HZ } from '../web/js/ports/image.js';
import { launch, sleep, ROOT } from './browser_lib.mjs';

const PART1_SECONDS = END_COUNTER / 138; // 69 interrupts/s, counter += 2
const table = JSON.parse(readFileSync(join(ROOT, 'web/data/parts.json'), 'utf8'));
const starts = [];
let DEMO_END = PART1_SECONDS;
for (const p of table.parts) { starts.push(DEMO_END); DEMO_END += p.ticks / TICK_HZ; }
// the part on screen at `sec` (index into table.parts)
const partAt = (sec) => { let k = 0; while (k + 1 < starts.length && sec >= starts[k + 1]) k++; return k; };

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('ok   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + detail)); }
}
function eq(name, got, want) {
  ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const state = `(() => {
  const d = window.__dope;
  if (!d) return null;
  return { started: d.started, paused: d.paused, t: d.t, duration: d.duration,
           status: d.status, audio: d.audioState, level: d.audioLevel,
           frames: d.frames, digest: d.digest, ink: d.ink, aspect: d.aspect };
})()`;

const waitStarted = (page) => page.until(state, (s) => s && s.started && s.t > 0.2, 'the demo to start');

/* ---------------------------------------------------------------------- main */

const { page, base, cleanup } = await launch();

try {

  // Node's side of the part 1 comparison: the frame the original shows at 30 s.
  const part1 = Part1.fromExecutable(new Uint8Array(readFileSync(join(ROOT, 'DOPE.EXE'))));
  const digestOf = (counter) => {
    const rgba = part1.rgba(counter, new Uint8ClampedArray(W * H * 4));
    let h = 0x811c9dc5;
    for (let i = 0; i < rgba.length; i++) { h ^= rgba[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return (h >>> 0).toString(16).padStart(8, '0');
  };

  /* ------------------------------------------------ 1. it starts and plays */

  await page.goto(base + '?autostart=1');
  let s = await waitStarted(page);
  eq('page starts without a click', s.started, true);
  eq('audio context is running', s.audio, 'running');
  eq('canvas is shown 4:3', s.aspect, '4 / 3');
  eq('whole demo duration', Math.round(s.duration), Math.round(DEMO_END));

  // audio actually produces samples: the callback runs and the block is loud
  const level = await page.until(state, (x) => x && x.level > 0.001, 'non-silent audio', 8000);
  ok('audio thread produces samples', level.level > 0.001, 'level ' + level.level);
  const t1 = level.t;
  await sleep(700);
  s = await page.eval(state);
  ok('song clock advances with the audio', s.t > t1 + 0.4, `${t1.toFixed(2)} -> ${s.t.toFixed(2)}`);
  ok('part 1 is on screen first', /original part 1 -- counter \d+/.test(s.status), s.status);

  /* --------------------------------------------------- 2. pause freezes both */

  await page.eval('__dope.pause()');
  await sleep(300); // let the audio thread write one silent block
  const frozen = await page.eval(state);
  await sleep(800);
  const still = await page.eval(state);
  eq('pause freezes the song clock', still.t, frozen.t);
  eq('pause freezes the picture', still.digest, frozen.digest);
  eq('pause silences the output', still.level, 0);
  ok('pause keeps the picture up', still.ink > 0, 'ink ' + still.ink); // part 1 fades in from black: a few hundred lit pixels at counter ~180

  await page.eval('__dope.play()');
  const moving = await page.until(state, (x) => x && x.t > still.t + 0.2, 'playback to resume');
  ok('play resumes both', moving.level > 0.001 && !moving.paused, `level ${moving.level}`);

  /* ---------------------------------------------------- 3. seeking lands */

  // 0:30 -- part 1: the picture must be the original frame for that instant
  await page.eval('__dope.seek(30)');
  await sleep(400);
  s = await page.eval(state);
  ok('seek to 0:30 keeps the music playing', s.level > 0.001, 'level ' + s.level);
  ok('seek to 0:30 is still inside part 1', /original part 1/.test(s.status), s.status);
  ok('seek to 0:30 is where it says', Math.abs(s.t - 30.4) < 0.5, 't ' + s.t);
  await page.eval('__dope.pause()');
  await sleep(150); // let one animation frame redraw the frozen clock
  const at30 = await page.eval(state);
  const counter30 = counterAt(at30.t);
  eq('0:30 shows the original frame for its counter (' + counter30 + ')',
    at30.digest, digestOf(counter30));
  await page.eval('__dope.play()');

  // 2:00 and 6:00 -- parts run from the original code: restart + fast forward, then play
  for (const sec of [120, 360]) {
    const k = partAt(sec);
    await page.eval(`__dope.seek(${sec})`);
    const want = `part ${k + 2} (block ${table.parts[k].block})`;
    s = await page.until(state, (x) => x && x.status.includes(want) && /pictures\/s/.test(x.status) && x.ink > 1000,
      `${Math.floor(sec / 60)}:00 to settle on ${want}`, 90000);
    ok(`seek to ${Math.floor(sec / 60)}:00 lands on ${want}`, s.status.includes(want), s.status);
    ok(`seek to ${Math.floor(sec / 60)}:00 is where it says`, Math.abs(s.t - sec) < 12, 't ' + s.t);
    const lv = await page.until(state, (x) => x && x.level > 0.001, 'the music after the seek', 4000).catch(() => s);
    ok(`seek to ${Math.floor(sec / 60)}:00 keeps the music`, lv.level > 0.001, 'level ' + lv.level);
    ok(`seek to ${Math.floor(sec / 60)}:00 draws a picture`, s.ink > 1000, 'ink ' + s.ink);
    ok(`seek to ${Math.floor(sec / 60)}:00 has no page error`, !/^(JS error|error:)/.test(s.status), s.status);
  }

  // pause freezes an emulated part too (a part is a port now: let the first frames land before pausing)
  await sleep(2500);
  await page.eval('__dope.pause()');
  await sleep(500);
  const e1 = await page.eval(state);
  await sleep(1500);
  const e2 = await page.eval(state);
  eq('pause freezes the song clock in an emulated part', e2.t, e1.t);
  eq('pause freezes the emulated picture', e2.digest, e1.digest);
  await page.eval('__dope.play()');
  const e3 = await page.until(state, (x) => x && x.digest !== e1.digest, 'the emulated picture to move again', 20000);
  ok('play moves the emulated picture again', e3.digest !== e1.digest);

  /* ------------------------------------------------------ 4. the 7:15 loop */

  await page.eval(`__dope.seek(${DEMO_END - 1})`);
  await sleep(200);
  s = await page.until(state, (x) => x && x.t < 5, 'the loop at the end', 6000);
  ok('loop at 7:15 wraps to the start', s.t < 5, 't ' + s.t);
  ok('loop restarts part 1', /original part 1/.test(s.status), s.status);
  ok('loop is still playing', s.level > 0.001, 'level ' + s.level);
  ok('loop leaves the page healthy', !/^(JS error|error:)/.test(s.status), s.status);

  /* ------------------------------------------------------------- 5. ?vm=1 */

  await page.goto(base + '?vm=1&autostart=1');
  s = await page.until(state, (x) => x && x.started && x.t > 0.2, '?vm=1 to start');
  eq('?vm=1 duration is part 1 only', Math.round(s.duration * 100) / 100, Math.round(PART1_SECONDS * 100) / 100);
  ok('?vm=1 draws part 1', /original part 1/.test(s.status), s.status);
  s = await page.until(state, (x) => x && x.level > 0.001, '?vm=1 audio', 8000);
  ok('?vm=1 plays audio', s.level > 0.001, 'level ' + s.level);
  ok('?vm=1 has no page error', !/^(JS error|error:)/.test(s.status), s.status);
  // and it ends by looping inside its own duration
  await page.eval(`__dope.seek(${PART1_SECONDS - 0.5})`);
  s = await page.until(state, (x) => x && x.t < 3, '?vm=1 to loop at its end', 6000);
  ok('?vm=1 loops at the end of part 1', s.t < 3 && /original part 1/.test(s.status), `t ${s.t} ${s.status}`);

  page.close();
  console.log(`${passed}/${passed + failed} passed`);
  cleanup(failed ? 1 : 0);
} catch (err) {
  console.log('FAIL ' + err.message);
  console.log(`${passed}/${passed + failed + 1} passed (1 error)`);
  cleanup(1);
}
