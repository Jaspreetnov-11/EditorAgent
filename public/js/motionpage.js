// 🎬 Motion page (After Effects-style): compositions made of layers - text, shapes, solids, images, nulls - with
// keyframes on every property, easing, a graph editor, parenting, masks, track mattes, blend modes, effects, text
// animators and wiggle. The drawing is motion.js (the same for this page, the Edit viewer and the render).
// "Add to timeline" puts the comp on the edit as a graphic clip; later changes here update those clips too.
//
// Panels: Project (comps + presets) | Composition (viewer, tools) | Properties (the selected layer) / Timeline below
// (layers, bars, keyframes) with the Graph Editor on a toggle.
import { ic } from './lineicons.js';
import { S, on, emit, commit, layout } from './store.js';
import { ASPECTS, uid, clipDur, compTrack, linkedPartner } from './model.js';
import { $, $$, esc, toast, clamp } from './ui.js';
import * as M from './motion.js';
import * as CV from './compvideo.js';
import { api, enc, watchJob } from './api.js';
import { cutOut, matteId } from './mattecut.js';

const { val, base, animated, EASE } = M;
let root, compId = null, selIds = new Set(), T = 0, playing = false, raf = 0, tool = 'select', graphOn = false, graphPath = null, selKey = null, pen = null, zoom = 'fit';
const comps = () => (S.project.comps ||= {});
const comp = () => S.project && comps()[compId];
const layer = (id) => comp()?.layers.find((l) => l.id === id);
const sel = () => [...selIds].map(layer).filter(Boolean);
const one = () => sel()[0] || null;
const imgCache = new Map();
function img(id) {
  const url = S.mediaById[id]?.urls?.play; if (!url) return null;
  let x = imgCache.get(url);
  if (!x) { x = new Image(); x.onload = () => draw(); x.src = url; imgCache.set(url, x); }
  return x.complete && x.naturalWidth ? x : null;
}
const fps = () => S.project?.settings?.fps || 30;
const snapT = (t) => Math.round(t * fps()) / fps();
const tc = (t) => { const f = fps(), fr = Math.round(t * f); return `${Math.floor(fr / f / 60)}:${String(Math.floor(fr / f) % 60).padStart(2, '0')}:${String(fr % f).padStart(2, '0')}`; };

// ---------------- saving ----------------
// every edit: the comp changes, the clips that show it on any sequence get the new copy (that is what renders)
function save(label, coalesce) {
  const c = comp(); if (!c) return;
  const copy = JSON.parse(JSON.stringify(c));
  const fix = (tracks) => { for (const [t, l] of Object.entries(tracks || {})) if (t[0] === 'V') for (const x of l) if (x.type === 'graphic' && x.gfx?.tpl === 'comp' && x.gfx.compId === c.id) { x.gfx = { tpl: 'comp', compId: c.id, comp: copy }; x.dur = c.dur; } };
  fix(S.project.tracks);
  for (const s of Object.values(S.project.sequences || {})) fix(s.data?.tracks);
  commit(label, coalesce);
}

// ---------------- mount ----------------
export function mountMotion(el) {
  root = el;
  el.innerHTML = `<div class="mo">
    <div class="panel mo-proj"><div class="mo-head"><b>Project</b><span class="grow"></span>
      <button class="small" data-m="new" title="New composition">Comp ▾</button></div>
      <div class="mo-list" id="moList"></div>
      <div class="mo-compset" id="moCompSet"></div>
      <div class="mo-head sub"><b>Presets</b></div>
      <div class="mo-presets" id="moPresets"></div></div>
    <div class="panel mo-view">
      <div class="mo-head mo-tools" role="toolbar" aria-label="Tools">
        ${[['select', ic('cursor'), 'Selection (V)'], ['text', 'T', 'Text (T)'], ['rect', ic('rect'), 'Rectangle (Q)'], ['ellipse', ic('ellipse'), 'Ellipse'], ['star', ic('star'), 'Star / polygon'], ['pen', ic('pen'), 'Pen - path shape (G): click = point, drag = curve, click the first point or Enter = done'],
          ['mrect', ic('mask'), 'Rectangle mask on the selected layer'], ['mellipse', ic('maskellipse'), 'Ellipse mask on the selected layer'], ['mpen', ic('edit'), 'Pen mask on the selected layer'], ['track', ic('target'), 'Track motion: select the layer that should follow (e.g. text), then drag a box around the thing in the video to follow']].map(([k, i, t]) => `<button class="mo-tool" data-tool="${k}" title="${t}">${i}</button>`).join('')}
        <span class="sep"></span>
        <button class="small" data-m="addLayer" title="New layer">Layer ▾</button>
        <span class="grow"></span>
        <select id="moZoom" aria-label="Zoom"><option value="fit">Fit</option><option value="0.25">25%</option><option value="0.5">50%</option><option value="1">100%</option></select>
        <button class="accent small" data-m="toTimeline" title="Put this comp on the edit's timeline at the playhead (it updates when you change it here)">Add to timeline</button>
      </div>
      <div class="mo-stage" id="moStage"><div class="mo-canvas"><canvas id="moCanvas"></canvas><canvas id="moOver"></canvas></div><div class="mo-empty" id="moEmpty">Make a composition: Comp, or pick a preset on the left.</div></div>
      <div class="mo-trans"><button class="icon-btn" data-m="start" title="Start (Home)">${ic('start')}</button><button class="icon-btn" data-m="prevKey" title="Previous keyframe (J)">${ic('prev')}</button><button class="icon-btn" data-m="play" title="Play / pause (Space)">${ic('play')}</button><button class="icon-btn" data-m="nextKey" title="Next keyframe (K)">${ic('next')}</button><button class="icon-btn" data-m="end" title="End (End)">${ic('end')}</button>
        <span class="tc" id="moTC">0:00:00</span><span class="muted small" id="moHint"></span></div>
    </div>
    <div class="panel mo-props" id="moProps"></div>
    <div class="panel mo-tl">
      <div class="mo-head"><b id="moTlName">Timeline</b><span class="grow"></span>
        <button class="small tog" data-m="graph" title="Graph Editor: shape the speed of the selected property between keyframes">Graph Editor</button>
        <span class="muted small">Ease: select a keyframe, then</span>${Object.entries({ linear: 'Linear', easy: 'Easy Ease (F9)', easyIn: 'Ease In', easyOut: 'Ease Out', overshoot: 'Overshoot', hold: 'Hold' }).map(([k, l]) => `<button class="small" data-ease="${k}">${l}</button>`).join('')}
      </div>
      <div class="mo-tlbody"><div class="mo-lhead" id="moLHead"></div><div class="mo-lanes" id="moLanes"><canvas id="moTlCanvas"></canvas></div></div>
    </div>
  </div>`;
  el.addEventListener('click', onClick);
  $('#moZoom', el).onchange = (e) => { zoom = e.target.value; size(); draw(); };
  new ResizeObserver(() => { size(); draw(); drawTl(); }).observe($('#moStage', el));
  new ResizeObserver(() => drawTl()).observe($('#moLanes', el));
  wireViewer(); wireTimeline(); wireKeys();
  on('change', () => { if (S.page === 'motion') refresh(); });
  on('media', () => { if (S.page === 'motion') draw(); });
}
export function showMotion() {
  if (!comp()) compId = Object.keys(comps())[0] || null;
  refresh();
}
export function hideMotion() { stop(); }

function refresh() {
  if (!root || !S.project) return;
  if (compId && !comp()) { compId = Object.keys(comps())[0] || null; selIds.clear(); }
  for (const id of [...selIds]) if (!layer(id)) selIds.delete(id);
  { const b = root.querySelector('[data-m="toTimeline"]'); if (b && comp()) b.textContent = onTimeline(comp().id).length ? 'Update on timeline' : 'Add to timeline'; } // (already there: updated, not added)
  T = clamp(T, 0, comp()?.dur || 0);
  renderList(); renderProps(); renderLHead(); size(); draw(); drawTl();
  $$('[data-tool]', root).forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  $('[data-m="graph"]', root).classList.toggle('on', graphOn);
  $('#moEmpty', root).hidden = !!comp();
}

// ---------------- project panel ----------------
function renderList() {
  const list = Object.values(comps());
  $('#moList', root).innerHTML = list.length ? list.map((c) => `<div class="mo-comp${c.id === compId ? ' on' : ''}" data-comp="${c.id}" title="Double-click to rename"><span class="grow">${esc(c.name)}</span><span class="muted small">${c.dur}s</span>
    <button class="icon-btn" data-dup="${c.id}" title="Duplicate">${ic('duplicate')}</button><button class="icon-btn" data-del="${c.id}" title="Delete">✕</button></div>`).join('') : '<div class="muted small pad">No compositions yet.</div>';
  $$('[data-comp]', root).forEach((r) => {
    r.onclick = (e) => { if (e.target.closest('button')) return; compId = r.dataset.comp; selIds.clear(); T = 0; refresh(); };
    r.ondblclick = () => { const c = comps()[r.dataset.comp], n = prompt('Composition name', c.name)?.trim(); if (n) { c.name = n; save('Rename comp'); } };
  });
  $$('[data-dup]', root).forEach((b) => (b.onclick = () => { const c = JSON.parse(JSON.stringify(comps()[b.dataset.dup])); c.id = M.uidM(); c.name += ' copy'; comps()[c.id] = c; compId = c.id; commit('Duplicate comp'); }));
  $$('[data-del]', root).forEach((b) => (b.onclick = () => {
    const c = comps()[b.dataset.del]; if (!confirm(`Delete the composition "${c.name}"? Clips of it already on the timeline stay as they are.`)) return;
    delete comps()[c.id]; if (compId === c.id) compId = null; commit('Delete comp');
  }));
  const c = comp();
  $('#moCompSet', root).innerHTML = c ? `<div class="mo-set"><label>Duration <input type="number" min="0.5" step="0.5" data-cs="dur" value="${c.dur}"> s</label>
    <label title="Fills the whole frame with this colour - it covers the clip underneath on the edit. Leave it off for a see-through comp.">Background colour (covers the edit below) <input type="checkbox" data-cs="bgOn"${c.bg ? ' checked' : ''}> <input type="color" data-cs="bg" value="${c.bg || '#000000'}"></label>
    <label title="A camera for parallax: layers with a Depth move with it (Properties, with no layer selected)">Camera (parallax) <input type="checkbox" data-cs="cam"${c.camera ? ' checked' : ''}></label>
    <span class="muted small">${c.w}×${c.h} · ${fps()} fps</span></div>` : '';
  $$('[data-cs]', root).forEach((i) => (i.onchange = () => {
    const c2 = comp(); if (!c2) return;
    if (i.dataset.cs === 'dur') { const d = Math.max(0.5, +i.value || 5); for (const l of c2.layers) if ((l.out ?? c2.dur) >= c2.dur - 1e-3) l.out = d; c2.dur = d; }
    if (i.dataset.cs === 'bgOn') c2.bg = i.checked ? $('[data-cs="bg"]', root).value : null;
    if (i.dataset.cs === 'bg' && c2.bg !== null) c2.bg = i.value;
    if (i.dataset.cs === 'cam') { if (i.checked) c2.camera = { pos: [0, 0], zoom: 1 }; else delete c2.camera; if (i.checked) { selIds.clear(); toast('Camera on: give layers a Depth (Properties > Layer), then animate the camera (click an empty spot to see it)'); } }
    save('Comp settings');
  }));
  // presets as two drop-downs: a new comp from a template, and a text animation for the selected text layer
  if (!$('#moPresets', root).dataset.built) {
    $('#moPresets', root).innerHTML = `<label class="mo-f"><span>New comp from a template</span><select data-psel="comp"><option value="">Choose a template…</option>${Object.entries(M.COMP_PRESETS).filter(([k]) => k !== 'blank').map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')}</select></label>
      <label class="mo-f"><span>Text animation (selected text layer)</span><select data-psel="text"><option value="">Choose an animation…</option>${Object.entries(M.TEXT_ANIMS).filter(([k]) => k !== 'tracking').map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')}</select></label>`;
    $('#moPresets', root).dataset.built = '1';
    $$('[data-psel]', root).forEach((s) => (s.onchange = () => { const v = s.value; s.value = ''; if (!v) return; if (s.dataset.psel === 'comp') return newCompFrom(v); const L = one(); if (L?.type !== 'text') return toast('Select a text layer first', 'err'); const a = M.TEXT_ANIMS[v].make(Math.min(2, comp().dur / 2)); (L.text.animators ||= []).push(a); shiftAnim(a, T); save(`Text animation: ${a.name}`); }));
  }
}
function frame() { return ASPECTS[S.project.settings.aspect] || [1920, 1080]; }
function newCompFrom(preset) {
  const [w, h] = frame(), c = M.COMP_PRESETS[preset].make(w, h);
  let n = c.name, k = 2; while (Object.values(comps()).some((x) => x.name === n)) n = `${c.name} ${k++}`;
  c.name = n; comps()[c.id] = c; compId = c.id; selIds = new Set(c.layers[0] ? [c.layers[0].id] : []); T = 0;
  commit(`New comp: ${c.name}`);
  toast(`"${c.name}" made - press Space to play`);
}

