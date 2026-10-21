// Viewer: "Timeline" mode plays the edit live from proxies (V1 with transitions, V2 overlays/titles, logo,
// all audio tracks); "Source" mode previews one media file with In/Out marks.
// Live playback is a close preview; "Accurate preview" renders the exact result with FFmpeg.
import * as SM from './sourcemon.js';
import { S, on, emit, layout, duration, commit } from './store.js';
import { ASPECTS, fmtTC, fmt, clipDur, propAt, sourceAt, speedAt, rampPts, setAnimated, overlayTracks, audioTracks, evalKeys } from './model.js';
import { lookCss } from './looks.js';
import { buildFxNodes } from './audiofx.js';
import { $, $$, h, esc, clamp, toast } from './ui.js';
import { placeMedia } from './timeline.js';
import { api, enc } from './api.js';
import { Grader, loadLut, cachedLut } from './colorgl.js';
import { isNeutral } from './colormath.js';
import { fxPreview, wordWindows, isKinetic } from './fx.js';
import { drawGraphic } from './graphics.js';
import { effectsCss } from './effects.js';
import { captionAt } from './captions.js';
import { fitMap, framingOf, srcSize, boxAt, srcTimeAt } from './tracking.js';

let root, frame, els = {}, mode = 'program', srcId = null, grader = null;
let lookFilter = ''; // the film look, roughly (CSS); added to every picture layer in program mode
let playing = false, wall0 = 0, t0 = 0, raf = 0;
// rAF stops in background tabs; keep the clock (and audio sync) running there with a timer
const nextFrame = (f) => (document.hidden ? setTimeout(f, 33) : requestAnimationFrame(f));
const cancelFrame = (id) => { cancelAnimationFrame(id); clearTimeout(id); };
const audioPool = new Map(); // clipId -> HTMLAudioElement
S.sourceMarks = {};

export function mountViewer(el) {
  root = el;
  el.innerHTML = `
  <div class="vw-head">
    <div class="segbtns" role="tablist">
      <button data-mode="source" role="tab">Source</button><button data-mode="program" role="tab">Timeline</button>
    </div>
    <span class="vw-title" id="vwTitle"></span>
    <span class="grow"></span>
    <button class="tog small" data-act="guides" title="Title/action-safe guides">Guides</button>
    <button class="small" data-act="accurate" title="Render an exact low-res preview with FFmpeg">Accurate preview</button>
  </div>
  <div class="vw-stage" id="vwStage">
    <div class="vw-frame" id="vwFrame">
      <div class="lyr blurbg" id="lyBlur"></div>
      <video class="lyr" id="lyA" playsinline preload="auto"></video>
      <video class="lyr" id="lyB" playsinline preload="auto"></video>
      <canvas class="lyr" id="lyGrade" hidden></canvas>
      <img class="lyr" id="lyImg" alt="">
      <div class="lyr title-card" id="lyCard"></div>
      <div class="lyr fxov" id="lyFx" hidden></div>
      <div class="lyr txt" id="lyText"></div>
      <div class="lyr maskl" id="lyMask"></div>
      <div class="lyr ovstack" id="lyOvStack"></div>
      <div class="lyr capl" id="lyCap" hidden></div>
      <video class="lyr" id="lyOv" playsinline preload="auto" muted hidden></video>
      <img class="lyr" id="lyOvImg" alt="">
      <div class="lyr txt" id="lyOvText"></div>
      <img class="lyr logo" id="lyLogo" alt="">
      <div class="lyr look" id="lyLook"></div>
      <div class="lyr guides" id="lyGuides" hidden><i class="g-action"></i><i class="g-title"></i><i class="g-h"></i><i class="g-v"></i></div>
      <div class="vw-msg" id="vwMsg" hidden></div>
    </div>
  </div>
  <div class="vw-src" id="vwSrc" hidden>
    <div class="src-bar" id="srcBar"><div class="src-range" id="srcRange"></div><div class="src-head" id="srcHead"></div></div>
  </div>
  <div class="vw-ctrl">
    <span class="tc big" id="vwTC">00:00:00:00</span>
    <span class="grow"></span>
    <button class="icon-btn" data-act="start" title="Go to start (Home)">⏮</button>
    <button class="icon-btn" data-act="back" title="Back 1 frame (←)">◂</button>
    <button class="icon-btn play" data-act="play" title="Play / pause (Space)" aria-label="Play">▶</button>
    <button class="icon-btn" data-act="fwd" title="Forward 1 frame (→)">▸</button>
    <button class="icon-btn" data-act="end" title="Go to end (End)">⏭</button>
    <span class="grow"></span>
    <span class="src-only" hidden>
      <button class="small" data-act="in" title="Mark In (I)">In</button>
      <button class="small" data-act="out" title="Mark Out (O)">Out</button>
      <button class="small accent" data-act="insert" title="Insert into V1 at the playhead (,)">Insert</button>
      <button class="small" data-act="append" title="Add to the end of V1">Append</button>
      <button class="small" data-act="overlay" title="Place on V2 at the playhead (.)">Overlay</button>
    </span>
    <span class="tc" id="vwDur"></span>
  </div>`;
  frame = $('#vwFrame', el);
  for (const k of ['lyA', 'lyB', 'lyImg', 'lyCard', 'lyText', 'lyOv', 'lyOvImg', 'lyOvText', 'lyLogo', 'lyBlur', 'vwMsg', 'lyGrade', 'lyFx', 'lyOvStack', 'lyCap', 'lyMask']) els[k] = $(`#${k}`, el);
  try { grader = new Grader(els.lyGrade); } catch { grader = null; } // without WebGL2 the CSS approximation is used
  // a paused frame arrives after the seek finishes: redraw then so the graded canvas is up to date
  [els.lyA, els.lyB, els.lyImg].forEach((m) => m.addEventListener(m.tagName === 'IMG' ? 'load' : 'seeked', () => { if (mode === 'program' && !playing) drawProgram(S.playhead, false); }));
  // (and once a new file has its first picture: the frame held up while it loaded goes away)
  [els.lyA, els.lyB].forEach((v) => v.addEventListener('loadeddata', () => { if (mode === 'program' && !playing) drawProgram(S.playhead, false); }));
  [els.lyA, els.lyB, els.lyOv].forEach((v) => { v.addEventListener('error', () => {}); });
  $$('[data-mode]', el).forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a) return;
    ({ play: toggle, start: () => seek(0), end: () => seek(curDuration()), back: () => step(-1), fwd: () => step(1),
      in: () => mark('in'), out: () => mark('out'), insert: () => sourceTo('insert'), append: () => sourceTo('append'), overlay: () => sourceTo('overlay'),
      guides: () => { const g = $('#lyGuides'); g.hidden = !g.hidden; e.target.closest('button').classList.toggle('on', !g.hidden); },
      accurate: () => emit('accuratePreview') })[a]?.();
  });
  $('#srcBar', el).addEventListener('pointerdown', (e) => {
    const bar = $('#srcBar'), go = (ev) => { const b = bar.getBoundingClientRect(); seek(clamp((ev.clientX - b.left) / b.width, 0, 1) * curDuration()); };
    go(e);
    const up = () => { window.removeEventListener('pointermove', go); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', go); window.addEventListener('pointerup', up);
  });
  new ResizeObserver(sizeFrame).observe($('#vwStage', el));
  bindDirectMove();
  els.lyA.addEventListener('timeupdate', () => { if (mode === 'source') { srcUI(); } });
  els.lyA.addEventListener('ended', () => { if (mode === 'source') setPlayingUI(false); });

  on('seek', (t) => { if (mode !== 'program') setMode('program'); seek(t); });
  on('change', () => { if (mode === 'program' && !playing) drawProgram(S.playhead, false); sizeFrame(); drawLook(); });
  on('mix', () => { if (mode === 'program') drawProgram(S.playhead, playing); });
  // openSource: a media id, or { id, t } to open it at t seconds (a footage search hit)
  on('openSource', (x) => { if (SM.srcMonOn()) return; x && typeof x === 'object' ? openSource(x.id, x.t) : openSource(x); });
  on('sourcePlays', () => pause()); // 🎬 one monitor plays at a time
  on('media', () => { if (mode === 'source' && srcId && srcPlayable() && els.lyA.hidden) { hideAll(); loadSource(); } });
  setMode('program');
}

