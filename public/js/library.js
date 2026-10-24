// Library shared by every project (<app>/Library on disk): ⭐ my effect presets, saved caption styles,
// 🏷 client brand packs (logo, colours, font, caption / lower-third style, intro / outro, end card) and project templates.
import { S, commit, emit, findClip, on } from './store.js';
import { api, enc, upload } from './api.js';
import { uid } from './model.js';
import { h, $, $$, esc, toast, modal } from './ui.js';
import { refreshMedia } from './mediapool.js';
import { CAPTION_PRESETS } from './captions.js';
import { applyPack, recolorTitle, packColors, LOGO_POS, LT_TITLES, LT_MOTION } from './brandpack.js';
import { fontField, pickFont } from './fontpick.js';

let lib = null;
export async function loadLib(force = false) { if (!lib || force) lib = await api('GET', '/api/library'); return lib; }
export const libCached = () => lib;

// ---------------- effect presets (a clip's look) ----------------
const LOOK_KEYS = ['effects', 'color', 'cutFx', 'blend'];
export async function saveFxPreset(clipId) {
  const c = findClip(clipId)?.clip; if (!c) return;
  const data = Object.fromEntries(LOOK_KEYS.filter((k) => c[k] && (!Array.isArray(c[k]) || c[k].length)).map((k) => [k, JSON.parse(JSON.stringify(c[k]))]));
  if (!Object.keys(data).length) return toast('This clip has no effects, colour, cut effect or blend to save', 'err');
  const name = prompt('Name for this look (it will be in Effects > My presets):', 'My look');
  if (!name?.trim()) return;
  lib = await api('PUT', '/api/library/presets', { kind: 'fx', item: { id: uid(), name: name.trim(), data } }).then((p) => ({ ...(lib || {}), presets: p }));
  emit('library'); toast(`"${name.trim()}" saved - drag it onto any clip from Effects`);
}
// adds the preset's effects (copies) to the clip's own, and sets its colour / cut effect / blend
export function applyFxPreset(item, c) {
  const d = item.data || {};
  if (d.effects?.length) c.effects = [...(c.effects || []), ...d.effects.map((e) => ({ ...JSON.parse(JSON.stringify(e)), id: uid() }))];
  if (d.color) c.color = JSON.parse(JSON.stringify(d.color));
  if (d.cutFx) c.cutFx = { ...d.cutFx };
  if (d.blend) c.blend = d.blend;
  return item.name;
}
export async function deletePreset(kind, id) {
  lib = await api('PUT', '/api/library/presets', { kind, id, remove: true }).then((p) => ({ ...(lib || {}), presets: p }));
  emit('library');
}
export async function saveCaptionStyle(st = S.project.captions?.style) { // (🗂 the CC panel passes the track being edited)
  if (!st) return;
  const name = prompt('Name for this caption style:', 'My captions');
  if (!name?.trim()) return;
  lib = await api('PUT', '/api/library/presets', { kind: 'captions', item: { id: uid(), name: name.trim(), data: { ...st } } }).then((p) => ({ ...(lib || {}), presets: p }));
  emit('library'); toast(`Caption style "${name.trim()}" saved - it is in the style list of every project`);
}

// ---------------- 🏷 client brand packs (public/js/brandpack.js; on disk: engine/brandpacks.mjs) ----------------
// a new title in the project's brand colours
export const brandTitle = (c) => { recolorTitle(c, S.project?.brand); return c; };

let packs = null;
export async function loadPacks(force = false) { if (!packs || force) packs = await api('GET', '/api/library/brandpacks'); return packs; }

// the brand's colours offered in every colour picker (<input type="color" list="brandSw">)
let swKey = null;
export function syncSwatches() {
  const cols = packColors(S.project?.brand), key = cols.join();
  if (key === swKey) return;
  swKey = key;
  let dl = document.getElementById('brandSw');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'brandSw'; document.body.append(dl); }
  dl.innerHTML = cols.map((c) => `<option value="${c}"></option>`).join('');
}
on('change', syncSwatches);

