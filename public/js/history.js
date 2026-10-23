// 🕘 History panel (Window › History, like Premiere): every change you can undo, oldest first, and the ones you undid
// (greyed). Click a step: the edit goes back - or forward again - to just after it. Your own changes only, this
// browser tab (the 📜 Activity window shows everyone's).
import { on, undo, redo, historySteps } from './store.js';
import { $, esc, toast, modal } from './ui.js';

let dlg = null;
export function openHistory() {
  if (dlg?.el.isConnected) return;
  dlg = modal('History', '<div class="hs-list" data-hs></div><p class="muted small">Click a step to go back to just after it. A new change clears the greyed steps.</p>', { width: 420, onClose: () => { dlg = null; } });
  draw();
  dlg.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-hs-go]'); if (!b) return;
    const { done } = historySteps(), want = +b.dataset.hsGo; // how many steps should stay done
    let n = 0;
    while (historySteps().done.length > want && undo()) n++;
    while (historySteps().done.length < want && redo()) n++;
    if (n) toast(`${want < done.length ? 'Back' : 'Forward'} ${n} step${n > 1 ? 's' : ''}`);
  });
}
function draw() {
  const box = dlg && $('[data-hs]', dlg.el); if (!box) return;
  const { done, undone } = historySteps();
  box.innerHTML = `<button class="hs-row${done.length ? '' : ' cur'}" data-hs-go="0">Start (when this project opened)</button>`
    + done.map((l, i) => `<button class="hs-row${i === done.length - 1 ? ' cur' : ''}" data-hs-go="${i + 1}">${esc(l)}</button>`).join('')
    + undone.map((l, i) => `<button class="hs-row off" data-hs-go="${done.length + i + 1}">${esc(l)}</button>`).join('');
  box.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
}
on('change', () => draw());
