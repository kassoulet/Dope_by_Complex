# DOPE — COMPLEX (The Gathering 95) — in the browser

A browser version of the 1995 DOS demo *DOPE* by Complex (jmagic, jugi, reward),
made by taking `DOPE.EXE` apart.  Everything runs from the demo's own files:
`DOPE.EXE` (RNC packed) and `DOPE.MOD`.

* **part 1** (the first ~39 s) is *transcoded*: its picture and palette tables
  are read out of the unpacked block and the frames are written directly,
  pixel-exact against DOSBox-X on 11 of 15 captured frames;
* **parts 2 to 7** are JavaScript **ports** (`web/js/ports/`): the effects rewritten
  from the machine code, each checked against the original code byte for byte, frame
  by frame, in a lock step (`docs/PORTING.md`).  Parts 2, 3, 5, 6 and 7 share one 3D
  engine in five slightly different copies (`docs/ENGINE.md`); each part has its own
  study, `docs/PORT2.md` ... `docs/PORT7.md`;
* the **music** is `DOPE.MOD` (28 channels) played by **libopenmpt**
  (WebAssembly, `web/vendor/`) with its 8 tap sinc interpolation, at the sound
  card's rate; the song clock is the number of audio frames rendered and drives
  every picture, so pause and seek move both.

The page has pause and seek, shows the picture at 4:3 (mode 13h pixels are 1.2x
taller than wide), and explains the process; `web/writeup.html` is the write-up
of the original's best assembly tricks.

## Run

```
python3 -m http.server 8000
# then open http://localhost:8000/web/
```

Click the canvas to start.  Space pauses, left/right seek 5 s, `j`/`l` 10 s, Home restarts.

| url | what |
|-----|------|
| `/web/` | the whole demo, 7:53, then it loops |
| `/web/?vm=1` | part 1 on its own |
| `/web/?autostart=1` | start without a click (used by the headless checks) |
| `/web/?t=200` | pin the picture at 200 s (one frame, no audio) |
| `/web/part1test.html` | part 1 in the browser: prints the frame digest and canvas mismatches |

`.github/workflows/pages.yml` publishes the site (`web/`, `DOPE.EXE`, `DOPE.MOD`) to GitHub Pages.

## How the page runs a part

* The loader's work is reproduced by `web/js/ports/image.js`: the block is placed at segment
  `0xf8b` in a 1 MB memory image and its 23-28 relocated words get `+ segment - 0x10`.  The
  relocation lists and the length of each part are data in `web/data/parts.json`, **measured**
  by diffing a DOSBox-X snapshot of each part at its start against its block
  (`tools/blocksnap.py`, `tools/relocdiff.py`).  A port reads the demo's own tables, pictures
  and scripts out of that image.
* A part's clock is its own INT 8 at 70 Hz; the page drives each port from the audio clock
  (`TICK_HZ = 70.086`).  Playing and seeking are the same thing: `advanceTo(tick)` moves the port's
  clock, `render()` draws.  The ports run in a Web Worker (`web/js/emuworker.js`).
* A part that continues on the previous screen (4, 5, 6) starts from the previous port's end state,
  which the worker computes by running that port to its end (`endScreen`).
* The parts' measured lengths include a frame's time per script step; each port is given the
  length and spreads the difference over its steps (`slackFor`), so every part ends on its tick.

## The oracle

The ports are checked against the original's own code, run in an x86 interpreter with a model of
the VGA card (`tools/vm/`: `x86.js`, `vga.js`, `machine.js`, a dynamic recompiler `jit.js`, and
`partvm.js`, which builds a part the way the loader did).  It is not part of the page.

