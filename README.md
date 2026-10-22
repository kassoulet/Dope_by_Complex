# DOPE — COMPLEX (The Gathering 95) — JavaScript port

A browser port of the 1995 DOS demo *DOPE* by Complex (jmagic, jugi, reward):
the original executable was unpacked and disassembled, and the parts that could
be recovered are reimplemented in JavaScript.  Part 1 is transcoded from the
demo's own data rather than rewritten, and matches the original's frames.

Everything runs from the demo's own assets: `DOPE.EXE` (RNC packed) and
`DOPE.MOD` (the 28 channel module the original loads from disk).

## Run

```
python3 -m http.server 8000
# then open http://localhost:8000/web/
```

Click the canvas to start.  Space pauses, left/right seek 5 s, `j`/`l` 10 s, Home restarts.
The canvas is shown 4:3 (mode 13h pixels are 1.2x taller than wide).
`/web/writeup.html` is the asm write-up of the original's best tricks.

| url | what |
|-----|------|
| `/web/` | the demo: **part 1** as the original, then the reconstructed parts 2..7 |
| `/web/?vm=1` | part 1 on its own, pixel exact, read out of `DOPE.EXE` |
| `/web/?autostart=1` | start without a click (used by the headless checks) |
| `/web/?t=45` | pin the picture at 45 s (one frame, no audio; how the handover is checked) |
| `/web/selftest.html` | renders every scene, reports coverage, prints the frames |
| `/web/part1test.html` | part 1 in the browser: prints the frame digest and canvas mismatches |

## Layout

```
tools/rnc.py      RNC ProPack method 1 decompressor (pure python)
tools/unpack.py   extracts the eight RNC blocks of DOPE.EXE into build/
tools/refcapture.py  runs the original in DOSBox-X and captures 320x200 frames
tools/probe.py    reads the emulated RAM to find the load layout
tools/framediff.py exact pixel comparison of a frame against a reference
tools/vmsnap.py   freezes DOSBox-X and dumps guest RAM + part segment + screen
tools/part1check.mjs  renders part 1 from DOPE.EXE alone, for framediff
tools/vmrun.mjs   runs that image in tools/vm/ and renders frames as PNG
tools/part2run.mjs   boots part 2 from block 2 alone (loader relocation + gs)
tools/part2frames.mjs  part 2 one frame per timer tick, to .idx/.pal/.png
tools/part2diff.py  exact-pixel comparison of those frames with build/ref_p2
tools/png.mjs     tiny PNG encoder used by the frame tools
tools/modtest.mjs renders DOPE.MOD with web/js/transport.js  song clock: tick scheduling, seek (no mixing), duration
web/js/mod.js to a wav
tools/parity.py   compares that render against libopenmpt (openmpt123)
tools/vm/x86.js   16/32-bit real mode x86 interpreter (verification rig)
tools/vm/vga.js   mode 13h framebuffer, CRTC scroll/offset, panning, DAC (rig)
tools/vm/machine.js memory map, 8253 timer, int 8, int 10h/21h, snapshot boot
web/js/rnc.js     RNC ProPack decompressor -- reads the blocks out of DOPE.EXE
web/js/part1.js   part 1 transcoded: picture + scroll + palette, written as pixels
web/js/part1player.js clocks that at the original's 69 Hz and paints the canvas
web/js/part2.js   what is exact about part 2 so far: its 256 entry palette, the
                  credits bands and the shade-table screen compositor
web/js/engine.js  320x200 8 bit framebuffer, palette, polygon rasteriser
web/js/mod.js     28 channel ProTracker/GUS replayer
web/js/look.js       look-alikes of parts 2..end, timeline measured from the original
web/js/scenes.js (old placeholders, only selftest uses it)  the demo parts and the palette
web/js/main.js    audio callback + scene loop
tests/            regression tests for the extraction pipeline and the player
docs/ANALYSIS.md  disassembly notes: EXE layout, driver, module, effects
docs/RUNTIME.md   measured runtime: video mode, code layout, load addresses
```

## Verify

