// Multi-track timeline: V2 overlays/titles, V1 magnetic main story, A1 voice-over, A2 music, A3 SFX.
// Drag to move (V1 reorders), drag edges to trim, blade/S to split, drop media from the pool, snapping to edges + playhead.
import { S, on, emit, commit, layout, duration, findClip, saveNow } from './store.js';
import { zoneBandsHTML } from './zones.js';
import { seqMenu, seqName, openSequence, nestSelected, renameSequence } from './sequences.js';
import { makeCompFromClip, textBehindFromClip } from './motionpage.js';
import { fusionFromClip, rotoFromClip } from './fusionpage.js';
import { seqList } from './model.js';
import { sharedSeqId } from './store.js';
import { copyClips, pasteClips, clipboard } from './clipboard.js';
import { clipDur, uid, fmtTC, fmt, trackList, trackKind, addTrack, syncLinked, linkAudioOf, linkedPartner, freeAudioTrack, RAMPS, setRamp, TRANSITIONS, setTransition, trHandles } from './model.js';
import { $, $$, h, esc, clamp, toast } from './ui.js';
import { openTemplates } from './titlesui.js';
import { openGraphics } from './gfxui.js';
import { GFX } from './graphics.js';
import { autoSoundDesign } from './sfxui.js';
import { openReplace } from './replace.js';
import { dropFx, transitionLength } from './fxpanel.js';

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
        <button data-tool="select" title="Select / move (V)" aria-label="Select tool">${ICON.pointer}</button>
        <button data-tool="blade" title="Blade - click a clip to cut it (B)" aria-label="Blade tool">${ICON.blade}</button>
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
      <span class="tl-tc" id="tlTC">00:00:00:00</span><span class="tl-dur" id="tlDur"></span>
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
      </div>
    </div>
  </div>`;
  scroller = $('#tlScroll', el); rowsEl = $('#tlRows', el); ruler = $('#tlRuler', el);
  playheadEl = $('#tlPlayhead', el); snapEl = $('#tlSnap', el); headsEl = $('#tlHeads', el);

  $$('[data-tool]', el).forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
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
      if (!id) toast('Select a video clip on the timeline first, then press ✂ Roto', 'err'); else rotoFromClip(id, findClip);
    }
    if (a === 'sfx') autoSoundDesign().catch((err) => toast(err.message, 'err'));
    if (a === 'snap') { S.snap = !S.snap; syncBar(); }
    if (a === 'fit') fitZoom();
  });
  const z = $('#tlZoom', el);
  z.value = S.zoom;
  z.oninput = () => setZoom(+z.value, true);
  scroller.addEventListener('scroll', () => {
    headsEl.scrollTop = scroller.scrollTop; drawRuler();
    // big edits draw only the clips near the view: scrolled close to the edge of what is drawn -> draw that part
    if (drawn && (scroller.scrollLeft < drawn.a + scroller.clientWidth * 0.3 || scroller.scrollLeft + scroller.clientWidth > drawn.b - scroller.clientWidth * 0.3) && !drag) {
      clearTimeout(scrollRender); scrollRender = setTimeout(render, 30);
    }
  });
  scroller.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.altKey) { e.preventDefault(); setZoom(S.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), true, e.clientX); return; }
    // like Premiere: the wheel moves the timeline left / right; Shift + wheel scrolls the tracks up / down
    // (a touchpad's own sideways swipe keeps working as it is)
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    const d = (e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY) * (e.shiftKey ? 1 : 1.5);
    if (e.shiftKey) scroller.scrollTop += d; else scroller.scrollLeft += d;
  }, { passive: false });
  new ResizeObserver(() => { if (pendingFit && scroller.clientWidth >= 80) fitZoom(); else drawRuler(); }).observe(scroller);
  // the track headers scroll the tracks up / down with the wheel (like Premiere's track header area)
  headsEl.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.altKey) return;
    e.preventDefault();
    scroller.scrollTop += (e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY);
    headsEl.scrollTop = scroller.scrollTop;
  }, { passive: false });

  ruler.addEventListener('pointerdown', (e) => scrubStart(e));
  rowsEl.addEventListener('pointerdown', onRowsDown);
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

export function setTool(t) { S.tool = t; syncBar(); root.classList.toggle('blade', t === 'blade'); }
function syncBar() {
  $$('[data-tool]', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === S.tool)));
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
    const list = [...list0].filter((x) => !closed.has(x.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)), team = sharedSeqId(), html = list.map((x) => `<button role="tab" class="tl-stab" data-stab="${esc(x.id)}" aria-selected="${x.open}" title="${esc(x.name)}${x.id === team ? ' (team main sequence)' : ''} - double-click to rename">${x.id === team ? '<i class="stab-team">👥</i>' : ''}<span>${esc(x.name)}</span>${list0.length - closed.size > 1 ? `<i class="stab-x" data-sclose="${esc(x.id)}" title="Close this tab (the sequence stays - 🎞 ▾ opens it again)">✕</i>` : ''}</button>`).join('');
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
  $('#tlZoom', root).value = S.zoom;
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
const mName = (c) => (c.type === 'title' ? (c.text || 'Title').split('\n')[0] : c.type === 'adjust' ? '◩ Adjustment layer' : c.type === 'graphic' ? (c.gfx?.tpl === 'fusion' ? `✨ ${c.gfx.fusion?.name || 'Fusion'}` : c.gfx?.tpl === 'comp' ? `🎬 ${c.gfx.comp?.name || 'Comp'}` : `📊 ${c.gfx?.title || GFX[c.gfx?.tpl]?.label || 'Graphic'}`) : nestedName(c) || S.mediaById[c.mediaId]?.name || 'Missing media');
// a nested clip is named after its sequence (renaming the sequence renames the clip)
const nestedName = (c) => { const sid = S.mediaById[c.mediaId]?.seqOf; const s = sid && seqList(S.project).find((x) => x.id === sid); return s ? `🎞 ${s.name}` : null; };

// edits with many clips (an agent edit can have hundreds) draw only the clips within a screen of the view (+ selected)
let drawn = null, scrollRender = 0;
const VIRTUAL_AT = 150;
function render() {
  if (!S.project || !root) return;
  syncBar();
  const L = layout(), D = duration();
  const width = Math.max(scroller.clientWidth, (D + 30) * S.zoom);
  $('#tlCanvas', root).style.width = `${width}px`;
  const ts = S.project.trackState;

  const TR = trackList(S.project);
  drawHeads(TR, ts);
  const many = Object.values(L).reduce((n, l) => n + l.length, 0) > VIRTUAL_AT, vw = scroller.clientWidth || 1200;
  drawn = many ? { a: Math.max(0, scroller.scrollLeft - vw), b: scroller.scrollLeft + vw * 2 } : null;
  const near = (x) => !drawn || (x.end * S.zoom >= drawn.a && x.start * S.zoom <= drawn.b) || S.sel.has(x.clip.id);
  patchRows(TR.map((t) => ({ id: t.id, cls: `tl-row ${t.kind}${ts[t.id]?.hide ? ' hidden-track' : ''}${ts[t.id]?.lock ? ' locked' : ''}`, h: rowH(t.id),
    clips: (L[t.id] || []).flatMap((x, i) => (near(x) ? [[String(x.clip.id), clipHTML(t.id, x, i)], ...(t.id === 'V1' && i > 0 && x.overlap ? [[`tr-${x.clip.id}`, transHTML(x)]] : [])] : [])) })));
  $('#tlDur', root).textContent = `/ ${fmtTC(D, S.project.settings.fps)}`;
  placePlayhead();
  drawRuler();
  decoratePeers();
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
function drawHeads(TR, ts) {
  const key = JSON.stringify([TR, ts, TR.map((t) => rowH(t.id))]);
  if (key === headsKey && headsEl.children.length) return;
  headsKey = key;
  headsEl.innerHTML = `<div class="th-ruler"></div>` + TR.map((t) => {
    const st = ts[t.id] || {};
    return `<div class="th ${t.kind}${st.lock ? ' locked' : ''}" style="height:${rowH(t.id)}px" data-track="${t.id}" title="Right-click: rename, add or delete a track">
      <div class="th-name"><b>${t.name}</b><span>${esc(t.label)}</span></div>
      <div class="th-btns">
        ${t.kind === 'video' ? `<button class="tbtn${st.hide ? ' on' : ''}" data-tst="hide" title="Hide track">${st.hide ? ICON.eyeOff : ICON.eye}</button>` : ''}
        <button class="tbtn${st.mute ? ' on' : ''}" data-tst="mute" title="${t.kind === 'video' ? 'Mute clip sound' : 'Mute track'}">M</button>
        ${t.kind === 'audio' ? `<button class="tbtn solo${st.solo ? ' on' : ''}" data-tst="solo" title="Solo Track: hear only the soloed tracks">S</button><button class="tbtn rec" data-rec="${t.id}" title="Voice-over record: 3-2-1, then the edit plays and your voice goes onto ${t.name} from the playhead (click again or Esc to stop)">🎙</button>` : ''}
        <button class="tbtn${st.lock ? ' on' : ''}" data-tst="lock" title="Lock track">${ICON.lock}</button>
      </div>
      <div class="th-resize" data-rowh="${t.id}" title="Drag to make ${t.name} taller / shorter (double-click: normal)"></div>
      ${t.kind === 'audio' || t.id === 'V1' ? `<div class="th-volrow" title="${t.id === 'V1' ? "Volume of the clips' own sound" : 'Track volume'}: drag (double-click = 100%)"><span class="th-vlbl">🔊</span><input class="th-vol" type="range" min="0" max="2" step="0.05" value="${st.volume ?? 1}" data-tvol="${t.id}" aria-label="${t.name} volume"><span class="th-vpct">${Math.round((st.volume ?? 1) * 100)}%</span></div>` : ''}
    </div>`;
  }).join('');
  $$('[data-tst]', headsEl).forEach((b) => (b.onclick = () => {
    const id = b.closest('.th').dataset.track, k = b.dataset.tst;
    ts[id] = { ...ts[id], [k]: !ts[id]?.[k] };
    commit(`Track ${k}`);
    emit('mix'); // (the preview mix follows mute / solo at once)
  }));
  $$('[data-rec]', headsEl).forEach((b) => (b.onclick = () => import('./vorecord.js').then((m) => m.toggleRecord(b.dataset.rec))));
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
  if (x.clip.gap) return `<div class="clip t-gap${S.sel.has(x.clip.id) ? ' sel' : ''}" data-id="${x.clip.id}" data-track="${track}" style="left:${x.start * S.zoom}px;width:${Math.max(2, (x.end - x.start) * S.zoom)}px" title="Gap ${fmt(x.end - x.start)} - select it and press Delete (or right-click > Close gap) to close it"><div class="trim l" data-trim="l"></div><div class="trim r" data-trim="r"></div></div>`;
  const c = x.clip, m = S.mediaById[c.mediaId];
  // V1 shots are drawn cut to cut (like Premiere): the frames lent to a transition beyond a cut sit under its box,
  // not inside the shot's rectangle. vs / ve: where the rectangle starts / ends on the timeline (sec).
  let vs = x.start, ve = x.end;
  if (track === 'V1') { const L1 = layout().V1, nx = L1[i + 1]; vs = cutOf(x); if (nx?.overlap) ve = cutOf(nx); }
  const w = Math.max(2, (ve - vs) * S.zoom);
  const missing = c.type !== 'title' && c.type !== 'adjust' && c.type !== 'graphic' && !m;
  let bg = '';
  if (c.type === 'video' && m?.urls?.strip && track !== 'A1' && track !== 'A2' && track !== 'A3') {
    const sp = c.speed || 1, full = (m.duration / sp) * S.zoom;
    bg = `background-image:url('${m.urls.strip}');background-size:${full}px 100%;background-position:${-((c.in || 0) / sp + (vs - x.start)) * S.zoom}px 0`;
  } else if (c.type === 'image' && m?.urls?.thumb) bg = `background-image:url('${m.urls.thumb}');background-size:auto 100%;background-repeat:repeat-x`;
  else if (KIND[track] === 'audio' && m?.urls?.wave) {
    const sp = c.speed || 1, seg = ((c.loop ? (c.out ?? m.duration) - (c.in || 0) : m.duration) / sp) * S.zoom;
    bg = `background-image:url('${m.urls.wave}');background-size:${c.loop ? seg : (m.duration / sp) * S.zoom}px 100%;background-position:${c.loop ? 0 : -((c.in || 0) / sp) * S.zoom}px 0;background-repeat:${c.loop ? 'repeat-x' : 'no-repeat'}`;
  } else if (c.type === 'title') bg = `background:${track === 'V1' ? esc(c.bg || '#0b2545') : ''}`;
  else if (c.type === 'graphic') bg = c.gfx?.tpl === 'comp' || c.gfx?.tpl === 'fusion' ? '' : 'background:linear-gradient(90deg,#0b2545,#1d4e89)';
  // 🎨 kinds you can tell apart at a glance: ⤵ nested sequence (green), 🎬 Motion comp (orange), ✨ Fusion (maroon)
  const kind = c.gfx?.tpl === 'comp' ? ' k-comp' : c.gfx?.tpl === 'fusion' ? ' k-fusion' : c.mediaId && S.mediaById[c.mediaId]?.seqOf ? ' k-nest' : '';
  const badges = [c.color && Object.keys(c.color).length ? '<i title="Colour graded">CC</i>' : '', c.speed && c.speed !== 1 ? `<i>${c.speed}×</i>` : '',
    c.text && c.type !== 'title' ? '<i title="Has text">T</i>' : '', c.loop ? '<i title="Loops">⟲</i>' : '', c.duck ? '<i title="Ducks under speech">duck</i>' : '',
    c.link ? `<i class="lk" title="Linked to its ${c.type === 'audio' ? 'picture' : 'sound'} - they move and trim together (Alt + click takes one; right-click › Unlink)">${c.type === 'audio' ? 'A' : 'V'}🔗</i>` : '',
    c.mute && !(c.link && c.type === 'video') ? '<i title="Muted">M</i>' : '',
    // fx (like Premiere): the clip has effects - video effects, a cut effect, audio clean-up or masks
    c.effects?.length || c.cutFx?.type || c.afx || c.masks?.length ? `<i class="fxb" title="Effects: ${esc([...(c.effects || []).map((e) => e.type), c.cutFx?.type, c.afx && 'audio clean-up', c.masks?.length && `${c.masks.length} mask${c.masks.length > 1 ? 's' : ''}`].filter(Boolean).join(', '))} (Effect Controls)">fx</i>` : '', c.sfx ? `<i title="Sound effect (auto)">${esc(c.sfx)}</i>` : '', c.ramp ? '<i title="Speed ramp">⤳</i>' : '', c.transform && (c.transform.zoom !== 1 || c.transform.x || c.transform.y || c.transform.rotation) ? '<i title="Transformed">◰</i>' : ''].join('');
  // without a transition: a small + on the cut (on hover); with one, its box is drawn on the row (transHTML)
  const trans = track === 'V1' && i > 0 && !x.overlap ? `<button class="tr-btn" data-trans="${c.id}" title="Add transition" style="left:${-Math.min(10, w / 2)}px">+</button>` : '';
  const ov = '';
  const kt = [...new Set(Object.values(c.keys || {}).flat().map((k) => +k.t.toFixed(3)))];
  const kfs = kt.length ? `<div class="kfs">${kt.map((t) => `<i style="left:${t * S.zoom}px"></i>`).join('')}</div>` : '';
  return `<div class="clip t-${c.type}${kind}${S.sel.has(c.id) ? ' sel' : ''}${missing ? ' missing' : ''}${c.disabled ? ' off' : ''}" data-id="${c.id}" data-track="${track}"
    style="left:${vs * S.zoom}px;width:${w}px" title="${esc(mName(c))} · ${fmt(ve - vs)}${c.color && Object.keys(c.color).length ? ' · colour graded' : ''}${c.speed && c.speed !== 1 ? ` · ${c.speed}×` : ''}${c.ramp ? ' · speed ramp' : ''}${c.mute ? ' · muted' : ''}">
    <div class="clip-bg" style="${bg}"></div>${ov}${kfs}
    <div class="clip-lbl"><span class="nm">${missing ? '⚠ ' : ''}${esc(mName(c))}</span><span class="bd">${badges}</span></div>
    <div class="clip-dur">${fmt(ve - vs)}</div>
    <div class="trim l" data-trim="l"></div><div class="trim r" data-trim="r"></div>${trans}
  </div>`;
}

// ⧓ a transition, like Premiere's: a box ON the cut between the two shots (half over each), as long as the transition,
// with its name and the bow-tie of one shot fading into the next; click it to change or remove it. (It is drawn on the
// row, not inside a clip - inside the incoming clip it could only sit at that clip's start.)
function transHTML(x) {
  // the box is where the two shots mix: from the incoming shot's (lent) start, as long as the transition - the cut
  // between the rectangles is inside it (in the middle when both shots lent the same)
  const c = x.clip, w = Math.max(10, x.overlap * S.zoom), name = TRANSITIONS.find(([k]) => k === c.transitionIn?.type)?.[1] || c.transitionIn?.type || 'Transition';
  return `<button class="tr-box" data-trans="${c.id}" title="${esc(name)} ${x.overlap.toFixed(2)} s - click to change it, drag an end to make it longer / shorter" style="left:${x.start * S.zoom}px;width:${w}px"><i class="tr-h l" data-trdur="${c.id}"></i><span>${w > 60 ? esc(name) : ''}</span><i class="tr-h r" data-trdur="${c.id}"></i></button>`;
}
// where the cut into V1 shot x is drawn: after what the shot before lent ("handles", model.js setTransition); an older
// transition that does not say is drawn with its middle on the cut
function cutOf(x) {
  if (!x.overlap) return x.start;
  const h = x.clip.transitionIn?.hA !== undefined ? trHandles(x.clip.transitionIn) : { hB: x.overlap / 2 };
  return x.start + Math.min(x.overlap, h.hB);
}
function drawRuler() {
  if (!ruler || !scroller || !S.project) return; // (no project: back on the Projects page)
  const w = scroller.clientWidth, dpr = window.devicePixelRatio || 1;
  ruler.width = w * dpr; ruler.height = 28 * dpr; ruler.style.width = `${w}px`;
  ruler.style.left = `${scroller.scrollLeft}px`;
  const g = ruler.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-2') || '#15181e';
  g.fillRect(0, 0, w, 28);
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
  // markers
  for (const mk of S.project.markers || []) {
    const x = (mk.t - t0) * S.zoom;
    if (x < -10 || x > w + 10) continue;
    // notes: orange until done (green); plain markers blue
    g.fillStyle = mk.color || (mk.note ? (mk.done ? '#36c27e' : '#ff9933') : '#4f8cff'); g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 8); g.fill();
    if (mk.note && !mk.done) g.fillRect(x - 0.5, 8, 1, 20);
  }
}

function placePlayhead() {
  if (!playheadEl) return;
  playheadEl.style.left = `${S.playhead * S.zoom}px`;
  $('#tlTC', root).textContent = fmtTC(S.playhead, S.project?.settings.fps || 30);
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

// clicking one half of a linked clip selects both ([V] + [A]); Alt + click takes only the half you clicked
function select(id, additive, single = false) {
  if (!additive) S.sel.clear();
  if (id) {
    const f = findClip(id), pid = !single && f ? linkedPartner(S.project, f.clip)?.clip.id : null;
    if (additive && S.sel.has(id)) { S.sel.delete(id); if (pid) S.sel.delete(pid); } else { S.sel.add(id); if (pid) S.sel.add(pid); }
  }
  emit('select');
}

function onRowsDown(e) {
  if (e.button !== 0) return;
  // ⧓ an end of a transition box: drag it to make that side longer / shorter, on its own - the left end is how long
  // it runs before the cut, the right end after it (like Premiere); the cut and every shot stay put
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
  if (transBtn) { e.stopPropagation(); toggleTransition(transBtn.dataset.trans); return; }
  const el = e.target.closest('.clip');
  if (!el) { marqueeStart(e); return; }
  const id = el.dataset.id, track = el.dataset.track;
  if (S.tool !== 'blade' && !e.target.closest('[data-trim]') && lastDown.id === id && Date.now() - lastDown.t < 400 && Math.abs(e.clientX - lastDown.x) < 6 && Math.abs(e.clientY - lastDown.y) < 6) {
    lastDown = { id: null, t: 0, x: 0, y: 0 }; lastOpen = Date.now(); emit('openClip', id); return; // double-click: open it (Source monitor / Motion / Fusion / nested sequence)
  }
  lastDown = { id, t: Date.now(), x: e.clientX, y: e.clientY };
  if (S.project.trackState[track]?.lock) { toast(`${track} is locked`); return; }
  if (S.tool === 'blade') { splitClip(id, snap(timeAt(e.clientX), snapPoints(new Set([id])))); commit('Blade'); return; }
  if (!S.sel.has(id) || e.shiftKey || e.ctrlKey || e.altKey) select(id, e.shiftKey || e.ctrlKey, e.altKey);
  S.linkLead = id; // (the linked half follows the one you drag / trim)
  const trim = e.target.closest('[data-trim]')?.dataset.trim;
  const f = findClip(id);
  drag = { id, track, el, x0: e.clientX, y0: e.clientY, moved: false, trim, orig: JSON.parse(JSON.stringify(f.clip)), index: f.index,
    // where on the clip it was taken (sec from its start) - from the timeline, not the element: select() above has
    // already redrawn the clips, so `el` may be a removed one (its position read as 0 and drops landed seconds off)
    grab: timeAt(e.clientX) - (layout()[track]?.find((x) => x.clip.id === id)?.start ?? f.clip.start ?? 0),
    others: [...S.sel].filter((s) => s !== id && !(f.clip.link && findClip(s)?.clip.link === f.clip.link)).map((s) => ({ id: s, ...findClip(s) })).filter((o) => o.track !== 'V1').map((o) => ({ id: o.id, start: o.clip.start || 0 })) };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp, { once: true });
}

function onDragMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.x0;
  if (!drag.moved && Math.abs(dx) < 5 && Math.abs(e.clientY - drag.y0) < 5) return; // (a click's small wobble is not a drag)
  drag.moved = true;
  const f = findClip(drag.id); if (!f) return;
  const c = f.clip, o = drag.orig, m = S.mediaById[c.mediaId], sp = c.speed || 1;
  const dt = dx / S.zoom, pts = snapPoints(new Set([drag.id]));
  if (drag.trim) {
    const L = layout()[f.track].find((x) => x.clip.id === c.id);
    if (drag.trim === 'l') {
      const tEdge = snap((drag.track === 'V1' ? L.start : o.start || 0) + dt, pts);
      let d = tEdge - (drag.track === 'V1' ? L.start : o.start || 0);
      if (c.type === 'video' || (c.type === 'audio' && !c.loop)) {
        const ni = clamp((o.in || 0) + d * sp, 0, (o.out ?? m?.duration ?? 0) - 0.1 * sp);
        d = (ni - (o.in || 0)) / sp; c.in = +ni.toFixed(3);
      } else { const nd = Math.max(0.2, clipDur(o, S.mediaById) - d); d = clipDur(o, S.mediaById) - nd; c.dur = +nd.toFixed(3); }
      if (drag.track !== 'V1') c.start = +Math.max(0, (o.start || 0) + d).toFixed(3);
    } else {
      const startT = drag.track === 'V1' ? L.start : o.start || 0;
      const endT = snap(startT + clipDur(o, S.mediaById) + dt, pts);
      const nd = Math.max(0.2, endT - startT);
      if (c.type === 'video' || (c.type === 'audio' && !c.loop)) {
        const max = m?.duration ?? Infinity;
        c.out = +clamp((o.in || 0) + nd * sp, (o.in || 0) + 0.1 * sp, max).toFixed(3);
      } else c.dur = +nd.toFixed(3);
    }
    if (c.link) syncLinked(S.project, S.mediaById, drag.id);
    render();
    return;
  }
  // move - onto another track only once the mouse has clearly gone up / down (a clip taken near its top edge used to
  // jump onto the track above at the first wobble and show there as a faded copy)
  const overTrack = Math.abs(e.clientY - drag.y0) < 12 ? f.track : rowAt(e.clientY);
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
  }
  render();
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
const gapClip = (len) => ({ id: uid(), type: 'title', gap: true, text: '', bg: '#000000', dur: +Math.max(0.04, len).toFixed(3) });
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
  if (!d || !d.moved) { S.linkLead = null; return; }
  const f = findClip(d.id);
  const lp = f && !d.trim && f.clip.type === 'audio' ? linkedPartner(S.project, f.clip) : null;
  if (lp?.track === 'V1') toast('This sound is linked to its picture on V1 - move the picture, or right-click › Unlink to move the sound alone');
  if (!f) return render();
  if (d.trim) { commit('Trim'); return; }
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
    S.project.tracks[d.toTrack].push(c);
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
  if (c.type === 'video' || (c.type === 'audio' && !c.loop)) {
    const cut = (c.in || 0) + off * sp;
    b.in = +cut.toFixed(3); c.out = +cut.toFixed(3);
  } else { b.dur = +(clipDur(c, S.mediaById) - off).toFixed(3); c.dur = +off.toFixed(3); }
  if (f.track !== 'V1') b.start = +t.toFixed(3);
  if (c.textDuration && off < c.textDuration) b.textDuration = undefined;
  S.project.tracks[f.track].splice(f.index + 1, 0, b);
  return true;
}
export function splitAtPlayhead() {
  const t = S.playhead, L = layout(), ts = S.project.trackState;
  const targets = S.sel.size ? [...S.sel] : Object.entries(L).filter(([tr]) => !ts[tr]?.lock).flatMap(([, list]) => list.filter((x) => t > x.start && t < x.end).map((x) => x.clip.id));
  let n = 0;
  for (const id of targets) if (splitClip(id, t)) n++;
  if (n) commit('Split'); else toast('Put the playhead over a clip to split it');
}
// Premiere-style ripple trim (Q / W): cut the front or the back of the clip(s) under the playhead at the playhead.
// Main story (V1) closes the gap by itself; on other tracks a front trim makes the clip start at the playhead.
export function trimAtPlayhead(side) {
  const t = S.playhead, L = layout(), ts = S.project.trackState;
  const under = Object.entries(L).filter(([tr]) => !ts[tr]?.lock).flatMap(([tr, list]) => {
    const hit = list.filter((x) => t > x.start + 0.04 && t < x.end - 0.04);
    return (tr === 'V1' ? hit.slice(-1) : hit).map((x) => ({ tr, x })); // in a dissolve, V1's visible clip is the incoming one
  });
  // selected clips under the playhead; nothing selected = the main story's clip (music / VO stay as they are)
  const sel = under.filter((u) => S.sel.has(u.x.clip.id));
  const targets = sel.length ? sel : under.filter((u) => u.tr === 'V1').length ? under.filter((u) => u.tr === 'V1') : under.filter((u) => u.tr !== 'V1' && trackKind(u.tr) === 'video');
  if (!targets.length) return toast('Put the playhead over a clip, then Q cuts its front and W cuts its back');
  let v1Start = null;
  for (const { tr, x } of targets) {
    const c = x.clip, off = t - x.start, sp = c.speed || 1, media = c.type === 'video' || (c.type === 'audio' && !c.loop);
    if (side === 'start') {
      if (media) c.in = +((c.in || 0) + off * sp).toFixed(3); else c.dur = +(clipDur(c, S.mediaById) - off).toFixed(3);
      if (c.keys) for (const k of Object.values(c.keys)) for (const key of k) key.t = +(key.t - off).toFixed(3);
      if (tr !== 'V1') c.start = +t.toFixed(3); else v1Start = v1Start ?? x.start;
    } else {
      if (media) c.out = +((c.in || 0) + off * sp).toFixed(3); else c.dur = +off.toFixed(3);
    }
  }
  commit(side === 'start' ? 'Trim front' : 'Trim back');
  if (v1Start !== null) emit('seek', v1Start); // the rest of the story moved up to where the cut was
}
// Delete = "Ripple delete": a main-story (V1) clip goes and the next one moves up into its place (no gap to fix by hand).
// Shift+Delete = "Lift": it leaves a gap of its length (black, silent), so nothing after it moves. A selected gap: Delete closes it.
export function deleteSelected(ripple = true) {
  if (!S.sel.size) return toast('Select a clip first');
  // many clips at once (box select / Ctrl+A): ask first, and keep a backup copy of the project before deleting
  if (S.sel.size >= 8) {
    const all = Object.values(S.project.tracks).flat().length;
    if (!confirm(`Delete ${S.sel.size} clips${S.sel.size >= all ? ' - that is the WHOLE timeline' : ''}?

