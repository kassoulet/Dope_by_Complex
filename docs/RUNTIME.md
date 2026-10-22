# DOPE runtime — what the original actually does

This is the reference material for the pixel-exact port.  Everything here was
measured against the real `DOPE.EXE` running in DOSBox-X with Gravis Ultrasound
emulation, not inferred from the file alone.  `tools/refcapture.py` records the
screen (native 320x200, `P` mode PNGs) and `tools/probe.py` reads the emulated
RAM while the demo runs.

## Video

Only `INT10:Set Video Mode 13` appears in the DOSBox-X log: there is no VESA
mode and no text mode.  But the parts **reprogram the card heavily after that
call**, so "plain mode 13h" is wrong:

* part 1 clears the 64 KB at `A0000` (`rep stosd`, `cx = 0x4000`) and then
  unpacks its picture **once per plane**: the sequencer map mask (`3C4/3C5`
  index 2) is set to `0x11`, `0x22`, `0x44`, `0x88` in turn, and the loop ends
  when `rol al,1` lifts bit 7 into carry (so exactly four passes).  Each pass
  writes 195 rows of 256 bytes, 336 bytes apart (`0x40` dwords per row, then
  `add di,0x50`), into one plane -- four 64 KB planes hold the picture;
* the CRTC gets `0x13 = 0xa8` (168 words = a 336 **plane** byte logical line,
  which the scan-out turns into 1344 pixels; see the scan-out section below),
  `0x14 = 0` (word mode), `0x17 = 0xe3`, `0x18 = 0x183`, and tweaked `9`/`7`
  registers; the sequencer memory mode is set to 6 (chain 4 off for the CPU,
  so the four map-mask passes are planar stores) and the misc output is `0xe3`;
* the attribute controller is written through index `0x10` (the `0x20` bit in
  the index byte is the palette-address-source bit, not part of the index) and
  the value written **clears bit 5**.  Measured on the running part,
  `attr[0x10] = 0`, so the split screen / line compare feature is *disabled*:
  the part programmed CRTC `0x18` but never turns the split on, and the scroll
  is the start address alone.  (An earlier revision of this note claimed the
  split screen was in use; that was wrong.)

Palette writes go through `3C8`/`3C9`, 6-bit values, from the part's own
`cs:` tables: index `0xc0` entries built from `cs:0x16c`/`cs:0x1ac` (the two
256 byte ramps rebuilt every pass from the counter) plus the base tables at
`cs:0x4f0` and `cs:0x7f8`.

## Code

The overlays are **16-bit code**, not 32-bit.  `pushaw` at `+0x120` is the
`66 60` form, the retrace wait at `+0x110` is `mov dx,3da / in al,dx`, and the
whole part-1 main loop is 16-bit address/operand encodings.  The 32-bit
protected-mode code that does exist (the DPMI calls around `0xE000`) belongs to
the loader/extender image, not to the parts.

Layout of a part image (offsets into the unpacked block, all relative to the
part's load segment; the loader maps file offset `0x100` at the segment, so
block offset `0xcd5` is segment offset `0xbd5`):

