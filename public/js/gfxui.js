// 📊 Motion graphics in the editor: the template picker, Effect Controls for a graphic, and baking - every frame
// drawn by graphics.js is sent to the server once (cache/graphics/<key>.mov, transparent) so the render lays exactly
// the same picture over the video. A graphic is baked again only when it changes (the key is its fingerprint).
import { PACK_ORDER } from './gfxpack.js';
import { S, commit, findClip, on, emit, layout } from './store.js';
import { api, enc } from './api.js';
import { ASPECTS, uid, clipDur, trackList, addTrack, parseTime, fmt, BLEND_MODES } from './model.js';
import { $, $$, esc, toast, modal, fieldsHTML, bindFields } from './ui.js';
import { GFX, gfxFields, newGraphic, drawGraphic, gfxKey, setGfxAssets, setGfxVideo, gfxReady, setFontLoader, brandOf, PINS, pinOk, rtimeOk, rtimeOf } from './graphics.js';
import { compVideos } from './motion.js';
import { fusionVideos } from './fusion.js';
import * as CV from './compvideo.js';
import { fontField, pickFont, ensureFont } from './fontpick.js';

// logos inside graphics come from the media pool (full-size image); a frame is drawn again when one has loaded
setGfxAssets((id) => S.mediaById[id]?.urls?.play || null, () => emit('live'));
// 🎬 video layers of comps in the Edit viewer: the nearest frame, redrawn when the exact one arrives
setGfxVideo((id, t, rate) => (S.progPlaying ? CV.follow('view', id, t, rate) : CV.frame('view', id, t, () => emit('live'))));
// a new graphic: in the brand kit's colours, font and logo when the project has a brand kit
export function made(tpl) {
  const g = newGraphic(tpl), b = brandOf(S.project);
  if (GFX[tpl].motion) {
    if (b) Object.assign(g, { theme: 'brand', brand: b, ...(S.project.brand.font ? { font: S.project.brand.font } : {}) });
    if ('logo' in g && !g.logo && S.project.logo?.mediaId) g.logo = S.project.logo.mediaId;
    if (tpl === 'lower3' && b && S.project.brand.ltMotion) g.style = S.project.brand.ltMotion; // (🏷 the brand pack's lower-third style)
  }
  if (rtimeOk(g)) g.rtime = true; // ⏱ new graphics keep their intro / outro when stretched
  return g;
}

// 📌 ⏱ Responsive Design fields (Effect Controls): pin to an edge, and the intro / outro that do not stretch
function respFields(g) {
  const out = [];
  if (pinOk(g)) {
    out.push({ type: 'section', label: 'Responsive - position' }, { k: 'pin', label: 'Pin to', type: 'select', options: PINS });
    if (g.pin) out.push({ k: 'pinMX', label: 'Margin (% of width)', type: 'range', min: -20, max: 40, step: 0.5, def: 0 },
      { k: 'pinMY', label: 'Margin (% of height)', type: 'range', min: -20, max: 40, step: 0.5, def: 0 },
      { k: 'pinSafe', label: 'Keep inside title safe', type: 'check', def: true }, { k: 'pinW', label: 'Scale with frame width', type: 'check' });
  }
  if (rtimeOk(g)) {
    const [i, o] = rtimeOf({ ...g, intro: undefined, outro: undefined });
    out.push({ type: 'section', label: 'Responsive - time' }, { k: 'rtime', label: 'Keep intro / outro when stretched', type: 'check' });
    if (g.rtime) out.push({ k: 'intro', label: 'Intro', type: 'num', min: 0, step: 0.1, unit: 'sec', ph: String(i) }, { k: 'outro', label: 'Outro', type: 'num', min: 0, step: 0.1, unit: 'sec', ph: String(o) });
  }
  return out;
}

const frameSize = () => ASPECTS[S.project.settings.aspect] || [1920, 1080];

