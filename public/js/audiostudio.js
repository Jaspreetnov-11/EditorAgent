// 🎧 Audio studio (Audio page): ✨ Studio voice on the speech tracks, 🎙 Podcast mode (every mic at the same level +
// a gate so silent mics don't add room noise), 🎵 Fit music to the edit (keeps the song's real ending, joined on a
// beat), 🎚 Split voice / music of a clip (Demucs, engine side).
import { S, commit, emit, findClip, layout } from './store.js';
import { api, enc, watchJob } from './api.js';
import { uid, layoutV1 } from './model.js';
import { FX_PRESETS } from './audiofx.js';
import { toast } from './ui.js';
import { refreshMedia } from './mediapool.js';

export const STUDIO_HTML = `<div class="ap-studio">
  <b>🎧 Audio studio</b>
  <button class="small" data-st="voice" title="A warm, clear, even voice on the speech tracks (main story and voice-over): rumble out, noise down, presence up, de-essed, compressed">✨ Studio voice</button>
  <button class="small" data-st="podcast" title="Several people on several mics: each clip levelled to the same loudness, and a gate on every mic track so the ones not speaking stay quiet">🎙 Podcast mode</button>
  <button class="small" data-st="fit" title="Make the music on A2 exactly as long as the edit: the start plays, then it jumps on a beat to the song's own ending">🎵 Fit music to edit</button>
  <button class="small" data-st="stems" title="Split the selected clip's sound into voice and music (select it on the Edit page first). First time downloads the model (~80 MB).">🎚 Split voice / music</button>
</div>`;

const speechTracks = () => Object.keys(S.project.tracks).filter((t) => t === 'V1' || (t[0] === 'A' && t !== 'A2' && t !== 'A3' && S.project.tracks[t].some((c) => c.type === 'audio')));
const ts = (id) => (S.project.trackState[id] ||= { mute: false, hide: false, lock: false, volume: 1 });

export async function studio(action, btn) {
  btn && (btn.disabled = true);
  try {
    if (action === 'voice') {
      const list = speechTracks();
      for (const t of list) ts(t).fx = { ...FX_PRESETS.studio.fx };
      commit('Studio voice');
      toast(`✨ Studio voice on ${list.join(', ')} - hear the full effect in Measure / renders (noise reduction and de-essing are render-only)`);
    }
    if (action === 'podcast') {
      const tracks = speechTracks(), clips = tracks.flatMap((t) => S.project.tracks[t].filter((c) => (c.type === 'video' || c.type === 'audio') && S.mediaById[c.mediaId]?.hasAudio));
      if (!clips.length) return toast('No speech clips on V1 / A1 / A4… to level', 'err');
      emit('job', { running: true, label: `Measuring ${clips.length} clips…` });
      const lv = await api('POST', `/api/audio/levels?p=${enc(S.proj)}`, { clips: clips.map((c) => ({ id: c.id, mediaId: c.mediaId, in: c.in || 0, out: c.out })) });
      let n = 0;
      for (const c of clips) {
        if (lv[c.id] === undefined) continue;
        // every clip to about -20 LUFS before the master (which then brings the whole mix to the target)
        c.volume = +Math.min(4, Math.max(0.25, Math.pow(10, (-20 - lv[c.id]) / 20))).toFixed(3); n++;
      }
      for (const t of tracks) ts(t).fx = { ...FX_PRESETS.studio.fx, gate: 0.55 };
      commit('Podcast mode');
      toast(`🎙 ${n} clip${n === 1 ? '' : 's'} levelled, a gate on ${tracks.join(', ')}`);
    }
    if (action === 'fit') await fitMusic();
    if (action === 'stems') await splitStems();
  } catch (e) { toast(e.job ? `Failed: ${e.job.log.slice(-1).join(' ')}` : e.message, 'err'); }
  finally { btn && (btn.disabled = false); emit('job', { running: false }); }
}

