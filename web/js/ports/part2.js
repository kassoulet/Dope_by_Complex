/*
 * dope/ports/part2.js -- part 2 of DOPE ("credits"), ported from block 2.
 *
 * The same 3D engine as parts 3, 5, 6 and 7 (the oldest copy of it: block 5's
 * code assembled 0xb30 bytes earlier, a sort that starts at bit 18, the
 * phong lookup with `shld 9`), drawing a few soft shapes.  What makes
 * part 2 different is the way the picture reaches the screen:
 *
 *  - the polygons are drawn into the BAND buffer (seg 0x4527), a 320 x 200
 *    byte picture that holds, in rows around 0x6e00, a strip of credits (40
 *    rows, one of four, `[0x1904]` says which);
 *  - the compose (0x3780) then builds the screen in a second buffer (0x5517):
 *    for every pixel, `out = shade[(old << 8) | band]` where `old` is what
 *    that same pixel of the second buffer held the frame before.  The table
 *    (0x1a98) is `0x80 | (0x1a0*old + 0x60*band) / 2 / 256`: a recursive
 *    mix of the new shape with the last picture, i.e. trails and glow.
 *    The old buffer keeps its high bit set, which the table ignores;
 *  - the label is pasted in the second buffer, which is then copied to the
 *    screen; the band buffer is cleared (or filled with the next picture,
 *    `[0x1947]`) for the next frame.
 *
 * The timer interrupt also fades the palette in from black while
 * `[0x193f]` is 1 (0x2680), rewriting all 768 DAC values through a 64 entry
 * ramp every tick; the script ends by setting the whole palette to white.
 */
import { Part3, A3 } from './part3.js';
import { OFF2 } from './engine3d.js';
import { V2 } from './raster3.js';
import { seg, RELOC } from './part4.js';
import script from './data/part2script.js';

const A2 = {
  ...A3, labPos: 0x1955, labVel: 0x1957, spin: 0x1963, tickFlag: 0x1924, ticks: 0x1928, frames: 0x192c,
  base: 0x1931, count: 0x1933, cull: 0x1935, selA: 0x194f, selB: 0x194d,
  fadeOn: 0x193f, fadePos: 0x1941, mode: 0x1904, picture: 0x1947, bandAt: 0x3626, pal: 0x1f10, ramp: 0x2510, gradient: 0x1965,
};
const u16 = (v) => v & 0xffff;

export class Part2 extends Part3 {
  constructor(image, opts = {}) {
    super(image, opts);
    this.band = image.subarray(seg(0x4527), seg(0x4527) + 0x10000);
    this.screen = image.subarray(seg(0x5517), seg(0x5517) + 0x10000);
    this.shade = image.subarray(seg(0x3527), seg(0x3527) + 0x10000);
    this.cs.set(image.subarray(seg(0x6507) + 0x10, seg(0x6507) + 0x10 + 720), A2.pal);
    this.cs.set(image.subarray(seg(0x2bd2) + 0x2da, seg(0x2bd2) + 0x2da + 48), A2.pal + 720);
    this.shadeTable();
    this.setW(A2.gradient, 0x18); // 0x38ec
    this.gradientMap();
  }

  /** 0x1a98 -- the compose table: out = 0x80 | ((0x1a0 * old + 0x60 * band) >> 1 + carry) >> 8, for old 0..63, band 0..127, three mirrors */
  shadeTable() {
    const t = this.shade;
    for (let hi = 0x3f; hi >= 0; hi--) {
      for (let lo = 0x7f; lo >= 0; lo--) {
        let ax = (hi * 0x1a0 + lo * 0x60) & 0xffff;
        ax = (ax >> 1) + (ax & 1);
        const v = ((ax & 0xffff) >> 8) | 0x80;
        const bx = (hi << 8) | lo;
        t[(bx + 0x80) & 0xffff] = v;
        t[(bx - 0x8000) & 0xffff] = v;
        t[(bx - 0x7f80) & 0xffff] = v;
      }
    }
  }

  /** 0x1a67 -- the 128 x 128 map the phong polygons read, rows 0x100 apart: (slope * x + (0x100 - slope) * y) >> 8 */
  gradientMap() {
    const map = this.image.subarray(seg(0x3527), seg(0x3527) + 0x10000), s = this.w(A2.gradient);
    let dx = 0, di = 0;
    for (let y = 0; y < 0x80; y++) {
      let cx = 0;
      for (let x = 0; x < 0x80; x++) { map[di++] = ((cx + dx) >> 8) & 0xff; cx = u16(cx + s); }
      dx = u16(dx + 0x100 - s);
      di += 0x80;
    }
  }

