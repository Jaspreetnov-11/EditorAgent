// 🅿 Presets page (after Labs): the motion templates (Limelight pack - openers, logo stings, titles, lower thirds,
// transitions, infographics, news, social - and the motion templates of graphics.js) in a big live preview. Pick one,
// change any part of it on the right - every text (font, size, colour, place, when it shows), the logo, the shapes, every
// colour it draws with, the background, the timing and the layout (presetmodel.js builds the panel for any preset) - and
// see it play, then Add to timeline (at the
// playhead, on a free overlay track) - or, opened from a graphic on the timeline (P / right-click), Update on timeline.
import { S, on, commit, findClip, emit } from './store.js';
import { api, enc } from './api.js';
import { ASPECTS, fmt } from './model.js';
import { $, $$, esc, toast, fieldsHTML, bindFields, getPath, setPath } from './ui.js';
import { ic } from './lineicons.js';
import { GFX, drawGraphic, gfxReady, brandOf } from './graphics.js';
import { presetModel, presetColours } from './presetmodel.js';
import { tidyEd } from './gfxparams.js';
import { PACK_ORDER } from './gfxpack.js';
import { made, addGraphic } from './gfxui.js';
import { fontField, pickFont } from './fontpick.js';
import { placeTemplate, openCustomTemplates } from './customtpl.js';

let root = null, tpl = null, g = null, dur = 5, editId = null, T = 0, playing = false, raf = 0, last = 0, cat = 'all', query = '', picked = null;
// 🎓 the editors' own templates and LUTs (learnt from their timelines, engine/styles.mjs): [{ name, mine, templates, luts }]
let saved = [], entries = new Map();
// 🎞 the shared custom templates (Library/graphics: MOGRTs, logo animations, videos with transparency) - played, not edited
let ctpls = [], custom = null;
// the Edit panel: which sections are open, the colours of the preset (found by drawing it, kept per preset + look)
const openSecs = new Set(['content']);
let colMemo = { key: '', list: [] }, colCv = null;
const frame = () => ASPECTS[S.project?.settings?.aspect] || [1920, 1080];
const groups = () => [...PACK_ORDER.map((p) => [p, Object.entries(GFX).filter(([, x]) => x.pack === p)]), ['Motion templates', Object.entries(GFX).filter(([, x]) => x.motion && !x.pack)]];
const editClip = () => (editId ? findClip(editId)?.clip : null);

