// 🧪 Labs clips (Phase 22, like Motion comps / Fusions): right-click a video clip > Edit in Labs - a copy of it is laid
// exactly over it on V3 or above (yellow on the timeline, muted: the sound stays with the clip below). Its Labs edit
// (motion template, speed ramp, cut effect, effects) is a draft in project.labs[id] that the Labs page changes, shows on
// its own preview + timeline, and puts on the timeline with Update on timeline - every clip of that Labs edit at once.
// Double-click the yellow clip to open it in Labs. Nothing about Labs is in Effect Controls.
import { S, commit, emit, findClip, layout } from './store.js';
import { uid, clipDur, compTrack, sourceAt, propAt, RAMPS, rampPts } from './model.js';
import { effectsCss } from './effects.js';
import { CUTFX } from './fx.js';
import { esc, toast } from './ui.js';
import { TEMPLATES, templateById, applyTemplate, clearTemplate } from './aitemplates.js';

// what a Labs edit changes on its clip (the rest - start, track, In / Out - belongs to the timeline)
const LAB_FIELDS = ['keys', 'ramp', 'rampPts', 'smooth', 'cutFx', 'effects', 'tpl', 'out'];
const labs = () => (S.project.labs ||= {});
let openId = null, T = 0, playing = false, raf = 0, root = null;
export const labOpen = () => (openId && labs()[openId]) || null;

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
  openId = id; T = 0;
  emit('gotoPage', 'ai');
  return id;
}
export function openLabsClip(c) {
  if (!c?.labsId) return;
  // a Labs clip copied from another project: its edit comes from the clip itself
  if (!labs()[c.labsId]) { labs()[c.labsId] = { id: c.labsId, name: S.mediaById[c.mediaId]?.name || 'Labs', dur: clipDur(c, S.mediaById), clip: JSON.parse(JSON.stringify(c)) }; commit('Bring back Labs edit'); }
  openId = c.labsId; T = 0;
  emit('gotoPage', 'ai');
}

// templates and their removal work on the open Labs edit (the draft)
export function labTemplate(t) {
  const L = labOpen(); if (!L) return false;
  if (t.video && L.clip.type !== 'video') { toast(`${t.label} needs a video clip`, 'err'); return true; }
  applyTemplate(L.clip, t, L.dur, S.mediaById);
  commit(`Labs: ${t.label}`); draw();
  toast(`${t.label} - press Update on timeline to put it on the edit`);
  return true;
}
export function labClear() {
  const L = labOpen(); if (!L) return false;
  if (clearTemplate(L.clip, L.dur, S.mediaById)) { commit('Labs: remove template'); draw(); }
  return true;
}
// the draft onto every clip of this Labs edit (their place on the timeline stays)
export function labUpdate() {
  const L = labOpen(); if (!L) return;
  const there = onTimeline(L.id);
  for (const { x } of there) {
    for (const k of LAB_FIELDS) { if (L.clip[k] === undefined) delete x[k]; else x[k] = JSON.parse(JSON.stringify(L.clip[k])); }
  }
  commit(`Update Labs edit "${L.name}" on the timeline`);
  S.sel = new Set(there.map((p) => p.x.id)); emit('select');
  toast(there.length ? `"${L.name}" updated on ${[...new Set(there.map((p) => p.t))].join(', ')}` : 'This Labs edit is not on the timeline any more');
  draw();
}

