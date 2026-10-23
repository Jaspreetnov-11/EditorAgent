// Multi-track timeline: V2 overlays/titles, V1 magnetic main story, A1 voice-over, A2 music, A3 SFX.
// Drag to move (V1 reorders), drag edges to trim, blade/S to split, drop media from the pool, snapping to edges + playhead.
import { guarded } from './errlog.js';
import { S, on, emit, commit, layout, duration, findClip, saveNow } from './store.js';
import { zoneBandsHTML } from './zones.js';
import { seqMenu, seqName, openSequence, nestSelected, renameSequence } from './sequences.js';
import { makeCompFromClip, textBehindFromClip, trackMatteFromClips } from './motionpage.js';
import { fusionFromClip, rotoFromClip } from './fusionpage.js';
import { labsFromClip } from './labsedit.js';
import { seqList, seqHash } from './model.js';
import { VFX } from './effects.js';
import { AFX } from './audioeffects.js';
import { sharedSeqId } from './store.js';
import { openAudioGain, soundClips } from './audiogain.js';
import { copyClips, pasteClips, clipboard } from './clipboard.js';
import { TOOL_GROUPS, groupClick, MANY_SELECT } from './toolgroups.js';
import { clipDur, uid, fmtTC, fmt, trackList, trackKind, trackNum, ensureTrack, frameScale, addTrack, syncLinked, linkAudioOf, linkedPartner, linkedIds, groupedIds, syncShift, rippleMarkers, evalKeys, fmtTime, freeAudioTrack, RAMPS, setRamp, rampPts, rampPart, profileAt, TRANSITIONS, setTransition, trHandles, propAt, keepLength, sourceAt } from './model.js';
import { $, $$, h, esc, clamp, toast, modal } from './ui.js';
import { api, enc } from './api.js';
import { openTemplates } from './titlesui.js';
import { openGraphics } from './gfxui.js';
import { GFX } from './graphics.js';
import { autoSoundDesign } from './sfxui.js';
import { openReplace } from './replace.js';
import { dropFx, transitionLength } from './fxpanel.js';
import { editMarker, markerNear } from './markers.js';
import { typeTimecode, replaceEdit, groupSelected, ungroupSelected, addClipMarker, clearClipMarkers } from './editing.js'; // (editing.js uses this module's gapClip / tidyGaps only when called)

// row heights: the main story is tallest; voice-over and music get room for their waveforms
// track heights: drag the bottom edge of a track header (double-click = back to normal); kept in this browser
const ROW_DEF = (id) => (id === 'V1' ? 66 : trackKind(id) === 'video' ? 46 : id === 'A1' || id === 'A2' ? 44 : 36);
let rowSizes = (() => { try { return JSON.parse(localStorage.getItem('ve-track-h') || '{}'); } catch { return {}; } })();
const rowH = (id) => rowSizes[id] || ROW_DEF(id);
function setRowH(id, h) {
  if (h) rowSizes[id] = Math.round(Math.max(24, Math.min(240, h))); else delete rowSizes[id];
  try { localStorage.setItem('ve-track-h', JSON.stringify(rowSizes)); } catch {}
  render();
}
const KIND = new Proxy({}, { get: (_, id) => trackKind(id) });
// a row's top inside the timeline canvas (the insert marker and dragged clips are placed with it)
const rowTop = (id) => { const r = rowsEl?.querySelector(`[data-track="${id}"]`), cv = $('#tlCanvas', root); return r && cv ? r.getBoundingClientRect().top - cv.getBoundingClientRect().top : 0; };
let root, scroller, rowsEl, ruler, playheadEl, snapEl, headsEl;
let drag = null;
let lastDown = { id: null, t: 0, x: 0, y: 0 }, lastOpen = 0; // 🖱 our own double-click (two downs on one clip within 400 ms)

export function mountTimeline(el) {
  root = el;
  el.innerHTML = `
  <div class="tl-top">
    <div class="tl-tools" role="toolbar" aria-label="Tools">
      <div class="segbtns" role="radiogroup" aria-label="Tool">
        ${TOOL_GROUPS.map((g, i) => toolBtn(g[0], i)).join('')}
      </div>
      <span class="sep"></span>
      <button data-act="split" title="Split clips under the playhead (S)">${ICON.split}<span>Split</span></button>
      <button data-act="trimStart" title="Cut the front: remove everything before the playhead from the clip under it, the gap closes (Q)"><b>⇤</b><span>Trim front</span></button>
      <button data-act="trimEnd" title="Cut the back: remove everything after the playhead from the clip under it, the gap closes (W)"><b>⇥</b><span>Trim back</span></button>
      <button data-act="delete" title="Delete selected (Del)">${ICON.trash}<span>Delete</span></button>
      <button data-act="dup" title="Duplicate (Ctrl+D)">${ICON.copy}<span>Duplicate</span></button>
      <span class="sep"></span>
      <button data-act="title" title="Titles, lower thirds and cards - pick a template (T adds a plain title)">${ICON.text}<span>Title</span></button>
      <button data-act="gfx" title="Motion graphics: counters, charts, callouts, route lines"><b>📊</b><span>Graphic</span></button>
      <button data-act="adjust" title="Adjustment layer: colour / effects for every track below it, at the playhead"><b>◩</b><span>Adjust</span></button>
      <button data-act="ramp" title="Speed ramp: pick a preset for the selected video clips (slow-mo hit, bullet time, whoosh…)"><b>⏩</b><span>Ramp</span></button>
      <button data-act="roto" title="Roto (AI): select a video clip - its subject (person / animal / vehicle) is cut out onto the track above. Put text on a track in between to have it behind the person"><b>✂</b><span>Roto</span></button>
      <button data-act="sfx" title="Auto sound design: whooshes, hits and a riser on A3, lined up with your cuts, transitions and effects"><b>🔊</b><span>SFX</span></button>
      <span class="sep"></span>
      <button data-act="snap" class="tog" title="Snapping on/off (N)">${ICON.magnet}<span>Snap</span></button>
    </div>
    <div class="tl-bar">
      <div class="tl-seqtabs" id="tlSeqTabs" role="tablist" aria-label="Sequences"></div>
      <button data-act="seq" class="tl-seq" title="Sequences: switch, make a new one, copy / paste a timeline, manage" aria-haspopup="menu"><b>🎞</b><span id="tlSeqName"></span><i class="tl-seq-caret">▾</i></button>
      <span class="sep"></span>
      <span class="tl-tc" id="tlTC" title="Click and type a timecode: 1:10:00 or 11000 goes there, +15 / -1:00 moves by that (the selected clips, else the playhead)">00:00:00:00</span><span class="tl-dur" id="tlDur"></span>
      <span class="grow"></span>
      <button data-act="fit" title="Fit the whole edit (Shift+Z)">Fit</button>
      <label class="zoom" title="Zoom (+ / -)">${ICON.zoomOut}<input type="range" id="tlZoom" min="2" max="300" step="1" aria-label="Timeline zoom">${ICON.zoomIn}</label>
    </div>
  </div>
  <div class="tl-main">
    <div class="tl-heads" id="tlHeads"></div>
    <div class="tl-scroll" id="tlScroll">
      <div class="tl-canvas" id="tlCanvas">
        <canvas class="tl-ruler" id="tlRuler" height="28"></canvas>
        <div class="tl-rows" id="tlRows"></div>
        <div class="tl-playhead" id="tlPlayhead"><div class="ph-head"></div></div>
        <div class="tl-snapline" id="tlSnap" hidden></div>
        <div class="tl-insert" id="tlInsert" hidden></div>
        <div class="tl-editpt" id="tlEditPt" hidden></div>
        <div class="tl-auto" id="tlAuto"></div>
      </div>
    </div>
  </div>`;
  scroller = $('#tlScroll', el); rowsEl = $('#tlRows', el); ruler = $('#tlRuler', el);
  import('./mastermeter.js').then((m) => m.mountMasterMeter($('.tl-main', el))); // 🎚 Audio Meters at its right
  playheadEl = $('#tlPlayhead', el); snapEl = $('#tlSnap', el); headsEl = $('#tlHeads', el);

  $$('[data-tool]', el).forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  bindToolGroups(el);
  // 🎞 a sequence tab: open that sequence (this browser only)
  $('#tlSeqTabs', el).addEventListener('click', (e) => {
    const x = e.target.closest('[data-sclose]');
    if (x) { e.stopPropagation(); return closeSeqTab(x.dataset.sclose); }
    const t = e.target.closest('[data-stab]'); if (t && t.getAttribute('aria-selected') !== 'true') openSequence(t.dataset.stab);
  });
  // double-click a tab: rename that sequence
  $('#tlSeqTabs', el).addEventListener('dblclick', (e) => { const t = e.target.closest('[data-stab]'); if (t && !e.target.closest('[data-sclose]')) renameSequence(t.dataset.stab); });
  // middle-click closes a tab too (like a browser / Premiere)
  $('#tlSeqTabs', el).addEventListener('auxclick', (e) => { const t = e.target.closest('[data-stab]'); if (t && e.button === 1) { e.preventDefault(); closeSeqTab(t.dataset.stab); } });
  $('.tl-top', el).addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a) return;
    if (a === 'seq') seqMenu(e.target.closest('[data-act]'));
    if (a === 'split') splitAtPlayhead();
    if (a === 'trimStart') trimAtPlayhead('start');
    if (a === 'trimEnd') trimAtPlayhead('end');
    if (a === 'delete') deleteSelected();
    if (a === 'dup') duplicateSelected();
    if (a === 'title') openTemplates();
    if (a === 'gfx') openGraphics();
    if (a === 'adjust') addAdjustmentLayer();
    if (a === 'ramp') { const r = e.target.closest('[data-act]').getBoundingClientRect(); rampMenu({ clientX: r.right + 4, clientY: r.top }); }
    if (a === 'roto') {
      const id = [...S.sel].find((s) => findClip(s)?.clip.type === 'video');
      if (!id) toast('Select a video clip on the timeline first, then press Roto', 'err'); else rotoFromClip(id, findClip);
    }
    if (a === 'sfx') autoSoundDesign().catch((err) => toast(err.message, 'err'));
    if (a === 'snap') { S.snap = !S.snap; syncBar(); }
    if (a === 'fit') fitZoom();
  });
  // ⌨ the timecode is a field, like Premiere's: click it and type where to go / how far to move
  $('#tlTC', el).addEventListener('click', () => typeTimecode($('#tlTC', el)));
  const z = $('#tlZoom', el);
  z.value = S.zoom;
  z.oninput = () => setZoom(+z.value, true);
  // 🔍 the zoom slider (with Fit) sits at the bottom left, on the page bar beside Media · Edit · Motion (Edit page only)
  const pb = document.querySelector('.pagebar');
  if (pb) {
    const box = h('<div class="pb-zoom" id="pbZoom"></div>');
    box.append($('[data-act="fit"]', el), z.closest('label'));
    box.querySelector('[data-act="fit"]').onclick = () => fitZoom();
    pb.prepend(box);
    const vis = () => { box.hidden = S.page !== 'edit'; };
    on('change', vis); vis();
  }
  scroller.addEventListener('scroll', () => {
    headsEl.scrollTop = scroller.scrollTop; drawRuler(); drawWaves();
    // big edits draw only the clips near the view: scrolled close to the edge of what is drawn -> draw that part
    if (drawn && (scroller.scrollLeft < drawn.a + scroller.clientWidth * 0.3 || scroller.scrollLeft + scroller.clientWidth > drawn.b - scroller.clientWidth * 0.3) && !drag) {
      clearTimeout(scrollRender); scrollRender = setTimeout(render, 30);
    }
  });
  scroller.addEventListener('wheel', (e) => {
    // like Premiere: the wheel moves the timeline left / right, Ctrl (or Shift) + wheel scrolls the tracks up / down,
    // Alt + wheel zooms (a touchpad's own sideways swipe keeps working as it is)
    if (e.altKey) { e.preventDefault(); setZoom(S.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), true, e.clientX); return; }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    const up = e.ctrlKey || e.shiftKey, d = (e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY) * (up ? 1 : 1.5);
    if (up) scroller.scrollTop += d; else scroller.scrollLeft += d;
  }, { passive: false });
  new ResizeObserver(() => { if (pendingFit && scroller.clientWidth >= 80) fitZoom(); else drawRuler(); }).observe(scroller);
  // the track headers scroll the tracks up / down with the wheel, Ctrl + wheel too (like Premiere's track header area;
  // Ctrl + wheel was let through and zoomed the whole browser page - the headers piled up on each other)
  headsEl.addEventListener('wheel', (e) => {
    if (e.altKey) return;
    e.preventDefault();
    scroller.scrollTop += (e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY);
    headsEl.scrollTop = scroller.scrollTop;
  }, { passive: false });

  ruler.addEventListener('pointerdown', (e) => scrubStart(e));
  // 📍 double-click a marker on the ruler: name, comment, colour, length (markers.js)
  ruler.addEventListener('dblclick', (e) => { const mk = markerNear(timeAt(e.clientX)); if (mk) { e.preventDefault(); editMarker(mk, drawRuler); } });
  // the playhead line itself can be taken and dragged anywhere down the tracks (not only in the ruler)
  playheadEl.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.stopPropagation(); scrubStart(e); });
  rowsEl.addEventListener('pointerdown', onRowsDown);
  // the empty timeline under the last track (and past the rows): a click puts the playhead there, a drag selects clips
  scroller.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('#tlRows, .tl-ruler, #tlPlayhead, .tl-marquee, .tr-box, .clip, button, input, select')) return;
    if (e.offsetX > scroller.clientWidth || e.offsetY > scroller.clientHeight) return; // (its scrollbars)
    marqueeStart(e);
  });
  rowsEl.addEventListener('contextmenu', onContext);
  rowsEl.addEventListener('dragover', onDragOver);
  rowsEl.addEventListener('dragleave', () => { $('#tlInsert').hidden = true; });
  rowsEl.addEventListener('drop', onDrop);
  // (double-clicks are found in onRowsDown: the first click redraws the clip as selected, so the browser's own dblclick
  // often never arrives; this one only catches what that missed)
  rowsEl.addEventListener('dblclick', (e) => { const c = e.target.closest('.clip'); if (c && Date.now() - lastOpen > 600) { lastOpen = Date.now(); emit('openClip', c.dataset.id); } });

  on('change', render);
  on('presence', decoratePeers);
  on('media', render);
  on('select', render);
  on('playhead', () => { placePlayhead(); followPlayhead(); });
  render();
}

const toolIcon = (x) => (x[3][0] === '@' ? ICON[x[3].slice(1)] : x[3]); // (ICON is made further down)
const toolTip = (x) => `${x[1]}${x[2] ? ` (${x[2]})` : ''}: ${x[4]}`;
function toolBtn(x, i) {
  const many = TOOL_GROUPS[i].length > 1;
  return `<button data-tool="${x[0]}" data-grp="${i}" title="${esc(toolTip(x))}${many ? ' - hold, right-click or ◢ for the others' : ''}" aria-label="${esc(x[1])}">${toolIcon(x)}${many ? '<i class="tg-more" data-tgmore></i>' : ''}</button>`;
}
// the flyout of group i under / beside its button
function toolFlyout(btn) {
  document.querySelector('.tg-fly')?.remove();
  const g = TOOL_GROUPS[+btn.dataset.grp], r = btn.getBoundingClientRect(), m = document.createElement('div');
  m.className = 'tg-fly ctx'; m.setAttribute('role', 'menu');
  m.innerHTML = g.map((x) => `<button role="menuitem" data-pick="${x[0]}" title="${esc(x[4])}"><span class="tg-ic">${toolIcon(x)}</span><span>${S.tool === x[0] ? '■ ' : ''}${esc(x[1])}</span>${x[2] ? `<kbd>${x[2]}</kbd>` : ''}</button>`).join('');
  document.body.append(m);
  m.style.left = `${Math.min(r.right + 4, innerWidth - m.offsetWidth - 6)}px`; m.style.top = `${Math.min(r.top, innerHeight - m.offsetHeight - 6)}px`;
  const close = () => { m.remove(); window.removeEventListener('pointerdown', out, true); };
  const out = (e) => { if (!m.contains(e.target)) close(); };
  setTimeout(() => window.addEventListener('pointerdown', out, true));
  m.addEventListener('click', (e) => { const p = e.target.closest('[data-pick]'); if (p) { close(); setTool(p.dataset.pick); } });
}
function bindToolGroups(el) {
  el.querySelectorAll('[data-grp]').forEach((b) => {
    let hold = null;
    b.addEventListener('pointerdown', (e) => { if (e.button === 0 && TOOL_GROUPS[+b.dataset.grp].length > 1) hold = setTimeout(() => { hold = 'open'; toolFlyout(b); }, 450); });
    const stop = () => { if (hold && hold !== 'open') clearTimeout(hold); };
    b.addEventListener('pointerup', stop); b.addEventListener('pointerleave', stop);
    // (its own click handler: the generic one switched the tool before the flyout could stop it)
    const many = TOOL_GROUPS[+b.dataset.grp].length > 1;
    b.onclick = (e) => {
      const act = groupClick({ held: hold === 'open', corner: !!e.target.closest('[data-tgmore]'), many });
      hold = null;
      if (act === 'flyout') toolFlyout(b); else if (act === 'set') setTool(b.dataset.tool);
    };
    b.addEventListener('contextmenu', (e) => { if (TOOL_GROUPS[+b.dataset.grp].length > 1) { e.preventDefault(); toolFlyout(b); } });
  });
}
export function setTool(t) {
  if (MANY_SELECT.has(t) && S.tool !== t) toast(`${t === 'trackfwd' ? 'Track Select Forward (A): a click selects that clip and everything after it' : 'Track Select Backward (Shift+A): a click selects that clip and everything before it'} on every track - press V for the Selection tool`);
  S.tool = t; syncBar(); root.classList.toggle('blade', t === 'blade'); root.dataset.tool = t; render(); }
function syncBar() {
  // (the group of the tool in use shows it on its button)
  root.querySelectorAll('[data-grp]').forEach((b) => {
    const g = TOOL_GROUPS[+b.dataset.grp], x = g.find((y) => y[0] === S.tool);
    if (x && b.dataset.tool !== x[0]) { const n = document.createElement('div'); n.innerHTML = toolBtn(x, +b.dataset.grp); const nb = n.firstElementChild; b.dataset.tool = x[0]; b.title = nb.title; b.setAttribute('aria-label', nb.getAttribute('aria-label')); b.innerHTML = nb.innerHTML; }
    b.setAttribute('aria-pressed', String(!!x));
  });
  const sn = $('#tlSeqName', root); if (sn && S.project) sn.textContent = seqName(); // 🎞 the open sequence
  const tabs = $('#tlSeqTabs', root);
  if (tabs && S.project) {
    // the tabs keep their places (opening one doesn't move it to the front): the first order seen is remembered
    // in this browser per project, new sequences go at the end
    const okey = `ve-seqorder:${S.proj}`; let order = []; try { order = JSON.parse(localStorage.getItem(okey) || '[]'); } catch {}
    const list0 = seqList(S.project), ids = new Set(list0.map((x) => x.id));
    order = order.filter((id) => ids.has(id)); for (const x of list0) if (!order.includes(x.id)) order.push(x.id);
    try { localStorage.setItem(okey, JSON.stringify(order)); } catch {}
    // ✕ closed tabs are hidden here (the sequence itself stays - 🎞 ▾ opens it again, which shows its tab again)
    const closed = closedTabs(); for (const x of list0) if (x.open) closed.delete(x.id);
    const list = [...list0].filter((x) => !closed.has(x.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)), team = sharedSeqId(), html = list.map((x) => `<button role="tab" class="tl-stab" data-stab="${esc(x.id)}" aria-selected="${x.open}" title="${esc(x.name)}${x.id === team ? ' (team main sequence)' : ''} - double-click to rename">${x.id === team ? '<i class="stab-team">👥</i>' : ''}<span>${esc(x.name)}</span>${list0.length - closed.size > 1 ? `<i class="stab-x" data-sclose="${esc(x.id)}" title="Close this tab (the sequence stays - ▾ opens it again)">✕</i>` : ''}</button>`).join('');
    if (tabs.__html !== html) { tabs.innerHTML = html; tabs.__html = html; const cur = tabs.querySelector('[aria-selected="true"]'); if (cur && (cur.offsetLeft < tabs.scrollLeft || cur.offsetLeft + cur.offsetWidth > tabs.scrollLeft + tabs.clientWidth)) tabs.scrollLeft = Math.max(0, cur.offsetLeft - 40); }
  }
  $('[data-act="snap"]', root).classList.toggle('on', S.snap);
}

