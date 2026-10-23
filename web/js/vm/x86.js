/*
 * dope/x86.js -- real mode x86 interpreter.
 *
 * DOPE's demo parts are 1995 hand written 16 bit assembly: the loader maps a
 * block into a segment, jumps into it, and everything after that is the
 * original code drawing into mode 13h.  Running that code, instead of
 * rewriting its effects, is the only way to get the original's exact pixels,
 * so this file is a small but ordinary 8086/186/386 interpreter: 16 and 32 bit
 * operand sizes (0x66), 16 and 32 bit addresses (0x67), segment overrides, the
 * rep prefix, and the instruction set those parts actually use.
 *
 * There is no protected mode, no paging and no segment limit checking: the
 * parts run in real mode with a flat 1 MB address space, which is what the
 * measurements in docs/RUNTIME.md show.  Floating point is not implemented;
 * parts that need it fail loudly instead of silently rendering the wrong
 * picture.
 *
 * The memory image is a single Uint8Array of 1 MB so that video memory is
 * ordinary memory from the CPU's point of view; the VGA in vga.js reads its
 * framebuffer straight out of it.
 */

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let b = i;
  let p = 1;
  while (b) {
    p ^= b & 1;
    b >>= 1;
  }
  PARITY[i] = p;
}

// Register file order: EAX ECX EDX EBX ESP EBP ESI EDI (the ModRM encoding).
const EAX = 0;
const ECX = 1;
const EDX = 2;
const EBX = 3;
const ESP = 4;
const EBP = 5;
const ESI = 6;
const EDI = 7;

// Segment register order: ES CS SS DS FS GS.
const SEG_ES = 0;
const SEG_CS = 1;
const SEG_SS = 2;
const SEG_DS = 3;
const SEG_FS = 4;
const SEG_GS = 5;

// Indexed by operand size in bytes; index 3 is unused (there is no 24 bit
// operand) and must stay a hole so that MASK[4] is the 32 bit mask.
const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];
const SIGN = [0, 0x80, 0x8000, 0, 0x80000000];

export class Unsupported extends Error {
  constructor(what, cpu) {
    super('unsupported instruction: ' + what + ' at ' + cpu.cs().toString(16) + ':' + (cpu.ip - 1).toString(16));
    this.opcode = what;
  }
}

export class CPU {
  constructor(mem, bus) {
    this.mem = mem;
    this.bus = bus || null;
    this.r = new Uint32Array(8);
    this.sreg = new Uint16Array(6);
    this.ip = 0;
    this.insts = 0;
    this.halted = false;
    this.onInt = null;
    this.reset();
  }

  reset() {
    this.r.fill(0);
    this.sreg.fill(0);
    this.sreg[SEG_CS] = 0xffff;
    this.ip = 0;
    this.cf = this.pf = this.af = this.zf = this.sf = 0;
    this.tf = this.if = this.df = this.of = 0;
    this.iopl = 3;
  }

  cs() { return this.sreg[SEG_CS]; }
  ss() { return this.sreg[SEG_SS]; }

  // ---------------------------------------------------------------- memory

  // Reads of A0000..AFFFF come from the card (the picture the parts wrote), not
  // from the flat memory image: a part that saves or restores the screen reads it back.
  read8(a) {
    a &= 0xfffff;
    if (a >= 0xa0000 && a < 0xb0000 && this.bus && this.bus.readVideo) return this.bus.readVideo(a - 0xa0000, 1);
    return this.mem[a];
  }

  read16(a) {
    a &= 0xfffff;
    if (a >= 0xa0000 && a < 0xb0000 && this.bus && this.bus.readVideo) return this.bus.readVideo(a - 0xa0000, 2);
    const m = this.mem;
    return m[a] | (m[(a + 1) & 0xfffff] << 8);
  }

  read32(a) {
    a &= 0xfffff;
    if (a >= 0xa0000 && a < 0xb0000 && this.bus && this.bus.readVideo) return this.bus.readVideo(a - 0xa0000, 4);
    const m = this.mem;
    return ((m[a] | (m[(a + 1) & 0xfffff] << 8) | (m[(a + 2) & 0xfffff] << 16) |
      (m[(a + 3) & 0xfffff] << 24)) >>> 0);
  }

  // Video memory is not plain RAM: the sequencer decides which planes a store
  // reaches, so writes into A0000 go to the bus when one is attached.
  videoWrite(a, v, size) {
    const bus = this.bus;
    if (bus && bus.writeVideo && a >= 0xa0000 && a + size <= 0xb0000) {
      bus.writeVideo(a - 0xa0000, v, size);
      return true;
    }
    return false;
  }

  write8(a, v) {
    a &= 0xfffff;
    if (this.videoWrite(a, v & 0xff, 1)) return;
    this.mem[a] = v & 0xff;
  }

  write16(a, v) {
    a &= 0xfffff;
    if (this.videoWrite(a, v & 0xffff, 2)) return;
    const m = this.mem;
    m[a] = v & 0xff;
    m[(a + 1) & 0xfffff] = (v >> 8) & 0xff;
  }

  write32(a, v) {
    a &= 0xfffff;
    if (this.videoWrite(a, v >>> 0, 4)) return;
    const m = this.mem;
    m[a] = v & 0xff;
    m[(a + 1) & 0xfffff] = (v >>> 8) & 0xff;
    m[(a + 2) & 0xfffff] = (v >>> 16) & 0xff;
    m[(a + 3) & 0xfffff] = (v >>> 24) & 0xff;
  }

  // Register encoding 0..7 is AL CL DL BL AH CH DH BH for byte accesses, so a
  // byte register index is (index & 3) plus a high/low half selector.
  getR(i, size) {
    if (size === 4) return this.r[i] >>> 0;
    if (size === 2) return this.r[i] & 0xffff;
    const v = this.r[i & 3];
    return (i & 4) ? ((v >>> 8) & 0xff) : (v & 0xff);
  }

  setR(i, size, v) {
    if (size === 4) { this.r[i] = v >>> 0; return; }
    if (size === 2) { this.r[i] = (this.r[i] & 0xffff0000) | (v & 0xffff); return; }
    const ri = i & 3;
    if (i & 4) this.r[ri] = (this.r[ri] & 0xffff00ff) | ((v & 0xff) << 8);
    else this.r[ri] = (this.r[ri] & 0xffffff00) | (v & 0xff);
  }

  // --------------------------------------------------------------- fetching

  fetch8() {
    const a = ((this.sreg[SEG_CS] << 4) + (this.ip & 0xffff)) & 0xfffff;
    this.ip = (this.ip + 1) & 0xffff;
    return this.mem[a];
  }

  fetch16() {
    const lo = this.fetch8();
    return lo | (this.fetch8() << 8);
  }

  fetch32() {
    const lo = this.fetch16();
    return (lo | (this.fetch16() << 16)) >>> 0;
  }

  fetch8s() {
    const v = this.fetch8();
    return v < 0x80 ? v : v - 0x100;
  }

  fetchImm(size) {
    if (size === 1) return this.fetch8();
    if (size === 2) return this.fetch16();
    return this.fetch32();
  }

  fetchImms(size) {
    if (size === 1) return this.fetch8s();
    if (size === 2) return (this.fetch16() << 16) >> 16;
    return this.fetch32() | 0;
  }

  // ------------------------------------------------------------------ flags

