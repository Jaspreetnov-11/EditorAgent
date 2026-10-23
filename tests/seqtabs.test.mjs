// 🎞 sequence tabs: five at most, the open one always among them, the order kept.
import { test, eq as same } from './harness.mjs';
import { pickTabs, MAX_TABS } from '../public/js/seqtabs.js';

const seqs = (n, open) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, open: i + 1 === open }));
const ids = (l) => l.map((x) => x.id);

test('five or fewer sequences: every tab shows', () => {
  same(MAX_TABS, 5);
  same(ids(pickTabs(seqs(3, 2))), ['s1', 's2', 's3']);
  same(ids(pickTabs(seqs(5, 5))), ['s1', 's2', 's3', 's4', 's5']);
});

test('more than five: the first five, and the open one takes the last place when it is further down', () => {
  same(ids(pickTabs(seqs(8, 2))), ['s1', 's2', 's3', 's4', 's5']);
  same(ids(pickTabs(seqs(8, 7))), ['s1', 's2', 's3', 's4', 's7']);
  same(ids(pickTabs(seqs(8, 0))), ['s1', 's2', 's3', 's4', 's5']); // (none open: just the first five)
});
