// 📜 Activity: who changed what on this project, newest first - and taking back one change by one person without touching
// anyone else's work (its inverse is applied like any other live change). Whole-edit changes (Agent, Claude) are taken
// back with ↶ AI undo instead.
import { S, saveNow } from './store.js';
import { api, enc } from './api.js';
import { esc, toast, modal } from './ui.js';
import { openAiUndo } from './aiundo.js';

const when = (t) => { const d = new Date(t), today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };

export async function openActivity() {
  if (!S.proj) return;
  await saveNow();
  let list = [];
  try { list = await api('GET', `/api/activity?p=${enc(S.proj)}&limit=300`); } catch (e) { return toast(e.message, 'err'); }
  const people = [...new Set(list.map((x) => x.name))];
  const dlg = modal('📜 Activity - who changed what', `
    <div class="row-in"><label class="fld"><span>Who</span><select data-who><option value="">Everyone</option>${people.map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>
      <span class="grow"></span><button class="link small" data-ai>↶ Undo AI edits (Agent / Claude)…</button></div>
    <div class="dv-list act-list" data-list></div>
    <p class="muted small">"↶ Undo just this" reverts that one change - everyone else's work stays as it is. Big changes (a whole Agent / Claude edit) are undone with ↶ AI Undo.</p>
    <div class="dv-actions"><button data-close>Close</button></div>`, { width: 680 });
  const draw = () => {
    const who = dlg.el.querySelector('[data-who]').value;
    const rows = list.filter((x) => !who || x.name === who);
    dlg.el.querySelector('[data-list]').innerHTML = rows.map((x) => `<div class="dv-item"><span class="act-t muted small">${esc(when(x.at))}</span>
      <span class="grow"><b>${esc(x.name)}</b>: ${esc(x.label || 'Edit')}${x.kind === 'replace' ? ' <span class="muted small">(whole edit replaced)</span>' : ''}</span>
      ${x.revertable ? `<button class="small" data-rev="${esc(x.id)}" data-label="${esc(x.label)}" data-name="${esc(x.name)}">↶ Undo just this</button>` : ''}</div>`).join('') || '<div class="muted pad">No changes recorded yet.</div>';
  };
  draw();
  dlg.el.querySelector('[data-who]').onchange = draw;
  dlg.el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-ai]')) { dlg.close(); return openAiUndo(); }
    const b = e.target.closest('[data-rev]'); if (!b) return;
    if (!confirm(`Undo this change by ${b.dataset.name}: "${b.dataset.label}"?\nEveryone else's work stays as it is.`)) return;
    b.disabled = true;
    try { const r = await api('POST', `/api/activity/revert?p=${enc(S.proj)}&id=${enc(b.dataset.rev)}`); toast(`↶ ${r.label}`); dlg.close(); }
    catch (err) { toast(err.message, 'err'); b.disabled = false; }
  });
}
