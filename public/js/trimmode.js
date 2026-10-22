// ✂ Trim mode (Shift+T), like Premiere's Trim Monitor: the main-story cut nearest the playhead opens over the Program
// monitor with the outgoing shot's last frame beside the incoming shot's first frame. Trim it a frame at a time
// (← / → or Ctrl+← / →, Shift = 5 frames, or the buttons) as a Ripple Out (the outgoing shot's end), a Roll (the cut
// moves, nothing else does) or a Ripple In (the incoming shot's start) - Tab changes which. J / K / L trims while it
// plays (L later, J earlier, again = faster, K stops and keeps it), Space plays round the cut, ↑ / ↓ go to the cut
// before / after, Esc or Shift+T closes. A ripple moves the story after the cut (and the ⇋ sync-locked tracks along
// with it); Ctrl+Z takes the trims on one cut back in one go.
import { S, on, emit, commit, layout } from './store.js';
import { clipDur, rampPts, setTransition, syncShift, fmtTC } from './model.js';
import { $, h, esc, toast } from './ui.js';
import { keyOf } from './keys.js';
import { markEditPoint } from './timeline.js';
import { playUrl, canPlay, play, pause, setMode, viewerMode } from './player.js';

const MODES = [['out', 'Ripple Out', 'The outgoing shot gets longer / shorter at its end - the story after it moves'],
  ['roll', 'Roll', 'The cut moves: one shot gets longer, the other shorter - nothing else moves'],
  ['in', 'Ripple In', 'The incoming shot starts earlier / later in its file - the story after it moves']];
let st = null, lastMode = 'roll';
const fps = () => S.project?.settings.fps || 30;
const r3 = (x) => +x.toFixed(3);

// the cut st is on: { k, A, B, cut } (B = V1[k], the incoming shot) or null when it is gone
function pair() {
  const V1 = S.project?.tracks.V1 || [], k = V1.findIndex((c) => c.id === st?.bId);
  if (k < 1) return null;
  const x = layout().V1[k];
  return { k, A: V1[k - 1], B: V1[k], cut: x.start + (x.overlap || 0) };
}

// ---- trimming one end of a shot by sec seconds of timeline; returns how far it really went ----
const minLen = (c) => (c.gap ? 0.04 : 0.2);
function tail(c, sec) { // + = the shot ends later
  if (c.type === 'video') {
    const m = S.mediaById[c.mediaId], sp = c.speed || 1, out0 = c.out ?? m?.duration ?? 0;
    c.out = r3(Math.min(m?.duration ?? Infinity, Math.max((c.in || 0) + 0.1 * sp, out0 + sec * sp)));
    return (c.out - out0) / sp;
  }
  const d0 = clipDur(c, S.mediaById); c.dur = r3(Math.max(minLen(c), d0 + sec)); return c.dur - d0;
}
function head(c, sec) { // + = the shot starts later in its file (shorter at the front)
  let moved;
  if (c.type === 'video') {
    const m = S.mediaById[c.mediaId], sp = c.speed || 1, in0 = c.in || 0, end = c.out ?? m?.duration ?? 0;
    c.in = r3(Math.max(0, Math.min(end - 0.1 * sp, in0 + sec * sp))); moved = (c.in - in0) / sp;
  } else { const d0 = clipDur(c, S.mediaById); c.dur = r3(Math.max(minLen(c), d0 - sec)); moved = d0 - c.dur; }
  if (moved && c.keys) for (const k of Object.values(c.keys)) for (const key of k) key.t = r3(key.t - moved); // (keyframes stay on their frames)
  return moved;
}

