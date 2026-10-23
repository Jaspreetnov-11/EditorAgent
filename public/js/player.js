// Viewer: "Timeline" mode plays the edit live from proxies (V1 with transitions, V2 overlays/titles, logo,
// all audio tracks); "Source" mode previews one media file with In/Out marks.
// Live playback is a close preview; "Accurate preview" renders the exact result with FFmpeg.
import { reportError } from './errlog.js';
import * as SM from './sourcemon.js';
import { useContext as audioOut } from './audioout.js';
import { S, on, emit, layout, duration, commit } from './store.js';
import { ASPECTS, fmtTC, fmtTime, fmt, clipDur, propAt, sourceAt, speedAt, rampPts, setAnimated, overlayTracks, audioTracks, evalKeys, BLEND_CSS, seqHash } from './model.js';
import { stabState, stabBanner } from './stabprev.js';

// 🎞 Full quality, like Premiere: a camera file the browser can decode itself - HEVC / H.265 (DJI drones, Sony, phones;
// most PCs' graphics decode 4K of it, measured: a 4K DJI file loads in 0.75 s and plays without a dropped frame) - plays
// from the file, not from its small 540p preview copy (which made the monitor soft). The preview copy stays for what
// the browser cannot play (MXF, ProRes, 4:2:2), and when the editor is opened over the internet (too heavy to stream).
const HEVC = (() => {
  try { const v = document.createElement('video'); return { yuv420p: !!v.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"'), yuv420p10le: !!v.canPlayType('video/mp4; codecs="hvc1.2.4.L153.B0"') }; } catch { return {}; }
})();
const ON_LAN = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
// ⚡ Playback, like Premiere's Playback Resolution (the monitor's Fast / Full): Fast - the default - plays the 1080p preview
// copy when there is one (light to stream from the NAS to every PC at once, quick to scrub); Full plays the camera file
// itself (sharpest, heavy: a 4K HEVC drone file is ~100 Mbit/s for each PC that plays it - 20-30 PCs made it all slow)
let playback = (() => { try { return localStorage.getItem('ve-playback') === 'full' ? 'full' : 'fast'; } catch { return 'fast'; } })();
export const playbackMode = () => playback;
// (and 4K H.264, which only got the preview copy for being big)
const direct = (m) => ON_LAN && m?.kind === 'video' && m.status === 'ready' && m.proxy !== 'none' && /\.(mp4|mov|m4v)$/i.test(m.path || '')
  && !(playback === 'fast' && m.proxy === 'ready' && ((m.proxyH || 0) >= 1080 || (m.width || 0) * (m.height || 0) > 1920 * 1080))
  // (a 4K file in Fast plays its preview copy even while that is still the old 540p one - its 1080p copy is being made;
  // five keyed 4K drone layers decoded at once made the monitor stutter)
  && ((m.vcodec === 'hevc' && HEVC[m.pixfmt]) || (m.vcodec === 'h264' && /^yuvj?420p$/.test(m.pixfmt || '')));
export const canPlay = (m) => !!m && (m.playable || direct(m));
export const playUrl = (m) => (direct(m) ? m.urls.play.replace(/\/play$/, '/orig') : m.urls.play);
import { lookCss } from './looks.js';
import { buildFxNodes } from './audiofx.js';
import { buildClipAudioChain, fadeShape } from './audioeffects.js';
import { $, $$, h, esc, clamp, toast } from './ui.js';
import { placeMedia, targets } from './timeline.js';
import { api, enc } from './api.js';
import { Grader, loadLut, cachedLut } from './colorgl.js';
import { isNeutral } from './colormath.js';
import { fxPreview, wordWindows, isKinetic, trLive, polyCss } from './fx.js';
import { drawGraphic, textLayout, pinOn } from './graphics.js';
import { addTextAt, addShapeAt } from './gfxui.js';
import { effectsCss, maskedEffectsCss, grainCss, VFX, inWindow, blendOf } from './effects.js';
import { maskAlpha, movedMask, unmovedMask, maskKey } from './shapemask.js';
import { captionAt, capTracks, capStack } from './captions.js';
import { monitorDrag } from './toolgroups.js';
import { fitMap, framingOf, srcSize, boxAt, srcTimeAt, pinAt, quadMatrix, orderQuad } from './tracking.js';

let root, frame, els = {}, mode = 'program', srcId = null, grader = null;
export const sourceMediaId = () => srcId; // (the file open in the Source monitor - ✂ Make Subclip)
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
    <select class="small vw-zoom" data-vzoom title="Zoom level, like Premiere's: Fit shows the whole frame. The mouse wheel over the picture zooms in / out where the mouse is (Alt + wheel scales the selected clip); middle-drag or the scrollbars move around"><option value="fit">Fit</option>${ZOOMS.map((z) => `<option value="${z}">${Math.round(z * 100)}%</option>`).join('')}</select>
    <select class="small vw-pb" data-pb title="Playback: Fast plays the light 1080p preview copies (quick to load and scrub, easy on the NAS when the whole office works); Full plays the camera files themselves where the browser can (sharpest, much heavier)"><option value="fast">Fast</option><option value="full">Full</option></select>
    <button class="tog small" data-act="guides" title="Title/action-safe guides">Guides</button>
    <select class="small vw-pq" data-pq title="Accurate preview quality: 1080p from the camera files (sharp), or Fast 720p from the small proxy copies (much quicker - for checking timing)"><option value="hq">1080p</option><option value="fast">Fast 720p</option></select>
    <button class="small" data-act="accurate" title="Render the exact result with FFmpeg (quality: the choice next to it)">Accurate preview</button>
  </div>
  <div class="vw-stage" id="vwStage">
    <div class="vw-frame" id="vwFrame">
      <div class="lyr blurbg" id="lyBlur"></div>
      <video class="lyr" id="lyA" playsinline preload="auto"></video>
      <video class="lyr" id="lyB" playsinline preload="auto"></video>
      <canvas class="lyr" id="lyGrade" hidden></canvas>
      <img class="lyr" id="lyImg" alt="">
      <div class="lyr title-card" id="lyCard"></div>
      <div class="lyr fxmask" id="lyFxm"></div>
      <div class="lyr fxover" id="lyFxo" hidden></div>
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
      <video class="lyr rend" id="lyRend" playsinline preload="auto" muted hidden></video>
      <div class="lyr guides" id="lyGuides" hidden><i class="g-action"></i><i class="g-title"></i><i class="g-h"></i><i class="g-v"></i></div>
      <div class="lyr maskui" id="lyMaskUi" hidden></div>
      <div class="vw-msg" id="vwMsg" hidden></div>
      <div class="vw-stab" id="vwStab" hidden></div>
    </div>
  </div>
  <div class="vw-ruler" id="vwRuler" title="Drag to move through the edit"><div class="vr-ticks"></div><div class="vr-ph"><i></i></div></div>
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
    <button class="icon-btn" data-act="frame" title="Export Frame (Ctrl+Shift+E): this frame as a PNG, exactly as the export makes it" aria-label="Export Frame">📷</button>
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
  for (const k of ['lyA', 'lyB', 'lyImg', 'lyCard', 'lyText', 'lyOv', 'lyOvImg', 'lyOvText', 'lyLogo', 'lyBlur', 'vwMsg', 'lyGrade', 'lyFx', 'lyOvStack', 'lyCap', 'lyMask', 'lyFxm', 'lyMaskUi', 'lyFxo', 'vwStab', 'lyRend']) els[k] = $(`#${k}`, el);
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
      accurate: () => emit('accuratePreview'), frame: () => import('./editing.js').then((x) => x.exportFrame()) })[a]?.();
  });
  $('#srcBar', el).addEventListener('pointerdown', (e) => {
    const bar = $('#srcBar'), go = (ev) => { const b = bar.getBoundingClientRect(); seek(clamp((ev.clientX - b.left) / b.width, 0, 1) * curDuration()); };
    go(e);
    const up = () => { window.removeEventListener('pointermove', go); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', go); window.addEventListener('pointerup', up);
  });
  new ResizeObserver(sizeFrame).observe($('#vwStage', el));
  { const pb = $('[data-pb]', el); pb.value = playback; pb.onchange = () => { playback = pb.value; try { localStorage.setItem('ve-playback', playback); } catch {} if (mode === 'program') drawProgram(S.playhead, false); else loadSource(); }; }
  { const pq = $('[data-pq]', el); try { pq.value = localStorage.getItem('ve-preview-q') === 'fast' ? 'fast' : 'hq'; } catch {} pq.onchange = () => { try { localStorage.setItem('ve-preview-q', pq.value); } catch {} }; }
  // ⏱ Program monitor's time ruler (like Premiere's): timecodes along the whole edit; drag anywhere on it to scrub
  const vr = $('#vwRuler', el);
  vr.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); try { vr.setPointerCapture(e.pointerId); } catch {}
    const go = (ev) => { const b = vr.getBoundingClientRect(); emit('seek', clamp((ev.clientX - b.left) / b.width, 0, 1) * duration()); };
    go(e);
    const up = () => { vr.removeEventListener('pointermove', go); vr.removeEventListener('pointerup', up); };
    vr.addEventListener('pointermove', go); vr.addEventListener('pointerup', up);
  });
  new ResizeObserver(drawRuler).observe(vr);
  on('change', drawRuler);
  bindDirectMove();
  bindTypeTool();
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
  // only the Selection tool moves a clip here
  frame.addEventListener('pointermove', (e) => { if (!e.buttons) frame.classList.toggle('can-move', monitorDrag(S.tool, 0, false) === 'move' && !!movable()); });
  frame.addEventListener('pointerdown', (e) => {
    if (monitorDrag(S.tool, e.button, false) !== 'move') return;
    const m = movable(); if (!m) return;
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
  // 🔍 the wheel zooms the monitor in / out where the mouse is (Alt + wheel: the selected clip's own Scale, below)
  const stage = $('#vwStage', root);
  stage.addEventListener('wheel', (e) => {
    if (e.altKey || e.ctrlKey) return;
    e.preventDefault();
    const [w] = frameWH(), cur = frame.getBoundingClientRect().width / w;
    setViewZoom(cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX, y: e.clientY });
  }, { passive: false });
  $('[data-vzoom]', root).addEventListener('change', (e) => setViewZoom(e.target.value === 'fit' ? 'fit' : +e.target.value));
  // middle-drag moves around a zoomed-in picture
  stage.addEventListener('pointerdown', (e) => {
    if (monitorDrag(S.tool, e.button, viewZoom !== 'fit') !== 'pan') return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, l0 = stage.scrollLeft, t0 = stage.scrollTop;
    const mv = (ev) => { stage.scrollLeft = l0 - (ev.clientX - x0); stage.scrollTop = t0 - (ev.clientY - y0); };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
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
  const v = +lk.vignette || 0, gr = +lk.grain || 0;
  el.hidden = mode !== 'program' || (!bar && !v && !gr);
  el.dataset.grain = gr ? String((bar ? 1 : 0) + (v ? 1 : 0)) : ''; // (how many layers come before the grain)
  // the film look, roughly (Accurate preview / renders use the exact LUT)
  lookFilter = mode === 'program' ? lookCss(lk) : '';
  if (els.lyBlur) els.lyBlur.style.filter = lookFilter;
  if (mode === 'program' && !playing) drawProgram(S.playhead, false);
  el.style.background = [bar ? `linear-gradient(#000 0 ${bar}%, transparent ${bar}% ${100 - bar}%, #000 ${100 - bar}%)` : '', v ? `radial-gradient(ellipse at center, transparent ${70 - 30 * v}%, rgba(0,0,0,${(0.35 + 0.45 * v).toFixed(2)}) 100%)` : '', gr ? grainCss(gr * 0.8) : ''].filter(Boolean).join(',');
}
// grain moves every frame while playing (still noise looks like dirt on the lens)
const grainShift = () => (playing ? `${Math.floor(Math.random() * 160)}px ${Math.floor(Math.random() * 160)}px` : '0 0');
export const isPlaying = () => playing || (mode === 'source' && !els.lyA.paused);
export const viewerMode = () => mode;

// 🔍 the monitor's zoom (Premiere's Select Zoom Level): 'fit' or a share of the frame's own pixels (1 = 100%)
const ZOOMS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4];
let viewZoom = 'fit';
function frameWH() {
  let [w, h] = ASPECTS[S.project.settings.aspect] || [16, 9];
  if (mode === 'source' && srcId) { const m = S.mediaById[srcId]; if (m?.width) { w = m.width; h = m.height; if (Math.abs(m.rotation) === 90) [w, h] = [h, w]; } }
  return [w, h];
}
// z: 'fit' or a level; at: the screen point that stays put (the mouse), else the middle of the view
function setViewZoom(z, at = null) {
  const st = $('#vwStage', root); if (!st || !S.project) return;
  const [w, h] = frameWH(), fitK = Math.min((st.clientWidth - 16) / w, (st.clientHeight - 16) / h);
  if (z !== 'fit') { z = Math.min(8, Math.max(0.05, z)); if (z <= fitK * 1.001) z = 'fit'; } // (smaller than fitting: back to Fit)
  const b0 = frame.getBoundingClientRect(), sr = st.getBoundingClientRect();
  const p = at || { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 }, u = (p.x - b0.left) / b0.width, v = (p.y - b0.top) / b0.height;
  viewZoom = z; sizeFrame();
  if (z !== 'fit') { const b1 = frame.getBoundingClientRect(); st.scrollLeft += b1.left + u * b1.width - p.x; st.scrollTop += b1.top + v * b1.height - p.y; }
  const sel = $('[data-vzoom]', root);
  if (sel) {
    sel.querySelector('[data-cur]')?.remove();
    if (z !== 'fit' && !ZOOMS.includes(z)) sel.insertAdjacentHTML('beforeend', `<option data-cur value="${z}">${Math.round(z * 100)}%</option>`);
    sel.value = String(z);
  }
  if (mode === 'program' && !playing) drawProgram(S.playhead, false);
}
function sizeFrame() {
  const st = $('#vwStage', root); if (!st || !S.project) return;
  const [w, h] = frameWH(), W = st.clientWidth - 16, H = st.clientHeight - 16, k = viewZoom === 'fit' ? Math.min(W / w, H / h) : viewZoom;
  st.classList.toggle('zoomed', viewZoom !== 'fit');
  frame.style.width = `${Math.max(10, w * k)}px`; frame.style.height = `${Math.max(10, h * k)}px`;
  frame.style.setProperty('--fh', `${h * k}px`);
}

export function setMode(m) {
  if (m === 'source' && !srcId) { toast('Double-click a clip in Media to open it here'); return; }
  pause();
  mode = m;
  $$('[data-mode]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  $('#vwSrc', root).hidden = m !== 'source';
  $('#vwRuler', root).hidden = m !== 'program';
  $('.src-only', root).hidden = m !== 'source';
  hideAll();
  sizeFrame();
  if (m === 'program') { $('#vwTitle').textContent = S.project?.name || ''; drawProgram(S.playhead, false); }
  else loadSource();
  drawLook();
}

function hideAll() {
  for (const k of ['lyA', 'lyB', 'lyImg', 'lyCard', 'lyText', 'lyOv', 'lyOvImg', 'lyOvText', 'lyLogo', 'lyBlur', 'vwMsg', 'vwStab', 'lyFx', 'lyCap', 'lyMask', 'lyFxo', 'lyFxm']) { els[k].hidden = true; els[k].style.opacity = ''; }
  // the program's colour layer and cinematic overlay must not show through the source monitor
  els.lyGrade.hidden = true; const lk = $('#lyLook', root); if (lk) lk.hidden = true;
  for (const v of [els.lyA, els.lyB, els.lyOv]) v.pause();
  if (els.lyRend) { els.lyRend.hidden = true; els.lyRend.pause(); }
  for (const a of audioPool.values()) a.pause();
  for (const sl of ovSlots.values()) { sl.el.hidden = true; if (sl.el.tagName === 'VIDEO') sl.el.pause(); }
}

// ---------------- source monitor ----------------
// A camera file whose preview copy is still being made cannot play yet; the Source monitor then scrubs a virtual
// position (srcT) over the clip's filmstrip, and In / Out / Insert / Overlay still work. The copy is made right away.
let srcT = 0;
const srcPlayable = () => { const m = S.mediaById[srcId]; return !!m && m.kind !== 'image' && canPlay(m); };
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
  // ✂ a subclip opens with its part marked (In / Out) - its file is the whole one
  if (m.subOf && !S.sourceMarks[srcId]) S.sourceMarks[srcId] = { in: m.subIn, out: m.subOut };
  const v = els.lyA, mk = S.sourceMarks[srcId] || {};
  v.style.cssText = ''; v.style.objectFit = 'contain';
  srcT = srcAt ?? mk.in ?? 0;
  const jump = srcAt !== null; srcAt = null;
  if (m.kind === 'image') { els.lyImg.hidden = false; els.lyImg.src = m.urls.thumb ? `${m.urls.play}` : m.urls.play; els.lyImg.style.cssText = 'object-fit:contain'; }
  else if (!canPlay(m)) {
    showMsg(`${proxyMsg(m)} - you can scrub, mark In / Out and Insert meanwhile.`, m.urls.strip ? null : m.urls.thumb);
    drawStrip();
    if (m.kind === 'video') api('POST', `/api/media/urgent?p=${enc(S.proj)}&id=${m.id}`).catch(() => {});
  } else {
    v.hidden = false; v.muted = false; v.volume = 1; v.playbackRate = 1;
    if (v.dataset.src !== playUrl(m)) {
      v.src = playUrl(m); v.dataset.src = playUrl(m); v.dataset.cid = '';
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
  } else { const tg = targets()[m.kind === 'audio' ? 'a' : 'v']; // (🎯 a targeted track, else as before)
    if (how === 'overlay') c = placeMedia(srcId, tg || (m.kind === 'audio' ? 'A1' : 'V2'), S.playhead, { ...mk, ...(tg ? { overwrite: true } : {}) });
    else c = placeMedia(srcId, tg || (m.kind === 'audio' ? 'A2' : 'V1'), S.playhead, mk); }
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
  const [FW] = ASPECTS[S.project.settings.aspect] || [1920], ef = effectsCss(c, (frame?.clientWidth || 640) / FW, rel);
  if (ef.filter) filt.push(ef.filter);
  if (lookFilter && mode === 'program') filt.push(lookFilter);
  const tf = [z !== 1 || x || y || r ? `translate(${x}%, ${y}%) scale(${z}) rotate(${r}deg)` : '', fx?.transform || '', ef.transform].filter(Boolean).join(' ');
  // fxFilter: only the effects (no colour approximation) - the exact WebGL grade layer adds just these
  return { filter: filt.join(' '), transform: tf, clip: ef.clip, overlay: ef.overlay, grain: ef.grain, fxFilter: [fx?.filter, ef.filter, mode === 'program' ? lookFilter : ''].filter(Boolean).join(' ') };
}
function fitStyle(el, c, rel = 0) {
  const mode = c.fit || S.project.settings.fit || (isVertical() ? 'blur' : 'fit');
  el.style.objectFit = mode === 'fill' ? 'cover' : 'contain';
  el.style.objectPosition = `${propAt(c, 'cropX', rel) * 100}% ${propAt(c, 'cropY', rel) * 100}%`;
  return mode;
}
const isVertical = () => { const [w, h] = ASPECTS[S.project.settings.aspect] || [16, 9]; return h > w; };

function syncVideo(v, m, c, start, t, play, vol, track = 'V1') {
  // 🎥 a stabilised shot plays its stabilised copy once the server has made it (stabprev.js); until then the file
  const st = stabState(c, m), stab = st?.status === 'ready' ? st : null, banner = stabBanner(st);
  if (banner && mode === 'program') { els.vwStab.hidden = false; els.vwStab.textContent = banner; }
  const url = stab ? stab.url : playUrl(m);
  if (v.dataset.src !== url) { v.src = url; v.dataset.src = url; }
  v.dataset.cid = c.id;
  // speed ramps: the source position and playback rate follow the ramp curve (tighter resync while ramping)
  const D = clipDur(c, S.mediaById), sp = speedAt(c, t - start, D);
  let target = sourceAt(c, t - start, D);
  // ⏪ Reverse speed: the frame mirrored inside In..Out (a browser cannot play backwards: it is shown frame by frame)
  if (c.reverse) target = (c.in || 0) + (c.out ?? m.duration ?? 0) - target;
  if (stab) target -= stab.a; // (the copy starts at that second of the file)
  v.preservesPitch = c.keepPitch !== false; // ("Maintain audio pitch" off: faster = higher, like the render)
  // (browsers play 1/16x - 16x; it used to stop at 0.25x - 4x, so bullet time / time-lapse looked wrong and kept jumping)
  // Playing, a small drift is caught up by playing a little faster / slower for a moment - a jump (seek) makes the
  // browser find a frame again and stutters; slow motion and ramps used to jump many times a second (DaVinci doesn't).
  // Only a real gap (over half a second, or the shot just came on) is a jump.
  const drift = target - v.currentTime;
  setVol(v, rampPts(c) || c.reverse ? 0 : vol, track, c); // ramped shots are silent, like the render (and reversed ones here)
  if (v.readyState >= 1) {
    if (c.reverse) { if (!v.paused) v.pause(); if (Math.abs(v.currentTime - target) > 0.03) v.currentTime = target; return; }
    if (play) {
      if (Math.abs(drift) > 0.5 || v.paused) { v.currentTime = target; v.playbackRate = clamp(sp, 0.07, 8); }
      else v.playbackRate = clamp(sp * (1 + clamp(drift * 2, -0.35, 0.35)), 0.07, 8);
      if (v.paused) v.play().catch(() => {});
    }
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
  src._gradeHidden = false;
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
  cv.hidden = false; cv.style.visibility = ''; // (a mirror / green screen canvas may have hidden it last frame)
  cv.style.objectFit = src.style.objectFit; cv.style.objectPosition = src.style.objectPosition;
  cv.style.transform = src.style.transform; cv.style.opacity = opacity; cv.style.filter = src._fxFilter || ''; cv.style.clipPath = src.style.clipPath;
  cv.style.maskImage = cv.style.webkitMaskImage = src.style.maskImage; cv.style.maskSize = cv.style.webkitMaskSize = '100% 100%';
  src.style.visibility = 'hidden'; src._gradeHidden = true;
}

// One element per active overlay clip (video / image / title), reused by clip id, stacked in track order.
// An adjustment layer adds its colour + effects (CSS, approximate) to every layer below it; blend modes use
// CSS mix-blend-mode. Exact results: Accurate preview / render.
const ovSlots = new Map(); // clipId -> { el, used }
const CSS_BLEND = BLEND_CSS;
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
// ⏱ the time ruler under the Program monitor: about one label every 90 px, at a round step (1 s … 30 min)
let rulerKey = '';
function drawRuler(t) {
  const el = $('#vwRuler', root); if (!el || !S.project) return;
  const D = Math.max(1, duration()), w = el.clientWidth || 1, key = `${D.toFixed(2)}|${w}|${S.project.settings.fps}`;
  if (key !== rulerKey) {
    rulerKey = key;
    const want = (D * 90) / w, step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800].find((x) => x >= want) || 3600, minor = step / 5;
    const tc = (t) => fmtTC(t, S.project.settings.fps).replace(/:\d\d$/, ''); // (hh:mm:ss, like Premiere's)
    let h = '';
    for (let t = 0; t <= D + 1e-6; t += minor) {
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6, x = ((t / D) * 100).toFixed(3);
      h += major ? `<b style="left:${x}%"></b>${t < D - step * 0.4 || t === 0 ? `<span style="left:${x}%">${tc(t)}</span>` : ''}` : `<i style="left:${x}%"></i>`;
    }
    $('.vr-ticks', el).innerHTML = h;
  }
  placeRuler(typeof t === 'number' ? t : S.playhead);
}
function placeRuler(t) {
  const ph = root && $('#vwRuler .vr-ph', root); if (!ph) return;
  ph.style.left = `${clamp(t / Math.max(1, duration()), 0, 1) * 100}%`;
}

// T ---------------- the Type tool: write straight on the Program monitor (like Premiere) ----------------
// Type tool (T): click on the picture -> a new text there, typed in place; click an existing text -> type in it.
// Selection tool: drag a text to move it, double-click it to type. The words, font and look are in Effect Controls.
let typing = null; // { id, box } while a text is being typed
const measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
const frameDims = () => ASPECTS[S.project.settings.aspect] || [1920, 1080];
function textsAt(t = S.playhead) { // Type tool texts on screen now, the top one first
  const L = layout(), out = [];
  for (const id of overlayTracks(S.project).reverse()) {
    if (S.project.trackState[id]?.hide) continue;
    for (const x of L[id] || []) if (x.clip.type === 'graphic' && x.clip.gfx?.tpl === 'text' && t >= x.start && t < x.end && !x.clip.disabled) out.push(x.clip);
  }
  return out;
}
function textHit(e) { // the text under the mouse (frame px -> project frame px)
  const r = frame.getBoundingClientRect(), [FW, FH] = frameDims(), px = ((e.clientX - r.left) / r.width) * FW, py = ((e.clientY - r.top) / r.height) * FH;
  return { c: textsAt().find((c) => { const b = textLayout(measureCtx, FW, FH, c.gfx); const m = b.px * 0.3; return px >= b.x - m && px <= b.x + b.w + m && py >= b.y - m && py <= b.y + b.h + m; }), fx: px / FW, fy: py / FH };
}
function placeTyping() {
  if (!typing) return;
  const c = findClipAny(typing.id); if (!c) return endTyping(false);
  const [FW, FH] = frameDims(), r = frame.getBoundingClientRect(), k = r.width / FW, g = c.gfx, b = textLayout(measureCtx, FW, FH, { ...g, text: typing.box.value || ' ' });
  Object.assign(typing.box.style, { left: `${b.x * k - 4}px`, top: `${b.y * k}px`, width: `${Math.max(40, b.w * k + 12)}px`, height: `${b.h * k + 4}px`,
    font: b.font.replace(/(\d+(?:\.\d+)?)px/, `${(b.px * k).toFixed(2)}px`), lineHeight: `${b.lh * k}px`, color: g.color || '#fff', textAlign: g.align || 'center',
    letterSpacing: `${((+g.track || 0) * b.px * k) / 100}px`, webkitTextStroke: g.stroke ? `${Math.max(0.5, (+g.strokeW || 6) * b.k * k)}px ${g.strokeColor || '#000'}` : '',
    textShadow: g.shadow ? '0 0 6px rgba(0,0,0,.7)' : '', background: g.bg ? `${g.bgColor || '#000'}${Math.round((g.bgOpacity ?? 0.6) * 255).toString(16).padStart(2, '0')}` : 'transparent' });
}
const findClipAny = (id) => Object.values(S.project.tracks).flat().find((c) => c.id === id);
function startTyping(c, isNew = false) {
  endTyping(true);
  pause();
  const box = document.createElement('textarea');
  box.className = 'type-box'; box.spellcheck = false; box.value = c.gfx.text || '';
  frame.append(box);
  typing = { id: c.id, box, isNew };
  S.sel = new Set([c.id]); emit('select');
  placeTyping(); drawProgram(S.playhead, false);
  box.focus(); box.select();
  box.addEventListener('input', () => { const cl = findClipAny(c.id); if (!cl) return; cl.gfx.text = box.value; placeTyping(); emit('live'); });
  box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); endTyping(true); } });
  // selecting inside the text (drag, double-click a word, triple-click a line) stays in the box: the monitor used to take
  // the double-click as "start typing" again, made a new box and selected ALL the text
  for (const ev of ['pointerdown', 'mousedown', 'click', 'dblclick']) box.addEventListener(ev, (e) => e.stopPropagation());
  box.addEventListener('blur', () => setTimeout(() => { if (typing?.box === box) endTyping(true); }, 0));
}
function endTyping(keep) {
  if (!typing) return;
  const { id, box, isNew } = typing; typing = null; box.remove();
  const c = findClipAny(id);
  if (c && !String(c.gfx.text || '').trim()) { // nothing typed: no empty text left behind
    for (const l of Object.values(S.project.tracks)) { const i = l.indexOf(c); if (i >= 0) l.splice(i, 1); }
    S.sel.clear(); emit('select');
    if (!isNew) commit('Delete empty text');
  } else if (c && keep) commit(isNew ? 'Type tool: new text' : 'Type text', `type:${id}`);
  drawProgram(S.playhead, false);
}
// ▭ ◯ Rectangle / Ellipse tool: drag a box on the picture (Shift: square / circle); a plain click makes a middle-sized one
function drawShape(e) {
  const r = frame.getBoundingClientRect(), kind = S.tool, x0 = e.clientX, y0 = e.clientY, ghost = document.createElement('div');
  ghost.className = `shape-ghost${kind === 'ellipse' ? ' round' : ''}`; frame.append(ghost);
  let box = null;
  const mv = (ev) => {
    let w = ev.clientX - x0, h = ev.clientY - y0;
    if (ev.shiftKey) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
    box = { l: Math.min(x0, x0 + w) - r.left, t: Math.min(y0, y0 + h) - r.top, w: Math.abs(w), h: Math.abs(h) };
    Object.assign(ghost.style, { left: `${box.l}px`, top: `${box.t}px`, width: `${box.w}px`, height: `${box.h}px` });
  };
  const up = () => {
    window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); ghost.remove();
    if (!box || box.w < 4 || box.h < 4) { const s = Math.min(r.width, r.height) * 0.3; box = { l: x0 - r.left - s / 2, t: y0 - r.top - s / 2, w: s, h: s }; }
    addShapeAt(kind, (box.l / r.width) * 100, (box.t / r.height) * 100, (box.w / r.width) * 100, (box.h / r.height) * 100);
    toast(`${kind === 'ellipse' ? 'Ellipse' : 'Rectangle'} added - colour, stroke and rounding in Effect Controls (V: back to the Selection tool)`);
  };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}
