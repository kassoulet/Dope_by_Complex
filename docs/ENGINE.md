# One engine, five copies

Parts 2, 3, 5, 6 and 7 of DOPE are drawn by the same software 3D engine.  It is not
a library: each block links in its own copy of the source, assembled again with
small edits, which is why the copies sit at different addresses and why the
differences between them are a record of the authors changing their mind.
This page is what the ports found when they were laid side by side; the code is
`web/js/ports/engine3d.js` (vertices, faces, sort), `raster3.js` (the triangle
fillers) and `part3.js` (the frame, the timer hook, the script), with one small
file per part for what it changes.

## The pipeline, once per frame

```
objects   for each object record: angles = (own + camera) >> 4, rotation matrix,
          every vertex transformed, lit, projected; every face culled and keyed
sort      radix sort of the faces by depth, one bit per pass, two ended partition
draw      polygons back to front: a lookup table (the "phong" fill) or a texture
          is read per pixel, the polygon is a triangle split in an upper and a lower half
compose   label slides in, the frame is copied to the card, the background restored
timer     (70 Hz, in the interrupt) moves every object by its speeds, slides the label
script    a straight line of "set these variables, run N ticks" steps
```

* **Vertices.**  `M` is a 3 x 3 matrix in 15 bit fixed point from three angles and a sine
  table (the file holds one quarter period; the part mirrors and negates it
  into a full period at start).  A vertex is rotated, then `x' = X * f / z / 8 + 160`,
  `y' = 3 * Y * f / z / 32 + 100`, both rounded by an `adc` that adds the centre and
  the bit shifted out (a 4:3 ratio built into the projection).  Two more values are made per vertex:
  `env`, the rotated normal's x and y (the coordinates of the lit sphere) and `tex`.
* **Faces.**  Visible when the 16 bit cross product of two screen edges has the right
  sign; keyed by `(sum of the three depths) << 16 | slot`.  The low two bits of
  vertex 1 and 2 (offsets are multiples of 4) carry which of four materials the face uses.
* **The two fillers.**  *Phong*: two attributes (`tex`, `env`), each two 16 bit lanes in
  one register, interpolated across the triangle; the pixel is `ds[ row[fs[T]] + U ]`.
  The colour depends on where the surface points, not on a flat shade.
  *Texture*: one attribute, `env`, as a position in a 256 x 256 picture.  Which one
  is used is decided per face by whether its material has a lookup map.
* The edges are held as packed screen addresses with 16 fractional bits, the two edges
  *crossed* in two registers so that one `add / adc / adc` chain steps both, and the per
  polygon gradients are written into the immediates of the inner loop before it runs.

## What differs between the copies

| | part 2 | part 3 | part 5 | part 6 | part 7 |
|---|---|---|---|---|---|
| title | phong BLUR motion | 7800 PHONG polys | (a rock on a floor) | SHADOW volume | 1995 WORLD domination |
| rotation matrix | **rounded** (`adc` after every `sar`) | truncated | truncated | truncated | truncated |
| vertex `tex` | from the object | from the normal | from the object | from the object | from the normal |
| vertex position | | | **translated again** after the rotation | | |
| vertex `env` | | | | **negated** (`neg edx`) | |
| sort | bit 18, 14 passes | bit 21, 11 | bit 21, 11 | **bit 20, 12** | bit 21, 11 |
| room for faces | 1,300 | 1,000 | 1,300 | 1,000 | **2,000** |
| phong `shld` | **9** | 8 | **10** | **10** | 8 |
| row table (`cs:`) | fixed, at 0 | fixed, at 0 | **rebuilt by the timer**, 0x375b | **rebuilt by the timer**, 0x10 | fixed, at 0 |
| texture fill used | yes | no | yes | yes | no (present) |
| lookup picture | fixed | fixed | fixed | **repainted each frame**, follows the camera | **repainted each frame**, five moving blobs |
| screen | band + feedback shade | frame | frame over part 4's picture | frame | frame |
| palette | fade in, then white | fixed | cross fade at the end | cross fade every tick, fade out | fixed |

Reading the columns left to right is reading the history: part 2's copy has the
rounding the others lost, the phong index is scaled by 9, 8, 10 as the author kept trying
(the `shld 10` is an accident: it was meant to rescale the index and instead
mixes bits of the two lanes, and that is how part 5 and 6 look), and the row table that
part 3 never touches becomes in part 5 a live brightness ramp.

## How the copies were compared

* `tools/ndiff.sh A a1 a2 B b1 b2` disassembles two address ranges and diffs them with
  every number blanked out: two copies of the same routine differ in a handful of
  lines.  The ranges in part 7's engine differ in **two** lines from part 3's.
* `tools/addrmap.py A a1 a2 B b1 b2` aligns the two listings and prints which address in
  B corresponds to every address in A: that is how the variable tables of the
  rasteriser (`V2`, `V5`, `V6`, `V7`) were made without typing a hundred addresses.
* `tools/disblock.py <block> <from> <to>` is the disassembler both use.
* `tools/scriptdump.mjs` / `tools/scriptdump2.py` decode the straight line scripts into data.

## Quirks that had to be copied

* `99` in 16 bit code is `cwd`, not `cdq`.  The row slope divisions look like
  `cdq` in the disassembly; they sign extend `ax`, and a port that tracks `eax` and
  extends its bit 31 is wrong.  (The first version of the part 5 port got this wrong; the polygon by polygon check found it.)
* The inner loops of the texture filler count pixels in `al`.  A run of 256 or more
  pixels draws its length mod 256, and a run of exactly 256 draws 256.
* The row slopes of the lower triangle are divided *after* the upper triangle has been
  drawn, from the accumulators it left: attributes may change sign there.
* The vertex arrays and the end of the frame buffer overlap in part 6 (the frame is 64 KB
  at one segment, the arrays start 0xff00 further on), so the port keeps both in one memory image.
