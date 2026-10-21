// 📋 Copy / paste between projects: a whole timeline (🎞 menu: Copy this timeline → in another project, Paste timeline -
// it opens as a new sequence, exactly as it was), or the selected clips (Ctrl+C → Ctrl+V at the playhead, same tracks,
// same spacing). The media the clips use is brought over from the source project first (/api/media/bring), so nothing
// shows up offline. The clipboard lives in this browser (localStorage), so it survives switching projects.
import { S, commit, layout, emit } from './store.js';
import { api, enc } from './api.js';
import { seqData, uid, linkedIds } from './model.js';
import { toast } from './ui.js';
import { refreshMedia } from './mediapool.js';
import { newSequenceFromData, seqName } from './sequences.js';

const KEY = 've-clipboard';
// kept in this browser AND on the editor (per person), so a copy made in one tab, browser, link (localhost / team
// link) or computer pastes in any other; the newer of the two wins
let remote = null;
const local = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
export function clipboard() { const a = local(), b = remote; return !a ? b : !b ? a : (b.at || 0) > (a.at || 0) ? b : a; }
export async function syncClipboard() { try { remote = await api('GET', '/api/clipboard'); } catch {} return clipboard(); }
function store(x) {
  const v = { ...x, from: S.proj, at: Date.now() };
  remote = v;
  api('PUT', '/api/clipboard', v).catch(() => {});
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} // (the editor's copy is enough when the browser's is full)
  return true;
}
const clipsOf = (data) => Object.values(data?.tracks || {}).flat();
// everything a timeline needs from its project: media ids, LUT files, the subtitles file
function needs(clips, data = {}) {
  const ids = new Set(), luts = new Set();
  for (const c of clips) {
    if (c.mediaId) ids.add(c.mediaId);
    if (c.mcAngle) ids.add(c.mcAngle);
    for (const a of c.angles || []) if (a?.mediaId) ids.add(a.mediaId);
    if (c.color?.lut) luts.add(c.color.lut);
  }
  if (data.settings?.look?.lut) luts.add(data.settings.look.lut);
  return { ids: [...ids], luts: [...luts], subs: data.subtitles?.file || null };
}
async function bring(cb, need) {
  if (cb.from === S.proj) return true;
  const r = await api('POST', `/api/media/bring?p=${enc(S.proj)}`, { from: cb.from, ...need });
  await refreshMedia();
  if (r.missing.length) toast(`${r.missing.length} clip file${r.missing.length > 1 ? 's are' : ' is'} no longer in "${cb.from}" - those clips show as missing`, 'err');
  return true;
}

// ---- whole timeline ----
export function copyTimeline() {
  if (!S.project) return;
  const data = seqData(S.project);
  if (store({ kind: 'timeline', name: seqName(), data })) toast(`📋 Timeline "${seqName()}" copied (${clipsOf(data).length} clips) - open another project and choose 🎞 > Paste timeline`);
}
export async function pasteTimeline() {
  const cb = await syncClipboard();
  if (cb?.kind !== 'timeline') return toast('Copy a timeline first (🎞 > Copy this timeline)', 'err');
  emit('job', { running: true, label: '📋 Bringing the media over…' });
  try {
    await bring(cb, needs(clipsOf(cb.data), cb.data));
    const nm = newSequenceFromData(cb.from === S.proj ? `${cb.name} copy` : `${cb.name} (${cb.from})`, cb.data);
    toast(`📋 Pasted as the sequence "${nm}" - exactly as it was`);
  } catch (e) { toast(e.message, 'err'); }
  finally { emit('job', { running: false }); }
}

// ---- selected clips (Ctrl+C / Ctrl+V) ----
export function copyClips() {
  if (!S.project || !S.sel.size) return false;
  const L = layout(), items = [], sel = linkedIds(S.project, S.sel); // (a picture comes with its linked sound)
  for (const [track, list] of Object.entries(L)) for (const x of list) if (sel.has(x.clip.id)) items.push({ track, start: x.start, clip: x.clip });
  if (!items.length) return false;
  items.sort((a, b) => a.start - b.start);
  if (store({ kind: 'clips', items })) toast(`📋 ${items.length} clip${items.length > 1 ? 's' : ''} copied - Ctrl+V pastes at the playhead (in this or another project)`);
  return true;
}
export async function pasteClips() {
  const cb = await syncClipboard();
  if (cb?.kind !== 'clips') {
    toast(cb?.kind === 'timeline' ? 'A whole timeline is copied - paste it with 🎞 ▾ > Paste timeline' : 'Nothing copied yet - select clips and press Ctrl+C (or right-click > Copy)', 'err');
    return false;
  }
  if (S.readOnly) return true;
  await bring(cb, needs(cb.items.map((x) => x.clip)));
  const t0 = +S.playhead || 0, first = Math.min(...cb.items.map((x) => x.start)), sel = new Set();
  const fresh = new Map(), lk = (c) => { if (c.link) { if (!fresh.has(c.link)) fresh.set(c.link, uid()); c.link = fresh.get(c.link); } return c; }; // pasted pairs get their own link
  // V1 is the magnetic main story: its clips go in, in order, where the playhead is; other tracks keep their spacing
  const v1 = cb.items.filter((x) => x.track === 'V1');
  if (v1.length) {
    const L = layout().V1;
    let idx = L.findIndex((x) => t0 < (x.start + x.end) / 2); if (idx < 0) idx = L.length;
    const add = v1.map((x) => lk({ ...JSON.parse(JSON.stringify(x.clip)), id: uid() }));
    if (idx === 0) delete add[0].transitionIn; // nothing before it to dissolve from
    S.project.tracks.V1.splice(idx, 0, ...add);
    add.forEach((c) => sel.add(c.id));
  }
  for (const x of cb.items.filter((y) => y.track !== 'V1')) {
    const audio = x.track[0] === 'A', track = S.project.tracks[x.track] ? x.track : audio ? 'A2' : 'V2';
    const c = lk({ ...JSON.parse(JSON.stringify(x.clip)), id: uid(), start: +(t0 + (x.start - first)).toFixed(3) });
    (S.project.tracks[track] ||= []).push(c); sel.add(c.id);
  }
  S.sel = sel;
  commit(`Paste ${sel.size} clip${sel.size > 1 ? 's' : ''}`);
  emit('select');
  toast(`📋 ${sel.size} clip${sel.size > 1 ? 's' : ''} pasted${cb.from !== S.proj ? ` from "${cb.from}"` : ''}`);
  return true;
}
// what the 🎞 menu can offer to paste
export function pasteOffer() {
  const cb = clipboard();
  return cb?.kind === 'timeline' ? `${cb.name}${cb.from !== S.proj ? ` (from ${cb.from})` : ''}` : null;
}
