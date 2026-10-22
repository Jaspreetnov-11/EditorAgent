// 🎞 Sequences: several timelines in one project (Full film, Teaser 30s, Reel…). Open one, make a new one (empty or a
// copy of this edit, as a version), rename / delete, and nest one inside another as a single clip (rendered once,
// re-rendered when that sequence changes). The data model is in model.js (seqList / openSeq / seqHash).
import { S, on, emit, commit, saveNow, openMySeq, sharedSeqId, sendPresence, adoptShared, layout } from './store.js';
import { api, enc, watchJob } from './api.js';
import { ASPECTS, newProject, seqOf, seqList, openSeq, seqData, seqHash, totalDuration, fmt, uid, linkedIds, relink, syncLinked, linkAudioOf } from './model.js';
import { $, $$, esc, toast, modal } from './ui.js';
import { refreshMedia } from './mediapool.js';
import { placeMedia } from './timeline.js';
import { copyTimeline, pasteTimeline, pasteOffer } from './clipboard.js';

export const seqName = () => (S.project ? seqOf(S.project).name : '');

// nested copies (media made from a sequence) whose sequence has changed since they were rendered
export function staleNested() {
  if (!S.project) return [];
  const byId = Object.fromEntries(seqList(S.project).map((x) => [x.id, x]));
  return S.media.filter((m) => m.seqOf && byId[m.seqOf] && m.seqHash !== seqHash(byId[m.seqOf].data));
}
// nested copies used on the open timeline
const usedHere = (list) => { const ids = new Set(Object.values(S.project.tracks).flat().map((c) => c.mediaId)); return list.filter((m) => ids.has(m.id)); };

// 🎞 opening a sequence changes only this browser's timeline (Phase 16): everyone else stays on theirs. The team's
// shared sequence (👥) is the one Claude, the Agent's server jobs and edtool work on.
function switchTo(id) {
  const s = seqList(S.project).find((x) => x.id === id);
  if (!s || s.open) return;
  if (!openMySeq(id)) return toast('That sequence no longer exists', 'err');
  S.sel.clear(); S.playhead = 0;
  emit('seq'); emit('fit'); emit('select'); emit('change', {}); sendPresence();
  toast(id === sharedSeqId() ? `Opened the team's main timeline "${s.name}"` : `Opened "${s.name}" - just for you. Everyone else stays on their own timeline.`);
}
on('seqBlocked', () => toast("This change can't be made from here: open the team's main sequence first, then change it.", 'err'));
on('seqGone', () => { toast("Someone deleted the sequence you had open - showing the team's main timeline.", 'err'); emit('seq'); emit('fit'); });

const freeName = (base) => { const names = new Set(seqList(S.project).map((x) => x.name)); let n = base, k = 2; while (names.has(n)) n = `${base} (${k++})`; return n; };

// new sequence: empty, or a copy of the open one (a version to try something on), in any frame shape
function addSeq(name, aspect, copy) {
  const id = uid();
  let data;
  if (copy) { data = seqData(S.project); data.settings.aspect = aspect; }
  else {
    const blank = newProject(name, { aspect, fps: S.project.settings.fps });
    data = { tracks: blank.tracks, trackState: blank.trackState, markers: [], subtitles: blank.subtitles, settings: { ...S.project.settings, aspect } };
  }
  (S.project.sequences ||= {})[id] = { name, data, modified: Date.now() };
  commit(`New sequence ${name}`);
  switchTo(id);
}

// 🎯 Auto Reframe Sequence: a copy of the open sequence in another frame shape (it opens)
export const copySequenceAs = (aspect) => addSeq(freeName(`${seqOf(S.project).name} ${aspect}`), aspect, true);

