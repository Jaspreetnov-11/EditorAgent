// 🧪 Labs clips (Phase 22, like Motion comps / Fusions): right-click a video clip > Edit in Labs - a copy of it is laid
// exactly over it on V3 or above (yellow on the timeline, muted: the sound stays with the clip below). Its Labs edit is a
// draft in project.labs[id] that the Labs page changes: a preview, an inspector (In / duration, keyframes, speed ramp,
// cut effect, effects with their settings) and its own timeline (trim the ends, drag keyframes, the cut effect's
// length). "Update the timeline as I edit" (on by default) or Update on timeline puts it on every clip of that Labs
// edit. Space / ← → / Delete work on the Labs preview while the Labs page is open. Nothing about Labs is in Effect Controls.
import { ic } from './lineicons.js';
import { S, commit, emit, findClip, layout } from './store.js';
import { uid, clipDur, compTrack, sourceAt, propAt, evalKeys, RAMPS, rampPts, setRamp, KEYABLE } from './model.js';
import { effectsCss, VFX, newEffect } from './effects.js';
import { CUTFX, fxPreview } from './fx.js';
import { esc, toast } from './ui.js';
import { applyTemplate, clearTemplate, templateNames } from './aitemplates.js';

// what a Labs edit changes on its clip (the rest - start, track - belongs to the timeline)
const LAB_FIELDS = ['in', 'out', 'speed', 'keys', 'ramp', 'rampPts', 'smooth', 'cutFx', 'hits', 'effects', 'tpl', 'color', 'opacity'];
// the Colour section: field, label, min, max, step, neutral (the same grade fields as the Color page - the render reads them)
const COLOR = [['exposure', 'Exposure', -3, 3, 0.05, 0], ['contrast', 'Contrast', 0.5, 2, 0.01, 1], ['saturation', 'Saturation', 0, 2, 0.01, 1], ['vibrance', 'Vibrance', -1, 1, 0.01, 0],
  ['temp', 'Temperature', -1, 1, 0.01, 0], ['tint', 'Tint', -1, 1, 0.01, 0], ['highlights', 'Highlights', -1, 1, 0.01, 0], ['shadows', 'Shadows', -1, 1, 0.01, 0]];
const PROPS = [['transform.zoom', 'Zoom', 0.01], ['transform.x', 'Position X', 0.5], ['transform.y', 'Position Y', 0.5], ['transform.rotation', 'Rotation', 1], ['opacity', 'Opacity', 0.01]];
const EASES = [['', 'Linear'], ['io', 'Smooth'], ['in', 'Ease in'], ['out', 'Ease out'], ['hold', 'Hold']];
const labs = () => (S.project.labs ||= {});
let openId = null, T = 0, playing = false, raf = 0, root = null, selKey = null; // selKey: { p, i }
const picked = new Set(); // Labs clips edited together (Ctrl / Shift + click in the list): templates, effects, cut, ramp go on all
let live = true; // (update the timeline as I edit)
try { live = localStorage.getItem('vedit.labs.live') !== '0'; } catch {}
export const labOpen = () => (openId && labs()[openId]) || null;
// the open Labs clip and the others picked with it
const targets = () => { const L = labOpen(); return L ? [L, ...[...picked].filter((id) => id !== L.id).map((id) => labs()[id]).filter(Boolean)] : []; };
const durOf = (L) => +clipDur(L.clip, S.mediaById).toFixed(3);

// the timeline clips that show Labs edit `id`
const onTimeline = (id) => Object.entries(S.project.tracks).filter(([t]) => t[0] === 'V').flatMap(([t, l]) => l.filter((x) => x.labsId === id).map((x) => ({ t, x })));

export function labsFromClip(clipId) {
  const f0 = findClip(clipId), c = f0?.clip, m = c && S.mediaById[c.mediaId];
  if (!c || c.type !== 'video' || !m) { toast('Right-click a video clip', 'err'); return null; }
  if (c.labsId) { openLabsClip(c); return c.labsId; }
  const start = Object.values(layout()).flat().find((x) => x.clip.id === c.id)?.start ?? c.start ?? 0, D = +clipDur(c, S.mediaById).toFixed(3);
  const id = uid(), name = `${m.name.replace(/\.[^.]+$/, '')} labs`;
  const copy = JSON.parse(JSON.stringify(c));
  delete copy.link; delete copy.transitionIn; delete copy.labsId;
  const draft = { ...copy, id: uid(), start: +start.toFixed(3), volume: 0, mute: true };
  labs()[id] = { id, name, from: c.id, dur: D, clip: draft };
  const tr = compTrack(S.project, start, D, S.mediaById, f0.track);
  S.project.tracks[tr].push({ ...JSON.parse(JSON.stringify(draft)), id: uid(), labsId: id });
  commit(`Edit in Labs: ${m.name}`);
  toast(`"${name}" made on ${tr} over the clip (yellow) - edit it on the Labs page, double-click it to open it again`);
  openId = id; T = 0; selKey = null;
  emit('gotoPage', 'ai');
  return id;
}
export function openLabsClip(c) {
  if (!c?.labsId) return;
  // a Labs clip copied from another project: its edit comes from the clip itself
  if (!labs()[c.labsId]) { labs()[c.labsId] = { id: c.labsId, name: S.mediaById[c.mediaId]?.name || 'Labs', dur: clipDur(c, S.mediaById), clip: JSON.parse(JSON.stringify(c)) }; commit('Bring back Labs edit'); }
  openId = c.labsId; T = 0; selKey = null;
  emit('gotoPage', 'ai');
}

// every change to the draft goes through here: saved (undo-able), the timeline follows when live, the page redraws
function changed(label, { quiet = false, coalesce } = {}) {
  const L = labOpen(); if (!L) return;
  for (const x of targets()) { x.dur = durOf(x); if (live) pushToTimeline(x); }
  commit(`Labs: ${label}${picked.size > 1 ? ` (${targets().length} clips)` : ''}`, coalesce);
  if (!quiet) draw(); else { drawTimeline(); frame(); }
}
function pushToTimeline(L) {
  const there = onTimeline(L.id);
  for (const { x } of there) for (const k of LAB_FIELDS) { if (L.clip[k] === undefined) delete x[k]; else x[k] = JSON.parse(JSON.stringify(L.clip[k])); }
  return there;
}

