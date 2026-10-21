// 🎞 my sequence (Phase 16): a change made on a browser's own view of the project must land in the right place on the
// server, and a server change must land in the right place in the view.
import { test, eq as same, assert, rng } from './harness.mjs';
import { viewOf, sharedOf, toShared, toView } from '../public/js/myseq.js';
import { diffOps, applyOps } from '../public/js/livepatch.js';

const copy = (x) => JSON.parse(JSON.stringify(x));
const clip = (id, out = 2) => ({ id, mediaId: 'm1', in: 0, out });
const shared = () => ({
  name: 'P', logo: { mediaId: 'L' }, zones: [],
  tracks: { V1: [clip('a'), clip('b')], A2: [clip('mu')] }, settings: { aspect: '16:9', fps: 30 }, markers: [],
  sequences: { t1: { name: 'Teaser', data: { tracks: { V1: [clip('t')] }, settings: { aspect: '9:16', fps: 30 }, markers: [] }, modified: 1 } },
});
const strip = (pj) => { const x = copy(pj); for (const s of Object.values(x.sequences || {})) delete s.modified; delete x.modified; return x; };

test('view of another sequence: its timeline on top, the shared one put away', () => {
  const v = viewOf(shared(), 't1');
  same(v.seq, { id: 't1', name: 'Teaser' });
  same(v.tracks.V1.map((c) => c.id), ['t']);
  same(v.sequences.main.data.tracks.V1.map((c) => c.id), ['a', 'b']);
  assert(!v.sequences.t1, 'the open one is not also under sequences');
  same(v.logo, { mediaId: 'L' }, 'project-wide fields stay');
});

test('sharedOf(viewOf(x)) gives x back (older project without a seq name)', () => {
  const s = shared(), map = { mine: 't1', shared: 'main', noSeq: true };
  same(strip(sharedOf(viewOf(s, 't1'), map)), strip(s));
});

test('a change on the view goes to sequences.<mine> on the server; the shared timeline is untouched', () => {
  const s = shared(), map = { mine: 't1', shared: 'main', noSeq: true }, v = viewOf(s, 't1'), v2 = copy(v);
  v2.tracks.V1[0].out = 9; v2.tracks.V1.push(clip('t2')); v2.seq.name = 'Teaser 30s';
  const ops = toShared(diffOps(v, v2), map), s2 = applyOps(copy(s), ops);
  same(s2.tracks, s.tracks, 'shared timeline unchanged');
  same(s2.sequences.t1.data.tracks.V1.map((c) => [c.id, c.out]), [['t', 9], ['t2', 2]]);
  same(s2.sequences.t1.name, 'Teaser 30s');
});

test('a server change to the shared timeline reaches the view under sequences.main', () => {
  const s = shared(), map = { mine: 't1', shared: 'main', noSeq: true }, v = viewOf(s, 't1'), s2 = copy(s);
  s2.tracks.V1[1].out = 7; s2.tracks.V1.splice(0, 1);
  const vops = toView(diffOps(s, s2), map), v2 = applyOps(copy(v), vops);
  same(v2.sequences.main.data.tracks.V1.map((c) => [c.id, c.out]), [['b', 7]]);
  same(v2.tracks, v.tracks, 'my timeline unchanged');
});

test('random round trips: view edits = server edits seen through the view (500 cases)', () => {
  const r = rng(5);
  for (let i = 0; i < 500; i++) {
    const s = shared(), map = { mine: 't1', shared: 'main', noSeq: true }, v = viewOf(s, 't1'), v2 = copy(v);
    for (let k = 0; k < 1 + r.int(4); k++) {
      const where = r.pick([v2.tracks.V1, v2.sequences.main.data.tracks.V1, v2.sequences.main.data.tracks.A2]);
      if (r.chance(0.5) && where.length) where[r.int(where.length)].out = r.int(30);
      else where.push(clip(`n${i}_${k}`));
    }
    const s2 = applyOps(copy(s), toShared(diffOps(v, v2), map));
    same(strip(viewOf(s2, 't1')), strip(v2), `case ${i}`);
  }
});

test('the server switching its open sequence cannot be shown on a view (rebuild instead)', () => {
  const map = { mine: 't1', shared: 'main' };
  assert(toView([{ o: 'set', p: ['seq'], v: { id: 'x', name: 'X' } }], map) === null, 'seq switch -> null');
  assert(toView([{ o: 'set', p: ['sequences', 't1'], v: undefined }], map) === null, 'my sequence deleted -> null');
  assert(toShared([{ o: 'set', p: ['sequences', 'main'], v: undefined }], map) === null, 'deleting the shared one from a view -> blocked');
});
