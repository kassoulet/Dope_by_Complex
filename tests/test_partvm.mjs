/*
 * Parts 2..7 as the page runs them: DOPE.EXE's own blocks in the x86 interpreter.
 *
 * For every part: build it from its block (loader relocation, entry, init),
 * feed it timer interrupts the way the player's worker does while seeking, and
 * check that its own code installs the ISR, draws, and that the picture is the
 * same one every run (the digests pin the interpreter and the relocation data:
 * a wrong relocated word or a wrong flag shows up as a different picture).
 *
 *   node tests/test_partvm.mjs
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findBlocks } from '../web/js/rnc.js';
import { PartRunner } from '../web/js/partvm.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const blocks = findBlocks(new Uint8Array(readFileSync(join(root, 'DOPE.EXE')))).map((b) => b.data);
const table = JSON.parse(readFileSync(join(root, 'web/data/parts.json'), 'utf8'));

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('ok   ' + name); } else { failed++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + detail)); }
};
const fnv = (a) => { let h = 0x811c9dc5; for (const b of a) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
const screen = (name) => {
  const d = inflateRawSync(readFileSync(join(root, 'web/data', name)));
  return { pixels: d.subarray(0, 64000), pal: d.subarray(64000, 64768) };
};

// picture after 600 interrupts at 5000 instructions each, from the part's own start
const expect = {
  2: { digest: null, ink: 1000 }, 3: { digest: null, ink: 20000 }, 4: { digest: null, ink: 20000 },
  5: { digest: null, ink: 40000 }, 6: { digest: null, ink: 40000 }, 7: { digest: null, ink: 1000 },
};
const pinned = JSON.parse(readFileSync(join(root, 'tests/part_digests.json'), 'utf8'));
const update = process.argv.includes('--update');

for (const p of table.parts) {
  const r = new PartRunner(blocks[p.block], p, p.screen ? screen(p.screen) : null);
  for (let i = 0; i < 600 && !r.exited; i++) { r.deliverTick(); r.run(5000); }
  r.run(300000);
  const { pixels, pal } = r.snapshot();
  let ink = 0; for (const b of pixels) if (b) ink++;
  const colours = new Set(pixels).size;
  const vec = r.m.cpu.read32(0x20);
  ok(`block ${p.block}: its own ISR is on INT 8`, (vec >>> 16) === 0xf8b, vec.toString(16));
  ok(`block ${p.block}: draws a picture (${ink} lit pixels, ${colours} colours)`, ink >= expect[p.block].ink && colours > 8, `ink ${ink}`);
  ok(`block ${p.block}: the DAC is loaded`, pal.some((v) => v), 'palette all zero');
  const d = fnv(pixels) + ':' + fnv(pal);
  if (update) pinned[p.block] = d;
  else ok(`block ${p.block}: the picture is the pinned one (${pinned[p.block]})`, pinned[p.block] === d, d);
}
if (update) {
  (await import('node:fs')).writeFileSync(join(root, 'tests/part_digests.json'), JSON.stringify(pinned, null, 1) + '\n');
  console.log('pinned', pinned);
}
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
