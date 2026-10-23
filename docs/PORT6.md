# Part 6: a palette that breathes and lights that follow the camera

Block 6 of `DOPE.EXE`: the engine of part 5 on a city.  `part6.js`.  Same two
fillers, the same wobbling row table (here `cs:0x10`, rebuilt by the timer
from a brightness `[0x176e]` that the script moves), `shld 10`; the engine
differences are addresses, a face list at 0x3200 and a sort starting one bit
lower (12 passes instead of 11), and `neg edx` in the vertex stage, which mirrors
the lighting coordinates.

## Lights that follow the view (0x2f05)

The 256 wide lookup strip the polygons are lit from is repainted every frame in
its right half: every pixel is faded by 0x10 (`(ax - 0x1010) & 0x3f3f`, two
pixels at once) and the pattern pixel is added: a 64 x 64 pattern, each pixel
doubled both ways, whose segment is chosen by the camera's angle
(`(-angle & 0x3fff) >> 9`, 32 patterns).  So lights fade out behind a
turning camera.  The strip is an array of the image shared with the
objects' lookup, as in the original: the port's `image` is the 1 MB memory.

## A palette cross fade every tick

The timer interrupt, after the part's hook, uploads colours 16..207
(`0x3995`): `clamp(rampA[paletteA[i]] + rampB[paletteB[i]])` where `paletteA` is
loaded at the start from the data and `paletteB` is a second 192 colour
palette in the block, and the ramps (`ramp()` of part 4) are built by the frame
from the fade position `[0x3259]`, which the script moves.  Day to night, with
no pixel touched.

## The end

The script's 16 steps take 3,990 ticks; then the DAC is read back and faded to black in 37
steps (`bx = 256, 249, ...`, `colour = colour * bx >> 8`), one per retrace.

## Checked

`tests/test_port3_run.mjs --block 6`: whole part in lock step, every frame
(variables, row table and ramps, frame, picture, DAC), then the fade out.
A mouse driver could change the camera's selectors (`int 33h`); without a
driver, as here, that code is not taken, and the port leaves it out.
