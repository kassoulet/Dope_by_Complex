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
import { Machine } from '../tools/vm/machine.js';
import { loadImage, boot, PART_SEGMENT, ENTRY, COUNTER, DATA_SEGMENT } from '../tools/part2run.mjs';

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

  // A band lives *inside* the part image: block offset 0x1201a maps to
  // part_linear + (0x1201a - 0x100) = 0x217ca, which is exactly what the code
  // reaches -- `push 0x451 / pop ds` is patched to 0x13cc in memory, and
  // 0x13cc0 + 0xdb0a = 0x217ca.  The four bands follow each other there as
  // they do in the block.
  const bandBase = (meta.part_segment << 4) + (0x1201a - 0x100);
  eq('the patched band segment points at the block\'s band 0', bandBase, 0x217ca);
  let bandDiff = 0;
  for (let n = 0; n < 4; n++) {
    const want = part.band(n);
    eq(`band ${n} is 32 rows of 320`, want.length, 32 * 320);
    const got = mem.subarray(bandBase + n * 0x2800, bandBase + n * 0x2800 + want.length);
    for (let i = 0; i < want.length; i++) if (want[i] !== got[i]) bandDiff++;
  }
  eq('blocks 0x1201a.. hold the four bands, as the frozen part does', bandDiff, 0);

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

  /* ------------------------- what the part is doing at the instant of the freeze
   *
   * These pin the state the notes in docs/RUNTIME.md quote, so a re-captured
   * snapshot shows up instead of quietly changing the story.  All of it is read
   * out of the image; the counters are the part's own.
   */
  const csBase = meta.part_segment << 4; // cs: offsets are not relocated
  const word = (off) => mem[csBase + off] | (mem[csBase + off + 1] << 8);
  const dword = (off) => (mem[csBase + off] | (mem[csBase + off + 1] << 8) |
    (mem[csBase + off + 2] << 16) | (mem[csBase + off + 3] << 24)) >>> 0;
  eq('[cs:0x1904] is band 2', word(0x1904), 2);
  eq('[cs:0x1955] is -1: the horizontal text scroll is off', word(0x1955), 0xffff);
  eq('[cs:0x1947] is 0 (no picture copied back from 0xec3)', word(0x1947), 0);
  eq('[cs:0x1810] is 0xffff: no object is being animated', word(0x1810), 0xffff);
  eq('the frame counter is the one the snapshot records', dword(meta.counter_offset), meta.counter);

  // The polygon list is full even though the object list is empty: 300 four
  // byte records at cs:0x2ccd, first words 0x92, 0x128, 0x8d, ... and 0xffff
  // after the last one.  It indexes the projected vertex arrays, which hold
  // screen coordinates -- so "the draw loop walks an empty polygon list" is not
  // what is happening here.
  const gsBase = at(0x2ccd, 0);
  const first = [];
  const index = [];
  let records = 0;
  while (records < 4096) {
    const w = mem[gsBase + records * 4] | (mem[gsBase + records * 4 + 1] << 8);
    if (w === 0xffff) break;
    if (records < 6) first.push(w);
    index.push(w);
    records++;
  }
  eq('the polygon list holds 300 records, terminated by 0xffff', records, 300);
  eq('its first records start 0x92, 0x128, 0x8d, 0x123, 0x8c, 0x122',
    first.join(','), '146,296,141,291,140,290');
  ok('every index stays inside the 0x12c entry vertex arrays', Math.max(...index) <= 0x12b,
    `max ${Math.max(...index).toString(16)}`);
  for (const off of [0x6720, 0x7148, 0x7b70]) {
    let worst = 0;
    for (let i = 0; i < 64; i++) {
      worst = Math.max(worst, mem[gsBase + off + i * 2] | (mem[gsBase + off + i * 2 + 1] << 8));
    }
    ok(`the vertex array at gs:0x${off.toString(16)} holds screen coordinates`, worst < 0x200,
      `largest ${worst.toString(16)}`);
  }

  // The two buffers the last frame consumed are gone: the band strip was
  // cleared after the frame (0x36f9) and the compose overwrote its own input
  // with the finished picture.  That is why a snapshot cannot rebuild its own
  // screen, and why the 3D layer cannot be checked against a frozen state.
  const strip = at(0x4527, 0);
  let stripNonZero = 0;
  for (let i = 0; i < 0xfa40; i++) if (mem[strip + i]) stripNonZero++;
  eq('the band strip (0x4527, i.e. 0x54a2 once patched) is cleared at the freeze',
    stripNonZero, 0);
}

/* ------------------ the compose loop, run by the part's own instructions */