// 🎞 New Sequence From Clip, like Premiere: a sequence shaped like the file (frame shape and rate) with the chosen
// files on it, in order; it opens. A file's own sound comes along as usual.
export function newSequenceFromClip(ids) {
  const ms = ids.map((id) => S.mediaById[id]).filter((m) => m && m.kind !== 'audio' && m.status !== 'offline');
  if (!ms.length) return toast('Pick a video or a photo in Media');
  const m = ms[0], turn = Math.abs(+m.rotation || 0) % 180 === 90, w = turn ? m.height : m.width, h = turn ? m.width : m.height;
  const r = w > 0 && h > 0 ? w / h : 16 / 9;
  const aspect = Object.entries(ASPECTS).sort((a, b) => Math.abs(a[1][0] / a[1][1] - r) - Math.abs(b[1][0] / b[1][1] - r))[0][0];
  // (high-speed camera files - 100 / 120 fps, for slow motion - go on a normal-rate sequence, as an edit would use them)
  const fps = m.kind === 'video' && m.fps > 0 && m.fps <= 61 ? Math.round(m.fps) : S.project.settings.fps;
  const name = freeName(String(m.name || 'Sequence').replace(/\.[^.]+$/, '')), id = uid(), blank = newProject(name, { aspect, fps });
  (S.project.sequences ||= {})[id] = { name, data: { tracks: blank.tracks, trackState: blank.trackState, markers: [], subtitles: blank.subtitles, settings: { ...S.project.settings, aspect, fps } }, modified: Date.now() };
  commit(`New sequence ${name}`);
  switchTo(id);
  for (const x of ms) placeMedia(x.id, 'V1', 1e9, {});
  commit(`${ms.length} clip${ms.length > 1 ? 's' : ''} into ${name}`);
  toast(`New sequence "${name}" (${aspect}, ${fps} fps) from ${ms.length > 1 ? `${ms.length} clips` : m.name}`);
}

// a new sequence holding these main-story clips (📝 Text page: rough cut from chosen sentences); it opens
export function newSequenceWith(name, V1) {
  const id = uid(), blank = newProject(name, { aspect: S.project.settings.aspect, fps: S.project.settings.fps });
  blank.tracks.V1 = V1;
  (S.project.sequences ||= {})[id] = { name: freeName(name), data: { tracks: blank.tracks, trackState: blank.trackState, markers: [], subtitles: blank.subtitles, settings: { ...S.project.settings } }, modified: Date.now() };
  commit(`New sequence ${name}`);
  switchTo(id);
  return id;
}

// a sequence that (through nested copies) already contains `id` cannot be nested into `id`
function contains(data, id, seen = new Set()) {
  for (const c of Object.values(data?.tracks || {}).flat()) {
    const m = S.mediaById[c.mediaId];
    if (!m?.seqOf || seen.has(m.seqOf)) continue;
    if (m.seqOf === id) return true;
    seen.add(m.seqOf);
    const inner = seqList(S.project).find((x) => x.id === m.seqOf);
    if (inner && contains(inner.data, id, seen)) return true;
  }
  return false;
}

// render a sequence into its nested copy (made or refreshed); resolves the media id
async function renderNested(id, onTick) {
  await saveNow();
  const job = await api('POST', `/api/seq/render?p=${enc(S.proj)}`, { seq: id });
  const j = await watchJob(job.id, onTick);
  await refreshMedia();
  return j.result;
}

async function nest(id) {
  const s = seqList(S.project).find((x) => x.id === id), cur = seqOf(S.project);
  if (!s || s.open) return;
  if (contains(s.data, cur.id)) return toast(`"${s.name}" already has "${cur.name}" inside it - nesting it here would loop`, 'err');
  if (!Object.values(s.data.tracks || {}).flat().length) return toast(`"${s.name}" is empty`, 'err');
  emit('job', { running: true, label: `Nesting ${s.name}…` });
  try {
    const r = await renderNested(id, (j) => emit('job', { running: true, label: `Nesting ${s.name} ${j.progress}%` }));
    if (placeMedia(r.mediaId, 'V1', S.playhead)) { commit(`Nest ${s.name}`); toast(`"${s.name}" is now one clip on V1 at the playhead. It updates when you change that sequence (> Update nested).`); }
  } catch (e) { toast(e.job ? `Nesting failed: ${e.job.log.slice(-1).join(' ')}` : e.message, 'err'); }
  finally { emit('job', { running: false }); }
}

