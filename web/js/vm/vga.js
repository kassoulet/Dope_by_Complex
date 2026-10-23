/*
 * dope/vga.js -- the part of an S3/VGA that mode 13h code touches.
 *
 * The parts set 320x200 256 colour mode and then repaint it through the
 * sequencer: part 1 unpacks its picture one **plane** at a time (map mask
 * 3C4/3C5 index 2 = 0x11, 0x22, 0x44, 0x88 on four successive passes).  CPU
 * writes to A0000 therefore go through `writeVideo()` below, which applies the
 * map mask instead of storing bytes flat.  What is modelled is the display
 * pipeline around the framebuffer, which the parts also use on purpose:
 *
 *   - the DAC (3C8/3C9), six bit per component, reloaded every timer tick;
 *   - the CRTC start address (0C/0D) and scanline offset (13) as a smooth
 *     horizontal scroll, counted in **plane bytes** (see below);
 *   - the attribute controller's pixel panning register (index 13), which
 *     shifts the display left by `value / 2 - 1` pixels;
 *   - the scan-out, which assembles four pixels per plane byte.
 *
 * Memory is a 4-plane 256 KB picture, `pixels` below, addressed as in chain 4:
 * pixel `4n+p` is byte `n` of plane `p`.  That is how the card reads it out --
 * four pixels per plane byte -- and it is why the four map-mask passes of the
 * unpack (`0x11`, `0x22`, `0x44`, `0x88`) lay an 8 bit picture down in the
 * planes: pass `p` fills plane `p`, so the display sees a byte per pixel.
 *
 * All of the register units above are measured against the reference frames,
 * not assumed: `tools/framediff.py` reaches zero differing pixels for
 * `build/ref/ref_0000..0002.png` and for the snapshot's own screen.  The
 * CRTC start and offset count plane bytes (not display bytes); at the 168 word
 * offset part 1 programs that is a 336 plane byte / 1344 pixel line, and the
 * unpack's 336 byte row pitch is exactly that.
 *
 * The vertical retrace bit of the input status register (3DA) is driven by
 * `clock`, supplied by the machine so that retrace waits terminate exactly as
 * they do on the real card.
 */

export const SCREEN_W = 320;
export const SCREEN_H = 200;

// One 70 Hz frame in machine ticks, and the vertical retrace window inside it.
export const FRAME_TICKS = 17045;
export const RETRACE_TICKS = 1670;

export class VGA {
  constructor(mem, base = 0xa0000) {
    this.mem = mem;
    this.base = base;
    this.clock = 0;
    this.mode = 0x03;
    this.crtc = new Uint8Array(0x20);
    this.seq = new Uint8Array(8);
    this.gfx = new Uint8Array(16);
    this.attr = new Uint8Array(0x20);
    this.pal = new Uint8Array(768);
    // The picture memory: four 64 KB planes, flattened the way the CRTC scans
    // them out -- pixel 4n+p is plane p byte n, i.e. four pixels per plane byte.
    // Part 1's picture is 195 rows of 336 plane bytes (200 KB of pixels), so a
    // 64 KB window is not enough: the whole 256 KB has to be there.
    this.pixels = new Uint8Array(0x40000);
    this.dacIndex = 0;
    this.dacPos = 0;
    this.dacReadIndex = 0;
    this.dacReadPos = 0;
    this.crtcIndex = 0;
    this.seqIndex = 0;
    this.gfxIndex = 0;
    this.attrIndex = 0;
    this.attrFlip = 0;
    this.misc = 0;
    // How the card is modelled, for the tools to measure against the reference
    // frames: 'auto' follows the sequencer, 'planar'/'chain4' force one host
    // write layout, 'bytes' and 'nopan' switch off the four-pixels-per-byte
    // scan-out and the panning shift respectively.
    this.layout = 'auto';
    this.chain4Override = false;
    this.fastRetrace = false;
    this.retraceFlip = 0;
    this.setMode(0x03);
  }

  setMode(mode) {
    this.mode = mode & 0xff;
    if (this.mode === 0x13) {
      this.crtc.fill(0);
      this.attr.fill(0);
      this.pal.fill(0);
      this.crtc[0x11] = 0x0c;   // vertical retrace end
      this.crtc[0x13] = 0x28;   // 40 words = 80 bytes per scanline
      this.crtc[0x14] = 0x00;
      this.crtc[0x17] = 0xa3;   // word addressing, byte/word select
      this.seq[2] = 0x0f;       // map mask: all four planes
      this.seq[4] = 0x0e;       // chain 4, odd/even, extended memory
      this.pixels.fill(0);
      this.defaultPalette();
      this.mem.fill(0, this.base, this.base + SCREEN_W * SCREEN_H);
      this.dacIndex = 0;
      this.dacPos = 0;
    }
  }

