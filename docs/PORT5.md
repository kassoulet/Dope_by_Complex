# Part 5: two fillers, a wobbling lighting table, and a cross fade through the palette

Block 5 of `DOPE.EXE`: the engine of parts 3 and 7 (`PORT3.md`, `PORT7.md`)
a third time, on the picture part 4 leaves.  `part5.js` is a subclass of
`part3.js`; `tools/addrmap.py` and `tools/ndiff.sh` found what differs
(listings with the numbers blanked out), and the differences are the study:

## Two ways to fill a triangle

The four materials of the polygon table (`cs:0` for the lookup picture,
`cs:8` for the lookup map) are not all phong.  Where the map entry is 0 the
polygon is filled by a **plain texture mapper** (`raster3.js`,
`texturePolygon`): one attribute, the rotated normal's x,y, used as a position in
a 256 x 256 texture, `texture[(v << 8) | u]`.  Block 7 contains the same code
and never takes it; here three of the four materials do.

Quirks that had to be kept exactly:

* the inner loops count pixels in `al`: a run of 256 pixels or more draws
  its count modulo 256, and a run that happens to be 256 long draws 256;
* the unclipped loop and the clipped loop patch different instructions, so
  the variables at their addresses differ (`tpatchL`...);
* the divisions for the per row slopes use `cwd` (one byte, `99`) and *not*
  `cdq` (`66 99`): the dividend is the sign extension of `ax`.  The first
  version of the port took the instruction for a `cdq`, tracked `eax`'s upper
  half and was wrong; the 16 bit disassembly prints both as `cdq`;
* **`shld ebx, ecx, 10`** instead of 8.  Block 3's phong lookup gets the 7 bit
  `x` and `y` of the map from the top byte of each lane (`shld 8`).  Here the
  author shifted by 10, which moves the low six bits of the `y` byte into the
  high byte of the index: `bx = ((ecx >> 8 & 0x3f) << 10 | ecx >> 22) & 0x7f7f`.
  The result is a lookup that is `x` scaled by 4, `y` mixed with `x`'s high
  bits: an accident that makes the lighting look like it does.  It showed up
  as a single pixel one colour off in frame 883 of 2,253.

## The row table is rebuilt by the timer

`cs:0x375b` holds the 256 words the phong inner loop adds to the pixel's row
(`mov si, [cs:eax*2 + 0x375b]`).  In part 3 it is a constant.  Here the timer
interrupt rebuilds it every tick (`0x3199`): a running angle `[0x1546]` moves by
`[0x1548]`, its sine goes through `dx = (sin >> 4) * 3 >> 4`, and from `dx` a
16 entry ramp `r[k] = ((k - 8) * dx) >> 8` is made; the table is every pair
`(r[i] << 8 | r[j])`.  The lit sphere breathes in and out.

## The vertex stage differs

The tex coordinate of a vertex is read from the object (`fs:[fs:0xa + 4v]`) and
not computed from the normal, and the rotated position is shifted by the object's offset
again after the rotation (`add eax, [0x14fa]`: the object turns around its
own centre and is also translated by it).

## The screen is not cleared

The part begins on the picture part 4 left (`tests/data/handoff4.z` for the lock step test; the page uses the end of the port of part 4).  Its low
nibbles become the background layer and the frame's first content (the
objects use colours 16..255); the 16 first DAC colours are saved.  At the end
the high nibbles are filled with the next part's picture and the 16 x 16
palette is cross faded between two 16 colour palettes through two
ramps (`mixPalette` of part 4, all 16 rows): fading the palette fades one
picture into the other without touching a pixel.  The fade is paced by the
card's retrace, 64 steps, not by the timer.

## Checked

`tests/test_port3_run.mjs --block 5`: the original from its first instruction,
timer held back, 2,253 frames, after each one every variable, the lookup row
table, the frame, the picture and the DAC are equal; then the cross fade at its
first and last step.  `--poly` checks polygon by polygon inside the frame (the
port draws each triangle the original is about to draw and compares the frame
and the variables when the original returns): that is how the `shld 10` was
found.