| offset | contents |
|--------|----------|
| `0x000` | unused / BSS, 0x100 bytes |
| `0x110` | vertical retrace wait, `ret` |
| `0x120` | timer ISR: `cli`, EOI, `inc word [cs:0x1e]`, `call 0xc8b` (CRTC start from the counter), retrace wait, PIT reload, `call 0xca3`, `add word [cs:0x16a],2`, `call 0xc24` (palette), `iret` / chain to the saved vector |
| `0x176` | mode 13h + CRTC/sequencer setup, saves the old `int 8` vector to `cs:0x0`, installs `cs:0x20`, calibrates the PIT |
| `0x1d6` | PIT calibration: one shot, retrace wait, latch, `neg ax`, `imul eax,0x3de`, `shr eax,11` |
| `0x232` | restores the saved CRTC registers |
| `0x266` | palette tables (768 bytes each, 6-bit, consecutive) |
| `0xc00` | scale/limit a word to 0..0x100: fills 0x40 bytes from `ah`, stepping by `dx` |
| `0xc24` | palette: 0xc0 DAC entries, `cs:0x16c`/`cs:0x1ac` ramps indexed by `cs:0x4f0`/`cs:0x7f8`, `add`, clamp to 0x3f |
| `0xc5c` | unpacks a picture: builds a dword from `[si]`, `[si+4]`, `[si+8]`, `[si+0xc]`, stores it at `es:di`, adds one paragraph to `ds` and 4 to `di` per dword, `0x40` dwords per row, then `0x50` to `di`, `0xc3` rows |
| `0xcd5` | part entry: `int 10h` mode 13h, sequencer/CRTC setup, `rep stosd` of `A0000`, `ds = 0x00e4`, `si = 0x70a`, then four `call 0xc5c` passes with map mask `0x11/0x22/0x44/0x88` (`rol al,1` / `jnc`) |
| `0xdb5` | main loop: `counter - 0x1f4` into `cs:0x4ec`, rebuild the `cs:0x16c`/`cs:0x1ac` ramps via `0xc00`, `call 0x176`, repeat until `[cs:0x16a] > 0x1500` or ESC on port `0x60`, then restore the CRTC and `mov ax,4c00 / int 21h` |

The part therefore depends on data **outside** its own image: the unpack reads
from `ds = 0x00e4`, `si = 0x70a`, i.e. linear `0x154a`, in the loader's data
area below the part.  (An earlier revision of this note said `ds = 0xe40`,
which was a misreading of `push word 0xe4; pop ds` -- the segment is
`0x00e4`.)  A port cannot just load a block and jump into it; it has to
reproduce the loader's memory placement as well.

## Load layout (measured)

While part 1 runs, `tools/probe.py` finds in the emulated address space:

```
block 0 (loader)      RAM + 0x8270
block 1 (part 1)      RAM + 0xf7b0
```

Block 1 is pinned by an exact 16-byte code match: the mode 13h sequence at
block offset `0xcd5` is found at RAM offset `0x10485`, and `0x10485 - 0xcd5 =
0xf7b0`.  The loader's own offset moves by a paragraph with the size of the
DOS environment (`0x8270` in a bare boot, `0x8280` with an extra variable), so
the stable quantity is the relation: **part 1 = loader + `0x7540`**.  Only the
loader and the current part are resident; blocks 2..7 are not in memory while
part 1 runs, so they are overlays loaded on demand.  With a `0x8270` loader the
part's segment is `0xf7b` and its entry is `0xf7b:0xbd5` -- the loader maps the
block at file offset `0x100`, so block `0xcd5` is segment offset `0xbd5` (the
snapshot used below has the part at `0xf8b` and the same `:0xbd5` entry).

## Timing

The timer handler is installed by the part itself (`0x176` saves the old
`int 8` vector into `cs:0x0` and points the vector at `cs:0x20`), and the
handler is `cli`, EOI, `inc word [cs:0x1e]`, `call 0xc8b` (which programs the
CRTC start from the counter), retrace wait, PIT reload, `call 0xca3`,
`add word [cs:0x16a],2`, `call 0xc24` (the palette), `iret` -- with a chain to
the saved vector when the interrupt came from the BIOS tick.

The divisor in `cs:0x4` is calibrated, not assumed: `0x1d6` programs the PIT
for one shot, waits for a retrace, latches the counter (`out 0x43,0`), negates
it, then `imul eax,0x3de / shr eax,11` (i.e. ×990/2048) before storing it.
Measured, that gives **69 interrupts per second**, and since the counter is
advanced by 2 each time, reference screenshots taken 2 s apart differ by 276
counts (`222, 498, 774, ...`), which is what `tools/refcapture.py` records.
Part 1 ends when the counter passes `0x1500`, i.e. after 2688 interrupts
(≈39 s); the counter minus `0x1f4` is also the scroll source, so the picture
scrolls with the timer, not with a frame counter.

## Ground truth

```
python3 tools/refcapture.py --start 18 --seconds 8 --interval 2 --out build/ref --tag-counters
```

