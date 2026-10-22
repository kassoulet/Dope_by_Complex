// Render DOPE.MOD with the JS replayer to a WAV file (offline parity test).
// usage: node tools/modtest.mjs [seconds] [out.wav] [seekSeconds]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mod } from "../web/js/mod.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const seconds = Number(process.argv[2] || 30);
const outPath = process.argv[3] || path.join(root, "build", "js_render.wav");
const seek = Number(process.argv[4] || 0);
const sampleRate = 44100;

const bytes = fs.readFileSync(path.join(root, "DOPE.MOD"));
const mod = new Mod(bytes, sampleRate, { periodScale: Number(process.env.PERIOD_SCALE) || undefined });
console.log(
  `module "${mod.name}" signature ${mod.signature} channels ${mod.channels} ` +
    `patterns ${mod.patternCount} orders ${mod.songLength} samples ` +
    `${mod.samples.filter((s) => s.length).length}`
);

const frames = seconds * sampleRate;
const left = new Float32Array(frames);
const right = new Float32Array(frames);

// One loop for both cases.  Frames before the seek point are mixed into a
// scratch buffer and dropped; mixing has to happen (not just tick advances)
// because the sample positions are part of the player state.
const seekFrames = Math.round(seek * sampleRate);
const total = seekFrames + frames;
const scratchL = new Float32Array(4096);
const scratchR = new Float32Array(4096);
let written = 0;
let nextTick = mod.framesPerTick(sampleRate);
while (written < total) {
  const boundary = Math.round(nextTick) - written;
  if (boundary <= 0) {
    mod.advanceTick();
    nextTick += mod.framesPerTick(sampleRate);
    continue;
  }
  const dst = written >= seekFrames ? written - seekFrames : -1;
  const room = dst >= 0 ? frames - dst : 4096;
  const n = Math.min(boundary, room, 4096);
  if (dst >= 0) {
    mod.render(left.subarray(dst, dst + n), right.subarray(dst, dst + n), n);
  } else {
    mod.render(scratchL.subarray(0, n), scratchR.subarray(0, n), n);
  }
  written += n;
  if (written >= Math.round(nextTick)) {
    mod.advanceTick();
    nextTick += mod.framesPerTick(sampleRate);
  }
}

// 16 bit stereo WAV
const dataBytes = frames * 4;
const buf = Buffer.alloc(44 + dataBytes);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(sampleRate, 24);
buf.writeUInt32LE(sampleRate * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(dataBytes, 40);
let peak = 0;
for (let i = 0; i < frames; i++) {
  const l = Math.max(-1, Math.min(1, left[i]));
  const r = Math.max(-1, Math.min(1, right[i]));
  peak = Math.max(peak, Math.abs(l), Math.abs(r));
  buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
}
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buf);

// RMS envelope, 0.5 s blocks, used by the parity check
const block = sampleRate / 2;
const env = [];
for (let i = 0; i < frames; i += block) {
  let sum = 0;
  let count = 0;
  for (let j = i; j < Math.min(i + block, frames); j++) {
    sum += left[j] * left[j] + right[j] * right[j];
    count += 2;
  }
  env.push(Math.sqrt(sum / count));
}
fs.writeFileSync(outPath.replace(/\.wav$/, ".env.json"), JSON.stringify(env));
console.log(`wrote ${outPath} (${seconds}s, peak ${peak.toFixed(3)})`);
console.log("rms:", env.map((v) => v.toFixed(4)).join(" "));
