// Color page (Resolve-style): graded viewer with before/after split, scopes, clip strip,
// Lift/Gamma/Gain/Offset wheels, RGB + hue curves (Lumetri), primaries, LUTs, auto colour, shot match, copy/paste/apply-to-all.
import { S, on, emit, commit, layout } from './store.js';
import { api, enc, watchJob, upload } from './api.js';
import { fmt, fmtTC } from './model.js';
import { $, $$, h, esc, toast, clamp } from './ui.js';
import { Grader } from './colorgl.js';
import { drawScope } from './scopes.js';
import { wheelToRGB, rgbToWheel, parseCube, isNeutral } from './colormath.js';
import { mountCurves } from './curvesui.js';
import { mountLumetri } from './lumetri.js';
import { activeGrade } from './colormath.js';

let wpane = 'wheels', curvesUI = [], lm = null, lookCube = null, picking = false;
let root, grader, video, img, scopeType = 'waveform', clipId = null, playing = false, raf = 0, lastScope = 0, busy = false;
const lutCache = new Map();
const WHEELS = [
  { k: 'lift', label: 'Lift', amt: 0.25, min: -0.5, max: 0.5, step: 0.005, hint: 'shadows' },
  { k: 'gamma', label: 'Gamma', amt: 0.5, min: -0.8, max: 0.8, step: 0.01, hint: 'midtones' },
  { k: 'gain', label: 'Gain', amt: 0.5, min: -1, max: 2, step: 0.01, hint: 'highlights' },
  { k: 'offset', label: 'Offset', amt: 0.25, min: -1, max: 1, step: 0.005, hint: 'everything' },
];
const PRIM = [
  { k: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.01, def: 0, unit: 'stops' },
  { k: 'temp', label: 'Temperature', min: -1, max: 1, step: 0.01, def: 0, unit: 'cool ↔ warm' },
  { k: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01, def: 0, unit: 'green ↔ magenta' },
  { k: 'contrast', label: 'Contrast', min: 0.3, max: 2.5, step: 0.01, def: 1 },
  { k: 'pivot', label: 'Pivot', min: 0.1, max: 0.9, step: 0.005, def: 0.435 },
  { k: 'saturation', label: 'Saturation', min: 0, max: 2.5, step: 0.01, def: 1 },
];

