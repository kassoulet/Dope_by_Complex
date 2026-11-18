# DOPE (Complex, 1995) - asm snippets worth reading

Addresses: "block N 0xXXXX" is an offset in the unpacked block N (`build/blockNN_*.bin`, the eight RNC ProPack blocks of `DOPE.EXE` decompressed by `tools/rnc.py`; block 1
is part 1, block 2 is part 2, and so on; block 0 is the loader). The address column and the jump targets of every listing are those block offsets. **Data operands are not**:
inside the code `[cs:0x16a]` or `[0x2e60]` are the program's own offsets, which are 0x100 lower than the block offset (`WRITEUP-effects.md` header: "the code's own addresses are that minus 0x100"): for instance the immediate
of `add ecx,0x0` at 0x27E5 (imm32 at 0x27E8) is what the program calls `[0x26e8]`; section 9 uses that to show the patching. Every listing was re-disassembled for this write-up with
`ndisasm -b16 -o ADDR` from those block files (what `tools/disblock.py` does with capstone). `ndisasm` prints `shr r,1` as `shr r,0x0`; written back as `1` where it occurs.

The code is real mode 16-bit with 386 registers (`66`/`67` prefixes): `mov si,[cs:eax*2+0]` is a 16-bit instruction with a 32-bit index. Block 2's own banner (block 2 0x2ED0,
repeated in blocks 3, 5, 6, 7) says "DON'T TELL ME IT'S NOT OPTIMIZED OR 'REAL' BECAUSE I KNOW THAT ALREADY! WHY OPTIMIZE ANYTHING FOR PENTIUM 100 MHZ?"; next to it, at
0x2DC0, "HELLO LAMER !!! HAVING NICE TIME WITH MY CODE ???". The numbering below follows the references in `WRITEUP-effects.md` ("asm 6", "asm 10", ...).
Where something is my reading rather than what the bytes show, it says so.

---

## 1. Wait for the retrace edge, not for "a" retrace (block 1 0x110)

```
0110: mov dx,0x3da
0113: in al,dx
0114: test al,0x8
0116: jnz 0x113          ; first: leave a retrace that is already in progress
0118: in al,dx
0119: test al,0x8
011b: jz 0x118           ; then: wait for the next one to begin
011d: ret
```

Waiting only for "bit 3 set" returns at once if the call lands in the middle of a retrace, and the palette or CRTC write that follows then lands half way down the
picture. Two loops and nine instructions, and every caller starts on the leading edge. It brackets the timer calibration of section 3.

## 2. A timer interrupt that decides on the carry flag (block 1 0x15A; part 2 0x1B21)

```
015a: call 0xc24                 ; rewrite the palette
015d: mov ax,[cs:0x4]            ; the PIT reload value this demo programmed
0161: add [cs:0x6],ax            ; 16 bit accumulator of PIT counts  -> CF
0166: popad
0168: pop gs / pop fs / pop es / pop ds       ; pop and popad do not touch the flags
016e: jc 0x171
0170: iret
0171: jmp far [cs:0x0]           ; chain to the old INT 8 only when the accumulator wrapped
```

The demo runs the PIT at its own rate (about once per frame, section 3), so the BIOS tick that keeps the DOS clock would run far too often. The handler adds the reload value to
a 16-bit accumulator that wraps once per 65,536 counts: that is exactly the BIOS's native 18.2 Hz period, and the wrap shows as the carry flag. The handler then pops
twelve registers and **still branches on the carry**, because none of those pops changes the flags. One `add` is all the bookkeeping, one `jc` decides whether to chain, so the
DOS clock stays right although the interrupt rate was changed.

Part 2's handler (block 2 0x1B21) has the same ending with the order `add [cs:0x1a07],ax / pop dx / pop ax / jc 0x1b5a / iret`, and in front of it waits for the start of the retrace
(`in al,dx / test al,8 / jz`) before re-arming the PIT in one-shot mode (`mov al,0x30 / out 0x43,al`, divisor from `[cs:0x1a05]`), then `sti` and a far call to the part's hook.

## 3. Calibrating the timer against the monitor with one multiply (block 1 0x1D6, 0x1EB)

```
01d6: call 0x110                 ; sync to a retrace edge
01d9: mov al,0x36 / out 0x43,al  ; counter 0, mode 3, 16 bit
01df: xor al,al / out 0x40,al / out 0x40,al      ; reload value 0 = 65536, free running
01e7: call 0x110                 ; one whole frame later
...
01ef: xor eax,eax / out 0x43,al  ; latch the counter
01f6: in al,0x40 / mov ah,al / in al,0x40 / xchg al,ah
0200: neg ax                     ; down counter: elapsed = -count
0206: imul eax,eax,0x3de
020d: shr eax,0xb                ; x 990/2048 = 0.4834
0211: mov [cs:0x4],ax            ; the reload value of the one-shot in section 2
```

