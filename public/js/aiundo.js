// ↶ AI undo: bring the timeline back to how it was before an Agent edit, a Re-edit or a Claude change.
// The server keeps a copy before each of them (cache/undo); bringing one back reaches every open editor and keeps the
// current edit as a copy too, so an undo can itself be undone. Unlike Ctrl+Z it survives a refresh and covers Claude.
import { S, saveNow } from './store.js';
import { api, enc } from './api.js';
import { $, h, esc, toast, modal } from './ui.js';

// a copy of the edit as it is now, before an AI change (returns its id, or null)
export async function aiSnapshot(label) {
  if (!S.proj) return null;
  try { await saveNow(); return (await api('POST', `/api/aiundo/snap?p=${enc(S.proj)}`, { label })).id; } catch { return null; }
}

const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleString(); };

async function restore(id, label) {
  try {
    await saveNow();
    await api('POST', `/api/aiundo/restore?p=${enc(S.proj)}&id=${id}`);
    toast(`Restored the edit from before "${label}". (The current edit is kept in the list too)`);
    hideBar();
  } catch (e) { toast(e.message, 'err'); }
}

// the list of earlier versions (newest first), each one click away
export async function openAiUndo() {
  if (!S.proj) return;
  let list = [];
  try { list = await api('GET', `/api/aiundo?p=${enc(S.proj)}`); } catch (e) { return toast(e.message, 'err'); }
  const dlg = modal('AI Undo - restore an earlier edit', `<p class="muted small">A copy of the timeline is kept before every Agent edit, Re-edit and Claude change. Click "Restore" on one - the timeline goes back to how it was before that change (the current edit is kept in the list too).</p>
    <div class="dv-list">${list.map((x) => `<div class="dv-item"><span class="grow">${/^↶ undo: /.test(x.label) ? `<b>Edit before an undo</b> <span class="muted small">(undid: ${esc(x.label.slice(8))})</span>` : `Before <b>${esc(x.label)}</b>`}<br><span class="muted small">${esc(ago(x.at))} · ${x.clips} clips</span></span><button class="small" data-undo="${esc(x.id)}" data-label="${esc(x.label)}">Restore</button></div>`).join('') || '<div class="muted pad">No AI edits yet - nothing here.</div>'}</div>
    <div class="dv-actions"><button data-close>Close</button></div>`, { width: 620 });
  dlg.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-undo]'); if (!b) return;
    if (!confirm(`Restore the edit from before "${b.dataset.label}"? The current edit is kept too (in the list).`)) return;
    dlg.close(); restore(b.dataset.undo, b.dataset.label);
  });
}

// after an AI change: a bar at the bottom with one-click undo, for a little while
let barTimer = null;
function hideBar() { clearTimeout(barTimer); $('#aiUndoBar')?.remove(); }
export async function offerAiUndo(what = 'AI edit') {
  hideBar();
  let last = null;
  try { last = (await api('GET', `/api/aiundo?p=${enc(S.proj)}`))[0]; } catch {}
  if (!last) return;
  const bar = h(`<div id="aiUndoBar" class="ai-undo-bar" role="status"><span>${esc(what)} applied. Don't like it?</span>
    <button class="primary small" data-u>Undo</button><button class="link small" data-list>Earlier ones…</button><button class="icon-btn small" data-x aria-label="Close">✕</button></div>`);
  document.body.append(bar);
  bar.querySelector('[data-u]').onclick = () => restore(last.id, last.label);
  bar.querySelector('[data-list]').onclick = () => { hideBar(); openAiUndo(); };
  bar.querySelector('[data-x]').onclick = hideBar;
  barTimer = setTimeout(hideBar, 30000);
}
