// ＋ New ▾ in the Media panel (Premiere's New Item): Sequence, Adjustment Layer, Color Matte, Black Video, Title.
// Layers are placed at the playhead on a free track above the main story.
import { S } from './store.js';
import { ASPECTS } from './model.js';
import { esc, toast, modal } from './ui.js';
import { addAdjustmentLayer, addTitle } from './timeline.js';
import { newEmptySequence } from './sequences.js';
import { addColorMatte } from './motionpage.js';

export function openNewItem(anchor) {
  document.querySelector('.ui-menu')?.remove();
  const m = document.createElement('div'); m.className = 'ui-menu';
  m.innerHTML = [['seq', 'Sequence…'], ['adjust', '◩ Adjustment Layer'], ['matte', '■ Color Matte…'], ['black', 'Black Video'], ['title', 'T Title']].map(([k, l]) => `<button data-k="${k}">${l}</button>`).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect(); m.style.top = `${r.bottom + 4}px`; m.style.left = `${Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.left))}px`;
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
  m.onclick = (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k; if (!k) return;
    m.remove(); document.removeEventListener('pointerdown', close, true);
    if (!S.project) return;
    if (k === 'adjust') addAdjustmentLayer();
    if (k === 'title') { addTitle(); toast('Title added on V2 at the playhead - change the words in Effect Controls'); }
    if (k === 'black') addColorMatte('#000000', 'Black Video');
    if (k === 'matte') askMatte();
    if (k === 'seq') askSequence();
  };
}
function askMatte() {
  const dlg = modal('■ Color Matte', `<label class="fld"><span>Colour</span><input type="color" name="c" value="#0b2545"></label>
    <label class="fld"><span>Name</span><input name="n" value="Color Matte"></label>
    <label class="fld"><span>Length (seconds)</span><input type="number" name="d" min="0.5" step="0.5" value="5"></label>
    <div class="row-in"><span class="grow"></span><button data-close>Cancel</button><button class="primary" data-ok>Add</button></div>`, { width: 380 });
  dlg.el.querySelector('[data-ok]').onclick = () => {
    const q = (n) => dlg.el.querySelector(`[name="${n}"]`).value;
    addColorMatte(q('c'), q('n').trim() || 'Color Matte', Math.max(0.5, +q('d') || 5));
    dlg.close();
  };
}
function askSequence() {
  const dlg = modal('New Sequence', `<label class="fld"><span>Name</span><input name="n" value="Sequence"></label>
    <label class="fld"><span>Frame</span><select name="a">${Object.keys(ASPECTS).map((a) => `<option${a === S.project.settings.aspect ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
    <div class="row-in"><span class="grow"></span><button data-close>Cancel</button><button class="primary" data-ok>Create</button></div>`, { width: 380 });
  dlg.el.querySelector('[data-ok]').onclick = () => {
    const q = (n) => dlg.el.querySelector(`[name="${n}"]`).value;
    newEmptySequence(q('n').trim() || 'Sequence', q('a'));
    dlg.close();
  };
}