function bindTypeTool() {
  // capture: before the drag-to-move of shots, so a text on top of a shot is the one taken
  frame.addEventListener('pointerdown', (e) => {
    if (mode !== 'program' || e.button !== 0 || e.target.closest('.type-box, .maskui .mk-shape, .maskui .mk-h')) return;
    if (S.tool === 'rect' || S.tool === 'ellipse') { e.preventDefault(); e.stopPropagation(); return drawShape(e); }
    const hit = textHit(e);
    if (S.tool === 'type') {
      e.preventDefault(); e.stopPropagation();
      if (hit.c) return startTyping(hit.c);
      return startTyping(addTextAt(hit.fx * 100, hit.fy * 100), true);
    }
    if (!hit.c) return;
    // selection tool on a text: select it and drag it about (its position in % of the frame)
    e.preventDefault(); e.stopPropagation();
    const c = hit.c, r = frame.getBoundingClientRect(), x0 = +c.gfx.x || 50, y0 = +c.gfx.y || 50;
    if (!S.sel.has(c.id)) { S.sel = new Set([c.id]); emit('select'); }
    let moved = false;
    // 📌 a pinned text keeps its pin: the drag changes its margins from that edge instead
    const pin = c.gfx.pin && pinOn(c.gfx) ? String(c.gfx.pin) : '', sx = pin.endsWith('r') ? -1 : 1, sy = pin.startsWith('b') ? -1 : 1, mx0 = +c.gfx.pinMX || 0, my0 = +c.gfx.pinMY || 0;
    const mv = (ev) => {
      const dx = ((ev.clientX - e.clientX) / r.width) * 100, dy = ((ev.clientY - e.clientY) / r.height) * 100;
      if (pin) { c.gfx.pinMX = +clamp(mx0 + sx * dx, -20, 40).toFixed(2); c.gfx.pinMY = +clamp(my0 + sy * dy, -20, 40).toFixed(2); }
      else { c.gfx.x = +clamp(x0 + dx, -20, 120).toFixed(2); c.gfx.y = +clamp(y0 + dy, -20, 120).toFixed(2); }
      moved = true; drawProgram(S.playhead, false);
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (moved) commit('Move text', `move-text:${c.id}`); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }, true);
  frame.addEventListener('dblclick', (e) => { if (e.target.closest('.type-box')) return; const hit = textHit(e); if (hit.c) { e.preventDefault(); startTyping(hit.c); } });
  frame.addEventListener('pointermove', (e) => { if (e.buttons) return; frame.classList.toggle('type-cursor', S.tool === 'type'); frame.classList.toggle('shape-cursor', S.tool === 'rect' || S.tool === 'ellipse'); frame.classList.toggle('over-text', S.tool !== 'type' && !!textHit(e).c); });
  new ResizeObserver(() => placeTyping()).observe(frame);
}
export const editTextClip = (id) => { const c = findClipAny(id); if (c?.gfx?.tpl === 'text') startTyping(c); };

// ✦ ---------------- effects CSS cannot do: drawn into a canvas each frame ----------------
// Mirror (left half + its reflection), Green screen (the key colour made see-through) and the effects with a pix drawing
// (Generate, Magnify, Replicate, the keys, Change Color, Timecode... - effects.js). The shot's own element keeps
// playing but is hidden; the canvas beside it takes its place, size, Motion and filters. Exact: Accurate preview / render.
const pixCanvas = new WeakMap(); // picture element -> its canvas
const hexRgb = (hx) => { const v = parseInt(String(hx || '#00ff00').replace('#', '').padEnd(6, '0').slice(0, 6), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
let pixStage = null; // (a graphics-card canvas the frame is made small on before its pixels are read - see pixFx)
function pixFx(el, c, after = el, rel) {
  const fx = (c.effects || []).filter((e) => e.on !== false && !e.mask?.shape && inWindow(e, rel) && (e.type === 'mirror' || e.type === 'chromakey' || VFX[e.type]?.pix));
  let cv = pixCanvas.get(el);
  if (!fx.length || el.hidden) { if (cv) cv.hidden = true; el.style.visibility = el._gradeHidden ? 'hidden' : ''; return null; }
  if (!cv) { cv = document.createElement('canvas'); cv.className = 'lyr pixfx'; pixCanvas.set(el, cv); }
  if (cv.previousSibling !== after) after.after(cv);
  // the source: the shot, or its exact colour layer when that is showing
  const src = el._gradeHidden && !els.lyGrade.hidden ? els.lyGrade : el;
  const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
  if (!sw || !sh) return cv;
  // 🟩 Green screen and Mirror only: done on the graphics card (keyGpu) - the pixels never come to the processor
  const gpu = fx.every((e) => e.type === 'chromakey' || e.type === 'mirror') && keyGl() !== null;
  const key = !gpu && fx.find((e) => e.type === 'chromakey' || VFX[e.type]?.key || VFX[e.type]?.reads), W = Math.min(key ? 640 : 1280, Math.round((frame?.clientWidth || 640) * Math.min(2, devicePixelRatio || 1))), [FW, FH] = ASPECTS[S.project.settings.aspect] || [16, 9], H = Math.round((W * FH) / FW);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d', { willReadFrequently: !!key });
  // object-fit (contain / cover) and object-position, like the element
  const cover = getComputedStyle(src).objectFit === 'cover', s = cover ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const pos = (src.style.objectPosition || '50% 50%').split(' ').map((p) => (parseFloat(p) || 50) / 100);
  const dw = sw * s, dh = sh * s;
  if (gpu) {
    // (a frame not there yet - just after a jump - keeps the last keyed one up rather than showing the shot unkeyed)
    if (keyGpu(src, W, H, [((W - dw) * pos[0]) / W, ((H - dh) * (pos[1] ?? 0.5)) / H, dw / W, dh / H], fx)) { g.clearRect(0, 0, W, H); g.drawImage(keyGl().canvas, 0, 0); }
    return showPix(cv, src, el);
  }
  g.clearRect(0, 0, W, H);
  if (key) {
    // (a canvas whose pixels are read lives in memory, not on the graphics card: drawing a 4K video straight into it copied
    // the whole camera frame back each time - 20-50 ms a layer, five keyed layers made playback stutter. The frame is made
    // small on the graphics card first, and only that comes across)
    const stg = pixStage || (pixStage = document.createElement('canvas'));
    if (stg.width !== W || stg.height !== H) { stg.width = W; stg.height = H; }
    const sg = stg.getContext('2d');
    sg.clearRect(0, 0, W, H); sg.drawImage(src, (W - dw) * pos[0], (H - dh) * (pos[1] ?? 0.5), dw, dh);
    g.drawImage(stg, 0, 0);
  } else g.drawImage(src, (W - dw) * pos[0], (H - dh) * (pos[1] ?? 0.5), dw, dh);
  for (const e of fx) {
    if (e.type === 'mirror') { g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(cv, 0, 0, W / 2, H, 0, 0, W / 2, H); g.restore(); }
    if (e.type === 'chromakey') {
      const [kr, kg, kb] = hexRgb(e.p?.color), sim = +(e.p?.similarity ?? 0.15), bl = Math.max(0.001, +(e.p?.blend ?? 0.05));
      const im = g.getImageData(0, 0, W, H), d = im.data;
      for (let i = 0; i < d.length; i += 4) {
      // (squared distances: the square root only for the few pixels on the soft edge - five keyed layers a frame)
      const in2 = (sim * 441.7) ** 2, out2 = ((sim + bl) * 441.7) ** 2;
        const r = d[i] - kr, gg = d[i + 1] - kg, b = d[i + 2] - kb, q = r * r + gg * gg + b * b;
        if (q >= out2) continue;
        if (q < in2) d[i + 3] = 0; else d[i + 3] = Math.round(d[i + 3] * ((Math.sqrt(q) / 441.7 - sim) / bl));
      }
      g.putImageData(im, 0, 0);
    } else if (e.type !== 'mirror') VFX[e.type].pix(g, W, H, e.p || {}, { cv, rel, fps: S.project.settings.fps || 30, c, name: S.mediaById[c.mediaId]?.name });
  }
  cv.hidden = false;
  return showPix(cv, src, el);
}
function showPix(cv, src, el) {
  for (const k of ['transform', 'opacity', 'clipPath', 'maskImage', 'webkitMaskImage', 'maskSize', 'webkitMaskSize', 'mixBlendMode']) cv.style[k] = src.style[k] || el.style[k];
  cv.style.filter = src === el ? el.style.filter : src.style.filter;
  src.style.visibility = 'hidden';
  return cv;
}
// 🖥 a transition drawn on the two V1 pictures: the moves on each, and the shape on whichever lies on top - the incoming
// 🟩 Green screen (+ Mirror) on the graphics card: one shared WebGL canvas for every keyed layer (a context each would pass
// the browser's ~16), whose result each layer copies into its own canvas - card to card. Same maths as the canvas version:
// distance to the key colour (0-1 of the RGB cube's diagonal) under Similarity -> clear, within Blend -> partly clear.
// null: no WebGL here - the canvas version is used.
let keyGlState;
const KEY_N = 4;
function keyGl() {
  if (keyGlState !== undefined) return keyGlState;
  keyGlState = null;
  const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 a;varying vec2 u;void main(){u=vec2(a.x*.5+.5,.5-a.y*.5);gl_Position=vec4(a,0.,1.);}'));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, `precision mediump float;varying vec2 u;uniform sampler2D t;uniform vec4 r;uniform float m;uniform int n;
uniform vec3 kc[${KEY_N}];uniform vec2 kp[${KEY_N}];
void main(){vec2 p=u;if(m>.5&&p.x>.5)p.x=1.-p.x;vec2 q=(p-r.xy)/r.zw;
if(q.x<0.||q.y<0.||q.x>1.||q.y>1.){gl_FragColor=vec4(0.);return;}
vec4 c=texture2D(t,q);float al=c.a;
for(int i=0;i<${KEY_N};i++){if(i>=n)break;float d=distance(c.rgb,kc[i])/1.7320508;
if(d<kp[i].x)al=0.;else if(d<kp[i].x+kp[i].y)al*=(d-kp[i].x)/kp[i].y;}
gl_FragColor=vec4(c.rgb,al);}`));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
  gl.useProgram(p);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(p, 'a'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const U = (k) => gl.getUniformLocation(p, k);
  keyGlState = { canvas, gl, r: U('r'), m: U('m'), n: U('n'), kc: U('kc'), kp: U('kp') };
  canvas.addEventListener('webglcontextlost', () => { keyGlState = null; }); // (the canvas version from then on)
  return keyGlState;
}
// rect: where the picture lies in the layer [x, y, w, h], 0-1 of it. false when the frame could not be taken (not loaded yet)
function keyGpu(src, W, H, rect, fx) {
  const k = keyGl(), gl = k?.gl;
  if (!gl || (src.tagName === 'VIDEO' && src.readyState < 2)) return false;
  if (k.canvas.width !== W || k.canvas.height !== H) { k.canvas.width = W; k.canvas.height = H; }
  gl.viewport(0, 0, W, H);
  try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); } catch { return false; }
  const keys = fx.filter((e) => e.type === 'chromakey').slice(0, KEY_N), kc = new Float32Array(KEY_N * 3), kp = new Float32Array(KEY_N * 2);
  keys.forEach((e, i) => { hexRgb(e.p?.color).forEach((v, j) => { kc[i * 3 + j] = v / 255; }); kp[i * 2] = +(e.p?.similarity ?? 0.15); kp[i * 2 + 1] = Math.max(0.001, +(e.p?.blend ?? 0.05)); });
  gl.uniform4fv(k.r, rect); gl.uniform1f(k.m, fx.some((e) => e.type === 'mirror') ? 1 : 0); gl.uniform1i(k.n, keys.length);
  gl.uniform3fv(k.kc, kc); gl.uniform2fv(k.kp, kp);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return true;
}
// shot seen through the shape, or the outgoing one seen around it (an even-odd polygon: the frame with the shape cut out)
function trDraw(tr, pe, ce) {
  const curTop = !!(pe.compareDocumentPosition(ce) & Node.DOCUMENT_POSITION_FOLLOWING);
  const local = (pts, part) => pts.map(([x, y]) => [x - (part?.tx || 0), y - (part?.ty || 0)]);
  const clip = tr.show && (curTop ? polyCss(local(tr.show, tr.cur)) : polyCss([[0, 0], [100, 0], [100, 100], [0, 100], [0, 0], ...local(tr.show, tr.prev), local(tr.show, tr.prev)[0], [0, 0]], true));
  const style = (el, part, cl, grade) => {
    const tf = part && (part.tx || part.ty || part.sx !== undefined) ? `translate(${part.tx || 0}%, ${part.ty || 0}%)${part.sx !== undefined ? ` scaleX(${Math.max(0, part.sx).toFixed(4)})` : ''} ` : '';
    // the element, its effects canvas and (when it shows this shot) the exact colour layer
    for (const e of [el, pixCanvas.get(el), grade ? els.lyGrade : null]) {
      if (!e || (e !== el && e.hidden)) continue;
      if (tf) e.style.transform = tf + (e.style.transform || '');
      if (cl) e.style.clipPath = cl;
      if (part?.op !== undefined) e.style.opacity = String((e.style.opacity === '' ? 1 : +e.style.opacity) * part.op);
    }
  };
  style(pe, tr.prev, curTop ? null : clip, pe._gradeHidden && !ce._gradeHidden);
  style(ce, tr.cur, curTop ? clip : null, ce._gradeHidden);
}
// a clip's own fade from / to black (one-sided Dip to Black), as a factor on its opacity
const fadeK = (c, rel, len) => Math.min(+c.fadeIn > 0 ? clamp(rel / c.fadeIn, 0, 1) : 1, +c.fadeOut > 0 ? clamp((len - rel) / c.fadeOut, 0, 1) : 1);

// ◯ ---------------- masks (public/js/shapemask.js) ----------------
// A mask as a small picture for CSS mask-image (kept per mask: drawing one costs a few ms)
const maskUrls = new Map();
function maskUrl(m) {
  const key = maskKey(m);
  let u = maskUrls.get(key);
  if (u) return u;
  const [FW, FH] = ASPECTS[S.project.settings.aspect] || [1920, 1080], w = 320, hh = Math.max(2, Math.round((w * FH) / FW));
  const a = maskAlpha(m, w, hh), cv = document.createElement('canvas');
  cv.width = w; cv.height = hh;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(w, hh);
  for (let i = 0; i < a.length; i++) img.data[i * 4 + 3] = a[i];
  ctx.putImageData(img, 0, 0);
  u = `url(${cv.toDataURL()})`;
  if (maskUrls.size > 60) maskUrls.clear();
  maskUrls.set(key, u);
  return u;
}
// ◐ the clip's Opacity mask on its picture element (it moves with the element's Motion transform)
function setMask(el, m) {
  const u = m?.shape ? maskUrl(m) : '';
  if (el._mask === u) return;
  el._mask = u;
  el.style.maskImage = el.style.webkitMaskImage = u; el.style.maskSize = el.style.webkitMaskSize = u ? '100% 100%' : '';
}
// effects with a mask on the V1 shot: the effect's look over just that part of the picture (exact in Accurate preview)
function drawFxMasks(x, t) {
  const el = els.lyFxm, c = x?.clip;
  const list = c && !c.disabled && (c.type === 'video' || c.type === 'image') ? maskedEffectsCss(c, (frame?.clientWidth || 640) / ((ASPECTS[S.project.settings.aspect] || [1920])[0])) : [];
  el.hidden = !list.length;
  if (!list.length) { el.innerHTML = ''; return; }
  const tf = look(c, t - x.start).transform;
  el.innerHTML = list.map((e) => { const u = maskUrl(e.mask); return `<i style="transform:${tf};backdrop-filter:${e.filter};-webkit-backdrop-filter:${e.filter};mask-image:${u};-webkit-mask-image:${u};mask-size:100% 100%;-webkit-mask-size:100% 100%"></i>`; }).join('');
}
// ✎ editing a mask on the monitor: S.maskEdit = { clipId, effId } (effId null: the clip's Opacity mask). The shape is
// drawn where it is seen (after Motion); drag inside to move it, the handles to size it.
function maskTarget() {
  const me = S.maskEdit; if (!me || mode !== 'program' || !S.project) return null;
  for (const list of Object.values(layout())) {
    const x = list.find((p) => p.clip.id === me.clipId); if (!x) continue;
    const c = x.clip, m = me.effId ? c.effects?.find((e) => e.id === me.effId)?.mask : c.omask;
    if (!m?.shape) return null;
    const rel = clamp(S.playhead - x.start, 0, x.end - x.start);
    const tf = { zoom: propAt(c, 'transform.zoom', rel), x: propAt(c, 'transform.x', rel), y: propAt(c, 'transform.y', rel) };
    return { c, m, tf, set: (nm) => { if (me.effId) c.effects.find((e) => e.id === me.effId).mask = nm; else c.omask = nm; } };
  }
  return null;
}
function drawMaskUI() {
  const el = els.lyMaskUi; if (!el) return;
  const mt = maskTarget();
  el.hidden = !mt;
  if (!mt) return;
  const v = movedMask(mt.m, mt.tf), pc = (n) => `${(n * 100).toFixed(3)}%`;
  if (!el.firstChild) {
    el.innerHTML = `<div class="mk-shape" data-mk="move"></div>${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((k) => `<b class="mk-h" data-mk="${k}"></b>`).join('')}<span class="mk-tip">Drag to move · handles to size · Esc to finish</span>`;
    el.addEventListener('pointerdown', maskDrag);
  }
  const sh = el.querySelector('.mk-shape');
  sh.style.cssText = `left:${pc(v.x - v.w / 2)};top:${pc(v.y - v.h / 2)};width:${pc(v.w)};height:${pc(v.h)}`;
  sh.classList.toggle('ell', mt.m.shape !== 'rect'); sh.classList.toggle('inv', !!mt.m.invert);
  const at = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
  el.querySelectorAll('.mk-h').forEach((b) => { const [fx, fy] = at[b.dataset.mk]; b.style.left = pc(v.x - v.w / 2 + v.w * fx); b.style.top = pc(v.y - v.h / 2 + v.h * fy); });
}
function maskDrag(e) {
  const kind = e.target.closest('[data-mk]')?.dataset.mk, mt = maskTarget();
  if (!kind || !mt) return;
  e.preventDefault(); e.stopPropagation(); pause();
  const r = frame.getBoundingClientRect(), v0 = movedMask(mt.m, mt.tf);
  let moved = false;
  const mv = (ev) => {
    const dx = (ev.clientX - e.clientX) / r.width, dy = (ev.clientY - e.clientY) / r.height;
    let { x, y, w, h } = v0;
    if (kind === 'move') { x += dx; y += dy; } else {
      let l = v0.x - v0.w / 2, rt = v0.x + v0.w / 2, tp = v0.y - v0.h / 2, bt = v0.y + v0.h / 2;
      if (kind.includes('w')) l = Math.min(rt - 0.01, l + dx);
      if (kind.includes('e')) rt = Math.max(l + 0.01, rt + dx);
      if (kind.includes('n')) tp = Math.min(bt - 0.01, tp + dy);
      if (kind.includes('s')) bt = Math.max(tp + 0.01, bt + dy);
      x = (l + rt) / 2; w = rt - l; y = (tp + bt) / 2; h = bt - tp;
    }
    const cur = maskTarget(); if (!cur) return;
    const back = unmovedMask({ ...cur.m, x, y, w, h }, cur.tf), r4 = (n) => +n.toFixed(4);
    cur.set({ ...cur.m, x: r4(back.x), y: r4(back.y), w: r4(back.w), h: r4(back.h) });
    moved = true; drawProgram(S.playhead, false); emit('maskMoved');
  };
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (moved) commit('Move mask', `mask:${S.maskEdit?.clipId}`); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}
on('maskEdit', () => { if (mode === 'program' && !playing) drawProgram(S.playhead, false); else drawMaskUI(); });
on('select', () => { if (S.maskEdit && !S.sel.has(S.maskEdit.clipId)) { S.maskEdit = null; drawMaskUI(); } });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.maskEdit) { S.maskEdit = null; drawMaskUI(); emit('maskEdit'); } });

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
// ▱ Click the four corners of a flat surface on the viewer (planar tracking): resolves [TL, TR, BL, BR] as { x, y }
// fractions of the frame, or null (Esc). Backspace takes the last corner back.
export function pickQuad(hint = 'Click the 4 corners of the surface (wall, banner, screen) · Backspace undoes · Esc cancels') {
  return new Promise((done) => {
    pause();
    const ov = document.createElement('div'); ov.className = 'lyr boxpick quadpick';
    ov.innerHTML = `<span>${esc(hint)}</span><svg viewBox="0 0 1 1" preserveAspectRatio="none"><polygon fill="rgba(80,160,255,.25)" stroke="#4aa3ff" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
    frame.append(ov);
    const pts = [], poly = ov.querySelector('polygon');
    const draw = () => {
      ov.querySelectorAll('i').forEach((d) => d.remove());
      for (const p of pts) { const d = document.createElement('i'); d.style.left = `${p.x * 100}%`; d.style.top = `${p.y * 100}%`; ov.append(d); }
      const q = pts.length === 4 ? orderQuad(pts) : pts, o = q.length === 4 ? [q[0], q[1], q[3], q[2]] : q;
      poly.setAttribute('points', o.map((p) => `${p.x},${p.y}`).join(' '));
    };
    const fin = (v) => { ov.remove(); window.removeEventListener('keydown', key, true); done(v); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); fin(null); } else if (e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); pts.pop(); draw(); } };
    window.addEventListener('keydown', key, true);
    ov.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const r = frame.getBoundingClientRect();
      pts.push({ x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) }); draw();
      if (pts.length === 4) setTimeout(() => fin(orderQuad(pts)), 250);
    });
  });
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
// 🗂 every shown caption track, stacked as in the render (capStack: track 2 above track 1 at the same position)
function drawCaption(t) {
  const el = els.lyCap, shown = capTracks(S.project.captions).filter((x) => x.on && x.cues?.length);
  const ats = shown.map((x) => [x, captionAt(x, t)]).filter(([, at]) => at);
  el.hidden = !ats.length;
  if (!ats.length) return;
  const [FW, FH] = ASPECTS[S.project.settings.aspect] || [1920, 1080], stack = capStack(shown, FW, FH);
  el.className = 'lyr capl';
  el.innerHTML = ats.map(([x, at]) => {
    const st = x.style || {}, pos = st.pos || 'bottom', lift = ((stack.get(x) || 0) / FH) * 100;
    const px = ((st.size || 54) * Math.min(FW, FH)) / 1080 / FH * 100; // % of the frame height, as in the render
    const place = pos === 'top' ? `top:${(8 + lift).toFixed(2)}cqh` : pos === 'middle' ? `top:${(50 - lift).toFixed(2)}cqh;transform:translateY(-50%)` : `bottom:${(8 + lift).toFixed(2)}cqh`;
    return `<div style="position:absolute;left:7%;right:7%;display:flex;justify-content:center;${place}"><span style="font-family:'${esc(st.font || 'Arial')}','Nirmala UI',sans-serif;font-size:${px.toFixed(2)}cqh;color:${esc(st.color || '#fff')};${st.box ? `background:${esc(st.box)};padding:.12em .4em;` : `-webkit-text-stroke:${((st.outline ?? 3) / 40).toFixed(2)}em #000;paint-order:stroke fill;`}">${at.words.map((w) => (w.active ? `<b style="color:${esc(st.hl || '#ffd400')};display:inline-block;transform:scale(${(1 + 0.18 * w.pop).toFixed(3)})">${esc(w.w)}</b>` : esc(w.w))).join(' ')}</span></div>`;
  }).join('');
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
        if (typing?.id === c.id) ctx.clearRect(0, 0, FW, FH); // (being typed: the typing box shows it)
        else drawGraphic(ctx, FW, FH, c.gfx || {}, rel, x.end - x.start);
        el.style.opacity = String(fadeK(c, rel, x.end - x.start));
        el.style.mixBlendMode = c.blend ? CSS_BLEND[c.blend] || c.blend : ''; // (🎭 text / shapes / templates blend as well)
        live.add(c.id); order.push(el); el.hidden = false; el.style.pointerEvents = 'none';
        continue;
      }
      const m = S.mediaById[c.mediaId];
      if (c.type !== 'title' && !m) continue; // (its file is not loaded yet / was removed: skip it, never stop the viewer)
      if (c.type === 'video' && !canPlay(m)) continue;
      const sl = ovSlot(c), el = sl.el;
      live.add(c.id); order.push(el);
      el.hidden = false;
      const bfx = c.blend ? null : blendOf(c); // (🎨 the Blend effect: its mode, or Crossfade as opacity)
      el.style.mixBlendMode = c.blend ? CSS_BLEND[c.blend] || c.blend : bfx && bfx.mode !== 'crossfade' ? bfx.css : '';
      if (c.type === 'title') { textStyle(el, c, null, t, x.start, x.end, true); continue; }
      const lk = look(c, rel);
      fitStyle(el, c, rel);
      el.style.opacity = propAt(c, 'opacity', rel) * fadeK(c, rel, x.end - x.start) * (bfx?.mode === 'crossfade' ? bfx.amount : 1); el.style.transform = lk.transform; el.style.filter = lk.filter; el.style.clipPath = lk.clip || ''; setMask(el, c.omask);
      // ▱ stuck onto a tracked surface: the whole picture is bent onto the surface's four corners (as the render does)
      const pq = c.pin?.keys?.length && (c.type === 'image' || c.type === 'video') ? pinAt(c.pin.keys, rel) : null;
      if (pq) { const fw = el.clientWidth || frame.clientWidth, fh = el.clientHeight || frame.clientHeight; el.style.objectFit = 'fill'; el.style.transformOrigin = '0 0'; el.style.clipPath = ''; el.style.transform = quadMatrix(fw, fh, pq.map((v, j) => v * (j % 2 ? fh : fw))); }
      else el.style.transformOrigin = '';
      if (c.type === 'image') { if (el.dataset.src !== m.urls.play) { el.src = m.urls.play; el.dataset.src = m.urls.play; } }
      else syncVideo(el, m, c, x.start, t, isPlay, c.volume ?? 0, id);
      const pc = pixFx(el, c, el, rel); if (pc) order.push(pc); // (mirror / green screen: its canvas stacks right above it)
      below.push(pc || el);
    }
  }
  // stacking order = track order
  order.forEach((el, i) => { if (stack.children[i] !== el) stack.insertBefore(el, stack.children[i] || null); });
  for (const [id, sl] of ovSlots) if (!live.has(id)) { sl.el.hidden = true; const pc = pixCanvas.get(sl.el); if (pc) pc.hidden = true; if (sl.el.tagName === 'VIDEO') sl.el.pause(); if (!findAny(id)) { sl.el.remove(); pc?.remove(); ovSlots.delete(id); } }
}