// ---- picker ----
export function openGraphics() {
  const [W, H] = frameSize(), pw = 220, ph = Math.round((pw * H) / W);
  const tile = ([k, x]) => `<button class="gfx-pick" data-tpl="${k}"><canvas width="${W}" height="${H}" style="width:${pw}px;height:${ph}px"></canvas><span>${esc(x.label)}</span></button>`;
  const all = Object.entries(GFX), b = brandOf(S.project);
  const dlg = modal('Motion graphics', `<h4>Motion templates <span class="muted small">${b ? "- the brand kit's colours, font and logo are applied automatically" : "- set a brand kit () and its colours and logo are applied automatically"}</span></h4>
    <div class="gfx-grid">${all.filter(([, x]) => x.motion && !x.pack).map(tile).join('')}</div>
    ${PACK_ORDER.map((p) => `<h4>${esc(p)} <span class="muted small">- Limelight pack</span></h4><div class="gfx-grid">${all.filter(([, x]) => x.pack === p).map(tile).join('')}</div>`).join('')}
    <h4>Data graphics <span class="muted small">- numbers, charts, callouts</span></h4>
    <div class="gfx-grid">${all.filter(([, x]) => !x.motion).map(tile).join('')}</div>
    <p class="muted small">Placed at the playhead on a free overlay track. Change words, colours and style in Effect Controls. What you see in the viewer is what renders.</p>
    <p class="small"><button class="link" data-ctpls>Custom templates - your own MOGRTs, logo animations and videos with transparency…</button></p>`, { width: 1000 });
  const preview = () => $$('[data-tpl]', dlg.el).forEach((el) => { const g = made(el.dataset.tpl), d = GFX[el.dataset.tpl].dur; drawGraphic(el.querySelector('canvas').getContext('2d'), W, H, g, Math.max(0.1, d * 0.62), d); });
  preview();
  // logos load a moment later: draw the tiles again then
  Promise.all(Object.keys(GFX).map((k) => gfxReady(made(k)))).then(() => { if (dlg.el.isConnected) preview(); });
  dlg.el.addEventListener('click', (e) => {
    if (e.target.closest('[data-ctpls]')) { dlg.close(); import('./customtpl.js').then((m) => m.openCustomTemplates()); return; }
    const b = e.target.closest('[data-tpl]'); if (!b) return; dlg.close(); addGraphic(b.dataset.tpl);
  });
}

export function addGraphic(tpl, gfx = null, len = 0) {
  const t = S.playhead, dur = len || GFX[tpl].dur;
  const free = (id) => !(S.project.tracks[id] || []).some((c) => (c.start || 0) < t + dur && (c.start || 0) + clipDur(c, S.mediaById) > t);
  const ov = trackList(S.project).filter((x) => x.kind === 'video' && x.id !== 'V1').map((x) => x.id).reverse(); // V2 first
  const id = ov.find(free) || addTrack(S.project, 'video');
  const c = { id: uid(), type: 'graphic', start: +t.toFixed(3), dur, gfx: gfx || made(tpl) };
  S.project.tracks[id].push(c);
  S.sel = new Set([c.id]);
  commit('Add graphic');
  emit('select');
  toast(`${GFX[tpl].label} added on ${id} - edit its words and numbers in Effect Controls`);
  return c;
}

// T the Type tool: a text where the Program monitor was clicked (x, y: % of the frame), on the first free overlay track
export function addTextAt(x, y) {
  const t = S.playhead, dur = GFX.text.dur;
  const free = (id) => !(S.project.tracks[id] || []).some((c) => (c.start || 0) < t + dur && (c.start || 0) + clipDur(c, S.mediaById) > t);
  const ov = trackList(S.project).filter((k) => k.kind === 'video' && k.id !== 'V1').map((k) => k.id).reverse();
  const id = ov.find(free) || addTrack(S.project, 'video');
  const c = { id: uid(), type: 'graphic', start: +t.toFixed(3), dur, gfx: { ...made('text'), text: '', x: +x.toFixed(2), y: +y.toFixed(2) } };
  S.project.tracks[id].push(c);
  S.sel = new Set([c.id]);
  emit('select');
  return c;
}

