// 🧰 the Tools panel's groups: Premiere's tools, each once; only a plain click on a button changes the tool.
import { test, eq as same, assert } from './harness.mjs';
import { TOOL_GROUPS, groupClick, MANY_SELECT } from '../public/js/toolgroups.js';

test('every tool once, Selection first, Premiere groups with their flyouts', () => {
  const ids = TOOL_GROUPS.flat().map((x) => x[0]);
  same(ids.length, new Set(ids).size);
  same(ids[0], 'select');
  for (const t of ['blade', 'ripple', 'rolling', 'rate', 'slip', 'slide', 'pen', 'rect', 'ellipse', 'zoom', 'type', 'trackfwd', 'trackback', 'extend']) assert(ids.includes(t), `${t} missing`);
  assert(!ids.includes('hand'), 'no Hand tool (the user: only the Selection / move tool)');
  same(TOOL_GROUPS.find((g) => g[0][0] === 'trackfwd').map((x) => x[0]), ['trackfwd', 'trackback']);
});

test('a click on a group button: a plain click sets its tool; the ◢ corner or a hold only shows the others', () => {
  same(groupClick({ many: true }), 'set');
  same(groupClick({ corner: true, many: true }), 'flyout');
  same(groupClick({ held: true, many: true }), 'none');
  same(groupClick({ corner: true, many: false }), 'set'); // (a one-tool group has no corner to peek in)
  assert(MANY_SELECT.has('trackfwd') && MANY_SELECT.has('trackback') && !MANY_SELECT.has('select'), 'track select tools say how they select');
});

test('Program monitor: the Hand tool pans and never moves the clip; only the Selection tool moves it', async () => {
  const { monitorDrag } = await import('../public/js/toolgroups.js');
  same(monitorDrag('select', 0, false), 'move');
  same(monitorDrag('hand', 0, true), 'pan');
  same(monitorDrag('hand', 0, false), null);
  same(monitorDrag('select', 1, true), 'pan');
  same(monitorDrag('ripple', 0, false), null);
});
