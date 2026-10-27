// ◯ ▭ Masks, like Premiere's: an ellipse or a rectangle on the picture that limits where something shows.
//   effect.mask - the effect shows only inside it (blur a face, brighten a sky)
//   clip.omask  - the clip shows only inside it (Opacity mask; on V1 the rest is black, on V2+ the shot below shows)
// mask = { shape: 'ellipse' | 'rect' | 'pen' | 'gradient', x, y (centre), w, h (size) as fractions of the frame,
//          feather, expand (px of a 1920-wide frame), opacity 0..1, invert,
//          pen: pts [[x, y], ...] (a closed shape drawn point by point), gradient: x0, y0 (fully seen) -> x1, y1 (gone) }
// The mask belongs to the clip's picture: Motion (position / scale) moves it along with the picture.
// One maths for the viewer (a small picture used as a CSS mask) and the render (a PNG laid in with FFmpeg's alphamerge).

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const MASK_SHAPES = [['ellipse', 'Ellipse'], ['rect', 'Rectangle'], ['pen', 'Pen (draw)'], ['gradient', 'Gradient']];
export const newMask = (shape = 'ellipse') => ({ shape, x: 0.5, y: 0.5, w: shape === 'ellipse' ? 0.32 : 0.4, h: shape === 'ellipse' ? 0.5 : 0.4, feather: shape === 'pen' ? 12 : 40, expand: 0, opacity: 1, invert: false,
  ...(shape === 'pen' ? { pts: [[0.35, 0.3], [0.65, 0.3], [0.7, 0.7], [0.3, 0.7]] } : {}), ...(shape === 'gradient' ? { x0: 0.5, y0: 0.3, x1: 0.5, y1: 0.8, feather: 0 } : {}) });
export const maskName = (m) => ({ rect: 'Rectangle', pen: 'Pen', gradient: 'Gradient' }[m?.shape] || 'Ellipse');

// how much of the picture shows at each pixel, 0..255, for a W x H frame
export function maskAlpha(m, W, H) {
  if (m.shape === 'pen') return penAlpha(m, W, H);
  if (m.shape === 'gradient') return gradAlpha(m, W, H);
  const out = new Uint8Array(W * H), k = W / 1920;
  const fe = Math.max(0.75, (+m.feather || 0) * k), ex = (+m.expand || 0) * k, op = clamp(m.opacity ?? 1, 0, 1);
  const cx = (m.x ?? 0.5) * W, cy = (m.y ?? 0.5) * H, rx = Math.max(1, ((m.w ?? 0.3) * W) / 2), ry = Math.max(1, ((m.h ?? 0.3) * H) / 2);
  const ell = m.shape !== 'rect';
  for (let y = 0; y < H; y++) {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx;
      let d; // distance to the edge in px (negative inside)
      if (ell) {
        const q = Math.hypot(dx / rx, dy / ry);
        const g = q > 1e-6 ? Math.hypot(dx / (rx * rx), dy / (ry * ry)) / q : 1 / Math.min(rx, ry);
        d = (q - 1) / g;
      } else {
        const qx = Math.abs(dx) - rx, qy = Math.abs(dy) - ry;
        d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
      }
      let a = clamp(0.5 - (d - ex) / fe, 0, 1);
      if (m.invert) a = 1 - a;
      out[y * W + x] = Math.round(a * op * 255);
    }
  }
  return out;
}

