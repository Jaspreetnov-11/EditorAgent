// 🔊 Auto sound design: whooshes, hits, a riser into the drop... placed on A3 from what is on the timeline
// (cuts, transitions, cut effects, speed ramps, kinetic titles). Used by the timeline button and the Assistant.
import { S, commit } from './store.js';
import { api, enc } from './api.js';
import { toast } from './ui.js';
import { refreshMedia } from './mediapool.js';
import { autoSfx, sfxCount } from './fx.js';

export async function autoSoundDesign({ amount = 1 } = {}) {
  if (!S.project?.tracks.V1.length) { toast('Put some shots on V1 first', 'err'); return 0; }
  toast('Getting the sound effects ready…');
  const lib = await api('GET', `/api/sfx?p=${enc(S.proj)}`);
  await refreshMedia();
  if (!Object.keys(lib).length) { toast('No sound effects found (SFX folder)', 'err'); return 0; }
  S.project.tracks.A3 = autoSfx(S.project, S.mediaById, lib, { amount });
  S.project.trackState.A3 = { ...S.project.trackState.A3, volume: S.project.trackState.A3?.volume ?? 0.8 };
  commit('Auto sound design');
  const n = sfxCount(S.project);
  toast(n ? `🔊 ${n} sound effects on A3 - your own A3 sounds stayed. Ctrl+Z to undo.` : 'Nothing to add sounds to: add transitions or cut effects first');
  return n;
}

export function removeSoundDesign() {
  const n = sfxCount(S.project);
  S.project.tracks.A3 = (S.project.tracks.A3 || []).filter((c) => !c.sfx);
  commit('Remove sound design');
  return n;
}
