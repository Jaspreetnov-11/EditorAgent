// 🏷 Tags: free-text labels with a colour (Premiere's labels + keywords) on templates, media and projects.
// A tag's colour comes from its name (the same tag looks the same everywhere).
import { $, esc, modal } from './ui.js';

// Premiere's label colours
export const PALETTE = ['#9c7bd8', '#5b6fe0', '#1fb5a8', '#c79be8', '#2f9bd8', '#4e9a3c', '#e07a9c', '#f0a030', '#a35bd0', '#3a74e0', '#2aa7a0', '#d24fa0', '#c8a878', '#6cc04a', '#a0703c', '#e8cf3a'];
const hash = (s) => [...s.toLowerCase()].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
export const tagColor = (t) => PALETTE[hash(String(t)) % PALETTE.length];

// the same rules as the server: trimmed, each once (case ignored), at most 20 of up to 32 characters
export const cleanTags = (list) => (list || []).map((t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 32)).filter(Boolean)
  .filter((t, i, a) => a.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i).slice(0, 20); // (the first spelling stays)
export const parseTags = (s) => cleanTags(String(s || '').split(/[,;#]/));

export const tagChips = (tags = [], { remove = false } = {}) => (tags || []).map((t) => `<span class="tag-chip" style="--tc:${tagColor(t)}" data-tagname="${esc(t)}">${esc(t)}${remove ? `<b data-untag="${esc(t)}" title="Remove">×</b>` : ''}</span>`).join('');

// the tag editor: the tags as chips (× takes one off), type new ones (Enter / comma adds), click a suggestion to add
// it. Resolves to the new list, or null when closed without saving.
export function editTags(tags = [], { title = 'Tags', suggest = [] } = {}) {
  return new Promise((ok) => {
    let cur = cleanTags(tags), done = false;
    const dlg = modal(`🏷 ${esc(title)}`, `<div class="tag-ed">
      <div class="tag-ed-cur" data-cur></div>
      <div class="row-in"><input data-new placeholder="Type a tag and press Enter (e.g. logo, intro, client: MyGov)" maxlength="32" aria-label="New tag"><button data-add>Add</button></div>
      <div class="tag-ed-sug" data-sug></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px"><button data-close>Cancel</button><button class="primary" data-save>Save</button></div></div>`,
    { width: 460, onClose: () => { if (!done) ok(null); } });
    const el = dlg.el, inp = $('[data-new]', el);
    const draw = () => {
      $('[data-cur]', el).innerHTML = cur.length ? tagChips(cur, { remove: true }) : '<span class="muted small">No tags yet</span>';
      const have = new Set(cur.map((t) => t.toLowerCase())), sg = cleanTags(suggest).filter((t) => !have.has(t.toLowerCase()));
      $('[data-sug]', el).innerHTML = sg.length ? `<span class="muted small">Used before:</span> ${sg.slice(0, 24).map((t) => `<button class="chip utag" data-sg="${esc(t)}" style="--tc:${tagColor(t)}">${esc(t)}</button>`).join('')}` : '';
    };
    const add = () => { const n = parseTags(inp.value); if (n.length) { cur = cleanTags([...cur, ...n]); inp.value = ''; draw(); } };
    el.addEventListener('click', (e) => {
      const un = e.target.closest('[data-untag]')?.dataset.untag;
      if (un !== undefined) { cur = cur.filter((t) => t !== un); return draw(); }
      const sg = e.target.closest('[data-sg]')?.dataset.sg;
      if (sg) { cur = cleanTags([...cur, sg]); return draw(); }
      if (e.target.closest('[data-add]')) return add();
      if (e.target.closest('[data-save]')) { add(); done = true; dlg.close(); ok(cur); }
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if (inp.value.trim()) add(); else { done = true; dlg.close(); ok(cur); } } });
    draw(); inp.focus();
  });
}
