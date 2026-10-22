/*
 * dope/mod.js -- player for DOPE.MOD, the 28 channel module used by DOPE.
 *
 * The module is ProTracker style (31 instruments, 64 row patterns, effects in
 * the low nibble) but carries the "28CH" signature and stores periods in
 * quarter-Amiga units: C-1 is 3424 instead of 856.  That is exactly how the
 * original GUS replay routine addressed its period table, so the pitch
 * constant is the usual Amiga one scaled accordingly:
 *
 *     freq = 14187578.4 / period
 *
 * The core is tick driven (50 Hz tracker ticks) and framework free, so the
 * same file runs in the browser and under node for tools/modtest.mjs.
 */

// Standard Amiga pitch constant: freq = 7093789.2 / (2 * period).  The module
// stores periods in the plain Amiga range (C-0 .. B-6 here), so the same
// constant the GUS replay routine used applies unchanged.
const PERIOD_SCALE = 3546894.6; // 7093789.2 / 2

const VIBRATO_TABLE = new Int8Array([
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
]);

export class Mod {
  constructor(bytes, sampleRate = 44100, options = {}) {
    this.bytes = bytes;
    this.sampleRate = sampleRate;
    this.periodScale = options.periodScale || PERIOD_SCALE;
    this.gain = options.gain ?? 0.5;
    this.name = "";
    for (let i = 0; i < 20 && bytes[i]; i++) this.name += String.fromCharCode(bytes[i]);

    this.samples = [];
    for (let i = 0; i < 31; i++) {
      const o = 20 + i * 30;
      let name = "";
      for (let j = 0; j < 22 && bytes[o + j]; j++) name += String.fromCharCode(bytes[o + j]);
      // lengths are stored in 16 bit words
      this.samples.push({
        name: name.trim(),
        length: (((bytes[o + 22] << 8) | bytes[o + 23]) * 2),
        finetune: bytes[o + 24] & 0x0f,
        volume: Math.min(64, bytes[o + 25]),
        loopStart: ((bytes[o + 26] << 8) | bytes[o + 27]) * 2,
        loopLength: ((bytes[o + 28] << 8) | bytes[o + 29]) * 2,
        data: null,
      });
    }

    this.songLength = bytes[950];
    this.restart = bytes[951];
    this.orders = Array.from(bytes.subarray(952, 1080));
    this.signature = String.fromCharCode(bytes[1080], bytes[1081], bytes[1082], bytes[1083]);

    let maxPat = 0;
    for (let i = 0; i < this.songLength; i++) maxPat = Math.max(maxPat, this.orders[i]);
    this.patternCount = maxPat + 1;
    this.channels = this.detectChannels();

    this.patterns = [];
    const patStart = 1084;
    const patSize = 64 * this.channels * 4;
    for (let p = 0; p < this.patternCount; p++) {
      const cells = new Array(64 * this.channels);
      const base = patStart + p * patSize;
      for (let i = 0; i < cells.length; i++) {
        const o = base + i * 4;
        const b0 = bytes[o], b1 = bytes[o + 1], b2 = bytes[o + 2], b3 = bytes[o + 3];
        cells[i] = {
          period: ((b0 & 0x0f) << 8) | b1,
          sample: (b0 & 0xf0) | (b2 >> 4),
          effect: b2 & 0x0f,
          param: b3,
        };
      }
      this.patterns.push(cells);
    }

    let offset = patStart + this.patternCount * patSize;
    for (const s of this.samples) {
      s.data = new Int8Array(s.length);
      for (let i = 0; i < s.length; i++) {
        const b = bytes[offset + i];
        s.data[i] = b < 128 ? b : b - 256;
      }
      offset += s.length;
    }
    this.sampleDataEnd = offset;

    this.reset();
  }

  /** Channel count implied by the pattern block ending exactly at the samples. */
  detectChannels() {
    let sampleBytes = 0;
    for (const s of this.samples) sampleBytes += s.length;
    const remaining = this.bytes.length - 1084 - sampleBytes;
    for (let ch = 4; ch <= 32; ch++) {
      if (remaining === this.patternCount * 64 * ch * 4) return ch;
    }
    return 28;
  }

