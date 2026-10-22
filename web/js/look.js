/*
 * dope/look.js -- parts 2..end as look-alikes.
 *
 * NOT a port: the timeline (which part runs when) is measured from a
 * DOSBox-X capture of the original at one frame per 3 s (build/ref_full,
 * tools/refcapture.py), and each part is a procedural imitation of what those
 * frames show.  Part 1 is the real thing (part1.js).  A frame is a pure
 * function of t, so pause and seek are free.
 */

export const W = 320, H = 200;
export const DEMO_END = 435; // the capture shows the original exiting to DOS at ~433 s

// [start s, end s, name]; i-th reference frame is t = 39 + 3 i
export const PARTS = [
  [39, 72, "credits"], [72, 144, "ribbons"], [144, 186, "phong"], [186, 249, "fire"],
  [249, 270, "fractal"], [270, 282, "checker"], [282, 303, "env"], [303, 342, "bump"],
  [342, 393, "shadow"], [393, 411, "light"], [411, 426, "world"], [426, DEMO_END, "end"],
];
export const partAt = (t) => PARTS.find((p) => t < p[1]) || PARTS[PARTS.length - 1];

const cv = typeof document !== "undefined" ? document.createElement("canvas") : null;
if (cv) { cv.width = W; cv.height = H; }
const g = cv && cv.getContext("2d", { willReadFrequently: true });
let img = null;

