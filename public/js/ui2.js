// 🖥 Studio UI (Phase 20): the Premiere-style look (public/css/ui2.css) - on by default, the classic look one click away
// (⚙ in the header, remembered in this browser). Also: line icons for the header, and the Edit page's panels resized by
// dragging the lines between them (Effect Controls | Program above, Project | Timeline below), remembered too.

import { ic } from './lineicons.js';
import { S, on } from './store.js';

const KEY = 've-ui', SIZE = 've-ui-split', DOCK = 've-ui-dock';
const get = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

export const studioOn = () => get(KEY, 'studio') !== 'classic';
export function applyLook() {
  document.documentElement.classList.toggle('ui2', studioOn());
  if (!document.querySelector('link[href="/css/ui2.css"]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/css/ui2.css'; document.head.append(l);
  }
}

// ---- line icons (16 px, stroke = the text colour) ----
const P = {
  undo: '<path d="M4 7h7a4 4 0 0 1 0 8H8"/><path d="M7 4 4 7l3 3"/>',
  refresh: '<path d="M13.2 6.2A5.5 5.5 0 1 0 13.5 9"/><path d="M13.5 2.5v3.8H9.7"/>',
  health: '<path d="M8 13.5S2 10 2 5.8A3 3 0 0 1 8 4.6a3 3 0 0 1 6 1.2C14 10 8 13.5 8 13.5z"/><path d="M3.5 8.2h2.2l1-1.6 1.6 3 1-1.4h3.2"/>',
  redo: '<path d="M12 7H5a4 4 0 0 0 0 8h3"/><path d="m9 4 3 3-3 3"/>',
  team: '<circle cx="6" cy="6" r="2.5"/><path d="M1.5 14c.6-2.6 2.3-4 4.5-4s3.9 1.4 4.5 4"/><circle cx="11.5" cy="5.5" r="2"/><path d="M11 10c1.9 0 3.2 1.2 3.6 3.2"/>',
  activity: '<path d="M2 8h3l2-5 2 10 2-5h3"/>',
  zones: '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M6 4v8M10.5 4v8"/>',
  media: '<path d="M2 4.5h4l1.5 1.5H14v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M8 8.5v3M6.5 10H9.5"/>',
  versions: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  aiundo: '<path d="M3.5 6.5h6a3.5 3.5 0 0 1 0 7H7"/><path d="m6 4-2.5 2.5L6 9"/><path d="M12.5 1.5l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z"/>',
  agent: '<path d="M8 1.5 9.3 5.2 13 6.5 9.3 7.8 8 11.5 6.7 7.8 3 6.5l3.7-1.3z"/><path d="M12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  reedit: '<path d="M13.5 6.5A5.5 5.5 0 0 0 3.2 5"/><path d="M2.5 2v3.2h3.2"/><path d="M2.5 9.5A5.5 5.5 0 0 0 12.8 11"/><path d="M13.5 14v-3.2h-3.2"/>',
  brand: '<path d="M2 2.5h5.5L14 9l-5 5-6.5-6.5z"/><circle cx="5.2" cy="5.7" r="1"/>',
  assistant: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5.5 7h.01M8 7h.01M10.5 7h.01"/>',
  report: '<path d="M4 1.5h5.5l3 3v10H4z"/><path d="M9 1.5V5h3.5M6 8h5M6 10.5h5"/>',
  export: '<path d="M8 10V2M5 5l3-3 3 3"/><path d="M2.5 9.5v4h11v-4"/>',
  folder: '<path d="M1.75 4.25a1 1 0 0 1 1-1h3.4l1.5 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"/><path d="M1.75 7h12.5"/>',
  folderMove: '<path d="M1.75 4.25a1 1 0 0 1 1-1h3.4l1.5 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"/><path d="M5.5 9.5h5M8.5 7.5l2 2-2 2"/>',
  trash: '<path d="M2.5 4.5h11M6.5 4.5V3h3v1.5"/><path d="M3.75 4.5l.7 9a1 1 0 0 0 1 .9h5.1a1 1 0 0 0 1-.9l.7-9"/><path d="M6.75 7v4.5M9.25 7v4.5"/>',
  keyboard: '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
};
export const icon = (k) => `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[k] || ''}</svg>`;

// ---- ⚙ look menu ----
export function openLookMenu(btn) {
  document.querySelector('.ui-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'ui-menu';
  m.innerHTML = `<div class="muted">Editor look</div>
    <button data-look="studio">${studioOn() ? ic('check') + ' ' : ''}Studio (Premiere-style)</button>
    <button data-look="classic">${studioOn() ? '' : ic('check') + ' '}Classic (old)</button><hr>
    <button data-look="reset">Reset panel sizes</button><hr>
    <button data-look="keys">Keyboard Shortcuts… <span class="muted small">Ctrl+Alt+K</span></button>`;
  document.body.append(m);
  const r = btn.getBoundingClientRect();
  m.style.top = `${r.bottom + 6}px`; m.style.left = `${Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth))}px`;
  const close = (e) => { if (!m.contains(e.target) && e.target !== btn) { m.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
  m.addEventListener('click', (e) => {
    const k = e.target.closest('[data-look]')?.dataset.look; if (!k) return;
    if (k === 'keys') { import('./keysui.js').then((x) => x.openShortcuts()); m.remove(); return; }
    if (k === 'reset') { set(SIZE, ''); sizeGrid(); }
    else { set(KEY, k); applyLook(); sizeGrid(); document.dispatchEvent(new Event('ve-look')); }
    m.remove();
  });
}

// ---- resizable Edit page ----
let grid = null;
function sizes() { try { return JSON.parse(get(SIZE, '') || '{}'); } catch { return {}; } }
function sizeGrid() {
  if (!grid) return;
  const s = sizes();
  grid.style.setProperty('--ui-col', s.col ? `${s.col}%` : '31%');
  // (on a short laptop screen the timeline gets more of the height by default)
  grid.style.setProperty('--ui-row', s.row ? `${s.row}%` : innerHeight < 850 ? '46%' : '52%');
  placeSplits();
}
function placeSplits() {
  if (!grid) return;
  const v = grid.querySelector('.ui-split.v'), h = grid.querySelector('.ui-split.h');
  const viewer = grid.querySelector('.viewer'), pool = grid.querySelector('.pool');
  if (!viewer || !pool || !v || !h) return;
  // (from the program monitor and the project panel: the top-left panel can be Source or Effect Controls)
  const g = grid.getBoundingClientRect(), gap = parseFloat(getComputedStyle(grid).columnGap) || 3;
  v.style.left = `${viewer.getBoundingClientRect().left - gap / 2 - g.left}px`;
  h.style.top = `${pool.getBoundingClientRect().top - gap / 2 - g.top}px`;
}
export function mountSplits(el) {
  grid = el;
  if (!grid || grid.querySelector('.ui-split')) return;
  grid.insertAdjacentHTML('beforeend', '<div class="ui-split v" title="Drag to resize panels (double-click: reset)"></div><div class="ui-split h" title="Drag to resize panels (double-click: reset)"></div>');
  const drag = (sp, axis) => {
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault(); sp.setPointerCapture(e.pointerId); sp.classList.add('drag'); document.documentElement.classList.add('ui-dragging');
      const move = (ev) => {
        const g = grid.getBoundingClientRect(), s = sizes();
        if (axis === 'x') s.col = Math.max(18, Math.min(60, ((ev.clientX - g.left) / g.width) * 100)).toFixed(1);
        else s.row = Math.max(25, Math.min(75, ((ev.clientY - g.top) / g.height) * 100)).toFixed(1);
        set(SIZE, JSON.stringify(s)); sizeGrid();
      };
      const up = () => { sp.classList.remove('drag'); document.documentElement.classList.remove('ui-dragging'); sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); };
      sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up);
    });
    sp.addEventListener('dblclick', () => { const s = sizes(); delete s[axis === 'x' ? 'col' : 'row']; set(SIZE, JSON.stringify(s)); sizeGrid(); });
  };
  drag(grid.querySelector('.ui-split.v'), 'x');
  drag(grid.querySelector('.ui-split.h'), 'y');
  new ResizeObserver(placeSplits).observe(grid);
  sizeGrid();
}

