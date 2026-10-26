// 📱 Phone and tablet. A touch screen gets a layout of its own:
// - phone (a touch screen with a short side under 500 px, either way round): not the desktop squeezed - a top bar
//   (Projects, the project, Undo / Redo), the Program monitor, a strip of the edit to scrub and pick clips, and a tab
//   bar: Edit · AI · Text · Export · Notes. Everything else of the editor is still there (dialogs, the Assistant, the
//   Deliver page, the Notes panel) - the phone shows those parts, sized for a finger.
// - tablet: the full editor, the panels arranged to fit, touch-sized controls (mobile.css) and touch gestures (touch.js).
// A desktop (mouse) never gets any of it. "Desktop view" on the phone's ⋯ menu shows the full editor there too.
import { S, on, emit, commit, layout, duration, findClip } from './store.js';
import { deviceMode, stripRows, textFieldsOf, setText, pinchZoom, cuesAround } from './phonecore.js';
import { gfxFields } from './graphics.js';
import { linkedIds, fmtTC } from './model.js';
import { capTracks } from './captions.js';
import { $, $$, h, esc, toast } from './ui.js';
import { ic } from './lineicons.js';
import { icon } from './ui2.js';
import { toggle, pause, isPlayingProgram, toggleFullscreen } from './player.js';
import { splitAtPlayhead, duplicateSelected, deleteSelected, addTitle } from './timeline.js';

const PICK = 've-device'; // (the user's own choice: phone / tablet / desktop - empty = from the screen)
const html = document.documentElement;
const coarse = matchMedia('(pointer: coarse)');
let mode = '';
const listeners = [];

const getPick = () => { try { return new URLSearchParams(location.search).get('ui') || localStorage.getItem(PICK) || ''; } catch { return ''; } };
export const deviceNow = () => mode;
export const onDevice = (fn) => listeners.push(fn);
export function pickDevice(p) {
  try { if (p) localStorage.setItem(PICK, p); else localStorage.removeItem(PICK); } catch {}
  applyDevice();
}
// the classes the CSS keys on: html.phone / html.tablet, and html.touch for both
export function applyDevice() {
  const m = deviceMode({ w: innerWidth, h: innerHeight, coarse: coarse.matches, pick: getPick() });
  if (m === mode) return m;
  mode = m;
  html.classList.toggle('phone', m === 'phone');
  html.classList.toggle('tablet', m === 'tablet');
  html.classList.toggle('touch', m !== 'desktop');
  // (a touch screen showing the desktop editor by choice: a small button brings the touch layout back)
  const back = coarse.matches && getPick() === 'desktop';
  html.classList.toggle('picked-desktop', back);
  if (back && !document.getElementById('phAuto')) document.body?.append(Object.assign(document.createElement('button'), { id: 'phAuto', className: 'ph-auto', textContent: '📱 Touch view', onclick: () => pickDevice('') }));
  for (const fn of listeners) { try { fn(m); } catch (e) { console.error(e); } }
  dispatchEvent(new Event('resize'));
  return m;
}
applyDevice();
addEventListener('resize', () => applyDevice());
coarse.addEventListener?.('change', () => applyDevice());

// ---------------- the phone editor ----------------
let ed = null, ctx = null, tab = 'start', pxs = 40;
// (Text has no tab of its own: it is a big card on Start, and a picked title shows its text on Timeline)
const TABS = [['start', 'Start', ic('star')], ['ai', 'AI', icon('agent')], ['edit', 'Timeline', ic('scissors')], ['export', 'Export', icon('export')], ['notes', 'Notes', ic('note')]];
// 🏁 Start: what people do on a phone, as four big cards (and the timeline for cutting)
const CARDS = [['ai', icon('agent'), 'AI se edit', 'Likho kya chahiye - AI bana dega'], ['notes', ic('note'), 'Dekho + note do', 'Jahan badlav chahiye, wahan note'],
  ['text', '<b class="ph-T">T</b>', 'Text badlo', 'Title, naam, captions'], ['export', icon('export'), 'Video banao', 'Export, render, bhejo']];

