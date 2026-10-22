/*
 * dope/part1.js -- part 1, transcoded: the original's effect written as pixels.
 *
 * docs/RUNTIME.md records what part 1 does to the VGA.  This module does not
 * reproduce any of that hardware.  It performs the same *intent* on a flat
 * 320x200 index buffer, and every constant below is a measured property of the
 * original code in block 1 (offsets are block file offsets):
 *
 *   picture   0xc5c unpacks 0xc3 rows of a 1024 byte strip into four planes;
 *             with four pixels assembled per plane byte the result is a
 *             1024 pixel wide picture whose rows sit 336 plane bytes (1344
 *             pixels) apart, starting 0x50 plane bytes (320 pixels) in.  The
 *             strip itself lives at block offset 0x154a and is read at run
 *             time, so it is copied in here unchanged -- no unpacking loop,
 *             because the byte at picture row r, column k is the pixel the
 *             card shows at r, k.
 *
 *   scroll    0xc8b programs the CRTC start from the counter (`counter >> 4`)
 *             and 0xca3 the panning register from `((counter >> 2) & 3) * 2`.
 *             In pixels that is a line start of `4 * (counter >> 4)` plus
 *             `((counter >> 2) & 3) - 1`: one pixel every four counts.
 *
 *   palette   0xc24 builds 0xc0 DAC entries from two 64 entry ramps,
 *             `clamp(rampA[tblA[i]] + rampB[tblB[i]], 63)`.  0xc00 fills each
 *             ramp with a slope taken from the counter, so the part fades from
 *             one table to the other; the tables are `tblA` at 0x5f0 and
 *             `tblB` at 0x8f8, the ramps at 0x16c/0x1ac in the part's segment.
 *
 * The frame for a counter is therefore a window copy out of the picture plus a
 * palette lookup.  `tools/part1check.mjs` renders frames from DOPE.EXE alone
 * and compares them with the reference screenshots; with the constants below
 * eleven of the fifteen are byte identical and the other four differ by eight
 * pixels each, in the last picture row (the same residue the snapshot VM shows,
 * see docs/RUNTIME.md).
 */

import { findBlocks } from './rnc.js';

export const W = 320;
export const H = 200;

export const PART_BLOCK = 1; // DOPE.EXE block 1 is part 1
export const PICTURE_OFFSET = 0x154a; // the strip 0xc5c reads
export const PICTURE_ROWS = 0xc3; // rows the unpack writes
export const PICTURE_ROW_SOURCE = 1024; // strip bytes per row
export const PICTURE_ROW_PITCH = 336 * 4; // 0x13 = 0xa8 words, four pixels per byte
export const PICTURE_ROW_BASE = 0x50 * 4; // the unpack starts at plane offset 0x50
export const VRAM_PIXELS = 0x40000; // 256 KB of planes, four pixels per byte

export const TABLE_A_OFFSET = 0x5f0; // cs:0x4f0, indexes ramp A
export const TABLE_B_OFFSET = 0x8f8; // cs:0x7f8, indexes ramp B
export const TABLE_LENGTH = 0xc0; // 64 colours x 3 channels

export const TICKS_PER_SECOND = 69; // measured interrupt rate
export const COUNTS_PER_TICK = 2; // the ISR adds 2 to the counter
export const END_COUNTER = 0x1500; // 0xde0e: the part stops here
export const PART1_SECONDS = END_COUNTER / (TICKS_PER_SECOND * COUNTS_PER_TICK);
export const FADE_BASE = 0x1f4; // the main loop subtracts this from the counter
export const PALETTE_LAG = 4; // measured: the DAC trails the scroll by two ticks

/**
 * The part's counter after `seconds` of playing, clamped to its end.  The demo
 * runs one timer interrupt every 1/69 s and adds 2 to the counter in each, so
 * 5376 counts is the whole of part 1 -- about 39 s.
 */
export function counterAt(seconds) {
  const ticks = Math.floor(Math.max(0, seconds) * TICKS_PER_SECOND);
  return Math.min(END_COUNTER, ticks * COUNTS_PER_TICK);
}

/** One 64 entry ramp, filled the way 0xc00 fills cs:0x16c / cs:0x1ac. */
export function ramp(steps, out) {
  let dx = (steps & 0xffff) >>> 0;
  if (dx & 0x8000) dx = 0; // 0xc00: `test dx,dx / jns` -- negative becomes 0
  dx >>>= 4;
  if (dx > 0x100) dx = 0x100;
  let ax = 0;
  for (let i = 0; i < 0x40; i++) {
    out[i] = (ax >> 8) & 0xff; // `mov [cs:bx],ah`
    if (ax <= 0x3f00) ax = (ax + dx) & 0xffff; // `cmp ax,0x3f00 / ja`
  }
  return out;
}

