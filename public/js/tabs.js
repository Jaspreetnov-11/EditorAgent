// 🗂 Project tabs, like Explorer's: the strip at the very top, one tab per open project (✕ closes it, + opens the project
// list in a new tab). Every tab is a whole editor of its own in a frame (/?tab=<id>#/p/<project>) - its playhead,
// selection, page and undo stay exactly as they were while another tab is shown, and switching is only showing another
// frame. A tab that is not shown sleeps (tabclient.js: no playback, no live stream). A tab opens its editor the first
// time it is shown. The open tabs come back after a reload. This page loads nothing of the editor itself.
import { mountChatDock } from './chatdock.js';
const KEY = 've-tabs';
const enc = encodeURIComponent;
let tabs = [], active = null, seq = 0;
const byId = (id) => tabs.find((t) => t.id === id);
const nameOf = (t) => t.proj || 'Projects';

// 🖥 in Limelight Editor.exe (1.1+) the strip IS the window's title bar - one line, like Chrome: the app's mark, the tabs,
// +, empty space to drag the window by, and minimise / maximise / close (Program.cs hides Windows' own caption once this
// page says "win:custom"). In a browser it is just the strip under the browser's own bar.
const wv = /LimelightFrame\/1/.test(navigator.userAgent) ? window.chrome?.webview : null;
const H = wv ? 36 : 32;
const css = `
html, body { margin: 0; height: 100%; overflow: hidden; background: #050505; }
.tb-strip { position: fixed; top: 0; left: 0; right: 0; height: ${H}px; display: flex; align-items: flex-end; padding-left: 8px; box-sizing: border-box;
  background: #141416; font: 12.5px/1 "Segoe UI Variable Text", "Segoe UI", "Nirmala UI", system-ui, sans-serif; color: #a1a1a8; user-select: none; z-index: 2; app-region: drag; }
.tb-mark { width: 16px; height: 16px; flex: none; align-self: center; margin: 0 8px 0 4px; }
.tb-tabs { display: flex; align-items: flex-end; flex: 0 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; scroll-behavior: smooth; }
.tb-tab { position: relative; display: flex; align-items: center; gap: 8px; height: ${H - 6}px; padding: 0 6px 0 14px; width: 200px; flex: 0 1 auto; min-width: 64px;
  box-sizing: border-box; border-radius: 8px 8px 0 0; cursor: default; white-space: nowrap; app-region: no-drag; }
.tb-tab + .tb-tab::before { content: ""; position: absolute; left: 0; top: 9px; bottom: 9px; width: 1px; background: #2c2c31; }
.tb-tab[aria-selected="true"]::before, .tb-tab[aria-selected="true"] + .tb-tab::before, .tb-tab:hover::before, .tb-tab:hover + .tb-tab::before { display: none; }
.tb-tab:hover { background: #1d1d20; color: #e4e4e7; }
.tb-tab[aria-selected="true"] { background: #050505; color: #f7f7f8; min-width: 140px; }
.tb-name { flex: 1; overflow: hidden; text-overflow: ellipsis; min-width: 0; padding: 2px 0; }
.tb-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: #ffc21a; display: none; }
.tb-tab[data-state="busy"] .tb-dot { display: block; animation: tbp 1s ease-in-out infinite alternate; }
.tb-tab[data-state="error"] .tb-dot { display: block; background: #ff5a4f; }
@keyframes tbp { to { opacity: .3; } }
button.tb-x, button.tb-new, button.tb-w { border: 0; background: transparent; color: inherit; cursor: default; display: grid; place-items: center; padding: 0; app-region: no-drag; }
.tb-x { width: 20px; height: 20px; flex: none; border-radius: 50%; visibility: hidden; }
.tb-tab:hover .tb-x, .tb-tab[aria-selected="true"] .tb-x { visibility: visible; }
.tb-x:hover { background: #2c2c31; color: #fff; }
.tb-new { width: 28px; height: 28px; margin: 0 4px 3px; border-radius: 6px; flex: none; }
.tb-new:hover { background: #1d1d20; color: #fff; }
.tb-x svg, .tb-new svg { width: 10px; height: 10px; stroke: currentColor; stroke-width: 1.4; fill: none; stroke-linecap: round; }
.tb-new svg { width: 12px; height: 12px; }
.tb-drag { flex: 1 1 24px; align-self: stretch; min-width: 24px; }
/* (many tabs / a narrow window: the tabs shrink like Chrome's, then scroll - mouse wheel or Ctrl+Tab; a narrow tab drops
   its ✕ unless it is the open one, the narrow window its mark) */
.tb-tab.slim { padding: 0 4px 0 10px; gap: 4px; }
.tb-tab.slim:not([aria-selected="true"]) .tb-x { display: none; }
@media (max-width: 700px) { .tb-mark { display: none; } .tb-strip { padding-left: 4px; } .tb-new { margin: 0 2px 3px; } }
.tb-win { display: flex; align-self: stretch; }
.tb-w { width: 46px; color: #e4e4e7; }
.tb-w:hover { background: #2a2a2e; }
.tb-w.close:hover { background: #c42b1c; color: #fff; }
.tb-w svg { width: 10px; height: 10px; stroke: currentColor; stroke-width: 1; fill: none; shape-rendering: crispEdges; }
.tb-frames { position: fixed; top: ${H}px; left: 0; right: 0; bottom: 0; }
.tb-frames iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #050505; }
.tb-frames iframe.off { visibility: hidden; pointer-events: none; }
.tb-down { position: absolute; inset: 0; display: grid; place-items: center; background: #050505; color: #a1a1a8; font: 14px/1.5 "Segoe UI", "Nirmala UI", sans-serif; text-align: center; z-index: 1; }
.tb-down b { display: block; color: #f7f7f8; font-size: 16px; margin-bottom: 4px; }
/* 🖥 installed from Chrome / Edge (Install on this PC): the strip goes up into the window's own title bar too
   (manifest display_override: window-controls-overlay) - one line, Windows' buttons stay at the right */
@media (display-mode: window-controls-overlay) {
  .tb-strip { height: env(titlebar-area-height, ${H}px); padding-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)); -webkit-app-region: drag; }
  .tb-tab, .tb-x, .tb-new, .cd-btn { -webkit-app-region: no-drag; }
  .tb-frames { top: env(titlebar-area-height, ${H}px); }
}
`;
const X = '<svg viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>';
const PLUS = '<svg viewBox="0 0 12 12"><path d="M6 1v10M1 6h10"/></svg>';
const WIN = { min: '<svg viewBox="0 0 10 10"><path d="M0 5.5h10"/></svg>', max: '<svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9"/></svg>',
  restore: '<svg viewBox="0 0 10 10"><rect x=".5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V.5h7v7h-2"/></svg>', close: '<svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10"/></svg>' };

