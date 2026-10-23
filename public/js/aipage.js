// ✨ Labs page (Phase 22; in the page bar where Audio was - the Audio page is in Window > Audio): every AI tool in one
// place. 🌐 AI dubbing like ElevenLabs (any language, the speaker's own voice, fitted to the timing), 🎬 motion templates
// like Higgsfield (one-click camera moves on the selected shot), and the AI edit tools: script se first cut, live
// same-day edit, archive search, QC, planar tracking, the agent, voice-over, auto reels.
import { S, on, commit, emit, findClip, layout } from './store.js';
import { api, enc, watchJob } from './api.js';
import { uid, fmt, clipDur } from './model.js';
import { esc, toast, modal } from './ui.js';
import { refreshMedia, uploadFiles } from './mediapool.js';
import { TEMPLATES, templateById, applyTemplate, clearTemplate } from './aitemplates.js';
import { labsWorkHTML, mountLabsWork, draw as drawLabs, labOpen, labTemplate, labClear, stopLabs } from './labsedit.js';

let root = null;
// languages a dub can go to: the same-voice model speaks the ones marked ★ (others use a Microsoft Edge voice)
const LANGS = [['hi', 'Hindi', true], ['en', 'English', true], ['mr', 'Marathi'], ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'], ['gu', 'Gujarati'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['pa', 'Punjabi'], ['ur', 'Urdu'],
  ['ar', 'Arabic', true], ['fr', 'French', true], ['de', 'German', true], ['es', 'Spanish', true], ['ru', 'Russian', true], ['ja', 'Japanese', true], ['zh', 'Chinese', true]];
const langName = (c) => LANGS.find((l) => l[0] === c)?.[1] || c;

const TOOLS = [
  ['script', 'Script to first cut', 'A/V script in, finished timeline out - shots from this project and the archive'],
  ['live', 'Live same-day edit', 'Cards copied during the event; the highlight reel keeps re-making itself'],
  ['archive', 'Archive search', 'Find any old shot on the NAS by what it shows'],
  ['qc', 'Auto QC', 'Black frames, flashing, broadcast-safe colour, loudness, title spelling'],
  ['planar', 'Planar tracking', 'Stick a logo or picture onto a wall, banner or screen that moves'],
  ['agent', 'Agent edit', 'Song edits, teasers, reels, highlights and VO films from your footage'],
  ['vo', 'Voice-over', 'Type the script and a voice speaks it, with captions'],
  ['reels', 'Auto reels', 'The best moments of a long talk, as 9:16 reels'],
];

