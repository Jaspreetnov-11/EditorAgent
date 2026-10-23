// 🎞 Custom templates (Library/graphics, shared by every project and every editor): After Effects / Premiere MOGRTs,
// logo animations, any video with transparency (ProRes 4444 / Animation .mov, VP9 .webm with alpha) and image
// sequences. Imported once (engine/gfxlib.mjs makes a ProRes 4444 master and a small preview with alpha); a click or a
// drag onto the timeline puts one on a free overlay track, where it renders with the shots below showing through.
// The browser is a floating window (not a blocking dialog), so its tiles can be dragged straight onto the timeline.
import { ic } from './lineicons.js';
import { S, commit, emit } from './store.js';
import { api, enc, upload, watchJob } from './api.js';
import { clipDur, trackList, addTrack, uid } from './model.js';
import { $, $$, h, esc, toast } from './ui.js';
import { refreshMedia } from './mediapool.js';
import { placeMedia } from './timeline.js';
import { tagChips, editTags } from './tags.js';

const KIND = { mogrt: 'MOGRT', video: 'Video', sequence: 'Frames', zip: 'Zip' };
export const LIMITS = 'A MOGRT is used as the video rendered inside it: its After Effects / Premiere composition is not rendered again here (that needs After Effects), so its animation and look stay as they were made, and its baked-in words cannot be changed. The text fields it lists can be added on top as the editor\'s own text. A MOGRT with no rendered video inside cannot be used: in After Effects render the comp as QuickTime, Apple ProRes 4444, RGB + Alpha, and import that .mov. A video without transparency is laid over with Screen blend, so a black background drops out.';

let win = null, list = [], filter = '';
const fmtDur = (d) => `${(+d || 0).toFixed(1)} s`;

// the first overlay track (V2 up) that is free from t for dur, else a new one
// (want: the track it was dropped on, when that is free there)
function freeOverlay(t, dur, want = null) {
  const free = (id) => !(S.project.tracks[id] || []).some((c) => (c.start || 0) < t + dur && (c.start || 0) + clipDur(c, S.mediaById) > t);
  if (want && free(want)) return want;
  const ov = trackList(S.project).filter((x) => x.kind === 'video' && x.id !== 'V1').map((x) => x.id).reverse();
  return ov.find(free) || addTrack(S.project, 'video');
}

// into the project (its copy goes into the project folder), then onto the timeline at t (track: a V track, or a free one)
export async function placeTemplate(id, track = null, t = S.playhead) {
  if (!S.proj) return null;
  toast('Adding the template…');
  let m;
  try { m = await api('POST', `/api/library/graphics/use?p=${enc(S.proj)}`, { id }); } catch (e) { toast(e.message, 'err'); return null; }
  await refreshMedia();
  if (!S.mediaById[m.id]) return toast('The template could not be read into this project', 'err');
  const tr = freeOverlay(t, m.duration || 2, track && track !== 'V1' && /^V\d+$/.test(track) ? track : null);
  const c = placeMedia(m.id, tr, Math.max(0, t), {});
  if (!c) return null;
  if (m.template?.blend) c.blend = m.template.blend; // (no transparency: Screen lets the black drop out)
  commit(`Add template "${m.template?.name || m.name}"`);
  emit('select');
  if (m.template?.fields?.length) askFields(m, c, tr);
  else toast(`${m.template?.name || m.name} on ${tr}`);
  return c;
}