export function mountColor(el) {
  root = el;
  el.innerHTML = `<div class="cp">
    <div class="panel cp-view">
      <div class="cp-head"><b id="cpName">No clip</b><span class="muted" id="cpInfo"></span><span class="grow"></span>
        <button class="small tog" data-ca="split" title="Before / after split">Split</button>
        <button class="small tog" data-ca="bypass" title="Show without grade (hold B)">Bypass</button></div>
      <div class="cp-stage" id="cpStage"><canvas id="cpCanvas"></canvas><div class="cp-msg" id="cpMsg" hidden></div>
        <input type="range" class="cp-splitter" id="cpSplit" min="0.02" max="0.98" step="0.001" value="0.5" hidden aria-label="Split position"></div>
      <div class="cp-scrub"><button class="icon-btn" data-ca="play" aria-label="Play">▶</button><input type="range" id="cpPos" min="0" max="1" step="0.001" value="0.3" aria-label="Position in clip"><span class="tc" id="cpTC"></span></div>
    </div>
    <div class="panel cp-scopes">
      <div class="cp-head"><div class="segbtns">${[['waveform', 'Waveform'], ['parade', 'Parade'], ['vector', 'Vector'], ['histogram', 'Histogram']].map(([k, l]) => `<button data-scope="${k}">${l}</button>`).join('')}</div></div>
      <div class="cp-scopewrap"><canvas id="cpScope" width="520" height="300"></canvas></div>
    </div>
    <div class="panel cp-strip" id="cpStrip"></div>
    <div class="panel cp-tools">
      <h3>Auto colour</h3>
      <button class="accent wide" data-ca="auto">✨ Auto colour this clip</button>
      <button class="wide" data-ca="autoAll">✨ Auto colour all clips</button>
      <label class="fld"><span>Strength <i id="cpStrV">80%</i></span><input type="range" id="cpStr" min="0.2" max="1" step="0.05" value="0.8"></label>
      <label class="chk"><input type="checkbox" id="cpLog" checked> Detect LOG footage and add a LUT</label>
      <h3>LUT</h3>
      <div class="row-in"><select id="cpLut" aria-label="LUT"></select><button class="small" data-ca="lutUp" title="Import a .cube LUT">+</button></div>
      <input type="file" id="cpLutFile" accept=".cube" hidden>
      <h3>Shot match</h3>
      <div class="row-in"><select id="cpRef" aria-label="Reference clip"></select><button class="small" data-ca="match">Match</button></div>
      <h3>Grade</h3>
      <div class="btn-grid"><button data-ca="copy" title="Ctrl+Shift+C">Copy</button><button data-ca="paste" title="Ctrl+Shift+V">Paste</button>
        <button data-ca="all">Apply to all</button><button data-ca="reset" class="danger">Reset</button></div>
    </div>
    <div class="panel cp-wheels" id="cpWheels"></div>
    <div class="panel cp-prim" id="cpPrim"></div>
  </div>`;
  video = h('<video muted playsinline preload="auto" crossorigin="anonymous" class="cp-src"></video>');
  img = h('<img class="cp-src" alt="">');
  el.append(video, img);
  try { grader = new Grader($('#cpCanvas', el)); } catch (e) { $('#cpMsg', el).hidden = false; $('#cpMsg', el).textContent = `Live colour preview needs WebGL2: ${e.message}`; }

  el.addEventListener('click', onClick);
  // 🎨 Lumetri sections (right panel)
  lm = mountLumetri($('#cpPrim', el), {
    clip: curClip, live: liveGrade, luts: () => S.luts || [], auto: () => cur() && autoColor([cur()]),
    commit: (label, co) => { const c = curClip(); if (c) { tidy(c); commit(label, co); } },
    pane: (p) => { wpane = p; renderWheels(); },
    picking: (on) => { picking = on; $('#cpCanvas', el).style.cursor = on ? 'crosshair' : ''; toast('Click the colour to change in the viewer'); },
  });
  // 🎯 HSL secondary: pick the colour from the viewer (the clip as it comes in)
  $('#cpCanvas', el).addEventListener('click', (e) => {
    if (!picking || !grader?.src) return;
    picking = false; e.target.style.cursor = '';
    const src = grader.src, r = e.target.getBoundingClientRect(), cv = document.createElement('canvas'); cv.width = 64; cv.height = 36;
    const g = cv.getContext('2d'); g.drawImage(src, 0, 0, 64, 36);
    const [R, G, B] = g.getImageData(Math.floor(((e.clientX - r.left) / r.width) * 64), Math.floor(((e.clientY - r.top) / r.height) * 36), 1, 1).data;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn || 1;
    let h = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4; h = (((h / 6) % 1) + 1) % 1;
    const c = curClip(); if (!c) return;
    c.color = { ...(c.color || {}), hsl: { hue: 0.08, width: 0.12, sat: [0.12, 1], luma: [0.05, 0.95], soft: 0.08, ...(c.color?.hsl || {}), hue: +h.toFixed(3) } };
    commit('HSL: pick colour'); toast('Colour picked - now change Temperature / Saturation / Hue shift under Correction');
  });
  $$('[data-scope]', el).forEach((b) => (b.onclick = () => { scopeType = b.dataset.scope; syncScopeBtns(); redraw(true); }));
  $('#cpPos', el).oninput = (e) => { pause(); seekTo(+e.target.value); };
  $('#cpSplit', el).oninput = (e) => { if (grader) { grader.split = +e.target.value; redraw(false); } };
  $('#cpStr', el).oninput = (e) => ($('#cpStrV', el).textContent = `${Math.round(e.target.value * 100)}%`);
  $('#cpLut', el).onchange = (e) => setProp('lut', e.target.value || undefined, 'LUT');
  $('#cpLutFile', el).onchange = importLut;
  video.addEventListener('seeked', () => redraw(true));
  video.addEventListener('loadeddata', () => { sizeCanvas(); redraw(true); });
  img.addEventListener('load', () => { sizeCanvas(); redraw(true); });
  new ResizeObserver(() => { sizeCanvas(); redraw(false); }).observe($('#cpStage', el));
  document.addEventListener('keydown', (e) => {
    if (S.page !== 'color' || e.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); copyGrade(); }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteGrade(); }
    if (!e.ctrlKey && e.key.toLowerCase() === 'b' && grader && grader.graded) { grader.graded = false; redraw(true); }
  }, true);
  document.addEventListener('keyup', (e) => { if (S.page === 'color' && e.key.toLowerCase() === 'b' && grader && !$('[data-ca="bypass"]', root).classList.contains('on')) { grader.graded = true; redraw(true); } });
  on('change', () => { if (S.page === 'color') refresh(); });
  on('media', () => { if (S.page === 'color') renderStrip(); });
  on('luts', () => { if (S.page === 'color') renderTools(); });
  syncScopeBtns();
}

