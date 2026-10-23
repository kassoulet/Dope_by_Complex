/*
 * dope/jit.js -- a dynamic recompiler for the x86 interpreter.
 *
 * The interpreter in x86.js decodes every instruction every time it runs, which
 * costs about 100 ns each.  The parts spend nearly all their time in a few
 * tight loops, so this turns each basic block into a JavaScript function the
 * first time it is reached: registers live in local variables, ModRM is decoded
 * once, a flag is computed only if something later in the block (or the block's
 * successor) can read it, and a block that jumps back to its own start loops
 * inside the function.
 *
 * What it does not cover it hands back: a block ends before any instruction it
 * cannot translate and the dispatcher runs that one instruction through the
 * interpreter, so coverage can grow without the translator ever being wrong
 * about the rest.  Software interrupts, `iret`, far calls, `mul`/`div` and the
 * like stay in the interpreter (the machine hooks the first group).
 *
 * Self-modifying code is real here: part 2's texture loop patches the
 * immediates of its own `add ecx,imm`.  Every byte of a translated block is
 * marked in `prot`; a store to a marked byte, from translated or interpreted
 * code, drops the blocks that contain it.
 *
 * tests/test_jit.mjs runs every part both ways and compares registers, flags
 * and memory after each run.
 */

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let b = i, p = 1;
  while (b) { p ^= b & 1; b >>= 1; }
  PARITY[i] = p;
}

const FC = 1, FP = 2, FA = 4, FZ = 8, FS = 16, FO = 32, FALL = 63;
const MAXLEN = 48; // instructions per block

const MASK = { 1: '255', 2: '65535', 4: '4294967295' };
const SIGN = { 1: '128', 2: '32768', 4: '2147483648' };
const BITS = { 1: 8, 2: 16, 4: 32 };
const MASK_N = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };

class Unsupported extends Error {}

// ---------------------------------------------------------------- registers
// Locals r0..r7 hold the registers as int32; a read of a narrower part yields
// an unsigned number, a write merges into the register.

const rd = (i, size) => size === 4 ? `(r${i}>>>0)` : size === 2 ? `(r${i}&65535)`
  : (i < 4 ? `(r${i}&255)` : `((r${i & 3}>>>8)&255)`);
const wr = (i, size, v) => size === 4 ? `r${i}=(${v})|0;` : size === 2 ? `r${i}=(r${i}&-65536)|((${v})&65535);`
  : (i < 4 ? `r${i}=(r${i}&-256)|((${v})&255);` : `r${i & 3}=(r${i & 3}&-65281)|(((${v})&255)<<8);`);

// ------------------------------------------------------------------- memory
// `e` is a linear address.  Reads and writes in A0000..AFFFF go to the card.
// A write value `v` must be a plain variable (it is repeated per byte).

const lin = (seg, off) => `(((S[${seg}]<<4)+(${off}))&1048575)`;
const rdMem = (e, size) => size === 1 ? `(${e}<655360?mem[${e}]:C.read8(${e}))`
  : size === 2 ? `(${e}<655359?(mem[${e}]|(mem[${e}+1]<<8)):C.read16(${e}))`
    : `(${e}<655357?((mem[${e}]|(mem[${e}+1]<<8)|(mem[${e}+2]<<16)|(mem[${e}+3]<<24))>>>0):C.read32(${e}))`;
const wrMem = (e, v, size) => size === 1
  ? `if(${e}<655360){mem[${e}]=${v};if(CM[${e}])J.smc(${e},1);}else C.write8(${e},${v});`
  : size === 2
    ? `if(${e}<655359){mem[${e}]=${v};mem[${e}+1]=${v}>>8;if(CM[${e}]|CM[${e}+1])J.smc(${e},2);}else C.write16(${e},${v});`
    : `if(${e}<655357){mem[${e}]=${v};mem[${e}+1]=${v}>>8;mem[${e}+2]=${v}>>16;mem[${e}+3]=${v}>>>24;if(CM[${e}]|CM[${e}+1]|CM[${e}+2]|CM[${e}+3])J.smc(${e},4);}else C.write32(${e},${v});`;

// ------------------------------------------------------------------- flags
// Helpers return code that sets exactly the flags in `live`: those a later
// instruction, or the exit of the block, may read.

function setZSP(res, size, live) {
  let c = '';
  if (live & FZ) c += `zf=(${res})===0?1:0;`;
  if (live & FS) c += `sf=((${res})&${SIGN[size]})?1:0;`;
  if (live & FP) c += `pf=PAR[(${res})&255];`;
  return c;
}

/** add/or/adc/sbb/and/sub/xor/cmp (op 0..7); A and B name variables holding unsigned values; result in `res` */
function aluCode(op, size, A, B, live) {
  const M = MASK[size], S = SIGN[size];
  const norm = size === 4 ? '>>>0' : `&${M}`;
  let c = '';
  switch (op) {
    case 0: case 2:
      c += op === 2 ? `t=${A}+${B}+cf;` : `t=${A}+${B};`;
      c += `res=t${norm};`;
      if (live & FC) c += `cf=t>${M}?1:0;`;
      if (live & FO) c += `of=((${A}^res)&(${B}^res)&${S})?1:0;`;
      break;
    case 5: case 3: case 7:
      c += op === 3 ? `t=${A}-${B}-cf;` : `t=${A}-${B};`;
      c += `res=t${norm};`;
      if (live & FC) c += 't<0?(cf=1):(cf=0);';
      if (live & FO) c += `of=((${A}^${B})&(${A}^res)&${S})?1:0;`;
      break;
    case 1: c += `res=(${A}|${B})${norm};`; if (live & FC) c += 'cf=0;'; if (live & FO) c += 'of=0;'; break;
    case 4: c += `res=(${A}&${B})${norm};`; if (live & FC) c += 'cf=0;'; if (live & FO) c += 'of=0;'; break;
    case 6: c += `res=(${A}^${B})${norm};`; if (live & FC) c += 'cf=0;'; if (live & FO) c += 'of=0;'; break;
    default: throw new Unsupported('alu');
  }
  if (live & FA) c += `af=((${A}^${B}^res)&16)?1:0;`;
  return c + setZSP('res', size, live);
}

const aluReads = (op) => (op === 2 || op === 3 ? FC : 0);

// flags each condition code reads
const CC_FLAGS = [FO, FO, FC, FC, FZ, FZ, FC | FZ, FC | FZ, FS, FS, FP, FP, FS | FO, FS | FO, FZ | FS | FO, FZ | FS | FO];