document.head.append(Object.assign(document.createElement('style'), { textContent: css }));
document.body.innerHTML = `<div class="tb-strip">${wv ? '<img class="tb-mark" src="/img/favicon.png?v=4" alt="">' : ''}<div class="tb-tabs" role="tablist" aria-label="Open projects"></div><button class="tb-new" title="Open another project in a new tab" aria-label="New tab">${PLUS}</button><div class="tb-drag"></div>`
  + (wv ? `<div class="tb-win"><button class="tb-w" data-w="min" title="Minimise" aria-label="Minimise">${WIN.min}</button><button class="tb-w" data-w="max" title="Maximise" aria-label="Maximise">${WIN.restore}</button><button class="tb-w close" data-w="close" title="Close" aria-label="Close">${WIN.close}</button></div>` : '')
  + '</div><div class="tb-frames"></div>';
const strip = document.querySelector('.tb-tabs'), frames = document.querySelector('.tb-frames');
const chatDock = mountChatDock({ after: document.querySelector('.tb-drag'), top: H }); // 💬 the open project's chat, at the strip's right end
if (wv) {
  document.querySelector('.tb-win').addEventListener('click', (e) => { const w = e.target.closest('[data-w]')?.dataset.w; if (w) wv.postMessage(`win:${w}`); });
  wv.addEventListener('message', (e) => {
    if (e.data?.win !== 'max' && e.data?.win !== 'normal') return;
    const b = document.querySelector('[data-w="max"]'), max = e.data.win === 'max';
    b.innerHTML = max ? WIN.restore : WIN.max; b.title = max ? 'Restore' : 'Maximise';
  });
  wv.postMessage('win:custom'); wv.postMessage('win:state');
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ tabs: tabs.map((t) => t.proj), active: tabs.findIndex((t) => t.id === active) })); } catch {}
}
function draw() {
  strip.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tb-tab'; el.setAttribute('role', 'tab'); el.dataset.id = t.id;
    el.setAttribute('aria-selected', String(t.id === active));
    el.dataset.state = t.save === 'error' ? 'error' : t.busy ? 'busy' : '';
    el.title = t.proj ? `${t.proj}${t.save === 'error' ? ' - not saved yet' : t.busy ? ' - a job is running' : ''}` : 'All projects - pick one to open it in this tab';
    el.innerHTML = `<span class="tb-name"></span><i class="tb-dot"></i><button class="tb-x" title="Close tab" aria-label="Close tab">${X}</button>`;
    el.querySelector('.tb-name').textContent = nameOf(t);
    strip.append(el);
  }
  slim();
  strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const t = byId(active);
  document.title = t?.proj ? `${t.proj} - Limelight` : 'Limelight';
  history.replaceState(null, '', t?.proj ? `#/p/${enc(t.proj)}` : '#/');
  chatDock.setProject(t?.proj); // (the project list has no chat)
  save();
}
// narrow tabs (under ~110 px) drop their ✕ - set from their width, after every change of the tabs or the window
function slim() { for (const el of strip.children) el.classList.toggle('slim', el.getBoundingClientRect().width < 110); }
addEventListener('resize', () => { slim(); strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
strip.addEventListener('wheel', (e) => { if (strip.scrollWidth <= strip.clientWidth) return; e.preventDefault(); strip.scrollLeft += e.deltaY || e.deltaX; }, { passive: false });
// the page's own query (e.g. ?ui=tablet) goes to every tab's editor too
const passQuery = () => { const q = new URLSearchParams(location.search); q.delete('tab'); const s = q.toString(); return s ? `&${s}` : ''; };
function frameOf(t) {
  if (t.frame) return t.frame;
  const f = document.createElement('iframe');
  f.title = nameOf(t);
  f.allow = 'fullscreen; clipboard-read; clipboard-write; microphone; camera; display-capture; autoplay; local-fonts';
  f.allowFullscreen = true;
  f.src = `/?tab=${t.id}${passQuery()}${t.proj ? `#/p/${enc(t.proj)}` : '#/'}`;
  frames.append(f);
  f.addEventListener('load', () => loaded(t));
  return (t.frame = f);
}
const call = (t, fn, ...a) => { try { return t.frame?.contentWindow?.veTab?.[fn]?.(...a); } catch { return undefined; } };
// 🔌 a tab whose editor did not load (the editor PC restarting, the network): instead of the browser's "refused to
// connect", it says so and tries again by itself; in Limelight Editor.exe after a few tries the whole window reloads, so
// the app moves on to the next address it knows (PC A by name, by address, the standby)
const down = document.createElement('div'); down.className = 'tb-down'; down.hidden = true;
down.innerHTML = '<div><b>The editor is not answering</b>Trying again by itself - your work is saved on the server.</div>';
frames.append(down);
function loaded(t) { const f = t.frame; setTimeout(() => { if (t.frame === f && f.isConnected) check(t); }, 2500); }
async function check(t, n = 0) {
  // the editor started in it (tabclient.js) = fine; another page of this site (the sign-in page) = the whole window goes
  // there; still loading while the server answers = look again soon; the browser's error page / no answer = not answering
  const f = t.frame; if (!f?.isConnected) return;
  let same = false, editor = false, app = false, url = '';
  try { const w = f.contentWindow; same = w.location.origin === location.origin; editor = !!w.veTab; app = !!w.document.getElementById('app'); url = w.location.href; } catch {}
  if (editor) { t.down = false; t.tries = 0; showDown(); return; }
  if (same && !app && url && !url.startsWith('about:')) { location.href = url; return; }
  const up = await fetch('/api/version', { cache: 'no-store' }).then((r) => r.ok || r.status === 401).catch(() => false);
  if (t.frame !== f) return;
  if (up && same && !t.down && n < 20) { setTimeout(() => check(t, n + 1), 1500); return; } // (a big project still opening)
  t.down = true; showDown();
  if (up) { // (load it again - loaded() looks again; waiting longer each time it still does not load: 3 s, 6 s … 30 s)
    t.tries = (t.tries || 0) + 1;
    setTimeout(() => { if (t.frame !== f) return; const u = new URL(f.src); u.searchParams.set('retry', Date.now().toString(36)); f.src = u.href; }, Math.min(30000, 1500 * 2 ** t.tries));
    return;
  }
  if (n >= 2 && wv) { location.reload(); return; } // (Limelight Editor.exe: the next address it knows)
  setTimeout(() => check(t, n + 1), 4000);
}
const showDown = () => { down.hidden = !byId(active)?.down; };
function activate(id) {
  const t = byId(id); if (!t) return;
  if (active !== id) {
    const old = byId(active);
    if (old?.frame) { old.frame.classList.add('off'); call(old, 'setVisible', false); }
    active = id;
  }
  const f = frameOf(t);
  f.classList.remove('off');
  showDown();
  call(t, 'setVisible', true);
  draw();
  try { f.contentWindow.focus(); } catch {}
}
function addTab(proj = null, show = true) {
  const t = { id: `t${Date.now().toString(36)}${seq++}`, proj, save: 'saved', busy: false, frame: null };
  tabs.push(t);
  if (show) activate(t.id); else draw();
  return t;
}
async function closeTab(id) {
  const t = byId(id); if (!t) return;
  if (t.frame && t.proj) {
    const ok = await Promise.race([Promise.resolve(call(t, 'close')), new Promise((r) => setTimeout(() => r('slow'), 10000))]);
    if (ok === false && !confirm(`"${t.proj}" could not be saved just now (is the editor running?).\n\nClose the tab anyway? Changes not saved yet are kept in this browser and offered again when you open the project.`)) { if (active === id) call(t, 'setVisible', true); return; }
  }
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  t.frame?.remove();
  if (!tabs.length) return addTab(null);
  if (active === id) { active = null; activate((tabs[i] || tabs[i - 1]).id); } else draw();
}

// what the editors in the tabs tell this page (tabclient.js)
window.veTabs = {
  isActive: (id) => id === active,
  report(id, s) {
    const t = byId(id); if (!t) return;
    const proj = s.proj || null;
    if (t.proj !== proj || t.save !== s.save || t.busy !== s.busy) {
      t.proj = proj; t.save = s.save; t.busy = s.busy;
      if (t.frame) t.frame.title = nameOf(t);
      draw();
    }
  },
  // a tab is about to open a project: one that is open in another tab already is shown there instead
  claim(id, name) {
    const other = tabs.find((t) => t.id !== id && t.proj === name);
    if (!other) { const me = byId(id); if (me && me.proj !== name) { me.proj = name; draw(); } return true; }
    const me = byId(id);
    if (me && !me.proj) { tabs.splice(tabs.indexOf(me), 1); me.frame?.remove(); if (active === id) active = null; } // (the new tab that picked it goes away)
    activate(other.id);
    return false;
  },
  step(d) {
    const i = tabs.findIndex((t) => t.id === active);
    if (tabs.length > 1) activate(tabs[(i + d + tabs.length) % tabs.length].id);
  },
};

strip.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.tb-tab'); if (!el) return;
  if (e.button === 1) { e.preventDefault(); closeTab(el.dataset.id); return; } // (middle click closes, like a browser)
  if (e.button === 0 && !e.target.closest('.tb-x')) activate(el.dataset.id);
});
strip.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
strip.addEventListener('click', (e) => { const x = e.target.closest('.tb-x'); if (x) closeTab(x.closest('.tb-tab').dataset.id); });
strip.addEventListener('dblclick', (e) => { if (!e.target.closest('.tb-tab')) addTab(null); }); // (double-click the empty strip: a new tab)
document.querySelector('.tb-new').addEventListener('click', () => addTab(null));
addEventListener('keydown', (e) => { if (e.ctrlKey && !e.altKey && (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp')) { e.preventDefault(); veTabs.step(e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1); } });

// ---- start: the tabs open last time, and the project in the address (#/p/<name>) ----
let saved = null;
try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
const want = (/^#\/p\/(.+)$/.exec(location.hash) || [])[1];
const fromHash = want ? decodeURIComponent(want) : null;
const list = Array.isArray(saved?.tabs) ? saved.tabs.filter((p, i, a) => p === null || (typeof p === 'string' && a.indexOf(p) === i)) : [];
for (const p of list) addTab(p, false);
let first = fromHash ? tabs.find((t) => t.proj === fromHash) : null;
if (fromHash && !first) first = addTab(fromHash, false);
if (!first) first = tabs[Math.max(0, Math.min(saved?.active ?? 0, tabs.length - 1))] || addTab(null, false);
activate(first.id);
