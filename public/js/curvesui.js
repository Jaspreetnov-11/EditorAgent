// Lumetri-style curves for the Color page: RGB Curves (Master / Red / Green / Blue) and Hue Saturation Curves
// (Hue vs Sat, Hue vs Hue, Hue vs Luma, Luma vs Sat, Sat vs Sat). The maths is colormath.js curveTable/applyCurves,
// shared with the WebGL preview and the renderer.
//   click on the line = add a point · drag = move · double-click a point (or right-click) = remove · double-click empty = reset
import { curveTable } from './colormath.js';
import { $, $$, esc } from './ui.js';

const RGB = [['m', 'Master', '#e8e8e8'], ['r', 'Red', '#ff5a5a'], ['g', 'Green', '#5ad65a'], ['b', 'Blue', '#5aa0ff']];
const HUE = [
  ['hs', 'Hue vs Sat', 'Make one colour stronger or weaker'],
  ['hh', 'Hue vs Hue', 'Shift one colour into another'],
  ['hl', 'Hue vs Luma', 'Make one colour brighter or darker'],
  ['ls', 'Luma vs Sat', 'Saturation in shadows / highlights'],
  ['ss', 'Sat vs Sat', 'Push or calm already strong colours'],
];
const WRAP = new Set(['hh', 'hs', 'hl']);