export function showColor() {
  const list = gradeable();
  const sel = [...S.sel].find((id) => list.some((x) => x.clip.id === id));
  if (sel) clipId = sel;
  if (!list.some((x) => x.clip.id === clipId)) clipId = list[0]?.clip.id || null;
  loadClip();
  refresh();
}
export function hideColor() { pause(); }

// clips that can be graded, in timeline order: V1 then V2
function gradeable() {
  const L = layout();
  return Object.keys(L).filter((t) => t[0] === 'V').flatMap((t) => L[t].map((x) => ({ ...x, track: t }))).filter((x) => x.clip.type === 'video' || x.clip.type === 'image');
}
const cur = () => gradeable().find((x) => x.clip.id === clipId);
const curClip = () => cur()?.clip;

function refresh() { renderStrip(); renderTools(); renderWheels(); lm?.render(); applyGrade(); }

// ---------------- viewer ----------------
function loadClip() {
  pause();
  const x = cur(), m = x && S.mediaById[x.clip.mediaId];
  $('#cpName', root).textContent = m ? m.name : 'No clip on the timeline';
  $('#cpInfo', root).textContent = m ? `${x.track} · ${fmtTC(x.start, S.project.settings.fps)} · ${m.width ? `${m.width}×${m.height}` : ''} ${m.pixfmt || ''}` : '';
  const msg = $('#cpMsg', root);
  msg.hidden = true;
  if (!m) { msg.hidden = false; msg.textContent = 'Add clips to the timeline on the Edit page, then grade them here.'; grader?.setSource(null); clear(); return; }
  if (m.kind === 'image') { grader?.setSource(img); if (img.dataset.src !== m.urls.play) { img.src = m.urls.play; img.dataset.src = m.urls.play; } else redraw(true); }
  else if (!m.playable) { msg.hidden = false; msg.textContent = `Preparing a preview copy of ${m.name} (${m.proxyPct || 0}%)…`; grader?.setSource(null); clear(); }
  else { grader?.setSource(video); if (video.dataset.src !== m.urls.play) { video.src = m.urls.play; video.dataset.src = m.urls.play; } seekTo(+$('#cpPos', root).value); }
}
function clear() { const c = $('#cpCanvas', root); c.getContext('webgl2')?.clear(0x4000); drawScope($('#cpScope', root), scopeType, null); }
function span() { const c = curClip(), m = c && S.mediaById[c.mediaId]; return { a: c?.in || 0, b: c?.out ?? m?.duration ?? 0 }; }
function seekTo(k) {
  const { a, b } = span();
  if (curClip()?.type !== 'video') return;
  video.currentTime = a + (b - a) * clamp(k, 0, 1);
  $('#cpTC', root).textContent = `${fmt(video.currentTime - a)} / ${fmt(b - a)}`;
}
function sizeCanvas() {
  const st = $('#cpStage', root), c = $('#cpCanvas', root), src = grader?.src;
  if (!st || !src) return;
  const w = src.videoWidth || src.naturalWidth || 16, hh = src.videoHeight || src.naturalHeight || 9;
  const k = Math.min((st.clientWidth - 8) / w, (st.clientHeight - 8) / hh);
  c.style.width = `${Math.floor(w * k)}px`; c.style.height = `${Math.floor(hh * k)}px`;
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = Math.min(1920, Math.floor(w * k * dpr)); c.height = Math.round((c.width * hh) / w);
}
function redraw(scopes) {
  if (!grader || !grader.src) return;
  if (!grader.draw()) return;
  if (scopes || performance.now() - lastScope > 120) {
    lastScope = performance.now();
    const src = grader.src, w = 240, hh = Math.max(2, Math.round((w * (src.videoHeight || src.naturalHeight || 9)) / (src.videoWidth || src.naturalWidth || 16)));
    const px = grader.draw([w, hh]);
    if (px) drawScope($('#cpScope', root), scopeType, px, w, hh);
  }
}
function play() {
  if (curClip()?.type !== 'video') return;
  const { a, b } = span();
  if (video.currentTime >= b - 0.05) video.currentTime = a;
  video.play(); playing = true; $('[data-ca="play"]', root).textContent = '❚❚';
  const loop = () => {
    if (!playing) return;
    if (video.currentTime >= b) video.currentTime = a; // loop the clip
    $('#cpPos', root).value = (video.currentTime - a) / Math.max(0.01, b - a);
    $('#cpTC', root).textContent = `${fmt(video.currentTime - a)} / ${fmt(b - a)}`;
    redraw(false);
    raf = document.hidden ? setTimeout(loop, 40) : requestAnimationFrame(loop);
  };
  loop();
}
function pause() { playing = false; cancelAnimationFrame(raf); clearTimeout(raf); video?.pause(); const b = root && $('[data-ca="play"]', root); if (b) b.textContent = '▶'; }