// Direct manipulation: drag the selected shot / overlay in the viewer to move it, Alt + wheel to zoom it.
// With keyframes on Position / Zoom the value is keyed at the playhead (like the Inspector), so motion paths are drawn by hand.
function movable() {
  if (mode !== 'program' || S.sel.size !== 1 || !S.project) return null;
  const id = [...S.sel][0], L = layout(), t = S.playhead;
  for (const tr of [...overlayTracks(S.project).reverse(), 'V1']) {
    const x = L[tr].find((p) => p.clip.id === id);
    if (x && t >= x.start && t < x.end && (x.clip.type === 'video' || x.clip.type === 'image')) return { c: x.clip, rel: t - x.start };
  }
  return null;
}
function bindDirectMove() {
  const fps = () => S.project.settings.fps || 30;
  frame.addEventListener('pointermove', (e) => { if (!e.buttons) frame.classList.toggle('can-move', !!movable()); });
  frame.addEventListener('pointerdown', (e) => {
    const m = movable(); if (!m || e.button !== 0) return;
    e.preventDefault(); try { frame.setPointerCapture(e.pointerId); } catch {}
    const b = frame.getBoundingClientRect(), x0 = +propAt(m.c, 'transform.x', m.rel) || 0, y0 = +propAt(m.c, 'transform.y', m.rel) || 0;
    let moved = false;
    const move = (ev) => {
      // percent of the frame, the unit the renderer uses (+x = right, +y = down)
      const nx = clamp(x0 + ((ev.clientX - e.clientX) / b.width) * 100, -100, 100), ny = clamp(y0 + ((ev.clientY - e.clientY) / b.height) * 100, -100, 100);
      setAnimated(m.c, 'transform.x', +nx.toFixed(1), m.rel, fps()); setAnimated(m.c, 'transform.y', +ny.toFixed(1), m.rel, fps());
      moved = true; drawProgram(S.playhead, false);
    };
    const up = () => { frame.removeEventListener('pointermove', move); frame.removeEventListener('pointerup', up); if (moved) commit('Move in viewer'); };
    frame.addEventListener('pointermove', move); frame.addEventListener('pointerup', up);
  });
  let wheelT = 0;
  frame.addEventListener('wheel', (e) => {
    const m = e.altKey && movable(); if (!m) return;
    e.preventDefault();
    const z = clamp((+propAt(m.c, 'transform.zoom', m.rel) || 1) * (e.deltaY < 0 ? 1.04 : 1 / 1.04), 0.5, 4);
    setAnimated(m.c, 'transform.zoom', +z.toFixed(3), m.rel, fps());
    drawProgram(S.playhead, false);
    clearTimeout(wheelT); wheelT = setTimeout(() => commit('Zoom in viewer', 'viewer-zoom'), 300);
  }, { passive: false });
}

// Cinematic finish preview: letterbox bars + vignette (grain and stabilize show in Accurate preview / renders)
function drawLook() {
  const el = $('#lyLook', root); if (!el || !S.project) return;
  const lk = S.project.settings.look || {}, [w, h] = ASPECTS[S.project.settings.aspect] || [16, 9];
  const ratio = { '2.39': 2.39, '2.0': 2, '1.85': 1.85 }[lk.letterbox], bar = ratio && w / h < ratio ? ((1 - w / h / ratio) / 2) * 100 : 0;
  const v = +lk.vignette || 0;
  el.hidden = mode !== 'program' || (!bar && !v);
  // the film look, roughly (Accurate preview / renders use the exact LUT)
  lookFilter = mode === 'program' ? lookCss(lk) : '';
  if (els.lyBlur) els.lyBlur.style.filter = lookFilter;
  if (mode === 'program' && !playing) drawProgram(S.playhead, false);
  el.style.background = [bar ? `linear-gradient(#000 0 ${bar}%, transparent ${bar}% ${100 - bar}%, #000 ${100 - bar}%)` : '', v ? `radial-gradient(ellipse at center, transparent ${70 - 30 * v}%, rgba(0,0,0,${(0.35 + 0.45 * v).toFixed(2)}) 100%)` : ''].filter(Boolean).join(',');
}
export const isPlaying = () => playing || (mode === 'source' && !els.lyA.paused);
export const viewerMode = () => mode;

function sizeFrame() {
  const st = $('#vwStage', root); if (!st || !S.project) return;
  let [w, h] = ASPECTS[S.project.settings.aspect] || [16, 9];
  if (mode === 'source' && srcId) { const m = S.mediaById[srcId]; if (m?.width) { w = m.width; h = m.height; if (Math.abs(m.rotation) === 90) [w, h] = [h, w]; } }
  const W = st.clientWidth - 16, H = st.clientHeight - 16, k = Math.min(W / w, H / h);
  frame.style.width = `${Math.max(10, w * k)}px`; frame.style.height = `${Math.max(10, h * k)}px`;
  frame.style.setProperty('--fh', `${h * k}px`);
}

