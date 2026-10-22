/*
 * Part 2's palette, read out of DOPE.EXE and checked against the original.
 *
 * The claim under test (docs/RUNTIME.md): part 2 uses all 256 DAC entries,
 * loaded from two spans of its own block and rewritten every timer tick as
 * `palette[i] = ramp[base[i]]`; at the top of the ramp that is the base palette
 * unchanged, and every colour of every reference frame comes from it.  If that
 * holds, no per-scanline palette exists and the earlier "70..107 colours per
 * frame means the DAC is rewritten inside the frame" note was a miscount.
 *
 * The frame check needs `build/ref_p2` (tools/refcapture.py --start 55 ...),
 * which is not committed; without it that part is reported as skipped.
 *
 *   node tests/test_part2.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Part2, PALETTE_ENTRIES, FADE_STEP, FADE_TOP, FADE_FRAMES } from '../web/js/part2.js';

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

/* ------------------------------------------------------ minimal PNG reader */

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let w = 0, h = 0, depth = 0, color = 0, palette = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error('unsupported bit depth ' + depth);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) throw new Error('unsupported colour type ' + color);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8Array(w * h * channels);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      line[i] = v & 0xff;
    }
    out.set(line, y * stride);
    prev.set(line);
  }
  return { w, h, color, channels, palette, data: out };
}