function trim(n) {
  const p = pair(); if (!p) return close('That cut is no longer there');
  const { A, B, cut } = p, d = n / fps(), mode = st.mode;
  if ((mode !== 'in' && rampPts(A)) || (mode !== 'out' && rampPts(B))) return toast('A speed-ramped shot is trimmed with the mouse (drag its end)', 'err');
  let moved;
  if (mode === 'out') moved = tail(A, d);
  else if (mode === 'in') moved = head(B, d);
  else { const a = tail(A, d), b = head(B, a); if (Math.abs(b - a) > 1e-4) tail(A, b - a); moved = b; }
  if (Math.abs(moved) < 1e-4) { draw(); return toast(n > 0 ? 'No more frames that way' : 'Cannot go shorter'); }
  if (mode === 'out') syncShift(S.project, cut, moved); // (⇋ the story after the cut moved by as much)
  if (mode === 'in') syncShift(S.project, cut, -moved);
  S.linkLead = null;
  commit(`Trim (${MODES.find((m) => m[0] === mode)[1]})`, `trimmode-${st.bId}-${mode}`);
}

// ---- J K L: trim while it plays ----
function dyn(dir) {
  if (!st.dyn) { st.dyn = { rate: 0, acc: 0, last: performance.now() }; st.dyn.raf = requestAnimationFrame(loop); }
  const r = st.dyn.rate;
  st.dyn.rate = dir > 0 ? (r > 0 ? Math.min(8, r * 2) : 1) : (r < 0 ? Math.max(-8, r * 2) : -1);
}
function loop(now) {
  const d = st?.dyn; if (!d) return;
  d.acc += ((now - d.last) / 1000) * d.rate; d.last = now;
  preview(d.acc);
  d.raf = requestAnimationFrame(loop);
}
function stopDyn(keep = true) {
  const d = st?.dyn; if (!d) return;
  st.dyn = null; cancelAnimationFrame(d.raf);
  const n = Math.round(d.acc * fps());
  if (keep && n) trim(n); else draw();
}

