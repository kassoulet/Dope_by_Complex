/*
 * dope/ports/part4.js -- part 4 of DOPE ("FIRE clouds", "FRACTAL scape", the
 * checker floor), ported from the 1995 machine code.
 *
 * This is a port, not an emulation: the routines of block 4 are rewritten as
 * JavaScript, one function per routine, each named after the block offset it
 * comes from so the two can be read side by side (docs/PORT4.md walks through
 * them).  What the port reads from DOPE.EXE are the same data the demo reads:
 * tables, the warp field, the pictures.  Every routine was checked against the
 * original running in the emulator (tests/test_port4.mjs): same inputs, same
 * outputs, byte for byte.
 *
 * The part in one paragraph.  The screen is two layers packed into one byte.
 * The high nibble is a fire intensity, produced by a feedback filter that every
 * frame blends each pixel towards a value looked up in a scrolling texture
 * (`warp`).  The low nibble is a second layer drawn into a back buffer (the
 * terrain, or a picture).  The 256 colour palette is a 16x16 table: the colour
 * at (fire, terrain) is the saturated sum of one colour ramp indexed by the
 * fire nibble and another indexed by the terrain nibble, and the two ramps
 * cross-fade over time (`ramp`, `mixPalette`), which is how scenes fade into
 * each other without touching a pixel.
 */

export const RELOC = 0xf7b; // the loader adds (part segment - 0x10) to every segment constant
export const seg = (block) => ((block + RELOC) & 0xffff) << 4; // linear base of a segment the code names

// segments the routines use, as they are written in the code (block values)
export const SEG = {
  fire: seg(0x66cd), // 160 x 200 fire intensities, two per 16 bit word
  warp: seg(0x7d9), // 16384 x (u16, u16): per pixel pair offsets into `map`
  map: seg(0x1ec1), // 64 KB texture the warp offsets index
  blend: seg(0x5ecd), // 128 x 128 (stride 256) table: new fire = blend[old][map]
  back: seg(0x4f1e), // 320 x 200 back buffer: the second layer (terrain / picture)
  band: seg(0x469), // 44 rows staged here so the label can be pasted in
};

export const W = 320;
export const H = 200;

// ---------------------------------------------------------------- routines

/**
 * 0x1a75 -- fill a 64 entry colour ramp.  `ax` is an 8.8 fixed point value
 * that starts at `from` and climbs by `step` per entry until it reaches 63.
 * `step` arrives as a 12 bit fade position: negative becomes 0, it is divided
 * by 16 and clamped to 0x100 (one whole unit per entry).
 * Returns the ramp as 64 bytes.
 */
export function ramp(step, out = new Uint8Array(64), from = 0) {
  let dx = step & 0xffff;
  if (dx & 0x8000) dx = 0; // test dx,dx / jns
  dx >>= 4;
  if (dx >= 0x100) dx = 0x100;
  let ax = from;
  for (let i = 0; i < 64; i++) {
    out[i] = ax >> 8;
    if (ax <= 0x3f00) ax += dx; // saturates by not adding once past 63
  }
  return out;
}

/**
 * 0x1a99 -- the 16 x 16 palette.  Entry (hi, lo) is, per colour component, the
 * sum of rampA[p1[lo]] and rampB[p2[hi]] clamped to 63, where p1 and p2 are
 * two 16 colour palettes (48 bytes each) and the ramps are the cross-fading
 * curves.  Only 15 values of `hi` are filled: colours 0xf0..0xff belong to
 * the label's own palette.  Returns 720 bytes for the DAC, index 0 first.
 */
export function mixPalette(p1, p2, rampA, rampB, out = new Uint8Array(720)) {
  let o = 0;
  for (let hi = 0; hi < 15; hi++) {
    for (let lo = 0; lo < 16; lo++) {
      for (let c = 0; c < 3; c++) {
        const v = rampA[p1[lo * 3 + c]] + rampB[p2[hi * 3 + c]];
        out[o++] = v > 63 ? 63 : v;
      }
    }
  }
  return out;
}

/**
 * 0x1fa8 -- the sine table, 0x1200 bytes at cs:0.  The file holds one quarter
 * period (512 words); the first loop copies it backwards after itself, the
 * second negates the first half into the second, the third repeats the start
 * so an index may run past the end.
 */