// thin line glyphs in the editor's own icon style (16 × 16, stroke = currentColor)
const G = {
  clone: '<rect x="2" y="1.5" width="4.5" height="7.5" rx="2.25"/><path d="M.8 6.5a3.5 3.5 0 0 0 6.9 0M4.25 10.5v2"/><path d="M9.5 5.5c.9.7.9 2.3 0 3M11.5 4c1.9 1.6 1.9 4.4 0 6M13.5 2.5c2.8 2.5 2.8 6.5 0 9"/>',
  dub: '<path d="M2.5 5.5h5M5 4v1.5M3.3 5.5c.4 2 1.7 3.4 3.4 4M6.7 5.5c-.4 2-1.7 3.4-3.4 4"/><path d="M8.5 13l2.5-6 2.5 6M9.3 11h3.4"/>',
  crashin: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect x="5" y="5.5" width="6" height="5" rx="1"/><path d="M2.5 3.5l2.5 2M13.5 3.5l-2.5 2M2.5 12.5l2.5-2M13.5 12.5l-2.5-2"/>',
  crashout: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect x="5" y="5.5" width="6" height="5" rx="1"/><path d="M5 5.5L2.8 3.6M11 5.5l2.2-1.9M5 10.5l-2.2 1.9M11 10.5l2.2 1.9"/>',
  dolly: '<rect x="1.5" y="5" width="9" height="6.5" rx="1.2"/><path d="M10.5 7.2l4-2v6.6l-4-2"/><path d="M4 14h4"/>',
  drone: '<circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><path d="M5.5 5.5l1.5 1.5h2l1.5-1.5"/><rect x="6.3" y="7" width="3.4" height="2.6" rx=".6"/><path d="M8 11.5v3M6.5 13l1.5 1.5 1.5-1.5"/>',
  arc: '<path d="M2.5 11a6 6 0 0 1 11 0"/><path d="M11.5 9.5l2 1.5.5-2.4"/><circle cx="8" cy="12" r="1.3"/>',
  roll: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M12.2 1.8v2.6H9.6"/><path d="M6 8h4"/>',
  bullet: '<circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.5M6.5 1.5h3"/>',
  hero: '<path d="M2 4.5l3.5 3.5L2 11.5M6.5 4.5L10 8l-3.5 3.5"/><path d="M12.5 4v8"/>',
  quake: '<path d="M1.5 8h2l1.5-4 2 8 2-6 1.5 3.5 1-1.5h3"/>',
  glitch: '<path d="M2 3.5h7M5 6h9M2 8.5h5M8 11h6M3 13.5h7"/>',
  burn: '<rect x="2.5" y="1.5" width="11" height="13" rx="1.2"/><path d="M5 1.5v13M11 1.5v13"/><path d="M8 5.5c1.4 1.3 1.4 3.2 0 4.5-1-1-1.2-2.3-.2-3.3"/>',
  flashpop: '<path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2 2M10.6 10.6l2 2M3.4 12.6l2-2M10.6 5.4l2-2"/>',
  trails: '<circle cx="11" cy="8" r="3"/><path d="M6.5 5.5a3 3 0 0 0 0 5M3.5 6a2.5 2.5 0 0 0 0 4"/>',
  strobe: '<path d="M9.5 1.5L4 9h4l-1.5 5.5L12 7H8z"/>',
  script: '<path d="M4 1.5h5.5L12.5 4.5v10h-8.5z"/><path d="M9.5 1.5v3h3M6.5 8h4M6.5 10.5h4"/>',
  live: '<circle cx="8" cy="8" r="2.2"/><path d="M4.2 4.2a5.4 5.4 0 0 0 0 7.6M11.8 4.2a5.4 5.4 0 0 1 0 7.6"/>',
  archive: '<rect x="1.5" y="2.5" width="13" height="3.5" rx=".8"/><path d="M2.5 6v6.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6M6.5 8.5h3"/>',
  qc: '<path d="M8 1.5l5.5 2v4.2c0 3.2-2.4 5.6-5.5 6.8-3.1-1.2-5.5-3.6-5.5-6.8V3.5z"/><path d="M5.5 8l1.8 1.8 3.2-3.3"/>',
  planar: '<path d="M3 4l9-1.5 1.5 10L2 12z"/><circle cx="3" cy="4" r=".9"/><circle cx="12" cy="2.5" r=".9"/><circle cx="13.5" cy="12.5" r=".9"/><circle cx="2" cy="12" r=".9"/>',
  agent: '<path d="M8 1.5l1.3 3.7L13 6.5 9.3 7.8 8 11.5 6.7 7.8 3 6.5l3.7-1.3z"/><path d="M12.5 11v3M11 12.5h3"/>',
  vo: '<rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"/>',
  reels: '<rect x="4" y="1.5" width="8" height="13" rx="1.5"/><path d="M7 6l3 2-3 2z"/>',
};
const glyph = (k) => `<svg class="lab-g" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${G[k] || ''}</svg>`;

const selClip = () => { const id = [...S.sel][0]; const f = id && findClip(id); return f ? { id, ...f } : null; };

