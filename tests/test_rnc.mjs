/*
 * Regression tests for web/js/rnc.js -- the decompressor the port uses to read
 * the demo's own data out of DOPE.EXE.
 *
 * The ground truth here is inside the executable: every RNC stream carries its
 * unpacked size and CRC16, so a decompressor that gets a byte wrong cannot
 * pass.  The block table matches tools/unpack.py and tests/test_tools.py.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findBlocks, header, unpack, crc16, RNCError } from '../web/js/rnc.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXE = new Uint8Array(readFileSync(join(ROOT, 'DOPE.EXE')));

const EXPECTED = [
  [0x000020, 25570],
  [0x002c6a, 213658],
  [0x00f66c, 449862],
  [0x01dc1a, 374042],
  [0x02ad70, 485072],
  [0x056f42, 386842],
  [0x068d64, 446560],
  [0x07bc02, 457550],
];

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

const blocks = findBlocks(EXE);

eq('eight blocks in DOPE.EXE', blocks.length, EXPECTED.length);
ok(
  'block offsets and sizes',
  blocks.every((b, i) => b.offset === EXPECTED[i][0] && b.data.length === EXPECTED[i][1]),
  blocks.map((b) => `0x${b.offset.toString(16)}:${b.data.length}`).join(' ')
);

// Header CRCs are the independent check: unpack() already verifies both, but
// recomputing them here pins the CRC itself (poly 0xA001, init 0).
for (let i = 0; i < blocks.length; i++) {
  const h = header(EXE, blocks[i].offset);
  eq(`block ${i} unpacked CRC16`, crc16(blocks[i].data), h.unpackedCrc);
  eq(`block ${i} packed size`, h.packedSize, h.total - 0x12);
}

{
  // The part 1 block is the one the transcoded port reads: pin its content so a
  // changed block table cannot slip through.
  const part1 = blocks[1].data;
  eq('part 1 is 213,658 bytes', part1.length, 213658);
  ok(
    'part 1 starts with the retrace wait at 0x110',
    Buffer.from(part1.subarray(0x110, 0x11e)).toString('hex') === 'bada03eca80875fbeca80874fbc3'
  );
  // The unpack (0xc5c) and the four map-mask passes of the entry (0xd92:
  // es:di = 0x50, ds:si = 0x70a, sequencer index 2 = 0x11 ...) are what the
  // transcode is built from, so pin them.  (The anti-rip banner is in blocks
  // 2, 3 and 5..7; part 1 is one of the overlays without it.)
  eq(
    'part 1 unpacks from the picture strip',
    Buffer.from(part1.subarray(0xc5c, 0xc64)).toString('hex'),
    '1eb9c30051b94000'
  );
  eq(
    'part 1 starts the unpack at plane offset 0x50 of strip 0x70a',
    Buffer.from(part1.subarray(0xd92, 0xda2)).toString('hex'),
    'bf5000be0a07bac403b002eeb01142ee'
  );
}

ok(
  'a bad stream is rejected rather than silently short',
  (() => {
    const cut = EXE.subarray(0x20, 0x20 + 0x40);
    try {
      unpack(cut);
      return false;
    } catch (err) {
      return err instanceof RNCError;
    }
  })()
);

console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