  tick() {
    super.tick();
    const A = this.A;
    if (this.ending) return;
    if (this.w(A.fadeOn) === 1) {
      let at = this.w(A.fadePos);
      const from = at;
      if (at >= 0x3f00) { this.setW(A.fadeOn, 0); this.setW(A.fadePos, 0x3e7f); }
      this.setW(A.fadePos, this.w(A.fadePos) + 0xff);
      const r = new Uint8Array(64);
      for (let i = 0, ax = from; i < 64; i++) { r[i] = ax >> 8; if (ax <= 0x3f00) ax = u16(ax + 0x100); } // 0x2650 (part 4's divides its step by 16, this one does not)
      this.cs.set(r, A.ramp);
      for (let i = 0; i < 768; i++) this.dac[i] = this.cs[A.ramp + this.cs[A.pal + i]];
    }
  }

  /** the script's extra operations */
  op(name) {
    if (name === 'map') this.gradientMap();
    else if (name === 'clearshade') { // 0x3b5d: three table cells and the upper half of the segment
      const t = this.shade;
      t[0x80] = 0; t[0x8000] = 0; t[0x8080] = 0;
      t.fill(0, 0x8000, 0x10000);
    }
  }

  nextStep() {
    this.step++;
    const steps = this.cfg.script;
    if (this.step >= steps.length) { this.finish(); return; }
    for (const [kind, a, size, v] of steps[this.step].ops) {
      if (kind === 'set') (size === 4 ? this.setD(a, v) : this.setW(a, v));
      else if (kind === 'dec') this.setW(a, this.w(a) - 1);
      else if (kind === 'inc') this.setW(a, this.w(a) + 1);
      else this.op(a);
    }
    this.setD(this.A.ticks, 0);
    this.setD(this.A.frames, 0);
  }

  scriptCheck() {
    if (this.done || this.ending) return;
    this.setD(this.A.frames, this.d(this.A.frames) + 1);
    const t = this.cfg.script[this.step].ticks;
    if (t !== null && this.d(this.A.ticks) >= t + this.slackFor(this.step)) this.nextStep();
  }

  /** 0x370c.. -- the band, the recursive shade, the label, the screen, the next band */
  compose() {
    const A = this.A, band = this.band, scr = this.screen, img = this.image;
    this.setD(A.tickFlag, 0);
    const mode = this.sw(A.mode), at = this.w(A.bandAt);
    if (mode !== -2) {
      for (let k = 0; k < 0x2800; k++) {
        let v;
        if (mode === -1) v = 0;
        else if (mode === 0) v = 0x80;
        else v = img[seg(0x451) + u16(u16(Math.imul(mode, 0x2800)) + 0xdb0a + k)];
        band[u16(at + k)] = v;
      }
    }
    const t = this.shade;
    for (let i = 0; i < 64000; i++) scr[i] = t[(scr[i] << 8) | band[i]];
    const slide = this.sw(A.labPos);
    if (slide >= 0) {
      let di = 0xb40, ax = slide;
      if (ax > 0x46) { di += ax; ax = 0x46; di -= ax; }
      const dx = 0x46 - ax;
      let si = 0x30a + dx;
      const lab = seg(0x2bd2);
      for (let r = 0; r < 44; r++) { for (let k = 0; k < ax; k++) scr[u16(di + k)] = img[lab + si + k]; si += ax + dx; di += 0x140; }
    }
    this.vram.set(scr.subarray(0x140, 0x140 + 64000));
    // the next band: black, or the next picture
    if (this.w(A.picture) === 1) band.set(img.subarray(seg(0xec3), seg(0xec3) + 64320), 0x140);
    else band.fill(0, 0x140, 0x140 + 64320);
    return this.vram;
  }

  draw3d() {
    const n = this.objects();
    this.sortFaces(n);
    this.polygons();
  }

  finish() {
    this.ending = true;
    this.dac.fill(63); // 0x44f8: the last act is a white screen
    this.done = true;
  }

  render() { if (!this.ending) super.render(); }
}

Part2.CFG = {
  script, gsSeg: 0x2ccd, fbSeg: 0x4527, A: A2, L: OFF2, V: V2, background: 0x4527, label: 0x2bd2, csSize: 0x3800, tShift: 9, texData: true, roundMatrix: true, rowsAt: 0,
  dac: [[0x6507, 0x10, 720, 0], [0x2bd2, 0x2da, 48, 720]],
};
void RELOC;
