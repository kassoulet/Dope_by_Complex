/*
 * dope/ports/part3.js -- part 3 of DOPE, "7800 PHONG polys", ported from block 3.
 *
 * One object (a lumpy blob, 514 vertices, about 1000 faces) turns in front of a
 * starfield, lit by "phong" shading: every pixel's colour is looked up from
 * the interpolated direction of the surface (see raster3.js).  The camera
 * and the blob move on a script of 21 steps; a label slides in at the start.
 *
 * Structure of the original, one function each here:
 *
 *   tick()    0x2060  the timer hook: move every object by its speeds, slide the label
 *   objects() 0x2b5a  rotate, project and cull each object's vertices and faces
 *   (sort)    0x2b95  radix sort of the visible faces by depth      engine3d.js
 *   polygons()0x2920  draw them back to front                      raster3.js
 *   compose() 0x2c1c  paste the label, copy the frame to the screen,
 *                     restore the background for the next frame
 *   script    0x2d9b..0x305a  21 steps of "set these variables, run N ticks"
 *
 * The working variables of the original live in its code segment; the port
 * keeps them in `cs`, a copy of that segment's first 0x3000 bytes, at the same
 * addresses (the script table names them by address), so tests can compare
 * with the original byte for byte.
 */
import { seg, RELOC } from './part4.js';
import { OFF, rotationMatrix, transformObject, buildFaces, radixSort, buildSine } from './engine3d.js';
import { Rasteriser, V3 } from './raster3.js';
import script from './data/part3script.js';

export const CS = 0xf8b0;
const s16 = (v) => (v << 16) >> 16;

// addresses in cs of the variables used here (see the notes at the top)
export const A3 = {
  camAngle: 0x182e, camPos: 0x1816, records: 0x1810, recSize: 0x3a,
  labPos: 0x19c4, labVel: 0x19c6, tickFlag: 0x1996, ticks: 0x199a, frames: 0x199e, spin: 0x19d6,
  base: 0x19a2, count: 0x19a4, cull: 0x19a6, selA: 0x19be, selB: 0x19bc, bufSeg: 0x19d0,
  off: 0x196c, pos: 0x1982, focal: 0x198e, angles: 0x1df0,
  dsTab: 0x400, fsTab: 0x408, sine: 0x410,
};

export class Part3 {
  constructor(image, { screen = null, pal = null } = {}) {
    const cfg = this.constructor.CFG;
    this.opts = { screen, pal, ...arguments[1] };
    this.A = cfg.A; this.L = cfg.L; this.cfg = cfg;
    const rdW = (o) => image[CS + o] | (image[CS + o + 1] << 8);
    this.cs = image.slice(CS, CS + (cfg.csSize || 0x3000));
    this.image = image;
    this.sin = buildSine(new Int16Array(Array.from({ length: 0x200 }, (_, i) => s16(rdW(this.A.sine + 2 * i)))));
    this.total = 0;
    this.gs = image.subarray(seg(cfg.gsSeg), seg(cfg.gsSeg) + 0x10000); // the engine's arrays; in the image, because the frame buffer's tail overlaps them
    this.fbSeg = cfg.fbSeg !== undefined ? (cfg.fbSeg + RELOC) & 0xffff : rdW(this.A.bufSeg);
    this.fb = image.subarray(this.fbSeg << 4, (this.fbSeg << 4) + 0x10000); // the off screen frame (in the image: other things overlap its tail)
    this.background = image.subarray(seg(cfg.background), seg(cfg.background) + 0x3ed0 * 4);
    this.rows = new Uint16Array(256);
    for (let i = 0; i < 256; i++) this.rows[i] = rdW((cfg.rowsAt || 0) + 2 * i);
    this.tex = { ds: [], fs: [] };
    for (let i = 0; i < 4; i++) {
      const d = rdW(this.A.dsTab + 2 * i) << 4, f = rdW(this.A.fsTab + 2 * i) << 4;
      this.tex.ds.push(image.subarray(d, d + 0x10000));
      this.tex.fs.push(f ? image.subarray(f, f + 0x10000) : null); // no map: the plain texture mapper
    }
    this.ras = new Rasteriser({ cs: this.cs, gs: this.gs, OFF: cfg.L, V: cfg.V, fb: this.fb, rows: this.rows, tShift: cfg.tShift || 8 });
    this.vram = new Uint8Array(64000);
    if (screen) this.vram.set(screen);
    // the screen as the part sets it up: 0..239 from one picture, 240..255 the label's, then 0..15 from the background's
    this.dac = new Uint8Array(768);
    for (const [segment, at, n, to] of cfg.dac) this.dac.set(image.subarray(seg(segment) + at, seg(segment) + at + n), to);
    this.step = -1;
    this.done = false;
    this.nextStep();
  }

