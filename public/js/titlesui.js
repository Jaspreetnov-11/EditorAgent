// Template gallery: pick a lower third / tag / card. New ones go in at the playhead (cards into the main story);
// with `target` set, the chosen look restyles that clip and keeps its words.
import { S, commit, emit, findClip, layout } from './store.js';
import { uid } from './model.js';
import { h, esc, modal, toast } from './ui.js';
import { brandTitle } from './library.js';
import { TEMPLATES, templateById, applyTemplate } from './templates.js';

function preview(t) {
  const p = t.props, size = p.size ? `--ts:${(p.size / 1080) * 100}cqh;` : '';
  if (t.track === 'V1') {
    return `<div class="tpl-prev" style="background:${esc(p.bg)}"><div class="lyr title-card" style="background:${esc(p.bg)}"><span style="color:${esc(p.textColor)};font-size:${(p.size / 1080) * 100}cqh${p.accent ? `;border-bottom:.12em solid ${esc(p.accent)};padding-bottom:.3em` : ''}">${esc(p.text)}</span>${p.tricolour ? '<i class="tri card"></i>' : ''}</div></div>`;
  }
  const style = p.textStyle || 'center', boxed = p.box ? p.box !== 'none' : style !== 'center';
  return `<div class="tpl-prev"><div class="lyr txt s-${style}${boxed && !p.strip ? ' boxed' : ''}${p.strip ? ' striped' : ''}" style="color:${esc(p.textColor)};${size}">
    <span style="${p.box && p.box !== 'none' ? `background:${esc(p.box)};` : ''}${p.accent ? `border-left:.25em solid ${esc(p.accent)};` : ''}${p.strip ? `--strip:${esc(p.strip)};` : ''}">${esc(p.text)}${p.tricolour ? '<i class="tri"></i>' : ''}</span></div></div>`;
}

export function openTemplates({ target = null } = {}) {
  const groups = [...new Set(TEMPLATES.map((t) => t.group))];
  const tc = target && findClip(target)?.clip;
  const list = TEMPLATES.filter((t) => !tc || (tc.type === 'title' && findClip(target).track === 'V1' ? t.track === 'V1' : t.track === 'V2'));
  const body = h(`<div><p class="muted small">${tc ? 'Pick a look - the text stays the same.' : 'Pick one: it is added at the playhead. Double-click it on the timeline later to change the words.'}</p>
    <div class="tpl-grid">${groups.map((g) => { const ts = list.filter((t) => t.group === g); return ts.length ? `<h4>${g}</h4>${ts.map((t) => `<button class="tpl" data-t="${t.id}">${preview(t)}<small>${esc(t.label)}</small></button>`).join('')}` : ''; }).join('')}</div></div>`);
  const d = modal(tc ? '🎨 Change the title style' : '🔤 Titles & lower thirds', body, { width: 860 });
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    const t = templateById(b.dataset.t);
    if (tc) { applyTemplate(tc, t); commit(`Title style: ${t.label}`); d.close(); return; }
    const c = brandTitle({ id: uid(), type: 'title', dur: t.dur, ...t.props, template: t.id });
    if (t.track === 'V2') {
      c.start = +S.playhead.toFixed(3);
      S.project.tracks.V2.push(c);
    } else {
      // full-screen card: into the main story after the shot under the playhead
      const L = layout().V1, i = L.findIndex((x) => S.playhead >= x.start && S.playhead < x.end);
      S.project.tracks.V1.splice(i < 0 ? S.project.tracks.V1.length : i + 1, 0, c);
    }
    S.sel = new Set([c.id]);
    commit(`Add ${t.label}`); emit('select');
    toast(`${t.label} added - change the words in the Inspector`);
    d.close();
  });
}
