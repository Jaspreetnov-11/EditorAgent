// ⚡ Automation: a complete video in five steps - the script, the footage (and what to make), the voice-over and music,
// the Agent's edit, check and export. Each step either does its job right there (the script line, a ready-made track,
// "Generate voice") or opens the dialog that already does it. On Home it sits above the projects (only for someone with
// few projects); in a project it shows while the sequence is still empty (Media page help, and over the empty
// timeline). "Hide" puts it away in this browser; Tools › Automation brings it back.
// What is chosen is kept per project in this browser (script, voice-over, music) and handed to the Agent in step 4.
import { S, on, emit } from './store.js';
import { $, $$, h, esc, toast, modal } from './ui.js';
import { api, enc, watchJob } from './api.js';
import { fmt } from './model.js';
import { refreshMedia, uploadAudioInto } from './mediapool.js';
import { JOBS, TYPES, openAgent } from './agent.js';
import { voicePicker } from './voiceover.js';
import { openPromptGuide } from './promptguide.js';

const HIDE = 've-start-hide', JOBKEY = 've-start-job', SCRIPTKEY = 've-start-script', FEW = 6; // (Home: the big card only with fewer projects than this)
export const startHidden = () => { try { return localStorage.getItem(HIDE) === '1'; } catch { return false; } };
const setHidden = (v) => { try { if (v) localStorage.setItem(HIDE, '1'); else localStorage.removeItem(HIDE); } catch {} };
// the job / script picked on Home before its project existed: the new project's steps start from them (this tab, an hour)
const pending = (k) => { try { const x = JSON.parse(sessionStorage.getItem(k) || 'null'); return x && Date.now() - x.at < 3600e3 ? x.v : null; } catch { return null; } };
const setPend = (k, v) => { try { if (v) sessionStorage.setItem(k, JSON.stringify({ v, at: Date.now() })); else sessionStorage.removeItem(k); } catch {} };
const pendingJob = () => pending(JOBKEY);
// this project's choices: { script, vo, music } (media ids)
const DRAFT = () => `ve-auto:${S.proj}`;
const draft = () => { try { return JSON.parse(localStorage.getItem(DRAFT()) || '{}'); } catch { return {}; } };
const setDraft = (o) => { try { localStorage.setItem(DRAFT(), JSON.stringify({ ...draft(), ...o })); } catch {} };

// step 2: the ready-made jobs, and the Agent's other kinds that a new editor asks for most
const KINDS = [...JOBS.map((j) => ({ job: j.id, label: j.label, sub: j.sub })), { type: 'reference', label: 'Copy a reference', sub: 'cut like a video you like' }, { type: 'reel', label: 'Something else…', sub: 'every kind the Agent makes' }];
const kindChips = (chosen) => `<div class="sh-kinds">${KINDS.map((k) => `<button type="button" class="chip${k.job && k.job === chosen ? ' on' : ''}" ${k.job ? `data-shjob="${k.job}"` : `data-shtype="${k.type}"`} title="${esc(k.sub)}">${esc(k.label)}</button>`).join('')}</div>`;
const TITLE = 'Complete video in 5 easy steps';
const head = (title) => `<div class="sh-head"><div><span class="sh-kicker">Automation</span><h2>${title}</h2></div><span class="grow"></span>
  <button type="button" class="link small" data-shguide>Prompt guide</button><button type="button" class="link small" data-shhide title="Tools › Automation brings it back">Hide</button></div>`;
const step = (n, title, text, extra = '', done = false) => `<li class="sh-step${done ? ' done' : ''}"><i>${done ? '✓' : n}</i><div><b>${title}</b>${text ? `<small>${text}</small>` : ''}${extra}</div></li>`;
// step 1: one line to paste the script into (it takes any length; the box stays one line)
const words = (t) => (String(t || '').trim() ? String(t).trim().split(/\s+/).length : 0);
const scriptInfo = (t) => (words(t) ? `${words(t)} words · about ${fmt(String(t).trim().length / 14.5)} of voice-over` : 'Paste or type it - Hindi, English or Hinglish. Optional.');
const scriptLine = (t) => `<input class="sh-script" data-shscript value="${esc(t || '')}" placeholder="Paste the script here…" aria-label="Script" spellcheck="false"><small data-shscriptinfo>${scriptInfo(t)}</small>`;

