# Part 7, "1995 World domination": the same engine, a living lookup table

Block 7 of `DOPE.EXE`: a knot of snakes turns over a desert horizon.  It is
the engine of part 3 (see `PORT3.md`) *assembled again at other addresses*:
`tools/disblock.py 3 …` and `tools/disblock.py 7 …` listings, with the
numbers blanked out, differ in two lines.  So `engine3d.js` and `raster3.js`
take their addresses as data (`OFF7`, `V7`: room for 2,000 faces instead of
1,000, and every variable of the polygon routine 8 to 28 bytes earlier) and
the port of the part itself is `part7.js`, a subclass of `part3.js`.

## What is new: the lookup table moves

The phong polygon colours a pixel with `ds[row(fs[T]) + U]`: `ds` is a 256 x
256 picture and `U` is where on it the surface normal points.  Part 3's picture
is fixed.  Part 7's is rebuilt every frame (`0x3189`..`0x3266`):

1. copy a 64 KB background picture into the buffer (`rep movsd`);
2. add five 128 x 128 "blob" sprites into it with a plain 32 bit `add` of four
   pixels at once (bytes carry into each other; the sprites are dark enough that
   they never overflow), each at a position taken from the sine table at a
   different multiple of the tick counter: `x = sin(t)`, `sin(8t)`, `sin(4t)`,
   `sin(2t)` and `sin(sin(3t)/8)` against the matching cosine.

The snakes' surface normals then look up *this* picture, so the highlights slide
over the metal without anything on the object changing.  The buffer sits at
`0x13b4` (+ the loader's `0xf7b`); `ds` points 0x404 paragraphs into it.

## The rest

* the frame is part 3's: objects, 11 pass radix sort, polygons back to front,
  paste the label (here `0x19c6` names its segment: the script swaps in a
  second label picture), copy to the screen, restore the background;
* the script is 7 steps, 2,100 ticks (`tools/scriptdump.mjs 7 0x331d 0x34a8
  0x3170`); then a 128 x 64 strip of picture is copied to the screen and the part
  idles for 350 ticks before the fade;
* the polygon routine also holds a plain texture mapper (taken when the `fs`
  table entry is 0).  No polygon of this part uses it, so it is not ported;
* between the polygon code and the data the author left a note to rippers
  (`HELLO LAMER !!! HAVING NICE TIME WITH MY CODE ???`).

## Checked

`tests/test_port3_run.mjs --block 7`: the original from its first
instruction, timer held back and delivered 1, 2, 3, 2 … ticks at a time; after
each of 1,053 frames the port equals it in every variable, the animated lookup
buffer, the off screen frame, the picture and the DAC; then the final strip
and the 350 tick wait.
