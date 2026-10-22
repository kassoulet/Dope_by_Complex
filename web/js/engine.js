/*
 * dope/engine.js -- 320x200 8-bit software renderer in the spirit of the
 * original: one indexed framebuffer, one 6 bit VGA palette, everything drawn
 * by hand and then blitted to a canvas.
 */

export const W = 320;
export const H = 200;

export class VGA {
  constructor(w = W, h = H) {
    this.w = w;
    this.h = h;
    this.fb = new Uint8Array(w * h);
    this.pal = new Uint8Array(768);
    this.image = null;
    this.ctx = null;
    this.textCanvas = document.createElement("canvas");
    this.textCanvas.width = w;
    this.textCanvas.height = h;
    this.textCtx = this.textCanvas.getContext("2d", { willReadFrequently: true });
  }

  attach(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.image = this.ctx.createImageData(this.w, this.h);
  }

  clear(c = 0) {
    this.fb.fill(c);
  }

  plot(x, y, c) {
    x |= 0;
    y |= 0;
    if (x >= 0 && x < this.w && y >= 0 && y < this.h) this.fb[y * this.w + x] = c;
  }

  hline(x0, x1, y, c) {
    y |= 0;
    if (y < 0 || y >= this.h) return;
    if (x0 > x1) [x0, x1] = [x1, x0];
    x0 = Math.max(0, x0 | 0);
    x1 = Math.min(this.w - 1, x1 | 0);
    if (x1 < x0) return;
    this.fb.fill(c, y * this.w + x0, y * this.w + x1 + 1);
  }

  vline(x, y0, y1, c) {
    x |= 0;
    if (x < 0 || x >= this.w) return;
    if (y0 > y1) [y0, y1] = [y1, y0];
    y0 = Math.max(0, y0 | 0);
    y1 = Math.min(this.h - 1, y1 | 0);
    for (let y = y0; y <= y1; y++) this.fb[y * this.w + x] = c;
  }

  line(x0, y0, x1, y1, c) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.plot(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /** Filled triangle, flat colour. */
  tri(x0, y0, x1, y1, x2, y2, c) {
    this.shadeTri(x0, y0, c, x1, y1, c, x2, y2, c);
  }

  /**
   * Gouraud shaded triangle.  Colours are palette indices that already encode
   * the ramp; the rasteriser just interpolates between the three corner
   * indices along each scanline.
   */
  shadeTri(x0, y0, c0, x1, y1, c1, x2, y2, c2) {
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      let loX = Infinity, loC = 0, hiX = -Infinity, hiC = 0;
      for (let e = 0; e < 3; e++) {
        const ax = e === 0 ? x0 : e === 1 ? x1 : x2;
        const ay = e === 0 ? y0 : e === 1 ? y1 : y2;
        const ac = e === 0 ? c0 : e === 1 ? c1 : c2;
        const bx = e === 0 ? x1 : e === 1 ? x2 : x0;
        const by = e === 0 ? y1 : e === 1 ? y2 : y0;
        const bc = e === 0 ? c1 : e === 1 ? c2 : c0;
        if (ay === by) continue;
        const t = (py - ay) / (by - ay);
        if (t < 0 || t > 1) continue;
        const x = ax + (bx - ax) * t;
        const col = ac + (bc - ac) * t;
        if (x < loX) { loX = x; loC = col; }
        if (x > hiX) { hiX = x; hiC = col; }
      }
      if (loX > hiX) continue;
      const xa = Math.max(0, Math.round(loX));
      const xb = Math.min(this.w - 1, Math.round(hiX));
      if (xb < xa) continue;
      const span = hiX - loX || 1;
      const base = y * this.w;
      for (let x = xa; x <= xb; x++) {
        const t = (x - loX) / span;
        this.fb[base + x] = (loC + (hiC - loC) * t) | 0;
      }
    }
  }

  /** Canvas text rendered into the framebuffer with the given palette index. */
  text(str, x, y, color, size = 8, weight = "bold") {
    const t = this.textCtx;
    t.clearRect(0, 0, this.w, this.h);
    t.font = `${weight} ${size}px "Courier New", monospace`;
    t.textBaseline = "top";
    t.fillStyle = "#fff";
    t.fillText(str, 0, 0);
    const data = t.getImageData(0, 0, this.w, this.h).data;
    const width = Math.ceil(t.measureText(str).width);
    for (let yy = 0; yy < size + 6; yy++) {
      for (let xx = 0; xx < Math.min(width, this.w); xx++) {
        if (data[(yy * this.w + xx) * 4 + 3] > 110) this.plot(x + xx, y + yy, color);
      }
    }
    return width;
  }

  setColor(i, r, g, b) {
    this.pal[i * 3] = Math.min(63, Math.max(0, r | 0));
    this.pal[i * 3 + 1] = Math.min(63, Math.max(0, g | 0));
    this.pal[i * 3 + 2] = Math.min(63, Math.max(0, b | 0));
  }

  present() {
    const d = this.image.data;
    for (let i = 0, j = 0; i < this.fb.length; i++, j += 4) {
      const c = this.fb[i];
      d[j] = this.pal[c * 3] << 2;
      d[j + 1] = this.pal[c * 3 + 1] << 2;
      d[j + 2] = this.pal[c * 3 + 2] << 2;
      d[j + 3] = 255;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}

/* ------------------------------------------------------------------ maths */

export const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

export function rotY(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

export function rotX(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

export function rotZ(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

/* -------------------------------------------------------------- geometry */

/** Unit cube corner list and quad faces (indices, CCW when seen from outside). */
export const CUBE = {
  verts: [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ],
  faces: [
    [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7],
    [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0],
  ],
};

/** Tessellated sphere used for the env-mapped object and the globe. */
export function sphere(lat = 12, lon = 18, radius = 1) {
  const verts = [];
  const faces = [];
  for (let i = 0; i <= lat; i++) {
    const theta = (i / lat) * Math.PI;
    for (let j = 0; j < lon; j++) {
      const phi = (j / lon) * Math.PI * 2;
      verts.push([
        Math.sin(theta) * Math.cos(phi) * radius,
        Math.cos(theta) * radius,
        Math.sin(theta) * Math.sin(phi) * radius,
      ]);
    }
  }
  const idx = (i, j) => i * lon + (j % lon);
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = idx(i, j), b = idx(i, j + 1), c = idx(i + 1, j + 1), d = idx(i + 1, j);
      if (i !== 0) faces.push([a, b, c]);
      if (i !== lat - 1) faces.push([a, c, d]);
    }
  }
  return { verts, faces };
}

export function torus(R = 1, r = 0.42, nu = 20, nv = 12) {
  const verts = [];
  const faces = [];
  for (let i = 0; i < nu; i++) {
    const u = (i / nu) * Math.PI * 2;
    for (let j = 0; j < nv; j++) {
      const v = (j / nv) * Math.PI * 2;
      verts.push([
        (R + r * Math.cos(v)) * Math.cos(u),
        r * Math.sin(v),
        (R + r * Math.cos(v)) * Math.sin(u),
      ]);
    }
  }
  const idx = (i, j) => (i % nu) * nv + (j % nv);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      faces.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)]);
    }
  }
  return { verts, faces };
}