// ▭ ◯ the Rectangle / Ellipse tool: a shape over the box dragged on the Program monitor (% of the frame)
export function addShapeAt(shape, x, y, w, h) {
  const t = S.playhead, dur = GFX.shape.dur;
  const free = (id) => !(S.project.tracks[id] || []).some((c) => (c.start || 0) < t + dur && (c.start || 0) + clipDur(c, S.mediaById) > t);
  const ov = trackList(S.project).filter((k) => k.kind === 'video' && k.id !== 'V1').map((k) => k.id).reverse();
  const id = ov.find(free) || addTrack(S.project, 'video');
  (S.project.tracks[id] ||= []);
  const c = { id: uid(), type: 'graphic', start: +t.toFixed(3), dur, gfx: { ...made('shape'), shape, x: +x.toFixed(2), y: +y.toFixed(2), w: +w.toFixed(2), h: +h.toFixed(2) } };
  S.project.tracks[id].push(c);
  S.sel = new Set([c.id]);
  commit(shape === 'ellipse' ? 'Ellipse tool: new shape' : 'Rectangle tool: new shape');
  emit('select');
  return c;
}

// 🔤 fonts from the editor's computer / Google: loaded when a graphic needs one; the monitor draws again when it arrives
setFontLoader((fam) => ensureFont(fam, () => emit('mix')));