// ---------------- the workspace on the Labs page: clips list · preview · timeline ----------------
export function labsWorkHTML() {
  return `<section class="lab-work" data-work>
    <div class="lab-sec-h"><div><span class="lab-kicker">Labs timeline</span><h2 data-lname>No Labs clip open</h2></div>
      <p class="lab-note" data-lhint>Right-click a video clip on the timeline › Edit in Labs. Its copy goes on V3 (yellow); edit it here.</p>
      <button class="primary" data-l="update" disabled>Update on timeline</button></div>
    <div class="lw-grid">
      <aside class="lw-list" data-llist></aside>
      <div class="lw-stage"><div class="lw-frame" data-lframe><video muted playsinline preload="auto" data-lvid></video><div class="lw-ov" data-lov></div></div>
        <div class="lw-tr"><button class="icon-btn" data-l="play" aria-label="Play">▶</button><span class="mono lw-tc" data-ltc>0:00.0</span></div></div>
    </div>
    <div class="lw-tl" data-ltl></div>
  </section>`;
}
export function mountLabsWork(el) {
  root = el;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-l]'), it = e.target.closest('[data-lid]');
    if (it) { openId = it.dataset.lid; T = 0; draw(); return; }
    if (!b) return;
    if (b.dataset.l === 'update') labUpdate();
    if (b.dataset.l === 'play') toggle();
    if (b.dataset.l === 'rm') { const L = labOpen(); if (L && confirm(`Delete the Labs edit "${L.name}"? Its clips stay on the timeline as they are.`)) { for (const { x } of onTimeline(L.id)) delete x.labsId; delete labs()[L.id]; openId = null; commit('Delete Labs edit'); draw(); } }
  });
  // the Labs timeline: click / drag to move its playhead
  el.addEventListener('pointerdown', (e) => {
    const lane = e.target.closest('[data-lanes]'); if (!lane) return;
    const seek = (ev) => { const r = lane.getBoundingClientRect(), L = labOpen(); if (!L) return; T = Math.max(0, Math.min(L.dur, ((ev.clientX - r.left) / r.width) * L.dur)); frame(); };
    seek(e); const mv = (ev) => seek(ev), up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
}

export function draw() {
  if (!root) return;
  const all = Object.values(labs()), L = labOpen();
  if (!L && all.length) openId = all[all.length - 1].id;
  const cur = labOpen();
  root.querySelector('[data-llist]').innerHTML = all.length ? all.map((x) => `<button class="lw-item${x.id === openId ? ' on' : ''}" data-lid="${x.id}"><i class="lw-sw"></i><span><b>${esc(x.name)}</b><small>${x.clip.tpl ? esc(templateById(x.clip.tpl.id)?.label || '') : 'No template yet'} · ${x.dur.toFixed(1)} s · ${onTimeline(x.id).length ? 'on the timeline' : 'not on the timeline'}</small></span></button>`).join('') : '<p class="lab-note">No Labs clips yet.</p>';
  root.querySelector('[data-lname]').textContent = cur ? cur.name : 'No Labs clip open';
  root.querySelector('[data-lhint]').innerHTML = cur ? `Pick a motion template below, then <b>Update on timeline</b>. <button class="lab-link" data-l="rm">Delete this Labs edit</button>` : 'Right-click a video clip on the timeline › Edit in Labs. Its copy goes on V3 (yellow); edit it here.';
  root.querySelector('[data-l="update"]').disabled = !cur;
  root.querySelector('[data-lframe]').classList.toggle('empty', !cur);
  const v = root.querySelector('[data-lvid]'), m = cur && S.mediaById[cur.clip.mediaId], url = m?.urls?.play || '';
  if (v.dataset.src !== url) { v.src = url; v.dataset.src = url; }
  drawTimeline(); frame();
}

// the Labs edit's own timeline: video (with its keyframes), speed (the ramp curve), cut effect, effects
function drawTimeline() {
  const el = root.querySelector('[data-ltl]'), L = labOpen();
  if (!L) { el.innerHTML = ''; return; }
  const c = L.clip, D = L.dur, pct = (t) => `${Math.max(0, Math.min(100, (t / D) * 100)).toFixed(2)}%`;
  const ticks = []; const step = D > 20 ? 5 : D > 8 ? 2 : 1;
  for (let t = 0; t <= D + 1e-6; t += step) ticks.push(`<span style="left:${pct(t)}">${t}s</span>`);
  const keyT = [...new Set(Object.values(c.keys || {}).flat().map((k) => +k.t.toFixed(2)))];
  const pts = rampPts(c), curve = pts ? (() => { const mx = Math.max(...pts.map((p) => p[1]), 1); return pts.map(([u, s]) => `${(u * 100).toFixed(2)},${(100 - (s / mx) * 86).toFixed(1)}`).join(' '); })() : '';
  const cfx = c.cutFx?.type && CUTFX[c.cutFx.type] ? { label: CUTFX[c.cutFx.type].label, d: +c.cutFx.dur || CUTFX[c.cutFx.type].dur } : null;
  const fx = (c.effects || []).filter((e) => e.on !== false);
  const row = (name, body) => `<div class="lbt-row"><span class="lbt-name">${name}</span><div class="lbt-lane">${body}</div></div>`;
  el.innerHTML = `<div class="lbt" data-lanes>
    <div class="lbt-row lbt-ruler"><span class="lbt-name"></span><div class="lbt-lane">${ticks.join('')}</div></div>
    ${row('Video', `<div class="lbt-clip"><b>${esc(L.name)}</b>${c.tpl ? `<i>${esc(templateById(c.tpl.id)?.label || '')}</i>` : ''}</div>${keyT.map((t) => `<em class="lbt-key" style="left:${pct(t)}"></em>`).join('')}`)}
    ${row('Speed', pts ? `<svg class="lbt-curve" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${curve}"/></svg><small class="lbt-cap">${esc(RAMPS[c.ramp]?.label || 'Custom ramp')}</small>` : '<small class="lbt-cap">Normal speed</small>')}
    ${row('Cut', cfx ? `<div class="lbt-fx" style="width:${pct(cfx.d)}">${esc(cfx.label)}</div>` : '<small class="lbt-cap">None</small>')}
    ${row('Effects', fx.length ? `<div class="lbt-chips">${fx.map((e) => `<span>${esc(e.type)}</span>`).join('')}</div>` : '<small class="lbt-cap">None</small>')}
    <i class="lbt-ph" data-lph></i></div>`;
}

// the preview frame at T: the shot at its (ramped) source time, with the template's Motion and effects
function frame() {
  if (!root) return;
  const L = labOpen(), v = root.querySelector('[data-lvid]'), fr = root.querySelector('[data-lframe]'), ph = root.querySelector('[data-lph]');
  root.querySelector('[data-ltc]').textContent = `${Math.floor(T / 60)}:${(T % 60).toFixed(1).padStart(4, '0')}`;
  if (ph && L) ph.style.left = `calc(var(--lbt-name) + (100% - var(--lbt-name)) * ${(T / L.dur).toFixed(4)})`;
  if (!L) return;
  const c = L.clip, src = sourceAt(c, T, L.dur);
  if (!playing && Math.abs((v.currentTime || 0) - src) > 0.04) { try { v.currentTime = src; } catch {} }
  const z = +propAt(c, 'transform.zoom', T) || 1, x = +propAt(c, 'transform.x', T) || 0, y = +propAt(c, 'transform.y', T) || 0, r = +propAt(c, 'transform.rotation', T) || 0;
  const ef = effectsCss(c, fr.clientWidth / 1920);
  v.style.transform = `translate(${x}%, ${y}%) rotate(${r}deg) scale(${z}) ${ef.transform || ''}`;
  v.style.filter = ef.filter || '';
  // the cut effect: a flash / dip over the first moments of the clip
  const cf = c.cutFx?.type, d = cf ? (+c.cutFx.dur || CUTFX[cf]?.dur || 0.3) : 0, ov = root.querySelector('[data-lov]');
  ov.style.background = ef.overlay || ''; ov.style.opacity = '1';
  if (cf && T < d) { const k = 1 - T / d; ov.style.background = cf === 'flash' || cf === 'strobe' ? `rgba(255,255,255,${k.toFixed(2)})` : cf === 'burn' || cf === 'leak' ? `radial-gradient(circle at 20% 30%, rgba(255,140,40,${(0.7 * k).toFixed(2)}), transparent 70%)` : ef.overlay || ''; }
}
function toggle() {
  const L = labOpen(), v = root.querySelector('[data-lvid]'), b = root.querySelector('[data-l="play"]');
  if (!L) return;
  playing = !playing; b.textContent = playing ? '⏸' : '▶';
  if (!playing) { cancelAnimationFrame(raf); v.pause(); return; }
  if (T >= L.dur - 0.05) T = 0;
  let last = performance.now();
  v.currentTime = sourceAt(L.clip, T, L.dur); v.play().catch(() => {});
  const tick = (now) => {
    if (!playing) return;
    T += (now - last) / 1000; last = now;
    if (T >= L.dur) { T = 0; v.currentTime = sourceAt(L.clip, 0, L.dur); }
    // a ramp changes the speed as it goes: the video's rate follows it (and is pulled back when it drifts)
    const want = sourceAt(L.clip, T, L.dur), ahead = sourceAt(L.clip, Math.min(L.dur, T + 0.1), L.dur);
    v.playbackRate = Math.max(0.0625, Math.min(16, (ahead - want) / 0.1));
    if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
    frame(); raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
export function stopLabs() { if (playing) toggle(); }
export { LAB_FIELDS, TEMPLATES };