// templates and their removal work on the open Labs edit (the draft)
export function labTemplate(t) {
  const L = labOpen(); if (!L) return false;
  const all = targets();
  for (const x of all) applyTemplate(x.clip, t, durOf(x), S.mediaById, { stack: true }); // (several templates add up)
  changed(t.label);
  toast(`${t.label} added${all.length > 1 ? ` to ${all.length} Labs clips` : ''}${live ? ' - on the timeline too' : ' - press Update on timeline'}`);
  return true;
}
export function labClear() {
  const L = labOpen(); if (!L) return false;
  let n = 0; for (const x of targets()) if (clearTemplate(x.clip, durOf(x), S.mediaById)) n++;
  if (n) changed('remove templates');
  return true;
}
export function labUpdate() {
  const L = labOpen(); if (!L) return;
  const there = targets().flatMap((x) => pushToTimeline(x));
  commit(`Update Labs edit "${L.name}" on the timeline`);
  S.sel = new Set(there.map((p) => p.x.id)); emit('select');
  toast(there.length ? `"${L.name}" updated on ${[...new Set(there.map((p) => p.t))].join(', ')}` : 'This Labs edit is not on the timeline any more');
  draw();
}

// ---------------- the workspace on the Labs page ----------------
export function labsWorkHTML() {
  return `<section class="lab-work" data-work>
    <div class="lab-sec-h"><div><span class="lab-kicker">Labs timeline</span><h2 data-lname>No Labs clip open</h2></div>
      <p class="lab-note" data-lhint></p>
      <label class="chk lw-live" title="Every change in Labs goes straight onto the clip on the Edit timeline"><input type="checkbox" data-llive${live ? ' checked' : ''}> Update the timeline as I edit</label>
      <button class="primary" data-l="update" disabled>Update on timeline</button></div>
    <div class="lw-grid">
      <aside class="lw-list" data-llist></aside>
      <div class="lw-stage"><div class="lw-frame" data-lframe><video muted playsinline preload="auto" data-lvid></video><div class="lw-ov" data-lov></div></div>
        <div class="lw-tr"><button class="icon-btn" data-l="start" aria-label="Go to start" title="Go to start (Home)">${ic('start')}</button><button class="icon-btn" data-l="back" aria-label="One frame back" title="One frame back (←)">‹</button>
          <button class="icon-btn lw-play" data-l="play" aria-label="Play" title="Play / pause (Space)">${ic('play')}</button><button class="icon-btn" data-l="fwd" aria-label="One frame on" title="One frame on (→)">›</button><button class="icon-btn" data-l="end" aria-label="Go to end" title="Go to end (End)">${ic('end')}</button>
          <span class="mono lw-tc" data-ltc>0:00.00</span><span class="mono lw-dur" data-ldur></span><label class="lw-zoom" title="Zoom the Labs timeline (Ctrl + mouse wheel over it)"><span>Zoom</span><input type="range" data-lzoom min="1" max="12" step="0.5" value="1"></label></div></div>
      <aside class="lw-insp" data-linsp></aside>
    </div>
    <div class="lw-tl" data-ltl></div>
  </section>`;
}

export function mountLabsWork(el) {
  root = el;
  el.addEventListener('click', onClick);
  el.addEventListener('change', (e) => onInput(e));
  el.addEventListener('input', (e) => { if (e.target.matches('[type=range]')) onInput(e, true); });
  el.addEventListener('pointerdown', onPointer);
  el.addEventListener('input', (e) => { if (e.target.matches('[data-lzoom]')) { zoom = +e.target.value; drawTimeline(); } });
  el.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !e.target.closest('[data-ltl]')) return;
    e.preventDefault(); zoom = Math.max(1, Math.min(12, zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
    const z = root.querySelector('[data-lzoom]'); if (z) z.value = zoom; drawTimeline();
  }, { passive: false });
  el.addEventListener('dblclick', (e) => {
    // double-click a property row: a keyframe there, with the value it has at that time
    const hl = e.target.closest('[data-hits]');
    if (hl && labOpen() && !e.target.closest('[data-hit]')) { const r = hl.getBoundingClientRect(), L2 = labOpen(); return addHit(Math.max(0, Math.min(L2.dur - 0.05, ((e.clientX - r.left) / r.width) * L2.dur))); }
    const lane = e.target.closest('[data-prop]'), L = labOpen(); if (!lane || !L || e.target.closest('[data-key]')) return;
    const r = lane.getBoundingClientRect(), t = Math.max(0, Math.min(L.dur, ((e.clientX - r.left) / r.width) * L.dur));
    addKey(lane.dataset.prop, t);
  });
  // Space plays the Labs preview (not the Edit timeline) while the Labs page is open; ← → a frame; Delete a keyframe
  document.addEventListener('keydown', (e) => {
    if (S.page !== 'ai' || !labOpen() || document.querySelector('dialog[open]')) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
    const L = labOpen(), fps = S.project.settings?.fps || 25;
    let done = true;
    if (e.key === ' ') toggle();
    else if (e.key === 'ArrowLeft') seek(T - (e.shiftKey ? 10 : 1) / fps);
    else if (e.key === 'ArrowRight') seek(T + (e.shiftKey ? 10 : 1) / fps);
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(L.dur);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selKey) delKey();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selKey) { const k = L.clip.keys[selKey.p][selKey.i]; keyClip = { p: selKey.p, v: k.v, ease: k.ease }; toast(`Keyframe copied (${KEYABLE[selKey.p]?.label} ${+k.v.toFixed(3)}) - Ctrl+V puts it at the playhead`); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && keyClip) pasteKey();
    else if (e.key === '=' || e.key === '+') { zoom = Math.min(12, zoom * 1.25); drawTimeline(); }
    else if (e.key === '-') { zoom = Math.max(1, zoom * 0.8); drawTimeline(); }
    else done = false;
    if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