// ✕ sequence tabs: which ones this browser has closed (per project)
const ckey = () => `ve-seqclosed:${S.proj}`;
function closedTabs() { try { return new Set(JSON.parse(localStorage.getItem(ckey()) || '[]')); } catch { return new Set(); } }
function saveClosed(s) { try { localStorage.setItem(ckey(), JSON.stringify([...s])); } catch {} }
function closeSeqTab(id) {
  const list = seqList(S.project), closed = closedTabs();
  closed.add(id);
  const left = list.filter((x) => !closed.has(x.id));
  if (!left.length) return toast('The last open sequence stays', 'err');
  saveClosed(closed);
  // closing the one you are on: the next tab to its right (or left) opens
  if (list.find((x) => x.id === id)?.open) { const tabs = [...document.querySelectorAll('#tlSeqTabs [data-stab]')].map((b) => b.dataset.stab), i = tabs.indexOf(id); openSequence(tabs.slice(i + 1).find((t) => !closed.has(t)) || tabs.slice(0, i).reverse().find((t) => !closed.has(t)) || left[0].id); }
  syncBar();
}
// opening a sequence from anywhere (🎞 menu, a nested clip) shows its tab again
on('seq', () => { if (!S.project) return; const open = seqList(S.project).find((x) => x.open)?.id, c = closedTabs(); if (open && c.delete(open)) saveClosed(c); });

export function setZoom(z, keepPlayhead = false, anchorX = null) {
  const old = S.zoom;
  S.zoom = clamp(z, 2, 300);
  const zs = document.getElementById('tlZoom'); if (zs) zs.value = S.zoom; // (on the page bar - pbZoom)
  const rect = scroller.getBoundingClientRect();
  const ax = anchorX !== null ? anchorX - rect.left : keepPlayhead ? S.playhead * old - scroller.scrollLeft : 0;
  const t = (scroller.scrollLeft + ax) / old;
  render();
  scroller.scrollLeft = Math.max(0, t * S.zoom - ax);
}
let pendingFit = false;
export function fitZoom() {
  // while the Edit page is hidden the timeline has no width: fit once it becomes visible
  if (!scroller || scroller.clientWidth < 80) { pendingFit = true; return; }
  pendingFit = false;
  const d = Math.max(5, duration());
  setZoom((scroller.clientWidth - 40) / d);
  scroller.scrollLeft = 0;
}

// ---------------- render ----------------
const mName = (c) => (c.labsId && S.project.labs?.[c.labsId] ? S.project.labs[c.labsId].name : c.type === 'title' ? (c.text || 'Title').split('\n')[0] : c.type === 'adjust' ? '◩ Adjustment layer' : c.type === 'graphic' ? (c.gfx?.tpl === 'fusion' ? `${c.gfx.fusion?.name || 'Fusion'}` : c.gfx?.tpl === 'comp' ? `${c.gfx.comp?.name || 'Comp'}` : `${c.gfx?.title || GFX[c.gfx?.tpl]?.label || 'Graphic'}`) : nestedName(c) || S.mediaById[c.mediaId]?.name || 'Missing media');
// a nested clip is named after its sequence (renaming the sequence renames the clip)
const nestedName = (c) => { const sid = S.mediaById[c.mediaId]?.seqOf; const s = sid && seqList(S.project).find((x) => x.id === sid); return s ? `${s.name}` : null; };

// edits with many clips (an agent edit can have hundreds) draw only the clips within a screen of the view (+ selected)
let drawn = null, scrollRender = 0;
const VIRTUAL_AT = 150;
// 🛡 drawn through guarded(): a clip it cannot draw leaves a note + Reload over the tracks, never a blank timeline
function render() { return guarded(rowsEl, 'Timeline', renderNow); }
// ⧉ Duplicate frame markers (like Premiere, View menu): where the same frames of a file are used by more than one video
// clip, a stripe in that file's own colour runs along the bottom of each - so a shot used twice is seen at once
let dupMarks = null;
const DUP_KEY = 've-dupframes';
export const dupFramesOn = () => { try { return localStorage.getItem(DUP_KEY) !== '0'; } catch { return true; } };
export function toggleDupFrames() { try { localStorage.setItem(DUP_KEY, dupFramesOn() ? '0' : '1'); } catch {} render(); toast(`Duplicate frame markers ${dupFramesOn() ? 'on' : 'off'}`); }
function dupFrames(L) {
  const by = {};
  for (const [t, list] of Object.entries(L)) if (trackKind(t) === 'video') for (const x of list) {
    const c = x.clip; if (c.type !== 'video' || c.gap || c.disabled || rampPts(c)) continue;
    const sp = c.speed || 1, a = c.in || 0; (by[c.mediaId] ||= []).push({ x, a, b: a + (x.end - x.start) * sp, sp });
  }
  const out = new Map();
  for (const [mid, arr] of Object.entries(by)) {
    if (arr.length < 2) continue;
    let h = 0; for (const ch of mid) h = (h * 31 + ch.charCodeAt(0)) % 360;
    for (const p of arr) {
      const segs = [];
      for (const q of arr) { if (q === p) continue; const o0 = Math.max(p.a, q.a), o1 = Math.min(p.b, q.b); if (o1 - o0 > 0.04) segs.push([(o0 - p.a) / p.sp, (o1 - p.a) / p.sp]); }
      if (segs.length) out.set(p.x.clip.id, { col: `hsl(${h} 85% 58%)`, segs });
    }
  }
  return out;
}
function renderNow() {
  if (!S.project || !root) return;
  syncBar();
  const L = layout(), D = duration();
  const width = Math.max(scroller.clientWidth, (D + 30) * S.zoom);
  $('#tlCanvas', root).style.width = `${width}px`;
  const ts = S.project.trackState;

  const TR = trackList(S.project);
  // a track the list shows always exists in the project (an older project has no V3 yet: dropping on it must work)
  for (const t of TR) { S.project.tracks[t.id] ||= []; ts[t.id] ||= { mute: false, hide: false, lock: false, volume: 1 }; }
  drawHeads(TR, ts);
  dupMarks = dupFramesOn() ? dupFrames(L) : null;
  const many = Object.values(L).reduce((n, l) => n + l.length, 0) > VIRTUAL_AT, vw = scroller.clientWidth || 1200;
  drawn = many ? { a: Math.max(0, scroller.scrollLeft - vw), b: scroller.scrollLeft + vw * 2 } : null;
  const near = (x) => !drawn || (x.end * S.zoom >= drawn.a && x.start * S.zoom <= drawn.b) || S.sel.has(x.clip.id);
  patchRows(TR.map((t) => ({ id: t.id, cls: `tl-row ${t.kind}${ts[t.id]?.hide ? ' hidden-track' : ''}${ts[t.id]?.lock ? ' locked' : ''}`, h: rowH(t.id),
    clips: (L[t.id] || []).flatMap((x, i) => (near(x) ? [[String(x.clip.id), clipHTML(t.id, x, i)], ...(t.id === 'V1' && i > 0 && x.overlap ? [[`tr-${x.clip.id}`, transHTML(x)]] : [])] : [])) })));
  $('#tlDur', root).textContent = `/ ${fmtTime(D, S.project.settings)}`;
  placePlayhead();
  placeEditPt();
  drawAuto();
  drawRuler();
  decoratePeers();
  drawWaves();
}
// 🎚 track volume keyframes (trackState.volKeys: [{ t, v }], v 0..2 = x the fader): a yellow line across the track with
// a dot per keyframe - drag a dot (up / down = louder / softer, sideways = when), double-click it to remove it
const AUTO_MAX = 2;
function drawAuto() {
  const box = root && $('#tlAuto', root); if (!box) return;
  const ts = S.project.trackState || {}, W = $('#tlCanvas', root).offsetWidth;
  box.innerHTML = Object.entries(ts).filter(([id, st]) => st?.volKeys?.length && S.project.tracks[id]).map(([id, st]) => {
    const h = rowH(id), top = rowTop(id), y = (v) => (h - 6) * (1 - v / AUTO_MAX) + 3, k = st.volKeys;
    const pts = [[0, y(k[0].v)], ...k.map((p) => [p.t * S.zoom, y(p.v)]), [W, y(k[k.length - 1].v)]];
    return `<svg class="ta-svg" data-ta="${id}" style="top:${top}px;height:${h}px;width:${W}px" viewBox="0 0 ${W} ${h}">
      <polyline points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}"/>
      ${k.map((p, i) => `<circle data-tai="${i}" cx="${(p.t * S.zoom).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4.5"><title>${Math.round(p.v * 100)}% at ${fmtTC(p.t, S.project.settings.fps)}</title></circle>`).join('')}</svg>`;
  }).join('');
  box.querySelectorAll('circle[data-tai]').forEach((c) => {
    const id = c.closest('[data-ta]').dataset.ta, i = +c.dataset.tai;
    c.ondblclick = (e) => { e.stopPropagation(); const st = S.project.trackState[id]; st.volKeys.splice(i, 1); if (!st.volKeys.length) delete st.volKeys; commit('Remove track volume keyframe'); };
    c.onpointerdown = (e) => {
      e.preventDefault(); e.stopPropagation();
      const st = S.project.trackState[id], k = st.volKeys, h = rowH(id), r = c.ownerSVGElement.getBoundingClientRect();
      const lo = i > 0 ? k[i - 1].t + 0.01 : 0, hi = i < k.length - 1 ? k[i + 1].t - 0.01 : Infinity;
      const move = (ev) => {
        k[i].t = +clamp(timeAt(ev.clientX), lo, hi).toFixed(3);
        k[i].v = +clamp((1 - (ev.clientY - r.top - 3) / (h - 6)) * AUTO_MAX, 0, AUTO_MAX).toFixed(3);
        drawAuto(); toast(`${id} ${Math.round(k[i].v * 100)}%`); emit('mix');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', move); commit('Track volume keyframe'); }, { once: true });
    };
  });
}

// ✂ the edit point Trim mode works on (trimmode.js): a bright bar on the cut, on V1. null = none.
let editPt = null;
export function markEditPoint(t, side = 'roll') { editPt = t === null ? null : { t, side }; placeEditPt(); }
function placeEditPt() {
  const el = root && $('#tlEditPt', root); if (!el) return;
  el.hidden = !editPt;
  if (!editPt) return;
  Object.assign(el.style, { left: `${editPt.t * S.zoom}px`, top: `${rowTop('V1')}px`, height: `${rowH('V1')}px` });
  el.dataset.side = editPt.side;
}

// ---------------- 🔊 waveforms ----------------
// The server sends a file's sound as peaks (one byte every 10 ms, 0 = silence, 255 = full scale: /pm/<p>/<id>/peaks).
// Each audio clip's canvas covers only the part of the clip on screen (plus some room to scroll), drawn column by
// column from the peaks under it - so at every zoom the waveform shows the words, pauses and beats where they are
// heard, mirrored round the middle like Premiere's.
const PEAKS = new Map(), PPS = 100;
function peaksOf(m) {
  let p = PEAKS.get(m.id);
  if (!p) {
    p = { data: null };
    PEAKS.set(m.id, p);
    fetch(m.urls.peaks).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => { if (b?.byteLength) { p.data = new Uint8Array(b); drawWaves(); } }).catch(() => {});
  }
  return p.data;
}
let waveRaf = 0;
function drawWaves() { cancelAnimationFrame(waveRaf); waveRaf = requestAnimationFrame(() => guarded(rowsEl, 'Waveforms', drawWavesNow)); }
function drawWavesNow() {
  const vw = scroller.clientWidth || 1200, v0 = scroller.scrollLeft, dpr = window.devicePixelRatio || 1, Z = S.zoom;
  for (const cv of rowsEl.querySelectorAll('canvas.clip-wave')) {
    const d = cv.dataset, m = S.mediaById[d.wm], data = m && peaksOf(m);
    if (!data) continue;
    const box = cv.parentElement, W = box.clientWidth, H = box.clientHeight, vs = +d.vs;
    // the clip's columns on screen (px from the clip's left edge); drawn with half a screen of room each side
    const s0 = v0 - vs * Z, s1 = s0 + vw, r = cv.__r, sig = `${d.wm} ${d.t0} ${d.vs} ${d.in} ${d.sp} ${d.loop}`;
    if (r && r.Z === Z && r.H === H && r.W === W && r.sig === sig && s0 >= r.a && s1 <= r.b) continue;
    const a = Math.max(0, Math.floor(s0 - vw / 2)), b = Math.min(W, Math.ceil(s1 + vw / 2));
    if (b <= a || H < 4) { cv.style.width = '0'; continue; }
    cv.__r = { a, b, Z, H, W, sig };
    const cw = Math.round((b - a) * dpr), ch = Math.round(H * dpr);
    Object.assign(cv.style, { left: `${a}px`, width: `${b - a}px` });
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d');
    g.fillStyle = getComputedStyle(box.closest('.clip')).backgroundColor || '#23460f';
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#7fd3a8';
    const t0 = +d.t0, sp = +d.sp, src0 = +d.in, loop = +d.loop, mid = ch / 2, step = sp / (Z * dpr); // source seconds per column
    for (let i = 0; i < cw; i++) {
      let t = (vs + (a + i / dpr) / Z - t0) * sp;
      if (t < 0) continue;
      if (loop) t %= loop;
      const k0 = Math.floor((src0 + t) * PPS), k1 = Math.max(k0 + 1, Math.ceil((src0 + t + step) * PPS));
      let v = 0;
      for (let k = k0; k < k1 && k < data.length; k++) if (data[k] > v) v = data[k];
      const y = (v / 255) * mid * 0.96;
      if (y > 0.25) g.fillRect(i, mid - y, 1, Math.max(1, 2 * y));
    }
  }
}

// ⚡ Phase 18: only what changed is redrawn. Each row remembers the HTML of its clips; a change replaces just the clips
// whose HTML differs (a trim on a 2000-clip timeline used to rebuild all 2000 - ~100 ms on every drag step).
function patchRows(rows) {
  const els = [...rowsEl.children];
  if (els.length !== rows.length || rows.some((r, i) => els[i].dataset.track !== r.id)) {
    rowsEl.innerHTML = rows.map((r) => `<div class="${r.cls}" data-track="${r.id}" style="height:${r.h}px">${r.clips.map((c) => c[1]).join('')}</div>`).join('');
    [...rowsEl.children].forEach((el, i) => { el.__clips = rows[i].clips; });
    return;
  }
  rows.forEach((r, i) => {
    const el = els[i], old = el.__clips || [];
    if (el.className !== r.cls) el.className = r.cls;
    if (el.style.height !== `${r.h}px`) el.style.height = `${r.h}px`;
    // the same clips in the same order: swap only those that look different (or were moved by a drag)
    if (old.length === r.clips.length && old.every((c, k) => c[0] === r.clips[k][0]) && el.children.length === old.length) {
      r.clips.forEach((c, k) => {
        const node = el.children[k];
        if (c[1] !== old[k][1] || node.style.transform || node.classList.contains('dragging')) node.outerHTML = c[1];
      });
    } else el.innerHTML = r.clips.map((c) => c[1]).join('');
    el.__clips = r.clips;
  });
}

