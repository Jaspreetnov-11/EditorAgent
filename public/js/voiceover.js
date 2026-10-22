// 🎙 AI voice-over (text -> voice, with subtitles) and 🌐 dub / re-voice of a clip (its lines heard, translated or
// edited, spoken again by an AI voice and fitted to the original timing). Voices: Microsoft Edge (free, internet)
// or ElevenLabs (your key). See engine/voices.mjs.
import { S, commit, emit, findClip, layout } from './store.js';
import { api, enc, watchJob } from './api.js';
import { uid, fmt } from './model.js';
import { h, esc, toast, modal } from './ui.js';
import { refreshMedia } from './mediapool.js';

const LAST = 'vedit.voice';
const remembered = () => { try { return JSON.parse(localStorage.getItem(LAST)) || {}; } catch { return {}; } };
const remember = (o) => { try { localStorage.setItem(LAST, JSON.stringify(o)); } catch {} };

// provider + voice + speed controls, shared by both dialogs
export function voicePicker(body) {
  const last = remembered();
  const el = h(`<div class="fgrid vo-pick">
    <label class="fld"><span>Voice from</span><select name="provider"><option value="edge">Microsoft Edge voices (free, needs internet)</option><option value="eleven">ElevenLabs (your key, paid)</option></select></label>
    <label class="fld"><span>Voice <button type="button" class="link small" data-a="elkey">ElevenLabs key…</button></span><select name="voice"><option>Loading…</option></select></label>
    <label class="fld"><span>Speed <b data-rate>0%</b></span><input type="range" name="rate" min="-30" max="30" step="5" value="${last.rate || 0}"></label>
  </div>`);
  body.append(el);
  const f = (n) => el.querySelector(`[name="${n}"]`);
  const load = async () => {
    const sel = f('voice'); sel.innerHTML = '<option>Loading…</option>';
    try {
      let v = await api('GET', `/api/tts/voices?provider=${f('provider').value}`);
      if (f('provider').value === 'edge') v = v.filter((x) => /^(hi-|en-IN|en-US|en-GB|bn-|mr-|ta-|te-|gu-|kn-|ml-|ur-)/.test(x.locale));
      sel.innerHTML = v.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.locale)}${x.gender ? ` · ${esc(x.gender)}` : ''}${x.own ? ' · yours' : ''}</option>`).join('');
      if (last.voice && v.some((x) => x.id === last.voice)) sel.value = last.voice;
    } catch (err) { sel.innerHTML = '<option value="">-</option>'; toast(err.message, 'err'); }
  };
  if (last.provider) f('provider').value = last.provider;
  f('provider').onchange = load;
  f('rate').oninput = () => (el.querySelector('[data-rate]').textContent = `${f('rate').value > 0 ? '+' : ''}${f('rate').value}%`);
  f('rate').oninput();
  el.querySelector('[data-a="elkey"]').onclick = async () => {
    const key = prompt('Paste your ElevenLabs API key (elevenlabs.io > Profile > API keys). It is kept only on this computer.');
    if (key === null) return;
    try { const r = await api('PUT', '/api/settings/elevenlabs', { key }); toast(r.elevenlabs ? `✓ ElevenLabs works - ${r.voices} voices` : 'ElevenLabs key removed'); f('provider').value = r.elevenlabs ? 'eleven' : 'edge'; load(); }
    catch (err) { toast(err.message, 'err'); }
  };
  load();
  return () => { const o = { provider: f('provider').value, voice: f('voice').value, rate: +f('rate').value }; remember(o); return o; };
}

// text: prefilled; onDone(mediaId) - e.g. the Agent picks it as its VO. Without onDone it can go on A1 at the playhead.
export function openVoiceOver({ text = '', onDone = null, setBusy = null } = {}) {
  const scenes = S.project.agentOpts?.scenes;
  const pre = text || (scenes?.length ? scenes.map((s) => s.vo).filter(Boolean).join('\n\n') : '');
  const body = h(`<div class="vo">
    <label class="fld wide"><span>What the voice says (Hindi, English or Hinglish - a blank line = a short pause)</span>
      <textarea name="text" rows="9" placeholder="बस्तर… जहाँ जंगल सिर्फ जंगल नहीं, एक अनुभव है।">${esc(pre.replace(/\*+/g, ''))}</textarea></label>
    <div data-picker></div>
    <label class="chk"><input type="checkbox" name="subs" checked> Subtitles from this voice-over (exact words, timed to the voice)</label>
    ${onDone ? '' : '<label class="chk"><input type="checkbox" name="place" checked> Put it on A1 (Voice-over) at the playhead</label>'}
    <div class="ag-foot"><span class="muted small" data-count></span><span class="grow"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" data-go>🎙 Make the voice-over</button></div></div>`);
  const dlg = modal('🎙 AI voice-over', body, { width: 640 });
  const pick = voicePicker(body.querySelector('[data-picker]'));
  const ta = body.querySelector('[name="text"]'), cnt = () => (body.querySelector('[data-count]').textContent = `${ta.value.trim().length} characters`);
  ta.oninput = cnt; cnt();
  body.querySelector('[data-go]').onclick = async () => {
    const v = pick(); if (!v.voice) return toast('Choose a voice', 'err');
    const subs = body.querySelector('[name="subs"]').checked, place = body.querySelector('[name="place"]')?.checked;
    dlg.close(); setBusy?.(true, '🎙 Making the voice-over…');
    try {
      const job = await api('POST', `/api/tts?p=${enc(S.proj)}`, { ...v, text: ta.value, subtitles: subs });
      const r = (await watchJob(job.id, () => {})).result;
      await refreshMedia();
      if (onDone) onDone(r.mediaId, r);
      else if (place && r.mediaId) {
        S.project.tracks.A1.push({ id: uid(), type: 'audio', mediaId: r.mediaId, start: +S.playhead.toFixed(3), in: 0, volume: 1 });
        if (r.subs) S.project.subtitles = { ...S.project.subtitles, file: r.subs };
        commit('AI voice-over'); emit('subs');
      }
      toast(`🎙 Voice-over ready (${fmt(r.duration)})${r.subs ? ' with subtitles' : ''} - it is in the "AI voice-over" bin`);
    } catch (err) { toast(err.message, 'err'); }
    finally { setBusy?.(false); }
  };
}