export function mountAI(el) {
  root = el;
  el.innerHTML = `<div class="lab">
    <header class="lab-head"><div><h1>Labs</h1><p>AI tools for voice cloning, camera moves and faster edits - all running on this computer.</p></div></header>
    <section class="lab-sec">
      <div class="lab-sec-h"><div><span class="lab-kicker">Motion templates</span><h2>One-click camera moves</h2></div><p class="lab-note" data-tplsel></p><button class="lab-link" data-a="untpl">Remove from selected</button></div>
      <div class="lab-grid" data-tpls>${TEMPLATES.map((t) => `<button class="lab-tile" data-tpl="${t.id}"><span class="lab-tile-ic">${glyph(t.id)}</span><span class="lab-tile-t"><b>${esc(t.label)}</b><small>${esc(t.sub)}</small></span>${t.video ? '<i class="lab-tag">video</i>' : ''}</button>`).join('')}</div>
    </section>
    ${labsWorkHTML()}
    <section class="lab-hero">
      <div class="lab-hero-ic">${glyph('clone')}</div>
      <div class="lab-hero-txt"><span class="lab-kicker">Voice cloning</span><h2>Any voice, from a short sample</h2>
        <p>Give it 10-15 seconds of someone speaking - a clip, a file or your microphone - then type what they should say. It is spoken in that same voice, Hindi or English, on this computer.</p>
        <p class="lab-note" data-dubsel></p></div>
      <div class="lab-hero-act"><span class="lab-pill" data-vst></span><button class="primary" data-a="clone">Clone a voice</button><button class="lab-link" data-a="setup" hidden>Set up same-voice AI (one time, about 5 GB)</button></div>
    </section>
    <section class="lab-sec">
      <div class="lab-sec-h"><div><span class="lab-kicker">Tools</span><h2>Edit faster</h2></div></div>
      <div class="lab-list">${TOOLS.map(([id, l, s]) => `<button class="lab-row" data-tool="${id}"><span class="lab-row-ic">${glyph(id)}</span><span class="lab-tile-t"><b>${esc(l)}</b><small>${esc(s)}</small></span><svg class="lab-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5L10.5 8 6 12.5"/></svg></button>`).join('')}</div>
    </section></div>`;
  mountLabsWork(el.querySelector('[data-work]'));
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a, tpl = e.target.closest('[data-tpl]')?.dataset.tpl, tool = e.target.closest('[data-tool]')?.dataset.tool;
    if (a === 'clone') openVoiceClone();
    if (a === 'setup') setupVoice();
    // (with a Labs clip open, the templates go on it - Update on timeline puts them on the edit)
    if (a === 'untpl') { if (!labClear()) removeTemplates(); }
    if (tpl) { if (!labTemplate(templateById(tpl))) putTemplate(templateById(tpl)); }
    if (tool) runTool(tool);
  });
}
export function showAI() { if (!root) return; drawSel(); voiceState(); drawLabs(); }
export function hideAI() { stopLabs(); }
on('select', () => { if (S.page === 'ai') drawSel(); });
on('change', () => { if (S.page === 'ai') drawLabs(); }); // (undo / redo of a Labs edit)

function drawSel() {
  const c = selClip(), n = S.sel.size;
  const m = c && S.mediaById[c.clip.mediaId];
  root.querySelector('[data-dubsel]').textContent = c && m?.hasAudio ? `Voice sample ready: ${m.name} (the selected clip)` : 'Select a clip with clear speech on the timeline to use its voice - or pick a file or record one in the next step.';
  if (labOpen()) { root.querySelector('[data-tplsel]').textContent = `Goes on the open Labs clip "${labOpen().name}" - then Update on timeline`; return; }
  root.querySelector('[data-tplsel]').textContent = n ? `${n} shot${n > 1 ? 's' : ''} selected${c?.clip.tpl ? ` · has "${templateById(c.clip.tpl.id)?.label}"` : ''}` : 'Select shots on the Edit timeline first (V1 or above).';
}

// ---------------- 🎬 templates ----------------
function putTemplate(t) {
  const ids = [...S.sel].filter((id) => ['video', 'image'].includes(findClip(id)?.clip.type));
  if (!ids.length) return toast('Select video or photo shots on the timeline first', 'err');
  let n = 0, skipped = 0;
  for (const id of ids) {
    const c = findClip(id).clip;
    if (t.video && c.type !== 'video') { skipped++; continue; }
    applyTemplate(c, t, clipDur(c, S.mediaById), S.mediaById); n++;
  }
  if (!n) return toast(`${t.label} needs video shots (it changes the speed)`, 'err');
  commit(`Template: ${t.label}`); emit('change', {}); drawSel();
  toast(`${t.label} on ${n} shot${n > 1 ? 's' : ''}${skipped ? ` (${skipped} photo${skipped > 1 ? 's' : ''} skipped)` : ''} - change any part in Effect Controls, Ctrl+Z takes it back`);
}
function removeTemplates() {
  let n = 0;
  for (const id of S.sel) { const c = findClip(id)?.clip; if (c && clearTemplate(c, clipDur(c, S.mediaById), S.mediaById)) n++; }
  if (!n) return toast('No template on the selected shots');
  commit('Remove template'); emit('change', {}); drawSel(); toast(`Template removed from ${n} shot${n > 1 ? 's' : ''}`);
}