// ---------------- adding layers ----------------
function addLayer(type, extra = {}) {
  const c = comp(); if (!c) { newCompFrom('blank'); return addLayer(type, extra); }
  const L = M.newLayer(type, c, extra);
  if (extra.at) L.tr.position = extra.at;
  c.layers.unshift(L); selIds = new Set([L.id]);
  save(`New ${type} layer`);
  return L;
}
function layerMenu(btn) {
  const imgs = S.media.filter((m) => m.kind === 'image'), vids = S.media.filter((m) => m.kind === 'video' && m.playable !== false);
  menu(btn, [['text', 'Text'], ['shape', 'Shape'], ['solid', 'Solid'], ['null', 'Null (parent for others)'], ...(vids.length ? [['video', 'Video from Media…']] : []), ...(imgs.length ? [['image', 'Image from Media…']] : [])], (k) => {
    if (k === 'video') return menu(btn, vids.slice(0, 80).map((m) => [m.id, m.name]), (id) => { const m = S.mediaById[id], c = comp() || null, [w, h] = frame(), k2 = Math.max(w / (m.width || w), h / (m.height || h)); addLayer('video', { mediaId: id, name: m.name, w: Math.round((m.width || w) * k2), h: Math.round((m.height || h) * k2) }); });
    if (k !== 'image') return addLayer(k);
    menu(btn, imgs.slice(0, 60).map((m) => [m.id, m.name]), (id) => { const m = S.mediaById[id], [w, h] = frame(), k2 = Math.min(1, (w * 0.6) / (m.width || 800)); addLayer('image', { mediaId: id, name: m.name, w: Math.round((m.width || 800) * k2), h: Math.round((m.height || 600) * k2) }); });
  });
}
function menu(anchor, items, pick) {
  document.querySelector('.ui-menu')?.remove();
  const m = document.createElement('div'); m.className = 'ui-menu';
  m.innerHTML = items.map(([k, l]) => `<button data-k="${esc(k)}">${esc(l)}</button>`).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${Math.min(innerHeight - m.offsetHeight - 8, r.bottom + 4)}px`; m.style.left = `${Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.left))}px`;
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
  m.onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; m.remove(); document.removeEventListener('pointerdown', close, true); pick(b.dataset.k); };
}

function onClick(e) {
  const b = e.target.closest('[data-m], [data-tool], [data-preset], [data-tanim], [data-ease]'); if (!b) return;
  if (b.dataset.tool) { tool = b.dataset.tool; pen = null; refresh(); hint(); return; }
  if (b.dataset.preset) return newCompFrom(b.dataset.preset);
  if (b.dataset.tanim) {
    const L = one(); if (L?.type !== 'text') return toast('Select a text layer first', 'err');
    const a = M.TEXT_ANIMS[b.dataset.tanim].make(Math.min(2, comp().dur / 2));
    (L.text.animators ||= []).push(a); shiftAnim(a, T); save(`Text animation: ${a.name}`); return;
  }
  if (b.dataset.ease) return easeSel(b.dataset.ease);
  const m = b.dataset.m;
  if (m === 'new') menu(b, Object.entries(M.COMP_PRESETS).map(([k, p]) => [k, p.name]), newCompFrom);
  if (m === 'addLayer') layerMenu(b);
  if (m === 'play') playing ? stop() : play();
  if (m === 'start') seek(0);
  if (m === 'end') seek(comp()?.dur || 0);
  if (m === 'prevKey' || m === 'nextKey') jumpKey(m === 'nextKey' ? 1 : -1);
  if (m === 'graph') { graphOn = !graphOn; refresh(); }
  if (m === 'toTimeline') toTimeline(e);
}
// a text animation added at time T: its keyframes start at T
function shiftAnim(a, t0) { const walk = (o) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o.k)) o.k.forEach((k) => (k.t = +(k.t + t0).toFixed(4))); else Object.values(o).forEach(walk); }; walk(a.range); }

// ---------------- the comp on the edit timeline ----------------
// the clips of the open sequence that show comp `id`
const onTimeline = (id) => Object.entries(S.project.tracks).filter(([t]) => t[0] === 'V').flatMap(([t, l]) => l.filter((x) => x.type === 'graphic' && x.gfx?.tpl === 'comp' && x.gfx.compId === id).map((x) => ({ t, x })));
// a comp opened from the timeline (or put there before) is updated in place - not added again; Shift = another copy
function toTimeline(e) {
  const c = comp(); if (!c) return;
  const there = onTimeline(c.id);
  if (there.length && !e?.shiftKey) {
    save(`Update comp "${c.name}" on the timeline`);
    S.sel = new Set(there.map((p) => p.x.id)); emit('select');
    return toast(`"${c.name}" updated on ${[...new Set(there.map((p) => p.t))].join(', ')} - no new clip (Shift + click adds another copy)`);
  }
  const t = S.playhead || 0, dur = c.dur;
  const id = compTrack(S.project, t, dur, S.mediaById);
  const clip = { id: uid(), type: 'graphic', start: +t.toFixed(3), dur, gfx: { tpl: 'comp', compId: c.id, comp: JSON.parse(JSON.stringify(c)) } };
  S.project.tracks[id].push(clip);
  commit(`Add comp "${c.name}" to the timeline`);
  toast(`"${c.name}" is on ${id} at the playhead - changes made here update it`);
}

// ---------------- viewer ----------------
let VW = 0, VH = 0, VS = 1; // canvas css size and comp->css scale
function size() {
  const st = $('#moStage', root), c = comp(); if (!st || !c) return;
  const k = zoom === 'fit' ? Math.min((st.clientWidth - 24) / c.w, (st.clientHeight - 24) / c.h) : +zoom;
  VS = Math.max(0.05, k); VW = Math.round(c.w * VS); VH = Math.round(c.h * VS);
  const dpr = Math.min(2, devicePixelRatio || 1);
  for (const cv of [$('#moCanvas', root), $('#moOver', root)]) { cv.style.width = `${VW}px`; cv.style.height = `${VH}px`; cv.width = Math.round(VW * dpr); cv.height = Math.round(VH * dpr); }
  $('.mo-canvas', root).style.width = `${VW}px`; $('.mo-canvas', root).style.height = `${VH}px`;
}
function draw() {
  const c = comp(), cv = $('#moCanvas', root); if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!c) { ctx.clearRect(0, 0, cv.width, cv.height); drawOver(); return; }
  M.drawComp(ctx, cv.width, cv.height, c, T, { img, placeholder: true, video: (id, t) => (playing ? CV.get('motion', id) : CV.frame('motion', id, t, draw)), cut: cutOut });
  drawOver();
  $('#moTC', root).textContent = `${tc(T)} / ${tc(c.dur)}`;
}
// selection boxes, anchor points, mask / path points
function drawOver() {
  const cv = $('#moOver', root), g = cv.getContext('2d'), c = comp();
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
  if (!c) return;
  const k = cv.width / c.w; g.scale(k, k);
  const lw = 1.5 / k;
  for (const L of sel()) {
    const q = M.layerQuad(c, L, T, g);
    g.strokeStyle = '#2f8cff'; g.lineWidth = lw; g.beginPath(); q.forEach((p, i) => (i ? g.lineTo(...p) : g.moveTo(...p))); g.closePath(); g.stroke();
    if (L.locked) continue;
    g.fillStyle = '#2f8cff'; for (const p of q) g.fillRect(p[0] - 4 / k, p[1] - 4 / k, 8 / k, 8 / k);
    const top = [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2], m = M.worldMatrix(c, L, T), ctr = M.apply(m, base(L.tr.anchor, T) || [0, 0]);
    const rh = rotHandle(q); g.beginPath(); g.moveTo(...top); g.lineTo(...rh); g.stroke(); g.beginPath(); g.arc(rh[0], rh[1], 5 / k, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#ffcc33'; g.beginPath(); g.arc(ctr[0], ctr[1], 6 / k, 0, Math.PI * 2); g.moveTo(ctr[0] - 9 / k, ctr[1]); g.lineTo(ctr[0] + 9 / k, ctr[1]); g.moveTo(ctr[0], ctr[1] - 9 / k); g.lineTo(ctr[0], ctr[1] + 9 / k); g.stroke();
    // masks and pen paths of the selected layer, in comp space
    const paths = [...(L.masks || []).map((x) => x.path), ...(L.type === 'shape' && L.shape.kind === 'path' ? [L.shape.path] : [])];
    g.strokeStyle = '#ffd400'; g.fillStyle = '#ffd400';
    for (const P of paths) {
      if (!P?.length) continue;
      g.beginPath(); P.forEach((p, i) => { const a = M.apply(m, p); i ? g.lineTo(...a) : g.moveTo(...a); }); g.closePath(); g.stroke();
      for (const p of P) { const a = M.apply(m, p); g.fillRect(a[0] - 3 / k, a[1] - 3 / k, 6 / k, 6 / k); }
    }
  }
  if (pen?.pts?.length) {
    g.strokeStyle = '#ffd400'; g.fillStyle = '#ffd400'; g.lineWidth = lw; g.beginPath();
    pen.pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke();
    for (const p of pen.pts) g.fillRect(p[0] - 4 / k, p[1] - 4 / k, 8 / k, 8 / k);
  }
  if (drag?.box) { g.strokeStyle = '#ffffffaa'; g.setLineDash([6 / k, 4 / k]); g.strokeRect(...drag.box); g.setLineDash([]); }
}
const rotHandle = (q) => { const top = [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2], ctr = [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2], d = Math.hypot(top[0] - ctr[0], top[1] - ctr[1]) || 1; return [top[0] + ((top[0] - ctr[0]) / d) * 40, top[1] + ((top[1] - ctr[1]) / d) * 40]; };
function inPoly(p, q) { let c = false; for (let i = 0, j = q.length - 1; i < q.length; j = i++) if ((q[i][1] > p[1]) !== (q[j][1] > p[1]) && p[0] < ((q[j][0] - q[i][0]) * (p[1] - q[i][1])) / (q[j][1] - q[i][1]) + q[i][0]) c = !c; return c; }
function hit(p) {
  const c = comp(), g = $('#moOver', root).getContext('2d');
  return c.layers.find((L) => !L.hidden && !L.locked && T >= (L.in || 0) && T < (L.out ?? c.dur) && inPoly(p, M.layerQuad(c, L, T, g)));
}
let drag = null;
function wireViewer() {
  const ov = $('#moOver', root);
  const pt = (e) => { const r = ov.getBoundingClientRect(), c = comp(); return [((e.clientX - r.left) / r.width) * c.w, ((e.clientY - r.top) / r.height) * c.h]; };
  ov.addEventListener('pointerdown', (e) => {
    const c = comp(); if (!c || S.readOnly) return;
    const p = pt(e); ov.setPointerCapture(e.pointerId);
    if (tool === 'pen' || tool === 'mpen') return penDown(p, e);
    if (['rect', 'ellipse', 'star', 'mrect', 'mellipse', 'track'].includes(tool)) { drag = { mode: 'box', p0: p, box: [p[0], p[1], 0, 0] }; return; }
    if (tool === 'text') { const L = addLayer('text', { at: [Math.round(p[0]), Math.round(p[1])] }); tool = 'select'; refresh(); setTimeout(() => $('#moProps [data-textarea]', root)?.focus(), 50); return L; }
    // selection: handles of the selected layer first, then the layer under the pointer
    const g = ov.getContext('2d'), L0 = one();
    if (L0 && !L0.locked) {
      const q = M.layerQuad(c, L0, T, g), near = (a) => Math.hypot(a[0] - p[0], a[1] - p[1]) < 12 / VS;
      if (near(rotHandle(q))) { const m = M.worldMatrix(c, L0, T), ctr = M.apply(m, base(L0.tr.anchor, T) || [0, 0]); drag = { mode: 'rot', L: L0, ctr, a0: Math.atan2(p[1] - ctr[1], p[0] - ctr[0]), r0: val(L0.tr.rotation, T) || 0 }; return; }
      const ci = q.findIndex(near);
      if (ci >= 0) { const m = M.worldMatrix(c, L0, T), ctr = M.apply(m, base(L0.tr.anchor, T) || [0, 0]); drag = { mode: 'scale', L: L0, ctr, d0: Math.hypot(p[0] - ctr[0], p[1] - ctr[1]), s0: base(L0.tr.scale, T) || [100, 100] }; return; }
    }
    const L = hit(p);
    if (!L) { selIds.clear(); refresh(); return; }
    if (e.shiftKey) selIds.has(L.id) ? selIds.delete(L.id) : selIds.add(L.id); else if (!selIds.has(L.id)) selIds = new Set([L.id]);
    drag = { mode: 'move', p0: p, start: sel().map((x) => [x, base(x.tr.position, T) || [0, 0], x.parent ? M.invert(M.worldMatrix(c, comp().layers.find((y) => y.id === x.parent), T)) : null]) };
    renderProps(); renderLHead(); drawOver(); drawTl();
  });
  ov.addEventListener('pointermove', (e) => {
    if (!drag) { if (pen) { pen.hover = pt(e); } return; }
    const p = pt(e);
    if (drag.mode === 'box') { drag.box = [Math.min(drag.p0[0], p[0]), Math.min(drag.p0[1], p[1]), Math.abs(p[0] - drag.p0[0]), Math.abs(p[1] - drag.p0[1])]; if (e.shiftKey) drag.box[3] = drag.box[2]; drawOver(); return; }
    if (drag.mode === 'penHandle') { const P = drag.P, i = drag.i, a = drag.toLocal(p), dx = a[0] - P[i][0], dy = a[1] - P[i][1]; P[i][4] = dx; P[i][5] = dy; P[i][2] = -dx; P[i][3] = -dy; pen.pts = drag.toCompPts(); draw(); return; }
    if (drag.mode === 'move') {
      const d = [p[0] - drag.p0[0], p[1] - drag.p0[1]];
      for (const [L, p0, inv] of drag.start) {
        let np = [p0[0] + d[0], p0[1] + d[1]];
        if (inv) { const a = M.apply(inv, [0, 0]), b = M.apply(inv, d); np = [p0[0] + b[0] - a[0], p0[1] + b[1] - a[1]]; }
        L.tr.position = M.setVal(L.tr.position, T, np.map((v) => Math.round(v * 10) / 10));
      }
      drag.moved = true;
    }
    if (drag.mode === 'rot') { const a = Math.atan2(p[1] - drag.ctr[1], p[0] - drag.ctr[0]); let r = drag.r0 + ((a - drag.a0) * 180) / Math.PI; if (e.shiftKey) r = Math.round(r / 15) * 15; drag.L.tr.rotation = M.setVal(drag.L.tr.rotation, T, +r.toFixed(1)); drag.moved = true; }
    if (drag.mode === 'scale') { const k = Math.hypot(p[0] - drag.ctr[0], p[1] - drag.ctr[1]) / Math.max(1, drag.d0); drag.L.tr.scale = M.setVal(drag.L.tr.scale, T, drag.s0.map((v) => +(v * k).toFixed(1))); drag.moved = true; }
    draw(); renderPropsValues();
  });
  ov.addEventListener('pointerup', () => {
    const d = drag; drag = null; if (!d) return;
    if (d.mode === 'box') return boxDone(d.box);
    if (d.mode === 'penHandle') return drawOver();
    if (d.moved) save({ move: 'Move layer', rot: 'Rotate layer', scale: 'Scale layer' }[d.mode]);
  });
  ov.addEventListener('dblclick', (e) => { const L = hit(pt(e)); if (L?.type === 'text') { selIds = new Set([L.id]); renderProps(); $('#moProps [data-textarea]', root)?.focus(); } });
}
function boxDone([x, y, w, h]) {
  drawOver();
  if (w < 4 && h < 4) return;
  const c = comp();
  if (tool === 'track') return trackBox([x, y, w, h]);
  if (tool === 'mrect' || tool === 'mellipse') {
    const L = one(); if (!L) return toast('Select the layer to mask first', 'err');
    const inv = M.invert(M.worldMatrix(c, L, T)), a = M.apply(inv, [x, y]), b = M.apply(inv, [x + w, y + h]);
    const [x0, y0, x1, y1] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const path = tool === 'mrect' ? M.rectPath(x0, y0, x1 - x0, y1 - y0) : M.ellipsePath((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2);
    (L.masks ||= []).push({ id: M.uidM(), name: `Mask ${L.masks.length + 1}`, mode: 'add', feather: 0, opacity: 100, expansion: 0, inverted: false, path });
    return save('Add mask');
  }
  const L = addLayer('shape', { at: [Math.round(x + w / 2), Math.round(y + h / 2)], name: { rect: 'Rectangle', ellipse: 'Ellipse', star: 'Star' }[tool] });
  Object.assign(L.shape, { kind: tool === 'star' ? 'star' : tool, size: [Math.round(w), Math.round(h)], roundness: tool === 'rect' ? 0 : L.shape.roundness });
  save('Draw shape');
}
// ✒ pen: points in comp space while drawing; the path is stored in the layer's own space
function penDown(p, e) {
  const c = comp();
  if (!pen) {
    let L;
    if (tool === 'mpen') { L = one(); if (!L) return toast('Select the layer to mask first', 'err'); }
    else { L = M.newLayer('shape', c, { name: 'Path' }); Object.assign(L.shape, { kind: 'path', path: [], closed: false, fillOn: false, strokeW: 8, stroke: '#ff9933' }); L.tr.position = [Math.round(p[0]), Math.round(p[1])]; L.tr.anchor = [0, 0]; c.layers.unshift(L); selIds = new Set([L.id]); }
    pen = { L, mask: tool === 'mpen', P: [], pts: [] };
    if (pen.mask) (L.masks ||= []).push(pen.maskObj = { id: M.uidM(), name: `Mask ${L.masks.length + 1}`, mode: 'add', feather: 0, opacity: 100, expansion: 0, inverted: false, path: pen.P });
    else L.shape.path = pen.P;
  }
  const inv = M.invert(M.worldMatrix(c, pen.L, T)), toLocal = (q) => M.apply(inv, q);
  const toCompPts = () => { const m = M.worldMatrix(c, pen.L, T); return pen.P.map((q) => M.apply(m, q)); };
  if (pen.P.length > 2 && Math.hypot(...M.apply(M.worldMatrix(c, pen.L, T), pen.P[0]).map((v, i) => v - p[i])) < 12 / VS) return penFinish(true);
  const a = toLocal(p); pen.P.push([+a[0].toFixed(1), +a[1].toFixed(1), 0, 0, 0, 0]); pen.pts = toCompPts();
  drag = { mode: 'penHandle', P: pen.P, i: pen.P.length - 1, toLocal, toCompPts };
  draw(); hint();
}
function penFinish(close) {
  if (!pen) return;
  const { L, mask, P } = pen; pen = null;
  if (P.length < 2) { if (mask) L.masks = L.masks.filter((x) => x.path !== P); else comp().layers = comp().layers.filter((x) => x !== L); refresh(); return; }
  if (!mask) { L.shape.closed = !!close; if (close) { L.shape.fillOn = true; L.shape.fill = '#ff9933'; L.shape.strokeW = 0; } }
  tool = 'select';
  save(mask ? 'Pen mask' : 'Pen path');
}
function hint() {
  const t = { pen: 'Click to add points, drag for curves; click the first point (closed) or Enter (open) to finish', mpen: 'Draw the mask on the selected layer; click the first point to close', mrect: 'Drag on the viewer to add a rectangle mask to the selected layer', mellipse: 'Drag to add an ellipse mask', rect: 'Drag to draw a rectangle (Shift = square)', ellipse: 'Drag to draw an ellipse (Shift = circle)', star: 'Drag to draw a star', text: 'Click where the text goes', track: 'Select the layer that should follow, then drag a box around the thing in the video (a face, a sign, a car…)' }[tool] || '';
  $('#moHint', root).textContent = t;
}

// ---------------- play / seek ----------------
function seek(t) { const c = comp(); T = snapT(clamp(t, 0, c?.dur || 0)); draw(); drawTl(); renderPropsValues(); syncOutline(); }
// the outline's values and timecode follow the time (rebuilt only when nothing in it is being typed in)
function syncOutline() { const el = root && $('#moLHead', root); if (!el) return; if (el.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') { const t = $('.ae-tc', el); if (t) t.textContent = tc(T); return; } renderLHead(); }
function play() {
  const c = comp(); if (!c) return;
  playing = true; $('[data-m="play"]', root).innerHTML = ic('pause');
  if (T >= c.dur - 1 / fps()) T = 0;
  let last = performance.now();
  const step = (now) => {
    if (!playing) return;
    T += (now - last) / 1000; last = now;
    if (T >= c.dur) T = 0; // loops, like AE's preview
    { const tcEl = $('.ae-tc', root); if (tcEl) tcEl.textContent = tc(T); }
    CV.play('motion', M.compVideos(c, T));
    draw(); drawTl();
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}
function stop() { playing = false; cancelAnimationFrame(raf); CV.pause('motion'); if (root && comp()) setTimeout(() => { draw(); syncOutline(); }, 0); const b = root && $('[data-m="play"]', root); if (b) b.innerHTML = ic('play'); if (root) renderPropsValues(); }
function allKeyTimes(onlySel = true) {
  const c = comp(); if (!c) return [];
  const ts = new Set();
  for (const L of onlySel && selIds.size ? sel() : c.layers) for (const r of M.layerKeys(L)) for (const k of r.keys) ts.add(k.t);
  return [...ts].sort((a, b) => a - b);
}
function jumpKey(dir) { const ks = allKeyTimes(), t = dir > 0 ? ks.find((x) => x > T + 1e-4) : [...ks].reverse().find((x) => x < T - 1e-4); if (t !== undefined) seek(t); }

// ---------------- properties panel ----------------
// a row: label, ⏱ stopwatch, ◆ key, value inputs, 〰 wiggle. path = where the property lives in the layer
const ROW = (L, path, label, kind, opts = {}) => {
  const p = M.getIn(L, path), on = animated(p), k = M.keyAt(p, T) >= 0, w = p && typeof p === 'object' && !Array.isArray(p) ? p.wiggle : null;
  const v = val(p, T), P = path.join('.');
  const num = (x, i) => `<input type="number" step="${opts.step || 1}" data-pv="${P}" data-i="${i}" value="${+(+x || 0).toFixed(2)}" class="mo-num${on ? ' anim' : ''}">`;
  const input = kind === 'color' ? `<input type="color" data-pv="${P}" value="${v || '#ffffff'}">`
    : kind === 'xy' ? (v || [0, 0]).map(num).join('') : num(v, -1);
  return `<div class="mo-row${graphPath === P ? ' gsel' : ''}" data-row="${P}">
    <button class="mo-sw${on ? ' on' : ''}" data-sw="${P}" title="Stopwatch: animate this property">${ic('clock')}</button>
    <span class="mo-lab" data-glab="${P}" title="${on ? 'Click: show in the Graph Editor' : ''}">${label}</span>
    <span class="mo-in">${input}</span>
    ${on ? `<button class="mo-key${k ? ' on' : ''}" data-key="${P}" title="${k ? 'Remove the keyframe here' : 'Add a keyframe here'}">${ic('diamond')}</button>` : '<span class="mo-key-sp"></span>'}
    ${kind !== 'color' && opts.wiggle !== false ? `<button class="mo-wig${w ? ' on' : ''}" data-wig="${P}" title="Wiggle (random motion)${w ? `: ${w.freq}/s, ±${w.amp}` : ''}">${ic('wave')}</button>` : ''}
  </div>`;
};
const SEL = (path, label, options, cur) => `<label class="mo-f"><span>${label}</span><select data-sv="${path}">${options.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(cur ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const CHK = (path, label, cur) => `<label class="mo-f chk"><input type="checkbox" data-cv="${path}"${cur ? ' checked' : ''}> ${label}</label>`;
const sec = (id, title, body, extra = '') => `<details class="mo-sec" data-sec="${id}"${openSecs.has(id) ? ' open' : ''}><summary>${title}${extra}</summary>${body}</details>`;
const openSecs = new Set(['tr', 'text', 'shape', 'solid', 'image', 'video', 'roto']);

function renderProps() {
  const el = $('#moProps', root), c = comp(), L = one();
  if (!c) { el.innerHTML = '<div class="mo-head"><b>Properties</b></div><div class="muted pad small">No composition open.</div>'; return; }
  if (!L) {
    // 🎥 no layer selected: the comp's camera (parallax) is edited here
    el.innerHTML = `<div class="mo-head"><b>Properties</b></div>${c.camera ? `<div class="mo-scroll">${sec('cam', 'Camera (parallax)', ROW(c, ['camera', 'pos'], 'Position', 'xy') + ROW(c, ['camera', 'zoom'], 'Zoom ×', 'n', { step: 0.01 }) + '<div class="muted small">Layers with a Depth move with it - near ones more, far ones less. to animate the move.</div>')}</div>` : ''}<div class="muted pad small">Select a layer (click it in the viewer or the timeline).<br><br>Keys: V select · T text · Q rectangle · G pen · Space play · J / K keyframes · F9 easy ease · Delete · Ctrl+D duplicate · [ ] layer in / out at the time</div>`;
    if (c.camera) { openSecs.add('cam'); wireProps(el, c, {}); }
    return;
  }
  const layersOpt = [['', 'None'], ...c.layers.filter((x) => x.id !== L.id).map((x) => [x.id, x.name])];
  let h = `<div class="mo-head"><input class="mo-name" data-name value="${esc(L.name)}" aria-label="Layer name"><span class="muted small">${L.type}</span></div><div class="mo-scroll">`;
  h += sec('layer', 'Layer', `<div class="mo-grid">${SEL('parent', 'Parent', layersOpt, L.parent)}${SEL('blend', 'Blend mode', Object.keys(M.BLENDS).map((k) => [k, k[0].toUpperCase() + k.slice(1)]), L.blend)}
    ${SEL('matte', 'Track matte (layer above)', [['', 'None'], ['alpha', 'Alpha matte'], ['alphaInv', 'Alpha inverted'], ['luma', 'Luma matte'], ['lumaInv', 'Luma inverted']], L.matte)}
    <label class="mo-f" title="Parallax: how far away the layer is when the comp has a camera (0 = near, 300 = far)"><span>Depth (parallax)</span><span><input type="number" step="5" min="0" data-depth value="${Number.isFinite(+L.depth) ? L.depth : ''}" placeholder="off" class="mo-num"></span></label>
    <label class="mo-f"><span>In / Out (s)</span><span><input type="number" step="0.04" data-io="in" value="${+(L.in || 0).toFixed(2)}" class="mo-num"><input type="number" step="0.04" data-io="out" value="${+(L.out ?? c.dur).toFixed(2)}" class="mo-num"></span></label></div>`);
  h += sec('tr', 'Transform', [ROW(L, ['tr', 'anchor'], 'Anchor point', 'xy'), ROW(L, ['tr', 'position'], 'Position', 'xy'), ROW(L, ['tr', 'scale'], 'Scale %', 'xy'), ROW(L, ['tr', 'rotation'], 'Rotation °', 'n'), ROW(L, ['tr', 'opacity'], 'Opacity %', 'n')].join(''));
  if (L.type === 'text') {
    const t = L.text;
    h += sec('text', 'Text', `<textarea data-textarea rows="2" aria-label="Text">${esc(base(t.text, T))}</textarea>
      <div class="mo-grid">${SEL('text.font', 'Font', [['Nirmala UI', 'Nirmala UI (Hindi)'], ['Segoe UI', 'Segoe UI'], ['Arial', 'Arial'], ['Georgia', 'Georgia'], ['Impact', 'Impact'], ['Bahnschrift', 'Bahnschrift'], ['Mangal', 'Mangal (Hindi)'], ['Kokila', 'Kokila (Hindi)'], ['Consolas', 'Consolas']], t.font)}
      ${SEL('text.weight', 'Weight', [[300, 'Light'], [400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black']], t.weight)}
      ${SEL('text.align', 'Align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], t.align)}${CHK('text.italic', 'Italic', t.italic)}</div>
      ${ROW(L, ['text', 'size'], 'Size px', 'n')}${ROW(L, ['text', 'tracking'], 'Tracking', 'n', { step: 5 })}${ROW(L, ['text', 'fill'], 'Fill', 'color')}${ROW(L, ['text', 'stroke'], 'Stroke', 'color')}${ROW(L, ['text', 'strokeW'], 'Stroke width', 'n')}`);
    h += sec('anim', `Text animators (${(t.animators || []).length})`, (t.animators || []).map((a, i) => {
      const P = ['text', 'animators', i];
      return `<div class="mo-anim"><div class="mo-anim-h"><b>${esc(a.name || `Animator ${i + 1}`)}</b><span class="grow"></span><button class="icon-btn" data-adel="${i}" title="Remove">✕</button></div>
        <div class="muted small">Animate these to (where the selector is):</div>
        ${Object.keys(a.props || {}).map((k) => ROW(L, [...P, 'props', k], { position: 'Position', scale: 'Scale %', rotation: 'Rotation °', opacity: 'Opacity %', fill: 'Fill colour', blur: 'Blur' }[k] || k, k === 'position' ? 'xy' : k === 'fill' ? 'color' : 'n', { wiggle: false })).join('')}
        <div class="mo-grid">${SEL(`${P.join('.')}.addprop`, 'Add property', [['', 'Add…'], ['position', 'Position'], ['scale', 'Scale'], ['rotation', 'Rotation'], ['opacity', 'Opacity'], ['fill', 'Fill colour'], ['blur', 'Blur']].filter(([k]) => !k || !(k in (a.props || {}))), '')}</div>
        <div class="muted small">Range selector</div>
        ${ROW(L, [...P, 'range', 'start'], 'Start %', 'n', { wiggle: false })}${ROW(L, [...P, 'range', 'end'], 'End %', 'n', { wiggle: false })}${ROW(L, [...P, 'range', 'offset'], 'Offset %', 'n', { wiggle: false })}
        <div class="mo-grid">${SEL(`${P.join('.')}.range.by`, 'Based on', [['char', 'Characters'], ['word', 'Words'], ['line', 'Lines']], a.range?.by || 'char')}${SEL(`${P.join('.')}.range.shape`, 'Shape', [['square', 'Square'], ['rampUp', 'Ramp up'], ['rampDown', 'Ramp down'], ['triangle', 'Triangle'], ['smooth', 'Round']], a.range?.shape || 'square')}</div></div>`;
    }).join('') + `<div class="mo-grid">${SEL('addanim', 'Add', [['', 'Animator or preset…'], ['custom', 'Empty animator (Opacity)'], ...Object.entries(M.TEXT_ANIMS).filter(([k]) => k !== 'tracking').map(([k, p]) => [k, p.name])], '')}</div>`);
  }
  if (L.type === 'shape') {
    const s = L.shape;
    h += sec('shape', 'Shape', `<div class="mo-grid">${SEL('shape.kind', 'Kind', [['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['polygon', 'Polygon'], ['star', 'Star'], ['path', 'Pen path']], s.kind)}${CHK('shape.fillOn', 'Fill', s.fillOn !== false)}${s.kind === 'path' ? CHK('shape.closed', 'Closed', s.closed) : ''}</div>
      ${s.kind !== 'path' ? ROW(L, ['shape', 'size'], 'Size', 'xy') : ''}${s.kind === 'rect' ? ROW(L, ['shape', 'roundness'], 'Roundness', 'n') : ''}
      ${s.kind === 'polygon' || s.kind === 'star' ? ROW(L, ['shape', 'sides'], 'Points', 'n') : ''}${s.kind === 'star' ? ROW(L, ['shape', 'inner'], 'Inner radius', 'n', { step: 0.05 }) : ''}
      ${ROW(L, ['shape', 'fill'], 'Fill', 'color')}${ROW(L, ['shape', 'stroke'], 'Stroke', 'color')}${ROW(L, ['shape', 'strokeW'], 'Stroke width', 'n')}
      <div class="muted small">Trim paths (draw-on: animate End from 0 to 100)</div>
      ${ROW(L, ['shape', 'trimStart'], 'Start %', 'n')}${ROW(L, ['shape', 'trimEnd'], 'End %', 'n')}${ROW(L, ['shape', 'trimOffset'], 'Offset °', 'n')}`);
  }
  if (L.type === 'solid') h += sec('solid', 'Solid', ROW(L, ['solid', 'color'], 'Colour', 'color') + ROW(L, ['solid', 'size'], 'Size', 'xy'));
  if (L.type === 'video') h += sec('roto', 'Subject (AI roto)', `<div class="btn-grid"><button class="accent small" data-roto>${L.video.matte?.id ? 'Find again' : 'Cut out subject'}</button><button class="small" data-behind title="Text between the clip and its cut-out subject - in one click">🅣 Text behind subject</button><button class="small" data-parallax title="2.5D: the subject in front, text in the middle, the background behind, and a slow camera move">Parallax (2.5D)</button></div>
    ${L.video.matte?.id ? `<div class="mo-grid">${SEL('video.matte.mode', 'Show', [['cutout', 'Subject only'], ['background', 'Everything but the subject'], ['matte', 'The matte (black & white)']], L.video.matte.mode || 'cutout')}<label class="mo-f"><span>Blur edge px</span><input type="number" class="mo-num" min="0" max="30" step="0.5" data-msoft value="${+L.video.matte.soft || 0}"></label></div>
    <label class="pr"><span>Shrink (+) / grow (−) <i>edge in or out</i></span><input type="range" min="-40" max="40" step="1" data-mref="choke" value="${+L.video.matte.choke || 0}"><input type="number" class="pr-n" data-mrefn="choke" value="${+L.video.matte.choke || 0}"></label>
    <label class="pr"><span>Edge softness % <i>0 = hard</i></span><input type="range" min="0" max="100" step="1" data-mref="edge" value="${L.video.matte.edge ?? 100}"><input type="number" class="pr-n" data-mrefn="edge" value="${L.video.matte.edge ?? 100}"></label>
    <div class="muted small">Something wrong in places? Draw a mask on this layer and set it to <b>Subtract</b> to take it out. Adding missed parts: use the Nodes page's Subject Matte (add / remove inputs).</div><label class="chk small"><input type="checkbox" data-moff> Matte off (whole picture)</label>` : '<div class="muted small">The AI finds the person / animal / vehicle in every frame (GPU, a few seconds).</div>'}`)
    + sec('video', 'Video (from the edit)', `<div class="muted small">${esc(S.mediaById[L.video.mediaId]?.name || 'Missing media')}</div>
    <label class="mo-f"><span>Source start (s) / speed</span><span><input type="number" step="0.04" data-vv="in" value="${+(L.video.in || 0).toFixed(2)}" class="mo-num"><input type="number" step="0.05" min="0.1" data-vv="speed" value="${L.video.speed || 1}" class="mo-num"></span></label>
    <label class="mo-f"><span>Width / height</span><span><input type="number" data-vv="w" value="${L.video.w || 0}" class="mo-num"><input type="number" data-vv="h" value="${L.video.h || 0}" class="mo-num"></span></label>
    <small class="muted">Plays silent here - the sound stays with the clip on the edit. Mask it, track-matte it, animate it like any layer.</small>`);
  if (L.type === 'image') h += sec('image', 'Image', `<div class="mo-grid">${SEL('image.mediaId', 'Picture', S.media.filter((m) => m.kind === 'image').slice(0, 300).map((m) => [m.id, m.name]), L.image.mediaId)}</div>
    <label class="mo-f"><span>Width / height</span><span><input type="number" data-iv="w" value="${L.image.w || 0}" class="mo-num"><input type="number" data-iv="h" value="${L.image.h || 0}" class="mo-num"></span></label>`);
  h += sec('masks', `Masks (${(L.masks || []).length})`, (L.masks || []).map((m, i) => `<div class="mo-anim"><div class="mo-anim-h"><b>${esc(m.name)}</b>
      <select data-mmode="${i}">${[['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect']].map(([k, l]) => `<option value="${k}"${m.mode === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <label class="chk small"><input type="checkbox" data-minv="${i}"${m.inverted ? ' checked' : ''}>Inverted</label><span class="grow"></span><button class="icon-btn" data-mdel="${i}" title="Remove mask">✕</button></div>
      ${ROW(L, ['masks', i, 'feather'], 'Feather px', 'n', { wiggle: false })}${ROW(L, ['masks', i, 'opacity'], 'Opacity %', 'n', { wiggle: false })}${ROW(L, ['masks', i, 'expansion'], 'Expansion px', 'n', { wiggle: false })}</div>`).join('')
    + '<div class="muted small">Draw masks with the mask tools on the viewer toolbar.</div>');
  const FX = { blur: ['Gaussian blur', { amount: 10 }], shadow: ['Drop shadow', { color: '#000000', opacity: 60, distance: 12, angle: 135, softness: 20 }], glow: ['Glow', { radius: 30, intensity: 100 }], fill: ['Fill (colour)', { color: '#ff9933' }], brightness: ['Brightness', { amount: 130 }], saturation: ['Saturation', { amount: 150 }], hue: ['Hue shift', { amount: 90 }] };
  h += sec('fx', `Effects (${(L.effects || []).length})`, (L.effects || []).map((f, i) => `<div class="mo-anim"><div class="mo-anim-h"><label class="chk"><input type="checkbox" data-fxon="${i}"${f.off ? '' : ' checked'}> <b>${FX[f.type]?.[0] || f.type}</b></label><span class="grow"></span><button class="icon-btn" data-fxdel="${i}" title="Remove effect">✕</button></div>
      ${Object.keys(FX[f.type]?.[1] || {}).map((k) => (k === 'color' ? (f.type === 'fill' ? `<label class="mo-f"><span>Colour</span><input type="color" data-fxc="${i}" value="${f.color || '#ffffff'}"></label>` : ROW(L, ['effects', i, k], 'Colour', 'color')) : ROW(L, ['effects', i, k], { amount: 'Amount', opacity: 'Opacity %', distance: 'Distance', angle: 'Angle °', softness: 'Softness', radius: 'Radius', intensity: 'Intensity %' }[k] || k, 'n', { wiggle: false }))).join('')}</div>`).join('')
    + `<div class="mo-grid">${SEL('addfx', 'Add', [['', 'Effect…'], ...Object.entries(FX).map(([k, [l]]) => [k, l])], '')}</div>`);
  el.innerHTML = `${h}</div>`;
  wireProps(el, L, FX);
}
// while dragging / playing: only the numbers change
function renderPropsValues() {
  const L = one(); if (!L || !root) return;
  $$('#moProps [data-pv]', root).forEach((i) => {
    if (document.activeElement === i) return;
    const v = val(M.getIn(L, i.dataset.pv.split('.').map((x) => (/^\d+$/.test(x) ? +x : x))), T);
    if (i.type === 'color') i.value = v || '#ffffff'; else i.value = +(+(i.dataset.i >= 0 ? v?.[+i.dataset.i] : v) || 0).toFixed(2);
  });
  $$('#moProps [data-key]', root).forEach((b) => b.classList.toggle('on', M.keyAt(M.getIn(L, pathOf(b.dataset.key)), T) >= 0));
}
const pathOf = (P) => P.split('.').map((x) => (/^\d+$/.test(x) ? +x : x));
function wireProps(el, L, FX) {
  $$('details.mo-sec', el).forEach((d) => d.addEventListener('toggle', () => (d.open ? openSecs.add(d.dataset.sec) : openSecs.delete(d.dataset.sec))));
  const nm = $('[data-name]', el); if (nm) nm.onchange = (e) => { L.name = e.target.value.trim() || L.name; save('Rename layer'); };
  const ta = $('[data-textarea]', el);
  if (ta) { ta.oninput = () => { L.text.text = M.setVal(L.text.text, T, ta.value); draw(); }; ta.onchange = () => save('Edit text', `txt-${L.id}`); }
  $$('[data-pv]', el).forEach((i) => {
    const path = pathOf(i.dataset.pv);
    const set = () => {
      const p = M.getIn(L, path), cur = val(p, T);
      let v = i.type === 'color' ? i.value : +i.value;
      if (i.dataset.i >= 0) { const arr = [...(base(p, T) || cur || [0, 0])]; arr[+i.dataset.i] = v; v = arr; }
      M.setIn(L, path, M.setVal(p, T, v));
    };
    i.oninput = () => { set(); draw(); };
    i.onchange = () => { set(); save('Change property', `pv-${L.id}-${i.dataset.pv}`); };
    // scrub: drag on a number left / right (AE's hot text)
    if (i.type === 'number') i.addEventListener('pointerdown', (e) => {
      if (document.activeElement === i) return;
      const x0 = e.clientX, v0 = +i.value, st = +(i.step || 1); let moved = false;
      const mv = (ev) => { const d = Math.round((ev.clientX - x0) / 2) * st * (ev.shiftKey ? 10 : 1); if (d) moved = true; i.value = +(v0 + d).toFixed(2); set(); draw(); };
      const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); if (moved) { save('Change property', `pv-${L.id}-${i.dataset.pv}`); } else i.focus(); };
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up); e.preventDefault();
    });
  });
  $$('[data-sw]', el).forEach((b) => (b.onclick = () => { const path = pathOf(b.dataset.sw); M.setIn(L, path, M.stopwatch(M.getIn(L, path), T)); graphPath = b.dataset.sw; save(animated(M.getIn(L, path)) ? 'Animate property' : 'Stop animating'); }));
  $$('[data-key]', el).forEach((b) => (b.onclick = () => { const path = pathOf(b.dataset.key), p = M.getIn(L, path); M.setIn(L, path, M.keyAt(p, T) >= 0 ? M.delKey(p, T) : M.setKey(p, T, base(p, T))); save('Keyframe'); }));
  $$('[data-glab]', el).forEach((s) => (s.onclick = () => { graphPath = s.dataset.glab; if (animated(M.getIn(L, pathOf(graphPath)))) { graphOn = true; } refresh(); }));
  $$('[data-wig]', el).forEach((b) => (b.onclick = () => {
    const path = pathOf(b.dataset.wig), p = M.getIn(L, path), w = p && typeof p === 'object' && !Array.isArray(p) ? p.wiggle : null;
    if (w) { M.setIn(L, path, M.setWiggle(p, T, null)); return save('Remove wiggle'); }
    const r = prompt('Wiggle: how many times a second, how much (e.g. "2, 30")', '2, 30'); if (!r) return;
    const [freq, amp] = r.split(/[,\s]+/).map(Number); M.setIn(L, path, M.setWiggle(p, T, { freq: freq || 2, amp: amp || 10 })); save('Wiggle');
  }));
  $$('[data-sv]', el).forEach((s) => (s.onchange = () => {
    const k = s.dataset.sv, v = s.value;
    if (k === 'addanim') { if (!v) return; const a = v === 'custom' ? { name: `Animator ${(L.text.animators || []).length + 1}`, props: { opacity: 0 }, range: { by: 'char', shape: 'square', start: 0, end: 100, offset: 0 } } : M.TEXT_ANIMS[v].make(Math.min(2, comp().dur / 2)); if (v !== 'custom') shiftAnim(a, T); (L.text.animators ||= []).push(a); openSecs.add('anim'); return save('Add text animator'); }
    if (k === 'addfx') { if (!v) return; (L.effects ||= []).push({ type: v, ...JSON.parse(JSON.stringify(FX[v][1])) }); openSecs.add('fx'); return save('Add effect'); }
    if (k.endsWith('.addprop')) { if (!v) return; const a = M.getIn(L, pathOf(k.replace(/\.addprop$/, ''))); (a.props ||= {})[v] = { position: [0, 0], scale: 100, rotation: 0, opacity: 0, fill: '#ff9933', blur: 10 }[v]; return save('Animator property'); }
    const path = pathOf(k), num = ['text.weight'].includes(k);
    M.setIn(L, path, k === 'parent' || k === 'matte' ? (v || null) : num ? +v : v);
    if (k === 'parent' && v) reparent(L, v);
    save(`Layer ${k}`);
  }));
  $$('[data-cv]', el).forEach((c) => (c.onchange = () => { M.setIn(L, pathOf(c.dataset.cv), c.checked); save('Layer option'); }));
  $$('[data-io]', el).forEach((i) => (i.onchange = () => { L[i.dataset.io] = clamp(+i.value || 0, 0, comp().dur); if (L.out <= L.in) L.out = Math.min(comp().dur, L.in + 0.1); save('Layer in / out'); }));
  $$('[data-iv]', el).forEach((i) => (i.onchange = () => { L.image[i.dataset.iv] = Math.max(1, +i.value || 1); save('Image size'); }));
  $('[data-roto]', el)?.addEventListener('click', () => findSubject(L));
  $('[data-parallax]', el)?.addEventListener('click', () => parallax(L));
  $('[data-depth]', el)?.addEventListener('change', (e) => { const v = e.target.value.trim(); if (v === '') delete L.depth; else { L.depth = Math.max(0, +v || 0); comp().camera ||= { pos: [0, 0], zoom: 1 }; } save('Layer depth'); });
  $('[data-behind]', el)?.addEventListener('click', () => textBehind(L));
  $('[data-msoft]', el)?.addEventListener('change', (e) => { L.video.matte.soft = Math.max(0, +e.target.value || 0); save('Matte soft edge'); });
  $$('[data-mref]', el).forEach((r) => { const k = r.dataset.mref; r.oninput = () => { L.video.matte[k] = +r.value; $(`[data-mrefn="${k}"]`, el).value = r.value; draw(); }; r.onchange = () => save(`Matte ${k}`, `mref-${L.id}-${k}`); });
  $$('[data-mrefn]', el).forEach((n) => (n.onchange = () => { L.video.matte[n.dataset.mrefn] = +n.value; save(`Matte ${n.dataset.mrefn}`); }));
  $('[data-moff]', el)?.addEventListener('change', () => { delete L.video.matte; save('Matte off'); });
  $$('[data-vv]', el).forEach((i) => (i.onchange = () => { const k = i.dataset.vv; L.video[k] = k === 'in' ? Math.max(0, +i.value || 0) : Math.max(k === 'speed' ? 0.1 : 1, +i.value || 1); save('Video layer'); }));
  $$('[data-adel]', el).forEach((b) => (b.onclick = () => { L.text.animators.splice(+b.dataset.adel, 1); save('Remove animator'); }));
  $$('[data-mdel]', el).forEach((b) => (b.onclick = () => { L.masks.splice(+b.dataset.mdel, 1); save('Remove mask'); }));
  $$('[data-mmode]', el).forEach((s) => (s.onchange = () => { L.masks[+s.dataset.mmode].mode = s.value; save('Mask mode'); }));
  $$('[data-minv]', el).forEach((c) => (c.onchange = () => { L.masks[+c.dataset.minv].inverted = c.checked; save('Mask inverted'); }));
  $$('[data-fxdel]', el).forEach((b) => (b.onclick = () => { L.effects.splice(+b.dataset.fxdel, 1); save('Remove effect'); }));
  $$('[data-fxon]', el).forEach((c) => (c.onchange = () => { L.effects[+c.dataset.fxon].off = !c.checked; save('Effect on / off'); }));
  $$('[data-fxc]', el).forEach((c) => (c.onchange = () => { L.effects[+c.dataset.fxc].color = c.value; save('Effect colour'); }));
}
// parenting keeps the child where it is on screen (its position becomes relative to the parent)
function reparent(L, pid) {
  const c = comp(), P = c.layers.find((x) => x.id === pid); if (!P) return;
  let a = P; for (let i = 0; a && i < 30; i++) { if (a.parent === L.id) { L.parent = null; return toast('That would make a loop of parents', 'err'); } a = c.layers.find((x) => x.id === a.parent); }
  if (animated(L.tr.position)) return;
  const L2 = { ...L, parent: null }, here = M.apply(M.worldMatrix(c, L2, T), base(L.tr.anchor, T) || [0, 0]);
  const loc = M.apply(M.invert(M.worldMatrix(c, P, T)), here);
  L.tr.position = loc.map((v) => +v.toFixed(1));
}

// ---------------- timeline ----------------
const ROWH = 24, HEAD = 22;
// After Effects-style layer outline: twirl a layer open for its property groups, a group for its properties; every
// property row has its stopwatch, value and keyframe navigator, and its keyframes sit on the same row on the right.
// P / S / R / T / A / U (with layers selected) show only Position / Scale / Rotation / Opacity / Anchor / animated, like AE.
const openLayers = new Set(), closedGroups = new Set(); // groups are open unless closed (key: layerId:group)
let propSolo = null, tlSearch = '';
const LABELS = ['#b53838', '#e4d84c', '#a9cbc7', '#e5bcc9', '#a9a9ca', '#e7c19e', '#b3c7b3', '#677de0', '#4aa44c', '#8e2c9a', '#e8920d', '#7f452a', '#f46dd6', '#3da2a5', '#a8956c', '#1e401e'];
const labelOf = (L) => LABELS[L.label ?? { text: 7, shape: 8, solid: 0, image: 6, video: 13, null: 4 }[L.type] ?? 2];
function propsOf(L) { // [{ g: group name, items: [{ path, label, kind }] }]
  const P = (path, label, kind = 'n') => ({ path, label, kind });
  const out = [{ g: 'Transform', items: [P(['tr', 'anchor'], 'Anchor Point', 'xy'), P(['tr', 'position'], 'Position', 'xy'), P(['tr', 'scale'], 'Scale', 'xy'), P(['tr', 'rotation'], 'Rotation'), P(['tr', 'opacity'], 'Opacity')] }];
  if (L.type === 'text') {
    out.unshift({ g: 'Text', items: [P(['text', 'size'], 'Font Size'), P(['text', 'tracking'], 'Tracking'), P(['text', 'fill'], 'Fill Color', 'color'), P(['text', 'stroke'], 'Stroke Color', 'color'), P(['text', 'strokeW'], 'Stroke Width')] });
    (L.text.animators || []).forEach((an, i) => out.splice(1 + i, 0, { g: an.name || `Animator ${i + 1}`, items: [...Object.keys(an.props || {}).map((k) => P(['text', 'animators', i, 'props', k], { position: 'Position', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity', fill: 'Fill Color', blur: 'Blur' }[k] || k, k === 'position' ? 'xy' : k === 'fill' ? 'color' : 'n')),
      P(['text', 'animators', i, 'range', 'start'], 'Range Start'), P(['text', 'animators', i, 'range', 'end'], 'Range End'), P(['text', 'animators', i, 'range', 'offset'], 'Range Offset')] }));
  }
  if (L.type === 'shape') out.unshift({ g: 'Contents', items: [...(L.shape.kind !== 'path' ? [P(['shape', 'size'], 'Size', 'xy')] : []), ...(L.shape.kind === 'rect' ? [P(['shape', 'roundness'], 'Roundness')] : []), ...(['polygon', 'star'].includes(L.shape.kind) ? [P(['shape', 'sides'], 'Points')] : []),
    P(['shape', 'fill'], 'Fill Color', 'color'), P(['shape', 'stroke'], 'Stroke Color', 'color'), P(['shape', 'strokeW'], 'Stroke Width'), P(['shape', 'trimStart'], 'Trim Start'), P(['shape', 'trimEnd'], 'Trim End'), P(['shape', 'trimOffset'], 'Trim Offset')] });
  if (L.type === 'solid') out.unshift({ g: 'Solid', items: [P(['solid', 'color'], 'Color', 'color'), P(['solid', 'size'], 'Size', 'xy')] });
  if ((L.masks || []).length) out.unshift({ g: 'Masks', items: L.masks.flatMap((m, i) => [P(['masks', i, 'feather'], `${m.name} Feather`), P(['masks', i, 'opacity'], `${m.name} Opacity`), P(['masks', i, 'expansion'], `${m.name} Expansion`)]) });
  if ((L.effects || []).length) out.push({ g: 'Effects', items: L.effects.flatMap((f, i) => Object.keys(f).filter((k) => !['type', 'off', 'color'].includes(k)).map((k) => P(['effects', i, k], `${f.type} ${k}`))) });
  return out;
}
const SOLO = { p: [['tr', 'position']], s: [['tr', 'scale']], r: [['tr', 'rotation']], t: [['tr', 'opacity']], a: [['tr', 'anchor']] };
function rowsOf() {
  const c = comp(); if (!c) return [];
  const out = [], q = tlSearch.trim().toLowerCase();
  c.layers.forEach((L, n) => {
    if (q && !L.name.toLowerCase().includes(q)) return;
    out.push({ L, n: n + 1 });
    const all = propsOf(L).flatMap((g) => g.items);
    const prop = (it) => { const p = M.getIn(L, it.path); return { L, prop: it.path, label: it.label, kind: it.kind, keys: animated(p) ? p.k : [] }; };
    if (propSolo && selIds.has(L.id)) { // AE's P / S / R / T / A / U
      const items = propSolo === 'u' ? all.filter((it) => animated(M.getIn(L, it.path))) : all.filter((it) => SOLO[propSolo].some((p) => p.join('.') === it.path.join('.')));
      items.forEach((it) => out.push(prop(it)));
      return;
    }
    if (!openLayers.has(L.id)) return;
    for (const g of propsOf(L)) {
      const gk = `${L.id}:${g.g}`;
      out.push({ L, group: g.g, gk, open: !closedGroups.has(gk) });
      if (!closedGroups.has(gk)) g.items.forEach((it) => out.push(prop(it)));
    }
  });
  return out;
}
const propName = (p) => p.filter((x) => typeof x === 'string').slice(-2).join(' › ').replace(/^tr › /, '');
const vnum = (v, P, i) => `<input type="number" class="mo-num tl-num" data-tv="${P}" data-i="${i}" step="${/scale|opacity|size|tracking|width|stroke|trim|range|feather|expansion/i.test(P) ? 1 : 0.5}" value="${+(+v || 0).toFixed(1)}">`;
function renderLHead() {
  const el = $('#moLHead', root), c = comp();
  $('#moTlName', root).textContent = c ? `Timeline - ${c.name}` : 'Timeline';
  if (!c) { el.innerHTML = ''; return; }
  const parents = (L) => `<option value="">None</option>${c.layers.filter((x) => x.id !== L.id).map((x) => `<option value="${x.id}"${x.id === L.parent ? ' selected' : ''}>${c.layers.indexOf(x) + 1}. ${esc(x.name)}</option>`).join('')}`;
  const modes = (L) => Object.keys(M.BLENDS).map((k) => `<option value="${k}"${k === (L.blend || 'normal') ? ' selected' : ''}>${k[0].toUpperCase()}${k.slice(1)}</option>`).join('');
  const mats = (L) => [['', 'None'], ['alpha', 'Alpha'], ['alphaInv', 'Alpha Inv'], ['luma', 'Luma'], ['lumaInv', 'Luma Inv']].map(([k, l]) => `<option value="${k}"${k === (L.matte || '') ? ' selected' : ''}>${l}</option>`).join('');
  el.innerHTML = `<div class="ae-top" style="height:${HEAD}px"><span class="ae-tc">${tc(T)}</span><input type="search" class="ae-search" data-tlsearch placeholder="Search layers" value="${esc(tlSearch)}">${propSolo ? `<span class="tag" title="Esc shows everything">${propSolo.toUpperCase()} only</span>` : ''}</div>`
    + '<div class="ae-row ae-hdr"><span class="ae-av">' + ic('eye') + ' </span><span class="ae-n">#</span><span class="ae-name">Source Name</span><span class="ae-fx">fx</span><span class="ae-mode">Mode</span><span class="ae-mat">TrkMat</span><span class="ae-par">Parent &amp; Link</span></div>'
    + rowsOf().map((r) => {
      const L = r.L, sel = selIds.has(L.id);
      if (r.group !== undefined) return `<div class="ae-row ae-grp" data-gk="${esc(r.gk)}" data-lid="${L.id}"><span class="ae-tw">${r.open ? '▾' : '›'}</span>${esc(r.group)}</div>`;
      if (r.prop) {
        const P = r.prop.join('.'), p = M.getIn(L, r.prop), on = animated(p), v = val(p, T), k = M.keyAt(p, T) >= 0;
        const input = r.kind === 'color' ? `<input type="color" class="tl-col" data-tv="${P}" value="${v || '#ffffff'}">` : r.kind === 'xy' ? (v || [0, 0]).map((x, i) => vnum(x, P, i)).join('') : vnum(v, P, -1);
        return `<div class="ae-row ae-prop${graphPath === P && sel ? ' gsel' : ''}" data-lid="${L.id}" data-gprop="${P}"><button class="mo-sw${on ? ' on' : ''}" data-tsw="${P}" title="Stopwatch">${ic('clock')}</button><span class="ae-pname" title="Click: graph it in the Graph Editor">${esc(r.label)}</span><span class="ae-pv">${input}</span>`
          + (on ? `<span class="ae-nav"><button data-tnav="-1" data-p="${P}" title="Previous keyframe">${ic('prev')}</button><button class="${k ? 'on' : ''}" data-tkey="${P}" title="Add / remove keyframe">${ic('diamond')}</button><button data-tnav="1" data-p="${P}" title="Next keyframe">${ic('next')}</button></span>` : '<span class="ae-nav"></span>') + '</div>';
      }
      const isMatte = c.layers[c.layers.indexOf(L) + 1]?.matte;
      return `<div class="ae-row ae-layer${sel ? ' on' : ''}" data-lid="${L.id}" draggable="true">`
        + `<span class="ae-av"><button class="mo-ib${L.hidden ? '' : ' on'}" data-vis="${L.id}" title="Video (show / hide)">${ic('eye')}</button><button class="mo-ib${L.solo ? ' on' : ''}" data-solo="${L.id}" title="Solo">${ic('radio')}</button><button class="mo-ib${L.locked ? ' on' : ''}" data-lock="${L.id}" title="Lock">${ic('lock')}</button></span>`
        + `<span class="ae-n"><i class="ae-lab" data-lab="${L.id}" style="background:${labelOf(L)}" title="Label colour (click to change)"></i>${r.n}</span>`
        + `<span class="ae-name"><span class="ae-tw" data-tw="${L.id}">${openLayers.has(L.id) ? '▾' : '›'}</span><span class="ae-ln" data-ren="${L.id}" title="Double-click to rename">${esc(L.name)}</span>${isMatte ? ' <i class="muted">(matte)</i>' : ''}</span>`
        + `<span class="ae-fx"><button class="mo-ib${(L.effects || []).some((f) => !f.off) ? ' on' : ''}" data-fxall="${L.id}" title="Effects on / off">fx</button></span>`
        + `<span class="ae-mode"><select data-tsel="blend" data-l="${L.id}">${modes(L)}</select></span>`
        + `<span class="ae-mat"><select data-tsel="matte" data-l="${L.id}">${mats(L)}</select></span>`
        + `<span class="ae-par"><select data-tsel="parent" data-l="${L.id}">${parents(L)}</select></span></div>`;
    }).join('');
  wireLHead(el, c);
}
function wireLHead(el, c) {
  const srch = $('[data-tlsearch]', el);
  srch.oninput = () => { tlSearch = srch.value; renderLHead(); drawTl(); const s2 = $('[data-tlsearch]', el); s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); };
  $$('.ae-row[data-lid]', el).forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest('button, input, select')) return;
      if (row.dataset.gk) { closedGroups.has(row.dataset.gk) ? closedGroups.delete(row.dataset.gk) : closedGroups.add(row.dataset.gk); renderLHead(); drawTl(); return; }
      if (row.dataset.gprop) { graphPath = row.dataset.gprop; selIds = new Set([row.dataset.lid]); return refresh(); }
      if (e.shiftKey || e.ctrlKey) selIds.has(row.dataset.lid) ? selIds.delete(row.dataset.lid) : selIds.add(row.dataset.lid); else selIds = new Set([row.dataset.lid]);
      refresh();
    };
    if (row.classList.contains('ae-layer')) {
      row.ondragstart = (e) => e.dataTransfer.setData('text/mo-layer', row.dataset.lid);
      row.ondragover = (e) => e.preventDefault();
      row.ondrop = (e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/mo-layer'), Ls = comp().layers, a = Ls.findIndex((x) => x.id === id), b = Ls.findIndex((x) => x.id === row.dataset.lid); if (a < 0 || b < 0 || a === b) return; const [x] = Ls.splice(a, 1); Ls.splice(b, 0, x); save('Reorder layers'); };
    }
  });
  $$('[data-tw]', el).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const id = b.dataset.tw; openLayers.has(id) ? openLayers.delete(id) : openLayers.add(id); propSolo = null; renderLHead(); drawTl(); }));
  $$('[data-ren]', el).forEach((s) => (s.ondblclick = (e) => { e.stopPropagation(); const L = layer(s.dataset.ren), n = prompt('Layer name', L.name)?.trim(); if (n) { L.name = n; save('Rename layer'); } }));
  $$('[data-lab]', el).forEach((s) => (s.onclick = (e) => { e.stopPropagation(); const L = layer(s.dataset.lab); L.label = (LABELS.indexOf(labelOf(L)) + 1) % LABELS.length; save('Label colour'); }));
  const tog = (attr, key, label) => $$(`[data-${attr}]`, el).forEach((b) => (b.onclick = () => { const L = layer(b.dataset[attr]); L[key] = !L[key]; save(label); }));
  tog('vis', 'hidden', 'Show / hide layer'); tog('solo', 'solo', 'Solo'); tog('lock', 'locked', 'Lock layer');
  $$('[data-fxall]', el).forEach((b) => (b.onclick = () => { const L = layer(b.dataset.fxall); if (!(L.effects || []).length) return toast('No effects on this layer - add them in Properties'); const on = L.effects.some((f) => !f.off); L.effects.forEach((f) => (f.off = on)); save('Effects on / off'); }));
  $$('[data-tsel]', el).forEach((s) => (s.onchange = () => { const L = layer(s.dataset.l), k = s.dataset.tsel; L[k] = s.value || (k === 'blend' ? 'normal' : null); if (k === 'parent' && s.value) reparent(L, s.value); save(`Layer ${k}`); }));
  // property values: type, or drag left / right on a number (AE's hot text)
  $$('[data-tv]', el).forEach((i) => {
    const L = layer(i.closest('[data-lid]').dataset.lid), path = pathOf(i.dataset.tv);
    const set = () => { const p = M.getIn(L, path); let v = i.type === 'color' ? i.value : +i.value; if (i.dataset.i >= 0) { const arr = [...(base(p, T) || val(p, T) || [0, 0])]; arr[+i.dataset.i] = v; v = arr; } M.setIn(L, path, M.setVal(p, T, v)); };
    i.oninput = () => { set(); draw(); };
    i.onchange = () => { set(); save('Change property', `tl-${L.id}-${i.dataset.tv}`); };
    if (i.type === 'number') i.addEventListener('pointerdown', (e) => {
      if (document.activeElement === i) return;
      const x0 = e.clientX, v0 = +i.value, st = +(i.step || 1); let moved = false;
      const mv = (ev) => { const d = Math.round((ev.clientX - x0) / 2) * st * (ev.shiftKey ? 10 : 1); if (d) moved = true; i.value = +(v0 + d).toFixed(2); set(); draw(); };
      const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); if (moved) save('Change property', `tl-${L.id}-${i.dataset.tv}`); else { i.focus(); i.select(); } };
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up); e.preventDefault();
    });
  });
  $$('[data-tsw]', el).forEach((b) => (b.onclick = () => { const L = layer(b.closest('[data-lid]').dataset.lid), path = pathOf(b.dataset.tsw); M.setIn(L, path, M.stopwatch(M.getIn(L, path), T)); graphPath = b.dataset.tsw; save(animated(M.getIn(L, path)) ? 'Animate property' : 'Stop animating'); }));
  $$('[data-tkey]', el).forEach((b) => (b.onclick = () => { const L = layer(b.closest('[data-lid]').dataset.lid), path = pathOf(b.dataset.tkey), p = M.getIn(L, path); M.setIn(L, path, M.keyAt(p, T) >= 0 ? M.delKey(p, T) : M.setKey(p, T, base(p, T))); save('Keyframe'); }));
  $$('[data-tnav]', el).forEach((b) => (b.onclick = () => { const L = layer(b.closest('[data-lid]').dataset.lid), p = M.getIn(L, pathOf(b.dataset.p)), d = +b.dataset.tnav, ks = (p.k || []).map((k) => k.t); const t = d > 0 ? ks.find((x) => x > T + 1e-4) : [...ks].reverse().find((x) => x < T - 1e-4); if (t !== undefined) seek(t); }));
}
function tlGeom() {
  const cv = $('#moTlCanvas', root), box = $('#moLanes', root), c = comp();
  return { cv, box, c, W: box.clientWidth, x: (t) => 8 + (t / (c?.dur || 1)) * (box.clientWidth - 16), t: (x) => ((x - 8) / (box.clientWidth - 16)) * (c?.dur || 1) };
}
function drawTl() {
  if (!root) return;
  const G = tlGeom(), { cv, box, c } = G, rows = rowsOf();
  const H = graphOn ? Math.max(box.clientHeight, 120) : Math.max(box.clientHeight, HEAD + ROWH + rows.length * ROWH + 4);
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.style.width = `${G.W}px`; cv.style.height = `${H}px`; cv.width = Math.round(G.W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, G.W, H);
  if (!c) return;
  // ruler
  g.fillStyle = '#15171c'; g.fillRect(0, 0, G.W, HEAD);
  g.fillStyle = '#8a93a3'; g.font = '10px Consolas, monospace'; g.textBaseline = 'middle';
  const step = c.dur > 20 ? 5 : c.dur > 8 ? 1 : 0.5;
  for (let s = 0; s <= c.dur + 1e-6; s += step) { const x = G.x(s); g.fillRect(x, HEAD - 6, 1, 6); g.fillText(`${+s.toFixed(1)}s`, x + 3, 9); }
  if (graphOn) drawGraph(g, G, H);
  else rows.forEach((r, i) => {
    const y = HEAD + ROWH + i * ROWH; // (under the ruler: the row that matches the column header on the left)
    g.fillStyle = i % 2 ? '#14161b' : '#111318'; g.fillRect(0, y, G.W, ROWH);
    if (r.group !== undefined) { g.fillStyle = '#ffffff06'; g.fillRect(0, y, G.W, ROWH); return; }
    if (!r.prop) {
      const a = G.x(r.L.in || 0), b = G.x(r.L.out ?? c.dur), on = selIds.has(r.L.id);
      g.fillStyle = r.L.hidden ? '#3a3f4a' : labelOf(r.L);
      g.globalAlpha = on ? 0.95 : 0.6; g.fillRect(a, y + 4, b - a, ROWH - 8); g.globalAlpha = 1;
      if (on) { g.strokeStyle = '#fff'; g.strokeRect(a + 0.5, y + 4.5, b - a - 1, ROWH - 9); }
      // keyframe ticks of all properties, faint
      g.fillStyle = '#ffffff88';
      for (const k of M.layerKeys(r.L).flatMap((x) => x.keys)) g.fillRect(G.x(k.t) - 1, y + ROWH - 7, 2, 3);
    } else {
      for (const k of r.keys) {
        const x = G.x(k.t), cy = y + ROWH / 2, s = 5, isSel = selKey && selKey.lid === r.L.id && selKey.path === r.prop.join('.') && Math.abs(selKey.t - k.t) < 1e-4;
        g.fillStyle = isSel ? '#ffcc33' : '#d8dde6'; g.beginPath();
        if (k.hold) { g.rect(x - s, cy - s, s * 2, s * 2); }
        else if (k.e && (k.e[0] !== 0 || k.e[1] !== 0 || k.e[2] !== 1 || k.e[3] !== 1)) { g.arc(x, cy, s, 0, Math.PI * 2); } // eased: round
        else { g.moveTo(x, cy - s); g.lineTo(x + s, cy); g.lineTo(x, cy + s); g.lineTo(x - s, cy); g.closePath(); }
        g.fill();
      }
    }
  });
  // playhead
  const px = G.x(T); g.fillStyle = '#ff9933'; g.fillRect(px - 0.5, 0, 1.5, H); g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 7); g.fill();
}
// 📈 graph editor: the value of the chosen property over time; drag keys (time / value) and the yellow ease handles
function graphTarget() {
  const L = one(); if (!L) return null;
  let P = graphPath && pathOf(graphPath), p = P && M.getIn(L, P);
  if (!animated(p)) { const r = M.layerKeys(L)[0]; if (!r) return null; P = r.path; p = M.getIn(L, P); graphPath = P.join('.'); }
  return { L, P, p };
}
function graphMap(G, H, p) {
  const comps2 = Array.isArray(p.k[0].v) ? p.k[0].v.length : 1, vs = [];
  for (let i = 0; i <= 120; i++) { const v = val({ k: p.k }, (i / 120) * G.c.dur); (Array.isArray(v) ? v : [v]).forEach((x) => typeof x === 'number' && vs.push(x)); }
  let lo = Math.min(...vs), hi = Math.max(...vs); if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  return { n: comps2, y: (v) => HEAD + 10 + (1 - (v - lo) / (hi - lo)) * (H - HEAD - 20), v: (y) => lo + (1 - (y - HEAD - 10) / (H - HEAD - 20)) * (hi - lo) };
}
function drawGraph(g, G, H) {
  const tg = graphTarget();
  g.fillStyle = '#0d0e12'; g.fillRect(0, HEAD, G.W, H - HEAD);
  if (!tg) { g.fillStyle = '#8a93a3'; g.font = '12px Segoe UI'; g.fillText('Select a layer with keyframes (on a property) - click a property name to graph it.', 12, HEAD + 24); return; }
  const { p } = tg, Mp = graphMap(G, H, p), cols = ['#ff6b6b', '#5ad65a', '#5aa0ff', '#ffcc33'];
  g.fillStyle = '#8a93a3'; g.font = '11px Segoe UI'; g.fillText(`${tg.L.name} › ${propName(tg.P)}  (drag keys; yellow handles shape the ease)`, 10, HEAD + 12);
  for (let ci = 0; ci < Mp.n; ci++) {
    g.strokeStyle = Mp.n > 1 ? cols[ci] : '#ff9933'; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i <= 300; i++) { const t = (i / 300) * G.c.dur, v = val({ k: p.k }, t), x = G.x(t), y = Mp.y(Array.isArray(v) ? v[ci] : v); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  }
  // keys + ease handles (on the first value)
  const K = p.k, first = (v) => (Array.isArray(v) ? v[0] : v);
  K.forEach((k, i) => {
    const x = G.x(k.t), y = Mp.y(first(k.v));
    if (i < K.length - 1 && !k.hold && typeof first(k.v) === 'number') {
      const b = K[i + 1], e = k.e || EASE.linear, dv = first(b.v) - first(k.v), x1 = G.x(k.t + e[0] * (b.t - k.t)), y1 = Mp.y(first(k.v) + e[1] * dv), x2 = G.x(k.t + e[2] * (b.t - k.t)), y2 = Mp.y(first(k.v) + e[3] * dv);
      g.strokeStyle = '#ffd40088'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x1, y1); g.moveTo(G.x(b.t), Mp.y(first(b.v))); g.lineTo(x2, y2); g.stroke();
      g.fillStyle = '#ffd400'; g.beginPath(); g.arc(x1, y1, 4, 0, 7); g.arc(x2, y2, 4, 0, 7); g.fill();
    }
    g.fillStyle = '#fff'; g.fillRect(x - 4, y - 4, 8, 8);
  });
}
function wireTimeline() {
  const lanes = $('#moLanes', root);
  let td = null;
  lanes.addEventListener('pointerdown', (e) => {
    const c = comp(); if (!c) return;
    const r = lanes.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top + lanes.scrollTop, G = tlGeom();
    lanes.setPointerCapture(e.pointerId);
    if (y < HEAD) { td = { mode: 'scrub' }; seek(G.t(x)); return; }
    if (graphOn) return graphDown(e, x, y, G);
    const rows = rowsOf(), row = rows[Math.floor((y - HEAD - ROWH) / ROWH)];
    if (!row) { td = { mode: 'scrub' }; seek(G.t(x)); return; }
    if (row.prop) { // a keyframe?
      const k = row.keys.find((q) => Math.abs(G.x(q.t) - x) < 7);
      if (k) { selKey = { lid: row.L.id, path: row.prop.join('.'), t: k.t }; td = { mode: 'key', row, k, t0: k.t, x0: x }; drawTl(); return; }
      td = { mode: 'scrub' }; seek(G.t(x)); return;
    }
    if (!selIds.has(row.L.id)) { selIds = new Set([row.L.id]); refresh(); }
    if (row.L.locked) return;
    const a = G.x(row.L.in || 0), b = G.x(row.L.out ?? c.dur);
    td = { mode: Math.abs(x - a) < 6 ? 'in' : Math.abs(x - b) < 6 ? 'out' : x > a && x < b ? 'bar' : 'scrub', L: row.L, in0: row.L.in || 0, out0: row.L.out ?? c.dur, x0: x };
    if (td.mode === 'scrub') seek(G.t(x));
  });
  lanes.addEventListener('pointermove', (e) => {
    const r = lanes.getBoundingClientRect(), x = e.clientX - r.left, G = tlGeom(), c = comp();
    if (!td) { lanes.style.cursor = ''; return; }
    if (td.mode === 'scrub') return seek(G.t(x));
    if (td.mode === 'graph') return graphMove(e, x, e.clientY - r.top, G);
    const dt = snapT(G.t(x) - G.t(td.x0));
    if (td.mode === 'key') { const nt = snapT(clamp(td.t0 + dt, 0, c.dur)); if (!td.row.keys.some((q) => q !== td.k && Math.abs(q.t - nt) < 1e-4)) { td.k.t = nt; td.row.keys.sort((a, b) => a.t - b.t); selKey.t = nt; td.moved = true; } draw(); drawTl(); return; }
    if (td.mode === 'bar') { const d = clamp(dt, -td.in0, c.dur - td.out0); td.L.in = +(td.in0 + d).toFixed(3); td.L.out = +(td.out0 + d).toFixed(3); }
    if (td.mode === 'in') td.L.in = +clamp(td.in0 + dt, 0, td.out0 - 0.04).toFixed(3);
    if (td.mode === 'out') td.L.out = +clamp(td.out0 + dt, td.in0 + 0.04, c.dur).toFixed(3);
    td.moved = true; draw(); drawTl();
  });
  lanes.addEventListener('pointerup', () => { const d = td; td = null; if (d?.moved) save({ key: 'Move keyframe', bar: 'Move layer in time', in: 'Layer in point', out: 'Layer out point', graph: 'Graph edit' }[d.mode]); });
  lanes.addEventListener('dblclick', () => { if (selKey) { seek(selKey.t); } });
  // graph editor dragging
  function graphDown(e, x, y, G) {
    const tg = graphTarget(); if (!tg) return;
    const H = parseFloat($('#moTlCanvas', root).style.height), Mp = graphMap(G, H, tg.p), K = tg.p.k, first = (v) => (Array.isArray(v) ? v[0] : v);
    for (let i = 0; i < K.length - 1; i++) { // ease handles first
      const k = K[i], b = K[i + 1]; if (k.hold) continue;
      const e2 = k.e || EASE.linear, dv = first(b.v) - first(k.v);
      for (const h of [0, 1]) { const hx = G.x(k.t + e2[h * 2] * (b.t - k.t)), hy = Mp.y(first(k.v) + e2[h * 2 + 1] * dv); if (Math.hypot(hx - x, hy - y) < 7) { td = { mode: 'graph', what: 'handle', k, b, h, Mp }; return; } }
    }
    const k = K.find((q) => Math.hypot(G.x(q.t) - x, Mp.y(first(q.v)) - y) < 8);
    if (k) { selKey = { lid: tg.L.id, path: tg.P.join('.'), t: k.t }; td = { mode: 'graph', what: 'key', k, K, Mp, v0: k.v, y0: y, x0: x, t0: k.t }; return; }
    td = { mode: 'scrub' }; seek(G.t(x));
  }
  function graphMove(e, x, y, G) {
    const first = (v) => (Array.isArray(v) ? v[0] : v);
    if (td.what === 'handle') {
      const { k, b, h, Mp } = td, dv = first(b.v) - first(k.v);
      const ex = clamp((G.t(x) - k.t) / Math.max(1e-6, b.t - k.t), 0, 1), ey = dv ? (Mp.v(y) - first(k.v)) / dv : (h ? 1 : 0);
      k.e = [...(k.e || EASE.linear)]; k.e[h * 2] = +ex.toFixed(3); k.e[h * 2 + 1] = +clamp(ey, -2, 3).toFixed(3);
    } else {
      const { k, K, Mp } = td, nt = snapT(clamp(td.t0 + G.t(x) - G.t(td.x0), 0, comp().dur));
      if (!K.some((q) => q !== k && Math.abs(q.t - nt) < 1e-4)) { k.t = nt; K.sort((a, c2) => a.t - c2.t); selKey.t = nt; }
      const dv = Mp.v(y) - Mp.v(td.y0);
      k.v = Array.isArray(td.v0) ? td.v0.map((v, i) => (i === 0 ? +(v + dv).toFixed(2) : v)) : typeof td.v0 === 'number' ? +(td.v0 + dv).toFixed(2) : td.v0;
    }
    td.moved = true; draw(); drawTl();
  }
}
// ease of the selected keyframe (or every keyframe of the selected layers when none is picked)
function easeSel(kind) {
  const c = comp(); if (!c) return;
  const keys = [];
  if (selKey) { const L = layer(selKey.lid), p = L && M.getIn(L, pathOf(selKey.path)); const k = animated(p) && p.k.find((q) => Math.abs(q.t - selKey.t) < 1e-4); if (k) keys.push(k); }
  else for (const L of sel()) for (const r of M.layerKeys(L)) keys.push(...r.keys);
  if (!keys.length) return toast('Select a keyframe (click a keyframe in the timeline) or a layer with keyframes', 'err');
  for (const k of keys) { if (kind === 'hold') k.hold = true; else { delete k.hold; k.e = [...EASE[kind]]; } }
  save(`Keyframe ease: ${kind}`);
  toast(`${keys.length} keyframe${keys.length > 1 ? 's' : ''}: ${kind === 'easy' ? 'Easy Ease' : kind}`);
}

// ---------------- keys ----------------
function wireKeys() {
  document.addEventListener('keydown', (e) => {
    if (S.page !== 'motion' || !S.project || document.querySelector('dialog[open]')) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey, c = comp();
    let done = true;
    if (ctrl && k.toLowerCase() === 'd') { const L = one(); if (L) { const n = JSON.parse(JSON.stringify(L)); n.id = M.uidM(); n.name += ' copy'; c.layers.splice(c.layers.indexOf(L), 0, n); selIds = new Set([n.id]); save('Duplicate layer'); } }
    else if (ctrl) done = false;
    else if (k === ' ') playing ? stop() : play();
    else if (k === 'Delete' || k === 'Backspace') { if (selKey) { const L = layer(selKey.lid), P = pathOf(selKey.path); M.setIn(L, P, M.delKey(M.getIn(L, P), selKey.t)); selKey = null; save('Delete keyframe'); } else if (selIds.size && c) { c.layers = c.layers.filter((L) => !selIds.has(L.id)); for (const L of c.layers) if (selIds.has(L.parent)) L.parent = null; selIds.clear(); save('Delete layer'); } }
    else if (k === 'Enter' && pen) penFinish(false);
    else if (k === 'Escape') { if (pen) penFinish(false); selKey = null; tool = 'select'; propSolo = null; refresh(); }
    // AE: P / S / R / T / A / U show just that property of the selected layers (T = Opacity when layers are selected)
    else if (selIds.size && k.length === 1 && 'psrtau'.includes(k.toLowerCase()) && !e.shiftKey) { const x = k.toLowerCase(); propSolo = propSolo === x ? null : x; renderLHead(); drawTl(); }
    else if (k === 'F9') easeSel('easy');
    else if (k === 'j' || k === 'J') jumpKey(-1);
    else if (k === 'k' || k === 'K') jumpKey(1);
    else if (k === 'Home') seek(0);
    else if (k === 'End') seek(c?.dur || 0);
    else if (k === 'ArrowLeft') seek(T - (e.shiftKey ? 10 : 1) / fps());
    else if (k === 'ArrowRight') seek(T + (e.shiftKey ? 10 : 1) / fps());
    else if (k === '[' || k === ']') { for (const L of sel()) { if (k === '[') L.in = Math.min(T, (L.out ?? c.dur) - 0.04); else L.out = Math.max(T, (L.in || 0) + 0.04); } if (selIds.size) save('Layer in / out'); }
    else if ('vtqg'.includes(k.toLowerCase()) && k.length === 1) { tool = { v: 'select', t: 'text', q: 'rect', g: 'pen' }[k.toLowerCase()]; pen = null; refresh(); hint(); }
    else done = false;
    if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

// a comp clip from the timeline (double-click / Open in Motion): its comp is opened - and brought back from the clip's
// copy when the project doesn't have it (a clip pasted from another project)
export function openCompClip(clip) {
  const g = clip.gfx || {};
  if (!comps()[g.compId] && g.comp) { const c = JSON.parse(JSON.stringify(g.comp)); comps()[c.id] = c; g.compId = c.id; commit('Bring back comp'); }
  compId = g.compId; selIds.clear(); T = 0;
}

// 🎬 Make Motion comp (right-click a video clip on the timeline): a comp of the clip's length with the clip as a video
// layer, laid exactly over the clip on the track above. The clip stays underneath for its sound (and as a fallback).
export function makeCompFromClip(clipId, findClip) {
  const f = findClip(clipId), c = f?.clip, m = c && S.mediaById[c.mediaId];
  if (!c || c.type !== 'video' || !m) return toast('Right-click a video clip', 'err');
  const [w, h] = frame(), dur = +clipDur(c, S.mediaById).toFixed(3), start = (layoutStart(f) ?? c.start ?? 0);
  const k = Math.max(w / (m.width || w), h / (m.height || h));
  let name = `${m.name.replace(/\.[^.]+$/, '')} comp`, n = 2; while (Object.values(comps()).some((x) => x.name === name)) name = `${m.name.replace(/\.[^.]+$/, '')} comp ${n++}`;
  const cp = M.newComp(name, w, h, dur);
  const L = M.newLayer('video', cp, { mediaId: m.id, name: m.name, srcIn: +(c.in || 0), speed: c.speed || 1, w: Math.round((m.width || w) * k), h: Math.round((m.height || h) * k) });
  cp.layers = [L]; comps()[cp.id] = cp;
  // V3 or higher, above the clip, on a track free for its whole length (or a new one)
  const tr = compTrack(S.project, start, dur, S.mediaById, f.track);
  S.project.tracks[tr].push({ id: uid(), type: 'graphic', start: +start.toFixed(3), dur, gfx: { tpl: 'comp', compId: cp.id, comp: JSON.parse(JSON.stringify(cp)) } });
  compId = cp.id; selIds = new Set([L.id]); T = 0;
  commit(`Make Motion comp: ${m.name}`);
  toast(`"${name}" made on ${tr} over the clip (orange) - double-click it to open it in Motion`);
  return true;
}
const layoutStart = (f) => Object.values(layout()).flat().find((x) => x.clip.id === f.clip.id)?.start;

// ◐ Track Matte Key on the timeline (like Premiere's effect): two selected clips - the picture on the lower track, the
// matte (text, a photo / logo with transparency, or a video) on a track above it - become one Motion comp where the
// picture shows only through the matte: through its shape (alpha) for text / stills, through its light parts (luma)
// for a video matte. The comp takes the picture's place and length; the picture's sound stays as it was.
export function trackMatteFromClips(ids, findClip) {
  const fs = ids.map((id) => findClip(id)).filter((f) => f && !f.clip.gap);
  if (fs.length !== 2) return toast('Select two clips: the picture, and the matte (text / logo / video) on a track above it', 'err');
  const num = (t) => +String(t).slice(1);
  fs.sort((a, b) => num(a.track) - num(b.track));
  const [fb, fm] = fs, b = fb.clip, mt = fm.clip, mb = S.mediaById[b.mediaId];
  if (fb.track[0] !== 'V' || fm.track[0] !== 'V' || fb.track === fm.track) return toast('The two clips must be on two different video tracks (the matte above)', 'err');
  if (!['video', 'image'].includes(b.type) || !mb) return toast('The lower clip must be a video or a photo', 'err');
  const [w, h] = frame(), start = layoutStart(fb) ?? b.start ?? 0, dur = +clipDur(b, S.mediaById).toFixed(3);
  const ms = layoutStart(fm) ?? mt.start ?? 0, md = clipDur(mt, S.mediaById), mm = S.mediaById[mt.mediaId];
  let name = `${mb.name.replace(/\.[^.]+$/, '')} matte`, n = 2; while (Object.values(comps()).some((x) => x.name === name)) name = `${mb.name.replace(/\.[^.]+$/, '')} matte ${n++}`;
  const cp = M.newComp(name, w, h, dur);
  const fit = (m) => { const k = Math.max(w / (m.width || w), h / (m.height || h)); return { w: Math.round((m.width || w) * k), h: Math.round((m.height || h) * k) }; };
  const base = b.type === 'video' ? M.newLayer('video', cp, { mediaId: mb.id, name: mb.name, srcIn: +(b.in || 0), speed: b.speed || 1, ...fit(mb) }) : M.newLayer('image', cp, { mediaId: mb.id, name: mb.name, ...fit(mb) });
  let mat, mode = 'alpha';
  const txt = mt.type === 'title' ? mt.text : mt.type === 'graphic' && mt.gfx?.tpl === 'text' ? mt.gfx.text : null;
  if (mt.type === 'video' && mm) { mat = M.newLayer('video', cp, { mediaId: mm.id, name: mm.name, srcIn: +(mt.in || 0) + Math.max(0, start - ms) * (mt.speed || 1), speed: mt.speed || 1, ...fit(mm) }); mode = 'luma'; }
  else if (mt.type === 'image' && mm) mat = M.newLayer('image', cp, { mediaId: mm.id, name: mm.name, ...fit(mm) });
  else if (txt) { mat = M.newLayer('text', cp, { name: 'Matte text' }); mat.text.text = txt; mat.text.size = Math.round(h * 0.28); }
  else return toast('The upper clip must be text, a photo / logo or a video', 'err');
  mat.in = +Math.max(0, ms - start).toFixed(3); mat.out = +Math.min(dur, ms + md - start).toFixed(3);
  base.matte = mode;
  cp.layers = [mat, base]; comps()[cp.id] = cp;
  const clip = { id: uid(), type: 'graphic', dur, gfx: { tpl: 'comp', compId: cp.id, comp: JSON.parse(JSON.stringify(cp)) } };
  if (fb.track !== 'V1') clip.start = +start.toFixed(3);
  const mate = linkedPartner(S.project, b)?.clip; if (mate) delete mate.link; // (its sound plays on)
  const lb = S.project.tracks[fb.track]; lb.splice(lb.indexOf(b), 1, clip);
  const lm = S.project.tracks[fm.track]; lm.splice(lm.indexOf(mt), 1);
  S.sel = new Set([clip.id]);
  commit(`Track Matte Key: ${name}`);
  toast(`"${name}": the picture shows through the ${mode === 'luma' ? 'light parts of the video' : 'shape of the matte'} - double-click it to change it in Motion`);
  return true;
}

// ---------------- ✂ one-click roto ----------------
// the AI matte of a video layer (engine/matte.py on the editor's GPU) for the layer's length: L.video.matte
let rotoBusy = false;
async function findSubject(L) {
  const c = comp(); if (!c || L?.type !== 'video') return;
  if (rotoBusy) return toast('Already finding the subject - one moment');
  rotoBusy = true;
  const sp = L.video.speed || 1, a = L.video.in || 0, len = ((L.out ?? c.dur) - (L.in || 0)) * sp;
  try {
    emit('job', { running: true, label: 'Finding the subject (AI)…' });
    const job = await api('POST', `/api/matte?p=${enc(S.proj)}`, { mediaId: L.video.mediaId, in: a, out: a + len, fps: fps() });
    const j = await watchJob(job.id, (x) => emit('job', { running: true, label: `Finding the subject (AI)… ${x.progress || 0}%` }));
    const live = layer(L.id) || L;
    live.video.matte = { id: matteId(S.proj, j.result.file), mode: live.video.matte?.mode || 'cutout', soft: live.video.matte?.soft ?? 1 };
    save('Subject (AI roto)');
    toast('Subject cut out in every frame');
  } catch (e) { toast(e.job ? `Could not find the subject: ${e.job.log?.slice(-1)[0] || ''}` : e.message, 'err'); }
  finally { rotoBusy = false; emit('job', { running: false }); }
}
// 🅣 text behind the subject: the clip at the bottom, a text layer, the cut-out subject on top
function textBehind(L) {
  const c = comp(); if (!c || L?.type !== 'video') return;
  const top = JSON.parse(JSON.stringify(L));
  top.id = M.uidM(); top.name = `${L.name} (subject)`; top.video.matte = L.video.matte ? { ...L.video.matte, mode: 'cutout' } : null; top.parent = L.id;
  top.tr = { anchor: [0, 0], position: [0, 0], scale: [100, 100], rotation: 0, opacity: 100 }; // (rides on the clip below)
  const t = M.newLayer('text', c, { name: 'Text behind' });
  Object.assign(t.text, { text: 'LIMELIGHT', size: Math.round(c.h * 0.24), weight: 900 });
  t.tr.position = [c.w / 2, c.h * 0.42];
  delete L.video.matte;
  const i = c.layers.indexOf(L);
  c.layers.splice(i, 0, top, t);
  selIds = new Set([t.id]);
  save('Text behind subject');
  if (!top.video.matte) findSubject(top);
  toast('🅣 Text is behind the subject - change the words in Properties; drag it in the viewer');
}
// right-click a clip on the edit → ✂ Text behind subject: a comp of the clip, set up and roto'd in one go
export function textBehindFromClip(clipId, findClip) {
  if (!makeCompFromClip(clipId, findClip)) return false;
  const c = comp(), L = c.layers.find((x) => x.type === 'video');
  if (L) textBehind(L);
  return true;
}

// ---------------- 🎯 track motion (AE's Track Motion → apply to a layer) ----------------
// The box is drawn around something in a video layer; engine/track.py follows it through the layer's time; the
// selected layer gets Position keyframes that move with it (keeping where it sits relative to the thing).
async function trackBox([x, y, w, h]) {
  const c = comp(), target = one();
  if (!target) return toast('First select the layer that should follow (e.g. the text), then draw the box', 'err');
  const mid = [x + w / 2, y + h / 2];
  // the video under the box (the top one that shows there now), not the target itself
  const g = $('#moOver', root).getContext('2d');
  const V = c.layers.find((L) => L.type === 'video' && L !== target && !L.hidden && T >= (L.in || 0) && T < (L.out ?? c.dur) && inPoly(mid, M.layerQuad(c, L, T, g)));
  if (!V) return toast('Draw the box over a video layer (the thing to follow must be in a video)', 'err');
  // box → fractions of the video picture (the layer shows the whole picture in its w x h box)
  const inv = M.invert(M.worldMatrix(c, V, T)), vw = V.video.w || 1920, vh = V.video.h || 1080;
  const a = M.apply(inv, [x, y]), b = M.apply(inv, [x + w, y + h]);
  const fx = (p) => (p[0] + vw / 2) / vw, fy = (p) => (p[1] + vh / 2) / vh;
  const box = { x: Math.min(fx(a), fx(b)), y: Math.min(fy(a), fy(b)), w: Math.abs(fx(b) - fx(a)), h: Math.abs(fy(b) - fy(a)) };
  const from = T, to = V.out ?? c.dur, sp = V.video.speed || 1;
  try {
    emit('job', { running: true, label: 'Following it through the shot…' });
    const job = await api('POST', `/api/track?p=${enc(S.proj)}`, { mediaId: V.video.mediaId, t0: M.videoTime(V, from), t1: M.videoTime(V, to), box });
    const j = await watchJob(job.id, (q) => emit('job', { running: true, label: `Tracking… ${q.progress || 0}%` }));
    const pts = j.result.points || [];
    if (pts.length < 2) throw new Error('It could not be followed - try a bigger box around something with clear edges');
    // each tracked point → comp time and comp position (through the video layer's own transform at that time)
    const at = (p) => { const tc = (V.in || 0) + (p.t - (V.video.in || 0)) / sp, lp = [(p.x + p.w / 2) * vw - vw / 2, (p.y + p.h / 2) * vh - vh / 2]; return { t: tc, pos: M.apply(M.worldMatrix(c, V, tc), lp) }; };
    const track = pts.map(at).filter((q) => q.t >= from - 1e-3 && q.t <= to + 1e-3);
    // where the target sits relative to the thing at the start stays the same
    const live = layer(target.id) || target;
    const P = live.parent ? c.layers.find((q) => q.id === live.parent) : null;
    const now = M.apply(P ? M.worldMatrix(c, P, from) : [1, 0, 0, 1, 0, 0], M.base(live.tr.position, from) || [0, 0]);
    const off = [now[0] - track[0].pos[0], now[1] - track[0].pos[1]];
    let p = { k: [] };
    for (const q of track) {
      const world = [q.pos[0] + off[0], q.pos[1] + off[1]], local = P ? M.apply(M.invert(M.worldMatrix(c, P, q.t)), world) : world;
      p = M.setKey(p, snapT(q.t), local.map((v) => +v.toFixed(1)));
    }
    live.tr.position = p;
    tool = 'select';
    save(`Track motion → ${live.name}`);
    toast(`${live.name} now follows it - ${p.k.length} position keyframes${j.result.lost?.length ? ` (lost it ${j.result.lost.length}× - check those moments)` : ''}`);
  } catch (e) { toast(e.job ? `Tracking failed: ${e.job.log?.slice(-1)[0] || ''}` : e.message, 'err'); }
  finally { emit('job', { running: false }); }
}

// 🌄 parallax in one click: the cut-out subject near (depth 0), a text in the middle (60), the clip behind (200, a bit
// bigger so its edges never show) and a camera that slides and pushes in slowly over the comp
function parallax(L) {
  const c = comp(); if (!c || L?.type !== 'video') return;
  const top = JSON.parse(JSON.stringify(L));
  top.id = M.uidM(); top.name = `${L.name} (subject)`; top.video.matte = L.video.matte ? { ...L.video.matte, mode: 'cutout' } : null; top.depth = 0;
  const t = M.newLayer('text', c, { name: 'Parallax text' });
  Object.assign(t.text, { text: 'LIMELIGHT', size: Math.round(c.h * 0.22), weight: 900 });
  t.tr.position = [c.w / 2, c.h * 0.4]; t.depth = 60;
  delete L.video.matte; L.depth = 200; L.tr.scale = [118, 118];
  const i = c.layers.indexOf(L);
  c.layers.splice(i, 0, top, t);
  const d = c.dur, e = [...M.EASE.easy];
  c.camera = { pos: { k: [{ t: 0, v: [-90, 0], e }, { t: +d.toFixed(3), v: [90, 0], e }] }, zoom: { k: [{ t: 0, v: 1, e }, { t: +d.toFixed(3), v: 1.08, e }] } };
  selIds = new Set([t.id]);
  save('Parallax (2.5D)');
  if (!top.video.matte) findSubject(top);
  toast('Parallax made: subject near, text in the middle, background far - the camera slides across (Space to play)');
}

// ＋ New ▾ > Color Matte / Black Video (Media panel): a full-frame colour on a free track above, at the playhead.
// It is a Motion comp with that background (open it in Motion to animate the colour or add things on it).
export function addColorMatte(color = '#000000', name = 'Color Matte', dur = 5) {
  const [w, h] = frame(), c = M.newComp(name, w, h, dur);
  let n = name, k = 2; while (Object.values(comps()).some((x) => x.name === n)) n = `${name} ${k++}`;
  c.name = n; c.bg = color; comps()[c.id] = c;
  const t = S.playhead || 0;
  const id = compTrack(S.project, t, dur, S.mediaById);
  const clip = { id: uid(), type: 'graphic', start: +t.toFixed(3), dur, gfx: { tpl: 'comp', compId: c.id, comp: JSON.parse(JSON.stringify(c)) } };
  S.project.tracks[id].push(clip);
  S.sel = new Set([clip.id]);
  commit(`${name}`);
  emit('select');
  toast(`${name} on ${id} at the playhead - drag its ends to change the length; double-click to open it in Motion`);
}
