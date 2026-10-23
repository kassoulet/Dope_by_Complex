/*
 * dope/part2.js -- what is known exactly about part 2 (the credits): its palette.
 *
 * (Superseded: part 2 is now ported, see ports/part2.js and docs/PORT2.md; what follows
 * is the earlier study of its palette and compositor, kept because tests check it.)
 *
 * Part 2 was NOT ported when this was written.  Its picture is drawn by a software 3D engine (vertex
 * transform 0x1c60, projection 0x1d60, polygon setup 0x3420-0x3475, texture
 * mapped span fill 0x27c6 with the gradients patched into the instruction
 * stream), and that engine is still only understood well enough to describe,
 * not to reimplement.  What *is* nailed down, and is checked here, is the
 * colour side -- and it settles a question the notes used to get wrong:
 *
 *   Part 2 does not rewrite the DAC per scanline.  It uses all 256 entries:
 *   the part entry (block 0x387f) loads 768 bytes of 6 bit palette into
 *   cs:0x1f10 from two places in its own block -- 0x2d0 bytes at block
 *   0x65080 and 0x30 bytes at block 0x2bffa -- and writes them to ports
 *   3c8/3c9.  The timer interrupt then rewrites the same 768 bytes every
 *   tick (block 0x2680) as `palette[i] = ramp[base[i]]`, where `ramp` is a
 *   64 entry brightness table built by block 0x2650 from the word at
 *   cs:0x1941 (stepped by 0xff per interrupt), i.e. a fade from black.
 *
 *   At the ramp's top the table is the identity, so the DAC holds the base
 *   palette unchanged.  Every colour of all ten reference frames in
 *   `build/ref_p2` is in that palette, which is how the per-line theory was
 *   retired (a single 64 entry palette cannot show the 70..107 colours those
 *   frames hold; a 256 entry one can, and does).
 *
 * What is transcribed here beyond the colour side is the screen *compositor*:
 * the shade table (segment 0x1998), the credit bands (they sit inside the part
 * image at block 0x1201a, 0x2800 bytes each) and the compose loop (segment
 * 0x3680) that turns the 3D buffer plus a band into the 320x200 index picture.
 * The whole pipeline is in the comment on the screen pipeline constants below.
 * Only the 3D engine that fills the span buffer is still missing from the page.
 * It does run in the verification rig -- `tools/part2run.mjs` redoes the
 * loader (28 relocated words, plus the data segment `gs` must hold) and boots
 * the part from its block, which then builds 271 polygons and blits frames.
 * `tools/part2frames.mjs` goes further and drives it one frame per timer tick
 * (the PIT is held off and the part's own frame hook is called at the screen
 * wait), so counters 1..438 can be rendered in seconds; the best of those
 * matches a captured frame in 35,180 of 64,000 pixels, with the credit rows
 * almost exact and the discs still differing.  That rig is verification, not
 * this page: the page runs the original code (partvm.js) instead.
 *
 * Everything below is read out of the part's own block, so the values are the
 * original's, not a guess.  `tests/test_part2.mjs` checks them against the
 * reference frames and against the frozen part's memory; `tests/test_x86.mjs`
 * pins the signed 32 bit divide the projection needs, and
 * `tests/test_part2_frames.mjs` the one-tick frames.
 *
 * Where the code is (block 2 file offsets; the loader maps file offset 0x100
 * at the part segment, so segment offset = block offset - 0x100):
 *
 *   0x386c  per-part entry: setup, 0x1a98, then 0x387f, then exit to DOS
 *   0x387f  mode 13h, copy the palette, load all 768 DAC bytes, start the
 *           frame script
 *   0x1b21  timer ISR (segment 0x1a21): EOI, wait for the start of vertical
 *           retrace, reload the PIT from cs:0x1a05, call the frame hook at
 *           cs:0x1a09, chain to the old vector when the tick was not ours
 *   0x2680  the frame hook the ISR calls: object animation counters, the
 *           palette rewrite above, and the frame counter cs:0x1928
 *   0x1998  builds the 64 x 128 compose table (`shadeTable` below)
 *   0x360c  per-frame screen: band strip, compose through that table, blit
 *   0x26c0  texture mapped span inner loop (the 3D engine)
 *   0x381e  "show the current object for cx frames": draw until the ISR has
 *           advanced cs:0x1928 by cx
 */

