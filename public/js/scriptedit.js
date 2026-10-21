// 📜 Script se edit: an A/V script (Word / PDF / pasted) -> scenes you can check and fix -> the agent finds footage for every
// scene, lines it up with the recorded voice-over, puts SUPERs on screen and captions the VO with the script's own words.
import { S } from './store.js';
import { api, enc } from './api.js';
import { fmt } from './model.js';
import { $, $$, h, esc, toast, modal } from './ui.js';
import { uploadAudioInto } from './mediapool.js';
import { runAgentWith } from './agent.js';

export function openScriptEdit(setBusy) {
  const audio = S.media.filter((m) => m.kind === 'audio');
  const footage = S.media.filter((m) => (m.kind === 'video' || m.kind === 'image') && m.status === 'ready');
  const bins = {};
  footage.forEach((m) => (bins[m.bin || 'Other'] ||= []).push(m));
  let scenes = [];
  const body = h(`<div class="ag se">
    <section><h3>1. Script</h3>
      <div class="row-in"><label class="btn">📄 Open script file (.docx / .pdf / .txt)<input type="file" hidden name="file" accept=".docx,.pdf,.txt,.srt"></label><span class="muted small" data-fname></span></div>
      <details><summary class="muted small">…or paste the script text (a table copied from Word works too)</summary>
        <textarea name="paste" rows="6" placeholder="VISUAL: Drone shot of the waterfall at sunrise&#10;VO: छत्तीसगढ़ - जहाँ प्रकृति खुद कहानी कहती है।&#10;SUPER: Chitrakote Falls&#10;&#10;VISUAL: Tribal dancers&#10;VO: यहाँ की संस्कृति, यहाँ के लोग।"></textarea>
        <button type="button" class="small" data-a="paste">Read pasted script</button></details>
      <ul class="warns" data-warn hidden></ul>
      <div class="se-scenes" data-scenes><p class="muted small">Open or paste a script - its scenes appear here to check before editing.</p></div>
    </section>
    <section><h3>2. Footage</h3>
      <div class="se-bins">${Object.entries(bins).map(([b, l]) => `<label class="chk"><input type="checkbox" data-bin="${esc(b)}" checked> ${esc(b)} <span class="muted">(${l.length})</span></label>`).join('') || '<span class="muted">Import footage first (Media page).</span>'}</div>
    </section>
    <section><h3>3. Sound</h3>
      <div class="fgrid">
        <div class="fld wide"><span>Recorded voice-over (optional - without it the script's timing is used)</span>
          <div class="row-in"><select name="vo"><option value="">No recording yet</option>${audio.map((m) => `<option value="${m.id}">${esc(m.name)} (${fmt(m.duration)})</option>`).join('')}</select><label class="btn small">⬆ Upload VO<input type="file" hidden name="voFile" accept="audio/*,video/*"></label></div></div>
        <label class="fld"><span>VO language</span><select name="voLang"><option value="hi">Hindi</option><option value="en">English</option><option value="auto">Auto-detect</option></select></label>
        <label class="fld"><span>Listening accuracy</span><select name="whisperModel"><option value="small">Fast</option><option value="medium" selected>Good</option><option value="large-v3">Best (slow)</option></select></label>
        <div class="fld wide"><span>Music</span>
          <div class="row-in"><select name="music"><option value="">No music</option>${audio.map((m) => `<option value="${m.id}">${esc(m.name)} (${fmt(m.duration)})</option>`).join('')}</select><label class="btn small">⬆ Upload music<input type="file" hidden name="musicFile" accept="audio/*"></label></div></div>
      </div>
    </section>
    <section><h3>4. Finish</h3>
      <div class="fgrid">
        <label class="fld"><span>Format</span><select name="aspect"><option value="16:9">16:9 YouTube / Film</option><option value="9:16">9:16 Reel / Shorts</option><option value="1:1">1:1 Square</option><option value="4:5">4:5 Feed</option></select></label>
        <label class="fld"><span>Pace inside a scene</span><select name="pace"><option value="fast">Fast cuts (~1.7 s)</option><option value="medium" selected>Medium (~2.8 s)</option><option value="slow">Slow, one long shot (~4 s)</option></select></label>
        <label class="fld"><span>Transitions</span><select name="style"><option value="cinematic">Dissolve between scenes</option><option value="cuts">Clean cuts</option></select></label>
        <label class="chk"><input type="checkbox" name="autoColor" checked> Auto colour every shot</label>
        <label class="chk"><input type="checkbox" name="subtitles" checked> Captions from the script's words (needs the VO recording)</label>
        <label class="fld"><span>End card</span><input name="endText" placeholder="e.g. mybharat.gov.in"></label>
      </div>
    </section>
    <div class="ag-foot"><span class="muted small" data-sum></span><span class="grow"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" data-a="go">📜 Create edit from script</button></div>
  </div>`);
  const dlg = modal('📜 Script se edit', body, { width: 900 });
  const f = (n) => body.querySelector(`[name="${n}"]`);

  const est = (s) => +(s.dur ?? (s.vo ? Math.min(30, Math.max(2, s.vo.split(/\s+/).length / 2.4 + 0.8)) : 3)).toFixed(1);
  const summary = () => {
    const t = scenes.reduce((a, s) => a + est(s), 0), v = S.mediaById[f('vo').value];
    $('[data-sum]', body).textContent = scenes.length ? `${scenes.length} scenes · ${v ? `follows the VO (${fmt(v.duration)})` : `about ${fmt(t)} from the script`}` : '';
  };
  const draw = () => {
    $('[data-scenes]', body).innerHTML = scenes.length ? `<table class="se-table"><thead><tr><th>#</th><th>Visual (what to show)</th><th>VO (what is said)</th><th>Super (on screen)</th><th>Sec</th><th></th></tr></thead><tbody>
      ${scenes.map((s, i) => `<tr data-i="${i}"><td>${i + 1}</td>
        <td><textarea data-k="visual" rows="2">${esc(s.visual)}</textarea></td>
        <td><textarea data-k="vo" rows="2">${esc(s.vo)}</textarea></td>
        <td><input data-k="super" value="${esc(s.super)}"></td>
        <td><input data-k="dur" type="number" min="0.5" step="0.5" value="${s.dur ?? ''}" placeholder="${est(s)}" title="Seconds (only used without a VO recording)"></td>
        <td><button type="button" class="small" data-del="${i}" title="Remove scene">🗑</button></td></tr>`).join('')}</tbody></table>
      <button type="button" class="small" data-a="add">+ Add scene</button>` : '<p class="muted small">No scenes yet.</p>';
    summary();
  };
  const load = async (promise, label) => {
    try {
      const r = await promise;
      scenes = r.scenes; draw();
      $('[data-warn]', body).hidden = !r.warnings.length;
      $('[data-warn]', body).innerHTML = r.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
      $('[data-fname]', body).textContent = r.title ? `${label} · "${r.title}"` : label;
      toast(`${scenes.length} scenes read - check them, then Create`);
    } catch (e) { toast(e.message, 'err'); }
  };
  f('file').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    $('[data-fname]', body).textContent = file.name;
    load(fetch(`/api/script/parse?p=${enc(S.proj)}&name=${enc(file.name)}`, { method: 'POST', body: file }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; }), file.name);
    e.target.value = '';
  };
  f('voFile').onchange = (e) => uploadAudioInto(e.target, f('vo')).then(summary);
  f('musicFile').onchange = (e) => uploadAudioInto(e.target, f('music'));
  f('vo').onchange = summary;
  body.addEventListener('input', (e) => {
    const k = e.target.dataset.k, tr = e.target.closest('tr[data-i]');
    if (!k || !tr) return;
    const s = scenes[+tr.dataset.i];
    s[k] = k === 'dur' ? (e.target.value ? +e.target.value : null) : e.target.value;
    summary();
  });
  body.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { scenes.splice(+del.dataset.del, 1); return draw(); }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'paste') load(api('POST', `/api/script/parse?p=${enc(S.proj)}`, { text: f('paste').value }), 'pasted text');
    if (a === 'add') { scenes.push({ visual: '', vo: '', super: '', dur: null }); draw(); }
    if (a === 'go') {
      const sc = scenes.map((s) => ({ visual: s.visual.trim(), vo: s.vo.trim(), super: s.super.trim(), dur: s.dur })).filter((s) => s.visual || s.vo || s.super);
      if (!sc.length) return toast('Open or paste a script first', 'err');
      const on = new Set($$('[data-bin]', body).filter((x) => x.checked).map((x) => x.dataset.bin));
      const clips = footage.filter((m) => on.has(m.bin || 'Other')).map((m) => m.id);
      if (!clips.length) return toast('Tick some footage', 'err');
      const vo = f('vo').value || null;
      const o = {
        scenes: sc, clips, vo, voLang: f('voLang').value, whisperModel: f('whisperModel').value, music: f('music').value || null, musicBest: true, keepSound: false,
        aspect: f('aspect').value, pace: f('pace').value, target: Math.round(sc.reduce((t, s) => t + est(s), 0)), autoColor: f('autoColor').checked, detectLog: true,
        subtitles: !!vo && f('subtitles').checked, style: f('style').value, title: '', endText: f('endText').value.trim(),
        names: [...new Set(sc.map((s) => s.super).filter(Boolean))].join(', ').slice(0, 400), outline: '',
      };
      dlg.close();
      runAgentWith(o, setBusy);
    }
  });
}

