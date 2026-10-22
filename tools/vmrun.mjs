/*
 * dope/vmrun.mjs -- run the snapshot in the JavaScript VM and write frames.
 *
 *   node tools/vmrun.mjs build/snap/part1 --list-frames
 *   node tools/vmrun.mjs build/snap/part1 --frame 120 --png build/out/0120.png
 *   node tools/vmrun.mjs build/snap/part1 --each 50 --out build/out
 *   node tools/vmrun.mjs build/snap/part1 --frame 774 --png f.png --bytes
 *
 * `--bytes` and `--nopan` switch off the measured scan-out conventions (four
 * pixels per plane byte, and the panning shift); they exist to show that the
 * reference frames really do depend on them.
 *
 * The VM renders one frame every time the part's timer interrupt completes, so
 * `--frame N` means "the picture for counter N", the same key the reference
 * screenshots are tagged with.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Machine } from './vm/machine.js';
import { SCREEN_W, SCREEN_H } from './vm/vga.js';
import { encodePNG, indexedToRGB } from './png.mjs';

function load(base) {
  const meta = JSON.parse(readFileSync(base + '.json', 'utf8'));
  const image = new Uint8Array(readFileSync(base + '.mem'));
  return { meta, image };
}

function main(argv) {
  const base = argv[0] || 'build/snap/part1';
  const opts = { each: 0, out: 'build/out', frames: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--frame') opts.frames.push(parseInt(argv[++i], 10));
    else if (a === '--each') opts.each = parseInt(argv[++i], 10);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--png') opts.png = argv[++i];
    else if (a === '--until') opts.until = parseInt(argv[++i], 10);
    else if (a === '--max-inst') opts.maxInst = parseInt(argv[++i], 10);
    else if (a === '--list-frames') opts.list = true;
    else if (a === '--trace') opts.trace = true;
    else if (a === '--bytes') opts.layout = 'bytes';
    else if (a === '--nopan') opts.layout = 'nopan';
  }

  const { meta, image } = load(base);
  const m = new Machine();
  if (opts.layout) m.vga.layout = opts.layout;
  m.boot(image, meta);
  const target = opts.until || Math.max(1, ...opts.frames);
  const buf = new Uint8Array(SCREEN_W * SCREEN_H);
  const ok = m.runTo(target, opts.maxInst || 60000000);
  if (!ok) console.error('instruction budget exhausted before counter ' + target);

  if (opts.list || opts.trace) {
    console.log('booted at ' + m.partSeg.toString(16) + ':' + 0xbd5.toString(16) +
      '  instructions ' + m.cpu.insts + '  frames ' + m.frames.length +
      '  stopped ' + m.stopped + '  exited ' + m.exited +
      '  pitDiv ' + m.pitDiv);
    if (m.log.length) console.log('unhandled: ' + m.log.slice(0, 8).join(', '));
    const cs = m.frames.map((f) => f.counter);
    if (cs.length) {
      console.log('counters: first ' + cs[0] + ' last ' + cs[cs.length - 1] +
        ' odd ' + cs.filter((c) => c % 2).length);
    }
  }
  if (opts.list) return 0;

  const wanted = opts.frames.length ? opts.frames
    : opts.each ? m.frames.filter((_, i) => i % opts.each === 0).map((f) => f.counter)
      : [];
  void ok;
  if (!wanted.length) {
    console.error('no frames requested');
    return 2;
  }
  if (opts.png && wanted.length === 1) {
    mkdirSync(dirname(opts.png), { recursive: true });
    const f = m.frames.find((x) => x.counter === wanted[0]) || m.frames[m.frames.length - 1];
    m.vga.crtc.set(f.crtc);
    if (f.attr) m.vga.attr.set(f.attr);
    m.vga.pal.set(f.pal);
    m.vga.render(buf);
    writeFileSync(opts.png, encodePNG(SCREEN_W, SCREEN_H, indexedToRGB(buf, f.pal, SCREEN_W, SCREEN_H)));
    console.log('wrote ' + opts.png + ' for counter ' + f.counter +
      '  start ' + f.start + ' offset ' + f.offset + ' pan ' + f.pan);
    return 0;
  }
  mkdirSync(opts.out, { recursive: true });
  for (const want of wanted) {
    const f = m.frames.find((x) => x.counter === want) ||
      m.frames.find((x) => x.counter >= want);
    if (!f) {
      console.error('no frame at counter ' + want);
      continue;
    }
    m.vga.crtc.set(f.crtc);
    if (f.attr) m.vga.attr.set(f.attr);
    m.vga.pal.set(f.pal);
    m.vga.render(buf);
    const name = join(opts.out, 'vm_' + String(want).padStart(5, '0') + '.png');
    writeFileSync(name, encodePNG(SCREEN_W, SCREEN_H, indexedToRGB(buf, f.pal, SCREEN_W, SCREEN_H)));
    console.log('wrote ' + name + ' (counter ' + f.counter + ')');
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
