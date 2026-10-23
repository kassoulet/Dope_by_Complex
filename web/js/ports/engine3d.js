/*
 * dope/ports/engine3d.js -- the 3D engine shared by parts 2, 3, 5, 6 and 7 of
 * DOPE, ported from the machine code of block 3.
 *
 * It is a classic small software pipeline, all fixed point, all integer:
 *
 *   rotationMatrix   three angles -> a 3x3 matrix (15 bit)
 *   transformObject  every vertex: rotate, translate, project to the screen;
 *                    the vertex NORMAL is rotated too and kept as an
 *                    environment-map coordinate (this is "phong" here)
 *   buildFaces       cull back faces, give every visible face a depth key
 *   radixSort        sort the faces by that key, 11 passes of a two ended
 *                    partition
 *   (rasteriser)     draw the sorted triangles back to front
 *
 * The data live in one 64 KB segment (`gs` in the original) at fixed
 * offsets; the port keeps that layout so a test can compare the whole segment
 * with the original's byte for byte.  Offsets, from the original:
 *
 *   0x0000  face list: dword (depth << 16) | slot, ends with 0xffffffff
 *   0x0fa0  scratch for the radix sort (1000 entries: the part's hard limit)
 *   0x1f40  per vertex dword: the normal's x,y (15 bit) -- texture coordinate
 *   0x2ee0  per vertex dword: rotated normal x,y + 0x4000 each
 *   0x3e80  per vertex: y word, x word (screen, 320 x 200)
 *   0x4e20  per vertex: z word (depth, 0x4000 + ...)
 *   0x5dc0  per face word: vertex 0 (offset in dwords * 4), 0x6590: vertex 1,
 *   0x6d60: vertex 2; their low two bits carry the face's texture selectors
 *
 * Functions are named after the block 3 offset they come from.
 */

/** the 12 bit angle -> byte offset the original uses: even, masked to 0xffe */
const idx = (a) => (a & 0xffe) >> 1;

/**
 * 0x1ef6 -- the rotation matrix from three angles.  `sin` is the 2048 entry
 * table (cs:0x410, 15 bit, period 2048: the original builds it from a quarter
 * of a sine, see buildSine); cosine is the same table a quarter period later
 * (cs:0x810).  Writes 9 dwords, in the order the original stores them at
 * cs:0x1dcc..0x1dec, and returns the 6 intermediates (0x1db4..0x1dc8) too.
 */
export function rotationMatrix(sin, a0, a1, a2) {
  const S = (a) => sin[idx(a)], C = (a) => sin[idx(a) + 0x200];
  const sa = S(a0), ca = C(a0), sb = S(a1), cb = C(a1), sc = S(a2), cc = C(a2);
  const m = new Int32Array(9);
  const imul = Math.imul;
  m[0] = (imul(cb, cc) - imul(imul(sb, sa) >> 15, sc)) >> 15; // 0x1dcc
  m[1] = imul(ca, sc) >> 15; // 0x1dd0
  m[2] = (imul(sb, cc) + imul(imul(cb, sa) >> 15, sc)) >> 15; // 0x1dd4
  m[3] = -(imul(cb, sc) + imul(imul(sb, sa) >> 15, cc)) >> 15; // 0x1dd8
  m[4] = imul(ca, cc) >> 15; // 0x1ddc
  m[5] = -(imul(sb, sc) - imul(imul(cb, sa) >> 15, cc)) >> 15; // 0x1de0
  m[6] = imul(-sb, ca) >> 15; // 0x1de4
  m[7] = -sa; // 0x1de8
  m[8] = imul(cb, ca) >> 15; // 0x1dec
  return m;
}

/**
 * 0x1fa8-style sine table: the block holds one quarter period (512 words) at
 * `quarter`; the table is that, then the quarter mirrored backwards, then both
 * negated, then the first quarter again (so an index may run past the end).
 * Result: Int16Array(0xa00 words), word k at byte 2k from the table start.
 */
export function buildSine(quarter) {
  const t = new Int16Array(0xa00);
  t.set(quarter.subarray(0, 0x200), 0);
  for (let k = 0; k < 0x200; k++) t[0x3ff - k] = t[k]; // lodsw / stosw / sub di,4
  for (let k = 0; k < 0x400; k++) t[0x400 + k] = -t[k]; // lodsw / neg / stosw
  t.copyWithin(0x800, 0, 0x200); // rep movsw
  return t;
}

// ---------------------------------------------------------------------------
// the segment the engine's arrays live in

export const OFF = {
  list: 0x0000, scratch: 0x0fa0, tex: 0x1f40, env: 0x2ee0, sy: 0x3e80, sx: 0x3e82, sz: 0x4e20,
  f0: 0x5dc0, f1: 0x6590, f2: 0x6d60,
};
/** The same engine in block 7: other limits (2,000 faces), other offsets, same code. */
export const OFF7 = {
  list: 0x0000, scratch: 0x1f40, tex: 0x3e80, env: 0x55f0, sy: 0x6d60, sx: 0x6d62, sz: 0x84d0,
  f0: 0x9c40, f1: 0xabe0, f2: 0xbb80,
};
export const MAX_FACES = 1000;
export const MAX_VERTS = 1000;