// ---- Effect Controls ----
// T the Type tool's text, laid out like Premiere's Essential Graphics: Text (font, style, size, alignment, spacing), then
// Appearance and Align and Transform that fold away. The inputs are ordinary fields (data-k, bound with the others);
// the style / alignment buttons set their key at once (bindTextPanel).
const WEIGHTS = [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra Bold'], [900, 'Black']];
const ALIGN_IC = { left: '<svg viewBox="0 0 16 16"><path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h8"/></svg>', center: '<svg viewBox="0 0 16 16"><path d="M2 3h12M4 6.5h8M2 10h12M4 13.5h8"/></svg>', right: '<svg viewBox="0 0 16 16"><path d="M2 3h12M6 6.5h8M2 10h12M6 13.5h8"/></svg>' };
const txOpen = new Set(['appear']); // (folded sections stay as the editor left them)
function textPanel(g) {
  const w = g.weight || (g.bold === false ? 400 : 700), on = (b) => (b ? ' aria-pressed="true"' : ' aria-pressed="false"');
  const num = (k, v, step, title, ic, min = '', max = '') => `<label class="tx-num" title="${title}"><i>${ic}</i><input type="number" data-k="${k}" data-type="num" step="${step}" min="${min}" max="${max}" value="${v}"></label>`;
  const sec = (key, title, body) => `<details class="tx-sec" data-txsec="${key}"${txOpen.has(key) ? ' open' : ''}><summary>${title}</summary><div class="tx-body">${body}</div></details>`;
  return `<div class="tx-head">Text</div>
    <textarea class="tx-text" data-k="text" data-type="area" rows="2" placeholder="Type here - or with the Type tool on the monitor">${esc(g.text || '')}</textarea>
    ${fontField(g.font).replace('<span>Font</span>', '')}
    <div class="tx-row"><select class="tx-weight" data-k="weight" data-type="select" title="Font style (weight)">${WEIGHTS.map(([v, l]) => `<option value="${v}"${v === w ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <div class="tx-tg"><button data-txb="bold" title="Bold"${on(w >= 600)}><b>B</b></button><button data-txb="italic" title="Italic"${on(g.italic)}><i>I</i></button><button data-txb="caps" title="All Caps"${on(g.caps)}>TT</button><button data-txb="underline" title="Underline"${on(g.underline)}><u>U</u></button></div></div>
    <div class="tx-size"><span>Font Size</span><input type="range" data-k="size" data-type="range" min="8" max="400" step="1" value="${g.size ?? 90}"><input type="number" data-mirror="size" min="8" max="600" step="1" value="${g.size ?? 90}"></div>
    <div class="tx-row"><div class="tx-tg tx-align">${['left', 'center', 'right'].map((a) => `<button data-txa="${a}" title="Align ${a}"${on((g.align || 'center') === a)}>${ALIGN_IC[a]}</button>`).join('')}</div>
      ${num('track', g.track ?? 0, 1, 'Tracking (space between letters)', 'VA↔', -10, 60)}${num('lead', g.lead ?? 1.2, 0.05, 'Leading (space between lines)', '↕A', 0.8, 2.5)}</div>
    ${sec('appear', 'Appearance', `
      <div class="tx-line"><span class="tx-l">Fill</span><input type="color" list="brandSw" data-k="color" value="${esc(g.color || '#ffffff')}"></div>
      <div class="tx-line"><label class="tx-chk"><input type="checkbox" data-k="stroke" data-type="check"${g.stroke ? ' checked' : ''}> Stroke</label><input type="color" list="brandSw" data-k="strokeColor" value="${esc(g.strokeColor || '#000000')}">${num('strokeW', g.strokeW ?? 6, 1, 'Stroke width', '⎯', 1, 40)}</div>
      <div class="tx-line"><label class="tx-chk"><input type="checkbox" data-k="bg" data-type="check"${g.bg ? ' checked' : ''}> Background</label><input type="color" list="brandSw" data-k="bgColor" value="${esc(g.bgColor || '#000000')}">${num('bgOpacity', g.bgOpacity ?? 0.6, 0.05, 'Background opacity (0 - 1)', '◐', 0, 1)}</div>
      <div class="tx-line"><label class="tx-chk"><input type="checkbox" data-k="shadow" data-type="check"${g.shadow ? ' checked' : ''}> Shadow</label></div>`)}
    ${sec('xform', 'Align and Transform', `<div class="tx-line">${num('x', g.x ?? 50, 0.5, 'Position across (% of the frame)', 'X', -20, 120)}${num('y', g.y ?? 50, 0.5, 'Position down (% of the frame)', 'Y', -20, 120)}</div>
      <div class="fgrid tx-resp">${fieldsHTML(respFields(g), g)}</div>`)}`;
}
export function gfxInspector(c) {
  const g = c.gfx || {};
  // T Type tool text: Premiere's Text panel layout
  if (g.tpl === 'text') return `<div class="isec"><div class="fgrid tx-panel">${textPanel(g)}</div>
  <div class="fgrid">${fieldsHTML([{ k: 'start', label: 'Starts at', type: 'time', fmt, ph: '0:00.0' }, { k: 'dur', label: 'Length', type: 'num', min: 1, step: 0.5, unit: 'sec' }, { k: 'blend', label: 'Blend Mode (with the tracks below)', type: 'select', options: BLEND_MODES }], c)}</div></div>`;
  // 🎬 a Motion comp: edited on the Motion page
  if (g.tpl === 'comp' || g.tpl === 'fusion') return `<div class="isec"><p><b>${g.tpl === 'fusion' ? `${esc(g.fusion?.name || 'Nodes')}</b> <span class="muted small">- ${g.fusion?.nodes?.length || 0} nodes</span>` : `${esc(g.comp?.name || 'Composition')}</b> <span class="muted small">- ${g.comp?.layers?.length || 0} layers</span>`}</p>
    <button class="accent" data-open-comp>${g.tpl === 'fusion' ? 'Open in Nodes' : 'Open in Motion'}</button><div class="fgrid">${fieldsHTML([{ k: 'start', label: 'Starts at', type: 'time', fmt, ph: '0:00.0' }], c)}</div>
    <small class="hint">Changes made to the comp on the Motion page update this clip. Double-click the clip to open it there.</small></div>`;
  return `<div class="isec"><div class="fgrid">${fieldsHTML([
    { k: 'tpl', label: 'Template', type: 'select', options: Object.entries(GFX).map(([k, x]) => [k, x.label]), wide: true },
    ...gfxFields(g.tpl).map((f) => (f.k === 'logo' ? { ...f, options: [['', 'None (round placeholder)'], ...S.media.filter((m) => m.kind === 'image').slice(0, 2000).map((m) => [m.id, m.name])] } : f)),
    ...(g.tpl === 'shape' ? [] : [{ type: 'html', html: fontField(g.font) }]), // (🔤 any font on this computer, like Premiere's Essential Graphics)
    ...respFields(g),
  ], g)}</div>
  <div class="fgrid">${fieldsHTML([{ k: 'start', label: 'Starts at', type: 'time', fmt, ph: '0:00.0' }, { k: 'dur', label: 'Length', type: 'num', min: 1, step: 0.5, unit: 'sec' }, { k: 'blend', label: 'Blend Mode (with the tracks below)', type: 'select', options: BLEND_MODES }], c)}</div>
  <small class="hint">Numbers count up, bars grow and lines draw in during the first seconds; the last 0.4 s fades out. Hindi works too.</small></div>`;
}
function bindTextPanel(box, id, render) {
  const g = () => findClip(id)?.clip.gfx;
  box.querySelectorAll('[data-txb]').forEach((b) => b.addEventListener('click', () => {
    const x = g(); if (!x) return; const k = b.dataset.txb;
    if (k === 'bold') { const wNow = x.weight || (x.bold === false ? 400 : 700); x.weight = wNow >= 600 ? 400 : 700; x.bold = x.weight >= 600; }
    else x[k] = !x[k] || undefined;
    commit(`Text: ${b.title}`); emit('live'); render();
  }));
  box.querySelectorAll('[data-txa]').forEach((b) => b.addEventListener('click', () => { const x = g(); if (!x) return; x.align = b.dataset.txa; commit('Text: align'); emit('live'); render(); }));
  box.querySelectorAll('[data-txsec]').forEach((d) => d.addEventListener('toggle', () => (d.open ? txOpen.add(d.dataset.txsec) : txOpen.delete(d.dataset.txsec))));
  box.querySelector('[data-k="weight"]')?.addEventListener('change', (e) => { const x = g(); if (x) x.bold = +e.target.value >= 600; });
}
export function bindGfxInspector(root, id, render) {
  const box = root.querySelector('.isec');
  if (findClip(id)?.clip.gfx?.tpl === 'text') bindTextPanel(box, id, render);
  if (['comp', 'fusion'].includes(findClip(id)?.clip.gfx?.tpl)) {
    box.querySelector('[data-open-comp]').onclick = () => emit(findClip(id).clip.gfx.tpl === 'fusion' ? 'openFusion' : 'openComp', findClip(id).clip);
    bindFields(box.querySelector('.fgrid'), () => findClip(id)?.clip, { parse: { start: parseTime }, live: () => emit('live'), commit: () => commit('Comp timing') });
    return;
  }
  const fields = box.querySelectorAll('.fgrid');
  bindFields(fields[0], () => findClip(id)?.clip.gfx, {
    live: () => emit('live'),
    commit: (k, v) => {
      const c = findClip(id)?.clip; if (!c) return;
      if (k === 'tpl') { const n = made(v); c.gfx = GFX[v].motion ? { ...n, ...(c.gfx.theme ? { theme: c.gfx.theme, brand: c.gfx.brand, font: c.gfx.font } : {}) } : { ...n, title: c.gfx.title || n.title, theme: c.gfx.theme, pos: c.gfx.pos }; c.dur = GFX[v].dur; commit('Graphic template'); render(); return; }
      // 🏷 brand look: the brand kit's colours (and font) are copied in now
      // 📌 pinned on this frame shape (what "scale with frame width" measures against); the panel shows the pin's settings
      if (k === 'pin') { if (v && !c.gfx.pinRef) c.gfx.pinRef = frameSize().slice(); commit('Pin graphic', `gfx-${id}-${k}`); render(); return; }
      if (k === 'rtime' || k === 'pos') { commit('Edit graphic', `gfx-${id}-${k}`); render(); return; }
      if (k === 'theme' && v === 'brand') { c.gfx.brand = brandOf(S.project) || { primary: '#0b2545', accent: '#ff9933', text: '#ffffff' }; if (!c.gfx.font && S.project.brand?.font) c.gfx.font = S.project.brand.font; if (!brandOf(S.project)) toast('No brand kit set - choose colours in Brand kit; MyGov colours are used for now'); render(); }
      commit('Edit graphic', `gfx-${id}-${k}`);
    },
  });
  bindFields(fields[1], () => findClip(id)?.clip, { parse: { start: parseTime }, live: () => emit('live'), commit: () => commit('Graphic timing') });
  box.querySelector('[data-fontpick]')?.addEventListener('click', (e) => pickFont(e.currentTarget, findClip(id)?.clip.gfx?.font || '', (fam) => {
    const c = findClip(id)?.clip; if (!c?.gfx) return;
    if (fam) c.gfx.font = fam; else delete c.gfx.font;
    commit(`Font: ${fam || 'default'}`); render();
  }));
}

// ---- baking (frames -> server) ----
const baked = new Set(); // keys known to be on the server
const keyOf = (c, [W, H] = frameSize()) => gfxKey(c.gfx, W, H, S.project.settings.fps, clipDur(c, S.mediaById));
const allGraphics = () => Object.entries(S.project.tracks).filter(([t]) => t[0] === 'V').flatMap(([, l]) => l).filter((c) => c.type === 'graphic');

const inflight = new Map(); // key -> promise: the auto-bake and a render never bake the same graphic twice at once
function bake(c, onProgress, forRender = false, fr = frameSize()) {
  const key = keyOf(c, fr);
  if (baked.has(key)) return Promise.resolve(key);
  if (!inflight.has(key)) inflight.set(key, bakeNow(c, key, onProgress, forRender, fr).finally(() => inflight.delete(key)));
  return inflight.get(key);
}
async function bakeNow(c, key, onProgress, forRender = false, [W, H] = frameSize()) {
  const has = await api('GET', `/api/gfx/has?p=${enc(S.proj)}&key=${key}`).catch(() => ({}));
  if (has.ok) { baked.add(key); return key; }
  const fps = S.project.settings.fps, dur = clipDur(c, S.mediaById), n = Math.max(1, Math.round(dur * fps));
  await gfxReady(c.gfx); // the logo must be in every frame
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const vids = c.gfx.tpl === 'comp' ? (t) => compVideos(c.gfx.comp, t) : c.gfx.tpl === 'fusion' ? (t) => fusionVideos(c.gfx.fusion, t) : () => [];
  for (let i = 0; i < n; i++) {
    // 🎬 every video layer of a comp shows exactly this frame before it is drawn
    // (the edit is playing: the bake waits, so playback stays smooth)
    while (S.progPlaying && !forRender) await new Promise((ok) => setTimeout(ok, 400));
    for (const v of vids(i / fps)) await CV.exact('bake', v.id, v.t);
    drawGraphic(ctx, W, H, c.gfx, i / fps, dur, { video: (id) => CV.get('bake', id) });
    const blob = await new Promise((ok) => cv.toBlob(ok, 'image/png'));
    const r = await fetch(`/api/gfx/frame?p=${enc(S.proj)}&key=${key}&i=${i}`, { method: 'POST', body: blob });
    if (!r.ok) throw new Error('Could not send the graphic to the editor');
    onProgress?.((i + 1) / n);
  }
  await api('POST', `/api/gfx/done?p=${enc(S.proj)}&key=${key}&fps=${fps}&n=${n}`);
  baked.add(key);
  return key;
}
// before a render / preview: every graphic of every sequence that renders must be baked (here: the open one).
// 📌 aspects = the export frames: a pinned graphic is baked for each other frame shape too, so it sits on its edge there
export async function bakeAll(aspects = []) {
  const own = S.project.settings.aspect, list = allGraphics().flatMap((c) => [[c, frameSize()], ...(c.gfx?.pin ? [...new Set(aspects)].filter((a) => a && a !== own && ASPECTS[a]).map((a) => [c, ASPECTS[a]]) : [])]);
  for (const [i, [c, fr]] of list.entries()) {
    await bake(c, (k) => emit('job', { running: true, label: `Preparing graphics ${i + 1}/${list.length} · ${Math.round(k * 100)}%` }), true, fr);
  }
  if (list.length) emit('job', { running: false });
  return list.length;
}
// quietly bake graphics a little after they stop changing, so renders start right away
let bakeTimer = null, baking = false;
on('change', () => {
  if (!S.project || !allGraphics().length) return;
  clearTimeout(bakeTimer);
  bakeTimer = setTimeout(async () => {
    if (baking) return;
    baking = true;
    try { for (const c of allGraphics()) await bake(c); } catch {} finally { baking = false; }
  }, 2500);
});
