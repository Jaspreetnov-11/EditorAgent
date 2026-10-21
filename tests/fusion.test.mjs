// ✨ Fusion (public/js/fusion.js): every style builds a complete graph ending in MediaOut, loops are caught, the clips a
// fusion shows are found for the bake.
import { test, eq as same } from './harness.mjs';
import * as F from '../public/js/fusion.js';

test('every style makes a connected graph from the clip to MediaOut', () => {
  for (const [k, s] of Object.entries(F.STYLES)) {
    const f = F.newFusion('t', 1920, 1080, 4, { mediaId: 'm1', srcIn: 2, speed: 1 }, k);
    const out = f.nodes.find((n) => n.id === f.out);
    same(out?.type, 'mediaOut', k);
    const seen = new Set(), walk = (id) => { if (seen.has(id)) return; seen.add(id); Object.values(f.nodes.find((n) => n.id === id)?.in || {}).forEach(walk); };
    walk(f.out);
    same(f.nodes.filter((n) => n.type === 'mediaIn').every((n) => seen.has(n.id)), true, `${k}: the clip reaches the output`);
    same(f.nodes.every((n) => Object.values(n.in).every((id) => f.nodes.some((x) => x.id === id))), true, `${k}: no dangling wires`);
  }
});
test('a wire that would make a loop is caught', () => {
  const f = F.newFusion('t', 100, 100, 1, { mediaId: 'm' }, 'bloom');
  const [src, glow] = f.nodes;
  same(F.wouldLoop(f, src.id, f.nodes[3].id), false, 'clip straight into MediaOut is fine');
  same(F.wouldLoop(f, glow.id, src.id), true, 'glow back into its own source');
  same(F.wouldLoop(f, f.nodes[2].id, glow.id), true);
});
test('the bake knows which second of which clip each frame needs', () => {
  const f = F.newFusion('t', 100, 100, 3, { mediaId: 'm9', srcIn: 4, speed: 2 }, 'plain');
  same(F.fusionVideos(f, 1.5), [{ id: 'm9', t: 7 }]);
});