// re-render the nested copies used here whose sequence changed
export async function updateNested(list = usedHere(staleNested())) {
  for (const [k, m] of list.entries()) {
    emit('job', { running: true, label: `Updating ${m.name} (${k + 1}/${list.length})…` });
    try { await renderNested(m.seqOf, (j) => emit('job', { running: true, label: `Updating ${m.name} ${j.progress}%` })); }
    catch (e) { toast(`${m.name}: ${e.job ? e.job.log.slice(-1).join(' ') : e.message}`, 'err'); }
  }
  emit('job', { running: false });
  emit('change', {});
  if (list.length) toast(`${list.length} nested sequence${list.length > 1 ? 's' : ''} updated`);
}

export function openSequences() {
  const dlg = modal('Sequences', '<div data-seqbody></div>', { width: 640 });
  const draw = () => {
    const list = seqList(S.project), stale = staleNested(), staleHere = usedHere(stale);
    const dur = (x) => { try { return fmt(totalDuration({ ...S.project, ...x.data }, S.mediaById)); } catch { return ''; } };
    $('[data-seqbody]', dlg.el).innerHTML = `<p class="muted">One project, many timelines: the full film, a 30-second teaser, a 9:16 reel… Each has its own clips, frame shape, captions and look. Media is shared.<br>Opening one changes only your timeline; everyone else stays on their own sequence. Claude and edtool work on the <b>Team</b> sequence.</p>
      <div class="seq-list">${list.map((x) => `<div class="seq-row${x.open ? ' open' : ''}">
        <span class="grow"><b>${esc(x.name)}</b>${x.open ? ' <span class="tag">open</span>' : ''}${x.id === sharedSeqId() ? ' <span class="tag" title="The team&#39;s main sequence: Claude, the server&#39;s Agent jobs and edtool work on this one">Team</span>' : ''}${(S.people || []).filter((p) => (p.seq || sharedSeqId()) === x.id).map((p) => ` <span class="tag" style="background:${esc(p.color)};color:#111">${esc(p.name)}</span>`).join('')}<br><span class="muted small">${esc(x.data.settings?.aspect || '')} · ${dur(x)} · ${Object.values(x.data.tracks || {}).flat().length} clips</span></span>
        ${x.open ? '' : `<button class="small" data-open="${x.id}">Open</button><button class="small" data-nest="${x.id}" title="Put this whole sequence into the open timeline as one clip, at the playhead">Nest here</button>`}
        ${x.id === sharedSeqId() ? '' : `<button class="small" data-team="${x.id}" title="Make this the team's main sequence: edtool and the server's Agent jobs work on it (the Assistant's Claude always works on the sequence you have open). Everyone on the team sequence switches to it too.">Make team sequence</button>`}
        <button class="icon-btn small" data-ren="${x.id}" title="Rename" aria-label="Rename ${esc(x.name)}">✎</button>
        ${list.length > 1 ? `<button class="icon-btn small" data-del="${x.id}" title="Delete this sequence" aria-label="Delete ${esc(x.name)}"></button>` : ''}</div>`).join('')}</div>
      ${staleHere.length ? `<div class="warns">Changed since nested: ${staleHere.map((m) => esc(m.name)).join(', ')} <button class="small" data-upd>⟳ Update nested</button></div>` : ''}
      <h4>New sequence</h4>
      <div class="fgrid"><label class="fld"><span>Name</span><input data-nname value="${esc(freeName('Teaser 30s'))}"></label>
        <label class="fld"><span>Frame</span><select data-naspect>${Object.keys(ASPECTS).map((a) => `<option${a === S.project.settings.aspect ? ' selected' : ''}>${a}</option>`).join('')}</select></label></div>
      <div class="dv-actions"><button class="primary" data-new="empty">+ Empty sequence</button><button data-new="copy" title="A copy of the open timeline - try changes on it while the original stays as it is">⧉ Copy of "${esc(seqOf(S.project).name)}" (version)</button></div>`;
  };
  draw();
  dlg.el.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (d.open) { switchTo(d.open); dlg.close(); }
    if (d.nest) { dlg.close(); nest(d.nest); }
    if (d.team) {
      const s = seqList(S.project).find((x) => x.id === d.team), n = (S.people || []).filter((p) => (p.seq || sharedSeqId()) === sharedSeqId()).length;
      if (n && !confirm(`${n} ${n > 1 ? 'people are' : 'person is'} on the team sequence now - their timeline will switch to "${s.name}" too. Continue?`)) return;
      adoptShared();
      openSeq(S.project, d.team);
      S.sel.clear(); commit(`Team sequence: ${s.name}`);
      emit('seq'); emit('fit'); emit('change', {}); sendPresence(); draw();
      toast(`"${s.name}" is now the team's main sequence - Claude will work on it too`);
    }
    if (d.upd !== undefined) { dlg.close(); updateNested(); }
    if (d.ren) { if (renameSequence(d.ren)) draw(); }
    if (d.del) {
      const s = seqList(S.project).find((x) => x.id === d.del);
      if (!confirm(`Delete the sequence "${s.name}"? Its clips and settings go (Undo brings it back). Media stays in the project.`)) return;
      if (!s.open && s.id === sharedSeqId()) return toast("This is the team's main sequence - open it first to delete it.", 'err');
      if (s.open && S.seqMap) { switchTo(sharedSeqId()); }          // my own one: back to the team's, then it goes
      else if (s.open) {
        // the team's shared one: everyone on it moves to another sequence
        const n = (S.people || []).length;
        if (n && !confirm(`${n} other ${n > 1 ? 'people are' : 'person is'} on this project. Deleting the team's main sequence changes their timeline too. Continue?`)) return;
        openSeq(S.project, seqList(S.project).find((x) => !x.open).id);
      }
      delete S.project.sequences[s.id];
      S.sel.clear(); commit(`Delete sequence ${s.name}`); emit('seq'); emit('fit'); draw();
    }
    if (d.new) {
      const copy = d.new === 'copy', name = $('[data-nname]', dlg.el).value.trim() || freeName(copy ? `${seqOf(S.project).name} v2` : 'Sequence');
      addSeq(freeName(name), $('[data-naspect]', dlg.el).value, copy);
      dlg.close();
    }
  });
}

