#!/usr/bin/env python3
"""Snapshot every demo part at its start, in one DOSBox-X run.

Each part installs its own int 8 handler, so the IVT entry at guest 0x20
changes to `<part segment>:<isr offset>` when a part starts.  This watches that
vector, and the moment it points at a known part ISR it freezes the machine and
writes the low megabyte, the screen and a json sidecar:

    python3 tools/blocksnap.py --seconds 460 --out build/snap

writes build/snap/block<N>.mem/.json/.png and prints the wall-clock time each
part started (the demo's real part boundaries).
"""
import argparse, json, os, shutil, signal, subprocess, sys, tempfile, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vmsnap import Guest, CONF, DBOX, DBOX_LIB, ROOT, window_geometry, grab  # noqa: E402

# ISR offset in the loaded part (block file offset - 0x100) -> block number
ISR = {0x20: 1, 0x1a21: 2, 0x1a43: 3, 0x1420: 4, 0x15d7: 5, 0x17ee: 6, 0x1a47: 7}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seconds', type=float, default=460)
    ap.add_argument('--out', default=os.path.join(ROOT, 'build', 'snap'))
    ap.add_argument('--display', default=':79')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    work = tempfile.mkdtemp(prefix='dope-blocks-')
    for n in ('DOPE.EXE', 'DOPE.MOD'):
        shutil.copy(os.path.join(ROOT, n), work)
    with open(os.path.join(work, 'dope.conf'), 'w') as f:
        f.write(CONF.format(work=work))
    xvfb = subprocess.Popen(['Xvfb', args.display, '-screen', '0', '640x400x24', '-nolisten', 'tcp'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    env = dict(os.environ, DISPLAY=args.display, SDL_AUDIODRIVER='dummy')
    env['LD_LIBRARY_PATH'] = DBOX_LIB + ':' + env.get('LD_LIBRARY_PATH', '')
    proc = subprocess.Popen([DBOX, '-conf', conf_path(work), '-nolog'], cwd=work, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    t0 = time.time()
    try:
        guest = Guest(proc.pid)
        base = None
        while base is None and time.time() - t0 < 90:
            base, seg, _ = guest.find_base()
            time.sleep(0.2)
        if base is None:
            print('part 1 never appeared'); return 1
        print('guest found at %.1fs, part 1 segment %#x' % (time.time() - t0, seg))
        geom = window_geometry(args.display)
        seen = set()
        last = None
        while time.time() - t0 < args.seconds and proc.poll() is None:
            raw = guest.read(base + 0x20, 4)
            off = raw[0] | raw[1] << 8
            segv = raw[2] | raw[3] << 8
            if (segv, off) != last:
                last = (segv, off)
                n = ISR.get(off)
                if n and n not in seen:
                    os.kill(proc.pid, signal.SIGSTOP)
                    try:
                        mem = guest.read(base, 0x100000)
                        if geom: grab(args.display, geom, '%s/block%d.png' % (args.out, n))
                    finally:
                        os.kill(proc.pid, signal.SIGCONT)
                    seen.add(n)
                    meta = {'block': n, 'part_segment': segv, 'isr_off': off, 'wall': round(time.time() - t0, 2)}
                    with open('%s/block%d.mem' % (args.out, n), 'wb') as f: f.write(mem)
                    with open('%s/block%d.json' % (args.out, n), 'w') as f: json.dump(meta, f)
                    print('block %d starts at %.2fs (segment %#x)' % (n, time.time() - t0, segv), flush=True)
                elif not n:
                    print('  vector -> %04x:%04x at %.2fs' % (segv, off, time.time() - t0), flush=True)
            time.sleep(0.003)
    finally:
        proc.kill(); proc.wait(); xvfb.kill(); shutil.rmtree(work, ignore_errors=True)

def conf_path(work): return os.path.join(work, 'dope.conf')

if __name__ == '__main__':
    sys.exit(main())