// ---------------- 🧠 tools ----------------
async function runTool(id) {
  const busy = (on, label) => emit('job', { running: on, label });
  if (id === 'script') return import('./scriptedit.js').then((x) => x.openScriptEdit((on, l) => busy(on, l)));
  if (id === 'live') return import('./liveedit.js').then((x) => x.openLiveEdit());
  if (id === 'archive') return import('./archive.js').then((x) => x.openArchive());
  if (id === 'qc') return import('./qc.js').then((x) => x.openQC(null));
  if (id === 'agent') return import('./agent.js').then((x) => x.openAgent((on, l) => busy(on, l)));
  if (id === 'vo') return import('./voiceover.js').then((x) => x.openVoiceOver({ setBusy: (on, l) => busy(on, l) }));
  if (id === 'reels') return import('./reels.js').then((x) => x.openReels((on, l) => busy(on, l)));
  if (id === 'planar') {
    const c = selClip();
    if (!c || c.track === 'V1' || !['image', 'video'].includes(c.clip.type)) return modal('Planar tracking', `<ol class="dv-steps"><li>Put the logo / picture / video on <b>V2</b> (above the shot), over the part of the shot where it should stick.</li>
      <li>Select it, move the playhead to a frame where the surface (wall, banner, screen) is clearly visible.</li><li>Effect Controls › <b>Stick onto a surface…</b> and click the surface's four corners on the viewer.</li></ol>
      <p class="muted small">It is tracked through the whole shot (both ways); the picture bends with the camera.</p><div class="dv-actions"><button data-close>OK</button></div>`, { width: 560 });
    emit('gotoPage', 'edit');
    return import('./trackui.js').then((x) => x.addPin(c.id, () => emit('select')));
  }
}

