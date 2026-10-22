"""Rob Northen Compression (RNC ProPack) -- method 1 decompressor.

Pure Python port of the reference unpacker (rnc64/main.c).  Used here to pull
the eight RNC blocks out of DOPE.EXE without any external tooling.

Header (18 bytes, big endian):
    0..1  "RN"
    2     "C"
    3     method (1 or 2)
    4..7  unpacked size
    8..11 packed size
    12..13 unpacked CRC16
    14..15 packed CRC16
    16    leeway
    17    chunk count

Method 1 payload is stored as a 16-bit LSB-first bit stream that is refilled
from the *front* of the packed data (unlike method 2), with Huffman coded
tables describing literal-run lengths and match length/distance pairs.
"""

import struct

HEADER_SIZE = 0x12


class RNCError(Exception):
    pass


def crc_block(data):
    """RNC's CRC-16 (poly 0xA001, init 0)."""
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc & 0xFFFF


def _inverse_bits(value, count):
    out = 0
    for _ in range(count):
        out = (out << 1) | (value & 1)
        value >>= 1
    return out


class _HuffTable:
    """Canonical Huffman table built from a list of bit depths (proc_20)."""

    def __init__(self, depths):
        self.depth = list(depths) + [0] * (16 - len(depths))
        self.l3 = [0] * 16
        self._build()

    def _build(self):
        val = 0
        div = 0x80000000
        bits = 1
        count = len(self.depth)
        while bits <= 16:
            i = 0
            while True:
                if i >= count:
                    bits += 1
                    div >>= 1
                    break
                if self.depth[i] == bits:
                    self.l3[i] = _inverse_bits(val // div, bits)
                    val += div
                i += 1


class _Reader:
    def __init__(self, data):
        self.data = data + b"\0\0\0\0"
        self.pos = 0
        self.bit_buffer = 0
        self.bit_count = 0
        self.out = bytearray()

    # -- source bytes -----------------------------------------------------
    def byte(self):
        b = self.data[self.pos]
        self.pos += 1
        return b

    # -- bit stream -------------------------------------------------------
    def bits(self, count):
        value = 0
        prev = 1
        while count:
            if not self.bit_count:
                b1 = self.byte()
                b2 = self.byte()
                self.bit_buffer = (
                    (self.data[self.pos + 1] << 24)
                    | (self.data[self.pos] << 16)
                    | (b2 << 8)
                    | b1
                )
                self.bit_count = 16
            if self.bit_buffer & 1:
                value |= prev
            self.bit_buffer >>= 1
            prev <<= 1
            self.bit_count -= 1
            count -= 1
        return value

    def refill_after_literal(self):
        p = self.pos
        value = ((self.data[p + 2] << 16) | (self.data[p + 1] << 8) | self.data[p]) & 0xFFFFFF
        self.bit_buffer = ((value << self.bit_count) | (self.bit_buffer & ((1 << self.bit_count) - 1))) & 0xFFFFFFFF

    # -- output -----------------------------------------------------------
    def put(self, b):
        self.out.append(b)

    def copy(self, offset, count):
        for _ in range(count):
            back = len(self.out) - offset
            self.put(self.out[back] if back >= 0 else 0)


def _table(reader):
    leaves = reader.bits(5)
    if leaves > 16:
        leaves = 16
    depths = [reader.bits(4) for _ in range(leaves)]
    return _HuffTable(depths)


def _decode(reader, table):
    for i in range(len(table.depth)):
        depth = table.depth[i]
        if depth and table.l3[i] == (reader.bit_buffer & ((1 << depth) - 1)):
            reader.bits(depth)
            if i < 2:
                return i
            return reader.bits(i - 1) | (1 << (i - 1))
    raise RNCError("bad huffman code")


def unpack(src, max_output=None):
    """Decompress the RNC stream at the start of *src*; return the payload."""
    if len(src) < HEADER_SIZE:
        raise RNCError("truncated header")
    if src[:3] != b"RNC":
        raise RNCError("missing RNC signature")
    method = src[3]
    unpacked_size, packed_size = struct.unpack(">II", src[4:12])
    unpacked_crc, packed_crc = struct.unpack(">HH", src[12:16])
    if method != 1:
        raise RNCError("unsupported method %d" % method)
    if len(src) < HEADER_SIZE + packed_size:
        raise RNCError("truncated stream")
    packed = src[HEADER_SIZE:HEADER_SIZE + packed_size]
    if crc_block(packed) != packed_crc:
        raise RNCError("packed CRC mismatch")

    reader = _Reader(packed)
    # Two flag bits precede the data (key present / not packed).
    reader.bits(1)
    reader.bits(1)

    while len(reader.out) < unpacked_size:
        raw_table = _table(reader)
        len_table = _table(reader)
        pos_table = _table(reader)
        subchunks = reader.bits(16)
        while subchunks:
            subchunks -= 1
            literals = _decode(reader, raw_table)
            for _ in range(literals):
                reader.put(reader.byte())
            if literals:
                reader.refill_after_literal()
            if subchunks:
                offset = _decode(reader, len_table) + 1
                count = _decode(reader, pos_table) + 2
                reader.copy(offset, count)

    out = bytes(reader.out[:unpacked_size])
    if crc_block(out) != unpacked_crc:
        raise RNCError("unpacked CRC mismatch")
    return out


def unpack_file(path):
    with open(path, "rb") as f:
        return unpack(f.read())