/** Every RGB triple in the image, as a Set of packed 0xRRGGBB. */
function coloursOf(png) {
  const { w, h, color, channels, palette, data } = png;
  const set = new Set();
  for (let i = 0; i < w * h; i++) {
    if (color === 3) {
      const p = data[i] * 3;
      set.add((palette[p] << 16) | (palette[p + 1] << 8) | palette[p + 2]);
    } else {
      const o = i * channels;
      set.add((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
    }
  }
  return set;
}

/* ------------------------------------------------------------------- tests */

const part = Part2.fromExecutable(new Uint8Array(readFileSync(join(ROOT, 'DOPE.EXE'))));

eq('the base palette is 768 bytes (all 256 entries)', part.base.length, 768);
eq('the base palette is 6 bit', Math.max(...part.base), 63);
// Pinned so a changed block, or a shifted offset, is noticed.
eq('base palette digest (block 0x65080 + 0x2bffa)', fnv1a(part.base), '6616199c');
{
  const distinct = new Set();
  for (let i = 0; i < PALETTE_ENTRIES; i++) {
    distinct.add((part.base[i * 3] << 16) | (part.base[i * 3 + 1] << 8) | part.base[i * 3 + 2]);
  }
  eq('the 256 entries hold 206 distinct colours (a gradient, so some repeat)', distinct.size, 206);
}

{
  const top = part.palette(0x100);
  let same = true;
  for (let i = 0; i < 768; i++) if (top[i] !== part.base[i]) same = false;
  ok('a ramp step of 0x100 is the identity, so the DAC holds the base palette', same);

  const black = part.palette(0);
  ok('a ramp step of 0 is black', black.every((v) => v === 0));

  // no saturation at this step, so entry k of the ramp is exactly k >> 1
  const half = part.palette(0x80);
  let bad = 0;
  for (let i = 0; i < 768; i++) if (half[i] !== part.base[i] >> 1) bad++;
  eq('a ramp step of 0x80 halves every palette value', bad, 0);
}

// The fade the ISR runs: 0xff per interrupt, saturating at 0x3f00.
eq('the fade reaches the top in 64 frames', Math.ceil((FADE_TOP + 1) / FADE_STEP), FADE_FRAMES);
eq('the fade starts at black', Part2.fadeStep(0), 0);
eq('the fade is the identity after 64 frames', Part2.fadeStep(64), 0x3f00);

// 8 bit expansion must be DOSBox's, the same one part 1 uses.
{
  const rgb = part.rgbPalette(0x100);
  let bad = 0;
  for (let i = 0; i < 768; i++) {
    const v = part.base[i];
    if (rgb[i] !== ((v << 2) | (v >> 4))) bad++;
  }
  eq('6 bit to 8 bit expansion', bad, 0);
}

/* ------------------------------------ against the captured reference frames */

const dir = join(ROOT, 'build', 'ref_p2');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : [];
if (!files.length) {
  console.log('skip the frame check: no build/ref_p2 (tools/refcapture.py --start 55 --seconds 20 --interval 2 --out build/ref_p2)');
} else {
  const pal = part.rgbPalette(0x100);
  const have = new Set();
  for (let i = 0; i < PALETTE_ENTRIES; i++) {
    have.add((pal[i * 3] << 16) | (pal[i * 3 + 1] << 8) | pal[i * 3 + 2]);
  }
  let worst = 0;
  for (const name of files) {
    const png = decodePNG(readFileSync(join(dir, name)));
    const cols = coloursOf(png);
    let missing = 0;
    for (const c of cols) if (!have.has(c)) missing++;
    worst = Math.max(worst, missing);
    ok(`${name}: all ${cols.size} colours come from the base palette`, missing === 0,
      `${missing} not in the palette`);
    eq(`${name} is 320x200`, png.w * 100000 + png.h, 320 * 100000 + 200);
  }
  eq('every frame is explained by one 256 entry palette', worst, 0);
}

/* ------------------------------- against the live part, frozen in build/snap */

// The compose table and the credit bands are not inferred: they are compared
// with the memory of the real part while it runs.  The snapshot caught it at
// part segment 0xf8b, so every stored segment constant in block 2 carries the
// loader's shift of part_segment - 0x10 = 0xf7b: the table the code addresses
// as 0x3527 is at 0x44a2, the band segment (0x451) at 0xdcc.
const snapBase = join(ROOT, 'build', 'snap', 'part2');
if (!existsSync(snapBase + '.mem')) {
  console.log('skip the memory check: no build/snap/part2.mem (tools/vmsnap.py --part 2)');
} else {
  const mem = new Uint8Array(readFileSync(snapBase + '.mem'));
  const meta = JSON.parse(readFileSync(snapBase + '.json', 'utf8'));
  const reloc = meta.part_segment - 0x10;
  const at = (seg, off) => (((seg + reloc) << 4) + (off | 0)) & 0xfffff;

  const table = part.shadeTable();
  const tableSeg = 0x3527;
  let differ = 0;
  let written = 0;
  for (let span = 0; span < 0x40; span++) {
    for (let band = 0; band < 0x80; band++) {
      const base = (span << 8) | band;
      for (const off of [0x80, 0x8000, 0x8080]) {
        const k = (base + off) & 0xffff;
        written++;
        if (mem[at(tableSeg, k)] !== table[k]) differ++;
      }
    }
  }
  eq('the compose table matches the live part byte for byte', differ, 0);
  eq('the table is 64 x 128 entries written three times', written, 64 * 128 * 3);

  // A band lives *inside* the part image: block offset 0xc01a maps to
  // part_linear + (0xc01a - 0x100), and the four bands follow each other there
  // exactly as they do in the block.  (The code reaches them as ds:0xdb0a with
  // ds patched to 0xdcc, i.e. 0xdcc0 + 0xdb0a = 0x1b7ca -- the same address,
  // which puts the band-segment addend at 0x97b rather than the 0xf7b the
  // code's other constants get.)
  const bandBase = (meta.part_segment << 4) + (0xc01a - 0x100);
  let bandDiff = 0;
  for (let n = 0; n < 4; n++) {
    const want = part.band(n);
    eq(`band ${n} is 32 rows of 320`, want.length, 32 * 320);
    const got = mem.subarray(bandBase + n * 0x2800, bandBase + n * 0x2800 + want.length);
    for (let i = 0; i < want.length; i++) if (want[i] !== got[i]) bandDiff++;
  }
  eq('blocks 0xc01a.. hold the four bands, as the frozen part does', bandDiff, 0);

  // The composed screen is blitted one row down (segment 0x36eb copies from
  // screen+0x140), which is the scroll: the frozen part's own screen buffer,
  // read through the base palette, matches the frozen screenshot that way and
  // no other way.
  const screen = mem.subarray(at(0x5517, 0), at(0x5517, 0) + 64000);
  const pal = part.base;
  const shot = decodePNG(readFileSync(join(snapBase + '.png')));
  const lut = (v) => ((v & 0x3f) << 2) | ((v & 0x3f) >> 4);
  const shotRGB = (x, y) => {
    const o = (y * shot.w + x) * shot.channels;
    if (shot.color === 3) {
      const q = shot.data[o] * 3;
      return [shot.palette[q], shot.palette[q + 1], shot.palette[q + 2]];
    }
    return [shot.data[o], shot.data[o + 1], shot.data[o + 2]];
  };
  const rowMatch = (shift) => {
    let rows = 0;
    for (let y = 0; y + shift < 200; y++) {
      let same = true;
      for (let x = 0; x < 320 && same; x++) {
        const i = (y + shift) * 320 + x;
        const p = screen[i] * 3;
        const rgb = shotRGB(x, y);
        if (lut(pal[p]) !== rgb[0] || lut(pal[p + 1]) !== rgb[1] || lut(pal[p + 2]) !== rgb[2]) same = false;
      }
      if (same) rows++;
    }
    return rows;
  };
  const shifted = rowMatch(1);
  const unshifted = rowMatch(0);
  ok('the screen buffer is shown one row down (the scroll)', shifted > unshifted,
    `one row down ${shifted} rows, none ${unshifted}`);
  ok('most of the frozen screen is reproduced exactly', shifted >= 80, `${shifted} of 199 rows`);
}

console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