function condCode(cc) {
  switch (cc) {
    case 0: return 'of===1'; case 1: return 'of===0';
    case 2: return 'cf===1'; case 3: return 'cf===0';
    case 4: return 'zf===1'; case 5: return 'zf===0';
    case 6: return '(cf===1||zf===1)'; case 7: return '(cf===0&&zf===0)';
    case 8: return 'sf===1'; case 9: return 'sf===0';
    case 10: return 'pf===1'; case 11: return 'pf===0';
    case 12: return 'sf!==of'; case 13: return 'sf===of';
    case 14: return '(zf===1||sf!==of)'; default: return '(zf===0&&sf===of)';
  }
}

// where a block writes back its registers and flags; build() replaces it with the stores this block needs
const STORE = '/*STORE*/';

/** conditional jump that ends a block (looping inside it when it goes back to the block start) */
function jump(cond, pre, target, next, ctx) {
  if (ctx.selfLoop && target === ctx.ip0) {
    return `${pre}n+=${ctx.n};if((${cond})&&(budget-=${ctx.n})>0)continue;C.ip=(${cond})?${target}:${next};${STORE}return n;`;
  }
  return `${pre}C.ip=(${cond})?${target}:${next};${STORE}return n;`;
}
const goto = (target) => `C.ip=${target};${STORE}return n;`;

// ------------------------------------------------------------------ shifts

function shiftCode(sop, size, live) {
  const M = MASK[size], S = SIGN[size], bits = BITS[size];
  const norm = size === 4 ? '>>>0' : `&${M}`;
  let c = 'if(count===0){res=a;}else{';
  switch (sop) {
    case 4: // shl
      c += `res=count>=${bits}?0:((a<<count)${norm});`;
      if (live & (FC | FO)) c += `cf=count<=${bits}?((a>>>(${bits}-count))&1):0;`;
      if (live & FO) c += `of=((res&${S})?1:0)^cf;`;
      break;
    case 5: // shr
      c += `res=count>=${bits}?0:(a>>>count);`;
      if (live & FC) c += `cf=count<=${bits}?((a>>>(count-1))&1):0;`;
      if (live & FO) c += `of=(a&${S})?1:0;`;
      break;
    case 7: // sar
      c += size === 4 ? 'res=(((a|0)>>count)>>>0);' : `res=(((a<<${32 - bits})>>${32 - bits})>>count)&${M};`;
      if (live & FC) c += size === 4 ? 'cf=((a|0)>>(count-1))&1;' : `cf=(((a<<${32 - bits})>>${32 - bits})>>(count-1))&1;`;
      if (live & FO) c += 'of=0;';
      break;
    case 0: // rol
      c += `x=count%${bits};res=x===0?a:(((a<<x)|(a>>>(${bits}-x)))${norm});`;
      if (live & FC) c += 'cf=res&1;';
      if (live & FO) c += `of=((res&${S})?1:0)^(res&1);`;
      break;
    case 1: // ror
      c += `x=count%${bits};res=x===0?a:(((a>>>x)|(a<<(${bits}-x)))${norm});`;
      if (live & FC) c += `cf=(res&${S})?1:0;`;
      if (live & FO) c += `of=((res&${S})?1:0)^((res&${SIGN[size] / 2})?1:0);`;
      break;
    default: throw new Unsupported('shift');
  }
  c += '}';
  if (sop >= 4) c += `if(count!==0){${setZSP('res', size, live)}}`;
  return c;
}

// mul/imul/div/idiv r/m (f7 /4../7) for 16 and 32 bit operands
function mulDivCode(m, size) {
  const src = m.isReg ? rd(m.rm, size) : rdMem('e', size);
  let c = `${m.ea}b=${src};`;
  if (size === 4) {
    switch (m.reg) {
      case 4: return c + 'a=r0>>>0;res=Math.imul(a,b);r2=J.hiu(a,b)|0;r0=res|0;cf=of=r2!==0?1:0;';
      case 5: return c + 'a=r0|0;b=b|0;res=Math.imul(a,b);r2=J.his(a,b);r0=res|0;cf=of=r2!==(res>>31)?1:0;';
      case 6: return c + 'if(b===0)J.fault();y=J.div64(r2,r0,b,false);r0=y|0;r2=J.rem|0;';
      default: return c + 'b=b|0;if(b===0)J.fault();y=J.div64(r2,r0,b,true);r0=y|0;r2=J.rem|0;';
    }
  }
  switch (m.reg) {
    case 4: return c + 'res=(r0&65535)*b;r0=(r0&-65536)|(res&65535);r2=(r2&-65536)|((res>>>16)&65535);cf=of=(res>>>16)?1:0;';
    case 5: return c + 'res=((r0<<16)>>16)*((b<<16)>>16);r0=(r0&-65536)|(res&65535);r2=(r2&-65536)|((res>>16)&65535);cf=of=(res<-32768||res>32767)?1:0;';
    case 6: return c + 'if(b===0)J.fault();a=(((r2&65535)<<16)|(r0&65535))>>>0;r0=(r0&-65536)|(Math.floor(a/b)&65535);r2=(r2&-65536)|((a%b)&65535);';
    default: return c + 'b=(b<<16)>>16;if(b===0)J.fault();a=((r2&65535)<<16)|(r0&65535);r0=(r0&-65536)|(Math.trunc(a/b)&65535);r2=(r2&-65536)|((a%b)&65535);';
  }
}

// ----------------------------------------------------------------- decoder

/**
 * Decode one instruction at csBase+ip0 into
 *   { len, reads, writes, end, gen(live, ctx) -> code, loopTo? }
 * `reads`/`writes` are flag masks.  Throws Unsupported for anything else.  The
 * generated code may use the temporaries t res a b e x y k count.
 */
