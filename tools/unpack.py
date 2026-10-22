#!/usr/bin/env python3
"""Extract the RNC ProPack blocks embedded in DOPE.EXE.

DOPE.EXE is not a plain DOS extender program: the MZ stub is a CDPI loader
followed by eight concatenated RNC (Rob Northen Compression) method-1 blocks.
Block 0 holds the DPMI loader, blocks 1..7 hold the demo payload.

Usage:  python3 tools/unpack.py [EXE] [OUTDIR]
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rnc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def find_blocks(data):
    """Locate every valid RNC method-1 stream and decompress it."""
    blocks = []
    pos = 0
    while True:
        pos = data.find(b"RNC\x01", pos)
        if pos < 0:
            break
        try:
            payload = rnc.unpack(data[pos:])
        except rnc.RNCError:
            pos += 4
            continue
        blocks.append((pos, payload))
        pos += 4
    return blocks


def main(argv):
    exe = argv[1] if len(argv) > 1 else os.path.join(ROOT, "DOPE.EXE")
    outdir = argv[2] if len(argv) > 2 else os.path.join(ROOT, "build")
    os.makedirs(outdir, exist_ok=True)

    data = open(exe, "rb").read()
    blocks = find_blocks(data)
    if not blocks:
        raise SystemExit("no RNC blocks found in %s" % exe)

    manifest = {"source": os.path.basename(exe), "size": len(data), "blocks": []}
    for i, (offset, payload) in enumerate(blocks):
        name = "block%02d_%06x.bin" % (i, offset)
        with open(os.path.join(outdir, name), "wb") as f:
            f.write(payload)
        manifest["blocks"].append({
            "index": i,
            "name": name,
            "file_offset": offset,
            "size": len(payload),
        })
        print("%-22s exe+0x%06x  %7d bytes" % (name, offset, len(payload)))

    with open(os.path.join(outdir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("wrote %d blocks to %s" % (len(blocks), outdir))


if __name__ == "__main__":
    main(sys.argv)
