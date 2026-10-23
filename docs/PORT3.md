# Part 3, "7800 PHONG polys": a software 3D engine, ported

Block 3 of `DOPE.EXE`.  A lumpy rock (514 vertices, about 1,000 triangles)
tumbles in front of a starfield and is lit per pixel.  The same engine, at
other addresses, draws the 3D parts 2, 5, 6 and 7, so this port is also the
study of that engine.  Files: `web/js/ports/engine3d.js` (vertices, faces,
sort), `raster3.js` (the triangle filler), `part3.js` (the frame, the timer
hook, the 21 step script).

## What a frame is

```
0x2b5a  for each object: matrix, transform+light+project vertices, build the face list
0x2b95  radix sort of the faces by depth
0x2920  draw the sorted faces back to front   (0x2311 triangle, 0x20f0 / 0x21e0 scanlines)
0x2c1c  paste the label, copy the buffer to the screen, restore the background
```

The timer interrupt (70 Hz, 0x2060) moves every object by its speeds and slides
the label; the main loop runs these four until the step's tick count is reached.

## The tricks

* **Matrix** (0x1ef6): one 2048 entry sine table built from a quarter period
  (mirror, negate, copy), cosine is the same table a quarter later; 15 bit
  fixed point, nine products with `imul`/`sar 15`.
* **Phong without normals at pixel time.**  Each vertex's *rotated normal* x,y
  become two coordinates (`env`), and its unrotated normal two more (`tex`).  The
  filler interpolates both across the triangle; per pixel it looks the pair up
  in a 256 x 256 table (the lit sphere, `fs`) and a second table maps that to
  a palette index (`ds`).  Interpolating the normal is Phong shading; the
  table lookup replaces the lighting arithmetic.
* **The edge arithmetic is packed.**  Two 16 bit lanes of one 32 bit register
  hold two attributes; one `add`/`adc`/`adc` chain steps both along an edge.
  The port keeps that chain, because the carries between the lanes are part of
  the result (`raster3.js`).
* **Self modifying gradients.**  The per pixel steps are patched as immediates
  into the scanline loop before each triangle; the port keeps them as fields.
* **No counting sort.**  The face list is ordered by an 11 pass radix sort on the
  top bits of the depth, each pass a stable two ended partition (clear bits
  fill the scratch from the front, set bits from the back), with no counters.
* **Selectors in the free bits.**  Vertex slots are multiples of 4, so the low two
  bits of vertex 1 and 2 carry which of four textures a triangle uses.
* **Back face culling** is a 16 bit cross product whose overflow is part of
  what you see; the port uses `Math.imul` and masks to 16 bits.
* **Frame composition.**  The background (a nebula) is copied *under* the next
  frame as soon as the last one is copied out, so there is no clear.

## How it was checked

* `tests/test_engine3.mjs`: matrix, vertex stage, face stage and sort, run in
  the original on a copy of the machine at seven moments, bytes compared.
* `tests/test_port3_run.mjs`: the whole part in lock step.  The original runs
  from its first instruction; its timer interrupt is delivered 1, 2, 3, 2 ...
  ticks at a time after the polygons are drawn, and after each frame the port
  must equal the original in: every variable (records, counters, the
  rasteriser's), the off screen frame, the picture, the DAC.  1,812 frames,
  all identical.  A few scratch variables the port has no use for (the sort's
  end pointer, temporaries of the object stage, one dead store in the
  filler) are masked, and listed in the test.
* The script (which variables change at which tick) is not retyped: 
  `tools/scriptdump.mjs 3 0x2d9b 0x305a 0x2ca4` decodes the straight line code
  that sets them into `web/js/ports/data/part3script.js`.