function decodeOne(mem, csBase, ip0, vol, blockIp) {
  let ip = ip0;
  const byte = () => { const v = mem[(csBase + ip) & 0xfffff]; ip = (ip + 1) & 0xffff; return v; };
  let opsz = 2, addr32 = false, segOv = -1, rep = 0;
  let op;
  for (;;) {
    op = byte();
    if (op === 0x66) opsz = 4;
    else if (op === 0x67) addr32 = true;
    else if (op === 0x26) segOv = 0;
    else if (op === 0x2e) segOv = 1;
    else if (op === 0x36) segOv = 2;
    else if (op === 0x3e) segOv = 3;
    else if (op === 0x64) segOv = 4;
    else if (op === 0x65) segOv = 5;
    else if (op === 0xf2) rep = 2;
    else if (op === 0xf3) rep = 1;
    else if (op === 0xf0) { /* lock */ } else break;
  }
  const sz = opsz;
  const imm8 = () => byte();
  const imm8s = () => { const v = byte(); return v < 128 ? v : v - 256; };
  const imm16 = () => { const lo = byte(); return lo | (byte() << 8); };
  const imm32 = () => { const lo = imm16(); return ((lo | (imm16() << 16)) >>> 0); };
  const immN = (size) => size === 1 ? imm8() : size === 2 ? imm16() : imm32();
  const mk = (o) => ({ len: (ip - ip0) & 0xffff, reads: 0, writes: 0, end: false, ...o, ...(immAt >= 0 ? { immOff: (immAt - ip0) & 0xffff, immLen, dyn: immDyn } : {}) });
  // An immediate that the part is known to patch (a store hit it before) is
  // read from memory when the block runs, so patching it costs no recompile.
  let immAt = -1, immLen = 0, immDyn = false;
  const field = (size, signed) => { // read an immediate field; returns [value, expression for it]
    const at = ip;
    const addr = (csBase + at) & 0xfffff;
    const dyn = vol && vol.has(addr);
    let v;
    if (size === 1) v = signed ? imm8s() : imm8();
    else if (size === 2) v = imm16();
    else v = imm32();
    immAt = at; immLen = size; immDyn = !!dyn;
    return [v, dyn ? dynRead(addr, size, signed) : null];
  };
  const dynRead = (a, size, signed) => size === 1
    ? (signed ? `((mem[${a}]<<24)>>24)` : `mem[${a}]`)
    : size === 2 ? `(mem[${a}]|(mem[${a + 1}]<<8))`
      : `((mem[${a}]|(mem[${a + 1}]<<8)|(mem[${a + 2}]<<16)|(mem[${a + 3}]<<24))>>>0)`;

  // ModRM: { reg, isReg, rm, ea } where `ea` is code that sets `e` to the linear address
  const modrm = () => {
    const m = byte();
    const mod = m >> 6, reg = (m >> 3) & 7, rm = m & 7;
    if (mod === 3) return { reg, isReg: true, rm, ea: '', off: '' };
    let off, full, dseg = 3;
    if (!addr32) {
      const R16 = (i) => `(r${i}&65535)`;
      switch (rm) {
        case 0: off = `${R16(3)}+${R16(6)}`; break;
        case 1: off = `${R16(3)}+${R16(7)}`; break;
        case 2: off = `${R16(5)}+${R16(6)}`; dseg = 2; break;
        case 3: off = `${R16(5)}+${R16(7)}`; dseg = 2; break;
        case 4: off = R16(6); break;
        case 5: off = R16(7); break;
        case 6: if (mod === 0) off = String(imm16()); else { off = R16(5); dseg = 2; } break;
        default: off = R16(3);
      }
      if (mod === 1) off += `+${imm8s()}`;
      else if (mod === 2) off += `+${imm16()}`;
      full = `((${off})&65535)`;
      off = full;
    } else {
      let base = '0', index = '';
      if (rm === 4) {
        const sib = byte();
        const scale = sib >> 6, idx = (sib >> 3) & 7, bas = sib & 7;
        if (idx !== 4) index = scale ? `+(r${idx}<<${scale})` : `+r${idx}`;
        if (bas === 5 && mod === 0) base = String(imm32() | 0);
        else { base = `r${bas}`; if (bas === 5) dseg = 2; }
      } else if (rm === 5 && mod === 0) base = String(imm32() | 0);
      else { base = `r${rm}`; if (rm === 5) dseg = 2; }
      off = `(${base}${index}`;
      if (mod === 1) off += `+${imm8s()}`;
      else if (mod === 2) off += `+${imm32() | 0}`;
      off += ')';
      full = `(${off}|0)`; // lea wants all 32 bits
      off = `(${off}&65535)`; // real mode memory wraps at 64 K
    }
    const seg = segOv >= 0 ? segOv : dseg;
    return { reg, isReg: false, rm, ea: `e=${lin(seg, off)};`, full };
  };
  const rmGet = (m, size) => m.isReg ? rd(m.rm, size) : rdMem('e', size);
  const rmSet = (m, size, v) => m.isReg ? wr(m.rm, size, v) : wrMem('e', v, size);

  // stack
  const push = (v, size) => size === 2
    ? `r4=(r4&-65536)|((r4-2)&65535);e=${lin(2, '(r4&65535)')};${wrMem('e', v, 2)}`
    : `r4=(r4-4)|0;e=${lin(2, '(r4&65535)')};${wrMem('e', v, 4)}`;
  const pop = (size) => size === 2
    ? `e=${lin(2, '(r4&65535)')};x=${rdMem('e', 2)};r4=(r4&-65536)|((r4+2)&65535);`
    : `e=${lin(2, '(r4&65535)')};x=${rdMem('e', 4)}|0;r4=(r4+4)|0;`;

  // ---- ALU, 00..3f
  if (op < 0x40 && (op & 7) < 6) {
    const aop = op >> 3;
    const form = op & 7;
    const size = (op & 1) ? sz : 1;
    if (form < 4) {
      const m = modrm();
      const toRm = form < 2;
      const R = rd(m.reg, size);
      return mk({
        reads: aluReads(aop), writes: FALL,
        gen: (live) => {
          let c = m.ea;
          c += toRm ? `a=${rmGet(m, size)};b=${R};` : `a=${R};b=${rmGet(m, size)};`;
          c += aluCode(aop, size, 'a', 'b', live);
          if (aop !== 7) c += toRm ? rmSet(m, size, 'res') : wr(m.reg, size, 'res');
          return c;
        },
      });
    }
    const [imm, dynImm] = field(size, false);
    return mk({
      reads: aluReads(aop), writes: FALL,
      gen: (live) => `a=${rd(0, size)};b=${dynImm ?? imm};${aluCode(aop, size, 'a', 'b', live)}${aop === 7 ? '' : wr(0, size, 'res')}`,
    });
  }

  // ---- inc/dec/push/pop register
  if (op >= 0x40 && op < 0x50) {
    const i = op & 7, dec = op >= 0x48;
    return mk({
      writes: FALL & ~FC,
      gen: (live) => {
        const M = MASK[sz], S = SIGN[sz];
        let c = `a=${rd(i, sz)};res=(a${dec ? '-1' : '+1'})${sz === 4 ? '>>>0' : '&' + M};`;
        if (live & FO) c += dec ? `of=a===${S}?1:0;` : `of=a===${M}?1:0;`;
        if (live & FA) c += 'af=((a^res)&16)?1:0;';
        return c + setZSP('res', sz, live) + wr(i, sz, 'res');
      },
    });
  }
  if (op >= 0x50 && op < 0x58) { const i = op & 7; return mk({ gen: () => `x=${rd(i, sz)};${push('x', sz)}` }); }
  if (op >= 0x58 && op < 0x60) { const i = op & 7; return mk({ gen: () => pop(sz) + (i === 4 ? '' : wr(i, sz, 'x')) }); }
  if (op === 0x06 || op === 0x0e || op === 0x16 || op === 0x1e) {
    const s = { 0x06: 0, 0x0e: 1, 0x16: 2, 0x1e: 3 }[op];
    return mk({ gen: () => `x=S[${s}];${push('x', 2)}` });
  }
  if (op === 0x07 || op === 0x17 || op === 0x1f) {
    const s = { 0x07: 0, 0x17: 2, 0x1f: 3 }[op];
    return mk({ gen: () => pop(2) + `S[${s}]=x;` });
  }
  if (op === 0x68) { const v = immN(sz); return mk({ gen: () => `x=${sz === 4 ? v | 0 : v};${push('x', sz)}` }); }
  if (op === 0x6a) { const v = imm8s(); return mk({ gen: () => `x=${v};${push('x', sz)}` }); }

  // ---- mov
  if (op === 0x88 || op === 0x89) {
    const size = op & 1 ? sz : 1;
    const m = modrm();
    return mk({ gen: () => `${m.ea}x=${rd(m.reg, size)};${rmSet(m, size, 'x')}` });
  }
  if (op === 0x8a || op === 0x8b) {
    const size = op & 1 ? sz : 1;
    const m = modrm();
    return mk({ gen: () => `${m.ea}x=${rmGet(m, size)};${wr(m.reg, size, 'x')}` });
  }
  if (op === 0x8c) {
    const m = modrm();
    if (m.reg > 5) throw new Unsupported('sreg');
    return mk({ gen: () => `${m.ea}x=S[${m.reg}];${rmSet(m, 2, 'x')}` });
  }
  if (op === 0x8e) {
    const m = modrm();
    if (m.reg > 5 || m.reg === 1) throw new Unsupported('sreg');
    return mk({ gen: () => `${m.ea}S[${m.reg}]=${rmGet(m, 2)};` });
  }
  if (op >= 0xb0 && op < 0xb8) { const i = op & 7; const v = imm8(); return mk({ gen: () => wr(i, 1, String(v)) }); }
  if (op >= 0xb8 && op < 0xc0) { const i = op & 7; const [v, dv] = field(sz, false); return mk({ gen: () => wr(i, sz, dv ?? String(sz === 4 ? v | 0 : v)) }); }
  if (op === 0xc6 || op === 0xc7) {
    const size = op & 1 ? sz : 1;
    const m = modrm();
    if (m.reg !== 0) throw new Unsupported('c6/c7');
    const v = immN(size);
    return mk({ gen: () => `${m.ea}x=${size === 4 ? v | 0 : v};${rmSet(m, size, 'x')}` });
  }
  if (op >= 0xa0 && op <= 0xa3) {
    const size = op & 1 ? sz : 1;
    const off = addr32 ? imm32() : imm16();
    const seg = segOv >= 0 ? segOv : 3;
    const e = lin(seg, String(off & 0xffff));
    if (op < 0xa2) return mk({ gen: () => `e=${e};x=${rdMem('e', size)};${wr(0, size, 'x')}` });
    return mk({ gen: () => `e=${e};x=${rd(0, size)};${wrMem('e', 'x', size)}` });
  }
  if (op === 0x8d) {
    const m = modrm();
    if (m.isReg) throw new Unsupported('lea reg');
    return mk({ gen: () => `x=${m.full};${wr(m.reg, sz, 'x')}` });
  }
  if (op === 0x86 || op === 0x87) {
    const size = op & 1 ? sz : 1;
    const m = modrm();
    return mk({ gen: () => `${m.ea}a=${rmGet(m, size)};b=${rd(m.reg, size)};${rmSet(m, size, 'b')}${wr(m.reg, size, 'a')}` });
  }
  if (op === 0x90 && !rep) return mk({ gen: () => '' });
  if (op > 0x90 && op < 0x98) { const i = op & 7; return mk({ gen: () => `a=${rd(0, sz)};b=${rd(i, sz)};${wr(0, sz, 'b')}${wr(i, sz, 'a')}` }); }
  if (op === 0x98) return mk({ gen: () => (sz === 4 ? 'r0=(r0<<16)>>16;' : 'r0=(r0&-65536)|(((r0<<24)>>24)&65535);') });
  if (op === 0x99) return mk({ gen: () => (sz === 4 ? 'r2=r0>>31;' : 'r2=(r2&-65536)|(((r0<<16)>>31)&65535);') });

  // ---- group 80..83, test, shifts, f6/f7, fe/ff
  if (op >= 0x80 && op <= 0x83) {
    const size = op & 1 ? sz : 1;
    const m = modrm();
    const [imm, dynImm] = op === 0x81 ? field(size, false) : op === 0x83 ? field(1, true) : field(1, false);
    const aop = m.reg;
    const v = op === 0x83 ? (size === 4 ? imm >>> 0 : (imm & MASK_N[size])) : (size === 4 ? imm >>> 0 : imm);
    // the dynamic form of the sign extended byte, widened to the operand size
    const dv = dynImm === null ? null : op === 0x83 ? (size === 4 ? `(${dynImm}>>>0)` : `(${dynImm}&${MASK_N[size]})`) : dynImm;
    return mk({ reads: aluReads(aop), writes: FALL,
      gen: (live) => `${m.ea}a=${rmGet(m, size)};b=${dv ?? v};${aluCode(aop, size, 'a', 'b', live)}${aop === 7 ? '' : rmSet(m, size, 'res')}` });
  }
  if (op === 0x84 || op === 0x85) {
    const size = op & 1 ? sz : 1;
    const m = modrm();
    return mk({ writes: FALL & ~FA, gen: (live) => `${m.ea}a=${rmGet(m, size)};b=${rd(m.reg, size)};${aluCode(4, size, 'a', 'b', live & ~FA)}` });
  }
  if (op === 0xa8 || op === 0xa9) {
    const size = op & 1 ? sz : 1;
    const v = immN(size);
    return mk({ writes: FALL & ~FA, gen: (live) => `a=${rd(0, size)};b=${v};${aluCode(4, size, 'a', 'b', live & ~FA)}` });
  }
  if (op === 0xc0 || op === 0xc1 || (op >= 0xd0 && op <= 0xd3)) {
    const size = op & 1 ? sz : 1;
    const m = modrm();
    const sop = m.reg;
    if (sop === 2 || sop === 3 || sop === 6) throw new Unsupported('rcl/rcr/sal');
    let cnt;
    if (op <= 0xc1) cnt = imm8() & 31;
    else if (op <= 0xd1) cnt = 1;
    else cnt = -1;
    if (cnt === 0) return mk({ gen: () => '' });
    // a count in CL may be 0 at run time, in which case no flag changes
    const writes = cnt === -1 ? 0 : (sop >= 4 ? FALL & ~FA : FC | FO);
    return mk({ writes, reads: cnt === -1 ? FALL : 0,
      gen: (live) => `${m.ea}a=${rmGet(m, size)};count=${cnt === -1 ? '(r1&31)' : cnt};${shiftCode(sop, size, live)}${rmSet(m, size, 'res')}` });
  }
  if (op === 0xf6 || op === 0xf7) {
    const size = op & 1 ? sz : 1;
    const m = modrm();
    if (m.reg === 0 || m.reg === 1) {
      const v = immN(size);
      return mk({ writes: FALL & ~FA, gen: (live) => `${m.ea}a=${rmGet(m, size)};b=${v};${aluCode(4, size, 'a', 'b', live & ~FA)}` });
    }
    if (m.reg === 2) return mk({ gen: () => `${m.ea}x=~${rmGet(m, size)};${rmSet(m, size, 'x')}` });
    if (m.reg === 3) {
      return mk({ writes: FALL, gen: (live) => {
        const M = MASK[size], S = SIGN[size];
        let c = `${m.ea}a=${rmGet(m, size)};res=(-a)${size === 4 ? '>>>0' : '&' + M};`;
        if (live & FC) c += 'cf=a!==0?1:0;';
        if (live & FO) c += `of=a===${S}?1:0;`;
        if (live & FA) c += 'af=((a^res)&16)?1:0;';
        return c + setZSP('res', size, live) + rmSet(m, size, 'res');
      } });
    }
    if (size === 1) throw new Unsupported('f6 mul/div');
    return mk({ writes: m.reg <= 5 ? FC | FO : 0, gen: () => mulDivCode(m, size) });
  }
  if (op === 0xfe || op === 0xff) {
    const size = op & 1 ? sz : 1;
    const m = modrm();
    if (m.reg === 0 || m.reg === 1) {
      const dec = m.reg === 1;
      return mk({ writes: FALL & ~FC, gen: (live) => {
        const M = MASK[size], S = SIGN[size];
        let c = `${m.ea}a=${rmGet(m, size)};res=(a${dec ? '-1' : '+1'})${size === 4 ? '>>>0' : '&' + M};`;
        if (live & FO) c += dec ? `of=a===${S}?1:0;` : `of=a===${M}?1:0;`;
        if (live & FA) c += 'af=((a^res)&16)?1:0;';
        return c + setZSP('res', size, live) + rmSet(m, size, 'res');
      } });
    }
    if (op === 0xff && sz === 2) {
      if (m.reg === 2) { const ret = ip; return mk({ end: true, gen: () => `${m.ea}y=${rmGet(m, 2)};x=${ret};${push('x', 2)}${goto('y&65535').replace('C.ip=y&65535', 'C.ip=y&65535')}` }); }
      if (m.reg === 4) return mk({ end: true, gen: () => `${m.ea}C.ip=${rmGet(m, 2)}&65535;${STORE}return n;` });
    }
    if (op === 0xff && (m.reg === 3 || m.reg === 5) && !m.isReg && sz === 2) {
      const ret = ip;
      const pre = `${m.ea}y=${rdMem('e', 2)};k=${rdMem('(e+2)', 2)};`;
      if (m.reg === 5) return mk({ end: true, gen: () => `${pre}S[1]=k;C.ip=y;${STORE}return n;` });
      return mk({ end: true, gen: () => `${pre}x=S[1];${push('x', 2)}x=${ret};${push('x', 2)}S[1]=k;C.ip=y;${STORE}return n;` });
    }
    if (op === 0xff && m.reg === 6) return mk({ gen: () => `${m.ea}x=${rmGet(m, sz)};${push('x', sz)}` });
    throw new Unsupported('ff');
  }

  // ---- two byte opcodes
  if (op === 0x0f) {
    const b2 = byte();
    if (b2 === 0xaf) {
      const m = modrm();
      return mk({ writes: FC | FO, gen: (live) => {
        let c = `${m.ea}a=${sz === 4 ? `${rmGet(m, 4)}|0` : `(${rmGet(m, 2)}<<16)>>16`};b=${sz === 4 ? `${rd(m.reg, 4)}|0` : `(${rd(m.reg, 2)}<<16)>>16`};`;
        c += sz === 4 ? 'res=Math.imul(a,b);' : 'res=Math.imul(a,b)&65535;';
        if (live & (FC | FO)) c += sz === 4 ? 'cf=of=(a*b===(res|0))?0:1;' : 'cf=of=(a*b===((res<<16)>>16))?0:1;';
        return c + wr(m.reg, sz, 'res');
      } });
    }
    if (b2 === 0xb6 || b2 === 0xb7 || b2 === 0xbe || b2 === 0xbf) {
      const m = modrm();
      const from = (b2 & 1) ? 2 : 1;
      const signed = b2 >= 0xbe;
      return mk({ gen: () => {
        let v = `${m.ea}x=${rmGet(m, from)};`;
        if (signed) v += from === 1 ? 'x=(x<<24)>>24;' : 'x=(x<<16)>>16;';
        return v + wr(m.reg, sz, 'x');
      } });
    }
    if (b2 === 0xa4 || b2 === 0xac) { // shld / shrd r/m, r, imm8
      const m = modrm();
      const left = b2 === 0xa4;
      const cnt = imm8() & 31;
      if (cnt === 0) return mk({ gen: () => '' });
      if (sz !== 4) throw new Unsupported('shld16');
      return mk({ writes: FALL & ~FA, gen: (live) => {
        let c = `${m.ea}a=${rmGet(m, 4)};b=${rd(m.reg, 4)};`;
        c += left ? `res=((a<<${cnt})|(b>>>${32 - cnt}))>>>0;` : `res=((a>>>${cnt})|(b<<${32 - cnt}))>>>0;`;
        if (live & FC) c += left ? `cf=(a>>>${32 - cnt})&1;` : `cf=(a>>>${cnt - 1})&1;`;
        if (live & FO) c += 'of=0;';
        return c + setZSP('res', 4, live) + rmSet(m, 4, 'res');
      } });
    }
    if (b2 === 0xa0 || b2 === 0xa8) return mk({ gen: () => `x=S[${b2 === 0xa0 ? 4 : 5}];${push('x', 2)}` });
    if (b2 === 0xa1 || b2 === 0xa9) return mk({ gen: () => pop(2) + `S[${b2 === 0xa1 ? 4 : 5}]=x;` });
    if (b2 >= 0x80 && b2 <= 0x8f) {
      const rel = (imm16() << 16) >> 16;
      const target = (ip + rel) & 0xffff, next = ip;
      return mk({ end: true, reads: CC_FLAGS[b2 & 15], gen: (live, ctx) => jump(condCode(b2 & 15), '', target, next, ctx) });
    }
    throw new Unsupported('0f' + b2.toString(16));
  }
  if (op === 0x69 || op === 0x6b) {
    const m = modrm();
    const v = op === 0x69 ? (sz === 4 ? imm32() | 0 : (imm16() << 16) >> 16) : imm8s();
    return mk({ writes: FC | FO, gen: (live) => {
      let c = `${m.ea}a=${sz === 4 ? `${rmGet(m, 4)}|0` : `(${rmGet(m, 2)}<<16)>>16`};b=${v};`;
      c += sz === 4 ? 'res=Math.imul(a,b);' : 'res=Math.imul(a,b)&65535;';
      if (live & (FC | FO)) c += sz === 4 ? 'cf=of=(a*b===(res|0))?0:1;' : 'cf=of=(a*b===((res<<16)>>16))?0:1;';
      return c + wr(m.reg, sz, 'res');
    } });
  }

  // ---- control flow
  if (op >= 0x70 && op <= 0x7f) {
    const rel = imm8s();
    const target = (ip + rel) & 0xffff, next = ip;
    return mk({ end: true, reads: CC_FLAGS[op & 15], loopTo: target, gen: (live, ctx) => jump(condCode(op & 15), '', target, next, ctx) });
  }
  if (op === 0xeb || op === 0xe9) {
    const rel = op === 0xeb ? imm8s() : (imm16() << 16) >> 16;
    const target = (ip + rel) & 0xffff;
    if (target === blockIp) return mk({ end: true, loopTo: target, gen: (live, ctx) => jump('true', '', target, target, ctx) });
    // otherwise the block carries on at the target (the translator follows it)
    return mk({ follow: target, gen: () => '' });
  }
  if (op === 0xe8) {
    const rel = (imm16() << 16) >> 16;
    const ret = ip, target = (ip + rel) & 0xffff;
    return mk({ end: true, gen: () => `x=${ret};${push('x', 2)}${goto(target)}` });
  }
  if (op === 0xcb && sz === 2) return mk({ end: true, gen: () => `${pop(2)}y=x;${pop(2)}C.ip=y;S[1]=x;${STORE}return n;` });
  if (op === 0x60) return mk({ gen: () => `y=r4;${[0, 1, 2, 3].map((i) => `x=${rd(i, sz)};${push('x', sz)}`).join('')}x=${sz === 4 ? 'y>>>0' : '(y&65535)'};${push('x', sz)}${[5, 6, 7].map((i) => `x=${rd(i, sz)};${push('x', sz)}`).join('')}` });
  if (op === 0x61) return mk({ gen: () => `${[7, 6, 5].map((i) => `${pop(sz)}${wr(i, sz, 'x')}`).join('')}r4=${sz === 4 ? '(r4+4)|0' : '(r4&-65536)|((r4+2)&65535)'};${[3, 2, 1, 0].map((i) => `${pop(sz)}${wr(i, sz, 'x')}`).join('')}` });
  if (op === 0xc3 && sz === 2) return mk({ end: true, gen: () => `${pop(2)}C.ip=x;${STORE}return n;` });
  if (op === 0xc2 && sz === 2) { const v = imm16(); return mk({ end: true, gen: () => `${pop(2)}r4=(r4&-65536)|((r4+${v})&65535);C.ip=x;${STORE}return n;` }); }
  if (op === 0xe2 || op === 0xe0 || op === 0xe1) {
    const rel = imm8s();
    const target = (ip + rel) & 0xffff, next = ip;
    return mk({ end: true, reads: op === 0xe2 ? 0 : FZ, loopTo: target,
      gen: (live, ctx) => {
        const dec = addr32 ? 'r1=(r1-1)|0;' : 'r1=(r1&-65536)|((r1-1)&65535);';
        const nz = addr32 ? 'r1!==0' : '(r1&65535)!==0';
        const cond = op === 0xe2 ? nz : op === 0xe1 ? `(${nz}&&zf===1)` : `(${nz}&&zf===0)`;
        return jump(cond, dec, target, next, ctx);
      } });
  }
  if (op === 0xe3) {
    const rel = imm8s();
    const target = (ip + rel) & 0xffff, next = ip;
    return mk({ end: true, gen: () => `C.ip=(${addr32 ? 'r1===0' : '(r1&65535)===0'})?${target}:${next};${STORE}return n;` });
  }

  // ---- flags and misc
  if (op === 0xfc) return mk({ gen: () => 'C.df=0;' });
  if (op === 0xfd) return mk({ gen: () => 'C.df=1;' });
  if (op === 0xfa) return mk({ gen: () => 'C.if=0;' });
  if (op === 0xfb) return mk({ gen: () => 'C.if=1;' });
  if (op === 0xf8) return mk({ writes: FC, gen: (live) => (live & FC ? 'cf=0;' : '') });
  if (op === 0xf9) return mk({ writes: FC, gen: (live) => (live & FC ? 'cf=1;' : '') });
  if (op === 0xf5) return mk({ writes: FC, reads: FC, gen: (live) => (live & FC ? 'cf^=1;' : '') });
  if (op === 0xd7) {
    const seg = segOv >= 0 ? segOv : 3;
    return mk({ gen: () => `e=${lin(seg, '((r3&65535)+(r0&255))&65535')};x=${rdMem('e', 1)};${wr(0, 1, 'x')}` });
  }
  if (op === 0xc9 && sz === 2) return mk({ gen: () => `r4=(r4&-65536)|(r5&65535);${pop(2)}r5=(r5&-65536)|x;` });

  // ---- port I/O (the machine's bus does the work)
  if (op === 0xec || op === 0xed || op === 0xe4 || op === 0xe5) {
    const size = op & 1 ? sz : 1;
    const port = (op === 0xe4 || op === 0xe5) ? String(byte()) : '(r2&65535)';
    return mk({ gen: () => `x=C.in(${port},${size});${wr(0, size, 'x')}` });
  }
  if (op === 0xee || op === 0xef || op === 0xe6 || op === 0xe7) {
    const size = op & 1 ? sz : 1;
    const port = (op === 0xe6 || op === 0xe7) ? String(byte()) : '(r2&65535)';
    return mk({ gen: () => `x=${rd(0, size)};C.out(${port},${size},x);` });
  }

  // ---- string instructions
  if (op === 0xa4 || op === 0xa5 || op === 0xaa || op === 0xab || op === 0xac || op === 0xad || op === 0x6e || op === 0x6f) {
    return stringOp(op, sz, addr32, segOv, rep, mk);
  }

  throw new Unsupported('op ' + op.toString(16));
}

