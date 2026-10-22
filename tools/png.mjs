/*
 * dope/png.mjs -- minimal PNG writer for the offline tools.
 *
 * The browser path draws straight into a canvas, but the comparison against
 * the original runs under node and needs real PNG files for tools/framediff.py.
 */

import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// `rgb` is w*h*3 bytes.
export function encodePNG(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;         // truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Expand a 320x200 index image through a 768 byte 6-bit palette to RGB, using
// DOSBox's 6 bit to 8 bit expansion (`v << 2 | v >> 4`), so frames compare
// exactly against screenshots of the emulator.
export function indexedToRGB(indices, pal6, w, h) {
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const idx = indices[i] * 3;
    for (let c = 0; c < 3; c++) {
      const v = pal6[idx + c] & 0x3f;
      out[i * 3 + c] = (v << 2) | (v >> 4);
    }
  }
  return out;
}