export function buildSine(quarter) {
  const t = new Int16Array(0x900);
  t.set(quarter.subarray(0, 0x200), 0);
  for (let k = 0; k < 0x200; k++) t[0x3ff - k] = t[k]; // lodsw / stosw / sub di,4
  for (let k = 0; k < 0x400; k++) t[0x400 + k] = -t[k]; // lodsw / neg ax / stosw
  t.copyWithin(0x800, 0, 0x200); // rep movsw
  return t;
}

/** 0x1c36 -- compress the texture: map[i] = min(0x7f, map[i] * 7 / 4) */
export function squashMap(map) {
  for (let i = 0; i < 0x10000; i++) {
    const v = (map[i] * 7) >> 2;
    map[i] = v > 0x7f ? 0x7f : v;
  }
}

/**
 * 0x1c56 -- build the blend table.  blend[old * 256 + m] =
 * min(0x70, (m * k + old * (256 - k) + 63) >> 8): the new fire value is the old
 * one pulled k/256 of the way towards the texture value m (k is 0x18 here, so
 * a pixel moves 9% of the way per frame).
 */
export function buildBlend(blend, k) {
  for (let row = 0, dx = 0; row < 128; row++, dx += 0x100 - k) {
    for (let col = 0, cx = 0; col < 128; col++, cx += k) {
      const v = ((cx + dx + 0x3f) & 0xffff) >> 8;
      blend[row * 256 + col] = v >= 0x70 ? 0x70 : v;
    }
  }
}

/**
 * 0x1bab, first half -- where the texture sits this frame: a sine of the angle
 * (index masked to even, so 11 bits) plus a steady 16.16 drift, in 8.8, as a
 * 16 bit offset added to every warp entry.
 */
export function shiftFor(sine, angle, drift) {
  return (((sine[(angle & 0xffe) >> 1] + drift) | 0) >> 8) & 0xffff;
}

/**
 * 0x1bab, second half (the loop at 0x1c00) -- advance the fire one frame.
 * For each pair of pixels the warp table gives two offsets; the texture is
 * sampled at (offset + shift) and each pixel is replaced by blend[old][sample].
 * The table is walked from its end while the fire is walked from its start.
 */
export function warp(fire, warpTable, map, blend, shift) {
  let di = 0;
  for (let e = 0x3e7f; e >= 0; e--) {
    const o = e * 4;
    const a = blend[(fire[di] << 8) | map[((warpTable[o + 2] | (warpTable[o + 3] << 8)) + shift) & 0xffff]];
    const b = blend[(fire[di + 1] << 8) | map[((warpTable[o] | (warpTable[o + 1] << 8)) + shift) & 0xffff]];
    fire[di++] = a;
    fire[di++] = b;
  }
}

/**
 * 0x1d6b -- one screen row.  Each 16 bit word of fire (two pixels) becomes four
 * screen pixels, each fire value doubled in width; the fire value is doubled,
 * a dither byte is added, only the high nibble is kept (so 16 fire levels from
 * a 0..0x70 value) and the back buffer's four pixels are added on top: the
 * low nibble of the result is the second layer.  The four dither bytes rotate
 * one byte per row, a 4 x 4 ordered dither.  Returns the rotated dither.
 */
function row(fire, back, out, esi, dither, outBase = 0, outIndex = esi) {
  for (let i = 0; i < 80; i++, esi++, outIndex++) {
    const lo = fire[2 * esi], hi = fire[2 * esi + 1];
    const pix = (lo | (lo << 8) | (hi << 16) | (hi << 24)) >>> 0; // al=ah=bl, then bh bh in the top word
    let e = (dither + ((pix << 1) >>> 0)) >>> 0; // lea eax,[edx+eax*2]
    e = (e & 0xf0f0f0f0) >>> 0;
    e = (e + (back[4 * esi] | (back[4 * esi + 1] << 8) | (back[4 * esi + 2] << 16) | (back[4 * esi + 3] << 24))) >>> 0;
    const o = outBase + 4 * outIndex;
    out[o] = e & 0xff;
    out[o + 1] = (e >>> 8) & 0xff;
    out[o + 2] = (e >>> 16) & 0xff;
    out[o + 3] = e >>> 24;
  }
  return ((dither << 8) | (dither >>> 24)) >>> 0; // rol edx,8
}