function stringOp(op, sz, addr32, segOv, rep, mk) {
  const kind = { 0xa4: 'movs', 0xa5: 'movs', 0xaa: 'stos', 0xab: 'stos', 0xac: 'lods', 0xad: 'lods', 0x6e: 'outs', 0x6f: 'outs' }[op];
  const size = (op & 1) ? sz : 1;
  const sseg = segOv >= 0 ? segOv : 3;
  const siE = addr32 ? 'r6' : '(r6&65535)';
  const diE = addr32 ? 'r7' : '(r7&65535)';
  const inc = (r) => addr32 ? `${r}=(${r}+y)|0;` : `${r}=(${r}&-65536)|((${r}+y)&65535);`;
  let one;
  switch (kind) {
    case 'movs': one = `e=${lin(sseg, siE)};x=${rdMem('e', size)};e=${lin(0, diE)};${wrMem('e', 'x', size)}${inc('r6')}${inc('r7')}`; break;
    case 'stos': one = `e=${lin(0, diE)};${wrMem('e', 'x', size)}${inc('r7')}`; break;
    case 'lods': one = `e=${lin(sseg, siE)};x=${rdMem('e', size)};${wr(0, size, 'x')}${inc('r6')}`; break;
    default: one = `e=${lin(sseg, siE)};x=${rdMem('e', size)};C.out(r2&65535,${size},x);${inc('r6')}`;
  }
  const pre = `y=C.df?-${size}:${size};${kind === 'stos' ? `x=${rd(0, size)};` : ''}`;
  const dec = addr32 ? 'r1=(r1-1)|0;' : 'r1=(r1&-65536)|((r1-1)&65535);';
  const cxz = addr32 ? 'r1!==0' : '(r1&65535)!==0';
  return mk({ gen: () => pre + (rep ? `while(${cxz}){${one}${dec}}` : one) });
}

