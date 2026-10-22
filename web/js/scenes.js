/*
 * dope/scenes.js -- the demo itself.
 *
 * The parts, in the order DOPE.TXT lists them: the routine boxes sketch, the
 * 3d objects (credits part, the 7800 poly object, the environment map and the
 * shadow volume), world domination, and the end scroll the group ran out of
 * time to illustrate.  Everything is drawn on top of engine.js with the demo's
 * palette style, and the scene cuts are tied to the module's order list so
 * they land on the music.
 */

import { V, CUBE, rotX, rotY, rotZ, sphere, torus, W, H } from "./engine.js";

const FOV = 260;
const CX = W / 2;
const CY = H / 2 - 6;

/* --------------------------------------------------------------- palettes */

export function buildPalette(vga) {
  vga.pal.fill(0);
  vga.setColor(0, 0, 0, 0);
  vga.setColor(1, 8, 8, 12);

  // 16..79: ember ramp, 80..143: toxic green, 144..207: ice blue
  ramp(vga, 16, 64, 63, 12, 2, 63, 55, 30); // fire
  ramp(vga, 80, 64, 2, 10, 1, 40, 63, 34); // green
  ramp(vga, 144, 64, 2, 6, 16, 34, 60, 63); // ice
  // 208..239: grey ramp, 240..255: white/UI
  for (let i = 0; i < 32; i++) {
    const k = i / 31;
    vga.setColor(208 + i, 4 + 59 * k, 4 + 59 * k, 6 + 59 * k);
  }
  for (let i = 0; i < 16; i++) vga.setColor(240 + i, 63, 63, 63 - i * 2);
}

function ramp(vga, base, n, r0, g0, b0, r1, g1, b1) {
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    vga.setColor(base + i, r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k);
  }
}

/* ------------------------------------------------------------------ utils */

function project(p, camZ) {
  const z = Math.max(0.05, p[2] + camZ);
  const s = FOV / z;
  return [CX + p[0] * s, CY - p[1] * s, z];
}

function faceNormal(v, face) {
  const a = v[face[0]], b = v[face[1]], c = v[face[2]];
  return V.norm(V.cross(V.sub(b, a), V.sub(c, a)));
}

/* --------------------------------------------------------------- 1. intro */

export function sceneIntro(vga, t, mod) {
  vga.clear(0);
  // copper bars, palette cycling on the fire ramp
  for (let y = 0; y < H; y++) {
    const w = Math.sin(y * 0.09 - t * 2.1) + Math.sin(y * 0.031 + t * 1.3);
    if (Math.abs(w) < 0.75) continue;
    const hue = (y + Math.floor(t * 40)) & 31;
    const c = 16 + ((hue * 2) % 64);
    vga.hline(0, W - 1, y, c);
  }
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
  const c = 208 + Math.floor(20 + pulse * 11);

  vga.text("COMPLEX", 118, 26, c, 22);
  flashText(vga, "PRESENTS", 108, 54, t, 12);
  const wob = Math.sin(t * 1.7) * 3;
  vga.text("D O P E", 76 + wob, 96, 208 + 28, 46);
  vga.text("the gathering 95", 96, 156, 208 + Math.floor(6 + 12 * pulse), 11);
  if (Math.floor(t * 2) % 2 === 0) vga.text("click to start", 108, 182, 240, 8);
  void mod;
}

function flashText(vga, str, x, y, t, size) {
  const on = Math.sin(t * 6) > -0.3;
  if (on) vga.text(str, x, y, 208 + Math.floor(20 + 20 * Math.abs(Math.sin(t * 3))), size);
}

/* ------------------------------------------------------- 2. boxes sketch */

function sceneBoxes(vga, t) {
  vga.clear(0);
  const camZ = 9.5;
  const rot = t * 0.6;
  const fly = (t * 1.6) % 3;
  for (let gx = -1; gx <= 1; gx++) {
    for (let gy = -1; gy <= 1; gy++) {
      for (let gz = -1; gz <= 1; gz++) {
        const centre = [gx * 3.1, gy * 3.1, gz * 3.1 + fly];
        const pts = CUBE.verts.map((p) => {
          let q = [p[0] * 0.42, p[1] * 0.42, p[2] * 0.42];
          q = rotX(q, rot * 0.7 + gx);
          q = rotY(q, rot + gy);
          q = rotZ(q, rot * 0.3 + gz);
          const w = [q[0] + centre[0], q[1] + centre[1], q[2] + centre[2]];
          return project(w, camZ);
        });
        const depth = Math.max(0, Math.min(1, 1 - (centre[2] + camZ) / 14));
        const c = 144 + Math.floor(depth * 60);
        for (const [a, b] of EDGES) vga.line(pts[a][0], pts[a][1], pts[b][0], pts[b][1], c);
      }
    }
  }
  vga.text("routine boxes sketch", 76, 4, 240, 10);
  vga.text("jugi", W - 46, H - 14, 208 + 6, 10);
}

const EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/* ------------------------------------------- 3. environment mapped object */

const TORUS = torus(1.05, 0.44, 22, 12);

function sceneEnv(vga, t) {
  vga.clear(0);
  for (let y = 0; y < H; y++) {
    const k = Math.abs(y - CY) / CY;
    if (k < 1) vga.hline(0, W - 1, y, 144 + Math.floor((1 - k) * 12));
  }
  vga.clear(0);

  const camZ = 3.6;
  const ax = t * 0.55;
  const ay = t * 0.9;
  const faces = [];
  for (const f of TORUS.faces) {
    const n = faceNormal(TORUS.verts, f);
    const world = f.map((i) => {
      let p = TORUS.verts[i];
      p = rotX(p, ax);
      p = rotY(p, ay);
      return p;
    });
    const nn = rotY(rotX(n, ax), ay);
    // environment lookup: a banded sphere map, like the original's env part
    const u = nn[0];
    const v = nn[1];
    const bands = Math.sin(u * 7 + t * 0.6) * Math.sin(v * 5 - t * 0.4);
    const col = 144 + Math.max(0, Math.min(60, Math.floor(30 + bands * 30)));
    const z = (world[0][2] + world[1][2] + world[2][2] + world[3][2]) / 4;
    if (z < -1.1) continue;
    faces.push({ world, col, z });
  }
  faces.sort((a, b) => a.z - b.z);
  for (const f of faces) {
    const p = f.world.map((v) => project(v, camZ));
    const light = 0.55 + 0.45 * Math.max(0, -f.world[1][1]);
    const c = Math.min(207, f.col + Math.floor(light * 10));
    vga.tri(p[0][0], p[0][1], p[1][0], p[1][1], p[2][0], p[2][1], c);
    vga.tri(p[0][0], p[0][1], p[2][0], p[2][1], p[3][0], p[3][1], c);
  }
  vga.text("environment map", 78, 4, 240, 10);
  vga.text("jugi", W - 46, H - 14, 208 + 6, 10);
}

/* ------------------------------------------------------- 4. shadow volume */

const SHADOW_OBJ = sphere(9, 14, 1);

function sceneShadow(vga, t) {
  vga.clear(0);
  // floor grid
  for (let i = 0; i <= 8; i++) {
    const z = 1.5 + i * 0.9;
    vga.hline(0, W - 1, Math.floor(CY + 26 + 160 / z), 208 + 1 + Math.floor(i * 1.2));
  }
  for (let i = -6; i <= 6; i++) {
    vga.line(CX + i * 12, CY + 26, CX + i * 46, H, 208 + 3);
  }

  const camZ = 4.2;
  const obj = SHADOW_OBJ.verts.map((p) => {
    let q = rotY(rotX(p, 0.6), t * 0.8);
    return [q[0], q[1] * 0.8 + 1.35, q[2]];
  });

  // light comes from above-left and moves; project onto y = 0.35 plane
  const light = [Math.cos(t * 0.7) * 2.4, 4.4, Math.sin(t * 0.7) * 2.4 + 1.5];
  const planeY = 0.35;
  const shadow = obj.map((p) => {
    const k = (p[1] - planeY) / (p[1] - light[1]);
    return [p[0] + (light[0] - p[0]) * k, planeY, p[2] + (light[2] - p[2]) * k];
  });

  for (const f of SHADOW_OBJ.faces) {
    const s = f.map((i) => project(shadow[i], camZ));
    if (s.some((p) => p[2] <= 0.1)) continue;
    const c = 208 + 1 + (f[0] % 3);
    vga.tri(s[0][0], s[0][1], s[1][0], s[1][1], s[2][0], s[2][1], c);
  }

  const faces = SHADOW_OBJ.faces
    .map((f) => ({
      f,
      z: (obj[f[0]][2] + obj[f[1]][2] + obj[f[2]][2]) / 3,
      n: faceNormal(obj, f),
    }))
    .sort((a, b) => a.z - b.z);

  for (const { f, n } of faces) {
    const p = f.map((i) => project(obj[i], camZ));
    const lum = Math.max(0, V.dot(n, V.norm([light[0], light[1], light[2]])));
    const c = 144 + 6 + Math.floor(lum * 50);
    vga.tri(p[0][0], p[0][1], p[1][0], p[1][1], p[2][0], p[2][1], c);
  }
  vga.text("shadow volume", 84, 4, 240, 10);
  vga.text("cat figure", 8, H - 14, 208 + 5, 10);
}

