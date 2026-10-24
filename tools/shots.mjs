/*
 * Pictures of each part as the ports draw them: tools/shots.mjs  ->  web/img/parts/part<N>.png, a grid of frames
 * stretched to 4:3 like the page shows them (320 x 240 each, two columns)
 * The parts that remember their last frames (the fire of part 4, the glow of part 2, the lights of part 6)
 * are drawn a few times on the way, like the page does.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { findBlocks } from '../web/js/rnc.js';
import { PortRunner } from '../web/js/ports/index.js';
import { encodePNG, indexedToRGB } from './png.mjs';

const table = JSON.parse(readFileSync('web/data/parts.json', 'utf8'));
const blocks = findBlocks(new Uint8Array(readFileSync('DOPE.EXE'))).map((b) => b.data);
const ends = [];
function endScreen(k) {
  if (!ends[k]) {
    const r = new PortRunner(blocks[table.parts[k].block], table.parts[k], table.parts[k].screen ? endScreen(k - 1) : null);
    r.advanceTo(1e9);
    const s = r.snapshot();
    ends[k] = { pixels: s.pixels, pal: s.pal };
  }
  return ends[k];
}
const AT = { 2: [700, 2600, 4400, 7000], 3: [250, 1300, 2400, 3500], 4: [600, 2600, 4300, 5800, 7300], 5: [300, 1600, 2900, 4200], 6: [400, 1300, 2500, 3700], 7: [400, 1000, 1700, 2300] };
const stretch = (rgb) => { // 200 rows -> 240 rows, nearest: every fifth row twice
  const out = new Uint8Array(320 * 240 * 3);
  for (let y = 0; y < 240; y++) out.set(rgb.subarray(Math.floor(y / 1.2) * 960, Math.floor(y / 1.2) * 960 + 960), y * 960);
  return out;
};
table.parts.forEach((p, k) => {
  const r = new PortRunner(blocks[p.block], p, p.screen ? endScreen(k - 1) : null);
  const frames = AT[p.block].map((tick) => {
    for (let t = Math.max(r.tick, tick - 60); t < tick; t += 3) { r.advanceTo(t); r.snapshot(); }
    r.advanceTo(tick);
    const { pixels, pal } = r.snapshot();
    return stretch(indexedToRGB(pixels, pal, 320, 200));
  });
  const cols = 2, rows = Math.ceil(frames.length / cols), sheet = new Uint8Array(320 * cols * 240 * rows * 3);
  frames.forEach((f, i) => { for (let y = 0; y < 240; y++) sheet.set(f.subarray(y * 960, (y + 1) * 960), (((Math.floor(i / cols) * 240 + y) * cols * 320) + (i % cols) * 320) * 3); });
  writeFileSync(`web/img/parts/part${p.block}.png`, encodePNG(320 * cols, 240 * rows, sheet));
});
console.log('done');
