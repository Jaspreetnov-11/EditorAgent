// ◆ Keyframe selection in Effect Controls, like Premiere: click selects one, Shift / Ctrl+click adds or takes one away,
// a box dragged over the lanes selects every ◆ in it; the selected ones move together (drag one of them) and Delete
// removes them all. A selection is a list of { p, k }: the property path and the key object itself (indexes change as
// keys are moved past each other). Pure functions - the inspector draws and binds them (inspector.js bindKeyLane).

export const inSel = (list, k) => list.some((s) => s.k === k);

// mode 'set' (only this one), 'add' (this one too), 'toggle' (in or out)
export function pickKeys(list, hit, mode = 'set') {
  if (mode === 'set') return hit ? [hit] : [];
  if (!hit) return list;
  if (inSel(list, hit.k)) return mode === 'toggle' ? list.filter((s) => s.k !== hit.k) : list;
  return [...list, hit];
}

// every key of these properties between t0 and t1 (clip time, either order)
export function keysInRange(c, paths, t0, t1) {
  const a = Math.min(t0, t1), b = Math.max(t0, t1), out = [];
  for (const p of paths) for (const k of c.keys?.[p] || []) if (k.t >= a - 1e-6 && k.t <= b + 1e-6) out.push({ p, k });
  return out;
}

// moves the selected keys by dt (from t0s: their times when the drag began, in the same order) - all by the same amount,
// none before the clip's start or past its length D. Each property's keys are sorted again. Returns the dt used.
export function moveKeys(c, list, t0s, dt, D) {
  if (!list.length) return 0;
  const lo = -Math.min(...t0s), hi = D - Math.max(...t0s), d = Math.min(hi, Math.max(lo, dt));
  list.forEach((s, i) => { s.k.t = +(t0s[i] + d).toFixed(3); });
  for (const p of new Set(list.map((s) => s.p))) c.keys?.[p]?.sort((x, y) => x.t - y.t);
  return d;
}

// after a move: a key that was not moved and now sits on the same frame as a moved one is replaced by it (Premiere)
export function settleKeys(c, list, fps = 30) {
  const tol = 0.5 / fps;
  let gone = 0;
  for (const p of new Set(list.map((s) => s.p))) {
    const keys = c.keys?.[p]; if (!keys) continue;
    const moved = keys.filter((k) => inSel(list, k));
    for (let i = keys.length - 1; i >= 0; i--) if (!inSel(list, keys[i]) && moved.some((m) => Math.abs(m.t - keys[i].t) < tol)) { keys.splice(i, 1); gone++; }
  }
  return gone;
}

// removes the selected keys; a property left with none stops being animated (its value stays at the last key's)
export function deleteKeys(c, list) {
  let n = 0;
  for (const p of new Set(list.map((s) => s.p))) {
    const keys = c.keys?.[p]; if (!keys) continue;
    const keep = keys.filter((k) => !inSel(list, k));
    n += keys.length - keep.length;
    if (keep.length) c.keys[p] = keep;
    else {
      const last = keys[keys.length - 1]?.v;
      delete c.keys[p];
      if (last !== undefined) setVal(c, p, last);
    }
  }
  if (c.keys && !Object.keys(c.keys).length) delete c.keys;
  return n;
}
function setVal(o, path, v) {
  const ks = path.split('.'), last = ks.pop();
  for (const k of ks) o = o[k] ||= {};
  o[last] = v;
}
