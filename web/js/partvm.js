/*
 * dope/partvm.js -- run one of the demo's parts, as the loader would, in the
 * x86 interpreter (web/js/vm/).
 *
 * A part is one of DOPE.EXE's RNC blocks.  The loader maps it at segment
 * 0xf8b (file offset 0x100 at the segment's first byte), adds `segment - 0x10`
 * to the 20-odd words it relocates, and calls the part: first an optional far
 * `init` routine, then `main`.  The relocation lists were measured against
 * DOSBox-X snapshots (tools/relocdiff.py, web/data/parts.json).  Nothing here
 * is specific to a part except that data.
 *
 * The part's clock is the 70 Hz timer interrupt it installs on INT 8.  We do
 * not run a PIT: `deliverTick()` raises that interrupt when the player's clock
 * says a tick is due, so pause is "stop calling it" and seek is "call it fast".
 */
import { Machine } from './vm/machine.js';

export const SEGMENT = 0xf8b;
export const TICK_HZ = 70.086; // one timer interrupt per mode 13h frame

/** Start of the part's main: walk back from its `int 21h/4Ch` over `push cs / call` pairs. */
export function findEntry(block) {
  let exit = -1;
  for (let i = 0x200; i < block.length - 5; i++) {
    if ((block[i] === 0xb8 && block[i + 1] === 0 && block[i + 2] === 0x4c && block[i + 3] === 0xcd && block[i + 4] === 0x21) ||
        (block[i] === 0xb4 && block[i + 1] === 0x4c && block[i + 2] === 0x2e && block[i + 3] === 0xa0)) { exit = i; break; }
  }
  if (exit < 0) throw new Error('no exit found');
  let pos = exit;
  for (;;) {
    if (block[pos - 4] === 0x0e && block[pos - 3] === 0xe8) pos -= 4;
    else if (block[pos - 3] === 0xe8) pos -= 3;
    else break;
  }
  return pos;
}

/** The segment the part loads into gs (`push imm / pop gs`); the loader leaves it in gs. */
export function findGs(block) {
  for (let i = 0x100; i < block.length - 5; i++) {
    if (block[i] === 0x68 && block[i + 3] === 0x0f && block[i + 4] === 0xa9) return block[i + 1] | (block[i + 2] << 8);
  }
  return null;
}

/** The 1 MB memory image as the loader leaves it. */
export function loadImage(block, reloc, segment = SEGMENT, left = null) {
  const mem = new Uint8Array(1 << 20);
  // the loader does not clear memory: what the part before left above its own image stays
  if (left) mem.set(left.subarray(segment * 16, 0xa0000), segment * 16);
  mem.set(block.subarray(0x100), segment * 16);
  const add = segment - 0x10;
  for (const j of reloc) {
    const a = segment * 16 + j;
    const v = (mem[a] | (mem[a + 1] << 8)) + add;
    mem[a] = v & 0xff;
    mem[a + 1] = (v >> 8) & 0xff;
  }
  return mem;
}

/**
 * @param block   the unpacked RNC block
 * @param spec    { reloc, entry?, init?, inheritsMode?: bool }
 * @param screen  { pixels: Uint8Array(64000), pal: Uint8Array(768) } left by the part before
 */
export function makePart(block, spec, { screen = null, gs = null, left = null } = {}) {
  const mem = loadImage(block, spec.reloc, SEGMENT, left);
  const entry = (spec.entry ?? findEntry(block)) - 0x100;
  const m = new Machine();
  m.vga.layout = 'nopan';
  m.boot(mem, { part_segment: SEGMENT, entry, counter_offset: 0 });
  const g = gs ?? (findGs(block) === null ? null : (findGs(block) + SEGMENT - 0x10) & 0xffff);
  if (g !== null) m.cpu.sreg[5] = g;
  if (spec.init) { // the loader calls this far routine first; it returns into main
    m.cpu.push(SEGMENT, 2);
    m.cpu.push(entry, 2);
    m.cpu.ip = spec.init - 0x100;
  }
  if (spec.inheritsMode) { // the part never sets the mode: it paints over the previous part's screen
    m.vga.setMode(0x13);
    if (screen) { m.vga.pixels.set(screen.pixels, 0); m.vga.pal.set(screen.pal); }
  }
  // the part programs the PIT itself; the player owns the clock
  const out8 = m.out8.bind(m);
  m.out8 = (p, v) => { if (p === 0x40 || p === 0x43) return; out8(p, v); };
  m.pitDiv = 1e12;
  m.pitCount = 1e12;
  m.vga.fastRetrace = true;
  return { m, entry };
}

/** One part, driven by ticks. */
export class PartRunner {
  constructor(block, spec, screen = null, left = null) {
    this.spec = spec;
    ({ m: this.m } = makePart(block, spec, { screen, left }));
    this.tick = 0; // timer interrupts delivered so far
    this.exited = false;
  }

  /** Run up to `n` instructions. Returns false once the part has exited. */
  run(n) {
    const m = this.m;
    const c = m.cpu;
    for (let i = 0; i < n; i++) {
      c.step();
      m.clock++;
      if (m.exited) { this.exited = true; return false; }
    }
    return true;
  }

  /** Raise the part's timer interrupt if its ISR is idle. Returns true when a tick was delivered. */
  deliverTick() {
    const m = this.m;
    if (m.ret || !m.cpu.if) return false;
    const vec = m.cpu.read32(0x20);
    if ((vec >>> 16) === m.partSeg) {
      m.ret = { cs: m.cpu.sreg[1], ip: m.cpu.ip };
      m.cpu.interrupt(8);
    }
    this.tick++;
    return true;
  }

  /** The picture the card would show now: 64000 indices and the 6 bit DAC. */
  snapshot(pixels = new Uint8Array(64000), pal = new Uint8Array(768)) {
    pixels.set(this.m.vga.pixels.subarray(0, 64000));
    pal.set(this.m.vga.pal);
    return { pixels, pal };
  }
}