/**
 * 0x1c91, second half -- the whole picture.  Rows 0..147 and 192..199 go
 * straight to the screen; rows 148..191 are staged in a 44 row buffer so the
 * label (a 70 x 44 sprite, drawn `slide` pixels wide from the right edge) can
 * be pasted over them, then copied to the screen.  `slide` < 0 means no label.
 * `label` is the memory the sprite's segment points at; the sprite is at 0x30a.
 */
export function compose(fire, back, label, slide, out) {
  let dither = 0x01040007;
  let esi = 0;
  for (let r = 0; r < 148; r++, esi += 80) dither = row(fire, back, out, esi, dither);
  esi += 0xdc0; // the band is done separately
  for (let r = 0; r < 8; r++, esi += 80) dither = row(fire, back, out, esi, dither);
  esi -= 0x1040;
  const band = new Uint8Array(44 * 320);
  for (let r = 0; r < 44; r++, esi += 80) dither = row(fire, back, band, esi, dither, 0, r * 80);
  if (slide >= 0) {
    let di = 0x13f - slide;
    const n = slide > 0x46 ? 0x46 : slide;
    let si = 0x30a;
    for (let r = 0; r < 44; r++) {
      for (let k = 0; k < n; k++) band[di + k] = label[si + k];
      si += 0x46;
      di += 0x140;
    }
  }
  out.set(band, 148 * 320);
  return out;
}

// 0x2058: how far apart the terrain rows are: one step each near the viewer, then wider
export const ROW_STEP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  32, 33, 34, 35, 36, 37, 38, 39, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 64, 68, 72, 76, 80, 84, 88, 92, 96, 100];

/**
 * 0x1fe8 -- clear the back buffer to colour 2 (the terrain's "sky").
 */
export function clearBack(back) {
  back.fill(2, 0, 64000);
}

/**
 * 0x1ffc -- draw the terrain into the back buffer: a height field seen from
 * above and behind, with no 3D at all.
 *
 * The map is 256 x 256 bytes, `heights` (and `colours` the same shape).  A row
 * of the picture is a row of the map at one distance `d`; rows are drawn from
 * the far one to the near one.  For each of the 319 columns the map is sampled
 * along the row with 16.16 fixed point steps and linear interpolation, the
 * height is scaled by a distance dependent factor and subtracted from the
 * row's screen baseline, giving the height of the hill on screen (`top`).
 * Whatever lies between that and the highest point drawn so far in that
 * column (`ycol`, kept between frames) is painted with the colour at that map
 * position: the classic "voxel space" occlusion, with a 0x8000 / d
 * perspective and one division per row.
 *
 * `t` is the scroll position, `camX` the sideways position.  `ycol` (320
 * words) is the occlusion buffer, `ccol` (320 words) receives the
 * interpolated colour of the columns that were not drawn (the original
 * computes it and never reads it again; kept so the memory matches).
 */