const fetchCube = async (name) => { if (!lutCache.has(name)) lutCache.set(name, parseCube(await (await fetch(`/api/lut/file?p=${enc(S.proj)}&name=${enc(name)}`)).text())); return lutCache.get(name); };
async function applyGrade() {
  if (!grader) return;
  const c0 = curClip()?.color || {}, c = activeGrade(c0) || {};
  // 🎨 the creative look LUT goes into the post stage (Lumetri > Creative)
  try { lookCube = c.look ? await fetchCube(c.look) : null; } catch (e) { lookCube = null; toast(`Look LUT problem: ${e.message}`, 'err'); }
  grader.setGrade(c0, lookCube);
  if (c.lut !== grader.lutName) {
    if (c.lut) {
      try {
        if (!lutCache.has(c.lut)) lutCache.set(c.lut, parseCube(await (await fetch(`/api/lut/file?p=${enc(S.proj)}&name=${enc(c.lut)}`)).text()));
        grader.setLut(c.lut, lutCache.get(c.lut));
      } catch (e) { toast(`LUT problem: ${e.message}`, 'err'); grader.setLut(null); }
    } else grader.setLut(null);
  }
  redraw(true);
}

// ---------------- strip ----------------
function renderStrip() {
  const list = gradeable(), el = $('#cpStrip', root);
  el.innerHTML = list.length ? list.map((x, i) => {
    const m = S.mediaById[x.clip.mediaId];
    return `<button class="cs${x.clip.id === clipId ? ' on' : ''}" data-clip="${x.clip.id}" title="${esc(m?.name || '')}">
      <span class="cs-th" style="${m?.urls.thumb ? `background-image:url('${m.urls.thumb}')` : ''}"></span>
      <span class="cs-n">${String(i + 1).padStart(2, '0')} <i>${x.track}</i>${isNeutral(x.clip.color) ? '' : '<b title="Graded">●</b>'}${x.clip.color?.lut ? '<b title="LUT">L</b>' : ''}</span></button>`;
  }).join('') : '<div class="muted pad">No video clips on the timeline yet.</div>';
  $$('[data-clip]', el).forEach((b) => (b.onclick = () => { clipId = b.dataset.clip; S.sel = new Set([clipId]); emit('select'); loadClip(); refresh(); }));
}

