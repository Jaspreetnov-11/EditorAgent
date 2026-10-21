// 📝 Text page presets (public/js/textcut.js): verbal fillers, stutters, retakes, silent heads / tails, highlights,
// and corrected words showing in place of what was heard.
import { test, eq as same } from './harness.mjs';
import * as T from '../public/js/textcut.js';

const W = (arr, clip = 'c') => arr.map((w, i) => ({ clipId: clip, mediaId: 'm', cin: 0, cout: 99, i, si: 0, w, s: 1 + i * 0.5, e: 1 + i * 0.5 + 0.4, ts: 1 + i * 0.5, te: 1 + i * 0.5 + 0.4, seg: `${clip}:${Math.floor(i / 6)}` }));
test('verbal fillers and stutters are found, real words are not', () => {
  const w = W(['main', 'main', 'basically', 'ghar', 'you', 'know', 'gaya', 'tha']);
  same(T.stutterCuts(w).length, 1); same(T.verbalCuts(w).length, 2);
  same(T.verbalCuts(W(['you', 'are', 'here'])).length, 0, '"you" alone stays');
});
test('a retake: the earlier take goes, the last one stays', () => {
  const s = [{ text: 'we will build a new road here', ts: 0, clipId: 'c', s: 0, e: 2 }, { text: 'something else entirely different now', ts: 3, clipId: 'c', s: 3, e: 4 }, { text: 'we will build a new road here today', ts: 6, clipId: 'c', s: 6, e: 8 }];
  same(T.retakes(s).map((x) => x.ts), [0]);
});
test('silence before the first and after the last word of a shot', () => {
  const cuts = T.headTailCuts(W(['ek', 'do']), 0.15);
  same(cuts.length, 2); same(cuts[0].s, 0); same(cuts[1].e, 99);
});
test('a highlight fits the length asked for, in story order', () => {
  const sents = Array.from({ length: 12 }, (_, k) => ({ key: `s${k}`, ts: k * 5, s: k * 5, e: k * 5 + 4, text: 'one two three four five six', words: Array.from({ length: 6 }, () => ({ w: 'x' })) }));
  const h = T.pickHighlights(sents, 15), d = h.reduce((a, x) => a + x.e - x.s + 0.32, 0);
  same(d <= 15 * 1.08 && d >= 8, true, `length ${d}`); same(h.every((x, i) => i === 0 || x.ts > h[i - 1].ts), true);
});
test('a corrected word shows instead of what was heard', () => {
  const project = { tracks: { V1: [{ id: 'c1', type: 'video', mediaId: 'm1', in: 0, out: 5 }] }, wordFix: { m1: { '0:1': 'Bharat' } } };
  const tr = { m1: { segments: [{ words: [{ w: 'viksit', s: 0.2, e: 0.6 }, { w: 'barat', s: 0.7, e: 1.1 }] }] } };
  const words = T.wordsOf(project, { m1: { duration: 5 } }, tr);
  same(words.map((x) => x.w), ['viksit', 'Bharat']); same(words[1].fixed, true);
});