  // ---- the variables in cs, by address
  w(o) { return this.cs[o] | (this.cs[o + 1] << 8); }
  sw(o) { return s16(this.w(o)); }
  d(o) { return (this.cs[o] | (this.cs[o + 1] << 8) | (this.cs[o + 2] << 16) | (this.cs[o + 3] << 24)) | 0; }
  setW(o, v) { this.cs[o] = v & 0xff; this.cs[o + 1] = (v >> 8) & 0xff; }
  setD(o, v) { this.cs[o] = v & 0xff; this.cs[o + 1] = (v >> 8) & 0xff; this.cs[o + 2] = (v >> 16) & 0xff; this.cs[o + 3] = (v >>> 24) & 0xff; }

  labelBase() { return this.cfg.label ? seg(this.cfg.label) : this.w(this.A.labSeg) << 4; } // where the label picture is, as a linear address: fixed, or named by a variable the script changes

  /** 0x2060 -- the timer hook, once per tick. */
  tick() {
    this.total++;
    this.setW(this.A.labPos, this.w(this.A.labPos) + this.w(this.A.labVel));
    const lp = this.sw(this.A.labPos);
    if (lp < 0 || this.w(this.A.labPos) >= 0x4b) this.setW(this.A.labVel, 0);
    if (this.A.spin) this.setW(this.A.spin, this.w(this.A.spin) + 0x64);
    for (let r = this.A.records; ; r += this.A.recSize) {
      if (this.w(r + 2) === 0) {
        if (this.w(r) === 0) break;
        // angles += angular speeds, positions += speeds
        for (let i = 0; i < 3; i++) this.setW(r + 0x1e + 2 * i, this.w(r + 0x1e + 2 * i) + this.w(r + 0x24 + 2 * i));
        for (let i = 0; i < 3; i++) this.setD(r + 6 + 4 * i, this.d(r + 6 + 4 * i) + this.d(r + 0x12 + 4 * i));
      }
    }
    this.setD(this.A.tickFlag, this.d(this.A.tickFlag) + 1);
    this.setD(this.A.ticks, this.d(this.A.ticks) + 1);
  }

  /** 0x2b5a with 0x2a9b -- every visible object's vertices and faces. */
  objects() {
    const o = { base: 0, count: 0 };
    for (let r = this.A.records; this.w(r) !== 0; r += this.A.recSize) {
      if (this.w(r) === 0xffff || this.w(r + 2) !== 0) continue; // the camera / hidden
      const segW = this.w(r);
      const geo = this.image.subarray(segW << 4, (segW << 4) + 0x10000);
      const ang = [0, 1, 2].map((i) => (this.sw(r + 0x1e + 2 * i) + this.sw(this.A.camAngle + 2 * i)) >> 4);
      const M = rotationMatrix(this.sin, ...ang, this.cfg.roundMatrix);
      const pos = [0, 1, 2].map((i) => (this.d(r + 6 + 4 * i) + this.d(this.A.camPos + 4 * i)) | 0);
      const offset = [0, 1, 2].map((i) => this.d(r + 0x2e + 4 * i));
      const sel = this.w(r + 0x2a);
      transformObject(this.gs, geo, M, { base: o.base, offset, pos, focal: this.sw(r + 4), texData: this.cfg.texData, addOffset: this.cfg.addOffset, negEnv: this.cfg.negEnv }, this.L);
      o.cull = this.w(r + 0x2c);
      o.selA = (this.w(this.A.selA) & 0xff) + (sel & 0xff);
      o.selB = (this.w(this.A.selB) & 0xff) + (sel >> 8);
      buildFaces(this.gs, geo, o, this.L);
    }
    new DataView(this.gs.buffer, this.gs.byteOffset, this.gs.length).setUint32(this.L.list + 4 * o.count, 0xffffffff, true);
    this.setW(this.A.count, o.count);
    this.setW(this.A.base, o.base);
    return o.count;
  }

