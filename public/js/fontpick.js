// 🔤 Font picker, like Premiere's Essential Graphics: every font installed on the editor's computer (server.mjs
// /api/fonts - its files are served too, so an editor on any PC has them) and all of Google Fonts, in one list with a
// search box; each name is written in its own face (loaded as it scrolls into view); ↑ / ↓ and Enter work, Esc closes.
// A graphic using one is drawn once the font has arrived (ensureFont); a bake for the render waits for it.
import { esc } from './ui.js';
import { api } from './api.js';

const COMMON = ['Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
  'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free', 'Javanese Text', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode',
  'Malgun Gothic', 'Mangal', 'Microsoft Sans Serif', 'MV Boli', 'Nirmala UI', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Black',
  'Segoe UI Semibold', 'Sitka Text', 'Sylfaen', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Aparajita', 'Kokila', 'Utsaah'];
let lists = null; // { pc: { family: [{ file, weight, italic }] }, google: [family] }
// the editor computer's families and Google's (an older editor without /api/fonts: the usual Windows fonts)
export async function fontLists() {
  if (lists) return lists;
  try { lists = await api('GET', '/api/fonts'); } catch { lists = { pc: Object.fromEntries(COMMON.map((f) => [f, []])), google: [] }; }
  return lists;
}
export async function fontFamilies() { const l = await fontLists(); return [...new Set([...Object.keys(l.pc), ...l.google])].sort((a, b) => a.localeCompare(b)); }

// ---- loading a font into this browser ----
const loaded = new Map(), ready = new Set(), queued = new Set(); // family -> promise of true (it is here now) / false; ready: arrived
const gUrl = (fam, extra = '') => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}${extra}&display=swap`;
// a Google stylesheet in the page; resolves once it has loaded (or failed - a weight the family does not have)
const sheets = new Map();
function addCss(href) {
  if (!sheets.has(href)) sheets.set(href, new Promise((done) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.onload = l.onerror = () => done(); document.head.append(l); }));
  return sheets.get(href);
}
// family -> loaded (cached); onNew() runs once when it has just arrived (the monitor draws the graphic again)
export function ensureFont(fam, onNew) {
  fam = String(fam || '').trim(); if (!fam) return Promise.resolve(true);
  if (loaded.has(fam)) { const p = loaded.get(fam); if (onNew && !ready.has(fam) && !queued.has(fam)) { queued.add(fam); p.then((ok) => ok && onNew()); } return p; } // (still on its way, asked for by the list first)
  const p = (async () => {
    const l = await fontLists();
    const faces = (l.pc[fam] || []).filter((x) => x.file);
    if (faces.length) {
      // (a .ttc collection only when the family has nothing else - browsers read single fonts best)
      const use = faces.some((x) => !/\.ttc$/i.test(x.file)) ? faces.filter((x) => !/\.ttc$/i.test(x.file)) : faces;
      await Promise.all(use.map(async (x) => {
        try { const f = new FontFace(fam, `url(/api/fonts/file?f=${encodeURIComponent(x.file)})`, { weight: String(x.weight), style: x.italic ? 'italic' : 'normal' }); document.fonts.add(f); await f.load(); } catch {}
      }));
    } else if (l.google.includes(fam)) {
      // each weight on its own (a family without 800 would fail a request that asks for it with the others)
      await Promise.all(['', ':wght@500', ':wght@600', ':wght@700', ':wght@800'].map((w) => addCss(gUrl(fam + w)))); // (the @font-face rules first, then the files)
      await Promise.all(['400', '700', '800'].map((w) => document.fonts.load(`${w} 40px "${fam}"`).catch(() => null)));
    } else return true; // (a font of this PC itself)
    const ok = document.fonts.check(`40px "${fam}"`);
    ready.add(fam);
    if (!ok) { loaded.delete(fam); ready.delete(fam); queued.delete(fam); } // (offline / not found now: tried again next time)
    return ok;
  })();
  loaded.set(fam, p);
  if (onNew) { queued.add(fam); p.then((ok) => ok && onNew()); } // (one redraw when it arrives, however often it is drawn meanwhile)
  return p;
}
// the name in the list written in its own face: only the letters of the name for a Google font (a tiny file)
function preview(fam, l) {
  if (l.pc[fam]?.length) return ensureFont(fam);
  if (l.google.includes(fam)) addCss(gUrl(fam, `&text=${encodeURIComponent(fam)}`));
  return null;
}

let open = null;
// shows the list under `anchor`; onPick(family) ('' = the default font)
export async function pickFont(anchor, current, onPick, defLabel = 'Default (Nirmala UI - Hindi)') {
  open?.close();
  const box = document.createElement('div');
  box.className = 'fontpick'; box.innerHTML = '<input type="search" placeholder="Search fonts - this computer and Google Fonts…" aria-label="Search fonts" spellcheck="false"><div class="fp-list" role="listbox">Loading fonts…</div>';
  document.body.append(box);
  anchor.scrollIntoView({ block: 'nearest' });
  const r = anchor.getBoundingClientRect(), inp = box.querySelector('input'), list = box.querySelector('.fp-list');
  box.style.left = `${Math.max(6, Math.min(r.left, innerWidth - 330))}px`;
  const below = innerHeight - r.bottom > 360;
  box.style[below ? 'top' : 'bottom'] = below ? `${r.bottom + 4}px` : `${innerHeight - r.top + 4}px`;
  const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); preview(e.target.dataset.fam, l); } }, { root: list });
  const close = () => { io.disconnect(); box.remove(); window.removeEventListener('pointerdown', outside, true); open = null; };
  const outside = (e) => { if (!box.contains(e.target) && e.target !== anchor) close(); };
  open = { close };
  setTimeout(() => window.addEventListener('pointerdown', outside, true));
  inp.focus();
  const l = await fontLists();
  const pc = Object.keys(l.pc).sort((a, b) => a.localeCompare(b)), pcSet = new Set(pc), gg = l.google.filter((f) => !pcSet.has(f));
  const MAX = 400;
  let shown = [], at = 0;
  const row = (f, i) => `<button role="option" data-i="${i}" data-fam="${esc(f)}" class="${i === at ? 'on' : ''}"${f ? ` style="font-family:&quot;${esc(f)}&quot;, 'Segoe UI'"` : ''} title="${esc(f || defLabel)}">${esc(f || defLabel)}${f ? `<small>${pcSet.has(f) ? 'PC' : 'Google'}</small>` : ''}</button>`;
  const draw = () => {
    const q = inp.value.trim().toLowerCase(), m = (f) => !q || f.toLowerCase().includes(q);
    const a = pc.filter(m), b = gg.filter(m);
    shown = [...(q ? [] : ['']), ...a.slice(0, MAX), ...b.slice(0, MAX)];
    at = q ? 0 : Math.max(0, shown.indexOf(current ?? ''));
    let i = 0, h = '';
    if (!q) h += row('', i++);
    if (a.length) h += `<div class="fp-h">This computer · ${a.length}</div>` + a.slice(0, MAX).map((f) => row(f, i++)).join('');
    if (b.length) h += `<div class="fp-h">Google Fonts · ${b.length}</div>` + b.slice(0, MAX).map((f) => row(f, i++)).join('');
    list.innerHTML = h || '<p class="muted small">No font by that name</p>';
    list.querySelectorAll('[data-fam]').forEach((el) => { if (el.dataset.fam) io.observe(el); });
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
      e.preventDefault(); at = Math.max(0, Math.min(shown.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      list.querySelectorAll('[data-i]').forEach((b) => b.classList.toggle('on', +b.dataset.i === at)); list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    }
  });
  draw();
}
// the field that opens it (Effect Controls)
export const fontField = (font, defLabel = 'Default (Nirmala UI - Hindi)') => `<label class="fld wide"><span>Font</span><button type="button" class="fontbtn" data-fontpick${font ? ` style="font-family:&quot;${esc(font)}&quot;, 'Segoe UI'"` : ''} title="Pick a font - every font on the editor's computer and all Google Fonts, searchable">${esc(font || defLabel)}<i>▾</i></button></label>`;