// 🛡 a clip the viewer cannot draw (missing file, odd data) is skipped - the editor keeps working; the error is logged once
let drawErr = '';
function drawProgram(t, isPlay) {
  try { drawProgramNow(t, isPlay); drawRendered(t, isPlay); }
  catch (e) { const k = String(e?.stack || e); if (k !== drawErr) { drawErr = k; reportError('Viewer (a clip could not be drawn)', e); } }
}
// 🟩 the rendered (Accurate) preview, like Premiere's green render bar: while the edit is as it was rendered, the monitor
// shows that exact video at the playhead (blends, effects, colour as the export makes them) over the live layers; any
// change to the edit and it is the live view again. (The sound stays the live mix.)
let renderedOk = false;
on('change', () => { const R = S.rendered; renderedOk = !!(R?.url && S.project && R.hash === seqHash(S.project)); });
function drawRendered(t, isPlay) {
  const v = els.lyRend, R = S.rendered; if (!v) return;
  if (!(renderedOk && mode === 'program' && t >= R.a && t < R.b - 0.02)) { if (!v.hidden) { v.hidden = true; v.pause(); } return; }
  if (v.dataset.src !== R.url) { v.src = R.url; v.dataset.src = R.url; }
  v.hidden = false;
  const want = t - R.a;
  if (isPlay) { if (v.paused) v.play().catch(() => {}); if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want; }
  else { if (!v.paused) v.pause(); if (Math.abs(v.currentTime - want) > 0.5 / (S.project.settings.fps || 30)) v.currentTime = want; }
}
function drawProgramNow(t, isPlay) {
  if (!S.project || mode !== 'program') return;
  applyMix(); autoMix(t); // (🎚 track volume keyframes at this frame)
  const L = layout(), ts = S.project.trackState;
  $('#vwTC').textContent = fmtTime(t, S.project.settings); // (⚙ Display format)
  { const lkEl = els.lyLook || (els.lyLook = $('#lyLook', root)); if (lkEl?.dataset.grain) lkEl.style.backgroundPosition = [...Array(+lkEl.dataset.grain).fill('0 0'), grainShift()].join(', '); }
  drawRuler(t); // (redrawn only when the edit's length or the monitor's width changed)
  $('#vwDur').textContent = fmtTC(duration(), S.project.settings.fps);
  els.vwMsg.hidden = true; els.vwStab.hidden = true;
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
    opacity = String(+opacity * propAt(c, 'opacity', t - x.start) * fadeK(c, t - x.start, x.end - x.start)); // its own (keyframed) opacity and fades, over black
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
      img.style.transform = `${lk.transform} scale(${z})`; img.style.filter = lk.filter; img.style.opacity = opacity; img.style.clipPath = lk.clip || ''; img._fxFilter = lk.fxFilter; setMask(img, c.omask);
      gradeLayer(img, c, opacity);
      pixFx(img, c, els.lyGrade.hidden ? img : els.lyGrade, t - x.start);
      return img;
    }
    if (!canPlay(m)) { showMsg(proxyMsg(m), m.urls.thumb); return; }
    const v = slotFor(x); used.add(v);
    v.hidden = false; v.style.opacity = opacity;
    const fm = fitStyle(v, c, t - x.start);
    v.style.transform = lk.transform; v.style.filter = lk.filter; v.style.clipPath = lk.clip || ''; v._fxFilter = lk.fxFilter; setMask(v, c.omask);
    if (fm === 'blur' && m.urls.thumb && !blurSet) { els.lyBlur.hidden = false; els.lyBlur.style.backgroundImage = `url('${m.urls.thumb}')`; blurSet = true; }
    const pa = partnerOf(c);
    if (pa && !pa.a.disabled) {
      carried.add(pa.a.id);
      const rel = t - x.start, fi = pa.a.fadeIn || 0, fo = pa.a.fadeOut || 0, fade = Math.min(fi ? clamp(rel / fi, 0, 1) : 1, fo ? clamp((x.end - t) / fo, 0, 1) : 1);
      syncVideo(v, m, c, x.start, t, isPlay, pa.a.mute || !trackAudible(pa.id) ? 0 : propAt(pa.a, 'volume', rel) * fade, pa.id);
    } else syncVideo(v, m, c, x.start, t, isPlay, v1vol(c, t - x.start));
    gradeLayer(v, c, opacity);
    pixFx(v, c, els.lyGrade.hidden ? v : els.lyGrade, t - x.start);
    return v;
  };
  els.lyCard.hidden = true; els.lyImg.hidden = true; els.lyBlur.hidden = true; els.lyGrade.hidden = true;
  // 🖥 a transition's live look (fx.js trLive): wipes, irises and slides are drawn; the rest is a dissolve
  const trQ = prev && cur ? clamp((t - cur.start) / Math.max(0.01, cur.overlap), 0, 1) : 1, [aw, ah] = ASPECTS[S.project.settings.aspect] || [16, 9];
  const tr = prev && cur ? trLive(cur.clip.transitionIn?.type, trQ, aw / ah) : null;
  const pe = prev ? drawV1(prev, 1) : null, ce = cur ? drawV1(cur, prev && !tr ? String(trQ) : 1) : null;
  if (tr && pe && ce && pe !== ce) trDraw(tr, pe, ce);
  // the shot's overlay effects (vignette), over its picture and moving with it
  { const lk2 = cur && !cur.clip.disabled && cur.clip.type !== 'title' ? look(cur.clip, t - cur.start) : null; const lay = lk2 ? [lk2.overlay, lk2.grain].filter(Boolean) : []; els.lyFxo.hidden = !lay.length;
    if (lay.length) { els.lyFxo.style.background = lay.join(', '); els.lyFxo.style.transform = lk2.transform; els.lyFxo.style.backgroundPosition = lay.map((l) => (l === lk2.grain ? grainShift() : '0 0')).join(', '); } }
  // the shot that just came is still loading (a jump to a new place in the file, over the internet): the last frame of
  // the one before stays up under it instead of black, until the new one has a picture
  const loading = [...used].some((s) => s.readyState < 2 || s.seeking);
  for (const s of slots) if (!used.has(s)) { s.pause(); if (!(loading && !s.hidden && s.readyState >= 2)) s.hidden = true; }
  for (const s of [...slots, els.lyImg]) if (s.hidden && pixCanvas.get(s)) pixCanvas.get(s).hidden = true;
  if (!cur && !act.length && L.V1.length && t < duration()) { /* gap after V1: black */ }
  // V1 clip text (lower third)
  const tx = cur?.clip;
  if (tx?.text && tx.type !== 'title' && (!tx.textDuration || t - cur.start < tx.textDuration)) { els.lyText.hidden = false; textStyle(els.lyText, tx, null, t, cur.start, cur.end, false); }
  else els.lyText.hidden = true;
  // preload the next V1 video so cuts don't stall
  const nx = L.V1.find((x) => x.start > t && x.start - t < 2 && x.clip.type === 'video');
  if (nx && isPlay) {
    const m = S.mediaById[nx.clip.mediaId], free = slots.find((s) => !used.has(s));
    if (canPlay(m) && free && free.dataset.cid !== nx.clip.id) {
      const st = stabState(nx.clip, m), stab = st?.status === 'ready' ? st : null, url = stab ? stab.url : playUrl(m); // (🎥 its stabilised copy)
      free.dataset.cid = nx.clip.id; if (free.dataset.src !== url) { free.src = url; free.dataset.src = url; } free.currentTime = (nx.clip.in || 0) - (stab ? stab.a : 0);
    }
  }

  drawMasks(cur, t);
  drawFxMasks(cur, t);
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
      // (🎚 Constant Gain / Constant Power / Exponential Fade: the fade's shape)
      const fade = Math.min(fi ? fadeShape(rel / fi, c.fadeInCurve) : 1, fo ? fadeShape(rem / fo, c.fadeOutCurve) : 1);
      setVol(a, propAt(c, 'volume', rel) * fade, id, c);
      a.playbackRate = clamp(sp, 0.25, 4);
      if (a.readyState >= 1) {
        // (a clip's own linked sound keeps lip sync tighter)
        if (isPlay) { if (Math.abs(a.currentTime - target) > (c.link ? 0.12 : 0.3)) a.currentTime = target; if (a.paused) a.play().catch(() => {}); }
        else { a.pause(); if (Math.abs(a.currentTime - target) > 0.05) a.currentTime = target; }
      }
    }
  }
  for (const [id, a] of audioPool) if (!live.has(id)) { a.pause(); if (!S.project || !findAny(id)) { a.src = ''; audioPool.delete(id); } }
  drawMaskUI();
}
const findAny = (id) => Object.values(S.project.tracks).some((l) => l.some((c) => c.id === id));