import { findBlocks } from './rnc.js';

export const W = 320;
export const H = 200;

/* ------------------------------------------------------- the screen pipeline
 *
 * Part 2's screen is not the 3D engine's output directly: the engine fills a
 * 320x200 index buffer and block 0x370c (segment 0x360c) turns it into the
 * picture once per frame, in this order:
 *
 *   0x360c  wait until the ISR has bumped cs:0x1924 (one frame)
 *   0x3621  es = 0x4527, di = 0x6e00, cx = 0xa00: fill the 0x2800 byte band
 *           strip from `n = [cs:0x1904]`:  -2 keeps the previous band, -1 is
 *           black, 0 is the 0x80808080 grey, anything else copies
 *           ds:0xdb0a + n*0x2800 from the band segment (block 0x1201a)
 *   0x3680  the compose, 0x7d00 times on word pairs: for each of the 64,000
 *           screen pixels, `byte = map[(span << 8) | band]` where `span` is the
 *           3D buffer at ds=0x5517 and `band` the strip at es=0x4527
 *   0x36e3  blit: ds = 0x5517, es = 0xa000, 0x3ed0 dwords from screen+0x140 to
 *           A0000+0, i.e. one 320 pixel row down, which is the vertical scroll
 *   0x36f9  clear the band strip for the next frame
 *   0x2a1c..the scroll: [cs:0x1955] += [cs:0x1957] per frame in the hook, and
 *           anything outside 0..0x4b turns the scroll off
 *
 * The map itself is built at segment 0x1998 into the segment at 0x3527 (0x44a2
 * once the loader's +0xf7b has been added), and `shadeTable()` below is that
 * builder.  It is checked against the live demo's memory, not inferred: the
 * 24,576 bytes it writes are byte identical to the ones in the running part.
 */
export const SHADE_SLOPE_SPAN = 0x1a0;
export const SHADE_SLOPE_BAND = 0x60;
export const SHADE_WRITES = [0x80, 0x8000, 0x8080]; // [bx+0x80], [bx-0x8000], [bx-0x7f80]

/** Block 2 offset of band 0; the bands are 0x2800 bytes (32 rows) apart. */
export const BAND_OFFSET = 0x1201a;
export const BAND_BYTES = 0x2800;
export const BAND_ROWS = BAND_BYTES / W; // 32
export const BAND_COUNT = 0x10; // the script only reaches the first few

/** The blit starts one 320 pixel row into the screen buffer (segment 0x36eb). */
export const SCREEN_SHIFT = W;

export const PART_BLOCK = 2; // DOPE.EXE block 2 is the part that follows part 1
export const PALETTE_HEAD_OFFSET = 0x65080; // 0x2d0 bytes, block 0x6507:0x10
export const PALETTE_TAIL_OFFSET = 0x2bffa; // 0x30 bytes, block 0x2bd2:0x2da
export const PALETTE_ENTRIES = 256; // all of the DAC, not part 1's 0xc0
export const PALETTE_BYTES = PALETTE_ENTRIES * 3;

// The ISR waits for the start of vertical retrace, and its PIT divisor is
// calibrated as latch * 1000 / 2048 against part 1's latch * 990 / 2048, which
// was measured at 69 Hz -- so ~69.7 Hz, i.e. every retrace.
export const FRAME_HZ = 70;
export const FADE_STEP = 0xff; // cs:0x1941 += 0xff per interrupt
export const FADE_TOP = 0x3f00; // the ramp stops moving here
export const FADE_FRAMES = 64; // 0..0x3f00 in 0xff steps: a ~0.9 s fade in

/**
 * The 64 entry brightness table built by block 0x2650: `dx` is the step, each
 * entry stores `ah`, and `ax` stops moving once it passes 0x3f00.  With a step
 * of 0x100 this is the identity, which is the state the reference frames were
 * captured in.
 */
