// Replayer invariants that need no external tools.
// Run: node tests/test_mod.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mod } from "../web/js/mod.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bytes = fs.readFileSync(path.join(root, "DOPE.MOD"));
const SR = 44100;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function skipSeconds(mod, seconds) {
  const target = Math.round(seconds * SR);
  const scratchL = new Float32Array(4096);
  const scratchR = new Float32Array(4096);
  let written = 0;
  let nextTick = mod.framesPerTick(SR);
  while (written < target) {
    let n = Math.min(Math.round(nextTick) - written, target - written);
    if (n <= 0) {
      mod.advanceTick();
      nextTick += mod.framesPerTick(SR);
      continue;
    }
    n = Math.min(n, 4096);
    mod.render(scratchL.subarray(0, n), scratchR.subarray(0, n), n);
    written += n;
    if (written >= Math.round(nextTick)) {
      mod.advanceTick();
      nextTick += mod.framesPerTick(SR);
    }
  }
  return written;
}

function renderSeconds(mod, seconds) {
  const frames = Math.round(seconds * SR);
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  let written = 0;
  let nextTick = mod.framesPerTick(SR);
  while (written < frames) {
    const n = Math.min(Math.round(nextTick) - written, frames - written);
    if (n <= 0) {
      mod.advanceTick();
      nextTick += mod.framesPerTick(SR);
      continue;
    }
    mod.render(l.subarray(written, written + n), r.subarray(written, written + n), n);
    written += n;
    mod.advanceTick();
    nextTick += mod.framesPerTick(SR);
  }
  return { l, r };
}

test("header", () => {
  const m = new Mod(bytes, SR);
  assert(m.signature === "28CH", `signature ${m.signature}`);
  assert(m.channels === 28, `channels ${m.channels}`);
  assert(m.patternCount === 70, `patterns ${m.patternCount}`);
  assert(m.songLength === 124, `orders ${m.songLength}`);
  assert(m.samples.filter((s) => s.length).length === 23, "sample count");
  assert(m.sampleDataEnd === bytes.length, `sample data ends at ${m.sampleDataEnd}`);
});

test("tables", () => {
  const m = new Mod(bytes, SR);
  // the loop window of sample 4 (ping.Leadi) is inside the sample
  const s = m.samples[3];
  assert(s.loopStart === 11324, `loopStart ${s.loopStart}`);
  assert(s.loopLength === 8804, `loopLength ${s.loopLength}`);
  assert(s.loopStart + s.loopLength <= s.length, "loop must fit in the sample");
  assert(m.samples[16].volume === 46, `sample 17 volume ${m.samples[16].volume}`);
});

test("silence-free output", () => {
  const m = new Mod(bytes, SR);
  const { l, r } = renderSeconds(m, 8);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < l.length; i++) {
    sum += l[i] * l[i];
    peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    assert(Number.isFinite(l[i]) && Number.isFinite(r[i]), `NaN at ${i}`);
  }
  const rms = Math.sqrt(sum / l.length);
  assert(rms > 0.01, `rms too low ${rms}`);
  assert(peak <= 1, `peak ${peak}`);
});

test("seek equals continuous playback", () => {
  const continuous = new Mod(bytes, SR);
  const { l } = renderSeconds(continuous, 7);

  const seeked = new Mod(bytes, SR);
  const skipped = skipSeconds(seeked, 5);
  assert(skipped === 5 * SR, `skipped ${skipped}`);
  const { l: tail } = renderSeconds(seeked, 2);

  let diff = 0;
  const base = 5 * SR;
  for (let i = 0; i < tail.length; i++) {
    diff = Math.max(diff, Math.abs(tail[i] - l[base + i]));
  }
  assert(diff < 1e-6, `seek mismatch ${diff}`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