// ------------------------------------------------------------------- JIT

export class JIT {
  constructor(cpu) {
    this.cpu = cpu;
    this.cache = new Array(1 << 20); // linear address -> compiled function, null = interpret, undefined = unknown
    this.blocks = new Map(); // start -> { ranges }
    this.prot = new Uint8Array(1 << 20);
    this.pageBlocks = new Map(); // 256 byte page -> Set of block start addresses
    this.stats = { compiled: 0, invalidated: 0, interp: 0, blocks: 0 };
    this.volatile = new Set(); // linear addresses of immediates that stores have patched
    this.dirty = 0; // set when a store hit translated code
    this.rem = 0;
    cpu.prot = this.prot;
    cpu.jit = this;
  }

  // 64 bit helpers for mul/imul/div/idiv (doubles hold 53 bits, so the halves are split)
  hiu(a, b) {
    const a1 = a >>> 16, a0 = a & 0xffff, b1 = b >>> 16, b0 = b & 0xffff;
    const mid = a0 * b1 + a1 * b0 + ((a0 * b0) >>> 16);
    return (a1 * b1 + Math.floor(mid / 65536)) >>> 0;
  }

  his(a, b) {
    const a1 = a >> 16, a0 = a & 0xffff, b1 = b >> 16, b0 = b & 0xffff;
    const mid = a0 * b1 + a1 * b0 + ((a0 * b0) >>> 16);
    return (a1 * b1 + Math.floor(mid / 65536)) | 0;
  }

