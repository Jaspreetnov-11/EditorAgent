// livepatch.js - small, mergeable changes to a project, so many people can edit one timeline at once (🔴 live editing).
// diffOps(a, b) lists what changed from a to b; applyOps(target, ops) makes the same change on another copy.
// Lists of things with an id (clips on a track, markers, notes, caption cues…) change item by item: two people trimming
// two different clips, or adding clips to the same track, both keep their work. A change to the same field of the same
// thing at the same moment: the one the server got last wins. Used by the browser (store.js) and the server (server.mjs).
//
// An op: { o: 'set', p: path, v }        set (v undefined = delete) a value
//        { o: 'ins', p: path, v, after }  insert item v into the list at path, after the item with id `after` (null = first)
//        { o: 'del', p: path, id }        remove the item with that id from the list at path
//        { o: 'ord', p: path, ids }       put the listed items of the list in this order (others keep their places)
// A path is a list of object keys; '#<id>' steps into the list item with that id.

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const keyed = (a) => Array.isArray(a) && a.every((x) => isObj(x) && (typeof x.id === 'string' || typeof x.id === 'number')) && new Set(a.map((x) => x.id)).size === a.length;
// deep equality the way JSON sees it (a key holding undefined = no key), in one walk that stops at the first difference
// (it used to compare JSON strings at every level - on a 5000-clip project that was most of the 35 ms of every edit)
export function eq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const arr = Array.isArray(a);
  if (arr !== Array.isArray(b)) return false;
  if (arr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
    return true;
  }
  for (const k in a) if (!eq(a[k], b[k])) return false;
  for (const k in b) if (!(k in a) && b[k] !== undefined) return false;
  return true;
}
const same = eq;
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
// project keys that are not shared edits ('modified' is the server's save time; '_rev' the live revision)
const SKIP = new Set(['modified', '_rev']);

export function diffOps(a, b, p = [], ops = []) {
  if (a === b) return ops;
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) if (!(k in b) && !(p.length === 0 && SKIP.has(k))) ops.push({ o: 'set', p: [...p, k], v: undefined });
    for (const k of Object.keys(b)) {
      if (p.length === 0 && SKIP.has(k)) continue;
      if (!(k in a)) ops.push({ o: 'set', p: [...p, k], v: clone(b[k]) });
      else diffOps(a[k], b[k], [...p, k], ops);
    }
    return ops;
  }
  if (keyed(a) && keyed(b) && (a.length || b.length)) {
    const ia = new Map(a.map((x) => [x.id, x])), ib = new Set(b.map((x) => x.id));
    for (const x of a) if (!ib.has(x.id)) ops.push({ o: 'del', p, id: x.id });
    b.forEach((x, i) => {
      if (!ia.has(x.id)) ops.push({ o: 'ins', p, v: clone(x), after: i ? b[i - 1].id : null });
      else diffOps(ia.get(x.id), x, [...p, `#${x.id}`], ops);
    });
    // the items both have, in a different order: send b's order
    const kept = a.filter((x) => ib.has(x.id)).map((x) => x.id), want = b.filter((x) => ia.has(x.id)).map((x) => x.id);
    if (!same(kept, want)) ops.push({ o: 'ord', p, ids: b.map((x) => x.id) });
    return ops;
  }
  if (!same(a, b)) ops.push({ o: 'set', p, v: clone(b) });
  return ops;
}

// the object / list a path leads to (null when something on the way is gone - e.g. a clip someone else deleted)
function walk(root, p) {
  let cur = root;
  for (const k of p) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = typeof k === 'string' && k[0] === '#' && Array.isArray(cur) ? cur.find((x) => String(x?.id) === k.slice(1)) : cur[k];
    if (cur === undefined) return null;
  }
  return cur;
}

