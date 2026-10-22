// 🪟 Workspaces (Premiere's Window > Workspaces): how the Edit page's panels are laid out.
// Ready one - Limelight Default (Media | Source | Program | Effect Controls over the timeline) - and your own.
// Every workspace is customisable: drag the lines between panels to resize, drag a panel's ⠿ grip onto another panel
// to swap them, or "Edit layout…" to pick a layout and which panel goes where. Changes stay in the workspace you are
// in (remembered in this browser); "Reset to saved layout" takes it back, "Save as new workspace…" keeps a copy.
//
// panels: pool (Project / Media), viewer (Program), insp (Effect Controls, + Source as a tab), src (Source monitor on
// its own - Resolve's two viewers), tl (Timeline). A layout is a grid: column/row sizes and which panel fills each cell.
import { $, esc, toast } from './ui.js';

const LIST = 've-ws-list', CUR = 've-ws-cur', LOOK = 've-ui';
const get = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

export const PANELS = { pool: 'Project / Media', viewer: 'Program monitor', insp: 'Effect Controls', src: 'Source monitor', tl: 'Timeline' };
const BUILT = {
  // Source and Program share one monitor window (tabs), so Effect Controls gets a wide panel of its own
  limelight: { name: 'Limelight Default', look: 'studio', cols: [19, 50, 31], rows: [58, 42], areas: [['pool', 'viewer', 'insp'], ['tl', 'tl', 'tl']], srcWith: 'viewer' },
};
// layouts offered in "Edit layout…" (the cells are filled in order with the panels you choose)
export const TEMPLATES = {
  quad: { name: 'Premiere: 2 × 2', cols: [31, 69], rows: [54, 46], shape: [[0, 1], [2, 3]] },
  resolve: { name: 'Limelight: 4 on top, timeline below', cols: [21, 29, 29, 21], rows: [55, 45], shape: [[0, 1, 2, 3], [4, 4, 4, 4]] },
  three: { name: '3 on top, timeline below', cols: [25, 50, 25], rows: [55, 45], shape: [[0, 1, 2], [3, 3, 3]] },
  tltop: { name: 'Timeline on top', cols: [30, 70], rows: [42, 58], shape: [[0, 0], [1, 2]] },
  side: { name: 'Timeline + monitor, panels on the side', cols: [26, 74], rows: [55, 45], shape: [[0, 1], [2, 3]] },
  wide: { name: 'Big monitor, timeline below', cols: [22, 78], rows: [62, 38], shape: [[0, 1], [2, 2]] },
};

const clone = (x) => JSON.parse(JSON.stringify(x));
let user = null;
const store = () => { try { user ||= JSON.parse(get(LIST, '') || '{}'); } catch { user = {}; } return user; };
const save = () => put(LIST, JSON.stringify(store()));
// what a workspace looks like now: your changes to it (stored under its id) over its saved form
export function all() {
  const u = store(), out = {};
  for (const [id, w] of Object.entries(BUILT)) out[id] = fit({ ...clone(w), ...(u[id]?.live || {}), id, builtIn: true, changed: !!u[id]?.live }, w);
  for (const [id, w] of Object.entries(u)) if (!BUILT[id] && w.saved) out[id] = fit({ ...clone(w.saved), ...(w.live || {}), id, changed: !!w.live }, w.saved);
  return out;
}
// sizes kept from an older layout of the same workspace (4 columns when it now has 3) would leave an empty strip at the
// side: they are dropped and the layout's own sizes used
function fit(w, base) {
  if (!w.areas) return w;
  if (w.cols?.length !== w.areas[0].length) w.cols = base.cols?.length === w.areas[0].length ? clone(base.cols) : w.areas[0].map(() => 100 / w.areas[0].length);
  if (w.rows?.length !== w.areas.length) w.rows = base.rows?.length === w.areas.length ? clone(base.rows) : w.areas.map(() => 100 / w.areas.length);
  return w;
}
export const currentId = () => { const id = get(CUR, 'limelight'); return all()[id] ? id : 'limelight'; };
export const current = () => { const w = all()[currentId()]; return w.look === 'classic' ? { ...w, look: 'studio', ...(w.areas ? {} : { cols: BUILT.limelight.cols, rows: BUILT.limelight.rows, areas: BUILT.limelight.areas }) } : w; };

