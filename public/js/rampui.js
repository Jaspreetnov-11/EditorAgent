// ⏩ Speed ramp editor (Effect Controls > Speed ramp): presets as little curves, and a graph to draw your own -
// across = position in the shot, up = speed (0.1× … 5×, 1× is the dotted line). Click to add a point, drag to move,
// double-click a point to remove it. Drawing makes the clip's ramp 'custom' (model.js rampPts), so the viewer and the
// render follow it exactly. Ramped shots are silent (the music carries them), as before.
import { RAMPS, rampPts, clipDur, setRamp } from './model.js';
import { S } from './store.js';
import { $, $$, esc } from './ui.js';

const LO = Math.log(0.1), HI = Math.log(5);
const yOf = (s, h, pad) => pad + (1 - (Math.log(Math.max(0.1, Math.min(5, s))) - LO) / (HI - LO)) * (h - 2 * pad);
const sOf = (y, h, pad) => Math.exp(LO + (1 - (y - pad) / (h - 2 * pad)) * (HI - LO));
const smooth = (u) => u * u * (3 - 2 * u);
function at(pts, u) {
  if (u <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) { const [a, sa] = pts[i], [b, sb] = pts[i + 1]; if (u <= b) return sa + (sb - sa) * smooth((u - a) / Math.max(1e-6, b - a)); }
  return pts[pts.length - 1][1];
}
function curve(g, pts, w, h, pad, colour, lw = 2) {
  g.strokeStyle = colour; g.lineWidth = lw; g.beginPath();
  for (let i = 0; i <= 100; i++) { const u = i / 100, x = pad + u * (w - 2 * pad), y = yOf(at(pts, u), h, pad); i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
}

// box: element to fill; clip(): the clip; live(): redraw the viewer; done(label): commit
export function mountRamp(box, clip, live, done) {
  box.innerHTML = `<div class="rp-presets">${[['', 'None', null], ...Object.entries(RAMPS).map(([k, r]) => [k, r.label, r.pts])].map(([k, l]) => `<button class="rp-p" data-rp="${k}" title="${esc(l)}"><canvas width="84" height="34"></canvas><span>${esc(l.replace(/\s*\(.*\)/, ''))}</span></button>`).join('')}</div>
    <canvas class="rp-graph" width="560" height="200" aria-label="Speed ramp graph"></canvas>
    <div class="rp-info muted small"></div>`;
  $$('[data-rp]', box).forEach((b) => {
    const k = b.dataset.rp, cv = $('canvas', b), g = cv.getContext('2d');
    g.strokeStyle = '#ffffff22'; g.setLineDash([2, 2]); g.beginPath(); g.moveTo(2, yOf(1, 34, 3)); g.lineTo(82, yOf(1, 34, 3)); g.stroke(); g.setLineDash([]);
    if (RAMPS[k]) curve(g, RAMPS[k].pts, 84, 34, 3, '#ff9933', 1.6);
    b.onclick = () => {
      const c = clip(); if (!c) return;
      setRamp(c, k, S.mediaById); // (the shot keeps its length on the timeline; only the speed inside changes)
      done(k ? `Speed ramp: ${RAMPS[k].label}` : 'No speed ramp'); draw();
    };
  });
  const cv = $('.rp-graph', box), g = cv.getContext('2d'), pad = 14;
  let drag = null;
  const pts = () => (rampPts(clip()) || [[0, 1], [1, 1]]).map((p) => [...p]);
  function draw() {
    const c = clip(); if (!c) return;
    const w = cv.width, h = cv.height, P = rampPts(c);
    g.clearRect(0, 0, w, h); g.fillStyle = '#0b0c0f'; g.fillRect(0, 0, w, h);
    g.font = '10px Consolas, monospace'; g.fillStyle = '#7d8696';
    for (const s of [0.25, 0.5, 1, 2, 4]) { const y = yOf(s, h, pad); g.strokeStyle = s === 1 ? '#ffffff40' : '#ffffff12'; g.setLineDash(s === 1 ? [4, 4] : []); g.beginPath(); g.moveTo(pad, y); g.lineTo(w - pad, y); g.stroke(); g.fillText(`${s}×`, 2, y - 2); }
    g.setLineDash([]);
    const Q = P || [[0, 1], [1, 1]];
    curve(g, Q, w, h, pad, P ? '#ff9933' : '#ffffff55', 2.5);
    if (P) for (const [u, s] of Q) { const x = pad + u * (w - 2 * pad), y = yOf(s, h, pad); g.fillStyle = '#111'; g.strokeStyle = '#ff9933'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); g.stroke(); }
    $$('[data-rp]', box).forEach((b) => b.classList.toggle('on', (b.dataset.rp || '') === (c.ramp && c.ramp !== 'custom' ? c.ramp : c.ramp ? '__' : '')));
    const D = clipDur(c, S.mediaById);
    $('.rp-info', box).textContent = P ? `${c.ramp === 'custom' ? 'Custom ramp' : RAMPS[c.ramp]?.label} · shot is ${D.toFixed(2)} s on the timeline · slowest ${Math.min(...Q.map((p) => p[1])).toFixed(2)}× · fastest ${Math.max(...Q.map((p) => p[1])).toFixed(2)}×` : 'No ramp - click a preset, or click on the graph to start your own.';
  }
  const evPt = (e) => { const r = cv.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * cv.width, y = ((e.clientY - r.top) / r.height) * cv.height; return [Math.min(1, Math.max(0, (x - pad) / (cv.width - 2 * pad))), +sOf(y, cv.height, pad).toFixed(3), x, y]; };
  const nearest = (P, x, y) => P.findIndex(([u, s]) => Math.hypot(pad + u * (cv.width - 2 * pad) - x, yOf(s, cv.height, pad) - y) < 10);
  const set = (P) => { const c = clip(); setRamp(c, 'custom', S.mediaById, P.map(([u, s]) => [+u.toFixed(4), +Math.max(0.1, Math.min(5, s)).toFixed(3)]), drag?.D); };
  cv.addEventListener('pointerdown', (e) => {
    const c = clip(); if (!c || S.readOnly) return;
    const [u, s, x, y] = evPt(e), P = pts();
    let i = nearest(P, x, y);
    if (i < 0) { P.push([u, s]); P.sort((a, b) => a[0] - b[0]); i = P.findIndex((p) => p[0] === u && p[1] === s); }
    drag = { P, i, D: clipDur(c, S.mediaById) }; cv.setPointerCapture(e.pointerId); set(P); live(); draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [u, s] = evPt(e), { P, i } = drag;
    const lo = i === 0 ? 0 : P[i - 1][0] + 0.01, hi = i === P.length - 1 ? 1 : P[i + 1][0] - 0.01;
    P[i] = [i === 0 ? 0 : i === P.length - 1 ? 1 : Math.min(hi, Math.max(lo, u)), e.shiftKey ? 1 : s];
    set(P); live(); draw();
  });
  const up = () => { if (drag) { drag = null; done('Speed ramp (custom)'); draw(); } };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('dblclick', (e) => {
    const [, , x, y] = evPt(e), P = pts(), i = nearest(P, x, y);
    if (i > 0 && i < P.length - 1) { P.splice(i, 1); set(P); done('Remove ramp point'); draw(); }
  });
  draw();
  return { draw };
}
