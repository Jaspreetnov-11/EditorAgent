// 🔤 Font picker, like Premiere's Essential Graphics: every font installed on this computer, each name written in its own
// face, with a search box; ↑ / ↓ and Enter work, Esc closes. The fonts come from the browser (Local Font Access - Chrome /
// Edge ask once) or, where that is not allowed, a list of the usual Windows fonts. A graphic is drawn (and baked for the
// render) by this browser, so the font must be installed on the computer that renders it.
import { esc } from './ui.js';

const COMMON = ['Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
  'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free', 'Javanese Text', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode',
  'Malgun Gothic', 'Mangal', 'Microsoft Sans Serif', 'MV Boli', 'Nirmala UI', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Black',
  'Segoe UI Semibold', 'Sitka Text', 'Sylfaen', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Aparajita', 'Kokila', 'Utsaah', 'Poppins', 'Montserrat', 'Roboto', 'Open Sans'];
let cache = null;
// the families installed here, sorted (Local Font Access when the browser gives it, else the usual ones that are here)
export async function fontFamilies() {
  if (cache) return cache;
  let fams = [];
  try { if (window.queryLocalFonts) fams = [...new Set((await window.queryLocalFonts()).map((f) => f.family))]; } catch {}
  if (!fams.length) fams = COMMON.filter((f) => { try { return document.fonts.check(`12px "${f}"`) && installed(f); } catch { return true; } });
  cache = fams.sort((a, b) => a.localeCompare(b));
  return cache;
}
// a font that is not installed falls back to the default: compare its width with two fallbacks
const probe = document.createElement('canvas').getContext('2d');
function installed(f) {
  const w = (fam) => { probe.font = `40px ${fam}`; return probe.measureText('mmmmmmmmlli 1234 अआक').width; };
  return w(`"${f}", monospace`) !== w('monospace') || w(`"${f}", serif`) !== w('serif');
}

let open = null;
// shows the list under `anchor`; onPick(family) ('' = the default font)
export async function pickFont(anchor, current, onPick, defLabel = 'Default (Nirmala UI - Hindi)') {
  open?.close();
  const box = document.createElement('div');
  box.className = 'fontpick'; box.innerHTML = '<input type="search" placeholder="Search fonts…" aria-label="Search fonts" spellcheck="false"><div class="fp-list" role="listbox">Loading fonts…</div>';
  document.body.append(box);
  anchor.scrollIntoView({ block: 'nearest' });
  const r = anchor.getBoundingClientRect(), inp = box.querySelector('input'), list = box.querySelector('.fp-list');
  box.style.left = `${Math.max(6, Math.min(r.left, innerWidth - 300))}px`;
  const below = innerHeight - r.bottom > 300;
  box.style[below ? 'top' : 'bottom'] = below ? `${r.bottom + 4}px` : `${innerHeight - r.top + 4}px`;
  const close = () => { box.remove(); window.removeEventListener('pointerdown', outside, true); open = null; };
  const outside = (e) => { if (!box.contains(e.target) && e.target !== anchor) close(); };
  open = { close };
  setTimeout(() => window.addEventListener('pointerdown', outside, true));
  const fams = await fontFamilies();
  let shown = [], at = 0;
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    shown = ['', ...fams.filter((f) => !q || f.toLowerCase().includes(q))];
    if (q) shown.shift();
    at = Math.max(0, shown.indexOf(current ?? '')); if (q) at = 0;
    list.innerHTML = shown.slice(0, 600).map((f, i) => `<button role="option" data-i="${i}" class="${i === at ? 'on' : ''}"${f ? ` style="font-family:&quot;${esc(f)}&quot;, 'Segoe UI'"` : ''} title="${esc(f || defLabel)}">${esc(f || defLabel)}${f ? `<small>${esc(f)}</small>` : ''}</button>`).join('') || '<p class="muted small">No font by that name</p>';
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i) => { if (shown[i] === undefined) return; close(); onPick(shown[i]); };
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pick(+b.dataset.i); });
  inp.addEventListener('input', draw);
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation(); // (the editor's own keys stay out of the search box)
    if (e.key === 'Escape') return close();
    if (e.key === 'Enter') return pick(at);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); at = Math.max(0, Math.min(Math.min(shown.length, 600) - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      list.querySelectorAll('[data-i]').forEach((b) => b.classList.toggle('on', +b.dataset.i === at)); list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    }
  });
  draw(); inp.focus();
}
// the field that opens it (Effect Controls)
export const fontField = (font, defLabel = 'Default (Nirmala UI - Hindi)') => `<label class="fld wide"><span>Font</span><button type="button" class="fontbtn" data-fontpick${font ? ` style="font-family:&quot;${esc(font)}&quot;, 'Segoe UI'"` : ''} title="Pick a font - every font on this computer, searchable">${esc(font || defLabel)}<i>▾</i></button></label>`;
