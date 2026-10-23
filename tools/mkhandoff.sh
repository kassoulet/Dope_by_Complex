#!/bin/bash
# Regenerate web/data/handoff{3,4,5}.z: the screen each part leaves for the next.
# Runs parts 2..5 to their exit in the rig, chaining the screen (about 6 minutes).
set -e
cd "$(dirname "$0")/.."
mkdir -p build/chain
prev=""
for n in 2 3 4 5; do
  init=""; [ -n "$prev" ] && init="--init build/chain/screen$prev.bin"
  node tools/partrun.mjs $n --frames 99999 --quiet --max-inst 2e10 --ipt 100000 $init --exit-dump build/chain/screen$n.bin
  prev=$n
done
python3 - <<'PY'
import zlib
for n in (3, 4, 5):
    d = open('build/chain/screen%d.bin' % n, 'rb').read()
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    open('web/data/handoff%d.z' % n, 'wb').write(c.compress(d) + c.flush())
PY