function onClick(e) {
  const b = e.target.closest('[data-l]'), it = e.target.closest('[data-lid]'), key = e.target.closest('[data-key]');
  if (it) {
    const id = it.dataset.lid;
    if (e.ctrlKey || e.metaKey || e.shiftKey) { if (picked.has(id) && id !== openId) picked.delete(id); else { picked.add(id); if (openId) picked.add(openId); } }
    else { picked.clear(); openId = id; T = 0; selKey = null; }
    draw(); return;
  }
  if (key) return; // (handled on pointerdown)
  if (!b) return;
  const a = b.dataset.l, L = labOpen(), fps = S.project.settings?.fps || 25;
  if (a === 'update') labUpdate();
  if (!L) return;
  if (a === 'play') toggle();
  if (a === 'start') seek(0);
  if (a === 'end') seek(L.dur);
  if (a === 'back') seek(T - 1 / fps);
  if (a === 'fwd') seek(T + 1 / fps);
  if (a === 'rm' && confirm(`Delete the Labs edit "${L.name}"? Its clips stay on the timeline as they are.`)) { for (const { x } of onTimeline(L.id)) delete x.labsId; delete labs()[L.id]; openId = null; selKey = null; commit('Delete Labs edit'); draw(); }
  if (a === 'addkey') addKey(b.dataset.p, T);
  if (a === 'clrkeys') { delete L.clip.keys?.[b.dataset.p]; if (L.clip.keys && !Object.keys(L.clip.keys).length) delete L.clip.keys; selKey = null; changed(`clear ${KEYABLE[b.dataset.p]?.label}`); }
  if (a === 'delkey') delKey();
  if (a === 'addhit') addHit(Math.min(T, L.dur - 0.05));
  if (a === 'rmhit') { L.clip.hits.splice(+b.dataset.i, 1); if (!L.clip.hits.length) delete L.clip.hits; changed('remove hit'); }
  if (a === 'colreset') { for (const x of targets()) for (const [k2] of COLOR) { if (x.clip.color) delete x.clip.color[k2]; } for (const x of targets()) if (x.clip.color && !Object.keys(x.clip.color).length) delete x.clip.color; changed('reset colour'); }
  if (a === 'rmfx') { L.clip.effects = (L.clip.effects || []).filter((x) => x.id !== b.dataset.id); if (!L.clip.effects.length) delete L.clip.effects; changed('remove effect'); }
  if (a === 'fxon') { const x = L.clip.effects.find((y) => y.id === b.dataset.id); x.on = x.on === false; changed(x.on ? 'effect on' : 'effect off'); }
}

// inspector fields: data-f = what it sets
function onInput(e, sliding = false) {
  const el = e.target, f = el.dataset.f, L = labOpen();
  if (el.matches('[data-llive]')) { live = el.checked; try { localStorage.setItem('vedit.labs.live', live ? '1' : '0'); } catch {} if (live && L) { pushToTimeline(L); commit('Labs: update timeline'); } return; }
  if (!f || !L) return;
  const c = L.clip, v = el.type === 'checkbox' ? el.checked : el.value, n = +v, m = S.mediaById[c.mediaId], full = m?.duration || 1e9;
  if (f === 'name') { L.name = String(v).trim() || L.name; return changed('rename'); }
  if (f === 'in') { const d = durOf(L), sp = c.speed || 1, tin = Math.max(0, Math.min(full - 0.1, n)); c.in = +tin.toFixed(3); c.out = +Math.min(full, tin + d * sp).toFixed(3); return changed('In point'); }
  if (f === 'dur') { const d = Math.max(0.2, n), sp = c.speed || 1; c.out = +Math.min(full, (c.in || 0) + d * sp).toFixed(3); if (c.ramp) setRamp(c, c.ramp, S.mediaById, c.rampPts, d); T = Math.min(T, d); return changed('Duration'); }
  if (f === 'speed') { const d = durOf(L), sp = Math.max(0.1, Math.min(8, n || 1)); if (sp === 1) delete c.speed; else c.speed = sp; c.out = +Math.min(full, (c.in || 0) + d * sp).toFixed(3); return changed('Speed'); }
  const each = (fn) => { for (const x of targets()) fn(x.clip, x); };
  if (f === 'ramp') { each((cc, x) => { setRamp(cc, v, S.mediaById, null, durOf(x)); if (!v) delete cc.smooth; }); return changed(v ? `Speed ramp: ${RAMPS[v]?.label}` : 'No speed ramp'); }
  if (f === 'smooth') { each((cc) => { if (v) cc.smooth = true; else delete cc.smooth; }); return changed(v ? 'Smooth slow motion' : 'No smooth slow motion'); }
  if (f === 'cut') { each((cc) => { if (v) cc.cutFx = { type: v, dur: CUTFX[v].dur }; else delete cc.cutFx; }); return changed(v ? `Cut effect: ${CUTFX[v].label}` : 'No cut effect'); }
  if (f === 'cutdur') { if (c.cutFx) c.cutFx.dur = Math.max(0.05, Math.min(3, n)); return changed('Cut effect length', { quiet: sliding, coalesce: 'labs-cutdur' }); }
  if (f === 'addfx') { if (v) { each((cc) => (cc.effects ||= []).push(newEffect(v))); el.value = ''; changed(`effect ${VFX[v].label}`); } return; }
  if (f === 'fxp') { const x = c.effects.find((y) => y.id === el.dataset.id); x.p = { ...(x.p || {}), [el.dataset.k]: n }; const lb = el.closest('.lwi-f')?.querySelector('b'); if (lb) lb.textContent = n; return changed(`${VFX[x.type].label} setting`, { quiet: sliding, coalesce: `labs-fx-${x.id}-${el.dataset.k}` }); }
  if (f === 'fxfrom' || f === 'fxto') { const x = c.effects.find((y) => y.id === el.dataset.id), t = Math.max(0, Math.min(L.dur, n)); if (f === 'fxfrom') { if (t <= 0.001) delete x.from; else x.from = +t.toFixed(3); } else if (t >= L.dur - 0.001) delete x.to; else x.to = +t.toFixed(3); return changed('effect time'); }
  if (f === 'hittype') { hitType = v; return; }
  if (f.startsWith('hit-')) { const h = c.hits[+el.dataset.i]; if (f === 'hit-type') { h.type = v; h.dur = CUTFX[v].dur; } if (f === 'hit-t') h.t = +Math.max(0, Math.min(L.dur - 0.05, n)).toFixed(3); if (f === 'hit-dur') h.dur = +Math.max(0.05, Math.min(3, n)).toFixed(2); c.hits.sort((a, b) => a.t - b.t); return changed('hit'); }
  if (f === 'col') { const k2 = el.dataset.k, z = COLOR.find((x) => x[0] === k2)[5]; each((cc) => { cc.color = { ...(cc.color || {}) }; if (Math.abs(n - z) < 1e-6) delete cc.color[k2]; else cc.color[k2] = n; if (!Object.keys(cc.color).length) delete cc.color; }); const lb = el.closest('.lwi-f')?.querySelector('b'); if (lb) lb.textContent = +n.toFixed(2); return changed('colour', { quiet: sliding, coalesce: `labs-col-${k2}` }); }
  if (f === 'val') { const p = el.dataset.p; setValueAt(p, T, n); return changed(`${KEYABLE[p]?.label}`, { quiet: true, coalesce: `labs-val-${p}` }); }
  if (f === 'kt' && selKey) { const ks = c.keys[selKey.p], k = ks[selKey.i]; k.t = +Math.max(0, Math.min(L.dur, n)).toFixed(3); ks.sort((a, b) => a.t - b.t); selKey.i = ks.indexOf(k); return changed('keyframe time'); }
  if (f === 'kv' && selKey) { c.keys[selKey.p][selKey.i].v = n; return changed('keyframe value'); }
  if (f === 'ke' && selKey) { const k = c.keys[selKey.p][selKey.i]; if (v) k.ease = v; else delete k.ease; return changed('keyframe ease'); }
}

