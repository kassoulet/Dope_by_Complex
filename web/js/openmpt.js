/*
 * dope/openmpt.js -- DOPE.MOD played by libopenmpt (web/vendor/libopenmpt.js, WebAssembly).
 *
 * The page's clock is the number of audio frames rendered, so all this has to do is fill
 * buffers and seek.  Quality settings: the 8 tap windowed sinc interpolation filter (the best
 * libopenmpt has), full stereo separation, rendered at the sound card's own rate.
 */
import libopenmpt from "../vendor/libopenmpt.js";

const RENDER_STEREOSEPARATION_PERCENT = 2;
const RENDER_INTERPOLATIONFILTER_LENGTH = 3;
const RENDER_VOLUMERAMPING_STRENGTH = 4;
const CHUNK = 4096; // the most frames one read may return

export class Song {
  static async load(bytes) {
    const lib = await libopenmpt();
    return new Song(lib, bytes);
  }

  constructor(lib, bytes) {
    this.lib = lib;
    const file = lib._malloc(bytes.length);
    lib.HEAPU8.set(bytes, file);
    this.ptr = lib._openmpt_module_create_from_memory(file, bytes.length, 0, 0, 0);
    lib._free(file);
    if (!this.ptr) throw new Error("libopenmpt cannot read the module");
    this.left = lib._malloc(4 * CHUNK);
    this.right = lib._malloc(4 * CHUNK);
    lib._openmpt_module_set_repeat_count(this.ptr, -1); // loop forever
    lib._openmpt_module_set_render_param(this.ptr, RENDER_INTERPOLATIONFILTER_LENGTH, 8); // 8 tap sinc
    lib._openmpt_module_set_render_param(this.ptr, RENDER_STEREOSEPARATION_PERCENT, 100);
    lib._openmpt_module_set_render_param(this.ptr, RENDER_VOLUMERAMPING_STRENGTH, 1);
    this.channels = lib._openmpt_module_get_num_channels(this.ptr);
    this.patterns = lib._openmpt_module_get_num_patterns(this.ptr);
    this.orders = lib._openmpt_module_get_num_orders(this.ptr);
    this.duration = lib._openmpt_module_get_duration_seconds(this.ptr);
  }

  /** Move to `seconds` into the song (libopenmpt replays the song state up to there). */
  seek(seconds) {
    this.lib._openmpt_module_set_position_seconds(this.ptr, seconds);
  }

  get position() { return this.lib._openmpt_module_get_position_seconds(this.ptr); }

  /** Render `frames` frames at `sampleRate` into l and r (Float32Arrays); returns the frames made, the rest is silence. */
  render(l, r, frames, sampleRate) {
    const lib = this.lib;
    let done = 0;
    while (done < frames) {
      const n = lib._openmpt_module_read_float_stereo(this.ptr, sampleRate, Math.min(CHUNK, frames - done), this.left, this.right);
      if (n === 0) break;
      l.set(lib.HEAPF32.subarray(this.left >> 2, (this.left >> 2) + n), done);
      r.set(lib.HEAPF32.subarray(this.right >> 2, (this.right >> 2) + n), done);
      done += n;
    }
    if (done < frames) { l.fill(0, done, frames); r.fill(0, done, frames); }
    return done;
  }
}
