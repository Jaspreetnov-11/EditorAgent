// 🎬 Motion (After Effects-style compositions) - the engine. One drawing code for the Motion page, the Edit viewer and
// the render (a comp on the timeline is a graphic clip { type: 'graphic', gfx: { tpl: 'comp', comp } } that graphics.js
// hands to drawComp, and gfxui.js bakes like any graphic). Works in the browser and in Node (no DOM at import).
//
// comp  = { id, name, w, h, dur, bg: null | '#rrggbb', layers: [layer] }  - layers[0] is the TOP layer (as in AE)
// layer = { id, name, type: 'text' | 'shape' | 'solid' | 'image' | 'video' | 'null', in, out, parent, hidden, solo, locked,
//           (video: { mediaId, in: source second at the layer's start, speed, w, h } - a clip of the edit brought in)
//           blend: 'normal' | 'multiply' | 'screen' | 'add' | 'overlay' | 'darken' | 'lighten' | 'difference',
//           matte: null | 'alpha' | 'alphaInv' | 'luma' | 'lumaInv'   (the layer just above is the matte, AE track matte)
//           tr: { anchor, position, scale, rotation, opacity }, text, shape, solid, image, masks: [], effects: [] }
// A property is a plain value (number, [x, y], '#rrggbb') or animated: { k: [{ t, v, e: [x1, y1, x2, y2], hold }] }
// (e = the ease of the segment that starts at that keyframe, a CSS cubic-bezier; [0,0,1,1] linear) and may have
// wiggle: { freq, amp } (AE's wiggle() expression without code).

export const BLENDS = { normal: 'source-over', multiply: 'multiply', screen: 'screen', add: 'lighter', overlay: 'overlay', darken: 'darken', lighten: 'lighten', difference: 'difference' };
export const EASE = { linear: [0, 0, 1, 1], easy: [0.33, 0, 0.67, 1], easyIn: [0.33, 0, 1, 1], easyOut: [0, 0, 0.67, 1], snappy: [0.2, 0.9, 0.25, 1], overshoot: [0.3, 1.45, 0.45, 1] };
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const isAnim = (p) => p && typeof p === 'object' && !Array.isArray(p) && Array.isArray(p.k);
export const uidM = () => Math.random().toString(36).slice(2, 9);

