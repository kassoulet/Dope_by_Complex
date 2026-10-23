# Part 4: FIRE clouds, FRACTAL scape, checker floor

Code: `web/js/ports/part4.js` (about 430 lines).  Original: block 4 of `DOPE.EXE`,
485,072 bytes unpacked, of which the code is 0x1500..0x2158.  7,443 timer ticks
(106 s).  Method: `PORTING.md`.  Tests: `tests/test_port4.mjs` (every routine, 8
moments, 160 checks) and `tests/test_port4_run.mjs` (the whole part in lock
step with the original).

## What the part does

| ticks | what you see | script (main loop) |
|-------|--------------|--------------------|
| 0..1400 | fire swirl over the previous part's screen | draw until `[0x1969] >= 0x578` |
| ..2886 | the "larusse FIRE clouds" label slides in | label speed +1, fire rotation 0x1f |
| ..+1280 | label slides out | speed -1, rotation 0x1d |
| ..+1050 | a landscape grows out of the fire | fade B falls, palette 1 = terrain's |
| ..+1750 | "larusse FRACTAL scape" | label B slides in |
| ..+490 | the landscape fades | fade B rises |
| ..+1024 | checker floor under the fire | an ILBM picture becomes the back layer |

The whole script is eight comparisons of one counter in the main loop
(`0x1e19..0x1f81`), each followed by a few stores.  `STAGES` and `Part4.script()`
are those lines.

## The idea: two layers in one byte

Every pixel of the screen is one byte, and the byte is two things:

* the **high nibble** is the fire's intensity, 0..14;
* the **low nibble** is a second layer: a landscape, or a picture, 0..15.

The palette is the 16 x 16 table of every combination, and it is *computed*:
colour (fire `i`, layer `j`) = `min(63, rampA[ P1[j] ] + rampB[ P2[i] ])` per
component, where `P1` is 16 RGB colours for the second layer, `P2` 16 colours
for the fire, and `rampA`/`rampB` are two 64 entry ramps that cross-fade as
time passes (`ramp` below).  So to dissolve the fire into another look, or the
landscape into the checker, the demo does not move a pixel: it changes two ramps
and uploads 720 palette bytes (`mixPalette`).  The label (its own 16 colours,
0xf0..0xff) sits outside the table.

```asm
; 0x1aa9 .. 0x1b06: for each fire colour (15) and each layer colour (16):
mov bl,[cs:si]            ; component of P1[j]
mov al,[cs:bx+0x15e9]     ; rampA[ that ]
mov bl,[cs:di]            ; component of P2[i]
add al,[cs:bx+0x1629]     ; + rampB[ that ]
cmp al,0x3f
jc  ok
mov al,0x3f               ; saturate
```

## The routines

### `ramp` (0x1a75)

A 64 entry ramp built from a 12 bit fade position.  The same routine as part 1's
(0xc00): `ax` is an 8.8 number, `ah` is stored (so no shift), and the value
saturates by *not adding* once past 63.

```asm
mov [cs:bx],ah
inc bx
cmp ax,0x3f00
ja  skip
add ax,dx
skip: dec cx / jnz
```

### `mixPalette` (0x1a99)

The 16 x 16 table above, written to DAC 0..239 with `outsb` (the card
auto-increments R, G, B, R, ...).

### `buildSine` (0x1fa8)

The file stores a quarter of a sine (512 words, `cs:0..0x3ff`).  Three tiny
loops make the 2048 entry period and room beyond it: the first copies the quarter
*backwards* (`lodsw / stosw / sub di,4` writes ascending while walking down),
the second negates what exists into the next half, the third repeats the start.

### `squashMap` (0x1c36), `buildBlend` (0x1c56)

`squashMap` rescales the 64 KB texture: `m = min(0x7f, m*7/4)`.  `buildBlend`
fills a 128 x 128 table (row stride 256) with

    blend[old][m] = min(0x70, (m*k + old*(256-k) + 63) >> 8),   k = 0x18

which is the whole fire in one line: **a pixel moves k/256 = 9% of the way from its
old value to the texture value**.  An exponential smoothing, with a lookup table
instead of a multiply.

### `warp` (0x1bab and the loop at 0x1c00)

One frame of fire.  A *warp field* in the file (16,384 pairs of 16 bit offsets)
says, for each pair of pixels, where to look in a 64 KB texture.  The whole
animation is **one number**: the shift added to every offset, a sine of an
angle plus a steady drift (`shiftFor`).