  get flags() {
    return (this.cf ? 1 : 0) | 0x02 | (this.pf ? 4 : 0) | (this.af ? 0x10 : 0) |
      (this.zf ? 0x40 : 0) | (this.sf ? 0x80 : 0) | (this.tf ? 0x100 : 0) |
      (this.if ? 0x200 : 0) | (this.df ? 0x400 : 0) | (this.of ? 0x800 : 0) |
      0x2000 | 0x8000;
  }

  set flags(v) {
    this.cf = v & 1 ? 1 : 0;
    this.pf = v & 4 ? 1 : 0;
    this.af = v & 0x10 ? 1 : 0;
    this.zf = v & 0x40 ? 1 : 0;
    this.sf = v & 0x80 ? 1 : 0;
    this.tf = v & 0x100 ? 1 : 0;
    this.if = v & 0x200 ? 1 : 0;
    this.df = v & 0x400 ? 1 : 0;
    this.of = v & 0x800 ? 1 : 0;
  }

  // -------------------------------------------------------------- arithmetic

  alu(op, a, b, size) {
    const m = MASK[size];
    const sign = SIGN[size];
    let res;
    switch (op) {
      case 0: { // add
        const s = a + b;
        res = s & m;
        this.cf = s > m ? 1 : 0;
        this.of = ((a ^ res) & (b ^ res) & sign) ? 1 : 0;
        break;
      }
      case 2: { // adc
        const s = a + b + (this.cf ? 1 : 0);
        res = s & m;
        this.cf = s > m ? 1 : 0;
        this.of = ((a ^ res) & (b ^ res) & sign) ? 1 : 0;
        break;
      }
      case 5: { // sub
        const s = a - b;
        res = s & m;
        this.cf = s < 0 ? 1 : 0;
        this.of = ((a ^ b) & (a ^ res) & sign) ? 1 : 0;
        break;
      }
      case 3: { // sbb
        const s = a - b - (this.cf ? 1 : 0);
        res = s & m;
        this.cf = s < 0 ? 1 : 0;
        this.of = ((a ^ b) & (a ^ res) & sign) ? 1 : 0;
        break;
      }
      case 7: { // cmp
        const s = a - b;
        res = s & m;
        this.cf = s < 0 ? 1 : 0;
        this.of = ((a ^ b) & (a ^ res) & sign) ? 1 : 0;
        break;
      }
      case 1: res = (a | b) & m; this.cf = this.of = 0; break;
      case 4: res = (a & b) & m; this.cf = this.of = 0; break;
      case 6: res = (a ^ b) & m; this.cf = this.of = 0; break;
      default: throw new Unsupported('alu' + op, this);
    }
    if (op !== 2 && op !== 3) this.af = ((a ^ b ^ res) & 0x10) ? 1 : 0;
    else this.af = ((a ^ b ^ res) & 0x10) ? 1 : 0;
    this.zf = res === 0 ? 1 : 0;
    this.sf = (res & sign) ? 1 : 0;
    this.pf = PARITY[res & 0xff];
    return res;
  }

  logic(res, size) {
    res &= MASK[size];
    this.cf = 0;
    this.of = 0;
    this.zf = res === 0 ? 1 : 0;
    this.sf = (res & SIGN[size]) ? 1 : 0;
    this.pf = PARITY[res & 0xff];
    return res;
  }

  incdec(v, size, delta) {
    const m = MASK[size];
    const res = (v + delta) & m;
    this.of = delta > 0 ? (v === m ? 1 : 0) : (v === SIGN[size] ? 1 : 0);
    this.zf = res === 0 ? 1 : 0;
    this.sf = (res & SIGN[size]) ? 1 : 0;
    this.pf = PARITY[res & 0xff];
    this.af = ((v ^ delta ^ res) & 0x10) ? 1 : 0;
    return res;
  }

  shift(op, v, count, size) {
    const bits = size * 8;
    const m = MASK[size];
    const sign = SIGN[size];
    let res = v & m;
    let c = count & 0x1f; // the 386 masks every shift count to 5 bits
    if (c === 0) return res;
    switch (op) {
      case 4: // shl / sal
        for (let i = 0; i < c; i++) {
          this.cf = (res & sign) ? 1 : 0;
          res = (res << 1) & m;
        }
        this.of = ((res & sign) ? 1 : 0) ^ this.cf;
        break;
      case 5: // shr
        for (let i = 0; i < c; i++) {
          this.cf = res & 1;
          res = (res >>> 1) & (m >>> 1);
        }
        this.of = v & sign ? 1 : 0;
        break;
      case 7: // sar
        for (let i = 0; i < c; i++) {
          this.cf = res & 1;
          res = ((res & sign) ? ((res >>> 1) | sign) : (res >>> 1)) & m;
        }
        this.of = 0;
        break;
      case 0: // rol
        for (let i = 0; i < c; i++) {
          const top = (res & sign) ? 1 : 0;
          res = ((res << 1) | top) & m;
          this.cf = top;
        }
        this.of = ((res & sign) ? 1 : 0) ^ this.cf;
        break;
      case 1: // ror
        for (let i = 0; i < c; i++) {
          const low = res & 1;
          res = ((res >>> 1) | (low ? sign : 0)) & m;
          this.cf = low;
        }
        this.of = ((res & sign) ? 1 : 0) ^ ((res & (sign >>> 1)) ? 1 : 0);
        break;
      case 2: { // rcl
        let carry = this.cf;
        for (let i = 0; i < c; i++) {
          const top = (res & sign) ? 1 : 0;
          res = ((res << 1) | carry) & m;
          carry = top;
        }
        this.cf = carry;
        this.of = ((res & sign) ? 1 : 0) ^ this.cf;
        break;
      }
      case 3: { // rcr
        let carry = this.cf;
        for (let i = 0; i < c; i++) {
          const low = res & 1;
          res = ((res >>> 1) | (carry ? sign : 0)) & m;
          carry = low;
        }
        this.cf = carry;
        this.of = ((res & sign) ? 1 : 0) ^ ((res & (sign >>> 1)) ? 1 : 0);
        break;
      }
      default:
        throw new Unsupported('shift' + op, this);
    }
    // rotates change CF and OF only; shifts also set ZF/SF/PF
    if (op >= 4) {
      this.zf = res === 0 ? 1 : 0;
      this.sf = (res & sign) ? 1 : 0;
      this.pf = PARITY[res & 0xff];
    }
    return res;
  }

  mul(v, size) {
    if (size === 1) {
      const p = (this.getR(EAX, 1) * v) & 0xffff;
      this.setR(EAX, 2, p);
      this.cf = this.of = (p >>> 8) ? 1 : 0;
      return;
    }
    const a = size === 2 ? this.getR(EAX, 2) : this.r[EAX];
    const p = a * v;
    if (size === 2) {
      this.setR(EAX, 2, p & 0xffff);
      this.setR(EDX, 2, (p >>> 16) & 0xffff);
      this.cf = this.of = (p >>> 16) ? 1 : 0;
    } else {
      const r = BigInt(a) * BigInt(v >>> 0);
      this.r[EAX] = Number(r & 0xffffffffn) >>> 0;
      this.r[EDX] = Number((r >> 32n) & 0xffffffffn) >>> 0;
      this.cf = this.of = this.r[EDX] ? 1 : 0;
    }
  }

