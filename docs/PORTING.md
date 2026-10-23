# Porting a demo part: the method

The parts of DOPE are 16 bit real mode x86 written by hand (block 4 is 485 KB,
of which about 3 KB is code).  Porting one means rewriting those few
kilobytes as JavaScript so that **the same data produce the same pictures**.
This document is the method; `PORT4.md` and the others are what it found.

## The rule

A port is allowed to be clearer than the original, but never to be different:
every routine is checked against the machine code it came from, on real
data, byte for byte.  Two checks, two scales.

### 1. Routine against routine (`tests/test_port<N>.mjs`)

`tools/oracle.mjs` can run **one routine of the original** in the emulator,
on a copy of the machine, at any moment of the part:

```js
const r = runPart(4, 1500);              // part 4 after 1500 timer ticks
const a = clone(r);                      // independent copy: memory, CPU, card
callRoutine(a, 0x1bab, {});              // run the routine at block offset 0x1bab
// ... run the port function on the same data (a copy of the same memory) ...
// compare what the routine may have written: a buffer, the DAC, a variable
```

The test then runs the **port function** on the data of another copy of the same
state and compares every byte the routine can write.  The states are spread over
the whole part (3, 60, 400, 1500, 2300, 3300, 4800, 6300 ticks for part 4), so
every phase of the script is exercised, not only the first seconds.  A routine
is "ported" when it passes at all of them.

This is the part that makes the work fast: when a routine is wrong, the
failing test says which one and where the first differing byte is.  Part 4's
palette mixer and fire step were right at the first run; the terrain needed
none, and the one mistake in the whole routine set was a palette that lives in
the *label's* segment, not the part's (found by the next check).

### 2. Whole part against whole part, in lock step (`tests/test_port<N>_run.mjs`)

Routines can each be right and still be wired wrong (an initial value, the order
of two updates, a script variable).  So the original also runs **from its first
instruction** while the port runs beside it.  The test takes control of the one
source of non-determinism, the timer interrupt: it is held back and delivered
by the test, k ticks at a time (1, 2, 3, 2, ...), exactly when the main loop
returns from the frame routine.  A frame is therefore never interrupted, and the
port, given the same schedule (draw, tick k times, run the script), has to
reproduce the original at every one of those moments: every variable, the DAC,
the intermediate buffers and the picture on the card.  Part 4: 3,700 frames,
all identical.

(The real demo is not deterministic in this sense: its interrupt fires in the
middle of frames, so what a given frame shows depends on how fast the machine
was.  That is why the lock step has to own the interrupt; and why the port may
choose its own frame rate.)

## The tools

| tool | what it is for |
|------|----------------|
| `tools/calltrace.mjs <block>` | which routines a part calls, how often, how many instructions each costs, during which ticks. The first thing to run: it turns 485 KB into a list of a dozen routines. |
| `tools/opmix.mjs`, `tools/bench.mjs` | what instructions a part executes and how fast they run |
| `tools/oracle.mjs` | `runPart`, `clone`, `callRoutine`: the original as a function |
| `ndisasm -b16 -o<addr> -e<addr> build/blockNN_*.bin` | the disassembly (addresses are block offsets; subtract 0x100 for the segment offset the code uses) |
| `tools/diffcheck*.py` | the emulator itself against Unicorn: if the oracle is wrong everything is |

## Reading order that worked

1. `calltrace` the part, sort by inclusive instructions. The routines that matter
   are the few at the top; the rest is setup.
2. Read the **leaf** routines first (a palette ramp, a table builder): they have
   no dependencies and each can be tested alone on the first day.
3. Then the inner loops. They are small, and the self-modifying ones (where the
   code patches its own immediates, see the write-up) are the most
   informative: the patched value *is* a parameter.
4. Last, the main loop. It is the script: a chain of "draw until counter X,
   then change these variables".
5. Keep the variables **by address** in comments (`0x1971`) until the port is
   verified; rename afterwards.

## Memory, relocation and what a port may read

The port reads from the same image the emulator runs: block 4 at segment
`0xf8b` with the loader's 22 relocated words applied (`web/js/partvm.js`
`loadImage`).  Segment constants in the code (`push 0x66cd`) are *block*
values; the loader adds `0xf7b`, which the port does with `seg()`.  Everything
that is data in the original (tables, the warp field, the pictures) is read from
the image; everything the original *builds* at run time (the sine table, the
blend table) the port builds with a function that is tested against the
original's result.
