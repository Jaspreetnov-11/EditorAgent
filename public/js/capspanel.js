// CC Captions panel: make captions (from the voice-over, from the whole edit's sound, or an .srt), style them,
// and edit them line by line - text, timing (set to the playhead), split, merge, delete, add. Data: project.captions
// (public/js/captions.js); burned into renders, previewed live in the viewer.
// 🗂 Caption tracks (as Premiere): pick the track you edit, add / rename / delete / show-hide tracks, save one as .srt,
// and 🌐 translate one into a new track (English / Hindi / Hinglish, same timings - Claude on the server).
import { guarded } from './errlog.js';
import { S, on, emit, commit, layout } from './store.js';
import { api, enc, watchJob } from './api.js';
import { fmt, uid } from './model.js';
import { $, esc, toast } from './ui.js';
import { loadLib, libCached, saveCaptionStyle } from './library.js';
import { CAPTION_PRESETS, CAPTION_FONTS, CAPTION_LANGS, MAIN_TRACK, defaultCaptions, cuesFromSegments, cuesFromSrt, splitCue, mergeCue, capTracks, trackId, trackName, addCapTrack, removeCapTrack, srtOf } from './captions.js';

let root, busy = false, lastActive = null, editId = MAIN_TRACK;
// (an older or half-written project can have captions without a style / cue list: the missing parts are filled in)
const fill = (t) => { const d = defaultCaptions(); t.style = { ...d.style, ...(t.style || {}) }; if (!Array.isArray(t.cues)) t.cues = []; return t; };
const cap = () => fill(S.project.captions ||= defaultCaptions());
// 🗂 the track being edited (track 1 when the picked one is gone - deleted here or by someone else)
const cur = () => { const c = cap(), t = capTracks(c).find((x) => trackId(c, x) === editId); if (!t) editId = MAIN_TRACK; return fill(t || c); };
const r3 = (x) => Math.round(x * 1000) / 1000;

export function mountCapsPanel(el) {
  root = el;
  on('change', () => { if (!root.hidden && !root.contains(document.activeElement)) draw(); });
  on('playhead', markActive);
  on('library', () => draw());
  loadLib().then(() => draw()).catch(() => {});
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  draw();
}
export const refreshCaps = () => draw();

