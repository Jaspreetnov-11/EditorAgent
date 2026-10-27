// App state, undo/redo history and auto-save. Every timeline change goes through commit().
import { reportError } from './errlog.js';
import { api, enc } from './api.js';
import { placed, totalDuration, syncLinked } from './model.js';
import { diffOps, applyOps, applyWithInverse, eq, opKey, overlaps } from './livepatch.js';
import { viewOf, sharedOf, toShared, toView, rememberSeq, rememberedSeq } from './myseq.js';
import { seqOf } from './model.js';

export const S = {
  proj: null,          // open project name
  project: null,       // project.json
  media: [],           // media pool items
  mediaById: {},
  page: 'edit',
  sel: new Set(),      // selected clip ids
  playhead: 0,
  zoom: 40,            // timeline px per second
  snap: true,
  tool: 'select',      // select | blade
  luts: [],
  health: {},
  renders: [],
  subs: [],
  saveState: 'saved',  // saved | saving | dirty | error
  queue: { quick: 0, proxy: 0 },
};

const listeners = {};
export const on = (evt, fn) => { (listeners[evt] ||= []).push(fn); };
// 🛡 one panel's mistake never stops the others (or the editor): each listener runs on its own; errors are logged once
const seenErr = new Set();
export const emit = (evt, data) => {
  (listeners[evt] || []).forEach((fn) => {
    try { fn(data); } catch (e) { const k = `${evt}:${e?.stack || e}`; if (!seenErr.has(k)) { seenErr.add(k); reportError(`"${evt}" listener`, e); } }
  });
  if (KEEP_SCROLL.has(evt)) keepScroll();
};
// 📜 a panel drawn again (a tick box, undo / redo, a value typed in) jumped back to its top: every panel scrolled by hand is
// noted (a selector made of ids / tag.class up the page) and, after such a redraw, its new copy is scrolled back there
const KEEP_SCROLL = new Set(['change', 'media', 'inspect']), scrolled = new Map(); // selector -> { el, top, left }
const selOf = (el) => {
  const p = [];
  for (let e = el; e && e !== document.body; e = e.parentElement) { if (e.id) { p.unshift(`#${CSS.escape(e.id)}`); return p.join(' > '); } p.unshift(`${e.tagName.toLowerCase()}${e.classList[0] ? `.${CSS.escape(e.classList[0])}` : ''}`); }
  return `body > ${p.join(' > ')}`;
};
if (typeof document !== 'undefined') document.addEventListener('scroll', (e) => { const el = e.target; if (el instanceof Element && el !== document.documentElement) scrolled.set(selOf(el), { el, top: el.scrollTop, left: el.scrollLeft }); }, true);
function keepScroll() {
  if (typeof document === 'undefined' || !scrolled.size) return;
  const put = () => {
    for (const [k, s] of scrolled) {
      if (s.el.isConnected && (s.el.scrollTop || !s.top)) continue; // (still there and where it was)
      let el; try { el = s.el.isConnected ? s.el : document.querySelector(k); } catch { el = null; }
      if (!el) continue;
      el.scrollTop = s.top; el.scrollLeft = s.left; s.el = el;
    }
  };
  put(); globalThis.requestAnimationFrame?.(put); // (and once more after panels that draw on the next frame)
}

