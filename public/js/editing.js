// ✂ Premiere editing extras: Nudge (Alt+← / →, Alt+Shift = 5 frames), typed timecode (click the timeline's timecode:
// go to a time, or +15 / -1:00 moves the selected clips / the playhead), Group / Ungroup (Ctrl+G / Ctrl+Shift+G) and
// Replace Edit (the selected clip takes the clip open in the Source monitor from its In, same place and length).
import { S, emit, commit, layout, findClip, saveNow } from './store.js';
import { api, enc, watchJob } from './api.js';
import { uid, parseTC, fmtTC, clipDur, rampPts, syncShift } from './model.js';
import { toast, modal } from './ui.js';
import { gapClip, tidyGaps } from './timeline.js';
import { replaceClip } from './replace.js';
import { sourceMediaId } from './player.js';
import { srcMonOn, sourceState } from './sourcemon.js';

const fps = () => S.project.settings.fps || 30;
const r3 = (x) => +x.toFixed(3);

// ---- ⇆ Nudge ----
// a main-story (V1) clip moves into the gap beside it (the gap on the other side grows) - the story never closes up or
// slides, like everything else here; with no gap on that side it stays and says so. Other tracks: the clip just moves.
function nudgeV1(c, d) {
  const V1 = S.project.tracks.V1, i = V1.indexOf(c), prev = V1[i - 1], next = V1[i + 1];
  if (c.transitionIn || next?.transitionIn) return 'it has a transition';
  if (d > 0) {
    if (next && !(next.gap && next.dur >= d - 0.001)) return 'no gap after it';
    if (next) { next.dur = r3(next.dur - d); if (next.dur < 0.04) V1.splice(i + 1, 1); }
    if (prev?.gap) prev.dur = r3(prev.dur + d); else V1.splice(i, 0, gapClip(d));
  } else {
    const a = -d;
    if (!prev?.gap || prev.dur < a - 0.001) return 'no gap before it';
    prev.dur = r3(prev.dur - a); if (prev.dur < 0.04) V1.splice(i - 1, 1);
    const j = V1.indexOf(c);
    if (V1[j + 1]?.gap) V1[j + 1].dur = r3(V1[j + 1].dur + a); else if (V1[j + 1]) V1.splice(j + 1, 0, gapClip(a));
  }
  return null;
}
export function nudgeSelected(frames) {
  if (S.page !== 'edit') return; // (the key is still kept from the browser - Alt+← would leave the editor)
  if (!S.sel.size) return toast('Select clips first - Alt+← / → nudges them a frame (Alt+Shift: 5 frames)');
  const ts = S.project.trackState, sel = [...S.sel].map((id) => findClip(id)).filter((f) => f && !f.clip.gap && !f.clip.locked && !ts[f.track]?.lock); // (🔒 locked clips stay)
  const v1Links = new Set(sel.filter((f) => f.track === 'V1').map((f) => f.clip.link).filter(Boolean));
  const free = sel.filter((f) => f.track !== 'V1' && !(f.clip.link && v1Links.has(f.clip.link))); // (a V1 picture's sound follows it)
  let d = frames / fps();
  if (free.length) d = Math.max(d, -Math.min(...free.map((f) => f.clip.start || 0))); // (none goes before 0; all move as one)
  if (Math.abs(d) < 1e-4) return toast('Already at the start');
  for (const f of free) f.clip.start = r3((f.clip.start || 0) + d);
  const v1 = sel.filter((f) => f.track === 'V1').map((f) => f.clip).sort((a, b) => (S.project.tracks.V1.indexOf(a) - S.project.tracks.V1.indexOf(b)) * (d > 0 ? -1 : 1));
  const fails = v1.map((c) => nudgeV1(c, d)).filter(Boolean);
  tidyGaps();
  if (!free.length && fails.length === v1.length) return toast(`This main-story clip cannot move: ${fails[0]} (drag it, or make room first)`);
  S.linkLead = free.length === 1 ? free[0].clip.id : null; // (one sound nudged on its own: its picture follows it)
  commit('Nudge', 'nudge');
  const n = Math.round(d * fps());
  toast(`Moved ${n > 0 ? '+' : ''}${n} frame${Math.abs(n) === 1 ? '' : 's'}${fails.length ? ` (a main-story clip stayed: ${fails[0]})` : ''}`);
}