The routine measures how many PIT counts one vertical retrace period takes (about 17,000 at 70 Hz: 1,193,182 / 70.09), scales it by 990/2048 with an `imul` and a `shr` (no
division, power-of-two divisor) and keeps that as the one-shot delay the handler of section 2 re-arms after each retrace. My reading: the interrupt then fires a little under half a
frame after the start of the retrace, so the CRTC and palette writes always happen at the same point of the frame whatever the monitor rate. That is inference from the constant;
what is measured on the running demo is only 69 interrupts per second (`README.md`). The `0x3de` and the `0xb` are in the bytes; "just under half a frame" is arithmetic.

## 4. A 64 entry gradient that saturates by not adding (block 1 0xC00)

```
0c00: test dx,dx
0c02: jns 0xc06
0c04: xor dx,dx          ; negative step -> 0
0c06: shr dx,0x4
0c09: cmp dx,0x100
0c0d: jc 0xc12
0c0f: mov dx,0x100       ; clamp the step to 1.0
0c12: mov cx,0x40
0c15: mov [cs:bx],ah     ; store the integer part: AH is bits 8..15 of an 8.8 number, free
0c18: inc bx
0c19: cmp ax,0x3f00
0c1c: ja 0xc20           ; already past 63.x: stop adding
0c1e: add ax,dx
0c20: dec cx
0c21: jnz 0xc15
```

`ax` is 8.8 fixed point, so `ah` is the integer part with no shift. The DAC is 6 bits, and the saturation at 63 is done by **not adding** once `ax > 0x3f00`, instead of clamping
afterwards. The slope comes from the demo's counter, so the ramp and the palette crossfade of part 1 move with time without any per-frame arithmetic besides this loop.
`WRITEUP-effects.md` section 1 has the JavaScript twin.

## 5. A palette crossfade that never sees a colour (block 1 0xC24)

```
0c2a: mov cx,0xc0                ; 192 = 64 colours x 3
0c2d: mov dx,0x3c8 / xor al,al / out dx,al / inc dx      ; DAC write index 0, then port 0x3c9
0c34: mov bl,[cs:bp+0x4f0]       ; index into ramp A
0c39: mov al,[cs:bx+0x16c]
0c3e: mov bl,[cs:bp+0x7f8]       ; index into ramp B
0c43: add al,[cs:bx+0x1ac]
0c48: cmp al,0x3f
0c4a: jc 0xc4e
0c4c: mov al,0x3f                ; saturate
0c4e: mov [cs:bp+0x1ec],al       ; shadow copy of the DAC
0c53: inc bp
0c54: out dx,al                  ; the DAC auto-increments R,G,B,R,G,B...
0c55: dec cx
0c56: jnz 0xc34
```

There is no "colour" structure in this loop: 192 iterations, one byte per iteration to port 0x3C9, and the DAC steps through R, G, B and on to the next entry by itself. Each byte
is a saturating sum of two entries picked by two precomputed index tables (one per ramp of section 4), so changing the two slopes cross-fades two whole palettes while the
picture is never touched. 192 table lookups per frame replace a pixel rewrite.

## 6. Unpacking a picture into planar VRAM, four pixels per store (block 1 0xC5C)

```
0c5d: mov cx,0xc3                ; 195 rows
0c60: push cx
0c61: mov cx,0x40                ; 64 groups per row
0c64: mov bl,[si+0x8]
0c67: mov bh,[si+0xc]
0c6a: shl ebx,0x10
0c6e: mov bl,[si]
0c70: mov bh,[si+0x4]
0c73: mov [es:di],ebx            ; ONE 32 bit store = four plane bytes
0c77: mov bx,ds
0c79: inc bx
0c7a: mov ds,bx                  ; source += 16 bytes, by moving the segment
0c7c: add di,0x4
0c7f: dec cx
0c80: jnz 0xc64
```