  reset(startOrder = 0) {
    this.order = startOrder;
    this.row = 0;
    this.tick = 0;
    this.speed = 6;
    this.tempo = 125;
    this.jumped = false;
    this.patternBreak = -1;
    this.voices = [];
    for (let i = 0; i < this.channels; i++) {
      // The GUS replay routine spreads voices across the stereo field; a
      // gentle alternating spread keeps the same feel without hard panning.
      const pan = ((i % 8) - 3.5) / 5;
      this.voices.push({
        sample: null,
        period: 0,
        targetPeriod: 0,
        volume: 0,
        pan,
        pos: 0,
        step: 0,
        effect: 0,
        param: 0,
        vibratoPos: 0,
        vibratoSpeed: 0,
        vibratoDepth: 0,
        arpeggio: 0,
        active: false,
      });
    }
    this.processRow();
  }

  periodToStep(period, finetune = 0) {
    if (period <= 0) return 0;
    const ft = finetune & 0x0f;
    const semi = (ft < 8 ? ft : ft - 16) / 8;
    const freq = (this.periodScale / period) * Math.pow(2, semi / 12);
    return freq / this.sampleRate;
  }

  updateStep(v) {
    if (!v.sample) return;
    let period = v.period;
    if (v.arpeggio) period *= Math.pow(2, -v.arpeggio / 12);
    v.step = this.periodToStep(period, v.sample.finetune);
  }

  processRow() {
    const patIndex = this.orders[this.order] || 0;
    const pat = this.patterns[patIndex] || this.patterns[0];
    const base = this.row * this.channels;
    for (let c = 0; c < this.channels; c++) {
      const cell = pat[base + c];
      const v = this.voices[c];
      v.effect = cell.effect;
      v.param = cell.param;
      v.arpeggio = 0;

      if (cell.sample) {
        v.sample = this.samples[cell.sample - 1];
        v.volume = v.sample.volume;
      }
      if (cell.period) {
        v.period = cell.period;
        v.targetPeriod = cell.period;
        v.pos = 0;
        v.active = true;
      }
      this.effectOnRow(v, cell);
      this.updateStep(v);
    }
  }

  effectOnRow(v, cell) {
    const e = cell.effect;
    const p = cell.param;
    switch (e) {
      case 0x0:
        v.arpeggio = 0; // set per tick
        break;
      case 0x3:
        if (cell.period) v.targetPeriod = cell.period;
        break;
      case 0x5:
        if (cell.period) v.targetPeriod = cell.period;
        break;
      case 0x8:
        v.pan = ((p & 0x0f) - 8) / 8;
        break;
      case 0x9:
        if (v.sample) v.pos = Math.min((p & 0xff) * 256, Math.max(0, v.sample.length - 1));
        break;
      case 0x0b:
        this.order = p;
        this.row = -1;
        this.jumped = true;
        break;
      case 0x0c:
        v.volume = Math.min(64, p);
        break;
      case 0x0d:
        this.patternBreak = (p >> 4) * 10 + (p & 0x0f);
        break;
      case 0x0e: {
        const sub = p >> 4;
        const x = p & 0x0f;
        if (sub === 0x1) v.period -= x * 4;
        else if (sub === 0x2) v.period += x * 4;
        else if (sub === 0xa) v.volume = Math.min(64, v.volume + x);
        else if (sub === 0xb) v.volume = Math.max(0, v.volume - x);
        break;
      }
      case 0x0f:
        if (p < 0x20) this.speed = Math.max(1, p);
        else this.tempo = Math.max(32, p);
        break;
    }
  }

  /** Called once per tracker tick, before the tick's audio is mixed. */
  tickEffects() {
    for (let c = 0; c < this.channels; c++) {
      const v = this.voices[c];
      const p = v.param;
      if (!v.active) continue;
      switch (v.effect) {
        case 0x0:
          if (p) {
            const phase = this.tick % 3;
            v.arpeggio = phase === 1 ? (p >> 4) : phase === 2 ? (p & 0x0f) : 0;
          }
          break;
        case 0x1:
          v.period = Math.max(113, v.period - p);
          break;
        case 0x2:
          v.period = Math.min(3424, v.period + p);
          break;
        case 0x3:
          this.tonePorta(v, p);
          break;
        case 0x4:
          this.vibrato(v, p);
          break;
        case 0x5:
          this.tonePorta(v, p);
          this.volumeSlide(v, p);
          break;
        case 0x6:
          this.vibrato(v, p);
          this.volumeSlide(v, p);
          break;
        case 0x0a:
          this.volumeSlide(v, p);
          break;
      }
      this.updateStep(v);
    }
  }