  imul1(v, size) {
    if (size === 1) {
      const p = ((this.getR(EAX, 1) << 24) >> 24) * ((v << 24) >> 24);
      this.setR(EAX, 2, p & 0xffff);
      this.cf = this.of = (p < -128 || p > 127) ? 1 : 0;
      return;
    }
    if (size === 2) {
      const a = (this.getR(EAX, 2) << 16) >> 16;
      const b = (v << 16) >> 16;
      const p = a * b;
      this.setR(EAX, 2, p & 0xffff);
      this.setR(EDX, 2, (p >> 16) & 0xffff);
      this.cf = this.of = (p < -32768 || p > 32767) ? 1 : 0;
      return;
    }
    const a = BigInt(this.r[EAX] | 0);
    const b = BigInt(v << 0);
    const p = a * b;
    this.r[EAX] = Number(p & 0xffffffffn) >>> 0;
    this.r[EDX] = Number((p >> 32n) & 0xffffffffn) >>> 0;
    this.cf = this.of = (p < -2147483648n || p > 2147483647n) ? 1 : 0;
  }

  div(v, size, signed) {
    if (v === 0) throw new Unsupported('divide error', this);
    if (size === 1) {
      const n = this.getR(EAX, 2);
      const d = signed ? ((v << 24) >> 24) : v;
      const ns = signed ? ((n << 16) >> 16) : n;
      const q = (signed ? Math.trunc(ns / d) : Math.floor(ns / d)) & 0xff;
      const r = (ns % d) & 0xff;
      this.setR(EAX, 2, (r << 8) | q);
      return;
    }
    if (size === 2) {
      const n = ((this.r[EDX] & 0xffff) << 16) | (this.r[EAX] & 0xffff);
      const d = signed ? (v << 16) >> 16 : v;
      let q;
      let r;
      if (signed) {
        const ns = (n << 16) >> 16 === n ? n : n > 0x7fffffff ? n - 0x100000000 : n;
        q = (ns / d) | 0;
        r = (ns % d) | 0;
      } else {
        q = Math.floor(n / d);
        r = n % d;
      }
      this.setR(EAX, 2, q & 0xffff);
      this.setR(EDX, 2, r & 0xffff);
      return;
    }
    // EDX:EAX is a 64 bit dividend but the registers are stored unsigned, so
    // a signed division has to sign extend the pair; dividing the raw value
    // gives a wildly wrong quotient whenever the dividend is negative (part
    // 2's projection does exactly that).
    const raw = (BigInt(this.r[EDX]) << 32n) | BigInt(this.r[EAX]);
    const n = signed ? BigInt.asIntN(64, raw) : raw;
    const d = BigInt(signed ? (v | 0) : (v >>> 0));
    const q = n / d; // BigInt division truncates toward zero, as x86 does
    const r = n % d;
    this.r[EAX] = Number(q & 0xffffffffn) >>> 0;
    this.r[EDX] = Number(r & 0xffffffffn) >>> 0;
  }

  // ------------------------------------------------------------- addressing

  modrm() {
    const b = this.fetch8();
    const mod = b >> 6;
    const reg = (b >> 3) & 7;
    const rm = b & 7;
    this.mod = mod;
    this.reg = reg;
    this.rm = rm;
    if (mod === 3) {
      this.memReg = true;
      this.ea = 0;
      return reg;
    }
    this.memReg = false;
    let off = 0;
    let dseg = SEG_DS;
    if (!this.addr32) {
      switch (rm) {
        case 0: off = this.getR(EBX, 2) + this.getR(ESI, 2); break;
        case 1: off = this.getR(EBX, 2) + this.getR(EDI, 2); break;
        case 2: off = this.getR(EBP, 2) + this.getR(ESI, 2); dseg = SEG_SS; break;
        case 3: off = this.getR(EBP, 2) + this.getR(EDI, 2); dseg = SEG_SS; break;
        case 4: off = this.getR(ESI, 2); break;
        case 5: off = this.getR(EDI, 2); break;
        case 6:
          if (mod === 0) off = this.fetch16();
          else { off = this.getR(EBP, 2); dseg = SEG_SS; }
          break;
        default: off = this.getR(EBX, 2); break;
      }
      if (mod === 1) off += this.fetch8s();
      else if (mod === 2) off += this.fetch16();
      off &= 0xffff;
    } else {
      let base = 0;
      let index = 0;
      if (rm === 4) {
        const sib = this.fetch8();
        const scale = sib >> 6;
        const idx = (sib >> 3) & 7;
        const bas = sib & 7;
        if (idx !== 4) index = this.r[idx] * (1 << scale);
        if (bas === 5 && mod === 0) base = this.fetch32();
        else { base = this.r[bas]; if (bas === EBP) dseg = SEG_SS; }
      } else if (rm === 5 && mod === 0) {
        base = this.fetch32();
      } else {
        base = this.r[rm];
        if (rm === EBP) dseg = SEG_SS;
      }
      off = base + index;
      if (mod === 1) off += this.fetch8s();
      else if (mod === 2) off += this.fetch32();
      off = off >>> 0;
    }
    const seg = this.segOverride >= 0 ? this.segOverride : dseg;
    this.eaOff = off;
    this.ea = ((this.sreg[seg] << 4) + off) & 0xfffff;
    return reg;
  }

  rmRead(size) {
    if (this.memReg) return this.getR(this.rm, size);
    if (size === 1) return this.read8(this.ea);
    if (size === 2) return this.read16(this.ea);
    return this.read32(this.ea);
  }

  rmWrite(size, v) {
    if (this.memReg) return this.setR(this.rm, size, v);
    if (size === 1) this.write8(this.ea, v);
    else if (size === 2) this.write16(this.ea, v);
    else this.write32(this.ea, v);
  }

  // ------------------------------------------------------------------ stack

  push(v, size) {
    if (size === 2) {
      const sp = (this.getR(ESP, 2) - 2) & 0xffff;
      this.setR(ESP, 2, sp);
      this.write16(((this.sreg[SEG_SS] << 4) + sp) & 0xfffff, v);
    } else {
      const sp = (this.r[ESP] - 4) >>> 0;
      this.r[ESP] = sp;
      this.write32(((this.sreg[SEG_SS] << 4) + sp) & 0xfffff, v);
    }
  }

  pop(size) {
    let v;
    if (size === 2) {
      const sp = this.getR(ESP, 2);
      v = this.read16(((this.sreg[SEG_SS] << 4) + sp) & 0xfffff);
      this.setR(ESP, 2, (sp + 2) & 0xffff);
    } else {
      const sp = this.r[ESP];
      v = this.read32(((this.sreg[SEG_SS] << 4) + sp) & 0xfffff);
      this.r[ESP] = (sp + 4) >>> 0;
    }
    return v;
  }

  // ------------------------------------------------------------------ jumps

  cond(cc) {
    switch (cc) {
      case 0: return this.of === 1;
      case 1: return this.of === 0;
      case 2: return this.cf === 1;
      case 3: return this.cf === 0;
      case 4: return this.zf === 1;
      case 5: return this.zf === 0;
      case 6: return this.cf === 1 || this.zf === 1;
      case 7: return this.cf === 0 && this.zf === 0;
      case 8: return this.sf === 1;
      case 9: return this.sf === 0;
      case 10: return this.pf === 1;
      case 11: return this.pf === 0;
      case 12: return this.sf !== this.of;
      case 13: return this.sf === this.of;
      case 14: return this.zf === 1 || this.sf !== this.of;
      default: return this.zf === 0 && this.sf === this.of;
    }
  }