export function ramp(step, out = new Uint8Array(0x40)) {
  let dx = step & 0xffff;
  if (dx & 0x8000) dx = 0; // 0x2650: `test dx,dx / jns`
  if (dx > 0x100) dx = 0x100;
  let ax = 0;
  for (let i = 0; i < 0x40; i++) {
    out[i] = (ax >> 8) & 0xff;
    if (ax <= FADE_TOP) ax = (ax + dx) & 0xffff;
  }
  return out;
}

export class Part2 {
  constructor(block) {
    this.block = block;
    this.base = new Uint8Array(PALETTE_BYTES);
    this.base.set(block.subarray(PALETTE_HEAD_OFFSET, PALETTE_HEAD_OFFSET + 0x2d0), 0);
    this.base.set(
      block.subarray(PALETTE_TAIL_OFFSET, PALETTE_TAIL_OFFSET + 0x30),
      0x2d0,
    );
    this.ramp = new Uint8Array(0x40);
    this.pal6 = new Uint8Array(PALETTE_BYTES);
    this.rgb = new Uint8Array(PALETTE_BYTES);
  }

  static fromExecutable(exe) {
    const blocks = findBlocks(exe);
    if (blocks.length <= PART_BLOCK) throw new Error('DOPE.EXE has no part 2 block');
    return new Part2(blocks[PART_BLOCK].data);
  }

  /** 6 bit DAC values: `palette[i] = ramp[base[i]]` (block 0x2680). */
  palette(step) {
    const r = ramp(step, this.ramp);
    const out = this.pal6;
    for (let i = 0; i < PALETTE_BYTES; i++) out[i] = r[this.base[i]];
    return out;
  }

  /** The same, expanded to 8 bit the way DOSBox does it (v << 2 | v >> 4). */
  rgbPalette(step) {
    const pal = this.palette(step);
    const rgb = this.rgb;
    for (let i = 0; i < PALETTE_BYTES; i++) {
      const v = pal[i];
      rgb[i] = (v << 2) | (v >> 4);
    }
    return rgb;
  }

  /**
   * The word the fade runs on at part time `frames`: the ISR starts from 0 and
   * adds 0xff per interrupt, so the picture fades up out of black in the first
   * 64 frames and then sits at 0x100 (identity).
   */
  static fadeStep(frames) {
    return Math.min(FADE_TOP, (frames | 0) * FADE_STEP);
  }

  /* ----------------------------------------------------------- the picture */

  /**
   * The compose lookup table (segment 0x1998, at fs = 0x3527): a 64 x 128
   * table of palette indices, each entry
   *
   *   0x80 | (((0x1a0 * span + 0x60 * band) >> 1) + (that & 1) >> 8 & 0x7f)
   *
   * written three times, so the same entry is reachable from three bases.  The
   * high bit is always set, which is why every composed pixel uses the upper
   * half of the DAC.  The compose reads it at `table[(span << 8) | band]`, and
   * the three copies are what make `band` bytes >= 0x80 (the picture values)
   * and `span` bytes >= 0x80 (the 3D layer) land on their entry too.
   */
  shadeTable(out = new Uint8Array(0x10000)) {
    for (let span = 0x3f; span >= 0; span--) {
      for (let band = 0x7f; band >= 0; band--) {
        const v = SHADE_SLOPE_SPAN * span + SHADE_SLOPE_BAND * band;
        const value = 0x80 | ((((v >> 1) + (v & 1)) >> 8) & 0x7f);
        const base = (span << 8) | band;
        for (const off of SHADE_WRITES) out[(base + off) & 0xffff] = value;
      }
    }
    return out;
  }

  /** Band `n` of the credits background, straight out of block 2. */
  band(n) {
    const at = BAND_OFFSET + (n | 0) * BAND_BYTES;
    return this.block.subarray(at, at + BAND_BYTES);
  }

  /**
   * The compose loop (segment 0x3680): one palette index per screen pixel.
   * `span` is the 3D buffer, `bg` the band strip; both are 64,000 bytes, and a
   * band byte of 0 keeps the 3D pixel's own colour (span << 8).
   */
  compose(span, bg, out = new Uint8Array(W * H)) {
    const table = this.shade || (this.shade = this.shadeTable());
    for (let i = 0; i < W * H; i++) {
      out[i] = table[((span[i] << 8) | bg[i]) & 0xffff];
    }
    return out;
  }
}