// ---- history + 🔴 live editing ----
// Every change is turned into small ops (public/js/livepatch.js) against `base` - the project as this browser last
// agreed it - and sent to the server, which passes them to everyone else on this project. Their ops come back the same
// way and are applied here. Undo takes back only your own changes (their inverse ops), never someone else's.
// 🎞 My sequence (myseq.js): with S.seqMap = { mine, shared } this browser shows its own sequence; S.project and `base`
// are then the view, while the undo history, the send queue and the server always use the server's shape.
let undoStack = [], redoStack = [], base = null;
const copy = (x) => JSON.parse(JSON.stringify(x));
export function resetHistory() { undoStack = []; redoStack = []; S.seqMap = null; base = copy(S.project); delete base._rev; }
// Call after mutating S.project. Same `coalesce` key within 1s (e.g. dragging a slider) = one undo step.
let lastKey = null, lastTime = 0;
// this tab, for the server (its own ops are not sent back to it as someone else's)
export const CLIENT = Math.random().toString(36).slice(2, 12);
export function commit(label = 'Edit', coalesce = null) {
  if (S.readOnly) {
    // a viewer: the change is taken back
    if (base) S.project = copy(base);
    emit('change', {}); emit('readonly', { tried: label });
    return;
  }
  // 🔗 linked picture + sound stay together after every edit (the half the user dragged / trimmed leads)
  if (S.project?.tracks) { try { syncLinked(S.project, S.mediaById, S.linkLead); } catch (e) { console.warn('linked audio:', e); } }
  S.linkLead = null;
  const now = Date.now();
  const vfwd = base ? diffOps(base, S.project) : [];
  if (vfwd.length) {
    const fwd = toShared(vfwd, S.seqMap);
    if (!fwd) {
      // e.g. deleting the team's shared sequence while another one is open here
      S.project = copy(base);
      emit('change', {}); emit('seqBlocked', { tried: label });
      return;
    }
    emit('ops', { ops: vfwd, before: base, label });
    // ⚡ base catches up by applying the same ops, which also gives their inverse (no whole-project copy or backward
    // diff per change - on a 5000-clip project those were ~45 ms of every edit and every drag step)
    const inv = toShared(applyWithInverse(base, vfwd), S.seqMap) || [];
    keepBaseHonest();
    const top = undoStack[undoStack.length - 1];
    if (coalesce && coalesce === lastKey && now - lastTime < 1000 && top) { top.fwd.push(...fwd); top.inv = [...inv, ...top.inv]; }
    else { undoStack.push({ fwd, inv, label }); if (undoStack.length > 200) undoStack.shift(); }
    redoStack = [];
    sendOps(fwd, label, inv);
  }
  lastKey = coalesce; lastTime = now;
  keepLocal();
  emit('change', { label });
}
// every so often: base must still equal what is shown (it is kept by ops now) - if not, take a fresh copy as before
let commits = 0;
function keepBaseHonest() {
  if (++commits % 25) return;
  if (!eq(base, S.project)) { console.warn('live: base drifted from the project - re-synced'); base = copy(S.project); }
}
function step(from, to, ops, label, inv) {
  const v = toView(ops, S.seqMap);
  if (v) { applyOps(S.project, v); applyOps(base, v); } else rebuildView();
  to.push(from);
  lastKey = null;
  pruneSelection(); sendOps(ops, label, inv); keepLocal();
}
export function undo() {
  const u = undoStack.pop();
  if (!u) return false;
  step(u, redoStack, u.inv, `Undo ${u.label}`, u.fwd);
  emit('change', { label: `Undo ${u.label}` });
  return u.label;
}
export function redo() {
  const r = redoStack.pop();
  if (!r) return false;
  step(r, undoStack, r.fwd, `Redo ${r.label}`, r.inv);
  emit('change', { label: `Redo ${r.label}` });
  return r.label;
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
// 🕘 History panel: the steps that can be undone (oldest first) and the ones that can be redone (next first)
export const historySteps = () => ({ done: undoStack.map((u) => u.label), undone: [...redoStack].reverse().map((r) => r.label) });

function pruneSelection() {
  const ids = new Set(allClips().map((c) => c.id));
  for (const id of [...S.sel]) if (!ids.has(id)) S.sel.delete(id);
}

// ---- sending (the server saves the file a moment after the last change) ----
// Crash safety: until the server has the change, a copy waits in this browser (localStorage). If the tab crashes or the
// editor server is not running, opening the project again offers it back (main.js recoverable()).
export const RECOVER_KEY = (p) => `ve-recover:${p}`;
let keepTimer = null, queue = [], inflight = null, retryTimer = null;
function keepLocal() {
  clearTimeout(keepTimer);
  keepTimer = setTimeout(() => {
    if (!S.proj || !S.project) return;
    try { localStorage.setItem(RECOVER_KEY(S.proj), JSON.stringify({ at: Date.now(), project: sharedOf(S.project, S.seqMap) })); } catch {} // too big / storage off: skip
  }, 300);
}
function sendOps(ops, label, inv = null) {
  if (!ops.length || !S.proj) return;
  queue.push({ ops, label, inv });
  S.saveState = 'dirty'; emit('save');
  setTimeout(flushOps, 0);
}
// ops sent but not confirmed: someone else's change to the same thing arriving now waits for our answer (see onOps)
const pendingKeys = () => [...(inflight?.keys || []), ...queue.flatMap((b) => b.ops.map(opKey))];
async function flushOps() {
  if (inflight || !queue.length || !S.proj) return inflight?.done;
  const batch = queue.splice(0, queue.length), ops = batch.flatMap((b) => b.ops), proj = S.proj;
  // the inverse of the whole batch (last change undone first) - lets anyone take back just this change later (📜 Activity)
  const inv = batch.every((b) => b.inv) ? [...batch].reverse().flatMap((b) => b.inv) : null;
  const label = batch.length === 1 ? batch[0].label : `${batch[batch.length - 1].label} (+${batch.length - 1})`;
  inflight = { keys: ops.map(opKey) };
  inflight.done = (async () => {
    S.saveState = 'saving'; emit('save');
    try {
      const r = await api('POST', `/api/live/ops?p=${enc(proj)}&client=${CLIENT}`, { ops, label, inv });
      if (proj !== S.proj) return;
      S.liveRev = Math.max(S.liveRev || 0, r.rev);
      // changes by others to the same things: those the server got after ours win, the earlier ones were overwritten
      const held = heldOps.splice(0);
      for (const e of held) if (e.rev > r.rev) applyRemote(e, true);
      inflight = null;
      if (queue.length) return flushOps();
      S.saveState = 'saved'; emit('save');
      try { localStorage.removeItem(RECOVER_KEY(proj)); } catch {}
    } catch (e) {
      // not reached the server (editor closed / network): try again; the browser copy keeps it meanwhile
      console.error(e);
      if (proj === S.proj) queue.unshift(...batch);
      inflight = null;
      S.saveState = 'error'; emit('save');
      clearTimeout(retryTimer); retryTimer = setTimeout(flushOps, 2500);
    }
  })();
  return inflight.done;
}
// backup: also keep a backup copy on the server (Ctrl+S, leaving the project) - 'force' = always a new one
export async function saveNow(backup = false) {
  if (!S.proj || !S.project) return;
  if (S.readOnly) { S.saveState = 'locked'; emit('save'); return; }
  for (let i = 0; i < 20 && (queue.length || inflight); i++) await flushOps();
  try {
    await api('POST', `/api/live/save?p=${enc(S.proj)}${backup ? `&backup=${backup === 'force' ? 'force' : 1}` : ''}`);
    if (!queue.length && !inflight) { S.saveState = 'saved'; emit('save'); }
  } catch (e) { S.saveState = 'error'; emit('save'); console.error(e); }
}
window.addEventListener('beforeunload', (e) => { if (queue.length || inflight) { flushOps(); e.preventDefault(); } });

// ---- receiving: everyone else's changes (one event stream per open project) ----
let es = null, esTimer = null, heldOps = [], waiting = [];
// while you drag something or type in a box, others' changes wait (a redraw would break the drag / the typing)
let pointerDown = false;
window.addEventListener('pointerdown', () => { pointerDown = true; }, true);
window.addEventListener('pointerup', () => { pointerDown = false; setTimeout(drainWaiting, 0); }, true);
window.addEventListener('pointercancel', () => { pointerDown = false; setTimeout(drainWaiting, 0); }, true);
document.addEventListener('focusout', () => setTimeout(drainWaiting, 0), true);
const typing = () => { const a = document.activeElement; return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable || (a.tagName === 'INPUT' && /^(text|search|number|)$/.test(a.type || ''))); };
const busy = () => pointerDown || typing();
function drainWaiting() {
  if (busy() || !waiting.length) return;
  const w = waiting.splice(0);
  let changed = false;
  for (const m of w) changed = handleLive(m, true) || changed;
  if (changed) { pruneSelection(); emit('change', { remote: true }); }
}
// someone else's ops: applied to both what you see and the agreed base, so your next change is still just yours
function applyRemote(e, show = false) {
  const v = toView(e.ops, S.seqMap);
  if (v) { applyOps(S.project, v); applyOps(base, v); } else rebuildView();
  if (!show) return;
  pruneSelection(); emit('change', { remote: true, by: e.name, label: e.label });
}
function handleLive(m, batched = false) {
  if (m.type === 'ops') {
    S.liveRev = Math.max(S.liveRev || 0, m.rev);
    if (m.client === CLIENT) return false;
    // the same thing changed here and not confirmed yet: decide when the server answers (flushOps)
    const mine = pendingKeys();
    if (mine.length && m.ops.some((op) => mine.some((k) => overlaps(k, opKey(op))))) { heldOps.push(m); return false; }
    applyRemote(m);
    if (m.label) emit('liveActivity', { name: m.name, label: m.label });
    if (!batched) { pruneSelection(); emit('change', { remote: true, by: m.name, label: m.label }); }
    return true;
  }
  if (m.type === 'reset') {
    // the whole project changed on the server (restore, a version…): take it, then put back what was not sent yet
    S.liveRev = m.rev;
    const project = m.project; delete project._rev;
    takeShared(project);
    for (const b of queue) { const v = toView(b.ops, S.seqMap); if (v) { applyOps(S.project, v); applyOps(base, v); } }
    if (m.by) emit('liveActivity', { name: m.by, label: 'replaced the project' });
    if (!batched) { pruneSelection(); emit('change', { remote: true }); }
    return true;
  }
  // a note from the editor for everyone on this project (e.g. 🔗 files relinked by themselves)
  if (m.type === 'notice') { emit('notice', m); return false; }
  if (m.type === 'presence') {
    S.people = (m.people || []).filter((x) => x.client !== CLIENT);
    S.peopleAll = m.people || [];
    emit('presence');
  }
  return false;
}
// resume: the same project again (back from the background / the stream dropped) - changes not sent yet are kept
export function connectLive(resume = false) {
  if (resume) { clearTimeout(esTimer); if (es) { es.onerror = null; es.close(); es = null; } } else disconnectLive();
  if (!S.proj || typeof EventSource === 'undefined') return;
  if (document.hidden) return; // a background tab connects when it is shown (see visibilitychange)
  const proj = S.proj;
  es = new EventSource(`/api/live?p=${enc(proj)}&client=${CLIENT}&since=${S.liveRev || 0}`);
  es.onmessage = (ev) => {
    if (proj !== S.proj) return;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'presence' && busy()) { waiting.push(m); return; }
    if (waiting.length) drainWaiting();
    handleLive(m);
  };
  // the stream dropped (editor restarted, network): open it again from where this browser was
  es.onerror = () => { if (es) es.close(); es = null; clearTimeout(esTimer); esTimer = setTimeout(() => { if (S.proj === proj) connectLive(true); }, 2000); };
  S.people = []; emit('presence');
}
// A browser keeps only ~6 connections to one site, and every open editor tab holds one for this stream: a tab in the
// background lets it go at once (the editor would otherwise stall once several tabs are open; a timer is no good here,
// browsers hold back timers in hidden tabs) and picks up what it missed when it comes back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(esTimer); if (es) { es.onerror = null; es.close(); es = null; } }
  else if (S.proj && !es) connectLive(true);
});
export function disconnectLive() {
  clearTimeout(esTimer);
  if (es) { es.close(); es = null; }
  queue = []; heldOps = []; waiting = [];
  S.seqMap = null;
  S.people = []; emit('presence');
}
// what you are looking at, for the others (their timelines show your selection and playhead in your colour)
let presTimer = null, presLast = '';
export function sendPresence() {
  clearTimeout(presTimer);
  presTimer = setTimeout(() => {
    if (!S.proj || !es) return;
    const b = { sel: [...S.sel], playhead: +(+S.playhead || 0).toFixed(2), page: S.page, seq: S.project?.seq?.id || '' }, k = JSON.stringify(b);
    if (k === presLast) return;
    presLast = k;
    api('POST', `/api/live/presence?p=${enc(S.proj)}&client=${CLIENT}`, b).catch(() => {});
  }, 250);
}

