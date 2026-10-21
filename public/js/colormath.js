// Colour maths shared by the WebGL preview (colorgl.js) and the FFmpeg renderer (engine/color.mjs).
// Change it here and both stay identical.
//
// color = { lut, exposure, temp, tint, contrast, pivot, saturation, lift/gamma/gain/offset: { y, r, g, b } }
// Per pixel (RGB 0..1): LUT -> v*2^exposure*wb[ch] -> (v-pivot)*contrast+pivot -> v*gain + lift*(1-v) + offset
//                       -> clamp^(1/gamma) -> saturation around Rec.709 luma
export const LUMA = [0.2126, 0.7152, 0.0722];
const n = (x, d = 0) => (Number.isFinite(+x) ? +x : d);
export const wheel = (w = {}) => ({ y: n(w.y), r: n(w.r), g: n(w.g), b: n(w.b) });

export function isNeutral(c) {
  if (!c) return true;
  c = activeGrade(c);
  const ws = ['lift', 'gamma', 'gain', 'offset'].every((k) => { const w = wheel(c[k]); return !w.y && !w.r && !w.g && !w.b; });
  return ws && !hasCurves(c) && !c.lut && !n(c.exposure) && !n(c.temp) && !n(c.tint) && n(c.contrast, 1) === 1 && n(c.saturation, 1) === 1 && !hasPost(c) && !hasVig(c) && !n(c.sharpen);
}

// White balance as channel gains: warm = more red / less blue, magenta = less green.
export function wbGains(c) {
  const t = n(c.temp), ti = n(c.tint);
  return { r: (1 + 0.12 * t) * (1 + 0.04 * ti), g: 1 - 0.08 * ti, b: (1 - 0.12 * t) * (1 + 0.04 * ti) };
}

export function channelParams(c, ch) {
  const L = wheel(c.lift), G = wheel(c.gamma), Gn = wheel(c.gain), O = wheel(c.offset);
  return {
    mul: Math.pow(2, n(c.exposure)) * wbGains(c)[ch],
    contrast: n(c.contrast, 1), pivot: n(c.pivot, 0.435),
    gain: Math.max(0, 1 + Gn.y + Gn[ch]),
    lift: L.y + L[ch],
    offset: O.y + O[ch],
    gamma: Math.max(0.1, 1 + G.y + G[ch]),
  };
}

export function transfer(v, p) {
  v = (v * p.mul - p.pivot) * p.contrast + p.pivot;
  v = v * p.gain + p.lift * (1 - v) + p.offset;
  return Math.pow(Math.min(1, Math.max(0, v)), 1 / p.gamma);
}

// Colour-wheel puck <-> per-channel deltas. Hue angle 0 = red, 120 = green, 240 = blue (zero-sum, keeps brightness).
export function wheelToRGB(angleRad, amount) {
  return { r: amount * Math.cos(angleRad), g: amount * Math.cos(angleRad - (2 * Math.PI) / 3), b: amount * Math.cos(angleRad - (4 * Math.PI) / 3) };
}
export function rgbToWheel(w) {
  const x = w.r - (w.g + w.b) / 2, y = ((w.g - w.b) * Math.sqrt(3)) / 2;
  return { angle: Math.atan2(y, x), amount: Math.hypot(x, y) / 1.5 };
}

export function parseCube(text) {
  let size = 0, min = [0, 0, 0], max = [1, 1, 1];
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l[0] === '#') continue;
    if (l.startsWith('LUT_3D_SIZE')) size = +l.split(/\s+/)[1];
    else if (l.startsWith('DOMAIN_MIN')) min = l.split(/\s+/).slice(1).map(Number);
    else if (l.startsWith('DOMAIN_MAX')) max = l.split(/\s+/).slice(1).map(Number);
    else if (/^[-\d.eE+]+\s+[-\d.eE+]+\s+[-\d.eE+]+$/.test(l)) vals.push(...l.split(/\s+/).map(Number));
  }
  if (!size || vals.length < size ** 3 * 3) throw new Error('Not a 3D .cube LUT');
  return { size, min, max, data: Float32Array.from(vals.slice(0, size ** 3 * 3)) };
}

