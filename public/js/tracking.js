// 🎯 Motion tracking results, shared by the viewer, Effect Controls and engine/render2.mjs.
//   clip.masks = [{ id, type: 'blur' | 'pixelate', amount, path: [{ t, x, y, w, h }] }]  - a moving blur / mosaic
//   (path: seconds in the source file, box as fractions of the source picture, from engine/track.py)
//   following: an overlay's Position keyframes (images / videos) or title.follow { x: keys, y: keys } (% offsets)
// Coordinates go source picture -> the clip's framed picture (fit / fill / blur framing) -> output frame.

const r4 = (x) => Math.round(x * 1e4) / 1e4;

// fewer points where the motion is straight: a point is dropped when the line between its neighbours misses it
// by less than tol (fractions of the picture) on every coordinate
export function simplifyPath(pts, tol = 0.003) {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const rdp = (a, b) => {
    let worst = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const u = (pts[i].t - pts[a].t) / Math.max(1e-6, pts[b].t - pts[a].t);
      const e = Math.max(...['x', 'y', 'w', 'h'].map((k) => Math.abs(pts[a][k] + (pts[b][k] - pts[a][k]) * u - pts[i][k])));
      if (e > worst) { worst = e; idx = i; }
    }
    if (worst > tol) { keep[idx] = true; rdp(a, idx); rdp(idx, b); }
  };
  rdp(0, pts.length - 1);
  return pts.filter((_, i) => keep[i]);
}

// how the source picture sits in a W x H frame: frame px = o + source px * s
export function fitMap(mode, sw, sh, W, H, cropX = 0.5, cropY = 0.5) {
  if (!(sw > 0 && sh > 0)) return { s: 1, ox: 0, oy: 0 };
  if (mode === 'fill') { const s = Math.max(W / sw, H / sh); return { s, ox: -(sw * s - W) * cropX, oy: -(sh * s - H) * cropY }; }
  const s = Math.min(W / sw, H / sh);
  return { s, ox: (W - sw * s) / 2, oy: (H - sh * s) / 2 };
}
// the source size as the picture shows it (90° rotated phone video swaps it)
export const srcSize = (m) => (Math.abs(m?.rotation || 0) === 90 ? [m.height, m.width] : [m?.width, m?.height]);
export const framingOf = (c, settings, W, H, reframed = null) => reframed || c.fit || settings.fit || (H > W ? 'blur' : 'fit');

// the box of a tracked path at source time ts (linear between points), as fractions of the source picture
export function boxAt(path, ts) {
  if (!path?.length || ts < path[0].t - 0.05 || ts > path[path.length - 1].t + 0.05) return null;
  let i = path.findIndex((p) => p.t >= ts); if (i <= 0) return path[Math.max(0, i)];
  const a = path[i - 1], b = path[i], u = (ts - a.t) / Math.max(1e-6, b.t - a.t);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u };
}
// source time shown `rel` seconds into the clip (plain speed; ramps are ignored here)
export const srcTimeAt = (c, rel) => (c.in || 0) + rel * (c.speed || 1);

// keyframes { t (clip-relative seconds), v } of a mask's box centre in frame px, plus its fixed size and window
export function maskTrack(mask, c, m, W, H, mode) {
  const [sw, sh] = srcSize(m), sp = c.speed || 1;
  const at = (rel) => fitMap(mode, sw, sh, W, H, cropAt(c, 'cropX', rel), cropAt(c, 'cropY', rel));
  const pts = (mask.path || []).map((p) => { const t = (p.t - (c.in || 0)) / sp, f = at(t); return { t, cx: f.ox + (p.x + p.w / 2) * sw * f.s, cy: f.oy + (p.y + p.h / 2) * sh * f.s, w: p.w * sw * f.s, h: p.h * sh * f.s }; });
  if (!pts.length) return null;
  // (a box drawn by hand is used as drawn; a tracked face gets some room around it)
  const pad = mask.exact ? 1 : 1.18, BW = Math.max(8, Math.round(Math.max(...pts.map((p) => p.w)) * pad / 2) * 2), BH = Math.max(8, Math.round(Math.max(...pts.map((p) => p.h)) * pad / 2) * 2);
  return { BW, BH, a: pts[0].t, b: pts[pts.length - 1].t, xs: pts.map((p) => ({ t: +p.t.toFixed(3), v: Math.round(p.cx - BW / 2) })), ys: pts.map((p) => ({ t: +p.t.toFixed(3), v: Math.round(p.cy - BH / 2) })) };
}

// Follow: an overlay moves with the tracked thing - Position X/Y keyframes (% of the frame) relative to where it was
// first. target: the tracked clip and its timeline start; ov: the overlay and its timeline start.
export function followKeys(path, target, targetStart, targetMedia, ovStart, W, H, mode) {
  const [sw, sh] = srcSize(targetMedia), c = target, f = fitMap(mode, sw, sh, W, H, c.cropX ?? 0.5, c.cropY ?? 0.5), sp = c.speed || 1;
  const pts = path.map((p) => ({ t: targetStart + (p.t - (c.in || 0)) / sp - ovStart, cx: f.ox + (p.x + p.w / 2) * sw * f.s, cy: f.oy + (p.y + p.h / 2) * sh * f.s })).filter((p) => p.t >= -0.01);
  if (!pts.length) return null;
  const x0 = pts[0].cx, y0 = pts[0].cy;
  return { x: pts.map((p) => ({ t: +Math.max(0, p.t).toFixed(3), v: +(((p.cx - x0) / W) * 100).toFixed(2) })), y: pts.map((p) => ({ t: +Math.max(0, p.t).toFixed(3), v: +(((p.cy - y0) / H) * 100).toFixed(2) })) };
}
export { r4 };
// crop position at clip time rel (keyframed by 🎯 Follow faces, or fixed)
function cropAt(c, k, rel) {
  const keys = c.keys?.[k];
  if (!keys?.length) return c[k] ?? 0.5;
  if (rel <= keys[0].t) return keys[0].v;
  for (let i = 0; i < keys.length - 1; i++) if (rel < keys[i + 1].t) { const a = keys[i], b = keys[i + 1], u = (rel - a.t) / Math.max(1e-6, b.t - a.t), e = a.ease === 'io' || a.ease === true ? u * u * (3 - 2 * u) : u; return a.v + (b.v - a.v) * e; }
  return keys[keys.length - 1].v;
}