// track headers: rebuilt only when something on them changed (so a volume slider keeps its grip while you drag it)
let headsKey = '';
// 🎯 Track targeting (Premiere's source patching): the track Insert ( , ) and Overwrite ( . ) put a Source clip on - one
// video and one audio track, picked with the small target button at the left of a track's name. Nothing picked: as
// before (Insert on V1 / A2, Overwrite as an overlay on V2 / A1). Kept per browser.
const TG_KEY = 've-targets';
export function targets() { try { return JSON.parse(localStorage.getItem(TG_KEY) || '{}'); } catch { return {}; } }
function setTarget(kind, id) {
  const t = targets(); if (t[kind] === id) delete t[kind]; else t[kind] = id;
  try { localStorage.setItem(TG_KEY, JSON.stringify(t)); } catch {}
  headsKey = ''; render();
  toast(t[kind] ? `Insert / Overwrite now go to ${t[kind]}` : `${kind === 'v' ? 'Video' : 'Audio'} target off - Insert / Overwrite as before`);
}
function drawHeads(TR, ts) {
  const tg = targets();
  const key = JSON.stringify([TR, ts, TR.map((t) => rowH(t.id)), tg]);
  if (key === headsKey && headsEl.children.length) return;
  headsKey = key;
  headsEl.innerHTML = `<div class="th-ruler"></div>` + TR.map((t) => {
    const st = ts[t.id] || {};
    return `<div class="th ${t.kind}${st.lock ? ' locked' : ''}" style="height:${rowH(t.id)}px" data-track="${t.id}" title="Right-click: rename, add or delete a track">
      <div class="th-name"><button class="th-tg${tg[t.kind === 'video' ? 'v' : 'a'] === t.id ? ' on' : ''}" data-tg="${t.id}" title="Target: Insert / Overwrite from the Source monitor go to ${t.name} (click again: off)">${t.kind === 'video' ? 'V' : 'A'}</button><b>${t.name}</b><span>${esc(t.label)}</span></div>
      <div class="th-btns">
        ${t.kind === 'video' ? `<button class="tbtn${st.hide ? ' on' : ''}" data-tst="hide" title="Hide track">${st.hide ? ICON.eyeOff : ICON.eye}</button>` : ''}
        <button class="tbtn${st.mute ? ' on' : ''}" data-tst="mute" title="${t.kind === 'video' ? 'Mute clip sound' : 'Mute track'}">M</button>
        ${t.kind === 'audio' ? `<button class="tbtn solo${st.solo ? ' on' : ''}" data-tst="solo" title="Solo Track: hear only the soloed tracks">S</button><button class="tbtn rec" data-rec="${t.id}" title="Voice-over record: 3-2-1, then the edit plays and your voice goes onto ${t.name} from the playhead (click again or Esc to stop)">🎙</button>` : ''}
        ${t.kind === 'audio' || t.id === 'V1' ? `<button class="tbtn tkey${st.volKeys?.length ? ' on' : ''}" data-tkey="${t.id}" title="Track volume keyframe at the playhead (${st.volKeys?.length || 0} now) - drag the dots on the track's yellow line, double-click one to remove it">◆</button>` : ''}
        ${t.id !== 'V1' ? `<button class="tbtn sync${st.sync ? ' on' : ''}" data-tst="sync" title="Sync Lock: when the main story ripples (Ripple delete, Q / W, Insert, ripple trim, Paste Insert, Trim mode) the clips on ${t.name} after that point move along with it">⇋</button>` : ''}
        <button class="tbtn${st.lock ? ' on' : ''}" data-tst="lock" title="Lock track">${ICON.lock}</button>
      </div>
      <div class="th-resize" data-rowh="${t.id}" title="Drag to make ${t.name} taller / shorter (double-click: normal)"></div>
      ${t.kind === 'audio' || t.id === 'V1' ? `<div class="th-volrow" title="${t.id === 'V1' ? "Volume of the clips' own sound" : 'Track volume'}: drag (double-click = 100%)"><span class="th-vlbl">🔊</span><input class="th-vol" type="range" min="0" max="2" step="0.05" value="${st.volume ?? 1}" data-tvol="${t.id}" aria-label="${t.name} volume"><span class="th-vpct">${Math.round((st.volume ?? 1) * 100)}%</span></div>` : ''}
    </div>`;
  }).join('');
  $$('[data-tst]', headsEl).forEach((b) => (b.onclick = () => {
    const id = b.closest('.th').dataset.track, k = b.dataset.tst;
    ts[id] = { ...ts[id], [k]: !ts[id]?.[k] };
    commit(k === 'sync' ? 'Sync Lock' : `Track ${k}`);
    if (k === 'sync') toast(ts[id].sync ? `⇋ Sync Lock on ${id}: its clips move along when the main story ripples` : `Sync Lock off on ${id}: its clips stay where they are`);
    emit('mix'); // (the preview mix follows mute / solo at once)
  }));
  // 🎚 track volume keyframe at the playhead: the value the line has there (1 = the fader as it is)
  $$('[data-tkey]', headsEl).forEach((b) => (b.onclick = () => {
    const id = b.dataset.tkey, st = (ts[id] ||= {}), k = (st.volKeys ||= []), t = +S.playhead.toFixed(3);
    const v = k.length ? +evalKeys(k, t).toFixed(3) : 1, i = k.findIndex((x) => Math.abs(x.t - t) < 0.02);
    if (i >= 0) k[i].v = v; else { k.push({ t, v }); k.sort((p, q) => p.t - q.t); }
    commit('Track volume keyframe'); toast(`◆ ${id} volume keyframe at ${fmtTC(t, S.project.settings.fps)} - drag its dot up / down on the track`);
  }));
  $$('[data-rec]', headsEl).forEach((b) => (b.onclick = () => import('./vorecord.js').then((m) => m.toggleRecord(b.dataset.rec))));
  $$('[data-tg]', headsEl).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); setTarget(trackKind(b.dataset.tg) === 'video' ? 'v' : 'a', b.dataset.tg); }));
  $$('[data-rowh]', headsEl).forEach((g) => {
    const id = g.dataset.rowh;
    g.ondblclick = () => setRowH(id, 0);
    g.onpointerdown = (e) => {
      e.preventDefault(); e.stopPropagation();
      const y0 = e.clientY, h0 = rowH(id);
      const move = (ev) => setRowH(id, h0 + ev.clientY - y0);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
    };
  });
  $$('[data-tvol]', headsEl).forEach((r) => {
    const id = r.dataset.tvol, pct = r.nextElementSibling;
    // (a track with no state yet - e.g. one just added - gets it here; it used to throw and the slider did nothing)
    r.oninput = () => { ts[id] = { ...ts[id], volume: +r.value }; pct.textContent = `${Math.round(r.value * 100)}%`; emit('mix'); };
    r.onchange = () => commit('Track volume', `tvol-${id}`);
    r.ondblclick = () => { r.value = 1; r.oninput(); r.onchange(); };
  });

  headsEl.insertAdjacentHTML('beforeend', '<div class="th-add"><button class="small" data-addtrack="video" title="Add a video track on top">+ Video track</button><button class="small" data-addtrack="audio" title="Add an audio track at the bottom">+ Audio track</button></div>');
  $$('[data-addtrack]', headsEl).forEach((b) => (b.onclick = () => { const id = addTrack(S.project, b.dataset.addtrack); commit(`Add track ${id}`); toast(`${id} added`); }));
  headsEl.querySelectorAll('.th[data-track]').forEach((h) => h.addEventListener('contextmenu', (e) => trackMenu(e, h.dataset.track)));
}

// 🔴 live: what the others on this timeline have selected (outlined in their colour, with their name) and their playheads
function decoratePeers() {
  if (!rowsEl || !S.project) return;
  rowsEl.querySelectorAll('.clip.peer').forEach((el) => { el.classList.remove('peer'); el.style.removeProperty('--peer'); delete el.dataset.peer; });
  const canvas = $('#tlCanvas', root);
  canvas.querySelectorAll('.peer-ph, .zone-band').forEach((x) => x.remove());
  canvas.insertAdjacentHTML('beforeend', zoneBandsHTML(S.zoom)); // 🧩 parts given to people
  const seq = S.project.seq?.id || '';
  for (const p of S.people || []) {
    if ((p.seq || '') !== seq) continue; // on another sequence of this project
    for (const id of p.sel || []) {
      const el = rowsEl.querySelector(`.clip[data-id="${CSS.escape(String(id))}"]`);
      if (el) { el.classList.add('peer'); el.style.setProperty('--peer', p.color); el.dataset.peer = p.name; }
    }
    canvas.insertAdjacentHTML('beforeend', `<div class="peer-ph" style="left:${(+p.playhead || 0) * S.zoom}px;--peer:${p.color}" title="${esc(p.name)}'s playhead"><span>${esc(p.name)}</span></div>`);
  }
}

function clipHTML(track, x, i) {
  // a gap is just empty timeline, like Premiere: nothing drawn, nothing to select or grab (it only holds the place so
  // nothing after it moves). Right-click the empty place › Ripple delete closes it.
  if (x.clip.gap) return `<div class="clip t-gap" data-id="${x.clip.id}" data-track="${track}" style="left:${x.start * S.zoom}px;width:${Math.max(2, (x.end - x.start) * S.zoom)}px"></div>`;
  const c = x.clip, m = S.mediaById[c.mediaId];
  // V1 shots are drawn cut to cut (like Premiere): the frames lent to a transition beyond a cut sit under its box,
  // not inside the shot's rectangle. vs / ve: where the rectangle starts / ends on the timeline (sec).
  let vs = x.start, ve = x.end;
  if (track === 'V1') { const L1 = layout().V1, nx = L1[i + 1]; vs = cutOf(x); if (nx?.overlap) ve = cutOf(nx); }
  const w = Math.max(2, (ve - vs) * S.zoom);
  const missing = c.type !== 'title' && c.type !== 'adjust' && c.type !== 'graphic' && !m;
  let bg = '', wv = '';
  if (c.type === 'video' && m?.urls?.strip && track !== 'A1' && track !== 'A2' && track !== 'A3') {
    const sp = c.speed || 1, full = (m.duration / sp) * S.zoom;
    bg = `background-image:url('${m.urls.strip}');background-size:${full}px 100%;background-position:${-((c.in || 0) / sp + (vs - x.start)) * S.zoom}px 0`;
  } else if (c.type === 'image' && m?.urls?.thumb) bg = `background-image:url('${m.urls.thumb}');background-size:auto 100%;background-repeat:repeat-x`;
  else if (KIND[track] === 'audio' && m?.urls?.wave) {
    const sp = c.speed || 1, seg = ((c.loop ? (c.out ?? m.duration) - (c.in || 0) : m.duration) / sp) * S.zoom;
    bg = `background-image:url('${m.urls.wave}');background-size:${c.loop ? seg : (m.duration / sp) * S.zoom}px 100%;background-position:${c.loop ? 0 : -((c.in || 0) / sp) * S.zoom}px 0;background-repeat:${c.loop ? 'repeat-x' : 'no-repeat'}`;
  }
  // 🔊 the real waveform from the sound's peaks, drawn over the picture above once they are in (drawWaves)
  if (KIND[track] === 'audio' && m?.urls?.peaks) {
    const sp = c.speed || 1, loop = c.loop ? Math.max(0.05, (c.out ?? m.duration) - (c.in || 0)) : 0;
    wv = `<canvas class="clip-wave" data-wm="${m.id}" data-t0="${x.start}" data-vs="${vs}" data-in="${c.in || 0}" data-sp="${sp}" data-loop="${loop}"></canvas>`;
  } else if (c.type === 'title') bg = `background:${track === 'V1' ? esc(c.bg || '#0b2545') : ''}`;
  else if (c.type === 'graphic') bg = c.gfx?.tpl === 'comp' || c.gfx?.tpl === 'fusion' ? '' : 'background:linear-gradient(90deg,#0b2545,#1d4e89)';
  // 🎨 kinds you can tell apart at a glance: ⤵ nested sequence (green), 🎬 Motion comp (orange), ✨ Fusion (maroon)
  const kind = c.labsId ? ' k-labs' : c.gfx?.tpl === 'comp' ? ' k-comp' : c.gfx?.tpl === 'fusion' ? ' k-fusion' : c.mediaId && S.mediaById[c.mediaId]?.seqOf ? ' k-nest' : '';
  const badges = [c.color && Object.keys(c.color).length ? '<i title="Colour graded">CC</i>' : '', c.speed && c.speed !== 1 ? `<i>${c.speed}×</i>` : '',
    c.text && c.type !== 'title' ? '<i title="Has text">T</i>' : '', c.loop ? '<i title="Loops">⟲</i>' : '', c.duck ? '<i title="Ducks under speech">duck</i>' : '',
    c.link ? `<i class="lk" title="Linked to its ${c.type === 'audio' ? 'picture' : 'sound'} - they move and trim together (Alt + click takes one; right-click › Unlink)">${c.type === 'audio' ? 'A' : 'V'}🔗</i>` : '',
    c.mute && !(c.link && c.type === 'video') ? '<i title="Muted">M</i>' : '',
    c.soundType ? `<i title="Audio type: ${c.soundType} (Essential Sound)">${{ dialogue: '🗣', music: '🎵', sfx: '💥', ambience: '🌿' }[c.soundType] || ''}</i>` : '',
    c.locked ? '<i class="lkb" title="Locked clip (right-click › Unlock clip)">🔒</i>' : '',
    c.grp ? '<i class="grpb" title="Grouped - selected, moved and deleted together (Alt + click takes one; Ctrl+Shift+G ungroups)">▣</i>' : '',
    // fx (like Premiere): the clip has effects - video effects, a cut effect, audio clean-up or masks
    c.effects?.length || c.cutFx?.type || c.afx || c.masks?.length || c.aeffects?.length ? `<i class="fxb" title="Effects: ${esc([...(c.effects || []).map((e) => e.type), c.cutFx?.type, c.afx && 'audio clean-up', ...(c.aeffects || []).map((e) => `${e.type}`), c.masks?.length && `${c.masks.length} mask${c.masks.length > 1 ? 's' : ''}`].filter(Boolean).join(', '))} (Effect Controls)">fx</i>` : '', c.sfx ? `<i title="Sound effect (auto)">${esc(c.sfx)}</i>` : '', c.ramp ? '<i title="Speed ramp">⤳</i>' : '', c.transform && (c.transform.zoom !== 1 || c.transform.x || c.transform.y || c.transform.rotation) ? '<i title="Transformed">◰</i>' : ''].join('');
  // (no + on the cut any more: it sat - invisible - over the left trim edge, so taking a shot's start to trim it often
  // added a transition instead. Transitions: Effects panel, Ctrl+D, right-click. A transition's box is drawn on the row.)
  // 🌑 a fade from / to black at an end of the clip (a one-sided Dip to Black): a box like a transition's, click to change it
  const fdName = c.type === 'audio' ? 'Fade' : 'Dip to black', len = Math.max(0.01, x.end - x.start);
  const fdBox = (end, d) => `<div class="fd-box ${end === 'in' ? 'l' : 'r'}" data-fade="${end}" title="${fdName} (${end === 'in' ? 'fade in' : 'fade out'}) ${(+d).toFixed(2)} s - click to change or remove" style="width:${Math.max(8, Math.min(len, +d) * S.zoom)}px"><span>${Math.min(len, +d) * S.zoom > 70 ? fdName : ''}</span></div>`;
  const trans = (+c.fadeIn > 0 ? fdBox('in', c.fadeIn) : '') + (+c.fadeOut > 0 ? fdBox('out', c.fadeOut) : '');
  const ov = '';
  const kt = [...new Set(Object.values(c.keys || {}).flat().map((k) => +k.t.toFixed(3)))];
  const kfs = kt.length ? `<div class="kfs">${kt.map((t) => `<i style="left:${t * S.zoom}px"></i>`).join('')}</div>` : '';
  // ⏩ a speed-ramped shot shows its speed line across the clip (like Premiere's Time Remapping band; 100% = the middle)
  const rp = c.type === 'video' && !c.gap ? rampPts(c) : null;
  const spd = rp ? `<svg class="clip-spd" viewBox="0 0 200 100" preserveAspectRatio="none" aria-hidden="true"><polyline points="${Array.from({ length: 41 }, (_, i) => { const u = i / 40, s = Math.max(0.1, Math.min(10, profileAt(rp, u))); return `${(u * 200).toFixed(1)},${(50 - 45 * (Math.log(s) / Math.log(10))).toFixed(1)}`; }).join(' ')}"/></svg>` : '';
  // 📍 clip markers (inside the clip, from its start)
  const cmk = (c.markers || []).map((mk) => `<i class="cmk" style="left:${(mk.t - (vs - x.start)) * S.zoom}px" title="${esc(mk.name || 'Clip marker')} (right-click › Remove clip markers)"></i>`).join('');
  return `<div class="clip t-${c.type}${kind}${S.sel.has(c.id) ? ' sel' : ''}${missing ? ' missing' : ''}${c.disabled ? ' off' : ''}${c.locked ? ' clocked' : ''}${c.label ? ' lab' : ''}" data-id="${c.id}" data-track="${track}"
    style="left:${vs * S.zoom}px;width:${w}px${c.label ? `;--lab:${c.label}` : ''}" title="${esc(mName(c))} · ${fmt(ve - vs)}${c.color && Object.keys(c.color).length ? ' · colour graded' : ''}${c.speed && c.speed !== 1 ? ` · ${c.speed}×` : ''}${c.ramp ? ' · speed ramp' : ''}${c.mute ? ' · muted' : ''}">
    <div class="clip-bg" style="${bg}">${wv}</div>${ov}${(dupMarks?.get(c.id)?.segs || []).map(([a0, a1]) => `<i class="dupf" title="These frames are used in another clip too" style="left:${Math.max(0, (a0 - (vs - x.start)) * S.zoom)}px;width:${Math.max(2, (a1 - a0) * S.zoom)}px;background:${dupMarks.get(c.id).col}"></i>`).join('')}${kfs}${cmk}${spd}${bandHTML(c, track, x.end - x.start)}
    <div class="clip-lbl"><span class="nm">${missing ? '⚠ ' : ''}${esc(mName(c))}</span><span class="bd">${badges}</span></div>
    <div class="clip-dur">${fmt(ve - vs)}</div>
    <div class="trim l" data-trim="l"></div><div class="trim r" data-trim="r"></div>${trans}
  </div>`;
}

// 🌑 change or remove a fade from / to black (its box at the clip's end)
function editFade(id, end) {
  const c = findClip(id)?.clip; if (!c) return;
  const k = end === 'in' ? 'fadeIn' : 'fadeOut', sound = c.type === 'audio';
  const body = h(`<div><label class="fld"><span>${sound ? 'Fade' : 'Dip to black'} - ${end === 'in' ? 'fade in at the start' : 'fade out at the end'} (seconds)</span><input type="number" data-fd min="0.05" max="10" step="0.05" value="${(+c[k] || 0.5).toFixed(2)}"></label>
    <div class="iactions"><button class="danger" data-fdx>Remove</button><span class="grow"></span><button data-close>Cancel</button><button class="primary" data-fdok>OK</button></div></div>`);
  const dlg = modal(sound ? 'Fade' : 'Dip to black', body, { width: 360 });
  const inp = body.querySelector('[data-fd]'); inp.focus(); inp.select();
  const ok = () => { const v = +inp.value; if (v > 0) { c[k] = +Math.min(10, v).toFixed(2); commit(`${end === 'in' ? 'Fade in' : 'Fade out'} ${c[k]} s`); } dlg.close(); };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') ok(); });
  body.querySelector('[data-fdok]').onclick = ok;
  body.querySelector('[data-fdx]').onclick = () => { delete c[k]; commit(`Remove ${end === 'in' ? 'fade in' : 'fade out'}`); dlg.close(); };
}

// ⧓ a transition, like Premiere's: a box ON the cut between the two shots (half over each), as long as the transition,
// with its name and the bow-tie of one shot fading into the next; click it to change or remove it. (It is drawn on the
// row, not inside a clip - inside the incoming clip it could only sit at that clip's start.)
function transHTML(x) {
  // the box is where the two shots mix: from the incoming shot's (lent) start, as long as the transition - the cut
  // between the rectangles is inside it (in the middle when both shots lent the same)
  const c = x.clip, w = Math.max(10, x.overlap * S.zoom), name = TRANSITIONS.find(([k]) => k === c.transitionIn?.type)?.[1] || c.transitionIn?.type || 'Transition';
  // the box takes the mouse only on its ends (length) and its two sides (slide / move); a strip on the cut itself is left
  // open, so the shots' ends under it can still be trimmed there (it used to cover them - no trimming a shot with a transition)
  const cx = (cutOf(x) - x.start) * S.zoom, gap = 6;
  return `<div class="tr-box" data-trans="${c.id}" title="${esc(name)} ${x.overlap.toFixed(2)} s - click to change it, drag an end to make it longer / shorter, drag it to slide it or move it to another cut; on the cut line: trim the shots" style="left:${x.start * S.zoom}px;width:${w}px">
    <i class="tr-s" style="left:7px;width:${Math.max(0, cx - gap - 7)}px"></i><i class="tr-s" style="left:${cx + gap}px;width:${Math.max(0, w - 7 - cx - gap)}px"></i>
    <i class="tr-h l" data-trdur="${c.id}"></i><span>${w > 60 ? esc(name) : ''}</span><i class="tr-h r" data-trdur="${c.id}"></i></div>`;
}
// where the cut into V1 shot x is drawn: after what the shot before lent ("handles", model.js setTransition); an older
// transition that does not say is drawn with its middle on the cut
function cutOf(x) {
  if (!x.overlap) return x.start;
  return x.start + Math.min(x.overlap, trHandles(x.clip.transitionIn).hB);
}
// 🟥🟨🟩 the render bar: red where a clip has work only a render shows exactly (stabilise, AI enhance / fill, smooth slow
// motion, render-only effects, audio clean-up), yellow where effects are shown live as an approximation, green where the
// last Accurate preview rendered this sequence as it is now. Worked out once per change.
let rbCache = null;
on('change', () => { rbCache = null; });
const RB = { red: '#e5484d', yellow: '#e8b923', green: '#36c27e' };
function clipLoad(c) {
  if (c.gap) return null;
  const red = c.stabilize || c.enhance || c.smooth || c.filled || c.afx || (c.effects || []).some((e) => e.on !== false && (!VFX[e.type]?.css || VFX[e.type]?.stab))
    || (c.aeffects || []).some((e) => e.on !== false && !AFX[e.type]?.live && !AFX[e.type]?.meter);
  if (red) return 'red';
  return c.effects?.length || c.aeffects?.length || (c.color && Object.keys(c.color).length) || c.masks?.length || c.cutFx?.type || c.transitionIn || c.ramp || c.type === 'graphic' ? 'yellow' : null;
}
function renderBar() {
  if (rbCache) return rbCache;
  const out = [];
  for (const [tr, list] of Object.entries(layout())) for (const x of list) { const k = clipLoad(x.clip); if (k && !(trackKind(tr) === 'audio' && k === 'yellow')) out.push([x.start, x.end, k]); }
  // red over yellow where they overlap: yellow first, red after
  out.sort((p, q) => (p[2] === q[2] ? 0 : p[2] === 'yellow' ? -1 : 1));
  const done = S.rendered && S.rendered.hash === seqHash(S.project) ? [[S.rendered.a, S.rendered.b, 'green']] : [];
  rbCache = [...out, ...done].map(([a, b, k]) => [a, b, RB[k]]);
  return rbCache;
}
function drawRuler() {
  if (!ruler || !scroller || !S.project) return; // (no project: back on the Projects page)
  const w = scroller.clientWidth, dpr = window.devicePixelRatio || 1;
  ruler.width = w * dpr; ruler.height = 28 * dpr; ruler.style.width = `${w}px`;
  ruler.style.left = `${scroller.scrollLeft}px`;
  // the ruler (and the playhead's head) stay at the top when many tracks are scrolled down
  ruler.style.top = `${scroller.scrollTop}px`; playheadEl.style.setProperty('--ph-top', `${scroller.scrollTop}px`);
  const g = ruler.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-2') || '#15181e';
  g.fillRect(0, 0, w, 28);
  // 🎬 In / Out: the part Export and the preview make - a band with brackets at its ends
  const rg = S.project.settings.range;
  if (rg && (rg.in !== undefined || rg.out !== undefined)) {
    const t0r = scroller.scrollLeft / S.zoom, xa = ((rg.in ?? 0) - t0r) * S.zoom, xb = rg.out === undefined ? w : (rg.out - t0r) * S.zoom;
    g.fillStyle = 'rgba(232,176,74,.22)'; g.fillRect(Math.max(0, xa), 14, Math.max(0, Math.min(w, xb) - Math.max(0, xa)), 14);
    g.fillStyle = '#e8b04a';
    if (rg.in !== undefined && xa > -6 && xa < w + 6) { g.fillRect(xa, 12, 2, 16); g.fillRect(xa, 12, 6, 2); g.fillRect(xa, 26, 6, 2); }
    if (rg.out !== undefined && xb > -6 && xb < w + 6) { g.fillRect(xb - 2, 12, 2, 16); g.fillRect(xb - 6, 12, 6, 2); g.fillRect(xb - 6, 26, 6, 2); }
  }
  const steps = [1 / 30, 0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((s) => s * S.zoom >= 90) || 600;
  const minor = steps.filter((s) => s < major).reverse().find((s) => s * S.zoom >= 12) || major / 5;
  const t0 = scroller.scrollLeft / S.zoom, t1 = t0 + w / S.zoom;
  g.strokeStyle = '#3a4150'; g.fillStyle = '#8b93a3'; g.font = '11px Segoe UI, sans-serif';
  g.beginPath();
  for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
    const x = Math.round((t - t0) * S.zoom) + 0.5, isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    g.moveTo(x, isMajor ? 12 : 20); g.lineTo(x, 28);
    if (isMajor) g.fillText(fmtTC(t, S.project.settings.fps).replace(/^00:/, ''), x + 4, 11);
  }
  g.stroke();
  // 🟥🟨🟩 render bar along the bottom of the ruler, like Premiere
  for (const [a, b, col] of renderBar()) {
    const xa = (a - t0) * S.zoom, xb = (b - t0) * S.zoom;
    if (xb < 0 || xa > w) continue;
    g.fillStyle = col; g.fillRect(Math.max(0, xa), 25, Math.min(w, xb) - Math.max(0, xa), 3);
  }
  // markers
  for (const mk of S.project.markers || []) {
    const x = (mk.t - t0) * S.zoom;
    if (x < -10 || x > w + 10) continue;
    // notes: orange until done (green); plain markers blue
    g.fillStyle = mk.color || (mk.note ? (mk.done ? '#36c27e' : '#ff9933') : '#4f8cff');
    // 📍 a range marker: a band as long as it lasts; its name next to it when there is room
    if (mk.dur > 0) { g.globalAlpha = 0.35; g.fillRect(x, 0, mk.dur * S.zoom, 8); g.globalAlpha = 1; }
    g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 8); g.fill();
    if (mk.note && !mk.done) g.fillRect(x - 0.5, 8, 1, 20);
    if (mk.name && S.zoom > 6) { g.save(); g.font = '10px sans-serif'; g.fillText(mk.name.slice(0, 30), x + 7, 22); g.restore(); }
  }
}

// 🎬 In / Out of the timeline (I / O when the Source monitor does not have the keys; Ctrl+Shift+X clears them)
export function markRange(kind) {
  if (!S.project) return;
  const st = S.project.settings, r = { ...(st.range || {}) }, t = +S.playhead.toFixed(3);
  if (kind === 'in') { r.in = t; if (r.out !== undefined && r.out <= t + 0.05) delete r.out; } else { r.out = t; if (r.in !== undefined && r.in >= t - 0.05) delete r.in; }
  st.range = r; commit(kind === 'in' ? 'Mark In' : 'Mark Out'); drawRuler();
  toast(`${kind === 'in' ? 'In' : 'Out'} at ${fmtTC(t, st.fps)} - Export and the preview make ${r.in !== undefined && r.out !== undefined ? `${fmtTC(r.in, st.fps)} to ${fmtTC(r.out, st.fps)}` : 'only this part'} (Ctrl+Shift+X clears)`);
}
export function clearRange() {
  if (!S.project?.settings.range) return toast('No In / Out on this timeline');
  delete S.project.settings.range; commit('Clear In / Out'); drawRuler(); toast('In / Out cleared - Export makes the whole timeline');
}
export const rangeMark = (kind) => S.project?.settings.range?.[kind];
// ⌫ Lift ( ; ) and Extract ( ' ), like Premiere: the part of every unlocked track between the timeline's In and Out
// comes out. Lift leaves a gap there (nothing else moves); Extract closes it - everything after the Out moves up by
// the range's length, on every track, so picture and sound stay together.
export function liftExtract(extract) {
  const rg = S.project?.settings.range;
  if (!(rg?.in !== undefined && rg?.out !== undefined && rg.out > rg.in)) return toast('Mark an In ( I ) and an Out ( O ) on the timeline first', 'err');
  const a = rg.in, b = rg.out, len = b - a, ts = S.project.trackState, eps = 0.01;
  const tracks = Object.keys(S.project.tracks).filter((t) => !ts[t]?.lock);
  // cut every clip that crosses In or Out, so the range holds whole clips only
  for (const t of tracks) for (const at of [a, b]) for (const x of [...layout()[t]]) if (!x.clip.gap && x.start < at - eps && x.end > at + eps) splitClip(x.clip.id, at);
  let n = 0;
  for (const t of tracks) {
    const inside = layout()[t].filter((x) => x.start >= a - eps && x.end <= b + eps).map((x) => x.clip);
    if (t === 'V1') {
      for (const c of inside) {
        const i = S.project.tracks.V1.indexOf(c); if (i < 0) continue;
        if (extract) S.project.tracks.V1.splice(i, 1);
        else if (!c.gap) S.project.tracks.V1.splice(i, 1, { id: uid(), type: 'title', gap: true, text: '', bg: '#000000', dur: +clipDur(c, S.mediaById).toFixed(3) });
        if (!c.gap) n++;
      }
      if (extract && S.project.tracks.V1[0]) delete S.project.tracks.V1[0].transitionIn;
    } else {
      S.project.tracks[t] = S.project.tracks[t].filter((c) => !inside.includes(c));
      n += inside.length;
      if (extract) for (const c of S.project.tracks[t]) if ((c.start || 0) >= b - eps) c.start = +((c.start || 0) - len).toFixed(3);
    }
  }
  tidyGaps();
  if (extract) { S.project.markers = (S.project.markers || []).filter((m) => !(S.project.settings.rippleMarkers && m.t > a + eps && m.t < b - eps)); rippleMarkers(S.project, b, -len); } // (📍 with Ripple Sequence Markers)
  // (an Extract closes the range on V1 too; a gap that covered more than the range is cut down to fit)
  delete S.project.settings.range; S.sel.clear(); S.playhead = a;
  commit(extract ? `Extract ${len.toFixed(2)} s` : `Lift ${len.toFixed(2)} s`);
  emit('seek', a);
  toast(`${extract ? 'Extract' : 'Lift'}: ${n} clip piece${n === 1 ? '' : 's'} out of ${len.toFixed(2)} s${extract ? ' - the rest moved up' : ' - a gap is left, nothing else moved'}`);
}

function placePlayhead() {
  if (!playheadEl) return;
  playheadEl.style.left = `${S.playhead * S.zoom}px`;
  $('#tlTC', root).textContent = S.project ? fmtTime(S.playhead, S.project.settings) : fmtTC(S.playhead, 30); // (⚙ Display format)
}
function followPlayhead() {
  if (drag) return;
  const x = S.playhead * S.zoom, l = scroller.scrollLeft, w = scroller.clientWidth;
  if (x > l + w - 30) scroller.scrollLeft = x - 60;
  else if (x < l) scroller.scrollLeft = Math.max(0, x - 60);
}

// ---------------- pointer helpers ----------------
const timeAt = (clientX) => Math.max(0, (clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft) / S.zoom);
function rowAt(clientY) {
  for (const r of $$('.tl-row', rowsEl)) { const b = r.getBoundingClientRect(); if (clientY >= b.top && clientY < b.bottom) return r.dataset.track; }
  return null;
}
function snapPoints(excludeIds) {
  const pts = [0, S.playhead];
  const L = layout();
  for (const list of Object.values(L)) for (const x of list) if (!excludeIds.has(x.clip.id)) pts.push(x.start, x.end);
  for (const mk of S.project.markers || []) pts.push(mk.t);
  return pts;
}
function snap(t, pts) {
  if (!S.snap) { snapEl.hidden = true; return t; }
  const tol = 8 / S.zoom;
  let best = null;
  for (const p of pts) if (Math.abs(p - t) < tol && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
  if (best === null) { snapEl.hidden = true; return t; }
  snapEl.hidden = false; snapEl.style.left = `${best * S.zoom}px`;
  return best;
}

function scrubStart(e) {
  e.preventDefault();
  const move = (ev) => emit('seek', timeAt(ev.clientX));
  move(e);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

// Drag on empty track space = rubber-band selection: every clip the box touches is selected
// (Shift / Ctrl keeps the clips already selected). A plain click there still moves the playhead and clears the selection.
function marqueeStart(e) {
  e.preventDefault();
  const additive = e.shiftKey || e.ctrlKey, x0 = e.clientX, y0 = e.clientY, keep = additive ? new Set(S.sel) : new Set();
  const canvas = $('#tlCanvas', root);
  let box = null, lastX = x0, raf = 0;
  const pick = (cx, cy) => {
    const l = Math.min(x0, cx), r = Math.max(x0, cx), t = Math.min(y0, cy), b = Math.max(y0, cy);
    const cr = canvas.getBoundingClientRect();
    Object.assign(box.style, { left: `${l - cr.left}px`, top: `${t - cr.top}px`, width: `${r - l}px`, height: `${b - t}px` });
    const hit = new Set(keep);
    $$('.clip', rowsEl).forEach((c) => {
      if (S.project.trackState[c.dataset.track]?.lock) return;
      const q = c.getBoundingClientRect();
      if (q.right > l && q.left < r && q.bottom > t && q.top < b) hit.add(c.dataset.id);
    });
    for (const id of groupedIds(S.project, hit)) hit.add(id); // (⛓ touching one clip of a group takes the group)
    if (hit.size !== S.sel.size || [...hit].some((id) => !S.sel.has(id))) { S.sel = hit; emit('select'); }
  };
  // keep scrolling while the pointer sits near the left / right edge
  const edgeScroll = () => {
    const sr = scroller.getBoundingClientRect(), d = lastX > sr.right - 30 ? 18 : lastX < sr.left + 30 ? -18 : 0;
    if (d && box) { scroller.scrollLeft += d; }
    raf = requestAnimationFrame(edgeScroll);
  };
  const move = (ev) => {
    lastX = ev.clientX;
    if (!box) {
      if (Math.abs(ev.clientX - x0) < 5 && Math.abs(ev.clientY - y0) < 5) return;
      box = document.createElement('div'); box.className = 'tl-marquee'; canvas.append(box);
      raf = requestAnimationFrame(edgeScroll);
    }
    pick(ev.clientX, ev.clientY);
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); cancelAnimationFrame(raf);
    if (box) { box.remove(); if (S.sel.size) toast(`${S.sel.size} clip${S.sel.size > 1 ? 's' : ''} selected`); return; }
    select(null, additive); emit('seek', timeAt(ev.clientX)); // a click, not a drag
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

// clicking one half of a linked clip selects both ([V] + [A]), a grouped clip its whole group (⛓ Ctrl+G); Alt + click
// takes only the clip you clicked
function select(id, additive, single = false) {
  if (!additive) S.sel.clear();
  if (id) {
    const ids = single ? [id] : [...linkedIds(S.project, groupedIds(S.project, [id]))];
    if (additive && S.sel.has(id)) ids.forEach((x) => S.sel.delete(x)); else ids.forEach((x) => S.sel.add(x));
  }
  emit('select');
}

// ⇥⇥ Track Select Forward (A) / ⇤⇤ Backward (Shift+A), like Premiere: the clicked clip (or the clicked time) and every
// clip after / before it on all unlocked tracks; Shift+click = only that track
function trackSelect(e, el) {
  const fwd = S.tool === 'trackfwd', L = layout(), ts = S.project.trackState;
  const x0 = el && L[el.dataset.track]?.find((p) => p.clip.id === el.dataset.id);
  const t = x0 ? (fwd ? x0.start : x0.end) : timeAt(e.clientX), only = e.shiftKey ? el?.dataset.track || rowAt(e.clientY) : null;
  S.sel = new Set();
  for (const [tr, list] of Object.entries(L)) {
    if (ts[tr]?.lock || (only && tr !== only)) continue;
    for (const x of list) if (!x.clip.gap && (fwd ? x.start >= t - 0.01 : x.end <= t + 0.01)) S.sel.add(x.clip.id);
  }
  emit('select');
  toast(S.sel.size ? `${S.sel.size} clip${S.sel.size > 1 ? 's' : ''} ${fwd ? 'from here on' : 'up to here'}${only ? ` on ${only}` : ''} selected` : 'Nothing there');
}

function onRowsDown(e) {
  if (e.button !== 0) return;
  // ✋ Hand: drag the timeline around; ⌕ Zoom: click to zoom in there, Alt+click out (like Premiere's H / Z)
  if (S.tool === 'hand') { handDrag(e); return; }
  if (S.tool === 'zoom') { e.preventDefault(); setZoom(S.zoom * (e.altKey ? 1 / 1.6 : 1.6), true, e.clientX); return; }
  // ⧓ an end of a transition box: drag it to make that side longer / shorter, on its own - the left end is how long
  // it runs before the cut, the right end after it (like Premiere); the cut and every shot stay put
  const fdb = e.target.closest('[data-fade]');
  if (fdb) { e.stopPropagation(); e.preventDefault(); editFade(fdb.closest('.clip').dataset.id, fdb.dataset.fade); return; }
  const trd = e.target.closest('[data-trdur]');
  if (trd) {
    e.stopPropagation(); e.preventDefault();
    const id = trd.dataset.trdur, f = findClip(id), x = f && layout().V1.find((p) => p.clip.id === id);
    if (!x?.overlap) return;
    const cut = cutOf(x), type = f.clip.transitionIn.type, box = trd.closest('.tr-box'); box?.classList.add('drag');
    const left = trd.classList.contains('l'), h0 = { hB: cut - x.start, hA: x.start + x.overlap - cut };
    let moved = false;
    const move = (ev) => {
      const t = timeAt(ev.clientX), side = +Math.max(0, Math.min(5, left ? cut - t : t - cut)).toFixed(2);
      const sides = left ? { hA: h0.hA, hB: side } : { hA: side, hB: h0.hB };
      if (sides.hA + sides.hB < 0.1) sides[left ? 'hB' : 'hA'] = +(0.1 - sides[left ? 'hA' : 'hB']).toFixed(2);
      const cur = findClip(id); if (!cur) return;
      setTransition(S.project, S.mediaById, cur.index, type, 0, sides); moved = true; render();
      toast(`⧓ ${findClip(id)?.clip.transitionIn?.dur?.toFixed(2) || d.toFixed(2)} s`);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', move); if (moved) commit('Transition length'); }, { once: true });
    return;
  }
  const transBtn = e.target.closest('[data-trans]');
  // ⧓ a transition box: drag it along its cut to slide it (more before / after the cut, same length - like Premiere),
  // or onto another cut to move it there; a click opens its settings
  if (transBtn?.classList.contains('tr-box')) {
    e.stopPropagation(); e.preventDefault();
    const id = transBtn.dataset.trans, x0 = e.clientX, f0 = findClip(id), lay0 = layout().V1.find((p) => p.clip.id === id);
    if (!f0 || !lay0?.overlap) return;
    const cut = cutOf(lay0), dur0 = lay0.overlap, h0 = { hB: cut - lay0.start, hA: lay0.start + dur0 - cut }, type = f0.clip.transitionIn.type;
    let moved = false, to = null, slid = false;
    const nearCut = (t) => { const L = layout().V1; let best = null; for (let j = 1; j < L.length; j++) { if (L[j].clip.id === id) continue; const ct = cutOf(L[j]); if (!best || Math.abs(ct - t) < Math.abs(best.t - t)) best = { j, t: ct }; } return best; };
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 5) return;
      moved = true;
      const t = timeAt(ev.clientX), d = (ev.clientX - x0) / S.zoom, ins = $('#tlInsert');
      const other = nearCut(t);
      // far from its own cut and nearer another: it will go there
      if (other && Math.abs(t - cut) > dur0 / 2 + 0.25 && Math.abs(other.t - t) < Math.abs(t - cut)) {
        to = other; transBtn.style.transform = `translateX(${ev.clientX - x0}px)`; transBtn.style.opacity = '.7';
        ins.hidden = false; ins.style.left = `${other.t * S.zoom}px`; ins.style.top = `${rowTop('V1')}px`; ins.style.height = `${rowH('V1')}px`;
        return;
      }
      // along its own cut: slide - what runs after the cut grows as much as what runs before it shrinks
      to = null; ins.hidden = true; transBtn.style.transform = ''; transBtn.style.opacity = '';
      const hA = +Math.max(0, Math.min(dur0, h0.hA + d)).toFixed(2), cur = findClip(id);
      if (cur) { setTransition(S.project, S.mediaById, cur.index, type, 0, { hA, hB: +(dur0 - hA).toFixed(2) }); slid = true; render(); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move); $('#tlInsert').hidden = true;
      if (!moved) return toggleTransition(id);
      if (!to) { if (slid) commit('Slide transition'); return render(); }
      const f = findClip(id), tr = f?.clip.transitionIn ? { ...f.clip.transitionIn } : null;
      if (!f || !tr || S.project.tracks.V1[to.j]?.id === id) return render();
      const target = S.project.tracks.V1[to.j];
      if (target.gap || S.project.tracks.V1[to.j - 1]?.gap) { toast('A transition goes between two shots, not next to a gap', 'err'); return render(); }
      setTransition(S.project, S.mediaById, f.index, null); // (gives back the frames it took there)
      const j = S.project.tracks.V1.indexOf(target), h = trHandles(tr);
      if (!setTransition(S.project, S.mediaById, j, tr.type, tr.dur, h.hA || h.hB ? h : null)) toast('Those shots have no frames to spare for a transition', 'err');
      S.sel = new Set([target.id]); commit('Move transition');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return;
  }
  if (transBtn) { e.stopPropagation(); toggleTransition(transBtn.dataset.trans); return; }
  const el = e.target.closest('.clip');
  if (S.tool === 'trackfwd' || S.tool === 'trackback') {
    if (el && S.project.trackState[el.dataset.track]?.lock) { toast(`${el.dataset.track} is locked`); return; }
    trackSelect(e, el);
    // an overlay clip can be dragged at once (all the selected overlay clips go along); a main-story one stays put
    if (!el || e.shiftKey || el.dataset.track === 'V1' || el.classList.contains('t-gap')) return;
  }
  if (!el) { marqueeStart(e); return; }
  const id = el.dataset.id, track = el.dataset.track;
  if (S.tool !== 'blade' && !e.target.closest('[data-trim]') && lastDown.id === id && Date.now() - lastDown.t < 400 && Math.abs(e.clientX - lastDown.x) < 6 && Math.abs(e.clientY - lastDown.y) < 6) {
    lastDown = { id: null, t: 0, x: 0, y: 0 }; lastOpen = Date.now(); emit('openClip', id); return; // double-click: open it (Source monitor / Motion / Fusion / nested sequence)
  }
  lastDown = { id, t: Date.now(), x: e.clientX, y: e.clientY };
  if (S.project.trackState[track]?.lock) { toast(`${track} is locked`); return; }
  // 🔒 a locked clip: it can be selected (and looked at), never moved, trimmed or cut
  if (findClip(id)?.clip.locked) { if (!S.sel.has(id)) select(id, e.shiftKey || e.ctrlKey, e.altKey); toast('This clip is locked - right-click › Unlock clip'); return; }
  if (S.tool === 'blade') { splitClip(id, snap(timeAt(e.clientX), snapPoints(new Set([id])))); commit('Blade'); return; }
  if (S.tool === 'extend') { select(id, false); if (findClip(id)?.clip.type === 'video') morphOrExtend(id, 'extend'); else toast('Generative Extend works on video clips'); return; }
  if (S.tool === 'pen' && !e.target.closest('[data-trim]')) { penKey(id, track, e, el); return; }
  if (S.tool === 'slip' || S.tool === 'slide') { select(id, false); slipSlide(e, id, track); return; }
  if (!S.sel.has(id) || e.shiftKey || e.ctrlKey || e.altKey) select(id, e.shiftKey || e.ctrlKey, e.altKey);
  S.linkLead = id; // (the linked half follows the one you drag / trim)
  const trim = e.target.closest('[data-trim]')?.dataset.trim;
  const f = findClip(id);
  // a main-story (V1) trim keeps every other shot in place, like Premiere: what is cut off becomes a gap and a shot only
  // grows into a gap next to it. Ctrl while trimming: ripple (the story after it closes up / moves along), as before.
  let v1 = null, roll = null;
  // trimming a shot's end at a cut that has a transition: the transition comes off first (its lent frames given back)
  // - a gap or a moved cut cannot keep it between the two shots. (Ctrl+Z brings both back.)
  if (trim && track === 'V1' && S.tool !== 'rolling') {
    const k = trim === 'l' ? f.index : f.index + 1, tc = S.project.tracks.V1[k];
    if (tc?.transitionIn && tc.transitionIn.type !== 'cut') { setTransition(S.project, S.mediaById, k, null); render(); toast('Transition taken off this cut to trim it (Ctrl+Z brings it back)'); }
  }
  // ✂ every other selected clip is trimmed along with this one (same end, same amount) - one of each linked pair, its
  // other half follows it. Not with Rolling / Rate stretch / Remix, which work on one cut / clip.
  const multi = trim && !['rolling', 'rate', 'remix'].includes(S.tool) ? trimMates(id, f.clip, trim) : [];
  if (multi.some((t) => t.track === 'V1')) {
    for (const t of multi.filter((x) => x.track === 'V1')) {
      const V1 = S.project.tracks.V1, i = V1.indexOf(findClip(t.id).clip), tc = V1[trim === 'l' ? i : i + 1];
      if (tc?.transitionIn && tc.transitionIn.type !== 'cut') setTransition(S.project, S.mediaById, V1.indexOf(tc), null);
    }
    render();
  }
  const v1State = (i) => {
    const L0 = layout().V1, V1 = S.project.tracks.V1, nb = V1[i + (trim === 'r' ? 1 : -1)];
    return { s0: L0[i]?.start || 0, ripple: e.ctrlKey || S.tool === 'ripple', gapId: nb?.gap ? nb.id : null, gap0: nb?.gap ? clipDur(nb, S.mediaById) : 0,
      open: trim === 'r' && i === V1.length - 1 }; // (the last shot may grow freely to the right)
  };
  for (const t of multi) { const x = findClip(t.id); t.orig = JSON.parse(JSON.stringify(x.clip)); if (t.track === 'V1') t.v1 = v1State(x.index); }
  if (trim && track === 'V1') {
    const L0 = layout().V1, nb = S.project.tracks.V1[f.index + (trim === 'r' ? 1 : -1)];
    v1 = v1State(f.index);
    // ⇹ Rolling edit: the cut between this shot and the one next to it moves; one gets longer, the other shorter
    if (S.tool === 'rolling' && nb) {
      const A = trim === 'r' ? f.clip : nb, B = trim === 'r' ? nb : f.clip, iB = S.project.tracks.V1.indexOf(B);
      roll = { aId: A.id, bId: B.id, a0: JSON.parse(JSON.stringify(A)), b0: JSON.parse(JSON.stringify(B)), cut0: L0[iB].start };
    }
  }
  drag = { id, track, from: track, made: [], el, x0: e.clientX, y0: e.clientY, moved: false, trim, v1, roll, multi, rate: !!trim && S.tool === 'rate', remix: !!trim && S.tool === 'remix' && f.clip.type === 'audio', orig: JSON.parse(JSON.stringify(f.clip)), index: f.index,
    // where on the clip it was taken (sec from its start) - from the timeline, not the element: select() above has
    // already redrawn the clips, so `el` may be a removed one (its position read as 0 and drops landed seconds off)
    grab: timeAt(e.clientX) - (layout()[track]?.find((x) => x.clip.id === id)?.start ?? f.clip.start ?? 0),
    others: [...S.sel].filter((s) => s !== id && !(f.clip.link && findClip(s)?.clip.link === f.clip.link)).map((s) => ({ id: s, ...findClip(s) })).filter((o) => o.track !== 'V1').map((o) => ({ id: o.id, start: o.clip.start || 0 })) };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp, { once: true });
}

// ⏸ Frame Hold, like Premiere: the frame under the playhead as a full-size still (POST /api/media/still).
// Add Frame Hold: from the playhead on, the clip stays on that frame - same length, nothing moves, its sound plays on.
// Insert Frame Hold Segment: the clip is cut at the playhead and 2 s of that frame go in between (the main story moves
// along by 2 s, as an insert does; on the other tracks the part after it moves 2 s on).
async function frameHold(id, insert) {
  const f = findClip(id), c = f?.clip; if (!c || c.type !== 'video') return;
  const x = layout()[f.track].find((p) => p.clip.id === id), t = S.playhead;
  if (!x || t < x.start + 0.02 || t > x.end - 0.02) return toast('Put the playhead inside this clip first (the frame there is held)', 'err');
  const D = clipDur(c, S.mediaById);
  let src = sourceAt(c, t - x.start, D);
  if (c.reverse) src = (c.in || 0) + (c.out ?? S.mediaById[c.mediaId]?.duration ?? 0) - src;
  toast('Taking the frame…');
  let r;
  try { r = await api('POST', `/api/media/still?p=${enc(S.proj)}`, { mediaId: c.mediaId, t: src }); } catch (e) { return toast(e.message, 'err'); }
  const { refreshMedia } = await import('./mediapool.js'); await refreshMedia();
  const now = findClip(id); if (!now) return;
  const keep = (o) => Object.fromEntries(['transform', 'color', 'effects', 'opacity', 'blend', 'masks', 'cropX', 'cropY', 'fit'].filter((k) => o[k] !== undefined).map((k) => [k, JSON.parse(JSON.stringify(o[k]))]));
  const still = (dur) => ({ id: uid(), type: 'image', mediaId: r.mediaId, dur: +dur.toFixed(3), kenburns: false, hold: true, ...keep(now.clip) });
  const atCut = t > x.start + 0.05 && t < x.end - 0.05;
  if (!insert) {
    // from the playhead to the end of the clip: the still, as long as the part it replaces
    let tail = now.clip;
    if (atCut && splitClip(id, t)) { const L = layout()[f.track]; tail = L[L.findIndex((p) => p.clip.id === id) + 1]?.clip || tail; }
    const len = clipDur(tail, S.mediaById), mate = linkedPartner(S.project, tail)?.clip, list = S.project.tracks[f.track], i = list.indexOf(tail);
    if (mate) delete mate.link; // (its sound plays on under the held frame)
    const h = still(len); if (f.track !== 'V1') h.start = +(layout()[f.track].find((p) => p.clip.id === tail.id)?.start ?? t).toFixed(3);
    list.splice(i, 1, h);
    S.sel = new Set([h.id]); commit('Add Frame Hold');
    toast(`Frame Hold: the clip stays on this frame for ${len.toFixed(2)} s (a still in Media › Frame holds)`);
  } else {
    if (atCut) splitClip(id, t);
    const list = S.project.tracks[f.track], i = list.indexOf(now.clip), h = still(2);
    if (f.track === 'V1') list.splice(atCut ? i + 1 : (t - x.start < 0.05 ? i : i + 1), 0, h);
    else { h.start = +t.toFixed(3); for (const o of list) if (o !== now.clip && (o.start || 0) >= t - 0.001) o.start = +((o.start || 0) + 2).toFixed(3); list.push(h); }
    S.sel = new Set([h.id]); commit('Insert Frame Hold Segment');
    toast('2 s of this frame put in (Media › Frame holds) - drag its end to change the length');
  }
}

// 🪄 Morph Cut (like Premiere): the jump cut before a main-story clip (words taken out of an interview) made smooth -
// the two shots each give up a quarter second at the cut and the frames from one to the other are made from their
// motion (server /api/morph). The story keeps its length; the sound stays exactly as it was (unlinked from them).
// ⏩ Extend: a clip carries on past its end for up to 1 s - its last half second slowed with in-between frames - into
// the empty space after it (a gap), so nothing moves; with no room after it, it says so. (Not generative AI: the
// frames come from the shot's own motion.)
async function morphOrExtend(id, kind) {
  const f = findClip(id), c = f?.clip; if (!c || c.type !== 'video') return;
  if (rampPts(c)) return toast('Take the speed ramp off first', 'err');
  const fps = S.project.settings.fps || 30, V1 = S.project.tracks.V1, L = layout()[f.track], x = L.find((p) => p.clip.id === id);
  const m = S.mediaById[c.mediaId], end = c.out ?? m?.duration ?? 0, sp = c.speed || 1;
  let body, room = 0, A = null, D = 0;
  if (kind === 'morph') {
    A = V1[f.index - 1];
    if (rampPts(A)) return toast('The clip before has a speed ramp - take it off first', 'err');
    D = +Math.min(0.5, clipDur(A, S.mediaById) / 2, clipDur(c, S.mediaById) / 2).toFixed(3);
    const aEnd = (A.out ?? S.mediaById[A.mediaId]?.duration ?? 0) - (D / 2) * (A.speed || 1), bIn = (c.in || 0) + (D / 2) * sp;
    body = { kind, a: { mediaId: A.mediaId, t: aEnd - 1 / fps }, b: { mediaId: c.mediaId, t: bIn }, dur: D, _aEnd: aEnd, _bIn: bIn };
  } else {
    if (f.track === 'V1') { const nx = V1[f.index + 1]; room = !nx ? 1 : nx.gap ? clipDur(nx, S.mediaById) : 0; }
    else { const after = L.filter((p) => p.start >= x.end - 0.001).reduce((t, p) => Math.min(t, p.start), Infinity); room = after - x.end; }
    D = +Math.min(1, room).toFixed(3);
    if (D < 0.1) return toast('No room after this clip - make a gap after it (trim or move the next clip), then Extend', 'err');
    body = { kind, a: { mediaId: c.mediaId, t: end }, dur: D, from: Math.min(0.5, D / 2 + 0.1) };
  }
  emit('job', { running: true, label: kind === 'morph' ? 'Making the morph cut…' : 'Extending…' });
  let r;
  try {
    const job = await api('POST', `/api/morph?p=${enc(S.proj)}`, body);
    const { watchJob } = await import('./api.js'), { refreshMedia } = await import('./mediapool.js');
    r = (await watchJob(job.id)).result; await refreshMedia();
  } catch (e) { emit('job', { running: false }); return toast(e.job ? e.job.log.slice(-1).join(' ') : e.message, 'err'); }
  emit('job', { running: false });
  const now = findClip(id); if (!now) return;
  const piece = { id: uid(), type: 'video', mediaId: r.mediaId, in: 0, out: D, mute: true, ...(kind === 'morph' ? { morph: true } : { extendOf: c.id }) };
  if (kind === 'morph') {
    for (const k of [A, c]) { const mate = linkedPartner(S.project, k)?.clip; if (mate) delete mate.link; } // (the sound stays as it was)
    A.out = +body._aEnd.toFixed(3); c.in = +body._bIn.toFixed(3); delete c.transitionIn;
    V1.splice(V1.indexOf(c), 0, piece);
  } else if (f.track === 'V1') {
    const i = V1.indexOf(c), nx = V1[i + 1];
    V1.splice(i + 1, 0, piece);
    if (nx?.gap) { nx.dur = +(clipDur(nx, S.mediaById) - D).toFixed(3); if (nx.dur < 0.04) V1.splice(V1.indexOf(nx), 1); }
  } else { piece.start = +x.end.toFixed(3); S.project.tracks[f.track].push(piece); }
  S.sel = new Set([piece.id]);
  commit(kind === 'morph' ? 'Morph Cut' : 'Extend');
  toast(kind === 'morph' ? `Morph Cut: ${D.toFixed(2)} s of in-between frames - the cut is smooth, the length is the same` : `Extended by ${D.toFixed(2)} s into the space after it`);
}

// 🎬 Scene Edit Detection (like Premiere): a clip of a finished video is cut wherever its picture cuts - the server
// finds them (FFmpeg scene change, /api/media/scenes); the clip is split there, nothing else moves
async function sceneEdits(id) {
  const f = findClip(id), c = f?.clip; if (!c || c.type !== 'video') return;
  if (rampPts(c)) return toast('Take the speed ramp off first - its cuts would not land on the picture cuts', 'err');
  const m = S.mediaById[c.mediaId], a = c.in || 0, b = c.out ?? m?.duration ?? 0;
  emit('job', { running: true, label: 'Looking for the cuts…' });
  let cuts = [];
  try {
    const job = await api('POST', `/api/media/scenes?p=${enc(S.proj)}`, { mediaId: c.mediaId, in: a, out: b });
    const { watchJob } = await import('./api.js');
    cuts = (await watchJob(job.id, (j) => emit('job', { running: true, label: `Looking for the cuts ${j.progress || 0}%` }))).result.cuts || [];
  } catch (e) { emit('job', { running: false }); return toast(e.job ? e.job.log.slice(-1).join(' ') : e.message, 'err'); }
  emit('job', { running: false });
  const now = findClip(id); if (!now) return;
  const x = layout()[now.track].find((p) => p.clip.id === id), sp = c.speed || 1;
  // last cut first: the clip keeps its id on the part before each cut
  const ts = cuts.map((s) => x.start + (c.reverse ? (b - s) : (s - a)) / sp).filter((t) => t > x.start + 0.1 && t < x.end - 0.1).sort((p, q) => q - p);
  let n = 0;
  for (const t of ts) if (splitClip(id, t)) n++;
  if (n) commit(`Scene Edit Detection: ${n} cut${n > 1 ? 's' : ''}`);
  toast(n ? `Cut at ${n} scene change${n > 1 ? 's' : ''}` : 'No cuts found in this clip - it is one shot');
}

// 🏷 Label colour on the selected timeline clips: their name bar takes the colour (like Premiere's labels)
function clipLabel() {
  const ids = [...S.sel]; if (!ids.length) return;
  import('./mediapool.js').then(({ LABELS }) => {
    const d = modal('Label colour', `<div class="mk-colors">${LABELS.map(([c, n]) => `<button class="mk-c" data-lab="${c}" title="${n}" style="background:${c}"></button>`).join('')}<button class="small" data-lab="">None</button></div>`, { width: 360 });
    d.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lab]'); if (!b) return; d.close();
      for (const id of ids) { const c = findClip(id)?.clip; if (c) { if (b.dataset.lab) c.label = b.dataset.lab; else delete c.label; } }
      commit('Label colour');
    });
  });
}

function handDrag(e) {
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY, l0 = scroller.scrollLeft, t0 = scroller.scrollTop;
  root.classList.add('grabbing');
  const move = (ev) => { scroller.scrollLeft = l0 - (ev.clientX - x0); scroller.scrollTop = t0 - (ev.clientY - y0); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', move); root.classList.remove('grabbing'); }, { once: true });
}
// ↔ Slip: the clip keeps its place and length and shows another part of its file (In and Out move together, as far
// as the file goes). ⇆ Slide (main story): the clip moves between its neighbours - the one before grows into it as much
// as the one after shrinks (or the other way), from their spare frames - so the rest of the story stays where it is.
// On the other tracks Slide moves the clip as far as the clips around it allow.
function slipSlide(e, id, track) {
  const f = findClip(id), c = f?.clip; if (!c || c.gap) return;
  const m = S.mediaById[c.mediaId], media = c.type === 'video' || c.type === 'audio';
  const o = JSON.parse(JSON.stringify(c)), x0 = e.clientX, sp = c.speed || 1, slip = S.tool === 'slip';
  if (slip && (!media || rampPts(c))) return toast(media ? 'A clip with a speed ramp cannot slip - take the ramp off first' : 'Slip works on video and audio clips', 'err');
  const V1 = S.project.tracks.V1, i = V1.indexOf(c), A = track === 'V1' ? V1[i - 1] : null, B = track === 'V1' ? V1[i + 1] : null;
  const a0 = A && JSON.parse(JSON.stringify(A)), b0 = B && JSON.parse(JSON.stringify(B));
  const L = layout()[track], others = L.filter((x) => x.clip.id !== id), me = L.find((x) => x.clip.id === id);
  // how far each way: slip - the frames before In / after Out in the file; slide - what the neighbours can give / take
  const isM = (x) => x.type === 'video' || x.type === 'audio';
  const tail = (x) => (x.gap || !isM(x) ? Infinity : ((S.mediaById[x.mediaId]?.duration ?? x.out ?? 0) - (x.out ?? S.mediaById[x.mediaId]?.duration ?? 0)) / (x.speed || 1));
  const head = (x) => (x.gap || !isM(x) ? Infinity : (x.in || 0) / (x.speed || 1));
  const shrink = (x) => Math.max(0, clipDur(x, S.mediaById) - (x.gap ? 0.04 : 0.2));
  let lo, hi;
  if (slip) { lo = -((o.in || 0) / sp); hi = ((m?.duration ?? o.out ?? 0) - (o.out ?? m?.duration ?? 0)) / sp; }
  else if (track === 'V1') {
    if (!A || !B) return toast('Slide needs a clip on both sides of this one', 'err');
    if (rampPts(A) || rampPts(B)) return toast('A neighbour has a speed ramp - Slide would change it', 'err');
    hi = Math.min(tail(A), shrink(B)); lo = -Math.min(shrink(A), head(B));
  } else {
    const before = others.filter((x) => x.end <= me.start + 0.001).reduce((t, x) => Math.max(t, x.end), 0);
    const after = others.filter((x) => x.start >= me.end - 0.001).reduce((t, x) => Math.min(t, x.start), Infinity);
    lo = before - me.start; hi = after - me.end;
  }
  root.classList.add('grabbing');
  const move = (ev) => {
    const d = Math.min(hi, Math.max(lo, (ev.clientX - x0) / S.zoom));
    if (slip) { c.in = +Math.max(0, (o.in || 0) + d * sp).toFixed(3); if (o.out !== undefined || m?.duration) c.out = +((o.out ?? m.duration) + d * sp).toFixed(3); emit('mix'); }
    else if (track === 'V1') {
      // the shot moves later by d: the one before is longer by d, the one after starts d later in its file (shorter)
      if (A) { if (A.gap) A.dur = +(clipDur(a0, S.mediaById) + d).toFixed(3); else if (A.type === 'video' || A.type === 'audio') A.out = +((a0.out ?? S.mediaById[A.mediaId]?.duration ?? 0) + d * (A.speed || 1)).toFixed(3); else A.dur = +(clipDur(a0, S.mediaById) + d).toFixed(3); }
      if (B) { if (B.gap) B.dur = +(clipDur(b0, S.mediaById) - d).toFixed(3); else if (B.type === 'video' || B.type === 'audio') B.in = +Math.max(0, (b0.in || 0) + d * (B.speed || 1)).toFixed(3); else B.dur = +(clipDur(b0, S.mediaById) - d).toFixed(3); }
    } else c.start = +((o.start || 0) + d).toFixed(3);
    render();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', () => {
    window.removeEventListener('pointermove', move); root.classList.remove('grabbing');
    if (JSON.stringify(c) !== JSON.stringify(o) || (A && JSON.stringify(A) !== JSON.stringify(a0)) || (B && JSON.stringify(B) !== JSON.stringify(b0))) commit(slip ? 'Slip' : 'Slide');
  }, { once: true });
}

// A V1 shot just trimmed (c; o = as it was): the gap next to the trimmed end takes up the difference so nothing else
// moves - a shorter shot leaves a gap, a longer one only uses up a gap that is there (it never covers the next shot).
function v1KeepPlace(c, o, m, stretched = false, v = drag.v1) {
  const V1 = S.project.tracks.V1, sp = c.speed || 1, right = drag.trim === 'r';
  const d0 = clipDur(o, S.mediaById);
  let delta = clipDur(c, S.mediaById) - d0;
  if (!v.open && delta > v.gap0) { // no room to grow: stop at the shot next to it
    delta = v.gap0;
    if (stretched) { const span = (o.out ?? m?.duration ?? 0) - (o.in || 0); c.speed = +(span / Math.max(0.05, d0 + delta)).toFixed(4); }
    else if (c.type === 'video' || c.type === 'audio') { if (right) c.out = +((o.out ?? m?.duration ?? 0) + delta * sp).toFixed(3); else c.in = +Math.max(0, (o.in || 0) - delta * sp).toFixed(3); }
    else c.dur = +(d0 + delta).toFixed(3);
  }
  if (v.open) return; // (the end of the story: nothing after it to keep in place)
  const want = +(v.gap0 - delta).toFixed(3);
  let g = v.gapId ? V1.find((x) => x.id === v.gapId) : null;
  if (want >= 0.01) {
    if (!g) { g = { id: uid(), type: 'title', gap: true, text: '', bg: '#000000', dur: want }; v.gapId = g.id; V1.splice(V1.indexOf(c) + (right ? 1 : 0), 0, g); }
    g.dur = want;
  } else if (g) { V1.splice(V1.indexOf(g), 1); v.gapId = null; }
}

// ♫ Remix: a music clip dragged to a new length is re-cut to fit it - the best stretch of the song that long (the
// server finds it on the beats, /api/music/best), faded out at the end
async function remixTo(id) {
  const c = findClip(id)?.clip; if (!c) return;
  const len = +clipDur(c, S.mediaById).toFixed(2);
  try {
    toast(`♫ Remixing to ${fmt(len)}…`);
    const best = await api('GET', `/api/music/best?p=${enc(S.proj)}&id=${c.mediaId}&dur=${len}`);
    const now = findClip(id)?.clip; if (!now) return;
    Object.assign(now, { in: best.in, out: best.out, fadeOut: Math.max(now.fadeOut || 0, 1.5) });
    if (now.loop) now.dur = len;
    commit('Remix'); toast(`♫ Remixed to ${fmt(clipDur(now, S.mediaById))} from the best part of the music`);
  } catch (err) { commit('Trim'); toast(`Remix: ${err.message}`, 'err'); }
}
// ⇹ Rolling edit: the cut moves by dt; the shot before gets longer / shorter by as much as the shot after gets shorter /
// longer (each only as far as its file allows), so nothing else on the timeline moves
function rollCut(dt, pts) {
  const r = drag.roll, V1 = S.project.tracks.V1, A = V1.find((x) => x.id === r.aId), B = V1.find((x) => x.id === r.bId);
  if (!A || !B) return;
  const media = S.mediaById, dA = clipDur(r.a0, media), dB = clipDur(r.b0, media);
  const vid = (c) => c.type === 'video' || (c.type === 'audio' && !c.loop);
  const growA = vid(A) ? ((media[A.mediaId]?.duration ?? r.a0.out ?? 0) - (r.a0.out ?? media[A.mediaId]?.duration ?? 0)) / (A.speed || 1) : 1e9;
  const growB = vid(B) ? (r.b0.in || 0) / (B.speed || 1) : 1e9;
  const d = Math.max(-Math.min(dA - 0.1, growB), Math.min(snap(r.cut0 + dt, pts) - r.cut0, growA, dB - 0.1));
  if (vid(A)) A.out = +((r.a0.out ?? media[A.mediaId]?.duration ?? 0) + d * (A.speed || 1)).toFixed(3); else A.dur = +(dA + d).toFixed(3);
  if (vid(B)) B.in = +Math.max(0, (r.b0.in || 0) + d * (B.speed || 1)).toFixed(3); else B.dur = +(dB - d).toFixed(3);
  for (const c of [A, B]) if (c.link) syncLinked(S.project, media, c.id);
}
// ⟷ Rate stretch: the end moves, the shot keeps the same frames and its speed changes to fill the new length
function rateStretch(c, o, m, dt, pts) {
  const d0 = clipDur(o, S.mediaById), right = drag.trim === 'r', L = layout()[drag.track].find((x) => x.clip.id === c.id);
  const s0 = drag.v1 ? drag.v1.s0 : o.start || 0;
  const edge = snap(right ? s0 + d0 + dt : s0 + dt, pts), nd = Math.max(0.1, right ? edge - s0 : s0 + d0 - edge);
  if (c.type === 'video' || c.type === 'audio') {
    const span = (o.out ?? m?.duration ?? 0) - (o.in || 0), sp = Math.max(0.05, Math.min(16, span / nd));
    if (Math.abs(sp - 1) < 0.005) delete c.speed; else c.speed = +sp.toFixed(4);
  } else c.dur = +nd.toFixed(3);
  if (!right && drag.track !== 'V1') c.start = +Math.max(0, (o.start || 0) + (d0 - clipDur(c, S.mediaById))).toFixed(3);
  toast(`⟷ ${fmt(clipDur(c, S.mediaById))} · speed ${Math.round((c.speed || 1) * 100)}%`);
  return L;
}
// ✒ Pen: a keyframe on the clip's opacity (picture) / volume (sound) line where it was clicked - the higher on the clip,
// the more (top = 100% opacity / 200% volume, bottom = 0)
function penKey(id, track, e, el) {
  const f = findClip(id), c = f?.clip, x = layout()[track]?.find((p) => p.clip.id === id); if (!c || !x) return;
  const prop = KIND[track] === 'audio' ? 'volume' : 'opacity', top = KIND[track] === 'audio' ? 2 : 1;
  const r = el.getBoundingClientRect(), y = clamp((e.clientY - (r.top + 15)) / Math.max(1, r.height - 15), 0, 1);
  const t = +clamp(timeAt(e.clientX) - x.start, 0, x.end - x.start).toFixed(3), v = +((1 - y) * top).toFixed(3);
  const keys = ((c.keys ||= {})[prop] ||= []);
  const i = keys.findIndex((k) => Math.abs(k.t - t) < 0.05);
  if (i >= 0) keys[i].v = v; else { keys.push({ t, v }); keys.sort((a, b) => a.t - b.t); }
  S.sel = new Set([id]); commit(`Pen: ${prop} keyframe`);
  toast(`${prop === 'volume' ? 'Volume' : 'Opacity'} ${Math.round(v * 100)}% at ${fmt(t)}`);
}
// the opacity / volume line drawn on a clip (with the Pen, or once it has keyframes), like Premiere's rubber band
function bandHTML(c, track, D) {
  const prop = KIND[track] === 'audio' ? 'volume' : 'opacity', top = KIND[track] === 'audio' ? 2 : 1, keys = c.keys?.[prop] || [];
  if (S.tool !== 'pen' && !keys.length) return '';
  const y = (v) => (1 - Math.min(top, Math.max(0, v)) / top) * 100;
  const pts = Array.from({ length: 33 }, (_, k) => { const t = (D * k) / 32; return `${((k / 32) * 100).toFixed(2)},${y(propAt(c, prop, t)).toFixed(2)}`; }).join(' ');
  return `<svg class="band" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${pts}" vector-effect="non-scaling-stroke"/></svg>${keys.map((k) => `<i class="band-k" style="left:${((k.t / Math.max(0.01, D)) * 100).toFixed(2)}%;top:calc(15px + (100% - 15px) * ${(y(k.v) / 100).toFixed(3)})"></i>`).join('')}`;
}

// the other selected clips a trim takes along: one of each linked pair (not the dragged clip's own other half - that one
// follows it anyway), no gaps, nothing on a locked track
function trimMates(id, lead, side) {
  const seen = new Set(lead.link ? [lead.link] : []), out = [];
  for (const s of S.sel) {
    if (s === id) continue;
    const x = findClip(s); if (!x || x.clip.gap || S.project.trackState[x.track]?.lock) continue;
    if (x.clip.link) { if (seen.has(x.clip.link)) continue; seen.add(x.clip.link); }
    out.push({ id: s, track: x.track, side });
  }
  return out;
}
// one of those clips: its end moves by `by` seconds on the timeline (as far as its own file allows)
function trimMate(t, by, e) {
  const x = findClip(t.id); if (!x) return;
  const c = x.clip, o = t.orig, m = S.mediaById[c.mediaId], sp = c.speed || 1, src = c.type === 'video' || (c.type === 'audio' && !c.loop);
  if (t.side === 'l') {
    let d = by;
    if (src) { const ni = clamp((o.in || 0) + d * sp, 0, (o.out ?? m?.duration ?? 0) - 0.1 * sp); d = (ni - (o.in || 0)) / sp; c.in = +ni.toFixed(3); }
    else { const nd = Math.max(0.2, clipDur(o, S.mediaById) - d); d = clipDur(o, S.mediaById) - nd; c.dur = +nd.toFixed(3); }
    if (t.track !== 'V1') c.start = +Math.max(0, (o.start || 0) + d).toFixed(3);
  } else {
    const nd = Math.max(0.2, clipDur(o, S.mediaById) + by);
    if (src) c.out = +clamp((o.in || 0) + nd * sp, (o.in || 0) + 0.1 * sp, m?.duration ?? Infinity).toFixed(3); else c.dur = +nd.toFixed(3);
  }
  if (t.v1 && !t.v1.ripple && !e.ctrlKey) v1KeepPlace(c, o, m, false, t.v1);
  if (c.link) syncLinked(S.project, S.mediaById, t.id);
}

function onDragMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.x0;
  if (!drag.moved && Math.abs(dx) < 5 && Math.abs(e.clientY - drag.y0) < 5) return; // (a click's small wobble is not a drag)
  drag.moved = true;
  const f = findClip(drag.id); if (!f) return;
  const c = f.clip, o = drag.orig, m = S.mediaById[c.mediaId], sp = c.speed || 1;
  const dt = dx / S.zoom, pts = snapPoints(new Set([drag.id]));
  if (drag.roll) { rollCut(dt, pts); render(); return; }
  if (drag.rate) { rateStretch(c, o, m, dt, pts); if (drag.v1 && !drag.v1.ripple) v1KeepPlace(c, o, m, true); if (c.link) syncLinked(S.project, S.mediaById, drag.id); render(); return; }
  if (drag.trim) {
    const L = layout()[f.track].find((x) => x.clip.id === c.id), s0 = drag.v1 ? drag.v1.s0 : L.start;
    if (drag.trim === 'l') {
      const tEdge = snap((drag.track === 'V1' ? s0 : o.start || 0) + dt, pts);
      let d = tEdge - (drag.track === 'V1' ? s0 : o.start || 0);
      if (c.type === 'video' || (c.type === 'audio' && !c.loop)) {
        const ni = clamp((o.in || 0) + d * sp, 0, (o.out ?? m?.duration ?? 0) - 0.1 * sp);
        d = (ni - (o.in || 0)) / sp; c.in = +ni.toFixed(3);
      } else { const nd = Math.max(0.2, clipDur(o, S.mediaById) - d); d = clipDur(o, S.mediaById) - nd; c.dur = +nd.toFixed(3); }
      if (drag.track !== 'V1') c.start = +Math.max(0, (o.start || 0) + d).toFixed(3);
      if (o.markers) { c.markers = o.markers.map((m) => ({ ...m, t: +(m.t - d).toFixed(3) })).filter((m) => m.t >= 0); if (!c.markers.length) delete c.markers; } // (📍 they stay on their frames)
    } else {
      const startT = drag.track === 'V1' ? s0 : o.start || 0;
      const endT = snap(startT + clipDur(o, S.mediaById) + dt, pts);
      const nd = Math.max(0.2, endT - startT);
      if (c.type === 'video' || (c.type === 'audio' && !c.loop)) {
        const max = m?.duration ?? Infinity;
        c.out = +clamp((o.in || 0) + nd * sp, (o.in || 0) + 0.1 * sp, max).toFixed(3);
      } else c.dur = +nd.toFixed(3);
    }
    if (drag.v1 && !drag.v1.ripple && !e.ctrlKey) v1KeepPlace(c, o, m);
    if (c.link) syncLinked(S.project, S.mediaById, drag.id);
    if (drag.multi.length) {
      // how far this clip's edge really moved (after its own limits) - the others move theirs as far
      const by = drag.trim === 'l' ? clipDur(o, S.mediaById) - clipDur(c, S.mediaById) : clipDur(c, S.mediaById) - clipDur(o, S.mediaById);
      for (const t of drag.multi) trimMate(t, by, e);
    }
    render();
    return;
  }
  // move - onto another track only once the mouse has clearly gone up / down (a clip taken near its top edge used to
  // jump onto the track above at the first wobble and show there as a faded copy)
  let overTrack = Math.abs(e.clientY - drag.y0) < 12 ? f.track : rowAt(e.clientY);
  if (!overTrack && Math.abs(e.clientY - drag.y0) >= 12) overTrack = edgeTrack(e.clientY, KIND[drag.track]);
  const overOverlay = overTrack && trackKind(overTrack) === 'video' && overTrack !== 'V1';
  // the clip as drawn now: the timeline may have been redrawn since the press (select, moves on overlay tracks), and
  // moving the old, removed element made the clip freeze and then jump
  const live = root.querySelector(`.clip[data-id="${drag.id}"]`) || drag.el;
  if (drag.track === 'V1' && !overOverlay) {
    // along V1: like Premiere it goes exactly where it is let go (Ctrl: inserted at the nearest cut)
    v1Target(e, pts, live, layout().V1.find((x) => x.clip.id === drag.id)?.start || 0, 0);
    return;
  }
  $('#tlInsert').hidden = true;
  const kind = KIND[drag.track];
  const target = overTrack && KIND[overTrack] === kind ? overTrack : drag.track;
  if (drag.track === 'V1') {
    // dragged up from V1 onto an overlay track: becomes a free overlay clip there
    drag.toTrack = overTrack;
    drag.newStart = snap(Math.max(0, timeAt(e.clientX) - drag.grab), pts); // (it used to stay where it was taken from)
    const from = layout().V1.find((x) => x.clip.id === drag.id)?.start || 0;
    live.style.transform = `translate(${(drag.newStart - from) * S.zoom}px, ${rowTop(overTrack) - rowTop('V1')}px)`; live.classList.add('dragging');
    return;
  }
  if (target === 'V1') {
    // an overlay clip coming down onto V1: it goes exactly where it is let go (Ctrl: inserted at the nearest cut)
    v1Target(e, pts, live, c.start || 0, rowTop('V1') - rowTop(f.track));
    return;
  }
  // back on an overlay track: it stays there (it used to still drop on V1 if it had passed over V1 on the way)
  drag.toTrack = undefined; drag.insertAt = undefined; drag.dropT = undefined;
  live.style.transform = ''; live.classList.remove('dragging');
  const ns = snap(Math.max(0, (o.start || 0) + dt), pts);
  const delta = ns - (o.start || 0);
  c.start = +ns.toFixed(3);
  for (const ot of drag.others) { const x = findClip(ot.id); if (x && x.track !== 'V1') x.clip.start = +Math.max(0, ot.start + delta).toFixed(3); }
  if (c.link) syncLinked(S.project, S.mediaById, drag.id);
  if (target !== f.track && !drag.others.length) {
    S.project.tracks[f.track].splice(f.index, 1);
    S.project.tracks[target].push(c);
    drag.track = target;
  } else if (target !== f.track) groupToTrack(f, target);
  render();
}
// ⇅ several clips selected (video and audio): the whole selection goes as many tracks as the one being dragged, each
// on its own side - V2 -> V3 with A2 -> A3, out from the middle like a linked clip - with the linked sound of each
// picture; new tracks at the edges. When one of them has no room there (or would land on V1 / above A1) none moves.
function groupToTrack(f, target) {
  const d = trackNum(target) - trackNum(f.track), ids = new Set([drag.id, ...drag.others.map((o) => o.id)]);
  for (const id of [...ids]) { const c = findClip(id)?.clip, lp = c?.type === 'video' ? linkedPartner(S.project, c) : null; if (lp && KIND[lp.track] === 'audio') ids.add(lp.clip.id); }
  const items = [...ids].map((id) => findClip(id)).filter(Boolean);
  if (items.some((x) => x.track === 'V1')) return;
  const moving = new Set(items.map((x) => x.clip)), ts = S.project.trackState || {};
  const last = (k) => Math.max(...trackList(S.project).filter((t) => t.id[0] === k).map((t) => trackNum(t.id)));
  const plan = items.map((x) => ({ x, to: `${x.track[0]}${Math.min(last(x.track[0]) + 1, trackNum(x.track) + d)}` })); // (no skipped numbers)
  const free = (to, c) => { const a = c.start || 0, b = a + clipDur(c, S.mediaById); return !(S.project.tracks[to] || []).some((o) => !moving.has(o) && (o.start || 0) < b - 1e-3 && (o.start || 0) + clipDur(o, S.mediaById) > a + 1e-3); };
  if (plan.some(({ x, to }) => trackNum(to) < 1 || to === 'V1' || ts[to]?.lock || !free(to, x.clip))) return;
  for (const { x } of plan) { const l = S.project.tracks[x.track]; l.splice(l.indexOf(x.clip), 1); }
  for (const { x, to } of plan) {
    if (!S.project.tracks[to] && !trackList(S.project).some((t) => t.id === to)) drag.made.push(to);
    ensureTrack(S.project, to); S.project.tracks[to].push(x.clip);
  }
  drag.track = target;
}

// ➕ dragged above the top video track / below the last audio track: a new track there (like Premiere). Made at once so
// the clip shows on it; one that is still empty when the clip is let go is taken away again (onDragUp).
function edgeTrack(y, kind) {
  const rows = $$('.tl-row', rowsEl); if (!rows.length) return null;
  const list = trackList(S.project), up = kind === 'video';
  if (up ? y >= rows[0].getBoundingClientRect().top : y < rows[rows.length - 1].getBoundingClientRect().bottom) return null;
  const end = up ? list.find((t) => t.kind === 'video') : [...list].reverse().find((t) => t.kind === 'audio');
  if (end && drag.made.includes(end.id)) return end.id; // (the one this drag made already)
  const id = `${up ? 'V' : 'A'}${trackNum(end?.id || (up ? 'V1' : 'A1')) + 1}`;
  ensureTrack(S.project, id); drag.made.push(id);
  render();
  return id;
}
// 🔗 a linked picture moved to another video track: its sound goes as many tracks the same way (V2 -> V3 with A2 -> A3),
// onto a new audio track when there is none - if that track is free at its time
function soundFollows(c, from, to) {
  const lp = c?.type === 'video' ? linkedPartner(S.project, c) : null;
  if (!lp || KIND[lp.track] !== 'audio' || to === from) return;
  const lastA = Math.max(...trackList(S.project).filter((t) => t.kind === 'audio').map((t) => trackNum(t.id)));
  const n = Math.min(lastA + 1, trackNum(lp.track) + trackNum(to) - trackNum(from)); if (n < 1 || n === trackNum(lp.track)) return; // (no skipped numbers)
  const id = `A${n}`, a = lp.clip.start || 0, b = a + clipDur(lp.clip, S.mediaById);
  if (S.project.trackState?.[id]?.lock || (S.project.tracks[id] || []).some((o) => o !== lp.clip && (o.start || 0) < b - 1e-3 && (o.start || 0) + clipDur(o, S.mediaById) > a + 1e-3)) return;
  ensureTrack(S.project, id);
  const l = S.project.tracks[lp.track]; l.splice(l.indexOf(lp.clip), 1);
  S.project.tracks[id].push(lp.clip);
}
// Where a clip dragged over V1 would go, shown while dragging. Like Premiere: it overwrites what is under it at that
// time and nothing else on the timeline moves. With Ctrl held it is inserted at the nearest cut instead (the story
// after it moves along). from: where the clip is drawn now (sec); yOff: px down to V1.
function v1Target(e, pts, live, from, yOff) {
  const L = layout().V1, ins = $('#tlInsert');
  drag.toTrack = 'V1'; drag.dropT = snap(Math.max(0, timeAt(e.clientX) - drag.grab), pts); drag.insertAt = undefined;
  let at = drag.dropT;
  if (e.ctrlKey) {
    const t = timeAt(e.clientX);
    let idx = L.findIndex((x) => t < (x.start + x.end) / 2);
    if (idx < 0) idx = L.length;
    drag.insertAt = idx;
    at = idx < L.length ? L[idx].start : L.at(-1)?.end || 0;
    ins.hidden = false; ins.style.left = `${at * S.zoom}px`;
    ins.style.top = `${rowTop('V1')}px`; ins.style.height = `${rowH('V1')}px`;
  } else ins.hidden = true;
  live.style.transform = `translate(${(at - from) * S.zoom}px, ${yOff}px)`; live.classList.add('dragging');
}
// an empty stretch of the main story (black, silent) - what a clip leaves behind when it is lifted out of V1
export const gapClip = (len) => ({ id: uid(), type: 'title', gap: true, text: '', bg: '#000000', dur: +Math.max(0.04, len).toFixed(3) });
// Premiere's overwrite on V1: clip c goes in at time t0 and replaces whatever is there for its length (cut where it
// starts and ends); everything before and after stays exactly where it was. Past the end: a gap, then the clip.
export function overwriteV1(c, t0) {
  const V1 = S.project.tracks.V1, len = clipDur(c, S.mediaById), t1 = t0 + len;
  delete c.start; delete c.transitionIn;
  const end = layout().V1.at(-1)?.end || 0;
  if (t0 >= end - 0.02) { if (t0 - end >= 0.04) V1.push(gapClip(t0 - end)); V1.push(c); return; }
  for (const t of [t0, t1]) { const x = layout().V1.find((p) => t > p.start + 0.05 && t < p.end - 0.05); if (x) splitClip(x.clip.id, t); }
  const L = layout().V1;
  const under = new Set(L.filter((p) => p.start >= t0 - 0.05 && p.end <= t1 + 0.05).map((p) => p.clip));
  const first = L.find((p) => p.start >= t0 - 0.05)?.clip;
  let at = first ? V1.indexOf(first) : V1.length;
  for (let i = V1.length - 1; i >= 0; i--) if (under.has(V1[i])) { V1.splice(i, 1); if (i < at) at--; }
  V1.splice(at, 0, c);
  if (V1[at + 1]) delete V1[at + 1].transitionIn;
  tidyGaps();
}

function onDragUp(e) {
  window.removeEventListener('pointermove', onDragMove);
  // where the mouse is let go decides the drop (a fast drag can end before the last move was handled)
  if (drag?.moved && e) onDragMove(e);
  snapEl.hidden = true; $('#tlInsert').hidden = true;
  const d = drag; drag = null;
  // (tracks this drag made at the edge that ended up empty go again)
  const dropMade = () => { for (const id of d?.made || []) if (!S.project.tracks[id]?.length) { delete S.project.tracks[id]; delete S.project.trackState?.[id]; } };
  if (!d || !d.moved) { dropMade(); S.linkLead = null; if (d?.made.length) render(); return; }
  dropMade();
  // 🎬 let go over the Source / Program monitor: the clip opens in the Source monitor at its In, and stays where it was
  const overMon = e && !d.trim && !d.roll && !d.rate && !d.multi?.length && document.elementFromPoint(e.clientX, e.clientY)?.closest('.srcmon, .mon-dock, .edit-grid.ws-monsrc .viewer');
  if (overMon) {
    const f0 = findClip(d.id);
    if (f0) { for (const k of Object.keys(f0.clip)) delete f0.clip[k]; Object.assign(f0.clip, d.orig); }
    try { syncLinked(S.project, S.mediaById); } catch {} // (its linked sound goes back with it)
    S.linkLead = null; render();
    const m = S.mediaById[d.orig.mediaId];
    if (m) emit('openSource', { id: m.id, t: +(d.orig.in || 0) }); else toast('Only a clip with a file (video, photo, sound) opens in the Source monitor');
    return;
  }
  const f = findClip(d.id);
  const lp = f && !d.trim && f.clip.type === 'audio' ? linkedPartner(S.project, f.clip) : null;
  if (lp?.track === 'V1') toast('This sound is linked to its picture on V1 - move the picture, or right-click › Unlink to move the sound alone');
  if (!f) return render();
  if (d.trim && d.remix) { remixTo(d.id); return; }
  // ⇋ a ripple trim of a main-story shot: the sync-locked tracks move along by as much as the story after it did
  if (d.trim && !d.roll && d.track === 'V1' && f.track === 'V1' && (d.v1?.ripple || e?.ctrlKey)) {
    const end0 = (d.v1?.s0 || 0) + clipDur(d.orig, S.mediaById);
    syncShift(S.project, end0, clipDur(f.clip, S.mediaById) - clipDur(d.orig, S.mediaById));
  }
  if (d.trim || d.roll || d.rate) { commit(d.roll ? 'Rolling edit' : d.rate ? 'Rate stretch' : 'Trim'); return; }
  // the length a V1 clip takes on the timeline (what it leaves as a gap when it is lifted out)
  const v1Len = (id) => { const x = layout().V1.find((p) => p.clip.id === id); return x ? x.end - x.start - (x.overlap || 0) : 0; };
  if (d.toTrack === 'V1' && f.track === 'V1') {
    if (d.insertAt !== undefined) { // Ctrl: inserted at a cut, the story after it moves along
      const [c] = S.project.tracks.V1.splice(f.index, 1);
      const to = d.insertAt > f.index ? d.insertAt - 1 : d.insertAt;
      S.project.tracks.V1.splice(to, 0, c);
      if (to === 0) delete c.transitionIn;
    } else if (d.dropT !== undefined) {
      // lifted out (a gap stays where it was) and laid over the spot it was let go: nothing else moves
      const x = layout().V1.find((p) => p.clip.id === d.id);
      if (x && Math.abs(d.dropT - x.start) < 0.01) return render();
      // (the other selected clips - overlays, sound - go along by as much)
      if (x) for (const o of d.others) { const y = findClip(o.id); if (y && y.track !== 'V1') y.clip.start = +Math.max(0, o.start + d.dropT - x.start).toFixed(3); }
      const [c] = S.project.tracks.V1.splice(f.index, 1, gapClip(v1Len(d.id)));
      overwriteV1(c, d.dropT);
    }
    commit('Move clip'); return;
  }
  if (d.toTrack && d.toTrack !== 'V1' && f.track === 'V1') {
    // up from V1 onto an overlay track: a gap stays in its place, so the rest of the story does not move
    const [c] = S.project.tracks.V1.splice(f.index, 1, gapClip(v1Len(d.id)));
    tidyGaps();
    delete c.transitionIn; c.start = +d.newStart.toFixed(3);
    ensureTrack(S.project, d.toTrack); S.project.tracks[d.toTrack].push(c);
    soundFollows(c, 'V1', d.toTrack);
    commit(`Move to ${d.toTrack}`); return;
  }
  if (d.toTrack === 'V1' && f.track !== 'V1') {
    const [c] = S.project.tracks[f.track].splice(f.index, 1);
    delete c.start;
    if (c.type === 'audio' || c.type === 'adjust') { toast(c.type === 'audio' ? 'Audio clips go on the A tracks' : 'Adjustment layers go on V2 or higher'); S.project.tracks[f.track].push(c); return render(); }
    if (d.insertAt !== undefined) S.project.tracks.V1.splice(d.insertAt, 0, c); // Ctrl: inserted, the story moves along
    else overwriteV1(c, d.dropT ?? 0); // exactly where it was let go; nothing else moves
    commit('Move to V1'); return;
  }
  if (f.track !== d.from && KIND[f.track] === 'video' && !d.others.length) soundFollows(f.clip, d.from, f.track); // (a group took its sound along already)
  commit('Move clip');
}

// ---------------- edits ----------------
export function splitClip(id, t) {
  const f = findClip(id); if (!f) return false;
  const x = layout()[f.track].find((p) => p.clip.id === id);
  if (!x || t <= x.start + 0.05 || t >= x.end - 0.05) return false;
  const c = f.clip, b = JSON.parse(JSON.stringify(c));
  b.id = uid(); delete b.transitionIn; delete b.fadeIn; delete c.fadeOut;
  const off = t - x.start, sp = c.speed || 1;
  if (c.type === 'video' && rampPts(c)) {
    // a ramped shot: each half keeps its own part of the speed curve, so nothing moves
    const D = clipDur(c, S.mediaById), u = off / D;
    Object.assign(b, rampPart(c, u, 1, D)); Object.assign(c, rampPart(c, 0, u, D));
  } else if (c.type === 'video' || (c.type === 'audio' && !c.loop)) {
    const cut = (c.in || 0) + off * sp;
    b.in = +cut.toFixed(3); c.out = +cut.toFixed(3);
  } else { b.dur = +(clipDur(c, S.mediaById) - off).toFixed(3); c.dur = +off.toFixed(3); }
  if (f.track !== 'V1') b.start = +t.toFixed(3);
  if (c.markers?.length) { // (📍 each half keeps the clip markers on its own frames)
    b.markers = c.markers.filter((m) => m.t >= off).map((m) => ({ ...m, t: +(m.t - off).toFixed(3) })); c.markers = c.markers.filter((m) => m.t < off);
    if (!b.markers.length) delete b.markers; if (!c.markers.length) delete c.markers;
  }
  if (c.textDuration && off < c.textDuration) b.textDuration = undefined;
  S.project.tracks[f.track].splice(f.index + 1, 0, b);
  return true;
}
export function splitAtPlayhead() {
  const t = S.playhead, L = layout(), ts = S.project.trackState;
  const targets = S.sel.size ? [...S.sel] : Object.entries(L).filter(([tr]) => !ts[tr]?.lock).flatMap(([, list]) => list.filter((x) => t > x.start && t < x.end).map((x) => x.clip.id));
  let n = 0;
  for (const id of targets) if (!findClip(id)?.clip.locked && splitClip(id, t)) n++; // (🔒 a locked clip is not cut)
  if (n) commit('Split'); else toast('Put the playhead over a clip to split it');
}
// Premiere-style ripple trim (Q / W): cut the front or the back of the clip(s) under the playhead at the playhead.
// Main story (V1) closes the gap by itself; on other tracks a front trim makes the clip start at the playhead.
export function trimAtPlayhead(side) {
  const t = S.playhead, L = layout(), ts = S.project.trackState;
  const under = Object.entries(L).filter(([tr]) => !ts[tr]?.lock).flatMap(([tr, list]) => {
    const hit = list.filter((x) => t > x.start + 0.04 && t < x.end - 0.04 && !x.clip.locked); // (🔒 a locked clip is not trimmed)
    return (tr === 'V1' ? hit.slice(-1) : hit).map((x) => ({ tr, x })); // in a dissolve, V1's visible clip is the incoming one
  });
  // selected clips under the playhead; nothing selected = the main story's clip (music / VO stay as they are)
  const sel = under.filter((u) => S.sel.has(u.x.clip.id));
  const targets = sel.length ? sel : under.filter((u) => u.tr === 'V1').length ? under.filter((u) => u.tr === 'V1') : under.filter((u) => u.tr !== 'V1' && trackKind(u.tr) === 'video');
  if (!targets.length) return toast('Put the playhead over a clip, then Q cuts its front and W cuts its back');
  let v1Start = null;
  for (const { tr, x } of targets) {
    const c = x.clip, off = t - x.start, sp = c.speed || 1, media = c.type === 'video' || (c.type === 'audio' && !c.loop);
    if (tr === 'V1') { if (side === 'start') syncShift(S.project, t, -off); else syncShift(S.project, x.end, -(x.end - t)); } // (⇋ Sync Lock)
    if (c.type === 'video' && rampPts(c)) {
      // a ramped shot: what stays keeps its own part of the speed curve (it plays as before, only shorter)
      const D = clipDur(c, S.mediaById), u = off / D;
      Object.assign(c, side === 'start' ? rampPart(c, u, 1, D) : rampPart(c, 0, u, D));
      if (side === 'start') {
        if (c.keys) for (const k of Object.values(c.keys)) for (const key of k) key.t = +(key.t - off).toFixed(3);
        if (tr !== 'V1') c.start = +t.toFixed(3); else v1Start = v1Start ?? x.start;
      }
      continue;
    }
    if (side === 'start') {
      if (media) c.in = +((c.in || 0) + off * sp).toFixed(3); else c.dur = +(clipDur(c, S.mediaById) - off).toFixed(3);
      if (c.keys) for (const k of Object.values(c.keys)) for (const key of k) key.t = +(key.t - off).toFixed(3);
      if (tr !== 'V1') c.start = +t.toFixed(3); else v1Start = v1Start ?? x.start;
      if (c.markers) { c.markers = c.markers.map((m) => ({ ...m, t: +(m.t - off).toFixed(3) })).filter((m) => m.t >= 0); if (!c.markers.length) delete c.markers; }
    } else {
      if (media) c.out = +((c.in || 0) + off * sp).toFixed(3); else c.dur = +off.toFixed(3);
    }
  }
  commit(side === 'start' ? 'Trim front' : 'Trim back');
  if (v1Start !== null) emit('seek', v1Start); // the rest of the story moved up to where the cut was
}
// 📌 Delete = "Lift": a main-story (V1) clip leaves a gap of its length (black, silent), so every clip after it stays
// exactly where it was put. Shift+Delete = "Ripple delete": the next one moves up into its place. A selected gap:
// Delete closes it.
export function deleteSelected(ripple = false) {
  if (!S.sel.size) return toast('Select a clip first');
  // many clips at once (box select / Ctrl+A): ask first, and keep a backup copy of the project before deleting
  if (S.sel.size >= 8) {
    const all = Object.values(S.project.tracks).flat().length;
    if (!confirm(`Delete ${S.sel.size} clips${S.sel.size >= all ? ' - that is the WHOLE timeline' : ''}?

Ctrl+Z brings them back. A backup of the project is saved first.`)) return;
    saveNow('force');
  }
  let n = 0;
  const L1 = layout().V1, closed = []; // [where, seconds] the main story closed up (⇋ Sync Lock follows it)
  for (const id of [...S.sel]) {
    const f = findClip(id);
    if (!f || S.project.trackState[f.track]?.lock || f.clip.locked) continue; // (🔒 locked track / clip)
    const x = f.track === 'V1' ? L1.find((p) => p.clip.id === id) : null, len = x ? x.end - x.start - (x.overlap || 0) : clipDur(f.clip, S.mediaById);
    if (f.track === 'V1' && !ripple && !f.clip.gap) {
      // the gap ends exactly where the clip ended, so every later clip keeps its place
      S.project.tracks.V1.splice(f.index, 1, { id: uid(), type: 'title', gap: true, text: '', bg: '#000000', dur: +Math.max(0.04, len).toFixed(3) });
    } else {
      S.project.tracks[f.track].splice(f.index, 1);
      if (x) closed.push([x.end, len]);
    }
    n++;
    if (f.track === 'V1' && f.index === 0 && S.project.tracks.V1[0]) delete S.project.tracks.V1[0].transitionIn;
  }
  for (const [at, len] of closed.sort((a, b) => b[0] - a[0])) syncShift(S.project, at, -len); // (latest first: each moves only what is after it)
  tidyGaps();
  S.sel.clear();
  if (n) commit(ripple ? `Ripple delete ${n} clip${n > 1 ? 's' : ''}` : `Delete ${n} clip${n > 1 ? 's' : ''}`);
}
// gaps next to each other become one; a gap at the very end of the story goes (it would only add black)
export function tidyGaps() {
  const v = S.project.tracks.V1;
  for (let i = v.length - 1; i > 0; i--) if (v[i].gap && v[i - 1].gap) { v[i - 1].dur = +(v[i - 1].dur + v[i].dur).toFixed(3); v.splice(i, 1); }
  while (v.length && v[v.length - 1].gap) v.pop();
}
export function duplicateSelected() {
  if (!S.sel.size) return toast('Select a clip first');
  const L = layout(), newSel = [];
  for (const id of [...S.sel]) {
    const f = findClip(id); if (!f) continue;
    const c = JSON.parse(JSON.stringify(f.clip)); c.id = uid();
    if (f.track === 'V1') S.project.tracks.V1.splice(f.index + 1, 0, c);
    else { const x = L[f.track].find((p) => p.clip.id === id); c.start = +x.end.toFixed(3); S.project.tracks[f.track].push(c); }
    newSel.push(c.id);
  }
  S.sel = new Set(newSel);
  commit('Duplicate');
}
export function addTitle(text = 'Your title') {
  const c = { id: uid(), type: 'title', text, dur: 3, start: +S.playhead.toFixed(3), textStyle: 'center', textColor: '#ffffff' };
  S.project.tracks.V2.push(c);
  S.sel = new Set([c.id]);
  commit('Add title');
}
function toggleTransition(id) {
  const f = findClip(id); if (!f) return;
  if ((!f.clip.transitionIn || f.clip.transitionIn.type === 'cut') && !setTransition(S.project, S.mediaById, f.index, 'fade', 0.5)) return toast('These shots have no frames to spare beyond their ends for a transition', 'err');
  S.sel = new Set([id]);
  commit('Transition');
  emit('inspect', 'transition');
}

// Media dropped from the pool (or added via buttons). Returns the new clip.
// A video with sound comes in as two linked clips, like Premiere: the picture on the V track and its sound on an A
// track (A1 when free). marks.only = 'video' / 'audio' takes just the picture or just the sound (Source monitor).
export function placeMedia(mediaId, track, time, marks = {}) {
  const m = S.mediaById[mediaId];
  if (!m) return null;
  if (m.subOf && marks.in === undefined && marks.out === undefined) marks = { ...marks, in: m.subIn, out: m.subOut }; // (✂ a subclip: its part)
  const ik = m.interpretFps && m.fps ? m.interpretFps / m.fps : 1; // (🎞 Interpret footage: its clips play at that speed)
  const only = m.kind === 'video' ? marks.only : undefined;
  if (only === 'audio') {
    if (!m.hasAudio) { toast('This video has no sound'); return null; }
    if (KIND[track] !== 'audio') {
      const len = Math.max(0.1, (marks.out ?? m.duration ?? 0) - (marks.in ?? 0));
      const t0 = track === 'V1' && time >= 1e8 ? layout().V1.at(-1)?.end || 0 : time;
      track = freeAudioTrack(S.project, S.mediaById, t0, t0 + len); time = t0;
    }
  }
  if (only === 'video' && KIND[track] === 'audio') track = 'V1';
  if (m.kind === 'audio' && KIND[track] !== 'audio') track = 'A2';
  if (m.kind === 'image' && KIND[track] === 'audio') { toast('Photos go on the V tracks'); return null; }
  if (m.kind === 'video' && KIND[track] === 'audio' && !m.hasAudio) { toast('This video has no sound'); return null; }
  const c = { id: uid(), mediaId };
  if (KIND[track] === 'audio') Object.assign(c, { type: 'audio', in: marks.in ?? 0, ...(marks.out !== undefined ? { out: marks.out } : {}), volume: track === 'A2' ? 0.5 : 1, ...(track === 'A2' ? { duck: true } : {}) });
  else if (m.kind === 'image') Object.assign(c, { type: 'image', dur: 4 });
  else Object.assign(c, { type: 'video', in: marks.in ?? 0, ...(marks.out !== undefined ? { out: marks.out } : {}), ...(only === 'video' && m.hasAudio ? { mute: true } : {}) }); // (video only = no sound)
  if (c.type === 'video' && Math.abs(ik - 1) > 1e-4) c.speed = +ik.toFixed(5);
  if (track === 'V1' && marks.overwrite && time < 1e8) overwriteV1(c, Math.max(0, time)); // dragged in from Media: at the mouse
  else if (track === 'V1') {
    const L = layout().V1;
    const g = L.findIndex((x) => x.clip.gap && time >= x.start && time < x.end);
    if (g >= 0) {
      // dropped into a gap: the clip fills it from its start, the gap shrinks - nothing after it moves (Premiere overwrite)
      const gap = L[g].clip; S.project.tracks.V1.splice(g, 0, c);
      gap.dur = +(gap.dur - clipDur(c, S.mediaById)).toFixed(3);
      if (gap.dur < 0.04) S.project.tracks.V1.splice(S.project.tracks.V1.indexOf(gap), 1);
    } else {
      let idx = L.findIndex((x) => time < (x.start + x.end) / 2);
      if (idx < 0) idx = L.length;
      S.project.tracks.V1.splice(idx, 0, c);
      if (idx < L.length) syncShift(S.project, L[idx].start, clipDur(c, S.mediaById)); // (⇋ the story after it moved along)
    }
  } else {
    c.start = +time.toFixed(3);
    // Music longer than the edit would add black at the end: trim it to the main story and fade it out.
    const v1End = layout().V1.at(-1)?.end || 0;
    if (track === 'A2' && marks.out === undefined && v1End > c.start + 1 && m.duration > v1End - c.start + (c.in || 0)) {
      c.out = +((c.in || 0) + v1End - c.start).toFixed(3); c.fadeOut = 2;
    }
    S.project.tracks[track].push(c);
  }
  S.sel = new Set([c.id]);
  if (c.type === 'video' && m.hasAudio !== false && only !== 'video') {
    syncLinked(S.project, S.mediaById); // (later V1 clips' sound has moved along before a free track is chosen)
    const a = linkAudioOf(S.project, S.mediaById, c);
    if (a) S.sel.add(a.audio.id);
  }
  return c;
}

// effects from the Effects panel: the clip under the pointer lights up (a transition shows on the cut it would take)
function fxTarget(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.clip');
  $$('.clip.fx-target', root).forEach((x) => x !== el && x.classList.remove('fx-target'));
  if (el) el.classList.add('fx-target');
  return el;
}
document.addEventListener('dragend', () => { const z = document.getElementById('tlFxZone'); if (z) z.hidden = true; });
// a transition dragged over V1: like Premiere, a box on the cut it would go on, as long as the transition
function fxZone(e, el) {
  let z = $('#tlFxZone', root);
  const id = el?.dataset.id, f = id && findClip(id);
  if (!f || f.track !== 'V1' || ![...e.dataTransfer.types].includes('text/x-fx-transition')) { if (z) z.hidden = true; return; }
  const L = layout().V1, i = L.findIndex((x) => x.clip.id === id), r = el.getBoundingClientRect();
  const cutAt = (e.clientX - r.left) / Math.max(1, r.width) > 0.5 ? i + 1 : i; // (the same choice dropFx makes)
  if (cutAt <= 0 || cutAt >= L.length) { if (z) z.hidden = true; return; } // (no cut before the first / after the last shot)
  if (!z) { z = h('<div id="tlFxZone" class="tl-fxzone"></div>'); $('#tlCanvas', root).append(z); }
  const d = transitionLength(), t = L[cutAt].start;
  Object.assign(z.style, { left: `${(t - d / 2) * S.zoom}px`, width: `${Math.max(6, d * S.zoom)}px`, top: `${rowTop('V1')}px`, height: `${rowH('V1')}px` });
  z.hidden = false;
}
function onDragOver(e) {
  if ([...e.dataTransfer.types].includes('text/x-fx')) { const el = fxTarget(e); fxZone(e, el); if (el) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } return; }
  if (![...e.dataTransfer.types].includes('text/x-media-id')) return;
  e.preventDefault();
  const tr = rowAt(e.clientY);
  if (tr === 'V1') {
    // where it lands: at the mouse (overwrite, nothing moves); Ctrl: at the nearest cut (insert, the story moves along)
    const t = timeAt(e.clientX), L = layout().V1;
    let idx = L.findIndex((x) => t < (x.start + x.end) / 2); if (idx < 0) idx = L.length;
    const ins = $('#tlInsert'); ins.hidden = false;
    ins.style.left = `${(e.ctrlKey ? (idx < L.length ? L[idx].start : L.length ? L[L.length - 1].end : 0) : Math.max(0, t)) * S.zoom}px`;
    ins.style.top = `${rowTop('V1')}px`; ins.style.height = `${rowH('V1')}px`;
  } else $('#tlInsert').hidden = true;
}
function onDrop(e) {
  const fxs = e.dataTransfer.getData('text/x-fx');
  if (fxs) {
    const el = fxTarget(e); el?.classList.remove('fx-target');
    const z = $('#tlFxZone', root); if (z) z.hidden = true;
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    return dropFx(JSON.parse(fxs), el.dataset.id, (e.clientX - r.left) / Math.max(1, r.width));
  }
  const ids = (e.dataTransfer.getData('text/x-media-id') || '').split(',').filter(Boolean);
  $('#tlInsert').hidden = true;
  if (!ids.length) return;
  e.preventDefault();
  const track = rowAt(e.clientY) || 'V1';
  if (S.project.trackState[track]?.lock) return toast(`${track} is locked`);
  const only = e.dataTransfer.getData('text/x-media-only') || undefined; // 🎞 / 🔊 from the Source monitor's V / A chips
  let t = timeAt(e.clientX), placedN = 0;
  for (const id of ids) {
    const c = placeMedia(id, track, t, { ...(S.sourceMarks?.[id] || {}), ...(only ? { only } : {}), overwrite: !e.ctrlKey });
    if (c) { placedN++; t += clipDur(c, S.mediaById); }
  }
  if (placedN) commit(`Add ${placedN} clip${placedN > 1 ? 's' : ''}`);
}