// ---- ⌨ typed timecode ----
export function typeTimecode(span) {
  if (!S.project || span.parentElement.querySelector('.tl-tcin')) return;
  const inp = document.createElement('input');
  inp.className = 'tl-tcin'; inp.value = span.textContent; inp.spellcheck = false;
  inp.setAttribute('aria-label', 'Timecode: where to go, or +15 / -1:00 to move');
  span.hidden = true; span.after(inp); inp.select();
  let closed = false;
  const done = (go) => {
    if (closed) return; // (removing the field fires its blur - that must not close it a second time)
    closed = true;
    const v = inp.value; inp.remove(); span.hidden = false;
    if (go) applyTimecode(v);
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation(); // (the editor's keys stay out of the field)
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    if (e.key === 'Escape') { e.preventDefault(); done(false); }
  });
  inp.addEventListener('blur', () => done(false));
}
export function applyTimecode(v) {
  const p = parseTC(v, fps());
  if (!p) return toast('Not a timecode - e.g. 1:10:00, 11000, +15 (frames) or -1:00', 'err');
  if (!p.rel) { emit('seek', p.sec); return toast(`▶ ${fmtTC(p.sec, fps())}`); }
  const frames = Math.round(p.sec * fps()) * p.rel;
  if (S.sel.size) return nudgeSelected(frames);
  emit('seek', Math.max(0, S.playhead + frames / fps()));
}

// ---- ⛓ Group ----
export function groupSelected() {
  const ids = [...S.sel].filter((id) => { const c = findClip(id)?.clip; return c && !c.gap; });
  if (ids.length < 2) return toast('Select two or more clips, then Ctrl+G groups them');
  const g = uid();
  for (const id of ids) findClip(id).clip.grp = g;
  commit(`Group ${ids.length} clips`);
  toast(`⛓ ${ids.length} clips grouped - a click on one selects them all (Alt + click: just that one)`);
}
export function ungroupSelected() {
  let n = 0;
  for (const id of S.sel) { const c = findClip(id)?.clip; if (c?.grp) { delete c.grp; n++; } }
  if (!n) return toast('The selected clips are not grouped');
  commit('Ungroup'); toast(`⛓ ${n} clip${n > 1 ? 's' : ''} ungrouped`);
}

// ---- ⇤ Gaps (Sequence › Close Gap, Go to next / previous gap) ----
// every empty stretch of the main story closes up - the story after each moves back by its length (⇋ sync-locked
// tracks with it); with In / Out marked, only the gaps between them
export function closeAllGaps() {
  const rg = S.project.settings.range, a = rg?.in ?? 0, b = rg?.out ?? Infinity;
  const gaps = layout().V1.filter((x) => x.clip.gap && x.start >= a - 0.01 && x.end <= b + 0.01);
  if (!gaps.length) return toast(rg ? 'No gaps between In and Out' : 'No gaps on the main story');
  let secs = 0;
  for (const x of [...gaps].sort((p, q) => q.start - p.start)) {
    const V1 = S.project.tracks.V1, i = V1.indexOf(x.clip); if (i < 0) continue;
    V1.splice(i, 1); syncShift(S.project, x.end, -(x.end - x.start)); secs += x.end - x.start;
  }
  commit(`Close ${gaps.length} gap${gaps.length > 1 ? 's' : ''}`);
  toast(`⇤ ${gaps.length} gap${gaps.length > 1 ? 's' : ''} closed (${secs.toFixed(1)} s) - the story moved up`);
}
export function goGap(dir) {
  const ts = Object.values(layout()).flatMap((l) => l.filter((x) => x.clip.gap).map((x) => x.start)).sort((a, b) => a - b);
  // (an empty stretch on an overlay track counts too: from the end of one clip to the start of the next)
  for (const l of Object.entries(layout()).filter(([t]) => t !== 'V1').map(([, l]) => [...l].sort((a, b) => a.start - b.start)))
    for (let i = 1; i < l.length; i++) if (l[i].start - l[i - 1].end > 0.05) ts.push(l[i - 1].end);
  ts.sort((a, b) => a - b);
  const t = dir < 0 ? [...ts].reverse().find((x) => x < S.playhead - 0.01) : ts.find((x) => x > S.playhead + 0.01);
  if (t === undefined) return toast(dir < 0 ? 'No gap before the playhead' : 'No gap after the playhead');
  emit('seek', t);
}