// ---------------- 🧬 voice cloning ----------------
// a voice sample (the selected clip from its In, any clip with sound, a file, or 15 s from the microphone) + the words ->
// the words spoken in that voice (offline same-voice AI, server: POST /api/tts provider 'clone') -> A1 at the playhead
const withSound = () => S.media.filter((m) => m.kind === 'audio' || (m.kind === 'video' && m.hasAudio));
export async function openVoiceClone() {
  const vs = await api('GET', '/api/aivoice').catch(() => ({ ready: false }));
  const c = selClip(), cm = c && S.mediaById[c.clip.mediaId];
  const body = document.createElement('div');
  body.className = 'vo vclone';
  body.innerHTML = `
    <div class="vc-step"><b>1 · Voice sample</b><span class="muted small">10-15 seconds of one person speaking clearly, no music</span></div>
    <div class="row-in vc-src">
      <select name="ref" aria-label="Voice sample"></select>
      <button type="button" class="small" data-play title="Hear the sample">Play</button>
      <button type="button" class="small" data-up title="Use an audio or video file from this computer">Upload…</button>
      <button type="button" class="small" data-rec title="Record 15 seconds from the microphone">Record</button>
      <input type="file" accept="audio/*,video/*" hidden>
    </div>
    <p class="muted small" data-st></p>
    <div class="vc-step"><b>2 · What the voice says</b><span class="muted small">Hindi, English or Hinglish - a blank line = a short pause</span></div>
    <textarea name="text" rows="7" placeholder="नमस्कार, मैं आपका स्वागत करता हूँ…"></textarea>
    <label class="chk"><input type="checkbox" name="subs" checked> Subtitles from it (exact words, timed to the voice)</label>
    <label class="chk"><input type="checkbox" name="place" checked> Put it on A1 (Voice-over) at the playhead</label>
    ${vs.ready ? '' : '<p class="vo-note">The same-voice AI is not set up on this computer yet - press "Set up same-voice AI" on the Labs page first (one time).</p>'}
    <div class="ag-foot"><span class="muted small" data-count></span><span class="grow"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" data-go${vs.ready ? '' : ' disabled'}>Make it in this voice</button></div>`;
  const dlg = modal('Voice cloning', body, { width: 640 });
  const q = (x) => body.querySelector(x), sel = q('[name="ref"]'), st = q('[data-st]'), ta = q('[name="text"]');
  // the samples: the selected clip first (from its In), then every file with sound
  const fill = (pick) => {
    const own = c && cm?.hasAudio ? [`<option value="clip">Selected clip: ${esc(cm.name)} (from its In)</option>`] : [];
    sel.innerHTML = own.concat(withSound().map((m) => `<option value="${m.id}">${esc(m.name)}</option>`)).join('') || '<option value="">No clip with sound yet - upload or record one</option>';
    if (pick) sel.value = pick;
  };
  fill();
  const ref = () => (sel.value === 'clip' ? { refMediaId: cm.id, refIn: +(c.clip.in || 0) } : sel.value ? { refMediaId: sel.value, refIn: 0 } : null);
  // hear the 15 s that will be used
  const au = new Audio(); let stopAt = 0;
  au.ontimeupdate = () => { if (au.currentTime >= stopAt) au.pause(); };
  q('[data-play]').onclick = () => {
    const r = ref(), m = r && S.mediaById[r.refMediaId]; if (!m) return;
    if (!au.paused) return au.pause();
    if (au.dataset.src !== m.urls.play) { au.src = m.urls.play; au.dataset.src = m.urls.play; }
    au.currentTime = r.refIn; stopAt = r.refIn + 15; au.play().catch(() => {});
  };
  // a file (or a recording) becomes a clip of the project, then the sample
  const addFile = async (file) => {
    st.textContent = `Adding ${file.name}…`;
    try {
      const added = await uploadFiles([file]), first = added.find((x) => x.kind === 'audio' || x.kind === 'video');
      if (!first) throw new Error('That file has no sound');
      for (let i = 0; i < 60 && S.mediaById[first.id]?.status !== 'ready'; i++) { await new Promise((r) => setTimeout(r, 1000)); await refreshMedia(); }
      fill(first.id); st.textContent = `Sample: ${first.name}`;
    } catch (e) { st.textContent = ''; toast(e.message, 'err'); }
  };
  const fileIn = q('input[type="file"]');
  q('[data-up]').onclick = () => fileIn.click();
  fileIn.onchange = () => { if (fileIn.files[0]) addFile(fileIn.files[0]); fileIn.value = ''; };
  // 🎙 15 s from the microphone (again = stop early)
  let rec = null;
  q('[data-rec]').onclick = async () => {
    if (rec) return rec.stop();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } }); }
    catch { return toast('The microphone could not be opened (allow it in the browser)', 'err'); }
    const chunks = [], mr = new MediaRecorder(stream), btn = q('[data-rec]'), t0 = Date.now();
    rec = mr; btn.textContent = 'Stop'; btn.classList.add('on');
    const tick = setInterval(() => { const n = Math.round((Date.now() - t0) / 1000); st.textContent = `Recording… ${n} s (read a few lines in a normal voice)`; if (n >= 15) mr.stop(); }, 250);
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      clearInterval(tick); stream.getTracks().forEach((t) => t.stop()); rec = null; btn.textContent = 'Record'; btn.classList.remove('on');
      const d = new Date(), p = (x) => String(x).padStart(2, '0');
      addFile(new File(chunks, `Voice sample ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.webm`, { type: mr.mimeType || 'audio/webm' }));
    };
    mr.start(250);
  };
  const cnt = () => { const n = ta.value.trim().length; q('[data-count]').textContent = n ? `${n} characters · about ${fmt(n / 14.5)}` : ''; };
  ta.oninput = cnt;
  q('[data-go]').onclick = async () => {
    const r = ref();
    if (!r) return toast('Pick, upload or record the voice sample first', 'err');
    if (!ta.value.trim()) return toast('Write what the voice should say', 'err');
    const subs = q('[name="subs"]').checked, place = q('[name="place"]').checked;
    au.pause(); dlg.close(); emit('job', { running: true, label: 'Cloning the voice…' });
    try {
      const job = await api('POST', `/api/tts?p=${enc(S.proj)}`, { provider: 'clone', ...r, text: ta.value, subtitles: subs });
      const res = (await watchJob(job.id, (x) => emit('job', { running: true, label: `Voice clone · ${x.stage || 'Speaking…'} ${x.progress || 0}%` }))).result;
      await refreshMedia();
      if (place && res.mediaId) {
        S.project.tracks.A1.push({ id: uid(), type: 'audio', mediaId: res.mediaId, start: +S.playhead.toFixed(3), in: 0, volume: 1 });
        if (res.subs) S.project.subtitles = { ...S.project.subtitles, file: res.subs };
        commit('Voice clone'); emit('subs');
      }
      toast(`Done in the cloned voice (${fmt(res.duration)})${res.subs ? ' with subtitles' : ''} - it is in the "AI voice-over" bin`);
    } catch (e) { toast(e.message, 'err'); }
    finally { emit('job', { running: false }); }
  };
}

