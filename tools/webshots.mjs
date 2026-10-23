/*
 * Seek the page to some times and save what the canvas shows (headless Chrome).
 *   node tools/webshots.mjs 60 100 160 --out build/web
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { launch, sleep } from '../tests/browser_lib.mjs';

const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const out = oi >= 0 ? args.splice(oi, 2)[1] : 'build/web';
mkdirSync(out, { recursive: true });
const { page, base, cleanup } = await launch();
try {
  await page.goto(base + '?autostart=1');
  await page.until('window.__dope && window.__dope.started && window.__dope.t > 0.2', (x) => x, 'start');
  for (const sec of args.map(Number)) {
    await page.eval(`__dope.seek(${sec})`);
    await page.until('__dope.status', (x) => /MIPS|part 1 --/.test(x), 'seek to settle', 120000);
    await sleep(2500);
    const png = await page.eval("document.getElementById('screen').toDataURL('image/png')");
    writeFileSync(`${out}/t${String(sec).padStart(3, '0')}.png`, Buffer.from(png.split(',')[1], 'base64'));
    console.log(sec, await page.eval('__dope.status'));
  }
  cleanup(0);
} catch (e) { console.log('FAIL', e.message); cleanup(1); }