// 🎞 the sequence menu on the timeline toolbar (Phase 20): which timeline is open here, switch with one click, make a new
// one (empty, or a copy of this edit as a version), or open the full Sequences window
// ✎ rename any sequence (the open one too); a nested clip of it shows the new name on the timeline at once
export function renameSequence(id) {
  const s = seqList(S.project).find((x) => x.id === id); if (!s) return false;
  const n = prompt('Name of this sequence', s.name)?.trim();
  if (!n || n === s.name) return false;
  if (seqList(S.project).some((x) => x.id !== id && x.name === n)) { toast(`There is already a sequence called "${n}"`, 'err'); return false; }
  if (s.open) S.project.seq = { ...(S.project.seq || {}), id: s.id, name: n }; else S.project.sequences[s.id].name = n;
  commit('Rename sequence'); emit('seq'); emit('change', {});
  toast(`Renamed to "${n}"`);
  return true;
}
export function seqMenu(anchor) {
  document.querySelector('.seq-menu')?.remove();
  if (!S.project) return;
  const list = seqList(S.project), team = sharedSeqId();
  const dur = (x) => { try { return fmt(totalDuration({ ...S.project, ...x.data }, S.mediaById)); } catch { return ''; } };
  const m = document.createElement('div');
  m.className = 'seq-menu ui-menu';
  m.innerHTML = `<div class="muted">Sequences - this project's timelines</div>
    ${list.map((x) => `<button data-sq="${esc(x.id)}" class="${x.open ? 'cur' : ''}"><span class="sq-dot">${x.open ? '●' : ''}</span>
      <span class="grow sq-name">${esc(x.name)}${x.id === team ? ' <span class="tag" title="The team&#39;s main sequence">👥</span>' : ''}</span>
      <span class="muted small">${esc(x.data.settings?.aspect || '')} · ${dur(x)}</span></button>`).join('')}
    <hr><button data-sq-ren>✎ Rename this sequence <span class="muted small">(or double-click its tab)</span></button>
    <button data-sq-new="empty">+ New empty sequence</button>
    <button data-sq-new="copy">⧉ Copy of this edit (version)</button>
    <hr><button data-sq-clip="copy">Copy this timeline <span class="muted small">(paste it in another project)</span></button>
    ${pasteOffer() ? `<button data-sq-clip="paste">Paste timeline: ${esc(pasteOffer())}</button>` : ''}
    <button data-sq-manage>Manage sequences… <span class="muted small">(rename, nest, delete)</span></button>`;
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.left))}px`;
  m.style.top = `${r.bottom + 6 + m.offsetHeight > innerHeight ? Math.max(8, r.top - m.offsetHeight - 6) : r.bottom + 6}px`;
  const close = (e) => { if (!m.contains(e.target) && !anchor.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
  m.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    m.remove(); document.removeEventListener('pointerdown', close, true);
    if (b.dataset.sq) switchTo(b.dataset.sq);
    else if (b.dataset.sqRen !== undefined) renameSequence(seqOf(S.project).id);
    else if (b.dataset.sqNew) {
      const copy = b.dataset.sqNew === 'copy', base = copy ? `${seqOf(S.project).name} v2` : 'Sequence';
      const name = prompt(copy ? 'Name of the copy (version)' : 'Name of the new sequence', freeName(base))?.trim();
      if (name) addSeq(freeName(name), S.project.settings.aspect, copy);
    } else if (b.dataset.sqClip === 'copy') copyTimeline();
    else if (b.dataset.sqClip === 'paste') pasteTimeline();
    else if (b.dataset.sqManage !== undefined) openSequences();
  });
}

// 📋 a whole timeline pasted from another project (or this one) opens as a new sequence, exactly as it was copied
export function newSequenceFromData(name, data) {
  const id = uid(), nm = freeName(name);
  (S.project.sequences ||= {})[id] = { name: nm, data: JSON.parse(JSON.stringify(data)), modified: Date.now() };
  commit(`Paste timeline ${nm}`);
  switchTo(id);
  return nm;
}

// a sequence tab on the timeline (🎞 tabs, Studio look): open it - this browser only
export const openSequence = (id) => switchTo(id);
// ✨ the Agent on a timeline that already has an edit: the old edit stays as it is; a new, empty sequence becomes the
// team's 👥 main one (Claude and the server's agent work on that one) and the new edit is made there.
// Returns false when the user said no; true otherwise (also when the timeline was empty - then it is used as it is).
export function sequenceForAgent(label = 'Agent edit', aspect = null) {
  if (!S.project || !Object.values(S.project.tracks).flat().length) return true;
  const n = (S.people || []).filter((p) => (p.seq || sharedSeqId()) === sharedSeqId()).length;
  if (n && !confirm(`${n} ${n > 1 ? 'people are' : 'person is'} on the team sequence - the new agent edit becomes the team's main sequence, so their timeline switches to it too (the old edit stays in Sequences). Continue?`)) return false;
  adoptShared();
  const old = seqOf(S.project).name, name = freeName(label), id = uid(), a = aspect || S.project.settings.aspect;
  const blank = newProject(name, { aspect: a, fps: S.project.settings.fps });
  (S.project.sequences ||= {})[id] = { name, data: { tracks: blank.tracks, trackState: blank.trackState, markers: [], subtitles: blank.subtitles, settings: { ...S.project.settings, aspect: a } }, modified: Date.now() };
  openSeq(S.project, id);
  S.sel.clear(); S.playhead = 0;
  commit(`New sequence for the agent: ${name}`);
  emit('seq'); emit('fit'); emit('select'); emit('change', {}); sendPresence();
  toast(`New sequence "${name}" for this edit - "${old}" stays as it was (Sequences)`);
  return true;
}