function draw() { return guarded(root, 'Captions', drawNow); }
function drawNow() {
  if (!root || !S.project) return;
  const all = capTracks(cap()), c = cur(), st = c.style, vo = S.project.tracks.A1?.find((x) => S.mediaById[x.mediaId]);
  root.innerHTML = `<div class="cc-top">
      <div class="row-in"><select data-trk title="The caption track you are editing">${all.map((t, i) => `<option value="${esc(trackId(cap(), t))}"${t === c ? ' selected' : ''}>${t.on ? '' : '🚫 '}${esc(trackName(t, i))}${t.lang && trackName(t, i) !== (CAPTION_LANGS[t.lang] || t.lang) ? ` · ${esc(CAPTION_LANGS[t.lang] || t.lang)}` : ''} (${(t.cues || []).length})</option>`).join('')}</select><button class="icon-btn small" data-a="tadd" title="New caption track (e.g. a second language)">＋</button><button class="icon-btn small" data-a="tren" title="Rename this track">✎</button><button class="icon-btn small" data-a="tdel" title="Delete this track"></button>
        <select data-tr title="Make a new track in another language - same timings (Claude translates)"${c.cues.length ? '' : ' disabled'}><option value="">Translate to…</option>${Object.entries(CAPTION_LANGS).filter(([k]) => k !== c.lang).map(([k, l]) => `<option value="${k}">${l}${k === 'hinglish' ? ' (Roman letters)' : ''}</option>`).join('')}</select>${c.cues.length ? '<button class="icon-btn small" data-a="srt" title="Save this track as an .srt file">.srt</button>' : ''}</div>
      <div class="row-in"><button class="small accent" data-a="fromvo"${vo ? '' : ' disabled title="No voice-over on A1"'}>From voice-over</button><button class="small" data-a="fromedit" title="Renders a quick mix of the whole edit and listens to it - works for any sound (slower)">From the edit's sound</button></div>
      <div class="row-in"><select data-k="lang" title="Language spoken"><option value="auto">Auto language</option><option value="hi">Hindi</option><option value="en">English</option></select><select data-srt><option value="">Import .srt…</option></select>
        <label class="chk" title="Show this track in the viewer and burn it into renders"><input type="checkbox" data-k="on"${c.on ? ' checked' : ''}> Show + burn in</label></div>
      <details class="cc-style"${c.cues.length ? '' : ' open'}><summary>Style · ${esc(CAPTION_PRESETS[st.preset]?.label || 'Custom')}</summary>
        <div class="cc-presets">${Object.entries(CAPTION_PRESETS).map(([k, p]) => `<button class="chip${st.preset === k ? ' on' : ''}" data-preset="${k}" style="${p.box ? `background:${p.box};` : ''}color:${p.color}">${esc(p.label)}</button>`).join('')}${(libCached()?.presets?.captions || []).map((p) => `<button class="chip${st.preset === p.id ? ' on' : ''}" data-mypreset="${p.id}" style="${p.data.box ? `background:${p.data.box};` : ''}color:${p.data.color}">${esc(p.name)}</button>`).join('')}<button class="chip" data-a="savestyle" title="Save this style for every project">Save style</button></div>
        <div class="fgrid">
          <label class="fld"><span>Font</span><select data-s="font">${CAPTION_FONTS.map((f) => `<option${f === st.font ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
          <label class="fld"><span>Size</span><input type="number" min="20" max="160" step="2" data-s="size" value="${st.size}"></label>
          <label class="fld"><span>Text</span><input type="color" data-s="color" value="${st.color}"></label>
          <label class="fld"><span>Highlight</span><input type="color" data-s="hl" value="${st.hl}"></label>
          <label class="fld"><span>Box</span><select data-s="box"><option value="">No box (outline)</option>${['#000000', '#0b2545', '#e8740c', '#b71c1c', '#ffffff'].map((b) => `<option value="${b}"${st.box === b ? ' selected' : ''}>${{ '#000000': 'Black', '#0b2545': 'Navy', '#e8740c': 'Saffron', '#b71c1c': 'Red', '#ffffff': 'White' }[b]}</option>`).join('')}</select></label>
          <label class="fld"><span>Position</span><select data-s="pos">${[['bottom', 'Bottom'], ['middle', 'Middle'], ['top', 'Top']].map(([v, l]) => `<option value="${v}"${st.pos === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="fld"><span>Animation</span><select data-s="anim">${[['none', 'None'], ['karaoke', 'Word highlight'], ['pop', 'Word pop']].map(([v, l]) => `<option value="${v}"${st.anim === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="fld"><span>Words a line</span><input type="number" min="1" max="12" data-s="words" value="${st.words}" title="Used when captions are made"></label>
          <label class="chk"><input type="checkbox" data-s="upper"${st.upper ? ' checked' : ''}> CAPITALS</label>
        </div></details>
    </div>
    <div class="cc-list" data-list>${c.cues.length ? c.cues.map((q, i) => `<div class="cc-cue" data-id="${q.id}">
        <button class="cc-t" data-a="seek" title="Go there">${fmt(q.start)}</button>
        <textarea rows="1" data-text>${esc(q.text)}</textarea>
        <div class="cc-btns"><button class="icon-btn small" data-a="instart" title="Start at the playhead">⇤</button><button class="icon-btn small" data-a="inend" title="End at the playhead">⇥</button><button class="icon-btn small" data-a="split" title="Split at the playhead"></button>${i < c.cues.length - 1 ? '<button class="icon-btn small" data-a="merge" title="Join with the next line">⊕</button>' : ''}<button class="icon-btn small" data-a="del" title="Delete line">✕</button></div></div>`).join('')
      : '<p class="muted pad small">No captions yet - make them from the voice-over or the edit\'s sound, import an .srt, or add lines yourself.</p>'}</div>
    <div class="cc-foot"><button class="small" data-a="add">+ Line at playhead</button><span class="grow"></span>${c.cues.length ? `<button class="small" data-a="shift" title="Move every line earlier / later">⇆ Shift all…</button><button class="small danger" data-a="clear">Clear</button>` : ''}</div>`;
  api('GET', `/api/subs?p=${enc(S.proj)}`).then((l) => { const sel = $('[data-srt]', root); if (sel) sel.insertAdjacentHTML('beforeend', l.map((x) => `<option>${esc(x.name || x)}</option>`).join('')); }).catch(() => {});
  lastActive = null; markActive();
}

function markActive() {
  if (!root || root.hidden || !S.project?.captions) return;
  const q = cur().cues.find((c) => S.playhead >= c.start && S.playhead < c.end);
  if (q?.id === lastActive) return;
  root.querySelectorAll('.cc-cue.on').forEach((e) => e.classList.remove('on'));
  if (q) { const e = root.querySelector(`[data-id="${q.id}"]`); e?.classList.add('on'); e?.scrollIntoView({ block: 'nearest' }); }
  lastActive = q?.id || null;
}

function cueOf(el) { const id = el.closest('[data-id]')?.dataset.id; return cur().cues.find((c) => c.id === id); }

async function onClick(e) {
  const pre = e.target.closest('[data-preset]')?.dataset.preset;
  if (pre) { cur().style = { preset: pre, ...CAPTION_PRESETS[pre] }; commit('Caption style'); return draw(); }
  const my = e.target.closest('[data-mypreset]')?.dataset.mypreset;
  if (my) { const p = libCached()?.presets?.captions?.find((x) => x.id === my); if (p) { cur().style = { ...p.data, preset: p.id }; commit('Caption style'); } return draw(); }
  const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
  const c = cur(), q = cueOf(e.target), t = r3(S.playhead);
  // 🗂 tracks
  if (a === 'tadd') { const n = addCapTrack(cap(), { style: { ...c.style } }); editId = n.id; commit('New caption track'); return draw(); }
  if (a === 'tren') { const i = capTracks(cap()).indexOf(c), n = prompt('Name of this caption track:', trackName(c, i)); if (!n?.trim()) return; c.name = n.trim(); commit('Rename caption track'); return draw(); }
  if (a === 'tdel') {
    if (capTracks(cap()).length < 2 && !c.cues.length) return toast('Nothing to delete');
    if (!confirm(`Delete the caption track "${trackName(c, capTracks(cap()).indexOf(c))}"${c.cues.length ? ` and its ${c.cues.length} lines` : ''}?`)) return;
    removeCapTrack(cap(), editId); editId = MAIN_TRACK; commit('Delete caption track'); return draw();
  }
  if (a === 'srt') return saveSrt(c);
  if (a === 'seek') return emit('seek', q.start + 0.01);
  if (a === 'instart' && q) { if (t < q.end - 0.1) q.start = t; else return toast('The playhead is after this line ends', 'err'); }
  if (a === 'inend' && q) { if (t > q.start + 0.1) q.end = t; else return toast('The playhead is before this line starts', 'err'); }
  if (a === 'split' && q && !splitCue(c.cues, q.id, t)) return toast('Put the playhead inside this line (between two words)', 'err');
  if (a === 'merge' && q) mergeCue(c.cues, q.id);
  if (a === 'del' && q) c.cues = c.cues.filter((x) => x !== q);
  if (a === 'add') { const nx = c.cues.find((x) => x.start > t); const n = { id: uid(), start: t, end: r3(Math.min(t + 2, nx ? nx.start - 0.02 : t + 2)), text: 'New caption' }; c.cues.push(n); c.cues.sort((x, y) => x.start - y.start); }
  if (a === 'shift') { const d = parseFloat(prompt('Move every caption by how many seconds? (negative = earlier)', '0.2')); if (!d) return; c.cues.forEach((x) => { x.start = r3(Math.max(0, x.start + d)); x.end = r3(Math.max(x.start + 0.2, x.end + d)); x.words?.forEach((w) => { w.t0 = r3(w.t0 + d); w.t1 = r3(w.t1 + d); }); }); }
  if (a === 'clear') { if (!confirm('Delete all captions?')) return; c.cues = []; }
  if (a === 'fromvo' || a === 'fromedit') return generate(a === 'fromvo' ? 'vo' : 'edit');
  if (a === 'savestyle') return saveCaptionStyle(c.style);
  c.cues.sort((x, y) => x.start - y.start);
  commit(`Captions ${a}`); draw();
}

function onChange(e) {
  const c = cur(), k = e.target.dataset.k, s = e.target.dataset.s;
  if (e.target.matches('[data-trk]')) { editId = e.target.value; return draw(); }
  if (e.target.matches('[data-tr]') && e.target.value) return translate(e.target.value);
  if (k === 'on') { c.on = e.target.checked; commit('Captions on/off'); toast(c.on ? 'This caption track shows and is burned into renders' : 'This caption track is hidden and not burned in'); draw(); }
  if (s) { c.style = { ...c.style, preset: 'custom', [s]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? +e.target.value : e.target.value }; commit('Caption style', 'capstyle'); }
  if (e.target.matches('[data-text]')) commit('Caption text', `cap-${cueOf(e.target)?.id}`);
  if (e.target.matches('[data-srt]') && e.target.value) importSrt(e.target.value);
}
function onInput(e) {
  if (!e.target.matches('[data-text]')) return;
  const q = cueOf(e.target); if (q) { q.text = e.target.value; emit('live'); }
}

async function importSrt(name) {
  const f = await api('GET', `/api/subs/file?p=${enc(S.proj)}&name=${enc(name)}`);
  const cues = cuesFromSrt(f.text);
  if (!cues.length) return toast('No captions found in that file', 'err');
  if (cur().cues.length && !confirm(`Replace the ${cur().cues.length} current captions?`)) return draw();
  cur().cues = cues; cur().on = true;
  commit('Import captions'); draw(); toast(`${cues.length} captions imported - edit them here`);
}
// ⬇ the track being edited as an .srt download
function saveSrt(t) {
  const a = document.createElement('a'), name = `${S.proj}${t === cap() ? '' : ` - ${trackName(t, capTracks(cap()).indexOf(t))}`}.srt`.replace(/[\\/:*?"<>|]/g, '_');
  a.href = URL.createObjectURL(new Blob([`﻿${srtOf(t.cues)}`], { type: 'text/plain' })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// 🌐 a new track in another language: the lines go to the server (Claude translates them in batches), timings stay
async function translate(to) {
  const src = cur();
  if (busy || !src.cues.length) return draw();
  busy = true;
  const status = (m) => { const sel = $('[data-tr]', root); if (sel) { sel.disabled = true; sel.options[0].textContent = m; sel.value = ''; } };
  try {
    status('Translating…');
    const job = await api('POST', `/api/captions/translate?p=${enc(S.proj)}`, { to, from: src.lang || '', lines: src.cues.map((q) => q.text || '') });
    const r = (await watchJob(job.id, (x) => status(`Translating ${x.progress || 0}%`))).result;
    const t = addCapTrack(cap(), { name: CAPTION_LANGS[to] || to, lang: to, style: { ...src.style }, cues: src.cues.map((q, i) => ({ id: uid(), start: q.start, end: q.end, text: r.lines[i] || q.text })) });
    editId = t.id;
    commit('Translate captions');
    toast(`✓ ${CAPTION_LANGS[to] || to} captions on a new track - same timings, check the words`);
  } catch (err) { toast(err.job?.log?.slice(-1)[0] || err.message || String(err), 'err'); }
  finally { busy = false; draw(); }
}

// vo: the voice-over on A1 (fast); edit: a quick mix of the whole edit, so every sound lines up with the timeline
async function generate(src) {
  if (busy) return;
  if (cur().cues.length && !confirm(`Replace the ${cur().cues.length} current captions?`)) return;
  busy = true;
  const c = cur(), lang = $('[data-k="lang"]', root)?.value || 'auto', n = c.style.words || 5;
  const status = (m) => { const b = $(`[data-a="${src === 'vo' ? 'fromvo' : 'fromedit'}"]`, root); if (b) { b.disabled = true; b.textContent = m; } };
  try {
    let segs, offset = 0, clip = null;
    if (src === 'vo') {
      clip = S.project.tracks.A1.find((x) => S.mediaById[x.mediaId]);
      status('Listening…');
      const job = await api('POST', `/api/transcribe?p=${enc(S.proj)}`, { mediaId: clip.mediaId, lang, model: 'medium', words: n, json: true });
      segs = (await watchJob(job.id, (x) => status(`Listening ${x.progress || 0}%`))).result.segments;
      offset = (clip.start || 0) - (clip.in || 0);
    } else {
      status('Mixing the edit…');
      const pj = await api('POST', `/api/render?p=${enc(S.proj)}`, { project: { ...S.project, captions: { ...cap(), on: false, tracks: [] } }, preview: true });
      const pr = (await watchJob(pj.id, (x) => status(`Mixing ${x.progress || 0}%`))).result;
      status('Listening…');
      const job = await api('POST', `/api/transcribe?p=${enc(S.proj)}`, { render: pr.output, lang, model: 'medium', words: n, json: true });
      segs = (await watchJob(job.id, (x) => status(`Listening ${x.progress || 0}%`))).result.segments;
    }
    let cues = cuesFromSegments(segs, n, offset);
    if (clip) { const a = clip.start || 0, b = a + (layout().A1.find((x) => x.clip.id === clip.id)?.end - a || Infinity); cues = cues.filter((q) => q.end > a && q.start < b); }
    if (!cues.length) throw new Error('No speech found');
    c.cues = cues; c.on = true;
    if (lang !== 'auto') c.lang = lang;
    commit('Make captions');
    toast(`✓ ${cues.length} caption lines - check the words, they are editable`);
  } catch (err) { toast(err.message || String(err), 'err'); }
  finally { busy = false; draw(); }
}