// ---- the monitor ----
function build() {
  const host = $('#viewer');
  document.querySelector('.mon-dock [data-mon="prog"]')?.click(); // (the Program monitor to the front - it holds Trim mode)
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const side = (s, cap) => `<div class="tm-side" data-s="${s}"><div class="tm-pic"><video muted playsinline preload="auto"></video><div class="tm-ph"></div></div>
    <div class="tm-cap"><small>${cap}</small><b class="tm-nm"></b><span class="tm-tc"></span></div></div>`;
  st.el = h(`<div class="trim-mon" role="dialog" aria-label="Trim mode">
    <div class="tm-frames">${side('a', 'Outgoing - last frame')}${side('b', 'Incoming - first frame')}</div>
    <div class="tm-bar">
      <div class="segbtns" role="radiogroup" aria-label="Trim type">${MODES.map(([k, l, t]) => `<button data-tm-mode="${k}" title="${t}">${l}</button>`).join('')}</div>
      <span class="grow"></span>
      <button data-tm="-5" title="Trim back 5 frames (Shift+←)">−5</button><button data-tm="-1" title="Trim back 1 frame (←)">−1</button>
      <span class="tm-amt tc" title="How many frames the outgoing (A) and incoming (B) shot grew / shrank since Trim mode came to this cut"></span>
      <button data-tm="1" title="Trim forward 1 frame (→)">+1</button><button data-tm="5" title="Trim forward 5 frames (Shift+→)">+5</button>
      <span class="grow"></span>
      <button data-tm="prev" title="Cut before (↑)">↑</button><button data-tm="next" title="Cut after (↓)">↓</button>
      <button data-tm="play" title="Play round the cut (Space)"></button><button data-tm="close" title="Close Trim mode (Esc / Shift+T)">✕</button>
    </div>
    <div class="tm-help">← → trim 1 frame · Shift 5 · Tab Ripple Out / Roll / Ripple In · J K L trim while playing · Space play round the cut · ↑ ↓ other cuts · Esc close</div>
  </div>`);
  host.append(st.el);
  st.el.addEventListener('click', (e) => {
    const md = e.target.closest('[data-tm-mode]')?.dataset.tmMode;
    if (md) { stopDyn(); st.mode = lastMode = md; return draw(); }
    const a = e.target.closest('[data-tm]')?.dataset.tm; if (!a) return;
    stopDyn();
    if (a === 'close') close(); else if (a === 'prev') goBy(-1); else if (a === 'next') goBy(1); else if (a === 'play') playAround(); else trim(+a);
  });
  for (const v of st.el.querySelectorAll('video')) v.addEventListener('loadedmetadata', () => { if (v.dataset.t) v.currentTime = +v.dataset.t; });
}
// show source time t of clip c on one side (a picture when it can play, else its thumbnail or what it is)
function showFrame(sideEl, c, t) {
  const v = sideEl.querySelector('video'), ph = sideEl.querySelector('.tm-ph'), m = c && S.mediaById[c.mediaId];
  const can = c?.type === 'video' && canPlay(m);
  v.hidden = !can;
  ph.hidden = can;
  if (can) {
    const url = playUrl(m);
    v.dataset.t = String(Math.max(0, t));
    if (v.dataset.src !== url) { v.dataset.src = url; v.src = url; } else if (v.readyState >= 1 && !v.seeking) v.currentTime = Math.max(0, t);
  } else {
    ph.style.backgroundImage = m?.urls?.thumb ? `url('${m.urls.thumb}')` : '';
    ph.textContent = c?.gap ? 'Gap' : m ? '' : c?.type === 'title' ? (c.text || 'Title') : c?.type || '';
  }
}
const outT = (A) => (A.out ?? S.mediaById[A.mediaId]?.duration ?? 0) - 0.5 / (S.mediaById[A.mediaId]?.fps || fps());
function draw() {
  if (!st) return;
  const p = pair(); if (!p) return close('That cut is no longer there');
  const { A, B, cut } = p, el = st.el, nm = (c) => (c.gap ? 'Gap' : S.mediaById[c.mediaId]?.name || (c.type === 'title' ? c.text || 'Title' : c.type));
  const [sa, sb] = [el.querySelector('[data-s="a"]'), el.querySelector('[data-s="b"]')];
  showFrame(sa, A, outT(A)); showFrame(sb, B, B.in || 0);
  sa.querySelector('.tm-nm').textContent = nm(A); sb.querySelector('.tm-nm').textContent = nm(B);
  sa.querySelector('.tm-tc').textContent = A.type === 'video' ? `Out ${fmtTC(A.out ?? S.mediaById[A.mediaId]?.duration ?? 0, fps())}` : `${clipDur(A, S.mediaById).toFixed(2)} s`;
  sb.querySelector('.tm-tc').textContent = B.type === 'video' ? `In ${fmtTC(B.in || 0, fps())}` : `${clipDur(B, S.mediaById).toFixed(2)} s`;
  sa.classList.toggle('on', st.mode !== 'in'); sb.classList.toggle('on', st.mode !== 'out');
  el.querySelectorAll('[data-tm-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tmMode === st.mode)));
  el.querySelector('.tm-amt').textContent = amt(p);
  markEditPoint(cut, st.mode);
}
// how much each shot grew (+) / shrank (-) since Trim mode came to this cut, in frames (follows Ctrl+Z too)
const sgn = (n) => `${n > 0 ? '+' : ''}${n}`;
function amt(p, extra = 0) {
  const a = Math.round((clipDur(p.A, S.mediaById) - st.len0[0]) * fps()) + (st.mode !== 'in' ? extra : 0);
  const b = Math.round((clipDur(p.B, S.mediaById) - st.len0[1]) * fps()) - (st.mode !== 'out' ? extra : 0);
  return `A ${sgn(a)} · B ${sgn(b)} f`;
}
// while J / L run: the side being trimmed shows the frame it would end / start on
function preview(acc) {
  const p = pair(); if (!p) return;
  const n = Math.round(acc * fps()), el = st.el;
  if (st.mode === 'in') showFrame(el.querySelector('[data-s="b"]'), p.B, (p.B.in || 0) + acc * (p.B.speed || 1));
  else showFrame(el.querySelector('[data-s="a"]'), p.A, outT(p.A) + acc * (p.A.speed || 1));
  el.querySelector('.tm-amt').textContent = `${amt(p, n)} ${st.dyn.rate > 0 ? '▶' : '◀'}${Math.abs(st.dyn.rate) > 1 ? `${Math.abs(st.dyn.rate)}×` : ''}`;
}
function playAround() {
  const p = pair(); if (!p) return;
  if (viewerMode() !== 'program') setMode('program');
  clearTimeout(st.pt);
  st.el.classList.add('playing');
  emit('seek', Math.max(0, p.cut - 2)); play();
  st.pt = setTimeout(() => { pause(); if (st) { st.el.classList.remove('playing'); emit('seek', p.cut); } }, 4000);
}

// ---- open / move / close ----
function go(k) {
  const V1 = S.project.tracks.V1;
  if (k < 1 || k >= V1.length) return toast(k < 1 ? 'No cut before this one' : 'No cut after this one');
  st.bId = V1[k].id;
  // a transition on the cut comes off first, like a trim with the mouse (Ctrl+Z brings it back)
  if (V1[k].transitionIn && V1[k].transitionIn.type !== 'cut') { setTransition(S.project, S.mediaById, k, null); commit('Transition off (trim)'); toast('Transition taken off this cut to trim it (Ctrl+Z brings it back)'); }
  const p = pair(); if (!p) return;
  st.len0 = [clipDur(p.A, S.mediaById), clipDur(p.B, S.mediaById)];
  emit('seek', p.cut);
  draw();
}
const goBy = (dir) => { const p = pair(); if (p) go(p.k + dir); };
export function toggleTrimMode() {
  if (st) return close();
  if (!S.project || S.page !== 'edit') return toast('Trim mode works on the Edit page');
  const L = layout().V1;
  let k = -1;
  for (let i = 1; i < L.length; i++) if (k < 0 || Math.abs(L[i].start - S.playhead) < Math.abs(L[k].start - S.playhead)) k = i;
  if (k < 1) return toast('Trim mode works on a cut of the main story (V1) - it needs two shots there');
  pause();
  st = { mode: lastMode, len0: [0, 0], dyn: null };
  build();
  window.addEventListener('keydown', onKey, true);
  go(k);
  toast('Trim mode: ← → trims, Tab changes the type, J K L trims while playing, Esc closes');
}
function close(why) {
  if (!st) return;
  stopDyn(false); clearTimeout(st.pt);
  window.removeEventListener('keydown', onKey, true);
  for (const v of st.el.querySelectorAll('video')) { v.pause(); v.removeAttribute('src'); v.load(); }
  st.el.remove(); st = null;
  markEditPoint(null);
  if (typeof why === 'string') toast(why);
}

const STEP = { Left: -1, Right: 1, 'Ctrl+Left': -1, 'Ctrl+Right': 1, 'Alt+,': -1, 'Alt+.': 1, ',': -1, '.': 1,
  'Shift+Left': -5, 'Shift+Right': 5, 'Ctrl+Shift+Left': -5, 'Ctrl+Shift+Right': 5 };
function onKey(e) {
  if (!st || document.querySelector('dialog[open]')) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
  const k = keyOf(e); if (!k) return;
  if (st.dyn && k !== 'J' && k !== 'L') { stopDyn(true); if (k === 'K') { e.preventDefault(); e.stopImmediatePropagation(); return; } }
  let mine = true;
  if (k in STEP) trim(STEP[k]);
  else if (k === 'Tab' || k === 'Shift+Tab') { const i = MODES.findIndex((m) => m[0] === st.mode); st.mode = lastMode = MODES[(i + (k === 'Tab' ? 1 : 2)) % 3][0]; draw(); }
  else if (k === 'Up') goBy(-1); else if (k === 'Down') goBy(1);
  else if (k === 'J') dyn(-1); else if (k === 'L') dyn(1); else if (k === 'K') { /* (nothing running) */ }
  else if (k === 'Space') playAround();
  else if (k === 'Esc' || k === 'Shift+T') close();
  else mine = false; // (Ctrl+Z, Ctrl+S… still reach the editor)
  if (mine) { e.preventDefault(); e.stopImmediatePropagation(); }
}

on('change', () => { if (!st) return; if (!S.project || S.page !== 'edit') close(); else if (!st.dyn) draw(); });