// a value at time t: the keyframe there (or a new one) when the property is animated, else the plain value
function setValueAt(p, t, v) {
  const c = labOpen().clip, ks = c.keys?.[p];
  if (!ks?.length) { const [a, b] = p.split('.'); if (b) c[a] = { ...(c[a] || {}), [b]: v }; else c[p] = v; return; }
  const near = ks.findIndex((k) => Math.abs(k.t - t) < 0.02);
  if (near >= 0) ks[near].v = v; else { ks.push({ t: +t.toFixed(3), v }); ks.sort((x, y) => x.t - y.t); }
}
function addKey(p, t) {
  const L = labOpen(), c = L.clip;
  const v = +(+propAt(c, p, t) || 0).toFixed(3), ks = ((c.keys ||= {})[p] ||= []);
  // the first key of a property: one at the start too, so it animates from the value it had
  if (!ks.length && t > 0.05) ks.push({ t: 0, v });
  if (!ks.some((k) => Math.abs(k.t - t) < 0.02)) ks.push({ t: +t.toFixed(3), v });
  ks.sort((a, b) => a.t - b.t);
  selKey = { p, i: ks.findIndex((k) => Math.abs(k.t - t) < 0.02) };
  changed(`keyframe ${KEYABLE[p]?.label}`);
}
let hitType = 'flash';
let zoom = 1, keyClip = null; // (the Labs timeline's zoom; a copied keyframe)
function addHit(t) {
  const c = labOpen().clip;
  (c.hits ||= []).push({ t: +t.toFixed(3), type: hitType, dur: CUTFX[hitType].dur });
  c.hits.sort((a, b) => a.t - b.t);
  changed(`hit: ${CUTFX[hitType].label}`);
}
// the copied keyframe at the playhead (its own property; it replaces a key already there)
function pasteKey() {
  const c = labOpen().clip, ks = ((c.keys ||= {})[keyClip.p] ||= []);
  const old = ks.findIndex((k) => Math.abs(k.t - T) < 0.02); if (old >= 0) ks.splice(old, 1);
  ks.push({ t: +T.toFixed(3), v: keyClip.v, ...(keyClip.ease ? { ease: keyClip.ease } : {}) }); ks.sort((a, b) => a.t - b.t);
  selKey = { p: keyClip.p, i: ks.findIndex((k) => Math.abs(k.t - T) < 0.02) };
  changed('paste keyframe');
}
function delKey() {
  const c = labOpen().clip, ks = c.keys?.[selKey.p]; if (!ks) return;
  ks.splice(selKey.i, 1);
  if (!ks.length) delete c.keys[selKey.p];
  if (c.keys && !Object.keys(c.keys).length) delete c.keys;
  selKey = null; changed('delete keyframe');
}