export function setMode(m) {
  if (m === 'source' && !srcId) { toast('Double-click a clip in Media to open it here'); return; }
  pause();
  mode = m;
  $$('[data-mode]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  $('#vwSrc', root).hidden = m !== 'source';
  $('.src-only', root).hidden = m !== 'source';
  hideAll();
  sizeFrame();
  if (m === 'program') { $('#vwTitle').textContent = S.project?.name || ''; drawProgram(S.playhead, false); }
  else loadSource();
  drawLook();
}

function hideAll() {
  for (const k of ['lyA', 'lyB', 'lyImg', 'lyCard', 'lyText', 'lyOv', 'lyOvImg', 'lyOvText', 'lyLogo', 'lyBlur', 'vwMsg', 'lyFx', 'lyCap', 'lyMask']) { els[k].hidden = true; els[k].style.opacity = ''; }
  // the program's colour layer and cinematic overlay must not show through the source monitor
  els.lyGrade.hidden = true; const lk = $('#lyLook', root); if (lk) lk.hidden = true;
  for (const v of [els.lyA, els.lyB, els.lyOv]) v.pause();
  for (const a of audioPool.values()) a.pause();
  for (const sl of ovSlots.values()) { sl.el.hidden = true; if (sl.el.tagName === 'VIDEO') sl.el.pause(); }
}

// ---------------- source monitor ----------------
// A camera file whose preview copy is still being made cannot play yet; the Source monitor then scrubs a virtual
// position (srcT) over the clip's filmstrip, and In / Out / Insert / Overlay still work. The copy is made right away.
let srcT = 0;
const srcPlayable = () => { const m = S.mediaById[srcId]; return !!m && m.kind !== 'image' && m.playable; };
const srcTime = () => (srcPlayable() ? els.lyA.currentTime || 0 : srcT);
let srcAt = null;
export function openSource(id, at = null) {
  srcId = id; srcAt = at;
  setMode('source');
}
function drawStrip() {
  const m = S.mediaById[srcId], card = els.lyCard;
  if (!m?.urls.strip || !m.duration) return;
  const k = clamp(Math.round((srcT / m.duration) * 12 - 0.5), 0, 11);
  card.hidden = false; card.innerHTML = '';
  card.style.cssText = `background:#000 url('${m.urls.strip}') no-repeat;background-size:1200% 100%;background-position:${(k / 11) * 100}% 0;opacity:1`;
}
function loadSource() {
  const m = S.mediaById[srcId];
  if (!m) return;
  $('#vwTitle').textContent = m.name;
  const v = els.lyA, mk = S.sourceMarks[srcId] || {};
  v.style.cssText = ''; v.style.objectFit = 'contain';
  srcT = srcAt ?? mk.in ?? 0;
  const jump = srcAt !== null; srcAt = null;
  if (m.kind === 'image') { els.lyImg.hidden = false; els.lyImg.src = m.urls.thumb ? `${m.urls.play}` : m.urls.play; els.lyImg.style.cssText = 'object-fit:contain'; }
  else if (!m.playable) {
    showMsg(`${proxyMsg(m)} - you can scrub, mark In / Out and Insert meanwhile.`, m.urls.strip ? null : m.urls.thumb);
    drawStrip();
    if (m.kind === 'video') api('POST', `/api/media/urgent?p=${enc(S.proj)}&id=${m.id}`).catch(() => {});
  } else {
    v.hidden = false; v.muted = false; v.volume = 1; v.playbackRate = 1;
    if (v.dataset.src !== m.urls.play) {
      v.src = m.urls.play; v.dataset.src = m.urls.play; v.dataset.cid = '';
      // show a real frame straight away (a freshly loaded video stays black until it is seeked)
      v.addEventListener('loadeddata', () => { if (mode === 'source') { v.currentTime = Math.max(0.04, srcT); srcUI(); } }, { once: true });
    } else if (jump) v.currentTime = Math.max(0.04, srcT);
  }
  if (m.kind === 'audio') { els.lyImg.hidden = !m.urls.wave; if (m.urls.wave) { els.lyImg.src = m.urls.wave; els.lyImg.style.cssText = 'object-fit:fill;opacity:.8'; } }
  srcUI();
}
function srcUI() {
  const m = S.mediaById[srcId]; if (!m || mode !== 'source') return;
  const d = m.duration || 0, t = m.kind === 'image' ? 0 : srcTime(), mk = S.sourceMarks[srcId] || {};
  $('#srcHead').style.left = `${d ? (t / d) * 100 : 0}%`;
  const a = mk.in ?? 0, b = mk.out ?? d;
  $('#srcRange').style.left = `${d ? (a / d) * 100 : 0}%`; $('#srcRange').style.width = `${d ? ((b - a) / d) * 100 : 0}%`;
  $('#vwTC').textContent = fmtTC(t, m.fps || 30);
  $('#vwDur').textContent = `In ${fmt(a)} · Out ${fmt(b)} · ${fmt(b - a)}`;
}
function mark(which) {
  if (mode !== 'source' || !srcId) return;
  const m = S.mediaById[srcId], t = +srcTime().toFixed(3), mk = (S.sourceMarks[srcId] ||= {});
  mk[which] = t;
  if (mk.out !== undefined && (mk.in ?? 0) >= mk.out) delete mk[which === 'in' ? 'out' : 'in'];
  srcUI(); toast(`${which === 'in' ? 'In' : 'Out'} ${fmt(t)}`);
}
// Source monitor keys: I / O mark, , insert, . overlay, arrows step a frame (Shift = 1 s). Returns false outside the source monitor.
export function sourceKey(k, shift = false) {
  if (SM.srcMonActive()) return SM.key(k, shift);
  if (mode !== 'source' || !srcId) return false;
  const m = S.mediaById[srcId], step = shift ? 1 : 1 / (m?.fps || 30);
  if (k === 'i') mark('in'); else if (k === 'o') mark('out'); else if (k === ',') sourceTo('insert'); else if (k === '.') sourceTo('overlay');
  else if (k === 'left' || k === 'right') { els.lyA.pause(); setPlayingUI(false); seek(srcTime() + (k === 'left' ? -step : step)); }
  else return false;
  return true;
}
export function sourceTo(how) {
  if (!srcId) return;
  const t = S.srcTake || { v: true, a: true }; // (the Source monitor's V / A chips)
  const m = S.mediaById[srcId], mk = { ...(S.sourceMarks[srcId] || {}), only: t.v && t.a ? undefined : t.v ? 'video' : 'audio' };
  let c;
  if (how === 'append') {
    const track = m.kind === 'audio' ? 'A2' : 'V1';
    c = placeMedia(srcId, track, track === 'V1' ? 1e9 : duration(), mk);
  } else if (how === 'overlay') c = placeMedia(srcId, m.kind === 'audio' ? 'A1' : 'V2', S.playhead, mk);
  else c = placeMedia(srcId, m.kind === 'audio' ? 'A2' : 'V1', S.playhead, mk);
  if (c) { commit(how === 'overlay' ? 'Overlay' : how === 'append' ? 'Append' : 'Insert'); toast(`${m.name} added (${fmt(clipDur(c, S.mediaById))})`); }
}

// ---------------- program monitor ----------------
const curDuration = () => (mode === 'source' ? S.mediaById[srcId]?.duration || 0 : duration());
export function seek(t) {
  t = clamp(t, 0, curDuration());
  if (mode === 'source') { if (srcPlayable()) els.lyA.currentTime = t; else { srcT = t; drawStrip(); } srcUI(); return; }
  S.playhead = t;
  if (playing) { t0 = t; wall0 = performance.now(); }
  drawProgram(t, playing);
  emit('playhead');
}
function step(n) {
  const fps = mode === 'source' ? S.mediaById[srcId]?.fps || 30 : S.project.settings.fps;
  if (mode === 'source') { els.lyA.pause(); seek(srcTime() + n / fps); }
  else { pause(); seek(S.playhead + n / fps); }
}
// ⛶ Ctrl+` (Ctrl+~): the Program monitor full screen, like Premiere - the picture only, on black; Space / J K L / arrows
// still work; Ctrl+` again or Esc comes back
export function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  const st = document.getElementById('vwStage');
  if (!st || !st.offsetWidth) return toast('Open the Edit page to see the Program monitor full screen');
  st.requestFullscreen().then(() => toast('Full screen - Ctrl+` or Esc to come back')).catch((e) => toast(`Full screen not allowed: ${e.message}`, 'err'));
}
export function toggle() { if (SM.srcMonActive()) return SM.toggle();
  if (mode === 'source' && srcId && !srcPlayable() && S.mediaById[srcId]?.kind !== 'image') { toast('The preview copy is still being made - scrub the bar, mark In / Out and Insert meanwhile'); return; }
  if (mode === 'source') { els.lyA.paused ? els.lyA.play() : els.lyA.pause(); setPlayingUI(!els.lyA.paused); return; } playing ? pause() : play(); }
