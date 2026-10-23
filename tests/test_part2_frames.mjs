/*
 * Part 2 rendered one frame per timer tick, from its own block.
 *
 * `tools/part2frames.mjs` suppresses the PIT and calls the part's own frame
 * hook at the top of the screen routine's wait, so the counter advances by one
 * per blit instead of by the 100..200 the free-running rig covers while a
 * frame is drawn.  These checks pin the frame order, the picture and the
 * credits band.  They do not claim the frames are the captured screenshots:
 * the comparison against build/ref_p2 is reported by the tool's docs, and the
 * engine is still not ported to the page (web/js/part2.js has the palette,
 * bands, shade table and compose, not the 3D layer).
 *
 *   node tests/test_part2_frames.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderPart2Frames } from '../tools/part2frames.mjs';
import { Part2 } from '../web/js/part2.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('ok   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + detail)); }
}
function eq(name, got, want) {
  ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
function fnv1a(data) {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) { h ^= data[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0).toString(16);
}

const blockPath = join(ROOT, 'build', 'block02_00f66c.bin');
if (!existsSync(blockPath)) {
  console.log('skip: no build/block02_00f66c.bin (python3 tools/unpack.py)');
  process.exit(0);
}
const block = new Uint8Array(readFileSync(blockPath));

// 70 frames: one per counter, enough to pass the first show's first segment and
// to have a stable palette (the intro does not run the fade; the hook's ramp is
// the identity until the script sets cs:0x193f at the very end).
const frames = [];
renderPart2Frames(block, {
  maxFrames: 70,
  onFrame(frame) { frames.push(frame); },
});

eq('the tool rendered 70 frames', frames.length, 70);
eq('the first frame is counter 1', frames[0].counter, 1);
eq('the counter advances by one per frame', frames[69].counter, 70);
ok('every frame has the part\'s picture', frames.every((f) => f.pixels.some((v) => v)),
  String(frames.filter((f) => !f.pixels.some((v) => v)).length) + ' blank');

// Pictures, not just counters: the first frame and a later one are pinned so a
// changed instruction, a changed relocation or a different timer convention
// shows up as a digest change.
eq('frame 1 digest', fnv1a(frames[0].pixels), '9438d9ec');
eq('frame 70 digest', fnv1a(frames[69].pixels), '8034fdcd');
ok('the picture changes from frame to frame', fnv1a(frames[0].pixels) !== fnv1a(frames[1].pixels));
ok('the palette is the part\'s base palette (this scene does not fade in)',
  fnv1a(frames[0].palette) === fnv1a(new Part2(block).palette(0x100)),
  'palette ' + fnv1a(frames[0].palette));

// The credits band is the part's own data composed through its own table, and
// the one-tick run must still put it on the screen at the band strip's rows.
// Some of it is covered by the 3D layer, so the check is a large majority, not
// every byte.
{
  const part = new Part2(block);
  // The 3D buffer is 0x80 where no polygon covered it (the shade table's three
  // copies are addressed by the *high* bit of the span byte), and the band is
  // copied to 0x6e00 (row 88) of the background buffer.  The blit starts one
  // row into the composed buffer, so display row y is composed row y+1.
  const span = new Uint8Array(320 * 200).fill(0x80);
  const bg = new Uint8Array(320 * 200);
  bg.set(part.band(0), 0x6e00);
  const want = part.compose(span, bg);
  let best = 0;
  let bestShift = 0;
  for (const shift of [0, 1]) {
    let same = 0;
    let total = 0;
    for (let y = 88; y < 120; y++) {
      for (let x = 0; x < 320; x++) {
        total++;
        if (frames[0].pixels[(y - shift) * 320 + x] === want[y * 320 + x]) same++;
      }
    }
    if (same / total > best) { best = same / total; bestShift = shift; }
  }
  ok('the credit band is composed from block 2 and in the right rows',
    best > 0.8, `${best.toFixed(3)} exact at shift ${bestShift}`);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
