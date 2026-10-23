/*
 * dope/main.js -- glue: load the module, run the replayer through Web Audio,
 * and draw at 320x200 into the canvas.
 *
 * The page plays the demo in order.  Part 1 is the original's own picture and
 * palette, transcoded from DOPE.EXE (web/js/part1.js) and driven by the
 * module clock, so the first ~39 s are the 1995 thing; when the part's counter
 * runs out the page hands over to the scene reconstruction of parts 2..7.
 * `?vm=1` plays part 1 on its own, and `?scene=N` pins one reconstructed scene.
 *
 * Transport: one song clock (audio frames rendered) drives every picture, so
 * pause freezes both and seek moves both (transport.js).  The canvas is
 * 320x200 but shown 4:3, the shape a VGA monitor gave mode 13h.
 */


import { Mod } from "./mod.js";
import { seekMod, renderBlock } from "./transport.js";
import { findBlocks } from "./rnc.js";
import { EmuParts } from "./emuparts.js";
import { Part1, W, H, counterAt, END_COUNTER, TICKS_PER_SECOND, COUNTS_PER_TICK } from "./part1.js";

const $ = (id) => document.getElementById(id);
const canvas = $("screen");
const status = $("status");
const playBtn = $("play");
const seekBar = $("seek");
const timeLabel = $("time");
const aspectBtn = $("aspect");

const params = new URLSearchParams(location.search);
const forcedScene = null; // (the old ?scene=N pin went with the placeholder scenes)
const originalMode = params.has("vm") || params.get("part") === "1"; // part 1 only
const stillSeconds = params.has("t") ? Math.max(0, Number(params.get("t")) || 0) : null;
const PART1_SECONDS = END_COUNTER / COUNTS_PER_TICK / TICKS_PER_SECOND;

const pctx = canvas.getContext("2d");
pctx.imageSmoothingEnabled = false;

let mod = null;
let bytes = null;
let audio = null;
let node = null;
let sr = 44100;
let tickLeft = 0;
let duration = originalMode ? PART1_SECONDS : 473; // replaced by the part lengths once DOPE.EXE is read
let emu = null; // parts 2..7, run from the original code
let started = false;
let clockOn = false; // the clock only runs once DOPE.EXE, the module and the audio are ready
let paused = false;
let framesDone = 0; // song clock, in output frames
let ctxMark = 0; // audio.currentTime when framesDone was last updated
let wallT = 0; // silent fallback clock
let wallMark = 0;
let part = null;
let partImage = null;
let playing = null;
let lastLevel = 0; // peak of the last audio block, for the browser check

/* ------------------------------------------------------------------ aspect */

// mode 13h is 320x200 shown on a 4:3 tube: pixels are 1.2 times taller than wide
let squarePixels = false;
function applyAspect() {
  canvas.style.aspectRatio = squarePixels ? "16 / 10" : "4 / 3";
  aspectBtn.textContent = squarePixels ? "aspect: 16:10 (raw)" : "aspect: 4:3 (CRT)";
}
aspectBtn.addEventListener("click", () => { squarePixels = !squarePixels; applyAspect(); });
applyAspect();

window.addEventListener("error", (e) => { status.textContent = `JS error: ${e.message}`; });

/* ------------------------------------------------------------------ clock */

function now() {
  if (!clockOn) return wallT; // still loading: the song has not started
  if (!node) return wallT + (paused || !started ? 0 : performance.now() / 1000 - wallMark);
  // audio frames are produced in 2048 frame blocks: extrapolate between them
  const extra = paused ? 0 : Math.min(2048 / sr, Math.max(0, audio.currentTime - ctxMark));
  return framesDone / sr + extra;
}

function seekTo(seconds) {
  seconds = Math.max(0, Math.min(duration - 0.05, seconds));
  if (emu) emu.markSeek();
  if (mod) tickLeft = seekMod(mod, seconds, sr);
  framesDone = Math.round(seconds * sr);
  wallT = seconds;
  wallMark = performance.now() / 1000;
  if (audio) ctxMark = audio.currentTime;
  drawAt(seconds);
  updateTransport(seconds);
}

function setPaused(p) {
  if (!started) return;
  if (p === paused) return;
  const t = now();
  paused = p;
  if (!node) { wallT = t; wallMark = performance.now() / 1000; }
  playBtn.textContent = paused ? "▶ play" : "❚❚ pause";
  if (audio && !paused) { audio.resume().catch(() => {}); ctxMark = audio.currentTime; }
}

function updateTransport(t) {
  if (!seekBar.matches(":active")) seekBar.value = String(Math.round((t / duration) * 1000));
  const f = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
  timeLabel.textContent = `${f(t)} / ${f(duration)}`;
}

/* ------------------------------------------------------------------- audio */

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot load ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function startAudio() {
  audio = new AudioContext();
  audio.resume().catch(() => {});
  sr = audio.sampleRate;
  mod = new Mod(bytes, sr);
  tickLeft = seekMod(mod, 0, sr);

  // A ScriptProcessor keeps the replayer tick-accurate without an
  // AudioWorklet; 2048 frames is ~46 ms and 28 voices cost well under 1 ms.
  const blockSize = 2048;
  const left = new Float32Array(blockSize);
  const right = new Float32Array(blockSize);
  node = audio.createScriptProcessor(blockSize, 0, 2);
  node.onaudioprocess = (e) => {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    if (paused) { outL.fill(0); outR.fill(0); lastLevel = 0; return; }
    tickLeft = renderBlock(mod, left, right, blockSize, tickLeft, sr);
    outL.set(left);
    outR.set(right);
    let peak = 0;
    for (let i = 0; i < blockSize; i++) {
      const a = left[i] < 0 ? -left[i] : left[i];
      if (a > peak) peak = a;
    }
    lastLevel = peak;
    framesDone += blockSize;
    ctxMark = audio.currentTime;
  };
  node.connect(audio.destination);
}