async function fitMusic() {
  const E = layoutV1(S.project, S.mediaById).at(-1)?.end || 0;
  const list = S.project.tracks.A2 || [];
  if (!E) return toast('The main story (V1) is empty', 'err');
  if (list.length !== 1) return toast(list.length ? 'Keep just one music clip on A2 to fit it (delete or move the others)' : 'Put a music clip on A2 first', 'err');
  const c = list[0], m = S.mediaById[c.mediaId], M = m?.duration || 0, start = c.start || 0, need = E - start;
  if (!(need > 1)) return toast('The music starts after the edit ends', 'err');
  if (M - (c.in || 0) <= need + 0.5) {
    Object.assign(c, { loop: true, dur: +need.toFixed(3), fadeOut: 2 }); delete c.out;
    commit('Fit music (loop)');
    return toast(`🎵 The song is shorter than the edit - it now loops to ${need.toFixed(1)} s and fades out`);
  }
  emit('job', { running: true, label: 'Finding the beat…' });
  const g = await api('GET', `/api/music/beats?p=${enc(S.proj)}&id=${m.id}`);
  const snap = (t) => (g.period ? g.first + Math.round((t - g.first) / g.period) * g.period : t);
  // keep the song's last `T` seconds (its real ending); the start plays until a beat, crossfading into the ending
  const xf = 1.2, T = Math.min(Math.max(8, need * 0.3), 16, M * 0.4), a = c.in || 0;
  const outroIn = snap(M - T);                       // where the ending part starts in the song (on a beat)
  const bodyLen = need - (M - outroIn) + xf;         // so body + ending - crossfade = the edit
  if (bodyLen < 2) { Object.assign(c, { in: +Math.max(0, M - need).toFixed(3), out: +M.toFixed(3), fadeIn: 1 }); delete c.loop; commit('Fit music'); return toast('🎵 The edit is short: it now plays the song\'s ending'); }
  const bodyOut = a + bodyLen;
  Object.assign(c, { out: +bodyOut.toFixed(3), fadeOut: xf }); delete c.loop; delete c.dur;
  const outro = { ...JSON.parse(JSON.stringify(c)), id: uid(), start: +(start + bodyLen - xf).toFixed(3), in: +outroIn.toFixed(3), out: +M.toFixed(3), fadeIn: xf, fadeOut: 0.5 };
  S.project.tracks.A2.push(outro);
  commit('Fit music to edit');
  toast(`🎵 Music fits the edit: the start (${bodyLen.toFixed(1)} s), then the song's own ending from a beat${g.bpm ? ` (${g.bpm} BPM)` : ''}`);
}

async function splitStems() {
  const id = [...S.sel][0], f = id && findClip(id), c = f?.clip;
  const m = c && S.mediaById[c.mediaId];
  if (!m?.hasAudio || !['video', 'audio'].includes(c.type)) return toast('Select a clip with sound on the Edit page first', 'err');
  if (c.ramp || (c.speed || 1) !== 1) return toast('Split works on clips at normal speed', 'err');
  const x = layout()[f.track].find((p) => p.clip.id === id), a = c.in || 0, b = c.out ?? m.duration;
  emit('job', { running: true, label: '🎚 Separating voice and music…' });
  const job = await api('POST', `/api/audio/stems?p=${enc(S.proj)}`, { mediaId: m.id, in: a, out: b });
  const r = (await watchJob(job.id, (j) => emit('job', { running: true, label: `🎚 ${j.stage || 'Separating'} ${j.progress}%` }))).result;
  await refreshMedia();
  const at = +x.start.toFixed(3), len = +(b - a).toFixed(3);
  const put = (track, mediaId, vol) => { (S.project.tracks[track] ||= []).push({ id: uid(), type: 'audio', mediaId, start: at, in: 0, out: len, volume: vol }); };
  put('A1', r.voice, 1); put('A2', r.music, 0.8);
  if (c.type === 'video') c.mute = true; else c.volume = 0;
  commit('Split voice / music');
  toast('🎚 Voice is on A1 and music on A2, lined up with the clip (its own sound is now muted) - set each one\'s level in the mixer');
}
