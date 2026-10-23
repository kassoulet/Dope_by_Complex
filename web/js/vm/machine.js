/*
 * dope/machine.js -- the machine the original parts run on.
 *
 * There is no BIOS, no DOS and no loader here.  The parts are started from a
 * memory image taken out of the real demo while it runs (tools/vmsnap.py), so
 * the data they read -- including the picture strips the loader decompressed
 * below the part -- is the original's own.  Everything this class adds is the
 * hardware around the CPU:
 *
 *   - a bus mapping the VGA's ports and the 8253 timer;
 *   - the timer interrupt, delivered through the guest's own `int 8` vector,
 *     which is what the parts install and what drives their animation;
 *   - the two BIOS/DOS services the part entry calls (mode set, exit).
 *
 * A frame is defined as the moment a timer interrupt finishes, i.e. exactly
 * when the part has advanced its own counter and rewritten the DAC, the CRTC
 * start address and the panning register.  Frame N therefore means "the
 * picture for counter N", which is what the reference screenshots are keyed
 * to as well.
 */

import { CPU } from './x86.js';
import { VGA } from './vga.js';

// The loader maps block file offset 0x100 at the part's segment, so the entry
// at 0xcd5 in the block is at 0xbd5 in the segment, and a part's `cs:` offsets
// (0x16a for the frame counter) are used as written.
export const PART_ENTRY = 0xcd5 - 0x100;
export const COUNTER = 0x16a;

export class Machine {
  constructor() {
    this.mem = new Uint8Array(1 << 20);
    this.vga = new VGA(this.mem);
    this.cpu = new CPU(this.mem, this);
    this.cpu.onInt = (n) => this.interrupt(n);
    this.cpu.onIret = (cs, ip) => this.iretDone(cs, ip);
    this.clock = 0;
    this.pitDiv = 8240;
    this.pitCount = 48491;
    this.pitLatch = 48491;
    this.pitLatchPos = 0;
    this.pitWriteLo = 0;
    this.pitExpectLo = true;
    this.pending = 0;
    this.timerArmed = false;
    this.ret = null;
    this.stopped = false;
    this.exited = false;
    this.partSeg = 0;
    this.counterBase = 0;
    this.frames = [];
    this.frameLimit = 4096;
    this.onFrame = null;
    this.log = [];
  }

  // ------------------------------------------------------------------- boot

  boot(image, meta) {
    this.mem.set(image.subarray(0, 1 << 20));
    this.installBiosStubs();
    const seg = meta.part_segment;
    this.partSeg = seg;
    // Part 1's counter is at 0x16a; other parts keep theirs elsewhere (part 2's
    // frame counter is the dword at 0x1928), so a snapshot can name it.
    this.counterBase = ((seg << 4) + (meta.counter_offset ?? COUNTER)) & 0xfffff;
    this.bootVector = this.cpu.read32(0x20);

    const cpu = this.cpu;
    cpu.reset();
    for (let i = 0; i < 6; i++) cpu.sreg[i] = seg;
    cpu.sreg[2] = 0x8000;      // stack segment: free RAM below video memory
    cpu.r[4] = 0xfffe;         // esp
    cpu.sreg[1] = seg;
    // A snapshot names the entry it caught the part at (`entry_cs_ip`); part 1
    // is the only part whose entry is the fixed 0xbd5 offset, so falling back
    // to that constant for any other part starts the CPU in the middle of
    // its data rather than its code.
    cpu.ip = meta.entry ?? (Array.isArray(meta.entry_cs_ip) ? meta.entry_cs_ip[1] : PART_ENTRY);
    this.entryIp = cpu.ip;
    cpu.cf = 0;
    this.vga.setMode(0x03);
    this.vga.clock = 0;
    this.clock = 0;
  }

  // The parts chain to the interrupt handler they found in the vector table
  // (the BIOS tick, at part entry).  There is no BIOS ROM behind this machine,
  // so every vector points at a two line stub in high memory: EOI and iret for
  // the hardware interrupts, a bare iret for everything else.  Without this a
  // chained tick would execute the zeroes of the ROM hole.
  installBiosStubs() {
    const base = 0xf0000 + 0x1000;
    const eoi = [0x50, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf]; // push ax; mov al,20; out 20,al; pop ax; iret
    this.mem.set(eoi, base);
    this.mem[base + 0x10] = 0xcf;
    for (let v = 0; v < 256; v++) {
      const a = v * 4;
      const off = v >= 8 && v <= 0x0f ? 0x1000 : 0x1010;
      this.mem[a] = off & 0xff;
      this.mem[a + 1] = off >> 8;
      this.mem[a + 2] = 0x00;
      this.mem[a + 3] = 0xf0;
    }
  }

  // ------------------------------------------------------------------- timing

  counter() {
    return this.cpu.read16(this.counterBase);
  }

  tick() {
    this.clock++;
    this.vga.clock = this.clock;
    if (--this.pitCount <= 0) {
      this.pitCount = this.pitDiv;
      this.pending = 1;
    }
    if (this.pending && this.cpu.if) {
      this.pending = 0;
      // Only count ticks whose handler is the part's own ISR: before the part
      // installs it, the vector still points at the BIOS stub, and those ticks
      // are not demo frames.
      const vec = this.cpu.read32(0x20);
      const own = (vec >>> 16) === this.partSeg;
      if (own) {
        this.ret = { cs: this.cpu.sreg[1], ip: this.cpu.ip };
        this.cpu.interrupt(8);
      }
    }
  }