const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function noise(x, y) { // smooth value noise
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const ease = (x) => Math.max(0, Math.min(1, x));

function pixels(fn) {
  img = img || g.createImageData(W, H);
  const d = img.data;
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4) {
    const c = fn(x, y);
    d[i] = clamp(c[0]); d[i + 1] = clamp(c[1]); d[i + 2] = clamp(c[2]); d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
const fill = (c) => { g.fillStyle = c; g.fillRect(0, 0, W, H); };

function title(small, big, sub, x, y) { // the little pixelled caption boxes
  g.save(); g.textBaseline = "top"; g.fillStyle = "rgba(8,8,24,.75)"; g.fillRect(x - 3, y - 2, 74, 36); g.fillStyle = "#cfd0e8";
  g.font = "italic 9px sans-serif"; g.fillText(small, x, y);
  g.font = "bold 15px sans-serif"; g.fillText(big, x, y + 8);
  g.font = "9px sans-serif"; g.fillText(sub, x, y + 22);
  g.restore();
}
function text(s, x, y, size, a) {
  g.save(); g.globalAlpha = ease(a); g.fillStyle = "#e8e8f0"; g.textAlign = "center";
  g.font = `${size}px "Helvetica Neue", Arial, sans-serif`; g.fillText(s, x, y); g.restore();
}

/* 1: two blue chrome discs and the credit pairs */
function credits(t) {
  const disc = (x, y, k) => { // y counted from the screen edge, 0..60
    const sw = Math.sin(t * 0.7 + k) * 60, ry = 24 + 14 * Math.sin(t * 0.5 + k * 2);
    const dx = (x - 160 - sw) / 190, dy = (y - 30) / ry, r = dx * dx + dy * dy;
    if (r > 1 || y > 60) return null;
    const b = 0.35 + 0.65 * Math.abs(Math.sin(r * 9 + noise(x * 0.05, y * 0.2 + t) * 3 - t));
    return [40 + 60 * b, 40 + 60 * b, 120 + 120 * b];
  };
  pixels((x, y) => (y < 100 ? disc(x, y, 0) : disc(x, H - 1 - y, 1)) || [0, 0, 0]);
  const s = [[39, 41.5, "jmagic", "code"], [42, 49, "jugi", "music"], [51, 58, "jugi", "graphics"]].find((c) => t >= c[0] && t < c[1]);
  if (s) { const a = Math.min((t - s[0]) * 2, (s[1] - t) * 2); text(s[2], 80, 106, 22, a); text(s[3], 232, 106, 22, a); }
  else if (t >= 58 && t < 69) text('"dope"', 160, 106, 28, Math.min((t - 58) * 2, (69 - t)));
}

/* 2: purple-blue chrome ribbons around a C, "phong BLUR motion" */
function ribbons(t) {
  fill("#07071a");
  const u = t - 72;
  for (let k = 0; k < 6; k++) {
    const a = u * 0.5 + k * 1.1, cx = 160 + Math.sin(a * 0.8) * 70, cy = 100 + Math.cos(a * 0.6 + k) * 40;
    const R = 40 + 40 * Math.abs(Math.sin(u * 0.2 + k)), w = 12 + 14 * Math.abs(Math.cos(a));
    const gr = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    gr.addColorStop(0, "#2a2a7a"); gr.addColorStop(0.5, "#8c8ce8"); gr.addColorStop(1, "#1a1a55");
    g.strokeStyle = gr; g.lineWidth = w; g.lineCap = "round";
    g.beginPath(); g.arc(cx, cy, R, a, a + 4.2); g.stroke();
  }
  if (u > 5) title("phong", "BLUR", "motion", 4, 4);
}

/* 3: starfield with a growing teal phong blob */
function phong(t) {
  const u = t - 144, grow = Math.sin(Math.min(1, u / 38) * Math.PI) * 1.1 + 0.05;
  pixels((x, y) => {
    const star = hash(x, y) > 0.9975 ? 200 : 0;
    const dx = x - 160, dy = y - 100;
    const ang = Math.atan2(dy, dx), r = Math.hypot(dx, dy);
    const edge = (35 + 90 * grow) * (0.75 + 0.3 * noise(Math.cos(ang + u * 0.3) * 1.5 + 5, Math.sin(ang + u * 0.3) * 1.5 + u * 0.2));
    if (r < edge) {
      const n = noise(x * 0.06 + u, y * 0.2), l = 0.45 + 0.55 * Math.abs(Math.sin(r * 0.15 + n * 5 - u));
      return [60 + 150 * l, 90 + 160 * l, 100 + 150 * l];
    }
    return [28 + star + 8 * noise(x * 0.02, y * 0.02), 8 + star, 45 + star];
  });
  if (u > 4) title("7800", "PHONG", "polys", 4, 4);
}

/* 4/5: orange fire swirl, with a perspective ground for "fractal scape" */
function fire(t, ground) {
  const u = t - 186;
  pixels((x, y) => {
    let dx = x - 160, dy = y - 100;
    if (ground && y > 120) { // grey perspective plane
      const z = 40 / (y - 112), gx = (x - 160) * z * 0.2 + u * 3, n = noise(gx * 0.2, z * 3);
      return [70 + 90 * n, 62 + 80 * n, 60 + 70 * n];
    }
    const r = Math.hypot(dx, dy * 1.3), a = Math.atan2(dy, dx);
    const w = Math.sin(r * 0.28 - u * 2.2 + a * 2 + 3 * noise(Math.cos(a) * 2 + u * 0.3, Math.sin(a) * 2 + r * 0.05));
    const v = Math.pow(Math.max(0, w), 3) * (1 - Math.min(1, r / 220)) * (0.5 + 0.8 * Math.abs(Math.sin(u * 0.4)));
    return [255 * v + 30, 120 * v + 8, 40 * v + 18];
  });
  if (t >= 198 && t < 244) title("larusse", "FIRE", "clouds", 262, 170);
  if (ground && t >= 249) title("larusse", "FRACTAL", "scape", 262, 170);
}

/* orange checkerboard floor, shared by env / bump */
function checker(t, shape) {
  const u = t - 270;
  pixels((x, y) => {
    const dy = y - 70; let c;
    if (dy < 2) c = 0.15; else {
      const z = 60 / dy, gx = (x - 160) * z / 40 + u * 0.5, gz = z + u * 0.8;
      c = (Math.floor(gx) + Math.floor(gz)) & 1 ? 0.95 : 0.3;
    }
    return [215 * c, 95 * c, 20 * c];
  });
  if (shape) shape(u);
}
function env(u) { // gold spiky star
  const s = 30 + 50 * Math.abs(Math.sin((u - 12) * 0.3)); g.save(); g.translate(160, 100); g.rotate(u * 0.8);
  const gr = g.createLinearGradient(-s, -s, s, s); gr.addColorStop(0, "#fff0a0"); gr.addColorStop(0.5, "#b07010"); gr.addColorStop(1, "#ffe070");
  g.fillStyle = gr; g.strokeStyle = "#402000"; g.beginPath();
  for (let i = 0; i < 16; i++) { const r = i & 1 ? s * 0.45 : s, a = i * Math.PI / 8; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  g.closePath(); g.fill(); g.stroke(); g.restore();
  title("phong", "ENV", "mapping", 4, 4);
}
function bump(u) { // lumpy red blob
  const s = 20 + 60 * Math.abs(Math.sin((u - 30) * 0.22)); g.save(); g.translate(160, 100); g.rotate(u * 0.4);
  const gr = g.createRadialGradient(-s * 0.3, -s * 0.3, 2, 0, 0, s * 1.2); gr.addColorStop(0, "#ffb0a0"); gr.addColorStop(0.6, "#b03028"); gr.addColorStop(1, "#501010");
  g.fillStyle = gr; g.beginPath();
  for (let i = 0; i <= 60; i++) { const a = i / 60 * Math.PI * 2, r = s * (0.55 + 0.45 * Math.abs(Math.cos(a * 3 + u * 0.5))) * (1 + 0.08 * Math.sin(a * 13)); g.lineTo(Math.cos(a) * r, Math.sin(a) * r * 0.8); }
  g.fill(); g.restore();
  title("BUMP", "glow", "", 4, 4);
}

/* 8: pale blue water, orbit rings, a cat that changes material */
function shadow(t) {
  const u = t - 342;
  pixels((x, y) => {
    const n = noise(x * 0.025 + Math.sin(u * 0.3), y * 0.03 + u * 0.1) + 0.5 * noise(x * 0.07, y * 0.07 - u * 0.2), l = 0.5 + 0.45 * Math.sin(n * 6);
    return [90 + 90 * l, 150 + 80 * l, 210 + 40 * l];
  });
  g.save(); g.translate(160, 100); g.strokeStyle = "#3a6fb0"; g.lineWidth = 3;
  for (let k = 0; k < 3; k++) { g.beginPath(); g.ellipse(0, 0, 120, 30 + 70 * Math.abs(Math.sin(u * 0.4 + k * 1.05)), k * 1.05 + u * 0.15, 0, 7); g.stroke(); }
  const mat = u < 27 ? ["#c05030", "#6a2010"] : u < 48 ? ["#c05030", "#304a80"] : ["#6070a8", "#202850"];
  const s = 30 + 35 * Math.abs(Math.sin(u * 0.35)); g.rotate(Math.sin(u * 0.6) * 0.5);
  const gr = g.createLinearGradient(-s, -s, s, s); gr.addColorStop(0, mat[0]); gr.addColorStop(1, mat[1]); g.fillStyle = gr;
  g.beginPath(); g.ellipse(0, s * 0.3, s * 0.5, s * 0.7, 0, 0, 7); g.fill();
  g.beginPath(); g.arc(0, -s * 0.55, s * 0.32, 0, 7); g.fill();
  g.beginPath(); g.moveTo(-s * 0.3, -s * 0.7); g.lineTo(-s * 0.2, -s * 1.1); g.lineTo(-s * 0.05, -s * 0.8); g.moveTo(s * 0.3, -s * 0.7); g.lineTo(s * 0.2, -s * 1.1); g.lineTo(s * 0.05, -s * 0.8); g.fill();
  g.restore();
  title(u < 27 ? "SHADOW" : u < 48 ? "material" : "METAL", u < 27 ? "volume" : u < 48 ? "MORPH" : "shading", "", 4, 4);
}

/* 9/10: grey tentacles over a dark skyline */
function worms(t, world) {
  fill("#000");
  const u = t - (world ? 411 : 393), n = world ? 9 : 5;
  g.lineCap = "round"; g.strokeStyle = "#a8a8b4";
  for (let k = 0; k < n; k++) {
    g.lineWidth = 3 + 5 * ease(u / 12 + 0.2); g.beginPath();
    for (let i = 0; i < 40; i++) {
      const a = i * 0.28 + k * 6.28 / n + u * 0.4, r = i * (1.5 + u * 0.25 * (world ? 1 : 0.4));
      g.lineTo(160 + Math.cos(a) * r + Math.sin(i * 0.5 + u * 2) * 8, 90 + Math.sin(a) * r * 0.7 + Math.cos(i * 0.4 + u * 1.5) * 8);
    }
    g.stroke();
  }
  g.fillStyle = "#14203a"; for (let x = 0; x < W; x++) g.fillRect(x, 186 - noise(x * 0.08, 3) * 6, 1, 14);
  title(world ? "1995" : "multiple", world ? "WORLD" : "LIGHT", world ? "domination" : "sources", 4, 4);
}

function end(t) {
  fill("#000");
  g.fillStyle = "#14203a"; for (let x = 0; x < W; x++) g.fillRect(x, 186 - noise(x * 0.08, 3) * 6, 1, 14);
  text("dope", 160, 108, 26, Math.min(1, (t - 426) * 0.8) * Math.min(1, (DEMO_END - t) / 3));
}

const R = {
  credits, ribbons, phong, fire: (t) => fire(t, false), fractal: (t) => fire(t, true), checker: (t) => checker(t, null),
  env: (t) => checker(t, env), bump: (t) => checker(t, bump), shadow, light: (t) => worms(t, false), world: (t) => worms(t, true), end,
};

/** Draw the frame for song time t (>= 39 s) onto `ctx`. Returns the part name. */
export function renderLook(ctx, t) {
  const name = partAt(t)[2];
  R[name](Math.max(39, t));
  ctx.drawImage(cv, 0, 0);
  return name;
}
