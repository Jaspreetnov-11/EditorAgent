// 📈 Premiere's keyframe graphs in Effect Controls: twirl a keyframed property open (▸) to see its value graph and,
// under it, its velocity (speed) graph over the clip. Drag a key up / down (value) and sideways (time), click the line
// to add a key, double-click or Delete removes one; the yellow handles of the selected key shape its ease (drag up /
// down = speed, sideways = influence; Ctrl-drag breaks a Continuous Bezier into a Bezier). Right-click a key (here or
// on the ◆ lane) for its interpolation; F9 Easy Ease, Shift+F9 Ease In, Ctrl+Shift+F9 Ease Out.
// The curve is model.js evalKeys - the same one the render turns into FFmpeg expressions (keysExpr).
import { on } from './store.js';
import { evalKeys, keyHandle, setKeyIp, KEY_IPS } from './model.js';

const open = new Set(); // twirled-open properties (stay open across clips and re-renders)
let cx = null; // the inspector's hooks for the clip on show
let sel = null; // the selected key: { id, p, j }
let refocus = false, menuEl = null, wired = false;
const SHORT = { linear: 'Linear', bezier: 'Bezier', auto: 'Auto', cont: 'Cont.', hold: 'Hold', easein: 'Ease In', easeout: 'Ease Out', easy: 'Easy Ease' };
const KEYS = { easy: 'F9', easein: 'Shift+F9', easeout: 'Ctrl+Shift+F9' };
const IP_NAME = Object.fromEntries(KEY_IPS);

export const kgTwirl = (c, p) => (c.keys?.[p]?.length ? `<button class="kg-tw" data-kgtw="${p}" title="${open.has(p) ? 'Hide' : 'Show'} the value and velocity graphs">${open.has(p) ? '▾' : '▸'}</button>` : '');
export const kgRow = (c, p) => (c.keys?.[p]?.length && open.has(p) ? `<div class="kg" data-kg="${p}" tabindex="0">
    <div class="kg-side"><div class="kg-ip">${KEY_IPS.map(([k, l]) => `<button class="kg-b" data-kgset="${k}" title="${l}${KEYS[k] ? ` (${KEYS[k]})` : ''} - on the selected keyframe">${SHORT[k]}</button>`).join('')}</div>
    <small class="kg-info" data-kginfo>Click a keyframe in the graph</small><small class="kg-lab"><b>Value</b><b>Velocity</b></small></div>
    <canvas class="kg-cv"></canvas></div>` : '');

// ctx: { id, clip(), D, fps, seek(clipTime), live(), commit(label), rerender(), shown(p, v) -> number, unit(p), clamp(p, v) }
export function mountKeyGraphs(root, ctx) {
  css(); wire();
  cx = { ...ctx, root };
  if (sel && sel.id !== ctx.id) sel = null;
  const pm = root.querySelector('.pm'); if (!pm) return;
  pm.tabIndex = -1;
  pm.querySelectorAll('[data-kgtw]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const p = b.dataset.kgtw; open.has(p) ? open.delete(p) : open.add(p); ctx.rerender(); }));
  // ◆ on the lane: click selects it (for F9 / Delete), right-click opens the interpolation menu
  pm.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.kl-k');
    if (k) { sel = { id: ctx.id, p: k.closest('[data-kp]').dataset.kp, j: +k.dataset.kj }; drawAll(); return; }
    if (!e.target.closest('.kg')) { if (sel) { sel = null; drawAll(); } }
  });
  pm.addEventListener('contextmenu', (e) => {
    const k = e.target.closest('.kl-k'); if (!k) return;
    e.preventDefault(); sel = { id: ctx.id, p: k.closest('[data-kp]').dataset.kp, j: +k.dataset.kj }; drawAll(); showMenu(e.clientX, e.clientY);
  });
  pm.querySelectorAll('.kg').forEach((el) => bindGraph(el));
  drawAll();
  if (refocus) { refocus = false; (pm.querySelector(`.kg[data-kg="${sel?.p}"]`) || pm).focus({ preventScroll: true }); }
}

