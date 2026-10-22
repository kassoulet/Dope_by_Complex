/*
 * dope/part2.js -- what is known exactly about part 2 (the credits): its palette.
 *
 * Part 2 is NOT ported.  Its picture is drawn by a software 3D engine (vertex
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
 * Everything below is read out of the part's own block, so the values are the
 * original's, not a guess.  `tests/test_part2.mjs` checks them against the
 * reference frames.
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
 *   0x1a67  builds the 128x128 diagonal gradient map the texture loop reads
 *   0x27c6  texture mapped span inner loop
 *   0x381e  "show the current object for cx frames": draw until the ISR has
 *           advanced cs:0x1928 by cx
 */

import { findBlocks } from './rnc.js';

export const W = 320;
export const H = 200;

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
}