* The interpreter was checked against Unicorn (QEMU's CPU) instruction by instruction:
  `tools/difftrace2.mjs` dumps a run, `tools/diffcheck2.py` replays it.  It found `shld`/`shrd imm8`
  run as byte ops, rotate flags, `imul` overflow flags and string-instruction pointers stepping as
  32 bit registers.
* The recompiler (31 to 230 M instructions/s) is checked against the interpreter in lock step
  (`tests/test_jit.mjs`).
* `tools/oracle.mjs` runs one routine of the original on a copy of the machine (`callRoutine`);
  the lock step tests run a whole part beside its port.
* It is **not** pixel-compared against DOSBox: the original is not deterministic in the counter
  (the credit band up at counter 127 differed between two DOSBox runs).

## Layout

```
web/index.html, writeup.html, style.css   the site: player, process, asm write-up
web/*.html            the docs as pages (engine, porting, port2 ... port7), made by tools/md2html.mjs
web/js/main.js        the page: audio callback, transport, part 1 / ports switch
web/js/openmpt.js     DOPE.MOD in libopenmpt (render, seek)
web/vendor/           libopenmpt compiled to WebAssembly (chiptune3's build) and its licences
web/js/rnc.js         RNC ProPack decompressor -- reads the blocks out of DOPE.EXE
web/js/part1.js       part 1 transcoded: picture + scroll + palette, written as pixels
web/js/emuparts.js    the timeline of parts 2..7 and the canvas painting
web/js/emuworker.js   the worker that runs a port at the page clock's pace
web/js/ports/         the ports: image.js (loader), index.js, engine3d.js, raster3.js, part2..7.js
web/data/             parts.json (relocation, lengths)
tools/vm/             the oracle: x86 interpreter, recompiler, VGA/DAC model, machine, partvm.js
tools/                extraction, DOSBox-X capture and snapshot, differential tests, renderers
tests/                regression tests (tests/data: the screens the lock step tests start parts 4..6 from)
docs/ANALYSIS.md      disassembly notes: EXE layout, driver, module, effects
docs/RUNTIME.md       how the parts were first made to run: video mode, code layout, load addresses
docs/PORTING.md       the porting method: oracle, lock step, polygon by polygon, lessons
docs/EFFECTS.md       what each part shows, how, and the seven 3D models (tools/models.mjs, tools/shots.mjs)
docs/ENGINE.md        the 3D engine parts 2, 3, 5, 6, 7 share, and how its five copies differ
docs/PORT2..7.md      what each part turned out to be
```

## Verify

```
python3 tests/test_tools.py      # EXE header, 8 RNC blocks + CRCs, MOD layout
node tests/test_rnc.mjs          # the JS decompressor against the same CRCs
node tests/test_part1.mjs        # part 1: picture, scroll units, palette, frames
node tests/test_openmpt.mjs      # DOPE.MOD in libopenmpt: channels, seek, rates
node tests/test_port4.mjs [--quick]   # part 4's port, every routine against the original (8 moments)
node tests/test_port4_run.mjs    # part 4's port in lock step with the original, whole part (4 min)
node tests/test_engine3.mjs [--quick]  # the 3D engine's routines against block 3
node tests/test_port3_run.mjs [--block 2|3|5|6|7] [--poly]   # a 3D part's port in lock step, whole part (--poly: polygon by polygon)
node tests/test_browser.mjs      # the real page in headless Chrome: audio, pause, seek, loop
node tests/test_page_ports.mjs   # the real page shows the ports' pictures (parts 3, 5, 7 byte for byte)

# the oracle itself
node tests/test_partvm.mjs       # parts 2..7 from DOPE.EXE in the interpreter: ISR, picture, pinned digests
node tests/test_x86.mjs          # interpreter regressions found by the Unicorn replay
node tests/test_jit.mjs [runs]   # recompiler == interpreter, lock step, all six parts
node tests/test_vga.mjs          # the VGA model
node tools/difftrace2.mjs 6 --n 600000 --out build/diff6
.venv/bin/python tools/diffcheck2.py build/diff6   # .venv has unicorn + capstone

# ground truth from the original (needs DOSBox-X and Xvfb)
python3 tools/refcapture.py --start 18 --seconds 8 --interval 2 --out build/ref
python3 tools/blocksnap.py --seconds 470 --out build/snap      # every part at its start
```

## Part 1: transcoded

The first ~39 s are **part 1 as the original left it**.  It is not emulated or
reconstructed, it is **transcoded**:

* `web/js/rnc.js` decompresses the demo's own block 1 out of `DOPE.EXE` (the
eight blocks verify against the CRCs stored in the file), and `web/js/part1.js`
  takes part 1's picture strip and its two palette index tables from it;
