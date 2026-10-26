// gfxparams.js - 🎛 every part of a preset editable, for all the templates at once. A graphic keeps its own fields (words,
// data, look...) and, beside them, g.ed - what the editor changed on top of the design:
//   ed.t[key]  one text of the preset (key = its field: title, sub, tagline...; '_' = any other text, numbers):
//              { font, size (×), weight, italic, color, x, y (% of the frame), op, from, to (s), outline, outlineW, shadow }
//   ed.logo    { size (×), x, y (% of the frame), shape: circle | rounded | square }
//   ed.cmap    every colour the preset draws with, swapped: { '#ff9933': '#22aa55' } (any alpha of it follows)
//   ed.sh      shapes and lines: { op (opacity ×), lw (line thickness ×) }
//   ed.n       the preset's own knobs (GFX[tpl].knobs: how many shapes, how far they fly...)
//   ed.bg      background: { mode: solid | grad | image | none, c1, c2, angle, img (media id), dim }
//   ed.time    { delay, speed, fadeIn, fadeOut, feel (easing: smooth | snappy | bouncy | linear) }
//   ed.lay     the whole graphic: { x, y (% of the frame), zoom (×), rot (degrees) }
// Nothing in g.ed = the preset exactly as designed. drawGraphic (graphics.js) applies it through a thin wrapper around
// the canvas, so the drawings of the templates stay as they are - and the viewer, the Presets page and the render (the
// bake draws the same frames) all show the same thing.

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const num = (v, d) => (v === '' || v == null || !Number.isFinite(+v) ? d : +v);
const empty = (o) => !o || typeof o !== 'object' || !Object.keys(o).some((k) => (o[k] && typeof o[k] === 'object' ? !empty(o[k]) : o[k] !== undefined && o[k] !== ''));
export const hasEdit = (g) => !!g?.ed && !empty(g.ed);
// drops what is empty (a field cleared, a section reset) - nothing left = no g.ed (the graphic as it always was)
export function tidyEd(g) {
  const walk = (o) => { for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === 'object') { walk(v); if (!Object.keys(v).length) delete o[k]; } else if (v === undefined || v === '' || v === null) delete o[k]; } };
  if (g?.ed && typeof g.ed === 'object') { walk(g.ed); if (!Object.keys(g.ed).length) delete g.ed; }
  return g;
}

// ---------------- the graphic being drawn (drawing is synchronous: set by drawGraphic, read by the templates) ----------------
export const CUR = { g: null, W: 1920, H: 1080, feel: '' };
export function setCur(g, W, H) { CUR.g = g; CUR.W = W; CUR.H = H; CUR.feel = g?.ed?.time?.feel || ''; }
// a preset's own knob (GFX[tpl].knobs), e.g. kn('count', 9)
export const kn = (k, d) => num(CUR.g?.ed?.n?.[k], d);

// ---------------- 🎢 motion feel: every ease of the template swapped for one curve ----------------
const back = (c) => (u) => 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2);
const CURVES = {
  smooth: (u) => 0.5 - Math.cos(Math.PI * u) / 2,
  snappy: (u) => (u >= 1 ? 1 : 1 - Math.pow(2, -12 * u)),
  bouncy: back(2.6),
  linear: (u) => u,
};
export const FEELS = [['', 'As designed'], ['smooth', 'Smooth'], ['snappy', 'Snappy'], ['bouncy', 'Bouncy'], ['linear', 'Linear']];
export const eased = (f) => (u) => (CUR.feel && CURVES[CUR.feel] ? CURVES[CUR.feel](clamp(u)) : f(u));

// ---------------- ⏱ timing ----------------
// the animation's own clock: starts `delay` s into the clip, runs `speed` times as fast (its end moves with it)
export function editTime(g, t, dur) {
  const T = g?.ed?.time; if (!T) return [t, dur];
  const d = Math.max(0, num(T.delay, 0)), s = clamp(num(T.speed, 1), 0.1, 10);
  return [Math.max(0, t - d) * s, Math.max(0.05, dur - d) * s];
}
// the fade of the whole graphic (clip time): out over the last fadeOut s (the designs' 0.4 s), in over the first fadeIn s
export function editFade(g, t, dur, defOut = 0.4) {
  const T = g?.ed?.time || {}, fo = Math.max(0, num(T.fadeOut, defOut)), fi = Math.max(0, num(T.fadeIn, 0));
  return (fo > 0 ? clamp((dur - t) / fo) : 1) * (fi > 0 ? clamp(t / fi) : 1);
}