// a MOGRT's text fields: added as the editor's own text, on the track above the template, for as long as it runs
function askFields(m, c, tr) {
  const f = m.template.fields;
  const d = h(`<dialog class="dlg" style="width:min(520px, calc(100vw - 32px))"><div class="dlg-head"><h3>Text in "${esc(m.template.name)}"</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="dlg-body"><p class="muted small">This MOGRT has ${f.length} text field${f.length > 1 ? 's' : ''}. Its video already shows the words it was made with - they cannot be changed inside it. Add your words as editable text layers on top (cover or hide the baked ones in After Effects if they clash).</p>
    <div class="fgrid">${f.map((x, i) => `<label>${esc(x.name)}<input type="text" data-fi="${i}" value="${esc(x.value)}"></label>`).join('')}</div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px"><button data-close>Skip</button><button class="primary" data-add>Add as text layers</button></div></div></dialog>`);
  document.body.append(d); d.showModal();
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return d.close();
    if (!e.target.closest('[data-add]')) return;
    const { newGraphic } = await import('./graphics.js');
    const start = c.start || 0, dur = clipDur(c, S.mediaById);
    $$('[data-fi]', d).forEach((inp, i) => {
      const text = inp.value.trim(); if (!text) return;
      const id = freeOverlay(start, dur);
      S.project.tracks[id].push({ id: uid(), type: 'graphic', start, dur: +dur.toFixed(3), gfx: { ...newGraphic('text'), text, y: Math.min(90, 70 + i * 9) } });
    });
    commit('Template text layers'); d.close(); toast('Text layers added above the template - change them in Effect Controls');
  });
}

async function load() { list = await api('GET', '/api/library/graphics').catch(() => []); draw(); }
function draw() {
  if (!win) return;
  const q = filter.trim().toLowerCase();
  const shown = list.filter((t) => !q || t.name.toLowerCase().includes(q) || (t.tags || []).some((g) => g.toLowerCase().includes(q)) || (KIND[t.kind] || '').toLowerCase().includes(q));
  $('[data-grid]', win).innerHTML = shown.length ? shown.map((t) => `<div class="ctpl-tile" draggable="true" data-ctpl="${t.id}" title="Click: add at the playhead · drag onto a track">
      <div class="ctpl-pic"><img src="/lg/${t.id}/thumb.png?v=${t.saved}" alt="" loading="lazy"><span class="ctpl-kind">${esc(KIND[t.kind] || t.kind)}</span></div>
      <b>${esc(t.name)}</b>
      <span class="muted small">${fmtDur(t.duration)} · ${t.width}×${t.height} · ${t.alpha ? 'transparent' : 'on black (Screen)'}${t.fields?.length ? ` · ${t.fields.length} text field${t.fields.length > 1 ? 's' : ''}` : ''}</span>
      <span class="ctpl-tags">${tagChips(t.tags)}</span>
      <span class="ctpl-acts"><button class="icon-btn small" data-ren="${t.id}" title="Rename">${ic('edit')}</button><button class="icon-btn small" data-tag="${t.id}" title="Tags">${ic('tag')}</button><button class="icon-btn small" data-del="${t.id}" title="Delete from the Library">${ic('trash')}</button></span>
    </div>`).join('') : `<p class="muted">${list.length ? 'No template matches.' : 'No custom templates yet - import a .mogrt, a logo animation (.mov / .webm with transparency) or a zip / folder of PNG frames.'}</p>`;
}

async function importFiles(files) {
  for (const f of files) {
    const st = $('[data-status]', win);
    try {
      const fps = /\.zip$/i.test(f.name) ? +(prompt(`Frame rate of the frames in ${f.name}:`, '30') || 30) : 30;
      const j = await upload(`/api/library/graphics/import?name=${enc(f.name)}&fps=${fps}`, f, (k) => { st.textContent = `Uploading ${f.name}… ${Math.round(k * 100)}%`; });
      await watchJob(j.id, (x) => { st.textContent = `${f.name}: ${x.stage || 'working…'}`; });
      st.textContent = `✓ ${f.name} added`;
    } catch (e) { st.textContent = ''; toast(e.job ? `${f.name}: ${e.job.log?.slice(-1)[0] || 'could not be imported'}` : e.message, 'err'); }
  }
  load();
}
async function importPath() {
  const p = prompt('Path of a .mogrt / video file, or of a folder of numbered PNG frames (on this PC or the NAS):');
  if (!p?.trim()) return;
  const fps = /\.[a-z0-9]{2,6}$/i.test(p.trim()) ? 30 : +(prompt('Frame rate of the frames:', '30') || 30);
  const st = $('[data-status]', win);
  try {
    const j = await api('POST', '/api/library/graphics/import-path', { path: p.trim(), fps });
    await watchJob(j.id, (x) => { st.textContent = x.stage || 'working…'; });
    st.textContent = '✓ added';
  } catch (e) { st.textContent = ''; toast(e.job ? e.job.log?.slice(-1)[0] || 'Could not import it' : e.message, 'err'); }
  load();
}