const keysOf = (p) => cx?.clip()?.keys?.[p];
const selKeys = () => (sel && cx && sel.id === cx.id ? keysOf(sel.p) : null);

// ---------------- the interpolation commands ----------------
function setIp(mode) {
  const keys = selKeys(); if (!keys?.[sel.j]) return;
  setKeyIp(keys, sel.j, mode);
  done(`Keyframe: ${IP_NAME[mode]}`);
}
function delKey() {
  const c = cx?.clip(), keys = selKeys(); if (!keys?.[sel.j]) return;
  keys.splice(sel.j, 1);
  if (!keys.length) delete c.keys[sel.p];
  if (!Object.keys(c.keys).length) delete c.keys;
  sel = null; done('Delete keyframe');
}
function done(label) { refocus = true; cx.commit(label); cx.live(); cx.rerender(); }

function showMenu(x, y) {
  closeMenu();
  const k = selKeys()?.[sel.j]; if (!k) return;
  menuEl = document.createElement('div'); menuEl.className = 'kg-menu';
  menuEl.innerHTML = `<b>Temporal Interpolation</b>${KEY_IPS.map(([m, l]) => `<button data-m="${m}">${k.ip === m ? '✓ ' : ''}${l}${KEYS[m] ? `<small>${KEYS[m]}</small>` : ''}</button>`).join('')}<hr><button data-m="del">Delete keyframe</button>`;
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`; menuEl.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
  menuEl.addEventListener('click', (e) => { const m = e.target.closest('[data-m]')?.dataset.m; if (!m) return; closeMenu(); m === 'del' ? delKey() : setIp(m); });
}
function closeMenu() { menuEl?.remove(); menuEl = null; }

function wire() {
  if (wired) return; wired = true;
  on('live', drawAll); on('playhead', drawAll);
  document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
  window.addEventListener('resize', drawAll);
  // F9 / Shift+F9 / Ctrl+Shift+F9 and Delete on the selected key while Effect Controls has the focus
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuEl) { closeMenu(); e.stopPropagation(); return; }
    if (!selKeys() || !document.activeElement?.closest?.('.pm') || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const f9 = e.key === 'F9' && !e.altKey ? (e.ctrlKey && e.shiftKey ? 'easeout' : e.shiftKey ? 'easein' : e.ctrlKey ? null : 'easy') : null;
    if (f9) setIp(f9);
    else if (e.key === 'Delete' || e.key === 'Backspace') delKey();
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
}

// ---------------- drawing ----------------
// (a narrow panel: the graph takes the whole width under its buttons instead of lining up with the ◆ lane)
function drawAll() { if (cx) cx.root.querySelectorAll('.kg[data-kg]').forEach((el) => { el.classList.toggle('narrow', el.clientWidth < 620); draw(el); }); }
// the speed (value per second) inside segment i at share u of its time
const speedAt = (keys, i, u) => { const a = keys[i], b = keys[i + 1], d = b.t - a.t, h = Math.min(0.002, u, 1 - u) || 0.001; return (evalKeys(keys, a.t + (u + h) * d) - evalKeys(keys, a.t + (u - h) * d)) / (2 * h * d); };
const holdSeg = (k) => k.ip === 'hold' || (!k.ip && k.ease === 'hold');
// the handles of the selected key: where they end in time / value, and their speed
function handlesOf(keys, j) {
  const k = keys[j], out = [];
  if (!k || k.ip === 'linear') return out;
  if (j > 0 && !holdSeg(keys[j - 1])) { const h = keyHandle(keys, j, 'in'), d = k.t - keys[j - 1].t; out.push({ side: 'in', d, s: h.s, f: h.f, t: k.t - h.f * d, v: k.v - h.s * h.f * d }); }
  if (j < keys.length - 1 && !holdSeg(k)) { const h = keyHandle(keys, j, 'out'), d = keys[j + 1].t - k.t; out.push({ side: 'out', d, s: h.s, f: h.f, t: k.t + h.f * d, v: k.v + h.s * h.f * d }); }
  return out;
}
function geo(cv, p, keys) {
  const D = Math.max(0.01, cx.D), W = cv.clientWidth, H = cv.clientHeight, VH = Math.round(H * 0.62), V0 = VH + 8;
  const hs = sel?.p === p ? handlesOf(keys, sel.j) : [];
  const vs = keys.map((k) => k.v).concat(hs.map((h) => h.v)), ss = [0, ...hs.map((h) => h.s)];
  for (let i = 0; i <= 200; i++) vs.push(evalKeys(keys, (D * i) / 200));
  for (let i = 0; i < keys.length - 1; i++) if (!holdSeg(keys[i])) for (let n = 1; n < 40; n++) ss.push(speedAt(keys, i, n / 40));
  let lo = Math.min(...vs), hi = Math.max(...vs); if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }
  let slo = Math.min(...ss), shi = Math.max(...ss); if (shi - slo < 1e-6) { slo -= 1; shi += 1; }
  const pv = (hi - lo) * 0.1, ps = (shi - slo) * 0.12; lo -= pv; hi += pv; slo -= ps; shi += ps;
  return {
    W, H, VH, V0, D, hs,
    x: (t) => (t / D) * W, t: (x) => Math.min(D, Math.max(0, (x / W) * D)),
    y: (v) => 6 + (1 - (v - lo) / (hi - lo)) * (VH - 12), v: (y) => lo + (1 - (y - 6) / (VH - 12)) * (hi - lo),
    ys: (s) => V0 + 4 + (1 - (s - slo) / (shi - slo)) * (H - V0 - 8), s: (y) => slo + (1 - (y - V0 - 4) / (H - V0 - 8)) * (shi - slo),
    lo, hi, slo, shi,
  };
}
function draw(el) {
  const p = el.dataset.kg, keys = keysOf(p), cv = el.querySelector('canvas'); if (!keys?.length || !cv) return;
  const dpr = devicePixelRatio || 1, G = geo(cv, p, keys), g = cv.getContext('2d');
  cv.width = Math.round(G.W * dpr); cv.height = Math.round(G.H * dpr); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#121110'; g.fillRect(0, 0, G.W, G.VH); g.fillRect(0, G.V0, G.W, G.H - G.V0);
  g.font = '10px Segoe UI'; g.fillStyle = '#6f6a62';
  const show = (v) => +(+cx.shown(p, v)).toFixed(1), sshow = (s) => +(cx.shown(p, s) - cx.shown(p, 0)).toFixed(1);
  g.fillText(`${show(G.hi)}${cx.unit(p)}`, 3, 11); g.fillText(`${show(G.lo)}${cx.unit(p)}`, 3, G.VH - 3);
  g.fillText(`${sshow(G.shi)}/s`, 3, G.V0 + 11); g.fillText(`${sshow(G.slo)}/s`, 3, G.H - 3);
  // zero speed
  g.strokeStyle = '#2a2724'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, G.ys(0)); g.lineTo(G.W, G.ys(0)); g.stroke();
  // the value
  g.strokeStyle = '#5aa7ff'; g.lineWidth = 1.6; g.beginPath();
  for (let px = 0; px <= G.W; px += 2) { const y = G.y(evalKeys(keys, G.t(px))); px ? g.lineTo(px, y) : g.moveTo(px, y); }
  g.stroke();
  // the velocity, segment by segment (a hold jumps)
  g.strokeStyle = '#c9a26b'; g.beginPath();
  g.moveTo(0, G.ys(0)); g.lineTo(G.x(keys[0].t), G.ys(0));
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1], n = Math.max(2, Math.round((G.x(b.t) - G.x(a.t)) / 2));
    for (let m = 0; m <= n; m++) { const u = m / n, x = G.x(a.t + u * (b.t - a.t)), y = G.ys(holdSeg(a) ? 0 : speedAt(keys, i, Math.min(0.999, Math.max(0.001, u)))); m ? g.lineTo(x, y) : g.moveTo(x, y); }
  }
  g.moveTo(G.x(keys[keys.length - 1].t), G.ys(0)); g.lineTo(G.W, G.ys(0)); g.stroke();
  // the selected key's handles (on both graphs)
  const k0 = sel?.p === p ? keys[sel.j] : null;
  if (k0) for (const h of G.hs) {
    g.strokeStyle = '#ffd40099'; g.lineWidth = 1; g.beginPath();
    g.moveTo(G.x(k0.t), G.y(k0.v)); g.lineTo(G.x(h.t), G.y(h.v)); g.moveTo(G.x(k0.t), G.ys(h.s)); g.lineTo(G.x(h.t), G.ys(h.s)); g.stroke();
    g.fillStyle = '#ffd400'; g.beginPath(); g.arc(G.x(h.t), G.y(h.v), 3.5, 0, 7); g.arc(G.x(h.t), G.ys(h.s), 3.5, 0, 7); g.fill();
  }
  // keys (shape by interpolation, like the lane) and the playhead
  keys.forEach((k, j) => {
    const x = G.x(k.t), y = G.y(k.v), on2 = sel?.p === p && sel.j === j;
    g.fillStyle = on2 ? '#ffd400' : '#e8e2d6'; g.beginPath();
    if (k.ip === 'hold') g.rect(x - 4, y - 4, 8, 8);
    else if (k.ip === 'auto' || (!k.ip && k.ease)) g.arc(x, y, 4.5, 0, 7);
    else if (k.ip === 'bezier' || k.ip === 'cont') { g.moveTo(x - 4.5, y - 4.5); g.lineTo(x + 4.5, y - 4.5); g.lineTo(x - 4.5, y + 4.5); g.lineTo(x + 4.5, y + 4.5); g.closePath(); }
    else { g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.closePath(); }
    g.fill();
    g.fillStyle = '#6f6a62'; g.fillRect(x - 0.5, G.H - 4, 1, 4);
  });
  const rel = cx.rel?.();
  if (rel !== null && rel !== undefined && rel >= 0 && rel <= G.D) { g.fillStyle = '#ff4d4d'; g.fillRect(G.x(rel) - 0.5, 0, 1, G.H); }
  // the side: which interpolation the selected key has
  const info = el.querySelector('[data-kginfo]'), k = sel?.p === p ? keys[sel.j] : null;
  if (info) info.textContent = k ? `◆ ${k.t.toFixed(2)}s · ${show(k.v)}${cx.unit(p)} · ${IP_NAME[k.ip] || (k.ease ? 'Old ease' : 'Linear')}` : 'Click a keyframe in the graph';
  el.querySelectorAll('[data-kgset]').forEach((b) => { b.disabled = !k; b.classList.toggle('on', !!k && (k.ip || 'linear') === b.dataset.kgset); });
  cx.root.querySelectorAll('.kl-k.kg-sel').forEach((d) => d.classList.remove('kg-sel'));
  if (sel) cx.root.querySelector(`[data-kp="${sel.p}"] .kl-k[data-kj="${sel.j}"]`)?.classList.add('kg-sel');
}

// ---------------- dragging ----------------
function bindGraph(el) {
  const p = el.dataset.kg, cv = el.querySelector('canvas');
  el.querySelectorAll('[data-kgset]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setIp(b.dataset.kgset); }));
  cv.addEventListener('contextmenu', (e) => { e.preventDefault(); if (hitKey(e) >= 0) { sel = { id: cx.id, p, j: hitKey(e) }; drawAll(); showMenu(e.clientX, e.clientY); } });
  cv.addEventListener('dblclick', (e) => { const j = hitKey(e); if (j >= 0) { sel = { id: cx.id, p, j }; delKey(); } });
  function pos(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function hitKey(e) { const keys = keysOf(p), G = geo(cv, p, keys), [x, y] = pos(e); return keys.findIndex((k) => Math.abs(G.x(k.t) - x) < 7 && (y > G.VH || Math.abs(G.y(k.v) - y) < 7)); }
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const keys = keysOf(p); if (!keys?.length) return;
    const G = geo(cv, p, keys), [x, y] = pos(e), inVal = y < G.VH;
    e.preventDefault(); el.focus({ preventScroll: true });
    try { cv.setPointerCapture(e.pointerId); } catch {}
    let drag = null;
    // a handle of the selected key?
    const h = sel?.p === p ? G.hs.find((q) => Math.abs(G.x(q.t) - x) < 6 && Math.abs((inVal ? G.y(q.v) : G.ys(q.s)) - y) < 6) : null;
    if (h) drag = { mode: 'h', side: h.side, inVal };
    else {
      const j = hitKey(e);
      if (j >= 0) { sel = { id: cx.id, p, j }; const k = keys[j]; drag = { mode: 'k', t0: k.t, v0: k.v, x0: x, y0: y }; }
      else if (inVal && Math.abs(G.y(evalKeys(keys, G.t(x))) - y) < 6) {
        // a click on the line: a new keyframe there, on the curve
        const t = +G.t(x).toFixed(3), j2 = keys.findIndex((k) => k.t > t), at = j2 < 0 ? keys.length : j2;
        if (keys.some((k) => Math.abs(k.t - t) < 0.5 / (cx.fps || 30))) return;
        keys.splice(at, 0, { t, v: +(+evalKeys(keys, t)).toFixed(5), ...(keys.some((k) => k.ip) ? { ip: 'auto' } : {}) });
        sel = { id: cx.id, p, j: at }; done('Add keyframe'); return;
      } else { sel = null; cx.seek(G.t(x)); drag = { mode: 'scrub' }; }
    }
    drawAll();
    let moved = false;
    const mv = (ev) => {
      const [mx, my] = pos(ev), keys2 = keysOf(p), k = keys2?.[sel?.j];
      if (drag.mode === 'scrub') { cx.seek(G.t(mx)); return; }
      if (!k) return;
      moved = true;
      if (drag.mode === 'k') {
        let dx = mx - drag.x0, dy = my - drag.y0;
        if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; } // (Shift: one direction only)
        const f1 = 1 / (cx.fps || 30), lo = sel.j > 0 ? keys2[sel.j - 1].t + f1 : 0, hi = sel.j < keys2.length - 1 ? keys2[sel.j + 1].t - f1 : G.D;
        k.t = +Math.min(hi, Math.max(lo, drag.t0 + (dx / G.W) * G.D)).toFixed(3);
        k.v = +cx.clamp(p, G.v(G.y(drag.v0) + dy)).toFixed(5);
        const d = cx.root.querySelector(`[data-kp="${p}"] .kl-k[data-kj="${sel.j}"]`); if (d) d.style.left = `${(k.t / G.D) * 100}%`;
      } else {
        // a handle: sideways = influence, up / down = speed (the value graph: where the handle points)
        if (!k.ip || k.ip === 'auto') { const was = k.ip; setKeyIp(keys2, sel.j, 'bezier'); if (was === 'auto') k.ip = 'cont'; } // (an Auto key becomes Continuous, as in Premiere)
        if (ev.ctrlKey && k.ip === 'cont') k.ip = 'bezier';
        if (k.ip === 'cont' && !k.in) k.in = { ...keyHandle(keys2, sel.j, 'in') };
        if (k.ip === 'cont' && !k.out) k.out = { ...keyHandle(keys2, sel.j, 'out') };
        const hh = handlesOf(keys2, sel.j).find((q) => q.side === drag.side); if (!hh) return;
        const dt = drag.side === 'in' ? k.t - G.t(mx) : G.t(mx) - k.t, f = Math.min(1, Math.max(0.01, dt / hh.d));
        const s = drag.inVal ? (drag.side === 'in' ? k.v - G.v(my) : G.v(my) - k.v) / (f * hh.d) : G.s(my);
        k[drag.side] = { s: +s.toFixed(5), f: +f.toFixed(4) };
        const other = drag.side === 'in' ? 'out' : 'in';
        if (k.ip === 'cont' && k[other]) k[other] = { ...k[other], s: +s.toFixed(5) }; // (Continuous: one speed through the key)
      }
      cx.live(); drawAll();
    };
    const up = () => {
      cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up);
      if (moved && drag.mode !== 'scrub') done(drag.mode === 'k' ? 'Move keyframe' : 'Keyframe ease');
      else if (drag.mode === 'k' && sel) cx.seek(keysOf(p)[sel.j].t);
    };
    cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up);
  });
}

// the look, kept with the code (Effect Controls rows: the graph sits under the lane, the buttons under the name)
function css() {
  if (document.getElementById('kg-css')) return;
  const s = document.createElement('style'); s.id = 'kg-css';
  s.textContent = `
.kg-tw { padding: 0 4px 0 0; background: none; border: 0; color: #8a847a; font-size: 10px; cursor: pointer; }
.kg-tw:hover { color: #e8e2d6; }
.kg { display: grid; grid-template-columns: 22px minmax(82px, 112px) 64px 50px minmax(120px, 1fr); column-gap: 10px; padding: 4px 0 8px; outline: none; }
.kg:focus-visible { box-shadow: inset 0 0 0 1px #5aa7ff55; }
.kg-side { grid-column: 1 / 5; display: flex; flex-direction: column; gap: 6px; min-width: 0; padding-left: 4px; }
.kg-ip { display: flex; flex-wrap: wrap; gap: 3px; }
.kg-b { padding: 1px 5px; font-size: 10px; border-radius: 3px; background: #1d1b19; border: 1px solid #34302b; color: #c9c3b8; }
.kg-b.on { border-color: #5aa7ff; color: #5aa7ff; } .kg-b:disabled { opacity: .45; }
.kg-info { color: #8a847a; font-size: 10.5px; }
.kg-lab { display: flex; flex-direction: column; gap: 52px; color: #6f6a62; font-size: 10px; margin-top: auto; }
.kg-cv { grid-column: 5; width: 100%; height: 170px; border-radius: 4px; cursor: crosshair; }
.kg.narrow .kg-side { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 0 4px 6px; }
.kg.narrow .kg-lab { display: none; } .kg.narrow .kg-cv { grid-column: 1 / -1; }
.kl-k.kg-sel { background: #ffd400; box-shadow: 0 0 5px #ffd400; }
.kl-k.ip-hold { transform: none; border-radius: 0; }
.kl-k.ip-auto { transform: none; border-radius: 50%; }
.kl-k.ip-bezier, .kl-k.ip-cont { transform: none; border-radius: 50% 0; }
.kg-menu { position: fixed; z-index: 9999; min-width: 190px; padding: 4px; background: #1d1b19; border: 1px solid #3a3530; border-radius: 6px; box-shadow: 0 8px 24px #0009; display: flex; flex-direction: column; }
.kg-menu b { font-size: 10.5px; color: #8a847a; padding: 3px 8px; font-weight: 600; }
.kg-menu button { text-align: left; background: none; border: 0; padding: 4px 8px; font-size: 12px; color: #e8e2d6; border-radius: 4px; display: flex; justify-content: space-between; gap: 12px; }
.kg-menu button:hover { background: #2b2824; } .kg-menu small { color: #6f6a62; } .kg-menu hr { border: 0; border-top: 1px solid #34302b; margin: 3px 0; }`;
  document.head.append(s);
}