Ctrl+Z brings them back. A backup of the project is saved first.`)) return;
    saveNow('force');
  }
  let n = 0;
  const L1 = layout().V1;
  for (const id of [...S.sel]) {
    const f = findClip(id);
    if (!f || S.project.trackState[f.track]?.lock) continue;
    if (f.track === 'V1' && !ripple && !f.clip.gap) {
      // the gap ends exactly where the clip ended, so every later clip keeps its place
      const x = L1.find((p) => p.clip.id === id), len = x ? x.end - x.start - (x.overlap || 0) : clipDur(f.clip, S.mediaById);
      S.project.tracks.V1.splice(f.index, 1, { id: uid(), type: 'title', gap: true, text: '', bg: '#000000', dur: +Math.max(0.04, len).toFixed(3) });
    } else S.project.tracks.V1 === S.project.tracks[f.track] ? S.project.tracks.V1.splice(f.index, 1) : S.project.tracks[f.track].splice(f.index, 1);
    n++;
    if (f.track === 'V1' && f.index === 0 && S.project.tracks.V1[0]) delete S.project.tracks.V1[0].transitionIn;
  }
  tidyGaps();
  S.sel.clear();
  if (n) commit(ripple ? `Ripple delete ${n} clip${n > 1 ? 's' : ''}` : `Delete ${n} clip${n > 1 ? 's' : ''}`);
}
// gaps next to each other become one; a gap at the very end of the story goes (it would only add black)
function tidyGaps() {
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
  const n = S.project.tracks[id]?.length || 0, items = [['rename', 'Rename…'], ['addv', '+ Video track'], ['adda', '+ Audio track'], ...(CORE.has(id) ? [] : ['-', ['del', `Delete ${id}${n ? ` (${n} clips)` : ''}`]])];
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
    if (clipboard()?.kind !== 'clips' || !e.target.closest('.tl-row')) return;
    e.preventDefault();
    const at = Math.max(0, timeAt(e.clientX)), n = clipboard().items.length;
    return ctxMenu(e, [['pasteHere', `Paste ${n} clip${n > 1 ? 's' : ''} here`, 'Ctrl+V']], () => { S.playhead = at; emit('playhead'); pasteClips().catch((err) => toast(err.message, 'err')); });
  }
  e.preventDefault();
  const id = el.dataset.id;
  if (!S.sel.has(id)) select(id, false);
  const f = findClip(id), c = f.clip;
  const items = [
    ...(c.gap ? [['closegap', '⇤ Close gap (ripple)', 'Del'], '-'] : []),
    ['split', 'Split at playhead', 'S'], ['copy', S.sel.size > 1 ? `Copy ${S.sel.size} clips` : 'Copy', 'Ctrl+C'],
    ...(clipboard()?.kind === 'clips' ? [['paste', `Paste ${clipboard().items.length > 1 ? `${clipboard().items.length} clips ` : ''}at playhead`, 'Ctrl+V']] : []),
    ['dup', 'Duplicate', 'Ctrl+D'], ['nest', S.sel.size > 1 ? `⤵ Nest ${S.sel.size} clips…` : '⤵ Nest…'],
    ...(c.type === 'video' ? [['comp', '🎬 Make Motion comp (animate it in Motion)'], ['roto', '✂ Roto: cut out the subject (AI)'], ['behind', '✂ Text behind subject (AI roto)'], ['fusion', '✨ Open in Fusion (node effects)']] : []), ['del', 'Delete', 'Del'], ...(f.track === 'V1' && !c.gap ? [['lift', 'Delete and leave a gap', 'Shift+Del']] : []), '-',
    ...(c.type === 'video' ? [['ramp', `⏩ Speed ramp…${c.ramp ? ' (on)' : ''}`]] : []),
    ...(c.type === 'video' || c.type === 'audio' ? [['sp0.5', 'Speed 0.5× (slow-mo)'], ['sp1', 'Speed 1×'], ['sp2', 'Speed 2×'], ...(linkedPartner(S.project, c) ? [] : [['mute', c.mute ? 'Unmute' : 'Mute']])] : []),
    ...(linkedPartner(S.project, c) ? [['unlink', '⛓ Unlink audio / video']] : c.type === 'video' && S.mediaById[c.mediaId]?.hasAudio && !c.link ? [['linkA', '🔊 Separate audio onto its own track (linked)']] : c.type === 'video' && c.link && S.mediaById[c.mediaId]?.hasAudio ? [['linkA', '🔊 Bring back its sound (linked)']] : []),
    ...(f.track === 'V1' && f.index > 0 ? ['-', ['trans', c.transitionIn && c.transitionIn.type !== 'cut' ? 'Remove transition' : 'Add cross dissolve']] : []),
    ...(c.mediaId ? ['-', ['replace', '🔄 Replace clip…'], ['src', 'Open in source viewer']] : []),
  ];
  const menu = h(`<div class="ctx" role="menu">${items.map((it) => (it === '-' ? '<hr>' : `<button role="menuitem" data-c="${it[0]}">${it[1]}${it[2] ? `<kbd>${it[2]}</kbd>` : ''}</button>`)).join('')}</div>`);
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`; menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  const close = () => { menu.remove(); window.removeEventListener('pointerdown', outside, true); };
  const outside = (ev) => { if (!menu.contains(ev.target)) close(); };
  setTimeout(() => window.addEventListener('pointerdown', outside, true));
  menu.onclick = (ev) => {
    const a = ev.target.closest('[data-c]')?.dataset.c; if (!a) return;
    close();
    if (a === 'split') { if (splitClip(id, S.playhead)) commit('Split'); else toast('Move the playhead inside this clip first'); }
    if (a === 'nest') nestSelected();
    if (a === 'comp') makeCompFromClip(id, findClip); // (stays on the timeline: double-click the orange clip to open it)
    if (a === 'behind') textBehindFromClip(id, findClip);
    if (a === 'fusion') fusionFromClip(id, findClip); // (double-click the maroon clip to open it)
    if (a === 'roto') rotoFromClip(id, findClip);
    if (a === 'ramp') rampMenu(e);
    if (a === 'copy') copyClips();
    if (a === 'paste') pasteClips().catch((err) => toast(err.message, 'err'));
    if (a === 'dup') duplicateSelected();
    if (a === 'del' || a === 'closegap') deleteSelected(true);
    if (a === 'lift') deleteSelected(false);
    if (a.startsWith('sp')) { c.speed = +a.slice(2) === 1 ? undefined : +a.slice(2); commit('Speed'); }
    if (a === 'mute') { c.mute = !c.mute || undefined; commit('Mute'); }
    if (a === 'unlink') unlinkSelected();
    if (a === 'linkA') separateAudio();
    if (a === 'trans') { setTransition(S.project, S.mediaById, f.index, c.transitionIn && c.transitionIn.type !== 'cut' ? null : 'fade', 0.5); commit('Transition'); }
    if (a === 'src') emit('openSource', c.mediaId);
    if (a === 'replace') openReplace(id);
  };
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
  ctxMenu(e, [['', '✕ No speed ramp'], ...Object.entries(RAMPS).map(([k, r]) => [k, `⏩ ${r.label}`]), ['custom', '✏ Draw my own (Effect Controls)']], (k) => {
    if (k === 'custom') { emit('select'); return toast('Effect Controls › ⏩ Speed ramp: click on the graph to draw your own'); }
    for (const c of vids) setRamp(c, k, S.mediaById); // (the shot keeps its length; only the speed inside changes)
    commit(k ? `Speed ramp: ${RAMPS[k].label}` : 'No speed ramp'); emit('select');
    toast(k ? `⏩ ${RAMPS[k].label} - ${vids.length} clip${vids.length > 1 ? 's' : ''} (same length on the timeline; Accurate preview shows it exactly)` : 'Speed ramp removed');
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