// ---------------- tools ----------------
function renderTools() {
  const c = curClip()?.color || {};
  $('#cpLut', root).innerHTML = `<option value="">No LUT</option>${S.luts.map((l) => `<option${l === c.lut ? ' selected' : ''}>${esc(l)}</option>`).join('')}`;
  const others = gradeable().filter((x) => x.clip.id !== clipId);
  const prev = $('#cpRef', root).value;
  $('#cpRef', root).innerHTML = others.length ? others.map((x) => `<option value="${x.clip.id}"${x.clip.id === prev ? ' selected' : ''}>Clip ${String(gradeable().indexOf(x) + 1).padStart(2, '0')} · ${esc(S.mediaById[x.clip.mediaId]?.name || '')}</option>`).join('') : '<option value="">Need another clip</option>';
  $$('.cp-tools button', root).forEach((b) => { if (['auto', 'match', 'copy', 'reset', 'all'].includes(b.dataset.ca)) b.disabled = !curClip() || busy; });
  $('[data-ca="autoAll"]', root).disabled = !gradeable().length || busy;
  $('[data-ca="paste"]', root).disabled = !curClip() || !S.colorClipboard;
}

function setProp(k, v, label, coalesce) {
  const c = curClip(); if (!c) return;
  c.color = { ...(c.color || {}) };
  if (v === undefined) delete c.color[k]; else c.color[k] = v;
  tidy(c);
  commit(label || `Color ${k}`, coalesce);
}
function tidy(c) {
  const k = c.color; if (!k) return;
  for (const w of ['lift', 'gamma', 'gain', 'offset']) if (k[w] && !k[w].y && !k[w].r && !k[w].g && !k[w].b) delete k[w];
  for (const [p, d] of [['exposure', 0], ['temp', 0], ['tint', 0], ['contrast', 1], ['pivot', 0.435], ['saturation', 1], ['highlights', 0], ['shadows', 0], ['whites', 0], ['blacks', 0],
    ['faded', 0], ['sharpen', 0], ['vibrance', 0], ['csat', 1], ['lookAmt', 1], ['tintBal', 0]]) if (k[p] === d || k[p] === undefined) delete k[p];
  if (!k.lut) delete k.lut;
  if (!k.look) delete k.look;
  for (const t of ['shTint', 'hiTint']) if (k[t] && !+k[t].amt) delete k[t];
  if (k.vig && !+k.vig.amount) delete k.vig;
  if (k.off && !Object.keys(k.off).length) delete k.off;
  if (!Object.keys(k).length) delete c.color;
}

async function onClick(e) {
  const a = e.target.closest('[data-ca]')?.dataset.ca;
  if (!a) return;
  const c = curClip();
  if (a === 'play') playing ? pause() : play();
  if (a === 'split') { const on = !e.target.closest('button').classList.toggle('on') ? false : true; $('#cpSplit', root).hidden = !on; if (grader) grader.split = on ? +$('#cpSplit', root).value : 0; redraw(false); }
  if (a === 'bypass') { const on = e.target.closest('button').classList.toggle('on'); if (grader) grader.graded = !on; redraw(true); }
  if (a === 'lutUp') $('#cpLutFile', root).click();
  if (a === 'copy') copyGrade();
  if (a === 'paste') pasteGrade();
  if (a === 'reset' && c) { delete c.color; commit('Reset grade'); toast('Grade reset'); }
  if (a === 'all' && c) {
    const list = gradeable();
    if (!confirm(`Apply this clip's grade to all ${list.length} clips?`)) return;
    for (const x of list) { if (c.color) x.clip.color = JSON.parse(JSON.stringify(c.color)); else delete x.clip.color; }
    commit('Grade applied to all'); toast(`Grade applied to ${list.length} clips`);
  }
  if (a === 'auto' && c) autoColor([cur()]);
  if (a === 'autoAll') autoColor(gradeable());
  if (a === 'match' && c) matchShot();
}

