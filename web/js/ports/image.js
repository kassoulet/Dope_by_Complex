/*
 * dope/ports/image.js -- the memory a part runs in, as the loader leaves it, and the clock's rate.
 */
export const SEGMENT = 0xf8b; // where the loader maps a part
export const TICK_HZ = 70.086; // one timer interrupt per mode 13h frame

/** The 1 MB memory image as the loader leaves it: the block at SEGMENT, its relocated words patched. */
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
