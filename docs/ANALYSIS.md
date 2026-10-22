# DOPE (Complex, The Gathering 95) — disassembly notes

> **Corrections from running the demo** (details and evidence in
> `docs/RUNTIME.md`): the demo parts are **16-bit** code, not 32-bit protected
> mode; the video mode is set with `int 10h` mode 13h but then **reprogrammed**
> (planar sequencer mode, 336 plane byte CRTC line, per-plane map masks during
> the picture unpack), so it is not a plain linear framebuffer (the split screen
> is programmed but disabled -- see RUNTIME.md); and blocks
> 2..7 are not all resident — they are overlays loaded on demand (only the
> loader at `0x8270` and the running part at `0xf7b0` are in memory during part
> 1).  The parts also read data from the loader's area (`ds = 0x00e4`, linear
> `0x154a` for part 1), so they are not self contained.

These are the notes the JS port was built from.  Everything marked *verified* was
reproduced with the tools in `tools/`; anything marked *inferred* is a reading of
the code that has not been executed under an emulator.

## 1. The executable

`DOPE.EXE` is 584,133 bytes and starts with a plain DOS `MZ` header:

```
MZ  cblp=0x004a  cp=0x0017  crlc=0  parhdr=2  minalloc=0x0ced
    ss:sp=0x0640:0x04ea   cs:ip=0x0294:0x000c   lfarlc=0x028c
```

The header is followed by **eight Rob Northen RNC v1 method-1 blocks**, not by
an ordinary DOS image.  Their offsets are found by scanning for the `RNC\x01`
signature and validated against the size and CRC fields in each 18 byte header:

| # | file offset | packed | unpacked | contents |
|---|-------------|--------|----------|----------|
| 0 | `0x000020` | 10,533 | 25,570 | CDPI DPMI extender + **ProTracker for GUS** replay routine |
| 1 | `0x002c6a` | 50,996 | 213,658 | demo part |
| 2 | `0x00f66c` | 57,982 | 449,862 | demo part |
| 3 | `0x01dc1a` | 52,784 | 374,042 | demo part |
| 4 | `0x02ad70` | 179,896 | 485,072 | demo part |
| 5 | `0x056f42` | 72,433 | 386,842 | demo part |
| 6 | `0x068d64` | 76,667 | 446,560 | demo part |
| 7 | `0x07bc02` | 76,412 | 457,550 | demo part |

*Verified*: `python3 tools/unpack.py` decompresses all eight blocks and the
unpacked CRCs stored in the headers match.  The Python decompressor in
`tools/rnc.py` produces byte-identical output to the reference `rnc64` tool on
all eight streams.

### Block 0 — loader and music driver

Block 0 is the interesting one for a port: it is not just the DPMI stub.  It
carries the CDPI v0.2 extender messages (`386 or better not detected!!!`,
`Couldn't enter 32bit protected mode!!!`), the DOS file loader, and the whole
GUS replay routine:

```
Initializing music replay...
Dumping samples to GUS...
dope.mod
ProTracker for GUS replay routine
Copyright (C) 1994 Oskari Tammelin
...
ULTRASNDNo ULTRASND variable found.
Please select your Gravis UltraSound port address:
    0> NoSound   1> 210h   2> 220h ...
UltraSound IRQ number:
```

That matches the credit in `DOPE.TXT`: *"music replay routine phantom/sonic pc
(gus unit raped by jmagic)"* — the base is Oskari Tammelin's ProTracker-for-GUS
driver, patched by jmagic to upload the module's samples into GUS DRAM before
the demo starts (`Dumping samples to GUS...`).

The driver reads `dope.mod` from disk at run time, which is why the module that
ships next to the executable is the exact one the demo plays.

### Blocks 1..7 — the demo parts

Each block starts with 0x100..0x110 bytes of zeroes and then 32 bit protected
mode code plus data.  All seven contain the same anti-rip banner at a slightly
different offset, so they are separate overlays that each link in a copy of the
engine:

```
HELLO LAMER !!!  HAVING NICE TIME WITH MY CODE ???
...
PS. DON'T TELL ME IT'S NOT OPTIMIZED OR 'REAL' BECAUSE I KNOW
THAT ALREADY! WHY OPTIMIZE ANYTHING FOR PENTIUM 100 MHZ?
```

The first routine in block 1 (offset `0x110`) is the vertical retrace wait the
whole demo is built on:

```
00000110  BA DA 03        mov dx,0x3da
00000113  EC             in  al,dx
00000114  A8 08          test al,0x08
00000116  75 FB          jnz 0x113        ; wait for vertical retrace
00000118  C3             ret
```

and `0x120` is the 100 Hz timer handler: `push ds/es/fs/gs`, `pushaw`,
`mov al,0x20; out 0x20,al` (EOI), then `inc dword [cs:0x1e]` — the frame
counter every effect reads — followed by the PIT reprogramming
(`out 0x43,0x30` / `out 0x40`) used to derive a stable 70 Hz mode.

Port usage per block (*verified* by byte scan, counts are occurrences of the
`mov dx,imm16` / `out imm8,al` encodings):

| block | VGA 0x3DA | palette 0x3C8 | seq 0x3C4 | int 10h | int 21h | PIT 0x43 |
|-------|-----------|----------------|-----------|---------|---------|----------|
| 1 | 7 | 1 | 9 | 1 | 2 | 4 |
| 2 | 5 | 3 | 4 | 1 | 1 | 6 |
| 3 | 4 | 2 | 4 | 1 | 1 | 5 |
| 4 | 2 | 2 | 0 | 3 | 3 | 4 |
| 5 | 4 | 3 | 0 | 2 | 1 | 4 |
| 6 | 4 | 4 | 4 | 0 | 1 | 4 |
| 7 | 5 | 3 | 4 | 3 | 1 | 7 |