async function start() {
  if (started) return;
  started = true;
  status.textContent = "loading DOPE.MOD...";
  bytes = await fetchBytes("../DOPE.MOD");
  mod = new Mod(bytes, 44100);

  if (forcedScene === null) {
    status.textContent = "reading DOPE.EXE...";
    try {
      const blocks = findBlocks(await fetchBytes("../DOPE.EXE")).map((b) => b.data);
      part = new Part1(blocks[1]);
      if (!originalMode) {
        emu = await EmuParts.load(blocks, PART1_SECONDS);
        duration = emu.end;
      }
    } catch (err) {
      console.warn("DOPE.EXE parts unavailable:", err);
    }
  }
  status.textContent = `DOPE.MOD - ${mod.channels} channels, ${mod.patternCount} patterns, ${mod.songLength} orders`;

  try {
    startAudio();
  } catch (err) {
    node = null; // headless / blocked autoplay: visuals keep running silently
    mod = new Mod(bytes, 44100);
    mod.reset(0);
    console.warn("audio unavailable:", err);
    status.textContent += " (audio unavailable)";
  }
  wallMark = performance.now() / 1000;
  clockOn = true;
  playBtn.disabled = false;
  playBtn.textContent = "❚❚ pause";
  requestAnimationFrame(frame);
}

/* ----------------------------------------------------------------- drawing */

function frame() {
  const t = now();
  if (t >= duration - 0.05) { seekTo(0); } else { drawAt(t); updateTransport(t); }
  requestAnimationFrame(frame);
}

// The demo in order: part 1's own frames until its counter runs out, then the
// reconstruction.  `?scene=N` pins a reconstructed scene and skips part 1.
function drawAt(t) {
  const counter = counterAt(t);
  if (part && forcedScene === null && counter < END_COUNTER) {
    playing = "part1";
    partImage = partImage || pctx.createImageData(W, H);
    part.rgba(counter, partImage.data);
    pctx.putImageData(partImage, 0, 0);
    status.textContent =
      `original part 1 -- counter ${counter} / ${END_COUNTER}` +
      `  scroll ${4 * (counter >> 4)}  pan ${part.panPixels(counter)}`;
    return;
  }
  if (!emu) return;
  const k = emu.draw(t, pctx, !paused);
  const s = emu.stats;
  status.textContent = `original code, part ${k + 2} (block ${emu.parts[k].block}) run in a JS x86 -- ` +
    (emu.seeking ? "seeking..." : `${s.fps.toFixed(0)} pictures/s, tick ${emu.frame ? emu.frame.tick : 0} of ${emu.parts[k].ticks}`);
}

/* ---------------------------------------------------------------- controls */

const run = (fn) => fn().catch((err) => { status.textContent = `error: ${err.message}`; console.error(err); });

canvas.addEventListener("click", () => { if (!started) run(start); else setPaused(!paused); });
playBtn.addEventListener("click", () => { if (!started) run(start); else setPaused(!paused); });
seekBar.addEventListener("input", () => { if (started) seekTo((seekBar.value / 1000) * duration); });
document.addEventListener("keydown", (e) => {
  if (!started || e.target === seekBar && e.key.startsWith("Arrow")) return;
  const key = { " ": () => setPaused(!paused), ArrowLeft: () => seekTo(now() - 5), ArrowRight: () => seekTo(now() + 5),
    Home: () => seekTo(0), j: () => seekTo(now() - 10), l: () => seekTo(now() + 10), k: () => setPaused(!paused) }[e.key];
  if (key) { e.preventDefault(); key(); }
});

/* --------------------------------------------------------------- test hook */

// tests/test_browser.mjs drives the page through this object: it reads the
// song clock, the visible picture and the audio level, and moves the transport
// the way the buttons and keys do.  The demo itself never looks at it.
function canvasDigest() {
  const d = pctx.getImageData(0, 0, W, H).data;
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function canvasInk() { // non-black pixels, to tell a picture from a blank card
  const d = pctx.getImageData(0, 0, W, H).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] || d[i + 1] || d[i + 2]) n++;
  return n;
}

window.__dope = {
  get started() { return started; },
  get paused() { return paused; },
  get t() { return now(); },
  get duration() { return duration; },
  get status() { return status.textContent; },
  get audioState() { return audio ? audio.state : null; },
  get audioLevel() { return lastLevel; },
  get frames() { return framesDone; },
  get aspect() { return getComputedStyle(canvas).aspectRatio; },
  get digest() { return canvasDigest(); },
  get ink() { return canvasInk(); },
  play: () => (started ? setPaused(false) : run(start)),
  pause: () => setPaused(true),
  seek: (seconds) => seekTo(seconds),
};

// draw an attract frame straight away so the page is never blank
updateTransport(0);

if (stillSeconds !== null) {
  // ?t=N pins the picture at N seconds: one frame, no audio (headless checks)
  run(async () => {
    bytes = await fetchBytes("../DOPE.MOD");
    mod = new Mod(bytes, 44100);
    mod.reset(0);
    if (forcedScene === null) {
      const blocks = findBlocks(await fetchBytes("../DOPE.EXE")).map((b) => b.data);
      part = new Part1(blocks[1]);
      if (stillSeconds >= PART1_SECONDS) emu = await EmuParts.load(blocks, PART1_SECONDS);
    }
    drawAt(stillSeconds);
  });
} else if (params.has("autostart")) {
  run(start);
} else if (location.protocol === "file:") {
  status.textContent = "serve this folder over http (python3 -m http.server) and reload";
} else {
  status.textContent = originalMode ? "click to play the original part 1 (pixel exact)" : "click to start";
}
