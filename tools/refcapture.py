#!/usr/bin/env python3
"""Capture reference frames from the original DOPE.EXE.

Runs the real demo in DOSBox-X (Gravis Ultrasound emulation on) on a private
Xvfb display and grabs the emulated screen at native VGA resolution: the
DOSBox window is the 320x200 surface at 2x, so each grab is cropped to the
window and halved with nearest-neighbour sampling, which recovers the exact
indexed image after the VGA DAC mapping.

    python3 tools/refcapture.py --seconds 60 --interval 1 --out build/ref

Requires DOSBox-X ($DBOX, default /tmp/dbox/root/usr/bin/dosbox-x and its
private libs in $DBOX_LIB), Xvfb, xwininfo and ImageMagick's `import`.
Nothing is written outside the output directory and a temp working dir.
"""

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vmsnap import Guest, PARTS  # noqa: E402  (same directory, shares the guest reader)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DBOX = os.environ.get('DBOX', '/tmp/dbox/root/usr/bin/dosbox-x')
DBOX_LIB = os.environ.get('DBOX_LIB', '/tmp/dbox/root/usr/lib/x86_64-linux-gnu')

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
    return {
        'id': wid,
        'x': num('Absolute upper-left X'),
        'y': num('Absolute upper-left Y'),
        'w': num('Width'),
        'h': num('Height'),
    }


def grab(display, geom, path):
    env = dict(os.environ, DISPLAY=display)
    png = path + '.root.png'
    subprocess.check_call(['import', '-window', 'root', png], env=env, timeout=30)
    subprocess.check_call([
        'convert', png, '-crop', '%dx%d+%d+%d' % (geom['w'], geom['h'], geom['x'], geom['y']),
        '+repage', '-filter', 'point', '-resize', '50%', path], timeout=30)
    os.unlink(png)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seconds', type=float, default=60.0, help='total capture time')
    ap.add_argument('--interval', type=float, default=1.0, help='seconds between grabs')
    ap.add_argument('--start', type=float, default=0.0, help='wait before the first grab')
    ap.add_argument('--out', default=os.path.join(ROOT, 'build', 'ref'))
    ap.add_argument('--display', default=':78')
    ap.add_argument('--part', type=int, default=1, choices=sorted(PARTS),
                    help='which part --tag-counters follows (vmsnap.PARTS)')
    ap.add_argument('--tag-counters', action='store_true',
                    help=('freeze the demo around each grab and record its frame '
                          'counter, so a VM frame can be matched to this picture'))
    args = ap.parse_args()

    for tool in ('Xvfb', 'xwininfo', 'import', 'convert'):
        if not shutil.which(tool):
            print('missing tool: %s' % tool)
            return 2
    if not os.path.exists(DBOX):
        print('DOSBox-X not found at %s (set $DBOX)' % DBOX)
        return 2

    os.makedirs(args.out, exist_ok=True)
    work = tempfile.mkdtemp(prefix='dope-ref-')
    for name in ('DOPE.EXE', 'DOPE.MOD'):
        shutil.copy(os.path.join(ROOT, name), work)
    conf = os.path.join(work, 'dope.conf')
    with open(conf, 'w') as f:
        f.write(CONF.format(work=work))

    xvfb = subprocess.Popen(['Xvfb', args.display, '-screen', '0', '640x400x24',
                             '-nolisten', 'tcp'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    env = dict(os.environ)
    env['DISPLAY'] = args.display
    env['LD_LIBRARY_PATH'] = DBOX_LIB + ':' + env.get('LD_LIBRARY_PATH', '')
    env['SDL_AUDIODRIVER'] = 'dummy'
    proc = subprocess.Popen([DBOX, '-conf', conf, '-nolog'], cwd=work, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(args.start)
        geom = None
        deadline = time.time() + 30
        while geom is None and time.time() < deadline:
            geom = window_geometry(args.display)
            if geom is None:
                time.sleep(0.5)
        if geom is None:
            print('no DOSBox window appeared')
            return 1
        if (geom['w'], geom['h']) != (640, 400):
            print('window is %dx%d, expected 640x400 (2x the 320x200 surface);'
                  ' the crop would not be pixel exact' % (geom['w'], geom['h']))
            return 1
        guest = None
        base = seg = None
        spec = PARTS[args.part]
        isr = bytes.fromhex(spec['sig'])
        isr_offset = spec['isr'] - 0x100
        cnt_off, cnt_size = spec['counter']
        if args.tag_counters:
            guest = Guest(proc.pid)
            for _ in range(120):
                base, seg, _ = guest.find_base(isr, isr_offset)
                if base is not None:
                    break
                time.sleep(0.5)
                if base is not None:
                    break
                time.sleep(0.5)
            if base is None:
                print('no running part found; cannot tag counters')
                return 1
            print('tagging counters from part segment %#06x' % seg)

        frames = int(args.seconds / args.interval)
        t0 = time.time()
        last_counter = -1
        for i in range(frames):
            path = os.path.join(args.out, 'ref_%04d.png' % i)
            if guest is not None:
                # Freeze the machine so the picture and the counter inside it
                # belong to the same instant, then grab the frozen screen.
                os.kill(proc.pid, signal.SIGSTOP)
                try:
                    before = guest.counter(base, seg, cnt_off, cnt_size)
                    grab(args.display, geom, path)
                    after = guest.counter(base, seg, cnt_off, cnt_size)
                finally:
                    os.kill(proc.pid, signal.SIGCONT)
                with open(path[:-4] + '.json', 'w') as f:
                    json.dump({'counter': before, 'counter_after': after}, f)
                print('%s  t=%.2fs  counter %d' % (os.path.basename(path), time.time() - t0, before))
                if before < last_counter:
                    print('counter went back to %d: the part restarted or ended, stopping'
                          % before)
                    return 0
                last_counter = before
            else:
                grab(args.display, geom, path)
                print('%s  t=%.2fs' % (os.path.basename(path), time.time() - t0))
            time.sleep(max(0.0, args.interval - 0.05))
        return 0
    finally:
        proc.kill()
        proc.wait()
        xvfb.kill()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