// ▱ Planar track (Phase 22): an overlay stuck onto a tracked surface. clip.pin = { keys: [{ t, q }], on: <V1 clip id> }:
// t = seconds into the overlay, q = its four corners [x0, y0, x1, y1, x2, y2, x3, y3] as fractions of the frame
// (top-left, top-right, bottom-left, bottom-right) - the render (render2.mjs pinnedOverlay) and the viewer both read it.

// four clicked points in any order -> top-left, top-right, bottom-left, bottom-right
export function orderQuad(pts) {
  const byY = [...pts].sort((a, b) => a.y - b.y), top = byY.slice(0, 2).sort((a, b) => a.x - b.x), bot = byY.slice(2).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bot[0], bot[1]];
}
// corners at overlay time rel (linear between keys; before / after: the first / last)
export function pinAt(keys, rel) {
  if (!keys?.length) return null;
  if (rel <= keys[0].t) return keys[0].q;
  const i = keys.findIndex((k) => k.t >= rel);
  if (i < 0) return keys[keys.length - 1].q;
  const a = keys[i - 1], b = keys[i], u = (rel - a.t) / Math.max(1e-6, b.t - a.t);
  return a.q.map((v, j) => v + (b.q[j] - v) * u);
}
// CSS matrix3d that puts a w×h element (transform-origin 0 0) onto the quad q (pixels: [x0, y0, ... x3, y3])
export function quadMatrix(w, h, q) {
  const [X0, Y0, X1, Y1, X3, Y3, X2, Y2] = q; // (square order: TL, TR, BR, BL - q is TL, TR, BL, BR)
  const dx1 = X1 - X2, dx2 = X3 - X2, dx3 = X0 - X1 + X2 - X3, dy1 = Y1 - Y2, dy2 = Y3 - Y2, dy3 = Y0 - Y1 + Y2 - Y3;
  let a, b, c, d, e, f, g = 0, k = 0;
  const den = dx1 * dy2 - dx2 * dy1;
  if ((Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) || Math.abs(den) < 1e-9) { a = X1 - X0; b = X2 - X1; d = Y1 - Y0; e = Y2 - Y1; }
  else { g = (dx3 * dy2 - dx2 * dy3) / den; k = (dx1 * dy3 - dx3 * dy1) / den; a = X1 - X0 + g * X1; b = X3 - X0 + k * X3; d = Y1 - Y0 + g * Y1; e = Y3 - Y0 + k * Y3; }
  c = X0; f = Y0;
  const n = (v) => +v.toFixed(8);
  return `matrix3d(${[a / w, d / w, 0, g / w, b / h, e / h, 0, k / h, 0, 0, 1, 0, c, f, 0, 1].map(n).join(',')})`;
}
// a tracked path (seconds in the V1 shot's file, corners as fractions of its picture) -> pin keys for an overlay
// (seconds into the overlay, fractions of the frame), through the shot's framing and Motion
export function pinKeys(path, target, targetStart, targetMedia, ovStart, ovDur, W, H, mode, propAt) {
  const [sw, sh] = srcSize(targetMedia), c = target, sp = c.speed || 1;
  const keys = [];
  for (const p of path) {
    const rel = (p.t - (c.in || 0)) / sp, t = targetStart + rel - ovStart;
    if (t < -0.05 || t > ovDur + 0.05) continue;
    const fm = fitMap(mode, sw, sh, W, H, cropAt(c, 'cropX', rel), cropAt(c, 'cropY', rel));
    const z = +propAt(c, 'transform.zoom', rel) || 1, tx = ((+propAt(c, 'transform.x', rel) || 0) / 100) * W, ty = ((+propAt(c, 'transform.y', rel) || 0) / 100) * H;
    const q = [];
    for (let j = 0; j < 4; j++) {
      const px = fm.ox + p.q[j * 2] * sw * fm.s, py = fm.oy + p.q[j * 2 + 1] * sh * fm.s;
      q.push(r4((W / 2 + (px - W / 2) * z + tx) / W), r4((H / 2 + (py - H / 2) * z + ty) / H));
    }
    keys.push({ t: +Math.max(0, t).toFixed(3), q });
  }
  return simplifyPin(keys);
}
// fewer keys where the corners move in a straight line (tol: fractions of the frame, ~1 px at 1080p)
export function simplifyPin(keys, tol = 0.0008) {
  if (keys.length < 3) return keys;
  const keep = new Array(keys.length).fill(false);
  keep[0] = keep[keys.length - 1] = true;
  const rdp = (a, b) => {
    let worst = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const u = (keys[i].t - keys[a].t) / Math.max(1e-6, keys[b].t - keys[a].t);
      const e = Math.max(...keys[i].q.map((v, j) => Math.abs(keys[a].q[j] + (keys[b].q[j] - keys[a].q[j]) * u - v)));
      if (e > worst) { worst = e; idx = i; }
    }
    if (worst > tol) { keep[idx] = true; rdp(a, idx); rdp(idx, b); }
  };
  rdp(0, keys.length - 1);
  return keys.filter((_, i) => keep[i]);
}