writes `build/ref/ref_0000.png` … 320x200, palette PNG, straight from the
emulated VGA, and (with `--tag-counters`) a `.json` sidecar per frame with the
part's counter at the instant of the grab (222, 498, 774, …).  Those frames,
not the old procedural scenes, are the target for the port.  Without the flag
the tool cannot find the part's counter and writes no sidecars: `--tag-counters`
keys on the part installing its `int 8` handler at `<segment>:0x20`, which is
where part 1's ISR lives.

## The verification rig: `tools/vmsnap.py` + `tools/vm/`

The parts are executed here, not reimplemented: `tools/vmsnap.py` freezes
DOSBox-X while part 1 runs and writes the low 1 MB of guest RAM plus the part
segment, and `tools/vm/x86.js` / `vga.js` / `machine.js` run that image from
the part entry (`0xbd5`) with a mode 13h VGA, the 8253 timer and the `int 8`
vector the part installs.  `node tools/vmrun.mjs build/snap/part1 --frame N
--png out.png` renders "the picture for counter N", the same key as the
reference frames.  This is a *measuring instrument*: the port itself does not
contain it (`web/js/part1.js` writes the frames directly), but it is what
established every constant the transcode uses, and it still agrees with the
reference frames and with the transcode frame for frame.

Rendering a frame after the fact needs the card state that defines it: the
CRTC (start and offset) **and** the attribute controller, because the pixel
panning register lives there.  `vmsnap`-style frame dumps that restore only the
CRTC come out wrong for every counter whose panning differs from the last one
run, which is easy to mistake for a picture problem.

What has been measured with it:

* the snapshot boots and runs: 76 timer interrupts for the first 600k
  instructions of the main loop, `cs:0x16a` advancing by 2 per interrupt,
  CRTC start, offset (`0x150` = 336 bytes) and the DAC values are all produced
  by the original code;
* **the palette is exact.**  At counter 774 the VM's DAC (as the original code
  computes it) contains **all 63 colours** of `ref_0002.png` — missing 0.  The
  6 bit to 8 bit expansion had to match DOSBox (`v << 2 | v >> 4`); expanding
  with `round(v * 255 / 63)` was off by one for most values and made every
  non-black pixel differ on its own.
* **the picture is exact.**  11 of the 15 reference frames are byte identical
  (`framediff` reports `identical`), the other four differ by 8 pixels each —
  32 pixels out of 960,000 — the same picture pixels every time (row 194,
  columns 263..270, source indices `2,2,3,4,5,4,3,3`), where the reference
  shows 0.  The transcode reproduces this exactly, residue included; the eight
  pixels are still unexplained, and nothing else differs.

## How the scan-out actually works (measured)

The mismatch that used to be reported here (`38960 / 64000` pixels at counter
774) was a **units error in this port, not missing picture content**.  The
reference frames are an exact window into the unpacked picture; the mapping was
found by searching for each reference row inside the snapshot's picture source
and reading off the stride, then confirmed on every reference frame:

```
screen(x, y) = picture[1024 * y + x + (4 * start + pan - 321)]
```

where `picture` is the 199,680 bytes the unpack reads (four 256 byte plane rows
per 1024 byte picture row) and `start`/`pan` are the CRTC start register and
the panning value `attr[0x13] >> 1`.  Equivalently, in the port's terms:

1. **Memory is four planes, and the scan-out assembles four pixels per plane
   byte**: pixel `4n+p` is byte `n` of plane `p`, i.e. the chain-4 arrangement.
   That is why the four map-mask passes of the unpack (`0x11`, `0x22`, `0x44`,
   `0x88`, sequencer 4 = 6 turns chain 4 *off* for the CPU side) lay down a
   byte-per-pixel picture: pass `p` fills plane `p`, and the display reads the
   four planes back interleaved.  The picture is 195 rows of 336 plane bytes,
   which is 200 KB of pixels -- more than the 64 KB window at `A0000`, so the
   port keeps the whole 256 KB.
2. **The CRTC start and offset registers count plane bytes**, not display
   bytes; the port multiplies both by four.  Part 1 programs offset
   `0x13 = 0xa8` (168 words = 336 plane bytes), which is exactly the row pitch
   of the strip the unpack writes (`0x40` dwords + `add di,0x50`), so each
   displayed line is 1344 pixels on.
