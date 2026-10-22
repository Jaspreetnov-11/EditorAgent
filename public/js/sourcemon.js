// 🎬 Source monitor (Studio look, Phase 20): Premiere's two monitors - a clip from Media opens here, beside the Program
// monitor (the timeline), instead of taking the viewer over. Its own picture, scrub bar with the In / Out range, Mark In /
// Out, Go to In / Out, frame steps, and Insert / Append / Overlay (or drag the picture onto the timeline - the clip comes
// trimmed to In / Out). Marks live in S.sourceMarks, shared with the classic viewer, the timeline drop and the pool.
// Keys while this panel is the active one (click it): Space, J K L, ← →, I O, Shift+I / Shift+O (go to), , insert, . overlay.
import { S, on, emit, commit, duration } from './store.js';
import { api, enc } from './api.js';
import { fmtTC, fmt, clipDur } from './model.js';
import { $, esc, toast } from './ui.js';
import { placeMedia, targets } from './timeline.js';
import { uploadFiles, refreshMedia } from './mediapool.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
let root = null, id = null, active = false, virt = 0, recent = [], raf = 0;
const el = {};
const media = () => S.mediaById[id];
const playable = () => { const m = media(); return !!m && m.kind !== 'image' && m.playable; };
const time = () => (playable() ? el.v.currentTime || 0 : virt);
const dur = () => media()?.duration || 0;
const fps = () => media()?.fps || 30;
const marks = () => (S.sourceMarks[id] ||= {});

// the Studio look uses this monitor; the classic look keeps its one viewer with Source / Timeline
export const srcMonOn = () => !!root && document.documentElement.classList.contains('ui2');
export const srcMonActive = () => srcMonOn() && active && !!id;

