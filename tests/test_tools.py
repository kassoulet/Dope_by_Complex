#!/usr/bin/env python3
"""Regression checks for the extraction pipeline.

Run: python3 tests/test_tools.py
"""

import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import rnc  # noqa: E402
import unpack  # noqa: E402

EXPECTED_BLOCKS = [
    (0x000020, 25570),
    (0x002C6A, 213658),
    (0x00F66C, 449862),
    (0x01DC1A, 374042),
    (0x02AD70, 485072),
    (0x056F42, 386842),
    (0x068D64, 446560),
    (0x07BC02, 457550),
]

EXE = os.path.join(ROOT, "DOPE.EXE")
MOD = os.path.join(ROOT, "DOPE.MOD")


def test_exe_header():
    data = open(EXE, "rb").read()
    assert data[:2] == b"MZ"
    fields = struct.unpack("<13H", data[2:28])
    cblp, cp, crlc, parhdr, minalloc, maxalloc, ss, sp, csum, ip, cs, lfarlc, ovno = fields
    assert cblp == 0x4A
    assert cs == 0x0294 and ip == 0x000C
    assert lfarlc == 0x028C
    assert crlc == 0
    assert cp * 512 > 0x20 + 18  # the image claim covers the first stream


def test_block_table():
    data = open(EXE, "rb").read()
    blocks = unpack.find_blocks(data)
    got = [(offset, len(payload)) for offset, payload in blocks]
    assert got == EXPECTED_BLOCKS, got


def test_block_crcs():
    data = open(EXE, "rb").read()
    blocks = unpack.find_blocks(data)
    assert len(blocks) == 8
    for offset, payload in blocks:
        header_crc = struct.unpack(">H", data[offset + 12:offset + 14])[0]
        assert rnc.crc_block(payload) == header_crc, hex(offset)


def test_block_payloads():
    data = open(EXE, "rb").read()
    blocks = unpack.find_blocks(data)

    stub = blocks[0][1]
    for needle in (b"CDPI v0.2", b"dope.mod", b"ProTracker for GUS", b"ULTRASND"):
        assert needle in stub, needle

    # block 1 opens with the vertical retrace wait at 0x110
    wait = bytes.fromhex("bada03eca80875fbeca80874fbc3")
    assert blocks[1][1][0x110:0x11E] == wait
    # every overlay polls the VGA status port (mov dx,0x3da) somewhere
    for offset, payload in blocks[1:]:
        assert payload.count(b"\xba\xda\x03") > 0, hex(offset)

    # five of the seven overlays carry the anti-rip banner
    with_banner = [hex(o) for o, p in blocks[1:] if b"HELLO LAMER" in p]
    assert len(with_banner) == 5, with_banner


def test_mod_header():
    d = open(MOD, "rb").read()
    assert d[1080:1084] == b"28CH"
    song_length = d[950]
    orders = list(d[952:952 + song_length])
    patterns = max(orders) + 1
    # sample lengths are stored in 16 bit words
    samples = 2 * sum((d[20 + i * 30 + 22] << 8) | d[20 + i * 30 + 23] for i in range(31))
    assert song_length == 124, song_length
    assert patterns == 70, patterns
    data_start = 1084 + patterns * 64 * 28 * 4
    assert data_start == 502_844, data_start
    assert data_start + samples == len(d), (data_start, samples, len(d))


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for test in tests:
        try:
            test()
            print("ok   %s" % test.__name__)
        except AssertionError as exc:
            failures += 1
            print("FAIL %s: %s" % (test.__name__, exc))
    print("%d/%d passed" % (len(tests) - failures, len(tests)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