```asm
1c00: mov bx,[es:ecx*4+2]    ; this pixel's offset from the warp field
1c09: add bx,0x0             ; + shift: the immediate IS the shift, patched into the code
1c0d: mov bl,[fs:bx]         ; texture value there
1c10: mov bh,[di]            ; the pixel's old value
1c12: mov al,[gs:bx]         ; blend[old][texture]
      ... the same for the second pixel of the pair, then
1c2b: mov [di],ax            ; store both
```

The shift is stored into the two `add bx,imm` instructions (`mov [cs:0x1b0b],bx`
and `0x1b20`): **the demo passes the parameter of its inner loop by rewriting
the loop**, so the loop does no extra load.  The pass is skipped when the shift
did not change.  Note the fire buffer is read *and* written: the fire is a
feedback system, which is why the picture depends on how many frames were drawn.

### `compose` (0x1c91 second half, 0x1d6b)

The 160 x 200 fire becomes 320 x 200 pixels: each fire value is doubled in width
and dithered, and the low nibble comes from the back buffer.

```asm
mov bx,[esi*2]            ; two fire pixels
mov al,bh / mov ah,bh
shl eax,16
mov al,bl / mov ah,bl     ; eax = bl bl bh bh: four screen pixels
lea eax,[edx+eax*2]       ; value * 2 + dither
and eax,0xf0f0f0f0        ; keep the high nibble: 16 fire levels
add eax,[fs:esi*4]        ; + the back buffer's four pixels (low nibble)
mov [es:esi*4],eax
...
rol edx,8                 ; next row: the dither bytes rotate
```

Four pixels per instruction pair, no branches, and the dither (`edx =
0x01040007`: bytes 7, 0, 4, 1) is a 4 x 4 ordered dither that costs one `rol` per
row.  The fire is at most 0x70 so doubling it never carries into the next byte.
Rows 148..191 are staged in a 44 row buffer (so the label, a 70 x 44 sprite, can
be pasted over them `slide` pixels wide from the right edge) and copied to the
screen.

### `terrain` (0x1ffc)

The "fractal scape" is not 3D.  The map is two 256 x 256 byte arrays (heights and
colours).  Rows are drawn from far to near; row `d` is the map row at distance
`tbl[row]*16 + scroll` (the steps between rows widen with distance:
`ROW_STEP`).  Per column the map is sampled with 16.16 fixed point and linear
interpolation (`imul` / `shrd ax,dx,7`), the height is multiplied by `0xaaaa/d`
and subtracted from the row's baseline `0x8000/d + 0x48` to give the screen
height of the hill.  A per column memory `ycol` holds the highest point drawn so
far, and **only the strip between the old and the new height is painted**, so
hidden terrain costs nothing (the classic voxel-space occlusion).  One division
per row, two multiplies per column.

```asm
sub bp,di            ; previous top - new top
jns hidden           ; not visible: only remember the colour
...
mov [di],al          ; paint upward
sub di,0x140
dec bp
jnz ...
```

`ycol` is not cleared between frames: the far row compares against what the
nearest row left (initially 100 for every column, which is in the file).

### `decodeILBM` (0x15f3)

The checker is an IFF ILBM picture (Deluxe Paint) embedded in the block.  The
routine scans for the words `CM`,`AP` then `BO`,`DY`, shifts the 768 palette bytes
down to 6 bits and unpacks the ByteRun1 body (a byte `n >= 0` copies the next
`n+1`, a negative one repeats the next `1-n` times) straight into the back
buffer.

## What the port had to find out

* The label's palette is not in the part's segment: it lives in the *label's*
  segment at `0x2da` (found by the whole-part check on the first frame).
* The back buffer starts as a copy of the **card** (`rep movsd` from `0xa000`):
  the part's first image is the previous part's last, which is why the fire
  appears over the starfield.  (The emulator had to learn to read the card back
  before block 5 would work, for the same reason.)
* `ycol` starts at 100, not 0 (the first terrain frame of the lock step).
* The first 16 colours of the mix (`P1`) are read back from the DAC at start
  (`insb` on port 0x3c9): the previous part's colours.
* A timer tick is `isrTicks++` then the hook; the palette mix happens on odd
  ticks only.

## Numbers

* 3 KB of code became about 430 lines, including comments.
* 160 routine checks + 3,700 lock-step frames, all identical.
* The port runs part 4 at 33 pictures/s in headless Chrome on a software renderer
  during the fire, 9 during the terrain; the original needed a Pentium for the
  terrain.