export function play() {
  ensureAudio();
  if (mode !== 'source') emit('programPlays'); // 🎬 the Source monitor stops
  if (mode === 'source') { els.lyA.play(); setPlayingUI(true); return; }
  if (S.playhead >= duration() - 0.05) S.playhead = 0;
  playing = true; S.progPlaying = true; t0 = S.playhead; wall0 = performance.now();
  setPlayingUI(true);
  cancelFrame(raf);
  const loop = () => {
    if (!playing) return;
    const t = t0 + (performance.now() - wall0) / 1000;
    if (t >= duration()) { S.playhead = duration(); pause(); emit('playhead'); return; }
    S.playhead = t;
    drawProgram(t, true);
    emit('playhead');
    raf = nextFrame(loop);
  };
  raf = nextFrame(loop);
}
export function pause() {
  if (!root) return; // viewer not mounted yet (e.g. on the Home screen)
  if (mode === 'source') { els.lyA.pause(); setPlayingUI(false); return; }
  playing = false; S.progPlaying = false; cancelFrame(raf);
  for (const v of [els.lyA, els.lyB, els.lyOv]) v.pause();
  for (const a of audioPool.values()) a.pause();
  setPlayingUI(false);
}
// J/K/L shuttle (simple): L = play, K = pause, J = back 2 s
export function shuttle(k) { if (SM.srcMonActive()) return SM.shuttle(k); if (k === 'k') pause(); if (k === 'l') play(); if (k === 'j') { pause(); seek((mode === 'source' ? els.lyA.currentTime : S.playhead) - 2); } }
function setPlayingUI(p) { const b = $('[data-act="play"]', root); b.textContent = p ? '❚❚' : '▶'; b.setAttribute('aria-label', p ? 'Pause' : 'Play'); }

function proxyMsg(m) {
  if (m.status !== 'ready') return `Reading ${m.name}…`;
  if (m.proxy === 'error') return `Preview copy failed for ${m.name} - it will still render`;
  return `Preparing a preview copy of ${m.name}${m.proxyPct ? ` (${m.proxyPct}%)` : ''}… it will still render normally`;
}
function showMsg(text, poster) {
  els.vwMsg.hidden = false; els.vwMsg.textContent = text;
  if (poster) { els.lyImg.hidden = false; els.lyImg.src = poster; els.lyImg.style.cssText = 'object-fit:contain;opacity:.5'; }
}

// CSS approximation of the clip's grade/transform for live playback (the render uses the exact FFmpeg maths).
function look(c, rel = 0) {
  const col = c.color || {};
  const exp = Math.pow(2, +col.exposure || 0) * (1 + (+col.offset?.y || 0) * 0.5 + (+col.gain?.y || 0) * 0.5);
  const filt = [];
  if (exp !== 1) filt.push(`brightness(${exp.toFixed(3)})`);
  if ((col.contrast ?? 1) !== 1) filt.push(`contrast(${col.contrast})`);
  if ((col.saturation ?? 1) !== 1) filt.push(`saturate(${col.saturation})`);
  if (col.temp) filt.push(`sepia(${Math.max(0, col.temp) * 0.35}) hue-rotate(${col.temp < 0 ? col.temp * -25 : 0}deg)`);
  const z = +propAt(c, 'transform.zoom', rel) || 1, x = +propAt(c, 'transform.x', rel) || 0, y = +propAt(c, 'transform.y', rel) || 0, r = +propAt(c, 'transform.rotation', rel) || 0;
  // cut effect (flash, shake, whip...) on the first moments of the clip; overlays are drawn by drawFx
  const fx = fxPreview(c, rel);
  if (fx?.filter) filt.push(fx.filter);
  // the clip's video effects (approximate; exact in Accurate preview), amounts scaled to the viewer's size
  const [FW] = ASPECTS[S.project.settings.aspect] || [1920], ef = effectsCss(c, (frame?.clientWidth || 640) / FW);
  if (ef.filter) filt.push(ef.filter);
  if (lookFilter && mode === 'program') filt.push(lookFilter);
  const tf = [z !== 1 || x || y || r ? `translate(${x}%, ${y}%) scale(${z}) rotate(${r}deg)` : '', fx?.transform || '', ef.transform].filter(Boolean).join(' ');
  // fxFilter: only the effects (no colour approximation) - the exact WebGL grade layer adds just these
  return { filter: filt.join(' '), transform: tf, clip: ef.clip, fxFilter: [fx?.filter, ef.filter, mode === 'program' ? lookFilter : ''].filter(Boolean).join(' ') };
}
function fitStyle(el, c, rel = 0) {
  const mode = c.fit || S.project.settings.fit || (isVertical() ? 'blur' : 'fit');
  el.style.objectFit = mode === 'fill' ? 'cover' : 'contain';
  el.style.objectPosition = `${propAt(c, 'cropX', rel) * 100}% ${propAt(c, 'cropY', rel) * 100}%`;
  return mode;
}
const isVertical = () => { const [w, h] = ASPECTS[S.project.settings.aspect] || [16, 9]; return h > w; };

function syncVideo(v, m, c, start, t, play, vol, track = 'V1') {
  const url = m.urls.play;
  if (v.dataset.src !== url) { v.src = url; v.dataset.src = url; }
  v.dataset.cid = c.id;
  // speed ramps: the source position and playback rate follow the ramp curve (tighter resync while ramping)
  const D = clipDur(c, S.mediaById), sp = speedAt(c, t - start, D), target = sourceAt(c, t - start, D);
  // (browsers play 1/16x - 16x; it used to stop at 0.25x - 4x, so bullet time / time-lapse looked wrong and kept jumping)
  v.playbackRate = clamp(sp, 0.07, 8);
  const tol = rampPts(c) ? 0.12 : 0.3;
  setVol(v, rampPts(c) ? 0 : vol, track); // ramped shots are silent, like the render
  if (v.readyState >= 1) {
    if (play) { if (Math.abs(v.currentTime - target) > tol) v.currentTime = target; if (v.paused) v.play().catch(() => {}); }
    else { if (!v.paused) v.pause(); if (Math.abs(v.currentTime - target) > 0.03) v.currentTime = target; }
  } else v.addEventListener('loadedmetadata', () => { v.currentTime = target; if (play && playing) v.play().catch(() => {}); }, { once: true });
}

