// seek lands on the same sound as continuous playback; duration matches libopenmpt (514.7 s)
import { readFileSync } from "node:fs";
import { Mod } from "../web/js/mod.js";
import { seekMod, renderBlock, songDuration } from "../web/js/transport.js";

const SR = 22050;
const bytes = new Uint8Array(readFileSync(new URL("../DOPE.MOD", import.meta.url)));
const BLOCK = 2048;
const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);

// continuous: mix 12 s, keep the last 0.5 s
const a = new Mod(bytes, SR);
a.reset(0);
let tl = a.framesPerTick(SR);
const total = 12 * SR;
let tail = null;
for (let done = 0; done < total + SR / 2; done += BLOCK) {
  tl = renderBlock(a, l, r, BLOCK, tl, SR);
  if (done >= total) tail = (tail || []).concat(Array.from(l));
}
// seeked: jump to 12 s (block aligned), mix 0.5 s
const b = new Mod(bytes, SR);
const alignedFrames = Math.ceil(total / BLOCK) * BLOCK;
let tb = seekMod(b, alignedFrames / SR, SR);
let tail2 = [];
for (let done = 0; done < SR / 2; done += BLOCK) {
  tb = renderBlock(b, l, r, BLOCK, tb, SR);
  tail2 = tail2.concat(Array.from(l));
}
// compare from the block-aligned point
const off = 0; // both start at alignedFrames
let diff = 0, ref = 0;
const n = Math.min(tail2.length, 4000);
for (let i = 0; i < n; i++) { diff += Math.abs(tail2[i] - tail[i + off]); ref += Math.abs(tail[i + off]); }
console.log(`seek diff ${diff.toFixed(4)} of ${ref.toFixed(4)}`);
if (!(diff < ref * 0.02 + 1e-3)) throw new Error("seek differs from continuous playback");

const d = songDuration(bytes, 44100);
console.log(`duration ${d.toFixed(2)} s`);
if (Math.abs(d - 514.69) > 2) throw new Error("duration off");
console.log("ok");