Two tricks. The card is in an unchained planar mode, where pixel x of a row sits in plane x mod 4; for one plane the pixels are at stride 4 in the source (`[si]`, `[si+4]`,
`[si+8]`, `[si+0xc]`). Gathering the four bytes in `ebx` with `shl ebx,16` makes one `mov [es:di],ebx` write four plane bytes. And the source advances by `inc bx / mov ds,bx`
(a 16-byte step) instead of `add si,16`: the picture strip is larger than 64 KB, and moving the segment means the offset `si` never overflows. That also explains why the
picture has to sit where the loader mapped it (`README.md`: "a part is not self contained"). (I only got this right after the first port was off by a unit: the card's plane bytes
hold four pixels each, and the CRTC start and offset registers count plane bytes.)

## 7. The scroll: two register writes from one counter (block 1 0xC8B, 0xCA3)

```
0c8d: mov bx,[cs:0x16a]          ; the shared counter
0c92: shr bx,0x4                 ; 16 counts = one start address unit
0c95: mov dx,0x3d4
0c98: mov al,0xc / mov ah,bh / out dx,ax        ; CRTC start address high
0c9d: inc al / mov ah,bl / out dx,ax            ; CRTC start address low
0ca2: retf
...
0ca5: mov dx,0x3da / in al,dx                   ; reading 0x3da resets the attribute flip-flop
0ca9: mov dx,0x3c0 / mov al,0x33 / out dx,al    ; index 0x13 | 0x20: horizontal pel panning
0caf: mov ax,[cs:0x16a]
0cb3: shr ax,0x2 / and al,0x3 / add al,al       ; pan 0, 2, 4, 6
0cba: out dx,al
```

Each `out dx,ax` writes the index and the data byte of the CRTC with one instruction. The counter is read twice: its high bits move the start address in coarse steps, its low bits go to
the attribute controller's panning register for the fine steps, so a picture that can only be moved a few pixels at a time by that register appears to scroll one pixel per
two counts. No pixel is copied; the whole animation of part 1 is a window sliding over a picture that was unpacked once (`web/js/part1.js` draws it as a crop).

## 8. The texture/phong inner loop: 14 instructions, 32-bit packing in 16-bit code (block 2 0x27C0)

```
27c0: mov edx,[cs:0x2650]         ; setup: V accumulator
27c6: mov bl,ch
27c8: shld ebx,ecx,0x9            ; assemble both coordinates in one index
27cd: and bx,0x7f7f               ; ... wrapped to 128 x 128 by one AND
27d1: inc di
27d2: mov al,[fs:bx]              ; lookup 1: a 128 x 128 map in FS
27d5: shld ebx,edx,0x8
27da: mov si,[cs:eax*2+0x0]       ; 67-prefixed: 32 bit index in 16 bit code, a table of row offsets
27e3: mov bh,dh
27e5: add ecx,0x0                 ; imm32 patched at run time
27ec: mov bl,[bx+si]              ; lookup 2: the picture in DS, shaded by SI
27ee: add edx,0x0                 ; patched too
27f5: mov [es:di-0x1],bl
27f9: inc bp
27fa: jnz 0x27c6                  ; BP counts up from negative to 0
```

* **Two attributes per register.** `ecx` and `edx` each carry two 16-bit lanes; one `add ecx,imm` steps two coordinates. `shld ebx,ecx,N` followed by `and bx,0x7f7f`
  forms the (y,x) index of the 128 x 128 map without a `shl/or` pair.
* **No compare in the loop**: the span length is a negative count in `bp` that `inc bp / jnz` brings to zero.
* The segment registers are used as free pointer registers: `fs` the map, `ds` the picture, `es` the screen, `cs` the row table; the loop needs no base arithmetic.
* The 14 instructions are the loop body from 0x27C6 to 0x27FA, as counted in the listing above.
* `ds` and `fs` are loaded from two four-entry tables indexed by the sub-pixel phase of the span start (`WRITEUP-effects.md` and `docs/` give the measured values for part 2:
  `fs` is a 128 x 128 map of palette indices 1..127, the second lookup is the same map shifted by a row).

## 9. Patching the immediates of your own loop, and the loop that reads them back (block 2 0x2785, 0x2B3C..0x2B88, 0x28E6)

The per-polygon gradients are not kept in variables. The set-up divides lane differences by the row count and **stores the word quotients straight into the immediate fields** of
the instructions that will use them (the zeros in the file are placeholders):

```
2b48: cwd
2b49: idiv bx                    ; (lane difference) / rows
2b4b: mov [0x2708],ax            ; -> imm of "add [cs:0x2650],imm32" (lane high word)
...
2b7f: shl eax,0x10
2b83: cwd (66 99 = cdq)
2b85: idiv ebp
2b88: mov [0x26f1],ax            ; -> the imm32 of "add edx,0x0" at 0x27ee (its low word)
...
2785: mov [0x2717],esi           ; the two edge steps, written into add/adc imm32 fields
278a: mov [0x271e],edi
```