// ---------------- track menu (right-click a track header) ----------------
const CORE = new Set(['V1', 'V2', 'A1', 'A2', 'A3']);
function trackMenu(e, id) {
  e.preventDefault();
  const n = S.project.tracks[id]?.length || 0, items = [['rename', 'Rename…'], ['addv', '+ Video track'], ['adda', '+ Audio track'], ...(S.project.trackState[id]?.volKeys?.length ? [['clrkeys', `Clear volume keyframes (${S.project.trackState[id].volKeys.length})`]] : []), ...(CORE.has(id) ? [] : ['-', ['del', `Delete ${id}${n ? ` (${n} clips)` : ''}`]])];
  const menu = h(`<div class="ctx" role="menu">${items.map((it) => (it === '-' ? '<hr>' : `<button role="menuitem" data-c="${it[0]}">${it[1]}</button>`)).join('')}</div>`);
  document.body.append(menu);
  menu.style.left = `${e.clientX}px`; menu.style.top = `${Math.min(e.clientY, innerHeight - menu.getBoundingClientRect().height - 8)}px`;
  const close = () => { menu.remove(); window.removeEventListener('pointerdown', outside, true); };
  const outside = (ev) => { if (!menu.contains(ev.target)) close(); };
  setTimeout(() => window.addEventListener('pointerdown', outside, true));
  menu.onclick = (ev) => {
    const a = ev.target.closest('[data-c]')?.dataset.c; if (!a) return;
    close();
    if (a === 'rename') { const nm = prompt(`Name for ${id}`, S.project.trackState[id]?.name || ''); if (nm !== null) { S.project.trackState[id] = { ...S.project.trackState[id], name: nm.trim() || undefined }; commit('Rename track'); } }
    if (a === 'clrkeys') { delete S.project.trackState[id].volKeys; commit('Clear track volume keyframes'); }
    if (a === 'addv' || a === 'adda') { const nid = addTrack(S.project, a === 'addv' ? 'video' : 'audio'); commit(`Add track ${nid}`); }
    if (a === 'del') {
      if (n && !confirm(`Delete ${id} and its ${n} clips?\n\nCtrl+Z brings it back.`)) return;
      delete S.project.tracks[id]; delete S.project.trackState[id];
      for (const c of [...S.sel]) if (!findClip(c)) S.sel.delete(c);
      commit(`Delete track ${id}`);
    }
  };
}