// ---------------- live audio mix (Web Audio) ----------------
// media element -> own gain (clip volume, may exceed 1) -> track FX chain -> track fader -> meter -> master.
// Created on the first Play (browsers allow audio only after a user gesture). Noise reduction, de-essing and ducking are render-only.
let actx = null, master = null, masterAn = null, masterLR = null;
const chains = {}, fxSig = {};
function ensureAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return actx; }
  try { actx = new AudioContext(); } catch { return null; }
  audioOut(actx); // 🎧 on the speakers / headphones chosen in View › Sound output
  master = actx.createGain(); masterAn = actx.createAnalyser(); masterAn.fftSize = 2048;
  master.connect(masterAn); masterAn.connect(actx.destination);
  // 🎚 left / right for the master meter (timeline's Audio Meters): a splitter beside the output, nothing in the way of the sound
  const split = actx.createChannelSplitter(2); masterLR = [actx.createAnalyser(), actx.createAnalyser()];
  const up = actx.createGain(); up.channelCount = 2; up.channelCountMode = 'explicit'; up.channelInterpretation = 'speakers'; // (a mono mix shows on both)
  masterAn.connect(up); up.connect(split); masterLR.forEach((an, i) => { an.fftSize = 2048; split.connect(an, i); });
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
// 🔊 a clip's own audio effects (clip.aeffects) between its element and its gain - rebuilt only when they change
function clipAudio(el, c) {
  if (!actx || !el._src) return;
  const sig = c?.aeffects?.length ? JSON.stringify(c.aeffects) : '';
  if (el._fxSig === sig) return;
  el._fxSig = sig;
  try { el._src.disconnect(); } catch {}
  try { el._fx?.output.disconnect(); } catch {}
  el._fx = sig ? buildClipAudioChain(actx, c.aeffects) : null;
  if (el._fx) { el._src.connect(el._fx.input); el._fx.output.connect(el._g); } else el._src.connect(el._g);
}
function setVol(el, vol, track, c = null) {
  if (actx) { route(el, track); clipAudio(el, c); el.muted = false; el._g.gain.setTargetAtTime(Math.max(0, vol), actx.currentTime, 0.015); return; }
  const v = vol * (trackAudible(track) ? S.project.trackState?.[track]?.volume ?? 1 : 0);
  el.volume = clamp(v, 0, 1); el.muted = v <= 0;
}
// 🎚 the track fader where the track has volume keyframes: its value at the playhead (x the fader), every frame
const trackGain = (st, t) => (st.volume ?? 1) * (st.volKeys?.length ? evalKeys(st.volKeys, t) : 1);
function autoMix(t) {
  if (!actx || !S.project) return;
  for (const [id, st] of Object.entries(S.project.trackState || {})) if (st?.volKeys?.length && chains[id] && trackAudible(id)) chains[id].fader.gain.setTargetAtTime(trackGain(st, t), actx.currentTime, 0.01);
}
export function applyMix() {
  if (!actx || !S.project) return;
  for (const id of Object.keys(chains)) {
    const st = S.project.trackState?.[id] || {};
    chains[id].fader.gain.setTargetAtTime(trackAudible(id) ? trackGain(st, S.playhead) : 0, actx.currentTime, 0.02);
    const sig = JSON.stringify(st.fx || {});
    if (fxSig[id] !== sig) { chains[id].fx.set(st.fx || {}); fxSig[id] = sig; }
    // 🎛 the track's effect slots (trackState.aeffects) between its clean-up and its fader - rebuilt when they change
    const ss = st.aeffects?.length ? JSON.stringify(st.aeffects) : '', ch = chains[id];
    if (ch.slotSig !== ss) {
      ch.slotSig = ss;
      try { ch.fx.output.disconnect(); } catch {}
      try { ch.slots?.output.disconnect(); } catch {}
      ch.slots = ss ? buildClipAudioChain(actx, st.aeffects) : null;
      if (ch.slots) { ch.fx.output.connect(ch.slots.input); ch.slots.output.connect(ch.fader); } else ch.fx.output.connect(ch.fader);
    }
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
// the master's left and right channel ({ peak, rms } in dBFS each), null until the sound has started
export const masterLevels = () => (masterLR ? masterLR.map(measureAn) : null);
export const isPlayingProgram = () => playing;