  /** 0x2920 -- draw the sorted faces back to front into the off screen frame. */
  polygons() {
    const dv = new DataView(this.gs.buffer, this.gs.byteOffset, this.gs.length);
    for (let si = this.L.list; ; si += 4) {
      const slot = dv.getUint16(si, true);
      if (slot >= 0x8000) break;
      const v0 = dv.getUint16(this.L.f0 + 2 * slot, true), v1 = dv.getUint16(this.L.f1 + 2 * slot, true), v2 = dv.getUint16(this.L.f2 + 2 * slot, true);
      this.ras.polygon(v0 & ~3, v1 & ~3, v2 & ~3, this.tex.ds[v2 & 3], this.tex.fs[v1 & 3]);
    }
  }

  sortFaces(n) { radixSort(this.gs, n, this.L); }

  /** The 3D half of a frame: 0x2b5a, 0x2b95, 0x2920. */
  draw3d() {
    const n = this.objects();
    this.sortFaces(n);
    this.polygons();
  }

  /** 0x2c1c (after its wait for a tick) -- label, copy to the screen, restore the background. */
  compose() {
    this.setD(this.A.tickFlag, 0);
    const slide = this.sw(this.A.labPos);
    const label = this.image.subarray(this.labelBase(), this.labelBase() + 0x30a + 0x46 * 44);
    if (slide >= 0) {
      let di = 0xb40, ax = slide;
      if (ax > 0x46) { di += ax; ax = 0x46; di -= ax; }
      const dx = 0x46 - ax;
      let si = 0x30a + dx;
      for (let r = 0; r < 44; r++) { for (let k = 0; k < ax; k++) this.fb[di + k] = label[si + k]; si += ax + dx; di += 0x140; }
    }
    this.vram.set(this.fb.subarray(0x140, 0x140 + 64000), 0);
    this.fb.set(this.background.subarray(0, 0x3ed0 * 4), 0x140);
    return this.vram;
  }

  /** What the main loop does after a frame: leave the step when its ticks are up. */
  scriptCheck() {
    if (this.done || this.ending) return;
    this.setD(this.A.frames, this.d(this.A.frames) + 1);
    if (this.d(this.A.ticks) >= this.cfg.script[this.step].ticks) this.nextStep();
  }

  /** The script has run out. */
  finish() { this.done = true; }

  nextStep() {
    this.step++;
    if (this.step >= this.cfg.script.length) { this.finish(); return; }
    for (const [addr, size, value] of this.cfg.script[this.step].set) (size === 4 ? this.setD(addr, value) : this.setW(addr, value));
    this.setD(this.A.ticks, 0);
    this.setD(this.A.frames, 0);
  }

  /** The picture for the current tick (what the player asks for). */
  render() { this.draw3d(); this.compose(); }

  frame() { this.draw3d(); const v = this.compose(); this.scriptCheck(); return v; }

  /** Run the part's clock up to `tick`, drawing nothing (the player calls frame() for pictures). */
  advanceTo(tick) {
    while (this.total < tick && !this.done) { this.tick(); this.scriptCheck(); }
  }
}

Part3.CFG = {
  script, gsSeg: 0x343d, A: A3, L: OFF, V: V3, background: 0x4bb1, label: 0x3342,
  dac: [[0x306, 0x10, 720, 0], [0x3342, 0x2da, 48, 720], [0x4b81, 0, 48, 0]], // [segment, offset, bytes, first DAC byte]
};