// Optional script for the normal Agent / Re-edit: "📜 Add script" -> scenes kept in `state.scenes`.
// With a script the captions use its exact spellings and its visual notes guide the shot choice.
export function scriptPicker(state, onChange = () => {}) {
  const el = h(`<div class="fld wide sp-box"><span>Script (optional - better captions and shot choice)</span>
    <div class="row-in"><label class="btn small">📜 Add script (.docx / .pdf / .txt)<input type="file" hidden accept=".docx,.pdf,.txt"></label>
    <button type="button" class="btn small" data-paste>Paste</button><span class="muted small grow" data-st></span><button type="button" class="btn small" data-clear hidden>✕</button></div>
    <textarea rows="4" hidden placeholder="Paste the script: VISUAL: … / VO: … / SUPER: …, or a table copied from Word"></textarea></div>`);
  const st = $('[data-st]', el), ta = $('textarea', el);
  const show = (label) => {
    st.textContent = state.scenes?.length ? `${state.scenes.length} scenes${label ? ` from ${label}` : ''} - captions follow the script` : '';
    $('[data-clear]', el).hidden = !state.scenes?.length; onChange();
  };
  const take = async (p, label) => {
    try { const r = await p; if (!r.scenes.length) throw new Error(r.warnings[0] || 'No scenes found'); state.scenes = r.scenes; show(label); if (r.warnings.length) toast(r.warnings[0]); }
    catch (e) { toast(e.message, 'err'); }
  };
  $('input', el).onchange = (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    take(fetch(`/api/script/parse?p=${enc(S.proj)}&name=${enc(file.name)}`, { method: 'POST', body: file }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; }), file.name);
  };
  $('[data-paste]', el).onclick = () => { ta.hidden = !ta.hidden; if (!ta.hidden) ta.focus(); };
  ta.onchange = () => { if (ta.value.trim()) take(api('POST', `/api/script/parse?p=${enc(S.proj)}`, { text: ta.value }), 'pasted text'); };
  $('[data-clear]', el).onclick = () => { state.scenes = null; ta.value = ''; show(); };
  show(state.scenes?.length ? 'this edit' : '');
  return el;
}