let grid = null;
export function mountWorkspaces(el) {
  grid = el;
  if (!grid) return;
  new ResizeObserver(() => placeSplits()).observe(grid);
  apply();
}

// ---- apply the current workspace to the Edit page ----
export function apply() {
  const w = current(), html = document.documentElement;
  put(LOOK, w.look === 'classic' ? 'classic' : 'studio');
  html.classList.toggle('ui2', w.look !== 'classic');
  if (!grid) return;
  grid.querySelectorAll('.ws-split').forEach((x) => x.remove());
  const custom = !!w.areas;
  grid.classList.toggle('ws-custom', custom);
  if (!custom) { for (const p of ['gridTemplateColumns', 'gridTemplateRows', 'gridTemplateAreas']) grid.style[p] = ''; grid.classList.remove('ws-src', 'ws-monsrc'); syncGrips(); document.dispatchEvent(new Event('ve-look')); return; }
  grid.style.gridTemplateColumns = w.cols.map((c) => `minmax(120px, ${c}fr)`).join(' ');
  grid.style.gridTemplateRows = w.rows.map((r) => `minmax(120px, ${r}fr)`).join(' ');
  grid.style.gridTemplateAreas = w.areas.map((r) => `"${r.join(' ')}"`).join(' ');
  const used = new Set(w.areas.flat());
  // panels the layout leaves out are hidden; Source gets its own place when the layout has one
  grid.classList.toggle('ws-src', used.has('src'));
  // srcWith 'viewer': no Source panel of its own - it is a tab of the Program monitor's window
  grid.classList.toggle('ws-monsrc', !used.has('src') && w.srcWith === 'viewer');
  for (const [k, sel] of [['pool', '.pool'], ['viewer', '.viewer'], ['insp', '.inspector'], ['tl', '.timeline']]) grid.querySelector(sel)?.classList.toggle('ws-off', !used.has(k));
  grid.querySelector('.ui-dock')?.classList.toggle('ws-off', !used.has('insp'));
  grid.querySelector('.srcmon')?.classList.toggle('ws-off', !used.has('src') && !used.has('insp') && !(w.srcWith === 'viewer' && used.has('viewer')));
  // the lines between columns / rows: one per boundary, only where two different panels meet
  for (let i = 0; i < w.cols.length - 1; i++) grid.insertAdjacentHTML('beforeend', `<div class="ws-split v" data-i="${i}" title="Drag to resize (double-click: as saved)"></div>`);
  for (let i = 0; i < w.rows.length - 1; i++) grid.insertAdjacentHTML('beforeend', `<div class="ws-split h" data-i="${i}" title="Drag to resize (double-click: as saved)"></div>`);
  grid.querySelectorAll('.ws-split').forEach(wireSplit);
  syncGrips();
  requestAnimationFrame(placeSplits);
  document.dispatchEvent(new Event('ve-look'));
}
function tracks(prop) { return getComputedStyle(grid)[prop].split(' ').map(parseFloat).filter(Number.isFinite); }
function placeSplits() {
  const w = current();
  if (!grid || !w.areas) return;
  const cs = getComputedStyle(grid), gap = parseFloat(cs.columnGap) || 0, padL = parseFloat(cs.paddingLeft) || 0, padT = parseFloat(cs.paddingTop) || 0;
  const C = tracks('gridTemplateColumns'), R = tracks('gridTemplateRows');
  const at = (L, pad, i) => pad + L.slice(0, i + 1).reduce((a, b) => a + b, 0) + gap * i + gap / 2;
  const span = (L, pad, a, b) => [pad + L.slice(0, a).reduce((x, y) => x + y, 0) + gap * a, L.slice(a, b + 1).reduce((x, y) => x + y, 0) + gap * (b - a)];
  grid.querySelectorAll('.ws-split.v').forEach((s) => {
    const i = +s.dataset.i, rows = w.areas.map((r, k) => (r[i] !== r[i + 1] ? k : -1)).filter((k) => k >= 0);
    s.hidden = !rows.length; if (!rows.length) return;
    const [top, hgt] = span(R, padT, rows[0], rows[rows.length - 1]);
    Object.assign(s.style, { left: `${at(C, padL, i)}px`, top: `${top}px`, height: `${hgt}px` });
  });
  grid.querySelectorAll('.ws-split.h').forEach((s) => {
    const i = +s.dataset.i, cols = w.areas[0].map((_, k) => (w.areas[i][k] !== w.areas[i + 1][k] ? k : -1)).filter((k) => k >= 0);
    s.hidden = !cols.length; if (!cols.length) return;
    const [left, wid] = span(C, padL, cols[0], cols[cols.length - 1]);
    Object.assign(s.style, { top: `${at(R, padT, i)}px`, left: `${left}px`, width: `${wid}px` });
  });
}
function wireSplit(sp) {
  const axis = sp.classList.contains('v') ? 'cols' : 'rows', i = +sp.dataset.i;
  sp.addEventListener('pointerdown', (e) => {
    e.preventDefault(); sp.setPointerCapture(e.pointerId); sp.classList.add('drag'); document.documentElement.classList.add('ui-dragging');
    const w = current(), L = [...w[axis]], px = tracks(axis === 'cols' ? 'gridTemplateColumns' : 'gridTemplateRows');
    const total = L[i] + L[i + 1], pxTotal = px[i] + px[i + 1], start = axis === 'cols' ? e.clientX : e.clientY;
    const move = (ev) => {
      const d = ((axis === 'cols' ? ev.clientX : ev.clientY) - start) / Math.max(1, pxTotal);
      const a = Math.min(0.9, Math.max(0.1, px[i] / pxTotal + d));
      L[i] = +(total * a).toFixed(2); L[i + 1] = +(total - L[i]).toFixed(2);
      change({ [axis]: L }, false);
    };
    const up = () => { sp.classList.remove('drag'); document.documentElement.classList.remove('ui-dragging'); sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); };
    sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up);
  });
  sp.addEventListener('dblclick', () => { const s = saved(currentId()); if (s?.[axis]) change({ [axis]: s[axis] }); });
}
function saved(id) { return BUILT[id] ? clone(BUILT[id]) : clone(store()[id]?.saved || null); }
// change the current workspace (kept as its live state until reset / saved)
function change(patch, full = true) {
  const id = currentId(), u = store(), w = current();
  u[id] = { ...(u[id] || {}), live: { ...(u[id]?.live || {}), ...patch } };
  if (!w.areas && (patch.cols || patch.rows) && !patch.areas) return; // (the classic layout has no grid of its own)
  save();
  if (full) apply(); else {
    const nw = current();
    grid.style.gridTemplateColumns = nw.cols.map((c) => `minmax(120px, ${c}fr)`).join(' ');
    grid.style.gridTemplateRows = nw.rows.map((r) => `minmax(120px, ${r}fr)`).join(' ');
    placeSplits();
  }
}
export function switchTo(id) { put(CUR, id); apply(); toast(`Workspace: ${current().name}`); }