// timeline drags: the playhead (ruler / empty lane), a keyframe (its time), the clip's ends (In / duration), the cut
// effect's end (its length)
function onPointer(e) {
  const L = labOpen(); if (!L || e.button !== 0) return;
  const tl = e.target.closest('[data-lanes]'); if (!tl) return;
  const lane = tl.querySelector('.lbt-ruler .lbt-lane'), r = lane.getBoundingClientRect(), D0 = L.dur;
  // times snap to frames, and to the playhead / other keyframes when close (Alt: no snapping)
  const fps = S.project.settings?.fps || 25, px = D0 / r.width;
  const snapTo = (t, ev, others = []) => {
    if (ev.altKey) return t;
    for (const o of [T, 0, D0, ...others]) if (Math.abs(o - t) < px * 6) return o;
    return Math.round(t * fps) / fps;
  };
  const tAt = (x) => Math.max(0, Math.min(D0, ((x - r.left) / r.width) * D0));
  const key = e.target.closest('[data-key]'), trim = e.target.closest('[data-trim]'), cut = e.target.closest('[data-cutend]');
  const hit = e.target.closest('[data-hit]'), hitEnd = e.target.closest('[data-hitend]'), fxe = e.target.closest('[data-fxedge]');
  let move, done;
  if (key) {
    // drag sideways: its time; drag up / down: its value (Shift: finer)
    selKey = { p: key.dataset.key, i: +key.dataset.i };
    const ks0 = L.clip.keys[selKey.p], k = ks0[selKey.i], x0 = e.clientX, y0 = e.clientY, v0 = k.v, step = PROPS.find((p) => p[0] === selKey.p)?.[2] || 0.01;
    let mode = null;
    T = k.t; frame(); drawInspector(); drawTimeline();
    move = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!mode) { if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) return; mode = Math.abs(dy) > Math.abs(dx) ? 'v' : 't'; }
      if (mode === 't') k.t = +snapTo(tAt(ev.clientX), ev, ks0.filter((o) => o !== k).map((o) => o.t)).toFixed(3);
      else k.v = +(v0 - dy * step * (ev.shiftKey ? 0.2 : 1)).toFixed(4);
      T = k.t; drawTimeline(); frame(); drawInspector();
    };
    done = () => { if (!mode) return; ks0.sort((a, b) => a.t - b.t); selKey.i = ks0.indexOf(k); changed(mode === 't' ? 'move keyframe' : 'keyframe value'); };
  } else if (hit || hitEnd) {
    // a hit: drag it to move it, or its end to change its length
    const h = L.clip.hits[+(hit || hitEnd).dataset.i], t0 = h.t, x0 = e.clientX;
    move = (ev) => {
      if (hitEnd) h.dur = +Math.max(0.05, Math.min(3, tAt(ev.clientX) - h.t)).toFixed(2);
      else h.t = +Math.max(0, Math.min(D0 - 0.05, snapTo(t0 + (ev.clientX - x0) * px, ev))).toFixed(3);
      drawTimeline();
    };
    done = () => changed(hitEnd ? 'hit length' : 'move hit');
  } else if (fxe) {
    // an effect's start / end: the time it shows
    const x = L.clip.effects.find((y) => y.id === fxe.dataset.id), side = fxe.dataset.fxedge;
    move = (ev) => {
      const t = +snapTo(tAt(ev.clientX), ev).toFixed(3);
      if (side === 'l') x.from = Math.min(t, (x.to ?? D0) - 0.05); else x.to = Math.max(t, (x.from ?? 0) + 0.05);
      if (x.from !== undefined && x.from <= 0.001) delete x.from;
      if (x.to !== undefined && x.to >= D0 - 0.001) delete x.to;
      drawTimeline(); frame();
    };
    done = () => changed('effect time');
  } else if (trim) {
    const c = L.clip, side = trim.dataset.trim, sp = c.speed || 1, in0 = c.in || 0, out0 = c.out, full = S.mediaById[c.mediaId]?.duration || 1e9;
    move = (ev) => {
      const dx = ((ev.clientX - e.clientX) / r.width) * D0;
      if (side === 'r') c.out = +Math.min(full, in0 + Math.max(0.2, D0 + dx) * sp).toFixed(3);
      else { c.in = +Math.max(0, Math.min(in0 + (D0 - 0.2) * sp, in0 + dx * sp)).toFixed(3); c.out = out0; }
      root.querySelector('[data-ldur]').textContent = `/ ${fmtT(durOf(L))}`;
    };
    done = () => changed(side === 'r' ? 'trim end' : 'trim start');
  } else if (cut) {
    move = (ev) => { L.clip.cutFx.dur = +Math.max(0.05, Math.min(3, tAt(ev.clientX))).toFixed(2); drawTimeline(); };
    done = () => changed('cut effect length');
  } else {
    if (e.target.closest('input, select, button')) return;
    move = (ev) => seek(tAt(ev.clientX));
    done = () => {};
    move(e);
  }
  e.preventDefault();
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); done(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

const fmtT = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
function seek(t) { const L = labOpen(); if (!L) return; T = Math.max(0, Math.min(L.dur, t)); frame(); drawInspector(true); }

export function draw() {
  if (!root) return;
  const all = Object.values(labs());
  if (!labOpen() && all.length) openId = all[all.length - 1].id;
  const L = labOpen();
  if (L) { L.dur = durOf(L); T = Math.min(T, L.dur); if (selKey && !L.clip.keys?.[selKey.p]?.[selKey.i]) selKey = null; }
  root.querySelector('[data-llist]').innerHTML = all.length ? all.map((x) => `<button class="lw-item${x.id === openId ? ' on' : ''}${picked.has(x.id) && x.id !== openId ? ' pk' : ''}" data-lid="${x.id}" title="Click: open · Ctrl / Shift + click: edit together"><i class="lw-sw"></i><span><b>${esc(x.name)}</b><small>${esc(templateNames(x.clip) || 'No template')} · ${(+x.dur).toFixed(1)} s${onTimeline(x.id).length ? '' : ' · not on the timeline'}</small></span></button>`).join('') : '<p class="lab-note">No Labs clips yet. Right-click a video clip on the timeline › Edit in Labs.</p>';
  root.querySelector('[data-lname]').textContent = L ? L.name : 'No Labs clip open';
  root.querySelector('[data-lhint]').innerHTML = L ? `${picked.size > 1 ? `<b>Editing ${targets().length} Labs clips together</b> (templates, effects, cut, speed ramp) · ` : 'Ctrl + click clips in the list to edit several together · '}Double-click a row: keyframe · Space plays · <button class="lab-link" data-l="rm">Delete this Labs edit</button>` : 'Right-click a video clip on the timeline › Edit in Labs. Its copy goes on V3 (yellow); edit it here.';
  root.querySelector('[data-l="update"]').disabled = !L;
  root.querySelector('[data-lframe]').classList.toggle('empty', !L);
  const v = root.querySelector('[data-lvid]'), m = L && S.mediaById[L.clip.mediaId], url = m?.urls?.play || '';
  if (v.dataset.src !== url) { v.src = url; v.dataset.src = url; }
  drawInspector(); drawTimeline(); frame();
}

// ---------------- inspector ----------------
function drawInspector(valuesOnly = false) {
  const el = root?.querySelector('[data-linsp]'), L = labOpen();
  if (!el) return;
  if (!L) { el.innerHTML = '<p class="lab-note">The settings of the open Labs clip appear here.</p>'; return; }
  const c = L.clip, num = (f, v, step = 0.01, attrs = '') => `<input type="number" data-f="${f}" value="${+(+v).toFixed(3)}" step="${step}" ${attrs}>`;
  if (valuesOnly) { // (the playhead moved: only the values at the new time)
    for (const [p] of PROPS) { const i = el.querySelector(`[data-f="val"][data-p="${p}"]`); if (i && document.activeElement !== i) i.value = +(+propAt(c, p, T) || 0).toFixed(3); }
    const h = el.querySelector('[data-at]'); if (h) h.textContent = `at ${fmtT(T)}`;
    return;
  }
  const k = selKey && c.keys?.[selKey.p]?.[selKey.i];
  const fx = (c.effects || []).map((x) => {
    const d = VFX[x.type]; if (!d) return '';
    const ps = Object.entries(d.params || {}).filter(([, p]) => p.min !== undefined).map(([pk, p]) => `<label class="lwi-f"><span>${esc(p.label)} <b>${+(x.p?.[pk] ?? p.def)}</b></span><input type="range" data-f="fxp" data-id="${x.id}" data-k="${pk}" min="${p.min}" max="${p.max}" step="${p.step || 0.01}" value="${x.p?.[pk] ?? p.def}"></label>`).join('');
    return `<div class="lwi-fx${x.on === false ? ' off' : ''}"><div class="lwi-fxh"><b>${esc(d.label)}</b><button class="lab-link" data-l="fxon" data-id="${x.id}">${x.on === false ? 'Turn on' : 'Turn off'}</button><button class="lab-link" data-l="rmfx" data-id="${x.id}">Remove</button></div>${ps}
      <div class="lwi-2"><label class="lwi-f"><span>From (s)</span><input type="number" data-f="fxfrom" data-id="${x.id}" value="${+(x.from ?? 0).toFixed(3)}" step="0.04" min="0"></label><label class="lwi-f"><span>To (s)</span><input type="number" data-f="fxto" data-id="${x.id}" value="${+(x.to ?? L.dur).toFixed(3)}" step="0.04" min="0"></label></div></div>`;
  }).join('');
  el.innerHTML = `
    <div class="lwi-sec"><h4>Clip</h4>
      <label class="lwi-f"><span>Name</span><input data-f="name" value="${esc(L.name)}"></label>
      <div class="lwi-2"><label class="lwi-f"><span>In (s)</span>${num('in', c.in || 0, 0.04, 'min="0"')}</label><label class="lwi-f"><span>Duration (s)</span>${num('dur', L.dur, 0.04, 'min="0.2"')}</label></div></div>
    ${k ? `<div class="lwi-sec lwi-key"><h4>Keyframe · ${esc(KEYABLE[selKey.p]?.label || selKey.p)}</h4>
      <div class="lwi-2"><label class="lwi-f"><span>Time (s)</span>${num('kt', k.t, 0.04, 'min="0"')}</label><label class="lwi-f"><span>Value</span>${num('kv', k.v, 0.01)}</label></div>
      <label class="lwi-f"><span>Ease to the next</span><select data-f="ke">${EASES.map(([v, l]) => `<option value="${v}"${(k.ease || '') === v || (k.ease === true && v === 'io') ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <button class="small danger" data-l="delkey">Delete keyframe</button></div>` : ''}
    <div class="lwi-sec"><h4>Motion <small data-at>at ${fmtT(T)}</small></h4>
      ${PROPS.map(([p, l, st]) => `<div class="lwi-prop"><span>${l}</span><input type="number" data-f="val" data-p="${p}" value="${+(+propAt(c, p, T) || 0).toFixed(3)}" step="${st}"><button class="icon-btn lwi-kb${c.keys?.[p]?.length ? ' on' : ''}" data-l="addkey" data-p="${p}" title="Keyframe at the playhead" aria-label="Add keyframe">${ic('diamond')}</button>${c.keys?.[p]?.length ? `<button class="lab-link" data-l="clrkeys" data-p="${p}" title="Remove its keyframes">Clear</button>` : '<span></span>'}</div>`).join('')}</div>
    <div class="lwi-sec"><h4>Speed</h4>
      <div class="lwi-2"><label class="lwi-f"><span>Speed</span>${num('speed', c.speed || 1, 0.05, 'min="0.1" max="8"')}</label>
      <label class="lwi-f"><span>Speed ramp</span><select data-f="ramp"><option value="">None</option>${Object.entries(RAMPS).map(([k2, r]) => `<option value="${k2}"${c.ramp === k2 ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label></div>
      <label class="chk"><input type="checkbox" data-f="smooth"${c.smooth ? ' checked' : ''}> Smooth slow motion (optical flow)</label></div>
    <div class="lwi-sec"><h4>Cut effect</h4>
      <label class="lwi-f"><span>On the cut in</span><select data-f="cut"><option value="">None</option>${Object.entries(CUTFX).map(([k2, x]) => `<option value="${k2}"${c.cutFx?.type === k2 ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
      ${c.cutFx ? `<label class="lwi-f"><span>Length <b>${(+c.cutFx.dur || CUTFX[c.cutFx.type]?.dur).toFixed(2)} s</b></span><input type="range" data-f="cutdur" min="0.05" max="3" step="0.05" value="${+c.cutFx.dur || CUTFX[c.cutFx.type]?.dur}"></label>` : ''}</div>
    <div class="lwi-sec"><h4>Hits <small>any moment</small></h4>
      <div class="lwi-2"><label class="lwi-f"><span>Kind</span><select data-f="hittype">${Object.entries(CUTFX).map(([k2, x]) => `<option value="${k2}"${k2 === hitType ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label><button class="small lwi-btn" data-l="addhit">+ Hit at ${fmtT(T)}</button></div>
      ${(c.hits || []).map((h, i) => `<div class="lwi-hit"><select data-f="hit-type" data-i="${i}">${Object.entries(CUTFX).map(([k2, x]) => `<option value="${k2}"${h.type === k2 ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select><input type="number" data-f="hit-t" data-i="${i}" value="${+h.t.toFixed(3)}" step="0.04" min="0" title="At (s)"><input type="number" data-f="hit-dur" data-i="${i}" value="${+(+h.dur || CUTFX[h.type]?.dur).toFixed(2)}" step="0.05" min="0.05" title="Length (s)"><button class="icon-btn" data-l="rmhit" data-i="${i}" aria-label="Remove hit">✕</button></div>`).join('') || '<p class="lab-note">Double-click the Hits row, or add one at the playhead.</p>'}</div>
    <div class="lwi-sec"><h4>Colour <button class="lab-link" data-l="colreset">Reset</button></h4>
      ${COLOR.map(([k2, l, mn, mx, st, z]) => { const v = c.color?.[k2] ?? z; return `<label class="lwi-f"><span>${l} <b>${+(+v).toFixed(2)}</b></span><input type="range" data-f="col" data-k="${k2}" min="${mn}" max="${mx}" step="${st}" value="${v}"></label>`; }).join('')}</div>
    <div class="lwi-sec"><h4>Effects</h4>${fx || '<p class="lab-note">None</p>'}
      <select data-f="addfx"><option value="">+ Add an effect…</option>${Object.entries(VFX).filter(([, d]) => !d.v2only && !d.stab).map(([k2, d]) => `<option value="${k2}">${esc(d.label)}</option>`).join('')}</select></div>`;
}

// ---------------- timeline ----------------
function drawTimeline() {
  const el = root?.querySelector('[data-ltl]'), L = labOpen();
  if (!el) return;
  if (!L) { el.innerHTML = ''; return; }
  const c = L.clip, D = L.dur, pct = (t) => `${Math.max(0, Math.min(100, (t / D) * 100)).toFixed(3)}%`;
  root.querySelector('[data-ldur]').textContent = `/ ${fmtT(D)}`;
  const ticks = [], step = D > 40 ? 10 : D > 16 ? 2 : D > 6 ? 1 : 0.5;
  for (let t = 0; t <= D + 1e-6; t += step) ticks.push(`<span style="left:${pct(t)}">${t % 1 ? t.toFixed(1) : t}s</span>`);
  const pts = rampPts(c), curve = pts ? (() => { const mx = Math.max(...pts.map((p) => p[1]), 1); return pts.map(([u, s]) => `${(u * 100).toFixed(2)},${(100 - (s / mx) * 86).toFixed(1)}`).join(' '); })() : '';
  const cfx = c.cutFx?.type && CUTFX[c.cutFx.type] ? { label: CUTFX[c.cutFx.type].label, d: +c.cutFx.dur || CUTFX[c.cutFx.type].dur } : null;
  const row = (name, body, attrs = '') => `<div class="lbt-row"><span class="lbt-name">${name}</span><div class="lbt-lane"${attrs}>${body}</div></div>`;
  // a property's curve over the clip, drawn under its keyframes
  const propRow = ([p, l]) => {
    const ks = c.keys?.[p] || [];
    let line = '';
    if (ks.length > 1) {
      const vals = Array.from({ length: 41 }, (_, i) => evalKeys(ks, (i / 40) * D)), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
      line = `<svg class="lbt-curve" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${vals.map((v, i) => `${(i * 2.5).toFixed(1)},${(88 - ((v - lo) / span) * 76).toFixed(1)}`).join(' ')}"/></svg>`;
    }
    return row(l, `${line}${ks.map((k, i) => `<em class="lbt-key${selKey?.p === p && selKey.i === i ? ' on' : ''}" data-key="${p}" data-i="${i}" style="left:${pct(k.t)}" title="${l}: ${+k.v.toFixed(3)} at ${fmtT(k.t)} - drag to move, click to edit"></em>`).join('')}${ks.length ? '' : '<small class="lbt-cap">Double-click to add a keyframe</small>'}`, ` data-prop="${p}"`);
  };
  const cw = el.clientWidth || 800, nw = parseFloat(getComputedStyle(el).getPropertyValue('--lbt-name')) || 96;
  el.innerHTML = `<div class="lbt" data-lanes style="width:${Math.round(nw + (cw - nw) * zoom)}px">
    <div class="lbt-row lbt-ruler"><span class="lbt-name"></span><div class="lbt-lane">${ticks.join('')}</div></div>
    ${row('Video', `<div class="lbt-clip"><i class="lbt-trim l" data-trim="l" title="Drag: the In point"></i><b>${esc(L.name)}</b>${c.tpl ? `<i class="lbt-tpl">${esc(templateNames(c))}</i>` : ''}<span class="lbt-len">${D.toFixed(2)} s</span><i class="lbt-trim r" data-trim="r" title="Drag: the duration"></i></div>`)}
    ${PROPS.map(propRow).join('')}
    ${row('Speed', pts ? `<svg class="lbt-curve" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${curve}"/></svg><small class="lbt-cap">${esc(RAMPS[c.ramp]?.label || 'Custom ramp')}</small>` : `<small class="lbt-cap">${c.speed && c.speed !== 1 ? `${c.speed}× all through` : 'Normal speed'}</small>`)}
    ${row('Hits', `${(c.hits || []).map((h, i) => `<div class="lbt-hit" data-hit data-i="${i}" style="left:${pct(h.t)};width:max(26px, ${pct(+h.dur || CUTFX[h.type]?.dur || 0.3)})" title="${esc(CUTFX[h.type]?.label || h.type)} at ${fmtT(h.t)} - drag to move"><span>${esc(CUTFX[h.type]?.label || h.type)}</span><i class="lbt-trim r" data-hitend data-i="${i}" title="Drag: its length"></i></div>`).join('')}${(c.hits || []).length ? '' : '<small class="lbt-cap">Double-click to add a hit (flash, shake, glitch…) at that moment</small>'}`, ' data-hits')}
    ${row('Cut', cfx ? `<div class="lbt-fx" style="width:${pct(cfx.d)}">${esc(cfx.label)}<i class="lbt-trim r" data-cutend title="Drag: its length"></i></div>` : '<small class="lbt-cap">None</small>')}
    ${(c.effects || []).length ? (c.effects || []).map((e) => row(esc(VFX[e.type]?.label || e.type), `<div class="lbt-efx${e.on === false ? ' off' : ''}" style="left:calc(${pct(e.from ?? 0)} + 2px);right:calc(${(100 - (((e.to ?? D) / D) * 100)).toFixed(3)}% + 2px)"><i class="lbt-trim l" data-fxedge="l" data-id="${e.id}" title="Drag: when it starts"></i><i class="lbt-trim r" data-fxedge="r" data-id="${e.id}" title="Drag: when it ends"></i><span>${esc(VFX[e.type]?.label || e.type)}${e.tpl ? ' · template' : ''}</span><button class="lab-link" data-l="fxon" data-id="${e.id}">${e.on === false ? 'On' : 'Off'}</button><button class="lab-link" data-l="rmfx" data-id="${e.id}" aria-label="Remove">✕</button></div>`)).join('') : row('Effects', '<small class="lbt-cap">None - add effects in the inspector (as many as you like)</small>')}
    <i class="lbt-ph" data-lph></i></div>`;
  drawPh();
}
function drawPh() {
  const ph = root?.querySelector('[data-lph]'), L = labOpen();
  if (ph && L) ph.style.left = `calc(var(--lbt-name) + (100% - var(--lbt-name)) * ${(T / L.dur).toFixed(4)})`;
  const tc = root?.querySelector('[data-ltc]'); if (tc) tc.textContent = fmtT(T);
}

// the preview frame at T: the shot at its (ramped) source time, with its Motion and effects
function frame() {
  if (!root) return;
  const L = labOpen(), v = root.querySelector('[data-lvid]'), fr = root.querySelector('[data-lframe]');
  drawPh();
  if (!L) return;
  const c = L.clip, src = sourceAt(c, T, L.dur);
  if (!playing && Math.abs((v.currentTime || 0) - src) > 0.04) { try { v.currentTime = src; } catch {} }
  const z = +propAt(c, 'transform.zoom', T) || 1, x = +propAt(c, 'transform.x', T) || 0, y = +propAt(c, 'transform.y', T) || 0, r = +propAt(c, 'transform.rotation', T) || 0;
  const ef = effectsCss(c, fr.clientWidth / 1920);
  v.style.transform = `translate(${x}%, ${y}%) rotate(${r}deg) scale(${z}) ${ef.transform || ''}`;
  const col = c.color || {}, cf2 = [];
  if (+col.exposure) cf2.push(`brightness(${Math.pow(2, +col.exposure).toFixed(3)})`);
  if ((col.contrast ?? 1) !== 1) cf2.push(`contrast(${col.contrast})`);
  if ((col.saturation ?? 1) !== 1 || +col.vibrance) cf2.push(`saturate(${((col.saturation ?? 1) * (1 + 0.5 * (+col.vibrance || 0))).toFixed(3)})`);
  if (+col.temp) cf2.push(col.temp > 0 ? `sepia(${(col.temp * 0.35).toFixed(2)})` : `hue-rotate(${(col.temp * -25).toFixed(0)}deg)`);
  const hp = fxPreview({ ...c, cutFx: undefined }, T); // (⚡ a hit at this moment)
  v.style.filter = [ef.filter, ...cf2, hp?.filter].filter(Boolean).join(' ');
  if (hp?.transform) v.style.transform += ` ${hp.transform}`;
  v.style.opacity = String(Math.max(0, Math.min(1, +propAt(c, 'opacity', T) ?? 1)));
  const cf = c.cutFx?.type, d = cf ? (+c.cutFx.dur || CUTFX[cf]?.dur || 0.3) : 0, ov = root.querySelector('[data-lov]');
  ov.style.background = hp?.overlay ? hp.overlay.background : ef.overlay || ''; ov.style.opacity = hp?.overlay ? String(hp.overlay.opacity ?? 1) : '1';
  if (cf && T < d) { const k = 1 - T / d; ov.style.background = cf === 'flash' || cf === 'strobe' ? `rgba(255,255,255,${k.toFixed(2)})` : cf === 'burn' || cf === 'leak' ? `radial-gradient(circle at 20% 30%, rgba(255,140,40,${(0.7 * k).toFixed(2)}), transparent 70%)` : ef.overlay || ''; }
}
function toggle() {
  const L = labOpen(), v = root.querySelector('[data-lvid]'), b = root.querySelector('[data-l="play"]');
  if (!L) return;
  playing = !playing; b.innerHTML = ic(playing ? 'pause' : 'play');
  if (!playing) { cancelAnimationFrame(raf); v.pause(); drawInspector(true); return; }
  if (T >= L.dur - 0.05) T = 0;
  let last = performance.now();
  v.currentTime = sourceAt(L.clip, T, L.dur); v.play().catch(() => {});
  const tick = (now) => {
    if (!playing) return;
    T += (now - last) / 1000; last = now;
    if (T >= L.dur) { T = 0; v.currentTime = sourceAt(L.clip, 0, L.dur); }
    // a ramp changes the speed as it goes: the video's rate follows it (and is pulled back when it drifts)
    const want = sourceAt(L.clip, T, L.dur), ahead = sourceAt(L.clip, Math.min(L.dur, T + 0.1), L.dur);
    v.playbackRate = Math.max(0.0625, Math.min(16, (ahead - want) / 0.1 || 1));
    if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
    frame(); raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
export function stopLabs() { if (playing) toggle(); }
export { LAB_FIELDS };
