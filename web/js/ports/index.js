/*
 * dope/ports/index.js -- the parts that run as ports (JavaScript rewritten from
 * the machine code) instead of in the emulator.  A port has the same job as a
 * PartRunner for the page's worker -- be at tick N, have a picture -- but is
 * driven differently: it has no instructions to run, only ticks to advance.
 */
import { loadImage } from '../partvm.js';
import { Part3 } from './part3.js';
import { Part4 } from './part4.js';

const PORTS = {
  3: Part3,
  4: Part4,
};

export const hasPort = (block) => block in PORTS;

export class PortRunner {
  constructor(block, spec, screen) {
    const image = loadImage(block, spec.reloc);
    this.port = new PORTS[spec.block](image, { screen: screen && screen.pixels, pal: screen && screen.pal });
    this.spec = spec;
    this.exited = false;
  }

  get tick() { return this.port.total ?? this.port.ticks; }

  /** Move the part to timer tick `tick`. */
  advanceTo(tick) {
    this.port.advanceTo(tick);
    if (this.port.done) this.exited = true;
  }

  /** The picture and palette as the card would show them. */
  snapshot() {
    this.port.render();
    return { pixels: this.port.vram.slice(), pal: this.port.dac.slice() };
  }
}
