// 🔊 Audio Gain (Premiere's, G): the selected clips' sound made louder / quieter in dB - set to a level, changed by an
// amount, or normalised so the loudest moment of each clip reaches a level. Kept as the clip's volume (1 = 0 dB, it may go
// past 2 = +6 dB); a linked picture's sound is its audio clip. Keyframed volume keeps its shape and moves as a whole.
import { S, commit, findClip } from './store.js';
import { api, enc } from './api.js';
import { h, modal, toast } from './ui.js';
import { linkedPartner } from './model.js';

const MAX = 16; // +24 dB
export const toDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const fromDb = (db) => Math.pow(10, db / 20);
const fmtDb = (db) => (Number.isFinite(db) ? `${db > 0 ? '+' : ''}${db.toFixed(1)} dB` : '-∞ dB');

// the clips whose sound the selection means (each once)
export function soundClips(ids = [...S.sel]) {
  const out = new Map();
  for (const id of ids) {
    const f = findClip(id); if (!f) continue;
    const c = f.clip;
    if (c.type === 'audio') { out.set(c.id, c); continue; }
    if (c.type !== 'video') continue;
    const p = linkedPartner(S.project, c);
    if (p?.clip.type === 'audio') out.set(p.clip.id, p.clip);
    else if (S.mediaById[c.mediaId]?.hasAudio) out.set(c.id, c);
  }
  return [...out.values()];
}
const gainOf = (c) => c.volume ?? 1;
function scale(c, k) {
  c.volume = +Math.min(MAX, Math.max(0, gainOf(c) * k)).toFixed(4);
  for (const key of c.keys?.volume || []) key.v = +Math.min(MAX, Math.max(0, key.v * k)).toFixed(4);
}

export function openAudioGain() {
  const list = soundClips();
  if (!list.length) return toast('Select a clip with sound first (audio, or a video with its sound)', 'err');
  const now = list.length === 1 ? fmtDb(toDb(gainOf(list[0]))) : 'different per clip';
  const body = h(`<div class="again">
    <p class="muted small">${list.length} clip${list.length > 1 ? 's' : ''} · gain now: <b>${now}</b></p>
    <label class="ag-row"><input type="radio" name="ag" value="set"> <span>Set gain to</span> <input type="number" data-v="set" step="0.5" value="0"> dB</label>
    <label class="ag-row"><input type="radio" name="ag" value="adj" checked> <span>Adjust gain by</span> <input type="number" data-v="adj" step="0.5" value="3"> dB</label>
    <label class="ag-row"><input type="radio" name="ag" value="norm"> <span>Normalize max peak to</span> <input type="number" data-v="norm" step="0.5" value="-1" max="0"> dB</label>
    <small class="hint">Normalize measures each clip's loudest moment and sets it to that level (each clip on its own). Heard live, exact in renders.</small>
    <div class="iactions"><button data-close>Cancel</button><button class="primary" data-ok>OK</button></div></div>`);
  const dlg = modal('🔊 Audio Gain', body, { width: 420 });
  body.querySelectorAll('[data-v]').forEach((i) => i.addEventListener('focus', () => { body.querySelector(`input[value="${i.dataset.v}"]`).checked = true; }));
  body.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') body.querySelector('[data-ok]').click(); });
  body.querySelector('[data-ok]').addEventListener('click', async (e) => {
    const mode = body.querySelector('input[name="ag"]:checked').value, db = +body.querySelector(`[data-v="${mode}"]`).value || 0;
    const btn = e.target; btn.disabled = true;
    try {
      if (mode === 'set') for (const c of list) { const k = fromDb(db) / Math.max(1e-6, gainOf(c)); if (c.keys?.volume?.length) scale(c, k); else c.volume = +Math.min(MAX, fromDb(db)).toFixed(4); }
      if (mode === 'adj') for (const c of list) scale(c, fromDb(db));
      if (mode === 'norm') {
        btn.textContent = 'Measuring…';
        for (const c of list) {
          const r = await api('GET', `/api/audio/peak?p=${enc(S.proj)}&id=${c.mediaId}&in=${c.in || 0}&out=${c.out ?? ''}`);
          // the file's peak is at gain 1: the new gain brings it to the level asked for
          const k = fromDb(Math.min(0, db) - r.peak) / Math.max(1e-6, gainOf(c));
          scale(c, k);
        }
      }
      for (const c of list) if (c.volume === 1 && !(c.type === 'video')) delete c.volume;
      commit(`Audio gain (${mode === 'norm' ? `normalize to ${db} dB` : mode === 'set' ? `set to ${db} dB` : `${db > 0 ? '+' : ''}${db} dB`})`);
      toast(`🔊 Gain ${list.length === 1 ? `now ${fmtDb(toDb(gainOf(list[0])))}` : `changed on ${list.length} clips`}`);
      dlg.close();
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = 'OK'; }
  });
}
