#!/usr/bin/env python3
"""Exact comparison of one-tick part 2 frames against the captured screenshots.

    node tools/part2frames.mjs --frames 438 --out build/out/p2frames --quiet
    python3 tools/part2diff.py build/out/p2frames build/ref_p2/ref_0000.png

Each frame is written as `.idx` (one palette index per pixel) and `.pal` (the
DAC at that instant).  The reference is an RGB PNG.  The tool reports how many
of the 64,000 pixels are byte identical for the best frame, which is the honest
count while the 3D layer is not the original's; it never rounds that up to
"exact".

    python3 tools/part2diff.py --all build/out/p2frames build/ref_p2

Exit status: 0 if some frame and reference agree on every pixel, 1 otherwise.
"""

import argparse
import glob
import os
import sys

try:
    from PIL import Image, ImageChops
except ImportError:
    print('needs Pillow: pip install pillow')
    sys.exit(2)


def frame_image(stem):
    idx = open(stem + '.idx', 'rb').read()
    pal = open(stem + '.pal', 'rb').read()
    if len(idx) != 320 * 200 or len(pal) != 768:
        raise ValueError('%s: expected 64,000 index bytes and a 768 byte DAC' % stem)
    im = Image.frombytes('P', (320, 200), idx)
    table = []
    for i in range(256):
        r, g, b = pal[i * 3:i * 3 + 3]
        # DOSBox's six bit expansion, the same one the port uses.
        table += [(r << 2) | (r >> 4), (g << 2) | (g >> 4), (b << 2) | (b >> 4)]
    im.putpalette(table)
    return im.convert('RGB')


def differing(candidate, reference):
    """Pixels where any channel differs, as a greyscale mask."""
    diff = ImageChops.difference(candidate, reference)
    r, g, b = diff.split()
    return ImageChops.lighter(ImageChops.lighter(r, g), b)


def exact_pixels(candidate, reference):
    return differing(candidate, reference).histogram()[0]


def region_report(candidate, reference, bands):
    mask = differing(candidate, reference)
    out = []
    for name, top, bottom in bands:
        same = mask.crop((0, top, 320, bottom)).histogram()[0]
        out.append((name, same, 320 * (bottom - top)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('frames', help='directory written by tools/part2frames.mjs')
    ap.add_argument('reference', nargs='+', help='a reference PNG (or a directory with --all)')
    ap.add_argument('--all', action='store_true', help='treat reference as a directory of *.png')
    ap.add_argument('--top', type=int, default=3, help='how many best frames to print')
    args = ap.parse_args()

    stems = sorted(p[:-4] for p in glob.glob(os.path.join(args.frames, '*.idx')))
    if not stems:
        print('no .idx frames in %s (run tools/part2frames.mjs first)' % args.frames)
        return 2
    refs = []
    for r in args.reference:
        if args.all or os.path.isdir(r):
            refs += sorted(glob.glob(os.path.join(r, '*.png')))
        else:
            refs.append(r)
    if not refs:
        print('no reference PNGs')
        return 2

    images = {}
    any_perfect = 0
    for ref_path in refs:
        ref = Image.open(ref_path).convert('RGB')
        if ref.size != (320, 200):
            print('%s: %dx%d, expected 320x200' % (ref_path, *ref.size))
            return 2
        scores = []
        for stem in stems:
            im = images.get(stem)
            if im is None:
                im = images[stem] = frame_image(stem)
            scores.append((exact_pixels(im, ref), stem))
        scores.sort(reverse=True)
        print('\n%s' % os.path.basename(ref_path))
        for same, stem in scores[:args.top]:
            print('  %6d / 64000 exact  %s' % (same, os.path.basename(stem)))
        best_same, best_stem = scores[0]
        if best_same == 64000:
            any_perfect += 1
            print('  identical frame: %s' % os.path.basename(best_stem))
        else:
            best = images[best_stem]
            bands = [
                ('credit rows 70..89', 70, 90),
                ('credit rows 90..124', 90, 125),
                ('upper disc 0..69', 0, 70),
                ('lower disc 125..199', 125, 200),
            ]
            for name, same, total in region_report(best, ref, bands):
                print('    %-22s %6d / %6d' % (name, same, total))
    return 0 if any_perfect == len(refs) else 1


if __name__ == '__main__':
    sys.exit(main())
