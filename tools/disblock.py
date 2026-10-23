"""Disassemble a range of an unpacked block (16 bit, file offsets): tools/dis.py <block> <from> <to>"""
import sys, glob
from capstone import *
d = open(glob.glob('build/block%02d_*.bin' % int(sys.argv[1]))[0], 'rb').read()
a, b = int(sys.argv[2], 16), int(sys.argv[3], 16)
for i in Cs(CS_ARCH_X86, CS_MODE_16).disasm(d[a:b], a):
    print("%04x %s %s" % (i.address, i.mnemonic, i.op_str))