function textStyle(el, c, st, t, start, end, overlay) {
  const style = c.textStyle || (overlay ? 'center' : 'lower');
  const boxed = c.box ? c.box !== 'none' : style !== 'center' && c.type !== 'title';
  el.className = `lyr txt s-${style}${boxed && !c.strip ? ' boxed' : ''}${c.strip ? ' striped' : ''}`;
  const tri = c.tricolour ? '<i class="tri"></i>' : '';
  let shown = c.text || '', pop = 0;
  if (overlay && isKinetic(c)) { const w = [...wordWindows(c, start, end)].reverse().find((x) => t >= x.a); shown = w ? w.text : ''; if (w && c.anim === 'words') pop = Math.max(0, 1 - (t - w.a) / 0.2) ** 2; }
  el.innerHTML = `<span style="${c.box && c.box !== 'none' ? `background:${esc(c.box)};` : ''}${c.accent ? `border-left:.25em solid ${esc(c.accent)};` : ''}${c.strip ? `--strip:${esc(c.strip)};` : ''}">${esc(shown)}${tri}</span>`;
  // slide-in (templates): lower thirds come in from the left, others rise a little
  const k = c.anim === 'slide' ? Math.max(0, 1 - (t - start) / 0.45) ** 2 : 0;
  // follow (motion tracking): the whole text layer moves with the tracked thing
  el.style.transform = overlay && c.follow?.x?.length ? `translate(${evalKeys(c.follow.x, t - start)}%, ${evalKeys(c.follow.y, t - start)}%)` : '';
  el.firstChild.style.transform = k ? (style === 'lower' ? `translateX(-${(k * 110).toFixed(1)}cqw)` : `translateY(${(k * 4).toFixed(2)}cqh)`) : '';
  el.style.color = c.textColor || '#fff';
  // kinetic 'words': each word big, punched in (render: the same 0.2 s pop)
  // same size rule as the render: a long word is sized to fit the width, even at the top of its pop
  const [FW, FH] = ASPECTS[S.project.settings.aspect] || [1920, 1080];
  const kin = overlay && c.anim === 'words' && c.type === 'title' ? (c.size || Math.min(150, (FW * 0.78) / (Math.max(3, [...shown].length) * 0.7 * 1.25))) : 0;
  el.style.setProperty('--ts', kin ? `${((kin / FH) * 100 * (1 + 0.25 * pop)).toFixed(2)}cqh` : c.size ? `${(c.size / 1080) * 100}cqh` : '');
  const f = Math.min(0.3, (end - start) / 4);
  el.style.opacity = overlay && c.anim !== 'none' ? String(clamp(Math.min((t - start) / f, (end - t) / f), 0, 1)) : '';
}

// Exact grade (same maths as the renderer) drawn by WebGL over the media element, which is kept but made invisible.
function gradeLayer(src, c, opacity) {
  const col = c.color;
  if (!grader || isNeutral(col)) { src.style.visibility = ''; return; }
  if (col.lut && grader.lutName !== col.lut) {
    const cube = cachedLut(col.lut);
    if (cube) grader.setLut(col.lut, cube);
    else { loadLut(S.proj, col.lut).then(() => { if (!playing) drawProgram(S.playhead, false); }).catch(() => {}); src.style.visibility = ''; return; }
  } else if (!col.lut && grader.lutName) grader.setLut(null);
  const w = src.videoWidth || src.naturalWidth, hh = src.videoHeight || src.naturalHeight;
  if (!w) return;
  const cv = els.lyGrade, k = Math.min(1, 1280 / w);
  if (cv.width !== Math.round(w * k)) { cv.width = Math.round(w * k); cv.height = Math.round(hh * k); }
  grader.setSource(src); grader.setGrade(col);
  if (!grader.draw()) return;
  cv.hidden = false;
  cv.style.objectFit = src.style.objectFit; cv.style.objectPosition = src.style.objectPosition;
  cv.style.transform = src.style.transform; cv.style.opacity = opacity; cv.style.filter = src._fxFilter || ''; cv.style.clipPath = src.style.clipPath;
  src.style.visibility = 'hidden';
}