The 0x3C4 hits are Mode X style planar setup, the 0x3C8 hits are palette
loads.  Several blocks also contain long ascending byte ramps (`PQRST...`,
`abcdef...`) — the pre-shaded gradients used for the gouraud table and the
environment map lookup, which is why the port keeps its shading in palette
index space instead of computing RGB.

## 2. The module

`DOPE.MOD` is 957,334 bytes, 28 channels, signature `28CH` (the GUS driver
patches `M.K.` modules to its own tag).  libopenmpt agrees with the parse:

```
Type.......: mod (ProTracker MOD (28CH))   Duration: 08:34.688
Channels...: 28   Orders: 124   Patterns: 70   Samples: 23
```

Header layout is stock ProTracker (20 byte title, 31 x 30 byte instruments,
song length, restart, 128 byte order table, signature at 1080), the pattern
block is `64 * 28 * 4` bytes per pattern and the sample data begins at
`1084 + 70 * 7168 = 502,844` and ends exactly at EOF (454,490 bytes of samples).

Effect usage across all 70 patterns:

| effect | meaning | count |
|--------|---------|-------|
| 0 | arpeggio | 102,395 cells (mostly empty) |
| 3 | tone portamento | 1,363 |
| 4 | vibrato | 319 |
| 8 | set panning | 54 |
| 9 | sample offset | 190 |
| A | volume slide | 14,676 |
| C | set volume | 5,821 |
| D | pattern break | 2 |
| E1x / EBx | fine porta up / fine volume down | 12 / 550 |
| F | speed / tempo | 23 |

The periods are plain Amiga periods in the extended range (C-0 = 3424 down to
far above B-3), so pitch is `freq = 7093789.2 / (2 * period)`, the same
constant the GUS driver feeds to the GF1 voice rate registers.

## 3. What the port reproduces

*Verified*:

* `tools/rnc.py` + `tools/unpack.py` — the RNC v1 decompressor and the block
  extractor, cross-checked against `rnc64` and the stored CRCs.  Covered by
  `tests/test_tools.py` (header fields, the eight offsets/sizes, the CRCs, the
  retrace wait at block 1 +0x110, the banner in five overlays, MOD layout).
* `web/js/rnc.js` — the same decompressor in JavaScript, so the page can read
  the demo's blocks itself; it produces byte-identical output for all eight
  streams and verifies the CRCs stored in the executable (`tests/test_rnc.mjs`).
* `web/js/part1.js` — part 1 transcoded: the picture strip at block `0x154a`,
  the scroll arithmetic of `0xc8b`/`0xca3`, the palette ramps of `0xc00`/`0xc24`
  and the two index tables at `0x5f0`/`0x8f8`, written straight to a 320x200
  index image.  `tools/part1check.mjs` renders it from `DOPE.EXE` alone: 11 of
  the 15 reference frames are byte identical, the other four by 8 pixels
  (`tests/test_part1.mjs`, `docs/RUNTIME.md`).
* `web/js/mod.js` — the 28 channel replayer.  Rendered offline it matches a
  libopenmpt render of the same module: RMS **0.1059 vs 0.1058** and a 0.5 s
  loudness envelope correlation of **0.994** over the first 20 seconds
  (`tools/parity.py 20`).  Over the whole 8:34 tune the correlation is
  **0.879** and the two clocks drift apart by **-0.30 s at 440 s**
  (-0.043 s/min, i.e. 0.07 %).  The sign and size point at the reference
  rounding its tick length to whole samples (903.69 samples at tempo 122), but
  that is an explanation, not something measured inside libopenmpt.
* Player semantics: effects run on ticks 1..speed-1 only, so a speed 3 pattern
  is not slid 33 % too fast — this alone moved the full song correlation from
  0.848 to 0.879.  `tests/test_mod.mjs` pins the header, sample loop windows
  and the fact that seeking (mix and discard) is identical to continuous
  playback.

*Reconstructed* (inferred from `DOPE.TXT` and the code, not bit exact):

* `web/js/scenes.js` — the running order: intro, routine boxes sketch,
  environment map, shadow volume, world domination, end scroll.  The geometry
  is rebuilt from scratch (cube lattice, tessellated torus and sphere) rather
  than extracted from the 7800 poly object data; the look follows the demo's
  palette ramps and 320x200 mode 13h framing.
* The scene cuts are driven by the module's order list, so they land on
  musical boundaries like the original's hard cuts did.

Part 1 was the part that could not be recovered by reading the code alone: its
picture is a pre-shaded gradient strip the renderer copies with hand written
inner loops, and the four map-mask passes, the 336 plane byte picture strip and
the panning register only became clear from the frames.  `tools/vmsnap.py` +
`tools/vm/` (the x86 and VGA classes) were built to run the original code
against a snapshot and measure it; once the measurements were complete the part
was **transcoded** into `web/js/part1.js`, which reproduces those frames from
the demo's own data with no emulator (see `docs/RUNTIME.md`).  The emulator
remains as verification rigging under `tools/vm/`.

Parts 2..7 are not captured yet: the `web/` page opens with the original part 1
and hands over to procedurally drawn scenes when that part ends (see
`docs/RUNTIME.md`).
