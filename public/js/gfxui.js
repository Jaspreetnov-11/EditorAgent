// 📊 Motion graphics in the editor: the template picker, Effect Controls for a graphic, and baking - every frame
// drawn by graphics.js is sent to the server once (cache/graphics/<key>.mov, transparent) so the render lays exactly
// the same picture over the video. A graphic is baked again only when it changes (the key is its fingerprint).
import { S, commit, findClip, on, emit, layout } from './store.js';
import { api, enc } from './api.js';
import { ASPECTS, uid, clipDur, trackList, addTrack, parseTime, fmt } from './model.js';
import { $, $$, esc, toast, modal, fieldsHTML, bindFields } from './ui.js';
import { GFX, gfxFields, newGraphic, drawGraphic, gfxKey, setGfxAssets, setGfxVideo, gfxReady, brandOf } from './graphics.js';
import { compVideos } from './motion.js';
import { fusionVideos } from './fusion.js';
import * as CV from './compvideo.js';
import { CAPTION_FONTS } from './captions.js';

// logos inside graphics come from the media pool (full-size image); a frame is drawn again when one has loaded
setGfxAssets((id) => S.mediaById[id]?.urls?.play || null, () => emit('live'));
// 🎬 video layers of comps in the Edit viewer: the nearest frame, redrawn when the exact one arrives
setGfxVideo((id, t, rate) => (S.progPlaying ? CV.follow('view', id, t, rate) : CV.frame('view', id, t, () => emit('live'))));
// a new graphic: in the brand kit's colours, font and logo when the project has a brand kit
function made(tpl) {
  const g = newGraphic(tpl), b = brandOf(S.project);
  if (GFX[tpl].motion) {
    if (b) Object.assign(g, { theme: 'brand', brand: b, ...(S.project.brand.font ? { font: S.project.brand.font } : {}) });
    if ('logo' in g && !g.logo && S.project.logo?.mediaId) g.logo = S.project.logo.mediaId;
  }
  return g;
}

const frameSize = () => ASPECTS[S.project.settings.aspect] || [1920, 1080];

// ---- picker ----
export function openGraphics() {
  const [W, H] = frameSize(), pw = 220, ph = Math.round((pw * H) / W);
  const tile = ([k, x]) => `<button class="gfx-pick" data-tpl="${k}"><canvas width="${W}" height="${H}" style="width:${pw}px;height:${ph}px"></canvas><span>${esc(x.label)}</span></button>`;
  const all = Object.entries(GFX), b = brandOf(S.project);
  const dlg = modal('🎬 Motion graphics', `<h4>🎬 Motion templates <span class="muted small">${b ? "- 🏷 the brand kit's colours, font and logo are applied automatically" : "- set a brand kit (🏷) and its colours and logo are applied automatically"}</span></h4>
    <div class="gfx-grid">${all.filter(([, x]) => x.motion).map(tile).join('')}</div>
    <h4>📊 Data graphics <span class="muted small">- numbers, charts, callouts</span></h4>
    <div class="gfx-grid">${all.filter(([, x]) => !x.motion).map(tile).join('')}</div>
    <p class="muted small">Placed at the playhead on a free overlay track. Change words, colours and style in Effect Controls. What you see in the viewer is what renders.</p>`, { width: 1000 });
  const preview = () => $$('[data-tpl]', dlg.el).forEach((el) => { const g = made(el.dataset.tpl), d = GFX[el.dataset.tpl].dur; drawGraphic(el.querySelector('canvas').getContext('2d'), W, H, g, Math.max(0.1, d * 0.62), d); });
  preview();
  // logos load a moment later: draw the tiles again then
  Promise.all(Object.keys(GFX).map((k) => gfxReady(made(k)))).then(() => { if (dlg.el.isConnected) preview(); });
  dlg.el.addEventListener('click', (e) => { const b = e.target.closest('[data-tpl]'); if (!b) return; dlg.close(); addGraphic(b.dataset.tpl); });
}

export function addGraphic(tpl) {
  const t = S.playhead, dur = GFX[tpl].dur;
  const free = (id) => !(S.project.tracks[id] || []).some((c) => (c.start || 0) < t + dur && (c.start || 0) + clipDur(c, S.mediaById) > t);
  const ov = trackList(S.project).filter((x) => x.kind === 'video' && x.id !== 'V1').map((x) => x.id).reverse(); // V2 first
  const id = ov.find(free) || addTrack(S.project, 'video');
  const c = { id: uid(), type: 'graphic', start: +t.toFixed(3), dur, gfx: made(tpl) };
  S.project.tracks[id].push(c);
  S.sel = new Set([c.id]);
  commit('Add graphic');
  emit('select');
  toast(`${GFX[tpl].label} added on ${id} - edit its words and numbers in Effect Controls`);
}