// One element per active overlay clip (video / image / title), reused by clip id, stacked in track order.
// An adjustment layer adds its colour + effects (CSS, approximate) to every layer below it; blend modes use
// CSS mix-blend-mode. Exact results: Accurate preview / render.
const ovSlots = new Map(); // clipId -> { el, used }
const CSS_BLEND = { addition: 'plus-lighter', softlight: 'soft-light' };
function ovSlot(c) {
  const tag = c.type === 'video' ? 'VIDEO' : c.type === 'image' ? 'IMG' : c.type === 'graphic' ? 'CANVAS' : 'DIV';
  let sl = ovSlots.get(c.id);
  if (sl && sl.el.tagName !== tag) { sl.el.remove(); ovSlots.delete(c.id); sl = null; }
  if (!sl) {
    const el = document.createElement(tag.toLowerCase());
    el.className = tag === 'DIV' ? 'lyr txt' : 'lyr';
    if (tag === 'VIDEO') { el.playsInline = true; el.preload = 'auto'; el.muted = true; el.addEventListener('error', () => {}); }
    sl = { el }; ovSlots.set(c.id, sl);
  }
  return sl;
}
// Tracked blur / mosaic boxes of the V1 shot (exact in renders; here a blur over the same place)
function drawMasks(x, t) {
  const el = els.lyMask, c = x?.clip;
  if (!c || c.type !== 'video' || !c.masks?.length) { el.hidden = true; return; }
  const m = S.mediaById[c.mediaId], [W, H] = ASPECTS[S.project.settings.aspect] || [1920, 1080];
  const f = fitMap(framingOf(c, S.project.settings, W, H), ...srcSize(m), W, H, propAt(c, 'cropX', t - x.start), propAt(c, 'cropY', t - x.start)), [sw, sh] = srcSize(m);
  const ts = srcTimeAt(c, t - x.start), boxes = c.masks.map((mk) => ({ mk, b: boxAt(mk.path, ts) })).filter((q) => q.b);
  el.hidden = !boxes.length;
  el.style.transform = look(c, t - x.start).transform;
  el.innerHTML = boxes.map(({ mk, b }) => { const pad = mk.exact ? 0 : 0.09;
    const l = ((f.ox + (b.x - b.w * pad) * sw * f.s) / W) * 100, tp = ((f.oy + (b.y - b.h * pad) * sh * f.s) / H) * 100, w = ((b.w * (1 + 2 * pad) * sw * f.s) / W) * 100, h = ((b.h * (1 + 2 * pad) * sh * f.s) / H) * 100;
    // (▭ Remove is filled in from the picture around it by the render; the viewer shows it as a strong blur)
    const look = mk.type === 'black' ? 'background:#000' : `backdrop-filter:blur(${mk.type === 'remove' ? 18 : mk.type === 'pixelate' ? 9 : 4 + 8 * (mk.amount ?? 0.6)}px)`;
    return `<i style="left:${l}%;top:${tp}%;width:${w}%;height:${h}%;${look}"></i>`; }).join('');
}
// A box drawn on the viewer (fractions of the frame) in clip c's own picture (fractions of the source), which is how
// masks are kept - so the box stays on the logo when the shot is reframed. start: where c starts on the timeline.
export function frameBoxToSource(c, start, b) {
  const m = S.mediaById[c.mediaId], [W, H] = ASPECTS[S.project.settings.aspect] || [1920, 1080], rel = S.playhead - start, [sw, sh] = srcSize(m);
  const f = fitMap(framingOf(c, S.project.settings, W, H), sw, sh, W, H, propAt(c, 'cropX', rel), propAt(c, 'cropY', rel));
  const r = (v) => +v.toFixed(4);
  return { x: r((b.x * W - f.ox) / (sw * f.s)), y: r((b.y * H - f.oy) / (sh * f.s)), w: r((b.w * W) / (sw * f.s)), h: r((b.h * H) / (sh * f.s)) };
}
// Draw a box on the viewer (motion tracking): resolves { x, y, w, h } as fractions of the frame, or null (Esc)
export function pickBox(hint = 'Drag a box around the thing to follow (Esc cancels)') {
  return new Promise((done) => {
    pause();
    const ov = document.createElement('div'); ov.className = 'lyr boxpick'; ov.innerHTML = `<span>${esc(hint)}</span><b hidden></b>`; frame.append(ov);
    const box = ov.querySelector('b'); let a = null;
    const fin = (v) => { ov.remove(); window.removeEventListener('keydown', key, true); done(v); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); fin(null); } };
    window.addEventListener('keydown', key, true);
    const at = (e) => { const r = frame.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) }; };
    ov.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); a = at(e); try { ov.setPointerCapture(e.pointerId); } catch {} });
    ov.addEventListener('pointermove', (e) => { if (!a) return; const b = at(e); Object.assign(box.style, { left: `${Math.min(a.x, b.x) * 100}%`, top: `${Math.min(a.y, b.y) * 100}%`, width: `${Math.abs(b.x - a.x) * 100}%`, height: `${Math.abs(b.y - a.y) * 100}%` }); box.hidden = false; });
    ov.addEventListener('pointerup', (e) => { if (!a) return; const b = at(e), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y); if (w < 0.01 || h < 0.01) { a = null; box.hidden = true; return; } fin({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w, h }); });
  });
}

// Captions (public/js/captions.js) as they will be burned in: style, position, word highlight / pop
function drawCaption(t) {
  const el = els.lyCap, at = captionAt(S.project.captions, t);
  el.hidden = !at;
  if (!at) return;
  const st = S.project.captions.style || {}, [FW, FH] = ASPECTS[S.project.settings.aspect] || [1920, 1080];
  const px = ((st.size || 54) * Math.min(FW, FH)) / 1080 / FH * 100; // % of the frame height, as in the render
  el.className = `lyr capl p-${st.pos || 'bottom'}`;
  el.innerHTML = `<span style="font-family:'${esc(st.font || 'Arial')}','Nirmala UI',sans-serif;font-size:${px.toFixed(2)}cqh;color:${esc(st.color || '#fff')};${st.box ? `background:${esc(st.box)};padding:.12em .4em;` : `-webkit-text-stroke:${((st.outline ?? 3) / 40).toFixed(2)}em #000;paint-order:stroke fill;`}">${at.words.map((w) => (w.active ? `<b style="color:${esc(st.hl || '#ffd400')};display:inline-block;transform:scale(${(1 + 0.18 * w.pop).toFixed(3)})">${esc(w.w)}</b>` : esc(w.w))).join(' ')}</span>`;
}
function drawOverlays(t, isPlay) {
  const L = layout(), ts = S.project.trackState, stack = els.lyOvStack, below = [];
  [els.lyA, els.lyB, els.lyImg, els.lyGrade, els.lyCard].forEach((e) => { if (!e.hidden) below.push(e); });
  const live = new Set(), order = [];
  for (const id of overlayTracks(S.project)) {
    if (ts[id]?.hide) continue;
    for (const x of L[id] || []) {
      if (t < x.start || t >= x.end || x.clip.disabled) continue;
      const c = x.clip, rel = t - x.start;
      if (c.type === 'adjust') {
        // colour (rough) + effects of the adjustment layer go onto everything below it
        const col = c.color || {}, ef = effectsCss(c, (frame?.clientWidth || 640) / ((ASPECTS[S.project.settings.aspect] || [1920])[0]));
        const f = [ef.filter, (col.contrast ?? 1) !== 1 ? `contrast(${col.contrast})` : '', (col.saturation ?? 1) !== 1 ? `saturate(${col.saturation})` : '', col.exposure ? `brightness(${Math.pow(2, col.exposure).toFixed(3)})` : ''].filter(Boolean).join(' ');
        if (f) below.forEach((e) => (e.style.filter = `${e.style.filter || ''} ${f}`.trim()));
        continue;
      }
      if (c.type === 'graphic') {
        // 📊 the same drawing the render bakes, at the viewer's size
        const el = ovSlot(c).el, [FW, FH] = ASPECTS[S.project.settings.aspect] || [1920, 1080];
        const cw = Math.max(2, Math.round((frame?.clientWidth || 640) * Math.min(2, devicePixelRatio || 1))), ch = Math.round((cw * FH) / FW);
        if (el.width !== cw || el.height !== ch) { el.width = cw; el.height = ch; }
        const ctx = el.getContext('2d'); ctx.setTransform(cw / FW, 0, 0, ch / FH, 0, 0);
        drawGraphic(ctx, FW, FH, c.gfx || {}, rel, x.end - x.start);
        live.add(c.id); order.push(el); el.hidden = false; el.style.pointerEvents = 'none';
        continue;
      }
      const m = S.mediaById[c.mediaId];
      if (c.type === 'video' && !m?.playable) continue;
      const sl = ovSlot(c), el = sl.el;
      live.add(c.id); order.push(el);
      el.hidden = false;
      el.style.mixBlendMode = c.blend ? CSS_BLEND[c.blend] || c.blend : '';
      if (c.type === 'title') { textStyle(el, c, null, t, x.start, x.end, true); continue; }
      const lk = look(c, rel);
      fitStyle(el, c, rel);
      el.style.opacity = propAt(c, 'opacity', rel); el.style.transform = lk.transform; el.style.filter = lk.filter; el.style.clipPath = lk.clip || '';
      if (c.type === 'image') { if (el.dataset.src !== m.urls.play) { el.src = m.urls.play; el.dataset.src = m.urls.play; } }
      else syncVideo(el, m, c, x.start, t, isPlay, c.volume ?? 0, id);
      below.push(el);
    }
  }
  // stacking order = track order
  order.forEach((el, i) => { if (stack.children[i] !== el) stack.insertBefore(el, stack.children[i] || null); });
  for (const [id, sl] of ovSlots) if (!live.has(id)) { sl.el.hidden = true; if (sl.el.tagName === 'VIDEO') sl.el.pause(); if (!findAny(id)) { sl.el.remove(); ovSlots.delete(id); } }
}

