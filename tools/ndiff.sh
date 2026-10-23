#!/bin/sh
# tools/ndiff.sh <blockA> <fromA> <toA> <blockB> <fromB> <toB>: diff two block ranges with the numbers blanked out
cd "$(dirname "$0")/.."
.venv/bin/python tools/disblock.py $1 $2 $3 | cut -d' ' -f2- | sed 's/0x[0-9a-f]*/N/g' > /tmp/nd_a.txt
.venv/bin/python tools/disblock.py $4 $5 $6 | cut -d' ' -f2- | sed 's/0x[0-9a-f]*/N/g' > /tmp/nd_b.txt
diff /tmp/nd_a.txt /tmp/nd_b.txt