// ---- Effect Controls ----
export function gfxInspector(c) {
  const g = c.gfx || {};
  // 🎬 a Motion comp: edited on the Motion page
  if (g.tpl === 'comp' || g.tpl === 'fusion') return `<div class="isec"><p><b>${g.tpl === 'fusion' ? `✨ ${esc(g.fusion?.name || 'Fusion')}</b> <span class="muted small">- ${g.fusion?.nodes?.length || 0} nodes</span>` : `🎬 ${esc(g.comp?.name || 'Composition')}</b> <span class="muted small">- ${g.comp?.layers?.length || 0} layers</span>`}</p>
    <button class="accent" data-open-comp>${g.tpl === 'fusion' ? 'Open in Fusion' : 'Open in Motion'}</button><div class="fgrid">${fieldsHTML([{ k: 'start', label: 'Starts at', type: 'time', fmt, ph: '0:00.0' }], c)}</div>
    <small class="hint">Changes made to the comp on the Motion page update this clip. Double-click the clip to open it there.</small></div>`;
  return `<div class="isec"><div class="fgrid">${fieldsHTML([
    { k: 'tpl', label: 'Template', type: 'select', options: Object.entries(GFX).map(([k, x]) => [k, x.label]), wide: true },
    ...gfxFields(g.tpl).map((f) => (f.k === 'logo' ? { ...f, options: [['', 'None (round placeholder)'], ...S.media.filter((m) => m.kind === 'image').slice(0, 2000).map((m) => [m.id, m.name])] } : f)),
    ...(GFX[g.tpl]?.motion ? [{ k: 'font', label: 'Font', type: 'select', options: [['', 'Default (Nirmala UI - Hindi)'], ...CAPTION_FONTS.map((f) => [f, f])] }] : []),
  ], g)}</div>
  <div class="fgrid">${fieldsHTML([{ k: 'start', label: 'Starts at', type: 'time', fmt, ph: '0:00.0' }, { k: 'dur', label: 'Length', type: 'num', min: 1, step: 0.5, unit: 'sec' }], c)}</div>
  <small class="hint">Numbers count up, bars grow and lines draw in during the first seconds; the last 0.4 s fades out. Hindi works too.</small></div>`;
}
export function bindGfxInspector(root, id, render) {
  const box = root.querySelector('.isec');
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
      if (k === 'theme' && v === 'brand') { c.gfx.brand = brandOf(S.project) || { primary: '#0b2545', accent: '#ff9933', text: '#ffffff' }; if (!c.gfx.font && S.project.brand?.font) c.gfx.font = S.project.brand.font; if (!brandOf(S.project)) toast('No brand kit set - choose colours in 🏷 Brand kit; MyGov colours are used for now'); render(); }
      commit('Edit graphic', `gfx-${id}-${k}`);
    },
  });
  bindFields(fields[1], () => findClip(id)?.clip, { parse: { start: parseTime }, live: () => emit('live'), commit: () => commit('Graphic timing') });
}

// ---- baking (frames -> server) ----
const baked = new Set(); // keys known to be on the server
const keyOf = (c) => { const [W, H] = frameSize(); return gfxKey(c.gfx, W, H, S.project.settings.fps, clipDur(c, S.mediaById)); };
const allGraphics = () => Object.entries(S.project.tracks).filter(([t]) => t[0] === 'V').flatMap(([, l]) => l).filter((c) => c.type === 'graphic');

const inflight = new Map(); // key -> promise: the auto-bake and a render never bake the same graphic twice at once
function bake(c, onProgress, forRender = false) {
  const key = keyOf(c);
  if (baked.has(key)) return Promise.resolve(key);
  if (!inflight.has(key)) inflight.set(key, bakeNow(c, key, onProgress, forRender).finally(() => inflight.delete(key)));
  return inflight.get(key);
}
async function bakeNow(c, key, onProgress, forRender = false) {
  const has = await api('GET', `/api/gfx/has?p=${enc(S.proj)}&key=${key}`).catch(() => ({}));
  if (has.ok) { baked.add(key); return key; }
  const [W, H] = frameSize(), fps = S.project.settings.fps, dur = clipDur(c, S.mediaById), n = Math.max(1, Math.round(dur * fps));
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
// before a render / preview: every graphic of every sequence that renders must be baked (here: the open one)
export async function bakeAll() {
  const list = allGraphics();
  for (const [i, c] of list.entries()) {
    await bake(c, (k) => emit('job', { running: true, label: `Preparing graphics ${i + 1}/${list.length} · ${Math.round(k * 100)}%` }), true);
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