// ---------------- 🏠 Home ----------------
// el: Home; count: projects shown; newProject(): the New project dialog (home.js)
export function mountHomeStart(el, count, newProject) {
  $('.sh-home', el)?.remove(); $('[data-shopen]', el)?.remove();
  const big = !startHidden() && count < FEW;
  if (!big) { // the steps one click away: a small button beside + New project
    $('.home-actions', el)?.insertAdjacentHTML('afterbegin', `<button class="small" data-shopen title="Automation: a complete video in 5 easy steps - script, footage, voice-over and music, the Agent's edit, export">Automation</button>`);
    $('[data-shopen]', el).onclick = () => { setHidden(false); mountHomeStart(el, 0, newProject); };
    return;
  }
  const card = h(`<section class="sh sh-home">${head(TITLE)}<ol class="sh-steps">
    ${step(1, 'Script', '', scriptLine(pending(SCRIPTKEY)))}
    ${step(2, 'Footage', 'Make a project and bring the raw folder, then pick what to make.', `<button type="button" class="primary small" data-shnew>New project</button>${kindChips(pendingJob())}`)}
    ${step(3, 'Voice-over & music', 'Generate the voice from the script (or a voice sample), or upload yours. Pick a ready-made track or upload music.')}
    ${step(4, 'Let the Agent edit', 'It looks at the footage, follows the voice-over and cuts on the beat.')}
    ${step(5, 'Check & export', 'Watch it (Space), change things in the Assistant ("music dheema karo"), then <b>Export</b>.')}
  </ol></section>`);
  $('.home-head', el).after(card);
  card.addEventListener('input', (e) => { if (e.target.matches('[data-shscript]')) { setPend(SCRIPTKEY, e.target.value.trim()); $('[data-shscriptinfo]', card).textContent = scriptInfo(e.target.value); } });
  card.onclick = (e) => {
    e.stopPropagation(); // (Home's own click handler opens projects)
    if (e.target.closest('[data-shhide]')) { setHidden(true); toast('Automation is hidden - the Automation button (and Tools › Automation) brings it back'); return mountHomeStart(el, count, newProject); }
    if (e.target.closest('[data-shguide]')) return openPromptGuide();
    if (e.target.closest('[data-shnew]')) return newProject();
    const k = e.target.closest('[data-shjob], [data-shtype]');
    if (k) { // a job before there is a project: the New project dialog in its format, and the project's steps start from it
      const j = JOBS.find((x) => x.id === k.dataset.shjob), aspect = TYPES.find((t) => t.id === (j?.type || k.dataset.shtype))?.aspect;
      setPend(JOBKEY, j?.id || null);
      newProject();
      const r = document.querySelector(`form.np input[name="aspect"][value="${aspect}"]`); if (r) r.checked = true;
      if (j) toast(`${j.label}: make the project, bring the footage - the Agent opens with it filled in`);
    }
  };
}