function copyGrade() { const c = curClip(); if (!c) return; S.colorClipboard = JSON.parse(JSON.stringify(c.color || {})); toast('Grade copied'); renderTools(); }
function pasteGrade() {
  const c = curClip(); if (!c || !S.colorClipboard) return;
  c.color = JSON.parse(JSON.stringify(S.colorClipboard)); tidy(c);
  commit('Paste grade'); toast('Grade pasted');
}

async function autoColor(list) {
  if (busy || !list.length) return;
  if (list.length > 1 && list.some((x) => !isNeutral(x.clip.color)) && !confirm(`Auto colour ${list.length} clips? Their current grades will be replaced (Ctrl+Z undoes it).`)) return;
  busy = true; renderTools();
  const label = list.length > 1 ? `Auto colour ${list.length} clips` : 'Auto colour';
  emit('job', { running: true, label: `${label}…` });
  try {
    const job = await api('POST', `/api/color/auto?p=${enc(S.proj)}`, {
      strength: +$('#cpStr', root).value, detectLog: $('#cpLog', root).checked,
      clips: list.map((x) => ({ id: x.clip.id, mediaId: x.clip.mediaId, in: x.clip.in, out: x.clip.out, lut: x.clip.color?.lut })),
    });
    const j = await watchJob(job.id, (jj) => emit('job', { running: true, label: `${label}… ${jj.progress}%` }));
    let logN = 0;
    for (const x of list) {
      const g = j.result.grades[x.clip.id]; if (!g) continue;
      if (g._log) logN++;
      delete g._log;
      x.clip.color = g; tidy(x.clip);
    }
    commit(label);
    toast(`${label} done${logN ? ` - ${logN} LOG clip${logN > 1 ? 's' : ''} got a LUT` : ''}. Fine-tune with the wheels.`);
  } catch (err) { toast(err.job ? `Auto colour failed: ${err.job.log.slice(-1)[0]}` : err.message, 'err'); }
  finally { busy = false; emit('job', { running: false }); renderTools(); }
}

async function matchShot() {
  const refId = $('#cpRef', root).value, ref = gradeable().find((x) => x.clip.id === refId), t = cur();
  if (!ref || !t) return toast('Choose a reference clip', 'err');
  busy = true; renderTools();
  try {
    const g = await api('POST', `/api/color/match?p=${enc(S.proj)}`, {
      target: { mediaId: t.clip.mediaId, in: t.clip.in, out: t.clip.out, color: t.clip.color },
      ref: { mediaId: ref.clip.mediaId, in: ref.clip.in, out: ref.clip.out, color: ref.clip.color },
    });
    t.clip.color = g; tidy(t.clip);
    commit('Shot match'); toast('Matched to the reference clip');
  } catch (err) { toast(err.message, 'err'); }
  finally { busy = false; renderTools(); }
}

async function importLut(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    parseCube(await f.text());
    await upload(`/api/upload?p=${enc(S.proj)}&name=${enc(f.name)}`, f);
    emit('luts'); S.luts = await api('GET', `/api/luts?p=${enc(S.proj)}`);
    setProp('lut', f.name, 'Import LUT');
    toast(`${f.name} imported and applied`);
  } catch (err) { toast(`LUT not imported: ${err.message}`, 'err'); }
}

