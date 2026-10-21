// looklut.mjs - cinematic "look" LUTs, written into LUTs/Looks. A look goes over the WHOLE edit (after each shot has
// been balanced by auto colour), so every shot ends up with the same film colour - the thing that makes an edit feel
// like one movie instead of a pile of clips. Pure maths, no downloads; regenerated when the recipe version changes.
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 3, N = 33;
const clamp = (x) => Math.min(1, Math.max(0, x));
const Y = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const scurve = (x, a) => x * (1 - a) + a * (x * x * (3 - 2 * x));
const mix = (a, b, t) => a + (b - a) * t;

// recipe: { exp, s (contrast S-curve 0..0.6), matte (lifted blacks), roll (highlight roll-off), sat, shadows / mids / highs [r,g,b] tints,
//           teal (pull greens/blues towards teal), skin (protect + warm orange hues), vib (saturate the dull colours more) }
export const LOOKS = {
  'Teal & Orange': { s: 0.5, matte: 0.02, roll: 0.25, sat: 1.12, shadows: [-0.07, 0.015, 0.075], highs: [0.07, 0.025, -0.065], teal: 0.8, skin: 0.5 },
  'Warm Film': { s: 0.38, matte: 0.045, roll: 0.35, sat: 0.9, shadows: [0.005, 0.0, 0.02], mids: [0.02, 0.008, -0.015], highs: [0.04, 0.02, -0.035], skin: 0.3 },
  'Golden Hour': { exp: 1.03, s: 0.34, roll: 0.3, sat: 1.06, mids: [0.035, 0.015, -0.035], highs: [0.07, 0.035, -0.06], shadows: [0.01, -0.005, 0.01] },
  'Moody Dark': { exp: 0.84, s: 0.55, matte: 0.03, roll: 0.3, sat: 0.74, shadows: [-0.035, 0.012, 0.04], highs: [0.02, 0.01, -0.01], teal: 0.35 },
  'Travel Vivid': { s: 0.36, roll: 0.2, sat: 1.32, vib: 0.5, highs: [0.015, 0.008, -0.01], teal: 0.15 },
  'Indian Heritage': { s: 0.44, matte: 0.02, roll: 0.3, sat: 1.2, vib: 0.3, shadows: [0.015, -0.005, -0.01], mids: [0.025, 0.006, -0.025], highs: [0.04, 0.025, -0.03], skin: 0.4 },
  'Bleach Bypass': { s: 0.55, roll: 0.15, sat: 0.55, shadows: [-0.01, 0, 0.01], highs: [0.01, 0.01, 0] },
  'Clean Natural': { s: 0.22, roll: 0.2, sat: 1.08, vib: 0.15 },
};
export const lookFile = (name) => `${name} (look).cube`;

function hueOf([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 1e-6) return { h: 0, s: 0 };
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: d / Math.max(mx, 1e-6) };
}
const near = (h, c, w) => Math.max(0, 1 - Math.abs(((h - c + 540) % 360) - 180) / w);

export function applyLook(rgb, L) {
  let v = rgb.map((x) => x * (L.exp ?? 1));
  // contrast S-curve on luminance (keeps hues), then the highlight roll-off and matte blacks
  const y0 = Y(v), y1 = scurve(clamp(y0), L.s || 0), k = y0 > 1e-4 ? y1 / y0 : 1;
  v = v.map((x) => x * k);
  // soft highlight shoulder above 80% (whites stop just short of clipping, like film)
  if (L.roll) v = v.map((x) => (x > 0.8 ? 0.8 + (x - 0.8) * (1 - L.roll * 0.5 * Math.min(1, (x - 0.8) / 0.2)) : x));
  if (L.matte) v = v.map((x) => L.matte + (1 - L.matte) * x);
  // split toning by brightness
  const y = clamp(Y(v)), ws = (1 - y) ** 2, wh = y ** 2, wm = 1 - ws - wh;
  for (let i = 0; i < 3; i++) v[i] += (L.shadows?.[i] || 0) * ws * 1.6 + (L.mids?.[i] || 0) * wm * 1.4 + (L.highs?.[i] || 0) * wh * 1.6;
  // hue work: greens/blues towards teal, orange skin tones protected and warmed
  const { h, s } = hueOf(v.map(clamp)), yy = Y(v);
  if (L.teal) {
    const g = near(h, 120, 60) * L.teal, bl = near(h, 220, 50) * L.teal;
    if (g) v = [v[0] * (1 - 0.18 * g), v[1] * (1 - 0.05 * g), v[2] + (v[1] - v[2]) * 0.35 * g];
    if (bl) v = [v[0] * (1 - 0.1 * bl), v[1] + (v[2] - v[1]) * 0.2 * bl, v[2]];
  }
  // saturation (vibrance pushes the dull colours more than the strong ones), skin kept natural
  const skin = near(h, 28, 25) * (L.skin || 0);
  const sat = (L.sat ?? 1) * (1 + (L.vib || 0) * (1 - Math.min(1, s * 1.6))) * (1 - 0.25 * skin) + 0.12 * skin;
  v = v.map((x) => mix(yy, x, sat));
  if (skin) v = [v[0] + 0.015 * skin, v[1] + 0.005 * skin, v[2] - 0.012 * skin];
  return v.map(clamp);
}

export function ensureLooks(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = path.join(dir, `.version-${VERSION}`);
  if (fs.existsSync(stamp) && Object.keys(LOOKS).every((n) => fs.existsSync(path.join(dir, lookFile(n))))) return;
  for (const [name, L] of Object.entries(LOOKS)) {
    const lines = [`TITLE "${name}"`, `LUT_3D_SIZE ${N}`];
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++)
      lines.push(applyLook([r / (N - 1), g / (N - 1), b / (N - 1)], L).map((x) => x.toFixed(6)).join(' '));
    fs.writeFileSync(path.join(dir, lookFile(name)), `${lines.join('\n')}\n`);
  }
  fs.writeFileSync(stamp, '');
}
