// ⏩ Speed ramp editor (Effect Controls > Speed ramp), like Premiere's Time Remapping: presets as little curves, and a
// speed graph - across = time in the shot, up = speed in % (10% … 1000%, 100% is the dotted line).
//   · a flat stretch between two keyframes is a speed segment: drag it up / down to change that speed (the rubber band)
//   · Ctrl + click on the line: a speed keyframe there (the segment splits in two - drag one half to change its speed)
//   · drag a keyframe sideways to widen / narrow the smooth ramp between two speeds (the shaded part); up / down too
//   · double-click a keyframe to remove it; Shift while dragging snaps to 100%
// It is the clip's ramp points (model.js rampPts: [u 0..1, speed]) - the viewer and the render play exactly this.
// The shot keeps its length on the timeline (nothing moves); ramped shots are silent (the music carries them).
import { RAMPS, RAMP_EASES, rampPts, clipDur, setRamp, profileAt } from './model.js';
import { S, layout } from './store.js';
import { $, $$, esc } from './ui.js';

const MIN = 0.1, MAX = 10, LO = Math.log(MIN), HI = Math.log(MAX);
const yOf = (s, h, pad) => pad + (1 - (Math.log(Math.max(MIN, Math.min(MAX, s))) - LO) / (HI - LO)) * (h - 2 * pad);
const sOf = (y, h, pad) => Math.exp(LO + (1 - (y - pad) / (h - 2 * pad)) * (HI - LO));
const pct = (s) => `${Math.round(s * 100)}%`;
const at = profileAt; // (the same curve the viewer and the render play - a cut part's eased pieces too)
// xf: where u (0..1) is across the canvas - the graph's own, so the line goes exactly through its keyframes
function curve(g, pts, w, h, pad, colour, lw = 2, xf = (u) => pad + u * (w - 2 * pad)) {
  g.strokeStyle = colour; g.lineWidth = lw; g.beginPath();
  for (let i = 0; i <= 240; i++) { const u = i / 240, x = xf(u), y = yOf(at(pts, u), h, pad); i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
}
const flat = (a, b) => Math.abs(Math.log(a[1]) - Math.log(b[1])) < 0.02; // (the same speed: a segment, not a ramp)

// box: element to fill; clip(): the clip; live(): redraw the viewer; done(label): commit
export function mountRamp(box, clip, live, done) {
  box.innerHTML = `<div class="rp-presets">${[['', 'None', null], ...Object.entries(RAMPS).map(([k, r]) => [k, r.label, r.pts])].map(([k, l]) => `<button class="rp-p" data-rp="${k}" title="${esc(l)}"><canvas width="84" height="34"></canvas><span>${esc(l.replace(/\s*\(.*\)/, ''))}</span></button>`).join('')}</div>
    <div class="rp-bar"><b class="rp-read">Speed</b><label class="rp-num" title="Type the speed (10% … 1000%): of the keyframe picked in the graph, or of the whole shot when none is picked"><input type="number" data-rpv min="10" max="1000" step="1" aria-label="Speed in percent"> %</label><span class="grow"></span><button class="small" data-rpa="key" title="A speed keyframe at the playhead (or Ctrl + click on the line)">◆ Keyframe at playhead</button><button class="small" data-rpa="reset" title="Back to 100% all the way">100% all</button></div>
    <canvas class="rp-graph" width="620" height="340" tabindex="0" aria-label="Speed graph (Time Remapping)"></canvas>
    <div class="rp-ease"><span class="muted small" data-rpe-for>Ease (all ramps)</span>${RAMP_EASES.map(([k, l]) => `<button class="small" data-rpe="${k}" title="${esc(l)}${k === 'io' ? '' : k === 'in' ? ' (Shift+F9)' : k === 'out' ? ' (Ctrl+Shift+F9)' : ''}">${esc(l.replace(' (F9)', ''))}</button>`).join('')}</div>
    <div class="rp-info muted small"></div>
    <small class="hint">Drag a flat part up / down to change its speed · Ctrl + click the line for a keyframe · drag a keyframe sideways to widen the ramp · double-click one to remove it · Shift = 100%</small>`;
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
  const cv = $('.rp-graph', box), g = cv.getContext('2d'), pad = 18, padL = 40;
  let drag = null, hover = null, sel = -1; // sel: the keyframe picked (its ramp gets the ease buttons)
  const W = () => cv.width, H = () => cv.height;
  const xOf = (u) => padL + u * (W() - padL - pad), uOf = (x) => Math.min(1, Math.max(0, (x - padL) / (W() - padL - pad)));
  const pts = () => (rampPts(clip()) || [[0, 1], [1, 1]]).map((p) => [...p]);
  const D = () => clipDur(clip(), S.mediaById);
  function draw() {
    const c = clip(); if (!c) return;
    const w = W(), h = H(), P = rampPts(c), Q = P || [[0, 1], [1, 1]];
    g.clearRect(0, 0, w, h); g.fillStyle = '#0b0c0f'; g.fillRect(0, 0, w, h);
    g.font = '10px Consolas, monospace';
    for (const s of [0.1, 0.25, 0.5, 1, 2, 4, 10]) { const y = yOf(s, h, pad); g.strokeStyle = s === 1 ? '#ffffff45' : '#ffffff12'; g.setLineDash(s === 1 ? [4, 4] : []); g.beginPath(); g.moveTo(padL, y); g.lineTo(w - pad, y); g.stroke(); g.fillStyle = s === 1 ? '#c9cfda' : '#7d8696'; g.fillText(pct(s), 2, y + 3); }
    g.setLineDash([]);
    // time along the bottom (seconds of the shot on the timeline)
    const d = D(); g.fillStyle = '#5d6676';
    for (let i = 0; i <= 4; i++) { const u = i / 4; g.fillText(`${(u * d).toFixed(1)}s`, Math.min(w - 30, xOf(u) - 8), h - 3); }
    // ramps (where the speed changes) shaded, like Premiere's split keyframes
    if (P) for (let i = 0; i < Q.length - 1; i++) if (!flat(Q[i], Q[i + 1])) { g.fillStyle = '#ff99331c'; g.fillRect(xOf(Q[i][0]), pad, xOf(Q[i + 1][0]) - xOf(Q[i][0]), h - 2 * pad); }
    // the hovered segment
    if (hover?.seg !== undefined) { const [a, b] = [Q[hover.seg], Q[hover.seg + 1]]; g.fillStyle = '#ffffff10'; g.fillRect(xOf(a[0]), pad, xOf(b[0]) - xOf(a[0]), h - 2 * pad); }
    curve(g, Q, w, h, pad, P ? '#ff9933' : '#ffffff55', 2.5, xOf);
    // keyframes: a diamond on the line and a tick at the top (Premiere shows them above the band)
    if (P) for (const [i, [u, s]] of Q.entries()) {
      const x = xOf(u), y = yOf(s, h, pad), on = hover?.pt === i || drag?.i === i || sel === i;
      g.fillStyle = on ? '#ffd24d' : '#111'; g.strokeStyle = '#ff9933'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 6, y); g.lineTo(x, y + 6); g.lineTo(x - 6, y); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#ff9933'; g.fillRect(x - 1, 2, 2, 7);
    }
    // the playhead inside this shot
    const x0 = clipStart(); if (x0 !== null) { const u = (S.playhead - x0) / d; if (u >= 0 && u <= 1) { g.strokeStyle = '#4f8cff'; g.lineWidth = 1; g.beginPath(); g.moveTo(xOf(u), pad); g.lineTo(xOf(u), h - pad); g.stroke(); } }
    $$('[data-rp]', box).forEach((b) => b.classList.toggle('on', (b.dataset.rp || '') === (c.ramp && c.ramp !== 'custom' ? c.ramp : c.ramp ? '__' : '')));
    const segs = P ? Q.slice(0, -1).map((p, i) => (flat(p, Q[i + 1]) ? pct(p[1]) : null)).filter(Boolean) : [];
    const nv = $('[data-rpv]', box); if (nv && document.activeElement !== nv) nv.value = Math.round((sel >= 0 && Q[sel] ? Q[sel][1] : at(Q, 0.5)) * 100);
    // (faster than the file has frames for: the shot ends sooner - say so, it reads as "the speed did not go up")
    const m = S.mediaById[c.mediaId], ran = P && m?.duration && Math.abs((c.out ?? m.duration) - m.duration) < 0.02 && Math.max(...Q.map((p) => p[1])) > 1;
    $('.rp-info', box).textContent = (ran ? '⚠ The file ends here: at this speed there are not enough frames, so the shot is shorter on the timeline - start it earlier in the file (Slip) to keep its length. ' : '') + (P ? `${c.ramp === 'custom' ? 'Custom ramp' : RAMPS[c.ramp]?.label} · ${d.toFixed(2)} s on the timeline · ${Q.length} keyframes${segs.length ? ` · speeds ${[...new Set(segs)].join(' → ')}` : ''} · slowest ${pct(Math.min(...Q.map((p) => p[1])))} · fastest ${pct(Math.max(...Q.map((p) => p[1])))}` : 'No ramp - pick a preset, drag the line up / down, or Ctrl + click it for a keyframe.');
  }
  // where this clip starts on the timeline (for the playhead line / keyframe at playhead)
  function clipStart() {
    const c = clip(); if (!c) return null;
    for (const l of Object.values(layout() || {})) { const x = l.find((p) => p.clip === c); if (x) return x.start; }
    return null;
  }
  const evAt = (e) => { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * W(), ((e.clientY - r.top) / r.height) * H()]; };
  const nearestPt = (P, x, y) => P.findIndex(([u, s]) => Math.hypot(xOf(u) - x, yOf(s, H(), pad) - y) < 9);
  const segAt = (P, x, y) => { const u = uOf(x); for (let i = 0; i < P.length - 1; i++) if (u >= P[i][0] && u <= P[i + 1][0] && flat(P[i], P[i + 1]) && Math.abs(yOf(P[i][1], H(), pad) - y) < 9) return i; return -1; };
  // (a point moved by hand: its segment eases fully again - a cut part's piece of an ease goes; its ease kind stays)
  const set = (P) => { const c = clip(); setRamp(c, 'custom', S.mediaById, P.map(([u, s, , , mode]) => [+u.toFixed(4), +Math.max(MIN, Math.min(MAX, s)).toFixed(3), ...(mode ? [0, 1, mode] : [])]), drag?.D); };
  const read = (txt) => { $('.rp-read', box).textContent = txt; };
  // a keyframe at u: the speed there stays, so nothing changes until a half is dragged
  function addKey(u) {
    const P = pts(), s = +at(P, u).toFixed(3);
    if (P.some((p) => Math.abs(p[0] - u) < 0.01)) return P;
    P.push([u, s]); P.sort((a, b) => a[0] - b[0]);
    return P;
  }
  cv.addEventListener('pointermove', (e) => {
    const [x, y] = evAt(e);
    if (!drag) {
      const P = pts(), i = rampPts(clip()) ? nearestPt(P, x, y) : -1, sg = i < 0 ? segAt(P, x, y) : -1;
      hover = i >= 0 ? { pt: i } : sg >= 0 ? { seg: sg } : null;
      cv.style.cursor = i >= 0 ? 'ew-resize' : sg >= 0 ? 'ns-resize' : 'crosshair';
      const u = uOf(x); read(`${pct(at(P, u))} at ${(u * D()).toFixed(2)} s`);
      draw(); return;
    }
    const { P, i, seg } = drag;
    const s = e.shiftKey ? 1 : sOf(y, H(), pad);
    if (seg !== undefined) { P[seg][1] = s; P[seg + 1][1] = s; } // the rubber band: the whole segment
    else {
      const lo = i === 0 ? 0 : P[i - 1][0] + 0.01, hi = i === P.length - 1 ? 1 : P[i + 1][0] - 0.01;
      P[i] = [i === 0 ? 0 : i === P.length - 1 ? 1 : Math.min(hi, Math.max(lo, uOf(x))), drag.vert ? s : P[i][1]];
      if (drag.vert === undefined && Math.abs(y - drag.y0) > 6) drag.vert = true;
    }
    set(P); live(); draw(); read(`${pct(seg !== undefined ? s : P[i][1])}`);
  });
  cv.addEventListener('pointerleave', () => { if (!drag) { hover = null; draw(); } });
  cv.addEventListener('pointerdown', (e) => {
    const c = clip(); if (!c || S.readOnly) return;
    const [x, y] = evAt(e);
    let P = pts();
    if (e.ctrlKey || e.metaKey) { P = addKey(uOf(x)); drag = { P, i: P.findIndex((p) => Math.abs(p[0] - uOf(x)) < 0.011), D: D(), y0: y }; }
    else {
      const i = rampPts(c) ? nearestPt(P, x, y) : -1, sg = i < 0 ? segAt(P, x, y) : -1;
      if (i >= 0) { drag = { P, i, D: D(), y0: y, vert: undefined }; sel = i; showEase(); }
      else if (sg >= 0) drag = { P, seg: sg, D: D() };
      else { sel = -1; showEase(); draw(); return; }
    }
    cv.setPointerCapture(e.pointerId); set(drag.P); live(); draw();
  });
  const up = () => { if (drag) { drag = null; done('Speed ramp (custom)'); draw(); } };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('dblclick', (e) => {
    const [x, y] = evAt(e), P = pts(), i = nearestPt(P, x, y);
    if (i > 0 && i < P.length - 1) { P.splice(i, 1); set(P); done('Remove speed keyframe'); draw(); }
  });
  // ⤳ ease, like After Effects / Premiere: the picked keyframe's ramp (to the next keyframe; the last one: the ramp into
  // it), or every ramp when none is picked. The button of the ease it has now is lit.
  const segOf = (P) => (sel < 0 ? -1 : sel >= P.length - 1 ? P.length - 2 : sel);
  function showEase() {
    const P = pts(), i = segOf(P), cur = i >= 0 ? P[i]?.[4] || 'io' : null;
    $('[data-rpe-for]', box).textContent = i >= 0 ? `Ease (ramp ${i + 1} → ${i + 2})` : 'Ease (all ramps)';
    $$('[data-rpe]', box).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.rpe === cur)));
  }
  function setEase(mode) {
    const c = clip(); if (!c || S.readOnly) return;
    const P = pts(), i = segOf(P);
    const one = (k) => { const [u, s, e0 = 0, e1 = 1] = P[k]; P[k] = mode === 'io' ? (e0 || e1 < 1 ? [u, s, e0, e1] : [u, s]) : [u, s, e0, e1, mode]; };
    if (i >= 0) one(i); else for (let k = 0; k < P.length - 1; k++) one(k);
    setRamp(c, 'custom', S.mediaById, P, D());
    done(`Speed ramp ease: ${RAMP_EASES.find((x) => x[0] === mode)[1]}`); live(); draw(); showEase();
  }
  $$('[data-rpe]', box).forEach((b) => (b.onclick = () => setEase(b.dataset.rpe)));
  cv.addEventListener('keydown', (e) => { // F9 Easy Ease, Shift+F9 Ease In, Ctrl+Shift+F9 Ease Out (After Effects' keys)
    if (e.key !== 'F9') return;
    e.preventDefault(); e.stopPropagation();
    setEase(e.ctrlKey && e.shiftKey ? 'out' : e.shiftKey ? 'in' : 'io');
  });
  showEase();
  box.querySelector('[data-rpa="key"]').onclick = () => {
    const x0 = clipStart(); if (x0 === null) return;
    const u = (S.playhead - x0) / D(); if (u <= 0.005 || u >= 0.995) return;
    set(addKey(u)); done('Speed keyframe'); draw();
  };
  // ⌨ the typed speed: the picked keyframe, or the whole shot at one speed
  box.querySelector('[data-rpv]').addEventListener('change', (e) => {
    const c = clip(), v = Math.max(MIN, Math.min(MAX, (+e.target.value || 100) / 100)); if (!c || S.readOnly) return;
    let P = pts();
    if (sel >= 0 && rampPts(c) && P[sel]) P[sel][1] = v; else P = [[0, v], [1, v]];
    set(P); done(`Speed ${Math.round(v * 100)}%`); live(); draw();
  });
  box.querySelector('[data-rpv]').addEventListener('keydown', (e) => e.stopPropagation()); // (the editor's keys stay out)
  box.querySelector('[data-rpa="reset"]').onclick = () => { const c = clip(); if (!c) return; setRamp(c, '', S.mediaById); done('No speed ramp'); draw(); };
  draw();
  return { draw };
}