  // The BIOS fills the DAC when it sets mode 13h.  Entries the parts never
  // write keep these values, so they have to be right too: the reference
  // frames show colours from indices above 0x3f, which only this table has.
  defaultPalette() {
    const ega = [
      0x00, 0x00, 0x00, 0x00, 0x00, 0x2a, 0x00, 0x2a, 0x00, 0x00, 0x2a, 0x2a,
      0x2a, 0x00, 0x00, 0x2a, 0x00, 0x2a, 0x2a, 0x15, 0x00, 0x2a, 0x2a, 0x2a,
      0x15, 0x15, 0x15, 0x15, 0x15, 0x3f, 0x15, 0x3f, 0x15, 0x15, 0x3f, 0x3f,
      0x3f, 0x15, 0x15, 0x3f, 0x15, 0x3f, 0x3f, 0x3f, 0x15, 0x3f, 0x3f, 0x3f,
    ];
    const grey = [0x00, 0x05, 0x08, 0x0b, 0x0e, 0x11, 0x14, 0x18,
      0x1c, 0x20, 0x24, 0x28, 0x2d, 0x32, 0x38, 0x3f];
    const levels = [0x00, 0x10, 0x20, 0x28, 0x30, 0x38];
    const pal = this.pal;
    pal.set(ega, 0);
    for (let i = 0; i < 16; i++) {
      pal[48 + i * 3] = grey[i];
      pal[48 + i * 3 + 1] = grey[i];
      pal[48 + i * 3 + 2] = grey[i];
    }
    for (let i = 0; i < 216; i++) {
      const o = (32 + i) * 3;
      pal[o] = levels[(i / 36) | 0];
      pal[o + 1] = levels[((i / 6) | 0) % 6];
      pal[o + 2] = levels[i % 6];
    }
    for (let i = 0; i < 8; i++) {
      const v = i === 7 ? 0x3f : i * 8;
      const o = (248 + i) * 3;
      pal[o] = pal[o + 1] = pal[o + 2] = v;
    }
    this.dacIndex = 0;
    this.dacPos = 0;
  }

  // ------------------------------------------------------------------- ports

  in8(port) {
    switch (port) {
      case 0x3c0: return this.attrFlip ? this.attr[this.attrIndex] : this.attrIndex;
      case 0x3c1:
        this.attrFlip = 0;
        return this.attr[this.attrIndex];
      case 0x3c2: return this.misc;
      case 0x3c4: return this.seqIndex;
      case 0x3c5: return this.seq[this.seqIndex & 7];
      case 0x3c6: return 0xff;
      case 0x3c7: return this.dacReadIndex;
      case 0x3c8: return this.dacIndex;
      case 0x3c9: {
        const v = this.pal[(this.dacReadIndex * 3 + this.dacReadPos) % 768];
        this.dacReadPos = (this.dacReadPos + 1) % 3;
        if (this.dacReadPos === 0) this.dacReadIndex = (this.dacReadIndex + 1) & 0xff;
        return v;
      }
      case 0x3ce: return this.gfxIndex;
      case 0x3cf: return this.gfx[this.gfxIndex & 15];
      case 0x3d4: case 0x3b4: return this.crtcIndex;
      case 0x3d5: case 0x3b5: return this.crtc[this.crtcIndex & 0x1f];
      case 0x3da: case 0x3ba: {
        // Input status 1: bit 3 is the vertical retrace, bit 0 the display
        // enable (inverted).  Reading it also resets the attribute flip flop.
        this.attrFlip = 0;
        if (this.fastRetrace) { // every read flips: retrace waits end at once (player mode)
          this.retraceFlip ^= 1;
          return this.retraceFlip ? 0x09 : 0x00;
        }
        const t = this.clock % FRAME_TICKS;
        let v = 0;
        if (t >= FRAME_TICKS - RETRACE_TICKS) v |= 0x09;
        else if (t < 480) v |= 0x01;
        return v;
      }
      default:
        return 0xff;
    }
  }

  out8(port, value) {
    const v = value & 0xff;
    switch (port) {
      case 0x3c0:
        if (this.attrFlip === 0) {
          this.attrIndex = v & 0x1f;
          this.attrFlip = 1;
        } else {
          this.attr[this.attrIndex] = v;
          this.attrFlip = 0;
        }
        return;
      case 0x3c2:
        this.misc = v;
        return;
      case 0x3c4:
        this.seqIndex = v & 7;
        return;
      case 0x3c5:
        this.seq[this.seqIndex & 7] = v;
        return;
      case 0x3c7:
        this.dacReadIndex = v;
        this.dacReadPos = 0;
        return;
      case 0x3c8:
        this.dacIndex = v;
        this.dacPos = 0;
        return;
      case 0x3c9:
        this.pal[(this.dacIndex * 3 + this.dacPos) % 768] = v & 0x3f;
        this.dacPos = (this.dacPos + 1) % 3;
        if (this.dacPos === 0) this.dacIndex = (this.dacIndex + 1) & 0xff;
        return;
      case 0x3ce:
        this.gfxIndex = v & 15;
        return;
      case 0x3cf:
        this.gfx[this.gfxIndex] = v;
        return;
      case 0x3d4: case 0x3b4:
        this.crtcIndex = v & 0x1f;
        return;
      case 0x3d5: case 0x3b5:
        this.crtc[this.crtcIndex & 0x1f] = v;
        return;
      default:
        return;
    }
  }