3. **The panning register shifts by `value / 2 - 1` pixels.**  The part steps
   it in twos from the counter (`(counter >> 2) & 3`, doubled, so 0/2/4/6),
   which gives shifts of -1/0/1/2 while the CRTC start moves in fours: the two
   together produce the smooth one-pixel-per-four-counts scroll, and the
   `counter >> 2` in the mapping above.  `4 * start + pan - 321` also pins the
   picture's base: the unpack starts at plane offset `0x50` = pixel 320, and
   the display begins one pixel before it.
4. The scan-out **stops at the end of the 256 KB** instead of wrapping: part
   1's 195 row picture leaves the last rows of a 200 line scan addressing past
   the end, and the reference frames show black there.

The loader **patches the part's picture segment at run time**: in the file
`0xcd5+0xb6` is `push 0xe4`, in memory it is `push 0x105f`, so the unpack reads
linear `0x10cfa` (block `0x154a`), not `0xe40`.  The snapshot's source there is
pristine: the 0x30c00 bytes are byte-identical to the block file (0 of 199,680
differ).

The split screen is not a gap at all: the part clears attribute `0x10` bit 5,
which disables line compare (measured `attr[0x10] = 0` at counter 774), so
`render()` does not need it for this part.

`tests/test_vga.mjs` pins the rig's VGA behaviour: the BIOS default DAC, the
`v << 2 | v >> 4` expansion, the map mask, both host write layouts, the
four-pixels-per-plane-byte flattening, the start/offset/panning units, the
scan-out window and the end-of-memory behaviour.

`tools/vmrun.mjs --bytes` and `--nopan` switch the two measured conventions off
again; with either one the frames stop matching, which is how they were found.

## The transcode: part 1 without a VGA card

Since the effect turned out to be "copy a window out of one picture and hand
the DAC a running sum of two ramps", part 1 does not need a card, a CRTC or a
CPU.  `web/js/part1.js` performs the intent on a flat 320x200 index buffer, and
every constant in it comes from the disassembly of block 1 below.

```
0xc8b  start     mov bx,[cs:0x16a] / shr bx,4 / out 3d4 index 0c,0d
                 -> line start 4 * (counter >> 4) pixels
0xca3  panning   [cs:0x16a] >> 2 & 3, doubled -> out 3c0 index 0x13
                 -> shift ((counter >> 2) & 3) - 1 pixels
0xc5c  unpack    ds:si = strip, es:di = 0x50, 4 bytes in from pc16 apart,
                 0x40 dwords per row, +0x50 after each row, 0xc3 rows
0xc00  ramp      dx = step; negative -> 0; dx >>= 4; 0x40 entries of ah,
                 ax += dx while ax <= 0x3f00
0xc24  palette   0xc0 entries: clamp(ramp16c[tbl4f0[i]] + ramp1ac[tbl7f8[i]], 63)
0xdb5  main loop d = counter - 0x1f4; ramp16c = ramp(0x1000 - d);
                 ramp1ac = ramp(d);  stop when counter > 0x1500
```

The picture strip the unpack reads is at block offset `0x154a` (199,680 bytes:
`0xc3` rows of 1024), and because one plane byte is four pixels the strip's row
`r`, byte `k` *is* the picture pixel at `r, k`; the port copies rows into card
memory instead of running the unpack.  The two palette index tables are at
block offsets `0x5f0` and `0x8f8`.

**The DAC trails the scroll by four counts.**  The main loop builds the ramps
from the counter value it reads *after* an interrupt, and the interrupt that
writes the DAC happens one scroll step later, so a frame at counter `c` uses
`d = c - 0x1f4 - 4`.  That is measured, not assumed: with a lag of 0 or 2 the
frame comparison fails on many pixels, with 4 it only fails on the eight pixel
residue below.

Result, from `DOPE.EXE` alone (`node tools/part1check.mjs build/ref`): **11 of
the 15 reference frames are byte identical**, the other four differ by 8 pixels
each — 32 of 960,000.

