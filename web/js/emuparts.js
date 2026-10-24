/*
 * dope/emuparts.js -- parts 2..7 on the page: the timeline, the worker, the canvas.
 *
 * The part table (web/data/parts.json) carries what was measured about each
 * block: the words the loader relocates, its entry points and how many timer
 * interrupts it lasts when the machine is fast enough (`ticks`).  The part
 * start times are those lengths laid end to end after part 1.
 */
import { TICK_HZ } from "./ports/image.js";

export class EmuParts {
  /** @param blocks the unpacked RNC blocks of DOPE.EXE (0..7); @param p1End seconds part 1 lasts */
  static async load(blocks, p1End, base = "data/") {
    const table = await (await fetch(base + "parts.json")).json();
    return new EmuParts(blocks, table, p1End);
  }

  constructor(blocks, table, p1End) {
    this.parts = table.parts;
    this.starts = [];
    let t = p1End;
    for (const p of this.parts) { this.starts.push(t); t += p.ticks / TICK_HZ; }
    this.end = t;
    this.worker = new Worker(new URL("./emuworker.js", import.meta.url), { type: "module" });
    this.frame = null;
    this.stats = { fps: 0 };
    this.seeking = false;
    this.cur = -1;
    this.lastT = -1;
    this.forceRestart = true;
    this.image = null;
    this.worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === "frame") {
        if (this.frame && !this.frame.shown) this.recycle(this.frame); // never painted: back to the worker
        this.frame = d; this.stats = d.stats; this.seeking = false;
      }
      else if (d.type === "seeking") this.seeking = true;
    };
    this.worker.postMessage({
      cmd: "init",
      blocks: this.parts.map((p) => blocks[p.block].slice()),
      parts: this.parts,
    });
  }

  /** Give a frame's buffer back to the worker for the next picture. */
  recycle(f) {
    if (f.recycled) return;
    f.recycled = true;
    const buf = f.rgba.buffer;
    f.rgba = null;
    this.worker.postMessage({ cmd: "recycle", buf }, [buf]);
  }

  /** Index of the part that is on screen at `t` seconds (>= p1End). */
  partAt(t) {
    let k = 0;
    while (k + 1 < this.starts.length && t >= this.starts[k + 1]) k++;
    return k;
  }

  /** The player jumped: restart the part and fast forward. */
  markSeek() { this.forceRestart = true; }

  /** Tell the worker where the clock is, and paint the newest picture it sent. */
  draw(t, ctx, running) {
    const k = this.partAt(t);
    const tick = (t - this.starts[k]) * TICK_HZ;
    if (k !== this.cur || this.forceRestart || Math.abs(t - this.lastT) > 1.5) {
      this.cur = k;
      this.forceRestart = false;
      this.worker.postMessage({ cmd: "play", part: k, offset: Math.floor(tick), tick, running });
    } else {
      this.worker.postMessage({ cmd: "clock", part: k, tick, running });
    }
    this.lastT = t;
    const f = this.frame;
    if (f && f.part === k && !f.shown) {
      f.shown = true;
      ctx.putImageData(new ImageData(f.rgba, 320, 200), 0, 0);
      this.recycle(f);
    }
    return k;
  }
}
