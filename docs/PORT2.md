# Part 2, the credits: the oldest copy of the engine and a feedback compositor

Block 2 of `DOPE.EXE`.  It is the same software 3D engine as parts 3 to 7, but the
earliest assembly of it, and the one part where the engine does not draw the
screen directly.  `web/js/ports/part2.js`, a subclass of `part3.js`.

## What differs in the engine

Found with `tools/ndiff.sh` (two listings, numbers blanked out) and
`tools/addrmap.py` (what each address became):

* the polygon code is block 5's, 0xb30 bytes earlier: both fillers (the plain texture
  filler is used here too: 17,000 of 44,000 polygons over the part), the phong one
  with **`shld ebx, ecx, 9`** (parts 5 and 6 use 10, 3 and 7 use 8);
* the vertex stage is block 3's with a per vertex texture coordinate from the object
  (no `add offset` after the rotation);
* the **rotation matrix is the older routine**: every `sar 15` is followed by
  `adc 0`, which rounds to nearest, except the inner product of the fourth entry
  (the author forgot it, and so does the port).  Without it a vertex differs by
  one unit in a frame in ten, which showed up in the lock step test as a 34 where
  a 35 was expected in a variable the picture did not even use;
* the sort starts at bit 18: 14 passes, the most of any part.

## The compositor: a picture that feeds back on itself

The polygons are not drawn on the screen buffer but on the *band* buffer
(segment `0x4527`), which also holds, in a 40 row strip, a line of credits
(there are four, `[0x1904]` picks one; `-2` leaves the strip, `-1` clears it, `0`
fills `0x80`).  Then for every pixel of the screen buffer (`0x5517`):

```
screen[i] = shade[ screen[i] << 8 | band[i] ]
```

with `shade` (0x1a98) `= 0x80 | ((0x1a0 * old + 0x60 * band) >> 1) >> 8`: 0x1a0 = 416
weighs the OLD screen value, 0x60 = 96 the band, so **each frame the screen is
81 % the previous screen and 19 % the new band**: a recursive blur.  That is the soft glow and the trails.  The table is 256 x 256
but only built for values below 64 and 128, in three mirrors, so the high bit
of the previous output (always set) is ignored: the feedback loop keeps working
on its own results.  Then the label is pasted in the screen buffer, the buffer is
copied to the card, and the band is cleared or reloaded from the next picture
(`[0x1947]`).  A script step (`clearshade`) zeroes the upper half of the table, which breaks
the loop on purpose: the next frames go dark.

The phong lookup map the polygons read, a 128 x 128 ramp `(slope * x + (256 - slope) * y) >> 8`
(`0x1a67`), sits in the same segment as the shade table (their cells do not
overlap), and the script changes the slope 118 times (a `call 0x1a67` after each
write) so that the lighting slides.

## The palette

Colours come from two spans of the block (0x2d0 and 0x30 bytes) and are fed through a
64 entry ramp every tick while `[0x193f]` is 1: a fade in from black over 64 ticks.
(Part 4's ramp divides its step by 16, this one does not.)  The part ends by setting
all 768 DAC values to 63: a white screen.

## Script

153 steps (`tools/scriptdump2.py`, which also knows the `dec`, `call 0x1a67` and the
table clear that the simpler dumper cannot represent).

## Checked

`tests/test_port3_run.mjs --block 2`: from the first instruction, frame by frame:
variables, band buffer, screen buffer, shade table and map, DAC, picture.
