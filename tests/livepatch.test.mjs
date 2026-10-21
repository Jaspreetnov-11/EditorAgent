// livepatch: diffOps / applyOps / applyWithInverse must round-trip exactly - live editing, undo and 📜 Activity all
// depend on it. Random projects get random changes (trims, moves, deletes, inserts, reorders, new fields, new tracks).
import { test, eq as same, assert, rng } from './harness.mjs';
import { diffOps, applyOps, applyWithInverse, eq } from '../public/js/livepatch.js';

const copy = (x) => JSON.parse(JSON.stringify(x));

function project(r, n = 30) {
  const mk = (i) => ({ id: `c${i}`, mediaId: `m${r.int(20)}`, in: r.int(100) / 10, out: 10 + r.int(100) / 10, ...(r.chance(0.3) ? { color: { exposure: r.int(10) / 10 } } : {}), ...(r.chance(0.2) ? { text: `t${i}` } : {}) });
  const tracks = { V1: [], V2: [], A1: [], A2: [] };
  for (let i = 0; i < n; i++) tracks[r.pick(Object.keys(tracks))].push(mk(i));
  return { name: 'p', settings: { fps: 30, aspect: '16:9' }, tracks, markers: [{ id: 'k1', t: 1 }], sequences: { s1: { name: 'Teaser', data: { tracks: { V1: [mk(900)] } } } }, modified: 1 };
}
function mutate(r, pj, steps) {
  let next = 1000;
  for (let s = 0; s < steps; s++) {
    const tk = r.pick(Object.keys(pj.tracks)), list = pj.tracks[tk];
    switch (r.int(9)) {
      case 0: if (list.length) r.pick(list).out += 0.5; break;                                   // trim
      case 1: if (list.length) list.splice(r.int(list.length), 1); break;                         // delete
      case 2: list.splice(r.int(list.length + 1), 0, { id: `n${next++}`, mediaId: 'm1', in: 0, out: 2 }); break; // insert
      case 3: if (list.length > 2) { const [x] = list.splice(r.int(list.length), 1); list.splice(r.int(list.length + 1), 0, x); } break; // move
      case 4: if (list.length) { const c = r.pick(list); c.color = { ...(c.color || {}), sat: r.int(5) }; } break; // nested change
      case 5: if (list.length) delete r.pick(list).text; break;                                   // field removed
      case 6: pj.tracks[`V${3 + r.int(3)}`] ||= [{ id: `n${next++}`, mediaId: 'm2', in: 0, out: 1 }]; break; // new track
      case 7: pj.markers.push({ id: `k${next++}`, t: r.int(30) }); break;
      case 8: pj.sequences.s1.data.tracks.V1[0].out = r.int(20); pj.settings.fps = r.pick([25, 30]); break;
    }
  }
}

test('eq matches JSON equality', () => {
  assert(eq({ a: 1, b: undefined }, { a: 1 }), 'undefined key = no key');
  assert(!eq({ a: [1, 2] }, { a: [2, 1] }), 'order of a list matters');
  assert(eq({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } }), 'deep');
  assert(!eq({ a: 1 }, { a: '1' }), 'types');
  assert(!eq([], {}), 'array vs object');
});

test('diffOps + applyOps reproduce the change (2000 random edits)', () => {
  const r = rng(7);
  for (let i = 0; i < 2000; i++) {
    const a = project(r, 5 + r.int(40)), b = copy(a);
    mutate(r, b, 1 + r.int(6));
    const ops = diffOps(a, b), got = applyOps(copy(a), ops);
    delete got.modified; const want = copy(b); delete want.modified;
    same(got, want, `case ${i}`);
  }
});

test('applyWithInverse takes the change back exactly (2000 random edits)', () => {
  const r = rng(11);
  for (let i = 0; i < 2000; i++) {
    const a = project(r, 5 + r.int(40)), b = copy(a);
    mutate(r, b, 1 + r.int(6));
    const ops = diffOps(a, b), work = copy(a), inv = applyWithInverse(work, ops);
    const w1 = copy(work), b1 = copy(b); delete w1.modified; delete b1.modified;
    same(w1, b1, `forward ${i}`);
    applyOps(work, inv);
    same(work, a, `back ${i}`);
  }
});

test('an unchanged project gives no ops', () => {
  const r = rng(3), a = project(r, 50);
  assert(diffOps(a, copy(a)).length === 0, 'no ops');
});