export function terrain(back, t, camX, heights, colours, ycol, ccol) {
  const S16 = (v) => (v << 16) >> 16;
  for (let v = 0x6e; v !== 0; v -= 2) {
    let si = (ROW_STEP[v >> 1] << 4) & 0xffff;
    si = (si + (~t & 0xf)) & 0xffff; // the distance, with the sub-row scroll in the low 4 bits
    const y0 = v === 2 ? 0x6400 : ((0x8000 / si) | 0) + 0x48; // screen baseline of this row
    const scale = v === 2 ? 0 : (0xaaaa / si) | 0; // height to pixels
    const step = ((si << 5) >>> 0); // map step per column, 16.16 (the dword at cs:0x211d)
    const stepLo = step & 0xffff, stepHi = (step >>> 16) & 0xff;
    let ecx = ((camX << 12) - ((step << 7) >>> 0)) | 0;
    let bl = (ecx >>> 16) & 0xff; // map x
    let bh = (((t << 5) & 0xffff) >> 8); // map z...
    bh = (bh + ((si >> 5) & 0xff)) & 0xff; // ... plus the row's distance
    let cx = (ecx & 0xffff) >> 1; // fractional x
    for (let col = 0, s = 0x27e; s !== 0; col++, s -= 2) {
      const sum = ((cx * 2) & 0xffff) + stepLo;
      cx = (sum & 0xffff) >> 1;
      bl = (bl + stepHi + (sum > 0xffff ? 1 : 0)) & 0xff;
      const bx = (bh << 8) | bl;
      const h0 = heights[bx], h1 = heights[(bx + 1) & 0xffff];
      let ax = ((((h1 - h0) * S16(cx)) >> 7) & 0xffff); // imul cx / shrd ax,dx,7: linear interpolation
      ax = (ax & 0xff) | ((((ax >> 8) + h0) & 0xff) << 8);
      const dxHi = (ax * scale) >>> 16; // mul word [0x211b], the high word
      let di = (y0 - dxHi) & 0xffff;
      if (di & 0x8000) di = 0xffff; // above the screen
      if (S16(di) >= 0xc8) di = 0xc7; // below it
      const prev = ycol[s >> 1];
      ycol[s >> 1] = di;
      const bp = (prev - di) & 0xffff;
      if (bp & 0x8000) {
        // this row's hill is lower on screen than the last one: paint the strip in between
        let d = (((di * 5) << 6) + col) & 0xffff;
        const c = colours[bx];
        for (let n = (-bp) & 0xffff; n > 0; n--) { back[d] = c; d = (d - 0x140) & 0xffff; }
      } else {
        const cd = S16(((colours[(bx + 1) & 0xffff] - colours[bx]) << 24) >> 24 & 0xffff);
        let a = ((cd * ((cx >> 8) & 0xff)) & 0xffff) * 2 & 0xffff;
        a = (a & 0xff) | ((((a >> 8) + colours[bx]) & 0xff) << 8);
        ccol[s >> 1] = a;
      }
    }
  }
}

/**
 * 0x15f3 -- read the checker picture: an IFF ILBM file stored in the block.
 * Scans (word by word, at most 5000 words) for the chunk 'CMAP' and takes its
 * 768 palette bytes (8 bit, shifted down to the DAC's 6), then for 'BODY' and
 * unpacks its ByteRun1 data into 64000 pixels: a non-negative byte n copies the
 * next n+1 bytes, a negative one repeats the next byte 1-n times.
 * Returns { pal, pixels } or null when a chunk is missing.
 */
export function decodeILBM(src, start = 0) {
  const w = (i) => src[i] | (src[i + 1] << 8);
  let si = start, found = false;
  for (let n = 0x1388; n > 0; n--, si += 2) {
    if (w(si) === 0x4d43) { si += 2; found = true; break; } // 'CM'
  }
  if (!found || w(si) !== 0x5041) return null; // 'AP'
  si += 2 + 4; // past 'AP' and the chunk length
  const pal = new Uint8Array(768);
  for (let i = 0; i < 768; i++) pal[i] = src[si + i] >> 2;
  let at = start;
  for (let n = 0x1388; n > 0; n--, at += 2) if (w(at) === 0x4f42) break; // 'BO'
  if (w(at + 2) !== 0x5944) return null; // 'DY'
  si = at + 8;
  const pixels = new Uint8Array(64000);
  let di = 0, dx = 0;
  while (dx < 0xfa00) {
    let al = src[si++];
    if (al < 0x80) { // literal run
      const cx = al + 1;
      dx += cx;
      for (let k = 0; k < cx; k++) pixels[di++] = src[si++];
    } else { // repeat run
      const cx = ((-al) & 0xff) + 1;
      dx += cx;
      const v = src[si++];
      for (let k = 0; k < cx; k++) pixels[di++] = v;
    }
  }
  return { pal, pixels };
}

// ------------------------------------------------------------------- the part

const CS = 0xf8b0; // linear address of the part's segment, where the loader puts block 4

/** The length of each stage of the script, in timer ticks (the thresholds the main loop compares). */
export const STAGES = [
  { name: 'fire, label hidden', until: 0x578 },
  { name: 'fire, "FIRE clouds" label slides in', until: 0xb46 },
  { name: 'fire, label slides out', until: 0x500 },
  { name: 'terrain appears ("FRACTAL scape" soon)', until: 0x41a },
  { name: 'terrain, "FRACTAL scape" label', until: 0x6d6 },
  { name: 'terrain fades out', until: 0x1ea },
  { name: 'checker picture', until: 0x400 },
];