That residue is one spot in the picture, not four odd frames.  It is picture
row 194 (the last row), source columns 263..270, values `2,2,3,4,5,4,3,3`, and
the reference shows 0 there.  Because the window scrolls, only the four frames
that happen to slide over that spot show it: screens x 253, 184, 115 and 46 as
the counter advances by 276, i.e. a fixed picture position.  What it is *not*:

* not a scan-out or palette mistake — the 8 pixels use palette entries that
  hundreds of other pixels in the same frame use and that match, and the rest
  of row 194 (including real content at columns 700..1019 in the counter 4086
  frame) matches to the byte;
* not a per-frame artefact and not introduced by the transcode — the snapshot
  rig produces the same values, and the strip is byte identical in the
  snapshot, so both models read `1,2,2,3,4,5,4,3,3,1,1` from the file.

So the reference's card held zeros at those eight picture pixels while the
executable holds values: a local difference in card memory, about eleven bytes
wide (the neighbouring index 1 pixels also render black, so they are invisible
either way).  A fresh capture run was attempted to see whether it reproduces,
but this capture came out misaligned (its screen is offset by several rows), so
that question is still open.  Everything else about those frames matches.

`tests/test_part1.mjs` pins the transcode: the strip placement, the scroll
units, the ramp builder, the palette at counter 774 (the values the original's
own DAC held), a frame digest per reference counter, the clock
(`counterAt`, 5376 counts in 38.96 s) and that an RGBA write matches the index
frame through the 6 bit DAC.

## Part 2: the structure, and the palette mistake this section used to make

Part 1 ends 39 s after the demo starts, i.e. about 55 s after launching
DOSBox-X (the loader spends ~16 s setting up the GUS before the counter starts
running).  A capture from that point on is in `build/ref_p2`:

```
python3 tools/refcapture.py --start 55 --seconds 20 --interval 2 --out build/ref_p2
```

Ten frames, 55..74 s, i.e. 39..57 s of the demo itself (part 1 ends at 39 s;
the loader spends about 16 s before the counter moves).  Each holds **70..107 distinct colours, all on the 6 bit
DAC lattice**, and this note used to conclude from that "a single 64 entry
palette cannot produce those, so the DAC is rewritten inside the visible
frame — part 2 needs a per line model".  **That was wrong, and the mistake was
part 1's palette size.**  Part 1 loads `0xc0` DAC entries (`0xc24`); part 2
loads all **256** (`0x300` bytes at block `0x38af`), so 70..107 colours is an
ordinary frame, not a mid-frame palette change.  Checked, not argued:

* the base palette is 768 bytes of 6 bit values, two spans of block 2 — `0x2d0`
  bytes at block `0x65080` (copied from `0x6507:0x10`) and `0x30` bytes at block
  `0x2bffa` (copied from `0x2bd2:0x2da`) — loaded to `cs:0x1f10` at part entry;
* the timer interrupt rewrites those 768 bytes every tick as
  `palette[i] = ramp[base[i]]` (block `0x2680`), where `ramp` is the 64 entry
  table built by block `0x2650` from the word at `cs:0x1941`, stepped by `0xff`
  per interrupt and saturating at `0x3f00` — a fade up out of black over 64
  ticks, after which the ramp is the identity and the DAC holds the base
  palette unchanged;
* **every colour of all ten reference frames is in that 256 entry palette**
  (0 missing per frame, at ramp step `0x100`), so one palette per frame
  accounts for the picture.  `web/js/part2.js` and `tests/test_part2.mjs`
  implement and check exactly this.

Part 2 ends at about 76 s of the demo.  In `build/ref_full` frame 11 (t=72)
still has the credits composition (two soft environment-mapped blobs top and
bottom, the credit lines between them), frame 12 (t=75) is a wipe and frame 13
(t=78) is the next scene, while the 2 s capture in `build/ref_p2` is still
credits at its last frame (t=57).  `web/js/look.js` puts its look-alike
boundary at 76 s for that reason (it used to cut at 72, four seconds early).

### Where part 2's code is (block 2 file offsets; segment offset = block − 0x100)