export function applyOps(root, ops) {
  for (const op of ops || []) {
    if (op.o === 'set') {
      if (!op.p.length) continue;
      const parent = walk(root, op.p.slice(0, -1)), k = op.p[op.p.length - 1];
      if (!parent || typeof parent !== 'object') continue;
      if (Array.isArray(parent) && typeof k === 'string' && k[0] === '#') continue; // (items change through ins / del)
      if (op.v === undefined) delete parent[k]; else parent[k] = clone(op.v);
    } else if (op.o === 'ins') {
      let list = walk(root, op.p);
      if (!list) {
        // the list itself is new here (e.g. a track someone just added): make it under its parent
        const parent = walk(root, op.p.slice(0, -1));
        if (!isObj(parent)) continue;
        list = parent[op.p[op.p.length - 1]] = [];
      }
      if (!Array.isArray(list)) continue;
      const old = list.findIndex((x) => String(x?.id) === String(op.v.id));
      if (old >= 0) list.splice(old, 1); // the same item twice (an undo of a delete…): one copy
      const at = op.after === null || op.after === undefined ? 0 : list.findIndex((x) => String(x?.id) === String(op.after)) + 1;
      list.splice(at > 0 || op.after === null || op.after === undefined ? at : list.length, 0, clone(op.v));
    } else if (op.o === 'del') {
      const list = walk(root, op.p);
      if (!Array.isArray(list)) continue;
      const i = list.findIndex((x) => String(x?.id) === String(op.id));
      if (i >= 0) list.splice(i, 1);
    } else if (op.o === 'ord') {
      const list = walk(root, op.p);
      if (!Array.isArray(list)) continue;
      const rank = new Map(op.ids.map((id, i) => [String(id), i]));
      const slots = [], items = [];
      list.forEach((x, i) => { if (rank.has(String(x?.id))) { slots.push(i); items.push(x); } });
      items.sort((x, y) => rank.get(String(x.id)) - rank.get(String(y.id)));
      slots.forEach((s, i) => (list[s] = items[i]));
    }
  }
  return root;
}

// what an op touches, for spotting two people changing the same thing at the same time
export const opKey = (op) => [...op.p, op.o === 'set' ? '' : op.o === 'ord' ? '~order' : `#${op.o === 'del' ? op.id : op.v?.id}`].join('/');
export const overlaps = (k1, k2) => k1 === k2 || k1.startsWith(`${k2}/`) || k2.startsWith(`${k1}/`);

// Apply ops to root one by one and return the ops that take them back (last change first). The browser keeps its
// agreed copy of the project (`base`) up to date this way after every change, instead of copying the whole project and
// diffing it backwards (store.js commit()).
export function applyWithInverse(root, ops) {
  const inv = [];
  for (const op of ops || []) {
    const back = inverseOf(root, op);
    if (back) inv.unshift(...back);
    applyOps(root, [op]);
  }
  return inv;
}
function inverseOf(root, op) {
  if (op.o === 'set') {
    if (!op.p.length) return null;
    const parent = walk(root, op.p.slice(0, -1)), k = op.p[op.p.length - 1];
    if (!parent || typeof parent !== 'object') return null;
    return [{ o: 'set', p: op.p, v: clone(parent[k]) }];
  }
  const list = walk(root, op.p);
  if (op.o === 'ins') {
    if (!Array.isArray(list)) return [{ o: 'set', p: op.p, v: undefined }]; // the list is made by this insert
    const i = list.findIndex((x) => String(x?.id) === String(op.v.id));
    // the same item already there (moved): put it back where it was, as it was
    return i >= 0 ? [{ o: 'ins', p: op.p, v: clone(list[i]), after: i ? list[i - 1].id : null }, { o: 'ord', p: op.p, ids: list.map((x) => x.id) }] : [{ o: 'del', p: op.p, id: op.v.id }];
  }
  if (!Array.isArray(list)) return null;
  if (op.o === 'del') {
    const i = list.findIndex((x) => String(x?.id) === String(op.id));
    return i >= 0 ? [{ o: 'ins', p: op.p, v: clone(list[i]), after: i ? list[i - 1].id : null }] : null;
  }
  if (op.o === 'ord') return [{ o: 'ord', p: op.p, ids: list.map((x) => x.id) }];
  return null;
}