// ctx: { showPage, selectTab } from main.js
export function mountPhone(editorEl, c) {
  ed = editorEl; ctx = c;
  ed.querySelector('.menubar').insertAdjacentHTML('afterend', `<header class="ph-top">
      <button class="ph-ib" data-ph="home" aria-label="All projects"><span class="ph-back">‹</span><span>Projects</span></button>
      <div class="ph-name"><b data-ph-name></b><small data-ph-save></small></div>
      <button class="ph-ib" data-ph="undo" aria-label="Undo">${icon('undo')}</button><button class="ph-ib" data-ph="redo" aria-label="Redo">${icon('redo')}</button>
      <button class="ph-ib" data-ph="more" aria-label="More">⋯</button>
      <i class="ph-job" data-ph-job hidden></i>
    </header>`);
  ed.querySelector('.edit-grid').insertAdjacentHTML('beforeend', `<div class="ph-dock">
      <div class="ph-time"><button class="ph-ib" data-ph="start" aria-label="Go to start">⏮</button><button class="ph-play" data-ph="play" aria-label="Play / pause">▶</button>
          <span class="ph-tc"><b data-ph-tc></b> / <span data-ph-dur></span></span><span class="grow"></span>
          <button class="ph-ib ph-zoom" data-ph="zout" aria-label="Zoom out">−</button><button class="ph-ib ph-zoom" data-ph="zin" aria-label="Zoom in">+</button><button class="ph-ib" data-ph="full" aria-label="Full screen">⛶</button></div>
      <div class="ph-mode ph-start" data-mode="start">
        <p class="ph-ask">Kya karna hai?</p>
        <div class="ph-cards">${CARDS.map(([k, i, t, sub]) => `<button class="ph-card-b" data-ph-go="${k}">${i}<b>${t}</b><small>${sub}</small></button>`).join('')}</div>
        <button class="ph-tlcard" data-ph-go="edit">${ic('scissors')}<span><b>Timeline</b><small>Kaato, hatao, clip chuno</small></span><i>›</i></button>
        <p class="ph-status" data-ph-status></p>
      </div>
      <div class="ph-mode" data-mode="edit">
        <div class="ph-stripw"><div class="ph-strip" data-ph-strip><div class="ph-strip-in" data-ph-in></div></div><i class="ph-ph" aria-hidden="true"></i></div>
        <div class="ph-acts">
          <button data-ph="split">${ic('scissors')}<span>Split</span></button><button data-ph="dup">${ic('copy')}<span>Duplicate</span></button>
          <button data-ph="del">${ic('trash')}<span>Delete</span></button><button data-ph="title">${ic('plus')}<span>Title</span></button></div>
        <div class="ph-sel" data-ph-sel></div>
      </div>
      <div class="ph-mode ph-list" data-mode="text" data-ph-text></div>
      <div class="ph-mode ph-notes" data-mode="notes" data-ph-notes></div>
    </div>`);
  ed.querySelector('.pagebar').insertAdjacentHTML('afterend', `<nav class="ph-nav" aria-label="Phone">${TABS.map(([k, l, i]) => `<button data-ph-tab="${k}">${i}<span>${l}</span><b class="ph-badge" hidden></b></button>`).join('')}</nav>`);
  // (on each part itself: the Edit page's panels stop some clicks on their way up)
  for (const el of ed.querySelectorAll('.ph-top, .ph-dock, .ph-nav')) el.addEventListener('click', onClick);
  wireStrip();
  // (the Assistant: its own close button takes the phone back to Edit)
  new MutationObserver(() => { if (mode === 'phone' && tab === 'ai' && !document.body.classList.contains('as-open')) setTab('start'); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  on('change', () => { if (mode !== 'phone') return; html.dataset.asp = /^(9:16|4:5|3:4|2:3)$/.test(S.project?.settings?.aspect || '') ? 'tall' : ''; drawStrip(); drawSel(); if (tab === 'text') drawText(); if (tab === 'start') drawStatus(); syncTab(); });
  on('media', () => mode === 'phone' && drawStrip());
  on('select', () => { if (mode !== 'phone') return; markSel(); drawSel(); });
  on('playhead', () => { if (mode === 'phone') follow(); });
  on('save', () => { const el = $('[data-ph-save]', ed); if (el) { el.textContent = { saved: 'Saved', saving: 'Saving…', dirty: 'Saving…', error: 'Not saved' }[S.saveState] || ''; el.className = S.saveState; } });
  on('job', (j) => { const el = $('[data-ph-job]', ed); if (el) { el.hidden = !j.running; el.title = j.label || ''; } });
  on('queue', (q) => { qLabel = q.count ? q.label : ''; if (tab === 'start') drawStatus(); const b = $('[data-ph-tab="export"] .ph-badge', ed); if (b) { b.hidden = !q.count; b.textContent = q.count || ''; } });
  onDevice(enter);
  enter(mode);
}

// a project opened / the phone turned into the phone layout (or out of it)
function enter(m) {
  if (!ed) return;
  const notes = document.getElementById('notesPanel');
  if (m === 'phone') {
    $('[data-ph-name]', ed).textContent = S.proj || '';
    if (notes && !notes.closest('.ph-notes')) { notesHome ||= { parent: notes.parentElement, next: notes.nextSibling }; $('[data-ph-notes]', ed).append(notes); notes.hidden = false; }
    setTab(tab === 'export' && S.page !== 'deliver' ? 'start' : tab);
    setTimeout(() => { drawStrip(); drawSel(); }, 30);
  } else {
    if (notes && notesHome && notes.parentElement !== notesHome.parent) { notesHome.parent.insertBefore(notes, notesHome.next); notes.hidden = !$('[data-ptab="notes"][aria-selected="true"]', ed); }
    if (html.dataset.phPane === 'ai') import('./assistant.js').then((a) => a.toggleAssistant(false));
    delete html.dataset.phPane;
  }
}
let notesHome = null;
export function phoneOpened() { if (mode === 'phone' && ed) { $('[data-ph-name]', ed).textContent = S.proj || ''; setTab('start'); } }

function setTab(t) {
  tab = t; html.dataset.phPane = t;
  $$('[data-ph-tab]', ed).forEach((b) => b.setAttribute('aria-current', String(b.dataset.phTab === (t === 'text' ? 'start' : t))));
  $$('.ph-mode', ed).forEach((x) => (x.hidden = x.dataset.mode !== (t === 'ai' || t === 'export' ? 'start' : t)));
  if (t === 'export') { if (S.page !== 'deliver') { ctx.showPage('deliver'); const q = document.querySelector('#deliverPage .dv-q'); if (q) q.open = false; } } // (Quality folded: Render is on the first screen)
  else if (S.page !== 'edit') ctx.showPage('edit');
  import('./assistant.js').then((a) => { const open = document.body.classList.contains('as-open'); if ((t === 'ai') !== open) a.toggleAssistant(t === 'ai'); if (t === 'ai') aiBar(); });
  if (t === 'text') drawText();
  if (t === 'start') drawStatus();
  if (t === 'notes') import('./review.js').then((r) => r.refreshNotes());
  if (t === 'edit') setTimeout(() => { drawStrip(); follow(true); }, 30); // (once the strip has its width)
}
// the page changed by something else (Export from a dialog, a page a tool opened): the tab bar follows
function syncTab() {
  const want = S.page === 'deliver' ? 'export' : tab === 'export' ? 'start' : tab;
  if (want !== tab) { tab = want; html.dataset.phPane = want; $$('[data-ph-tab]', ed).forEach((b) => b.setAttribute('aria-current', String(b.dataset.phTab === want))); $$('.ph-mode', ed).forEach((x) => (x.hidden = x.dataset.mode !== (want === 'export' ? 'start' : want))); }
}

// 🤖 the AI tab is the Assistant (type what to change) with the Agent and friends on a row above it
function aiBar() {
  const as = document.querySelector('aside.as');
  if (!as || as.querySelector('.ph-ai')) return;
  as.prepend(h(`<div class="ph-ai"><button class="primary" data-pa="agent">${icon('agent')}<span>Agent: poori edit</span></button><button data-pa="reedit">Re-edit</button><button data-pa="aiundo">AI Undo</button><button data-pa="report">Report</button></div>`));
  as.querySelector('.ph-ai').addEventListener('click', (e) => { const a = e.target.closest('[data-pa]')?.dataset.pa; if (a) ed.querySelector(`.tools [data-a="${a}"]`)?.click(); });
}

const tools = (a) => ed.querySelector(`.tools [data-a="${a}"]`)?.click();
function onClick(e) {
  const t = e.target.closest('[data-ph-tab], [data-ph-go]')?.dataset;
  if (t?.phGo) return setTab(t.phGo);
  if (t?.phTab) return setTab(t.phTab);
  const a = e.target.closest('[data-ph]')?.dataset.ph;
  if (!a) return;
  if (a === 'home') return ed.querySelector('[data-a="home"]')?.click();
  if (a === 'undo' || a === 'redo') return tools(a);
  if (a === 'more') return moreMenu(e.target.closest('[data-ph]'));
  if (a === 'play') { toggle(); return setTimeout(playLabel, 60); }
  if (a === 'start') return emit('seek', 0);
  if (a === 'full') return toggleFullscreen();
  if (a === 'zin' || a === 'zout') return zoomTo(pxs * (a === 'zin' ? 1.5 : 1 / 1.5));
  if (a === 'split') { if (!S.sel.size) selectAt(); return splitAtPlayhead(); }
  if (a === 'dup') { if (!S.sel.size) return toast('Pehle strip mein clip par tap karein'); return duplicateSelected(); }
  if (a === 'del') { if (!S.sel.size) return toast('Pehle strip mein clip par tap karein'); return deleteSelected(); }
  if (a === 'title') { addTitle(); setTimeout(() => $('[data-ph-sel] textarea', ed)?.focus(), 80); }
}
// (Split with nothing picked: the main-story clip under the playhead)
function selectAt() {
  const x = layout().V1?.find((p) => S.playhead >= p.start && S.playhead < p.end && !p.clip.gap);
  if (x) { S.sel = new Set([x.clip.id]); emit('select'); }
}

function moreMenu(btn) {
  document.querySelector('.ph-menu')?.remove();
  const m = h(`<div class="ph-menu" role="menu">
    <button data-m="versions">Versions</button><button data-m="aiundo">AI Undo</button><button data-m="brand">Brand packs</button>
    <button data-m="promptguide">Prompt guide</button><button data-m="refresh">Reload</button>
    <button data-m="desktop">Desktop view (full editor)</button>${S.me && !S.me.local ? '<a href="/team/logout" class="ph-out">Logout</a>' : ''}</div>`);
  document.body.append(m);
  const r = btn.getBoundingClientRect(); m.style.top = `${r.bottom + 4}px`;
  const close = () => { m.remove(); removeEventListener('pointerdown', out, true); };
  const out = (e) => { if (!m.contains(e.target)) close(); };
  setTimeout(() => addEventListener('pointerdown', out, true));
  m.addEventListener('click', (e) => {
    const k = e.target.closest('[data-m]')?.dataset.m; if (!k) return;
    close();
    if (k === 'desktop') { pickDevice('desktop'); toast('Desktop view - wapas aane ke liye neeche "📱 Touch view" dabaiye'); return; }
    tools(k);
    if (k === 'refresh') ed.querySelector('[data-a="refresh"]')?.click();
  });
}

// what the edit is now, in one line under the cards (and a render in the queue)
let qLabel = '';
function drawStatus() {
  const el = $('[data-ph-status]', ed); if (!el || !S.project) return;
  const n = (S.project.tracks.V1 || []).filter((c) => !c.gap).length, d = duration();
  el.textContent = n ? `${shortT(d)} ka video · ${n} shot${n > 1 ? 's' : ''}${qLabel ? ` · ${qLabel}` : ''}` : 'Timeline khaali hai - "AI se edit" se shuru karein';
}

// ---------------- the strip: the edit, sideways; the line in the middle is the playhead ----------------
let strip, inner, lastSet = -1, userScroll = 0;
function wireStrip() {
  strip = $('[data-ph-strip]', ed); inner = $('[data-ph-in]', ed);
  // dragging the strip moves through the edit (the playhead stays in the middle, the edit slides under it)
  strip.addEventListener('scroll', () => {
    if (Math.abs(strip.scrollLeft - lastSet) < 1) return;
    userScroll = Date.now();
    if (isPlayingProgram()) pause();
    emit('seek', Math.max(0, Math.min(duration(), strip.scrollLeft / pxs))); // (scroll events come once per frame already)
  }, { passive: true });
  strip.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cid]');
    S.sel = b ? linkedIds(S.project, [b.dataset.cid]) : new Set();
    emit('select');
  });
  // two fingers apart / together: zoom (around the playhead, which stays in the middle)
  let p0 = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  strip.addEventListener('touchstart', (e) => { if (e.touches.length === 2) p0 = { d: dist(e.touches), z: pxs }; }, { passive: true });
  strip.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !p0) return;
    e.preventDefault();
    zoomTo(pinchZoom(p0.z, p0.d, dist(e.touches), 4, 400));
  }, { passive: false });
  strip.addEventListener('touchend', (e) => { if (e.touches.length < 2) p0 = null; });
  new ResizeObserver(() => mode === 'phone' && drawStrip()).observe(strip);
}
function zoomTo(z) { pxs = Math.max(4, Math.min(400, z)); drawStrip(); follow(true); }