How the addresses line up (because data operands are 0x100 lower than block offsets): `add dword [cs:0x2650],0x0` at 0x2800 has its imm32 at 0x2806 = `[0x2706]`, which is written at
0x2B3E; the second one at 0x280A has its imm32 at 0x2810 = `[0x2710]`, written at 0x2B58; the span loop's `add ecx,0x0` and `add edx,0x0` have theirs at 0x27E8 = `[0x26e8]`
and 0x27F1 = `[0x26f1]`, and 0x2B88 is the store into the second. Nothing is moved between the set-up and the loop: the immediate **is** the variable.

The same routine has a second span loop for the clipped case that keeps the deltas as memory operands, and the operands are the patched fields themselves:

```
28e6: mov bl,ch
28e8: shld ebx,ecx,0x9
...
2905: add ecx,[cs:0x26e8]        ; the imm32 of the first loop's "add ecx,0x0"
290d: add edx,[cs:0x26f1]        ; the imm32 of "add edx,0x0"
```

* On a CPU with eight registers it frees two of them in the hot loop and removes one memory read per use; it costs a code-cache flush on a Pentium, which the authors accepted.
* It is the one thing that breaks "code is constant" for the emulator I used as the oracle (`tools/vm/jit.js`): it marks every translated byte, drops a block when a store hits
  it, and after a hit on an immediate reads that field from memory. Without that, part 2 recompiled its span loop 112,000 times in 3 seconds (`docs/RUNTIME.md`).
* The block-offset arithmetic above was done by me from the listings; the register-lane meaning of each immediate half (which lane is the high word) I did not trace.

## 10. Two edges in two registers: one `add / adc / adc` (block 2 0x2814, 0x28E6..0x2970)

```
2814: add ebp,0x0                 ; imm32 patched (section 9)
281b: adc edx,0x0                 ; imm32 patched
2822: adc ebp,0x0
2826: dec word [cs:0x2654]        ; rows left
282b: jnz 0x27b0
...
282f: rol ebp,0x10                ; leaving: rotate the lanes back and store
2833: rol edx,0x10
2837: xchg bp,dx
2839: mov [0x2e60],ebp
283e: mov [0x2e64],edx
...
285a: mov ebp,[0x2e60]            ; entering: load, swap, rotate
285f: mov edx,[0x2e64]
2864: xchg bp,dx
2866: rol ebp,0x10
286a: rol edx,0x10
```

The two polygon edges (left and right, each a 16.16 screen address: 16 bits of address, 16 bits of fraction) are **crossed** over two registers when they enter the loop:
`xchg bp,dx` and two `rol 16` give `ebp = (fraction of edge B : address of edge A)` and `edx = (fraction of edge A : address of edge B)`. Then
`add ebp,K1` adds A's address step and B's fraction step, its carry out of bit 31 is B's fraction carry; `adc edx,K2` takes that carry into B's address and adds A's fraction step; the
carry out of that is A's fraction carry, which the last `adc ebp,0` delivers into A's address. Three instructions advance both edges, the carry flag travelling from one fraction to the other edge's address, with two registers in all.
(That reading is mine, from the register layout the `xchg` / `rol` pair creates and the order of the carries; I did not work out how the signed steps are encoded in the immediates,
nor ran it. `docs/ENGINE.md` states the same idea, shorter.) The copy at 0x293F is the clipped loop's; its imm32s are patched by `mov [0x2842],esi / mov [0x2849],edi` at 0x2850.

## 11. Sorting polygons by partitioning at both ends of one buffer (block 2 0x369A)

```
369a: mov edx,0x40000            ; the bit under test (bit 18)
36a0: mov si,0x0                 ; read from the front
36a3: mov di,0x1450              ; "low" list grows upward from here
36a6: mov bx,[cs:0x1906]         ; "high" list grows downward from the end
36ab: jmp 0x36b2
36ad: mov [di],eax               ; bit clear: append to the low list
36b0: add di,bp                  ; bp = 4
36b2: mov eax,[si]               ; record = depth << 16 | polygon slot
36b5: test ax,ax
36b7: js 0x36d0                  ; a negative low word ends the list: no count needed
36b9: add si,bp
36bb: test edx,eax
36be: jz 0x36ad
36c0: mov [bx],eax               ; bit set: push on the high list
36c3: sub bx,bp
36c5: jmp 0x36b2
36d0: mov word [di],0xffff       ; terminate, then copy back: low list first,
36df: mov eax,[di] ...           ;   then the high list
36f0: mov eax,[bx] ... sub bx,bp ...
3700: mov word [si],0xffff
3704: add edx,edx                ; next bit up
3707: jnc 0x36a0                 ; until it shifts out of bit 31
```

