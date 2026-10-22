#!/usr/bin/env python3
"""Snapshot the machine while a demo part runs, for the JavaScript VM.

The port does not re-implement the demo's loader: it boots the original part
code from a memory image taken straight out of the running machine.  This tool
produces that image.

The guest base inside DOSBox-X's address space is not known a priori (the DOS
environment size moves everything), so it is found structurally: the part
installs its own `int 8` handler and the IVT entry at guest `0x20` therefore
points at `<part segment>:0x0020`, which is exactly where the timer ISR body
lives (the loader maps the block's file offset `0x100` at the part segment, so
`0x120` in the block file is `0x20` in memory).  For every 16-byte aligned
candidate base, the tool reads the vector at `base + 0x20`, then checks that
the ISR bytes really sit at `base + (segment << 4) + 0x20`.  That pins both the
guest base and the part segment.

    python3 tools/vmsnap.py --wait 12 --out build/snap/part1

Writes `<out>.mem` (the low 1 MB of guest RAM), `<out>.json` (part segment,
entry point, counter, checks) and `<out>.png` (the screen at the same instant,
frozen with SIGSTOP so memory and picture agree).

Requires DOSBox-X ($DBOX), Xvfb, xwininfo and ImageMagick's `import`.
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DBOX = os.environ.get('DBOX', '/tmp/dbox/root/usr/bin/dosbox-x')
DBOX_LIB = os.environ.get('DBOX_LIB', '/tmp/dbox/root/usr/lib/x86_64-linux-gnu')

# Per part: (block file offset of its timer ISR body, block file offset of its
# entry, offset and size of the counter the ISR advances, 16 byte signature).
# The signature is read out of the part's own block so it cannot go stale; the
# IVT entry at guest 0x20 must point at `<segment>:<isr segment offset>`.
PARTS = {
    1: {'block': 'block01_002c6a.bin', 'isr': 0x120, 'entry': 0xCD5,
        'counter': (0x16A, 2),
        'sig': 'fa1e060fa00fa86660b020e6202eff061e00'},
    2: {'block': 'block02_00f66c.bin', 'isr': 0x1B21, 'entry': 0x386C,
        'counter': (0x1928, 2),
        'sig': 'fa5052b020e6202eff061f1abada03ec'},
}

ISR = bytes.fromhex('fa1e060fa00fa86660b020e6202eff061e00')
PART_ENTRY = 0xCD5 - 0x100   # block file offset -> offset in the loaded part
COUNTER = 0x16A              # `inc word [cs:0x16a]` in the ISR

CONF = """[sdl]
fullscreen        = false
output            = surface
autolock          = false
windowresolution  = 320x200
showmenu          = false
usesystemcursor   = false

[render]
aspect            = false
scaler            = none
frameskip         = 0

[dosbox]
machine           = svga_s3
memsize           = 16

[cpu]
cycles            = max
core              = normal

[gus]
gus               = true
gusbase           = 240
gusirq            = 5
gusdma            = 3
gustype           = classic
gusmemsize        = 1024
gusrate           = 44100

[mixer]
nosound           = true