/**
 * The whole part.  `image` is the memory as the loader leaves it (block 4 at
 * segment 0xf8b, relocated); `screen` and `pal` are what the part before it
 * left on the card (the first frame is drawn over them and the first 16 colours
 * are the base of the palette mix).
 *
 * Drive it with tick() (the 70 Hz interrupt: the animation) and frame() (one
 * pass of the main loop: draw, then look at the script).  The original runs
 * both as fast as the machine allows; tick() decides how fast things move,
 * frame() how many pictures there are.
 */
export class Part4 {
  constructor(image, { screen = null, pal = null } = {}) {
    const u16 = (o) => image[CS + o] | (image[CS + o + 1] << 8);
    this.image = image;
    // --- read only data, taken from the block like the original takes it
    const quarter = new Int16Array(0x200);
    for (let i = 0; i < 0x200; i++) quarter[i] = (u16(2 * i) << 16) >> 16;
    this.sine = buildSine(quarter);
    this.warpTable = image.subarray(SEG.warp, SEG.warp + 0x10000);
    this.map = image.slice(SEG.map, SEG.map + 0x10000);
    squashMap(this.map);
    this.blend = new Uint8Array(0x10000);
    buildBlend(this.blend, 0x18);
    const view = (segWord, len) => image.subarray((segWord << 4), (segWord << 4) + len);
    this.labels = [view(u16(0x196b), 0x30a + 0x46 * 44), view(((0x36e + RELOC) & 0xffff), 0x30a + 0x46 * 44)];
    this.heights = view(u16(0x210d), 0x10000);
    this.colours = view(u16(0x210f), 0x10000);
    this.picture = image.subarray(seg(0x177a), seg(0x177a) + 0x10000);
    this.p2 = image.slice(CS + 0x15ae, CS + 0x15ae + 48); // the fire's 16 colours
    this.labelPal = image.slice((u16(0x196b) << 4) + 0x2da, (u16(0x196b) << 4) + 0x2da + 48); // colours 0xf0..0xff: the label's own palette
    this.terrainPal = image.slice(CS + 0x20d2, CS + 0x20d2 + 48); // the terrain's 16 colours
    // --- state: the variables of the original, with the address they live at
    this.speed = u16(0x1576); // 0x1576 angle step per two ticks
    this.angle = 0; // 0x1578
    this.drift = 0; // 0x157a (16.16: falls by one per two ticks)
    this.lastShift = 0; // 0x1b0b
    this.isrTicks = 0; // 0x141e
    this.scroll = 0; // 0x2113 terrain scroll, +2 per tick
    this.camX = u16(0x2111); // 0x2111
    this.phase = 0; // 0x1969 ticks since the stage began
    this.labPos = -1; // 0x196d label width shown (-1: hidden)
    this.labVel = 0; // 0x196f
    this.fade = 0; // 0x1971 cross fade between the two ramps, 0..0x1000
    this.fadeVel = 1; // 0x1973
    this.fadeMin = 0; // 0x1a59 (an immediate in the original's code)
    this.fadeMax = 0x1000; // 0x1a62
    this.label = this.labels[0];
    this.stage = 0;
    this.done = false;
    this.ticks = 0;
    // --- buffers
    this.fire = new Uint8Array(32000); // 0x66cd
    this.back = new Uint8Array(64000); // 0x4f1e
    if (screen) this.back.set(screen);
    // the occlusion buffer starts as whatever the file holds there (not zero)
    this.ycol = new Uint16Array(320); // 0x2121
    this.ccol = new Uint16Array(320); // 0x23a1
    for (let i = 0; i < 320; i++) { this.ycol[i] = u16(0x2121 + 2 * i); this.ccol[i] = u16(0x23a1 + 2 * i); }
    this.vram = new Uint8Array(64000);
    // --- palette: p1 is what the card showed for colours 0..15 before this part
    this.p1 = new Uint8Array(48);
    if (pal) this.p1.set(pal.subarray(0, 48));
    this.rampA = new Uint8Array(64);
    this.rampB = new Uint8Array(64);
    this.dac = new Uint8Array(768);
    this.dac.set(this.labelPal, 0xf0 * 3);
    if (pal) this.dac.set(pal.subarray(0, 0xf0 * 3), 0);
  }