// ---------------- wheels ----------------
function renderWheels() {
  const c = curClip()?.color || {}, el = $('#cpWheels', root);
  if (!el.dataset.built) {
    el.innerHTML = `<div class="cp-wtabs" role="tablist">${[['wheels', 'Wheels', 'Lift / Gamma / Gain / Offset'], ['rgb', 'Curves', 'RGB curves (Lumetri)'], ['hue', 'Hue', 'Hue saturation curves (Lumetri)']].map(([k, l, t]) => `<button data-wpane="${k}" title="${t}">${l}</button>`).join('')}</div>` + WHEELS.map((w) => `<div class="wh" data-w="${w.k}">
      <div class="wh-top"><b>${w.label}</b><span class="muted">${w.hint}</span><button class="icon-btn reset" data-wreset="${w.k}" title="Reset ${w.label}">↺</button></div>
      <canvas class="wh-c" width="150" height="150" aria-label="${w.label} colour wheel"></canvas>
      <input type="range" class="wh-y" min="${w.min}" max="${w.max}" step="${w.step}" aria-label="${w.label} master">
      <div class="wh-v"></div></div>`).join('') + '<div class="cp-curve" data-pane="rgb" hidden></div><div class="cp-curve" data-pane="hue" hidden></div>';
    el.dataset.built = '1';
    const capi = { clip: curClip, live: liveGrade, commit: (label) => { const c = curClip(); if (c) { tidy(c); commit(label); } } };
    curvesUI = ['rgb', 'hue'].map((m) => mountCurves($(`[data-pane="${m}"]`, el), m, capi));
    $$('[data-wpane]', el).forEach((b) => (b.onclick = () => { wpane = b.dataset.wpane; renderWheels(); }));
    $$('.wh', el).forEach((box) => wireWheel(box, WHEELS.find((w) => w.k === box.dataset.w)));
  }
  $$('[data-wpane]', el).forEach((b) => { b.setAttribute('aria-selected', String(b.dataset.wpane === wpane)); b.classList.toggle('has', b.dataset.wpane === 'rgb' ? !!c.curves : b.dataset.wpane === 'hue' ? !!c.hue : false); });
  $$('.wh', el).forEach((x) => (x.hidden = wpane !== 'wheels'));
  $$('[data-pane]', el).forEach((x) => (x.hidden = x.dataset.pane !== wpane));
  curvesUI.forEach((u) => u.draw());
  for (const w of WHEELS) {
    const box = $(`.wh[data-w="${w.k}"]`, el), v = c[w.k] || {};
    $('.wh-y', box).value = v.y || 0;
    $('.wh-v', box).innerHTML = ['y', 'r', 'g', 'b'].map((ch) => `<span class="c-${ch}">${(v[ch] || 0).toFixed(2)}</span>`).join('');
    drawWheel($('.wh-c', box), v, w.amt);
    box.classList.toggle('dis', !curClip());
  }
}
let wheelBg = null;
function drawWheel(cv, v, amt) {
  const g = cv.getContext('2d'), S2 = cv.width, R = S2 / 2 - 6, cx = S2 / 2, cy = S2 / 2;
  if (!wheelBg) {
    wheelBg = g.createImageData(S2, S2);
    for (let y = 0; y < S2; y++) for (let x = 0; x < S2; x++) {
      const dx = x - cx, dy = cy - y, d = Math.hypot(dx, dy), i = (y * S2 + x) * 4;
      if (d > R + 1) continue;
      const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360, ring = d > R - 6;
      const [r, gg, b] = hsl(hue, ring ? 0.9 : 0.35 * (d / R), ring ? 0.5 : 0.16 + 0.04 * (d / R));
      wheelBg.data[i] = r; wheelBg.data[i + 1] = gg; wheelBg.data[i + 2] = b; wheelBg.data[i + 3] = 255;
    }
  }
  g.clearRect(0, 0, S2, S2); g.putImageData(wheelBg, 0, 0);
  g.strokeStyle = '#ffffff22'; g.beginPath(); g.moveTo(cx - R + 6, cy); g.lineTo(cx + R - 6, cy); g.moveTo(cx, cy - R + 6); g.lineTo(cx, cy + R - 6); g.stroke();
  const { angle, amount } = rgbToWheel({ r: v.r || 0, g: v.g || 0, b: v.b || 0 });
  const d = Math.min(1, amount / amt) * (R - 8), px = cx + Math.cos(angle) * d, py = cy - Math.sin(angle) * d;
  g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(px, py, 6, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#ff9933'; g.beginPath(); g.arc(px, py, 2.5, 0, Math.PI * 2); g.fill();
}
function hsl(hh, s, l) {
  const k = (n) => (n + hh / 30) % 12, a = s * Math.min(l, 1 - l), f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
function wireWheel(box, w) {
  const cv = $('.wh-c', box);
  const setFrom = (e, final) => {
    const c = curClip(); if (!c) return;
    const b = cv.getBoundingClientRect(), R = b.width / 2 - 14 * (b.width / 150);
    const dx = e.clientX - (b.left + b.width / 2), dy = b.top + b.height / 2 - e.clientY;
    const amount = (Math.min(R, Math.hypot(dx, dy)) / R) * w.amt * (e.shiftKey ? 0.25 : 1), angle = Math.atan2(dy, dx);
    const rgb = wheelToRGB(angle, amount);
    c.color = { ...(c.color || {}) };
    c.color[w.k] = { y: c.color[w.k]?.y || 0, r: +rgb.r.toFixed(4), g: +rgb.g.toFixed(4), b: +rgb.b.toFixed(4) };
    if (final) { tidy(c); commit(`${w.label} wheel`, `${c.id}:${w.k}`); } else { liveGrade(); drawWheel(cv, c.color[w.k], w.amt); }
  };
  cv.addEventListener('pointerdown', (e) => {
    if (!curClip()) return;
    cv.setPointerCapture(e.pointerId); setFrom(e, false);
    const mv = (ev) => setFrom(ev, false), up = (ev) => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); setFrom(ev, true); };
    cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up);
  });
  cv.addEventListener('dblclick', () => resetWheel(w, true));
  $('.wh-y', box).addEventListener('input', (e) => {
    const c = curClip(); if (!c) return;
    c.color = { ...(c.color || {}) }; c.color[w.k] = { ...(c.color[w.k] || {}), y: +e.target.value };
    liveGrade();
  });
  $('.wh-y', box).addEventListener('change', () => { const c = curClip(); if (c) { tidy(c); commit(`${w.label}`, `${c.id}:${w.k}y`); } });
  $('[data-wreset]', box).onclick = () => resetWheel(w, false);
}
function resetWheel(w, colourOnly) {
  const c = curClip(); if (!c?.color?.[w.k]) return;
  if (colourOnly) c.color[w.k] = { y: c.color[w.k].y || 0 }; else delete c.color[w.k];
  tidy(c); commit(`Reset ${w.label}`);
}
function liveGrade() { if (grader) { grader.setGrade(curClip()?.color || {}, lookCube); redraw(!playing); } }