// the pack's files into this project's Media, then the pack onto the project as one change (one Ctrl+Z takes it back)
export async function applyPackToProject(id, { intro = true, outro = true } = {}) {
  const r = await api('POST', `/api/library/brandpacks/use?p=${enc(S.proj)}`, { id });
  await refreshMedia();
  const files = Object.fromEntries(Object.entries(r.files || {}).map(([k, m]) => [k, S.mediaById[m.id] || m]));
  applyPack(S.project, r.pack, files, { intro, outro, uid });
  commit(`Brand pack: ${r.pack.name}`); emit('subs'); emit('fit');
  return r.pack;
}

const SLOT_LABEL = { logo: 'Logo', intro: 'Intro clip', outro: 'Outro clip' };
const opts = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('');
const fileUrl = (p, s) => `/api/library/brandpacks/file?id=${enc(p.id)}&slot=${s}&t=${p.saved || 0}`;
const fileName = (f) => String(f || '').split(/[\\/]/).pop();

// 🏷 Brand packs: the list on the left, the chosen pack's logo / colours / styles / intro / outro on the right and
// "Apply to this project" at the bottom (inside a project). New project opens it too, with no project yet.
export async function openBrandKit(setBusy, { onClose } = {}) {
  let list = await loadPacks(true).catch((e) => { toast(e.message, 'err'); return []; });
  let cur = list.find((p) => p.id === S.project?.brand?.pack?.id) || list[0] || null, dirty = false;
  const inProject = !!(S.proj && S.project), L = inProject ? await loadLib(true).catch(() => ({})) : {};
  const body = h(`<div class="bp"><div class="bp-side"><div class="bp-list" role="listbox" aria-label="Brand packs"></div>
    <button type="button" data-a="new">+ New pack</button>
    ${inProject ? `<div class="bk-h">Project templates</div><div class="bk-tpl">${(L.templates || []).map((t) => `<span class="chip">${esc(t.name)} <small class="muted">${esc(t.aspect || '')}</small> <button class="link small" data-deltpl="${esc(t.name)}" title="Delete template">✕</button></span>`).join('') || '<span class="muted small">None yet.</span>'}
      <button type="button" class="small" data-a="savetpl">Save this project as a template</button></div>` : ''}</div>
    <div class="bp-main"></div></div>`);
  const dlg = modal('Brand packs', body, { width: 1000, onClose });
  const side = $('.bp-list', body), main = $('.bp-main', body);
  const onProject = (p) => p.id === S.project?.brand?.pack?.id;
  const drawList = () => {
    side.innerHTML = list.map((p) => `<button type="button" class="bp-it${p.id === cur?.id ? ' on' : ''}" role="option" aria-selected="${p.id === cur?.id}" aria-label="${esc(p.name)}${p.client ? ` - ${esc(p.client)}` : ''}" data-pick="${p.id}">
      <span class="bp-logo" style="background:${esc(p.primary)}">${p.has?.logo ? `<img src="${fileUrl(p, 'logo')}" alt="">` : ''}</span>
      <span class="bp-nm"><b>${esc(p.name)}</b><small class="muted">${esc(p.client || '')}${onProject(p) ? `${p.client ? ' · ' : ''}on this project` : ''}</small></span>
      <span class="bp-dots">${packColors(p).slice(0, 5).map((c) => `<i style="background:${c}"></i>`).join('')}</span></button>`).join('') || '<p class="muted small">No packs yet - make one for each client.</p>';
  };
  const media = (kinds) => (inProject ? S.media.filter((m) => kinds.includes(m.kind) && m.path) : []);
  const slotRow = (p, s) => {
    const list2 = media(s === 'logo' ? ['image'] : ['video', 'image']), f = p[s], ok = p.has?.[s];
    return `<div class="fld wide bp-file"><span>${SLOT_LABEL[s]}</span><div class="row-in">
      ${s === 'logo' && ok ? `<img class="bp-thumb" src="${fileUrl(p, 'logo')}" alt="">` : ''}
      <span class="bp-fname${f && !ok ? ' bad' : ''}" title="${esc(f || '')}">${f ? `${esc(fileName(f))}${ok ? '' : ' (file missing)'}` : '<span class="muted">None</span>'}</span>
      <button type="button" class="small" data-up="${s}">Upload…</button>
      ${list2.length ? `<select class="small" data-from="${s}" aria-label="${SLOT_LABEL[s]} from this project"><option value="">From this project…</option>${list2.map((m) => `<option value="${esc(m.path)}">${esc(m.name)}</option>`).join('')}</select>` : ''}
      ${f ? `<button type="button" class="small link" data-clear="${s}">Remove</button>` : ''}</div></div>`;
  };
  const drawMain = () => {
    if (!cur) { main.innerHTML = '<div class="bp-empty"><p>A brand pack keeps one client\'s logo, intro / outro, colours, font, caption and lower-third style - and puts them on a project in one click.</p><button type="button" class="primary" data-a="new">+ New pack</button></div>'; return; }
    const p = cur;
    main.innerHTML = `<form class="bp-form" autocomplete="off"><div class="fgrid">
      <label class="fld"><span>Pack name</span><input name="name" value="${esc(p.name)}" required maxlength="80"></label>
      <label class="fld"><span>Client / ministry</span><input name="client" value="${esc(p.client)}" placeholder="e.g. Ministry of Youth Affairs" maxlength="120"></label>
      ${slotRow(p, 'logo')}
      <label class="fld"><span>Logo corner</span><select name="logoPos">${opts(LOGO_POS, p.logoPos)}</select></label>
      <label class="fld"><span>Logo size <i data-v="logoScale">${Math.round(p.logoScale * 100)}%</i></span><input type="range" name="logoScale" min="0.03" max="0.5" step="0.01" value="${p.logoScale}"></label>
      <label class="fld"><span>Logo opacity <i data-v="logoOpacity">${Math.round(p.logoOpacity * 100)}%</i></span><input type="range" name="logoOpacity" min="0.1" max="1" step="0.05" value="${p.logoOpacity}"></label>
      <div class="fld wide"><span>Colours</span><div class="bp-cols">
        <label>Main <input type="color" name="primary" value="${esc(p.primary)}"></label><label>Accent <input type="color" name="accent" value="${esc(p.accent)}"></label>
        <label>Text <input type="color" name="text" value="${esc(p.text)}"></label><label>Charts <input type="color" name="accent2" value="${esc(p.accent2 || '#138808')}"></label>
        ${p.palette.map((c, i) => `<span class="bp-sw"><input type="color" data-pal="${i}" value="${esc(c)}" aria-label="Extra colour ${i + 1}"><button type="button" class="link small" data-palx="${i}" aria-label="Remove colour ${i + 1}">✕</button></span>`).join('')}
        ${p.palette.length < 8 ? '<button type="button" class="small" data-a="addcol">+ Colour</button>' : ''}</div>
        <small>Main = boxes, cards and strips; accent = highlights and bars. All of them show in the colour pickers of graphics and titles.</small></div>
      ${fontField(p.font, 'Arial')}
      <label class="fld"><span>Caption style</span><select name="capPreset">${opts(Object.entries(CAPTION_PRESETS).map(([k, x]) => [k, x.label]), p.capPreset)}</select></label>
      <label class="fld"><span>Lower third (title)</span><select name="ltTitle">${opts(LT_TITLES, p.ltTitle)}</select></label>
      <label class="fld"><span>Lower third (motion graphic)</span><select name="ltMotion">${opts(LT_MOTION, p.ltMotion)}</select></label>
      ${slotRow(p, 'intro')}
      <label class="fld"><span>Intro length (if a picture)</span><input type="number" name="introDur" min="0.5" max="15" step="0.5" value="${p.introDur}"></label>
      ${slotRow(p, 'outro')}
      <label class="fld"><span>Outro / end card length</span><input type="number" name="outroDur" min="0.5" max="15" step="0.5" value="${p.outroDur}"></label>
      <label class="fld wide"><span>End card text (used when there is no outro clip)</span><input name="endText" value="${esc(p.endText)}" placeholder="e.g. mybharat.gov.in" maxlength="200"></label>
    </div>
    <div class="ag-foot bp-foot"><button type="button" data-a="save">Save</button><button type="button" data-a="dup">Duplicate</button><button type="button" class="link" data-a="del">Delete</button><span class="grow"></span>
      ${inProject ? `<label class="chk"><input type="checkbox" name="doIntro" checked> Intro</label><label class="chk"><input type="checkbox" name="doOutro" checked> Outro / end card</label>
      <button type="button" class="primary" data-a="apply">Apply to this project</button>` : '<button type="button" data-close>Close</button>'}</div></form>`;
    $('[data-fontpick]', main).addEventListener('click', (e) => pickFont(e.currentTarget, cur.font, (fam) => { read(); cur.font = fam || 'Arial'; dirty = true; drawMain(); }, 'Arial'));
  };
  const form = () => $('.bp-form', main);
  // what the form says now, kept in cur (so redrawing after a file or colour change loses nothing)
  const read = () => {
    const F = form(); if (!F || !cur) return cur;
    const v = (n) => F.elements[n]?.value;
    Object.assign(cur, { name: v('name').trim() || cur.name, client: v('client'), logoPos: v('logoPos'), logoScale: +v('logoScale'), logoOpacity: +v('logoOpacity'),
      primary: v('primary'), accent: v('accent'), text: v('text'), accent2: v('accent2'), palette: $$('[data-pal]', F).map((x) => x.value),
      capPreset: v('capPreset'), ltTitle: v('ltTitle'), ltMotion: v('ltMotion'), introDur: +v('introDur'), outroDur: +v('outroDur'), endText: v('endText') });
    return cur;
  };
  const show = (p) => {
    const i = list.findIndex((x) => x.id === p.id);
    cur = { ...p, has: p.has || list[i]?.has || {} };
    if (i < 0) list.push(cur); else list[i] = cur;
    list.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    packs = null; dirty = false; drawList(); drawMain();
  };
  const save = async () => { const p = await api('POST', '/api/library/brandpacks/save', { pack: read() }); show(p); return p; };
  const reload = async (id = cur?.id) => { list = await loadPacks(true); cur = list.find((p) => p.id === id) || list[0] || null; dirty = false; drawList(); drawMain(); };
  const busy = async (msg, fn) => { setBusy?.(true, msg); try { return await fn(); } catch (e) { toast(e.message, 'err'); return null; } finally { setBusy?.(false); } };
  const leave = () => !dirty || !cur || confirm(`Leave "${cur.name}" without saving the changes?`);
  // a file into the pack: what was typed is saved first, then the file goes into the pack's own folder
  const setFile = (slot, how) => busy(`Adding the ${SLOT_LABEL[slot].toLowerCase()}…`, async () => { read(); if (dirty) await save(); await how(); await reload(); toast(`${SLOT_LABEL[slot]} added to "${cur.name}"`); });

  main.addEventListener('input', (e) => {
    dirty = true;
    const t = e.target.closest('[name="logoScale"],[name="logoOpacity"]');
    if (t) $(`[data-v="${t.name}"]`, main).textContent = `${Math.round(t.value * 100)}%`;
  });
  main.addEventListener('change', (e) => {
    const from = e.target.closest('[data-from]');
    if (from?.value) setFile(from.dataset.from, () => api('POST', '/api/library/brandpacks/addpath', { id: cur.id, slot: from.dataset.from, path: from.value }));
  });
  body.addEventListener('click', async (e) => {
    const at = (k) => e.target.closest(`[data-${k}]`)?.dataset[k];
    const pk = at('pick'), a = at('a'), del = at('deltpl'), up = at('up'), clr = at('clear'), px = at('palx');
    if (pk) { if (!leave()) return; cur = list.find((p) => p.id === pk); dirty = false; drawList(); drawMain(); return; }
    if (up) {
      const inp = h(`<input type="file" accept="${up === 'logo' ? 'image/*' : 'video/*,image/*'}" hidden>`); document.body.append(inp);
      inp.onchange = () => { const f = inp.files[0]; inp.remove(); if (f) setFile(up, () => upload(`/api/library/brandpacks/upload?id=${enc(cur.id)}&slot=${up}&name=${enc(f.name)}`, f, (k) => setBusy?.(true, `Uploading ${f.name}… ${Math.round(k * 100)}%`))); };
      inp.click(); return;
    }
    if (clr) { read(); cur[clr] = ''; await busy('Saving…', save); return; }
    if (px != null) { read(); cur.palette.splice(+px, 1); dirty = true; drawMain(); return; }
    if (del) { if (confirm(`Delete template "${del}"?`)) { await api('POST', '/api/library/template/delete', { name: del }); e.target.closest('.chip').remove(); } return; }
    if (a === 'addcol') { read(); cur.palette.push(cur.accent); dirty = true; drawMain(); return; }
    if (a === 'new') {
      if (!leave()) return;
      const name = prompt('Name of the client / brand (e.g. MY Bharat, Khelo India):'); if (!name?.trim()) return;
      // a new pack starts from the one open (its colours and styles - not its files), or from the defaults
      const base = cur ? { ...cur, id: '', logo: '', intro: '', outro: '', client: '', notes: '', has: {} } : {};
      const p = await busy('Making the pack…', () => api('POST', '/api/library/brandpacks/save', { pack: { ...base, name: name.trim() } }));
      if (p) { show({ ...p, has: {} }); toast(`"${p.name}" made - add its logo, intro and outro`); }
      return;
    }
    if (a === 'save') { const p = await busy('Saving…', save); if (p) toast(`"${p.name}" saved for everyone`); return; }
    if (a === 'dup') {
      const p = await busy('Copying…', async () => { read(); if (dirty) await save(); return api('POST', '/api/library/brandpacks/duplicate', { id: cur.id }); });
      if (p) { await reload(p.id); toast(`"${p.name}" made - rename it and change what differs`); }
      return;
    }
    if (a === 'del') {
      if (!confirm(`Delete the brand pack "${cur.name}" for everyone?\n\nProjects that already use it keep their logo, intro and outro.`)) return;
      if (await busy('Deleting…', () => api('POST', '/api/library/brandpacks/delete', { id: cur.id }))) { list = list.filter((p) => p.id !== cur.id); cur = list[0] || null; packs = null; dirty = false; drawList(); drawMain(); }
      return;
    }
    if (a === 'apply') {
      const F = form(), o = { intro: F.elements.doIntro.checked, outro: F.elements.doOutro.checked };
      const p = await busy('Applying the brand pack…', async () => { read(); if (dirty) await save(); return applyPackToProject(cur.id, o); });
      if (p) { dlg.close(); toast(`"${p.name}" applied - logo, colours, captions, lower thirds${o.intro || o.outro ? ', intro / outro' : ''}. Ctrl+Z takes it back.`); }
      return;
    }
    if (a === 'savetpl') {
      const name = prompt('Template name:', `${S.proj} template`); if (!name?.trim()) return;
      const r = await api('POST', `/api/library/template?p=${enc(S.proj)}`, { name: name.trim() }); lib = null;
      toast(`Template "${r.name}" saved - choose it in New project`);
      e.target.insertAdjacentHTML('beforebegin', `<span class="chip">${esc(r.name)}</span>`);
    }
  });
  drawList(); drawMain();
  return dlg;
}
