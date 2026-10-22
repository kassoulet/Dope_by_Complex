#!/usr/bin/env python3
"""Exact comparison of a candidate frame against a reference frame.

The port is only allowed to call itself pixel exact when this reports zero
differing pixels for every reference frame.

    python3 tools/framediff.py build/ref/ref_0000.png build/out/0000.png
    python3 tools/framediff.py --list build/ref/*.png      # sizes / palettes

Exit status: 0 identical, 1 different, 2 unusable input.
"""

import argparse
import sys

try:
    from PIL import Image
except ImportError:
    print('needs Pillow: pip install pillow')
    sys.exit(2)


def load(path):
    im = Image.open(path)
    return im.convert('RGB'), im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('reference')
    ap.add_argument('candidate', nargs='?')
    ap.add_argument('--list', action='store_true', help='describe the reference')
    ap.add_argument('--bbox', action='store_true', help='report the differing area')
    args = ap.parse_args()

    ref, ref_raw = load(args.reference)
    if args.list or not args.candidate:
        print('%s  %dx%d  mode %s  colours %d'
              % (args.reference, ref.width, ref.height, ref_raw.mode,
                 len(ref.getcolors(1 << 20) or [])))
        return 0

    cand, cand_raw = load(args.candidate)
    if ref.size != cand.size:
        print('size mismatch: %s %dx%d vs %s %dx%d'
              % (args.reference, ref.width, ref.height,
                 args.candidate, cand.width, cand.height))
        return 1
    if cand_raw.mode == 'P' and 'transparency' in cand_raw.info:
        print('candidate has palette transparency; not a VGA frame')
        return 2

    rp, cp = ref.load(), cand.load()
    bad = 0
    minx, miny, maxx, maxy = ref.width, ref.height, -1, -1
    for y in range(ref.height):
        for x in range(ref.width):
            if rp[x, y] != cp[x, y]:
                bad += 1
                if x < minx:
                    minx = x
                if y < miny:
                    miny = y
                if x > maxx:
                    maxx = x
                if y > maxy:
                    maxy = y
    total = ref.width * ref.height
    if bad == 0:
        print('identical: %s == %s' % (args.reference, args.candidate))
        return 0
    print('different: %d / %d pixels (%.2f%%)'
          % (bad, total, 100.0 * bad / total))
    if args.bbox and maxx >= 0:
        print('differing area: x %d..%d  y %d..%d' % (minx, maxx, miny, maxy))
    return 1


if __name__ == '__main__':
    sys.exit(main())
