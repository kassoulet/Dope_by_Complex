#!/usr/bin/env python3
"""Replay a whole part run (tools/difftrace2.mjs) in Unicorn and report the first
instruction where the rig's x86 interpreter disagrees: registers, flags, stores.

    node tools/difftrace2.mjs 6 --n 2000000 --out build/diff6
    .venv/bin/python tools/diffcheck2.py build/diff6
"""
import json, sys
import numpy as np
from collections import defaultdict
from unicorn import *
from unicorn.x86_const import *
from capstone import Cs, CS_ARCH_X86, CS_MODE_16

d = sys.argv[1]
st = json.load(open(d + '/state.json'))
mem = open(d + '/mem.bin', 'rb').read()
tr = np.fromfile(d + '/trace.bin', dtype=np.int32).reshape(-1, 16).astype(np.uint32)
ev = json.load(open(d + '/events.json'))
writes = json.load(open(d + '/writes.json'))
cs_ = Cs(CS_ARCH_X86, CS_MODE_16)

ins_by_k = defaultdict(list)
for k, port, size, v in ev['in']: ins_by_k[k].append((port, size, v))
irq = set(ev['irq']); hle = set(ev['hle'])
wr_by_k = defaultdict(list)
for k, a, s, v in writes: wr_by_k[k].append((a, s, v))

uc = Uc(UC_ARCH_X86, UC_MODE_16)
uc.mem_map(0, 1 << 20)
uc.mem_write(0, mem)
R = [UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_EBX, UC_X86_REG_ESP, UC_X86_REG_EBP, UC_X86_REG_ESI, UC_X86_REG_EDI]
S = [UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_ES, UC_X86_REG_FS, UC_X86_REG_GS, UC_X86_REG_SS]
r0 = st['regs']
for r, v in zip(S, r0[1:7]): uc.reg_write(r, v & 0xffff)
for r, v in zip(R, r0[7:15]): uc.reg_write(r, v & 0xffffffff)
uc.reg_write(UC_X86_REG_EFLAGS, (r0[15] & 0xdd5) | 0x202 | (0x200 if st['if'] else 0))
uc.reg_write(UC_X86_REG_EIP, r0[0])

cur = [0]; pending_in = [[]]
def hook_in(uc_, port, size, ud):
    q = pending_in[0]
    if not q: return 0
    p, s, v = q.pop(0)
    return v & ((1 << (size * 8)) - 1)
def hook_out(uc_, port, size, value, ud): pass
uc.hook_add(UC_HOOK_INSN, hook_in, None, 1, 0, UC_X86_INS_IN)
uc.hook_add(UC_HOOK_INSN, hook_out, None, 1, 0, UC_X86_INS_OUT)
wlog = []
uc.hook_add(UC_HOOK_MEM_WRITE, lambda u, a, ad, sz, v, ud: wlog.append((ad, sz, v & ((1 << (sz * 8)) - 1))))