/** word / dword access on a plain byte array (what the original does with fs: and gs:) */
const rd16 = (a, o) => a[o] | (a[o + 1] << 8);
const rds16 = (a, o) => (rd16(a, o) << 16) >> 16;
const wr16 = (a, o, v) => { a[o] = v & 0xff; a[o + 1] = (v >> 8) & 0xff; };
const wr32 = (a, o, v) => { a[o] = v & 0xff; a[o + 1] = (v >> 8) & 0xff; a[o + 2] = (v >> 16) & 0xff; a[o + 3] = (v >>> 24) & 0xff; };
const rd32 = (a, o) => (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) | 0;

/** trunc(a * b / d) for 32 bit a, b, d, exactly (the original's imul / idiv ebp pair) */
export function mulDiv(a, b, d) {
  const p = a * b;
  if (Math.abs(p) < 2 ** 52) {
    let q = Math.trunc(p / d);
    const r = p - q * d; // exact below 2^53
    if (r !== 0 && (r < 0) !== (p < 0)) q += (r < 0) === (d < 0) ? 1 : -1;
    else if (Math.abs(r) >= Math.abs(d)) q += (r < 0) === (d < 0) ? -1 : 1;
    return q | 0;
  }
  return Number(BigInt(a) * BigInt(b) / BigInt(d)) | 0;
}

/**
 * 0x1dd0 with 0x1cb0 -- transform, light and project every vertex of an
 * object into the shared arrays.
 *
 * `geo` is the object's own segment: word 0 the vertex count, 4 the offset of
 * the vertex positions (3 words each), 8 the offset of the vertex normals (3
 * words each).  `o` is the object as the frame routine prepared it:
 *   base       index of its first vertex in the shared arrays (cs:0x19a2)
 *   offset     the vertex centre offset, 3 dwords  (cs:0x196c, 0x1970, 0x1974)
 *   pos        the object position, 3 dwords       (cs:0x1982, 0x1986, 0x198a)
 *   focal      the projection scale                (cs:0x198e)
 *
 * Per vertex it stores: the normal's x and y, halved and kept to 15 bit (a
 * texture coordinate, `tex`); the rotated normal's x and y, each shifted to
 * the top of a word and centred on 0x4000 (`env`: the coordinates the phong
 * lookup uses); the depth word `z`; and the screen position, a perspective
 * divide per axis, 8 columns and 5/32 rows per unit, so the picture is
 * 3/4 as tall as it is wide in these units: a 4:3 screen on 320 x 200 pixels
 * (the `adc ax,0xa0` / `adc ax,0x64` add the centre and round at once).
 */
export function transformObject(gs, geo, M, o, L = OFF) {
  const nv = rd16(geo, 0);
  if (nv === 0) return;
  const posAt = rd16(geo, 4), nrmAt = rd16(geo, 8);
  const [cx0, cy0, cz0] = o.offset;
  const imul = Math.imul;
  for (let v = 0; v < nv; v++) {
    const slot = 4 * (o.base + v);
    // the normal (0x1cb0)
    const n = nrmAt + 6 * v;
    const nx = rds16(geo, n), ny = rds16(geo, n + 2), nz = rds16(geo, n + 4);
    const half = (x) => ((((x << 1) & 0xffff) << 16) >> 16) >> 1; // shl 1, then sar ax,1 on the low word
    const tex = ((half(ny) & 0xffff) << 16) | (half(nx) & 0xffff);
    const ex = (imul(nx, M[0]) + imul(ny, M[1]) + imul(nz, M[2])) | 0;
    const ey = (imul(nx, M[3]) + imul(ny, M[4]) + imul(nz, M[5])) | 0;
    const env = ((ex & 0xffff0000) | ((ey >>> 16) & 0xffff)) + 0x40004000 | 0;
    // the position
    const p = posAt + 6 * v;
    const px = rds16(geo, p) + cx0, py = rds16(geo, p + 2) + cy0, pz = rds16(geo, p + 4) + cz0;
    let X = (imul(M[0], px) + imul(M[1], py) + imul(M[2], pz)) | 0;
    let Y = (imul(M[3], px) + imul(M[4], py) + imul(M[5], pz)) | 0;
    const Z = (imul(M[6], px) + imul(M[7], py) + imul(M[8], pz)) | 0;
    wr32(gs, L.env + slot, env);
    wr32(gs, L.tex + slot, tex);
    X = (X + (o.pos[0] << 8)) | 0;
    Y = (Y + (o.pos[1] << 8)) | 0;
    wr16(gs, L.sz + slot, (((imul(Z >> 16, o.focal) >> 14) + 0x4000) & 0xffff));
    const depth = (Z - (o.pos[2] << 8)) | 0;
    // x: (X * focal / depth) >> 3, plus the bit shifted out (adc), plus the centre 0xa0
    let q = mulDiv(X, o.focal, depth);
    wr16(gs, L.sx + slot, ((q >> 3) + ((q >> 2) & 1) + 0xa0) & 0xffff);
    // y: (3 * (Y * focal / depth)) >> 5, rounded the same way, centre 0x64
    q = mulDiv(Y, o.focal, depth);
    q = (q + q * 2) | 0;
    wr16(gs, L.sy + slot, ((q >> 5) + ((q >> 4) & 1) + 0x64) & 0xffff);
  }
}