// box: the element to fill; mode 'rgb' | 'hue'; api: { clip(), live(), commit(label) }
export function mountCurves(box, mode, api) {
  let ch = mode === 'rgb' ? 'm' : 'hs', drag = null;
  const list = mode === 'rgb' ? RGB : HUE;
  box.innerHTML = `<div class="cv-wrap">
    <div class="cv-side">
      <div class="segbtns cv-ch">${list.map(([k, l, c]) => `<button data-cv="${k}" ${mode === 'rgb' ? `style="--cvc:${c}"` : `title="${esc(c)}"`}>${l}</button>`).join('')}</div>
      <p class="muted small cv-help">Click the line to add a point, drag to shape it. Double-click a point to remove it.${mode === 'hue' ? ' 0.5 (the middle line) = no change.' : ''}</p>
      <button class="small" data-cvreset="one">↺ Reset this curve</button>
      <button class="small" data-cvreset="all">↺ Reset all ${mode === 'rgb' ? 'RGB' : 'hue'} curves</button>
    </div>
    <canvas class="cv-c" width="300" height="300" aria-label="${mode === 'rgb' ? 'RGB curves' : 'Hue saturation curves'}"></canvas>
  </div>`;
  const cv = $('.cv-c', box), g = cv.getContext('2d');
  const group = () => (mode === 'rgb' ? 'curves' : 'hue');
  const get = () => (api.clip()?.color?.[group()]?.[ch] || []).map((p) => [...p]);
  const set = (P) => {
    const c = api.clip(); if (!c) return;
    c.color = { ...(c.color || {}) };
    const grp = { ...(c.color[group()] || {}) };
    if (P.length) grp[ch] = P.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]); else delete grp[ch];
    if (Object.keys(grp).length) c.color[group()] = grp; else delete c.color[group()];
  };
  const W = () => cv.width, H = () => cv.height, pad = 10;
  const toPx = ([x, y]) => [pad + x * (W() - 2 * pad), H() - pad - y * (H() - 2 * pad)];
  const fromEv = (e) => {
    const b = cv.getBoundingClientRect();
    return [Math.min(1, Math.max(0, ((e.clientX - b.left) * (W() / b.width) - pad) / (W() - 2 * pad))), Math.min(1, Math.max(0, (H() - pad - (e.clientY - b.top) * (H() / b.height)) / (H() - 2 * pad)))];
  };
  const kind = () => (mode === 'rgb' ? 'rgb' : WRAP.has(ch) ? 'wrap' : 'flat');

  function draw() {
    const w = W(), hh = H(), P = get();
    g.clearRect(0, 0, w, hh);
    // background: hue strip for hue curves, gradient for luma/sat
    if (mode === 'hue') {
      const gr = g.createLinearGradient(pad, 0, w - pad, 0);
      if (WRAP.has(ch)) for (let i = 0; i <= 6; i++) gr.addColorStop(i / 6, `hsl(${i * 60}, 80%, 45%)`);
      else if (ch === 'ls') { gr.addColorStop(0, '#000'); gr.addColorStop(1, '#fff'); }
      else { gr.addColorStop(0, '#777'); gr.addColorStop(1, 'hsl(10, 90%, 50%)'); }
      g.globalAlpha = 0.28; g.fillStyle = gr; g.fillRect(pad, pad, w - 2 * pad, hh - 2 * pad); g.globalAlpha = 1;
    }
    g.strokeStyle = '#ffffff14'; g.lineWidth = 1; g.beginPath();
    for (let i = 0; i <= 4; i++) { const x = pad + (i / 4) * (w - 2 * pad), y = pad + (i / 4) * (hh - 2 * pad); g.moveTo(x, pad); g.lineTo(x, hh - pad); g.moveTo(pad, y); g.lineTo(w - pad, y); }
    g.stroke();
    g.strokeStyle = '#ffffff30'; g.beginPath();
    if (mode === 'rgb') { g.moveTo(...toPx([0, 0])); g.lineTo(...toPx([1, 1])); } else { g.moveTo(...toPx([0, 0.5])); g.lineTo(...toPx([1, 0.5])); }
    g.stroke();
    // other RGB curves faintly, so the whole look is visible
    if (mode === 'rgb') for (const [k, , col] of RGB) {
      if (k === ch) continue;
      const pk = api.clip()?.color?.curves?.[k]; if (!pk?.length) continue;
      line(curveTable(pk, 'rgb'), col, 0.35);
    }
    const colour = mode === 'rgb' ? RGB.find((x) => x[0] === ch)[2] : '#ff9933';
    line(curveTable(P, kind()), colour, 1);
    for (const p of P) { const [x, y] = toPx(p); g.fillStyle = '#111'; g.strokeStyle = colour; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); g.stroke(); }
    $$('[data-cv]', box).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.cv === ch)));
    $$('[data-cv]', box).forEach((b) => b.classList.toggle('has', !!api.clip()?.color?.[group()]?.[b.dataset.cv]?.length));
    box.classList.toggle('dis', !api.clip());
  }
  function line(t, col, alpha) {
    g.globalAlpha = alpha; g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < t.length; i++) { const [x, y] = toPx([i / (t.length - 1), t[i]]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke(); g.globalAlpha = 1;
  }
  const near = (P, q) => {
    const [qx, qy] = toPx(q); let best = -1, bd = 12 * (W() / cv.getBoundingClientRect().width || 1);
    P.forEach((p, i) => { const [x, y] = toPx(p), d = Math.hypot(x - qx, y - qy); if (d < bd) { bd = d; best = i; } });
    return best;
  };

  cv.addEventListener('pointerdown', (e) => {
    if (!api.clip() || e.button === 2) return;
    const q = fromEv(e), P = get();
    let i = near(P, q);
    if (i < 0) {
      if (mode === 'rgb' && !P.length) P.push([0, 0], [1, 1]); // the ends become handles too (Lumetri)
      if (WRAP.has(ch) && !P.length) P.push([(q[0] + 0.92) % 1, 0.5], [(q[0] + 0.08) % 1, 0.5]); // two anchors keep the change local
      P.push(q); P.sort((a, b) => a[0] - b[0]); i = P.findIndex((p) => p === q);
    }
    drag = { P, i };
    cv.setPointerCapture(e.pointerId);
    set(P); api.live(); draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const q = fromEv(e), { P, i } = drag;
    const lo = i > 0 ? P[i - 1][0] + 0.005 : 0, hi = i < P.length - 1 ? P[i + 1][0] - 0.005 : 1;
    P[i] = [WRAP.has(ch) ? q[0] : Math.min(hi, Math.max(lo, q[0])), q[1]];
    set(P); api.live(); draw();
  });
  const end = () => { if (!drag) return; drag = null; api.commit(`${labelOf()} curve`); };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  const removeAt = (e) => {
    const P = get(), i = near(P, fromEv(e));
    if (i < 0) return false;
    P.splice(i, 1);
    set(mode === 'rgb' && P.length === 2 && P[0][0] === 0 && P[0][1] === 0 && P[1][0] === 1 && P[1][1] === 1 ? [] : P);
    api.commit(`Remove ${labelOf()} point`); return true;
  };
  cv.addEventListener('dblclick', (e) => { if (!api.clip()) return; if (!removeAt(e)) { set([]); api.commit(`Reset ${labelOf()} curve`); } });
  cv.addEventListener('contextmenu', (e) => { e.preventDefault(); if (api.clip()) removeAt(e); });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cv]'); if (b) { ch = b.dataset.cv; draw(); return; }
    const r = e.target.closest('[data-cvreset]')?.dataset.cvreset; if (!r || !api.clip()) return;
    if (r === 'one') set([]);
    else { const c = api.clip(); if (c.color) { delete c.color[group()]; } }
    api.commit(r === 'one' ? `Reset ${labelOf()} curve` : `Reset ${mode === 'rgb' ? 'RGB' : 'hue'} curves`);
  });
  new ResizeObserver(() => { const b = cv.getBoundingClientRect(), s = Math.max(120, Math.floor(Math.min(b.width, b.height) * Math.min(2, devicePixelRatio || 1))); if (s && s !== cv.width) { cv.width = s; cv.height = s; draw(); } }).observe(cv);
  const labelOf = () => list.find((x) => x[0] === ch)[1];
  return { draw };
}
