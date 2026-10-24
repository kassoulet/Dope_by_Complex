/*
 * DOPE.MOD through libopenmpt (web/js/openmpt.js): it loads, has 28 channels, seeks to where it is told,
 * and renders sound at the rates a sound card uses.   node tests/test_openmpt.mjs
 */
import { readFileSync } from 'node:fs';
import { Song } from '../web/js/openmpt.js';

let passed = 0, failed = 0;
const ok = (name, cond, detail) => { if (cond) { passed++; console.log('ok   ' + name); } else { failed++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); } };
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

const song = await Song.load(new Uint8Array(readFileSync('DOPE.MOD')));
ok('28 channels', song.channels === 28, song.channels);
ok('the song is longer than the demo (473 s)', song.duration > 473, song.duration);

for (const sr of [44100, 48000]) {
  song.seek(0);
  const l = new Float32Array(sr), r = new Float32Array(sr);
  const n = song.render(l, r, sr, sr);
  ok(`${sr} Hz: one second rendered, and it is sound`, n === sr && rms(l) > 0.01 && rms(r) > 0.01, `n ${n} rms ${rms(l)}`);
  ok(`${sr} Hz: the clock moved by one second`, Math.abs(song.position - 1) < 0.01, song.position);
}

for (const at of [5, 120, 300, 440]) {
  song.seek(at);
  ok(`seek to ${at} s lands within a row (${song.position.toFixed(3)})`, Math.abs(song.position - at) < 0.25);
  const l = new Float32Array(4096), r = new Float32Array(4096);
  song.render(l, r, 4096, 48000);
  ok(`... and plays from there`, rms(l) > 0.005);
}

// a seek is deterministic (libopenmpt replays the song state up to the nearest row, so this is what the page hears after a seek)
const sr = 48000, a = new Float32Array(sr), b = new Float32Array(sr), z = new Float32Array(sr);
song.seek(200); song.render(a, z, sr, sr);
song.seek(10); song.render(z, z, 1000, sr);
song.seek(200); song.render(b, z, sr, sr);
ok('seeking twice to the same time gives the same sound', a.every((v, i) => v === b[i]));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
