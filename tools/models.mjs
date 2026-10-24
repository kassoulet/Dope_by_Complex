/*
 * The 3D models of DOPE, drawn from the demo's own data: tools/models.mjs
 * For each mesh found in the part blocks: its statistics (printed) and a PNG with three views, shaded
 * (painter's algorithm, one light) above and as a wireframe below (web/img/models/<name>.png).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { findBlocks } from '../web/js/rnc.js';
import { loadImage } from '../web/js/ports/image.js';
import { encodePNG } from './png.mjs';

const table = JSON.parse(readFileSync('web/data/parts.json', 'utf8'));
const blocks = findBlocks(new Uint8Array(readFileSync('DOPE.EXE'))).map((b) => b.data);
// name, block, segment (as stored in the object record), what the part does with it
export const MODELS = [
  ['part2_ring', 2, 0x2dec], ['part2_knot', 2, 0x309c], ['part3_rock', 3, 0x22dd], ['part5_worm', 5, 0x237d],
  ['part6_open', 6, 0x2c3d], ['part6_cube', 6, 0x2fa8], ['part7_snakes', 7, 0x332f],
];

export function loadMesh(block, seg) {
  const p = table.parts.find((x) => x.block === block);
  const img = loadImage(blocks[block], p.reloc);
  const g = seg << 4;
  const w = (o) => img[g + o] | (img[g + o + 1] << 8), s = (o) => (w(o) << 16) >> 16;
  const nv = w(0), nf = w(2), vo = w(4), fo = w(6), no = w(8);
  const v = [], n = [], f = [];
  for (let i = 0; i < nv; i++) { v.push([s(vo + 6 * i), s(vo + 6 * i + 2), s(vo + 6 * i + 4)]); n.push([s(no + 6 * i), s(no + 6 * i + 2), s(no + 6 * i + 4)]); }
  for (let i = 0; i < nf; i++) f.push([w(fo + 8 * i + 2) / 4, w(fo + 8 * i + 4) / 4, w(fo + 8 * i + 6) / 4]);
  return { v, n, f };
}

const rot = (p, ax, ay) => {
  const [x, y, z] = p, cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
  const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
  return [x1, y * cx - z1 * sx, y * sx + z1 * cx];
};

function render(mesh, ax, ay, wire, W = 320, H = 200) {
  const rgb = new Uint8Array(W * H * 3).fill(16);
  const R = Math.max(...mesh.v.map((p) => Math.hypot(...p))), k = Math.min(W, H) * 0.46 / R;
  const P = mesh.v.map((p) => rot(p, ax, ay));
  const X = (p) => W / 2 + p[0] * k, Y = (p) => H / 2 - p[1] * k;
  const put = (x, y, c) => { x |= 0; y |= 0; if (x >= 0 && y >= 0 && x < W && y < H) { const o = (y * W + x) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; } };
  const line = (a, b, c) => { const n = Math.max(Math.abs(X(b) - X(a)), Math.abs(Y(b) - Y(a))) | 0; for (let i = 0; i <= n; i++) { const t = n ? i / n : 0; put(X(a) + (X(b) - X(a)) * t, Y(a) + (Y(b) - Y(a)) * t, c); } };
  const faces = mesh.f.map((t) => ({ t, z: (P[t[0]][2] + P[t[1]][2] + P[t[2]][2]) / 3 })).sort((a, b) => a.z - b.z);
  for (const { t } of faces) {
    const [a, b, c] = t.map((i) => P[i]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...nrm) || 1;
    const facing = nrm[2] / len; // toward the viewer (z up)
    if (wire) { if (facing > 0) { const col = [90, 200, 255]; line(a, b, col); line(b, c, col); line(c, a, col); } continue; }
    if (facing <= 0) continue;
    const shade = Math.max(0.1, (nrm[0] * -0.4 + nrm[1] * 0.5 + nrm[2] * 0.75) / len);
    const col = [60 + 190 * shade, 70 + 170 * shade, 100 + 150 * shade];
    // fill the triangle by scanning its bounding box
    const x0 = Math.floor(Math.min(X(a), X(b), X(c))), x1 = Math.ceil(Math.max(X(a), X(b), X(c)));
    const y0 = Math.floor(Math.min(Y(a), Y(b), Y(c))), y1 = Math.ceil(Math.max(Y(a), Y(b), Y(c)));
    const d = (X(b) - X(a)) * (Y(c) - Y(a)) - (X(c) - X(a)) * (Y(b) - Y(a));
    if (!d) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const l1 = ((x - X(a)) * (Y(c) - Y(a)) - (X(c) - X(a)) * (y - Y(a))) / d, l2 = ((X(b) - X(a)) * (y - Y(a)) - (x - X(a)) * (Y(b) - Y(a))) / d;
      if (l1 >= -0.01 && l2 >= -0.01 && l1 + l2 <= 1.01) put(x, y, col);
    }
  }
  return rgb;
}

if (process.argv[1].endsWith('models.mjs')) {
  const views = [[0, 0], [0.5, 0.9], [0.3, 1.57]];
  for (const [name, b, seg] of MODELS) {
    const mesh = loadMesh(b, seg);
    const W = 320, H = 200, sheet = new Uint8Array(W * 3 * H * 2 * 3);
    views.forEach(([ax, ay], i) => [false, true].forEach((wire, row) => {
      const rgb = render(mesh, ax, ay, wire);
      for (let y = 0; y < H; y++) sheet.set(rgb.subarray(y * W * 3, (y + 1) * W * 3), ((row * H + y) * W * 3 + i * W) * 3);
    }));
    writeFileSync(`web/img/models/${name}.png`, encodePNG(W * 3, H * 2, sheet));
    console.log(name, mesh.v.length, 'vertices', mesh.f.length, 'faces');
  }
}
