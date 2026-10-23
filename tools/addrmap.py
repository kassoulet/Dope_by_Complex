"""Map the data addresses of one block's listing onto another's (same code assembled elsewhere):
tools/addrmap.py <blockA> <fromA> <toA> <blockB> <fromB> <toB>  -> lines 'A -> B'"""
import sys, glob, re
from capstone import *
def lines(b, a, z):
    d = open(glob.glob('build/block%02d_*.bin' % int(b))[0], 'rb').read()
    return [(i.mnemonic, i.op_str) for i in Cs(CS_ARCH_X86, CS_MODE_16).disasm(d[int(a, 16):int(z, 16)], int(a, 16))]
A = lines(*sys.argv[1:4]); B = lines(*sys.argv[4:7])
# align by skipping lines that exist in only one (greedy on equal mnemonics)
i = j = 0; m = {}
H = re.compile(r'0x[0-9a-f]+')
while i < len(A) and j < len(B):
    ma, mb = A[i], B[j]
    if ma[0] == mb[0] and len(H.findall(ma[1])) == len(H.findall(mb[1])) and H.sub('N', ma[1]) == H.sub('N', mb[1]):
        for x, y in zip(H.findall(ma[1]), H.findall(mb[1])):
            m.setdefault(x, set()).add(y)
        i += 1; j += 1
    else:
        # resync: look ahead for a match
        for k in range(1, 8):
            if i + k < len(A) and A[i + k] == B[j]: i += k; break
            if j + k < len(B) and A[i] == B[j + k]: j += k; break
        else: i += 1; j += 1
for k in sorted(m, key=lambda s: int(s, 16)):
    print(k, '->', ' '.join(sorted(m[k], key=lambda s: int(s, 16))))