// ---------------- 🎨 colours ----------------
const NAMED = { white: '#ffffff', black: '#000000', red: '#ff0000' };
const hx = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
// a colour text -> { hex: '#rrggbb', a } (null: a gradient, 'transparent', a name we do not know)
export function parseCol(s) {
  if (typeof s !== 'string') return null;
  const v = NAMED[s.trim().toLowerCase()] || s.trim();
  let m = /^#([\da-f])([\da-f])([\da-f])$/i.exec(v);
  if (m) return { hex: `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase(), a: 1 };
  m = /^#([\da-f]{6})([\da-f]{2})?$/i.exec(v);
  if (m) return { hex: `#${m[1].toLowerCase()}`, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (m) return { hex: `#${hx(m[1])}${hx(m[2])}${hx(m[3])}`, a: m[4] === undefined ? 1 : +m[4] };
  return null;
}
const withAlpha = (hex, a) => { if (a >= 1) return hex; const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${+a.toFixed(3)})`; };
// a colour through the swaps (rec: count what the preset uses - the Colours section lists them)
export function mapCol(v, cmap, rec) {
  const c = parseCol(v); if (!c) return v;
  if (rec) rec.set(c.hex, (rec.get(c.hex) || 0) + 1);
  const to = cmap && parseCol(cmap[c.hex]);
  return to ? withAlpha(to.hex, c.a * to.a) : v;
}

// ---------------- 🔤 which text of the preset is being drawn ----------------
// the texts of a template: its text / area fields (and the heading when it has one), '_' for everything else
const norm = (s) => String(s ?? '').replace(/[*_|#▌]+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
export function textSources(fields, g) {
  return fields.filter((f) => f.type === 'text' || f.type === 'area').map((f) => {
    const v = String(g?.[f.k] ?? ''), ls = v.split(/\r?\n/).map(norm).filter(Boolean);
    const parts = ls.flatMap((l) => l.split(/\s*[,|:]\s*/).map(norm).filter(Boolean));
    return { k: f.k, label: f.label, all: norm(v), cands: [...new Set([...ls, ...parts])] };
  });
}
// the text key a drawn string belongs to: the whole field, one of its lines / parts, or typed so far
export function matchText(srcs, s) {
  const n = norm(s); if (!n) return '_';
  for (const x of srcs) if (x.all === n || x.cands.includes(n)) return x.k;
  for (const x of srcs) if (x.cands.some((c) => c.startsWith(n) || (n.length > 1 && (c.includes(n) || (c.length > 1 && n.includes(c)))))) return x.k;
  return '_';
}
// "700 52px family" with a text's own font / weight / size
export function fontWith(font, e) {
  const m = /^(.*?)(\d*\.?\d+)px(\/\S+)?\s+(.+)$/.exec(String(font || ''));
  if (!m) return font;
  let pre = m[1], px = +m[2] * clamp(num(e.size, 1), 0.1, 8);
  if (e.weight) pre = /\b(\d{3}|bold|normal|lighter|bolder)\b/.test(pre) ? pre.replace(/\b(\d{3}|bold|normal|lighter|bolder)\b/, e.weight) : `${pre}${e.weight} `;
  if (e.italic && !/italic/.test(pre)) pre = `italic ${pre}`;
  const fam = e.font ? `"${String(e.font).replace(/"/g, '')}", ${m[4]}` : m[4];
  return `${pre}${+px.toFixed(2)}px ${fam}`;
}
const textOn = (e) => e && ['font', 'size', 'weight', 'italic', 'color', 'x', 'y', 'op', 'from', 'to', 'outline', 'shadow'].some((k) => e[k] !== undefined && e[k] !== '' && e[k] !== false);
const fontOn = (e) => e && (e.font || e.weight || e.italic || (e.size !== undefined && +e.size !== 1));

