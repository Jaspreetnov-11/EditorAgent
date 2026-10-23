// 🎚 Mute / Solo, like Premiere: one rule for the live mix (player.js) and the render (render2.mjs).
import { test, eq as same } from './harness.mjs';
import { trackAudible } from '../public/js/model.js';

const heard = (ts) => ['V1', 'A1', 'A2', 'A3'].filter((id) => trackAudible(ts, id));

test('nothing muted or soloed: every track is heard', () => {
  same(heard({}), ['V1', 'A1', 'A2', 'A3']);
  same(heard(undefined), ['V1', 'A1', 'A2', 'A3']);
});

test('M mutes only its own track', () => {
  same(heard({ A2: { mute: true } }), ['V1', 'A1', 'A3']);
  same(heard({ V1: { mute: true } }), ['A1', 'A2', 'A3'], 'V1 mute = the clips\' own sound');
});

test('S on any track: only the soloed tracks are heard (V1 too, from the Audio page)', () => {
  same(heard({ A1: { solo: true } }), ['A1']);
  same(heard({ A1: { solo: true }, A3: { solo: true } }), ['A1', 'A3']);
  same(heard({ V1: { solo: true } }), ['V1']);
});

test('mute wins over solo; a solo flag on a picture-only track (V2) does not silence the rest', () => {
  same(heard({ A1: { solo: true, mute: true }, A2: { solo: true } }), ['A2']);
  same(heard({ V2: { solo: true } }), ['V1', 'A1', 'A2', 'A3']);
});
