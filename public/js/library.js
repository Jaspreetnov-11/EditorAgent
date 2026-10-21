// Library shared by every project (<app>/Library on disk): ⭐ my effect presets, saved caption styles,
// the 🏷 brand kit (logo, colours, font, intro / outro, end card) and project templates.
import { S, commit, emit, findClip } from './store.js';
import { api, enc } from './api.js';
import { uid } from './model.js';
import { h, esc, toast, modal } from './ui.js';
import { refreshMedia } from './mediapool.js';
import { CAPTION_PRESETS, CAPTION_FONTS } from './captions.js';

let lib = null;
export async function loadLib(force = false) { if (!lib || force) lib = await api('GET', '/api/library'); return lib; }
export const libCached = () => lib;

// ---------------- effect presets (a clip's look) ----------------
const LOOK_KEYS = ['effects', 'color', 'cutFx', 'blend'];
export async function saveFxPreset(clipId) {
  const c = findClip(clipId)?.clip; if (!c) return;
  const data = Object.fromEntries(LOOK_KEYS.filter((k) => c[k] && (!Array.isArray(c[k]) || c[k].length)).map((k) => [k, JSON.parse(JSON.stringify(c[k]))]));
  if (!Object.keys(data).length) return toast('This clip has no effects, colour, cut effect or blend to save', 'err');
  const name = prompt('Name for this look (it will be in ✨ Effects > ⭐ My presets):', 'My look');
  if (!name?.trim()) return;
  lib = await api('PUT', '/api/library/presets', { kind: 'fx', item: { id: uid(), name: name.trim(), data } }).then((p) => ({ ...(lib || {}), presets: p }));
  emit('library'); toast(`⭐ "${name.trim()}" saved - drag it onto any clip from ✨ Effects`);
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
export async function saveCaptionStyle() {
  const st = S.project.captions?.style; if (!st) return;
  const name = prompt('Name for this caption style:', 'My captions');
  if (!name?.trim()) return;
  lib = await api('PUT', '/api/library/presets', { kind: 'captions', item: { id: uid(), name: name.trim(), data: { ...st } } }).then((p) => ({ ...(lib || {}), presets: p }));
  emit('library'); toast(`⭐ Caption style "${name.trim()}" saved - it is in the style list of every project`);
}

// ---------------- brand kit ----------------
const recolor = (c, b) => {
  if (c.type !== 'title') return;
  if (c.box && c.box !== 'none') c.box = b.primary;
  if (c.strip) c.strip = b.primary;
  if (c.accent) c.accent = b.accent;
  if (c.bg && !c.mediaId) c.bg = b.primary;
};
export const brandTitle = (c) => { if (S.project?.brand?.primary) recolor(c, S.project.brand); return c; };

export async function applyBrand(b, { intro = true, outro = true } = {}) {
  const P = S.project, add = async (p) => (p ? api('POST', `/api/media/addpath?p=${enc(S.proj)}`, { path: p, bin: 'Brand' }).catch((e) => { toast(e.message, 'err'); return null; }) : null);
  const [logo, inM, outM] = await Promise.all([add(b.logo), intro ? add(b.intro) : null, outro ? add(b.outro) : null]);
  await refreshMedia();
  if (logo) P.logo = { ...(P.logo || {}), mediaId: logo.id, pos: b.logoPos || P.logo?.pos || 'tr', scale: P.logo?.scale ?? 0.12, opacity: P.logo?.opacity ?? 0.9 };
  // captions in the brand's colours and font
  const cs = P.captions?.style || { ...CAPTION_PRESETS.karaoke, preset: 'karaoke' };
  P.captions = { on: P.captions?.on ?? false, cues: P.captions?.cues || [], style: { ...cs, ...(b.capPreset && CAPTION_PRESETS[b.capPreset] ? CAPTION_PRESETS[b.capPreset] : {}), preset: 'brand', font: b.font || cs.font, hl: b.accent || cs.hl, ...(cs.box || CAPTION_PRESETS[b.capPreset]?.box ? { box: b.primary } : {}) } };
  // every title in the brand colours (new ones too: project.brand)
  for (const l of Object.values(P.tracks)) l.forEach((c) => recolor(c, b));
  P.brand = { primary: b.primary, accent: b.accent, text: b.text, font: b.font };
  // intro / outro shots at the start / end of the main story (earlier brand ones are replaced)
  P.tracks.V1 = P.tracks.V1.filter((c) => !c.brandClip);
  if (inM) P.tracks.V1.unshift({ id: uid(), type: inM.kind === 'image' ? 'image' : 'video', mediaId: inM.id, ...(inM.kind === 'image' ? { dur: 2.5 } : { in: 0 }), brandClip: 'intro' });
  if (outM) P.tracks.V1.push({ id: uid(), type: outM.kind === 'image' ? 'image' : 'video', mediaId: outM.id, ...(outM.kind === 'image' ? { dur: 3 } : { in: 0 }), brandClip: 'outro', transitionIn: { type: 'fadeblack', dur: 0.5 } });
  else if (outro && b.endText) P.tracks.V1.push({ id: uid(), type: 'title', text: b.endText, dur: 3, bg: b.primary || '#0b2545', textColor: b.text || '#ffffff', accent: b.accent, brandClip: 'outro', transitionIn: { type: 'fadeblack', dur: 0.5 } });
  commit('Apply brand kit'); emit('subs'); emit('fit');
}

export async function openBrandKit(setBusy) {
  const L = await loadLib(true), b = { primary: '#0b2545', accent: '#ff9933', text: '#ffffff', font: 'Arial', capPreset: 'karaoke', logoPos: 'tr', ...L.brand };
  const files = (kinds) => S.media.filter((m) => kinds.includes(m.kind));
  const opt = (list, cur) => `<option value="">None</option>${list.map((m) => `<option value="${esc(m.path)}"${m.path === cur ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}${cur && !list.some((m) => m.path === cur) ? `<option value="${esc(cur)}" selected>${esc(cur.split(/[\\/]/).pop())}</option>` : ''}`;
  const body = h(`<div class="bk">
    <p class="muted small">Saved once, used in every project. Pick the files from this project's media (upload them first if needed).</p>
    <div class="fgrid">
      <label class="fld"><span>Logo</span><select name="logo">${opt(files(['image']), b.logo)}</select></label>
      <label class="fld"><span>Logo corner</span><select name="logoPos">${[['tr', 'Top right'], ['tl', 'Top left'], ['br', 'Bottom right'], ['bl', 'Bottom left']].map(([v, l]) => `<option value="${v}"${b.logoPos === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="fld"><span>Main colour (boxes, cards)</span><input type="color" name="primary" value="${esc(b.primary)}"></label>
      <label class="fld"><span>Accent (highlights, bars)</span><input type="color" name="accent" value="${esc(b.accent)}"></label>
      <label class="fld"><span>Text colour</span><input type="color" name="text" value="${esc(b.text)}"></label>
      <label class="fld"><span>Font</span><select name="font">${CAPTION_FONTS.map((f) => `<option${f === b.font ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
      <label class="fld"><span>Caption style</span><select name="capPreset">${Object.entries(CAPTION_PRESETS).map(([k, p]) => `<option value="${k}"${b.capPreset === k ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
      <label class="fld"><span>Intro clip</span><select name="intro">${opt(files(['video', 'image']), b.intro)}</select></label>
      <label class="fld"><span>Outro clip</span><select name="outro">${opt(files(['video', 'image']), b.outro)}</select></label>
      <label class="fld wide"><span>End card text (used when there is no outro clip)</span><input name="endText" value="${esc(b.endText || '')}" placeholder="e.g. mybharat.gov.in"></label>
    </div>
    <div class="row-in"><label class="chk"><input type="checkbox" name="doIntro" checked> Add intro</label><label class="chk"><input type="checkbox" name="doOutro" checked> Add outro / end card</label></div>
    <div class="bk-h">📁 Project templates</div>
    <div class="bk-tpl">${(L.templates || []).map((t) => `<span class="chip">${esc(t.name)} <small class="muted">${esc(t.aspect || '')}</small> <button class="link small" data-deltpl="${esc(t.name)}" title="Delete template">✕</button></span>`).join('') || '<span class="muted small">None yet.</span>'}
      <button class="small" data-a="savetpl">💾 Save this project as a template</button></div>
    <div class="ag-foot"><button type="button" data-a="save">Save brand</button><span class="grow"></span><button type="button" data-close>Close</button><button type="button" class="primary" data-a="apply">🏷 Save & apply to this project</button></div></div>`);
  const dlg = modal('🏷 Brand kit & templates', body, { width: 700 });
  const f = (n) => body.querySelector(`[name="${n}"]`);
  const read = () => Object.fromEntries(['logo', 'logoPos', 'primary', 'accent', 'text', 'font', 'capPreset', 'intro', 'outro', 'endText'].map((k) => [k, f(k).value]));
  body.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a, del = e.target.closest('[data-deltpl]')?.dataset.deltpl;
    if (del) { if (confirm(`Delete template "${del}"?`)) { await api('POST', '/api/library/template/delete', { name: del }); e.target.closest('.chip').remove(); } return; }
    if (a === 'save' || a === 'apply') {
      const nb = read();
      await api('PUT', '/api/library/brand', nb); lib = null;
      if (a === 'save') return toast('🏷 Brand kit saved');
      dlg.close(); setBusy?.(true, '🏷 Applying the brand…');
      try { await applyBrand(nb, { intro: f('doIntro').checked, outro: f('doOutro').checked }); toast('🏷 Brand applied: logo, title and caption colours, intro / outro'); }
      catch (err) { toast(err.message, 'err'); } finally { setBusy?.(false); }
    }
    if (a === 'savetpl') {
      const name = prompt('Template name:', `${S.proj} template`); if (!name?.trim()) return;
      const r = await api('POST', `/api/library/template?p=${enc(S.proj)}`, { name: name.trim() }); lib = null;
      toast(`📁 Template "${r.name}" saved - choose it in New project`);
      e.target.insertAdjacentHTML('beforebegin', `<span class="chip">${esc(r.name)}</span>`);
    }
  });
}