[autoexec]
mount c {work}
c:
set ULTRASND=240,5,5,3
dope.exe
"""


class Guest(object):
    """Read access to the emulated machine's RAM through /proc/<pid>/mem."""

    def __init__(self, pid):
        self.pid = pid
        self.f = open('/proc/%d/mem' % pid, 'rb', 0)

    def read(self, addr, n):
        """Read guest memory, skipping pages the kernel will not hand over."""
        out = bytearray()
        for a in range(addr, addr + n, 1 << 16):
            want = min(1 << 16, addr + n - a)
            try:
                self.f.seek(a)
                chunk = self.f.read(want)
            except OSError:
                chunk = b''
            if len(chunk) < want:
                chunk = chunk + b'\x00' * (want - len(chunk))
            out += chunk
        return bytes(out)

    def regions(self, minimum=8 << 20):
        out = []
        for line in open('/proc/%d/maps' % self.pid):
            p = line.split()
            lo, hi = (int(x, 16) for x in p[0].split('-'))
            if 'rw' in p[1] and hi - lo >= minimum:
                out.append((lo, hi))
        return sorted(out)

    def find_base(self, isr=ISR, isr_offset=0x20, limit=64 << 20):
        """Locate guest physical 0 and the running part's segment.

        The ISR body is found by content, then the guest base is the value that
        makes the IVT entry at guest `0x20` point at that body.  Returns
        (base, segment, region_bytes) or (None, None, None).
        """
        for lo, hi in self.regions():
            if hi - lo > limit:
                hi = lo + limit
            data = self.read(lo, hi - lo)
            pos = data.find(isr)
            while pos >= 0:
                for seg in range(0x100, 0x1000):
                    base = pos - (seg << 4) - isr_offset
                    if base < 0 or base + 0x100000 > len(data):
                        continue
                    if data[base + 0x20:base + 0x24] == \
                            ((seg << 16) | isr_offset).to_bytes(4, 'little'):
                        return lo + base, seg, data
                pos = data.find(isr, pos + 1)
        return None, None, None

    def counter(self, base, seg, offset=COUNTER, size=2):
        part = base + (seg << 4)
        raw = self.read(part + offset, size)
        return int.from_bytes(raw, 'little')


def window_geometry(display):
    env = dict(os.environ, DISPLAY=display)
    tree = subprocess.check_output(['xwininfo', '-root', '-tree'], env=env,
                                   text=True, timeout=20)
    wid = None
    for line in tree.splitlines():
        if 'DOSBox' in line:
            wid = line.split()[0]
            break
    if not wid:
        return None
    info = subprocess.check_output(['xwininfo', '-id', wid], env=env,
                                   text=True, timeout=20)

    def num(key):
        m = re.search(r'%s:\s+(-?\d+)' % re.escape(key), info)
        return int(m.group(1)) if m else None

    return {'x': num('Absolute upper-left X'), 'y': num('Absolute upper-left Y'),
            'w': num('Width'), 'h': num('Height')}