  jumpRel(rel) {
    this.ip = (this.ip + rel) & 0xffff;
  }

  // --------------------------------------------------------------- interrupts

  interrupt(n) {
    if (this.onInt) {
      if (this.onInt(n, this) === true) return;
    }
    const addr = (n << 2) & 0xfffff;
    const off = this.read16(addr);
    const seg = this.read16(addr + 2);
    this.push(this.flags, 2);
    this.push(this.sreg[SEG_CS], 2);
    this.push(this.ip & 0xffff, 2);
    this.if = 0;
    this.tf = 0;
    this.sreg[SEG_CS] = seg;
    this.ip = off;
  }

  iret() {
    const ip = this.pop(2);
    const cs = this.pop(2);
    this.flags = this.pop(2);
    this.ip = ip;
    this.sreg[SEG_CS] = cs;
    if (this.onIret) this.onIret(cs, ip);
  }

  // ------------------------------------------------------------- instruction

  // One instruction.  Returns false when the CPU halted.
  step() {
    this.segOverride = -1;
    this.rep = 0;
    this.opsz = 2;
    this.addr32 = false;
    for (;;) {
      const b = this.fetch8();
      if (b === 0x66) { this.opsz = 4; continue; }
      if (b === 0x67) { this.addr32 = true; continue; }
      if (b === 0x26) { this.segOverride = SEG_ES; continue; }
      if (b === 0x2e) { this.segOverride = SEG_CS; continue; }
      if (b === 0x36) { this.segOverride = SEG_SS; continue; }
      if (b === 0x3e) { this.segOverride = SEG_DS; continue; }
      if (b === 0x64) { this.segOverride = SEG_FS; continue; }
      if (b === 0x65) { this.segOverride = SEG_GS; continue; }
      if (b === 0xf0) continue; // lock
      if (b === 0xf2) { this.rep = 2; continue; }
      if (b === 0xf3) { this.rep = 1; continue; }
      this.insts++;
      this.opcode(b);
      return !this.halted;
    }
  }