names = ['ip', 'cs', 'ds', 'es', 'fs', 'gs', 'ss', 'eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'flags']
ureg = [None] + S[:0] + [UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_ES, UC_X86_REG_FS, UC_X86_REG_GS, UC_X86_REG_SS] + R + [UC_X86_REG_EFLAGS]
MASK = 0x4c5

def uregs():
    out = [uc.reg_read(UC_X86_REG_EIP) & 0xffff]
    for r in ureg[1:]:
        v = uc.reg_read(r)
        out.append(v & (MASK if r == UC_X86_REG_EFLAGS else 0xffffffff))
    return out

def set_state(row):
    for r, v in zip([UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_ES, UC_X86_REG_FS, UC_X86_REG_GS, UC_X86_REG_SS], row[1:7]): uc.reg_write(r, int(v) & 0xffff)
    for r, v in zip(R, row[7:15]): uc.reg_write(r, int(v))
    uc.reg_write(UC_X86_REG_EFLAGS, (int(row[15]) & 0xdd5) | 0x202)
    uc.reg_write(UC_X86_REG_EIP, int(row[0]))

UNDEF = {'imul': 0x1, 'mul': 0x1, 'div': 0, 'idiv': 0}
for k in range(len(tr)):
    cur[0] = k
    pc = uc.reg_read(UC_X86_REG_CS) * 16 + (uc.reg_read(UC_X86_REG_EIP) & 0xffff)
    code = bytes(uc.mem_read(pc, 12))
    ins = next(cs_.disasm(code, 0), None)
    mn = ins.mnemonic.replace('rep ', '').replace('repe ', '').replace('repne ', '') if ins else ''
    ip0 = uc.reg_read(UC_X86_REG_EIP) & 0xffff
    pending_in[0] = list(ins_by_k.get(k, []))
    wlog.clear()
    if k in hle:
        set_state(tr[k]); continue
    try:
        uc.emu_start(pc, 0, count=1)
    except UcError as e:
        print('unicorn error at', k, e, code.hex()); break
    # a rep string instruction is one step in the rig; Unicorn may run one iteration per call
    has_rep = any(c in (0xf2, 0xf3) for c in code[:4]) and mn in ('movsb', 'movsw', 'movsd', 'stosb', 'stosw', 'stosd', 'lodsb', 'lodsw', 'lodsd', 'insb', 'outsb', 'cmpsb', 'scasb')
    if has_rep:
        guard = 0
        while (uc.reg_read(UC_X86_REG_EIP) & 0xffff) == ip0 and guard < 70000:
            try: uc.emu_start(pc, 0, count=1)
            except UcError: break
            guard += 1
    if k in irq:
        sp = uc.reg_read(UC_X86_REG_ESP) & 0xffff; ss = uc.reg_read(UC_X86_REG_SS) * 16
        fl = uc.reg_read(UC_X86_REG_EFLAGS) & 0xffff; csr = uc.reg_read(UC_X86_REG_CS); ipr = uc.reg_read(UC_X86_REG_EIP) & 0xffff
        for v in (fl, csr, ipr):
            sp = (sp - 2) & 0xffff; uc.mem_write(ss + sp, v.to_bytes(2, 'little')); wlog.append((ss + sp, 2, v))
        uc.reg_write(UC_X86_REG_ESP, (uc.reg_read(UC_X86_REG_ESP) & 0xffff0000) | sp)
        vec = bytes(uc.mem_read(0x20, 4))
        uc.reg_write(UC_X86_REG_EFLAGS, uc.reg_read(UC_X86_REG_EFLAGS) & ~0x300)
        uc.reg_write(UC_X86_REG_CS, int.from_bytes(vec[2:], 'little'))
        uc.reg_write(UC_X86_REG_EIP, int.from_bytes(vec[:2], 'little'))
        fm_all = True
    # stores
    mine = [(a, s, v) for a, s, v in wlog if not (0xa0000 <= a < 0xb0000)]
    theirs = [tuple(w) for w in wr_by_k.get(k, []) if not (0xa0000 <= w[0] < 0xb0000)]
    if k in irq:  # the pushed FLAGS word: compare only the architectural bits
        mine = [(a, sz, v & 0xfd5) if i == 0 else (a, sz, v) for i, (a, sz, v) in enumerate(mine)] if False else mine
        fix = lambda L: [(a, sz, (v & 0xfd5) if (sz == 2 and i == len(L) - 3) else v) for i, (a, sz, v) in enumerate(L)]
        mine, theirs = fix(mine), fix(theirs)
    mine, theirs = sorted(mine), sorted(theirs)
    if mine != theirs:
        print('STORE DIVERGE at instruction %d: %s' % (k, ins.mnemonic + ' ' + ins.op_str if ins else code.hex()))
        print('  unicorn', [(hex(a), s, hex(v)) for a, s, v in mine][:6]); print('  rig    ', [(hex(a), s, hex(v)) for a, s, v in theirs][:6]); sys.exit(1)
    got = uregs(); want = [int(x) for x in tr[k]]
    raw = want[15]
    fm = UNDEF.get(mn, MASK)
    if k in irq: fm = MASK & ~0x0  # after an interrupt entry flags are compared as normal
    got[15] &= fm; want[15] &= fm
    for i in range(16):
        if 1 <= i <= 6: got[i] &= 0xffff; want[i] &= 0xffff
        if got[i] != want[i]:
            print('DIVERGE at instruction %d: %s rig=%#x unicorn=%#x' % (k, names[i], want[i], got[i]))
            print('instruction:', code.hex(), '->', (ins.mnemonic + ' ' + ins.op_str) if ins else '?', ' at %04x:%04x' % (pc >> 4 & 0xffff if False else 0xf8b, pc - 0xf8b0))
            print('rig  :', ' '.join('%s=%x' % (n, v) for n, v in zip(names, want))); print('uni  :', ' '.join('%s=%x' % (n, v) for n, v in zip(names, got)))
            sys.exit(1)
    if fm != MASK: uc.reg_write(UC_X86_REG_EFLAGS, (raw & 0xdd5) | 0x202 | (uc.reg_read(UC_X86_REG_EFLAGS) & 0x200))
print('no divergence in', len(tr), 'instructions')