// ---------------- 🎞 in a project ----------------
let busyFn = null, lib = null;
const loadMusic = () => (lib ||= api('GET', '/api/library/music').catch(() => []));
const isFootage = (m) => m.kind === 'video' || m.kind === 'image';
const hasFootage = () => S.media.some(isFootage);
const hasEdit = () => Object.values(S.project?.tracks || {}).some((t) => t.length);
const audioOf = (id) => (id && S.mediaById[id]?.kind === 'audio' ? S.mediaById[id] : null);
// the project's choices, with what came from Home (script) taken over once
const current = () => {
  const d = draft();
  if (!d.script && pending(SCRIPTKEY)) { d.script = pending(SCRIPTKEY); setDraft({ script: d.script }); setPend(SCRIPTKEY, null); }
  return { ...d, vo: audioOf(d.vo)?.id || null, music: audioOf(d.music)?.id || null };
};
const musicSelect = (d, tracks) => {
  const own = S.media.filter((m) => m.kind === 'audio' && m.id !== d.vo);
  return `<select class="small" data-shmusic aria-label="Music"><option value="">No music</option>
    ${tracks.length ? `<optgroup label="Ready-made music">${tracks.map((t) => `<option value="lib:${esc(t.name)}">${esc(t.title)}</option>`).join('')}</optgroup>` : ''}
    ${own.length ? `<optgroup label="In this project">${own.map((m) => `<option value="${m.id}"${m.id === d.music ? ' selected' : ''}>${esc(m.name)}${m.duration ? ` (${fmt(m.duration)})` : ''}</option>`).join('')}</optgroup>` : ''}</select>`;
};
const projectSteps = (tracks = []) => {
  const fo = hasFootage(), ed = hasEdit(), job = JOBS.find((j) => j.id === pendingJob()), d = current(), vo = audioOf(d.vo);
  const n = S.media.filter(isFootage).length;
  return `<ol class="sh-steps">
  ${step(1, 'Script', '', scriptLine(d.script), !!d.script)}
  ${step(2, 'Footage', `${fo ? `${n} clips in Media. More? + Folder again.` : 'Pick the raw folder - sub-folders too.'} Then what to make${job ? `: <b>${esc(job.label)}</b>` : ':'}`, `<button type="button" class="small" data-shfolder>+ Folder</button>${kindChips(job?.id)}`, fo)}
  ${step(3, 'Voice-over & music', '', `<div class="sh-row"><span class="sh-lbl">Voice</span>${vo ? `<span class="sh-pick" title="${esc(vo.name)}">${esc(vo.name)}${vo.duration ? ` · ${fmt(vo.duration)}` : ''}</span><button type="button" class="link small" data-shvox aria-label="No voice-over">✕</button>` : ''}<button type="button" class="small${vo ? '' : ' primary'}" data-shvogen>Generate voice…</button><label class="btn small">Upload VO<input type="file" accept="audio/*" hidden data-shvofile></label></div>
    <div class="sh-row"><span class="sh-lbl">Music</span>${musicSelect(d, tracks)}<button type="button" class="icon-btn small" data-shplay title="Listen" aria-label="Listen to the music">▶</button><label class="btn small">Upload<input type="file" accept="audio/*" hidden data-shmusicfile></label></div>`, !!(vo || d.music))}
  ${step(4, 'Let the Agent edit', 'Footage, script, voice and music go in - it makes the whole edit on the timeline.', `<button type="button" class="${fo && !ed ? 'primary ' : ''}small" data-shagent>Open the Agent</button>`, ed)}
  ${step(5, 'Check & export', 'Watch (Space), change things in the Assistant, then Export.', `<button type="button" class="small" data-shexport${ed ? '' : ' disabled'}>Export</button>`)}
</ol>`;
};

// every place the steps are shown right now (Media help, over the timeline, the Tools window) - drawn again together
const shown = new Set();
async function draw(box) {
  const tracks = await loadMusic();
  if (!box.isConnected) return shown.delete(box);
  $('.sh-steps', box)?.remove();
  const hd = box.querySelector('.sh-head');
  if (hd) hd.insertAdjacentHTML('afterend', projectSteps(tracks)); else box.insertAdjacentHTML('afterbegin', projectSteps(tracks));
  const sel = $('[data-shmusic]', box), d = current();
  if (sel && d.music) sel.value = d.music;
}
const redraw = () => [...shown].forEach(draw);

let player = null;
function listen(btn, src) {
  if (player && !player.paused) { player.pause(); $$('[data-shplay]').forEach((b) => (b.textContent = '▶')); if (player.dataset.src === src) return; }
  if (!src) return toast('Pick a track first', 'err');
  player = new Audio(src); player.dataset.src = src;
  player.play().catch(() => toast('Could not play this file', 'err'));
  btn.textContent = '❚❚'; player.onended = () => (btn.textContent = '▶');
}