export function mountSourceMonitor(host) {
  root = host;
  root.innerHTML = `
  <div class="sm-head">
    <span class="sm-label">Source</span>
    <select class="sm-pick" aria-label="Open clip"><option value="">(no clip)</option></select>
    <span class="grow"></span>
    <button class="icon-btn sm-close" data-sm="close" title="Close this clip" aria-label="Close clip">✕</button>
  </div>
  <div class="sm-stage">
    <div class="sm-frame" draggable="true" title="Drag onto the timeline (comes trimmed to In / Out)">
      <video playsinline preload="auto"></video><img alt=""><div class="sm-strip"></div>
      <div class="sm-empty"><b>Source monitor</b><span>Double-click a clip in Media to open it here. Set In / Out, then Insert or drag it onto the timeline.</span></div>
      <div class="sm-msg" hidden></div>
    </div>
  </div>
  <div class="sm-bar" title="Click or drag to move">
    <div class="sm-ticks"></div><div class="sm-range"></div><div class="sm-in"></div><div class="sm-out"></div><div class="sm-head-mark"></div>
  </div>
  <div class="sm-ctrl">
    <span class="tc sm-tc">00:00:00:00</span>
    <span class="grow"></span>
    <button class="icon-btn" data-sm="in" title="Mark In (I)">${ico('in')}</button>
    <button class="icon-btn" data-sm="out" title="Mark Out (O)">${ico('out')}</button>
    <button class="icon-btn" data-sm="goin" title="Go to In (Shift+I)">${ico('goin')}</button>
    <button class="icon-btn" data-sm="back" title="Back 1 frame (←)">${ico('back')}</button>
    <button class="icon-btn sm-play" data-sm="play" title="Play / pause (Space)" aria-label="Play">${ico('play')}</button>
    <button class="icon-btn" data-sm="fwd" title="Forward 1 frame (→)">${ico('fwd')}</button>
    <button class="icon-btn" data-sm="goout" title="Go to Out (Shift+O)">${ico('goout')}</button>
    <span class="grow"></span>
    <span class="sm-sel tc" title="In → Out length"></span>
  </div>
  <div class="sm-actions">
    <span class="sm-take" title="What Insert / Overlay / Append and dragging the picture take - like Premiere's source patching. Drag one chip onto the timeline to take only that part.">
      <button class="sm-tk on" data-tk="v" draggable="true" title="Video - click to take it or not; drag = video only">${ico('vid')}V</button><button class="sm-tk on" data-tk="a" draggable="true" title="Audio - click to take it or not; drag = audio only">${ico('aud')}A</button>
    </span>
    <button class="small accent" data-sm="insert" title="Insert at the playhead on V1 - later clips move along (,)">Insert</button>
    <button class="small" data-sm="overlay" title="Place over the edit on V2 at the playhead (.)">Overlay</button>
    <button class="small" data-sm="append" title="Add at the end of V1">Append</button>
    <span class="grow"></span>
    <span class="muted small sm-info"></span>
  </div>`;
  el.v = root.querySelector('video'); el.img = root.querySelector('img'); el.strip = root.querySelector('.sm-strip');
  el.empty = root.querySelector('.sm-empty'); el.msg = root.querySelector('.sm-msg'); el.bar = root.querySelector('.sm-bar');
  el.pick = root.querySelector('.sm-pick'); el.tc = root.querySelector('.sm-tc'); el.sel = root.querySelector('.sm-sel'); el.info = root.querySelector('.sm-info');
  el.play = root.querySelector('.sm-play'); el.frame = root.querySelector('.sm-frame');
  el.v.addEventListener('timeupdate', ui);
  el.v.addEventListener('play', () => { setPlay(true); tick(); });
  el.v.addEventListener('pause', () => setPlay(false));
  el.v.addEventListener('ended', () => setPlay(false));
  el.v.addEventListener('loadeddata', () => { el.v.currentTime = Math.max(0.04, virt); ui(); });
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-sm]')?.dataset.sm; if (!a) return;
    ({ close, in: () => mark('in'), out: () => mark('out'), goin: () => seekTo(marks().in ?? 0), goout: () => seekTo(marks().out ?? dur()),
      back: () => stepF(-1), fwd: () => stepF(1), play: toggle, insert: () => put('insert'), overlay: () => put('overlay'), append: () => put('append') })[a]?.();
  });
  el.pick.addEventListener('change', () => { if (el.pick.value) open(el.pick.value); });
  // scrubbing
  el.bar.addEventListener('pointerdown', (e) => {
    if (!id) return;
    el.bar.setPointerCapture(e.pointerId);
    const go = (ev) => { const b = el.bar.getBoundingClientRect(); seekTo(clamp((ev.clientX - b.left) / b.width, 0, 1) * dur()); };
    go(e); el.v.pause();
    const up = () => { el.bar.removeEventListener('pointermove', go); el.bar.removeEventListener('pointerup', up); };
    el.bar.addEventListener('pointermove', go); el.bar.addEventListener('pointerup', up);
  });
  // drag the picture onto the timeline (the drop reads S.sourceMarks: the clip comes trimmed)
  el.frame.addEventListener('dragstart', (e) => {
    if (!id) return e.preventDefault();
    e.dataTransfer.setData('text/x-media-id', id); e.dataTransfer.effectAllowed = 'copy';
    const o = takeOnly(); if (o) e.dataTransfer.setData('text/x-media-only', o);
  });
  // a clip dragged here from Media opens in the Source monitor (like Premiere)
  // ...and so does a file dragged here from Explorer / the desktop: it is added to the project first (Uploads)
  root.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].some((t) => t === 'text/x-media-id' || t === 'Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; root.classList.add('sm-drop'); } });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('sm-drop'); });
  root.addEventListener('drop', (e) => {
    root.classList.remove('sm-drop');
    if (e.dataTransfer.files?.length && !e.dataTransfer.getData('text/x-media-id')) { e.preventDefault(); e.stopPropagation(); fromOutside([...e.dataTransfer.files]); return; }
    const mid = (e.dataTransfer.getData('text/x-media-id') || '').split(',').filter(Boolean)[0];
    if (!mid || mid === id) return;
    e.preventDefault(); open(mid);
  });
  // 🎞 / 🔊 source patching: V and A chips (click = take that part or not, drag = only that part)
  root.querySelectorAll('[data-tk]').forEach((b) => {
    b.addEventListener('click', () => {
      const k = b.dataset.tk, t = (S.srcTake ||= { v: true, a: true });
      t[k] = !t[k]; if (!t.v && !t.a) t[k === 'v' ? 'a' : 'v'] = true; // (one of them always stays on)
      syncTake();
    });
    b.addEventListener('dragstart', (e) => {
      if (!id) return e.preventDefault();
      e.dataTransfer.setData('text/x-media-id', id); e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/x-media-only', b.dataset.tk === 'v' ? 'video' : 'audio');
    });
  });
  syncTake();
  // the panel you last clicked takes the keys (like Premiere's panel focus)
  document.addEventListener('pointerdown', (e) => { active = !!root && root.contains(e.target); root?.classList.toggle('sm-active', active); }, true);
  on('programPlays', () => el.v.pause());
  on('openSource', (x) => { if (!srcMonOn()) return; typeof x === 'object' && x ? open(x.id, x.t) : open(x); });
  on('media', () => { if (id && !media()) close(); else if (id) { load(false); } });
  new ResizeObserver(fit).observe(root.querySelector('.sm-stage'));
}

// files from outside: uploaded into the project, then the first one opens here once the editor has read it
async function fromOutside(files) {
  const added = await uploadFiles(files);
  const first = added.find((x) => x.kind === 'video' || x.kind === 'image' || x.kind === 'audio');
  if (!first) return;
  for (let i = 0; i < 60 && S.mediaById[first.id]?.status !== 'ready'; i++) { await new Promise((r) => setTimeout(r, 1000)); await refreshMedia(); }
  if (S.mediaById[first.id]) open(first.id);
}