| block | what |
|-------|------|
| `0x386c` | the part's main function: setup, `0x1a98`, `0x387f`, then `int 21h` exit |
| `0x387f` | `int 10h` mode 13h, copy the palette spans, wait retrace, write 768 DAC bytes, clear `cs:0x0..0x30a`, attribute `0x31`/`0x20` = 0, point `cs:0x1a09` at the frame hook (`cs:0x2580` = block `0x2680`), call `0x1b5f` (sequencer/CRTC setup), build the gradient map |
| `0x1b21` | timer ISR: `cli`, EOI, `inc word [cs:0x1a1f]`, **wait for the start of vertical retrace**, reload the PIT from `cs:0x1a05`, `sti`, `call far [cs:0x1a09]`, add the divisor to `cs:0x1a07`, `iret` (or chain to the saved vector on carry) |
| `0x1bbf` | PIT calibration: one shot, wait for retrace, latch, `neg ax`, `imul eax,0x3e8 / shr eax,11` |
| `0x2680` | the frame hook: per-object animation, the palette rewrite above, `inc dword [cs:0x1924]` and `inc dword [cs:0x1928]` |
| `0x1a67` | fills a 128x128 map at block `0x35270` (rows 0x100 apart, 0x80 used) with `(0x18*x + 0xe8*y) >> 8`; the script sets the slope byte `cs:0x1965` to `0x18` |
| `0x381e` | "show the current object for `cx` frames": draw, then wait until the ISR has advanced `cs:0x1928` |
| `0x38f6` | the script: `mov word/dword [cs:state],imm` followed by `call 0x381e`, up to `0x44ed` |

