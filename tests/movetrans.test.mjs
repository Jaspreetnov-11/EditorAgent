// ⧓ a main-story clip that is moved takes its transitions along: taken off its old cuts properly (the frames the shots
// lent are given back - nothing comes out longer, nothing moves), put back on its new cuts (a fade to / from black where
// there is no shot to mix with)
import { test, eq as same, assert } from './harness.mjs';
import { setTransition, takeTransitions, giveTransitions, placed, clipDur } from '../public/js/model.js';

const media = Object.fromEntries(['a', 'b', 'c', 'd'].map((k) => [k, { id: k, kind: 'video', duration: 10 }]));
const story = () => {
  const p = { tracks: { V1: ['a', 'b', 'c', 'd'].map((k) => ({ id: k, type: 'video', mediaId: k, in: 1, out: 5 })) } };
  setTransition(p, media, 1, 'fade', 0.5); setTransition(p, media, 2, 'wipe', 1); setTransition(p, media, 3, 'fade', 0.5);
  return p;
};
const cuts = (p) => placed(p, media).V1.map((x) => +(x.start + (x.overlap ? Math.min(x.overlap, x.clip.transitionIn?.hB ?? 0) : 0)).toFixed(3));

test('⧓ taking a clip\'s transitions off gives the lent frames back; the cuts stay where they were', () => {
  const p = story(), before = cuts(p), b = p.tracks.V1[1], c = p.tracks.V1[2];
  const t = takeTransitions(p, media, b);
  same(t.head, { type: 'fade', dur: 0.5, hA: 0.25, hB: 0.25 });
  same(t.tail, { type: 'wipe', dur: 1, hA: 0.5, hB: 0.5 });
  same([b.in, b.out, b.transitionIn, c.transitionIn], [1, 5, undefined, undefined], 'b is its own 4 s again, no transitions left on its cuts');
  same([p.tracks.V1[0].out, c.in], [5, 1], 'its neighbours got their frames back');
  same(cuts(p).slice(0, 3), before.slice(0, 3), 'nothing moved');
});

test('⧓ put back where it lands: the same transitions on its new cuts, or fades where there is no shot next to it', () => {
  const p = story(), V1 = p.tracks.V1, b = V1[1];
  const t = takeTransitions(p, media, b);
  // b moved to after d (the end): a shot before it, nothing after it
  V1.splice(1, 1); V1.push(b);
  giveTransitions(p, media, b, t);
  same(b.transitionIn?.type, 'fade', 'its In transition is on its new cut');
  same(b.fadeOut, 1, 'its Out transition: a 1 s fade to black (nothing after it)');
  same(clipDur(b, media), 4.25, 'it lent its 0.25 s for the transition, as before');
  // with a gap before it: a fade from black instead
  const q = story(), W = q.tracks.V1, c = W[2], tc = takeTransitions(q, media, c);
  W.splice(2, 1, { id: 'g', type: 'title', gap: true, dur: 4 }); W.push({ id: 'g2', type: 'title', gap: true, dur: 2 }, c);
  giveTransitions(q, media, c, tc);
  same([c.transitionIn, c.fadeIn, c.fadeOut], [undefined, 1, 0.5]);
  assert(!q.tracks.V1[3].transitionIn, 'the shot it left has no transition from a gap');
});