  /** EDX:EAX / d; the quotient is returned, the remainder left in `rem` */
  div64(hi, lo, d, signed) {
    if (signed ? (hi >= -1048576 && hi < 1048576) : (hi >>> 0) < 1048576) {
      const n = (signed ? hi : hi >>> 0) * 4294967296 + (lo >>> 0);
      const an = Math.abs(n), ad = Math.abs(d);
      let qa = Math.floor(an / ad), ra = an - qa * ad;
      if (ra < 0) { qa--; ra += ad; } else if (ra >= ad) { qa++; ra -= ad; }
      this.rem = n < 0 ? -ra : ra;
      return (n < 0) !== (d < 0) ? -qa : qa;
    }
    const raw = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
    const n = signed ? BigInt.asIntN(64, raw) : raw;
    const dd = BigInt(d);
    this.rem = Number(n % dd);
    return Number(n / dd);
  }

  fault() { throw new Error('divide error'); }

  /** mark (or clear) the bytes of one instruction, except an immediate read at run time */
  markRange([a, l, immOff, immLen, dyn], v) {
    for (let i = 0; i < l; i++) {
      if (dyn && i >= immOff && i < immOff + immLen) continue;
      this.prot[(a + i) & 0xfffff] = v;
    }
  }

  /** a store hit a marked byte: drop the blocks that contain it */
  smc(addr, len) {
    let hit = false;
    for (let i = 0; i < len; i++) if (this.prot[(addr + i) & 0xfffff]) hit = true;
    if (!hit) return;
    this.dirty = 1;
    const drop = [];
    for (let page = addr >> 8; page <= ((addr + len - 1) >> 8); page++) {
      const set = this.pageBlocks.get(page);
      if (!set) continue;
      for (const start of set) {
        const blk = this.blocks.get(start);
        if (!blk) continue;
        for (const [a, l, immOff, immLen] of blk.ranges) {
          if (addr + len <= a || addr >= a + l) continue;
          // a store into an immediate: next time read it when the block runs
          if (immOff >= 0 && addr >= a + immOff && addr < a + immOff + immLen) this.volatile.add(a + immOff);
          drop.push(start);
          break;
        }
      }
    }
    for (const start of new Set(drop)) this.dropBlock(start);
  }