// ---- 🎞 my sequence (see myseq.js) ----
// the server's project arrived whole (opened, reset): show it, as this browser's own sequence when one is open here
function takeShared(shared) {
  const mine = S.seqMap?.mine, v = mine ? viewOf(shared, mine) : null;
  if (mine && !v && mine !== seqOf(shared).id) emit('seqGone', {}); // someone deleted the sequence open here
  S.seqMap = v ? { mine, shared: seqOf(shared).id, noSeq: !shared.seq } : null;
  S.project = v || shared; base = copy(S.project);
  if (!v && S.proj) rememberSeq(S.proj, null);
}
// the server's shape changed under this view (its open sequence switched…): fetch it whole and show it again
let rebuilding = null;
function rebuildView() {
  if (rebuilding || !S.proj) return;
  const proj = S.proj;
  rebuilding = api('GET', `/api/project?p=${enc(proj)}`).then((pj) => {
    if (proj !== S.proj) return;
    const rev = pj._rev; delete pj._rev;
    handleLive({ type: 'reset', rev, project: pj });
  }).catch(console.error).finally(() => { rebuilding = null; });
}
// the sequence the timeline shows for whoever uses this browser - nobody else's timeline changes
export function openMySeq(id) {
  if (!S.project) return false;
  const shared = sharedOf(S.project, S.seqMap), sharedBase = base ? sharedOf(base, S.seqMap) : shared;
  if (id !== seqOf(shared).id && !shared.sequences?.[id]) return false;
  const v = viewOf(shared, id);
  S.seqMap = v ? { mine: id, shared: seqOf(shared).id, noSeq: !shared.seq } : null;
  S.project = v || shared;
  base = (v ? viewOf(sharedBase, id) : null) || copy(sharedBase);
  lastKey = null;
  if (S.proj) rememberSeq(S.proj, v ? id : null);
  return true;
}
// back to the server's shape here (before changing which sequence is the team's shared one - that changes it for all)
export function adoptShared() {
  if (!S.seqMap || !S.project) return;
  S.project = sharedOf(S.project, S.seqMap); base = base ? sharedOf(base, S.seqMap) : copy(S.project);
  S.seqMap = null; lastKey = null;
  if (S.proj) rememberSeq(S.proj, null);
}
// a refresh / reopening: the sequence this browser had open last time
export function restoreMySeq() { const id = S.proj && rememberedSeq(S.proj); if (id) openMySeq(id); }
// the id of the team's shared sequence (the server's top level), and whether it is the one shown here
export const sharedSeqId = () => (S.seqMap ? S.seqMap.shared : seqOf(S.project || {}).id);

// ---- helpers ----
export const allClips = () => (S.project ? Object.values(S.project.tracks).flat() : []);
export function findClip(id) {
  for (const [track, list] of Object.entries(S.project.tracks)) {
    const i = list.findIndex((c) => c.id === id);
    if (i >= 0) return { clip: list[i], track, index: i };
  }
  return null;
}
export const layout = () => placed(S.project, S.mediaById);
export const duration = () => totalDuration(S.project, S.mediaById);
export function setMedia(items) {
  S.media = items;
  S.mediaById = Object.fromEntries(items.map((m) => [m.id, m]));
}
