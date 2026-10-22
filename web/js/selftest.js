/*
 * dope/selftest.js -- draws every scene at a few timestamps and reports how
 * much of the frame was touched.  Used by the headless chrome check in the
 * build instructions (there is no audio here, only the renderer).
 */

import { VGA, W, H } from "./engine.js";
import { SCENES, buildPalette } from "./scenes.js";

const out = document.getElementById("out");
const sheet = document.getElementById("sheet");
const sctx = sheet.getContext("2d");

const vga = new VGA();
vga.attach(document.createElement("canvas"));
buildPalette(vga);

const times = [0.7, 3.4];

sheet.width = W * times.length;
sheet.height = H * SCENES.length;
sctx.fillStyle = "#000";
sctx.fillRect(0, 0, sheet.width, sheet.height);

const lines = [];
let failures = 0;

SCENES.forEach((scene, row) => {
  times.forEach((t, col) => {
    vga.clear(0);
    let err = null;
    try {
      scene.draw(vga, t, null);
    } catch (e) {
      err = e;
      failures++;
    }
    let lit = 0;
    let distinct = new Set();
    for (let i = 0; i < vga.fb.length; i++) {
      const c = vga.fb[i];
      if (c) lit++;
      if (distinct.size < 64) distinct.add(c);
    }
    lines.push(
      `${scene.name.padEnd(8)} t=${t.toFixed(1)} lit=${((lit / (W * H)) * 100).toFixed(1)}% ` +
        `colours=${distinct.size}${err ? " ERROR " + err.message : ""}`
    );

    // blit this frame into the sheet
    const img = sctx.createImageData(W, H);
    for (let i = 0, j = 0; i < vga.fb.length; i++, j += 4) {
      const c = vga.fb[i];
      img.data[j] = vga.pal[c * 3] << 2;
      img.data[j + 1] = vga.pal[c * 3 + 1] << 2;
      img.data[j + 2] = vga.pal[c * 3 + 2] << 2;
      img.data[j + 3] = 255;
    }
    sctx.putImageData(img, col * W, row * H);
  });
});

lines.push(failures ? `FAIL (${failures} scenes threw)` : "OK all scenes rendered");
out.textContent = lines.join("\n");