// ⤵ Nest the selected clips (right-click > Nest, like Premiere): they move into a new sequence of their own - same
// places, same tracks - which is rendered once into one clip that takes their place here. Double-click that clip to open
// its sequence and change the inside; 🎞 > Manage > Update nested renders it again.
export async function nestSelected() {
  if (!S.project || !S.sel.size) return toast('Select the clips to nest first', 'err');
  const L = layout(), picked = [], want = linkedIds(S.project, S.sel); // (a picture comes with its linked sound)
  for (const [track, list] of Object.entries(L)) for (const x of list) if (want.has(x.clip.id)) picked.push({ track, x });
  if (!picked.length) return;
  const v1 = picked.filter((p) => p.track === 'V1'), ids = new Set(picked.map((p) => p.x.clip.id)); // (fixed now: the selection may change while it renders)
  // the nested sequence starts where the first selected main-story shot starts (or the earliest clip, with no V1 shot)
  const t0 = v1.length ? v1[0].x.start : Math.min(...picked.map((p) => p.x.start));
  const copy = (c) => JSON.parse(JSON.stringify(c));
  const tracks = { A1: [], A2: [], A3: [], V1: v1.map((p, i) => { const c = { ...copy(p.x.clip), id: uid() }; if (i === 0) delete c.transitionIn; return c; }) };
  for (const p of picked.filter((q) => q.track !== 'V1')) {
    const c = { ...copy(p.x.clip), id: uid() };
    let st = p.x.start - t0;
    if (st < 0) { // starts before the nest: its head is cut off
      if (c.type === 'video' || c.type === 'audio') c.in = +((c.in || 0) - st * (c.speed || 1)).toFixed(3);
      else if (c.dur) c.dur = +Math.max(0.1, c.dur + st).toFixed(3);
      st = 0;
    }
    c.start = +st.toFixed(3);
    (tracks[p.track] ||= []).push(c);
  }
  relink(Object.values(tracks).flat()); // (one fresh link per pair, picture and sound alike)
  // ✎ its name is asked first (Enter keeps the suggestion)
  const asked = prompt('Name of the nested sequence', freeName(`Nested ${picked.length} clip${picked.length > 1 ? 's' : ''}`));
  if (asked === null) return;
  const name = freeName(asked.trim() || `Nested ${picked.length} clip${picked.length > 1 ? 's' : ''}`), id = uid();
  const trackState = Object.fromEntries(Object.keys(tracks).map((t) => [t, { ...(S.project.trackState?.[t] || {}) }]));
  (S.project.sequences ||= {})[id] = { name, data: { tracks, trackState, markers: [], settings: { ...S.project.settings } }, modified: Date.now() };
  commit(`New sequence ${name}`);
  emit('job', { running: true, label: `Nesting ${picked.length} clips…` });
  let r;
  try { r = await renderNested(id, (j) => emit('job', { running: true, label: `Nesting ${j.progress}%` })); }
  catch (e) { emit('job', { running: false }); return toast(e.job ? `Nesting failed: ${e.job.log.slice(-1).join(' ')}` : e.message, 'err'); }
  emit('job', { running: false });
  // the selected clips leave; the nested clip takes their place
  const firstV1 = v1.length ? S.project.tracks.V1.findIndex((c) => c.id === v1[0].x.clip.id) : -1;
  const keepTr = v1.length ? v1[0].x.clip.transitionIn : null;
  for (const t of Object.keys(S.project.tracks)) S.project.tracks[t] = S.project.tracks[t].filter((c) => !ids.has(c.id));
  const m = S.mediaById[r.mediaId], nc = { id: uid(), type: 'video', mediaId: r.mediaId, in: 0 };
  if (firstV1 >= 0) {
    if (keepTr) nc.transitionIn = keepTr; S.project.tracks.V1.splice(Math.min(firstV1, S.project.tracks.V1.length), 0, nc);
    syncLinked(S.project, S.mediaById); if (m?.hasAudio) linkAudioOf(S.project, S.mediaById, nc); // the nest's sound on its own A track, like Premiere
  }
  else {
    const top = picked.map((p) => p.track).filter((t) => t !== 'V1').sort().pop();
    nc.start = +t0.toFixed(3);
    if (top[0] === 'A' || m?.kind === 'audio') nc.type = 'audio';
    (S.project.tracks[top] ||= []).push(nc);
  }
  S.sel = new Set([nc.id]);
  commit(`Nest ${picked.length} clips`);
  emit('select');
  toast(`${picked.length} clips nested into "${name}" - double-click it to open its sequence`);
}
// ＋ New ▾ > Sequence (Media panel): an empty one in the edit's frame (or another), opened at once
export function newEmptySequence(name, aspect) { addSeq(freeName(name || 'Sequence'), aspect || S.project.settings.aspect, false); }