One pass over the list is a **stable one-bit radix partition**: records with the bit clear go to the front of a scratch area, records with it set to the back, each list keeping
insertion order, and both are written back, low then high (the high list is read from the top, where its first record was written, downward, which is insertion order again). Two stacks growing toward each other need no counter and no second buffer, and the list terminator is any record whose low word is negative. The outer loop
`add edx,edx / jnc` walks the test bit from 18 up to 31: **14 passes** in part 2, 11 in parts 3, 5, 7, 12 in part 6 (bit 20), as in the table of `WRITEUP-effects.md` section 2. LSD
radix over the 14 high bits of a 32-bit key is a full depth sort in O(14 n). Part 2's copy keeps the scratch list at 0x1450 and the high list at `[cs:0x1906]`, so the face count is
bounded (the room for 1,000 to 2,000 faces in the effects write-up); I found no bounds check in the listing.

## 12. Projection with the rounding folded into the centre (block 2 0x1DFC)

```
1dfc: imul dword [0x191c]        ; X * f : signed 64 bit in edx:eax
1e01: idiv ebp                   ; / z   (sign extended pair)
1e04: sar eax,0x3
1e08: adc ax,0xa0                ; x = X*f/z / 8 + 160, rounded
1e0b: mov [gs:si+0x47e2],ax
...
1e14: imul dword [0x191c]
1e19: idiv ebp
1e1c: lea eax,[eax+eax*2]        ; y * 3
1e21: sar eax,0x5
1e25: adc ax,0x64                ; y = Y*f/z * 3/32 + 100, rounded
1e28: mov [gs:si+0x47e0],ax
```

`sar` leaves the last bit it shifted out in the carry flag and `adc` then adds the screen centre **and** that bit in one instruction: rounding to nearest for free. `lea eax,[eax+eax*2]`
multiplies by 3 with no `imul`, and the shift of 5 against x's 3 makes y scale 3/32 against x's 1/8 = 4/32: a 4:3 ratio inside the projection. Whether that is a deliberate correction for mode 13h's
non-square pixels (a pure correction would be 5:6) or taste, the code does not say; it is one more reason to show the demo at 4:3. The dividend is signed (`imul` gives a negative 64 bit
product for vertices in front of the camera and `idiv ebp` divides the pair): the verification rig first combined `edx:eax` as unsigned, so a projected x became millions of pixels wide
and the span fill looped 64 K times (`docs/RUNTIME.md`).

## 13. A recursive blur by table lookup: no clear, no average (block 2 0x1A98, 0x3780)

```
3780: mov bh,[si]                ; this pixel as it was last frame
3782: mov bl,[es:si]             ; what the polygons drew now (the band buffer)
3785: mov dl,[fs:bx]             ; out = shade[old << 8 | new]
3788: mov bh,[si+0x1]
378b: mov bl,[es:si+0x1]
378f: mov dh,[fs:bx]
3792: mov [si],dx                ; two pixels written back at once
3794: add si,0x2
3797: dec cx
3798: jnz 0x3780
```

and the table it uses, built once:

```
1aa4: mov cl,bl / imul cx,cx,0x60        ; 0x60 * band
1aa9: mov al,bh / imul ax,ax,0x1a0       ; 0x1a0 * old
1aaf: add ax,cx
1ab1: shr ax,1
1ab3: adc ax,0x0                         ; /2 rounded
1ab6: or ah,0x80                         ; the high bit every output carries
1ab9: mov [bx+0x80],ah                   ; ... and the table is stored three times over:
1abd: mov [bx-0x8000],ah                 ;   [bx+0x80], [bx-0x8000], [bx-0x7f80],
1ac1: mov [bx-0x7f80],ah                 ;   so the high bit is ignored by the next lookup
```

Each output is `(0x1a0*old + 0x60*new) / 512`: 416/512 = 81 % of last frame's screen and 19 % of the new band, written back into the same buffer, so this is a feedback filter and moving
shapes leave soft trails. Two byte loads, one table lookup and one store per pixel, two pixels per iteration. `WRITEUP-effects.md` section 3 has the rest of part 2 (the credit text
loaded into the band, the `clearshade` script step).

## 14. A fade that is a lookup on the palette, not on the picture (block 2 0x26AB)

