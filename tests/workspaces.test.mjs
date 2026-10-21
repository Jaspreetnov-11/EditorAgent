// 🪟 Workspaces (public/js/workspaces.js): the ready layouts are complete and "Edit layout…" recognises them.
import { test, eq as same } from './harness.mjs';

globalThis.localStorage ||= { getItem: () => null, setItem: () => {} };
globalThis.document ||= { addEventListener: () => {}, documentElement: { classList: { toggle() {} } } };
const { _test, PANELS } = await import('../public/js/workspaces.js');
test('every ready grid layout has the timeline and the program monitor, all in known panels', () => {
  for (const [id, w] of Object.entries(_test.BUILT)) {
    if (!w.areas) continue;
    const used = new Set(w.areas.flat());
    same(used.has('tl') && used.has('viewer'), true, id);
    same([...used].every((k) => PANELS[k]), true, id);
    same(w.areas.every((r) => r.length === w.cols.length) && w.areas.length === w.rows.length, true, id);
  }
});
test('Edit layout finds the template of a layout, panels in reading order', () => {
  same(_test.sameShape(_test.TEMPLATES.resolve, _test.BUILT.limelight.areas), true);
  same(_test.sameShape(_test.TEMPLATES.quad, [['insp', 'viewer'], ['pool', 'tl']]), true);
  same(_test.sameShape(_test.TEMPLATES.three, _test.BUILT.limelight.areas), false);
  same(_test.order(_test.BUILT.limelight.areas), ['pool', 'src', 'viewer', 'insp', 'tl']);
});