  in16(port) { return this.in8(port) | (this.in8(port + 1) << 8); }

  out16(port, value) {
    this.out8(port, value & 0xff);
    this.out8(port + 1, (value >> 8) & 0xff);
  }

  // ------------------------------------------------------------ video memory

  // CPU stores into A0000.  Chain 4 rotates the address so that a dword at
  // offset 4n lands on plane 0..3 at byte n, which is why the parts can write
  // one plane per pass by changing the map mask alone.
  writeVideo(offset, value, size) {
    const mask = this.seq[2] & 0x0f;
    const chain4 = this.layout === 'chain4' || this.chain4Override ||
      (this.layout !== 'planar' && (this.seq[4] & 0x08) !== 0);
    for (let i = 0; i < size; i++) {
      const a = (offset + i) & 0xffff;
      const byte = (value >>> (8 * i)) & 0xff;
      if (chain4) {
        // Chain 4: the address selects the plane, so a dword store covers one
        // pixel group and the map mask picks which of its four pixels commit.
        // Address `a` is then already the flat pixel index (a 16 bit window, so
        // this layout can reach 64 KB of pixels -- part 1 needs more and turns
        // it off).
        const plane = a & 3;
        if (mask & (1 << plane)) this.pixels[a] = byte;
      } else {
        // Planar: every (masked) plane sees the same byte offset, so the byte
        // lands in pixel (offset << 2) | plane of the flattened picture -- the
        // inverse of the chain-4 arrangement above, four pixels per byte.
        for (let plane = 0; plane < 4; plane++) {
          if (mask & (1 << plane)) {
            this.pixels[((a << 2) + plane) & 0x3ffff] = byte;
          }
        }
      }
    }
  }

  /**
   * A CPU read of `size` bytes at `offset` in A0000..AFFFF.  Chain 4 reads the
   * flat pixel; planar read mode 0 reads the plane in the read map select
   * register (gfx[4]) -- four pixels per plane byte, as writeVideo stores them.
   */
  readVideo(offset, size = 1) {
    const chain4 = this.layout === 'chain4' || this.chain4Override ||
      (this.layout !== 'planar' && (this.seq[4] & 0x08) !== 0);
    let v = 0;
    for (let i = 0; i < size; i++) {
      const a = (offset + i) & 0xffff;
      const byte = chain4 ? this.pixels[a] : this.pixels[((a << 2) + (this.gfx[4] & 3)) & 0x3ffff];
      v |= byte << (8 * i);
    }
    return size === 4 ? v >>> 0 : v;
  }

  // ----------------------------------------------------------------- display

  // The CRTC start address and scanline offset are counted in plane bytes, and
  // the scan-out assembles four pixels per plane byte, so a display pixel index
  // is four times either.  Part 1 programs offset 0xa8 (168 words = 336 plane
  // bytes = 1344 pixels per line), which is exactly the row pitch of its 336
  // byte picture strip; this is the relation the reference frames pin down.
  startPixels() {
    const s = (this.crtc[0x0c] << 8) | this.crtc[0x0d];
    if (this.layout === 'bytes') return s;
    return s * 4;
  }

  offsetBytes() {
    return this.crtc[0x13] * 2;
  }

  linePixels() {
    return this.offsetBytes() * 4;
  }

  // Pixel panning shifts the line start by `value / 2 - 1` pixels: the parts
  // step the register in twos (0, 2, 4, 6 -> -1, 0, 1, 2) while the CRTC start
  // moves in fours, which together give the 1 pixel per 4 counts scroll the
  // reference frames show.
  panPixels() {
    if (this.layout === 'nopan') return 0;
    return ((this.attr[0x13] & 7) >> 1) - 1;
  }

  // The visible 320x200 index image, as the card would scan it out.
  render(out) {
    const fb = this.pixels;
    const start = this.startPixels();
    const stride = this.linePixels();
    const pan = this.panPixels();
    // Part 1's picture is 195 rows of the 200 the CRTC scans, and the last few
    // rows address past the 256 KB of card memory.  Reading there shows black
    // in the reference frames, so the scan-out stops at the end of memory
    // rather than wrapping round to the picture again.
    for (let y = 0; y < SCREEN_H; y++) {
      const line = start + y * stride + pan;
      const row = y * SCREEN_W;
      for (let x = 0; x < SCREEN_W; x++) {
        const at = line + x;
        out[row + x] = at >= 0 && at < fb.length ? fb[at] : 0;
      }
    }
    return out;
  }

  // Six bit DAC values to 8 bit.  DOSBox replicates the top two bits into the
  // bottom two (`v << 2 | v >> 4`); rounding to 0..255 instead is off by one for
  // most values and made every colour in the comparison differ.
  paletteRGB() {
    const rgb = new Uint8Array(768);
    for (let i = 0; i < 768; i++) {
      const v = this.pal[i] & 0x3f;
      rgb[i] = (v << 2) | (v >> 4);
    }
    return rgb;
  }
}
