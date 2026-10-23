/*
 * The "script" of a 3D part is straight line code: store some numbers into the
 * part's variables (`mov word/dword [cs:addr],imm`), load a frame count into cx,
 * `call` the routine that runs that many ticks.  This reads such a stretch of a
 * block and writes it as data, so a port can carry the script as a table
 * instead of re-typing a hundred immediates.
 *
 *   node tools/scriptdump.mjs <block> <from> <to> <runner>   (offsets in the block; runner = the call target)
 *
 * Prints JSON: [{ set: [[addr, size, value], ...], ticks: cx }, ...]; anything
 * it does not understand is reported on stderr with its address.
 */
import { readFileSync } from 'node:fs';
import { findBlocks } from '../web/js/rnc.js';

const [n, from, to, runner] = process.argv.slice(2).map((x) => parseInt(x, x.startsWith('0x') ? 16 : 10));
const blocks = findBlocks(new Uint8Array(readFileSync('DOPE.EXE'))).map((b) => b.data);
const b = blocks[n];
const steps = [];
let cur = { set: [], ticks: null };
let cx = null;
for (let i = from; i < to;) {
  const o = i;
  if (b[i] === 0x66 && b[i + 1] === 0x2e && b[i + 2] === 0xc7 && b[i + 3] === 0x06) { // mov dword [cs:addr],imm32
    const addr = b[i + 4] | (b[i + 5] << 8);
    const v = (b[i + 6] | (b[i + 7] << 8) | (b[i + 8] << 16) | (b[i + 9] << 24)) | 0;
    cur.set.push([addr, 4, v]); i += 10;
  } else if (b[i] === 0x2e && b[i + 1] === 0xc7 && b[i + 2] === 0x06) { // mov word [cs:addr],imm16
    const addr = b[i + 3] | (b[i + 4] << 8);
    cur.set.push([addr, 2, b[i + 5] | (b[i + 6] << 8)]); i += 7;
  } else if (b[i] === 0xb9) { cx = b[i + 1] | (b[i + 2] << 8); i += 3; }
  else if (b[i] === 0xe8) {
    const rel = ((b[i + 1] | (b[i + 2] << 8)) << 16) >> 16;
    const target = (i + 3 + rel) & 0xffff;
    if (target === runner) { cur.ticks = cx; steps.push(cur); cur = { set: [], ticks: null }; }
    else console.error(`call ${target.toString(16)} at ${o.toString(16)} ignored`);
    i += 3;
  } else { console.error(`unknown byte ${b[i].toString(16)} at ${o.toString(16)}`); i++; }
}
if (cur.set.length) steps.push(cur);
console.log(JSON.stringify(steps));
