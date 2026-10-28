// 🧪 Auto QC (Phase 22): check a finished render - or the edit as it is now - before it goes out. The server
// (engine/qc.mjs) looks at every frame and the sound for the chosen channel; with "spelling" Claude reads every title.
// Each problem has a time: clicking it plays the render there (or moves the playhead, for the edit).
import { S, emit } from './store.js';
import { api, enc, watchJob } from './api.js';
import { esc, toast, modal } from './ui.js';

const CHANNELS = [['broadcast', 'Doordarshan / TV channel (EBU R128, broadcast-safe)'], ['youtube', 'YouTube'], ['instagram', 'Instagram / Facebook reel'], ['whatsapp', 'WhatsApp']];
const ICON = { fail: '<i class="qc-dot fail"></i>', warn: '<i class="qc-dot warn"></i>', ok: '<i class="qc-dot ok"></i>' };
const tc = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
// (reports kept from before Phase 22's restyle start with a symbol - the coloured dot says it now)
const plain = (s) => String(s).replace(/^[^\p{L}\p{N}"'(]+/u, '');
// the channel a render was made for, from its name (…_reel_1080p_v1.mp4) or the project's export preset
function guess(file) {
  const k = String(file || S.project?.settings?.exportPreset || '');
  return /reel|shorts|feed|fb|facebook|insta/i.test(k) ? 'instagram' : /whatsapp/i.test(k) ? 'whatsapp' : 'youtube';
}

// file: a render's name, or null = the edit now (a fast preview is made first). onSeek(t, file) plays / moves there.
export async function openQC(file, onSeek) {
  const last = file ? await api('GET', `/api/qc?p=${enc(S.proj)}&file=${enc(file)}`).catch(() => null) : null;
  const body = document.createElement('div');
  body.className = 'qc';
  body.innerHTML = `<p class="muted small">${file ? `<b>${esc(file)}</b>` : 'The edit as it is now (a quick preview is made first)'} - black frames, a stuck picture, flashing, broadcast-safe colours, loudness and peaks for the channel${file ? '' : ', the shape and length'}.</p>
    <div class="fgrid"><label class="fld"><span>Going to</span><select name="target">${CHANNELS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
    <label class="chk"><input type="checkbox" name="spell" checked> Check the spelling of the titles (Limelight AI)</label></div>
    <div class="dv-actions"><button class="primary" data-go>Run QC</button></div>
    <div class="job" data-job hidden><div class="job-top"><span data-st>Starting…</span><span data-pc></span></div><div class="bar"><div data-bar></div></div></div>
    <div data-out></div>`;
  body.querySelector('[name=target]').value = guess(file);
  const m = modal('QC check', body, { width: 680 });
  const show = (rep) => {
    const c = rep.counts;
    body.querySelector('[data-out]').innerHTML = `<div class="qc-sum ${c.fail ? 'bad' : c.warn ? 'meh' : 'good'}">${c.fail ? `${c.fail} problem${c.fail > 1 ? 's' : ''} to fix` : c.warn ? 'Passes, with things to look at' : 'Ready to send'} · ${esc(rep.target)}${rep.preview ? ' · checked on a low-res preview' : ''}</div>
      <ul class="qc-list">${rep.items.map((i) => `<li class="qc-${i.level}">${ICON[i.level]} <span>${esc(plain(i.text))}</span>${i.t != null ? `<button class="link small" data-t="${i.t}">${tc(i.t)}</button>` : ''}</li>`).join('')}</ul>
      ${rep.at ? `<p class="muted small">Checked ${new Date(rep.at).toLocaleString()}</p>` : ''}`;
    body.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => {
      const t = +b.dataset.t;
      if (onSeek) onSeek(t, file); else { S.playhead = t; emit('playhead'); }
    }));
  };
  if (last) show(last);
  body.querySelector('[data-go]').onclick = async () => {
    const go = body.querySelector('[data-go]'), job = body.querySelector('[data-job]');
    go.disabled = true; job.hidden = false;
    try {
      const r = await api('POST', `/api/qc?p=${enc(S.proj)}`, { file: file || undefined, project: file ? undefined : S.project, target: body.querySelector('[name=target]').value, spell: body.querySelector('[name=spell]').checked });
      const j = await watchJob(r.id, (x) => { body.querySelector('[data-st]').textContent = x.stage || 'Working…'; body.querySelector('[data-pc]').textContent = `${x.progress || 0}%`; body.querySelector('[data-bar]').style.width = `${x.progress || 0}%`; });
      show(j.result);
    } catch (e) { toast(e.job?.log?.slice(-1)[0] || e.message, 'err'); }
    finally { go.disabled = false; job.hidden = true; }
  };
  return m;
}