// The strongest check available without the 3D engine: put a known span buffer
// and a known band buffer where the part expects them, point the CPU at the
// compose loop (segment 0x3680) in the frozen part's own memory, and see
// whether `Part2.compose()` predicts what those instructions write.  This runs
// the original's code, not a transcription of it.
if (existsSync(snapBase + '.mem')) {
  const cpuMem = new Uint8Array(readFileSync(snapBase + '.mem'));
  const s = new Machine();
  s.boot(cpuMem, JSON.parse(readFileSync(snapBase + '.json', 'utf8')));
  const cpu = s.cpu;
  const lin = (seg, off) => ((seg << 4) + ((off | 0) & 0xffff)) & 0xfffff;

  const span = new Uint8Array(64000).map((_, i) => (i * 37 + 11) & 0x3f);
  const bg = new Uint8Array(64000).map((_, i) => ((i * 13 + 5) & 0x7f) | 0x80);
  s.mem.set(span, lin(0x6492, 0)); // the 3D buffer (0x5517, patched)
  s.mem.set(bg, lin(0x54a2, 0)); // the background buffer (0x4527, patched)

  cpu.if = 0;
  cpu.sreg[3] = 0x6492; // ds
  cpu.sreg[0] = 0x54a2; // es
  cpu.sreg[4] = 0x44a2; // fs: the compose table (0x3527, patched)
  cpu.r[6] = 0; // si
  cpu.r[1] = 0x7d00; // cx
  cpu.ip = 0x3680;
  let steps = 0;
  while (cpu.ip !== 0x369a && steps < 4000000) { cpu.step(); steps++; }
  eq('the compose loop runs to its end', cpu.ip, 0x369a);
  // Ten instructions per pixel pair: the two loads, the two lookups, the store,
  // the pointer and the two loop instructions (segment 0x3680..0x3698).
  eq('and takes 0x7d00 * 10 instructions', steps, 0x7d00 * 10);

  const got = s.mem.slice(lin(0x6492, 0), lin(0x6492, 0) + 64000);
  const want = part.compose(span, bg);
  let bad = 0;
  for (let i = 0; i < 64000; i++) if (got[i] !== want[i]) bad++;
  eq('the original\'s compose writes what compose() predicts', bad, 0);
}

/* ---------------------- booting part 2 from its own block (the loader, redone)
 *
 * The part is not self contained: the loader relocates 28 words of its block and
 * hands it a data segment in gs.  `tools/part2run.mjs` reproduces that, and the
 * strongest check available is to compare the image it builds with the image the
 * real loader left in memory -- at every word either of them touched.
 */
if (existsSync(join(ROOT, 'build', 'block02_00f66c.bin'))) {
  const block2 = new Uint8Array(readFileSync(join(ROOT, 'build', 'block02_00f66c.bin')));
  const image = loadImage(block2, PART_SEGMENT);
  eq('the loader patches 21 code immediates', image.code, 21);
  eq('and the 5 entries of the two phase tables', image.tables, 5);
  eq('and the first word of both object records', image.objects, 2);

  if (existsSync(snapBase + '.mem')) {
    const frozen = new Uint8Array(readFileSync(snapBase + '.mem'));
    const part = PART_SEGMENT * 16;
    const plain = new Uint8Array(1 << 20);
    plain.set(block2.subarray(0x100), part);
    let touched = 0;
    let wrong = [];
    for (let i = 0; i < block2.length - 0x100; i++) {
      if (image.mem[part + i] === plain[part + i]) continue;
      touched++;
      if (image.mem[part + i] !== frozen[part + i] && wrong.length < 6) {
        wrong.push((0x100 + i).toString(16));
      }
    }
    ok('the relocated image is the one the original loader left in memory', wrong.length === 0,
      `${wrong.length} words differ (${wrong.join(' ')}) of ${touched} changed bytes`);
  }

  // The part's own code sets gs only inside the transform and the draw; the
  // polygon list terminator is written through gs by 0x354a, which runs before
  // either of them.  Without this register the write lands in the part's code
  // and the sorter walks memory for ever -- the run that executed 4e9
  // instructions without one write to video memory.
  const m2 = boot(image.mem, { part_segment: PART_SEGMENT, entry: ENTRY, counter_offset: COUNTER });
  eq('boot hands the part its data segment in gs', m2.cpu.sreg[5],
    (PART_SEGMENT + DATA_SEGMENT - 0x10) & 0xffff);

  const cpu2 = m2.cpu;
  const part = PART_SEGMENT * 16;
  const spans = [];
  let drawAt = -1;
  let n = 0;
  const step2 = cpu2.step.bind(cpu2);
  cpu2.step = function () {
    if (drawAt < 0 && this.ip === 0x3310) drawAt = n;
    if (this.ip === 0x2660 && spans.length < 6) {
      spans.push([cpu2.read32(part + 0x2e60), cpu2.read32(part + 0x2e64)]);
    }
    step2();
  };
  while (n < 8e6 && spans.length < 6 && !m2.stopped && !m2.exited) { cpu2.step(); m2.tick(); n++; }

  ok('the part reaches its draw', drawAt > 0, `draw at ${drawAt}`);
  const polys = cpu2.read16(part + 0x1933);
  ok('the two objects build a polygon list before it draws', polys > 100, `${polys} polygons`);
  const gsBase = cpu2.sreg[5] << 4;
  eq('and terminate it', cpu2.read16(gsBase + polys * 4), 0xffff);
  eq('the draw runs to the end of the list', spans.length, 6);

  // The span endpoints are 16.16 with the integer part in the high word.  With
  // the object records relocated they are screen columns: every polygon the
  // draw starts on has at least one end on the picture.  Booted without them
  // the first span's left edge was 0xba97 = -17769, i.e. an edge from another
  // scene, and the fill ran off the screen for a hundred million instructions.
  const x = (v) => v >>> 16;
  eq('the first span starts at column 276, on the picture', x(spans[0][0]), 276);
  ok('the edges are screen columns, not another scene\'s', x(spans[0][0]) < 512,
    spans.map(([a, b]) => x(a) + '/' + x(b)).join(' '));
}

console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