// 🎙 step 3: the voice-over from the script - a small window: the voice (Microsoft Edge / ElevenLabs / a voice from a
// sample recording, cloned on this PC), speed, subtitles
function generateVoice(after) {
  const d = current();
  const body = h(`<div class="vo sh-gen">
    <label class="fld wide"><span>Script</span><input name="text" value="${esc(d.script || '')}" placeholder="Paste the script here…" spellcheck="false"><small data-info>${scriptInfo(d.script)}</small></label>
    <div data-picker></div>
    <div class="row-in" data-sample hidden><span class="muted small">No recording of the voice yet?</span><label class="btn small">Upload a voice sample<input type="file" accept="audio/*,video/*" hidden name="sample"></label></div>
    <label class="chk"><input type="checkbox" name="subs" checked> Subtitles from this voice-over</label>
    <div class="ag-foot"><span class="grow"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" data-go>Make the voice-over</button></div></div>`);
  const dlg = modal('Generate the voice-over', body, { width: 520 });
  const text = body.querySelector('[name="text"]');
  const pick = voicePicker(body.querySelector('[data-picker]'), { text: () => text.value, clone: true });
  const prov = body.querySelector('[name="provider"]'), sample = body.querySelector('[data-sample]');
  const showSample = () => { sample.hidden = prov.value !== 'clone'; };
  prov.addEventListener('change', showSample); showSample();
  body.querySelector('[name="sample"]').onchange = (e) => uploadAudioInto(e.target, body.querySelector('[name="ref"]'));
  let t0 = null;
  text.oninput = () => { body.querySelector('[data-info]').textContent = scriptInfo(text.value); clearTimeout(t0); t0 = setTimeout(pick.refit, 300); };
  body.querySelector('[data-go]').onclick = async () => {
    const v = pick(), words2 = text.value.trim();
    if (!words2) return toast('Paste the script first - the voice says it', 'err');
    if (v.provider === 'clone' ? !v.refMediaId : !v.voice) return toast(v.provider === 'clone' ? 'Pick (or upload) the recording whose voice should speak' : 'Choose a voice', 'err');
    setDraft({ script: words2 });
    dlg.close(); busyFn?.(true, 'Making the voice-over…');
    try {
      const job = await api('POST', `/api/tts?p=${enc(S.proj)}`, { ...v, text: words2, subtitles: body.querySelector('[name="subs"]').checked });
      const r = (await watchJob(job.id, () => {})).result;
      await refreshMedia();
      setDraft({ vo: r.mediaId });
      toast(`Voice-over ready (${fmt(r.duration)}) - the Agent will follow it`);
    } catch (err) { toast(err.message, 'err'); }
    finally { busyFn?.(false); after?.(); }
  };
}

