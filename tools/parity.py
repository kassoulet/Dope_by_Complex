#!/usr/bin/env python3
"""Compare the JS replayer against libopenmpt on DOPE.MOD.

The reference is rendered once by openmpt123 and cached as raw PCM in
build/reference.raw, so both sides always share one sample grid.

Reports the correlation of the loudness envelope plus the clock drift:

* short mode (default 20 s): 0.5 s blocks, must be > 0.95
* full mode: the whole 8:34 tune, drift must stay under 1 s total

Needs node, ffmpeg, openmpt123 and numpy.

Usage: python3 tools/parity.py [seconds | full]

Window mode always starts at 0: over several minutes the two players drift
apart by a fraction of a second (see clock drift in full mode), which is
larger than a 0.5 s envelope block, so a mid song window would compare
misaligned material and mean nothing.
"""

import os
import shutil
import subprocess
import sys
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
SR = 44100
FULL_SECONDS = 515  # the tune is 8:34.688
REFERENCE = os.path.join(BUILD, "reference.raw")


def require(name):
    if not shutil.which(name):
        raise SystemExit("missing tool: %s" % name)


def read_mono(path):
    import numpy as np

    if path.endswith(".raw"):
        data = np.fromfile(path, dtype=np.int16).astype(np.float32)
        return data.reshape(-1, 2).mean(axis=1) / 32768.0
    with wave.open(path) as w:
        frames = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return frames.astype(np.float32).reshape(-1, 2).mean(axis=1) / 32768.0


def reference():
    """Full song render from openmpt123, cached in build/reference.raw."""
    expected = int(FULL_SECONDS * SR) * 4
    if os.path.exists(REFERENCE) and os.path.getsize(REFERENCE) >= expected - 4:
        return read_mono(REFERENCE)

    os.makedirs(BUILD, exist_ok=True)
    subprocess.run(
        ["openmpt123", "--render", "--samplerate", str(SR), "--channels", "2",
         "--no-progress", "--banner", "0", "--output-type", "wav", "--force",
         "DOPE.MOD"],
        check=True, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    produced = os.path.join(ROOT, "DOPE.MOD.wav")
    if not os.path.exists(produced):
        raise SystemExit("openmpt123 did not produce DOPE.MOD.wav")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", produced,
         "-ac", "2", "-ar", str(SR), "-f", "s16le", REFERENCE],
        check=True,
    )
    os.remove(produced)
    return read_mono(REFERENCE)


def envelope(x, block):
    import numpy as np

    n = int(SR * block)
    k = len(x) // n
    return np.sqrt((x[: k * n].reshape(k, n) ** 2).mean(axis=1))


def best_lag(a, b, max_lag=15):
    import numpy as np

    best = (-9.0, 0)
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            x, y = a[lag:], b[: len(b) - lag]
        else:
            x, y = a[: len(a) + lag], b[-lag:]
        if len(x) < 50:
            continue
        r = float(np.corrcoef(x, y)[0, 1])
        if r > best[0]:
            best = (r, lag)
    return best


def clock_drift(ref, js):
    import numpy as np

    a = envelope(ref, 0.1)
    b = envelope(js, 0.1)
    k = min(len(a), len(b))
    a, b = a[:k], b[:k]
    seg = 400  # 40 s windows at 0.1 s resolution
    points = []
    for start in range(0, k - seg, seg):
        _, lag = best_lag(a[start:start + seg], b[start:start + seg])
        points.append((start * 0.1, lag * 0.1))
    if len(points) < 2:
        return points, 0.0
    t = np.array([p[0] for p in points])
    d = np.array([p[1] for p in points])
    return points, float(np.polyfit(t, d, 1)[0])


def main(argv):
    mode = argv[1] if len(argv) > 1 else "20"
    full = mode == "full"
    seconds = FULL_SECONDS if full else int(mode)
    if len(argv) > 2:
        raise SystemExit("window mode always starts at 0, see the docstring")

    for tool in ("node", "ffmpeg", "openmpt123"):
        require(tool)
    try:
        import numpy as np
    except ImportError:
        raise SystemExit("missing python module: numpy")

    os.makedirs(BUILD, exist_ok=True)
    js_wav = os.path.join(BUILD, "js_render.wav")
    node_cmd = ["node", os.path.join(ROOT, "tools", "modtest.mjs"), str(seconds), js_wav]
    subprocess.run(node_cmd, check=True, cwd=ROOT,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ref_full = reference()
    js = read_mono(js_wav)
    ref = ref_full[:len(js)]

    a = envelope(ref, 0.5)
    b = envelope(js, 0.5)
    k = min(len(a), len(b))
    corr = float(np.corrcoef(a[:k], b[:k])[0, 1])

    print("mode         %s (%d s)" % ("full" if full else "window", seconds))
    print("rms  ref     %.4f" % a[:k].mean())
    print("rms  js      %.4f" % b[:k].mean())
    print("envelope corr %.3f" % corr)

    if full:
        points, slope = clock_drift(ref, js)
        print("clock drift  %+.2f s at %5.0f s, %+.3f s per minute"
              % (points[-1][1], points[-1][0], slope * 60))
        ok = corr > 0.85 and abs(points[-1][1]) < 1.0
    else:
        ok = corr > 0.95
    print("result       %s" % ("ok" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
