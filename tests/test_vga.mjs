/*
 * Regression tests for tools/vm/vga.js -- the parts of the card the demo pokes.
 * This is the verification rig, not the port: web/js/part1.js writes pixels
 * without any of it.
 *
 * These pin the measured behaviour rather than a wish: the BIOS default DAC,
 * the six bit to eight bit expansion DOSBox uses, the sequencer map mask, the
 * two write layouts (chain 4 and planar), the CRTC start/offset units, pixel
 * panning and the scan-out loop.
 */

import { VGA, SCREEN_W, SCREEN_H } from '../tools/vm/vga.js';

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('ok   ' + name);
  } else {
    failed++;
    console.log('FAIL ' + name + (detail ? '  ' + detail : ''));
  }
}

function eq(name, got, want) {
  ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const mem = new Uint8Array(1 << 20);

// ---------------------------------------------------------------- mode set

{
  const vga = new VGA(mem);
  vga.setMode(0x13);
  eq('mode 13h keeps all four planes unmasked', vga.seq[2], 0x0f);
  eq('mode 13h enables chain 4', vga.seq[4] & 0x08, 0x08);
  eq('mode 13h sets a 40 word scanline offset', vga.crtc[0x13], 0x28);
  eq('mode 13h clears the picture buffer', vga.pixels.reduce((a, b) => a + b, 0), 0);
}

// ------------------------------------------------------------- BIOS palette

{
  const vga = new VGA(mem);
  vga.setMode(0x13);
  const at = (i) => [vga.pal[i * 3], vga.pal[i * 3 + 1], vga.pal[i * 3 + 2]];
  ok('default DAC entry 0 is black', at(0).every((v) => v === 0));
  eq('default DAC entry 1 keeps the EGA blue', at(1)[2], 0x2a);
  ok('default DAC entry 15 is white', at(15).every((v) => v === 0x3f));
  ok('default DAC entry 16 starts the grey ramp', at(16).every((v) => v === 0));
  // index 32 + 37: level 1 red, level 0 green, level 1 blue
  ok('default DAC has a 6x6x6 cube', at(32 + 37).join(',') === '16,0,16');
  ok('default DAC top entry is white', at(255).every((v) => v === 0x3f));
}

// ------------------------------------------------- six bit to eight bit DAC

{
  const vga = new VGA(mem);
  vga.pal[0] = 1; vga.pal[1] = 2; vga.pal[2] = 3;
  vga.pal[3] = 12; vga.pal[4] = 63; vga.pal[5] = 0;
  const rgb = vga.paletteRGB();
  eq('6 bit 1 expands to 4', rgb[0], 4);
  eq('6 bit 2 expands to 8', rgb[1], 8);
  eq('6 bit 3 expands to 12', rgb[2], 12);
  eq('6 bit 12 expands to 48 (not 49)', rgb[3], 48);
  eq('6 bit 63 expands to 255', rgb[4], 255);
}

// ------------------------------------------------------------ write layouts

{
  const vga = new VGA(mem);
  vga.setMode(0x13);
  vga.writeVideo(4, 0x11223344, 4);
  eq('chain 4 dword fills four pixels', [0, 1, 2, 3].map((i) => vga.pixels[4 + i]).join(','), '68,51,34,17');
}

{
  const vga = new VGA(mem);
  vga.setMode(0x13);
  vga.seq[2] = 0x01;                    // only plane 0
  vga.writeVideo(4, 0x11223344, 4);
  eq('map mask keeps plane 0 only', vga.pixels[4], 0x44);
  eq('map mask drops plane 1', vga.pixels[5], 0);
  eq('map mask drops plane 2', vga.pixels[6], 0);
  eq('map mask drops plane 3', vga.pixels[7], 0);
}

{
  const vga = new VGA(mem);
  vga.setMode(0x13);
  vga.seq[4] = 0x06;                    // part 1 turns chain 4 off
  vga.seq[2] = 0x02;                    // one plane per pass
  vga.writeVideo(8, 0x11223344, 4);
  // Planar flattening: pixel (offset << 2) | plane, so the four bytes of the
  // store land in plane 1 at offsets 8..11.
  eq('planar store lands four bytes in the plane',
    [8, 9, 10, 11].map((o) => vga.pixels[(o << 2) + 1]).join(','), '68,51,34,17');
  eq('planar store leaves the other planes alone', vga.pixels[(8 << 2) + 0], 0);
  vga.pixels[20] = 0x5a;
  vga.seq[2] = 0x00;
  vga.writeVideo(20, 0xaa, 1);
  eq('empty map mask writes nothing', vga.pixels[20], 0x5a);
}

{
  const vga = new VGA(mem);
  vga.setMode(0x13);
  vga.seq[4] = 0x0e;
  vga.chain4Override = true;
  vga.writeVideo(4, 0x11223344, 4);
  eq('chain4 override rotates like chain 4', vga.pixels[7], 0x11);
}

// ------------------------------------------------------------ display timing

// The start and offset registers count plane bytes and the scan-out takes four
// pixels per plane byte, so both are multiplied by four to reach a pixel.
{
  const vga = new VGA(mem);
  vga.setMode(0x13);
  vga.crtc[0x0c] = 0x01;
  vga.crtc[0x0d] = 0x02;
  eq('start address counts plane bytes', vga.startPixels(), 0x102 * 4);
  vga.layout = 'bytes';
  eq('byte layout drops the four pixel step', vga.startPixels(), 0x102);
  vga.layout = 'auto';
  vga.crtc[0x13] = 0xa8;
  eq('scanline offset is in words', vga.offsetBytes(), 336);
  eq('scan-out line is four pixels per plane byte', vga.linePixels(), 336 * 4);
  const mode13 = new VGA(mem);
  mode13.setMode(0x13);
  eq('mode 13h 40 word offset is a 320 pixel line', mode13.linePixels(), 320);
}

// Part 1 steps the panning register in twos (counter >> 2 & 3, doubled);
// measured, the shift is value / 2 - 1 pixels, which with the 4 pixel start
// step gives the 1 pixel per 4 counts scroll of the reference frames.
{
  const vga = new VGA(mem);
  vga.setMode(0x13);
  eq('pan register 0 shifts left by one', vga.panPixels(), -1);
  vga.attr[0x13] = 2;
  eq('pan register 2 does not shift', vga.panPixels(), 0);
  vga.attr[0x13] = 4;
  eq('pan register 4 shifts by one', vga.panPixels(), 1);
  vga.attr[0x13] = 6;
  eq('pan register 6 shifts by two', vga.panPixels(), 2);
  vga.attr[0x13] = 0;
  vga.layout = 'nopan';
  eq('nopan keeps the register out of it', vga.panPixels(), 0);
}

// The measured part 1 window: counter 774 leaves start 48, offset 0xa8 (336
// plane bytes) and pan register 2, i.e. the display starts at pixel 192 and
// each line is 1344 pixels on, exactly the pitch of the unpacked 336 byte rows.
{
  const vga = new VGA(mem);
  vga.setMode(0x13);
  vga.crtc[0x0c] = 0x00;
  vga.crtc[0x0d] = 48;
  vga.crtc[0x13] = 0xa8;
  vga.attr[0x13] = 2;
  eq('counter 774 starts at pixel 192', vga.startPixels(), 192);
  eq('counter 774 line pitch is 1344 pixels', vga.linePixels(), 1344);
  eq('counter 774 pan is zero', vga.panPixels(), 0);
}

// ------------------------------------------------------------------ scan-out

{
  const vga = new VGA(mem);
  vga.setMode(0x13);                // 40 word offset: a 320 pixel line
  vga.crtc[0x0c] = 0x00;
  vga.crtc[0x0d] = 0x00;
  vga.attr[0x13] = 2;
  for (let i = 0; i < vga.pixels.length; i++) vga.pixels[i] = (i * 7) & 0xff;
  const out = new Uint8Array(SCREEN_W * SCREEN_H);
  vga.render(out);
  let bad = 0;
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      if (out[y * SCREEN_W + x] !== vga.pixels[y * 320 + x]) bad++;
    }
  }
  eq('render copies the visible window', bad, 0);
}

// Addresses past the end of the 256 KB picture read black: part 1's 195 row
// picture leaves the last rows of the 200 line scan past the end of memory, and
// the reference frames show black there instead of the picture wrapping round.
{
  const vga = new VGA(mem);
  vga.setMode(0x13);
  vga.crtc[0x0c] = 0x00;
  vga.crtc[0x0d] = 0xf0;
  vga.crtc[0x13] = 0xa8;             // 1344 pixel lines, like part 1
  vga.attr[0x13] = 2;
  vga.pixels.fill(9);
  const out = new Uint8Array(SCREEN_W * SCREEN_H);
  vga.render(out);
  eq('a line inside the picture is shown', out[0], 9);
  const last = out.slice((SCREEN_H - 1) * SCREEN_W, SCREEN_H * SCREEN_W);
  eq('a line past the end of memory is black', last.reduce((a, b) => a + b, 0), 0);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