/**
 * 0x2987 -- the faces of one object: keep the ones that face the viewer, give
 * each a depth key, and append them to the face list.
 *
 * `geo` word 2 is the face count, word 6 the offset of the faces: 8 bytes each,
 * an attribute word and three vertex offsets (index * 4).  A face is visible
 * when the 16 bit cross product of two screen space edges has the right sign
 * (`o.cull` flips which: the object's own faces point inwards or outwards).
 * The list entry is (sum of the three depth words) << 16 | its slot number.
 * The low two bits of vertices 1 and 2 are free (offsets are multiples of 4)
 * and carry two 2 bit selectors made from the attribute bytes plus the object's
 * own phase (`o.selA`, `o.selB`): which of four textures the triangle uses.
 *
 * `o` in: base (vertex index of the object's first vertex), count (faces so far),
 * cull, selA, selB.  `o.count` and `o.base` are advanced.
 */
export function buildFaces(gs, geo, o, L = OFF) {
  const nf = rd16(geo, 2);
  if (nf === 0) return;
  const facesAt = rd16(geo, 6);
  const dx = (o.base << 2) & 0xffff;
  let si = o.count << 2, bp = o.count << 1;
  const x = (v) => rds16(gs, L.sx + v), y = (v) => rds16(gs, L.sy + v);
  for (let i = 0; i < nf; i++) {
    const f = facesAt + 8 * i;
    const v0 = (rd16(geo, f + 2) + dx) & 0xffff, v1 = (rd16(geo, f + 4) + dx) & 0xffff, v2 = (rd16(geo, f + 6) + dx) & 0xffff;
    let cx = (x(v2) - x(v0)) & 0xffff;
    cx = Math.imul(cx << 16 >> 16, (y(v1) - y(v0)) << 16 >> 16) & 0xffff; // imul cx,dx (16 bit)
    let ax = Math.imul((x(v1) - x(v0)) << 16 >> 16, (y(v2) - y(v0)) << 16 >> 16) & 0xffff;
    ax = (ax - cx) & 0xffff;
    const negative = (ax & 0x8000) !== 0;
    if (o.cull === 0 ? negative : !negative) continue;
    const z = (rd16(gs, L.sz + v0) + rd16(gs, L.sz + v1) + rd16(gs, L.sz + v2)) & 0xffff;
    const attr = rd16(geo, f);
    wr16(gs, L.f0 + bp, v0);
    wr16(gs, L.f1 + bp, v1 | (((attr >> 8) + o.selB) & 3));
    wr16(gs, L.f2 + bp, v2 | ((attr + o.selA) & 3));
    wr32(gs, L.list + si, ((z << 16) | (si >> 2)) | 0);
    si += 4;
    bp += 2;
  }
  o.count = bp >> 1;
  o.base = (o.base + rd16(geo, 0)) & 0xffff;
}

/**
 * 0x2b95 -- sort the face list by its depth key: an LSD radix sort on bits
 * 21..31 of each entry (the top 11 bits of the depth word), one pass per bit.
 * A pass walks the list once and puts the entries whose bit is clear at the
 * front of a scratch area growing up and the others at its end growing down,
 * then copies the first group back and the second after it, in the order they
 * arrived: a stable partition with no counters, ended by a negative low word.
 * (The scratch area starts 1000 entries in: the engine's hard limit.)
 */
export function radixSort(gs, count, L = OFF) {
  let end = L.scratch + 4 * count; // [0x1978]: where the "bit set" side starts
  for (let k = 21; k < 32; k++) {
    const bit = (1 << k) >>> 0;
    let di = L.scratch, bx = end, si = 0;
    for (;;) {
      const e = rd32(gs, si);
      if ((e & 0xffff) >= 0x8000) break; // the terminator: the low word is negative
      si += 4;
      if (((e >>> 0) & bit) === 0) { wr32(gs, di, e); di += 4; } else { wr32(gs, bx, e); bx -= 4; }
    }
    wr16(gs, di, 0xffff); // mov word [di],0xffff
    si = 0;
    for (let s = L.scratch; ; s += 4) { // the low side
      const e = rd32(gs, s);
      if ((e & 0xffff) >= 0x8000) break;
      wr32(gs, si, e); si += 4;
    }
    for (let b = end; ; b -= 4) { // the high side, in arrival order
      const e = rd32(gs, b);
      if ((e & 0xffff) >= 0x8000) break;
      wr32(gs, si, e); si += 4;
    }
    wr16(gs, si, 0xffff);
  }
}
