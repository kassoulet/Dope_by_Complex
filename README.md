# DOPE — COMPLEX (The Gathering 95) — in the browser

A browser version of the 1995 DOS demo *DOPE* by Complex (jmagic, jugi, reward),
made by taking `DOPE.EXE` apart:

* **part 1** (the first ~39 s) is *transcoded*: its picture and palette tables
  are read out of the unpacked block and the frames are written directly,
  pixel-exact against DOSBox-X;
* **parts 2..7** are the demo's own **machine code**, run by a 16/32-bit
  real-mode x86 interpreter written in JavaScript (`web/js/vm/`) with a model of
  the VGA card behind it, in a Web Worker.  The effects are not reimplemented;
* the **music** is the original 28 channel module in a JS replayer.

Everything runs from the demo's own files: `DOPE.EXE` (RNC packed) and
`DOPE.MOD`.  The page has pause and seek, shows the picture at 4:3 (mode 13h
pixels are 1.2x taller than wide), and explains the process; `web/writeup.html`
is the write-up of the original's best assembly tricks.

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

## How parts 2..7 run

* `web/js/partvm.js` builds a part the way the loader did: the block at segment
  `0xf8b`, 23-28 relocated words (`+ segment - 0x10`), an optional far `init`
  call, then `main`.  The relocation lists and entry points are data in
  `web/data/parts.json`, **measured** by diffing a DOSBox-X snapshot of each
  part at its start against its block (`tools/blocksnap.py`,
  `tools/relocdiff.py`); `tools/partrun.mjs` runs any part from the command line.
* The part's clock is its own INT 8 at 70 Hz.  `emuworker.js` raises it from
  the page's audio clock (`TICK_HZ = 70.086`), so the animation keeps its speed;
  each part lasts a fixed number of ticks (`parts.json`: 8200, 3665, 7443, 4557,
  4063, 2494; measured by running to the part's `int 21h/4Ch`).
* Pause stops the interrupts and the interpreter.  Seek restarts the part on the
  screen the previous part left (`web/data/handoff{3,4,5}.z`, made by
  `tools/mkhandoff.sh`) and calls the interrupt fast until the counters catch up.
* A dynamic recompiler (`web/js/vm/jit.js`) turns each x86 basic block into a
  JavaScript function the first time it runs: registers are locals, ModRM is
  decoded once, flags are computed only if something can read them, a block that
  loops to its own start loops inside the function, and the immediates the
  parts patch in their own code are read from memory (`tests/test_jit.mjs`
  runs every part both ways in lock step and compares registers, flags, memory
  and the card).  It runs 45-230 M instructions/s (the interpreter 16-20), which
  is a few frames per tick of the original's 70 Hz for every part.
* The interpreter was checked against Unicorn (QEMU's CPU) instruction by
  instruction: `tools/diffcheck.py` (one dumped state) and `tools/diffcheck2.py`
  (a whole run from boot with port reads and interrupts replayed).  It found
  `shld`/`shrd imm8` run as byte ops, rotate flags, `imul` overflow flags and
  string-instruction pointers stepping as 32 bit registers.
* It is **not** pixel-compared against DOSBox: the original is not
  deterministic in the counter (the credit band up at counter 127 differed
  between two DOSBox runs).  `tests/test_partvm.mjs` pins what the interpreter
  produces, and the pictures were compared by eye with `build/ref_full`.

## Layout

```
web/index.html, writeup.html, style.css   the site: player, process, asm write-up
web/js/main.js        audio callback, transport, part 1 / emulated parts switch
web/js/transport.js   song clock: tick scheduling, seek (no mixing), duration
web/js/mod.js         28 channel ProTracker/GUS replayer
web/js/rnc.js         RNC ProPack decompressor -- reads the blocks out of DOPE.EXE
web/js/part1.js       part 1 transcoded: picture + scroll + palette, written as pixels
web/js/part2.js       what is exact about part 2's screen machinery (palette, bands, compositor)
web/js/partvm.js      a part as the loader leaves it, driven by ticks
web/js/emuworker.js   the worker that runs a part at the page clock's pace
web/js/emuparts.js    the timeline of parts 2..7 and the canvas painting
web/js/vm/            x86 interpreter (x86.js), its recompiler (jit.js), VGA/DAC model, machine (INT 10h/21h, timer)
web/data/             parts.json (relocation, entries, lengths), handoff screens
tools/                extraction, DOSBox-X capture and snapshot, differential tests, renderers
tests/                regression tests
docs/ANALYSIS.md      disassembly notes: EXE layout, driver, module, effects
docs/RUNTIME.md       measured runtime: video mode, code layout, load addresses, part 2
```

## Verify

```
python3 tests/test_tools.py      # EXE header, 8 RNC blocks + CRCs, MOD layout
node tests/test_rnc.mjs          # the JS decompressor against the same CRCs
node tests/test_part1.mjs        # part 1: picture, scroll units, palette, frames
node tests/test_partvm.mjs       # parts 2..7 from DOPE.EXE: ISR, picture, pinned digests
node tests/test_x86.mjs          # interpreter regressions found by the Unicorn replay
node tests/test_jit.mjs [runs]   # recompiler == interpreter, lock step, all six parts
node tests/test_vga.mjs          # the VGA model
node tests/test_part2.mjs        # part 2's palette, shade table and bands against the frozen part
node tests/test_part2_frames.mjs # part 2 one frame per tick in the rig
node tests/test_transport.mjs    # seek == continuous playback, song duration
node tests/test_mod.mjs          # player: header, sample tables, seek == playback
node tests/test_browser.mjs      # the real page in headless Chrome: audio, pause, seek, loop

# differential test of the interpreter against Unicorn (.venv has unicorn + capstone)
node tools/difftrace2.mjs 6 --n 600000 --out build/diff6
.venv/bin/python tools/diffcheck2.py build/diff6

python3 tools/parity.py 20       # 20 s of music against libopenmpt, needs openmpt123
python3 tools/parity.py full     # whole 8:34, reports the clock drift

# ground truth from the original (needs DOSBox-X and Xvfb)
python3 tools/refcapture.py --start 18 --seconds 8 --interval 2 --out build/ref
python3 tools/blocksnap.py --seconds 470 --out build/snap      # every part at its start
```

`tools/parity.py` renders the module through the JS replayer and through
libopenmpt and compares the loudness envelopes.  Last run:

```
window (20 s)   rms ref 0.1059  js 0.1058   envelope corr 0.994
full  (515 s)   rms ref 0.1181  js 0.1198   envelope corr 0.879
                clock drift -0.30 s at 440 s (-0.043 s per minute)
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
* the interpreter that was used to *find* all of this (`web/js/vm/`, driven by
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