// ---------------- primaries ----------------
function renderPrim() {
  const c = curClip()?.color || {}, el = $('#cpPrim', root);
  if (!el.dataset.built) {
    el.innerHTML = `<h3>Primaries</h3>${PRIM.map((p) => `<label class="pr"><span>${p.label}${p.unit ? ` <i>${p.unit}</i>` : ''}</span>
      <input type="range" data-p="${p.k}" min="${p.min}" max="${p.max}" step="${p.step}"><input type="number" class="pr-n" data-pn="${p.k}" step="${p.step}">
      <button class="icon-btn reset" data-preset="${p.k}" title="Reset">↺</button></label>`).join('')}`;
    el.dataset.built = '1';
    $$('[data-p]', el).forEach((r) => {
      r.addEventListener('input', () => { const c2 = curClip(); if (!c2) return; c2.color = { ...(c2.color || {}), [r.dataset.p]: +r.value }; $(`[data-pn="${r.dataset.p}"]`, el).value = r.value; liveGrade(); });
      r.addEventListener('change', () => { const c2 = curClip(); if (c2) { tidy(c2); commit(`Color ${r.dataset.p}`, `${c2.id}:${r.dataset.p}`); } });
    });
    $$('[data-pn]', el).forEach((nb) => nb.addEventListener('change', () => setProp(nb.dataset.pn, +nb.value)));
    $$('[data-preset]', el).forEach((b) => (b.onclick = () => setProp(b.dataset.preset, undefined, `Reset ${b.dataset.preset}`)));
  }
  for (const p of PRIM) {
    const v = c[p.k] ?? p.def;
    $(`[data-p="${p.k}"]`, el).value = v; $(`[data-pn="${p.k}"]`, el).value = +(+v).toFixed(3);
    $(`[data-p="${p.k}"]`, el).disabled = !curClip();
  }
}
function syncScopeBtns() { $$('[data-scope]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.scope === scopeType))); }
