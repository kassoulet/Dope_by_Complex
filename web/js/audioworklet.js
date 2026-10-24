/*
 * dope/audioworklet.js -- DOPE.MOD in libopenmpt, rendered on the audio thread.
 *
 * messages in:   {cmd:'load', bytes}          -> {type:'ready', channels, patterns, orders, duration}
 *                {cmd:'seek', seconds, epoch} the song moves; `epoch` is echoed so the page can drop positions
 *                                             that were sent before the seek
 *                {cmd:'pause', on}            silence, and the song does not move
 * messages out:  {type:'pos', frames, time, peak, epoch}  every 2048 frames: how many frames the song has
 *                rendered, the audio clock when that was, and the peak of the last block
 */
import { Song } from "./openmpt.js";

class DopeSong extends AudioWorkletProcessor {
  constructor() {
    super();
    this.song = null;
    this.paused = false;
    this.frames = 0;
    this.since = 0;
    this.peak = 0;
    this.epoch = 0;
    this.port.onmessage = async (e) => {
      const d = e.data;
      if (d.cmd === "load") {
        this.song = await Song.load(d.bytes);
        const s = this.song;
        this.port.postMessage({ type: "ready", channels: s.channels, patterns: s.patterns, orders: s.orders, duration: s.duration });
      } else if (d.cmd === "seek" && this.song) {
        this.song.seek(d.seconds);
        this.frames = Math.round(d.seconds * sampleRate);
        this.epoch = d.epoch;
      } else if (d.cmd === "pause") this.paused = d.on;
    };
  }

  process(inputs, outputs) {
    if (!this.song || this.paused) return true; // the output stays silent
    const l = outputs[0][0], r = outputs[0][1], n = l.length;
    this.song.render(l, r, n, sampleRate);
    for (let i = 0; i < n; i++) { const a = l[i] < 0 ? -l[i] : l[i]; if (a > this.peak) this.peak = a; }
    this.frames += n;
    this.since += n;
    if (this.since >= 2048) {
      this.port.postMessage({ type: "pos", frames: this.frames, time: currentTime, peak: this.peak, epoch: this.epoch });
      this.since = 0;
      this.peak = 0;
    }
    return true;
  }
}
registerProcessor("dope-song", DopeSong);