// ---------------- keyframes ----------------
// cubic-bezier(x1,y1,x2,y2) at progress x (solve for the curve parameter, then read y)
export function bezier(e, x) {
  const [x1, y1, x2, y2] = e || EASE.linear;
  if (x1 === y1 && x2 === y2) return x;
  const bx = (s) => 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3, by = (s) => 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3;
  let lo = 0, hi = 1, s = x;
  for (let i = 0; i < 30; i++) { const v = bx(s); if (Math.abs(v - x) < 1e-5) break; if (v < x) lo = s; else hi = s; s = (lo + hi) / 2; }
  return by(s);
}
const hexRGB = (c) => { const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(c || ''); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : [255, 255, 255]; };
const rgbHex = (a) => `#${a.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
export function lerpV(a, b, k) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * k;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => (typeof v === 'number' ? v + ((b[i] ?? v) - v) * k : v));
  if (typeof a === 'string' && typeof b === 'string' && a[0] === '#' && b[0] === '#') { const A = hexRGB(a), B = hexRGB(b); return rgbHex(A.map((v, i) => v + (B[i] - v) * k)); }
  return k < 1 ? a : b;
}
// a smooth repeatable noise for wiggle (same value for the same seed and time everywhere)
function noise(seed, t) {
  const f = Math.floor(t), r = t - f, h = (n) => { const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
  const s = r * r * (3 - 2 * r);
  return h(f) * (1 - s) + h(f + 1) * s;
}
// a property: a plain value, { v, wiggle } (still, with a wiggle) or { k: [keys], wiggle? } (animated)
const isObj = (p) => p && typeof p === 'object' && !Array.isArray(p);
function keyed(K, t) {
  if (t <= K[0].t) return K[0].v;
  if (t >= K[K.length - 1].t) return K[K.length - 1].v;
  let i = 0; while (t > K[i + 1].t) i++;
  const a = K[i], b = K[i + 1];
  return a.hold ? a.v : lerpV(a.v, b.v, bezier(a.e, (t - a.t) / Math.max(1e-6, b.t - a.t)));
}
// the value without the wiggle
export const base = (p, t) => (isAnim(p) ? keyed(p.k, t) : isObj(p) && 'v' in p ? p.v : p);
// the value of a property at t seconds
export function val(p, t, seed = 1) {
  let v = base(p, t);
  const w = isObj(p) ? p.wiggle : null;
  if (w && +w.amp) {
    const fq = +w.freq || 2, amp = +w.amp;
    if (typeof v === 'number') v += noise(seed, t * fq) * amp;
    else if (Array.isArray(v)) v = v.map((x, i) => (typeof x === 'number' ? x + noise(seed + i * 17, t * fq) * amp : x));
  }
  return v;
}
const wig = (p) => (isObj(p) && p.wiggle ? { wiggle: p.wiggle } : {});
// keyframes: find / set / remove one at t
export function keyAt(p, t) { return isAnim(p) ? p.k.findIndex((k) => Math.abs(k.t - t) < 1 / 120) : -1; }
export function setKey(p, t, v, e = EASE.linear) {
  const q = { ...wig(p), k: isAnim(p) ? p.k.map((k) => ({ ...k })) : [] };
  const i = keyAt(q, t);
  if (i >= 0) q.k[i].v = v; else { q.k.push({ t: +t.toFixed(4), v, e: [...e] }); q.k.sort((a, b) => a.t - b.t); }
  return q;
}
export function delKey(p, t) {
  if (!isAnim(p)) return p;
  const k = p.k.filter((x) => Math.abs(x.t - t) >= 1 / 120);
  if (k.length) return { ...p, k };
  const v = base(p, t);
  return p.wiggle ? { v, wiggle: p.wiggle } : v;
}
export const animated = isAnim;
// set a value: on an animated property it becomes a keyframe at t, else the still value changes
export function setVal(p, t, v) { return isAnim(p) ? setKey(p, t, v) : isObj(p) && p.wiggle ? { v, wiggle: p.wiggle } : v; }
// ⏱ stopwatch: on = a first keyframe with the current value; off = keep the value at t, no keyframes
export function stopwatch(p, t) {
  if (isAnim(p)) { const v = base(p, t); return p.wiggle ? { v, wiggle: p.wiggle } : v; }
  return setKey(p, t, base(p, t));
}
// wiggle (AE's wiggle(freq, amp) without code): w = { freq, amp } or null to remove it
export function setWiggle(p, t, w) {
  const on = w && +w.amp;
  if (isAnim(p)) { const q = { k: p.k }; if (on) q.wiggle = w; return q; }
  const v = base(p, t);
  return on ? { v, wiggle: w } : v;
}

// ---------------- making things ----------------
export const tr0 = (w, h) => ({ anchor: [0, 0], position: [w / 2, h / 2], scale: [100, 100], rotation: 0, opacity: 100 });
export function newComp(name, w = 1920, h = 1080, dur = 5) { return { id: uidM(), name, w, h, dur, bg: null, layers: [] }; }
export function newLayer(type, comp, extra = {}) {
  const L = { id: uidM(), name: extra.name || ({ text: 'Text', shape: 'Shape', solid: 'Solid', image: 'Image', video: 'Video', null: 'Null' }[type]), type, in: 0, out: comp.dur,
    parent: null, hidden: false, solo: false, locked: false, blend: 'normal', matte: null, tr: tr0(comp.w, comp.h), masks: [], effects: [] };
  if (type === 'text') L.text = { text: 'Your text', font: 'Nirmala UI', size: 120, weight: 800, fill: '#ffffff', stroke: '#000000', strokeW: 0, align: 'center', tracking: 0, lineHeight: 1.15, animators: [] };
  if (type === 'shape') L.shape = { kind: 'rect', size: [600, 300], roundness: 24, sides: 5, inner: 0.5, path: [], closed: true, fill: '#ff9933', fillOn: true, stroke: '#ffffff', strokeW: 0, trimStart: 0, trimEnd: 100, trimOffset: 0 };
  if (type === 'solid') L.solid = { color: '#0b2545', size: [comp.w, comp.h] };
  if (type === 'image') L.image = { mediaId: extra.mediaId || null, w: extra.w || 0, h: extra.h || 0 };
  if (type === 'video') L.video = { mediaId: extra.mediaId || null, in: extra.srcIn || 0, speed: extra.speed || 1, w: extra.w || comp.w, h: extra.h || comp.h };
  if (type === 'null') L.tr.opacity = 100;
  return Object.assign(L, extra.props || {});
}

// ---------------- geometry ----------------
// the layer's own rectangle (anchor space: the content is centred on 0,0 for shapes/text/solids)
function contentBox(L, t, ctx) {
  if (L.type === 'solid') { const [w, h] = val(L.solid.size, t) || [100, 100]; return [-w / 2, -h / 2, w, h]; }
  if (L.type === 'shape') { const s = L.shape; if (s.kind === 'path') return pathBox(s.path); const [w, h] = val(s.size, t) || [100, 100]; return [-w / 2, -h / 2, w, h]; }
  if (L.type === 'image') { const w = L.image.w || 400, h = L.image.h || 300; return [-w / 2, -h / 2, w, h]; }
  if (L.type === 'video') { const w = L.video.w || 1920, h = L.video.h || 1080; return [-w / 2, -h / 2, w, h]; }
  if (L.type === 'text' && ctx) { const m = textLayout(ctx, L, t); return [m.x0, m.y0, m.w, m.h]; }
  if (L.type === 'null') return [-50, -50, 100, 100];
  return [-100, -50, 200, 100];
}
function pathBox(P) {
  if (!P?.length) return [-50, -50, 100, 100];
  const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys);
  return [x0, y0, Math.max(...xs) - x0 || 1, Math.max(...ys) - y0 || 1];
}
// 2D matrix [a b c d e f] like canvas setTransform
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export function localMatrix(L, t) {
  const T = L.tr || {}, [ax, ay] = val(T.anchor, t, 3) || [0, 0], [px, py] = val(T.position, t, 1) || [0, 0];
  const [sx, sy] = val(T.scale, t, 5) || [100, 100], r = ((val(T.rotation, t, 7) || 0) * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  // translate(pos) * rotate * scale * translate(-anchor)
  const k = [c * sx / 100, s * sx / 100, -s * sy / 100, c * sy / 100, 0, 0];
  return [k[0], k[1], k[2], k[3], px - (k[0] * ax + k[2] * ay), py - (k[1] * ax + k[3] * ay)];
}
export function worldMatrix(comp, L, t, depth = 0) {
  const m = localMatrix(L, t - 0);
  const P = L.parent && depth < 20 ? comp.layers.find((x) => x.id === L.parent) : null;
  if (P) return mul(worldMatrix(comp, P, t, depth + 1), m);
  return comp.camera && Number.isFinite(+L.depth) ? mul(cameraMatrix(comp, +L.depth, t), m) : m;
}
// 🌄 parallax (2.5D): comp.camera = { pos: [x, y], zoom } (animatable). A layer with a depth (0 = near, 100, 300… =
// farther away) moves and zooms with the camera by 100 / (100 + depth): near layers a lot, far ones a little.
export function cameraMatrix(comp, d, t) {
  const f = 100 / (100 + Math.max(0, d)), [cx, cy] = val(comp.camera.pos, t) || [0, 0], z = 1 + ((val(comp.camera.zoom, t) ?? 1) - 1) * f;
  const ox = (comp.w || 1920) / 2, oy = (comp.h || 1080) / 2;
  // translate(centre) * scale(z) * translate(-centre) * translate(-camera * f)
  return [z, 0, 0, z, ox - z * ox - z * cx * f, oy - z * oy - z * cy * f];
}
export function invert(m) { const d = m[0] * m[3] - m[1] * m[2] || 1e-9; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; }
export const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
// the four corners of a layer in comp space (for the viewer's selection box / click test)
export function layerQuad(comp, L, t, ctx) {
  const [x, y, w, h] = contentBox(L, t, ctx), m = worldMatrix(comp, L, t);
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((p) => apply(m, p));
}

// ---------------- paths ----------------
// path points: [x, y, inX, inY, outX, outY] (handles relative to the point, like AE's pen)
function tracePath(ctx, P, closed) {
  if (!P?.length) return;
  ctx.moveTo(P[0][0], P[0][1]);
  const seg = (a, b) => ctx.bezierCurveTo(a[0] + (a[4] || 0), a[1] + (a[5] || 0), b[0] + (b[2] || 0), b[1] + (b[3] || 0), b[0], b[1]);
  for (let i = 1; i < P.length; i++) seg(P[i - 1], P[i]);
  if (closed && P.length > 2) { seg(P[P.length - 1], P[0]); ctx.closePath(); }
}
function polyPoints(n, r1, r2, star) {
  const pts = [], k = star ? n * 2 : n;
  for (let i = 0; i < k; i++) { const a = -Math.PI / 2 + (i * 2 * Math.PI) / k, r = star && i % 2 ? r2 : r1; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
  return pts;
}
// the outline of a shape as a list of points (used for trim paths, which need the length)
function shapeOutline(s, t) {
  const [w, h] = val(s.size, t) || [100, 100];
  if (s.kind === 'ellipse') { const n = 96; return Array.from({ length: n + 1 }, (_, i) => { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; return [Math.cos(a) * w / 2, Math.sin(a) * h / 2]; }); }
  if (s.kind === 'polygon' || s.kind === 'star') { const p = polyPoints(Math.max(3, Math.round(val(s.sides, t) || 5)), Math.min(w, h) / 2, (Math.min(w, h) / 2) * clamp(val(s.inner, t) ?? 0.5, 0.05, 1), s.kind === 'star'); return [...p, p[0]]; }
  if (s.kind === 'path') {
    const P = s.path || [], out = [];
    const segs = s.closed && P.length > 2 ? [...P.map((p, i) => [p, P[(i + 1) % P.length]])] : P.slice(1).map((p, i) => [P[i], p]);
    for (const [a, b] of segs) for (let i = 0; i <= 24; i++) {
      const u = i / 24, c0 = [a[0], a[1]], c1 = [a[0] + (a[4] || 0), a[1] + (a[5] || 0)], c2 = [b[0] + (b[2] || 0), b[1] + (b[3] || 0)], c3 = [b[0], b[1]];
      const f = (j) => (1 - u) ** 3 * c0[j] + 3 * (1 - u) ** 2 * u * c1[j] + 3 * (1 - u) * u * u * c2[j] + u ** 3 * c3[j];
      out.push([f(0), f(1)]);
    }
    return out;
  }
  const r = Math.min(val(s.roundness, t) || 0, w / 2, h / 2);
  if (!r) return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, -h / 2]];
  const out = [], arc = (cx, cy, a0) => { for (let i = 0; i <= 8; i++) { const a = a0 + (i / 8) * (Math.PI / 2); out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
  arc(w / 2 - r, -h / 2 + r, -Math.PI / 2); arc(w / 2 - r, h / 2 - r, 0); arc(-w / 2 + r, h / 2 - r, Math.PI / 2); arc(-w / 2 + r, -h / 2 + r, Math.PI); out.push(out[0]);
  return out;
}
function trimmed(pts, a, b) { // keep the part of a polyline from a to b (0..1 of its length)
  const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const tot = L[L.length - 1] || 1, A = a * tot, B = b * tot, out = [];
  const at = (d) => { let i = 1; while (i < L.length - 1 && L[i] < d) i++; const k = (d - L[i - 1]) / Math.max(1e-9, L[i] - L[i - 1]); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]; };
  out.push(at(A)); for (let i = 0; i < L.length; i++) if (L[i] > A && L[i] < B) out.push(pts[i]); out.push(at(B));
  return out;
}
function drawShape(ctx, s, t) {
  const tS = clamp((val(s.trimStart, t) ?? 0) / 100), tE = clamp((val(s.trimEnd, t) ?? 100) / 100), off = ((val(s.trimOffset, t) || 0) / 360) % 1;
  const trim = tS > 0 || tE < 1 || off;
  const fill = s.fillOn !== false && s.kind !== 'path' ? true : s.fillOn !== false && s.closed;
  const sw = val(s.strokeW, t) || 0;
  ctx.beginPath();
  if (trim) {
    let a = tS + off, b = tE + off; const pts = shapeOutline(s, t);
    const draw = (x, y) => { const q = trimmed(pts, x, y); q.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); };
    a = ((a % 1) + 1) % 1; b = a + (tE - tS);
    if (b > 1) { draw(a, 1); draw(0, b - 1); } else draw(a, b);
    if (sw > 0) { ctx.strokeStyle = val(s.stroke, t) || '#fff'; ctx.lineWidth = sw; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(); }
    else if (fill) { ctx.fillStyle = val(s.fill, t) || '#fff'; ctx.fill(); }
    return;
  }
  const [w, h] = val(s.size, t) || [100, 100];
  if (s.kind === 'ellipse') ctx.ellipse(0, 0, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
  else if (s.kind === 'polygon' || s.kind === 'star') { const p = shapeOutline(s, t); p.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath(); }
  else if (s.kind === 'path') tracePath(ctx, s.path, s.closed);
  else { const r = Math.max(0, Math.min(val(s.roundness, t) || 0, Math.abs(w) / 2, Math.abs(h) / 2)); ctx.roundRect ? ctx.roundRect(-w / 2, -h / 2, w, h, r) : ctx.rect(-w / 2, -h / 2, w, h); }
  if (fill) { ctx.fillStyle = val(s.fill, t) || '#fff'; ctx.fill(); }
  if (sw > 0) { ctx.strokeStyle = val(s.stroke, t) || '#fff'; ctx.lineWidth = sw; ctx.lineJoin = 'round'; ctx.stroke(); }
}

// ---------------- text + animators ----------------
const FONT = (T, size) => `${T.italic ? 'italic ' : ''}${T.weight || 700} ${size}px "${String(T.font || 'Nirmala UI').replace(/"/g, '')}", "Nirmala UI", "Segoe UI", Arial, sans-serif`;
// split into characters (keeping Devanagari clusters whole), words and lines
function units(text) {
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('hi', { granularity: 'grapheme' }) : null;
  const lines = String(text ?? '').split('\n'), out = [];
  let ci = 0, wi = 0;
  lines.forEach((ln, li) => {
    const g = seg ? [...seg.segment(ln)].map((x) => x.segment) : [...ln];
    let inWord = false;
    for (const ch of g) { const sp = /\s/.test(ch); if (!sp && !inWord) wi++; inWord = !sp; out.push({ ch, line: li, word: sp ? -1 : wi - 1, i: ci++ }); }
    inWord = false;
  });
  return { list: out, lines: lines.length, words: wi };
}
export function textLayout(ctx, L, t) {
  const T = L.text, size = val(T.size, t) || 100, track = (val(T.tracking, t) || 0) * size / 1000, lh = size * (T.lineHeight || 1.15);
  ctx.save(); ctx.font = FONT(T, size);
  const U = units(val(T.text, t)), rows = [];
  for (const u of U.list) { (rows[u.line] ||= []).push(u); u.w = ctx.measureText(u.ch).width; }
  for (let i = 0; i < U.lines; i++) rows[i] ||= [];
  const widths = rows.map((r) => r.reduce((a, u) => a + u.w + track, 0) - (r.length ? track : 0));
  const W = Math.max(1, ...widths), H = lh * U.lines;
  rows.forEach((r, li) => {
    let x = T.align === 'left' ? 0 : T.align === 'right' ? -widths[li] : -widths[li] / 2;
    for (const u of r) { u.x = x; u.y = -H / 2 + lh * li + lh / 2; x += u.w + track; }
  });
  ctx.restore();
  const x0 = T.align === 'left' ? 0 : T.align === 'right' ? -W : -W / 2;
  return { U, rows, size, x0, y0: -H / 2, w: W, h: H };
}
// AE range selector: how much (0..1) an animator affects unit #i of n
export function selectorAmount(R, i, n, t) {
  const s = (val(R.start, t) ?? 0) / 100, e = (val(R.end, t) ?? 100) / 100, o = (val(R.offset, t) || 0) / 100;
  const a = Math.min(s, e) + o, b = Math.max(s, e) + o, x0 = i / n, x1 = (i + 1) / n;
  const shape = R.shape || 'square';
  if (shape === 'square') { // the part of this unit's cell inside [a, b]
    const cover = (Math.min(b, x1) - Math.max(a, x0)) / (x1 - x0);
    return clamp(cover);
  }
  const c = (x0 + x1) / 2, w = Math.max(1e-6, b - a), u = (c - a) / w;
  if (u < 0 || u > 1) return shape === 'rampUp' ? (u > 1 ? 1 : 0) : shape === 'rampDown' ? (u < 0 ? 1 : 0) : 0;
  if (shape === 'rampUp') return u;
  if (shape === 'rampDown') return 1 - u;
  if (shape === 'triangle') return 1 - Math.abs(u * 2 - 1);
  return 0.5 - 0.5 * Math.cos(u * Math.PI * 2); // smooth (round)
}
function drawText(ctx, L, t) {
  const T = L.text, m = textLayout(ctx, L, t), A = T.animators || [];
  ctx.font = FONT(T, m.size); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const fill = val(T.fill, t) || '#fff', sw = val(T.strokeW, t) || 0, stroke = val(T.stroke, t) || '#000';
  const n = { char: m.U.list.length, word: m.U.words, line: m.U.lines };
  for (const u of m.U.list) {
    if (/^\s$/.test(u.ch)) continue;
    let dx = 0, dy = 0, sc = 1, rot = 0, op = 1, col = fill, blur = 0;
    for (const a of A) {
      const by = a.range?.by || 'char', idx = by === 'word' ? u.word : by === 'line' ? u.line : u.i;
      if (idx < 0) continue;
      const k = selectorAmount(a.range || {}, idx, Math.max(1, n[by]), t); if (!k) continue;
      const p = a.props || {};
      if (p.position) { const [x, y] = val(p.position, t) || [0, 0]; dx += x * k; dy += y * k; }
      if (p.scale !== undefined) sc *= 1 + ((val(p.scale, t) ?? 100) / 100 - 1) * k;
      if (p.rotation !== undefined) rot += (val(p.rotation, t) || 0) * k;
      if (p.opacity !== undefined) op *= 1 + ((val(p.opacity, t) ?? 100) / 100 - 1) * k;
      if (p.fill) col = lerpV(col, val(p.fill, t), k);
      if (p.blur !== undefined) blur += (val(p.blur, t) || 0) * k;
    }
    if (op <= 0.001) continue;
    ctx.save();
    ctx.globalAlpha *= clamp(op);
    ctx.translate(u.x + u.w / 2 + dx, u.y + dy); ctx.rotate((rot * Math.PI) / 180); ctx.scale(sc, sc);
    if (blur > 0.1 && 'filter' in ctx) ctx.filter = `blur(${blur.toFixed(1)}px)`;
    if (sw > 0) { ctx.lineWidth = sw; ctx.strokeStyle = stroke; ctx.lineJoin = 'round'; ctx.strokeText(u.ch, -u.w / 2, 0); }
    ctx.fillStyle = col; ctx.fillText(u.ch, -u.w / 2, 0);
    ctx.restore();
  }
}
// ready-made text animators (AE's Animation Presets > Text)
export const TEXT_ANIMS = {
  typewriter: { name: '⌨ Typewriter', make: (d) => ({ name: 'Typewriter', props: { opacity: 0 }, range: { by: 'char', shape: 'square', start: { k: [{ t: 0, v: 0, e: [...EASE.linear] }, { t: d, v: 100, e: [...EASE.linear] }] }, end: 100 } }) },
  fadeUp: { name: '⬆ Fade up by letter', make: (d) => ({ name: 'Fade up', props: { opacity: 0, position: [0, 60] }, range: { by: 'char', shape: 'rampUp', start: { k: [{ t: 0, v: 0, e: [...EASE.easyOut] }, { t: d, v: 100, e: [...EASE.linear] }] }, end: 100, offset: 0 } }) },
  popWords: { name: '💥 Pop in words', make: (d) => ({ name: 'Pop words', props: { scale: 0, opacity: 0 }, range: { by: 'word', shape: 'rampUp', start: { k: [{ t: 0, v: 0, e: [...EASE.overshoot] }, { t: d, v: 100, e: [...EASE.linear] }] }, end: 100 } }) },
  slideLines: { name: '➡ Slide in lines', make: (d) => ({ name: 'Slide lines', props: { position: [-300, 0], opacity: 0 }, range: { by: 'line', shape: 'rampUp', start: { k: [{ t: 0, v: 0, e: [...EASE.easyOut] }, { t: d, v: 100, e: [...EASE.linear] }] }, end: 100 } }) },
  blurIn: { name: '🌫 Blur in', make: (d) => ({ name: 'Blur in', props: { blur: 30, opacity: 0, scale: 160 }, range: { by: 'char', shape: 'rampUp', start: { k: [{ t: 0, v: 0, e: [...EASE.easyOut] }, { t: d, v: 100, e: [...EASE.linear] }] }, end: 100 } }) },
  wave: { name: '〰 Wave', make: (d) => ({ name: 'Wave', props: { position: [0, -50] }, range: { by: 'char', shape: 'smooth', start: 0, end: 30, offset: { k: [{ t: 0, v: -30, e: [...EASE.linear] }, { t: d, v: 100, e: [...EASE.linear] }] } } }) },
  colorSweep: { name: '🎨 Colour sweep', make: (d) => ({ name: 'Colour sweep', props: { fill: '#ff9933' }, range: { by: 'char', shape: 'smooth', start: 0, end: 25, offset: { k: [{ t: 0, v: -25, e: [...EASE.linear] }, { t: d, v: 100, e: [...EASE.linear] }] } } }) },
  tracking: { name: '↔ Tracking in', make: (d) => ({ name: 'Tracking', props: { opacity: 0, position: [0, 0], scale: 100 }, range: { by: 'char', shape: 'square', start: 0, end: 100 }, trackIn: true, d }) },
};

