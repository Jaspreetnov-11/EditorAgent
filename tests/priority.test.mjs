// ⭐ who goes first: the render queue's order and where a job joins an AI job line (engine/priority.mjs)
import { test, eq, assert } from './harness.mjs';
import { byPriority, lineIndex, fairOrder } from '../engine/priority.mjs';
import { bestPoll, noteRate } from '../engine/helpers.mjs';

test('the queue renders the server PC first, then urgent, then the rest - first come first within each', () => {
  const q = [{ id: 'a' }, { id: 'b', priority: 1 }, { id: 'c', priority: 2 }, { id: 'd', priority: 0 }, { id: 'e', priority: 2 }, { id: 'f', priority: 1 }];
  eq(byPriority(q).map((x) => x.id), ['c', 'e', 'b', 'f', 'a', 'd']);
  eq(q.map((x) => x.id), ['a', 'b', 'c', 'd', 'e', 'f'], 'the queue itself keeps its order');
});

test('a server-PC job joins its line behind the other server-PC jobs and in front of everyone else', () => {
  const line = [{ job: { fromServer: true } }, { job: {} }, { job: {} }];
  eq(lineIndex(line, { fromServer: true }), 1);
  eq(lineIndex(line, {}), 3, 'any other job at the end');
  eq(lineIndex([], { fromServer: true }), 0);
  eq(lineIndex([{ job: { fromServer: true } }], { fromServer: true }), 1);
});

test('fair share: people take turns within a priority; a running render counts as a turn; urgent still goes first', () => {
  const w = (id, by, priority = 0) => ({ id, by, priority, state: 'waiting' });
  const q = [w('a1', 'amit'), w('a2', 'amit'), w('a3', 'amit'), w('v1', 'vishal'), w('k1', 'kanha'), w('v2', 'vishal'), w('u1', 'kanha', 1)];
  eq(fairOrder(q).filter((x) => x.state === 'waiting').map((x) => x.id), ['u1', 'a1', 'v1', 'k1', 'a2', 'v2', 'a3']);
  const busy = [{ id: 'r', by: 'amit', state: 'rendering' }, ...q.filter((x) => x.priority === 0)];
  eq(fairOrder(busy).filter((x) => x.state === 'waiting').map((x) => x.id), ['v1', 'k1', 'a1', 'v2', 'a2', 'a3'], 'amit already has one running');
  eq(fairOrder([{ id: 'd', state: 'done' }, w('x', '')]).map((x) => x.id), ['d', 'x']);
});

test('farm: the PC expected to finish first takes the task - measured speed, then strength, busy, load, failures', () => {
  const pc = (id, specs, more = {}) => ({ lane: 'heavy', w: { id, specs, slots: 2, busy: 0, load: 0, ...more } });
  const slow = pc('slow', { cores: 4 }), fast = pc('fast', { cores: 16, nvenc: true });
  const t = { lane: 'heavy', sizes: [800e6], tag: 'proxy' };
  eq(bestPoll([slow, fast], t), 1, 'the stronger PC with an NVIDIA card');
  eq(bestPoll([slow, pc('fast', { cores: 16, nvenc: true }, { busy: 3, slots: 1, load: 100 })], { lane: 'heavy', sizes: [800e6] }), 0, 'unless it is full and its user is busy');
  eq(bestPoll([pc('a', { cores: 8 }, { rate: { heavy: 40 } }), pc('b', { cores: 8 }, { rate: { heavy: 90 } })], t), 1, 'measured speed wins');
  eq(bestPoll([pc('a', { cores: 8 }), pc('b', { cores: 8 }, { failScore: 0.9 })], t), 0, 'a PC failing lately comes last');
  eq(bestPoll([{ ...fast, lane: 'light' }], t), -1, 'only PCs asking in its lane');
  eq(bestPoll([slow, fast], { ...t, helper: 'slow' }), 0, "a project's own helper when it is pinned to one");
  const w = {}; noteRate(w, 'heavy', 100, 10, false); noteRate(w, 'heavy', 200, 10, false);
  eq(Math.round(w.rate.heavy), 13); noteRate(w, 'heavy', 0, 0, true); assert(w.failScore > 0.2, 'a failure counts');
});