export function open(mid, at = null) {
  const m = S.mediaById[mid]; if (!m) return;
  id = mid; active = true; root.classList.add('sm-active');
  recent = [mid, ...recent.filter((x) => x !== mid)].slice(0, 12);
  virt = at ?? marks().in ?? 0;
  load(at !== null);
  emit('sourceShown');
}
function close() { el.v.pause(); el.v.removeAttribute('src'); el.v.load(); id = null; virt = 0; load(false); }

function load(jump) {
  const m = media();
  syncTake();
  el.pick.innerHTML = `<option value="">${id ? '' : '(no clip)'}</option>${recent.filter((x) => S.mediaById[x]).map((x) => `<option value="${esc(x)}"${x === id ? ' selected' : ''}>${esc(S.mediaById[x].name)}</option>`).join('')}`;
  el.pick.value = id || '';
  root.classList.toggle('sm-has', !!m);
  el.empty.hidden = !!m; el.msg.hidden = true; el.strip.hidden = true; el.img.hidden = true; el.v.hidden = true;
  if (!m) { ui(); return; }
  if (m.kind === 'image') { el.img.hidden = false; el.img.src = m.urls.play; }
  else if (!m.playable) {
    // a camera file whose preview copy is not ready: scrub its filmstrip; In / Out / Insert still work
    el.msg.hidden = false; el.msg.textContent = 'Preview copy is being made - meanwhile scrub on the bar, set In / Out and Insert.';
    strip();
    if (m.kind === 'video') api('POST', `/api/media/urgent?p=${enc(S.proj)}&id=${m.id}`).catch(() => {});
  } else {
    el.v.hidden = false; el.v.muted = false;
    if (el.v.dataset.src !== m.urls.play) { el.v.dataset.src = m.urls.play; el.v.src = m.urls.play; }
    else if (jump) el.v.currentTime = Math.max(0.04, virt);
    if (m.kind === 'audio') { el.img.hidden = !m.urls.wave; if (m.urls.wave) el.img.src = m.urls.wave; }
  }
  el.info.textContent = [m.width ? `${m.width}×${m.height}` : '', m.fps ? `${Math.round(m.fps * 100) / 100} fps` : '', m.kind].filter(Boolean).join(' · ');
  ticks(); fit(); ui();
}
function strip() {
  const m = media(); if (!m?.urls.strip || !m.duration) return;
  const k = clamp(Math.round((virt / m.duration) * 12 - 0.5), 0, 11);
  el.strip.hidden = false;
  el.strip.style.cssText = `background:#000 url('${m.urls.strip}') no-repeat;background-size:1200% 100%;background-position:${(k / 11) * 100}% 0`;
}
// the picture keeps the clip's shape inside the stage
function fit() {
  const st = root?.querySelector('.sm-stage'); if (!st) return;
  const m = media(), W = st.clientWidth - 12, H = st.clientHeight - 12;
  let w = m?.width || 16, h = m?.height || 9; if (Math.abs(m?.rotation || 0) === 90) [w, h] = [h, w];
  const k = Math.min(W / w, H / h);
  el.frame.style.width = `${Math.max(0, Math.floor(w * k))}px`; el.frame.style.height = `${Math.max(0, Math.floor(h * k))}px`;
}
// a light ruler under the scrub bar (about 10 marks)
function ticks() {
  const d = dur(), box = root.querySelector('.sm-ticks'); if (!d) { box.innerHTML = ''; return; }
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => d / s <= 12) || 1200;
  box.innerHTML = Array.from({ length: Math.floor(d / step) + 1 }, (_, i) => `<i style="left:${((i * step) / d) * 100}%"></i>`).join('');
}
function ui() {
  const m = media(), d = dur(), t = m?.kind === 'image' ? 0 : time(), mk = id ? marks() : {};
  const pct = (x) => `${d ? (clamp(x, 0, d) / d) * 100 : 0}%`;
  root.querySelector('.sm-head-mark').style.left = pct(t);
  const a = mk.in ?? 0, b = mk.out ?? d;
  const r = root.querySelector('.sm-range'); r.style.left = pct(a); r.style.width = d ? `${((b - a) / d) * 100}%` : '0';
  root.querySelector('.sm-in').style.left = pct(a); root.querySelector('.sm-in').hidden = mk.in === undefined;
  root.querySelector('.sm-out').style.left = pct(b); root.querySelector('.sm-out').hidden = mk.out === undefined;
  el.tc.textContent = fmtTC(t, fps());
  el.sel.textContent = m ? `${fmtTC(Math.max(0, b - a), fps())}` : '';
  el.sel.title = m ? `In ${fmt(a)} → Out ${fmt(b)}` : '';
}
function tick() { cancelAnimationFrame(raf); const f = () => { ui(); if (!el.v.paused) raf = requestAnimationFrame(f); }; raf = requestAnimationFrame(f); }
function setPlay(p) { el.play.innerHTML = ico(p ? 'pause' : 'play'); el.play.setAttribute('aria-label', p ? 'Pause' : 'Play'); }

