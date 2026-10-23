/*
 * dope/emuworker.js -- parts 2..7, run from DOPE.EXE's own code.
 *
 * The page's clock (the audio) says which tick of which part is due; this
 * worker feeds the part its timer interrupts at that pace and lets the
 * interpreter run in between, so the part draws as many frames as the
 * interpreter can manage and its animation keeps the original's speed.  A seek
 * restarts the part and calls the interrupt fast (`FF_IPT` instructions per
 * tick) until the part's own counters have caught up.
 *
 * messages in:   {cmd:'init', blocks, parts, screens}
 *                {cmd:'play', part, offset, tick, running}   (re)start a part at `offset` ticks
 *                {cmd:'clock', part, tick, running}          the player's clock, in ticks of this part
 * messages out:  {type:'ready'} {type:'frame', part, tick, pixels, pal, stats} {type:'seeking', part}
 */
import { PartRunner, TICK_HZ } from './partvm.js';
import { hasPort, PortRunner } from './ports/index.js';

// Instructions between interrupts when the clock is ahead of the part (a seek, or
// a stalled tab catching up).  Not smaller: the part draws a frame in about a
// million instructions and its timer interrupt moves the objects, so an
// interrupt every few thousand instructions changes the scene under the frame
// being drawn.  Part 6 loses its polygon list that way and never recovers
// (tested: 25,000 works, 12,000 hangs); 50,000 leaves a margin.
const FF_IPT = 50000;
const PLAY_IPT = 50000;

let blocks = [];
let parts = [];
let screens = {};
let runner = null;
let partIdx = -1;
let target = 0; // ticks of the current part, as of `targetWall`
let targetWall = 0;
let running = false;
let seekTo = 0;
let lastFrame = 0;
let insts = 0;
let statsAt = 0;
let statsInsts = 0;
let mips = 0;
let fps = 0;
let lastSum = -1;
let fpsCount = 0;
let fpsAt = 0;
let pumping = false;
let needFrame = false; // a restart is owed one picture even when paused

const chan = new MessageChannel();
chan.port1.onmessage = () => pump();
const kick = () => { if (!pumping) { pumping = true; chan.port2.postMessage(0); } };

function dueTick() {
  return target + (running ? (performance.now() - targetWall) / 1000 * TICK_HZ : 0);
}

// The screen a part leaves for the next: part k is run to its end (cheap, a port only moves its
// clock) and its picture and palette are taken.  The parts that continue on the previous screen (4, 5, 6)
// start from it, so the cut between two parts is the one the viewer was just looking at, not a
// recording made with the emulator (`screens`, kept as a fallback).
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
  partIdx = k;
  const p = parts[k];
  let screen = null;
  if (p.screen) { try { screen = endScreen(k - 1); } catch (e) { screen = screens[p.screen]; } }
  // every part has a port; the emulator is only the fallback for one that has not
  runner = hasPort(p.block) ? new PortRunner(blocks[k], p, screen) : new PartRunner(blocks[k], p, screen);
  seekTo = offset;
  if (offset > 0) postMessage({ type: 'seeking', part: k });
}

function pump() {
  pumping = false;
  if (!runner) return;
  const t0 = performance.now();
  if (runner.advanceTo) {
    // a port: no instructions, just ticks.  Seeking and playing are the same thing.
    runner.advanceTo(runner.tick < seekTo ? seekTo : running ? Math.floor(dueTick()) : runner.tick);
  } else if (runner.tick < seekTo) {
    // fast forward: interrupts as fast as the part will take them
    while (runner.tick < seekTo && performance.now() - t0 < 40 && !runner.exited) {
      if (runner.deliverTick()) { runner.run(FF_IPT); insts += FF_IPT; } else { runner.run(FF_IPT); insts += FF_IPT; }
    }
  } else if (running) {
    while (performance.now() - t0 < 12 && !runner.exited) {
      if (runner.tick < Math.floor(dueTick()) && runner.deliverTick()) { runner.run(PLAY_IPT); insts += PLAY_IPT; continue; }
      runner.run(20000); insts += 20000;
    }
  } else {
    // paused: nothing runs, keep the last picture
  }
  const now = performance.now();
  if (now - statsAt > 1000) { mips = (insts - statsInsts) / ((now - statsAt) * 1000); statsAt = now; statsInsts = insts; }
  if (now - lastFrame > 15 && runner.tick >= seekTo && (running || needFrame)) {
    lastFrame = now;
    needFrame = false;
    const { pixels, pal } = runner.snapshot();
    // distinct pictures per second: what the part really manages to draw
    let sum = 0;
    for (let i = 0; i < 64000; i += 7) sum = (sum * 31 + pixels[i]) | 0;
    if (sum !== lastSum) { fpsCount++; lastSum = sum; }
    if (now - fpsAt > 1000) { fps = fpsCount * 1000 / (now - fpsAt); fpsCount = 0; fpsAt = now; }
    postMessage({ type: 'frame', part: partIdx, tick: runner.tick, pixels, pal, stats: { mips, fps, exited: runner.exited } }, [pixels.buffer, pal.buffer]);
  }
  if (runner.advanceTo) {
    // ports are cheap: come back at the display's pace instead of spinning
    if (running || runner.tick < seekTo) setTimeout(() => { if (!pumping) { pumping = true; chan.port2.postMessage(0); } }, 8);
  } else if (running || runner.tick < seekTo) { pumping = true; chan.port2.postMessage(0); }
}

onmessage = (e) => {
  const d = e.data;
  if (d.cmd === 'init') {
    blocks = d.blocks; parts = d.parts; screens = d.screens || {};
    postMessage({ type: 'ready' });
    // the chain of end screens a seek into parts 4..6 needs takes a second: do it while part 1 plays
    setTimeout(() => { try { endScreen(parts.length - 2); } catch (e) { /* the seek will try again */ } }, 1500);
  } else if (d.cmd === 'play') {
    startPart(d.part, d.offset);
    target = d.tick; targetWall = performance.now(); running = d.running;
    lastFrame = 0;
    needFrame = true;
    kick();
  } else if (d.cmd === 'clock') {
    if (d.part !== partIdx) return;
    target = d.tick; targetWall = performance.now();
    const was = running; running = d.running;
    if (running && !was) kick();
    if (running) kick();
  }
};