function drawStrip() {
  times();
  if (!strip || !S.project || !strip.clientWidth) return;
  const half = Math.round(strip.clientWidth / 2), d = duration();
  const rows = stripRows(layout(), pxs);
  inner.style.width = `${Math.round(d * pxs) + half * 2}px`;
  inner.style.setProperty('--half', `${half}px`);
  inner.innerHTML = rows.length ? rows.map((r) => `<div class="ph-row${r.main ? ' main' : ''}${r.sound ? ' snd' : ''}" data-track="${r.track}"><span class="ph-tk">${r.track}</span>${r.blocks.map((b) => {
    const c = findClip(b.id)?.clip, m = c?.mediaId && S.mediaById[c.mediaId];
    let bg = '';
    if (r.main && b.kind === 'video' && m?.urls?.strip) { const sp = c.speed || 1; bg = `background-image:url('${m.urls.strip}');background-size:${Math.round((m.duration / sp) * pxs)}px 100%;background-position:${Math.round(-((c.in || 0) / sp) * pxs)}px 0`; }
    else if (r.main && b.kind === 'image' && m?.urls?.thumb) bg = `background-image:url('${m.urls.thumb}');background-size:auto 100%;background-repeat:repeat-x`;
    return `<button class="ph-b k-${b.kind}${S.sel.has(b.id) ? ' sel' : ''}" data-cid="${esc(b.id)}" style="left:${b.left}px;width:${b.width}px;${bg}"><span>${esc(r.main && b.kind === 'video' ? '' : b.label || m?.name || '')}</span></button>`;
  }).join('')}</div>`).join('') : '<p class="ph-empty">Timeline khaali hai - AI tab mein Agent se edit banwaiye, ya desktop par clips daaliye.</p>';
  follow();
}
// (a phone has no room for frames: 1:05.4)
const shortT = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
function markSel() { $$('.ph-b', inner).forEach((b) => b.classList.toggle('sel', S.sel.has(b.dataset.cid))); }
// the strip follows the playhead (playing, or moved from elsewhere) - not while a finger is moving it
function follow(force = false) {
  times();
  if (!strip || !S.project) return;
  if (!force && Date.now() - userScroll < 250) return;
  const x = Math.round(S.playhead * pxs);
  if (Math.abs(strip.scrollLeft - x) >= 1) { lastSet = x; strip.scrollLeft = x; lastSet = strip.scrollLeft; }
}