// ✒ pen: the shape filled (scanlines through pixel centres), grown / shrunk by Expansion, softened by Feather (a blur)
function penAlpha(m, W, H) {
  const out = new Uint8Array(W * H), k = W / 1920, pts = (m.pts || []).filter((p) => Array.isArray(p) && p.length >= 2);
  const op = clamp(m.opacity ?? 1, 0, 1);
  if (pts.length >= 3) {
    let P = pts.map(([x, y]) => [x * W, y * H]);
    const ex = (+m.expand || 0) * k;
    if (ex) { const cx = P.reduce((a, p) => a + p[0], 0) / P.length, cy = P.reduce((a, p) => a + p[1], 0) / P.length; P = P.map(([x, y]) => { const d = Math.hypot(x - cx, y - cy) || 1; return [x + ((x - cx) / d) * ex, y + ((y - cy) / d) * ex]; }); }
    const xs = [];
    for (let y = 0; y < H; y++) {
      const yc = y + 0.5; xs.length = 0;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xa, ya] = P[i], [xb, yb] = P[j]; if ((ya > yc) !== (yb > yc)) xs.push(xa + ((yc - ya) * (xb - xa)) / (yb - ya)); }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) { const a = Math.max(0, Math.round(xs[q])), b = Math.min(W, Math.round(xs[q + 1])); out.fill(255, y * W + a, y * W + b); }
    }
    const r = Math.round(((+m.feather || 0) * k) / 2);
    if (r > 0) { boxBlur(out, W, H, r); boxBlur(out, W, H, r); }
  }
  for (let i = 0; i < out.length; i++) { let a = out[i] / 255; if (m.invert) a = 1 - a; out[i] = Math.round(a * op * 255); }
  return out;
}
// one box blur pass, rows then columns (a running sum: fast whatever the radius)
function boxBlur(a, W, H, r) {
  const tmp = new Float32Array(Math.max(W, H)), n = 2 * r + 1;
  for (let y = 0; y < H; y++) { const o = y * W; let s = 0; for (let x = -r; x <= r; x++) s += a[o + clamp(x, 0, W - 1)]; for (let x = 0; x < W; x++) { tmp[x] = s / n; s += a[o + clamp(x + r + 1, 0, W - 1)] - a[o + clamp(x - r, 0, W - 1)]; } for (let x = 0; x < W; x++) a[o + x] = tmp[x]; }
  for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += a[clamp(y, 0, H - 1) * W + x]; for (let y = 0; y < H; y++) { tmp[y] = s / n; s += a[clamp(y + r + 1, 0, H - 1) * W + x] - a[clamp(y - r, 0, H - 1) * W + x]; } for (let y = 0; y < H; y++) a[y * W + x] = tmp[y]; }
}
// ▤ gradient: fully seen at (x0, y0), fading smoothly to nothing at (x1, y1); straight across, like Premiere's ramp
function gradAlpha(m, W, H) {
  const out = new Uint8Array(W * H), op = clamp(m.opacity ?? 1, 0, 1);
  const x0 = (m.x0 ?? 0.5) * W, y0 = (m.y0 ?? 0.3) * H, dx = (m.x1 ?? 0.5) * W - x0, dy = (m.y1 ?? 0.8) * H - y0, L2 = dx * dx + dy * dy || 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = clamp(((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / L2, 0, 1);
    let a = 1 - u * u * (3 - 2 * u); // (smoothstep)
    if (m.invert) a = 1 - a;
    out[y * W + x] = Math.round(a * op * 255);
  }
  return out;
}

// the mask where it is seen on the frame once Motion has moved / scaled the picture (rotation is left out)
const mvX = (v, z, X) => +(0.5 + (v - 0.5) * z + X).toFixed(5), unX = (v, z, X) => +(0.5 + (v - 0.5 - X) / z).toFixed(5);
export function movedMask(m, t = {}) {
  const z = +t.zoom || 1, X = (+t.x || 0) / 100, Y = (+t.y || 0) / 100;
  return { ...m, x: 0.5 + ((m.x ?? 0.5) - 0.5) * z + X, y: 0.5 + ((m.y ?? 0.5) - 0.5) * z + Y, w: (m.w ?? 0.3) * z, h: (m.h ?? 0.3) * z, feather: (+m.feather || 0) * z, expand: (+m.expand || 0) * z,
    ...(m.pts ? { pts: m.pts.map(([x, y]) => [mvX(x, z, X), mvX(y, z, Y)]) } : {}),
    ...(m.shape === 'gradient' ? { x0: mvX(m.x0 ?? 0.5, z, X), y0: mvX(m.y0 ?? 0.3, z, Y), x1: mvX(m.x1 ?? 0.5, z, X), y1: mvX(m.y1 ?? 0.8, z, Y) } : {}) };
}
// and back: a mask drawn on the frame -> the picture's own
export function unmovedMask(m, t = {}) {
  const z = +t.zoom || 1, X = (+t.x || 0) / 100, Y = (+t.y || 0) / 100;
  return { ...m, x: 0.5 + ((m.x ?? 0.5) - 0.5 - X) / z, y: 0.5 + ((m.y ?? 0.5) - 0.5 - Y) / z, w: (m.w ?? 0.3) / z, h: (m.h ?? 0.3) / z,
    ...(m.pts ? { pts: m.pts.map(([x, y]) => [unX(x, z, X), unX(y, z, Y)]) } : {}),
    ...(m.shape === 'gradient' ? { x0: unX(m.x0, z, X), y0: unX(m.y0, z, Y), x1: unX(m.x1, z, X), y1: unX(m.y1, z, Y) } : {}) };
}

export const hasMask = (o) => !!(o?.mask?.shape || o?.omask?.shape);
export const maskKey = (m) => JSON.stringify([m.shape, m.x, m.y, m.w, m.h, m.feather, m.expand, m.opacity, m.invert, m.pts, m.x0, m.y0, m.x1, m.y1]);
