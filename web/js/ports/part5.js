/*
 * dope/ports/part5.js -- part 5 of DOPE, ported from block 5.
 *
 * The engine of parts 3 and 7 once more, with three changes of its own:
 *
 *  - TWO ways to fill a polygon.  The "fs" table at cs:8 names a lookup map
 *    for each of four materials; where it is 0 the polygon is filled by the
 *    plain texture mapper (raster3.js, texturePolygon) with the "ds" segment
 *    as the texture;
 *  - the phong lookup reads its row table (a 16 x 16 grid of byte pairs, at
 *    cs:0x375b) and that table is REBUILT BY THE TIMER every tick from a sine
 *    of a running angle (0x3199): the lighting wobbles.  The row table is a
 *    brightness ramp used on both axes, so the lit sphere's rings swell and
 *    shrink;
 *  - the screen is not cleared.  The part begins on the picture part 4 left:
 *    its low nibbles are kept as the background layer (colours 0..15), the 3D
 *    objects use colours 16..255.  At the end the high nibbles are filled with
 *    the NEXT part's first picture and the 16 x 16 palette is cross faded
 *    (the trick of part 4 again): a palette fade is a picture fade.
 *
 * The other differences are addresses: see CFG below.
 */
import { Part3, A3 } from './part3.js';
import { OFF5 } from './engine3d.js';
import { V5 } from './raster3.js';
import { seg, RELOC, ramp } from './part4.js';
import script from './data/part5script.js';

const A5 = {
  ...A3, camAngle: 0x1430, camPos: 0x1418, records: 0x1412, labPos: 0x1558, labVel: 0x155a, labSeg: 0x1556,
  tickFlag: 0x1524, ticks: 0x1528, frames: 0x152c, spin: 0x156a,
  base: 0x1530, count: 0x1532, cull: 0x1534, selA: 0x1550, selB: 0x154e, bufSeg: 0x1564,
  angle: 0x1546, angleSpeed: 0x1548, ramp: 0x374b, rows: 0x375b, dsTab: 0, fsTab: 8, sine: 0x12,
};
const u16 = (v) => v & 0xffff;

export class Part5 extends Part3 {
  constructor(image, opts = {}) {
    const { screen = null, pal = null } = opts;
    super(image, { ...opts, screen, pal });
    // 0x31e2: the picture part 4 left becomes the background layer (its low nibbles) and the frame's first content
    const lo = new Uint8Array(64000);
    for (let i = 0; i < 64000; i++) lo[i] = this.vram[i] & 0x0f;
    image.set(lo, seg(0x3f00));
    this.fb.set(lo, 0x140);
    this.background = image.subarray(seg(0x3f00), seg(0x3f00) + 0x3ed0 * 4);
    this.vram.set(lo);
    // the card's first 16 colours are saved for the cross fade at the end
    const p0 = pal ? pal.subarray(0, 48) : new Uint8Array(48);
    image.set(p0, seg(0x3ecf) + 0x10);
    this.dac = new Uint8Array(768);
    if (pal) this.dac.set(pal.subarray(0, 768));
    this.dac.set(image.subarray(seg(0x3a6) + 0x40, seg(0x3a6) + 0x40 + 672), 48);
    this.dac.set(image.subarray(seg(0x248f) + 0x2da, seg(0x248f) + 0x2da + 48), 720);
    this.fade = -1;
  }

  /** 0x3199 -- the row table from the brightness `dx`: a 16 entry ramp, then every pair of its entries. */
  rebuildRows(dx) {
    const A = this.A, r = new Uint8Array(16);
    let bx = u16(-u16(dx * 8));
    for (let k = 0; k < 16; k++) { r[k] = bx >> 8; bx = u16(bx + dx); }
    this.cs.set(r, A.ramp);
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        const o = A.rows + 2 * (16 * i + j), w = (r[i] << 8) | r[j];
        this.cs[o] = w & 0xff; this.cs[o + 1] = w >> 8;
        this.rows[16 * i + j] = w;
      }
    }
  }

  tick() {
    const A = this.A;
    super.tick();
    if (this.ending) return this.fadeStep();
    // (the original runs these before the records move; no variable they touch is read by those)
    this.setW(A.angle, this.w(A.angle) + this.w(A.angleSpeed));
    let dx = this.sine16(this.w(A.angle) & 0x7fe) >>> 4;
    dx = u16(dx * 3) >>> 4;
    this.rebuildRows(dx);
  }

  /** cs:[si + 0x12] as an unsigned word (the table the original builds at its start) */
  sine16(si) { return this.sin[si >> 1] & 0xffff; }

  /** The script has run out: the cross fade to the next part's picture (0x37ba ff.). */
  finish() {
    this.ending = true;
    const image = this.image;
    this.pal1 = image.slice(seg(0x3ed0), seg(0x3ed0) + 48);
    this.pal2 = image.slice(seg(0x4ea1), seg(0x4ea1) + 48);
    this.fadeW = 0;
    this.fade = 0;
    this.mix(0);
    const a = this.background, b = image.subarray(seg(0x4ed1), seg(0x4ed1) + 64000);
    for (let i = 0; i < 64000; i++) this.vram[i] = (a[i] & 0x0f) + ((b[i] & 0x0f) << 4);
  }

  /** 0x3138: the 256 colour palette for fade position `w` (0..0x1000) */
  mix(w) {
    const A = ramp(0x1000 - w), B = ramp(w), dac = this.dac;
    let o = 0;
    for (let hi = 0; hi < 16; hi++) {
      for (let lo = 0; lo < 16; lo++) {
        for (let c = 0; c < 3; c++) {
          const v = A[this.pal1[lo * 3 + c]] + B[this.pal2[hi * 3 + c]];
          dac[o++] = v > 63 ? 63 : v;
        }
      }
    }
  }

  fadeStep() {
    if (this.fade >= 64) return;
    this.mix(this.fadeW);
    this.fadeW += 0x40;
    if (++this.fade === 64) {
      this.dac.set(this.pal2, 0);
      this.vram.set(this.image.subarray(seg(0x4ed1), seg(0x4ed1) + 64000));
      this.done = true;
    }
  }

  render() { if (!this.ending) super.render(); }
}

Part5.CFG = {
  script: script.map((st) => ({ ...st, set: st.set.map(([a, sz, v]) => [a, sz, a === 0x1556 ? (v + RELOC) & 0xffff : v]) })),
  endTicks: 64, gsSeg: 0x2685, A: A5, L: OFF5, V: V5, background: 0x3f00, label: 0, csSize: 0x3800, tShift: 10, texData: true, addOffset: true, rowsAt: 0x375b,
  dac: [],
};
