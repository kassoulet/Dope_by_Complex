/*
 * dope/rnc.js -- Rob Northen Compression (RNC ProPack), method 1.
 *
 * DOPE.EXE is an MZ stub followed by eight concatenated RNC blocks: block 0 is
 * the CDPI loader and music driver, blocks 1..7 are the demo parts.  The port
 * needs one of those blocks -- part 1's uncompressed picture strip -- so this
 * is the decompressor, a direct port of tools/rnc.py (which was in turn
 * cross-checked against the reference rnc64 on all eight streams).
 *
 * Header (18 bytes, big endian):
 *    0..1  "RN"      4..7   unpacked size    12..13 unpacked CRC16
 *    2     "C"       8..11  packed size      14..15 packed CRC16
 *    3     method    16 leeway, 17 chunk count
 */

export const HEADER_SIZE = 0x12;

export class RNCError extends Error {}

/** RNC's CRC-16, polynomial 0xA001, initial value 0. */
export function crc16(bytes, start = 0, end = bytes.length) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? ((crc >> 1) ^ 0xa001) & 0xffff : crc >> 1;
    }
  }
  return crc;
}

function inverseBits(value, count) {
  let out = 0;
  for (let i = 0; i < count; i++) {
    out = (out << 1) | (value & 1);
    value >>= 1;
  }
  return out;
}

/** Canonical Huffman table from a list of bit depths. */
class HuffTable {
  constructor(depths) {
    this.depth = new Uint8Array(16);
    this.depth.set(depths.subarray(0, Math.min(depths.length, 16)));
    this.depths = depths.length;
    this.l3 = new Int32Array(16);
    this.build();
  }

  build() {
    let value = 0;
    let div = 0x80000000;
    for (let bits = 1; bits <= 16; bits++) {
      for (let i = 0; i < this.depths; i++) {
        if (this.depth[i] === bits) {
          this.l3[i] = inverseBits(Math.floor(value / div), bits);
          value = (value + div) >>> 0;
        }
      }
      div >>>= 1;
    }
  }
}

class Reader {
  constructor(data) {
    this.data = data;
    this.pos = 0;
    this.bitBuffer = 0;
    this.bitCount = 0;
    this.out = new Uint8Array(1 << 20);
    this.len = 0;
  }

  byte() {
    return this.pos < this.data.length ? this.data[this.pos++] : 0;
  }

  bits(count) {
    let value = 0;
    let prev = 1;
    while (count--) {
      if (!this.bitCount) {
        const b1 = this.byte();
        const b2 = this.byte();
        const hi = this.pos + 1 < this.data.length ? this.data[this.pos + 1] : 0;
        const lo = this.pos < this.data.length ? this.data[this.pos] : 0;
        this.bitBuffer = ((hi << 24) | (lo << 16) | (b2 << 8) | b1) >>> 0;
        this.bitCount = 16;
      }
      if (this.bitBuffer & 1) value |= prev;
      this.bitBuffer >>>= 1;
      prev <<= 1;
      this.bitCount--;
    }
    return value;
  }

  // The literal bytes are taken straight from the stream, so the bit buffer
  // has to be re-based over the bytes that were just consumed.
  refillAfterLiteral() {
    const p = this.pos;
    const at = (i) => (i < this.data.length ? this.data[i] : 0);
    const value = ((at(p + 2) << 16) | (at(p + 1) << 8) | at(p)) & 0xffffff;
    const mask = this.bitCount === 0 ? 0 : (1 << this.bitCount) - 1;
    this.bitBuffer = ((value << this.bitCount) | (this.bitBuffer & mask)) >>> 0;
  }

  put(byte) {
    this.out[this.len++] = byte;
  }

  copy(offset, count) {
    for (let i = 0; i < count; i++) {
      const back = this.len - offset;
      this.put(back >= 0 ? this.out[back] : 0);
    }
  }
}

function readTable(reader) {
  let leaves = reader.bits(5);
  if (leaves > 16) leaves = 16;
  const depths = new Uint8Array(leaves);
  for (let i = 0; i < leaves; i++) depths[i] = reader.bits(4);
  return new HuffTable(depths);
}

function decode(reader, table) {
  for (let i = 0; i < table.depths; i++) {
    const depth = table.depth[i];
    if (depth && table.l3[i] === (reader.bitBuffer & ((1 << depth) - 1))) {
      reader.bits(depth);
      if (i < 2) return i;
      return reader.bits(i - 1) | (1 << (i - 1));
    }
  }
  throw new RNCError('bad huffman code');
}

/** Read the header of the stream at `src[offset]` and describe it. */
export function header(src, offset = 0) {
  if (src.length - offset < HEADER_SIZE) throw new RNCError('truncated header');
  if (src[offset] !== 0x52 || src[offset + 1] !== 0x4e || src[offset + 2] !== 0x43) {
    throw new RNCError('missing RNC signature');
  }
  const view = new DataView(src.buffer, src.byteOffset + offset, HEADER_SIZE);
  return {
    method: src[offset + 3],
    unpackedSize: view.getUint32(4),
    packedSize: view.getUint32(8),
    unpackedCrc: view.getUint16(12),
    packedCrc: view.getUint16(14),
    total: HEADER_SIZE + view.getUint32(8),
  };
}

/** Decompress the RNC stream at the start of `src` and check both CRCs. */
export function unpack(src) {
  const h = header(src, 0);
  if (h.method !== 1) throw new RNCError(`unsupported method ${h.method}`);
  if (src.length < h.total) throw new RNCError('truncated stream');
  const packed = src.subarray(HEADER_SIZE, HEADER_SIZE + h.packedSize);
  if (crc16(packed) !== h.packedCrc) throw new RNCError('packed CRC mismatch');

  const reader = new Reader(packed);
  reader.bits(1); // key frame present
  reader.bits(1); // stream is packed

  while (reader.len < h.unpackedSize) {
    const rawTable = readTable(reader);
    const lenTable = readTable(reader);
    const posTable = readTable(reader);
    let subchunks = reader.bits(16);
    while (subchunks--) {
      const literals = decode(reader, rawTable);
      for (let i = 0; i < literals; i++) reader.put(reader.byte());
      if (literals) reader.refillAfterLiteral();
      if (subchunks) {
        const offset = decode(reader, lenTable) + 1;
        const count = decode(reader, posTable) + 2;
        reader.copy(offset, count);
      }
    }
  }

  const out = reader.out.slice(0, h.unpackedSize);
  if (crc16(out) !== h.unpackedCrc) throw new RNCError('unpacked CRC mismatch');
  return out;
}

/**
 * Every valid RNC block in an executable, in file order.  A false positive in
 * the MZ stub is simply a stream whose CRCs do not check out; those are skipped.
 */
export function findBlocks(exe) {
  const blocks = [];
  let pos = 0;
  while (pos < exe.length - 4) {
    const at = indexOfSignature(exe, pos);
    if (at < 0) break;
    try {
      blocks.push({ offset: at, data: unpack(exe.subarray(at, at + header(exe, at).total)) });
    } catch (err) {
      if (!(err instanceof RNCError)) throw err;
    }
    pos = at + 4;
  }
  return blocks;
}

function indexOfSignature(src, from) {
  for (let i = from; i + 3 < src.length; i++) {
    if (src[i] === 0x52 && src[i + 1] === 0x4e && src[i + 2] === 0x43 && src[i + 3] === 0x01) {
      return i;
    }
  }
  return -1;
}