  tonePorta(v, p) {
    if (v.targetPeriod > v.period) v.period = Math.min(v.targetPeriod, v.period + p);
    else if (v.targetPeriod < v.period) v.period = Math.max(v.targetPeriod, v.period - p);
  }

  vibrato(v, param) {
    if (param & 0x0f) v.vibratoDepth = param & 0x0f;
    if (param >> 4) v.vibratoSpeed = param >> 4;
    const delta = (VIBRATO_TABLE[v.vibratoPos & 0x1f] * v.vibratoDepth) / 128;
    v.period += delta * 4;
    v.vibratoPos = (v.vibratoPos + v.vibratoSpeed) & 0x3f;
  }

  volumeSlide(v, p) {
    const up = p >> 4;
    const down = p & 0x0f;
    if (up) v.volume = Math.min(64, v.volume + up);
    else v.volume = Math.max(0, v.volume - down);
  }

  /** Move to the next tick, processing row changes when the tick wraps. */
  advanceTick() {
    this.tick++;
    if (this.tick >= this.speed) {
      this.tick = 0;
      this.row++;
      if (this.patternBreak >= 0) {
        this.row = this.patternBreak;
        this.patternBreak = -1;
        this.order++;
        this.jumped = true;
      }
      if (this.row >= 64) {
        this.row = 0;
        this.order++;
        this.jumped = true;
      }
      if (this.jumped) {
        if (this.order >= this.songLength || this.order < 0) this.order = this.restart;
        this.jumped = false;
      }
      // tick 0 of a row only triggers notes and applies the row's immediate
      // effects; slides, vibrato and arpeggio run on ticks 1..speed-1
      this.processRow();
    } else {
      this.tickEffects();
    }
  }

  /** Frames a single tracker tick lasts at the current tempo. */
  framesPerTick(sampleRate) {
    return (sampleRate * 2.5) / this.tempo;
  }

  /**
   * Advance every voice by `frames` output frames without mixing: the same
   * position update render() does, in closed form.  Used by seek, so jumping
   * to minute 7 costs milliseconds instead of mixing 7 minutes of audio.
   */
  skip(frames) {
    for (const v of this.voices) {
      if (!v.active || !v.sample) continue;
      const len = v.sample.data.length;
      let pos = v.pos + v.step * frames;
      if (v.sample.loopLength > 1) {
        const ls = v.sample.loopStart;
        const le = Math.min(len, ls + v.sample.loopLength);
        if (pos >= le) pos = ls + ((pos - ls) % (le - ls));
      } else if (pos >= len) {
        v.active = false;
        pos = len;
      }
      v.pos = pos;
    }
  }

  /** Mix `frames` stereo float samples into outL/outR. */
  render(outL, outR, frames) {
    const amp = this.gain / (64 * 128) * 64;
    for (let n = 0; n < frames; n++) {
      let l = 0;
      let r = 0;
      for (let c = 0; c < this.channels; c++) {
        const v = this.voices[c];
        if (!v.active || !v.sample) continue;
        const data = v.sample.data;
        const len = data.length;
        if (!len) continue;
        let pos = v.pos;
        if (pos >= len) {
          v.active = false;
          continue;
        }
        const i0 = pos | 0;
        const frac = pos - i0;
        const i1 = i0 + 1 < len ? i0 + 1 : i0;
        const s = data[i0] + (data[i1] - data[i0]) * frac;
        const g = v.volume * (s / 128);
        const panR = (v.pan + 1) / 2;
        l += g * (1 - panR);
        r += g * panR;

        pos += v.step;
        const loopLen = v.sample.loopLength;
        if (loopLen > 1) {
          // loop window is [loopStart, loopStart+loopLength); samples may also
          // run past the loop end, so wrap back into the window
          const ls = v.sample.loopStart;
          const le = Math.min(len, ls + loopLen);
          if (pos >= le) pos = ls + ((pos - ls) % (le - ls));
        } else if (pos >= len) {
          v.active = false;
          pos = len;
        }
        v.pos = pos;
      }
      outL[n] = Math.max(-1, Math.min(1, l * amp));
      outR[n] = Math.max(-1, Math.min(1, r * amp));
    }
  }
}