/* ------------------------------------------------------ 5. world domination */

const GLOBE = sphere(10, 16, 1.15);
const LAND = (() => {
  // cheap procedural continents: sum of plane waves, the same trick the
  // original used for its shaded world polygon object
  const land = [];
  for (let i = 0; i < 4000; i++) land.push(null);
  return (p) => {
    const n =
      Math.sin(p[0] * 2.1 + 1.3) * Math.cos(p[2] * 2.4) +
      Math.sin(p[1] * 3.3 - 0.7) * 0.8 +
      Math.cos(p[0] * 4.2 + p[2] * 3.1) * 0.6;
    return n > 0.35;
  };
})();

function sceneGlobe(vga, t) {
  vga.clear(0);
  const camZ = 4.4;
  const rot = t * 0.45;
  const pts = GLOBE.verts.map((p) => project(rotY(p, rot), camZ));

  const faces = GLOBE.faces
    .map((f) => ({
      f,
      z: (GLOBE.verts[f[0]][2] + GLOBE.verts[f[1]][2] + GLOBE.verts[f[2]][2]) / 3,
    }))
    .sort((a, b) => a.z - b.z);

  for (const { f } of faces) {
    const a = GLOBE.verts[f[0]];
    const b = GLOBE.verts[f[1]];
    const c = GLOBE.verts[f[2]];
    const mid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const isLand = LAND(mid);
    const n = faceNormal(GLOBE.verts, f);
    const light = Math.max(0.15, V.dot(rotY(n, rot), V.norm([-0.6, 0.8, 0.5])));
    const col = isLand
      ? 80 + Math.floor(light * 50)
      : 144 + 4 + Math.floor(light * 46);
    const p = f.map((i) => pts[i]);
    vga.tri(p[0][0], p[0][1], p[1][0], p[1][1], p[2][0], p[2][1], col);
  }
  vga.text("world domination", 74, 4, 240, 11);
  vga.text("m. hakulinen", 8, H - 14, 208 + 8, 9);
}

/* ----------------------------------------------------------- 6. end scroll */

const CREDITS = [
  "DOPE",
  "",
  "by COMPLEX",
  "",
  "code          jmagic",
  "graphics      jugi",
  "music         jugi",
  "replay        phantom/sonic pc",
  "              (gus unit raped by jmagic)",
  "",
  "routine boxes sketch   jugi",
  "boxes pixelled by      reward",
  "media labs logo        reward",
  "",
  "3d objects",
  "",
  "credits part           jugi",
  "7800 polys             m. hakulinen",
  "environment map        jugi",
  "shadow volume          cat figure",
  "world domination       m. hakulinen",
  "",
  "greetings to everyone at",
  "THE GATHERING 95",
  "",
  "sorry we ran out of time",
  "and the end scroll never",
  "got its graphics :)",
  "",
  "complex@hut.fi",
];

function sceneCredits(vga, t) {
  vga.clear(0);
  for (let y = 0; y < H; y++) {
    const k = y / H;
    if ((y + Math.floor(t * 30)) % 3 === 0) vga.hline(0, W - 1, y, 144 + Math.floor(k * 40));
  }
  const speed = 26;
  const y0 = H - ((t * speed) % (CREDITS.length * 11 + H));
  for (let i = 0; i < CREDITS.length; i++) {
    const y = y0 + i * 11;
    if (y < -12 || y > H) continue;
    const line = CREDITS[i];
    const wob = Math.sin(t * 1.5 + i * 0.6) * 6;
    vga.text(line, (W - line.length * 5.4) / 2 + wob, Math.floor(y), 240, 8);
  }
}

/* --------------------------------------------------------------- sequence */

const SCENES = [
  { name: "intro", draw: sceneIntro },
  { name: "boxes", draw: sceneBoxes },
  { name: "envmap", draw: sceneEnv },
  { name: "shadow", draw: sceneShadow },
  { name: "globe", draw: sceneGlobe },
  { name: "credits", draw: sceneCredits },
];

export { SCENES };

/**
 * Pick the scene from the module's order, so cuts follow the music.  An order
 * is 64 rows of speed 6 at 125 bpm, about 7.7 seconds, so a part lasts six
 * orders (~46 s) and the five effects cycle; the end scroll takes over for the
 * last part of the tune.
 */
export function sceneForOrder(order, totalOrders = 124) {
  if (order >= totalOrders - 18) return SCENES[SCENES.length - 1];
  return SCENES[Math.floor(order / 6) % (SCENES.length - 1)];
}
