#!/usr/bin/env python3
"""Run the state dumped by difftrace.mjs in Unicorn and report the first
instruction where the rig's x86 interpreter disagrees with a real x86 model.

    node tools/difftrace.mjs --at 26c6 --out build/diff
    .venv/bin/python tools/diffcheck.py build/diff
"""
import json, struct, sys
import numpy as np
from capstone import Cs, CS_ARCH_X86, CS_MODE_16
cs_ = Cs(CS_ARCH_X86, CS_MODE_16)
from unicorn import *
from unicorn.x86_const import *

d = sys.argv[1]
st = json.load(open(d + '/state.json'))['regs']
mem = open(d + '/mem.bin', 'rb').read()
tr = np.fromfile(d + '/trace.bin', dtype=np.int32).reshape(-1, 16).astype(np.uint32)

uc = Uc(UC_ARCH_X86, UC_MODE_16)
uc.mem_map(0, 1 << 20)
uc.mem_write(0, mem)
R = [UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_EBX, UC_X86_REG_ESP, UC_X86_REG_EBP, UC_X86_REG_ESI, UC_X86_REG_EDI]
S = [UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_ES, UC_X86_REG_FS, UC_X86_REG_GS, UC_X86_REG_SS]
ip, cs, ds, es, fs, gs, ss = st[:7]
for r, v in zip(S, [cs, ds, es, fs, gs, ss]):
    uc.reg_write(r, v & 0xffff)
for r, v in zip(R, st[7:15]):
    uc.reg_write(r, v & 0xffffffff)
uc.reg_write(UC_X86_REG_EFLAGS, (st[15] & 0xdd5) | 0x202)
uc.reg_write(UC_X86_REG_EIP, ip)  # real mode: eip is the offset, cs base applied by the CPU

MASK = 0x4c5  # CF PF ZF SF DF; AF and OF are undefined after some logic and shift ops, so they are not compared
names = ['ip', 'cs', 'ds', 'es', 'fs', 'gs', 'ss', 'eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'flags']
ureg = [None, UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_ES, UC_X86_REG_FS, UC_X86_REG_GS, UC_X86_REG_SS] + R + [UC_X86_REG_EFLAGS]

def uregs():
    out = [uc.reg_read(UC_X86_REG_EIP) & 0xffff]
    for r in ureg[1:]:
        v = uc.reg_read(r)
        out.append(v & (MASK if r == UC_X86_REG_EFLAGS else 0xffffffff))
    return out

writes = json.load(open(d + '/writes.json'))
wlog = []
cur = [0]
def on_write(uc_, access, address, size, value, ud):
    wlog.append((cur[0], address, size, value & ((1 << (size * 8)) - 1)))
uc.hook_add(UC_HOOK_MEM_WRITE, on_write)
wi = 0

for k in range(len(tr)):
    cur[0] = k
    pc = uc.reg_read(UC_X86_REG_CS) * 16 + uc.reg_read(UC_X86_REG_EIP)
    code = bytes(uc.mem_read(pc, 12))
    try:
        uc.emu_start(uc.reg_read(UC_X86_REG_CS) * 16 + uc.reg_read(UC_X86_REG_EIP), 0, count=1)
    except UcError as e:
        print('unicorn error at step', k, e); break
    # compare the stores this instruction made, in order, before the registers
    mine = [w for w in wlog if w[0] == k]
    theirs = []
    while wi < len(writes) and writes[wi][0] == k:
        theirs.append(tuple(writes[wi])); wi += 1
    if [(a, b, c) for _, a, b, c in mine] != [(a, b, c) for _, a, b, c in theirs]:
        lin = int(tr[k - 1][1]) * 16 + int(tr[k - 1][0]) if k else 0
        print('STORE DIVERGE at instruction %d (ip before %#x):' % (k, int(tr[k - 1][0]) if k else -1))
        print('  unicorn', [(hex(a), b, hex(c)) for _, a, b, c in mine])
        print('  rig    ', [(hex(a), b, hex(c)) for _, a, b, c in theirs])
        sys.exit(1)
    wlog.clear()
    got = uregs()
    want = [int(x) for x in tr[k]]
    rawflags = want[15]
    ins = next(cs_.disasm(code, 0), None)
    mn = ins.mnemonic if ins else ''
    # which flags the architecture defines after this instruction
    fm = {'imul': 0x1, 'mul': 0x1, 'div': 0, 'idiv': 0}.get(mn.replace('rep ', ''), MASK)
    got[15] &= fm
    want[15] &= fm
    for i in range(16):
        if i >= 1 and i <= 6:
            got[i] &= 0xffff
            want[i] &= 0xffff
        if got[i] != want[i]:
            print('DIVERGE at instruction %d: %s rig=%#x unicorn=%#x' % (k, names[i], want[i], got[i]))
            ins = next(cs_.disasm(code, 0), None)
            print('instruction:', code.hex(), '->', (ins.mnemonic + ' ' + ins.op_str) if ins else '?')
            print('rig  :', ' '.join('%s=%x' % (n, v) for n, v in zip(names, want)))
            print('uni  :', ' '.join('%s=%x' % (n, v) for n, v in zip(names, got)))
            sys.exit(1)
    if fm != MASK:  # flags the architecture leaves undefined: continue from the rig's values
        uc.reg_write(UC_X86_REG_EFLAGS, (rawflags & 0xdd5) | 0x202)
print('no divergence in', len(tr), 'instructions')