// ---------------- masks, mattes, effects ----------------
function canvasLike(ctx, w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return null;
}
function maskPath(ctx, M, t) {
  const P = (M.path || []), exp = val(M.expansion, t) || 0;
  if (!P.length) return;
  if (!exp) return tracePath(ctx, P, true);
  const [x, y, w, h] = pathBox(P), cx = x + w / 2, cy = y + h / 2, sx = (w + 2 * exp) / w, sy = (h + 2 * exp) / h;
  tracePath(ctx, P.map((p) => [cx + (p[0] - cx) * sx, cy + (p[1] - cy) * sy, p[2] * sx, p[3] * sy, p[4] * sx, p[5] * sy]), true);
}

// ---------------- the drawing ----------------
// paints the comp at t seconds on ctx (W x H, transparent unless comp.bg). opts.img(mediaId) -> loaded image or null
export function drawComp(ctx, W, H, comp, t, opts = {}) {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.scale(W / (comp.w || W), H / (comp.h || H));
  const CW = comp.w || W, CH = comp.h || H;
  if (comp.bg) { ctx.fillStyle = comp.bg; ctx.fillRect(0, 0, CW, CH); }
  const Ls = comp.layers || [], solo = Ls.some((l) => l.solo && !l.hidden);
  // bottom to top (layers[0] is the top one); a layer with a track matte uses the layer above it
  for (let i = Ls.length - 1; i >= 0; i--) {
    const L = Ls[i];
    if (L.hidden || L.type === 'null' || t < (L.in || 0) || t >= (L.out ?? comp.dur)) continue;
    if (solo && !L.solo) continue;
    const isMatte = i + 1 < Ls.length && Ls[i + 1].matte; // this layer is the matte of the one below: not drawn itself
    if (isMatte) continue;
    const needLayer = L.matte || (L.masks || []).length || (L.effects || []).some((e) => e.type === 'glow');
    if (!needLayer) { drawLayer(ctx, comp, L, t, opts); continue; }
    // offscreen: layer (+ masks) (+ matte), then composited with its blend mode
    const sc = W / CW, oc = canvasLike(ctx, W, H); if (!oc) { drawLayer(ctx, comp, L, t, opts); continue; }
    const o = oc.getContext('2d'); o.scale(sc, H / CH);
    drawLayer(o, comp, { ...L, blend: 'normal' }, t, opts, true);
    if ((L.masks || []).length) applyMasks(o, comp, L, t, W, H, CW, CH);
    if (L.matte && Ls[i - 1]) {
      const mc = canvasLike(ctx, W, H), mo = mc.getContext('2d'); mo.scale(sc, H / CH);
      drawLayer(mo, comp, { ...Ls[i - 1], hidden: false, blend: 'normal' }, t, opts, true);
      if (L.matte.startsWith('luma')) lumaToAlpha(mo, W, H, L.matte === 'lumaInv');
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.globalCompositeOperation = L.matte === 'alphaInv' ? 'destination-out' : 'destination-in';
      o.drawImage(mc, 0, 0);
    }
    if ((L.effects || []).some((e) => e.type === 'glow' && !e.off)) glow(o, oc, L, t, W, H);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = BLENDS[L.blend] || 'source-over';
    ctx.drawImage(oc, 0, 0); ctx.restore();
  }
  ctx.restore();
}
function lumaToAlpha(o, W, H, inv) {
  const d = o.getImageData(0, 0, W, H), p = d.data;
  for (let i = 0; i < p.length; i += 4) { const l = (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) * (p[i + 3] / 255); p[i + 3] = inv ? 255 - l : l; }
  o.putImageData(d, 0, 0);
}
function glow(o, oc, L, t, W, H) {
  const g = L.effects.find((e) => e.type === 'glow');
  const r = val(g.radius, t) ?? 30, k = (val(g.intensity, t) ?? 100) / 100, cp = canvasLike(o, W, H), c2 = cp.getContext('2d');
  c2.filter = `blur(${r}px)`; c2.globalAlpha = clamp(k); c2.drawImage(oc, 0, 0);
  o.save(); o.setTransform(1, 0, 0, 1, 0, 0); o.globalCompositeOperation = 'lighter'; o.drawImage(cp, 0, 0); if (k > 1) { o.globalAlpha = clamp(k - 1); o.drawImage(cp, 0, 0); } o.restore();
}
function applyMasks(o, comp, L, t, W, H, CW, CH) {
  // all masks drawn into one alpha canvas (in layer space), then the layer is kept where the mask is
  const mc = canvasLike(o, W, H), m = mc.getContext('2d');
  m.scale(W / CW, H / CH);
  const wm = worldMatrix(comp, L, t); m.transform(...wm);
  L.masks.forEach((M, j) => {
    if (M.off) return;
    const mode = M.mode || 'add', f = val(M.feather, t) || 0, op = clamp((val(M.opacity, t) ?? 100) / 100);
    m.save();
    m.globalCompositeOperation = j === 0 && mode !== 'subtract' ? 'source-over' : mode === 'subtract' ? 'destination-out' : mode === 'intersect' ? 'destination-in' : 'source-over';
    if (j === 0 && mode === 'subtract') { m.save(); m.setTransform(1, 0, 0, 1, 0, 0); m.fillStyle = '#fff'; m.fillRect(0, 0, W, H); m.restore(); }
    if (f > 0 && 'filter' in m) m.filter = `blur(${(f * W) / CW / 2}px)`;
    m.globalAlpha = op; m.fillStyle = '#fff'; m.beginPath(); maskPath(m, M, t); m.fill();
    m.restore();
  });
  if (L.masks.some((M) => M.inverted && !M.off)) { m.save(); m.setTransform(1, 0, 0, 1, 0, 0); m.globalCompositeOperation = 'xor'; m.fillStyle = '#fff'; m.fillRect(0, 0, W, H); m.restore(); }
  o.save(); o.setTransform(1, 0, 0, 1, 0, 0); o.globalCompositeOperation = 'destination-in'; o.drawImage(mc, 0, 0); o.restore();
}
// one layer with its transform (parents included), opacity, effects (blur, drop shadow, fill), blend mode
function drawLayer(ctx, comp, L, t, opts, offscreen = false) {
  const lt = t; // layer time = comp time (layers can be moved in time by their in/out)
  ctx.save();
  ctx.transform(...worldMatrix(comp, L, lt));
  let op = clamp((val(L.tr?.opacity, lt, 9) ?? 100) / 100);
  ctx.globalAlpha *= op;
  if (!offscreen) ctx.globalCompositeOperation = BLENDS[L.blend] || 'source-over';
  const F = [];
  for (const e of L.effects || []) {
    if (e.off) continue;
    if (e.type === 'blur') { const b = val(e.amount, lt) || 0; if (b > 0) F.push(`blur(${b}px)`); }
    if (e.type === 'shadow') { ctx.shadowColor = `${val(e.color, lt) || '#000000'}${Math.round(clamp((val(e.opacity, lt) ?? 60) / 100) * 255).toString(16).padStart(2, '0')}`; ctx.shadowBlur = val(e.softness, lt) ?? 20; const d = val(e.distance, lt) ?? 12, a = (((val(e.angle, lt) ?? 135) - 90) * Math.PI) / 180; ctx.shadowOffsetX = Math.cos(a) * d; ctx.shadowOffsetY = Math.sin(a) * d; }
    if (e.type === 'brightness') { F.push(`brightness(${(val(e.amount, lt) ?? 100) / 100})`); }
    if (e.type === 'saturation') { F.push(`saturate(${(val(e.amount, lt) ?? 100) / 100})`); }
    if (e.type === 'hue') { F.push(`hue-rotate(${val(e.amount, lt) || 0}deg)`); }
  }
  if (F.length && 'filter' in ctx) ctx.filter = F.join(' ');
  const fillFx = (L.effects || []).find((e) => e.type === 'fill' && !e.off);
  if (L.type === 'solid') { const [w, h] = val(L.solid.size, lt) || [comp.w, comp.h]; ctx.fillStyle = val(L.solid.color, lt) || '#000'; ctx.fillRect(-w / 2, -h / 2, w, h); }
  else if (L.type === 'shape') drawShape(ctx, fillFx ? { ...L.shape, fill: fillFx.color, stroke: fillFx.color } : L.shape, lt);
  else if (L.type === 'text') drawText(ctx, fillFx ? { ...L, text: { ...L.text, fill: fillFx.color } } : L, lt);
  else if (L.type === 'video') {
    const v = L.video, el = opts.video?.(v.mediaId, videoTime(L, lt), v.speed || 1), w = v.w || 1920, h = v.h || 1080;
    if (el && v.matte?.id && opts.cut) {
      // ✂ subject cut out with its matte video (mattecut.js); no matte frame yet = nothing (never the whole frame)
      const mt = opts.video(v.matte.id, matteTime(L, lt), v.speed || 1);
      if (mt) ctx.drawImage(opts.cut(el, mt, Math.min(w, 1920), Math.min(w, 1920) * (h / w), v.matte.mode || 'cutout', +v.matte.soft || 0, { choke: (+v.matte.choke || 0) / 100, edge: (v.matte.edge ?? 100) / 100 }), -w / 2, -h / 2, w, h);
    } else if (el) ctx.drawImage(el, -w / 2, -h / 2, w, h);
    else if (opts.placeholder) { ctx.fillStyle = '#ffffff14'; ctx.fillRect(-w / 2, -h / 2, w, h); }
  }
  else if (L.type === 'image') {
    const im = opts.img?.(L.image.mediaId), w = L.image.w || im?.naturalWidth || 400, h = L.image.h || im?.naturalHeight || 300;
    if (im) ctx.drawImage(im, -w / 2, -h / 2, w, h);
    else if (opts.placeholder) { ctx.fillStyle = '#ffffff22'; ctx.fillRect(-w / 2, -h / 2, w, h); }
  }
  ctx.restore();
}
// media ids a comp draws (to load them before a bake)
export const compMedia = (comp) => (comp?.layers || []).filter((l) => l.type === 'image' && l.image?.mediaId).map((l) => l.image.mediaId);
// video layers: the second of the source file shown at comp time t
export const videoTime = (L, t) => (L.video?.in || 0) + Math.max(0, t - (L.in || 0)) * (L.video?.speed || 1);
// a video layer's matte (✂ subject) starts where the layer starts
export const matteTime = (L, t) => Math.max(0, t - (L.in || 0)) * (L.video?.speed || 1);
// every video a comp shows at t, matte videos included: [{ id, t }] (to seek them before a bake / play them)
export const compVideos = (comp, t) => videoLayers(comp, t).flatMap((L) => [{ id: L.video.mediaId, t: videoTime(L, t) }, ...(L.video.matte?.id ? [{ id: L.video.matte.id, t: matteTime(L, t) }] : [])]);
export const videoLayers = (comp, t) => (comp?.layers || []).filter((l) => l.type === 'video' && l.video?.mediaId && !l.hidden && t >= (l.in || 0) && t < (l.out ?? comp.dur));

