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

const FF_IPT = 1500; // instructions between interrupts while fast forwarding
const PLAY_IPT = 4000; // minimum instructions after an interrupt while playing

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
let pumping = false;
let needFrame = false; // a restart is owed one picture even when paused

const chan = new MessageChannel();
chan.port1.onmessage = () => pump();
const kick = () => { if (!pumping) { pumping = true; chan.port2.postMessage(0); } };

function dueTick() {
  return target + (running ? (performance.now() - targetWall) / 1000 * TICK_HZ : 0);
}

function startPart(k, offset) {
  partIdx = k;
  const p = parts[k];
  const screen = p.screen ? screens[p.screen] : null;
  runner = new PartRunner(blocks[k], p, screen);
  seekTo = offset;
  if (offset > 0) postMessage({ type: 'seeking', part: k });
}

function pump() {
  pumping = false;
  if (!runner) return;
  const t0 = performance.now();
  if (runner.tick < seekTo) {
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
  if (now - lastFrame > 30 && runner.tick >= seekTo && (running || needFrame)) {
    lastFrame = now;
    needFrame = false;
    const { pixels, pal } = runner.snapshot();
    postMessage({ type: 'frame', part: partIdx, tick: runner.tick, pixels, pal, stats: { mips, exited: runner.exited } }, [pixels.buffer, pal.buffer]);
  }
  if (running || runner.tick < seekTo) { pumping = true; chan.port2.postMessage(0); }
}

onmessage = (e) => {
  const d = e.data;
  if (d.cmd === 'init') {
    blocks = d.blocks; parts = d.parts; screens = d.screens || {};
    postMessage({ type: 'ready' });
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