// ---- 📍 Clip markers: a marker inside a clip (clip.markers: [{ t, name }] - t from the clip's start), it moves, gets
// trimmed and split with the clip; M adds a sequence marker as before ----
export function addClipMarker() {
  const ids = [...S.sel].filter((id) => !findClip(id)?.clip.gap);
  const L = layout(), hits = [];
  for (const [tr, list] of Object.entries(L)) for (const x of list) if (ids.includes(x.clip.id) && S.playhead >= x.start - 0.001 && S.playhead <= x.end + 0.001) hits.push(x);
  if (!hits.length) return toast('Select a clip and put the playhead over it, then add a clip marker');
  const name = prompt('Clip marker name (optional)', '') ?? null;
  if (name === null) return;
  for (const x of hits) (x.clip.markers ||= []).push({ t: r3(S.playhead - x.start), ...(name.trim() ? { name: name.trim().slice(0, 80) } : {}) });
  commit('Clip marker'); toast(`📍 Clip marker at ${fmtTC(S.playhead, fps())}${hits.length > 1 ? ` on ${hits.length} clips` : ''}`);
}
export function clearClipMarkers() {
  let n = 0;
  for (const id of S.sel) { const c = findClip(id)?.clip; if (c?.markers?.length) { n += c.markers.length; delete c.markers; } }
  if (!n) return toast('The selected clips have no clip markers');
  commit('Remove clip markers'); toast(`${n} clip marker${n > 1 ? 's' : ''} removed`);
}

// ---- 📷 Export Frame (Ctrl+Shift+E): the frame at the playhead, exactly as the export makes it (effects, titles,
// colour), as a PNG in the project's output folder; it can go into Media too ----
export async function exportFrame() {
  if (!S.project) return;
  const t = +S.playhead.toFixed(3);
  emit('job', { running: true, label: '📷 Making the frame…' });
  try {
    await saveNow();
    const j = await api('POST', `/api/frame?p=${enc(S.proj)}`, { t, seq: S.seqMap?.mine });
    const r = (await watchJob(j.id)).result;
    const d = modal('📷 Export Frame', `<img src="${r.url}" alt="" style="width:100%;max-height:60vh;object-fit:contain;background:#000;border-radius:6px">
      <p class="muted small">${fmtTC(t, fps())} · ${r.width}×${r.height} · saved as <b>${r.name}</b> (project › output › frames)</p>
      <div class="dlg-actions"><a class="btn" href="${r.url}" download="${r.name}">⬇ Download</a><button data-action="import">➕ Add to Media</button><button data-close>Close</button></div>`, {
      width: 720,
      onAction: async (a) => { if (a !== 'import') return; try { await api('POST', `/api/frame/import?p=${enc(S.proj)}`, { name: r.name }); (await import('./mediapool.js')).refreshMedia(); toast('➕ The frame is in Media'); d.close(); } catch (e) { toast(e.message, 'err'); } } });
  } catch (e) { toast(e.job ? `Export Frame failed: ${e.job.log.slice(-1).join(' ')}` : e.message, 'err'); }
  finally { emit('job', { running: false }); }
}

// ---- 🔄 Replace Edit ----
// Premiere's Replace with Clip > From Source Monitor: the clip keeps its place, length, effects and motion; its picture
// comes from the Source monitor's clip, starting at its In (no In: the frame it shows). Nothing selected: the main-story
// shot under the playhead.
export async function replaceEdit(id = null) {
  if (!id) {
    const one = S.sel.size === 1 ? [...S.sel][0] : null;
    id = one && findClip(one)?.clip.mediaId ? one : layout().V1.filter((x) => S.playhead >= x.start && S.playhead < x.end && !x.clip.gap).pop()?.clip.id;
  }
  const c = id && findClip(id)?.clip;
  if (!c?.mediaId) return toast('Select the clip on the timeline to replace (or put the playhead over a shot)', 'err');
  const st = srcMonOn() ? sourceState() : null, mid = st?.id || sourceMediaId(), m = mid && S.mediaById[mid];
  if (!m) return toast('First open the new clip in the Source monitor (double-click it in Media) and mark its In', 'err');
  if (c.type === 'audio' ? !(m.kind === 'audio' || (m.kind === 'video' && m.hasAudio)) : m.kind === 'audio') return toast(c.type === 'audio' ? 'A sound clip takes a sound or a video with sound' : 'A picture takes a video or a photo', 'err');
  if (rampPts(c) && m.kind === 'image') return toast('A speed-ramped shot takes a video', 'err');
  const inPoint = m.kind === 'image' ? null : S.sourceMarks?.[mid]?.in ?? st?.t ?? 0;
  const L = clipDur(c, S.mediaById);
  if (await replaceClip(id, mid, { inPoint })) toast(`🔄 Replaced with ${m.name}${m.kind === 'image' ? '' : ` from ${fmtTC(inPoint, m.fps || fps())}`} (${L.toFixed(2)} s, same place)`);
}