// ---- Curves (Lumetri-style), applied after saturation ----
// color.curves = { m, r, g, b: [[x, y], ...] }   RGB curves, points 0..1 (no points = straight line). Channel first, then master.
// color.hue    = { hh, hs, hl, ls, ss: [[x, y], ...] }   y 0.5 = no change. Hue vs Hue (±180°), Hue vs Sat (0..2x),
//                Hue vs Luma (±0.5 brightness), Luma vs Sat, Sat vs Sat (0..2x). Hue curves wrap around.
export const CURVES = ['m', 'r', 'g', 'b'], HUES = ['hh', 'hs', 'hl', 'ls', 'ss'], CN = 256;
const pts = (a) => (Array.isArray(a) ? a.filter((p) => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1])).map((p) => [+p[0], +p[1]]) : []);
export function hasCurves(c) {
  return !!c && (CURVES.some((k) => pts(c.curves?.[k]).length) || HUES.some((k) => pts(c.hue?.[k]).length));
}
// monotone cubic (Fritsch-Carlson): smooth, never overshoots between points
function mono(P) {
  const n = P.length, d = [], m = [];
  for (let i = 0; i < n - 1; i++) d.push((P[i + 1][1] - P[i][1]) / Math.max(1e-6, P[i + 1][0] - P[i][0]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (!d[i]) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= P[0][0]) return P[0][1];
    if (x >= P[n - 1][0]) return P[n - 1][1];
    let i = 0; while (x > P[i + 1][0]) i++;
    const h = P[i + 1][0] - P[i][0], t = (x - P[i][0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * P[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * P[i + 1][1] + (t3 - t2) * h * m[i + 1];
  };
}
// one curve -> CN samples. kind 'rgb': ends at (0,0)/(1,1) unless moved; 'flat': ends at y 0.5; 'wrap': hue, loops around
export function curveTable(points, kind = 'rgb') {
  let P = pts(points).sort((a, b) => a[0] - b[0]);
  const out = new Float32Array(CN);
  if (!P.length) { for (let i = 0; i < CN; i++) out[i] = kind === 'rgb' ? i / (CN - 1) : 0.5; return out; }
  if (kind === 'wrap') P = [...P.map(([x, y]) => [x - 1, y]), ...P, ...P.map(([x, y]) => [x + 1, y])];
  else {
    const e = kind === 'rgb' ? [0, 1] : [0.5, 0.5];
    if (P[0][0] > 0.001) P.unshift([0, e[0]]);
    if (P[P.length - 1][0] < 0.999) P.push([1, e[1]]);
  }
  const f = mono(P);
  for (let i = 0; i < CN; i++) out[i] = Math.min(1, Math.max(0, f(i / (kind === 'wrap' ? CN : CN - 1))));
  return out;
}
// all 9 tables, rows in this order: m r g b hh hs hl ls ss
export function curveTables(c) {
  return [...CURVES.map((k) => curveTable(c?.curves?.[k], 'rgb')), ...HUES.map((k) => curveTable(c?.hue?.[k], ['hh', 'hs', 'hl'].includes(k) ? 'wrap' : 'flat'))];
}
const look = (t, x, wrap) => {
  if (wrap) { x = ((x % 1) + 1) % 1; const f = x * CN, i = Math.floor(f) % CN, j = (i + 1) % CN, k = f - Math.floor(f); return t[i] * (1 - k) + t[j] * k; }
  const f = Math.min(1, Math.max(0, x)) * (CN - 1), i = Math.floor(f), j = Math.min(CN - 1, i + 1), k = f - i; return t[i] * (1 - k) + t[j] * k;
};
// one pixel through the curves (the WebGL preview in colorgl.js does exactly this)
export function applyCurves(rgb, T) {
  let [r, g, b] = rgb;
  r = look(T[0], look(T[1], r)); g = look(T[0], look(T[2], g)); b = look(T[0], look(T[3], b));
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) h = (mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  h = (h + 1) % 1;
  let s = mx > 1e-6 ? d / mx : 0, v = mx;
  const l = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
  const sk = 2 * look(T[5], h, true) * 2 * look(T[7], l) * 2 * look(T[8], s);
  const nh = h + (look(T[4], h, true) - 0.5);
  v = v * (1 + (look(T[6], h, true) - 0.5) * s);
  s = Math.min(1, Math.max(0, s * sk));
  // HSV -> RGB
  const hh = (((nh % 1) + 1) % 1) * 6, c = v * s, x = c * (1 - Math.abs((hh % 2) - 1)), m = v - c;
  const [a1, a2, a3] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return [a1 + m, a2 + m, a3 + m].map((u) => Math.min(1, Math.max(0, u)));
}

// ---- Lumetri sections (Premiere's Lumetri Color panel): each can be switched off (color.off = { basic: true, … }) ----
// basic     LUT, white balance, exposure, contrast, highlights / shadows / whites / blacks, saturation
// creative  look LUT + intensity, faded film, sharpen, vibrance, saturation, shadow / highlight tint
// curves    RGB + hue/saturation curves          wheels  lift / gamma / gain / offset
// hsl       HSL secondary: a colour range keyed out and corrected on its own
// vignette  darker / lighter edges (amount, midpoint, roundness, feather)
export const SECTION_KEYS = {
  basic: ['lut', 'exposure', 'temp', 'tint', 'contrast', 'pivot', 'saturation', 'highlights', 'shadows', 'whites', 'blacks'],
  creative: ['look', 'lookAmt', 'faded', 'sharpen', 'vibrance', 'csat', 'shTint', 'hiTint', 'tintBal'],
  curves: ['curves', 'hue'], wheels: ['lift', 'gamma', 'gain', 'offset'], hsl: ['hsl'], vignette: ['vig'],
};
// the grade with switched-off sections left out (everything that draws or renders uses this)
export function activeGrade(c) {
  if (!c?.off) return c;
  const x = { ...c };
  for (const [s, keys] of Object.entries(SECTION_KEYS)) if (c.off[s]) for (const k of keys) delete x[k];
  delete x.off;
  return x;
}
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / ((b - a) || 1e-6))); return t * t * (3 - 2 * t); };
const hexRgb = (h) => { const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(h || ''); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [0.5, 0.5, 0.5]; };
const nn = (x, d = 0) => (Number.isFinite(+x) ? +x : d);
export const hasTone = (c) => !!c && ['highlights', 'shadows', 'whites', 'blacks'].some((k) => nn(c[k]));
export const hasCreative = (c) => !!c && (!!c.look || nn(c.faded) || nn(c.vibrance) || nn(c.csat, 1) !== 1 || nn(c.shTint?.amt) || nn(c.hiTint?.amt));
export const hasHsl = (c) => !!c?.hsl && (nn(c.hsl.temp) || nn(c.hsl.tint) || nn(c.hsl.exposure) || nn(c.hsl.contrast) || nn(c.hsl.sat2, 1) !== 1 || nn(c.hsl.hueShift) || c.hsl.show);
export const hasVig = (c) => !!c?.vig && nn(c.vig.amount) !== 0;
// everything after saturation that is per pixel: baked into one 3D LUT (render) / one 3D texture (preview)
export const hasPost = (c) => !!c && (hasTone(c) || hasCreative(c) || hasCurves(c) || hasHsl(c));
export const HSL_DEF = { hue: 0.08, width: 0.12, sat: [0.12, 1], luma: [0.05, 0.95], soft: 0.08, temp: 0, tint: 0, exposure: 0, contrast: 0, sat2: 1, hueShift: 0 };
// a .cube sampler (trilinear) - for the creative look LUT
export function cubeSampler(cube) {
  const { size: n, data, min, max } = cube;
  const at = (r, g, b, ch) => data[3 * (r + n * (g + n * b)) + ch];
  return (rgb) => {
    const p = rgb.map((v, i) => Math.min(n - 1, Math.max(0, ((v - min[i]) / (max[i] - min[i])) * (n - 1))));
    const i0 = p.map(Math.floor), i1 = i0.map((v) => Math.min(n - 1, v + 1)), f = p.map((v, i) => v - i0[i]), out = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) { let v = 0; for (let k = 0; k < 8; k++) { const w = (k & 1 ? f[0] : 1 - f[0]) * (k & 2 ? f[1] : 1 - f[1]) * (k & 4 ? f[2] : 1 - f[2]); v += w * at(k & 1 ? i1[0] : i0[0], k & 2 ? i1[1] : i0[1], k & 4 ? i1[2] : i0[2], ch); } out[ch] = v; }
    return out;
  };
}
function rgb2hsv([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0; if (d > 1e-6) h = (mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  return [(h + 1) % 1, mx > 1e-6 ? d / mx : 0, mx];
}
function hsv2rgb(h, s, v) {
  const hh = (((h % 1) + 1) % 1) * 6, c = v * s, x = c * (1 - Math.abs((hh % 2) - 1)), m = v - c;
  const [a, b, d] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return [a + m, b + m, d + m];
}
const lumaOf = (p) => LUMA[0] * p[0] + LUMA[1] * p[1] + LUMA[2] * p[2];
const satAround = (p, k) => { const l = lumaOf(p); return p.map((v) => l + (v - l) * k); };
// HSL secondary: how much (0..1) a pixel belongs to the keyed colour range
export function hslKey(rgb, H) {
  const [h, s] = rgb2hsv(rgb), l = lumaOf(rgb), soft = Math.max(0.005, nn(H.soft, 0.08));
  const dh = Math.min(Math.abs(h - nn(H.hue)), 1 - Math.abs(h - nn(H.hue))), half = nn(H.width, 0.12) / 2;
  const kh = 1 - sm(half, half + soft, dh);
  const rng = (v, [a, b]) => sm(a - soft, a + soft, v) * (1 - sm(b - soft, b + soft, v));
  return kh * rng(s, H.sat || [0, 1]) * rng(l, H.luma || [0, 1]);
}
// the per-pixel post stage: tone → creative → curves → HSL secondary. opts.look = sampler of the look LUT
export function postFn(c, opts = {}) {
  const T = hasCurves(c) ? curveTables(c) : null, tone = hasTone(c), cr = hasCreative(c), H = hasHsl(c) ? { ...HSL_DEF, ...c.hsl } : null;
  const sh = c.shTint ? { col: hexRgb(c.shTint.color), amt: nn(c.shTint.amt) } : null, hi = c.hiTint ? { col: hexRgb(c.hiTint.color), amt: nn(c.hiTint.amt) } : null;
  const bal = nn(c.tintBal), lookAmt = nn(c.lookAmt, 1);
  return (rgb) => {
    let p = rgb.map((v) => Math.min(1, Math.max(0, v)));
    if (tone) {
      const l = lumaOf(p), d = 0.25 * (nn(c.highlights) * sm(0.35, 1, l) + nn(c.shadows) * (1 - sm(0, 0.6, l))) + 0.15 * (nn(c.whites) * sm(0.65, 1, l) + nn(c.blacks) * (1 - sm(0, 0.3, l)));
      p = p.map((v) => v + d);
    }
    if (cr) {
      if (c.look && opts.look) { const q = opts.look(p.map((v) => Math.min(1, Math.max(0, v)))); p = p.map((v, i) => v + (q[i] - v) * lookAmt); }
      const f = nn(c.faded); if (f) p = p.map((v) => 0.12 * f + v * (1 - 0.18 * f));
      const vb = nn(c.vibrance); if (vb) { const s = Math.max(...p) - Math.min(...p); p = satAround(p, 1 + vb * (1 - Math.min(1, s))); }
      const cs = nn(c.csat, 1); if (cs !== 1) p = satAround(p, cs);
      const l = lumaOf(p), wS = Math.max(0, 1 - l * 1.6 + bal * 0.5), wH = Math.max(0, l * 1.6 - 0.6 + bal * 0.5);
      for (const [t, w] of [[sh, wS], [hi, wH]]) if (t?.amt) { const tl = lumaOf(t.col); p = p.map((v, i) => v + (t.col[i] - tl) * t.amt * Math.min(1, w)); }
    }
    p = p.map((v) => Math.min(1, Math.max(0, v)));
    if (T) p = applyCurves(p, T);
    if (H) {
      const k = hslKey(p, H);
      if (H.show) return [k, k, k]; // (preview only: shows the key as black & white)
      if (k > 0) {
        let q = [...p];
        const wb = wbGains({ temp: H.temp, tint: H.tint }), m = Math.pow(2, nn(H.exposure));
        q = [q[0] * wb.r * m, q[1] * wb.g * m, q[2] * wb.b * m];
        const ct = 1 + nn(H.contrast); if (ct !== 1) q = q.map((v) => (v - 0.5) * ct + 0.5);
        if (nn(H.hueShift)) { const [h, s, v] = rgb2hsv(q.map((x) => Math.min(1, Math.max(0, x)))); q = hsv2rgb(h + nn(H.hueShift) / 360, s, v); }
        if (nn(H.sat2, 1) !== 1) q = satAround(q, nn(H.sat2, 1));
        p = p.map((v, i) => v + (q[i] - v) * k);
      }
    }
    return p.map((v) => Math.min(1, Math.max(0, v)));
  };
}
// vignette (u, v = 0..1 across / down the frame; aspect = W / H). The same formula is in the shader and the ffmpeg geq.
// roundness 0 = the frame's shape, 1 = a circle; d = 1 at the corners. Returns f: < 0 darkens (v * (1 + f)),
// > 0 lightens (v + (1 - v) * f).
export function vigFactor(V, u, v, aspect) {
  const k = Math.pow(aspect, Math.min(1, Math.max(-1, nn(V.round)))), x = (u - 0.5) * 2 * k, y = (v - 0.5) * 2;
  const d = Math.hypot(x, y) / Math.hypot(k, 1), mid = nn(V.mid, 0.5), fe = Math.max(0.02, nn(V.feather, 0.5));
  return sm(mid - fe / 2, mid + fe / 2, d) * Math.max(-1, Math.min(1, nn(V.amount)));
}
export const vigApply = (val, f) => (f < 0 ? val * (1 + f) : val + (1 - val) * f);
