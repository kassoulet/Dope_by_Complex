/*
 * Where the page stutters: tools/perf.mjs [seconds per part]
 * Plays the page in headless Chrome, seeks into each part, and for `seconds` reports: animation frame intervals
 * (and how many were over 25 ms), the audio callback time (over 20 ms risks a dropout: a block is 43 ms at 48 kHz),
 * the worker's advance / render / part start times, the heap of the page and of the worker, and the garbage
 * collections seen as drops of the heap.
 */
import { readFileSync } from 'node:fs';
import { launch, sleep, ROOT } from '../tests/browser_lib.mjs';

const SECS = Number(process.argv[2] || 8);
const table = JSON.parse(readFileSync(ROOT + '/web/data/parts.json', 'utf8'));
const TICK_HZ = 70.086;
const starts = []; { let t = table.part1Ticks / TICK_HZ; for (const p of table.parts) { starts.push(t); t += p.ticks / TICK_HZ; } }
const f1 = (x) => (Math.round(x * 10) / 10).toString();
const sum = (p) => (p ? `n ${p.n} mean ${f1(p.sum / p.n)} max ${f1(p.max)} over ${p.over}` : '-');

const { page, base, cleanup } = await launch();
try {
  await page.goto(base + '?autostart=1');
  await page.until('window.__dope && window.__dope.started && window.__dope.t > 0.2', (x) => x, 'start');
  // part 1 first, as the viewer sees it
  await page.eval('__dope.resetPerf()');
  await sleep(SECS * 1000);
  console.log('part 1   raf', sum(await page.eval('__dope.perf.raf')), '| audio', sum(await page.eval('__dope.perf.audio')));
  for (let k = 0; k < starts.length; k++) {
    const b = table.parts[k].block;
    await page.eval(`__dope.seek(${starts[k] + 2})`);
    await sleep(1500); // let the part start
    await page.eval('__dope.resetPerf()');
    let last = 0, gcs = 0, heaps = [];
    for (let i = 0; i < SECS * 4; i++) {
      await sleep(250);
      const h = await page.eval('performance.memory ? performance.memory.usedJSHeapSize : 0');
      if (last && h < last - 200000) gcs++;
      last = h; heaps.push(h);
    }
    const perf = await page.eval('({raf: __dope.perf.raf, audio: __dope.perf.audio})');
    const ws = await page.eval('__dope.workerStats');
    const T = (ws && ws.timings) || {};
    console.log(`part ${k + 2} (block ${b})  raf ${sum(perf.raf)} | audio ${sum(perf.audio)} | worker advance ${sum(T.advance)} render ${sum(T.render)} start ${sum(T['start part'])}`);
    console.log(`          page heap ${f1(Math.min(...heaps) / 1e6)}..${f1(Math.max(...heaps) / 1e6)} MB, ${gcs} drops; worker heap ${f1((ws && ws.heap || 0) / 1e6)} MB; ${f1(ws ? ws.fps : 0)} pictures/s`);
  }
  cleanup(0);
} catch (e) { console.log('FAIL', e.message); cleanup(1); }
