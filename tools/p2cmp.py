#!/usr/bin/env python3
"""Compare rig frames (build/out/p2frames) with counter-tagged references
(tools/refcapture.py --part 2 --tag-counters --out build/ref_p2c)."""
from PIL import Image
import json, glob, sys
refdir = sys.argv[1] if len(sys.argv) > 1 else 'build/ref_p2c'
for f in sorted(glob.glob(refdir + '/ref_*.png')):
    c = json.load(open(f[:-4] + '.json'))['counter']
    rp = Image.open(f).convert('RGB').load()
    out = []
    for d in (-1, 0, 1):
        g = glob.glob('build/out/p2frames/f*_c%05d.png' % (c + d))
        if not g: continue
        im = Image.open(g[0]).convert('RGB').load()
        out.append((d, sum(1 for y in range(200) for x in range(320) if im[x, y] != rp[x, y])))
    print(f[-12:], c, out)