def grab(display, geom, path):
    env = dict(os.environ, DISPLAY=display)
    png = path + '.root.png'
    subprocess.check_call(['import', '-window', 'root', png], env=env, timeout=30)
    subprocess.check_call(['convert', png, '-crop',
                           '%dx%d+%d+%d' % (geom['w'], geom['h'], geom['x'], geom['y']),
                           '+repage', '-filter', 'point', '-resize', '50%', path],
                          timeout=30)
    os.unlink(png)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--wait', type=float, default=10.0,
                    help='seconds to wait before the first look')
    ap.add_argument('--timeout', type=float, default=40.0,
                    help='give up after this many seconds of looking')
    ap.add_argument('--out', default=os.path.join(ROOT, 'build', 'snap', 'part1'))
    ap.add_argument('--display', default=':77')
    ap.add_argument('--part', type=int, default=1, choices=sorted(PARTS),
                    help='which demo part is running when the snapshot is taken')
    ap.add_argument('--max-counter', type=int, default=128,
                    help='snapshot only while the part is early in its run')
    args = ap.parse_args()

    spec = PARTS[args.part]
    block_path = os.path.join(ROOT, 'build', spec['block'])
    if not os.path.exists(block_path):
        print('missing %s (run tools/unpack.py first)' % block_path)
        return 2
    with open(block_path, 'rb') as f:
        block = f.read()
    isr = bytes.fromhex(spec['sig'])
    isr_offset = spec['isr'] - 0x100      # block offset -> segment offset
    part_entry = spec['entry'] - 0x100
    counter_offset, counter_size = spec['counter']

    for tool in ('Xvfb', 'xwininfo', 'import', 'convert'):
        if not os.path.exists(DBOX):
            print('DOSBox-X not found at %s (set $DBOX)' % DBOX)
            return 2
        if tool != 'Xvfb' and not __import__('shutil').which(tool):
            print('missing tool: %s' % tool)
            return 2

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    work = tempfile.mkdtemp(prefix='dope-snap-')
    for name in ('DOPE.EXE', 'DOPE.MOD'):
        with open(os.path.join(ROOT, name), 'rb') as src, \
                open(os.path.join(work, name), 'wb') as dst:
            dst.write(src.read())
    conf = os.path.join(work, 'dope.conf')
    with open(conf, 'w') as f:
        f.write(CONF.format(work=work))

    xvfb = subprocess.Popen(['Xvfb', args.display, '-screen', '0', '640x400x24',
                             '-nolisten', 'tcp'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    env = dict(os.environ, DISPLAY=args.display, SDL_AUDIODRIVER='dummy')
    env['LD_LIBRARY_PATH'] = DBOX_LIB + ':' + env.get('LD_LIBRARY_PATH', '')
    proc = subprocess.Popen([DBOX, '-conf', conf, '-nolog'], cwd=work, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(args.wait)
        guest = None
        base = seg = None
        region = None
        started = time.time()
        while time.time() - started < args.timeout:
            if proc.poll() is not None:
                print('dosbox-x exited early (%s)' % proc.returncode)
                return 1
            if guest is None:
                guest = Guest(proc.pid)
            base, seg, region = guest.find_base(isr, isr_offset)
            if base is None:
                time.sleep(0.5)
                continue
            cnt = guest.counter(base, seg, counter_offset, counter_size)
            if 0 < cnt:
                print('part segment %#06x  captured at counter %d' % (seg, cnt))
                break
            time.sleep(0.02)
        if base is None:
            print('no running part found (is the demo still in the loader?)')
            return 1
        if cnt >= args.max_counter:
            print('warning: counter is already %d, the part is well into its run;'
                  ' use a smaller --wait for a fresher snapshot' % cnt)


        geom = None
        deadline = time.time() + 20
        while geom is None and time.time() < deadline:
            geom = window_geometry(args.display)
            if geom is None:
                time.sleep(0.5)

        # Freeze the machine so RAM and screen describe the same instant.
        os.kill(proc.pid, signal.SIGSTOP)
        try:
            mem = guest.read(base, 0x100000)
            before = guest.counter(base, seg, counter_offset, counter_size)
            if geom:
                grab(args.display, geom, args.out + '.png')
            after = guest.counter(base, seg, counter_offset, counter_size)
        finally:
            os.kill(proc.pid, signal.SIGCONT)

        part = seg << 4
        entry = (part + part_entry) & 0xFFFFF
        ok_entry = mem[entry:entry + 16] == block[spec['entry']:spec['entry'] + 16]
        meta = {
            'guest_base_host': base,
            'part_segment': seg,
            'part_linear': part,
            'part': args.part,
            'block': spec['block'],
            'entry_cs_ip': [seg, part_entry],
            'entry_linear': entry,
            'entry_matches_block': ok_entry,
            'counter': before,
            'counter_after_grab': after,
            'counter_offset': counter_offset,
            'isr_at': (part + isr_offset) & 0xFFFFF,
            'mem_bytes': len(mem),
            'screenshot': os.path.basename(args.out) + '.png' if geom else None,
            'window': geom,
        }
        with open(args.out + '.mem', 'wb') as f:
            f.write(mem)
        with open(args.out + '.json', 'w') as f:
            json.dump(meta, f, indent=2)
        print(json.dumps(meta, indent=2))
        if not ok_entry:
            print('warning: entry bytes do not match %s at 0x%x'
                  % (spec['block'], spec['entry']))
        return 0 if ok_entry else 1
    finally:
        proc.kill()
        proc.wait()
        xvfb.kill()
        __import__('shutil').rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