```
26ab: cmp word [cs:0x193f],0x1             ; fade running?
26b7: cmp ax,0x3f00 ...                    ; 64 steps to the top, then stop
26ca: add word [cs:0x1941],0xff
26d1: mov dx,0x100 / mov bx,0x2510 / call 0x2650     ; rebuild the 64 entry ramp
26da: xor bx,bx / mov si,0x1f10 / mov cx,0x300
26e2: mov dx,0x3c8 / xor al,al / out dx,al / inc dx
26e9: mov bl,[cs:si]              ; base palette byte
26ec: mov al,[cs:bx+0x2510]       ; through the brightness ramp
26f1: inc si
26f2: out dx,al
26f3: dec cx
26f4: jnz 0x26e9                  ; 768 DAC bytes
```

All 256 DAC entries are rewritten from a fixed base palette through a 64-entry brightness ramp that reaches the identity after 64 ticks, from the interrupt (section 2 waits for the
start of the retrace before calling the hook, so the colours change between frames, not inside one). 768 `out`s per tick is cheap on a 486; retouching the screen would not be. Counting
entries mattered: these frames hold 70 to 107 colours, which a 192 entry part 1 palette cannot explain and a 256 entry palette explains at once, which retired an earlier guess of a per-line
palette (`docs/RUNTIME.md`; I did not re-run that check).

## 15. The fire is composed four pixels per instruction pair with an ordered dither in a register (block 4 0x1D6B)

```
1d6b: mov cl,0x50
1d6d: mov bx,[esi*2+0x0]         ; two fire pixels
1d75: mov al,bh
1d77: mov ah,bh
1d79: shl eax,0x10
1d7d: mov al,bl
1d7f: mov ah,bl                  ; eax = bl bl bh bh : each fire value doubled in width
1d81: lea eax,[edx+eax*2]        ; value * 2 + dither bytes (edx)
1d86: and eax,0xf0f0f0f0         ; keep the high nibble: 16 fire levels
1d8c: add eax,[fs:esi*4+0x0]     ; + the back buffer's four pixels (the low nibble layer)
1d96: mov [es:esi*4+0x0],eax
1da0: inc si
1da1: dec cl
1da3: jnz 0x1d6d
1da5: rol edx,0x8                ; next row: the dither bytes rotate
```

`lea` does shift, add and dither in one instruction (`2*v + d`; the fire is at most 0x70, so the doubling never carries into the next byte), `and 0xf0f0f0f0` drops the fractional
nibble of all four pixels at once, and one `add` of the background merges the second layer into the low nibble of the same byte. The 4 x 4 ordered dither lives in `edx`
(`0x01040007`: bytes 7, 0, 4, 1, `docs/PORT4.md`) and costs one `rol edx,8` per row. This is the "two layers in one byte, palette is the 16 x 16 mix table" trick of part 4 seen from the
instruction level.

## 16. A fire loop whose parameter is the loop itself (block 4 0x1BAB, 0x1C00)

```
1bab: mov bx,[cs:0x1578]          ; angle
1bb0: and bx,0xffe
1bb4: movsx ebx,word [cs:bx]      ; sine
1bb9: add ebx,[cs:0x157a]         ; + drift
1bbf: sar ebx,0x8
1bc3: cmp bx,[cs:0x1b0b]          ; same shift as last time? [cs:0x1b0b] is the imm16 below
1bc8: jz 0x1c33                   ;   then skip the whole frame of fire
1bca: mov [cs:0x1b0b],bx          ; patch the shift into both adds
1bcf: mov [cs:0x1b20],bx
...
1bf2: xchg bx,bx  x7              ; 2 byte NOPs that align the loop to 0x1c00
1c00: mov bx,[es:ecx*4+0x2]       ; this pixel's offset in the warp field
1c09: add bx,0x0                  ; + shift: the immediate IS the shift
1c0d: mov bl,[fs:bx]              ; texture value there
1c10: mov bh,[di]                 ; old value of the pixel
1c12: mov al,[gs:bx]              ; blend[old][texture]
1c15: mov bx,[es:ecx*4+0x0]       ; the second pixel of the pair
1c1e: add bx,0x0
1c22: mov bl,[fs:bx]
1c25: mov bh,[di+0x1]
1c28: mov ah,[gs:bx]
1c2b: mov [di],ax
1c2d: add di,0x2
1c30: dec cx
1c31: jns 0x1c00
```