export const parseSrt = (txt) => txt.replace(/\r/g, '').split(/\n\n+/).map((b) => {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)\n([\s\S]*)/.exec(b.trim());
  if (!m) return null;
  const s = (a, b2, c, d) => +a * 3600 + +b2 * 60 + +c + +d / 1000;
  return { start: s(m[1], m[2], m[3], m[4]), end: s(m[5], m[6], m[7], m[8]), text: m[9].trim().replace(/\n/g, ' ') };
}).filter(Boolean);

// Dub / re-voice the selected clip (V1 video or A1 audio): its own speech is heard first, then edited, then spoken.
export function openDub(clipId, setBusy) {
  const f0 = findClip(clipId), c = f0?.clip, m = c && S.media.find((x) => x.id === c.mediaId);
  if (!c || !m?.hasAudio) return toast('Select a clip that has speech', 'err');
  const body = h(`<div class="vo dub">
    <div class="fgrid">
      <label class="fld"><span>New language</span><select name="task"><option value="translate">English (translate the speech)</option><option value="transcribe">Same language (clean AI re-voice)</option><option value="own">My own lines (paste a translation)</option></select></label>
      <label class="fld"><span>The clip speaks</span><select name="lang"><option value="auto">Auto-detect</option><option value="hi">Hindi</option><option value="en">English</option></select></label>
    </div>
    <div class="row-in"><button type="button" class="small accent" data-listen>👂 Listen to the clip</button><span class="muted small" data-st>${esc(m.name)} · ${fmt((c.out ?? m.duration) - (c.in || 0))}</span></div>
    <div class="dub-lines" data-lines><p class="muted small">Press "Listen": its lines appear here, timed. Edit or replace any text (e.g. paste your Hindi translation) before making the voice.</p></div>
    <div data-picker></div>
    <label class="chk"><input type="checkbox" name="duck" checked> Keep the clip's own sound quietly underneath (ambience)</label>
    <div class="ag-foot"><span class="grow"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" data-go disabled>🌐 Make the dub</button></div></div>`);
  const dlg = modal('🌐 Dub / re-voice with AI', body, { width: 720 });
  const pick = voicePicker(body.querySelector('[data-picker]'));
  let lines = [];
  const tin = c.in || 0, tout = c.out ?? m.duration;
  const draw = () => {
    body.querySelector('[data-lines]').innerHTML = `<table class="se-table"><tr><th>Time</th><th>Line</th></tr>${lines.map((l, i) => `<tr><td class="muted">${fmt(l.start - tin)}</td><td><textarea data-i="${i}" rows="1">${esc(l.text)}</textarea></td></tr>`).join('')}</table>`;
    body.querySelector('[data-go]').disabled = !lines.length;
  };
  body.addEventListener('input', (e) => { const i = e.target.dataset.i; if (i !== undefined) lines[+i].text = e.target.value; });
  body.querySelector('[data-listen]').onclick = async (e) => {
    const b = e.target; b.disabled = true; b.textContent = 'Listening…';
    const task = body.querySelector('[name="task"]').value;
    try {
      const job = await api('POST', `/api/transcribe?p=${enc(S.proj)}`, { mediaId: m.id, task: task === 'translate' ? 'translate' : 'transcribe', lang: body.querySelector('[name="lang"]').value, model: 'medium' });
      const j = await watchJob(job.id, (x) => (body.querySelector('[data-st]').textContent = `Listening… ${x.progress || 0}%`));
      const srt = await api('GET', `/api/subs/file?p=${enc(S.proj)}&name=${enc(j.result.subs)}`);
      lines = parseSrt(srt.text).filter((l) => l.end > tin && l.start < tout);
      if (task === 'own') lines.forEach((l) => (l.orig = l.text));
      body.querySelector('[data-st]').textContent = `${lines.length} lines`;
      draw();
    } catch (err) { toast(err.message, 'err'); }
    finally { b.disabled = false; b.textContent = '👂 Listen again'; }
  };
  body.querySelector('[data-go]').onclick = async () => {
    const v = pick(); if (!v.voice) return toast('Choose a voice', 'err');
    const duck = body.querySelector('[name="duck"]').checked;
    dlg.close(); setBusy?.(true, '🌐 Making the dub…');
    try {
      const job = await api('POST', `/api/dub?p=${enc(S.proj)}`, { ...v, lines });
      const r = (await watchJob(job.id, (x) => setBusy?.(true, `🌐 ${x.stage || 'Making the dub…'}`))).result;
      await refreshMedia();
      // the dub track runs on the clip's own clock: placed where the clip is, trimmed the same way
      const x = layout()[f0.track].find((p) => p.clip.id === clipId), cl = findClip(clipId)?.clip;
      S.project.tracks.A1.push({ id: uid(), type: 'audio', mediaId: r.mediaId, start: +x.start.toFixed(3), in: tin, out: tout, volume: 1, dubOf: clipId });
      cl.volume = duck ? 0.15 : 0;
      commit('AI dub');
      toast(`🌐 Dub ready: ${r.lines} lines${r.fitted ? `, ${r.fitted} sped up a little to fit` : ''}. The clip's own sound is ${duck ? 'quiet underneath' : 'off'}.`);
    } catch (err) { toast(err.message, 'err'); }
    finally { setBusy?.(false); }
  };
}