// ---- ⠿ grips: drag one panel onto another to swap them ----
const PSEL = { pool: '.pool', viewer: '.viewer', insp: '.inspector', src: '.srcmon', tl: '.timeline' };
function syncGrips() {
  if (!grid) return;
  const w = current();
  for (const [k, sel] of Object.entries(PSEL)) {
    const el = grid.querySelector(sel); if (!el) continue;
    let g = el.querySelector(':scope > .ws-grip');
    if (!w.areas) { g?.remove(); continue; }
    if (!g) {
      g = document.createElement('div'); g.className = 'ws-grip'; g.textContent = '⠿'; g.dataset.panel = k;
      g.title = `Drag onto another panel to swap ${PANELS[k]} with it`;
      el.append(g); wireGrip(g);
    }
    g.dataset.panel = k === 'src' && !w.areas.flat().includes('src') ? 'insp' : k;
  }
  const dockGrip = grid.querySelector('.ui-dock > .ws-grip'); if (dockGrip && !w.areas) dockGrip.remove();
}
function wireGrip(g) {
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    const from = g.dataset.panel, ghost = document.createElement('div');
    ghost.className = 'ws-ghost'; ghost.textContent = PANELS[from]; document.body.append(ghost);
    document.documentElement.classList.add('ui-dragging', 'ws-moving');
    let over = null;
    const target = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.edit-grid > .panel, .edit-grid > .ui-dock');
      if (!el) return null;
      const k = Object.entries(PSEL).find(([, s]) => el.matches(s))?.[0] || (el.matches('.ui-dock') ? 'insp' : null);
      return k === 'src' && !current().areas.flat().includes('src') ? 'insp' : k;
    };
    const move = (ev) => {
      ghost.style.left = `${ev.clientX + 12}px`; ghost.style.top = `${ev.clientY + 8}px`;
      const t = target(ev);
      grid.querySelectorAll('.ws-drop').forEach((x) => x.classList.remove('ws-drop'));
      over = t && t !== from ? t : null;
      if (over) grid.querySelector(PSEL[over])?.classList.add('ws-drop');
    };
    const up = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      ghost.remove(); document.documentElement.classList.remove('ui-dragging', 'ws-moving');
      grid.querySelectorAll('.ws-drop').forEach((x) => x.classList.remove('ws-drop'));
      if (!over) return;
      const areas = current().areas.map((r) => r.map((c) => (c === from ? over : c === over ? from : c)));
      change({ areas }); toast(`Swapped ${PANELS[from]} and ${PANELS[over]}`);
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    move(e);
  });
}