  /** 0x1b20 behind the interrupt handler: everything that moves with time. */
  tick() {
    this.isrTicks = (this.isrTicks + 1) & 0xffff; // 0x152d
    this.ticks++;
    this.scroll = (this.scroll + 2) & 0xffff;
    this.phase = (this.phase + 1) & 0xffff;
    // the label's slide: stops itself at either end
    this.labPos = (this.labPos + this.labVel) << 16 >> 16;
    if (this.labPos < 0 || this.labPos >= 0x4b) this.labVel = 0;
    // the cross fade, with limits the script patches into the code
    this.fade = (this.fade + this.fadeVel) & 0xffff;
    if (((this.fade << 16) >> 16) < ((this.fadeMin << 16) >> 16) || this.fade >= this.fadeMax) this.fadeVel = 0;
    if (this.isrTicks & 1) { // every other tick
      this.drift = (this.drift - 0x10000) | 0;
      this.angle = (this.angle + this.speed) & 0xffff;
      ramp(0x1000 - this.fade, this.rampA);
      ramp(this.fade, this.rampB);
      this.dac.set(mixPalette(this.p1, this.p2, this.rampA, this.rampB), 0);
    }
  }

  /** One pass of the main loop: draw, then the script's comparisons. */
  frame() {
    this.draw();
    this.script();
    return this.vram;
  }

  /** 0x1c91 with what comes before it in the loops that draw the terrain. */
  draw() {
    this.update();
    return this.render();
  }

  /** The state half of a frame: the terrain (stages 3..5) and the fire step. */
  update() {
    if (this.stage >= 3 && this.stage <= 5) {
      clearBack(this.back);
      terrain(this.back, this.scroll, this.camX, this.heights, this.colours, this.ycol, this.ccol);
    }
    const shift = shiftFor(this.sine, this.angle, this.drift);
    if (shift !== this.lastShift) {
      this.lastShift = shift;
      warp(this.fire, this.warpTable, this.map, this.blend, shift);
    }
  }

  /** The picture half: the fire, the back buffer and the label, dithered into 320 x 200. */
  render() {
    compose(this.fire, this.back, this.label, this.labPos, this.vram);
    return this.vram;
  }

  /**
   * Run the part up to timer tick `tick`, with a frame every second tick (what
   * a machine fast enough to keep up would do: the original draws as fast as it
   * can, so the fire's smoothness is the machine's, not the demo's).  Nothing is
   * drawn; call render() for the picture.
   */
  advanceTo(tick) {
    while (this.ticks < tick && !this.done) {
      this.tick();
      if ((this.ticks & 1) === 0) { this.update(); this.script(); }
    }
  }

  /** The main loop's comparisons, 0x1e19..0x1f81, run after every frame. */
  script() {
    const s = this.stage;
    if (this.done || this.phase < STAGES[s].until) return;
    switch (s) {
      case 0: this.labVel = 1; this.speed = 0x1f; break;
      case 1: this.labVel = -1; this.speed = 0x1d; this.phase = 0; break;
      case 2: this.fadeVel = -2; this.fadeMin = 0x600; this.phase = 0; this.speed = 0x1b; this.p1.set(this.terrainPal); break;
      case 3: this.speed = 0x19; this.label = this.labels[1]; this.labVel = 1; break;
      case 4: this.speed = 0x17; this.labVel = -1; this.fadeVel = 5; this.fadeMin = 0; this.fadeMax = 0x1000; this.phase = 0; break;
      case 5: {
        this.fadeVel = -4; this.phase = 0; this.fade = 0x1000;
        const pic = decodeILBM(this.picture, 0);
        this.back.set(pic.pixels);
        this.p1.set(pic.pal.subarray(0, 48));
        break;
      }
      default: // 0x1f81: the last picture is the back layer alone, straight to the screen
        this.done = true;
        this.vram.set(this.back);
        return;
    }
    this.stage++;
  }
}
