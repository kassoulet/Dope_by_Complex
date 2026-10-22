/*
 * dope/part1player.js -- play part 1 in the browser, from pixels.
 *
 * There is no emulator in this path: `part1.js` writes the 320x200 image for a
 * counter directly, and this class only clocks it.  The original's timing is
 * the part's own timer interrupt, measured at 69 Hz, with the counter advanced
 * by 2 per interrupt (docs/RUNTIME.md), so a counter of `2 * floor(69 * t)`
 * reproduces the speed the reference screenshots were taken at.
 *
 *   python3 -m http.server 8000        # from the repository root
 *   open http://localhost:8000/web/?vm=1
 */

import { Part1, W, H, counterAt, END_COUNTER } from './part1.js';

export class Part1Player {
  constructor(canvas, status) {
    this.canvas = canvas;
    this.status = status || (() => {});
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.image = this.ctx.createImageData(W, H);
    this.part = null;
    this.running = false;
    this.startedAt = 0;
    this.onExit = null;
  }

  /** Fetch DOPE.EXE and take the picture and palette tables out of block 1. */
  async load(url = '../DOPE.EXE') {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cannot load ${url} (${res.status})`);
    this.part = Part1.fromExecutable(new Uint8Array(await res.arrayBuffer()));
    return this.part;
  }

  reset() {
    this.startedAt = performance.now() / 1000;
  }

  start() {
    if (this.running) return;
    if (!this.part) throw new Error('part1player: load() first');
    this.reset();
    this.running = true;
    this.tick();
  }

  stop() {
    this.running = false;
  }

  tick() {
    if (!this.running) return;
    const counter = counterAt(performance.now() / 1000 - this.startedAt);
    const part = this.part;

    part.rgba(counter, this.image.data);
    this.ctx.putImageData(this.image, 0, 0);

    const start = part.lineStart(counter);
    const pan = part.panPixels(counter);
    const done = counter >= END_COUNTER;
    this.status(
      `original part 1 -- counter ${counter}` +
        `  scroll ${4 * (counter >> 4)}  pan ${pan}` +
        `  line ${start}` +
        (done ? '  (part 1 ends here; the loader hands over to part 2)' : '')
    );

    if (done) {
      this.running = false;
      if (this.onExit) this.onExit();
      return;
    }
    requestAnimationFrame(() => this.tick());
  }
}