The whole animation of the fire is one number, the shift added to every warp offset (`WRITEUP-effects.md` section 5). The routine passes it to its inner loop by **rewriting the two
`add bx,imm16` instructions**, and the comparison `cmp bx,[cs:0x1b0b]` uses the first immediate as the memory cell that holds "the shift of the last frame": the code is its own state,
and when nothing changed the pass is skipped. The seven `xchg bx,bx` are two-byte NOPs that start the loop on a 16-byte boundary (0x1C00); that they were put there for alignment is
my reading, the bytes only show the padding. Because the fire buffer is read and written, it is a feedback system and its picture depends on the number of frames drawn.

## 17. Building a sine period with three tiny loops (block 4 0x1FA8)

```
1fb1: mov di,0x7fe
1fb4: mov cx,0x200
1fb7: lodsw
1fb8: stosw
1fb9: sub di,0x4                 ; stosw advanced 2; minus 4 = walk downward by one word
1fbc: dec cx
1fbd: jnz 0x1fb7                 ; mirror the first quarter backwards into the second
1fc2: mov di,0x800
1fc5: mov cx,0x400
1fc8: lodsw
1fc9: neg ax
1fcb: stosw
1fcc: dec cx
1fcd: jnz 0x1fc8                 ; negate the first half into the second
1fd2: mov di,0x1000
1fd5: mov cx,0x200
1fd8: rep movsw                  ; repeat the start, room beyond one period
```

The file stores only a quarter of a sine (512 words). The first loop copies it **backwards**: `stosw` moves `di` up by 2 and the `sub di,4` makes the net step -2, so one
`lodsw/stosw` pair walks forward in the source and backward in the destination. The second negates the whole first half into the next, and a `rep movsw` repeats the start so
indexes slightly past the period are valid. Same routine as the matrix code needs (the 2048-entry period of `WRITEUP-effects.md` section 2).

## 18. `99` is `cwd`, not `cdq` (block 2 0x2B48, block 5 0x1FB4)

```
; block 5 0x1fb4: bytes  A1 46 23  2B 06 3E 23  99  F7 FB
1fb4: mov ax,[0x2346]
1fb7: sub ax,[0x233e]            ; difference of two 16 bit lanes
1fbb: cwd                        ; 99, no 66 prefix: dx = sign of AX
1fbc: idiv bx                    ; / rows: the lane's slope per row
1fbe: mov [0x1bd6],ax            ; stored into the loop's immediate (section 9)
```

The texture-gradient set-up divides 16-bit lane differences by the row count, and the instruction between the subtraction and the division is the single byte `99`. In 16-bit code that is
`cwd`; with a `66` prefix it is `cdq`, and a few lines later block 2 does use `66 99` for the 32-bit gradient (`shl eax,16 / cdq / idiv ebp`, block 2 0x2B7F..0x2B88). `ndisasm -b16` shows
the single byte as `cwd` but a disassembler or a reader who takes it for `cdq` believes the dividend's upper half is `eax`'s, which depends on whatever was left there by the previous
division, and a negative difference divides as a large positive number. The first port of part 5 made that mistake and the polygon-by-polygon check found it as a row slope that was
different in one lane of one triangle (`docs/PORT5.md`, `docs/PORTING.md`). Check the bytes whenever the high half of a register is involved.

## 19. A shift of 10 where a shift of 8 was meant (block 3 0x2158, block 5 0x1C98)

```
; block 3 0x2158                      ; block 5 0x1c98
shld ebx,ecx,0x8                      shld ebx,ecx,0xa      ; 66 0F A4 CB 0A
and  bx,0x7f7f                        and  bx,0x7f7f
mov  al,[fs:bx]                       mov  al,[fs:bx]
```

The phong fill packs two 16-bit coordinates in `ecx` and looks up a 128 x 128 map with the top seven bits of each. With a shift of 8 the high byte of `ecx` lands in `bl` and the previous `bl` in
`bh`: a clean (y,x). Parts 3 and 7 shift by 8, part 2 by 9 (section 8), parts 5 and 6 by 10. With 10 only the low six bits of the `bl` byte survive, in bits 10..15, so the index mixes the two
coordinates (`docs/PORT5.md` gives the closed form `bx = ((ecx >> 8 & 0x3f) << 10 | ecx >> 22) & 0x7f7f`). Nobody would write that on purpose, but it is what parts 5 and 6 execute, and a port
that "fixes" it to 8 is wrong in one pixel out of a few thousand: it was found in frame 883 of 2,253 (`docs/PORT5.md`).

## 20. Two small facts the port has to keep

**The rounding the matrix routine lost** (block 2 0x1F05, block 3 0x1F71):

```
; block 2 0x1f05                      ; block 3 0x1f71
sar eax,0xf                           sar eax,0xf
adc eax,0x0       ; + last bit out    mov [0x1dcc],eax    ; nothing
```