// ---------------- 🌐 AI dubbing ----------------
async function voiceState() {
  const st = await api('GET', '/api/aivoice').catch(() => ({ ready: false }));
  const b = root.querySelector('[data-a="setup"]'), s = root.querySelector('[data-vst]');
  b.hidden = st.ready || !!st.setting;
  s.textContent = st.ready ? 'Same voice ready · offline' : st.setting ? `Setting up · ${st.setting.stage || '…'}` : 'Same voice needs setup · Edge voices ready';
  s.classList.toggle('on', !!st.ready);
  if (st.setting) watchSetup(st.setting.id);
}
async function setupVoice() {
  if (!confirm('Download and install the same-voice AI on this computer?\n\nAbout 5 GB (PyTorch for the GPU + the Chatterbox voice model, MIT licence). It runs offline afterwards; nothing you dub is uploaded.')) return;
  try { const j = await api('POST', '/api/aivoice/setup', {}); watchSetup(j.id); } catch (e) { toast(e.message, 'err'); }
}
async function watchSetup(id) {
  const s = root.querySelector('[data-vst]');
  try { await watchJob(id, (x) => (s.textContent = `${x.stage || 'Setting up…'} ${x.progress || 0}%`)); toast('Same-voice AI is ready'); }
  catch (e) { toast(`Setup failed: ${e.job?.log?.slice(-1)[0] || e.message}`, 'err'); }
  voiceState();
}