// (the time row shows on every screen, the strip only on Timeline)
function times() {
  if (!S.project) return;
  $('[data-ph-tc]', ed).textContent = shortT(S.playhead); $('[data-ph-dur]', ed).textContent = shortT(duration());
  playLabel();
}
function playLabel() { const b = $('[data-ph="play"]', ed); if (b) b.textContent = isPlayingProgram() ? '❚❚' : '▶'; }

// ---------------- the picked clip: what it is, and its texts to type ----------------
function drawSel() {
  const el = $('[data-ph-sel]', ed); if (!el || !S.project) return;
  const ids = [...S.sel], f = ids.length ? findClip(ids[0]) : null, c = f?.clip;
  $$('.ph-acts [data-ph="dup"], .ph-acts [data-ph="del"]', ed).forEach((b) => (b.disabled = !c));
  if (!c) { el.innerHTML = '<p class="muted small">Strip mein clip par tap karein - Split, Duplicate, Delete, ya title ka text yahin badlein. Do ungliyon se zoom.</p>'; return; }
  const m = c.mediaId && S.mediaById[c.mediaId], x = layout()[f.track]?.find((p) => p.clip.id === c.id);
  const fields = textFieldsOf(c, c.type === 'graphic' ? gfxFields(c.gfx?.tpl) : []);
  el.innerHTML = `<div class="ph-selhead"><b>${esc(m?.name || (c.type === 'title' ? 'Title' : c.type === 'graphic' ? `Graphic · ${c.gfx?.tpl || ''}` : c.type))}</b><small>${f.track}${x ? ` · ${fmtTC(x.start, S.project.settings.fps)} · ${(x.end - x.start).toFixed(1)}s` : ''}${ids.length > 1 ? ` · +${ids.length - 1} linked` : ''}</small></div>`
    + fields.map((t) => fieldHTML(c.id, t)).join('');
  wireFields(el);
}
const fieldHTML = (id, t) => `<label class="ph-fld"><span>${esc(t.label)}</span>${t.multi ? `<textarea rows="2" data-tid="${esc(id)}" data-k="${esc(t.k)}">${esc(t.value)}</textarea>` : `<input data-tid="${esc(id)}" data-k="${esc(t.k)}" value="${esc(t.value)}">`}</label>`;
// typing shows on the monitor at once; the change is kept (one Undo step) when the box is left
function wireFields(el) {
  $$('[data-tid]', el).forEach((inp) => {
    inp.addEventListener('input', () => { const c = findClip(inp.dataset.tid)?.clip; if (c && setText(c, inp.dataset.k, inp.value)) { inp.dataset.dirty = '1'; emit('live'); } });
    inp.addEventListener('change', () => { if (inp.dataset.dirty) { delete inp.dataset.dirty; commit('Text'); } });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
  });
  $$('[data-cue]', el).forEach((inp) => {
    inp.addEventListener('change', () => {
      const cue = (capTracks(S.project.captions)[0]?.cues || []).find((q) => q.id === inp.dataset.cue);
      if (cue && cue.text !== inp.value) { cue.text = inp.value; commit('Caption text'); }
    });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
  });
}

