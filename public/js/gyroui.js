// 🛸 Gyroflow in Effect Controls: stabilise a shot with its gyro data (GoPro / DJI / Insta360 / Sony inside the file,
// FPV drones from the flight log next to the video). The stabilised copy goes into Media (bin "Gyroflow") and onto
// the clip in place of the shaky one, same In / Out; "Back to the original" swaps it back.
import { S, commit, findClip, emit } from './store.js';
import { api, enc, watchJob } from './api.js';
import { esc, toast } from './ui.js';
import { refreshMedia } from './mediapool.js';

let installed = null;
const last = { smoothness: 0.5, horizon: 0, zoom: 1, gyroFile: '' };

export function gyroHTML(c) {
  if (installed === null) api('GET', '/api/gyroflow/status').then((r) => { installed = r.installed; emit('select'); }).catch(() => {});
  if (installed === false) return '<p class="muted small">Gyroflow is not installed on the editing computer (tools/gyroflow).</p>';
  if (c.gyroflow) {
    return `<p class="small">✅ Stabilised with Gyroflow${c.gyroflow.gyroFile ? ` (flight log ${esc(c.gyroflow.gyroFile)})` : ''} - smoothness ${Math.round((c.gyroflow.smoothness ?? 0.5) * 100)}%${c.gyroflow.horizon ? `, horizon lock ${c.gyroflow.horizon}%` : ''}.</p>
      <div class="iactions"><button class="small" data-gf="back">↩ Back to the original</button><button class="small" data-gf="redo">Do it again with these settings</button></div>${fields(c.gyroflow)}`;
  }
  return `${fields(last)}<div class="iactions"><button class="small accent" data-gf="go">🛸 Stabilize with Gyroflow</button></div>
    <small class="hint">Uses the camera's gyro data - smoother than picture-based stabilizing, even for fast FPV flights. GoPro, DJI, Insta360, Sony have it inside the file; an FPV drone needs its flight log (.bbl / .bfl / .csv) - put it next to the video with the same name, or paste its path above. Makes a new stabilised file.</small>`;
}
const fields = (o) => `<div class="fgrid">
  <label class="fld"><span>Smoothness <b data-gfv="smoothness">${Math.round((o.smoothness ?? 0.5) * 100)}%</b></span><input type="range" data-gfp="smoothness" min="0.05" max="1" step="0.05" value="${o.smoothness ?? 0.5}"></label>
  <label class="fld"><span>Horizon lock (FPV) <b data-gfv="horizon">${o.horizon || 0}%</b></span><input type="range" data-gfp="horizon" min="0" max="100" step="5" value="${o.horizon || 0}"></label>
  <label class="fld"><span>Extra zoom <b data-gfv="zoom">${Math.round((o.zoom || 1) * 100)}%</b></span><input type="range" data-gfp="zoom" min="1" max="1.5" step="0.05" value="${o.zoom || 1}"></label>
  <label class="fld wide"><span>Flight log (FPV, optional)</span><input type="text" data-gfp="gyroFile" placeholder="Auto: a .bbl / .csv with the video's name" value="${esc(o.gyroFile || '')}"></label></div>`;

export function bindGyro(root, id, rerender) {
  const box = root.querySelector('[data-sec="gyro"]'); if (!box) return;
  const vals = () => { const v = {}; box.querySelectorAll('[data-gfp]').forEach((i) => { v[i.dataset.gfp] = i.type === 'range' ? +i.value : i.value.trim(); }); return v; };
  box.querySelectorAll('[data-gfp]').forEach((i) => i.addEventListener('input', () => {
    const b = box.querySelector(`[data-gfv="${i.dataset.gfp}"]`), k = i.dataset.gfp;
    if (b) b.textContent = k === 'horizon' ? `${i.value}%` : `${Math.round(+i.value * 100)}%`;
    if (!findClip(id)?.clip.gyroflow) Object.assign(last, vals());
  }));
  box.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-gf]')?.dataset.gf; if (!a) return;
    const c = findClip(id)?.clip; if (!c) return;
    if (a === 'back') { c.mediaId = c.gyroflow.from; delete c.gyroflow; commit('Gyroflow off'); rerender(); return; }
    const btn = e.target.closest('button'), v = vals(), src = c.gyroflow?.from || c.mediaId;
    btn.disabled = true; btn.textContent = 'Starting Gyroflow…';
    try {
      const j = await api('POST', `/api/gyroflow?p=${enc(S.proj)}`, { mediaId: src, ...v });
      const done = await watchJob(j.id, (s) => { btn.textContent = `🛸 ${s.progress || 0}% · ${s.stage || 'Working'}`; });
      await refreshMedia(); // (the new file is known here before the clip points at it)
      const now = findClip(id)?.clip; if (!now) return;
      now.mediaId = done.result.mediaId;
      now.gyroflow = { from: src, gyroFile: done.result.gyroFile, smoothness: v.smoothness, horizon: v.horizon, zoom: v.zoom, ...(v.gyroFile ? { gyroFile: v.gyroFile } : {}) };
      commit('Stabilize with Gyroflow'); rerender();
      toast('🛸 Stabilised with Gyroflow - the new file is in Media › Gyroflow');
    } catch (err) {
      toast(err.job ? err.job.log.slice(-1)[0] || 'Gyroflow failed' : err.message, 'err');
      btn.disabled = false; btn.textContent = a === 'redo' ? 'Do it again with these settings' : '🛸 Stabilize with Gyroflow';
    }
  });
}