// ---- the Workspaces menu (header) ----
export function openWorkspaceMenu(btn) {
  document.querySelector('.ui-menu')?.remove();
  const ws = all(), id = currentId(), cur = ws[id];
  const m = document.createElement('div');
  m.className = 'ui-menu ws-menu';
  m.innerHTML = `<div class="muted">Workspaces</div>
    ${Object.values(ws).map((w) => `<button data-ws="${esc(w.id)}">${w.id === id ? '● ' : '○ '}${esc(w.name)}${w.changed ? ' <i class="muted">(changed)</i>' : ''}</button>`).join('')}<hr>
    <button data-wa="edit">Edit layout…</button>
    <button data-wa="reset"${cur.changed ? '' : ' disabled'}>↺ Reset to saved layout</button>
    ${cur.builtIn ? '' : `<button data-wa="update"${cur.changed ? '' : ' disabled'}>Save changes to this workspace</button>`}
    <button data-wa="saveas">＋ Save as new workspace…</button>
    ${cur.builtIn ? '' : '<button data-wa="rename">Rename…</button><button data-wa="delete" class="danger">Delete this workspace</button>'}
    <hr><div class="muted small">Drag the lines to resize · drag ⠿ onto another panel to swap</div>`;
  document.body.append(m);
  const r = btn.getBoundingClientRect();
  m.style.top = `${r.bottom + 6}px`; m.style.left = `${Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth))}px`;
  const close = (e) => { if (!m.contains(e.target) && !btn.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ws], [data-wa]'); if (!b || b.disabled) return;
    m.remove(); document.removeEventListener('pointerdown', close, true);
    if (b.dataset.ws) return switchTo(b.dataset.ws);
    const a = b.dataset.wa, u = store();
    if (a === 'edit') return editLayout();
    if (a === 'reset') { if (u[id]) delete u[id].live; if (BUILT[id] && u[id]) delete u[id]; save(); apply(); toast(`${cur.name}: back to its saved layout`); }
    if (a === 'update') { const { id: _i, builtIn, changed, ...w } = cur; u[id] = { saved: w }; save(); apply(); toast(`Saved "${cur.name}"`); }
    if (a === 'saveas') {
      const name = prompt('Name of the new workspace', `${cur.name} (mine)`)?.trim(); if (!name) return;
      const { id: _i, builtIn, changed, ...w } = cur, nid = `u${Date.now().toString(36)}`;
      u[nid] = { saved: { ...w, name } }; save(); switchTo(nid);
    }
    if (a === 'rename') { const name = prompt('New name', cur.name)?.trim(); if (!name) return; u[id].saved.name = name; if (u[id].live) delete u[id].live.name; save(); syncBtn(); }
    if (a === 'delete') { if (!confirm(`Delete the workspace "${cur.name}"?`)) return; delete u[id]; save(); switchTo('limelight'); }
    syncBtn();
  });
}
export function syncBtn() { const b = document.querySelector('[data-a="workspace"] .ws-name'); if (b) b.textContent = current().name; }
document.addEventListener('ve-look', syncBtn);

