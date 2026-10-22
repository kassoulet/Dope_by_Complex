/*
 * dope/transport.js -- the song clock: tick scheduling, seek and duration.
 *
 * `tickLeft` is the fractional number of output frames until the next
 * tracker tick; carrying the fraction keeps the clock drift free (a tick is
 * 903.69 frames at tempo 122, rounding it would slip the music).
 */

import { Mod } from "./mod.js";

/** Reset `mod` and move it to `seconds` without mixing.  Returns tickLeft. */
export function seekMod(mod, seconds, sampleRate) {
  mod.reset(0);
  let tickLeft = mod.framesPerTick(sampleRate);
  let left = Math.round(seconds * sampleRate);
  while (left > 0) {
    if (tickLeft < 1) {
      mod.advanceTick();
      tickLeft += mod.framesPerTick(sampleRate);
      continue;
    }
    const n = Math.min(Math.floor(tickLeft), left);
    mod.skip(n);
    tickLeft -= n;
    left -= n;
  }
  return tickLeft;
}

/**
 * Fill l/r with `frames` frames, stepping ticks as they fall due.
 * Returns the new tickLeft.
 */
export function renderBlock(mod, l, r, frames, tickLeft, sampleRate) {
  let written = 0;
  while (written < frames) {
    if (tickLeft < 1) {
      mod.advanceTick();
      tickLeft += mod.framesPerTick(sampleRate);
      continue;
    }
    const n = Math.min(Math.floor(tickLeft), frames - written);
    mod.render(l.subarray(written, written + n), r.subarray(written, written + n), n);
    written += n;
    tickLeft -= n;
  }
  return tickLeft;
}

/** Length of the song in seconds: walk the ticks until the order list wraps. */
export function songDuration(bytes, sampleRate = 44100) {
  const mod = new Mod(bytes, sampleRate);
  mod.reset(0);
  let frames = 0;
  let order = mod.order;
  for (let guard = 0; guard < 2e6; guard++) {
    frames += mod.framesPerTick(sampleRate);
    mod.advanceTick();
    if (mod.order < order) break;
    order = mod.order;
  }
  return frames / sampleRate;
}