// ---------------- the canvas wrapper ----------------
// R = { t (clip s), W, H, srcs, rec } - the colour swaps, the texts' own styles, shapes' opacity / line thickness
const ORIG = Symbol('addColorStop');
export function editCtx(ctx, g, R) {
  const ed = g.ed || {}, cmap = ed.cmap, T = ed.t || {}, sh = ed.sh || {}, op = clamp(num(sh.op, 1), 0, 1), lw = clamp(num(sh.lw, 1), 0, 10);
  const cache = new Map(), key = (s) => { let k = cache.get(s); if (k === undefined) { k = matchText(R.srcs, s); cache.set(s, k); } return k; };
  const styleOf = (s) => { const e = T[key(s)]; return textOn(e) ? e : null; };
  const win = (e) => { const a = num(e.from, 0), b = num(e.to, 0), f = 0.25; return clamp((R.t - a) / f + (a > 0 ? 0 : 1)) * (b > 0 ? clamp((b - R.t) / f) : 1); };
  const col = (v) => mapCol(v, cmap, R.rec);
  const text = (fn) => (s, x, y, mw) => {
    const e = styleOf(s), args = mw === undefined ? [s, x, y] : [s, x, y, mw];
    if (!e) return ctx[fn](...args);
    ctx.save();
    ctx.globalAlpha *= clamp(num(e.op, 1)) * win(e);
    if (fontOn(e)) ctx.font = fontWith(ctx.font, e);
    if (e.color) ctx[fn === 'strokeText' ? 'strokeStyle' : 'fillStyle'] = e.color;
    ctx.translate((num(e.x, 0) / 100) * R.W, (num(e.y, 0) / 100) * R.H);
    if (e.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = R.H * 0.012; ctx.shadowOffsetY = R.H * 0.003; }
    if (e.outline && fn === 'fillText') { ctx.strokeStyle = e.outline; ctx.lineWidth = (num(e.outlineW, 4) * R.H) / 1080; ctx.lineJoin = 'round'; ctx.strokeText(...args); }
    ctx[fn](...args);
    ctx.restore();
  };
  const shape = (fn) => (op === 1 ? ctx[fn].bind(ctx) : (...a) => { ctx.save(); ctx.globalAlpha *= op; ctx[fn](...a); ctx.restore(); });
  const grad = (fn) => (...a) => { const gr = ctx[fn](...a); if (gr && typeof gr === 'object') { const add = (gr[ORIG] ||= gr.addColorStop); gr.addColorStop = (o, c) => add.call(gr, o, col(c)); } return gr; };
  const HOOK = {
    fillText: text('fillText'), strokeText: text('strokeText'),
    measureText: (s) => { const e = styleOf(s); if (!e || !fontOn(e)) return ctx.measureText(s); const f = ctx.font; ctx.font = fontWith(f, e); const m = ctx.measureText(s); ctx.font = f; return m; },
    fill: shape('fill'), stroke: shape('stroke'), fillRect: shape('fillRect'), strokeRect: shape('strokeRect'),
    createLinearGradient: grad('createLinearGradient'), createRadialGradient: grad('createRadialGradient'), createConicGradient: grad('createConicGradient'),
  };
  const bound = new Map();
  return new Proxy(ctx, {
    get(t, k) {
      if (HOOK[k]) return HOOK[k];
      const v = t[k];
      if (typeof v !== 'function') return v;
      let b = bound.get(k); if (!b) { b = v.bind(t); bound.set(k, b); }
      return b;
    },
    set(t, k, v) {
      if (k === 'fillStyle' || k === 'strokeStyle' || k === 'shadowColor') v = col(v);
      else if (k === 'lineWidth' && lw !== 1) v *= lw;
      t[k] = v; return true;
    },
  });
}

// ---------------- 🖼 background and layout ----------------
export const bgOn = (g) => ['solid', 'grad', 'image', 'none'].includes(g?.ed?.bg?.mode);
// draws the background chosen (true: it replaced the preset's own one)
export function drawBg(ctx, W, H, g, img) {
  const b = g?.ed?.bg; if (!bgOn(g)) return false;
  if (b.mode === 'solid') { ctx.fillStyle = b.c1 || '#0b2545'; ctx.fillRect(0, 0, W, H); }
  if (b.mode === 'grad') {
    const a = (num(b.angle, 90) * Math.PI) / 180, r = Math.hypot(W, H) / 2, dx = Math.sin(a) * r, dy = -Math.cos(a) * r;
    const gr = ctx.createLinearGradient(W / 2 - dx, H / 2 - dy, W / 2 + dx, H / 2 + dy);
    gr.addColorStop(0, b.c1 || '#0b2545'); gr.addColorStop(1, b.c2 || '#13315c'); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  }
  if (b.mode === 'image') {
    const im = img?.(b.img);
    if (im?.naturalWidth) { const k = Math.max(W / im.naturalWidth, H / im.naturalHeight), w = im.naturalWidth * k, h = im.naturalHeight * k; ctx.drawImage(im, (W - w) / 2, (H - h) / 2, w, h); }
    else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
  }
  const dim = clamp(num(b.dim, 0));
  if (dim > 0 && b.mode !== 'none') { ctx.fillStyle = `rgba(0,0,0,${dim})`; ctx.fillRect(0, 0, W, H); }
  return true;
}
export function applyLayout(ctx, W, H, g) {
  const L = g?.ed?.lay; if (!L) return;
  const x = (num(L.x, 0) / 100) * W, y = (num(L.y, 0) / 100) * H, z = clamp(num(L.zoom, 1), 0.05, 10), r = (num(L.rot, 0) * Math.PI) / 180;
  if (!x && !y && z === 1 && !r) return;
  ctx.translate(W / 2 + x, H / 2 + y); ctx.rotate(r); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2);
}

// ---------------- 🔘 the logo ----------------
// its size (×) and move (px) for the graphic being drawn
export function logoEdit() {
  const L = CUR.g?.ed?.logo || {};
  return { k: clamp(num(L.size, 1), 0.05, 8), dx: (num(L.x, 0) / 100) * CUR.W, dy: (num(L.y, 0) / 100) * CUR.H, shape: L.shape || '' };
}
// the shape a logo / its placeholder is cut to (a path at the box; false = as designed)
export function logoPath(ctx, x, y, w, h, shape) {
  if (!shape) return false;
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
  else if (shape === 'rounded' && ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.2);
  else ctx.rect(x, y, w, h);
  return true;
}