export class Part1 {
  constructor(block) {
    this.vram = new Uint8Array(VRAM_PIXELS);
    this.tblA = block.subarray(TABLE_A_OFFSET, TABLE_A_OFFSET + TABLE_LENGTH);
    this.tblB = block.subarray(TABLE_B_OFFSET, TABLE_B_OFFSET + TABLE_LENGTH);
    const strip = block.subarray(PICTURE_OFFSET, PICTURE_OFFSET + PICTURE_ROWS * PICTURE_ROW_SOURCE);
    for (let r = 0; r < PICTURE_ROWS; r++) {
      const at = PICTURE_ROW_BASE + PICTURE_ROW_PITCH * r;
      if (at >= VRAM_PIXELS) break;
      const n = Math.min(PICTURE_ROW_SOURCE, VRAM_PIXELS - at);
      this.vram.set(strip.subarray(r * PICTURE_ROW_SOURCE, r * PICTURE_ROW_SOURCE + n), at);
    }
    this.rampA = new Uint8Array(0x40);
    this.rampB = new Uint8Array(0x40);
    this.pal6 = new Uint8Array(192);
    this.rgb = new Uint8Array(192);
  }

  /** Decompress DOPE.EXE and take part 1's block out of it. */
  static fromExecutable(exe) {
    const blocks = findBlocks(exe);
    if (blocks.length <= PART_BLOCK) throw new Error('DOPE.EXE has no part 1 block');
    return new Part1(blocks[PART_BLOCK].data);
  }

  /** 0xc8b: `mov bx,[counter]; shr bx,4` written to CRTC 0x0c/0x0d. */
  startPixels(counter) {
    return ((counter >> 4) & 0xffff) << 2;
  }

  /** 0xca3: `((counter >> 2) & 3) * 2` panned, i.e. value / 2 - 1 pixels. */
  panPixels(counter) {
    return ((counter >> 2) & 3) - 1;
  }

  /** Where the scan starts, in picture pixels. */
  lineStart(counter) {
    return this.startPixels(counter) + this.panPixels(counter);
  }

  /** The 6 bit DAC values for a counter: 64 colours, red/green/blue. */
  palette(counter) {
    const d = (counter - FADE_BASE - PALETTE_LAG) & 0xffff;
    ramp((0x1000 - d) & 0xffff, this.rampA);
    ramp(d, this.rampB);
    const a = this.rampA;
    const b = this.rampB;
    const out = this.pal6;
    for (let i = 0; i < TABLE_LENGTH; i++) {
      const sum = a[this.tblA[i]] + b[this.tblB[i]];
      out[i] = sum < 63 ? sum : 63; // 0xc48: `cmp al,0x3f / jc`
    }
    return out;
  }

  /** 6 bit DAC to 8 bit the way DOSBox expands it, so frames stay exact. */
  rgbTable(counter) {
    const pal = this.palette(counter);
    const rgb = this.rgb;
    for (let i = 0; i < TABLE_LENGTH; i++) {
      const v = pal[i];
      rgb[i] = (v << 2) | (v >> 4);
    }
    return rgb;
  }

  /** The visible 320x200 index image for a counter. */
  frame(counter, out = new Uint8Array(W * H)) {
    const vram = this.vram;
    const start = this.lineStart(counter);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      const src = start + PICTURE_ROW_PITCH * y;
      const lo = Math.max(0, -src);
      const hi = Math.min(W, vram.length - src);
      out.fill(0, row, row + W);
      // Part 1's 195 row picture leaves the last lines addressing past the end
      // of card memory; the reference frames show black there, so it does too.
      if (hi > lo) out.set(vram.subarray(src + lo, src + hi), row + lo);
    }
    return out;
  }

  /** Straight to RGBA, which is all the page needs: write pixels, no buffering. */
  rgba(counter, data) {
    const rgb = this.rgbTable(counter);
    const vram = this.vram;
    const start = this.lineStart(counter);
    for (let y = 0; y < H; y++) {
      let src = start + PICTURE_ROW_PITCH * y;
      let o = y * W * 4;
      for (let x = 0; x < W; x++, src++, o += 4) {
        const c = src >= 0 && src < vram.length ? vram[src] * 3 : 0;
        data[o] = rgb[c];
        data[o + 1] = rgb[c + 1];
        data[o + 2] = rgb[c + 2];
        data[o + 3] = 255;
      }
    }
    return data;
  }
}