// ---------------- ready-made comps (AE templates) ----------------
const K = (pairs, e = EASE.easy) => ({ k: pairs.map(([t, v]) => ({ t, v, e: [...e] })) });
export const COMP_PRESETS = {
  blank: { name: 'Empty composition', make: (w, h) => newComp('Comp', w, h, 5) },
  title: { name: '🅰 Title reveal (mask wipe + tracking)', make: (w, h) => {
    const c = newComp('Title reveal', w, h, 5);
    const bar = newLayer('shape', c, { name: 'Accent bar' });
    Object.assign(bar.shape, { size: [Math.round(w * 0.5), 10], roundness: 5, fill: '#ff9933' });
    bar.tr.position = [w / 2, h / 2 + 90]; bar.tr.scale = K([[0, [0, 100]], [0.8, [100, 100]]], EASE.snappy);
    const tx = newLayer('text', c, { name: 'Title' });
    Object.assign(tx.text, { text: 'VIKSIT BHARAT', size: 150, tracking: 200 });
    tx.text.tracking = K([[0, 400], [2.5, 60]], EASE.easyOut); tx.tr.position = [w / 2, h / 2 - 20];
    tx.tr.opacity = K([[0, 0], [0.6, 100]]);
    tx.masks = [{ id: uidM(), name: 'Mask 1', mode: 'add', feather: 40, opacity: 100, expansion: K([[0.2, -600], [1.4, 40]], EASE.easyOut), path: rectPath(-w * 0.45, -120, w * 0.9, 240) }];
    c.layers = [tx, bar];
    return c;
  } },
  lower: { name: '▭ Lower third (slide + typewriter)', make: (w, h) => {
    const c = newComp('Lower third', w, h, 6);
    const box = newLayer('shape', c, { name: 'Box' });
    Object.assign(box.shape, { size: [760, 150], roundness: 12, fill: '#0b2545' });
    box.tr.position = K([[0, [-400, h * 0.8]], [0.7, [520, h * 0.8]], [5.3, [520, h * 0.8]], [6, [-400, h * 0.8]]], EASE.snappy);
    const ac = newLayer('shape', c, { name: 'Saffron edge' });
    Object.assign(ac.shape, { size: [14, 150], roundness: 0, fill: '#ff9933' }); ac.parent = box.id; ac.tr.position = [-373, 0];
    const tx = newLayer('text', c, { name: 'Name' });
    Object.assign(tx.text, { text: 'Name Surname\nDesignation', size: 52, align: 'left', weight: 700 });
    tx.parent = box.id; tx.tr.position = [-340, 0]; tx.text.animators = [TEXT_ANIMS.typewriter.make(1.6)];
    tx.text.animators[0].range.start.k.forEach((k) => (k.t += 0.6));
    c.layers = [tx, ac, box];
    return c;
  } },
  logo: { name: '✴ Logo sting (ring draw + pop)', make: (w, h) => {
    const c = newComp('Logo sting', w, h, 4);
    const ring = newLayer('shape', c, { name: 'Ring' });
    Object.assign(ring.shape, { kind: 'ellipse', size: [420, 420], fillOn: false, strokeW: 14, stroke: '#ff9933' });
    ring.shape.trimEnd = K([[0, 0], [1.2, 100]], EASE.easyOut); ring.tr.rotation = K([[0, -90], [1.2, 0]], EASE.easyOut);
    const dot = newLayer('shape', c, { name: 'Centre' });
    Object.assign(dot.shape, { kind: 'star', size: [260, 260], sides: 12, inner: 0.82, fill: '#138808' });
    dot.tr.scale = K([[0.8, [0, 0]], [1.4, [100, 100]]], EASE.overshoot); dot.tr.rotation = K([[0.8, -60], [3.5, 30]], EASE.easyOut);
    const tx = newLayer('text', c, { name: 'Brand' });
    Object.assign(tx.text, { text: 'LIMELIGHT', size: 90 }); tx.tr.position = [w / 2, h / 2 + 330]; tx.text.animators = [TEXT_ANIMS.fadeUp.make(1)];
    tx.text.animators[0].range.start.k.forEach((k) => (k.t += 1.3));
    c.layers = [tx, dot, ring];
    return c;
  } },
  kinetic: { name: '💬 Kinetic words (pop + wave)', make: (w, h) => {
    const c = newComp('Kinetic words', w, h, 5);
    const tx = newLayer('text', c, { name: 'Words' });
    Object.assign(tx.text, { text: 'नशा मुक्त\nभारत', size: 170 });
    tx.text.animators = [TEXT_ANIMS.popWords.make(1.2), TEXT_ANIMS.colorSweep.make(4)];
    tx.tr.position = [w / 2, h / 2];
    c.layers = [tx];
    return c;
  } },
  matte: { name: '◐ Text-matte reveal (shape through text)', make: (w, h) => {
    const c = newComp('Text matte', w, h, 5);
    const tx = newLayer('text', c, { name: 'Matte text' });
    Object.assign(tx.text, { text: 'BHARAT', size: 320, weight: 900 }); tx.tr.position = [w / 2, h / 2];
    const grad = newLayer('shape', c, { name: 'Fill (through the text)' });
    Object.assign(grad.shape, { kind: 'rect', size: [w * 1.5, 400], fill: '#ff9933', roundness: 0 });
    grad.tr.position = K([[0, [-w * 0.4, h / 2]], [3, [w * 1.4, h / 2]]], EASE.easy); grad.tr.rotation = -12;
    grad.matte = 'alpha';
    const back = newLayer('text', c, { name: 'Outline' });
    Object.assign(back.text, { text: 'BHARAT', size: 320, weight: 900, fill: '#ffffff', strokeW: 0 }); back.tr.position = [w / 2, h / 2]; back.tr.opacity = 25;
    c.layers = [tx, grad, back];
    return c;
  } },
};
export function rectPath(x, y, w, h) { return [[x, y, 0, 0, 0, 0], [x + w, y, 0, 0, 0, 0], [x + w, y + h, 0, 0, 0, 0], [x, y + h, 0, 0, 0, 0]]; }
export function ellipsePath(cx, cy, rx, ry) { const k = 0.5523; return [[cx, cy - ry, -rx * k, 0, rx * k, 0], [cx + rx, cy, 0, -ry * k, 0, ry * k], [cx, cy + ry, rx * k, 0, -rx * k, 0], [cx - rx, cy, 0, ry * k, 0, -ry * k]]; }
// every keyframe time of a layer (for the timeline's diamonds and J/K jumps)
export function layerKeys(L) {
  const out = [];
  const walk = (o, path) => { if (!o || typeof o !== 'object') return; if (isAnim(o)) { out.push({ path, keys: o.k }); return; } for (const [k, v] of Object.entries(o)) if (k !== 'path') walk(v, [...path, k]); };
  walk({ tr: L.tr, text: L.text, shape: L.shape, solid: L.solid, masks: L.masks, effects: L.effects }, []);
  return out;
}
export const getIn = (o, path) => path.reduce((a, k) => (a == null ? a : a[k]), o);
export function setIn(o, path, v) { let a = o; for (let i = 0; i < path.length - 1; i++) a = a[path[i]] ??= typeof path[i + 1] === 'number' ? [] : {}; a[path[path.length - 1]] = v; }