  dropBlock(start) {
    const blk = this.blocks.get(start);
    this.cache[start] = undefined;
    this.blocks.delete(start);
    if (!blk) return;
    this.stats.invalidated++;
    for (const r of blk.ranges) {
      const [a, l] = r;
      for (let p = a >> 8; p <= ((a + l - 1) >> 8); p++) {
        const s = this.pageBlocks.get(p);
        if (s) { s.delete(start); if (!s.size) this.pageBlocks.delete(p); }
      }
      this.markRange(r, 0);
    }
    // bytes shared with another block stay protected
    for (const [a, l] of blk.ranges) {
      for (let p = a >> 8; p <= ((a + l - 1) >> 8); p++) {
        const s = this.pageBlocks.get(p);
        if (s) for (const other of s) { const ob = this.blocks.get(other); if (ob) for (const r of ob.ranges) this.markRange(r, 1); }
      }
    }
  }

  /** Run until at least `budget` instructions have executed (blocks are not interrupted). Returns the count. */
  run(budget, machine = null) {
    const c = this.cpu, cache = this.cache, sreg = c.sreg;
    let left = budget, done = 0;
    while (left > 0) {
      const a = ((sreg[1] << 4) + c.ip) & 0xfffff;
      let fn = cache[a];
      if (fn === undefined) fn = this.compile(a);
      if (fn !== null) {
        const k = fn(left);
        left -= k;
        done += k;
      } else {
        this.stats.interp++;
        c.step(); // counts itself
        left--;
        if (machine && machine.exited) break;
      }
    }
    c.insts += done;
    return budget - left;
  }