function drawProgram(t, isPlay) {
  if (!S.project || mode !== 'program') return;
  applyMix();
  const L = layout(), ts = S.project.trackState;
  $('#vwTC').textContent = fmtTC(t, S.project.settings.fps);
  $('#vwDur').textContent = fmtTC(duration(), S.project.settings.fps);
  els.vwMsg.hidden = true;
  const used = new Set();
  // 🔗 a V1 shot's linked sound is played by the shot's own video (with the sound clip's volume, fades and track) - not by a
  // second player of the same file that keeps chasing the picture (that stuttered and loaded everything twice)
  const carried = new Set();
  const partnerOf = (c) => { if (!c.link) return null; for (const id of audioTracks(S.project)) { const a = (S.project.tracks[id] || []).find((o) => o.link === c.link && o.type === 'audio'); if (a) return { a, id }; } return null; };

  // ---- V1 (with transition overlap) ----
  const act = ts.V1?.hide ? [] : L.V1.filter((x) => t >= x.start && t < x.end && !x.clip.disabled);
  const cur = act[act.length - 1], prev = act.length > 1 ? act[0] : null;
  const v1vol = (c, rel) => (c.mute ? 0 : propAt(c, 'volume', rel));
  const slots = [els.lyA, els.lyB];
  const slotFor = (x) => slots.find((s) => s.dataset.cid === x.clip.id) || slots.find((s) => !used.has(s) && s.dataset.cid !== cur?.clip.id && s.dataset.cid !== prev?.clip.id) || slots.find((s) => !used.has(s));
  let blurSet = false;
  const drawV1 = (x, opacity) => {
    const c = x.clip, m = S.mediaById[c.mediaId];
    opacity = String(+opacity * propAt(c, 'opacity', t - x.start)); // the clip's own (keyframed) opacity over black
    if (c.type === 'title') {
      els.lyCard.hidden = false; els.lyCard.style.background = c.bg || '#0b2545'; els.lyCard.style.opacity = opacity;
      els.lyCard.innerHTML = `<span style="color:${esc(c.textColor || '#fff')};font-size:${c.size ? (c.size / 1080) * 100 : 6}cqh${c.accent ? `;border-bottom:.12em solid ${esc(c.accent)};padding-bottom:.3em` : ''}">${esc(c.text || '')}</span>${c.tricolour ? '<i class="tri card"></i>' : ''}`;
      return;
    }
    if (!m) { showMsg(`Missing media for clip`); return; }
    const lk = look(c, t - x.start);
    if (c.type === 'image') {
      const img = els.lyImg; img.hidden = false; if (img.dataset.src !== m.urls.play) { img.src = m.urls.play; img.dataset.src = m.urls.play; }
      const kb = c.kenburns ?? (S.project.settings.kenburns ? 'in' : false), p = clamp((t - x.start) / (x.end - x.start), 0, 1);
      const z = kb ? (kb === 'out' ? 1.15 - 0.15 * p : 1 + 0.15 * p) : 1;
      fitStyle(img, kb ? { ...c, fit: 'fill' } : c, t - x.start);
      img.style.transform = `${lk.transform} scale(${z})`; img.style.filter = lk.filter; img.style.opacity = opacity; img.style.clipPath = lk.clip || ''; img._fxFilter = lk.fxFilter;
      gradeLayer(img, c, opacity);
      return;
    }
    if (!m.playable) { showMsg(proxyMsg(m), m.urls.thumb); return; }
    const v = slotFor(x); used.add(v);
    v.hidden = false; v.style.opacity = opacity;
    const fm = fitStyle(v, c, t - x.start);
    v.style.transform = lk.transform; v.style.filter = lk.filter; v.style.clipPath = lk.clip || ''; v._fxFilter = lk.fxFilter;
    if (fm === 'blur' && m.urls.thumb && !blurSet) { els.lyBlur.hidden = false; els.lyBlur.style.backgroundImage = `url('${m.urls.thumb}')`; blurSet = true; }
    const pa = partnerOf(c);
    if (pa && !pa.a.disabled) {
      carried.add(pa.a.id);
      const rel = t - x.start, fi = pa.a.fadeIn || 0, fo = pa.a.fadeOut || 0, fade = Math.min(fi ? clamp(rel / fi, 0, 1) : 1, fo ? clamp((x.end - t) / fo, 0, 1) : 1);
      syncVideo(v, m, c, x.start, t, isPlay, pa.a.mute || !trackAudible(pa.id) ? 0 : propAt(pa.a, 'volume', rel) * fade, pa.id);
    } else syncVideo(v, m, c, x.start, t, isPlay, v1vol(c, t - x.start));
    gradeLayer(v, c, opacity);
  };
  els.lyCard.hidden = true; els.lyImg.hidden = true; els.lyBlur.hidden = true; els.lyGrade.hidden = true;
  if (prev) drawV1(prev, 1);
  if (cur) drawV1(cur, prev ? String(clamp((t - cur.start) / Math.max(0.01, cur.overlap), 0, 1)) : 1);
  // the shot that just came is still loading (a jump to a new place in the file, over the internet): the last frame of
  // the one before stays up under it instead of black, until the new one has a picture
  const loading = [...used].some((s) => s.readyState < 2 || s.seeking);
  for (const s of slots) if (!used.has(s)) { s.pause(); if (!(loading && !s.hidden && s.readyState >= 2)) s.hidden = true; }
  if (!cur && !act.length && L.V1.length && t < duration()) { /* gap after V1: black */ }
  // V1 clip text (lower third)
  const tx = cur?.clip;
  if (tx?.text && tx.type !== 'title' && (!tx.textDuration || t - cur.start < tx.textDuration)) { els.lyText.hidden = false; textStyle(els.lyText, tx, null, t, cur.start, cur.end, false); }
  else els.lyText.hidden = true;
  // preload the next V1 video so cuts don't stall
  const nx = L.V1.find((x) => x.start > t && x.start - t < 2 && x.clip.type === 'video');
  if (nx && isPlay) {
    const m = S.mediaById[nx.clip.mediaId], free = slots.find((s) => !used.has(s));
    if (m?.playable && free && free.dataset.cid !== nx.clip.id) { free.dataset.cid = nx.clip.id; if (free.dataset.src !== m.urls.play) { free.src = m.urls.play; free.dataset.src = m.urls.play; } free.currentTime = nx.clip.in || 0; }
  }

  drawMasks(cur, t);
  // ---- overlay tracks (V2, V3, … bottom to top) ----
  drawOverlays(t, isPlay);
  drawCaption(t);

  // ---- cut effect overlay (flash, light leak, film burn, strobe) of the shot on V1 ----
  const fo = cur && !cur.clip.disabled ? fxPreview(cur.clip, t - cur.start)?.overlay : null;
  els.lyFx.hidden = !fo;
  if (fo) { els.lyFx.style.background = fo.background; els.lyFx.style.opacity = fo.opacity.toFixed(3); els.lyFx.style.mixBlendMode = fo.blend || 'normal'; }

  // ---- logo ----
  const lg = S.project.logo, lm = lg?.mediaId && S.mediaById[lg.mediaId];
  els.lyLogo.hidden = !lm;
  if (lm) {
    if (els.lyLogo.dataset.src !== lm.urls.play) { els.lyLogo.src = lm.urls.play; els.lyLogo.dataset.src = lm.urls.play; }
    const pos = lg.pos || 'tr';
    els.lyLogo.style.cssText = `width:${(lg.scale ?? 0.12) * 100}%;opacity:${lg.opacity ?? 0.9};${pos.includes('t') ? 'top' : 'bottom'}:4%;${pos.includes('l') ? 'left' : 'right'}:4%`;
  }

  // ---- audio tracks ----
  const live = new Set();
  for (const id of audioTracks(S.project)) {
    if (!trackAudible(id)) continue;
    for (const x of L[id]) {
      if (t < x.start || t >= x.end || x.clip.disabled || carried.has(x.clip.id)) continue; // (carried: its picture plays it)
      const c = x.clip, m = S.mediaById[c.mediaId];
      if (!m?.playable) continue;
      live.add(c.id);
      let a = audioPool.get(c.id);
      if (!a) { a = new Audio(); a.preload = 'auto'; a.dataset.track = id; audioPool.set(c.id, a); }
      if (a.dataset.src !== m.urls.play) { a.src = m.urls.play; a.dataset.src = m.urls.play; }
      const sp = c.speed || 1;
      let target = (c.in || 0) + (t - x.start) * sp;
      if (c.loop) { const seg = Math.max(0.5, (c.out ?? m.duration) - (c.in || 0)); target = (c.in || 0) + (((t - x.start) * sp) % seg); }
      const fi = c.fadeIn || 0, fo = c.fadeOut || 0, rel = t - x.start, rem = x.end - t;
      const fade = Math.min(fi ? clamp(rel / fi, 0, 1) : 1, fo ? clamp(rem / fo, 0, 1) : 1);
      setVol(a, propAt(c, 'volume', rel) * fade, id);
      a.playbackRate = clamp(sp, 0.25, 4);
      if (a.readyState >= 1) {
        // (a clip's own linked sound keeps lip sync tighter)
        if (isPlay) { if (Math.abs(a.currentTime - target) > (c.link ? 0.12 : 0.3)) a.currentTime = target; if (a.paused) a.play().catch(() => {}); }
        else { a.pause(); if (Math.abs(a.currentTime - target) > 0.05) a.currentTime = target; }
      }
    }
  }
  for (const [id, a] of audioPool) if (!live.has(id)) { a.pause(); if (!S.project || !findAny(id)) { a.src = ''; audioPool.delete(id); } }
}
const findAny = (id) => Object.values(S.project.tracks).some((l) => l.some((c) => c.id === id));

