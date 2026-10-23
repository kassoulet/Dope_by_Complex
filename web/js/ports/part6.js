/*
 * dope/ports/part6.js -- part 6 of DOPE, ported from block 6.
 *
 * The engine of part 5 (two polygon fillers, the wobbling row table) over a
 * city of lit windows, with three new things:
 *
 *  - the lookup picture the polygons are lit from is a 256 wide strip whose right
 *    half is repainted every frame (0x2f05): the old picture fades by 0x10 per
 *    pixel, and a 64 x 64 pattern picked by the camera's angle is added, each
 *    pattern pixel doubled both ways.  Lights that follow the view;
 *  - the palette is not fixed: the timer cross fades colours 16..207 between
 *    two stored palettes (cs:0x325d and cs:0x3565) with two ramps, and
 *    uploads the result every tick;
 *  - the sort starts one bit lower (12 passes), the vertex stage mirrors the
 *    lookup coordinates (`neg edx`), and the list of faces is at 0x3200.
 *
 * At the end the palette is faded to black over 37 retraces.
 */
import { Part3, A3 } from './part3.js';
import { OFF6 } from './engine3d.js';
import { V6 } from './raster3.js';
import { seg, RELOC, ramp } from './part4.js';
import script from './data/part6script.js';

const A6 = {
  ...A3, camAngle: 0x163e, camPos: 0x1626, records: 0x1620, labPos: 0x1768, labVel: 0x176a, labSeg: 0x176c, spin: 0,
  tickFlag: 0x1732, ticks: 0x1736, frames: 0x173a, base: 0x173e, count: 0x1740, cull: 0x1742, selA: 0x1762, selB: 0x1760,
  bufSeg: 0x177a, dsTab: 0x210, fsTab: 0x218, sine: 0x220,
  fadePos: 0x3259, fadeVel: 0x325b, bright: 0x176e, brightVel: 0x1770, rampA: 0x2ed9, rampB: 0x2f19, palA: 0x325d, palB: 0x3565,
};
const u16 = (v) => v & 0xffff;

export class Part6 extends Part3 {
  constructor(image, { screen = null, pal = null } = {}) {
    super(image, { screen, pal });
    // 0x3a51: the picture goes into the frame (a 64 KB copy that wraps round its segment), the first palette into cs
    const bg = image.subarray(seg(0xc97), seg(0xc97) + 0x10000);
    for (let k = 0; k < 0x10000; k++) this.fb[(0x140 + k) & 0xffff] = bg[k];
    this.cs.set(image.subarray(seg(0x419), seg(0x419) + 768), A6.palA);
    this.dac = new Uint8Array(768);
    this.dac.set(image.subarray(seg(0xc66) + 0x10, seg(0xc66) + 0x10 + 48), 0);
    this.dac.set(image.subarray(seg(0x418) + 0x40, seg(0x418) + 0x40 + 672), 48);
    this.dac.set(image.subarray(this.labelBase() + 0x2da, this.labelBase() + 0x2da + 48), 720);
    this.pattern = seg(0x368a);
    this.light = seg(0x449);
    this.rampsFor(this.w(A6.fadePos)); // 0x39ca, once, before the first tick
    this.fadeOut = -1;
  }

  /** 0x3a13 -- the row table from the brightness `dx`: a 16 entry ramp at cs:0, then the pairs at cs:0x10. */
  rebuildRows(dx) {
    const r = new Uint8Array(16);
    let bx = u16(-u16(dx * 8));
    for (let k = 0; k < 16; k++) { r[k] = bx >> 8; bx = u16(bx + dx); }
    this.cs.set(r, 0);
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        const w = (r[i] << 8) | r[j], o = 0x10 + 2 * (16 * i + j);
        this.cs[o] = w & 0xff; this.cs[o + 1] = w >> 8;
        this.rows[16 * i + j] = w;
      }
    }
  }

  /** 0x39ca -- the two fade ramps for fade position `w` */
  rampsFor(w) {
    this.cs.set(ramp(0x1000 - w), A6.rampA);
    this.cs.set(ramp(w), A6.rampB);
  }

  tick() {
    super.tick();
    if (this.ending) return this.fadeStep();
    const A = this.A, cs = this.cs;
    // the fade position and the brightness move and bounce off their limits (0x1deb..0x1e34)
    this.setW(A.fadePos, this.w(A.fadePos) + this.w(A.fadeVel));
    const f = this.sw(A.fadePos);
    if (f < 0 || this.w(A.fadePos) >= 0x1000) this.setW(A.fadeVel, 0);
    this.setW(A.bright, this.w(A.bright) + this.w(A.brightVel));
    const b = this.sw(A.bright);
    if (b < 0 || this.w(A.bright) >= 0x100) { this.setW(A.bright, this.w(A.bright) - this.w(A.brightVel)); this.setW(A.brightVel, 0); }
    this.rebuildRows(this.w(A.bright));
    // 0x3995: colours 16..207 from the two palettes through the two ramps
    const dac = this.dac;
    for (let k = 0; k < 0x240; k++) {
      const v = cs[A.rampA + cs[A.palA + 0x30 + k]] + cs[A.rampB + cs[A.palB + 0x30 + k]];
      dac[0x30 + k] = v > 63 ? 63 : v;
    }
  }

  /** 0x2f05..0x2f66 -- fade the lookup strip and add the pattern for the camera's angle */
  animate() {
    const A = this.A, img = this.image;
    let ax = u16(-this.w(A.camAngle + 2));
    if (!((this.w(A.camAngle) - 0x4000) & 0x8000)) ax = u16(-ax);
    ax = ((ax & 0x3fff) >> 9) << 8;
    const pat = ((u16(ax + 0x368a + RELOC)) << 4);
    let si = 0x80, di = 0;
    for (let dx = 0x80; dx > 0; dx--) {
      for (let cx = 0; cx < 0x40; cx++) {
        let bl = ((img[pat + di] ^ 1) << 6) & 0xff;
        const a = this.light + si;
        const w = u16((img[a] | (img[a + 1] << 8)) - 0x1010) & 0x3f3f;
        bl = (bl + 0x50) & 0xff;
        img[a] = ((w & 0xff) + bl) & 0xff;
        img[a + 1] = ((w >> 8) + bl) & 0xff;
        si += 2; di++;
      }
      si += 0x80;
      if (!(dx & 1)) di -= 0x40;
    }
  }

  draw3d() {
    const n = this.objects();
    this.sortFaces(n);
    this.animate();
    this.rampsFor(this.w(this.A.fadePos));
    this.polygons();
  }

  /** The script has run out: fade the palette to black (0x3e22). */
  finish() {
    this.ending = true;
    this.saved = this.dac.slice();
    this.fadeOut = 0x100;
  }

  fadeStep() {
    if (this.fadeOut < 0) { this.done = true; return; }
    for (let i = 0; i < 768; i++) this.dac[i] = (this.saved[i] * this.fadeOut) >> 8;
    this.fadeOut -= 7;
    if (this.fadeOut < 0) { this.dac.fill(0); this.done = true; }
  }

  render() { if (!this.ending) super.render(); }
}

Part6.CFG = {
  script: script.map((st) => ({ ...st, set: st.set.map(([a, sz, v]) => [a, sz, a === 0x176c ? (v + RELOC) & 0xffff : v]) })),
  gsSeg: 0x667b, A: A6, L: OFF6, V: V6, background: 0xc97, label: 0, csSize: 0x3a00, tShift: 10, texData: true, negEnv: true, rowsAt: 0x10,
  dac: [],
};
