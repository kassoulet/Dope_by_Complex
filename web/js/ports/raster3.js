/*
 * dope/ports/raster3.js -- the triangle rasteriser of the shared 3D engine,
 * ported from block 3 (0x2311 and the two scanline loops 0x20f0 / 0x21e0).
 *
 * What it draws: a triangle whose three corners carry two attributes each,
 * both interpolated linearly across the triangle, each as two 16 bit lanes
 * packed in one 32 bit number:
 *
 *   T  (the normal's x,y)          -> a 7 bit position in a 128 x 128 map `fs`;
 *                                     the byte found there picks a row of `ds`
 *   U  (the rotated normal's x,y)  -> the position inside that row
 *
 * pixel = ds[ row(fs[T]) + U ]: two table lookups per pixel and nothing else
 * but adding the two gradients.  That is the "phong" look: the colour depends
 * on the interpolated direction of the surface, not on a flat shade.  (Parts
 * 5, 6 and 7 keep this machinery and change the tables.)
 *
 * The original packs everything to keep the inner loop short, and this port
 * is a faithful transcription where exactness depends on it:
 *
 *  - a screen point is (x << 16) | y; an edge position is a screen address
 *    (x + 320 y) with 16 fractional bits.  The two edges are kept in two
 *    registers *crossed*: one holds the left edge's address and the right
 *    edge's fraction, the other the opposite, so that a single
 *    `add ebp / adc edx / adc ebp` chain steps both edges by their slopes;
 *  - edge slopes are (packed difference) / (row count): the low half of the
 *    packed point is y, so every slope carries one extra unit in its low bit;
 *  - the per polygon gradients are patched into the immediates of the inner
 *    loop in the original; here they are fields of `cs` at the same addresses,
 *    so a test can compare the whole state with the original's;
 *  - two copies of the scanline loop: 0x20f0 for polygons wholly on the screen
 *    (the right side), 0x21e0 which clips each row to its 320 bytes.
 *
 * Comments name original addresses (block offsets; the code itself shows them
 * minus 0x100).
 */

const s16 = (v) => (v << 16) >> 16;
const u16 = (v) => v & 0xffff;
const rol16 = (v) => ((v << 16) | (v >>> 16)) | 0;
/** xchg r16,r16 on two 32 bit registers: only the low words trade places */
const xchg16 = (a, b) => [((a & 0xffff0000) | (b & 0xffff)) | 0, ((b & 0xffff0000) | (a & 0xffff)) | 0];
const idiv = (n, d) => Math.trunc(n / d); // truncates toward zero, as idiv does

/** where the original keeps the polygon routine's variables (offsets in its cs) */
/** and block 7's: the same code assembled a few bytes earlier, so every address moved */
export const V7 = {
  accT: 0x1fc8, accU: 0x1fcc, rows: 0x1fd0, gradT: 0x2068, gradU: 0x2071, rowU: 0x2086, rowT: 0x2090,
  patchL: 0x2097, patchR: 0x209e, patchL2: 0x21c2, patchR2: 0x21c9,
  p0: 0x27c8, p1: 0x27cc, p2: 0x27d0, s01: 0x27d4, s02: 0x27d8, s12: 0x27dc, edgeL: 0x27e0, edgeR: 0x27e4,
  dy01: 0x27e8, dy02: 0x27ea, dy12: 0x27ec, u0: 0x27ee, u1: 0x27f2, u2: 0x27f6, t0: 0x27fa, t1: 0x27fe, t2: 0x2802,
  flat: 0x2806, clip: 0x2808, rowBase: 0x280a,
};

