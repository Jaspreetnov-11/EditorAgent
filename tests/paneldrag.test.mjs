// ⇕ Dragging the line between two Edit-page panels: the edge goes where the pointer is, no panel under 120 px.
import { test, eq as same } from './harness.mjs';

globalThis.localStorage ||= { getItem: () => null, setItem: () => {} };
globalThis.document ||= { addEventListener: () => {}, documentElement: { classList: { toggle() {} } } };
const { pairResize } = await import('../public/js/workspaces.js');

test('the edge follows the pointer, up and down', () => {
  // top row 442 px, timeline 320 px: the pointer 342 px below the top row's start = the top row is 342 px
  same(pairResize([442, 320], 0, 342), 342);
  same(pairResize([442, 320], 0, 500), 500);
});

test('neither panel goes under 120 px', () => {
  same(pairResize([442, 320], 0, 40), 120);
  same(pairResize([442, 320], 0, 700), 642);
  same(pairResize([200, 50], 0, 10), 120, 'a pair too small for both minimums: the first one keeps its minimum');
  same(pairResize([200, 50], 0, 240), 130);
});

test('only the two tracks next to the line count (three columns: the middle line)', () => {
  same(pairResize([266, 700, 434], 1, 400), 400);
  same(pairResize([266, 700, 434], 1, 2000), 1014);
});