```
python3 tests/test_tools.py      # EXE header, 8 RNC blocks + CRCs, MOD layout
node tests/test_rnc.mjs          # the JS decompressor against the same CRCs
node tests/test_part1.mjs        # part 1: picture, scroll units, palette, frames
node tests/test_part2.mjs        # part 2: palette, shade table and bands, checked against
                                 # build/ref_p2 and the frozen part's memory
node tests/test_part2_frames.mjs # part 2 in the rig: one frame per timer tick, band, digests
node tests/test_x86.mjs          # the rig's 32 bit signed divide (part 2's projection)
node tests/test_browser.mjs      # the real page in headless Chrome: audio, pause, seek, loop
node tests/test_transport.mjs    # seek == continuous playback, song duration
node tests/test_mod.mjs          # player: header, sample tables, seek == playback
node tests/test_vga.mjs          # the verification rig's VGA (40 checks)

# the browser path: fetch, decompress, transcode, canvas readback (needs chrome)
google-chrome --headless=new --dump-dom http://localhost:8000/web/part1test.html
python3 tools/parity.py 20       # 20 s against libopenmpt, needs openmpt123
python3 tools/parity.py full     # whole 8:34, reports the clock drift

# part 1 against the original's own pixels (needs DOSBox-X and Xvfb)
python3 tools/refcapture.py --start 18 --seconds 8 --interval 2 --out build/ref
node tools/part1check.mjs build/ref --out build/out
python3 tools/framediff.py build/ref/ref_0001.png build/out/part1_0498.png --bbox

# the emulated-rig path, which produced the measurements in docs/RUNTIME.md
python3 tools/probe.py --wait 16   # load layout in emulated memory
python3 tools/vmsnap.py --wait 12 --out build/snap/part1   # memory + screen
node tools/vmrun.mjs build/snap/part1 --frame 498 --png build/out/vm498.png

# part 2 from its own block, one frame per timer tick (needs build/block02...)
node tools/part2frames.mjs --frames 438 --out build/out/p2frames --png-every 20
node tools/part2run.mjs --blits 6        # free-running timer, for comparison
python3 tools/part2diff.py build/out/p2frames build/ref_p2/ref_0000.png
                                 # best exact-pixel count, no rounding up
```

`tools/parity.py` renders the module through the JS replayer and through
libopenmpt (via openmpt123, cached as `build/reference.raw`) and compares the
loudness envelopes.  Last run:

```
window (20 s)   rms ref 0.1059  js 0.1058   envelope corr 0.994
full  (515 s)   rms ref 0.1181  js 0.1198   envelope corr 0.879
                clock drift -0.30 s at 440 s (-0.043 s per minute)
```

The second number is the honest one: over the full tune the two clocks drift
apart by about a third of a second, so a mid song window would compare
slightly misaligned material and is not offered as a check.

## Status: part 1 is ported, later parts are not

The page plays the demo in order.  The first ~39 s are **part 1 as the
original left it** — `/web/` opens on it, and when the part's counter runs out
(`0x1500`) the page hands over to the reconstruction of parts 2..7.  The music
is the real module throughout.  Part 1 is not reconstructed, it is
**transcoded**:

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
* the emulator that was used to *find* all of this is kept as verification
  rigging in `tools/vm/` (`x86.js`, `vga.js`, `machine.js`, driven by
  `tools/vmrun.mjs`).  It runs the frozen snapshot and agrees with the
  transcode frame for frame, which is how the transcode was checked before the
  reference comparisons.

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

## What is faithful and what is not

Faithful: the module parsing and playback (tempo, ticks, periods, sample
loops, volumes, effect set, tick 0 only triggering notes and row effects like
ProTracker), the 320x200 indexed framebuffer with 6 bit VGA palette, the
running order and credits, and **part 1**, which is the original's picture,
scroll and palette crossfade at the original's timing.

Reconstructed: the geometry and the effects of parts 2..7.  `docs/ANALYSIS.md`
records what the original code does; `docs/RUNTIME.md` records what was
measured on the running demo.  Part 2's 3D layer is still not ported to the
page: it is a software 3D engine (transform, projection, texture mapped spans).
It does run in the rig -- `tools/part2run.mjs` redoes the loader (28 relocated
words and a data segment in `gs`) and boots the part from `DOPE.EXE` alone,
after which it builds 271 polygons and blits real frames -- and
`tools/part2frames.mjs` now drives it one frame per timer tick, 438 frames in
about 15 s (the old 3.5e8 instructions per frame was a rig bug in 32 bit signed
`idiv`, pinned by `tests/test_x86.mjs`).  The frames are not yet the captured
ones: the best of those 438 matches `build/ref_p2/ref_0000` in 35,180 of
64,000 pixels, with the credit rows almost exact and the discs still differing.
What *is* exact about the part is the screen machinery around that engine
(`web/js/part2.js`, checked by `tests/test_part2.mjs` against `build/ref_p2`
and the frozen part's memory):

* all 256 DAC entries, loaded from the block and rewritten every timer tick
  through a 64 entry fade ramp -- which explains the 70..107 colours per frame
  without any per line palette (an earlier note here claimed the opposite and
  was a miscount of part 1's 192 entry palette);
* the shade table the compositor reads, rebuilt from block 2 to the running
  part's 24,576 bytes, and the four credit bands at block `0x1201a`, byte
  identical to memory;
* the compose loop itself, run by the original's own instructions against a
  known input and matching `compose()` on all 64,000 pixels, plus the one-row
  blit that scrolls the picture up: the frozen screen buffer read back through
  the base palette matches the frozen screenshot for 90 of 199 rows and 90% of
  its pixels, the remainder being one 6 bit DAC step -- the fade ramp's phase
  at the instant of the freeze.

Original: (c) 1995 Complex — jmagic / jugi / reward.  Music replay routine
based on Oskari Tammelin's ProTracker for GUS, as credited in `DOPE.TXT`.

## Update: timeline and look-alikes

`build/ref_full` (not committed) is a capture of the whole original, one frame per 3 s.
It shows 8 parts and the demo exiting to DOS at ~433 s.  `web/js/look.js` imitates
parts 2..end on that timeline.  They are look-alikes; only part 1 is a port.