// ---- ✏ Edit layout… : pick a layout, a style, and which panel goes in each place ----
function editLayout() {
  const cur = current();
  document.querySelector('dialog.ws-dlg')?.remove();
  const d = document.createElement('dialog');
  d.className = 'ws-dlg';
  // start from the template that matches the current layout's shape, else Premiere's
  let tplId = Object.keys(TEMPLATES).find((k) => cur.areas && sameShape(TEMPLATES[k], cur.areas)) || 'quad';
  let pick = cur.areas ? order(cur.areas) : ['insp', 'viewer', 'pool', 'tl'];
  const look = 'studio'; // (the old classic look is retired)
  const draw = () => {
    const t = TEMPLATES[tplId], n = Math.max(...t.shape.flat()) + 1;
    while (pick.length < n) pick.push(Object.keys(PANELS).find((k) => !pick.includes(k)) || 'tl');
    pick = pick.slice(0, n);
    d.innerHTML = `<form method="dialog" class="ws-form">
      <h2>Edit layout - ${esc(cur.name)}</h2>
      <label class="fld"><span>Layout</span><select name="tpl">${Object.entries(TEMPLATES).map(([k, x]) => `<option value="${k}"${k === tplId ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <p class="muted small">Choose the panel for each place. A panel left out is hidden; Source monitor on its own gives two viewers side by side (Resolve).</p>
      <div class="ws-prev" style="grid-template-columns:${t.cols.map((c) => `${c}fr`).join(' ')};grid-template-rows:${t.rows.map((r) => `${r}fr`).join(' ')};grid-template-areas:${t.shape.map((r) => `'${r.map((c) => `c${c}`).join(' ')}'`).join(' ')}">
        ${pick.map((p, i) => `<div class="ws-cell" style="grid-area:c${i}"><select data-cell="${i}" aria-label="Panel ${i + 1}">${Object.entries(PANELS).map(([k, l]) => `<option value="${k}"${k === p ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')}
      </div>
      <div class="ws-foot"><button value="cancel">Cancel</button><span class="grow"></span><button value="ok" class="primary">Apply</button></div></form>`;
    d.querySelector('[name="tpl"]').onchange = (e) => { tplId = e.target.value; draw(); };
    d.querySelectorAll('[data-cell]').forEach((s) => (s.onchange = () => { pick[+s.dataset.cell] = s.value; }));
  };
  draw();
  document.body.append(d); d.showModal();
  d.addEventListener('close', () => {
    if (d.returnValue === 'ok') {
      if (new Set(pick).size !== pick.length) { d.remove(); return toast('Each panel can be in one place only - pick different panels', 'err'); }
      if (!pick.includes('tl') || !pick.includes('viewer')) { d.remove(); return toast('A layout needs the Timeline and the Program monitor', 'err'); }
      const t = TEMPLATES[tplId];
      change({ look, cols: [...t.cols], rows: [...t.rows], areas: t.shape.map((r) => r.map((c) => pick[c])) });
      toast(`Layout of "${current().name}" changed - Reset to saved layout takes it back`);
    }
    d.remove();
  });
}
function sameShape(t, areas) {
  if (t.shape.length !== areas.length || t.shape[0].length !== areas[0].length) return false;
  const map = new Map();
  return t.shape.every((r, i) => r.every((c, j) => { if (!map.has(c)) map.set(c, areas[i][j]); return map.get(c) === areas[i][j]; })) && new Set(map.values()).size === map.size;
}
function order(areas) { const seen = []; for (const r of areas) for (const c of r) if (!seen.includes(c)) seen.push(c); return seen; }
export const _test = { BUILT, TEMPLATES, sameShape, order };
