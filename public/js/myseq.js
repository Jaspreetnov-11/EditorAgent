// 🎞 My sequence (Phase 16): every editor can have a different sequence open without switching anyone else's timeline.
// The project on the server keeps one sequence at its top level - the team's shared one, which Claude, edtool, renders
// and older tabs work on. A browser that opens another sequence M works on a "view": the same project with M brought to
// the top level and the shared one put away under sequences (exactly what openSeq would do, but only in this browser).
// Changes made on the view are translated to the server's shape (toShared) before they are sent, and everyone else's
// changes are translated to the view's shape (toView) before they are applied here.
import { SEQ_FIELDS, seqOf, seqData } from './model.js';

const F = new Set(SEQ_FIELDS);
const copy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

// the project as this browser shows it with sequence `id` open (null when id is the shared one or is gone)
export function viewOf(shared, id) {
  const cur = seqOf(shared), s = shared.sequences?.[id];
  if (!id || id === cur.id || !s) return null;
  const v = copy(shared);
  v.sequences[cur.id] = { name: cur.name, data: seqData(shared), modified: shared.modified || Date.now() };
  for (const k of SEQ_FIELDS) delete v[k];
  Object.assign(v, copy(s.data));
  delete v.sequences[id];
  v.seq = { id, name: s.name };
  return v;
}

// the server's shape of a view (for recovery copies and anything that needs the whole project)
export function sharedOf(view, map) {
  if (!map) return view;
  const s = copy(view), back = s.sequences?.[map.shared];
  if (!back) return view;
  s.sequences[map.mine] = { name: view.seq?.name || 'Sequence', data: seqData(view), modified: Date.now() };
  for (const k of SEQ_FIELDS) delete s[k];
  Object.assign(s, copy(back.data));
  delete s.sequences[map.shared];
  s.seq = { id: map.shared, name: back.name };
  if (map.noSeq) delete s.seq; // the server's project never named its open sequence (an older project): keep it so
  return s;
}

// one path from the side `from` (sequence id at its top level) to the side `to`: [path] or null when it cannot be said
// there. `whole` handles a set of a whole sequence's data, which becomes one set per field.
function movePath(p, from, to) {
  // top level fields of `from`'s open sequence live in sequences[from].data on the other side
  if (F.has(p[0])) return [['sequences', from, 'data', ...p]];
  if (p[0] === 'seq') return p[1] === 'name' && p.length === 2 ? [['sequences', from, 'name']] : null;
  if (p[0] === 'sequences' && p[1] === to) {
    if (p.length === 2) return null;                                    // the whole entry made / deleted
    if (p[2] === 'name') return p.length === 3 ? [['seq', 'name']] : null;
    if (p[2] === 'modified') return [];                                 // bookkeeping only
    if (p[2] === 'data') {
      if (p.length === 3) return 'whole';
      return F.has(p[3]) ? [p.slice(3)] : [];
    }
    return [];
  }
  if (p[0] === 'sequences' && p.length === 1) return null;
  return [p];
}

function moveOps(ops, from, to) {
  const out = [];
  for (const op of ops || []) {
    const r = movePath(op.p, from, to);
    if (r === null) return null;
    if (r === 'whole') {
      // a set of the whole data object: one set per field (and the fields it no longer has go)
      const v = op.v || {};
      for (const k of SEQ_FIELDS) out.push({ o: 'set', p: [k], v: copy(v[k]) });
      continue;
    }
    for (const p of r) out.push({ ...op, p });
  }
  return out;
}

// map = { mine, shared, noSeq }: this browser has `mine` open, the server's top level is `shared` (noSeq: unnamed there)
// view → server. null: a change that cannot be sent from here (e.g. deleting the team's shared sequence)
export const toShared = (ops, map) => (map ? moveOps(ops, map.mine, map.shared) : ops);
// server → view. null: the server's shape changed under us (its open sequence switched, ours deleted) - rebuild the view
export const toView = (ops, map) => (map ? moveOps(ops, map.shared, map.mine) : ops);

// remembered per project in this browser, so a refresh opens the same sequence again
const KEY = (p) => `ve-myseq:${p}`;
export function rememberSeq(proj, id) { try { if (id) localStorage.setItem(KEY(proj), id); else localStorage.removeItem(KEY(proj)); } catch {} }
export function rememberedSeq(proj) { try { return localStorage.getItem(KEY(proj)); } catch { return null; } }