// Adjustment layer: a clip on an overlay track whose colour and effects apply to every track below it
export function addAdjustmentLayer() {
  const t = S.playhead, dur = 4;
  const free = (id) => !(S.project.tracks[id] || []).some((c) => (c.start || 0) < t + dur && (c.start || 0) + clipDur(c, S.mediaById) > t);
  const ov = trackList(S.project).filter((x) => x.kind === 'video' && x.id !== 'V1').map((x) => x.id); // top first
  const id = ov.find(free) || addTrack(S.project, 'video');
  const c = { id: uid(), type: 'adjust', start: +t.toFixed(3), dur, effects: [] };
  S.project.tracks[id].push(c);
  S.sel = new Set([c.id]);
  commit('Adjustment layer');
  toast(`Adjustment layer on ${id} - add colour / effects in Effect Controls; it changes every track below it`);
}

// ---------------- context menu ----------------
function onContext(e) {
  const el = e.target.closest('.clip');
  // 📋 an empty spot: paste copied clips right there
  if (!el) {
    const row = e.target.closest('.tl-row'); if (!row) return;
    const at = Math.max(0, timeAt(e.clientX)), n = clipboard()?.kind === 'clips' ? clipboard().items.length : 0;
    // an empty place on the main story (a gap): Ripple delete closes it, like Premiere
    const gap = row.dataset.track === 'V1' ? layout().V1.find((x) => x.clip.gap && at >= x.start && at < x.end) : null;
    const items = [...(gap ? [['ripple', `⇤ Ripple delete (close this ${fmt(gap.end - gap.start)} gap)`]] : []), ...(n ? [['pasteHere', `Paste ${n} clip${n > 1 ? 's' : ''} here`, 'Ctrl+V']] : [])];
    if (!items.length) return;
    e.preventDefault();
    return ctxMenu(e, items, (a) => {
      if (a === 'ripple') { const i = S.project.tracks.V1.indexOf(gap.clip); if (i >= 0) { S.project.tracks.V1.splice(i, 1); syncShift(S.project, gap.end, -(gap.end - gap.start)); commit('Close gap'); } return; }
      S.playhead = at; emit('playhead'); pasteClips().catch((err) => toast(err.message, 'err'));
    });
  }
  e.preventDefault();
  const id = el.dataset.id;
  if (!S.sel.has(id)) select(id, false);
  const f = findClip(id), c = f.clip;
  // the everyday edits only; the rest sit under "More…" (same spot) so the menu stays short
  const items = [
    ...(c.gap ? [['closegap', '⇤ Close gap (ripple)', 'Del'], '-'] : []),
    ['split', 'Split at playhead', 'S'], ['copy', S.sel.size > 1 ? `Copy ${S.sel.size} clips` : 'Copy', 'Ctrl+C'],
    ...(clipboard()?.kind === 'clips' ? [['paste', `Paste ${clipboard().items.length > 1 ? `${clipboard().items.length} clips ` : ''}at playhead`, 'Ctrl+V']] : []),
    ['dup', 'Duplicate', 'Ctrl+D'],
    ...(c.gap ? [] : [['del', 'Delete (leave a gap)', 'Del'], ...(f.track === 'V1' ? [['ripdel', 'Ripple delete (close the gap)', 'Shift+Del']] : [])]),
    ...(S.sel.size > 1 ? [['nest', `Nest ${S.sel.size} clips…`], ['group', 'Group', 'Ctrl+G']] : []), ...(c.grp ? [['ungroup', 'Ungroup', 'Ctrl+Shift+G']] : []),
    '-',
    ['spdlg', 'Speed / Duration…', 'Ctrl+R'],
    ...(c.type === 'video' || c.type === 'image' ? [['frameFit', 'Set to Frame Size (fit)'], ['frameScale', 'Scale to Frame Size'], ['frameFill', 'Fill Frame']] : []),
    ...(soundClips([id]).length ? [['gain', 'Audio gain…', 'G']] : []),
    ...((c.type === 'video' || c.type === 'audio') && !linkedPartner(S.project, c) ? [['mute', c.mute ? 'Unmute' : 'Mute']] : []),
    ...(linkedPartner(S.project, c) ? [['unlink', 'Unlink audio / video']] : c.type === 'video' && S.mediaById[c.mediaId]?.hasAudio && !c.link ? [['linkA', 'Separate audio (linked)']] : c.type === 'video' && c.link && S.mediaById[c.mediaId]?.hasAudio ? [['linkA', 'Bring back its sound (linked)']] : []),
    ...(c.type === 'video' ? ['-', ['comp', 'Make Motion comp (animate it in Motion)'], ['fusion', 'Open in Fusion (node effects)'], ['labs', c.labsId ? 'Open in Labs' : 'Edit in Labs (templates, AI)'], ['roto', 'Roto: cut out the subject (AI)']] : []),
    ...(c.mediaId ? ['-', ['replace', 'Replace clip…']] : []),
    '-', ['more', 'More…'],
  ];
  const more = [
    ...(c.type === 'video' && !c.gap ? [['hold', 'Add Frame Hold (from the playhead)'], ['holdIns', 'Insert Frame Hold Segment (2 s)'], ['scenes', 'Scene Edit Detection (cut at its cuts)'],
      ...(f.track === 'V1' && f.index > 0 && S.project.tracks.V1[f.index - 1]?.type === 'video' ? [['morph', 'Morph Cut (smooth the jump cut before this clip)']] : []), ['extend', 'Extend the end (+1 s, optical flow)'],
      ['ramp', `Speed ramp…${c.ramp ? ' (on)' : ''}`]] : []),
    ...(c.type === 'video' || c.type === 'audio' ? [['sp0.5', 'Speed 0.5× (slow-mo)'], ['sp1', 'Speed 1×'], ['sp2', 'Speed 2×']] : []),
    '-',
    ...(S.sel.size > 1 ? [] : [['nest', 'Nest…']]),
    ['clipMarker', 'Add clip marker at playhead'], ...(c.markers?.length ? [['clipMarkersOff', `Remove clip markers (${c.markers.length})`]] : []),
    ['pasteAttr', 'Paste Attributes…', 'Ctrl+Alt+V'], ['removeAttr', 'Remove Attributes…'], ['label', 'Label colour…'],
    [c.locked ? 'unlockClip' : 'lockClip', c.locked ? 'Unlock clip' : `Lock clip${S.sel.size > 1 ? `s (${S.sel.size})` : ''}`],
    ...(S.sel.size === 2 ? [['matte', '◐ Track Matte Key (the upper clip is the matte)']] : []),
    ...(c.type === 'video' ? ['-', ['behind', 'Text behind subject (AI roto)']] : []),
    ...(c.mediaId && S.mediaById[c.mediaId] ? ['-', ['revealP', 'Reveal in Project'], ['copydir', 'Copy folder path'], ...(/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? [['revealE', 'Reveal in Explorer']] : [])] : []),
    ...(c.mediaId ? ['-', ['replaceSrc', 'Replace with clip from Source monitor'], ['src', 'Open in source viewer']] : []),
  ];
  const menu = h('<div class="ctx" role="menu"></div>');
  const fill = (list) => {
    list = list.filter((it, i) => it !== '-' || (i > 0 && list[i - 1] !== '-' && i < list.length - 1));
    menu.innerHTML = list.map((it) => (it === '-' ? '<hr>' : `<button role="menuitem" data-c="${it[0]}">${it[1]}${it[2] ? `<kbd>${it[2]}</kbd>` : ''}</button>`)).join('');
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - r.width - 8))}px`; menu.style.top = `${Math.max(8, Math.min(e.clientY, innerHeight - r.height - 8))}px`;
  };
  document.body.append(menu); fill(items);
  const close = () => { menu.remove(); window.removeEventListener('pointerdown', outside, true); };
  const outside = (ev) => { if (!menu.contains(ev.target)) close(); };
  setTimeout(() => window.addEventListener('pointerdown', outside, true));
  menu.onclick = (ev) => {
    const a = ev.target.closest('[data-c]')?.dataset.c; if (!a) return;
    if (a === 'more') return fill(more);
    close();
    if (a === 'split') { if (splitClip(id, S.playhead)) commit('Split'); else toast('Move the playhead inside this clip first'); }
    if (a === 'nest') nestSelected();
    if (a === 'hold' || a === 'holdIns') frameHold(id, a === 'holdIns');
    if (a === 'label') clipLabel();
    if (a === 'scenes') sceneEdits(id);
    if (a === 'morph' || a === 'extend') morphOrExtend(id, a);
    if (a === 'matte') trackMatteFromClips([...S.sel], findClip);
    if (a === 'pasteAttr' || a === 'removeAttr') import('./attrs.js').then((x) => (a === 'pasteAttr' ? x.pasteAttributes() : x.removeAttributes()));
    if (a === 'revealP') import('./mediapool.js').then((x) => x.revealInProject(c.mediaId));
    if (a === 'revealE') import('./mediapool.js').then((x) => x.revealInExplorer(c.mediaId));
    if (a === 'copydir') import('./mediapool.js').then((x) => x.copyFolderPath(c.mediaId));
    if (a === 'comp') makeCompFromClip(id, findClip); // (stays on the timeline: double-click the orange clip to open it)
    if (a === 'behind') textBehindFromClip(id, findClip);
    if (a === 'fusion') fusionFromClip(id, findClip); // (double-click the maroon clip to open it)
    if (a === 'labs') labsFromClip(id); // (a yellow copy over it on V3; double-click it to open it in Labs)
    if (a === 'roto') rotoFromClip(id, findClip);
    if (a === 'ramp') rampMenu(e);
    if (a === 'copy') copyClips();
    if (a === 'paste') pasteClips().catch((err) => toast(err.message, 'err'));
    if (a === 'dup') duplicateSelected();
    if (a === 'closegap' || a === 'ripdel') deleteSelected(true);
    if (a === 'del') deleteSelected(false);
    if (a === 'frameFit' || a === 'frameScale' || a === 'frameFill') frameSize(a === 'frameFill' ? 'fill' : 'fit');
    if (a === 'spdlg') return import('./speeddlg.js').then((x) => x.openSpeedDuration());
    if (a.startsWith('sp')) { const D0 = clipDur(c, S.mediaById); c.speed = +a.slice(2) === 1 ? undefined : +a.slice(2); keepLength(S.project, c, D0, S.mediaById); commit('Speed'); }
    if (a === 'mute') { c.mute = !c.mute || undefined; commit('Mute'); }
    if (a === 'gain') openAudioGain();
    if (a === 'fadein' || a === 'fadeout') { const k = a === 'fadein' ? 'fadeIn' : 'fadeOut'; if (c[k]) delete c[k]; else c[k] = transitionLength(); commit(c[k] ? `${a === 'fadein' ? 'Fade in' : 'Fade out'} ${c[k]} s` : `Remove ${a === 'fadein' ? 'fade in' : 'fade out'}`); }
    if (a === 'unlink') unlinkSelected();
    if (a === 'linkA') separateAudio();
    if (a === 'trans') { setTransition(S.project, S.mediaById, f.index, c.transitionIn && c.transitionIn.type !== 'cut' ? null : 'fade', 0.5); commit('Transition'); }
    if (a === 'src') emit('openSource', c.mediaId);
    if (a === 'replace') openReplace(id);
    if (a === 'replaceSrc') replaceEdit(id);
    if (a === 'clipMarker') addClipMarker();
    if (a === 'lockClip' || a === 'unlockClip') { const lock = a === 'lockClip'; let k = 0; for (const s of S.sel) { const cl = findClip(s)?.clip; if (cl) { if (lock) cl.locked = true; else delete cl.locked; k++; } } commit(lock ? 'Lock clip' : 'Unlock clip'); toast(lock ? `${k} clip${k > 1 ? 's' : ''} locked - they stay as they are` : `${k} clip${k > 1 ? 's' : ''} unlocked`); }
    if (a === 'clipMarkersOff') clearClipMarkers();
    if (a === 'group') groupSelected();
    if (a === 'ungroup') ungroupSelected();
  };
}

// 📐 Set to Frame Size / Scale to Frame Size (the whole picture inside the frame) and Fill Frame (the frame covered, the
// rest cropped off), like Premiere: Motion › Scale of every selected video / photo clip from its own width x height.
// Position and rotation stay; animated Scale stops animating (one value now).
function frameSize(mode) {
  const st = S.project.settings, list = [...S.sel].map((x) => findClip(x)?.clip).filter((c) => c && (c.type === 'video' || c.type === 'image') && !c.locked);
  if (!list.length) return;
  let keyed = 0;
  for (const c of list) {
    const z = frameScale(c, S.mediaById[c.mediaId], st.aspect, st.fit, mode);
    if (c.keys?.['transform.zoom']) { delete c.keys['transform.zoom']; if (!Object.keys(c.keys).length) delete c.keys; keyed++; }
    if (c.type === 'image' && (c.kenburns ?? st.kenburns)) c.kenburns = false; // (a slow zoom would scale it again)
    c.transform = { ...(c.transform || {}), zoom: z };
    const t = c.transform; if (t.zoom === 1 && !t.x && !t.y && !t.rotation) delete c.transform;
  }
  commit(mode === 'fill' ? 'Fill Frame' : 'Set to Frame Size');
  toast(`${mode === 'fill' ? 'Fill Frame: the frame is covered' : 'Set to Frame Size: the whole picture fits in the frame'}${list.length > 1 ? ` (${list.length} clips)` : ''}${keyed ? ' - its Scale keyframes were taken off' : ''}`);
}

// ⛓ Unlink: the picture and its sound move and trim on their own from now on (the picture stays silent)
export function unlinkSelected() {
  let n = 0;
  for (const id of [...S.sel]) { const f = findClip(id); if (f?.clip.link) { const p = linkedPartner(S.project, f.clip); delete f.clip.link; if (p) delete p.clip.link; n++; } }
  if (n) commit('Unlink'); else toast('Select a linked clip first');
}
// 🔊 the sound inside the selected video clips goes onto its own linked audio clip (A1 when free)
export function separateAudio() {
  let n = 0;
  for (const id of [...S.sel]) {
    const f = findClip(id);
    if (!f || f.clip.type !== 'video' || linkedPartner(S.project, f.clip)) continue;
    const prevMute = !f.clip.link && f.clip.mute; // (a muted clip stays muted; a linked one was only silent for its sound clip)
    delete f.clip.link;
    const a = linkAudioOf(S.project, S.mediaById, f.clip);
    if (a) { if (prevMute) a.audio.mute = true; S.sel.add(a.audio.id); n++; }
  }
  if (n) commit(n > 1 ? `Separate audio of ${n} clips` : 'Separate audio'); else toast('Select a video clip with sound first');
}

// a small right-click menu (one action)
// ⏩ Speed ramp presets for the selected video clips (timeline tools button / right-click), so they are one click
// away in Edit - not only inside Effect Controls. Custom: Effect Controls › Speed ramp, where the curve is drawn.
function rampMenu(e) {
  const vids = [...S.sel].map((id) => findClip(id)?.clip).filter((c) => c?.type === 'video');
  if (!vids.length) return toast('Select a video clip first, then pick a speed ramp', 'err');
  ctxMenu(e, [['', '✕ No speed ramp'], ...Object.entries(RAMPS).map(([k, r]) => [k, `${r.label}`]), ['custom', 'Draw my own (Effect Controls)']], (k) => {
    if (k === 'custom') { emit('select'); return toast('Effect Controls › Speed ramp: click on the graph to draw your own'); }
    for (const c of vids) setRamp(c, k, S.mediaById); // (the shot keeps its length; only the speed inside changes)
    commit(k ? `Speed ramp: ${RAMPS[k].label}` : 'No speed ramp'); emit('select');
    toast(k ? `${RAMPS[k].label} - ${vids.length} clip${vids.length > 1 ? 's' : ''} (same length on the timeline; Accurate preview shows it exactly)` : 'Speed ramp removed');
  });
}
function ctxMenu(e, items, run) {
  const menu = h(`<div class="ctx" role="menu">${items.map((it) => `<button role="menuitem" data-c="${it[0]}">${it[1]}${it[2] ? `<kbd>${it[2]}</kbd>` : ''}</button>`).join('')}</div>`);
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`; menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  const close = () => { menu.remove(); window.removeEventListener('pointerdown', outside, true); };
  const outside = (ev) => { if (!menu.contains(ev.target)) close(); };
  setTimeout(() => window.addEventListener('pointerdown', outside, true));
  menu.onclick = (ev) => { const b = ev.target.closest('[data-c]'); if (!b) return; close(); run(b.dataset.c); };
}

// ---------------- icons (inline SVG, inherit currentColor) ----------------
const svg = (p) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
export const ICON = {
  pointer: svg('<path d="M4 3l7 17 2-7 7-2z"/>'),
  blade: svg('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>'),
  split: svg('<path d="M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  text: svg('<path d="M4 7V4h16v3M9 20h6M12 4v16"/>'),
  magnet: svg('<path d="M6 3v7a6 6 0 0 0 12 0V3M6 3h4v7a2 2 0 0 0 4 0V3h4"/>'),
  zoomIn: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>'),
  zoomOut: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>'),
  eye: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M17.9 17.9A10.1 10.1 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M1 1l22 22"/>'),
  lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
};
