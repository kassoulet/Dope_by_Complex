#!/usr/bin/env python3
"""Find what the loader patched: diff a start-of-part snapshot against the block.

    python3 tools/relocdiff.py 3          # build/snap/block3.* vs build/block03_*.bin

Prints the words that differ by exactly (segment - 0x10) -- the loader's
relocations -- and counts the other differences (state the part wrote itself).
"""
import glob, json, sys
n = int(sys.argv[1]); snap = sys.argv[2] if len(sys.argv) > 2 else 'build/snap'
blk = open(glob.glob('build/block%02d_*.bin' % n)[0], 'rb').read()
mem = open('%s/block%d.mem' % (snap, n), 'rb').read()
meta = json.load(open('%s/block%d.json' % (snap, n)))
seg = meta['part_segment']; add = seg - 0x10
base = seg * 16
size = len(blk) - 0x100
part = mem[base: base + size]
img = blk[0x100:]
reloc = []; other = 0
i = 0
diff = [j for j in range(min(len(part), len(img))) if part[j] != img[j]]
ds = set(diff)
j = 0
words = []
for j in diff:
    if j + 1 < size and j in ds and (j + 1) in ds or True:
        pass
cnt_w = 0
used = set()
for j in diff:
    if j in used: continue
    if j + 1 < size:
        a = img[j] | img[j + 1] << 8; b = part[j] | part[j + 1] << 8
        if ((a + add) & 0xffff) == b:
            reloc.append(j); used.update((j, j + 1)); continue
    other += 1
print('block %d: segment %#x, image %d bytes, %d bytes differ' % (n, seg, size, len(diff)))
print('relocated words (+%#x): %d' % (add, len(reloc)))
print(' '.join('%x' % r for r in reloc[:80]))
print('other differing bytes (part state):', other)
json.dump(reloc, open('%s/block%d.reloc.json' % (snap, n), 'w'))
