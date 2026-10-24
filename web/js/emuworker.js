/*
 * dope/emuworker.js -- parts 2..7 of the demo, run as their JavaScript ports (web/js/ports/).
 *
 * The page's clock (the audio) says which tick of which part is due; this worker moves the port's
 * own clock to that tick and sends the picture.  A port has no instructions to run, only ticks to
 * advance, so playing and seeking are the same thing.
 *
 * messages in:   {cmd:'init', blocks, parts}
                {cmd:'recycle', buf}                        a frame's RGBA buffer, to be reused
 *                {cmd:'play', part, offset, tick, running}   (re)start a part at `offset` ticks
 *                {cmd:'clock', part, tick, running}          the player's clock, in ticks of this part
 * messages out:  {type:'ready'} {type:'frame', part, tick, rgba, stats} {type:'seeking', part}
 */
import { PortRunner } from './ports/index.js';
import { TICK_HZ } from './ports/image.js';

let blocks = [];
let parts = [];
let runner = null;
let partIdx = -1;
let target = 0; // ticks of the current part, as of `targetWall`
let targetWall = 0;
let running = false;
let seekTo = 0;
let lastFrame = 0;
let lastSum = -1;
let fps = 0;
let fpsCount = 0;
let fpsAt = 0;
let pumping = false;
const timings = {}; // name -> {n, sum, max, over}: advance / render / part start, in ms
function note(name, ms) {
  const p = timings[name] || (timings[name] = { n: 0, sum: 0, max: 0, over: 0 });
  p.n++; p.sum += ms; if (ms > p.max) p.max = ms; if (ms > 8) p.over++;
}
let needFrame = false; // a restart is owed one picture even when paused

function dueTick() {
  return target + (running ? (performance.now() - targetWall) / 1000 * TICK_HZ : 0);
}

// The screen a part leaves for the next: part k is run to its end (a port only moves its clock,
// about 0.7 s for the whole chain) and its picture and palette are taken.  The parts that continue
// on the previous screen (4, 5, 6) start from it, so the cut between two parts is the one the viewer
// was just looking at.
const ends = [];
function endScreen(k) {
  if (!ends[k]) {
    const r = new PortRunner(blocks[k], parts[k], parts[k].screen ? endScreen(k - 1) : null);
    r.advanceTo(1e9);
    const { pixels, pal } = r.snapshot();
    ends[k] = { pixels, pal };
  }
  return ends[k];
}

function startPart(k, offset) {
  const s0 = performance.now();
  partIdx = k;
  const p = parts[k];
  runner = new PortRunner(blocks[k], p, p.screen ? endScreen(k - 1) : null);
  seekTo = offset;
  note('start part', performance.now() - s0);
  if (offset > 0) postMessage({ type: 'seeking', part: k });
}

const lut = new Uint8Array(256 * 3); // palette entry -> 8 bit component
// RGBA buffers (320 x 200 x 4) go to the page and come back to be reused: no garbage per frame
const pool = [];
const takeBuf = () => pool.pop() || new Uint8ClampedArray(320 * 200 * 4);

let timer = 0; // one pending wake-up at most
function later() { if (!timer) timer = setTimeout(() => { timer = 0; kick(); }, 8); }

function pump() {
  pumping = false;
  if (!runner) return;
  const a0 = performance.now();
  runner.advanceTo(runner.tick < seekTo ? seekTo : running ? Math.floor(dueTick()) : runner.tick);
  const now = performance.now();
  note('advance', now - a0);
  if (now - lastFrame > 15 && runner.tick >= seekTo && (running || needFrame)) {
    lastFrame = now;
    needFrame = false;
    const r0 = performance.now();
    const { pixels, pal } = runner.view();
    // the card's 6 bit palette to 8 bit RGBA here, off the page's thread
    const rgba = takeBuf();
    for (let i = 0; i < 768; i++) { const v = pal[i] & 63; lut[i] = (v << 2) | (v >> 4); }
    for (let i = 0, j = 0; i < 64000; i++, j += 4) {
      const c = pixels[i] * 3;
      rgba[j] = lut[c]; rgba[j + 1] = lut[c + 1]; rgba[j + 2] = lut[c + 2]; rgba[j + 3] = 255;
    }
    note('render', performance.now() - r0);
    // distinct pictures per second: what the port really draws
    let sum = 0;
    for (let i = 0; i < 64000; i += 7) sum = (sum * 31 + pixels[i]) | 0;
    if (sum !== lastSum) { fpsCount++; lastSum = sum; }
    if (now - fpsAt > 1000) { fps = fpsCount * 1000 / (now - fpsAt); fpsCount = 0; fpsAt = now; }
    postMessage({ type: 'frame', part: partIdx, tick: runner.tick, rgba, stats: { fps, exited: runner.exited, timings, heap: performance.memory ? performance.memory.usedJSHeapSize : 0 } }, [rgba.buffer]);
  }
  // come back at the display's pace instead of spinning
  if (running || runner.tick < seekTo) later();
}

function kick() { if (!pumping) { pumping = true; pump(); } }

onmessage = (e) => {
  const d = e.data;
  if (d.cmd === 'init') {
    blocks = d.blocks; parts = d.parts;
    postMessage({ type: 'ready' });
    // the chain of end screens a seek into parts 4..6 needs takes a second: do it while part 1 plays
    setTimeout(() => { try { for (let k = 0; k + 1 < parts.length; k++) if (parts[k + 1].screen) endScreen(k); } catch (err) { /* the seek will try again */ } }, 1500);
  } else if (d.cmd === 'play') {
    startPart(d.part, d.offset);
    target = d.tick; targetWall = performance.now(); running = d.running;
    lastFrame = 0;
    needFrame = true;
    kick();
  } else if (d.cmd === 'recycle') {
    pool.push(new Uint8ClampedArray(d.buf));
  } else if (d.cmd === 'clock') {
    if (d.part !== partIdx) return;
    target = d.tick; targetWall = performance.now();
    const was = running; running = d.running;
    if (running && !was) kick();
    else if (running) later();
  }
};