export const V3 = {
  accT: 0x1fe4, accU: 0x1fe8, rows: 0x1fec, // the two accumulators, scanlines left
  gradT: 0x2078, gradU: 0x2081, // per pixel gradients: a dword each, lanes lo, hi
  rowU: 0x2096, rowT: 0x20a0, // per scanline slopes
  patchL: 0x20a7, patchR: 0x20ae, // edge slopes patched into the unclipped loop
  patchL2: 0x21d2, patchR2: 0x21d9, // ... and into the clipped one
  p0: 0x27d0, p1: 0x27d4, p2: 0x27d8, // the corners, sorted by y
  s01: 0x27dc, s02: 0x27e0, s12: 0x27e4, // edge slopes
  edgeL: 0x27e8, edgeR: 0x27ec, // edge positions
  dy01: 0x27f0, dy02: 0x27f2, dy12: 0x27f4, // row counts
  u0: 0x27f6, u1: 0x27fa, u2: 0x27fe, // the corners' U attribute
  t0: 0x2802, t1: 0x2806, t2: 0x280a, // ... and T attribute
  flat: 0x280e, clip: 0x2810, rowBase: 0x2812,
};

export class Rasteriser {
  /**
   * @param cs   Uint8Array(0x3000): the variables, indexed like the original's cs
   * @param gs   the engine's arrays (engine3d.js)
   * @param OFF  their offsets
   * @param fb   the frame buffer (320 x 200 and the slack the unclipped loop may write)
   * @param rows Uint16Array(256): the map byte -> row offset in `ds` (the words at cs:0..0x1ff)
   */
  constructor({ cs, gs, OFF, fb, rows, V = V3 }) { Object.assign(this, { cs, gs, OFF, fb, rows, V }); }

  w(o) { return this.cs[o] | (this.cs[o + 1] << 8); }
  sw(o) { return s16(this.w(o)); }
  d(o) { const c = this.cs; return (c[o] | (c[o + 1] << 8) | (c[o + 2] << 16) | (c[o + 3] << 24)) | 0; }
  setW(o, v) { this.cs[o] = v & 0xff; this.cs[o + 1] = (v >> 8) & 0xff; }
  setD(o, v) { const c = this.cs; c[o] = v & 0xff; c[o + 1] = (v >> 8) & 0xff; c[o + 2] = (v >> 16) & 0xff; c[o + 3] = (v >>> 24) & 0xff; }
  addD(o, v) { this.setD(o, (this.d(o) + v) | 0); }
  gd(o) { const g = this.gs; return (g[o] | (g[o + 1] << 8) | (g[o + 2] << 16) | (g[o + 3] << 24)) | 0; }

  /** `idiv word` after `cwd`: (a - b) / dy on 16 bit lanes, keeping the low 16 bits of the quotient */
  lane(hi, lo, dy) { return u16(idiv(s16(u16(this.w(hi) - this.w(lo))), s16(dy))); }