The rotation matrix is built with 15-bit fixed point products and part 2 adds `adc eax,0` after the `sar eax,15` to round to nearest; the copy in block 3 (and the other copies,
`docs/ENGINE.md`) has none of those `adc`s. In part 2's own copy one entry also lacks it and the port has to forget it as well.

**A pixel loop that counts in `al`** (block 7 0x2A51):

```
2a51: shld ebx,ecx,0x8
2a56: mov bh,ch
2a58: add ecx,ebp                ; both texture coordinates in one add
2a5b: mov ah,[fs:bx]             ; the pixel is read into AH ...
2a5e: mov [es:si],ah
2a61: inc si
2a62: dec al                     ; ... so the pixel count can only live in AL
2a64: jne 0x2a51
```

Eight instructions per textured pixel. The count is loaded as a word but tested as a byte, because `ah` is busy being the pixel register: a span of 256 pixels or more draws its length modulo
256, and exactly 256 draws 256 (`dec al` from 0 wraps). On a 320-pixel screen such spans are rare, so the original gets away with it and the port keeps the quirk.

## 21. A lookup picture that moves: five blobs added four pixels at a time (block 7 0x3189, 0x3146)

```
3197: mov cx,0x4000
319a: mov eax,0x4040404
31a4: rep movsd                  ; copy the 64 KB background (dwords)
31a7: mov di,[cs:0x19b8]         ; tick counter
31ac: and di,0xffe
31b0: mov di,[cs:di+0x410]       ; sine of it
31b5: sar di,0x9
31b8: add di,0x4040              ; position in the 256 x 256 picture
31bc: call 0x3146
...
3150: mov ch,0x80                ; 128 rows
3152: mov cl,0x20                ; 32 dwords
3154: mov eax,[si]
3157: add [es:di],eax            ; add the blob four pixels at once
315b: add si,0x4
315e: add di,0x4
3161: dec cl
3163: jnz 0x3154
3165: add di,0x80                ; 32 dwords = 128 bytes, + 128 = a row of 256
3169: dec ch
316b: jnz 0x3152
```

Part 7 colours its star with the same phong fill as part 3, but the 256 x 256 lookup picture is rebuilt every frame: a copy of the background and five 128 x 128 blob sprites added with one
plain 32-bit `add` per four pixels, each blob at a position taken from the sine table at a different multiple of the tick counter (the multiples are in `WRITEUP-effects.md` section 8). The
bytes carry into each other in principle; the blobs are dark enough that they never overflow (the effects write-up says so, I did not test every position). Highlights then swim over the
metal while nothing on the object changes. `docs/PORT7.md` has the remaining details.

## 22. A lighting table that breathes: the ramp built by negating 8x and adding (block 5 0x3199)

```
3199: lea bx,[edx*8+0x0]         ; 8 * dx
31a1: neg bx                     ; -8 * dx
31a3: mov cl,0x10
31a5: mov si,0x374b
31a8: mov [cs:si],bh             ; ramp[k] = high byte of ((k - 8) * dx)
31ab: inc si
31ac: add bx,dx
31ae: dec cl
31b0: jnz 0x31a8
31b2: mov bp,0x375b              ; the 256 word table
...
31ba: mov ah,[cs:di]             ; table[16*i + j] = ramp[i] << 8 | ramp[j]
31c2: mov al,[cs:si]
31c5: mov [cs:bp+0x0],ax
```

The phong fill adds a word of this 256 entry table to the pixel's row (`mov si,[cs:eax*2+...]` in section 8). In part 3 it is constant; in parts 5 and 6 the timer interrupt rebuilds it every tick from one
number `dx`: a 16-entry ramp centred on zero, made with no multiply (start at `-8*dx` and `add bx,dx` sixteen times, taking `bh`), then every pair of entries is one word. So the lit sphere the surface
is shaded from grows and shrinks 70 times a second for 16 bytes and 256 word stores per tick (`docs/PORT5.md` for where `dx` comes from).

---

**Limits of this write-up.** Part 4's landscape routine (0x1FFC, voxel-style occlusion with `ycol`) and the part 6 light repaint (block 6 0x2F05) are described in `docs/PORT4.md` and
`docs/PORT6.md` but I did not extract listings for them here, so nothing about their instruction-level tricks is claimed. The text of the `web/writeup.html` page is an earlier numbering of
some of these snippets; the listings above were re-extracted from the blocks and agree with it, but the numbering follows `WRITEUP-effects.md`.