  iretDone(cs, ip) {
    if (!this.ret || this.ret.cs !== cs || this.ret.ip !== ip) return;
    this.ret = null;
    if (this.partSeg === 0) return;
    const counter = this.counter();
    const frame = {
      counter,
      start: this.vga.startPixels(),
      offset: this.vga.offsetBytes(),
      pan: this.vga.panPixels(),
      crtc: this.vga.crtc.slice(),
      // The panning register lives in the attribute controller, so rendering a
      // frame later needs that saved too, not just the CRTC.
      attr: this.vga.attr.slice(),
      pal: this.vga.pal.slice(),
    };
    if (this.frames.length < this.frameLimit) this.frames.push(frame);
    if (this.onFrame) this.onFrame(frame);
  }

  // ------------------------------------------------------------------- video

  // The CPU hands A0000 stores here so the VGA can apply the sequencer's map
  // mask and chain-4 rotation instead of writing bytes flat.
  writeVideo(offset, value, size) {
    this.vga.writeVideo(offset, value, size);
  }

  readVideo(offset, size) {
    return this.vga.readVideo(offset, size);
  }

  // ------------------------------------------------------------------- ports

  in8(port) {
    switch (port) {
      case 0x40: {
        const v = this.pitLatch;
        const byte = this.pitLatchPos === 0 ? v & 0xff : (v >> 8) & 0xff;
        this.pitLatchPos = (this.pitLatchPos + 1) & 1;
        return byte;
      }
      case 0x60:
        return 0;
      case 0x61:
        return 0x20;
      default:
        return this.vga.in8(port);
    }
  }

  in16(port) { return this.in8(port) | (this.in8(port + 1) << 8); }
  in32(port) { return (this.in16(port) | (this.in16(port + 2) << 16)) >>> 0; }

  out8(port, v) {
    switch (port) {
      case 0x43:
        if ((v & 0x30) === 0) this.pitLatch = this.pitCount;
        else this.pitExpectLo = true;
        return;
      case 0x40:
        if (this.pitExpectLo) {
          this.pitWriteLo = v;
          this.pitExpectLo = false;
        } else {
          const div = (this.pitWriteLo | (v << 8)) || 0x10000;
          this.pitDiv = div;
          this.pitCount = div;
          this.pitLatch = div;
          this.pitExpectLo = true;
        }
        return;
      case 0x42:
        return;
      default:
        this.vga.out8(port, v);
    }
  }

  out16(port, v) {
    this.out8(port, v & 0xff);
    this.out8(port + 1, (v >> 8) & 0xff);
  }

  out32(port, v) {
    this.out16(port, v & 0xffff);
    this.out16(port + 2, (v >>> 16) & 0xffff);
  }

  // -------------------------------------------------------------- interrupts

  // Return true when the service was handled here (no IVT dispatch).
  interrupt(n) {
    const cpu = this.cpu;
    switch (n) {
      case 0x10: {
        const ah = (cpu.r[0] >> 8) & 0xff;
        const al = cpu.r[0] & 0xff;
        if (ah === 0x00) {
          this.vga.setMode(al);
          return true;
        }
        if (ah === 0x0f) {
          cpu.r[0] = (al & 0xff) | (this.vga.mode << 8) | (cpu.r[0] & 0xffff0000);
          cpu.setR(0, 2, (this.vga.mode << 8) | 0x50);
          return true;
        }
        if (ah === 0x03) {
          cpu.setR(1, 2, 0);
          cpu.setR(2, 2, 0);
          cpu.setR(0, 2, 0);
          return true;
        }
        this.log.push('int10 ax=' + cpu.r[0].toString(16));
        return true;
      }
      case 0x11:
        this.log.push('int11');
        cpu.setR(0, 2, 0x0030);
        return true;
      case 0x12:
        cpu.setR(0, 2, 0x0280);
        return true;
      case 0x16: {
        // No keyboard in the port: report "no key waiting".
        const ah = (cpu.r[0] >> 8) & 0xff;
        if (ah === 0x01 || ah === 0x11) cpu.zf = 1;
        else if (ah === 0x00 || ah === 0x10) cpu.setR(0, 2, 0);
        cpu.zf = 1;
        return true;
      }
      case 0x1a: {
        cpu.setR(1, 2, 0);
        cpu.setR(2, 2, 0);
        cpu.r[0] = cpu.r[0] & 0xffff0000;
        return true;
      }
      case 0x21: {
        const ah = (cpu.r[0] >> 8) & 0xff;
        if (ah === 0x4c) {
          this.exited = true;
          this.stopped = true;
          return true;
        }
        if (ah === 0x30) {
          cpu.setR(0, 2, 0x0005);
          return true;
        }
        this.log.push('int21 ax=' + cpu.r[0].toString(16));
        return true;
      }
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------- run

  // Run until the part's own counter reaches `target` (or a frame with that
  // counter has been rendered), or until the CPU budget runs out.
  runTo(target, maxInstructions = 40000000) {
    const start = this.cpu.insts;
    while (!this.stopped && !this.exited) {
      if (this.cpu.insts - start > maxInstructions) return false;
      if (this.frames.length && this.frames[this.frames.length - 1].counter >= target) return true;
      this.cpu.step();
      this.tick();
    }
    return true;
  }

  step() {
    this.cpu.step();
    this.tick();
  }
}