* there is **no emulator in the page**.  The part's 0xc3 row picture is a window
  copy at a start that comes straight from the counter (`4 * (counter >> 4) +
  ((counter >> 2) & 3) - 1` pixels), and the DAC is rebuilt from two ramps the
  original fills from the same counter — 64 colours, `clamp(rampA[tblA[i]] +
  rampB[tblB[i]], 63)`;
* **the frames are the original's pixels**: 11 of the 15 captured reference
  frames are byte identical, and the other four differ by 8 pixels each (32 of
  960,000, all in the last picture row); `node tools/part1check.mjs` renders
  them from `DOPE.EXE` alone, with no snapshot.  In the page, a canvas grab at
  `?t=5` is byte identical to the node render of counter 690;
* the earlier "the picture content differs" and "not pixel exact" conclusions
  were a **units error in this port**: the card's picture memory is four planes
  read back with four pixels per plane byte, and the CRTC start/offset
  registers count plane bytes.  With those units right the reference frames are
  an exact window into the unpacked picture,
  `screen(x,y) = picture[1024*y + x + 4*start + pan - 321]`;
* the interpreter that was used to *find* all of this (`tools/vm/`, driven by
  `tools/vmrun.mjs`) runs the frozen snapshot and agrees with the transcode
  frame for frame, which is how the transcode was checked.

Measured facts the port is built on (details in `docs/RUNTIME.md`):

* the demo sets **mode 13h** through `int 10h` and then reprograms it: the
  CRTC gets `0x13 = 0xa8` (168 words = 336 plane bytes, i.e. 1344 pixel lines),
  the sequencer is put in planar mode (memory mode 6) and the map mask is
  rewritten per plane during the unpack, and the attribute controller has its
  split-screen bit cleared — so it is not a plain linear framebuffer;
* part 1 lives at loader + `0x7540` (`0xf7b0` with a bare DOS load); block
  offset `0xcd5` is segment offset `0xbd5` once the loader has mapped the
  block (measured entry `0xf8b:0xbd5`, linear `0x10485`);
* a part is **not self contained** — it unpacks from `ds = 0x00e4`,
  `si = 0x70a` (linear `0x154a`), so the port has to reproduce the loader's
  memory placement too;
* the part's own `int 8` handler increments `cs:0x1e`, advances the shared
  counter `cs:0x16a` by 2, reloads the PIT from a divisor it calibrates against
  the retrace, reprograms the CRTC start and rewrites 0xc0 DAC entries —
  measured at 69 interrupts per second (reference frames 2 s apart differ by
  276 counts), so part 1 lasts 5376 counts, about 39 s;
* the scroll routine `0xc8b` writes `counter >> 4` to the CRTC start and
  `0xca3` writes `((counter >> 2) & 3) * 2` to the panning register; `0xc24`
  rebuilds the 0xc0 DAC entries from two 64 entry ramps that `0xc00` fills from
  `counter - 0x1f4`, so the picture is one full width of scroll (1024 pixels
  plus the 320 pixel gap) and a crossfade between two palettes.

Ground truth is now available and reproducible: `tools/refcapture.py` boots
the real `DOPE.EXE` in DOSBox-X with Gravis Ultrasound emulation and writes
native 320x200 palette PNGs, and `tools/probe.py` locates the unpacked blocks
in the emulated RAM while the demo runs.  Any replacement has to match those
frames, and that is now measurable.

Original: (c) 1995 Complex — jmagic / jugi / reward.  Music replay routine
based on Oskari Tammelin's ProTracker for GUS, as credited in `DOPE.TXT`.