// ---- 🎬 Source | Effect Controls: one place, two tabs (Premiere's top-left frame) ----
// A clip opened from Media shows the Source tab; clicking a clip on the timeline shows its Effect Controls.
export function mountDock(g) {
  if (!g) return;
  const show = (k) => {
    g.classList.toggle('dock-src', k === 'src'); g.classList.toggle('dock-ec', k !== 'src');
    g.querySelectorAll('[data-dock]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.dock === k)));
    set(DOCK, k);
  };
  g.querySelector('.ui-dock')?.addEventListener('click', (e) => { const b = e.target.closest('[data-dock]'); if (b) show(b.dataset.dock); });
  let srcAt = 0;
  on('sourceShown', () => { srcAt = Date.now(); show('src'); });
  // a click on a timeline clip (the select event alone also fires for other reasons) - but not the second click of a
  // double-click, which has just opened the clip in the Source tab
  g.querySelector('.timeline')?.addEventListener('pointerdown', (e) => { if (e.target.closest('.clip')) setTimeout(() => S.sel?.size && Date.now() - srcAt > 400 && show('ec'), 0); }, true);
  show(get(DOCK, 'ec') === 'src' ? 'src' : 'ec');
}

// ---- 🖥 Source | Program: one monitor window, two tabs (workspaces with srcWith: 'viewer' - Effect Controls then has
// a whole panel to itself). A clip opened from Media shows Source; playing or clicking the timeline shows Program.
export function mountMonDock(g) {
  if (!g) return;
  const show = (k) => {
    g.classList.toggle('mon-src', k === 'src');
    g.querySelectorAll('[data-mon]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mon === k)));
    if (k === 'prog') window.dispatchEvent(new Event('resize')); // (the Program monitor fits its picture again)
  };
  g.querySelector('.mon-dock')?.addEventListener('click', (e) => { const b = e.target.closest('[data-mon]'); if (b) show(b.dataset.mon); });
  on('sourceShown', () => show('src'));
  on('programPlays', () => show('prog'));
  g.querySelector('.timeline')?.addEventListener('pointerdown', (e) => { if (!e.target.closest('.clip') || e.detail < 2) show('prog'); }, true);
  show('prog');
}