export function openCustomTemplates() {
  if (win) { win.show(); load(); return; }
  win = h(`<dialog class="dlg ctpl-win" aria-label="Custom templates"><div class="dlg-head"><h3>Custom templates <span class="muted small">MOGRT · logo animations · videos with transparency · image sequences</span></h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="dlg-body">
      <div class="row ctpl-bar"><button class="primary small" data-imp>Import file…</button><button class="small" data-path>From a path / frames folder…</button><input type="search" class="small" data-q placeholder="Search name or tag"><span class="muted small" data-status></span>
        <input type="file" data-file hidden multiple accept=".mogrt,.mov,.webm,.mp4,.m4v,.mkv,.avi,.mxf,.zip"></div>
      <div class="ctpl-grid" data-grid><p class="muted">Loading…</p></div>
      <details class="muted small ctpl-limits"><summary>What works and what does not</summary><p>${esc(LIMITS)}</p><p>Shared by everyone: a template imported here is in every project, on every PC. Click one to add it at the playhead on a free overlay track, or drag it onto a track. In the project it is in Media › Templates too.</p></details>
    </div></dialog>`);
  document.body.append(win);
  win.show();
  const me = win;
  win.addEventListener('close', () => { me.remove(); if (win === me) win = null; });
  win.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return win.close();
    if (e.target.closest('[data-imp]')) return $('[data-file]', win).click();
    if (e.target.closest('[data-path]')) return importPath();
    const ren = e.target.closest('[data-ren]')?.dataset.ren, tg = e.target.closest('[data-tag]')?.dataset.tag, del = e.target.closest('[data-del]')?.dataset.del;
    const t = list.find((x) => x.id === (ren || tg || del));
    if (ren) { const n = prompt('Name:', t.name); if (n?.trim()) { await api('POST', '/api/library/graphics/update', { id: ren, name: n.trim() }); load(); } return; }
    if (tg) { const tags = await editTags(t.tags || [], { title: `Tags of ${t.name}`, suggest: list.flatMap((x) => x.tags || []) }); if (tags) { await api('POST', '/api/library/graphics/update', { id: tg, tags }); load(); } return; }
    if (del) { if (confirm(`Delete "${t.name}" from the Library for everyone?\n\nProjects that already use it keep their copy.`)) { await api('POST', '/api/library/graphics/delete', { id: del }); load(); } return; }
    const pick = e.target.closest('[data-ctpl]')?.dataset.ctpl;
    if (pick) placeTemplate(pick);
  });
  $('[data-file]', win).addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) importFiles(fs); });
  $('[data-q]', win).addEventListener('input', (e) => { filter = e.target.value; draw(); });
  // a moving preview on hover (the small copy with transparency)
  win.addEventListener('pointerover', (e) => {
    const tile = e.target.closest('[data-ctpl]'); if (!tile || tile.querySelector('video')) return;
    const v = h(`<video src="/lg/${tile.dataset.ctpl}/preview.webm" muted autoplay loop playsinline></video>`);
    tile.querySelector('.ctpl-pic').append(v);
    tile.addEventListener('pointerleave', () => v.remove(), { once: true });
  });
  win.addEventListener('dragstart', (e) => {
    const id = e.target.closest?.('[data-ctpl]')?.dataset.ctpl; if (!id) return;
    e.dataTransfer.setData('text/x-template', id); e.dataTransfer.effectAllowed = 'copy';
  });
  // files dropped on the window are imported
  win.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  win.addEventListener('drop', (e) => { if (e.dataTransfer.files?.length) { e.preventDefault(); importFiles([...e.dataTransfer.files]); } });
  load();
}
