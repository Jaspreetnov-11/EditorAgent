// ⚙ Batch + automation: the same job for many clips (subtitles, a transcript for the Text page, smart scan, a render of
// each clip on its own), now or overnight; and a watch folder that imports new footage and gives it those jobs.
import { S } from './store.js';
import { api, enc } from './api.js';
import { PRESETS } from './presets.js';
import { $, $$, esc, toast, modal } from './ui.js';
import { pickFolder, refreshMedia } from './mediapool.js';

let timer = null;
const STATE = { waiting: 'waiting', running: 'working', done: '✓ done', failed: 'failed', cancelled: 'cancelled' };

export function openBatch(selected = []) {
  const vids = S.media.filter((m) => m.kind === 'video' || m.kind === 'audio' || m.kind === 'image');
  const pre = new Set(selected.length ? selected : []);
  const dlg = modal('Batch & automation', `<div class="ptabs sm-tabs" role="tablist"><button role="tab" data-bt="batch" aria-selected="true">Batch</button><button role="tab" data-bt="watch" aria-selected="false">Watch folder</button></div>
    <div data-b="batch"><div class="pub-grid">
      <div><div class="row-in"><b class="grow">Clips (${vids.length})</b><button class="link small" data-all>all</button><button class="link small" data-none>none</button></div>
        <div class="bt-list">${vids.map((m) => `<label class="chk small"><input type="checkbox" data-id="${m.id}"${pre.has(m.id) ? ' checked' : ''}> ${esc(m.name)} <span class="muted">${m.kind}${m.duration ? ` · ${Math.round(m.duration)}s` : ''}</span></label>`).join('')}</div></div>
      <div><h4>Jobs for each clip</h4>
        <label class="chk"><input type="checkbox" data-a="subs"> Subtitles (.srt in Deliver › Subtitles)</label>
        <label class="chk"><input type="checkbox" data-a="transcript"> Transcript for the Text page</label>
        <label class="chk"><input type="checkbox" data-a="scan"> Smart scan (tags, search, bad clips)</label>
        <label class="chk"><input type="checkbox" data-a="convert"> Render each clip on its own</label>
        <div class="fgrid"><label class="fld"><span>Language</span><select data-lang><option value="auto">Auto</option><option value="hi">Hindi</option><option value="en">English</option></select></label>
          <label class="fld"><span>Accuracy</span><select data-model><option value="small">Fast</option><option value="medium" selected>Good</option><option value="large-v3">Best</option></select></label>
          <label class="fld"><span>Render as</span><select data-preset>${PRESETS.map((p) => `<option value="${p.id}"${p.id === 'whatsapp' ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
          <label class="fld"><span>Shape</span><select data-aspect><option value="">Each clip's own</option><option>16:9</option><option>9:16</option><option>1:1</option><option>4:5</option></select></label></div>
        <label class="chk"><input type="checkbox" data-logo checked> Project logo on renders</label>
        <label class="chk"><input type="checkbox" data-bsubs checked> Burn in the clip's subtitles (when it has some)</label>
        <h4>When</h4>
        <label class="chk"><input type="radio" name="bwhen" value="now" checked> Now</label>
        <label class="chk"><input type="radio" name="bwhen" value="later"> At <input type="datetime-local" data-at> (e.g. tonight - keep the editor running)</label>
        <button class="primary wide" data-go>Start batch</button></div></div>
      <h4 class="dv-h">Jobs <button class="link small" data-clear>Clear finished</button> <button class="link small" data-cancelall>Cancel waiting</button></h4><div class="dv-list bt-q" data-q></div></div>
    <div data-b="watch" hidden><p class="muted">Point this project at a folder (a card reader dump, a shared drive). Every minute, new files there are added to Media (folder "Watched") and get the jobs you tick - while the editor is running.</p>
      <div class="row-in"><input data-wf placeholder="Folder to watch"><button class="small" data-pick>Choose…</button></div>
      <label class="chk"><input type="checkbox" data-w="scan"> Smart scan new clips</label>
      <label class="chk"><input type="checkbox" data-w="transcript"> Transcript for the Text page</label>
      <label class="chk"><input type="checkbox" data-w="subs"> Subtitles</label>
      <label class="fld"><span>Spoken language</span><select data-wlang><option value="auto">Auto</option><option value="hi">Hindi</option><option value="en">English</option></select></label>
      <div class="dv-actions"><button class="primary" data-won>Watch this folder</button><button data-woff>Stop watching</button></div><p class="muted small" data-wst></p></div>`, { width: 900, onClose: () => clearTimeout(timer) });
  const el = dlg.el;
  el.querySelector('.sm-tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-bt]')?.dataset.bt; if (!t) return; $$('[data-bt]', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.bt === t))); $$('[data-b]', el).forEach((d) => (d.hidden = d.dataset.b !== t)); });
  $('[data-all]', el).onclick = () => $$('[data-id]', el).forEach((c) => (c.checked = true));
  $('[data-none]', el).onclick = () => $$('[data-id]', el).forEach((c) => (c.checked = false));
  const drawQ = async () => {
    const list = await api('GET', `/api/batch?p=${enc(S.proj)}`).catch(() => []);
    $('[data-q]', el).innerHTML = list.slice().reverse().slice(0, 80).map((x) => `<div class="dv-q-item ${x.state === 'running' ? 'rendering' : x.state}">
      <div class="dv-q-top"><span class="grow"><b>${esc(x.label)}</b> · ${esc(x.name)}${x.runAt && x.state === 'waiting' ? ` <span class="muted small">at ${new Date(x.runAt).toLocaleString()}</span>` : ''}</span><span class="muted small">${STATE[x.state]}</span>
      ${x.state === 'waiting' ? `<button class="link small" data-bc="${x.id}">✕</button>` : ''}${x.state === 'failed' ? `<button class="link small" data-br="${x.id}">⟳</button>` : ''}${x.result?.url ? `<a href="${x.result.url}?download" download></a>` : ''}</div>
      ${x.state === 'running' ? `<div class="bar"><div style="width:${Math.max(3, x.progress)}%"></div></div><div class="muted small">${esc(String(x.stage || '').slice(0, 120))}</div>` : ''}${x.error ? `<div class="warn small">${esc(x.error)}</div>` : ''}${x.result?.skipped ? `<div class="muted small">${esc(x.result.skipped)}</div>` : ''}</div>`).join('') || '<div class="muted">No batch jobs yet.</div>';
    clearTimeout(timer);
    if (list.some((x) => x.state === 'waiting' || x.state === 'running')) timer = setTimeout(() => { if (el.isConnected) { drawQ(); refreshMedia(); } }, 2000);
  };
  drawQ();
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.go !== undefined) {
        const ids = $$('[data-id]', el).filter((c) => c.checked).map((c) => c.dataset.id), actions = $$('[data-a]', el).filter((c) => c.checked).map((c) => c.dataset.a);
        const later = $('input[name="bwhen"]:checked', el).value === 'later', at = $('[data-at]', el).value;
        if (later && !at) return toast('Pick the time', 'err');
        const lang = $('[data-lang]', el).value, model = $('[data-model]', el).value;
        const r = await api('POST', `/api/batch?p=${enc(S.proj)}`, { ids, actions, runAt: later ? new Date(at).toISOString() : null,
          opts: { subs: { lang, model }, transcript: { lang, model }, convert: { preset: $('[data-preset]', el).value, aspect: $('[data-aspect]', el).value || undefined, logo: $('[data-logo]', el).checked, subs: $('[data-bsubs]', el).checked } } });
        toast(`${r.added} job${r.added > 1 ? 's' : ''} added${later ? ` - they start at ${new Date(at).toLocaleString()}` : ''}`); drawQ();
      }
      if (b.dataset.bc) { await api('POST', `/api/batch/cancel?id=${b.dataset.bc}`); drawQ(); }
      if (b.dataset.br) { await api('POST', `/api/batch/retry?id=${b.dataset.br}`); drawQ(); }
      if (b.dataset.clear !== undefined) { await api('POST', `/api/batch/clear?p=${enc(S.proj)}`); drawQ(); }
      if (b.dataset.cancelall !== undefined) { await api('POST', `/api/batch/cancel?all=1&p=${enc(S.proj)}`); drawQ(); }
      if (b.dataset.pick !== undefined) { const f = await pickFolder('Folder to watch', 'New files that appear here are added to this project.'); if (f) $('[data-wf]', el).value = f; }
      if (b.dataset.won !== undefined || b.dataset.woff !== undefined) {
        const on = b.dataset.won !== undefined;
        const w = { folder: $('[data-wf]', el).value.trim(), on, lang: $('[data-wlang]', el).value, ...Object.fromEntries($$('[data-w]', el).map((c) => [c.dataset.w, c.checked])) };
        if (on && !w.folder) return toast('Choose the folder first', 'err');
        const a = await api('PUT', `/api/automation?p=${enc(S.proj)}`, { watch: w });
        drawWatch(a); toast(on ? 'Watching - new files will appear in Media › Watched' : 'Stopped watching');
      }
    } catch (err) { toast(err.message, 'err'); }
  });
  const drawWatch = (a) => {
    const w = a.watch || {};
    $('[data-wf]', el).value = w.folder || '';
    $$('[data-w]', el).forEach((c) => (c.checked = !!w[c.dataset.w]));
    $('[data-wlang]', el).value = w.lang || 'auto';
    $('[data-wst]', el).textContent = w.on ? `Watching ${w.folder}${w.checked ? ` · last looked ${new Date(w.checked).toLocaleTimeString()}` : ''}${w.found ? ` · ${w.found} files added so far` : ''}` : 'Not watching.';
  };
  api('GET', `/api/automation?p=${enc(S.proj)}`).then(drawWatch).catch(() => {});
}