  compile(start) {
    let blk = null;
    try { blk = this.translate(start); } catch (e) { if (!(e instanceof Unsupported)) throw e; }
    if (!blk) { this.cache[start] = null; return null; }
    this.cache[start] = blk.fn;
    this.blocks.set(start, blk);
    this.stats.compiled++;
    for (const r of blk.ranges) {
      this.markRange(r, 1);
      const [a, l] = r;
      for (let p = a >> 8; p <= ((a + l - 1) >> 8); p++) {
        let s = this.pageBlocks.get(p);
        if (!s) { s = new Set(); this.pageBlocks.set(p, s); }
        s.add(start);
      }
    }
    return blk.fn;
  }

  translate(start) {
    const c = this.cpu;
    const mem = c.mem;
    const csBase = c.sreg[1] << 4;
    const ip0 = start - csBase;
    if (ip0 < 0 || ip0 > 0xffff) throw new Unsupported('ip');
    const list = [];
    const ranges = [];
    let ip = ip0;
    for (let n = 0; n < MAXLEN; n++) {
      let ins = null;
      try { ins = decodeOne(mem, csBase, ip, this.volatile, ip0); } catch (e) { if (!(e instanceof Unsupported)) throw e; }
      if (!ins) break;
      list.push(ins);
      ranges.push([csBase + ip, ins.len, ins.immOff ?? -1, ins.immLen ?? 0, !!ins.dyn]);
      ip = ins.follow !== undefined ? ins.follow : (ip + ins.len) & 0xffff;
      ins.next = ip;
      if (ins.end) break;
    }
    if (!list.length) return null;
    return { start, ranges, fn: this.build(list, ip0, ip), count: list.length };
  }

  build(list, ip0, ipEnd) {
    const n = list.length;
    const last = list[n - 1];
    // flag liveness, backwards: everything is live at the end of a block
    let live = FALL;
    const liveAfter = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      liveAfter[i] = live;
      live = (live & ~list[i].writes) | list[i].reads;
    }
    const selfLoop = last.end && last.loopTo === ip0;
    const ctx = { selfLoop, n, ip0 };
    let body = '';
    for (let i = 0; i < n; i++) {
      const at = list[i].next;
      let c = list[i].gen(liveAfter[i], ctx);
      // a store into translated code may have changed this very block: stop after it
      if (c.includes('J.smc(')) c += `if(J.dirty){J.dirty=0;C.ip=${at};${STORE}return ${selfLoop ? 'n+' : ''}${i + 1};}`;
      body += `{${c}}\n`;
    }
    let code = selfLoop ? 'for(;;){\n' : '';
    code += body;
    if (!last.end) code += `C.ip=${ipEnd};${STORE}return n;\n`;
    code += selfLoop ? '}\n' : '';
    // only touch the registers and flags the block uses, and write back those it changes
    let load = '', store = '';
    for (let i = 0; i < 8; i++) {
      if (new RegExp(`\\br${i}\\b`).test(code)) load += `let r${i}=R[${i}]|0;`;
      if (new RegExp(`\\br${i}=(?!=)`).test(code)) store += `R[${i}]=r${i};`;
    }
    for (const f of ['cf', 'pf', 'af', 'zf', 'sf', 'of']) {
      if (new RegExp(`\\b${f}\\b`).test(code)) load += `let ${f}=C.${f};`;
      if (new RegExp(`\\b${f}(=(?!=)|\\^=)`).test(code)) store += `C.${f}=${f};`;
    }
    code = code.split(STORE).join(store);
    code = `return function(budget){\n${load}let t=0,res=0,a=0,b=0,e=0,x=0,y=0,k=0,count=0;let n=${selfLoop ? 0 : n};\n${code}}`;
    const cpu = this.cpu;
    return new Function('C', 'mem', 'R', 'S', 'PAR', 'CM', 'J', code)(cpu, cpu.mem, cpu.r, cpu.sreg, PARITY, this.prot, this);
  }
}