// ---------------- live audio mix (Web Audio) ----------------
// media element -> own gain (clip volume, may exceed 1) -> track FX chain -> track fader -> meter -> master.
// Created on the first Play (browsers allow audio only after a user gesture). Noise reduction, de-essing and ducking are render-only.
let actx = null, master = null, masterAn = null;
const chains = {}, fxSig = {};
function ensureAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return actx; }
  try { actx = new AudioContext(); } catch { return null; }
  master = actx.createGain(); masterAn = actx.createAnalyser(); masterAn.fftSize = 2048;
  master.connect(masterAn); masterAn.connect(actx.destination);
  for (const id of ['V1', 'V2', 'A1', 'A2', 'A3']) {
    const fx = buildFxNodes(actx), fader = actx.createGain(), an = actx.createAnalyser();
    an.fftSize = 2048; fx.output.connect(fader); fader.connect(an); an.connect(master);
    chains[id] = { fx, fader, an };
  }
  route(els.lyA, 'V1'); route(els.lyB, 'V1'); route(els.lyOv, 'V2');
  for (const a of audioPool.values()) route(a, a.dataset.track);
  applyMix();
  return actx;
}
function chainOf(id) {
  if (!chains[id] && actx) {
    const fx = buildFxNodes(actx), fader = actx.createGain(), an = actx.createAnalyser();
    an.fftSize = 2048; fx.output.connect(fader); fader.connect(an); an.connect(master);
    chains[id] = { fx, fader, an };
  }
  return chains[id];
}
function route(el, track) {
  if (!actx || !track || !chainOf(track)) return;
  if (!el._src) { el._src = actx.createMediaElementSource(el); el._g = actx.createGain(); el._src.connect(el._g); }
  if (el._track !== track) { try { el._g.disconnect(); } catch {} el._g.connect(chains[track].fx.input); el._track = track; }
  el.volume = 1;
}
function trackAudible(id) {
  const ts = S.project.trackState || {};
  if (ts[id]?.mute) return false;
  return !Object.values(ts).some((x) => x?.solo) || !!ts[id]?.solo;
}
function setVol(el, vol, track) {
  if (actx) { route(el, track); el.muted = false; el._g.gain.setTargetAtTime(Math.max(0, vol), actx.currentTime, 0.015); return; }
  const v = vol * (trackAudible(track) ? S.project.trackState?.[track]?.volume ?? 1 : 0);
  el.volume = clamp(v, 0, 1); el.muted = v <= 0;
}
export function applyMix() {
  if (!actx || !S.project) return;
  for (const id of Object.keys(chains)) {
    const st = S.project.trackState?.[id] || {};
    chains[id].fader.gain.setTargetAtTime(trackAudible(id) ? st.volume ?? 1 : 0, actx.currentTime, 0.02);
    const sig = JSON.stringify(st.fx || {});
    if (fxSig[id] !== sig) { chains[id].fx.set(st.fx || {}); fxSig[id] = sig; }
  }
}
// Peak / RMS in dBFS per track and master, for the meters (null until audio has started).
const buf = new Float32Array(2048);
function measureAn(an) {
  an.getFloatTimeDomainData(buf);
  let pk = 0, sq = 0;
  for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; sq += buf[i] * buf[i]; }
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -120);
  return { peak: db(pk), rms: db(Math.sqrt(sq / buf.length)) };
}
export function levels() {
  if (!actx) return null;
  const out = { master: measureAn(masterAn) };
  for (const id of Object.keys(chains)) out[id] = measureAn(chains[id].an);
  return out;
}
export const isPlayingProgram = () => playing;