  /**
   * 0x2311 -- one triangle.  si, di, bp are the vertices' slots (4 * index).
   * `ds` is the lookup segment (a Uint8Array of 64 KB), `fs` the 128 x 128 map.
   */
  polygon(si, di, bp, ds, fs) {
    const OFF = this.OFF, V = this.V;
    let eax = this.gd(OFF.sy + si), ebx = this.gd(OFF.sy + di), ecx = this.gd(OFF.sy + bp);
    // all three corners off to the right?  cmp / sbb, with the original's reuse of edx
    let edx = 0x1400000;
    let cf = (edx >>> 0) < (eax >>> 0) ? 1 : 0; // cmp edx,eax / sbb dx,dx
    let dx = u16(-cf);
    edx = (edx & 0xffff0000) | dx;
    cf = (edx >>> 0) < (ebx >>> 0) ? 1 : 0; // cmp edx,ebx / sbb dx,0
    dx = u16(dx - cf);
    edx = (edx & 0xffff0000) | dx;
    cf = (edx >>> 0) < (ecx >>> 0) ? 1 : 0; // cmp edx,ecx / sbb dx,0
    dx = u16(dx - cf);
    if (dx === 0xfffd) return;
    this.setW(V.clip, dx);
    // order the corners by y
    const swapAB = () => { [eax, ebx] = [ebx, eax]; [si, di] = [di, si]; };
    const swapBC = () => { [ebx, ecx] = [ecx, ebx]; [di, bp] = [bp, di]; };
    if (!(s16(eax) < s16(ebx))) swapAB();
    if (!(s16(ebx) < s16(ecx))) swapBC();
    if (!(s16(eax) < s16(ebx))) swapAB();
    if (s16(eax) > 0xc9) return; // starts below the screen
    if (s16(ecx) < 1) return; // ends above it
    if (s16(eax) === s16(ebx) && !(eax < ebx)) swapAB(); // flat top: the left corner first
    this.setD(V.p0, eax); this.setD(V.p1, ebx); this.setD(V.p2, ecx);
    const ue = (v) => this.gd(OFF.env + v), te = (v) => this.gd(OFF.tex + v);
    this.setD(V.u0, ue(si)); this.setD(V.u1, ue(di)); this.setD(V.u2, ue(bp)); this.setD(V.accU, ue(si));
    this.setD(V.t0, te(si)); this.setD(V.t1, te(di)); this.setD(V.t2, te(bp)); this.setD(V.accT, te(si));
    this.setW(V.flat, 1);
    // the three edge slopes
    eax = (this.d(V.p1) - this.d(V.p0)) | 0;
    ebx = 0;
    this.setW(V.dy01, eax);
    if (u16(eax) !== 0) { ebx = u16(eax); this.setD(V.s01, idiv(eax, ebx) | 0); this.setW(V.flat, 0); }
    eax = (this.d(V.p2) - this.d(V.p0)) | 0;
    this.setW(V.dy02, eax);
    if (u16(eax) === 0) return;
    ebx = (ebx & 0xffff0000) | u16(eax);
    this.setD(V.s02, idiv(eax, ebx) | 0);
    eax = (this.d(V.p2) - this.d(V.p1)) | 0;
    this.setW(V.dy12, eax);
    if (u16(eax) !== 0) { ebx = (ebx & 0xffff0000) | u16(eax); this.setD(V.s12, idiv(eax, ebx) | 0); }
    let esi = this.d(V.p0);
    this.setD(V.edgeL, esi);
    this.setD(V.edgeR, (esi + 0x7fff) | 0);
    esi = this.d(V.s01);
    let edi = this.d(V.s02);
    ebx = this.w(V.dy01);
    let ebp = (esi - edi) | 0;
    // 0x24a1 / 0x24b3 / the first case: the per row slopes of the attributes
    if (ebp === 0 || ebx === 0) {
      ebp = (this.d(V.p1) - this.d(V.p0)) | 0;
      if (ebp === 0) return; // (the row slopes keep their old values)
    } else {
      ebp = Math.imul(ebp, ebx);
      const dy = esi < edi ? this.w(V.dy01) : this.w(V.dy02);
      const c = esi < edi ? { u: V.u1, t: V.t1 } : { u: V.u2, t: V.t2 };
      if (dy !== 0) { // (the left case tests it, the right one cannot be 0 here)
        this.setW(V.rowU, this.lane(c.u, V.u0, dy));
        this.setW(V.rowU + 2, this.lane(c.u + 2, V.u0 + 2, dy));
        this.setW(V.rowT, this.lane(c.t, V.t0, dy));
        this.setW(V.rowT + 2, this.lane(c.t + 2, V.t0 + 2, dy));
      }
    }
    // 0x24ef: the gradient along a row.  For each lane, the value the long edge
    // has level with corner 1, minus corner 1's, over the width ebp
    const across = (a0, a1, a2) => {
      let v = s16(u16(this.w(a0) - this.w(a2))); // ax = c0 - c2
      v = s16(u16(idiv(v * this.sw(V.dy01), this.sw(V.dy02)))); // imul word [dy01] / idiv word [dy02]
      v = s16(u16(v - this.w(a0) + this.w(a1))); // sub ax,[c0] / add ax,[c1]
      return u16(idiv(((v << 16) | 0), ebp)); // shl eax,16 / cdq / idiv ebp, keep ax
    };
    this.setW(V.gradU, across(V.u0, V.u1, V.u2));
    this.setW(V.gradU + 2, across(V.u0 + 2, V.u1 + 2, V.u2 + 2));
    this.setW(V.gradT, across(V.t0, V.t1, V.t2));
    this.setW(V.gradT + 2, across(V.t0 + 2, V.t1 + 2, V.t2 + 2));
    if (this.sw(V.p1) <= 1 || this.w(V.flat) === 1) {
      // 0x2589: the middle corner is at the top of the screen, or the triangle has a flat top:
      // skip down to it without drawing, then go on with the lower part
      eax = this.w(V.dy01);
      edi = Math.imul(edi, eax);
      ebx = eax;
      eax = Math.imul(eax, this.d(V.rowU));
      ebx = Math.imul(ebx, this.d(V.rowT));
      edi = (edi + this.d(V.edgeL)) | 0;
      this.addD(V.accU, eax);
      this.addD(V.accT, ebx);
      esi = this.d(V.p1);
      if (!(edi < esi)) [edi, esi] = [esi, edi];
      this.setD(V.edgeL, edi);
      this.setD(V.edgeR, (esi + 0x7fff) | 0);
      let y = this.sw(V.p0);
      if (!(y >= 1)) y = 1;
      const add = (Math.imul(y, 5) << 22) | 0; // y * 320 into the address field
      this.addD(V.edgeL, add);
      this.addD(V.edgeR, add);
    } else {
      // 0x25f1: the upper triangle, clipped at the top, drawn
      if (!(esi < edi)) [esi, edi] = [edi, esi];
      if (this.sw(V.p1) > 0xc9) this.setW(V.p1, 0xc9);
      if (this.sw(V.p0) < 1) {
        const n = u16(1 - this.w(V.p0));
        this.addD(V.accU, Math.imul(n, this.d(V.rowU)));
        this.addD(V.accT, Math.imul(n, this.d(V.rowT)));
        this.addD(V.edgeL, Math.imul(n, esi));
        this.addD(V.edgeR, Math.imul(n, edi));
        this.setW(V.p0, 1);
      }
      const y = this.w(V.p0), count = u16(this.w(V.p1) - y);
      if (count === 0) return;
      const base = u16(Math.imul(y, 5) << 6);
      this.setW(V.rowBase, base);
      this.addD(V.edgeL, base << 16);
      this.addD(V.edgeR, base << 16);
      this.scanlines(count, esi, edi, ds, fs);
    }
    // 0x267b: the lower triangle
    const dy = this.w(V.dy12);
    if (dy === 0) return;
    this.setW(V.rowU, u16(idiv(s16(u16(this.w(V.u2) - this.w(V.accU))), s16(dy))));
    this.setW(V.rowU + 2, u16(idiv(s16(u16(this.w(V.u2 + 2) - this.w(V.accU + 2))), s16(dy))));
    this.setW(V.rowT, u16(idiv(s16(u16(this.w(V.t2) - this.w(V.accT))), s16(dy))));
    this.setW(V.rowT + 2, u16(idiv(s16(u16(this.w(V.t2 + 2) - this.w(V.accT + 2))), s16(dy))));
    esi = this.d(V.s02);
    edi = this.d(V.s12);
    if (!(esi > edi)) [esi, edi] = [edi, esi];
    if (this.w(V.p2) > 0xc9) this.setW(V.p2, 0xc9); // an unsigned compare
    if (this.sw(V.p1) < 1) {
      const n = u16(1 - this.w(V.p1));
      this.addD(V.accU, Math.imul(n, this.d(V.rowU)));
      this.addD(V.accT, Math.imul(n, this.d(V.rowT)));
      this.addD(V.edgeL, Math.imul(n, esi));
      this.addD(V.edgeR, Math.imul(n, edi));
      this.setW(V.p1, 1);
    }
    const y1 = this.w(V.p1), count = u16(this.w(V.p2) - y1);
    if (count === 0) return;
    this.setW(V.rowBase, u16(Math.imul(y1, 5) << 6));
    this.scanlines(count, esi, edi, ds, fs);
  }