export function mountPresets(el) {
  root = el;
  el.innerHTML = `<div class="prs">
    <div class="panel pr-lib"><div class="mo-head"><b>Presets</b><span class="grow"></span><span class="muted small" id="prCount"></span></div>
      <div class="pr-filter"><input type="search" id="prFind" placeholder="Find a preset…" aria-label="Find a preset"><select id="prCat" aria-label="Group"></select></div>
      <div class="pr-list" id="prList"></div></div>
    <div class="panel pr-view">
      <div class="mo-head"><b id="prName">Pick a preset</b><span class="muted small" id="prFrom"></span><span class="grow"></span>
        <button class="small" data-p="reset" title="Back to the preset's own words and colours">Reset</button>
        <button class="accent small" data-p="add" title="Put it on the edit's timeline at the playhead, on a free overlay track">Add to timeline</button>
        <button class="accent small" data-p="update" title="Change the graphic on the timeline it was opened from">Update on timeline</button></div>
      <div class="pr-stage" id="prStage"><canvas id="prCanvas"></canvas><div class="mo-empty" id="prEmpty">Pick a preset on the left - or select a graphic on the Edit timeline and press P.</div></div>
      <div class="mo-trans"><button class="icon-btn" data-p="start" title="To the start">${ic('start')}</button><button class="icon-btn" data-p="play" title="Play / pause (Space)">${ic('play')}</button><input type="range" id="prPos" min="0" max="1" step="0.001" value="0" aria-label="Time"><span class="tc" id="prTC">0:00</span></div>
    </div>
    <div class="panel pr-insp" id="prInsp"></div>
  </div>`;
  $('#prCat', el).innerHTML = `<option value="all">All groups</option>${groups().map(([n]) => `<option>${esc(n)}</option>`).join('')}`;
  $('#prCat', el).onchange = (e) => { cat = e.target.value; drawList(); };
  $('#prFind', el).oninput = (e) => { query = e.target.value.trim().toLowerCase(); drawList(); };
  $('#prPos', el).oninput = (e) => { stop(); T = +e.target.value * dur; draw(); };
  el.addEventListener('click', onClick);
  // Space on this page plays the preset - never the Edit timeline (captured before the editor's own keys)
  document.addEventListener('keydown', (e) => {
    if (S.page !== 'presets' || e.code !== 'Space' || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]')) return;
    if (e.target instanceof Element && e.target.closest('input:not([type=range]), textarea, select, [contenteditable]')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (custom) { const v = $('#prVideo', root); if (v) v.paused ? v.play().catch(() => {}) : v.pause(); } else toggle();
  }, true);
  on('mix', () => { if (S.page === 'presets') draw(); }); // (a font arrived)
  on('live', () => { if (S.page === 'presets') draw(); }); // (a logo arrived)
  on('change', () => { if (S.page === 'presets' && editId && !editClip()) { editId = null; head(); } });
}
export function showPresets() { if (!root) return; drawList(); head(); inspector(); draw(); loadSaved(); }
async function loadSaved() {
  try {
    const r = await api('GET', '/api/styles/editors'), out = [];
    for (const e of r.editors.filter((x) => x.templates || x.luts).slice(0, 30)) {
      const s = await api('GET', `/api/styles/editor?name=${enc(e.name)}`);
      out.push({ name: e.name, mine: e.name === r.me, templates: (s.templates || []).filter((t) => GFX[t.tpl]), luts: Object.values(s.luts || {}).sort((a, b) => b.uses - a.uses) });
    }
    saved = out.sort((a, b) => b.mine - a.mine);
    ctpls = await api('GET', '/api/library/graphics').catch(() => []);
    const sel = $('#prCat', root), keep = sel.value;
    sel.innerHTML = `<option value="all">All groups</option>${allGroups().map(([n]) => `<option>${esc(n)}</option>`).join('')}`;
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'all';
    if (S.page === 'presets') drawList();
  } catch {}
}
const groupName = (e) => (e.mine ? 'My templates' : `${e.name}'s templates`);
// every group of the list: [name, [[key, { label, tpl, gfx?, dur }]]] - the editors' own first, then the pack
function allGroups() {
  const own = saved.filter((e) => e.templates.length).map((e) => [groupName(e), e.templates.map((t, j) => [`s:${e.name}:${j}`, { label: savedLabel(t), tpl: t.tpl, gfx: t.gfx, dur: t.dur || GFX[t.tpl].dur, who: e.name }])]);
  const cust = ctpls.length ? [['Custom templates', ctpls.map((t) => [`c:${t.id}`, { label: t.name, ctpl: t, tags: (t.tags || []).join(' ') }])]] : [];
  return [...own, ...cust, ...groups().map(([n, l]) => [n, l.map(([k, x]) => [`t:${k}`, { label: x.label, tpl: k, dur: x.dur }])])];
}
const savedLabel = (t) => { const w = String(t.gfx.title || t.gfx.name || t.gfx.text || t.gfx.words || '').split(/\r?\n/)[0].trim(); return w ? `${w.slice(0, 22)} · ${GFX[t.tpl].label}` : GFX[t.tpl].label; };
export function hidePresets() { stop(); }

// a graphic from the timeline (P, or right-click › Edit in Presets): edited here, Update on timeline puts it back
export function openPresetClip(clip) {
  if (!clip || clip.type !== 'graphic' || !GFX[clip.gfx?.tpl] || ['comp', 'fusion', 'vfx'].includes(clip.gfx.tpl)) return false;
  stop(); custom = null; showVideo(false); tpl = clip.gfx.tpl; g = JSON.parse(JSON.stringify(clip.gfx)); dur = clip.dur || GFX[tpl].dur; editId = clip.id; T = Math.min(dur * 0.62, dur);
  if (root && S.page === 'presets') showPresets();
  return true;
}

function pick(k, from = null) {
  stop(); custom = null; showVideo(false); tpl = k; g = from ? JSON.parse(JSON.stringify(from.gfx)) : made(k); dur = from?.dur || GFX[k].dur; editId = null; T = dur * 0.62; picked = from;
  head(); inspector(); draw(); play();
  gfxReady(g).then(draw);
}

// ---- library ----
function drawList() {
  const q = query, list = allGroups().filter(([n]) => cat === 'all' || n === cat).map(([n, l]) => [n, l.filter(([, x]) => !q || `${x.label} ${n} ${x.tpl || ''} ${x.tags || ''}`.toLowerCase().includes(q))]).filter(([, l]) => l.length);
  const [W, H] = frame(), tw = 132, th = Math.round((tw * H) / W);
  entries = new Map(list.flatMap(([, l]) => l));
  const luts = cat === 'all' && !q ? saved.filter((e) => e.luts.length) : [];
  $('#prCount', root).textContent = `${entries.size} presets`;
  $('#prList', root).innerHTML = luts.map((e) => `<div class="pr-group">${esc(e.mine ? 'My LUTs' : `${e.name}'s LUTs`)} <span class="muted">- click: on the selected clips</span></div><div class="pr-luts">${e.luts.slice(0, 12).map((l) => `<button class="chip" data-lut="${esc(l.kind)}|${esc(l.name)}" title="${l.kind === 'look' ? 'Creative look' : 'LUT'} · used on ${l.uses} clip${l.uses === 1 ? '' : 's'}">${esc(l.name.replace(/\.(cube|3dl)$/i, ''))}</button>`).join('')}</div>`).join('')
    + (list.map(([n, l]) => `<div class="pr-group">${esc(n)}</div><div class="pr-grid">${l.map(([k, x]) => `<button class="pr-tile${k === curKey() ? ' on' : ''}" data-pk="${esc(k)}" title="${esc(x.label)}">${x.ctpl ? `<img src="/lg/${x.ctpl.id}/thumb.png?v=${x.ctpl.saved}" alt="" loading="lazy">` : `<canvas width="${Math.round(W / 4)}" height="${Math.round(H / 4)}" style="width:${tw}px;height:${th}px"></canvas>`}<span>${esc(x.label)}</span></button>`).join('')}</div>`).join('') || '<div class="muted small pad">No preset matches.</div>');
  // the tiles: drawn a few at a time so the page opens at once
  const tiles = $$('[data-pk]', root);
  let i = 0;
  const paint = (cv, gx, d) => { try { drawGraphic(cv.getContext('2d'), cv.width, cv.height, gx, Math.max(0.1, d * 0.62), d); } catch {} };
  const step = () => {
    for (const end = i + 8; i < end && i < tiles.length; i++) {
      const el = tiles[i], x = entries.get(el.dataset.pk), cv = el.querySelector('canvas');
      if (!x || !cv) continue;
      const gx = x.gfx || made(x.tpl), d = x.dur || GFX[x.tpl].dur;
      paint(cv, gx, d);
      if (x.gfx) gfxReady(gx).then(() => paint(cv, gx, d)); // (their logo / font arrives a moment later)
    }
    if (i < tiles.length && root.isConnected) requestAnimationFrame(step);
  };
  step();
}
const curKey = () => (custom ? `c:${custom.id}` : picked ? [...entries].find(([, x]) => x.gfx === picked.gfx)?.[0] : tpl ? `t:${tpl}` : null);

function head() {
  if (custom) return headCustom();
  const c = editClip();
  $('#prName', root).textContent = tpl ? GFX[tpl].label : 'Pick a preset';
  $('#prFrom', root).textContent = c ? ' - from the timeline' : picked ? ` - ${picked.who}'s template` : tpl ? ` - ${GFX[tpl].pack || 'Motion template'}` : '';
  $('[data-p="update"]', root).hidden = !c;
  $('[data-p="add"]', root).textContent = c ? 'Add a copy' : 'Add to timeline';
  for (const b of $$('[data-p="add"], [data-p="reset"]', root)) b.disabled = !tpl;
  $('#prEmpty', root).hidden = !!tpl;
  $('#prCanvas', root).hidden = !tpl;
  const k = curKey(); $$('[data-pk]', root).forEach((b) => b.classList.toggle('on', b.dataset.pk === k));
}

// ---- the fields: every part of the preset (presetmodel.js), in sections that open and close ----
function colours() {
  const key = JSON.stringify([tpl, g.theme, g.brand, g.pos, g.style, g.logo, dur]);
  if (colMemo.key !== key) {
    colCv ||= typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(320, 180) : Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
    const { ed, ...plain } = g; // (the preset's own colours - the swaps are keyed by them)
    colMemo = { key, list: presetColours(plain, dur, () => colCv.getContext('2d')) };
  }
  return colMemo.list;
}
function inspector() {
  const box = $('#prInsp', root);
  if (!tpl) { box.innerHTML = '<div class="mo-head"><b>Edit</b></div><div class="muted small pad">Every part of the preset appears here: words, fonts, colours, logo, shapes, background, timing.</div>'; return; }
  const imgs = S.media.filter((m) => m.kind === 'image').slice(0, 2000).map((m) => [m.id, m.name]);
  const secs = presetModel(tpl, g, { logos: imgs, images: imgs, colours: colours() });
  // a colour that can go back to the design: "as designed" until it is changed, then a ↺
  const withClear = (d) => (d.clear ? { ...d, hint: getPath(g, d.k) ? `<button class="icon-btn reset" data-clear="${esc(d.k)}" title="Back to the design">${ic('reset')}</button>` : '<i class="muted">as designed</i>' } : d);
  const fontBtn = (path) => { const fam = getPath(g, path); return `<label class="fld wide"><span>Font</span><button type="button" class="fontbtn" data-efont="${esc(path)}"${fam ? ` style="font-family:&quot;${esc(fam)}&quot;, 'Segoe UI'"` : ''}>${esc(fam || 'As designed')}<i>▾</i></button></label>`; };
  const resetBtn = (sx) => (sx.path || sx.paths ? `<button class="icon-btn reset" data-sreset="${esc((sx.paths || [sx.path]).join(' '))}" title="Back to the design">${ic('reset')}</button>` : '');
  box.innerHTML = `<div class="mo-head"><b>Edit</b><span class="muted small">changes play on the left</span></div>
    <div class="pr-fields">${secs.map((sx) => `<details class="pr-sec" data-sec="${esc(sx.id)}"${openSecs.has(sx.id) ? ' open' : ''}><summary>${esc(sx.label)}<span class="grow"></span>${resetBtn(sx)}</summary>
      <div class="fgrid" data-sf>${fieldsHTML(sx.defs.map(withClear), g)}${sx.font === true ? fontField(g.font) : sx.font ? fontBtn(sx.font) : ''}</div>
      ${sx.len ? `<div class="fgrid" data-len>${fieldsHTML([{ k: 'dur', label: 'Length', type: 'num', min: 1, max: 60, step: 0.5, unit: 'sec' }], { dur })}</div>` : ''}</details>`).join('')}
    <small class="hint">Hindi and English both work. What plays here is what renders.</small></div>`;
  const changed = (k) => {
    if (k === 'theme') { delete g.ed?.cmap; if (g.theme === 'brand') { g.brand = brandOf(S.project) || { primary: '#0b2545', accent: '#ff9933', text: '#ffffff' }; if (!g.font && S.project.brand?.font) g.font = S.project.brand.font; } }
    tidyEd(g);
    if (k === 'logo' || k === 'theme' || k === 'ed.bg.img') gfxReady(g).then(draw);
    if (k === 'theme' || k === 'ed.bg.mode' || /^ed\.(t\.[^.]+\.(color|outline)|cmap\.)/.test(k)) inspector(); // (the fields shown change)
    draw();
  };
  for (const el of $$('[data-sf]', box)) {
    bindFields(el, () => g, { live: () => draw(), commit: (k) => changed(k) });
    for (const c of $$('input[type=color]', el)) c.addEventListener('input', () => { setPath(g, c.dataset.k, c.value); draw(); });
  }
  for (const d of $$('details[data-sec]', box)) d.addEventListener('toggle', () => (d.open ? openSecs.add(d.dataset.sec) : openSecs.delete(d.dataset.sec)));
  box.onclick = (e) => {
    const c = e.target.closest('[data-clear]'); if (c) { e.preventDefault(); setPath(g, c.dataset.clear, undefined); changed(c.dataset.clear); return; }
    const r = e.target.closest('[data-sreset]'); if (r) { e.preventDefault(); e.stopPropagation(); for (const p of r.dataset.sreset.split(' ')) setPath(g, p, undefined); changed(''); inspector(); return; }
    const f = e.target.closest('[data-efont]'); if (f) { e.preventDefault(); const p = f.dataset.efont; pickFont(f, getPath(g, p) || '', (fam) => { setPath(g, p, fam || undefined); tidyEd(g); gfxReady(g).then(draw); inspector(); draw(); }, 'As designed'); }
  };
  const lenBox = $('[data-len]', box);
  if (lenBox) { const len = { dur }; bindFields(lenBox, () => len, { live: () => { dur = Math.max(1, +len.dur || dur); draw(); }, commit: () => { dur = Math.max(1, +len.dur || dur); draw(); } }); }
  box.querySelector('[data-fontpick]')?.addEventListener('click', (e) => pickFont(e.currentTarget, g.font || '', (fam) => { if (fam) g.font = fam; else delete g.font; inspector(); draw(); }));
}

// ---- the preview ----
function draw() {
  if (!root || !tpl) return;
  const cv = $('#prCanvas', root), [W, H] = frame();
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  try { drawGraphic(ctx, W, H, g, Math.min(T, dur), dur); } catch (e) { console.error(e); }
  $('#prPos', root).value = dur ? T / dur : 0;
  $('#prTC', root).textContent = `${fmt(T)} / ${fmt(dur)}`;
}
function play() {
  if (!tpl) return;
  playing = true; last = performance.now(); if (T >= dur - 0.05) T = 0;
  $('[data-p="play"]', root).innerHTML = ic('pause');
  const step = (now) => { if (!playing) return; T += (now - last) / 1000; last = now; if (T >= dur) T = 0; draw(); raf = requestAnimationFrame(step); };
  raf = requestAnimationFrame(step);
}
function stop() { playing = false; cancelAnimationFrame(raf); const b = root && $('[data-p="play"]', root); if (b) b.innerHTML = ic('play'); }
const toggle = () => (playing ? stop() : play());

function onClick(e) {
  const t = e.target.closest('[data-pk]'); if (t) { const x = entries.get(t.dataset.pk); if (x?.ctpl) pickCustom(x.ctpl); else if (x) pick(x.tpl, x.gfx ? x : null); return; }
  if (e.target.closest('[data-p="cimport"]')) return openCustomTemplates();
  const lut = e.target.closest('[data-lut]'); if (lut) return putLut(...lut.dataset.lut.split('|'));
  const a = e.target.closest('[data-p]')?.dataset.p; if (!a) return;
  if (custom && (a === 'play' || a === 'start')) { const v = $('#prVideo', root); if (a === 'start') v.currentTime = 0; else if (v.paused) v.play().catch(() => {}); else v.pause(); return; }
  if (a === 'play') toggle();
  if (a === 'start') { stop(); T = 0; draw(); }
  if (a === 'reset' && tpl) { const keep = editId; pick(tpl, picked); editId = keep; head(); }
  if (a === 'add' && custom) { placeTemplate(custom.id); return; }
  if (a === 'add' && tpl) {
    const c = addGraphic(tpl, JSON.parse(JSON.stringify(g)), dur);
    toast(`${GFX[tpl].label} is on the timeline at ${fmt(c.start)} - change it here and press Update on timeline, or in Effect Controls`);
    editId = c.id; head();
  }
  if (a === 'update') {
    const c = editClip(); if (!c) { editId = null; head(); return toast('That graphic is no longer on the timeline - Add to timeline instead', 'err'); }
    c.gfx = JSON.parse(JSON.stringify(g)); c.dur = dur;
    commit(`Update preset: ${GFX[tpl].label}`); emit('select');
    toast(`${GFX[tpl].label} updated on the timeline`);
  }
}

// 🎨 an editor's LUT / look onto the clips selected on the timeline
function putLut(kind, name) {
  const ids = [...S.sel].filter((id) => ['video', 'image'].includes(findClip(id)?.clip.type));
  if (!ids.length) return toast('Select video or photo clips on the Edit timeline first', 'err');
  for (const id of ids) { const c = findClip(id).clip; c.color = { ...(c.color || {}), [kind === 'look' ? 'look' : 'lut']: name }; }
  commit(`${kind === 'look' ? 'Look' : 'LUT'}: ${name}`); emit('select');
  toast(`${name} on ${ids.length} clip${ids.length > 1 ? 's' : ''} - change it on the Color page`);
}

// ---- 🎞 a custom template: its own moving preview (the small copy with transparency) and what it is ----
function showVideo(on, src = '') {
  if (!root) return;
  let v = $('#prVideo', root);
  if (!v && on) { v = document.createElement('video'); v.id = 'prVideo'; v.muted = true; v.loop = true; v.playsInline = true; $('#prStage', root).append(v); v.ontimeupdate = () => { $('#prTC', root).textContent = `${fmt(v.currentTime)} / ${fmt(v.duration || 0)}`; $('#prPos', root).value = v.duration ? v.currentTime / v.duration : 0; }; }
  if (!v) return;
  v.hidden = !on;
  if (on) { if (v.dataset.src !== src) { v.src = src; v.dataset.src = src; } v.play().catch(() => {}); } else v.pause();
}
function pickCustom(t) {
  stop(); custom = t; tpl = null; picked = null; editId = null;
  showVideo(true, `/lg/${t.id}/preview.webm?v=${t.saved}`);
  headCustom();
  const kind = { mogrt: 'MOGRT', video: 'Video with transparency', sequence: 'Image sequence', zip: 'Image sequence' }[t.kind] || t.kind;
  $('#prInsp', root).innerHTML = `<div class="mo-head"><b>Custom template</b><span class="muted small">shared by every editor</span></div>
    <div class="pr-fields"><div class="pr-cinfo"><b>${esc(t.name)}</b>
      <span>${esc(kind)} · ${(+t.duration || 0).toFixed(1)} s · ${t.width}×${t.height} · ${t.alpha ? 'transparent' : 'on black (Screen)'}</span>
      ${t.fields?.length ? `<span>${t.fields.length} text field${t.fields.length > 1 ? 's' : ''} - after Add to timeline you can type your words; they go on as text layers above it</span>` : ''}
      ${(t.tags || []).length ? `<span>Tags: ${esc(t.tags.join(', '))}</span>` : ''}</div>
      <small class="hint">A MOGRT plays as the video made inside it - its own words and colours cannot change here (that needs After Effects). Put your text over it, or use a preset above.</small>
      <button class="small" data-p="cimport">Import, rename or tag custom templates…</button></div>`;
}
function headCustom() {
  $('#prName', root).textContent = custom.name;
  $('#prFrom', root).textContent = ' - custom template';
  $('[data-p="update"]', root).hidden = true;
  $('[data-p="reset"]', root).disabled = true;
  const add = $('[data-p="add"]', root); add.disabled = false; add.textContent = 'Add to timeline';
  $('#prEmpty', root).hidden = true; $('#prCanvas', root).hidden = true;
  const k = curKey(); $$('[data-pk]', root).forEach((b) => b.classList.toggle('on', b.dataset.pk === k));
}