function seekTo(t) {
  if (!id) return;
  t = clamp(t, 0, dur());
  if (playable()) el.v.currentTime = t; else { virt = t; strip(); }
  ui();
}
function stepF(n) { if (!id) return; el.v.pause(); seekTo(time() + n / fps()); }
export function toggle() {
  if (!id) return;
  if (!playable()) { if (media()?.kind !== 'image') toast('Preview copy is still being made - scrub on the bar'); return; }
  // (the program monitor stops: only one monitor plays at a time)
  if (el.v.paused) { emit('sourcePlays'); el.v.play(); } else el.v.pause();
}
export function shuttle(k) { if (!id) return; if (k === 'k') el.v.pause(); if (k === 'l' && playable()) { emit('sourcePlays'); el.v.play(); } if (k === 'j') { el.v.pause(); seekTo(time() - 2); } }
function mark(which) {
  if (!id) return;
  const t = +time().toFixed(3), mk = marks();
  mk[which] = t;
  if (mk.out !== undefined && (mk.in ?? 0) >= mk.out) delete mk[which === 'in' ? 'out' : 'in'];
  ui();
}
export function key(k, shift = false) {
  if (!srcMonActive()) return false;
  if (k === 'i') shift ? seekTo(marks().in ?? 0) : mark('in');
  else if (k === 'o') shift ? seekTo(marks().out ?? dur()) : mark('out');
  else if (k === ',') put('insert'); else if (k === '.') put('overlay');
  else if (k === 'left' || k === 'right') { el.v.pause(); seekTo(time() + (k === 'left' ? -1 : 1) * (shift ? 1 : 1 / fps())); }
  else return false;
  return true;
}
// what the V / A chips say: 'video' / 'audio' when only one is on (video clips with sound only), else undefined
export function takeOnly() {
  const t = S.srcTake || { v: true, a: true };
  return t.v && t.a ? undefined : t.v ? 'video' : 'audio';
}
function syncTake() {
  const t = S.srcTake || { v: true, a: true }, m = media(), split = m?.kind === 'video' && !!m.hasAudio;
  root?.querySelectorAll('[data-tk]').forEach((b) => { b.classList.toggle('on', !!t[b.dataset.tk]); b.hidden = !split; });
}
function put(how) {
  const m = media(); if (!m) return toast('First open a clip here from Media (double-click)', 'err');
  const mk = { ...marks(), only: takeOnly() };
  let c;
  if (how === 'append') { const track = m.kind === 'audio' ? 'A2' : 'V1'; c = placeMedia(id, track, track === 'V1' ? 1e9 : duration(), mk); }
  else { const tg = targets()[m.kind === 'audio' ? 'a' : 'v']; // (🎯 a targeted track, else as before)
    if (how === 'overlay') c = placeMedia(id, tg || (m.kind === 'audio' ? 'A1' : 'V2'), S.playhead, { ...mk, ...(tg ? { overwrite: true } : {}) });
    else c = placeMedia(id, tg || (m.kind === 'audio' ? 'A2' : 'V1'), S.playhead, mk); }
  if (c) { commit(how === 'overlay' ? 'Overlay' : how === 'append' ? 'Append' : 'Insert'); toast(`${m.name} on the timeline (${fmt(clipDur(c, S.mediaById))})`); }
}

// line icons for the transport (stroke = text colour)
function ico(k) {
  const P = {
    play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none"/>', pause: '<path d="M5 3.5v9M11 3.5v9" stroke-width="2.2"/>',
    back: '<path d="M10.5 4 6 8l4.5 4"/>', fwd: '<path d="M5.5 4 10 8l-4.5 4"/>',
    in: '<path d="M6 3H4v10h2"/><path d="M9 8h4"/>', out: '<path d="M10 3h2v10h-2"/><path d="M3 8h4"/>',
    goin: '<path d="M4 3v10"/><path d="M12 4 7 8l5 4"/>', goout: '<path d="M12 3v10"/><path d="M4 4l5 4-5 4"/>',
    vid: '<rect x="2" y="4" width="12" height="8" rx="1"/><path d="M5 4v8M11 4v8"/>', aud: '<path d="M2 8h1M5 5v6M8 3v10M11 6v4M14 8h.5"/>',
  };
  return `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[k]}</svg>`;
}