// any clip with speech -> its lines (transcribed) -> translated (Claude) -> checked -> spoken in the speaker's own voice
// (or an Edge / ElevenLabs voice), each line fitted into its time -> a new audio clip under the shot, the original quiet
export async function openAiDub(clipId = selClip()?.id) {
  const f0 = clipId && findClip(clipId), c = f0?.clip, m = c && S.mediaById[c.mediaId];
  if (!m?.hasAudio) return toast('Select a clip with speech on the timeline first', 'err');
  const { voicePicker, parseSrt } = await import('./voiceover.js');
  const vs = await api('GET', '/api/aivoice').catch(() => ({ ready: false }));
  const body = document.createElement('div');
  body.className = 'vo dub';
  body.innerHTML = `<div class="fgrid">
      <label class="fld"><span>The clip speaks</span><select name="from"><option value="auto">Auto-detect</option><option value="hi">Hindi</option><option value="en">English</option></select></label>
      <label class="fld"><span>Dub into</span><select name="to">${LANGS.map(([k, l, same]) => `<option value="${k}">${l}${same ? ' - own voice' : ''}</option>`).join('')}</select></label>
      <label class="fld wide"><span>Voice</span><select name="voiceKind"><option value="clone"${vs.ready ? '' : ' disabled'}>The speaker's own voice (languages marked own voice${vs.ready ? '' : ' - set it up on the Labs page first'})</option><option value="other">Another AI voice (Microsoft Edge / ElevenLabs)</option></select></label>
    </div>
    <div data-picker hidden></div>
    <div class="row-in"><button type="button" class="accent small" data-go1>Listen and translate</button><span class="muted small grow" data-st>${esc(m.name)}</span></div>
    <div class="dub-lines" data-lines><p class="muted small">Its lines appear here, translated and timed - fix any word before making the voice.</p></div>
    <label class="chk"><input type="checkbox" name="duck" checked> Keep the clip's own sound quietly underneath (ambience)</label>
    <div class="ag-foot"><span class="grow"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" data-go2 disabled>Make the dub</button></div>`;
  const dlg = modal('AI dubbing', body, { width: 760 });
  const q = (s) => body.querySelector(s), f = (n) => q(`[name="${n}"]`);
  if (!vs.ready) f('voiceKind').value = 'other';
  const pick = voicePicker(q('[data-picker]'), { text: () => lines.map((l) => l.text).join(' ') });
  const showPick = () => { q('[data-picker]').hidden = f('voiceKind').value === 'clone'; };
  f('voiceKind').onchange = showPick; showPick();
  f('to').onchange = () => { const same = LANGS.find((l) => l[0] === f('to').value)?.[2]; if (!same && f('voiceKind').value === 'clone') { f('voiceKind').value = 'other'; showPick(); toast(`The speaker's own voice does not speak ${langName(f('to').value)} yet - an Edge voice will`); } };
  let lines = [];
  const tin = c.in || 0, tout = c.out ?? m.duration;
  const draw = () => {
    q('[data-lines]').innerHTML = `<table class="se-table"><tr><th>Time</th><th>Original</th><th>${esc(langName(f('to').value))}</th></tr>${lines.map((l, i) => `<tr><td class="muted">${fmt(l.start - tin)}</td><td class="muted small">${esc(l.orig)}</td><td><textarea data-i="${i}" rows="1">${esc(l.text)}</textarea></td></tr>`).join('')}</table>`;
    q('[data-go2]').disabled = !lines.length;
    pick.refit(); // (the translated words decide which voices can read them)
  };
  body.addEventListener('input', (e) => { const i = e.target.dataset.i; if (i !== undefined) lines[+i].text = e.target.value; });
  q('[data-go1]').onclick = async (e) => {
    const b = e.target; b.disabled = true;
    try {
      q('[data-st]').textContent = 'Listening…';
      const job = await api('POST', `/api/transcribe?p=${enc(S.proj)}`, { mediaId: m.id, task: 'transcribe', lang: f('from').value, model: 'medium' });
      const j = await watchJob(job.id, (x) => (q('[data-st]').textContent = `Listening… ${x.progress || 0}%`));
      const srt = await api('GET', `/api/subs/file?p=${enc(S.proj)}&name=${enc(j.result.subs)}`);
      lines = parseSrt(srt.text).filter((l) => l.end > tin && l.start < tout).map((l) => ({ ...l, orig: l.text }));
      if (!lines.length) throw new Error('No speech heard in this part of the clip');
      q('[data-st]').textContent = `Translating ${lines.length} lines into ${langName(f('to').value)}…`;
      const tj = await api('POST', `/api/dub/translate?p=${enc(S.proj)}`, { texts: lines.map((l) => l.orig), to: langName(f('to').value), from: f('from').value === 'auto' ? '' : langName(f('from').value) });
      const tr = (await watchJob(tj.id, () => {})).result.lines;
      lines.forEach((l, i) => (l.text = tr[i] ?? l.orig));
      q('[data-st]').textContent = `${lines.length} lines - check them, then make the dub`;
      draw();
    } catch (x) { q('[data-st]').textContent = x.job?.log?.slice(-1)[0] || x.message; }
    finally { b.disabled = false; b.textContent = 'Listen and translate again'; }
  };
  q('[data-go2]').onclick = async () => {
    const clone = f('voiceKind').value === 'clone', v = clone ? { provider: 'clone' } : pick();
    if (!clone && !v.voice) return toast('Choose a voice', 'err');
    const duck = f('duck').checked;
    dlg.close(); emit('job', { running: true, label: 'Making the dub…' });
    try {
      const job = await api('POST', `/api/dub?p=${enc(S.proj)}`, { ...v, lang: f('to').value, mediaId: m.id, lines: lines.map(({ start, end, text }) => ({ start, end, text })) });
      const r = (await watchJob(job.id, (x) => emit('job', { running: true, label: `Dub · ${x.stage || 'Making the dub…'} ${x.progress || 0}%` }))).result;
      await refreshMedia();
      const x = layout()[f0.track].find((p) => p.clip.id === clipId), cl = findClip(clipId)?.clip;
      S.project.tracks.A1.push({ id: uid(), type: 'audio', mediaId: r.mediaId, start: +x.start.toFixed(3), in: tin, out: tout, volume: 1, dubOf: clipId });
      cl.volume = duck ? 0.15 : 0;
      commit(`AI dub (${langName(f('to').value)})`);
      toast(`${langName(f('to').value)} dub ready${clone ? ' in the speaker\'s own voice' : ''}: ${r.lines} lines${r.fitted ? `, ${r.fitted} sped up a little to fit` : ''}`);
    } catch (x) { toast(x.job?.log?.slice(-1)[0] || x.message, 'err'); }
    finally { emit('job', { running: false }); }
  };
}
