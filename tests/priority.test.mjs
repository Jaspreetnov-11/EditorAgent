// ⭐ who goes first: the render queue's order and where a job joins an AI job line (engine/priority.mjs)
import { test, eq } from './harness.mjs';
import { byPriority, lineIndex } from '../engine/priority.mjs';

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