  /**
   * 0x20f0 / 0x21e0 -- `count` scanlines.  esi and edi are the two edge slopes
   * (before the original's bias and rotation, which happen here too).
   */
  scanlines(count, esi, edi, ds, fs) {
    const fb = this.fb, rows = this.rows, V = this.V;
    this.setW(V.rows, count);
    esi = (esi + 0x1400000) | 0; // 320 added to the address field: one row down per step
    edi = (edi + 0x1400000) | 0;
    [esi, edi] = xchg16(esi, edi);
    esi = rol16(esi);
    edi = rol16(edi);
    const clipped = this.w(V.clip) !== 0;
    this.setD(clipped ? V.patchL2 : V.patchL, esi);
    this.setD(clipped ? V.patchR2 : V.patchR, edi);
    let ebp = this.d(V.edgeL), edx = this.d(V.edgeR);
    [ebp, edx] = xchg16(ebp, edx);
    ebp = rol16(ebp);
    edx = rol16(edx);
    let ebx = clipped ? this.w(V.rowBase) : 0; // the row's first address (clipped loop only)
    for (;;) {
      const keepEbp = ebp, keepEdx = edx;
      let ecx = this.d(V.accT);
      let edxx = this.d(V.accU);
      let di = ebp & 0xffff;
      let n; // pixels to draw
      if (!clipped) {
        n = u16(di - (edx & 0xffff)); // sub bp,dx
        if (n & 0x8000) n = 0x10000 - n; else n = 0; // jns: nothing; else count up to 0
      } else {
        let bp = edx & 0xffff;
        const e = (di - ebx) | 0; // sub edi,ebx (32 bit)
        let skip = false;
        if (e < 0) { // borrow: the left edge is before this row's start; step the attributes to column 0
          ecx = (ecx - Math.imul(e, this.d(V.gradT))) | 0;
          edxx = (edxx - Math.imul(e, this.d(V.gradU))) | 0;
          di = ebx;
        } else {
          di = u16(e + ebx); // add di,bx
          if (di >= u16(ebx + 0x140)) skip = true; // cmp di,bx / jnc: the left edge is past the row's end
        }
        n = 0;
        if (!skip) {
          if (!(bp >= ebx)) bp = ebx; // clamp the right edge into this row
          const end = u16(ebx + 0x140);
          if (!(bp < end)) bp = end;
          n = u16(bp - di);
          if (n === 0 || (n & 0x8000)) n = 0;
        }
      }
      for (let k = 0; k < n; k++) {
        const bx1 = (((ecx >>> 8) & 0x7f) << 8) | ((ecx >>> 24) & 0x7f); // mov bl,ch / shld ebx,ecx,8 / and bx,0x7f7f
        di = (di + 1) & 0xffff;
        const a = fs[bx1];
        const bx3 = (((edxx >>> 8) & 0xff) << 8) | ((edxx >>> 24) & 0xff); // shld ebx,edx,8 / mov bh,dh
        const si = rows[a];
        ecx = (ecx + this.d(V.gradT)) | 0;
        const px = ds[(bx3 + si) & 0xffff];
        edxx = (edxx + this.d(V.gradU)) | 0;
        fb[(di - 1) & 0xffff] = px;
      }
      // the next row
      ebp = keepEbp; edx = keepEdx;
      this.addD(V.accU, this.d(V.rowU));
      this.addD(V.accT, this.d(V.rowT));
      let sum = (ebp >>> 0) + ((clipped ? this.d(V.patchL2) : this.d(V.patchL)) >>> 0); // add ebp,imm
      let carry = sum > 0xffffffff ? 1 : 0; ebp = sum | 0;
      sum = (edx >>> 0) + ((clipped ? this.d(V.patchR2) : this.d(V.patchR)) >>> 0) + carry; // adc edx,imm
      carry = sum > 0xffffffff ? 1 : 0; edx = sum | 0;
      ebp = ((ebp >>> 0) + carry) | 0; // adc ebp,0
      if (clipped) ebx = u16(ebx + 0x140);
      this.setW(V.rows, this.w(V.rows) - 1);
      if (this.w(V.rows) === 0) break;
    }
    ebp = rol16(ebp); edx = rol16(edx);
    [ebp, edx] = xchg16(ebp, edx);
    this.setD(V.edgeL, ebp); this.setD(V.edgeR, edx);
  }
}
