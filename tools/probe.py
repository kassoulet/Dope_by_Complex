#!/usr/bin/env python3
"""Inspect the emulated machine while DOPE.EXE runs.

DOSBox-X is started as a child of this script, which is what makes
/proc/<pid>/mem readable (yama ptrace_scope=1 permits a parent to read its
child).  Every unpacked block is located in the emulated address space with a
needle taken from its most distinctive bytes; the result is the linear load
layout that the demo's own loader produces, which the JavaScript port has to
reproduce.

    python3 tools/probe.py --wait 15 --dump build/probe/ram.bin

Requires DOSBox-X ($DBOX) and Xvfb.  See tools/refcapture.py for the same
bootstrap.
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DBOX = os.environ.get('DBOX', '/tmp/dbox/root/usr/bin/dosbox-x')
DBOX_LIB = os.environ.get('DBOX_LIB', '/tmp/dbox/root/usr/lib/x86_64-linux-gnu')

CONF = """[sdl]
fullscreen        = false
output            = surface
windowresolution  = 320x200
[render]
aspect            = false
scaler            = none
[dosbox]
machine           = svga_s3
memsize           = 16
[cpu]
cycles            = max
[gus]
gus               = true
gusbase           = 240
gusirq            = 5
gusdma             = 3
gustype           = classic
gusmemsize        = 1024
[mixer]
nosound           = true
[autoexec]
mount c {work}
c:
set ULTRASND=240,5,5,3
dope.exe
"""


def blocks():
    out = []
    for name in sorted(os.listdir(os.path.join(ROOT, 'build'))):
        m = re.match(r'block(\d\d)_([0-9a-f]+)\.bin$', name)
        if m:
            with open(os.path.join(ROOT, 'build', name), 'rb') as f:
                out.append((int(m.group(1)), f.read()))
    return out


def needle(blob, length=64):
    best = (-1, 0)
    for off in range(0x100, len(blob) - length, 131):
        w = blob[off:off + length]
        score = len(set(w)) - 2 * w.count(0)
        if score > best[0]:
            best = (score, off)
    off = best[1]
    return off, blob[off:off + length]


class Mem(object):
    def __init__(self, pid):
        self.f = open('/proc/%d/mem' % pid, 'rb', 0)
        self.regions = []
        for line in open('/proc/%d/maps' % pid):
            p = line.split()
            lo, hi = (int(x, 16) for x in p[0].split('-'))
            if 'rw' in p[1] and hi - lo >= 8 << 20:
                self.regions.append((lo, hi))
        self.regions.sort()

    def read(self, lo, hi):
        out = bytearray()
        for a in range(lo, hi, 1 << 16):
            n = min(1 << 16, hi - a)
            try:
                self.f.seek(a)
                out += self.f.read(n)
            except OSError:
                out += b'\x00' * n
        return bytes(out)

    def find_image(self, blob0):
        """Return (host address, contents) of the region holding the demo image.

        The loader is the first thing the demo puts in RAM, so the region that
        contains its leading bytes is the one to report.  Its offset inside
        that buffer is the DOS load offset; the absolute guest address can
        shift by a paragraph with the DOS environment size, so only offsets
        relative to the loader and to each other are stable.
        """
        head = blob0[:64]
        for lo, hi in self.regions:
            data = self.read(lo, hi)
            if head in data:
                return lo, data
        return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--wait', type=float, default=15.0)
    ap.add_argument('--dump', default=None)
    ap.add_argument('--display', default=':79')
    args = ap.parse_args()

    work = tempfile.mkdtemp(prefix='dope-probe-')
    for name in ('DOPE.EXE', 'DOPE.MOD'):
        with open(os.path.join(ROOT, name), 'rb') as src, \
                open(os.path.join(work, name), 'wb') as dst:
            dst.write(src.read())
    conf = os.path.join(work, 'dope.conf')
    with open(conf, 'w') as f:
        f.write(CONF.format(work=work))

    xvfb = subprocess.Popen(['Xvfb', args.display, '-screen', '0', '800x600x24',
                             '-nolisten', 'tcp'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    env = dict(os.environ, DISPLAY=args.display, SDL_AUDIODRIVER='dummy')
    env['LD_LIBRARY_PATH'] = DBOX_LIB + ':' + env.get('LD_LIBRARY_PATH', '')
    proc = subprocess.Popen([DBOX, '-conf', conf, '-nolog'], cwd=work, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(args.wait)
        if proc.poll() is not None:
            print('dosbox-x exited early (%s)' % proc.returncode)
            return 1
        mem = Mem(proc.pid)
        base, ram = mem.find_image(blocks()[0][1])
        if ram is None:
            print('unpacked image not found in emulated memory')
            return 1
        print('emulated RAM buffer at %#x (%d MB)' % (base, len(ram) >> 20))
        loader = ram.find(blocks()[0][1][:64])
        print('loader image at buffer + %#x' % loader)
        for idx, blob in blocks():
            # Locate the block by a distinctive slice and confirm the head (or,
            # for parts whose head is patched by the loader, the mode 13h
            # sequence at 0xcd5) lands where the block says it should.
            off, pat = needle(blob)
            hits = []
            s = 0
            while True:
                i = ram.find(pat, s)
                if i < 0:
                    break
                candidate = i - off
                if candidate >= 0 and (ram[candidate:candidate + 64] == blob[:64]
                                       or ram[candidate + 0xcd5:candidate + 0xce5]
                                       == blob[0xcd5:0xce5]):
                    hits.append(candidate)
                s = i + 1
            rel = ' '.join('%#x' % (h - loader) for h in hits[:4]) if hits else 'not resident'
            print('block %d: %s' % (idx, rel))
        if args.dump:
            os.makedirs(os.path.dirname(args.dump) or '.', exist_ok=True)
            with open(args.dump, 'wb') as f:
                f.write(ram)
            print('wrote %d bytes to %s' % (len(ram), args.dump))
        return 0
    finally:
        proc.kill()
        proc.wait()
        xvfb.kill()


if __name__ == '__main__':
    sys.exit(main())
