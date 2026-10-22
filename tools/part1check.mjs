/*
 * dope/part1check.mjs -- render part 1 from DOPE.EXE alone, for comparison.
 *
 *   node tools/part1check.mjs                        # every counter in build/ref
 *   node tools/part1check.mjs build/ref --out build/out
 *   node tools/part1check.mjs --frame 774 --png f.png
 *
 * No snapshot and no emulator: the picture strip and the palette tables are
 * decompressed out of the executable with web/js/rnc.js and the frames are
 * written by web/js/part1.js.  Compare the result against the reference
 * screenshots with tools/framediff.py.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Part1, W, H } from '../web/js/part1.js';
import { encodePNG, indexedToRGB } from './png.mjs';

function framesIn(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const meta = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (typeof meta.counter === 'number') out.push(meta.counter);
  }
  return out;
}

function main(argv) {
  const opts = { out: 'build/out', counters: [] };
  let refdir = 'build/ref';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--frame') opts.counters.push(parseInt(argv[++i], 10));
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--png') opts.png = argv[++i];
    else if (a === '--exe') opts.exe = argv[++i];
    else if (!a.startsWith('--')) refdir = a;
  }

  const part = Part1.fromExecutable(new Uint8Array(readFileSync(opts.exe || 'DOPE.EXE')));
  const counters = opts.counters.length ? opts.counters : framesIn(refdir);
  if (!counters.length) {
    console.error('no counters: pass --frame N or point at a directory of reference frames');
    return 2;
  }

  const buf = new Uint8Array(W * H);
  const pal = new Uint8Array(768);
  const render = (counter) => {
    part.frame(counter, buf);
    pal.fill(0);
    pal.set(part.palette(counter), 0);
    return encodePNG(W, H, indexedToRGB(buf, pal, W, H));
  };

  if (opts.png && counters.length === 1) {
    mkdirSync(dirname(opts.png), { recursive: true });
    writeFileSync(opts.png, render(counters[0]));
    console.log('wrote ' + opts.png + ' for counter ' + counters[0] +
      '  start ' + part.lineStart(counters[0]));
    return 0;
  }

  mkdirSync(opts.out, { recursive: true });
  for (const counter of counters) {
    const name = join(opts.out, 'part1_' + String(counter).padStart(4, '0') + '.png');
    writeFileSync(name, render(counter));
    console.log('wrote ' + name +
      '  start ' + part.lineStart(counter) +
      '  pan ' + part.panPixels(counter));
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
