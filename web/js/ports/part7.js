/*
 * dope/ports/part7.js -- part 7 of DOPE, ported from block 7.
 *
 * The same engine as part 3 (engine3d.js, raster3.js: block 7 is the same
 * code assembled at other addresses, with room for 2,000 faces instead of
 * 1,000), a different object, and one new idea: the lookup table the phong
 * polygons read their colours from is ANIMATED.  Every frame the original
 *
 *   - copies a 256 x 256 background picture into the lookup buffer,
 *   - adds five 128 x 128 "blob" sprites into it, byte lanes summed with a
 *     plain 32 bit add, each on its own Lissajous path (sine / cosine of a
 *     multiple of the tick counter),
 *
 * and then draws the object, whose pixels are read out of that buffer.  The
 * highlights on the surface therefore swim around by themselves.
 *
 * What differs from part 3's frame (0x3170 here, 0x2b5a ff. there):
 *
 *   0x2fca   objects        = part 3's 0x2b5a
 *   0x3005   radix sort     = 0x2b95
 *   0x3189.. the animated lookup buffer (new)
 *   0x2d90   polygons       = 0x2920
 *   0x308c   compose        = 0x2c1c
 *   0x2040   timer hook     = 0x2060, plus one counter for the animation
 *
 * and at the end of the script: a picture strip is copied on the screen and
 * the part waits 350 ticks.  (Block 7's polygon routine also holds a plain
 * texture mapper, chosen when the "fs" table entry is 0; no polygon of this
 * part uses it, so the port leaves it out.)
 */
import { Part3, A3 } from './part3.js';
import { OFF7 } from './engine3d.js';
import { V7 } from './raster3.js';
import { seg, RELOC } from './part4.js';
import script from './data/part7script.js';

const A7 = {
  ...A3, labPos: 0x19c8, labVel: 0x19ca, labSeg: 0x19c6, spin: 0x19da, selA: 0x19c0, selB: 0x19be, bufSeg: 0x19d4, anim: 0x19b8,
};

export class Part7 extends Part3 {
  constructor(image, opts) {
    super(image, opts);
    this.texBase = seg(0x13b4); // the animated lookup buffer: 64 KB
    this.blob = image.subarray(seg(0x37ea), seg(0x37ea) + 128 * 128);
    this.backdrop = image.subarray(seg(0x3b3), seg(0x3b3) + 0x10000);
    this.strip = image.subarray(seg(0x6a86), seg(0x6a86) + 0x5000);
  }

  tick() {
    super.tick();
    this.setW(this.A.anim, this.w(this.A.anim) + 1);
    if (this.ending && this.d(this.A.tickFlag) >= 0x15e) this.done = true;
  }

  /** 0x3146 -- add the blob into the buffer at `di`: 128 rows of 32 dwords, rows 256 apart, dwords summed whole. */
  addBlob(di) {
    const buf = this.image, base = this.texBase, blob = this.blob;
    for (let row = 0; row < 128; row++) {
      for (let k = 0; k < 128; k += 4) {
        const a = base + ((di + k) & 0xffff), b = row * 128 + k;
        const sum = ((buf[a] | (buf[a + 1] << 8) | (buf[a + 2] << 16) | (buf[a + 3] << 24)) + (blob[b] | (blob[b + 1] << 8) | (blob[b + 2] << 16) | (blob[b + 3] << 24))) | 0;
        buf[a] = sum & 0xff; buf[a + 1] = (sum >> 8) & 0xff; buf[a + 2] = (sum >> 16) & 0xff; buf[a + 3] = (sum >>> 24) & 0xff;
      }
      di = (di + 0x100) & 0xffff;
    }
  }

  /** 0x3189..0x3266 -- rebuild the lookup buffer for the current animation counter. */
  animate() {
    const t = this.w(this.A.anim), S = this.sin;
    const sn = (i) => S[(i & 0xffe) >> 1] >> 9; // cs:[di + 0x410]  (sar 9, 16 bit)
    const cs = (i) => S[((i & 0xffe) >> 1) + 0x200] >> 9; // cs:[di + 0x810]
    this.image.set(this.backdrop, this.texBase);
    this.addBlob((sn(t) + 0x4040) & 0xffff);
    this.addBlob((((cs(t << 3) + 0x40) << 8) + 0x40) & 0xffff);
    this.addBlob((((sn(t << 2) + 0x40) << 8) + cs(t << 2) + 0x40) & 0xffff);
    this.addBlob((((cs(t << 1) + 0x40) << 8) + sn(t << 1) + 0x40) & 0xffff);
    const j = (S[(((t * 3) & 0xffe) >> 1)] >> 3) & 0xffe; // di = sin[3t] >> 3, kept even
    this.addBlob((((sn(j) + 0x40) << 8) + cs(j) + 0x40) & 0xffff);
  }

  draw3d() {
    const n = this.objects();
    this.sortFaces(n);
    this.animate();
    this.polygons();
  }

  finish() {
    this.ending = true;
    this.vram.set(this.strip.subarray(0, 0x5000), 0x3e80);
    this.setD(this.A.tickFlag, 0);
  }

  render() { if (!this.ending) super.render(); }
}

Part7.CFG = {
  script: script.map((st) => ({ ...st, set: st.set.map(([a, sz, v]) => [a, sz, a === 0x19c6 ? (v + RELOC) & 0xffff : v]) })),
  endTicks: 350, gsSeg: 0x3de1, A: A7, L: OFF7, V: V7, background: 0x5ab4, label: 0,
  dac: [[0x5a84, 0, 720, 0], [0x3beb, 0x2da, 48, 720]],
};
