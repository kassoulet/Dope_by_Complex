"""Decode a straight-line frame script: tools/scriptdump2.py <block> <from> <to> <runner hex> [<other call hex>=name ...]
-> JSON list of steps {ops:[[op,...]], ticks}.  ops: set addr size value | dec addr size | call name."""
import sys, glob, json, re
from capstone import *
blk, a, z, runner = int(sys.argv[1]), int(sys.argv[2], 16), int(sys.argv[3], 16), int(sys.argv[4], 16)
calls = dict((int(x.split('=')[0], 16), x.split('=')[1]) for x in sys.argv[5:] if '-' not in x.split('=')[0])
skips = [(int(x.split('=')[0].split('-')[0], 16), int(x.split('=')[0].split('-')[1], 16), x.split('=')[1]) for x in sys.argv[5:] if '-' in x.split('=')[0]]  # addr-addr=name: a block of code replaced by one named op
d = open(glob.glob('build/block%02d_*.bin' % blk)[0], 'rb').read()
md = Cs(CS_ARCH_X86, CS_MODE_16); md.detail = False
steps, ops, cx = [], [], None
for i in md.disasm(d[a:z], a):
    m, o = i.mnemonic, i.op_str
    sk = [k for k in skips if k[0] <= i.address < k[1]]
    if sk:
        if i.address == sk[0][0]: ops.append(['call', sk[0][2]])
        continue
    r = re.match(r'(word|dword) ptr cs:\[(0x[0-9a-f]+)\], (-?0x[0-9a-f]+|-?\d+)$', o)
    if m == 'mov' and r:
        v = int(r.group(3), 0)
        ops.append(['set', int(r.group(2), 16), 4 if r.group(1) == 'dword' else 2, v])
    elif m == 'mov' and o.startswith('cx, '):
        cx = int(o[4:], 0)
    elif m == 'call' and int(o, 16) == runner:
        steps.append({'ops': ops, 'ticks': cx}); ops = []
    elif m == 'call' and int(o, 16) in calls:
        ops.append(['call', calls[int(o, 16)]])
    elif m in ('dec', 'inc') and o.startswith('word ptr cs:['):
        ops.append([m, int(o[len('word ptr cs:['):-1], 16), 2])
    else:
        print('UNHANDLED', hex(i.address), m, o, file=sys.stderr)
if ops: steps.append({'ops': ops, 'ticks': None})
print(json.dumps(steps))
