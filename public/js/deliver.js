// Deliver: platform presets (with reframing), render queue, finished renders, timeline hand-off to Premiere / Resolve,
// and subtitles (generate, proof-read, burn in).
import { S, on, emit, commit, saveNow, duration } from './store.js';
import { api, enc, watchJob } from './api.js';
import { fmtTC, ASPECTS } from './model.js';
import { PRESETS, presetById, presetWarnings, REFRAME } from './presets.js';
import { CAPTION_STYLES } from './templates.js';
import { seqList, seqOf } from './model.js';
import { staleNested, updateNested } from './sequences.js';
import { bakeAll } from './gfxui.js';
import { openThumbs } from './thumbs.js';
import { openPublish } from './publish.js';
import { $, $$, esc, toast, fmtSize, modal, progressClock } from './ui.js';
import { pickFolder } from './mediapool.js';
import { localSaveAvailable, whyNoLocal, localDir, pickLocalDir, saveToLocal } from './localsave.js';

let root, busy = false;
// the render queue lives on the server (it keeps rendering while you edit, even with this page closed)
let rq = { items: [], gpu: false }, qTimer = null;

export function mountDeliver(el) {
  root = el;
  el.innerHTML = `<div class="deliver">
    <section class="dv-col">
      <h2>Export</h2>
      <label class="fld"><span>File name</span><input id="dvName"></label>
      <div class="fld" id="dvSaveF" data-saverow hidden><span>📁 Save to</span><div class="dv-saveto"><input id="dvSaveTo" data-savepath readonly placeholder="This project's folder (renders / exports)" title="Where the finished video and the exported timeline go. Empty = the project's own folder."><button class="small" data-savebrowse title="A folder on the editing computer or the network drive (Z:)">📁 Browse</button><button class="small" data-savelocal title="A folder on the computer you are sitting at - finished renders and exported timelines you start are saved into it">💻 This PC</button><button class="small" data-saveclear title="Back to the project's folder" hidden>✕</button></div></div>
      <label class="fld" id="dvSeqF"><span>Sequence</span><select id="dvSeq" title="Which timeline of this project to render"></select></label>
      <label class="fld"><span>Platform</span><select id="dvPreset">${PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select></label>
      <div class="fgrid dv-frame">
        <label class="fld"><span>Frame</span><select id="dvAspect">${Object.keys(ASPECTS).map((a) => `<option>${a}</option>`).join('')}</select></label>
        <label class="fld" id="dvFitF"><span>Reframe with</span><select id="dvFit">${REFRAME.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      </div>
      <details class="dv-q" open><summary>Quality</summary><div class="fgrid">
        <label class="fld"><span>Resolution</span><select id="qRes"><option value="">Platform default</option><option value="2160">4K UHD (2160p)</option><option value="1440">2K QHD (1440p)</option><option value="1080">Full HD (1080p)</option><option value="720">HD (720p)</option><option value="480">SD (480p)</option></select></label>
        <label class="fld"><span>Frame rate</span><select id="qFps"><option value="">Same as the edit</option><option>24</option><option>25</option><option>30</option><option>50</option><option>60</option></select></label>
        <label class="fld"><span>Codec</span><select id="qCodec"><option value="">Platform default</option><option value="h264">H.264 (plays everywhere)</option><option value="hevc">H.265 / HEVC (half the size)</option><option value="prores">ProRes 422 HQ (editing master)</option></select></label>
        <label class="fld"><span>Quality</span><select id="qCrf"><option value="">Platform default</option><option value="14">Best (big file)</option><option value="17">Very high</option><option value="19">High</option><option value="22">Standard</option><option value="26">Small</option></select></label>
        <label class="fld"><span>Audio</span><select id="qAbr"><option value="">Platform default</option><option value="320">320 kbps</option><option value="256">256 kbps</option><option value="192">192 kbps</option><option value="128">128 kbps</option></select></label>
        <label class="chk" id="qGpuL"><input type="checkbox" id="qGpu"> Use the NVIDIA GPU (faster 4K)</label>
      </div></details>
      <div class="dv-spec" id="dvSpec"></div>
      <ul class="warns" id="dvWarn" hidden></ul>
      <button class="primary big wide" id="dvRender" title="Goes into the render queue - keep editing while it renders">Render video</button>
      <button class="wide" id="dvXmlJump" title="Hand this edit to Premiere Pro / DaVinci Resolve - the timeline with its clips, cuts, titles (below)">🎞 Export timeline (XML for Premiere / Resolve)…</button>
      <button class="accent wide" id="dvBundle" title="One click: the same edit for several platforms (Reel, YouTube, WhatsApp…), rendered one after another">📦 All platforms…</button>
      <div class="dv-gpu" id="dvGpu"></div>
      <h2 class="dv-h">Render queue <button class="link small" id="dvQClear" title="Remove finished, failed and stopped renders from the list">Clear finished</button></h2>
      <div id="dvQueue" class="dv-list"></div>
      <button class="wide" id="dvPreview">Quick accurate preview (low-res)</button>
      <div class="row-in"><button class="wide" id="dvThumb" title="Make a thumbnail from the best frames of the video">🖼 Thumbnail</button><button class="wide accent" id="dvPublish" title="Upload to YouTube, Facebook and Instagram - now or at a set time">🚀 Publish</button></div>
      <div class="job" id="dvJob" hidden><div class="job-top"><span id="dvJobL"></span><span id="dvJobT"></span></div><div class="bar"><div id="dvBar"></div></div>
        <details><summary>Log</summary><pre id="dvLog"></pre></details></div>
      <h2 class="dv-h">Renders <button class="link small" id="dvOpenR">Open folder</button></h2>
      <div id="dvList" class="dv-list"></div>
      <h2 id="dvXmlH">Export timeline · Premiere Pro / DaVinci Resolve</h2>
      <p class="muted dv-note">Hand this edit to an editor: clips, cuts, dissolves, speed, volume, titles and markers land on their timeline, linked to the original camera files.</p>
      <label class="fld"><span>📦 Media (for another computer)</span><select id="dvXmlMedia"><option value="trim">Collect the used parts of the clips (+1 s handles) - smallest, best to send</option><option value="full">Collect whole files - every file the edit uses, copied</option><option value="none">Don't copy - link to the files on this computer</option></select></label>
      <label class="fld"><span>Colour</span><select id="dvXmlColor"><option value="lut">A LUT file per graded clip (quick)</option><option value="bake">Colour + film LUT + flash effects baked into new clips (exact, slower)</option><option value="none">Leave colour out</option></select></label>
      <div class="fld" data-saverow hidden><span>📁 Save to</span><div class="dv-saveto"><input data-savepath readonly placeholder="This project's folder (exports)" title="Where the exported timeline folder goes"><button class="small" data-savebrowse title="A folder on the editing computer or the network drive (Z:)">📁 Browse</button><button class="small" data-savelocal title="A folder on the computer you are sitting at - finished renders and exported timelines you start are saved into it">💻 This PC</button><button class="small" data-saveclear title="Back to the project's folder" hidden>✕</button></div></div>
      <button class="accent wide" id="dvXml">Export timeline (XML)</button>
      <div id="dvXmlList" class="dv-list"></div>
    </section>
    <section class="dv-col dv-play">
      <div class="dv-phead"><div class="segbtns"><button data-dvv="program" title="The edit as it is now (the timeline)">Program</button><button data-dvv="render" title="A rendered file - pick one under Renders">Render</button></div><span class="muted small grow" id="dvNow">Program: the edit as it is now - render it to watch the final file here</span></div>
      <div class="dv-pbody" id="dvProg"></div>
      <video id="dvVideo" controls playsinline hidden></video>
    </section>
    <!-- subtitles: moved out of Deliver (captions live in Edit > CC); kept hidden so a burned-in file set earlier still renders -->
    <section class="dv-col" hidden>
      <h2>Subtitles</h2>
      <div class="fgrid">
        <label class="fld wide"><span>Transcribe from</span><select id="trSrc"></select></label>
        <label class="fld"><span>Spoken language</span><select id="trLang"><option value="hi">Hindi</option><option value="en">English</option><option value="auto">Auto-detect</option></select></label>
        <label class="fld"><span>Output</span><select id="trTask"><option value="transcribe">Same language</option><option value="translate">English (translate)</option></select></label>
        <label class="fld"><span>Caption style</span><select id="trWords"><option value="4">Reel: 4 words</option><option value="3">Reel: 3 words</option><option value="6">6 words</option><option value="0">Full sentences</option></select></label>
        <label class="fld"><span>Accuracy</span><select id="trModel"><option value="large-v3">Best (slow)</option><option value="medium">Good</option><option value="small">Fast draft</option></select></label>
        <label class="fld wide"><span>Names / script (improves spelling)</span><textarea id="trPrompt" rows="2" placeholder="MY Bharat, Viksit Bharat, Chhattisgarh, speaker names…"></textarea></label>
      </div>
      <button class="accent wide" id="trGo">Generate subtitles</button>
      <div class="row-in"><select id="subPick"></select><button id="subBurn" class="small" title="Burn this file into the next render">Burn in</button></div>
      <label class="fld"><span>Caption style (burned-in .srt)</span><select id="subStyle">${CAPTION_STYLES.map((c) => `<option value="${c.id}">${c.label}</option>`).join('')}</select></label>
      <textarea id="subText" class="srt" spellcheck="false" placeholder="Proof-read here: fix names, numbers and spellings, then Save."></textarea>
      <button id="subSave" class="wide">Save subtitles</button>
    </section></div>`;
  $('#dvPreset', el).onchange = applyPreset;
  $('#dvAspect', el).onchange = syncSpec;
  $('#dvSeq', el).onchange = () => { const x = seqList(S.project).find((q) => (q.open ? '' : q.id) === $('#dvSeq', root).value); if (x) $('#dvAspect', root).value = x.data.settings?.aspect || $('#dvAspect', root).value; syncSpec(); };
  ['qRes', 'qFps', 'qCodec', 'qCrf', 'qAbr', 'qGpu'].forEach((k) => ($(`#${k}`, el).onchange = syncSpec));
  $('#qGpu', el).addEventListener('change', (e) => { e.target.dataset.touched = '1'; });
  $('#dvFit', el).onchange = syncSpec;
  $('#dvRender', el).onclick = () => enqueue([current()]);
  $('#dvBundle', el).onclick = bundleDialog;
  $('#dvQClear', el).onclick = async () => { await api('POST', '/api/queue/clear'); pollQueue(); };
  $('#dvPreview', el).onclick = () => render(true);
  $('#dvThumb', el).onclick = () => openThumbs();
  $('#dvPublish', el).onclick = () => openPublish();
  $('#dvXml', el).onclick = exportXml;
  // 📁 Save to: the owner picks a folder for the finished files (remembered per project in this browser)
  $$('[data-savebrowse]', el).forEach((b) => (b.onclick = async () => {
    const owner = S.me?.role === 'owner' || !!S.me?.anyFolder, shared = S.me?.shared || [];
    if (!owner && !shared.length) return toast('The owner has not added any Shared folders yet (Team & users > Shared folders) - until then exports stay in the project, use ⬇ to download', 'err');
    const d = await pickFolder('Save renders and exported timelines to…', owner ? 'The finished video (and an exported timeline folder) is put here. The project keeps its own copy too.'
      : `Pick a folder inside a Shared folder (⭐ at the top): ${shared.join(' · ')}. These are on the editing computer / office drive, not on this PC.`);
    if (!d) return;
    if (!owner && !inShared(d)) return toast(`Choose a folder inside a Shared folder: ${shared.join(', ')}`, 'err');
    setSaveTo(d); toast(`Exports go to ${d}`);
  }));
  $$('[data-saveclear]', el).forEach((b) => (b.onclick = () => { setLocal(false); setSaveTo(''); toast("Exports go to the project's folder"); }));
  $$('[data-savelocal]', el).forEach((b) => (b.onclick = async () => {
    if (!localSaveAvailable()) return modal('💻 Save on this PC', `<p>${esc(whyNoLocal())}</p><p class="muted small">Meanwhile every finished render has <b>⬇ Download</b>, and exported timelines <b>⬇ Download (.zip)</b>.</p><div class="dv-actions"><button data-close>OK</button></div>`, { width: 560 });
    try { const d = await pickLocalDir(); setSaveTo(''); setLocal(true); syncSaveTo(); toast(`💻 Finished files you start go to "${d.name}" on this PC`); }
    catch (e) { if (e.name !== 'AbortError') toast(e.message, 'err'); }
  }));
  $('#dvXmlJump', el).onclick = () => { $('#dvXmlH', el).scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#dvXml', el).focus({ preventScroll: true }); $('#dvXml', el).classList.add('pulse'); setTimeout(() => $('#dvXml', el)?.classList.remove('pulse'), 1600); };
  $('#dvOpenR', el).onclick = () => openSub('renders');
  $('#trGo', el).onclick = transcribe;
  $('#subPick', el).onchange = (e) => loadSub(e.target.value);
  $('#subStyle', el).onchange = (e) => {
    const cs = CAPTION_STYLES.find((c) => c.id === e.target.value);
    S.project.subtitles = { ...S.project.subtitles, style: { ...cs.style }, styleId: cs.id };
    commit('Caption style'); toast(`Captions: ${cs.label} (see it with Quick accurate preview)`);
  };
  $('#subSave', el).onclick = saveSub;
  $('#subBurn', el).onclick = () => {
    const f = $('#subPick', root).value;
    S.project.subtitles = { ...S.project.subtitles, file: S.project.subtitles?.file === f ? '' : f };
    commit('Subtitles'); syncSubs(); toast(S.project.subtitles.file ? `${f} will be burned into the next render` : 'Subtitles will not be burned in');
  };
  $$('[data-dvv]', el).forEach((b) => (b.onclick = () => showView(b.dataset.dvv)));
  on('change', syncSpec);
  on('accuratePreview', () => render(true));
  on('subs', loadSubsList);
}

export async function showDeliver() {
  syncSaveTo();
  $('#dvName', root).value = $('#dvName', root).value || S.project.name;
  $('#subStyle', root).value = S.project.subtitles?.styleId || '';
  $('#dvPreset', root).value = presetById(S.project.settings.exportPreset)?.id || { '9:16': 'reel', '1:1': 'insta-feed', '4:5': 'insta-feed' }[S.project.settings.aspect] || 'youtube';
  pickAspect();
  const seqs = seqList(S.project);
  $('#dvSeqF', root).hidden = seqs.length < 2;
  $('#dvSeq', root).innerHTML = seqs.map((x) => `<option value="${x.open ? '' : x.id}">${esc(x.name)}${x.open ? ' (open)' : ''} · ${esc(x.data.settings?.aspect || '')}</option>`).join('');
  syncSpec(); pollQueue();
  showView($('#dvVideo', root).getAttribute('src') ? view : 'program');
  await Promise.all([loadRenders(), loadSubsList(), loadExports()]);
}
// 🖥 the big monitor: the Program monitor of the Edit page (lent while Deliver is open) or a rendered file
let view = 'program', viewerHome = null;
function showView(v) {
  view = v === 'render' && $('#dvVideo', root).getAttribute('src') ? 'render' : 'program';
  const vid = $('#dvVideo', root), host = $('#dvProg', root), viewer = document.getElementById('viewer');
  $$('[data-dvv]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.dvv === view)));
  vid.hidden = view !== 'render'; host.hidden = view !== 'program';
  if (view === 'program') { if (viewer && viewer.parentElement !== host) { viewerHome ||= { parent: viewer.parentElement, next: viewer.nextSibling }; host.append(viewer); } vid.pause(); $('#dvNow', root).textContent = 'Program: the edit as it is now - render it to watch the final file here'; }
  else returnViewer();
  dispatchEvent(new Event('resize'));
}
// the Program monitor goes back to the Edit page
export function hideDeliver() { $('#dvVideo', root)?.pause(); returnViewer(); }
function returnViewer() {
  const viewer = document.getElementById('viewer');
  if (viewer && viewerHome && viewer.parentElement !== viewerHome.parent) { viewerHome.parent.insertBefore(viewer, viewerHome.next); dispatchEvent(new Event('resize')); }
}

// Frame: the edit's own shape when the platform takes it, otherwise the platform's preferred shape (reframed).
function pickAspect() {
  const p = presetById($('#dvPreset', root).value), a = S.project.settings.aspect;
  $('#dvAspect', root).value = !p.aspects.length || p.aspects.includes(a) ? a : p.aspects[0];
}
function applyPreset() {
  const p = presetById($('#dvPreset', root).value);
  Object.assign(S.project.settings, { exportPreset: p.id, loudness: p.loudness, ...(p.crf ? { crf: p.crf } : {}) });
  pickAspect();
  commit('Export preset');
}
const quality = () => {
  const q = { res: $('#qRes', root).value, fps: $('#qFps', root).value, codec: $('#qCodec', root).value, crf: $('#qCrf', root).value, abr: $('#qAbr', root).value, gpu: $('#qGpu', root).checked ? true : $('#qGpu', root).disabled ? '' : 'off' };
  return Object.fromEntries(Object.entries(q).filter(([, v]) => v));
};
const current = () => ({ seq: $('#dvSeq', root).value || undefined, preset: $('#dvPreset', root).value, aspect: $('#dvAspect', root).value, fit: $('#dvFit', root).value, filename: $('#dvName', root).value.trim(), quality: quality() });

function specOf(job) {
  const p = presetById(job.preset), s = S.project.settings, q = job.quality || {};
  const [fw, fh] = ASPECTS[job.aspect], k = +q.res ? +q.res / Math.min(fw, fh) : Math.min(1, p.short / Math.min(fw, fh));
  const cd = q.codec || p.codec || 'h264', crf = +q.crf || p.crf;
  const codec = cd === 'prores' ? 'ProRes 422 HQ .mov' : `${cd === 'hevc' ? 'H.265' : 'H.264'} .mp4 · quality ${crf}${p.maxrate ? ` · max ${p.maxrate / 1000} Mbit/s` : ''}${p.sizeMB ? ` · under ${p.sizeMB} MB` : ''}${q.gpu === true ? ' · GPU' : ''}`;
  return { w: Math.round((fw * k) / 2) * 2, h: Math.round((fh * k) / 2) * 2, fps: +q.fps || Math.min(p.fps, s.fps), codec, reframe: job.aspect !== s.aspect };
}
function syncSpec() {
  if (!root || !S.project) return;
  const s = S.project.settings, d = duration(), job = current(), p = presetById(job.preset), sp = specOf(job);
  $('#dvFitF', root).style.visibility = sp.reframe ? 'visible' : 'hidden';
  $('#qGpu', root).disabled = !S.health.nvenc;
  // GPU encoding is on by default when it works; unticking it (remembered while the page is open) renders on the CPU
  if (S.health.nvenc && !$('#qGpu', root).dataset.touched) $('#qGpu', root).checked = true;
  $('#qGpuL', root).title = S.health.nvenc ? '' : 'NVIDIA encoder not available - update the NVIDIA driver (610 or newer) to use it';
  $('#dvSpec', root).innerHTML = `<div><b>${sp.w}×${sp.h}</b> (${job.aspect}${sp.reframe ? `, reframed from ${s.aspect}` : ''}) · ${sp.fps} fps · ${fmtTC(d, s.fps)}</div>
    <div>${sp.codec} · loudness ${p.loudness} LUFS</div>
    <div>${S.project.subtitles?.file ? `Subtitles burned in: ${esc(S.project.subtitles.file)}` : 'No burned-in subtitles'}</div>`;
  const w = presetWarnings(p, { aspect: job.aspect, duration: d });
  $('#dvWarn', root).hidden = !w.length;
  $('#dvWarn', root).innerHTML = w.map((x) => `<li>${esc(x)}</li>`).join('');
}

// ---------------- render queue (server side): one edit, many platforms, rendered one after another ----------------
export async function enqueue(items, { quiet = false } = {}) {
  if (!Object.values(S.project.tracks).flat().length) { toast('The timeline is empty', 'err'); return false; }
  // nested sequences changed since they were nested: bring them up to date first (only the open timeline's)
  const stale = staleNested().filter((m) => Object.values(S.project.tracks).flat().some((c) => c.mediaId === m.id));
  if (stale.length && items.some((j) => !j.seq) && confirm(`${stale.map((m) => m.name).join(', ')} changed since you nested ${stale.length > 1 ? 'them' : 'it'}. Update before rendering? (OK = update, Cancel = render the old copy)`)) await updateNested(stale);
  try { await bakeAll(); } catch (e) { toast(`Graphics: ${e.message}`, 'err'); return false; }
  await saveNow();
  const name = (root && $('#dvName', root).value.trim()) || S.project.name;
  try {
    const r = await api('POST', `/api/queue?p=${enc(S.proj)}`, { items: items.map((j) => ({ seq: S.seqMap?.mine, ...j, filename: j.filename || name, saveTo: saveTo() || undefined })) });
    if (localOn()) { for (const a of r.added) mine.add(a.id); keepMine(); }
    if (!quiet) toast(r.added.length > 1 ? `${r.added.length} renders added to the queue - keep editing, they render one after another` : `Added to the render queue: ${r.added[0].out} - keep editing meanwhile`);
    pollQueue();
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}

// check the queue every 1.5 s while something waits or renders; tell the header chip and announce finished files
const seenDone = new Set();
let firstPoll = true;
export async function pollQueue() {
  clearTimeout(qTimer);
  try { rq = await api('GET', '/api/queue'); } catch { qTimer = setTimeout(pollQueue, 5000); return; }
  let newDone = false;
  for (const it of rq.items) {
    if ((it.state !== 'done' && it.state !== 'failed') || seenDone.has(it.id)) continue;
    seenDone.add(it.id);
    if (firstPoll) continue; // already finished before this page opened
    if (it.state === 'done') { toast(`Render complete: ${it.out}`); if (it.project === S.proj) newDone = true; if (mine.has(it.id)) { mine.delete(it.id); keepMine(); toThisPc(`${it.url}?download`, it.out); } }
    else toast(`Render failed: ${it.label} - ${it.error || 'see the queue'}`, 'err');
  }
  firstPoll = false;
  if (newDone && root && S.proj) loadRenders().catch(() => {});
  const active = rq.items.filter((x) => x.state === 'waiting' || x.state === 'rendering');
  const cur = rq.items.find((x) => x.state === 'rendering');
  emit('queue', { count: active.length, label: cur ? `🎬 Rendering ${cur.progress}%${active.length > 1 ? ` · ${active.length - 1} waiting` : ''}` : active.length ? `🎬 ${active.length} waiting` : '' });
  drawQueue();
  if (active.length) qTimer = setTimeout(pollQueue, 1500);
}

const STATE = { waiting: 'waiting', rendering: 'rendering', done: '✓ done', failed: 'failed', cancelled: 'stopped' };
// 📁 the chosen export folder (owner only; per project, in this browser)
const saveKey = () => `ve-saveto:${S.proj}`;
// an editor's folder must be inside one of the team's Shared folders (the server checks it again)
const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
const inShared = (d) => (S.me?.shared || []).some((l) => { const a = norm(d), b = norm(l); return a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`); });
const saveTo = () => {
  if (!S.me || S.me.role === 'viewer') return '';
  let d = ''; try { d = localStorage.getItem(saveKey()) || ''; } catch {}
  return S.me.role === 'owner' || S.me.anyFolder || inShared(d) ? d : '';
};
function setSaveTo(d) { try { d ? localStorage.setItem(saveKey(), d) : localStorage.removeItem(saveKey()); } catch {} if (d) setLocal(false); syncSaveTo(); }
// 💻 "This PC" mode: the finished files are written into a folder of the computer you are at (localsave.js)
const localKey = () => `ve-savelocal:${S.proj}`;
const localOn = () => { try { return localStorage.getItem(localKey()) === '1'; } catch { return false; } };
function setLocal(on) { try { on ? localStorage.setItem(localKey(), '1') : localStorage.removeItem(localKey()); } catch {} }
const mine = new Set(JSON.parse((() => { try { return localStorage.getItem('ve-mine-renders') || '[]'; } catch { return '[]'; } })())); // renders started here for This PC
const keepMine = () => { try { localStorage.setItem('ve-mine-renders', JSON.stringify([...mine].slice(-50))); } catch {} };
// save a finished file into the PC's folder; if the browser wants the permission again, one click gives it
async function toThisPc(url, name) {
  try { const p = await saveToLocal(url, name); toast(`💻 Saved on this PC: ${p}`); }
  catch (e) {
    if (!e.permission) return toast(`Could not save on this PC: ${e.message}`, 'err');
    const m = modal('💻 Save on this PC', `<p>"${esc(name)}" is ready. The browser needs one click to write into your folder again.</p><div class="dv-actions"><button class="primary" data-action="go">💻 Save it now</button><button data-close>Later (⬇ Download is in the list)</button></div>`,
      { width: 520, onAction: async (a) => { if (a !== 'go') return; m.close(); try { toast(`💻 Saved on this PC: ${await saveToLocal(url, name, { ask: true })}`); } catch (er) { toast(er.message, 'err'); } } });
  }
}
function syncSaveTo() {
  if (!root) return;
  for (const row of $$('[data-saverow]', root)) {
    row.hidden = !S.me || S.me.role === 'viewer';
    if (S.me?.role !== 'owner' && !S.me?.anyFolder) $('[data-savepath]', row).placeholder = (S.me?.shared || []).length ? "This project's folder - or Browse for a Shared folder" : "This project's folder (no Shared folders yet)";
    $('[data-savepath]', row).value = saveTo(); $('[data-saveclear]', row).hidden = !saveTo() && !localOn();
  }
  if (localOn()) localDir().then((d) => { for (const row of $$('[data-saverow]', root)) $('[data-savepath]', row).value = d ? `💻 This PC › ${d.name}` : '💻 This PC (pick the folder again)'; });
}
function drawQueue() {
  if (!root || !S.project) return;
  const el = $('#dvQueue', root), list = rq.items.slice(-25).reverse();
  el.innerHTML = list.map((j) => {
    const other = j.project !== S.proj ? ` <span class="muted">(${esc(j.project)})</span>` : '';
    const seq = j.seq ? ` <span class="tag">${esc(j.seq)}</span>` : '';
    const acts = j.state === 'waiting' ? `<button class="link small" data-qmove="${j.id}" data-dir="-1" title="Render it earlier">↑</button><button class="link small" data-qmove="${j.id}" data-dir="1" title="Render it later">↓</button><button class="link small" data-qcancel="${j.id}" title="Take it out of the queue">✕</button>`
      : j.state === 'rendering' ? `<button class="link small" data-qcancel="${j.id}" title="Stop this render">■ Stop</button>`
      : j.state === 'done' ? (/\.mp4$/i.test(j.out) && j.project === S.proj ? `<button class="link small" data-play="${esc(j.url)}" data-name="${esc(j.out)}" title="Watch">▶</button>` : '') + `<a href="${j.url}?download" download title="Download">⬇</a>`
      : j.state === 'failed' ? `<button class="link small" data-qretry="${j.id}" title="Try again">⟳</button>` : '';
    return `<div class="dv-q-item ${j.state}"><div class="dv-q-top"><span class="grow"><b>${esc(j.label)}</b>${seq}${other}</span><span class="muted small">${STATE[j.state]}</span>${acts}</div>
      <div class="muted small mono">${esc(j.out)}</div>
      ${j.copiedTo ? `<div class="small good">📁 also saved to ${esc(j.copiedTo)}</div>` : j.copyError ? `<div class="warn small">Could not copy to your folder: ${esc(j.copyError)}</div>` : j.saveTo && j.state !== 'done' ? `<div class="muted small">📁 → ${esc(j.saveTo)}</div>` : ''}
      ${j.state === 'rendering' ? `<div class="bar"><div style="width:${Math.max(2, j.progress)}%"></div></div><div class="muted small">${j.progress}% · ${esc(j.stage || '')}</div>` : ''}
      ${j.state === 'failed' && j.error ? `<div class="warn small">${esc(j.error)}</div>` : ''}</div>`;
  }).join('') || '<div class="muted">Nothing in the queue. <b>Render video</b> adds the edit here; you can keep editing while it renders.</div>';
  $$('[data-qcancel]', el).forEach((b) => (b.onclick = async () => { await api('POST', `/api/queue/cancel?id=${b.dataset.qcancel}`); pollQueue(); }));
  $$('[data-qretry]', el).forEach((b) => (b.onclick = async () => { await api('POST', `/api/queue/retry?id=${b.dataset.qretry}`); pollQueue(); }));
  $$('[data-qmove]', el).forEach((b) => (b.onclick = async () => { await api('POST', `/api/queue/move?id=${b.dataset.qmove}&dir=${b.dataset.dir}`); pollQueue(); }));
  $$('[data-play]', el).forEach((b) => (b.onclick = () => play(b.dataset.play, b.dataset.name)));
  const g = $('#dvGpu', root);
  g.innerHTML = rq.gpu ? '<span class="ok">● NVIDIA GPU encoding works</span> <span class="muted">- tick it under Quality for faster 4K</span>'
    : '<span class="muted">GPU encoding is off: the NVIDIA driver is too old for FFmpeg. After updating it (GeForce Experience or nvidia.com)</span> <button class="link small" id="dvGpuCheck">check again</button>';
  const gc = $('#dvGpuCheck', root);
  if (gc) gc.onclick = async () => { gc.textContent = 'checking…'; S.health = await api('POST', '/api/health/recheck'); await pollQueue(); syncSpec(); toast(S.health.nvenc ? 'GPU encoding works now' : 'Still not available - the driver needs an update', S.health.nvenc ? '' : 'err'); };
}

// 📦 one click, many platforms: each ticked platform in its own best frame shape (reframed when needed)
function bundleDialog() {
  const a = S.project.settings.aspect;
  const defs = ['reel', 'youtube', 'whatsapp'];
  const shape = (p) => (!p.aspects.length || p.aspects.includes(a) ? a : p.aspects[0]);
  const body = `<p class="muted">The same edit, rendered for every platform you tick - one after another, while you keep editing.
    A platform that wants another shape (a 16:9 film as a 9:16 Reel) gets the edit reframed.</p>
    <div class="bundle">${PRESETS.map((p) => `<label class="chk"><input type="checkbox" data-bp="${p.id}"${defs.includes(p.id) ? ' checked' : ''}> <span class="grow">${esc(p.label)}</span>
      <select data-ba="${p.id}" aria-label="Frame for ${esc(p.label)}">${Object.keys(ASPECTS).map((x) => `<option${x === shape(p) ? ' selected' : ''}>${x}</option>`).join('')}</select></label>`).join('')}</div>
    <label class="fld"><span>Reframe with</span><select data-bfit>${REFRAME.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    <p class="muted small">Quality settings from the Export panel apply to all of them. Shots that did not change since an earlier render are reused, so the second and third version go faster.</p>
    <div class="dv-actions"><button class="primary" data-action="go">Add to the queue</button><button data-close>Cancel</button></div>`;
  const m = modal('📦 Render for many platforms', body, { width: 580, onAction: async (act) => {
    if (act !== 'go') return;
    const fit = $('[data-bfit]', m.el).value, q = quality();
    const items = $$('[data-bp]', m.el).filter((c) => c.checked).map((c) => ({ preset: c.dataset.bp, aspect: $(`[data-ba="${c.dataset.bp}"]`, m.el).value, fit, quality: q }));
    if (!items.length) return toast('Tick at least one platform', 'err');
    m.close();
    await enqueue(items);
  } });
}

async function render(preview, job = null) {
  if (busy) { toast('Wait for the preview to finish', 'err'); return false; }
  if (!Object.values(S.project.tracks).flat().length) { toast('The timeline is empty', 'err'); return false; }
  try { await bakeAll(); } catch (e) { toast(`Graphics: ${e.message}`, 'err'); return false; }
  await saveNow();
  busy = true;
  const box = $('#dvJob', root); box.hidden = false; box.className = 'job';
  const label = job ? `${presetById(job.preset).label} (${job.aspect})` : 'Accurate preview';
  $('#dvJobL', root).textContent = `${label}: rendering…`;
  $('#dvBar', root).style.width = '3%';
  emit('job', { running: true, label: preview ? 'Preview' : 'Rendering' });
  try {
    // ⚡ the Accurate preview's quality, chosen next to its button on the monitor: 1080p (camera files) or Fast 720p (proxies)
    let fast = false; try { fast = localStorage.getItem('ve-preview-q') === 'fast'; } catch {}
    const started = await api('POST', `/api/render?p=${enc(S.proj)}`, preview ? { preview, fast, seq: S.seqMap?.mine } : { seq: S.seqMap?.mine, ...job, filename: job.filename || $('#dvName', root).value.trim() });
    const clock = progressClock();
    const j = await watchJob(started.id, (j) => {
      $('#dvBar', root).style.width = `${Math.max(3, j.progress)}%`;
      $('#dvJobT', root).textContent = `${j.progress}% · ${clock.tick(j.progress).text}`;
      $('#dvLog', root).textContent = j.log.join('\n');
      emit('job', { running: true, label: `${preview ? 'Preview' : 'Render'} ${j.progress}%`, progress: j.progress });
    });
    box.classList.add('done');
    $('#dvJobL', root).textContent = preview ? 'Preview ready' : `Done: ${j.result.output}`;
    await loadRenders();
    // (a preview asked for from the Edit page plays only in its own window - not also, unseen, in Deliver's monitor)
    const elsewhere = preview && S.page !== 'deliver';
    if (/\.mp4$/i.test(j.result.output) && !elsewhere) play(j.result.url, preview ? 'Accurate preview (low-res)' : j.result.output);
    if (elsewhere) {
      const pv = modal('Accurate preview', `<video src="${j.result.url}" controls autoplay style="width:100%;max-height:70vh;background:#000"></video>`, { width: 900,
        onClose: () => { const v = pv?.el.querySelector('video'); if (v) { v.pause(); v.removeAttribute('src'); v.load(); } } }); // closing it stops it
    }
    toast(preview ? 'Preview ready' : `Render complete: ${j.result.output}`);
    return true;
  } catch (e) {
    box.classList.add('error');
    $('#dvJobL', root).textContent = `${label}: failed - see the log`;
    if (e.job) $('#dvLog', root).textContent = e.job.log.join('\n');
    box.querySelector('details').open = true;
    toast(e.message, 'err');
    return false;
  } finally { busy = false; emit('job', { running: false }); }
}

async function loadRenders() {
  S.renders = await api('GET', `/api/renders?p=${enc(S.proj)}`);
  $('#dvList', root).innerHTML = S.renders.length ? S.renders.map((r) => `<div class="dv-item">
      ${/\.mov$/i.test(r.name) ? `<span class="link" title="ProRes plays in Premiere, Resolve or VLC, not in the browser">${esc(r.name)}</span>`
        : `<button class="link" data-play="${esc(r.url)}" data-name="${esc(r.name)}">${esc(r.name)}</button>`}<span class="muted">${fmtSize(r.size)}</span>
      <a class="link small" href="${r.url}?download" download title="Download to this PC">⬇ Download</a></div>`).join('') : '<div class="muted">Nothing rendered yet</div>';
  $$('[data-play]', root).forEach((b) => (b.onclick = () => play(b.dataset.play, b.dataset.name)));
  fillSources();
}
function play(url, name) { const v = $('#dvVideo', root); v.src = url; showView('render'); $('#dvNow', root).textContent = name; v.play().catch(() => {}); }
const openSub = (sub) => api('POST', `/api/open-folder?p=${enc(S.proj)}&sub=${enc(sub)}`).catch((e) => toast(e.message, 'err'));

// ---------------- timeline hand-off (Premiere Pro / DaVinci Resolve) ----------------
async function exportXml() {
  if (!Object.values(S.project.tracks).flat().length) return toast('The timeline is empty', 'err');
  await saveNow();
  const b = $('#dvXml', root); b.disabled = true; b.textContent = 'Exporting…';
  try {
    let r = await api('POST', `/api/export/timeline?p=${enc(S.proj)}`, { filename: $('#dvName', root).value.trim(), color: $('#dvXmlColor', root).value, collect: $('#dvXmlMedia', root).value, saveTo: saveTo() || undefined });
    if (r.id && r.status) r = (await watchJob(r.id, (j) => { b.textContent = `${j.stage || 'Working'}… ${j.progress}%`; emit('job', { running: true, label: `XML export ${j.progress}%` }); })).result;
    emit('job', { running: false });
    await loadExports();
    if (localOn() && r.folder) toThisPc(`/api/export/zip?p=${enc(S.proj)}&name=${enc(r.folder)}`, `${r.folder}.zip`); // 💻
    const extra = r.files.length - 2;
    const m = modal('Timeline exported', `<p><b>${esc(r.folder)}</b>: ${r.clips} clips in <span class="mono">${esc(r.xml)}</span>${extra > 0 ? `, plus ${extra} title/subtitle file${extra > 1 ? 's' : ''}` : ''}.</p>
      ${r.collected ? `<p>📦 <b>${r.collected.files} media files</b> (${r.collected.mb >= 1024 ? `${(r.collected.mb / 1024).toFixed(1)} GB` : `${r.collected.mb} MB`}) are in the <b>Media</b> folder${r.collected.cut ? ` - ${r.collected.cut} video clips cut down to the used part` : ''}. Send the <b>whole folder</b>. If the other computer shows clips offline: Premiere → Link Media → pick one file in Media (the rest link by themselves); Resolve → Relink Selected Clips → Media folder.</p>` : '<p class="muted">The XML links to the files on this computer - on another computer they will be missing (choose a 📦 Collect option to send the footage too).</p>'}
      ${r.color === 'lut' ? '<p>Colour: each graded clip has its own <b>.cube LUT</b> (clip names end in [LUT nn]) - how to apply it is in the README.</p>' : r.color === 'bake' ? '<p>Colour: the clips are already coloured (graded folder) - nothing to re-grade.</p>' : ''}
      <ol class="dv-steps"><li><b>Premiere Pro:</b> File → Import → pick the .xml. A new sequence appears in the Project panel.</li>
      <li><b>DaVinci Resolve:</b> File → Import → Timeline → pick the .xml and tick “Automatically import source clips into media pool”.</li></ol>
      ${r.notes.length ? `<p class="muted">Redo these by hand (also listed in the README file):</p><ul class="warns">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p>Everything in this edit carries over.</p>'}
      <div class="dv-actions">${!saveTo() ? `<a class="btn primary" href="/api/export/zip?p=${enc(S.proj)}&name=${enc(r.folder)}" download>⬇ Download to this PC (.zip)</a>` : ''}${S.me?.role !== 'viewer' ? '<button data-action="open">Open folder</button>' : ''}<button data-close>Close</button></div>`,
      { width: 640, onAction: (a) => { if (a === 'open') { if (saveTo() && r.path && S.me?.role !== 'owner') toast(`Saved in ${r.path}`); else if (saveTo() && r.path) api('POST', `/api/open-folder?p=${enc(S.proj)}&path=${enc(r.path)}`).catch((e) => toast(e.message, 'err')); else openSub(`exports/${r.folder}`); m.close(); } } });
  } catch (e) { toast(e.message, 'err'); }
  finally { b.disabled = false; b.textContent = 'Export timeline (XML)'; }
}
async function loadExports() {
  if (!root || !S.proj) return;
  const list = await api('GET', `/api/exports?p=${enc(S.proj)}`).catch(() => []);
  $('#dvXmlList', root).innerHTML = list.slice(0, 6).map((x) => `<div class="dv-item"><span class="link">${esc(x.name)}</span>
    <a class="link small" href="/api/export/zip?p=${enc(S.proj)}&name=${enc(x.name)}" download title="Download the whole folder as one .zip to this PC">⬇ Download (.zip)</a>${S.me?.role !== 'viewer' ? `<button class="link small" data-xopen="${esc(x.name)}">Open folder</button>` : ''}</div>`).join('');
  $$('[data-xopen]', root).forEach((b) => (b.onclick = () => openSub(`exports/${b.dataset.xopen}`)));
}

// ---------------- subtitles ----------------
function fillSources() {
  const opts = [...S.renders.map((r) => [`r:${r.name}`, `Render: ${r.name}`]), ...S.media.filter((m) => m.hasAudio).map((m) => [`m:${m.id}`, `Media: ${m.name}`])];
  const cur = $('#trSrc', root).value;
  $('#trSrc', root).innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('') || '<option value="">Render or import something first</option>';
  $('#trGo', root).disabled = !S.health.whisper || !opts.length;
  if (!S.health.whisper) $('#trGo', root).title = 'Python + faster-whisper not found';
}
async function transcribe() {
  const v = $('#trSrc', root).value;
  if (!v) return;
  const body = { lang: $('#trLang', root).value, task: $('#trTask', root).value, words: $('#trWords', root).value, model: $('#trModel', root).value, prompt: $('#trPrompt', root).value };
  if (v.startsWith('r:')) body.render = v.slice(2); else body.mediaId = v.slice(2);
  const b = $('#trGo', root); b.disabled = true; b.textContent = 'Listening… (first run downloads the speech model)';
  try {
    const job = await api('POST', `/api/transcribe?p=${enc(S.proj)}`, body);
    const j = await watchJob(job.id, (j) => { b.textContent = `Listening… ${Math.round(j.elapsed)}s`; });
    await loadSubsList();
    $('#subPick', root).value = j.result.subs; await loadSub(j.result.subs);
    toast('Subtitles ready - proof-read them, then Save and Burn in');
  } catch (e) { toast(e.job ? `Subtitles failed: ${e.job.log.slice(-2).join(' ')}` : e.message, 'err'); }
  finally { b.disabled = false; b.textContent = 'Generate subtitles'; }
}
async function loadSubsList() {
  if (!root || !S.proj) return;
  S.subs = await api('GET', `/api/subs?p=${enc(S.proj)}`);
  const cur = $('#subPick', root).value;
  $('#subPick', root).innerHTML = '<option value="">- subtitle file -</option>' + S.subs.map((s) => `<option${s.name === cur ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  syncSubs();
}
function syncSubs() { const f = $('#subPick', root).value; $('#subBurn', root).textContent = f && S.project.subtitles?.file === f ? 'Burning ✓' : 'Burn in'; syncSpec(); }
async function loadSub(name) {
  if (!name) { $('#subText', root).value = ''; return syncSubs(); }
  const r = await api('GET', `/api/subs/file?p=${enc(S.proj)}&name=${enc(name)}`);
  $('#subText', root).value = r.text; syncSubs();
}
async function saveSub() {
  const n = $('#subPick', root).value;
  if (!n) return toast('Pick a subtitle file first', 'err');
  try { await api('PUT', `/api/subs?p=${enc(S.proj)}&name=${enc(n)}`, $('#subText', root).value); toast('Subtitles saved'); }
  catch (e) { toast(e.message, 'err'); }
}