  opcode(b) {
    const sz = this.opsz;

    if (b === 0x0f) { this.opcode0f(); return; }

    switch (b) {
      case 0x06: this.push(this.sreg[SEG_ES], 2); return;
      case 0x07: this.sreg[SEG_ES] = this.pop(2); return;
      case 0x0e: this.push(this.sreg[SEG_CS], 2); return;
      case 0x16: this.push(this.sreg[SEG_SS], 2); return;
      case 0x17: this.sreg[SEG_SS] = this.pop(2); return;
      case 0x1e: this.push(this.sreg[SEG_DS], 2); return;
      case 0x1f: this.sreg[SEG_DS] = this.pop(2); return;
      case 0x27: case 0x2f: case 0x37: case 0x3f: { // daa/das/aaa/aas
        const al = this.getR(EAX, 1);
        let lo = al & 0x0f;
        let hi = al >> 4;
        if (b === 0x37) { // aaa
          if (lo > 9 || this.af) { this.setR(EAX, 2, (this.getR(EAX, 2) + 0x106) & 0xffff); this.af = 1; this.cf = 1; }
          else { this.setR(EAX, 1, this.getR(EAX, 1) & 0x0f); this.af = 0; this.cf = 0; }
          return;
        }
        if (b === 0x3f) { // aas
          if (lo > 9 || this.af) { this.setR(EAX, 2, (this.getR(EAX, 2) - 6) & 0xffff); this.setR(EAX, 2, (this.getR(EAX, 2) - 0x100) & 0xffff); this.af = 1; this.cf = 1; }
          else { this.setR(EAX, 1, this.getR(EAX, 1) & 0x0f); this.af = 0; this.cf = 0; }
          this.setR(EAX, 1, this.getR(EAX, 1) & 0x0f);
          return;
        }
        let adj = 0;
        let carry = 0;
        if (lo > 9 || this.af) { adj |= 6; if (b === 0x27) carry = al > 0xf9; }
        if (hi > 9 || this.cf || carry) { adj |= 0x60; carry = 1; }
        const res = b === 0x27 ? (al + adj) & 0xff : (al - adj) & 0xff;
        this.setR(EAX, 1, res);
        this.cf = b === 0x27 ? (carry || res > 0xf9 ? 1 : 0) : (carry ? 1 : 0);
        this.zf = res === 0 ? 1 : 0;
        this.sf = res & 0x80 ? 1 : 0;
        this.pf = PARITY[res];
        return;
      }
      default: break;
    }

    // 0x00..0x3f: ALU group, six encodings each.
    if (b < 0x40) {
      const op = b >> 3;
      const form = b & 7;
      if (form <= 3) {
        const size = (b & 1) ? sz : 1;
        const r = this.modrm();
        if (form < 2) {
          const a = this.rmRead(size);
          const v = op === 7 ? this.alu(7, a, this.getR(r, size), size)
            : this.alu(op, a, this.getR(r, size), size);
          if (op !== 7) this.rmWrite(size, v);
        } else {
          const a = this.getR(r, size);
          const v = this.alu(op, a, this.rmRead(size), size);
          if (op !== 7) this.setR(r, size, v);
        }
      } else if (form === 4) {
        const v = this.alu(op, this.getR(EAX, 1), this.fetch8(), 1);
        if (op !== 7) this.setR(EAX, 1, v);
      } else if (form === 5) {
        const v = this.alu(op, this.getR(EAX, sz), this.fetchImm(sz), sz);
        if (op !== 7) this.setR(EAX, sz, v);
      }
      return;
    }

    if (b >= 0x40 && b <= 0x47) { // inc reg
      const i = b & 7;
      this.setR(i, sz, this.incdec(this.getR(i, sz), sz, 1));
      return;
    }
    if (b >= 0x48 && b <= 0x4f) { // dec reg
      const i = b & 7;
      this.setR(i, sz, this.incdec(this.getR(i, sz), sz, -1));
      return;
    }
    if (b >= 0x50 && b <= 0x57) { // push reg
      this.push(this.getR(b & 7, sz), sz);
      return;
    }
    if (b >= 0x58 && b <= 0x5f) { // pop reg
      this.setR(b & 7, sz, this.pop(sz));
      return;
    }
    if (b >= 0x70 && b <= 0x7f) { // jcc rel8
      const rel = this.fetch8s();
      if (this.cond(b & 15)) this.jumpRel(rel);
      return;
    }
    if (b >= 0x90 && b <= 0x97) { // xchg ax, reg
      const i = b & 7;
      const t = this.getR(EAX, sz);
      this.setR(EAX, sz, this.getR(i, sz));
      this.setR(i, sz, t);
      return;
    }
    if (b >= 0xb0 && b <= 0xb7) { // mov r8, imm8
      this.setR(b & 7, 1, this.fetch8());
      return;
    }
    if (b >= 0xb8 && b <= 0xbf) { // mov reg, imm
      this.setR(b & 7, sz, this.fetchImm(sz));
      return;
    }
    if (b >= 0xd8 && b <= 0xdf) {
      throw new Unsupported('x87 0x' + b.toString(16), this);
    }

    switch (b) {
      case 0x60: { // pusha / pushad
        const sp = this.r[ESP];
        this.push(this.getR(EAX, sz), sz);
        this.push(this.getR(ECX, sz), sz);
        this.push(this.getR(EDX, sz), sz);
        this.push(this.getR(EBX, sz), sz);
        this.push(sp, sz);
        this.push(this.getR(EBP, sz), sz);
        this.push(this.getR(ESI, sz), sz);
        this.push(this.getR(EDI, sz), sz);
        return;
      }
      case 0x61: { // popa / popad
        this.setR(EDI, sz, this.pop(sz));
        this.setR(ESI, sz, this.pop(sz));
        this.setR(EBP, sz, this.pop(sz));
        this.pop(sz);
        this.setR(EBX, sz, this.pop(sz));
        this.setR(EDX, sz, this.pop(sz));
        this.setR(ECX, sz, this.pop(sz));
        this.setR(EAX, sz, this.pop(sz));
        return;
      }
      case 0x68:
        this.push(this.fetchImm(this.opsz), this.opsz);
        return;
      case 0x69: { // imul r, r/m, imm
        const r = this.modrm();
        const v = this.rmRead(sz);
        const imm = this.fetchImms(sz);
        const res = sz === 2 ? (((v << 16) >> 16) * ((imm << 16) >> 16)) | 0 : (v | 0) * (imm | 0);
        this.setR(r, sz, res);
        this.cf = this.of = 0;
        return;
      }
      case 0x6a:
        this.push(this.fetch8s() & (sz === 2 ? 0xffff : 0xffffffff), sz);
        return;
      case 0x6b: { // imul r, r/m, imm8
        const r = this.modrm();
        const v = this.rmRead(sz);
        const imm = this.fetch8s();
        const res = sz === 2 ? (((v << 16) >> 16) * imm) | 0 : (v | 0) * imm;
        this.setR(r, sz, res);
        this.cf = this.of = 0;
        return;
      }
      case 0x6c: // insb
      case 0x6d: { // insw/insd
        const size = b === 0x6c ? 1 : sz;
        const n = this.rep ? this.getR(ECX, 2) : 1;
        for (let i = 0; i < n; i++) {
          const port = this.getR(EDX, 2);
          const v = size === 1 ? this.in(port, 1) : size === 2 ? this.in(port, 2) : this.in(port, 4);
          const di = this.r[EDI];
          if (size === 1) this.write8(this.esAddr(di), v);
          else if (size === 2) this.write16(this.esAddr(di), v);
          else this.write32(this.esAddr(di), v);
          this.stepPtr(EDI, size);
        }
        if (this.rep) this.setR(ECX, 2, 0);
        return;
      }
      case 0x6e: // outsb
      case 0x6f: { // outsw/d
        const size = b === 0x6e ? 1 : sz;
        const n = this.rep ? this.getR(ECX, 2) : 1;
        for (let i = 0; i < n; i++) {
          const si = this.r[ESI];
          const v = size === 1 ? this.read8(this.dsAddr(si))
            : size === 2 ? this.read16(this.dsAddr(si)) : this.read32(this.dsAddr(si));
          this.out(this.getR(EDX, 2), size, v);
          this.stepPtr(ESI, size);
        }
        if (this.rep) this.setR(ECX, 2, 0);
        return;
      }

      case 0x80: case 0x81: case 0x82: case 0x83: {
        const size = b === 0x80 || b === 0x82 ? 1 : sz;
        const r = this.modrm();
        const a = this.rmRead(size);
        // 0x83 takes an imm8 and sign extends it to the operand size.
        const imm = b === 0x81 ? this.fetchImm(size)
          : b === 0x83 ? (this.fetch8s() & MASK[sz]) : this.fetch8();
        const v = this.alu(r, a, imm, size);
        if (r !== 7) this.rmWrite(size, v);
        return;
      }
      case 0x84: case 0x85: {
        const size = b === 0x84 ? 1 : sz;
        const r = this.modrm();
        this.logic(this.rmRead(size) & this.getR(r, size), size);
        return;
      }
      case 0x86: case 0x87: {
        const size = b === 0x86 ? 1 : sz;
        const r = this.modrm();
        const a = this.rmRead(size);
        this.rmWrite(size, this.getR(r, size));
        this.setR(r, size, a);
        return;
      }
      case 0x88: case 0x89: {
        const size = b === 0x88 ? 1 : sz;
        const r = this.modrm();
        this.rmWrite(size, this.getR(r, size));
        return;
      }
      case 0x8a: case 0x8b: {
        const size = b === 0x8a ? 1 : sz;
        const r = this.modrm();
        this.setR(r, size, this.rmRead(size));
        return;
      }
      case 0x8c: { // mov r/m, sreg
        const r = this.modrm();
        this.rmWrite(2, this.sreg[r & 7]);
        return;
      }
      case 0x8d: { // lea
        const r = this.modrm();
        this.setR(r, sz, this.eaOff);
        return;
      }
      case 0x8e: { // mov sreg, r/m
        const r = this.modrm();
        const v = this.rmRead(2);
        this.sreg[r & 7] = v & 0xffff;
        return;
      }
      case 0x8f: { // pop r/m
        const r = this.modrm();
        this.rmWrite(sz, this.pop(sz));
        return;
      }
      case 0x90:
        return;
      case 0x98:
        if (sz === 2) this.setR(EAX, 2, (this.getR(EAX, 1) << 24) >> 24 & 0xffff);
        else this.r[EAX] = (this.r[EAX] << 24) >> 24 >>> 0;
        return;
      case 0x99:
        if (sz === 2) this.setR(EDX, 2, (this.getR(EAX, 2) & 0x8000) ? 0xffff : 0);
        else this.r[EDX] = (this.r[EAX] & 0x80000000) ? 0xffffffff : 0;
        return;
      case 0x9a: { // call far
        const off = this.fetch16();
        const seg = this.fetch16();
        this.push(this.sreg[SEG_CS], 2);
        this.push(this.ip & 0xffff, 2);
        this.sreg[SEG_CS] = seg;
        this.ip = off;
        return;
      }
      case 0x9b:
        return;
      case 0x9c:
        this.push(this.flags, 2);
        return;
      case 0x9d:
        this.flags = this.pop(2);
        return;
      case 0x9e:
        this.flags = (this.flags & 0xff00) | (this.getR(EAX, 1) & 0xd5) | 2;
        return;
      case 0x9f:
        this.setR(EAX, 1, (this.flags & 0xd5) | 2);
        return;

      case 0xa0: case 0xa1: case 0xa2: case 0xa3: {
        const size = b === 0xa0 || b === 0xa2 ? 1 : sz;
        const off = this.addr32 ? this.fetch32() : this.fetch16();
        const addr = this.dsAddr(off);
        if (b < 0xa2) this.setR(EAX, size, size === 1 ? this.read8(addr) : size === 2 ? this.read16(addr) : this.read32(addr));
        else {
          const v = this.getR(EAX, size);
          if (size === 1) this.write8(addr, v); else if (size === 2) this.write16(addr, v); else this.write32(addr, v);
        }
        return;
      }
      case 0xa4: case 0xa5: { // movs
        const size = b === 0xa4 ? 1 : sz;
        const n = this.rep ? this.getR(ECX, 2) : 1;
        for (let i = 0; i < n; i++) {
          const si = this.r[ESI];
          const v = size === 1 ? this.read8(this.dsAddr(si)) : size === 2 ? this.read16(this.dsAddr(si)) : this.read32(this.dsAddr(si));
          const di = this.r[EDI];
          if (size === 1) this.write8(this.esAddr(di), v); else if (size === 2) this.write16(this.esAddr(di), v); else this.write32(this.esAddr(di), v);
          this.stepPtr(ESI, size);
          this.stepPtr(EDI, size);
        }
        if (this.rep) this.setR(ECX, 2, 0);
        return;
      }
      case 0xa6: case 0xa7: { // cmps
        const size = b === 0xa6 ? 1 : sz;
        const n = this.rep ? this.getR(ECX, 2) : 1;
        for (let i = 0; i < n; i++) {
          const a = size === 1 ? this.read8(this.dsAddr(this.r[ESI])) : size === 2 ? this.read16(this.dsAddr(this.r[ESI])) : this.read32(this.dsAddr(this.r[ESI]));
          const c = size === 1 ? this.read8(this.esAddr(this.r[EDI])) : size === 2 ? this.read16(this.esAddr(this.r[EDI])) : this.read32(this.esAddr(this.r[EDI]));
          this.stepPtr(ESI, size);
          this.stepPtr(EDI, size);
          if (this.rep) this.setR(ECX, 2, (this.getR(ECX, 2) - 1) & 0xffff);
          this.alu(7, a, c, size);
          if (this.rep && ((this.rep === 1 && this.zf === 0) || (this.rep === 2 && this.zf === 1))) break;
        }
        return;
      }
      case 0xa8:
        this.logic(this.getR(EAX, 1) & this.fetch8(), 1);
        return;
      case 0xa9:
        this.logic(this.getR(EAX, sz) & this.fetchImm(sz), sz);
        return;
      case 0xaa: case 0xab: { // stos
        const size = b === 0xaa ? 1 : sz;
        const n = this.rep ? this.getR(ECX, 2) : 1;
        const v = this.getR(EAX, size);
        for (let i = 0; i < n; i++) {
          const di = this.r[EDI];
          if (size === 1) this.write8(this.esAddr(di), v); else if (size === 2) this.write16(this.esAddr(di), v); else this.write32(this.esAddr(di), v);
          this.stepPtr(EDI, size);
        }
        if (this.rep) this.setR(ECX, 2, 0);
        return;
      }
      case 0xac: case 0xad: { // lods
        const size = b === 0xac ? 1 : sz;
        const n = this.rep ? this.getR(ECX, 2) : 1;
        let v = 0;
        for (let i = 0; i < n; i++) {
          const si = this.r[ESI];
          v = size === 1 ? this.read8(this.dsAddr(si)) : size === 2 ? this.read16(this.dsAddr(si)) : this.read32(this.dsAddr(si));
          this.stepPtr(ESI, size);
        }
        this.setR(EAX, size, v);
        if (this.rep) this.setR(ECX, 2, 0);
        return;
      }
      case 0xae: case 0xaf: { // scas
        const size = b === 0xae ? 1 : sz;
        const n = this.rep ? this.getR(ECX, 2) : 1;
        const v = this.getR(EAX, size);
        for (let i = 0; i < n; i++) {
          const c = size === 1 ? this.read8(this.esAddr(this.r[EDI])) : size === 2 ? this.read16(this.esAddr(this.r[EDI])) : this.read32(this.esAddr(this.r[EDI]));
          this.stepPtr(EDI, size);
          if (this.rep) this.setR(ECX, 2, (this.getR(ECX, 2) - 1) & 0xffff);
          this.alu(7, v, c, size);
          if (this.rep && ((this.rep === 1 && this.zf === 0) || (this.rep === 2 && this.zf === 1))) break;
        }
        return;
      }

      case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        const size = (b & 1) ? sz : 1;
        const r = this.modrm();
        let count;
        if (b === 0xc0 || b === 0xc1) count = this.fetch8();
        else if (b === 0xd0 || b === 0xd1) count = 1;
        else count = this.getR(ECX, 1);
        this.rmWrite(size, this.shift(r, this.rmRead(size), count, size));
        return;
      }
      case 0xc2: {
        const n = this.fetch16();
        this.ip = this.pop(2);
        this.setR(ESP, 2, (this.getR(ESP, 2) + n) & 0xffff);
        return;
      }
      case 0xc3:
        this.ip = this.pop(2);
        return;
      case 0xc4: { // les
        const r = this.modrm();
        const off = this.read16(this.ea);
        const seg = this.read16(this.ea + 2);
        this.setR(r, sz, off);
        this.sreg[SEG_ES] = seg;
        return;
      }
      case 0xc5: { // lds
        const r = this.modrm();
        const off = this.read16(this.ea);
        const seg = this.read16(this.ea + 2);
        this.setR(r, sz, off);
        this.sreg[SEG_DS] = seg;
        return;
      }
      case 0xc6: case 0xc7: {
        const size = b === 0xc6 ? 1 : sz;
        const r = this.modrm();
        this.rmWrite(size, this.fetchImm(size));
        return;
      }
      case 0xc8: { // enter
        const size = this.fetch16();
        const level = this.fetch8();
        this.push(this.getR(EBP, 2), 2);
        const frame = this.getR(ESP, 2);
        for (let i = 1; i < level; i++) {
          this.setR(EBP, 2, (this.getR(EBP, 2) - 2) & 0xffff);
          this.push(this.read16(((this.sreg[SEG_SS] << 4) + this.getR(EBP, 2)) & 0xfffff), 2);
        }
        this.push(frame, 2);
        this.setR(EBP, 2, frame);
        this.setR(ESP, 2, (this.getR(ESP, 2) - size) & 0xffff);
        return;
      }
      case 0xc9: { // leave
        this.setR(ESP, 2, this.getR(EBP, 2));
        this.setR(EBP, 2, this.pop(2));
        return;
      }
      case 0xca: {
        const n = this.fetch16();
        this.ip = this.pop(2);
        this.sreg[SEG_CS] = this.pop(2);
        this.setR(ESP, 2, (this.getR(ESP, 2) + n) & 0xffff);
        return;
      }
      case 0xcb:
        this.ip = this.pop(2);
        this.sreg[SEG_CS] = this.pop(2);
        return;
      case 0xcc:
        this.interrupt(3);
        return;
      case 0xcd:
        this.interrupt(this.fetch8());
        return;
      case 0xce:
        if (this.of) this.interrupt(4);
        return;
      case 0xcf:
        this.iret();
        return;
      case 0xd4: { // aam
        const base = this.fetch8();
        const al = this.getR(EAX, 1);
        this.setR(EAX, 2, ((al / base) << 8) | (al % base));
        this.zf = (al % base) === 0 ? 1 : 0;
        this.sf = (al % base) & 0x80 ? 1 : 0;
        this.pf = PARITY[al % base];
        return;
      }
      case 0xd5: { // aad
        const base = this.fetch8();
        const v = ((this.getR(EAX, 1) * base) + (this.getR(EAX, 1) >> 8)) & 0xff;
        this.setR(EAX, 1, v);
        this.zf = v === 0 ? 1 : 0;
        return;
      }
      case 0xd6: // salc
        this.setR(EAX, 1, this.cf ? 0xff : 0);
        return;
      case 0xd7: { // xlat
        const base = this.sreg[this.segOverride >= 0 ? this.segOverride : SEG_DS];
        const addr = ((base << 4) + ((this.getR(EBX, 2) + this.getR(EAX, 1)) & 0xffff)) & 0xfffff;
        this.setR(EAX, 1, this.read8(addr));
        return;
      }
      case 0xe0: case 0xe1: case 0xe2: { // loopne / loope / loop
        const rel = this.fetch8s();
        const cx = (this.getR(ECX, 2) - 1) & 0xffff;
        this.setR(ECX, 2, cx);
        let take = cx !== 0;
        if (b === 0xe0) take = take && this.zf === 0;
        if (b === 0xe1) take = take && this.zf === 1;
        if (take) this.jumpRel(rel);
        return;
      }
      case 0xe3: { // jcxz / jecxz
        const rel = this.fetch8s();
        const zero = sz === 4 ? this.r[ECX] === 0 : this.getR(ECX, 2) === 0;
        if (zero) this.jumpRel(rel);
        return;
      }
      case 0xe4: case 0xe5: {
        const port = this.fetch8();
        this.setR(EAX, b === 0xe4 ? 1 : this.opsz, this.in(port, b === 0xe4 ? 1 : this.opsz));
        return;
      }
      case 0xe6: case 0xe7: {
        const port = this.fetch8();
        this.out(port, b === 0xe6 ? 1 : this.opsz, this.getR(EAX, b === 0xe6 ? 1 : this.opsz));
        return;
      }
      case 0xe8: {
        const rel = this.fetchImms(sz);
        this.push(this.ip & 0xffff, 2);
        this.jumpRel(rel);
        return;
      }
      case 0xe9: {
        const rel = this.fetchImms(sz);
        this.jumpRel(rel);
        return;
      }
      case 0xea: {
        const off = this.fetch16();
        const seg = this.fetch16();
        this.sreg[SEG_CS] = seg;
        this.ip = off;
        return;
      }
      case 0xeb: {
        const rel = this.fetch8s();
        this.jumpRel(rel);
        return;
      }
      case 0xec: case 0xed: {
        this.setR(EAX, b === 0xec ? 1 : this.opsz, this.in(this.getR(EDX, 2), b === 0xec ? 1 : this.opsz));
        return;
      }
      case 0xee: case 0xef: {
        this.out(this.getR(EDX, 2), b === 0xee ? 1 : this.opsz, this.getR(EAX, b === 0xee ? 1 : this.opsz));
        return;
      }
      case 0xf4:
        this.halted = true;
        return;
      case 0xf5:
        this.cf = this.cf ? 0 : 1;
        return;
      case 0xf6: case 0xf7: {
        const size = b === 0xf6 ? 1 : sz;
        const r = this.modrm();
        if (r === 0 || r === 1) { // test
          this.logic(this.rmRead(size) & this.fetchImm(size), size);
        } else if (r === 2) {
          this.rmWrite(size, ~this.rmRead(size) & MASK[size]);
        } else if (r === 3) {
          const v = this.rmRead(size);
          this.rmWrite(size, this.alu(5, 0, v, size));
        } else if (r === 4) {
          this.mul(this.rmRead(size), size);
        } else if (r === 5) {
          this.imul1(this.rmRead(size), size);
        } else if (r === 6) {
          this.div(this.rmRead(size), size, false);
        } else {
          this.div(this.rmRead(size), size, true);
        }
        return;
      }
      case 0xf8:
        this.cf = 0;
        return;
      case 0xf9:
        this.cf = 1;
        return;
      case 0xfa:
        this.if = 0;
        return;
      case 0xfb:
        this.if = 1;
        return;
      case 0xfc:
        this.df = 0;
        return;
      case 0xfd:
        this.df = 1;
        return;
      case 0xfe: { // inc/dec r/m8
        const r = this.modrm();
        const v = this.rmRead(1);
        this.rmWrite(1, this.incdec(v, 1, r === 0 ? 1 : -1));
        return;
      }
      case 0xff: { // group 5
        const r = this.modrm();
        const size = this.opsz;
        if (r === 0 || r === 1) {
          this.rmWrite(size, this.incdec(this.rmRead(size), size, r === 0 ? 1 : -1));
        } else if (r === 2) { // call near
          const target = this.rmRead(size);
          this.push(this.ip & 0xffff, 2);
          this.ip = target & 0xffff;
        } else if (r === 3) { // call far
          const off = this.read16(this.ea);
          const seg = this.read16(this.ea + 2);
          this.push(this.sreg[SEG_CS], 2);
          this.push(this.ip & 0xffff, 2);
          this.sreg[SEG_CS] = seg;
          this.ip = off;
        } else if (r === 4) {
          this.ip = this.rmRead(size) & 0xffff;
        } else if (r === 5) { // jmp far
          const off = this.read16(this.ea);
          const seg = this.read16(this.ea + 2);
          this.sreg[SEG_CS] = seg;
          this.ip = off;
        } else if (r === 6) {
          this.push(this.rmRead(size), size);
        } else {
          throw new Unsupported('ff/7', this);
        }
        return;
      }
      default:
        throw new Unsupported('0x' + b.toString(16), this);
    }
  }

  opcode0f() {
    const b = this.fetch8();
    const sz = this.opsz;

    if (b >= 0x80 && b <= 0x8f) { // jcc rel16/32
      const rel = this.fetchImms(sz);
      if (this.cond(b & 15)) this.jumpRel(rel);
      return;
    }
    if (b >= 0x40 && b <= 0x4f) { // cmovcc
      const r = this.modrm();
      const v = this.rmRead(sz);
      if (this.cond(b & 15)) this.setR(r, sz, v);
      return;
    }
    if (b >= 0x90 && b <= 0x9f) { // setcc
      this.modrm();
      this.rmWrite(1, this.cond(b & 15) ? 1 : 0);
      return;
    }
    if (b >= 0xc8 && b <= 0xcf) { // bswap
      let v = this.r[b & 7];
      v = ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff);
      this.r[b & 7] = v >>> 0;
      return;
    }

    switch (b) {
      case 0x00: { // sldt/str/lldt/ltr/verr/verw
        const r = this.modrm();
        this.rmWrite(2, 0);
        return;
      }
      case 0x01: { // sgdt/sidt/lgdt/lidt/smsw/lmsw/invlpg
        const r = this.modrm();
        if (r === 4) { this.rmWrite(2, 0); return; }
        if (r === 6) { this.rmWrite(2, 0); return; }
        if (r === 0 || r === 1) { this.rmWrite(2, 0xffff); return; }
        return;
      }
      case 0x02: case 0x03: { // lar / lsl
        const r = this.modrm();
        this.rmRead(2);
        if (this.cond(4)) this.setR(r, sz, 0xffff);
        return;
      }
      case 0x20: case 0x22: { // mov r32, cr / cr, r32
        this.modrm();
        return;
      }
      case 0x31: { // rdtsc
        const t = this.insts * 3;
        this.r[EAX] = t >>> 0;
        this.r[EDX] = Math.floor(t / 4294967296) >>> 0;
        return;
      }
      case 0xa0: this.push(this.sreg[SEG_FS], 2); return;
      case 0xa1: this.sreg[SEG_FS] = this.pop(2); return;
      case 0xa2: { // cpuid
        const leaf = this.r[EAX];
        if (leaf === 0) {
          this.r[EAX] = 1;
          this.r[EBX] = 0x756e6547; // Genu
          this.r[EDX] = 0x49656e69; // ineI
          this.r[ECX] = 0x6c65746e; // ntel
        } else {
          this.r[EAX] = 0x00000543; // family 5, model 4, stepping 3
          this.r[EBX] = 0;
          this.r[ECX] = 0;
          this.r[EDX] = 0x000001bf;
        }
        return;
      }
      case 0xa3: { // bt
        const r = this.modrm();
        const v = this.rmRead(sz);
        this.cf = (v >> (this.getR(r, sz) & (sz * 8 - 1))) & 1;
        return;
      }
      case 0xa4: case 0xa5: { // shld (0xa4: count imm8, 0xa5: count CL; both use the operand size)
        const size = sz;
        const r = this.modrm();
        const dst = this.rmRead(size);
        const src = this.getR(r, size);
        const count = (b === 0xa4 ? this.fetch8() : this.getR(ECX, 1)) & 0x1f;
        const bits = size * 8;
        let res = dst;
        for (let i = 0; i < count; i++) {
          this.cf = (res & SIGN[size]) ? 1 : 0;
          res = ((res << 1) | ((src >> (bits - 1 - i)) & 1)) & MASK[size];
        }
        if (count) { const cf = this.cf; this.logic(res, size); this.cf = cf; this.rmWrite(size, res); }
        return;
      }
      case 0xab: case 0xbb: case 0xb3: { // bts / btc / btr
        const r = this.modrm();
        const v = this.rmRead(sz);
        const bit = this.getR(r, sz) & (sz * 8 - 1);
        this.cf = (v >> bit) & 1;
        let nv = v;
        if (b === 0xab) nv = v | (1 << bit);
        else if (b === 0xb3) nv = v & ~(1 << bit);
        else nv = v ^ (1 << bit);
        this.rmWrite(sz, nv);
        return;
      }
      case 0xac: case 0xad: { // shrd (same: 0xac is the imm8 form, not a byte operation)
        const size = sz;
        const r = this.modrm();
        const dst = this.rmRead(size);
        const src = this.getR(r, size);
        const count = (b === 0xac ? this.fetch8() : this.getR(ECX, 1)) & 0x1f;
        let res = dst;
        for (let i = 0; i < count; i++) {
          this.cf = res & 1;
          res = ((res >>> 1) | (((src >> i) & 1) << (size * 8 - 1))) & MASK[size];
        }
        if (count) { const cf = this.cf; this.logic(res, size); this.cf = cf; this.rmWrite(size, res); }
        return;
      }
      case 0xa8: this.push(this.sreg[SEG_GS], 2); return;
      case 0xa9: this.sreg[SEG_GS] = this.pop(2); return;
      case 0xaf: { // imul r, r/m
        const r = this.modrm();
        const a = this.getR(r, sz);
        const bv = this.rmRead(sz);
        const res = sz === 2 ? Math.imul((a << 16) >> 16, (bv << 16) >> 16) : Math.imul(a | 0, bv | 0);
        this.setR(r, sz, res);
        const full = sz === 2 ? ((a << 16) >> 16) * ((bv << 16) >> 16) : (a | 0) * (bv | 0);
        this.cf = this.of = (full === (sz === 2 ? (full << 16) >> 16 : full | 0)) ? 0 : 1;
        return;
      }
      case 0xb0: case 0xb1: { // cmpxchg
        const size = b === 0xb0 ? 1 : sz;
        const r = this.modrm();
        const dst = this.rmRead(size);
        const acc = this.getR(EAX, size);
        this.alu(7, acc, dst, size);
        if (acc === dst) this.rmWrite(size, this.getR(r, size));
        else this.setR(EAX, size, dst);
        return;
      }
      case 0xb2: case 0xb4: case 0xb5: { // lss / lfs / lgs
        const r = this.modrm();
        const off = this.read16(this.ea);
        const seg = this.read16(this.ea + 2);
        this.setR(r, sz, off);
        if (b === 0xb2) this.sreg[SEG_SS] = seg;
        else if (b === 0xb4) this.sreg[SEG_FS] = seg;
        else this.sreg[SEG_GS] = seg;
        return;
      }
      case 0xb6: case 0xb7: { // movzx
        const size = sz;
        const r = this.modrm();
        const v = this.rmRead(b === 0xb6 ? 1 : 2);
        this.setR(r, size, v);
        return;
      }
      case 0xba: { // bt group with imm8
        const r = this.modrm();
        const bit = this.fetch8() & (this.opsz * 8 - 1);
        const v = this.rmRead(this.opsz);
        this.cf = (v >> bit) & 1;
        if (r === 5) this.rmWrite(this.opsz, v | (1 << bit));
        else if (r === 6) this.rmWrite(this.opsz, v ^ (1 << bit));
        else if (r === 7) this.rmWrite(this.opsz, v & ~(1 << bit));
        return;
      }
      case 0xbc: case 0xbd: { // bsf / bsr
        const r = this.modrm();
        const v = this.rmRead(sz);
        if (v === 0) { this.zf = 1; return; }
        this.zf = 0;
        let i = 0;
        if (b === 0xbc) {
          while (((v >>> i) & 1) === 0) i++;
        } else {
          i = sz * 8 - 1;
          while (((v >>> i) & 1) === 0) i--;
        }
        this.setR(r, sz, i);
        return;
      }
      case 0xbe: case 0xbf: { // movsx
        const r = this.modrm();
        if (b === 0xbe) {
          const v = (this.rmRead(1) << 24) >> 24;
          this.setR(r, sz, v & MASK[sz]);
        } else {
          const v = (this.rmRead(2) << 16) >> 16;
          this.setR(r, sz, v & MASK[sz]);
        }
        return;
      }
      case 0xc0: case 0xc1: { // xadd
        const size = b === 0xc0 ? 1 : sz;
        const r = this.modrm();
        const dst = this.rmRead(size);
        const src = this.getR(r, size);
        this.rmWrite(size, this.alu(0, dst, src, size));
        this.setR(r, size, dst);
        return;
      }
      default:
        throw new Unsupported('0f ' + b.toString(16), this);
    }
  }

  // ------------------------------------------------------------------- I/O

  in(port, size) {
    if (!this.bus) return size === 1 ? 0xff : 0xffff;
    return size === 1 ? this.bus.in8(port & 0xffff) : size === 2 ? this.bus.in16(port & 0xffff) : this.bus.in32(port & 0xffff);
  }

  out(port, size, v) {
    if (!this.bus) return;
    if (size === 1) this.bus.out8(port & 0xffff, v & 0xff);
    else if (size === 2) this.bus.out16(port & 0xffff, v & 0xffff);
    else this.bus.out32(port & 0xffff, v >>> 0);
  }

  // ------------------------------------------------------- address helpers

  dsAddr(off) {
    const seg = this.segOverride >= 0 ? this.segOverride : SEG_DS;
    return ((this.sreg[seg] << 4) + (off & 0xffff)) & 0xfffff;
  }

  esAddr(off) {
    return ((this.sreg[SEG_ES] << 4) + (off & 0xffff)) & 0xfffff;
  }

  stepPtr(i, size) {
    // the string pointer moves by the operand size; it is a 32 bit register only
    // under a 0x67 prefix, otherwise SI/DI wrap at 64 K and the high half stays
    const d = this.df ? -size : size;
    if (this.addr32) this.r[i] = (this.r[i] + d) >>> 0;
    else this.setR(i, 2, (this.getR(i, 2) + d) & 0xffff);
  }
}

export { EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI, SEG_ES, SEG_CS, SEG_SS, SEG_DS, SEG_FS, SEG_GS };