Rendering is a software 3D engine, still **not ported**: `0x364a` walks the
object records at `cs:0x1810` (0x3a bytes each, terminated by 0/`0xffff`),
`0x3685` builds the polygon list, `0x3410` draws it, `0x370c` copies to
`A000:0` (behind a `cs:0x1904` mode: `-2` a row from `0x451:0xdb0a`,
`-1` black, `0` `0x80808080`, `1` from `0xec3`), the vertices are transformed
by `0x1c60` and projected by `0x1d60` (`idiv` by depth, centre `0xa0`/`0x64`,
y scaled 3/32 against x's 1/8), and the spans are texture mapped by
`0x27c6..0x27fa` with the texture gradients patched into the instruction
stream.  The polygon list lives at `gs = 0x2ccd` (block `0x2ccd0`), 4 byte
indices into vertex arrays at `gs:0x6720`, `gs:0x7148`, `gs:0x7b70`.

### Why the verification rig cannot see part 2 yet

`tools/vmsnap.py` keys on part 1's ISR bytes at `<segment>:0x20` (block
`0x120`), and block 2's layout is different: the ISR is at block `0x1b21`
(segment `0x1a21`) and part entry is `0x386c`/`0x387f`, not `0xcd5`.  Worse,
the parts address their own data through **relocated segment constants**: the
code says `push 0x4527` / `pop es` and the loader adds the part's base segment
(the same patch that turns part 1's `push 0xe4` into `push 0x105f`).  Block 2
does that everywhere (`0x2ccd`, `0x3527`, `0x4527`, `0x6507`, `0x2bd2`, and the
four-entry tables at `cs:0x400`/`cs:0x408` that select a texture and a shade
segment per sub-pixel phase), so a snapshot has to find the part's base, and a
standalone run has to relocate those immediates.  That is the next step before
any transcoding: the rig has to execute part 2 first, the way it executed part
1, and the frames it produces have to match `build/ref_p2`.

**The loader's relocation rule, measured.**  `tools/vmsnap.py --part 2` now
finds and freezes the running part (it keys on the block's own ISR bytes and on
the `int 8` vector pointing at `<segment>:0x1a21`), and a snapshot taken at 58 s
confirms the layout: part segment `0xf8b`, entry bytes identical to block 2 at
`0x386c`, counter 127.  Diffing the snapshot's part against the block file gives
the rule the loader uses: **a stored segment constant is patched by adding
`part_segment - 0x10`**, not `part_segment`.  Block `0x500` holds `0x6538,
0x6540, 0x6d38, 0x6540` and the running part holds `0x74b3, 0x74bb, 0x7cb3,
0x74bb`, i.e. +`0xf7b` for a part at `0xf8b` -- and `0xf8b0 - 0x100` is where
block offset 0 gets mapped, which is exactly why the addend is one paragraph
short.  That is the same `0xf7b` part 1's `push 0xe4` shows.

**The screen pipeline, read out of the code and checked against memory.**
Part 2's picture is built once per frame by block `0x370c` (segment `0x360c`),
which is called from `0x371e` after the objects are drawn:

| block | what |
|-------|------|
| `0x370c` | wait until the hook has bumped `cs:0x1924` (one frame) |
| `0x3721` | `es = 0x4527`, `di = 0x6e00`, `cx = 0xa00`: fill the 0x2800 byte band into the background buffer -- `[cs:0x1904] = -2` keeps the last band, `-1` fills black, `0` fills `0x80808080`, anything else copies `ds:0xdb0a + n*0x2800` from the band segment |
| `0x3780` | the compose: `0x7d00` word pairs, `byte = fs:[(span<<8)|band]`, with `span` the 3D buffer (`ds = 0x5517`) and `band` the background (`es = 0x4527`) |
| `0x37e3` | blit `0x3ed0` dwords from `0x5517:0x140` to `A0000:0` -- one 320 pixel row down, which is the vertical scroll |
| `0x37f9` | clear the band strip for the next frame |

The table the compose reads is built at segment `0x1998` into `0x3527`:
`0x80 | ((((0x1a0*span + 0x60*band) >> 1) + carry) >> 8) & 0x7f`, 64 x 128
entries written three times (`[bx+0x80]`, `[bx-0x8000]`, `[bx-0x7f80]`), so
every composed pixel has bit 7 set and uses the top half of the DAC.  Both
facts are *checked*, not inferred: rebuilding that table from the block's own
instructions reproduces the running part's 24,576 bytes exactly (0 differ), and
the four credit bands (`0x1201a`, `0x1481a`, `0x1701a`, `0x1981a` in block 2)
sit inside the part image at `part_linear + 0x11f1a`, contiguous and
byte-identical to the frozen part's memory.

That also settles what the early screens are: at counter 127 `[cs:0x1904] = 2`
and the object list is empty, so the picture is a band pushed through the shade
table with a zero span buffer.  The credit text is *in those bands*: it is
pre-shaded picture data, which is why there are no strings in block 2.

Every one of those addresses can be read straight off the frozen part, because
the loader patched the immediates in place: `push 0x4527` became `push 0x54a2`,
`0x5517` became `0x6492`, `0x3527` became `0x44a2`, and the band segment
`push 0x451` became `push 0x13cc` -- so the band the code reads is
`0x13cc0 + 0xdb0a = 0x217ca`, which is block `0x1201a`, not the `0xc01a` an
earlier reading of the band table guessed.  (The `0x451 -> 0x13cc` patch is
`+0xf7b` like the others; it is the *block offset* that was wrong.)

The screen buffer the blit reads (`0x6492`) read back through the base palette
matches the frozen screenshot with a one-row shift -- **90 of 199 rows and
57,526 of 63,680 pixels byte exact**, every other pixel off by exactly one
6-bit DAC step, which is the fade ramp's phase at the instant of the freeze,
not a picture error.

And the compose is checked against the original's *own instructions*, not only
against its output: put a known 3D buffer and a known band buffer where the
part expects them, set `ds/es/fs/si/cx` and `ip = 0x3680`, and the loop runs to
`0x369a` in exactly `0x7d00 * 10` instructions, writing 64,000 pixels that are
byte identical to what `web/js/part2.js`'s `compose()` predicts (0 differ).

That also explains the geometry buffers: `0x2ccd0` (polygon list), `0x333f0`
(projected x), `0x33e18`, `0x34840` and the 128x128 map at `0x35270` are **all
zero in the block file** and full of values in the running part.  They are
built at run time by the part's own setup, so a file-only transcode has the
credits (bands + shade table + compose, all transcribed) but not the 3D layer
that fills the span buffer.  `web/js/part2.js` therefore has `shadeTable()`,
`band(n)` and `compose()`, and no engine.

**What a run of part 2 actually does now (and the bug that hid it).**  The
earlier note here said the part "never writes video memory at all -- the draw
loop walks an empty polygon list".  That was a **rig bug, not a part-2 fact**:
`tools/vm/machine.js` took the snapshot's counter offset but still started the
CPU at part 1's fixed entry `0xbd5`.  Booting part 2 at `f8b:bd5` runs part 1's
code inside part 2's memory, which of course leaves the polygon list empty; the
two "impossible" phase segments (`0x1e71`, `0`) were that garbage.  With the
entry taken from the snapshot (`entry_cs_ip`, part 2's `376c`, verified against
block `0x386c`) the rig runs the part for real:

* `376c` → `3765` (palette copy `0x19ce`) → `1998` → setup `377f`: mode 13h, the
  two palette spans copied to `cs:0x1f10`, 768 DAC bytes out, `cs:0x1a09`
  pointed at the hook `2580`, `1a5f` builds the gradient map;
* the script then calls `371e` -- the per-object render -- which calls `354a`
  (object animation), `3585`, `3310` (draw), `360c` (blit to `A0000`) and waits
  for `cs:0x1928` until `[cs:0x371c]` frames have gone by;
* inside `3310` the rig reaches the vertex transform `1c60`, the projection and
  the texture span loop at `26c0`-`26fa` (the `mov al,[fs:bx]` / `mov bl,[bx+si]`
  / `mov [es:di-1],bl` body), which stores into the 3D buffer at `es = 0x54a2`
  (`0x54bb5`..`0x8ffe8`), i.e. it really is texture-mapping polygons.

So the engine is not the blocker any more; the span loop is.  It does not
terminate: `26fa` is `inc bp / jnz 26c6` and the count comes from `sub bp,dx`,
while the outer scanline loop is `dec word [cs:0x2654]` -- and `2660` fills that
counter with a store that has **no `cs:` prefix** (`mov [0x2654],dx`, i.e.
`ds:`), then sets `ds` from `cs:0x2e8c` afterwards, so it assumes the caller
runs with `ds == cs`.  Two experiments, both done, narrowed it:

* forcing `ds = cs` on every entry to `2660` makes spans *return* (21 entries,
  6 returns, and the outer counter now works) -- so that is a real convention,
  not the hang;
* the hang is the span's own length.  At `2660` the packed edge values are
  `2e60 = 0x01141099`, `2e64 = 0xbbe29e38`, i.e. one edge has a huge negative
  slope, and the resulting span is ~64 K pixels, which at ten instructions a
  pixel is a million instructions per span.

The projected vertex arrays next door are plausible (`0x332f0` and `0x33d18`
hold small screen coordinates like `0x14, 0x10, 0x1c`), so the transform is
running; the polygon being fed to the span filler is degenerate.  That is
consistent with a part that cannot be restarted from its own entry: the object
records live in `cs:0x1810` and the geometry comes from the loader's level map
(the six segment words of block 0 above), which a boot from block 2 alone does
not reproduce.  Reproducing that map is the next step, not another guess at the
span code.

Until that is answered the rig can boot and run part 2 but produces no frames,
so there is still no honest framediff against `build/ref_p2`; the palette test
above is the part-2 result that *is* measured.  The live screenshot is what the
real screen looks like at counter 127, and the framebuffer is not in the
`/proc/<pid>/mem` dump (DOSBox keeps `A0000` there as `0xff`, as does ours after
a planar clear), so the screenshot -- not the dump -- is the reference for the
picture side.

`tests/test_vga.mjs` pins the boot rule now (entry from the snapshot, `0xbd5`
only as the fallback), so this cannot silently come back.

## How the page plays the demo

`web/` runs the demo in order: `part1.js` draws until `counterAt(t)` reaches
`0x1500`, then `main.js` hands over to the reconstruction of parts 2..7.  The
handover is a time comparison, so it is testable: `?t=N` pins the picture at N
seconds and stops (`?t=5` is counter 690 of part 1, `?t=45` is the
reconstruction), and a canvas grab at `?t=5` is byte identical to the node
render for counter 690.  `?vm=1` plays part 1 alone, `?scene=N` pins one
reconstructed scene and skips part 1.