async function onStepClick(e, after) {
  if (e.target.closest('[data-shhide]')) { setHidden(true); toast('Automation is hidden - Tools › Automation brings it back'); return refreshProjectStart(); }
  if (e.target.closest('[data-shguide]')) return openPromptGuide();
  if (e.target.closest('[data-shfolder]')) { after?.(); return document.querySelector('#poolBig [data-a="folder"], #pool [data-a="folder"]')?.click(); }
  if (e.target.closest('[data-shexport]')) { after?.(); return emit('gotoPage', 'deliver'); }
  if (e.target.closest('[data-shvogen]')) return generateVoice(redraw);
  if (e.target.closest('[data-shvox]')) { setDraft({ vo: null }); return redraw(); }
  const pl = e.target.closest('[data-shplay]');
  if (pl) {
    const v = pl.closest('.sh-step').querySelector('[data-shmusic]')?.value || '';
    return listen(pl, v.startsWith('lib:') ? `/api/library/music/file?name=${enc(v.slice(4))}` : S.mediaById[v]?.urls?.play);
  }
  const k = e.target.closest('[data-shjob], [data-shtype], [data-shagent]');
  if (!k) return;
  if (!hasFootage()) return toast('Bring the footage first (step 2: + Folder)', 'err');
  after?.();
  const job = k.dataset.shjob || (k.dataset.shagent !== undefined ? pendingJob() : null), d = current();
  setPend(JOBKEY, null); // (used now - it must not follow the editor into the next project)
  openAgent(busyFn, { ...(job ? { job } : { type: k.dataset.shtype || null }), vo: d.vo, music: d.music, script: d.script || '' });
}
async function onStepChange(e) {
  const t = e.target;
  if (t.matches('[data-shvofile]')) { const m = await uploadAudioInto(t, document.createElement('select')); if (m) { setDraft({ vo: m.id }); redraw(); } return; }
  if (t.matches('[data-shmusicfile]')) { const m = await uploadAudioInto(t, document.createElement('select')); if (m) { setDraft({ music: m.id }); redraw(); } return; }
  if (!t.matches('[data-shmusic]')) return;
  if (!t.value.startsWith('lib:')) { setDraft({ music: t.value || null }); return redraw(); }
  // a ready-made track: copied into this project's Media (bin "Music"), then chosen
  busyFn?.(true, 'Adding the music…');
  try { const m = await api('POST', `/api/library/music/use?p=${enc(S.proj)}`, { name: t.value.slice(4) }); await refreshMedia(); setDraft({ music: m.id }); toast(`${m.name} added - the Agent cuts on its beat`); }
  catch (err) { toast(err.message, 'err'); }
  finally { busyFn?.(false); redraw(); }
}
// one box of steps: typing the script is saved (and shown in the other boxes) without drawing them again
function bind(box, after) {
  box.addEventListener('click', (e) => onStepClick(e, after));
  box.addEventListener('change', onStepChange);
  box.addEventListener('input', (e) => {
    if (!e.target.matches('[data-shscript]')) return;
    setDraft({ script: e.target.value.trim() });
    for (const b of shown) { const i = $('[data-shscript]', b); if (i && i !== e.target) i.value = e.target.value; const s = $('[data-shscriptinfo]', b); if (s) s.textContent = scriptInfo(e.target.value); }
  });
  shown.add(box); draw(box);
  return box;
}
// the steps in the Media page's help and over the empty timeline, kept in step with the project
export function mountProjectStart(setBusy) {
  busyFn = setBusy;
  for (const ev of ['change', 'media', 'seq']) on(ev, () => refreshProjectStart());
}
let lastKey = '';
export function refreshProjectStart() {
  const show = !!S.project && !startHidden() && !hasEdit();
  const key = `${S.proj}|${show}|${hasFootage()}|${pendingJob()}|${S.media.length}`;
  if (key === lastKey && (!show || $('.sh-over'))) return;
  lastKey = key;
  const help = $('.media-help'), tl = $('#timeline');
  help?.querySelector('.sh')?.remove(); tl?.querySelector('.sh-over')?.remove();
  for (const b of shown) if (!b.isConnected || b.classList.contains('sh-media') || b.classList.contains('sh-over')) shown.delete(b);
  help?.classList.toggle('sh-keep', show); tl?.classList.toggle('sh-has', show);
  if (!show) return;
  const mk = (cls) => bind(h(`<section class="sh ${cls}">${head(TITLE)}</section>`));
  help?.prepend(mk('sh-media'));
  tl?.append(mk('sh-over'));
}
// Tools › Automation: the steps in a window (and shown again where they were, if they had been hidden)
export function openStartHere() {
  setHidden(false); lastKey = ''; refreshProjectStart();
  const body = h(`<div class="sh sh-dlg"><div class="dv-actions"><button type="button" class="link small" data-shguide>Prompt guide</button><span class="grow"></span><button data-close>Close</button></div></div>`);
  const dlg = modal(`Automation - ${TITLE.toLowerCase()}`, body, { width: 600, onClose: () => shown.delete(body) });
  bind(body, () => dlg.close());
}
