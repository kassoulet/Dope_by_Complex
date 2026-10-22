/*
 * Regression tests for web/js/part1.js -- the transcoded part 1.
 *
 * The port does not emulate a VGA card: it writes the 320x200 image for a
 * counter straight out of the demo's own data.  These tests pin the pieces of
 * that transcode -- where the picture lands, how the counter maps to the
 * scroll, the palette -- plus a frame digest per reference counter, so a
 * change to any of them shows up immediately.  The digests are the frames that
 * `tools/part1check.mjs` writes and `tools/framediff.py` compares against the
 * reference screenshots (eleven of fifteen byte identical, four by 8 pixels).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findBlocks } from '../web/js/rnc.js';
import {
  Part1,
  W,
  H,
  PICTURE_OFFSET,
  PICTURE_ROW_BASE,
  PICTURE_ROW_PITCH,
  PICTURE_ROW_SOURCE,
  PICTURE_ROWS,
  VRAM_PIXELS,
  TICKS_PER_SECOND,
  COUNTS_PER_TICK,
  END_COUNTER,
  PART1_SECONDS,
  counterAt,
  ramp,
} from '../web/js/part1.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXE = new Uint8Array(readFileSync(join(ROOT, 'DOPE.EXE')));

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('ok   ' + name);
  } else {
    failed++;
    console.log('FAIL ' + name + (detail ? '  ' + detail : ''));
  }
}

function eq(name, got, want) {
  ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

function fnv1a(data) {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const part = Part1.fromExecutable(EXE);
const block = findBlocks(EXE)[1].data;
const strip = block.subarray(PICTURE_OFFSET, PICTURE_OFFSET + PICTURE_ROWS * PICTURE_ROW_SOURCE);

// ------------------------------------------------------------------- picture

eq('card memory is 256 KB of planes', part.vram.length, VRAM_PIXELS);

{
  // The unpack of 0xc5c scatters four planes; with four pixels read back per
  // plane byte the strip's byte k of row r is the pixel at r, k -- so the
  // picture is placed by copying rows, not by running the unpack loop.
  let bad = 0;
  for (let r = 0; r < PICTURE_ROWS; r++) {
    const at = PICTURE_ROW_BASE + PICTURE_ROW_PITCH * r;
    for (let k = 0; k < PICTURE_ROW_SOURCE; k++) {
      if (part.vram[at + k] !== strip[r * PICTURE_ROW_SOURCE + k]) bad++;
    }
  }
  eq('every strip byte is the picture pixel at row r, column k', bad, 0);
}

{
  let above = 0;
  for (const v of part.vram) if (v > 63) above++;
  eq('the picture only uses the 64 DAC entries the part writes', above, 0);
}

// -------------------------------------------------------------------- scroll

// 0xc8b writes `counter >> 4` to the CRTC start and 0xca3 writes
// `((counter >> 2) & 3) * 2` to the panning register; both are counted in
// plane bytes, which are four pixels each, and the panning value shifts by
// value / 2 - 1 pixels.
eq('start at counter 0', part.startPixels(0), 0);
eq('pan at counter 0', part.panPixels(0), -1);
eq('line start at counter 774', part.lineStart(774), 192);
eq('pan at counter 774', part.panPixels(774), 0);
eq('line start at counter 1050', part.lineStart(1050), 261);
eq('pan at counter 1050', part.panPixels(1050), 1);
eq('line start at counter 5376', part.lineStart(5376), 1343);
eq('one pixel of scroll per four counts', part.lineStart(4096) - part.lineStart(0), 1024);
eq('the counter runs 2 counts per interrupt', COUNTS_PER_TICK, 2);
eq('69 interrupts per second', TICKS_PER_SECOND, 69);
eq('part 1 ends at counter 0x1500', END_COUNTER, 0x1500);

// ------------------------------------------------------------------ palette

{
  // 0xc00 fills a ramp by adding `steps >> 4` to a 16 bit accumulator and
  // storing its high byte; a negative step (a 16 bit borrow) becomes zero.
  const out = new Uint8Array(0x40);
  ramp(0x100, out);
  // steps >> 4 goes into a 16 bit accumulator, so a step of 16 raises the high
  // byte once every 16 entries.
  eq('ramp(0x100) rises one per sixteen entries',
    [out[0], out[15], out[16], out[32]].join(','), '0,0,1,2');
  ramp(0x1000, out);
  eq('ramp(0x1000) rises one per entry and clamps',
    [out[0], out[1], out[62], out[63]].join(','), '0,1,62,63');
  ramp(0xfff0, out);
  eq('ramp with a negative step is zero', out.every((v) => v === 0), true);
  ramp(0, out);
  eq('ramp with a zero step is zero', out.every((v) => v === 0), true);
}

{
  // Measured from the original code's DAC at counter 774 (docs/RUNTIME.md).
  const pal = part.palette(774);
  eq('palette at 774, first entries', Array.from(pal.subarray(0, 12)).join(','), '0,0,0,0,0,0,0,0,1,0,0,2');
  eq('palette is 64 colours', pal.length, 192);
  ok('palette stays inside 6 bit range', pal.every((v) => v <= 63));
  eq('palette is a pure function of the counter', fnv1a(part.palette(774)), fnv1a(part.palette(774)));
}

// ------------------------------------------------------------------- frames

const EXPECTED = [
  [0, 0x38c165c5],
  [222, 0xef5db21f],
  [774, 0x52fc1b05],
  [1326, 0x8083f160],
  [5376, 0x38c165c5],
];

for (const [counter, digest] of EXPECTED) {
  const frame = part.frame(counter);
  eq(`frame(${counter}) matches the reference-verified digest`, fnv1a(frame), digest);
}

{
  const frame = part.frame(774);
  // Independent restatement of the window copy: row y is 320 pixels taken from
  // `lineStart + 1344 * y`, with anything outside card memory black.
  let bad = 0;
  for (let y = 0; y < H; y++) {
    const src = part.lineStart(774) + PICTURE_ROW_PITCH * y;
    for (let x = 0; x < W; x++) {
      const want = src + x >= 0 && src + x < part.vram.length ? part.vram[src + x] : 0;
      if (frame[y * W + x] !== want) bad++;
    }
  }
  eq('a frame is the window copy it should be', bad, 0);
  eq('the picture starts 128 pixels into the first row', frame.subarray(100 * W, 101 * W).findIndex((v) => v), 154);
  eq('rows past the 195 row picture are black', frame.subarray(197 * W, 198 * W).every((v) => !v), true);
}

{
  const frame = part.frame(0);
  eq('at counter 0 the picture has not scrolled into view', frame.every((v) => !v), true);
}

{
  // The original's clock: 69 interrupts/s, 2 counts each, 39 s of part 1.
  eq('counter after 0 s', counterAt(0), 0);
  eq('counter after 1 s', counterAt(1), 138);
  eq('counter after 10 s', counterAt(10), 1380);
  eq('the counter stops at the end of part 1', counterAt(39), END_COUNTER);
  eq('and stays there', counterAt(600), END_COUNTER);
  // The page uses this boundary to hand over to the reconstruction.
  ok('part 1 is 38.96 s long', Math.abs(PART1_SECONDS - 38.9565) < 1e-3, String(PART1_SECONDS));
  eq('the frame before the end is still part 1', counterAt(PART1_SECONDS - 0.01) < END_COUNTER, true);
  eq('the boundary frame is the last one', counterAt(PART1_SECONDS), END_COUNTER);
}

{
  // Straight to RGBA is the same image as the index frame through the DAC.
  const frame = part.frame(774);
  const pal = part.palette(774);
  const rgba = part.rgba(774, new Uint8ClampedArray(W * H * 4));
  let bad = 0;
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) {
      const v = pal[frame[i] * 3 + c];
      if (rgba[i * 4 + c] !== ((v << 2) | (v >> 4))) bad++;
    }
    if (rgba[i * 4 + 3] !== 255) bad++;
  }
  eq('rgba matches the indexed frame through the 6 bit DAC', bad, 0);
}

console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
