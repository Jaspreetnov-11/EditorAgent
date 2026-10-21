// 🎥 Multicam: 2-4 cameras (and/or an audio recorder) of the same event are synced by their sound on the server
// (engine/sync.mjs), then cut into V1 switching between angles while one recording's sound plays on A1 unbroken.
// Each V1 shot remembers its group (clip.mc = { group, angle }), so the Inspector can switch it to another angle
// later without losing sync: project.multicam[group] = { master, angles: [{ mediaId, offset, duration }] }.
import { S, commit, emit } from './store.js';
import { api, enc, watchJob } from './api.js';
import { uid, fmt } from './model.js';
import { h, esc, toast, modal } from './ui.js';

const r3 = (x) => Math.round(x * 1000) / 1000;

// angles: the cameras [{ mediaId, offset, duration }] (offset = where the angle's t=0 sits on the master's clock);
// total = length of the master recording (its sound plays on A1). V1 is magnetic, so a moment no camera recorded
// gets a black filler of the same length - the shots after it stay in sync with the sound.
export function buildMulticam(group, { master, angles, total }, { cut = 4, pick = null } = {}) {
  const covers = (a, t, L) => a.offset <= t + 1e-3 && a.offset + a.duration >= t + L - 1e-3;
  const V1 = [];
  let t = 0, prev = null, k = 0;
  while (t < total - 0.3) {
    // shot lengths vary around the chosen pace so the switching does not feel mechanical
    let L = Math.min(total - t, cut * [1, 0.7, 1.3, 0.85, 1.15][k++ % 5]);
    const full = angles.filter((a) => covers(a, t, L));
    const live = full.length ? full : angles.filter((a) => a.offset <= t + 1e-3 && a.offset + a.duration > t + 0.3);
    if (!live.length) {
      const next = Math.min(total, ...angles.map((a) => a.offset).filter((o) => o > t + 0.05));
      L = Math.max(0.2, Math.min(L, next - t));
      V1.push({ id: uid(), type: 'title', text: '', bg: '#000000', dur: r3(L), mc: { group, gap: true } });
      t += L; prev = null; continue;
    }
    const a = (pick && live.find((x) => x.mediaId === pick(t, L, live))) || live.find((x) => x.mediaId !== prev) || live[0];
    const len = full.includes(a) ? L : Math.max(0.3, Math.min(L, a.offset + a.duration - t));
    V1.push({ id: uid(), type: 'video', mediaId: a.mediaId, in: r3(Math.max(0, t - a.offset)), out: r3(t + len - a.offset), mc: { group } });
    prev = a.mediaId; t += len;
  }
  const A1 = [{ id: uid(), type: 'audio', mediaId: master, start: 0, in: 0, out: r3(total), volume: 1 }];
  return { V1, A1 };
}

// switch one V1 shot to another angle of its group, same moment of the event
export function switchAngle(c, mediaId) {
  const g = S.project.multicam?.[c.mc?.group]; if (!g) return false;
  const from = g.angles.find((a) => a.mediaId === c.mediaId), to = g.angles.find((a) => a.mediaId === mediaId);
  if (!from || !to) return false;
  const R = (c.in || 0) + from.offset, len = (c.out ?? from.duration) - (c.in || 0);
  if (R - to.offset < -0.05 || R + len - to.offset > to.duration + 0.05) { toast('That camera was not recording at this moment', 'err'); return false; }
  c.mediaId = mediaId; c.in = r3(Math.max(0, R - to.offset)); c.out = r3(c.in + len);
  delete c.color; // the grade belonged to the other camera
  return true;
}
export const anglesFor = (c) => S.project.multicam?.[c?.mc?.group]?.angles || null;

export function openMulticam(setBusy) {
  const vids = S.media.filter((m) => (m.kind === 'video' || m.kind === 'audio') && m.hasAudio && m.status === 'ready');
  const body = h(`<div class="mc">
    <p class="muted small">Choose the recordings of the same event (2-4 cameras, and an audio recorder if you have one). They are lined up by their sound.</p>
    <div class="pick mc-pick">${vids.map((m) => `<label title="${esc(m.name)}"><input type="checkbox" value="${m.id}">${m.urls.thumb ? `<img src="${m.urls.thumb}" alt="">` : '<i>♪</i>'}<span>${esc(m.name)} · ${fmt(m.duration)}</span></label>`).join('') || '<div class="muted pad">No clips with sound yet.</div>'}</div>
    <div class="fgrid">
      <label class="fld"><span>Sound from</span><select name="master"><option value="">First chosen clip</option></select></label>
      <label class="fld"><span>Switch angle about every</span><select name="cut"><option value="2.5">2.5 s (lively)</option><option value="4" selected>4 s</option><option value="6">6 s (calm)</option></select></label>
    </div>
    <p class="muted small">Replaces V1 and A1. Then select any shot and change its camera in the Inspector (Angle). Ctrl+Z undoes it.</p>
    <div class="ag-foot"><span class="grow"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" data-go>🎥 Sync & cut</button></div></div>`);
  const dlg = modal('🎥 Multicam - sync cameras by sound', body, { width: 680 });
  const chosen = () => [...body.querySelectorAll('.mc-pick input:checked')].map((x) => x.value);
  const master = body.querySelector('[name="master"]');
  body.querySelector('.mc-pick').addEventListener('change', () => {
    const v = master.value;
    master.innerHTML = '<option value="">First chosen clip</option>' + chosen().map((id) => `<option value="${id}"${id === v ? ' selected' : ''}>${esc(S.mediaById[id].name)}</option>`).join('');
  });
  body.querySelector('[data-go]').onclick = async () => {
    const ids = chosen();
    if (ids.length < 2) return toast('Choose at least two recordings', 'err');
    dlg.close(); setBusy?.(true, '🎥 Syncing cameras…');
    try {
      const job = await api('POST', `/api/multicam/sync?p=${enc(S.proj)}`, { ids, master: master.value || ids[0] });
      const r = (await watchJob(job.id, () => {})).result;
      const weak = r.angles.filter((a) => a.mediaId !== r.master && a.confidence < 6);
      const vid = { ...r, angles: r.angles.filter((a) => S.mediaById[a.mediaId]?.kind === 'video') };
      if (!vid.angles.length) throw new Error('None of the chosen clips has a picture');
      const group = uid();
      S.project.multicam = { ...(S.project.multicam || {}), [group]: { master: r.master, angles: vid.angles } };
      // the master is the sound; when it is an audio-only recorder, the cut follows the cameras' own span
      const total = r.angles.find((a) => a.mediaId === r.master).duration;
      const { V1, A1 } = buildMulticam(group, { master: r.master, angles: vid.angles, total }, { cut: +body.querySelector('[name="cut"]').value });
      S.project.tracks.V1 = V1;
      S.project.tracks.A1 = A1;
      S.project.trackState.V1 = { ...S.project.trackState.V1, volume: 0 }; // the cameras' own sound is replaced by the master
      commit('Multicam edit'); emit('fit');
      toast(`🎥 ${vid.angles.length} cameras synced, ${S.project.tracks.V1.length} shots.${weak.length ? ` Check sync of: ${weak.map((a) => S.mediaById[a.mediaId].name).join(', ')} (weak match)` : ''}`, weak.length ? 'err' : undefined);
    } catch (err) { toast(err.message, 'err'); }
    finally { setBusy?.(false); }
  };
}