// ---------------- Text tab: every title / text on the edit, and the captions near the playhead ----------------
function drawText() {
  const el = $('[data-ph-text]', ed); if (!el || !S.project) return;
  if (el.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return; // (not while typing)
  const fps = S.project.settings.fps, L = layout();
  const items = Object.entries(L).filter(([k]) => k[0] === 'V').flatMap(([track, xs]) => xs.map((x) => ({ track, x })))
    .map(({ track, x }) => ({ track, x, fields: textFieldsOf(x.clip, x.clip.type === 'graphic' ? gfxFields(x.clip.gfx?.tpl) : []) }))
    .filter((i) => i.fields.length).sort((a, b) => a.x.start - b.x.start);
  const cues = cuesAround(capTracks(S.project.captions)[0]?.cues, S.playhead, 40);
  el.innerHTML = `<div class="ph-lhead"><b>Titles & text</b><span class="grow"></span><button class="small" data-ph="title">+ Title</button></div>`
    + (items.length ? items.map((i) => `<div class="ph-card"><button class="ph-at" data-seek="${i.x.start + 0.05}">${fmtTC(i.x.start, fps)}</button><small class="muted">${i.track}${i.x.clip.type === 'graphic' ? ` · ${esc(i.x.clip.gfx?.tpl || '')}` : ''}</small>${i.fields.map((t) => fieldHTML(i.x.clip.id, t)).join('')}</div>`).join('') : '<p class="muted small">Is edit mein abhi koi title / text nahi hai.</p>')
    + (cues.length ? `<div class="ph-lhead"><b>Captions</b><small class="muted">playhead ke aas-paas</small></div>` + cues.map((q) => `<div class="ph-card"><button class="ph-at" data-seek="${q.start + 0.02}">${fmtTC(q.start, fps)}</button><textarea rows="2" data-cue="${esc(q.id)}">${esc(q.text)}</textarea></div>`).join('') : '');
  wireFields(el);
  el.onclick = (e) => { const s = e.target.closest('[data-seek]'); if (s) emit('seek', +s.dataset.seek); };
}
