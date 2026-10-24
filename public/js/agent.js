// Agent: one window - say what the edit should be (Hindi / Hinglish / English), check the footage, voice-over and music,
// and the agent builds the whole edit on the timeline. Every setting is still there, in the Advanced drawer. Then a
// report shows which shot was chosen for which voice-over line (and flags weak matches).
import { ic } from './lineicons.js';
import { S, emit, commit, findClip, layout } from './store.js';
import { sequenceForAgent } from './sequences.js';
import { api, enc, watchJob } from './api.js';
import { fmt, clipDur, placeRefLooks, arrangeLayers } from './model.js';
import { $, $$, h, esc, toast, modal, progressClock } from './ui.js';
import { pickFolder, refreshMedia, uploadAudioInto } from './mediapool.js';
import { defaultFootage } from './footagepick.js';
import { openReels } from './reels.js';
import { openMulticam } from './multicam.js';
import { openVoiceOver } from './voiceover.js';
import { openScriptEdit, scriptPicker } from './scriptedit.js';
import { applyCinematic, stabilizeAll, setFilmLook } from './looks.js';
import { openPromptGuide } from './promptguide.js';

export const TYPES = [
  { id: 'song', icon: 'music', label: 'Song / music video', sub: 'cuts on the beat, pictures follow the lyrics', aspect: '16:9', pace: 'medium', target: 60, subtitles: false, editStyle: 'song', look: 'Warm Film' },
  { id: 'teaser', icon: 'clapper', label: 'Cinematic teaser', sub: 'movie-trailer cut on the music beat', aspect: '16:9', pace: 'fast', target: 45, subtitles: false, editStyle: 'teaser', look: 'Teal & Orange', cinematic: true },
  { id: 'reel', icon: 'phone', label: 'Reel / Short', sub: '15-60 s, fast cuts, captions', aspect: '9:16', pace: 'fast', target: 30, subtitles: true },
  { id: 'highlights', icon: 'star', label: 'Event highlights', sub: '1-3 min, music-led', aspect: '16:9', pace: 'medium', target: 90, subtitles: false },
  { id: 'film', icon: 'film', label: 'VO film / Documentary', sub: 'shots follow the voice-over', aspect: '16:9', pace: 'slow', target: 120, subtitles: true },
  { id: 'script', icon: 'doc', label: 'Edit from a script', sub: 'A/V script (Word/PDF) → timeline', aspect: '16:9', pace: 'medium', target: 60, subtitles: true },
  { id: 'autoreels', icon: 'scissors', label: 'Auto Reels', sub: 'best moments of a long talk → 9:16 reels', aspect: '9:16', pace: 'fast', target: 30, subtitles: true },
  { id: 'multicam', icon: 'video', label: 'Multicam', sub: '2-4 cameras synced by sound, auto angle switching', aspect: '16:9', pace: 'medium', target: 60, subtitles: false },
  { id: 'reference', icon: 'copy', label: 'Copy a reference', sub: 'cut like a video you like - only your footage is used', aspect: 'ref', pace: 'medium', target: 30, subtitles: false },
];

// Ready-made jobs: Limelight's common briefs as a starting point. Each one is one of the kinds above (TYPES) with its
// settings, a story outline to change and what to write where - nothing new under it, the window is just filled in.
// style: a learnt edit style (Library/styles) whose name matches is picked for it, when there is one.
export const JOBS = [
  { id: 'scheme', type: 'reel', icon: 'phone', label: 'Govt scheme reel', sub: '9:16 · 30 s · captions', look: 'Clean Natural', pace: 'medium', editStyle: 'standard', style: /scheme|yojana|govt|sarkar/i,
    outline: 'Logon ki mushkil - scheme se pehle\nScheme ka launch - CM sahab / Minister\nBeneficiaries ke chehre, khushi\nNumbers: kitne logon ko fayda\nCall to action - kaise judein', names: 'Scheme ka naam, CM / Minister ka naam, district…', endText: 'mygov.in',
    hint: 'Add the voice-over if there is one, and the scheme / CM names (Advanced, Titles).' },
  { id: 'event', type: 'highlights', icon: 'star', label: 'Event highlight', sub: '16:9 · 90 s · music-led', look: 'Warm Film', transitions: 'cinematic', style: /event|highlight/i,
    outline: 'Venue and arrival\nChief guest arrives, welcome\nLamp lighting / inauguration\nSpeeches - the best lines\nCrowd, performances\nGroup photo, ending', names: 'Event name, chief guest, venue…',
    hint: 'Pick the music; the agent uses its best part and cuts on the beat.' },
  { id: 'vodoc', type: 'film', icon: 'film', label: 'VO documentary', sub: '16:9 · follows the VO · subtitles', look: 'Indian Heritage', transitions: 'cinematic', style: /doc|film|vo/i,
    names: 'Names, places, scheme names - as they must be spelt', hint: 'The voice-over decides the length and the shots. A script (Word / PDF, Advanced) gives exact spellings.' },
  { id: 'lyric', type: 'song', icon: 'music', label: 'Lyric / song edit', sub: 'beat cuts · lyrics on screen', lyricsOnScreen: true, style: /song|lyric/i,
    hint: 'Choose the song as Music and paste the lyrics (Advanced) for exact spellings.' },
];

const ASPECTS = [['9:16', '9:16 Reel'], ['16:9', '16:9 Film'], ['1:1', '1:1 Square'], ['4:5', '4:5 Feed']];
const lenLabel = (s) => (+s < 60 ? `${+s} s` : `${+(s / 60).toFixed(1)} min`);
// kinds that open their own window instead of editing here
const OPENS = { autoreels: 'Next: pick the long video', script: 'Next: open the script', multicam: 'Next: choose the cameras' };

/* ---------- the brief kit: shared by the Agent and Re-edit windows ---------- */

// endpoints the server does not have yet (404): not asked again on this page, the window works with its own fields
const missing = { parse: false, plan: false };
async function post(path, body) {
  const r = await fetch(`${path}?p=${enc(S.proj)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: S.proj, ...body }) });
  if (r.status === 404) { const e = new Error('not there'); e.missing = true; throw e; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// A small menu under a chip (Format / Length / Style): items [[value, label, sub?]]
export function chipMenu(anchor, items, cur, onPick) {
  const dlg = anchor.closest('dialog'); if (!dlg) return;
  const had = dlg.querySelector('.ag2-menu'); had?.remove();
  if (had?.dataset.for === anchor.dataset.chip) return; // a second click closes it
  const m = h(`<div class="ag2-menu" role="menu" data-for="${esc(anchor.dataset.chip)}">${items.map(([v, l, sub]) => `<button type="button" role="menuitemradio" aria-checked="${String(v) === String(cur)}" data-v="${esc(v)}"><span>${esc(l)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`).join('')}</div>`);
  dlg.append(m);
  // (the dialog has a backdrop blur, so it is the box fixed / absolute children are placed in)
  const a = anchor.getBoundingClientRect(), d = dlg.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(a.left - d.left, d.width - m.offsetWidth - 8))}px`;
  // below the chip, or above it when there is more room there (the dialog clips what goes past its edge)
  const below = d.bottom - a.bottom - 14, above = a.top - d.top - 14, up = m.offsetHeight > below && above > below;
  m.style.maxHeight = `${Math.max(120, up ? above : below)}px`;
  m.style.top = `${up ? a.top - d.top - 6 - Math.min(m.offsetHeight, above) : a.bottom - d.top + 6}px`;
  const off = (e) => { if (e.type === 'keydown' && e.key !== 'Escape') return; if (e.type === 'keydown') e.preventDefault(); if (e.type !== 'pointerdown' || !m.contains(e.target)) close(); };
  const close = () => { m.remove(); document.removeEventListener('pointerdown', off, true); dlg.removeEventListener('keydown', off, true); dlg.querySelector('.dlg-body')?.removeEventListener('scroll', close); };
  setTimeout(() => { document.addEventListener('pointerdown', off, true); dlg.addEventListener('keydown', off, true); dlg.querySelector('.dlg-body')?.addEventListener('scroll', close); });
  m.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; close(); onPick(b.dataset.v); });
  m.querySelector('[aria-checked="true"]')?.focus();
}

// The words box: as you type (0.5 s after the last key) the server reads it (POST /api/agent/parse) and the window shows
// what it understood, puts the settings it asked for into the fields and keeps its constraints for the run.
// What an earlier reading set and the words no longer ask for goes back to what it was; a field changed by hand is
// never overwritten. hooks[key] = { get, set } for settings that are not one plain field (the kind of edit).
export function wireBrief(body, { box, mode, opts, hooks = {}, onResult = () => {} }) {
  const k = { parsed: null, extra: {}, auto: new Map(), manual: new Set(), applying: false };
  const field = (n) => body.querySelector(`[name="${n}"]:not([type=radio]):not([type=file])`);
  const get = (n) => { if (hooks[n]) return String(hooks[n].get()); const el = field(n); return !el ? undefined : el.type === 'checkbox' ? String(el.checked) : el.value; };
  const put = (n, v) => {
    if (hooks[n]) { hooks[n].set(v); return true; }
    const el = field(n); if (!el || el.disabled) return false;
    if (el.type === 'checkbox') el.checked = v === true || v === 'true';
    else if (el.tagName === 'SELECT') {
      if (![...el.options].some((o) => o.value === String(v))) { if (n !== 'target' || !(+v > 0)) return false; el.add(new Option(lenLabel(v), String(+v))); }
      el.value = String(v);
    } else el.value = String(v ?? '');
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const NEVER = new Set(['clips', 'styleDefault', 'footage']);
  k.apply = (r) => {
    const want = r?.opts || {};
    k.applying = true;
    try {
      // what the last reading set and this one does not ask for: back to how it was
      for (const [n, a] of [...k.auto]) if (!(n in want)) { if (get(n) === a.now) put(n, a.was); k.auto.delete(n); }
      k.extra = {};
      // the kind first, then the edit style: they bring their own defaults, which the other settings then change
      const rank = (n) => (hooks[n] ? 0 : n === 'editStyle' ? 1 : 2), keys = Object.keys(want).sort((x, y) => rank(x) - rank(y));
      for (const n of keys) {
        if (NEVER.has(n) || k.manual.has(n)) continue;
        const v = want[n], was = k.auto.get(n)?.was ?? get(n);
        if (was === undefined) { k.extra[n] = v; continue; } // a setting with no field here: sent as it is
        if (put(n, v)) k.auto.set(n, { was, now: get(n) });
      }
    } finally { k.applying = false; }
  };
  // a change by hand: that setting is the user's now
  body.addEventListener('change', (e) => { if (!k.applying && e.target.name && e.target.name !== box.name) { k.manual.add(e.target.name); k.auto.delete(e.target.name); } });
  let timer = 0, seq = 0;
  const read = async () => {
    const text = box.value.trim(), my = ++seq;
    if (!text) { k.parsed = null; k.apply(null); return onResult(null); }
    if (missing.parse) return onResult(k.parsed);
    try {
      const r = await post('/api/agent/parse', { text, mode, opts: opts() });
      if (my !== seq) return;
      k.parsed = r; k.apply(r); onResult(r);
    } catch (e) {
      if (e.missing) { missing.parse = true; return onResult(null); }
      if (my === seq) onResult(k.parsed, e);
    }
  };
  box.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(read, 500); });
  k.read = read; k.byHand = (n) => { k.manual.add(n); k.auto.delete(n); };
  k.isAuto = (n) => k.auto.has(n);
  k.flush = async () => { if (timer) { clearTimeout(timer); timer = 0; if (box.value.trim() && !missing.parse) await read(); } };
  return k;
}

// What was understood, as small pills under the box (and what the parser could not use, quieter)
export function understoodHTML(r, err) {
  if (err) return `<span class="ag2-pill off">Could not read the words: ${esc(err.message)}</span>`;
  if (!r) return '';
  const u = (r.understood || []).map((s) => `<span class="ag2-pill">${ic('check')}${esc(s)}</span>`).join('');
  const n = (r.notes || []).map((s) => `<span class="ag2-pill off" title="Not turned into a setting - Claude reads it">${esc(s)}</span>`).join('');
  return u + n;
}

// The chips row: [{ key, label, items(), get(), set(v), text(), disabled?() }]
export function chipsHTML(chips, kit) {
  return chips.map((c) => {
    const off = c.disabled?.();
    return `<button type="button" class="ag2-chip${kit?.isAuto(c.key) ? ' auto' : ''}" data-chip="${c.key}"${off ? ` disabled title="${esc(off)}"` : ''}><small>${esc(c.label)}</small><b>${esc(c.text())}</b>${off ? '' : ic('down')}</button>`;
  }).join('');
}

// Plan: a quick outline of the edit before it is made (acts in proportion to time, the lines under each, length,
// shots, music bpm, warnings). The button goes away when the server has no planner.
export async function showPlan(el, btn, opts) {
  if (missing.plan) { btn.hidden = true; return; }
  el.hidden = false; el.innerHTML = '<div class="ag2-plan-wait"><span class="ag2-spin"></span>Planning the edit…</div>';
  btn.disabled = true;
  try {
    const r = await post('/api/agent/plan', { opts });
    el.innerHTML = planHTML(r, opts);
  } catch (e) {
    if (e.missing) { missing.plan = true; btn.hidden = true; el.hidden = true; el.innerHTML = ''; return; }
    el.innerHTML = `<p class="ag2-calm">${ic('warn')} The plan could not be made: ${esc(e.message)}</p>`;
  } finally { btn.disabled = false; }
}
const count = (x) => (Array.isArray(x) ? x.length : +x || 0);
// timeline time as m:ss (a tenth when it has one): 0:10, 1:02.5
export const tc = (sec) => {
  const t = Math.round(Math.max(0, +sec || 0) * 10) / 10, m = Math.floor(t / 60), x = Math.round((t - m * 60) * 10) / 10;
  return `${m}:${x < 10 ? '0' : ''}${Number.isInteger(x) ? x : x.toFixed(1)}`;
};
// a re-edit limited to part of the edit (constraints.scope), in words; '' for the whole edit
export function scopeText(sc) {
  if (sc?.kind === 'range') return `Only ${tc(sc.from)} - ${tc(sc.to)} changes`;
  if (sc?.kind === 'clips') { const n = sc.ids?.length || 0; return n === 1 ? 'Only the selected clip changes' : `Only the ${n} selected clips change`; }
  if (sc?.kind === 'slots') { const n = (sc.index || []).map((i) => i + 1); return `Only shot${n.length > 1 ? 's' : ''} ${n.join(', ')} change${n.length > 1 ? '' : 's'}`; }
  return '';
}
function planHTML(r, opts) {
  const acts = r.acts || [], dur = +r.duration || acts.reduce((s, a) => Math.max(s, +a.end || 0), 0) || 1;
  const sc = r.scope || opts?.constraints?.scope, scText = scopeText(sc);
  // the time range that changes, as a band over the acts (the rest stays as it is)
  const band = sc?.kind === 'range' && dur ? `<span class="ag2-band" style="left:${Math.max(0, (sc.from / dur) * 100).toFixed(2)}%;width:${Math.max(0.5, ((Math.min(dur, sc.to) - sc.from) / dur) * 100).toFixed(2)}%"></span>` : '';
  const shots = r.slots !== undefined ? count(r.slots) : acts.reduce((s, a) => s + count(a.shots), 0);
  const facts = [dur ? `<span><b>${fmt(dur)}</b> long</span>` : '', shots ? `<span><b>${shots}</b> shots</span>` : '', acts.length ? `<span><b>${acts.length}</b> acts</span>` : '',
    r.music ? `<span>${ic('music')}${esc(r.music.name || 'Music')}${r.music.bpm ? ` · <b>${Math.round(r.music.bpm)}</b> bpm` : ''}</span>` : '',
    r.vo ? `<span>${ic('mic')}<b>${count(r.vo.lines)}</b> voice-over lines</span>` : ''].filter(Boolean).join('');
  const act = (a, i) => {
    const len = Math.max(0.1, (+a.end || 0) - (+a.start || 0)), lines = (a.lines || []).filter(Boolean);
    return `<div class="ag2-act" style="flex:${(len / dur).toFixed(4)} 1 0">
      <div class="ag2-act-bar a${i % 4}"><b>${esc(a.label || `Act ${i + 1}`)}</b><small>${fmt(+a.start || 0)} · ${count(a.shots) ? `${count(a.shots)} shots` : fmt(len)}</small></div>
      ${lines.length ? `<ul>${lines.slice(0, 4).map((l) => `<li>${esc(l)}</li>`).join('')}${lines.length > 4 ? `<li class="more">+ ${lines.length - 4} more</li>` : ''}</ul>` : ''}</div>`;
  };
  return `<div class="ag2-plan-h"><b>Plan</b><div class="ag2-facts">${facts}</div><button type="button" class="link small" data-a="planclose">Hide</button></div>
    ${acts.length ? `<div class="ag2-acts">${band}${acts.map(act).join('')}</div>` : ''}
    ${scText ? `<p class="ag2-calm ag2-scope-note">${ic('target')}${esc(scText)} - everything else stays as it is.</p>` : ''}
    ${r.pending ? `<p class="ag2-calm">${ic('clock')}${esc(r.pending)}</p>` : ''}
    ${r.warnings?.length ? `<ul class="ag2-warns">${r.warnings.map((w) => `<li>${ic('warn')}${esc(w)}</li>`).join('')}</ul>` : ''}`;
}

/* ---------- the Agent window (a new edit) ---------- */

export function openAgent(setBusy, { job = null, type = null } = {}) {
  // the footage to start from: what is selected in Media (or its open folder), else the footage without logos, rejects,
  // bad clips and copies (footagepick.js) - not every file of the project
  const pre = defaultFootage();
  const st = { type: type || 'reel', clips: new Set(pre.ids), job: null, pick: false };
  const audioOpts = (none) => `<option value="">${none}</option>${S.media.filter((m) => m.kind === 'audio').map((m) => `<option value="${m.id}">${esc(m.name)} (${fmt(m.duration)})</option>`).join('')}`;
  const body = h(`<div class="ag ag2">
    <section class="ag2-hero">
      <label class="ag2-q" for="ag2Ask">What should the edit be?</label>
      <textarea id="ag2Ask" name="ask" rows="3" placeholder="e.g. 30 sec ka reel banao, tez cuts, pehle CM sahab ka shot, end mein logo" spellcheck="false"></textarea>
      <div class="ag2-understood" data-understood aria-live="polite"></div>
      <div class="ag2-chips" data-chips></div>
      <div class="ag-jobs ag2-jobs"><span class="pg-g">Ready-made</span>${JOBS.map((j) => `<button type="button" class="chip" data-job="${j.id}" title="${esc(`${j.sub} - ${j.hint}`)}">${ic(j.icon)}${esc(j.label)}</button>`).join('')}<span class="grow"></span><button type="button" class="link small" data-a="guide">Prompt guide & tips</button></div>
      <small class="ag-jobhint" data-jobhint hidden></small>
    </section>
    <section class="ag2-inputs">
      <div class="ag2-in" data-in="footage"><div class="ag2-in-h">${ic('film')}<b>Footage</b><span class="grow"></span><span class="ag2-count" data-fcount></span></div>
        <div class="row-in"><button type="button" class="btn small grow" data-a="pick">Choose clips</button><button type="button" class="btn small" data-a="addFolder" title="Import a folder of footage">${ic('folder')}</button></div>
        <small class="ag2-in-why" data-fwhy></small></div>
      <div class="ag2-in" data-in="vo"><div class="ag2-in-h">${ic('mic')}<b>Voice-over</b><span class="grow"></span><small>shots follow what is said</small></div>
        <div class="row-in"><select name="vo" aria-label="Voice-over">${audioOpts('No voice-over')}</select><label class="btn small" title="Upload a voice-over">${ic('upload')}<input type="file" accept="audio/*,video/*" hidden name="voFile"></label><button type="button" class="btn small" data-a="aivo" title="Make an AI voice-over">${ic('sparkle')}</button></div></div>
      <div class="ag2-in" data-in="music"><div class="ag2-in-h">${ic('music')}<b>Music</b><span class="grow"></span><small>the beat sets the cuts</small></div>
        <div class="row-in"><select name="music" aria-label="Music">${audioOpts('No music')}</select><label class="btn small" title="Upload music">${ic('upload')}<input type="file" accept="audio/*" hidden name="musicFile"></label></div></div>
      <div class="ag2-in wide" data-in="ref" data-ref hidden><div class="ag2-in-h">${ic('copy')}<b>Reference video</b><span class="grow"></span><small>the edit to copy - its shots are never used</small></div>
        <div class="row-in"><select name="reference" aria-label="Reference video"><option value="">Choose…</option>${S.media.filter((m) => m.kind === 'video').map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select><label class="btn small" title="A reel / video you downloaded: it is added to the project and picked here">Upload<input type="file" accept="video/*,.mxf,.mts" hidden name="refFile"></label></div></div>
    </section>
    <section class="ag2-pick" data-pickbox hidden>
      <div class="ag-pickbar">
        <input type="search" data-q placeholder="Search clips…" aria-label="Search clips">
        <div class="ag-kinds" role="group" aria-label="Show"><button type="button" class="chip on" data-kind="">All</button><button type="button" class="chip" data-kind="video">Video</button><button type="button" class="chip" data-kind="image">Photos</button></div>
        <span class="grow"></span><span class="ag-count" data-count></span>
      </div>
      <div class="ag-pickbar2"><button type="button" class="small" data-a="all">Select all shown</button><button type="button" class="small" data-a="none">Clear</button><button type="button" class="small" data-a="openall">Open all folders</button><span class="grow"></span><button type="button" class="small" data-a="addFolder">Import a folder</button><button type="button" class="small primary" data-a="pick">Done</button></div>
      <div class="ag-clips" data-clips></div>
      <small class="ag-why" data-why></small>
      <small class="muted">The agent uses ONLY the ticked clips, skips blurry / dark / shaky moments and never uses the same moment twice.</small>
    </section>
    <section class="ag2-plan" data-plan hidden></section>
    <details class="ag2-adv"><summary><b>Advanced</b><small data-advsum></small></summary>
      <div class="re-sections">
        <section class="re-card"><header class="re-card-h"><b>Kind of edit</b><small>Each kind brings its own format, pace and look</small></header>
          <div class="ag-types">${TYPES.map((t) => `<label class="ag-type"><input type="radio" name="type" value="${t.id}"${t.id === st.type ? ' checked' : ''}><span><b>${t.label}</b><small>${t.sub}</small></span></label>`).join('')}</div></section>
        <section class="re-card"><header class="re-card-h"><b>Cut &amp; format</b><small>Style, pace and size of the edit</small></header><div class="fgrid">
          <label class="fld"><span>Format</span><select name="aspect"><option value="ref" data-refonly>Same as the reference</option><option value="9:16">9:16 Reel / Shorts</option><option value="16:9">16:9 YouTube / Film</option><option value="1:1">1:1 Square</option><option value="4:5">4:5 Feed</option></select></label>
          <label class="fld"><span>Clip speed</span><select name="clipSpeed"><option value="0.5">0.5x slow motion</option><option value="0.75">0.75x gentle slow-mo</option><option value="1" selected>1x normal</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x fast</option></select></label>
          <label class="fld"><span>Edit style</span><select name="editStyle"><option value="standard">Standard</option><option value="teaser">Cinematic teaser (trailer: slow open, build, fast climax)</option><option value="montage">Fast montage (cut on every beat)</option><option value="song">Song / music video (beat + lyrics)</option></select></label>
          <label class="fld"><span>Pace</span><select name="pace"><option value="fast">Fast cuts (~1.7 s)</option><option value="medium">Medium (~2.8 s)</option><option value="slow">Slow, cinematic (~4 s)</option></select></label>
          <label class="fld" data-novo><span>Length (when there is no voice-over)</span><select name="target">${[15, 30, 45, 60, 90, 120, 180, 300].map((s) => `<option value="${s}">${lenLabel(s)}</option>`).join('')}</select></label>
          <label class="fld"><span>Transitions</span><select name="style"><option value="cuts">Clean cuts</option><option value="cinematic">Dissolves between ideas</option></select></label>
          <div class="fld wide"><span>Cut like (a style learnt from an edit you liked)</span>
            <div class="row-in"><select name="styleName"><option value="none">The agent's own way</option></select>
              <button type="button" class="btn small" data-a="learnStyle" title="Learn how the edit on this timeline is cut (shot length, moves, colour, cuts, lyric titles) - it becomes the default, so new edits are cut the same way">Learn from this timeline…</button>
              <label class="chk"><input type="checkbox" name="styleDefault"> Default for every edit</label></div>
            <small class="muted" data-stylesum></small></div>
        </div></section>
        <section class="re-card"><header class="re-card-h"><b>Voice &amp; script</b><small>How the voice-over is heard</small></header><div class="fgrid" data-voice>
          <label class="fld"><span>VO language</span><select name="voLang"><option value="hi">Hindi</option><option value="en">English</option><option value="auto">Auto-detect</option></select></label>
          <label class="fld"><span>Listening accuracy</span><select name="whisperModel"><option value="small">Fast</option><option value="medium">Good</option><option value="large-v3-turbo" selected>Best</option></select></label>
        </div></section>
        <section class="re-card"><header class="re-card-h"><b>Music &amp; story</b><small>The beat, the song and the order of ideas</small></header><div class="fgrid">
          <label class="chk"><input type="checkbox" name="musicBest" checked> Use the best part of the music, cut on the beat</label>
          <label class="chk"><input type="checkbox" name="keepSound"> Keep some of the clips' own sound (ambience)</label>
          <div class="fld wide ag-song" data-song hidden>
            <span>Song: the music is the song. The agent hears its beat, bars, verses / chorus and the sung words.</span>
            <div class="row-in"><label class="fld"><span>Use</span><select name="songPart"><option value="full">The whole song</option><option value="best">Its best part (the length above)</option></select></label>
              <label class="chk"><input type="checkbox" name="lyricsOnScreen"> Show the lyrics on screen (word by word)</label></div>
            <label class="fld wide"><span>Lyrics (optional - paste them for exact spellings; the timing comes from the song)</span>
              <textarea name="lyrics" rows="5" placeholder="एक सपना है आँखों में, एक उम्मीद है साँसों में&#10;हर घर में फिर हँसी खिले…"></textarea></label>
            <small class="muted">Every cut lands on a beat; chorus cuts faster, verses and calm parts slower; a new sung line gets a new picture that matches its meaning.</small>
          </div>
          <label class="fld wide" data-outline><span>Story outline (optional, used when there is no voice-over) - one idea per line</span>
            <textarea name="outline" rows="4" placeholder="Waterfall and forest&#10;Temple and prayers&#10;Local market, food&#10;People dancing, celebration&#10;Sunset"></textarea></label>
        </div></section>
        <section class="re-card"><header class="re-card-h"><b>Look &amp; finish</b><small>Colour, steadiness and effects</small></header><div class="fgrid">
          <label class="fld"><span>Film look (colour of the whole edit)</span><select name="look"><option value="">None (just balanced)</option><option selected>Teal & Orange</option><option>Warm Film</option><option>Golden Hour</option><option>Moody Dark</option><option>Travel Vivid</option><option>Indian Heritage</option><option>Bleach Bypass</option><option>Clean Natural</option></select></label>
          <label class="chk"><input type="checkbox" name="autoColor" checked> Auto colour every shot</label>
          <label class="chk"><input type="checkbox" name="detectLog" checked> Detect LOG footage and add a LUT</label>
          <label class="chk"><input type="checkbox" name="stabilize"> Stabilize shaky shots (slower render)</label>
          <label class="chk"><input type="checkbox" name="cinematic"> Cinematic finish (film grade, bars, vignette, grain)</label>
          <label class="chk"><input type="checkbox" name="fx" checked> Teaser effects (light leaks, whip, flash, shake on the cuts - teaser / montage styles)</label>
          <label class="chk"><input type="checkbox" name="sfx" checked> Sound design (whooshes, hits, a riser into the drop - teaser / montage styles)</label>
        </div></section>
        <section class="re-card"><header class="re-card-h"><b>Titles</b><small>Words on the screen</small></header><div class="fgrid">
          <label class="chk"><input type="checkbox" name="subtitles"> Subtitles from the voice-over</label>
          <label class="fld"><span>Title on the first shot</span><input name="title" placeholder="optional"></label>
          <label class="fld"><span>End card</span><input name="endText" placeholder="e.g. mybharat.gov.in"></label>
          <label class="fld wide"><span>Names & spellings (helps the subtitles)</span><input name="names" placeholder="MY Bharat, Viksit Bharat, Chhattisgarh, speaker names…"></label>
        </div></section>
      </div>
      <p class="muted small ag2-foot-note">The agent replaces V1 (main story), V2 titles, A1 voice-over and A2 music. Your logo and A3 sound effects stay. Ctrl+Z undoes it.</p>
    </details>
    <div class="ag-foot ag2-foot"><button type="button" data-a="plan" title="See the outline of the edit before it is made">${ic('chart')}Plan</button><span class="grow"></span><button type="button" data-close>Cancel</button>
      <button type="button" data-a="claude" title="Claude makes the edit the way it edits in this folder: it looks at the footage, plans a story and checks its own work (slower)">${ic('sparkle')}Polish with Claude</button>
      <button type="button" class="primary" data-a="make" title="The built-in agent on this PC">Make the edit</button></div>
  </div>`);
  const dlg = modal('Agent', body, { width: 980 });
  const f = (n) => body.querySelector(`[name="${n}"]`);
  // saved styles (Library/styles): the default one is chosen already
  const styles = { list: [], def: null };
  const fillStyles = async (select = null) => {
    try { const r = await api('GET', '/api/styles'); styles.list = r.styles; styles.def = r.default; } catch {}
    f('styleName').innerHTML = `<option value="none">The agent's own way</option>${styles.list.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('')}`;
    f('styleName').value = select || (styles.def && styles.list.some((x) => x.name === styles.def) ? styles.def : 'none');
    showStyle();
  };
  const showStyle = () => {
    const x = styles.list.find((s) => s.name === f('styleName').value);
    body.querySelector('[data-stylesum]').textContent = x ? `${x.summary}${x.from ? ` - learnt from "${x.from}"` : ''}` : 'Pace, effects and look come from the settings below.';
    f('styleDefault').checked = !!x && styles.def === x.name;
  };
  const stylesIn = fillStyles();
  const scr = { scenes: null }; // optional script: exact caption spellings + visual notes for shot choice
  body.querySelector('[data-voice]').append(scriptPicker(scr));
  f('voFile').onchange = (e) => uploadAudioInto(e.target, f('vo'));
  f('musicFile').onchange = (e) => uploadAudioInto(e.target, f('music'));
  f('refFile').onchange = (e) => { toast('Uploading the reference…'); uploadAudioInto(e.target, f('reference')); }; // (any video file: it is read like a sound file is)

  const applyType = () => {
    const t = TYPES.find((x) => x.id === st.type);
    f('aspect').value = t.aspect; f('pace').value = t.pace; f('target').value = t.target; f('subtitles').checked = t.subtitles;
    f('editStyle').value = t.editStyle || (t.id === 'reel' ? 'montage' : 'standard'); f('cinematic').checked = !!t.cinematic; if (t.look) f('look').value = t.look;
  };
  const setType = (id) => {
    if (!TYPES.some((t) => t.id === id)) return;
    st.type = id; const r = body.querySelector(`[name="type"][value="${id}"]`); if (r) r.checked = true;
    applyType(); if (JOBS.find((x) => x.id === st.job)?.type !== st.type) applyJob(null); show();
  };
  const pickLearnt = () => {
    const j = JOBS.find((x) => x.id === st.job), learnt = j?.style && styles.list.find((x) => j.style.test(x.name));
    if (learnt) { f('styleName').value = learnt.name; showStyle(); }
  };
  // a ready-made job: its kind, then its own settings; the outline / end card it brings replace only what it brought
  const applyJob = (id) => {
    const j = JOBS.find((x) => x.id === id), was = JOBS.find((x) => x.id === st.job);
    st.job = j ? j.id : null;
    if (j) {
      st.type = j.type; body.querySelector(`[name="type"][value="${j.type}"]`).checked = true; applyType();
      if (j.look) f('look').value = j.look;
      if (j.pace) f('pace').value = j.pace;
      if (j.editStyle) f('editStyle').value = j.editStyle;
      f('style').value = j.transitions || 'cuts';
      if (!f('outline').value.trim() || f('outline').value === was?.outline) f('outline').value = j.outline || '';
      if (!f('endText').value.trim() || f('endText').value === was?.endText) f('endText').value = j.endText || '';
      f('names').placeholder = j.names || 'MY Bharat, Viksit Bharat, Chhattisgarh, speaker names…';
      f('lyricsOnScreen').checked = !!j.lyricsOnScreen;
      pickLearnt();
    }
    $$('[data-job]', body).forEach((b) => b.classList.toggle('on', b.dataset.job === st.job));
    const hint = body.querySelector('[data-jobhint]');
    hint.hidden = !j; hint.textContent = j ? `${j.label}: ${j.sub}. ${j.hint}` : '';
    show();
  };

  // the clip picker: folders as rows that open (short names), big thumbnails, search + Video / Photos, a clear count
  const pick = { q: '', kind: '', open: new Set() };
  const usable = () => S.media.filter((m) => (m.kind === 'video' || m.kind === 'image') && m.status === 'ready');
  const shown = () => usable().filter((m) => (!pick.kind || m.kind === pick.kind) && (!pick.q || `${m.name} ${m.bin || ''}`.toLowerCase().includes(pick.q)));
  const shortBin = (b) => { const parts = String(b || 'Other').split(/[\\/]/).filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/') || 'Other'; };
  const countLine = () => {
    const all = usable().length;
    body.querySelector('[data-count]').innerHTML = `<b>${st.clips.size}</b> of ${all} selected`;
    body.querySelector('[data-fcount]').innerHTML = `<b>${st.clips.size}</b> of ${all} clips`;
    body.querySelector('[data-in="footage"]').classList.toggle('bad', !st.clips.size);
  };
  // why these clips are ticked - and what was left out, with the reason (tick it to use it anyway)
  const why = pre.from === 'selection' ? `Ticked: the <b>${pre.ids.length}</b> file${pre.ids.length > 1 ? 's' : ''} selected in Media.`
    : `${pre.from === 'folder' ? 'Ticked: the open Media folder. ' : ''}${pre.left.length ? `Left out: <b>${pre.left.length}</b> - ${esc([...new Set(pre.left.map((x) => x.why.replace(/^flagged: .*/, 'flagged bad').replace(/^in the .*/, 'Rejects / Duplicates / Brand folders')))].join(', '))} (tick any to use it).` : ''} Tip: select clips in Media first and only those are used.`;
  body.querySelector('[data-why]').innerHTML = why;
  body.querySelector('[data-fwhy]').innerHTML = pre.from === 'selection' ? 'the clips selected in Media' : pre.from === 'folder' ? 'the open Media folder' : pre.left.length ? `${pre.left.length} left out (logos, rejects, bad clips)` : 'all the project\'s footage';
  const renderClips = () => {
    const bins = {};
    shown().forEach((m) => (bins[m.bin || 'Other'] ||= []).push(m));
    const names = Object.keys(bins);
    // open: a folder that has chosen clips, the only folder, every folder while searching, or one opened by hand
    const isOpen = (b) => pick.open.has(b) || names.length === 1 || !!pick.q || (names.length <= 3 && bins[b].some((m) => st.clips.has(m.id)));
    const box = body.querySelector('[data-clips]'), keep = box.scrollTop; // (ticking a clip redraws the list where it was)
    box.innerHTML = names.map((b) => {
      const list = bins[b], sel = list.filter((m) => st.clips.has(m.id)).length;
      return `<details class="ag-bin"${isOpen(b) ? ' open' : ''} data-binrow="${esc(b)}"><summary title="${esc(b)}">
          <input type="checkbox" data-bin="${esc(b)}"${sel === list.length ? ' checked' : ''}${sel && sel < list.length ? ' data-mixed' : ''} aria-label="Select the whole folder">
          <span class="ag-bname">${esc(shortBin(b))}</span><span class="ag-bmeta">${list.length} clip${list.length > 1 ? 's' : ''}${sel ? ` · <b>${sel} selected</b>` : ''}</span></summary>
        <div class="ag-tiles">${list.map((m) => `<label class="ag-tile${st.clips.has(m.id) ? ' on' : ''}" title="${esc(m.name)}"><input type="checkbox" value="${m.id}"${st.clips.has(m.id) ? ' checked' : ''}>
          <span class="ag-th">${m.urls.thumb ? `<img src="${m.urls.thumb}" alt="" loading="lazy">` : `<i>${m.kind === 'image' ? ic('image') : ic('film')}</i>`}${m.kind === 'video' && m.duration ? `<em>${fmt(m.duration)}</em>` : ''}<b class="ag-tick">${ic('check')}</b></span>
          <span class="ag-tn">${esc(m.name)}</span></label>`).join('')}</div></details>`;
    }).join('') || (usable().length ? '<div class="muted pad">Nothing matches - clear the search.</div>' : '<div class="muted pad">No footage yet - use "Import a folder".</div>');
    body.querySelectorAll('[data-mixed]').forEach((x) => { x.indeterminate = true; });
    box.scrollTop = keep;
    countLine();
  };
  body.querySelector('[data-q]').addEventListener('input', (e) => { pick.q = e.target.value.trim().toLowerCase(); renderClips(); });
  body.querySelector('[data-clips]').addEventListener('toggle', (e) => { const b = e.target.dataset?.binrow; if (b === undefined) return; if (e.target.open) pick.open.add(b); else pick.open.delete(b); }, true);
  // the folder checkbox sits in the row: ticking it must not open / close the row
  body.querySelector('[data-clips]').addEventListener('click', (e) => { if (e.target.matches('summary input[data-bin]')) e.stopPropagation(); }, true);
  const openPick = (on = !st.pick) => {
    st.pick = on; body.querySelector('[data-pickbox]').hidden = !on;
    body.querySelector('[data-in="footage"] [data-a="pick"]').textContent = on ? 'Hide the clips' : 'Choose clips';
    if (on) { renderClips(); body.querySelector('[data-pickbox]').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  };

  // the words box, read as you type; its settings go into the fields (and the chips)
  const box = f('ask');
  const kit = wireBrief(body, {
    box, mode: 'new', opts: () => opts(),
    hooks: { type: { get: () => st.type, set: (v) => setType(v) } },
    onResult: (r, err) => { body.querySelector('[data-understood]').innerHTML = understoodHTML(r, err); show(); },
  });
  // the kind follows a song / teaser the words asked for (the edit style alone would leave a reel's 9:16 and captions)
  const typeOf = { song: 'song', teaser: 'teaser' };
  body.addEventListener('change', (e) => {
    if (kit.applying && e.target.name === 'editStyle' && typeOf[e.target.value] && !kit.manual.has('type') && st.type !== typeOf[e.target.value]) {
      const v = e.target.value, was = st.type;
      setType(typeOf[v]); f('editStyle').value = v;
      if (!kit.auto.has('type')) kit.auto.set('type', { was, now: st.type }); // (goes back with the words that asked for it)
    }
  });
  const CHIPS = [
    { key: 'aspect', label: 'Format', items: () => [...(st.type === 'reference' ? [['ref', 'Same as the reference']] : []), ...ASPECTS], get: () => f('aspect').value,
      text: () => (f('aspect').value === 'ref' ? 'Like the reference' : ASPECTS.find(([v]) => v === f('aspect').value)?.[1] || f('aspect').value) },
    { key: 'target', label: 'Length', items: () => [...f('target').options].map((o) => [o.value, o.textContent]), get: () => f('target').value,
      text: () => (S.mediaById[f('vo').value] ? `${fmt(S.mediaById[f('vo').value].duration)} (the VO)` : f('editStyle').value === 'song' && f('songPart').value === 'full' ? 'The whole song' : lenLabel(f('target').value)),
      disabled: () => (S.mediaById[f('vo').value] ? 'The voice-over decides the length' : '') },
    { key: 'type', label: 'Style', items: () => TYPES.map((t) => [t.id, t.label, t.sub]), get: () => st.type, text: () => TYPES.find((t) => t.id === st.type)?.label || st.type },
  ];
  const drawChips = () => { body.querySelector('[data-chips]').innerHTML = chipsHTML(CHIPS, kit); };
  const advSum = () => {
    const t = TYPES.find((x) => x.id === st.type), sel = (n) => f(n).selectedOptions[0]?.textContent.replace(/ \(.*$/, '') || '';
    return [t?.label, `pace ${f('pace').value}`, f('look').value || 'no film look', f('subtitles').checked ? 'subtitles' : '', f('style').value === 'cinematic' ? 'dissolves' : 'cuts',
      f('styleName').value !== 'none' ? `cut like "${f('styleName').value}"` : '', scr.scenes?.length ? 'script' : '', sel('clipSpeed') !== '1x normal' ? sel('clipSpeed') : ''].filter(Boolean).join(' · ');
  };
  const show = () => {
    const opens = OPENS[st.type], make = $('[data-a="make"]', body);
    make.textContent = opens || 'Make the edit';
    $('[data-a="claude"]', body).hidden = !!opens;
    $('[data-a="plan"]', body).hidden = !!opens || missing.plan;
    body.querySelector('[data-refonly]').hidden = st.type !== 'reference';
    body.querySelector('[data-ref]').hidden = st.type !== 'reference';
    const novo = !f('vo').value, song = f('editStyle').value === 'song';
    body.querySelector('[data-outline]').hidden = !novo || song;
    body.querySelector('[data-song]').hidden = !song;
    f('musicBest').closest('label').hidden = song; // (the song has its own "whole song / best part")
    body.querySelector('[data-in="music"]').classList.toggle('need', song && !f('music').value);
    body.querySelector('[data-advsum]').textContent = advSum();
    drawChips(); countLine();
  };
  body.addEventListener('change', (e) => {
    if (e.target.name === 'type') { kit.byHand('type'); setType(e.target.value); }
    if (e.target.name === 'styleName') showStyle();
    if (e.target.name === 'styleDefault') api('PUT', '/api/styles/default', { name: e.target.checked && f('styleName').value !== 'none' ? f('styleName').value : null }).then((r) => { styles.def = r.default; toast(r.default ? `"${r.default}" is now the default for every edit` : 'No default style - the agent cuts its own way'); }).catch((err) => toast(err.message, 'err'));
    if (e.target.name === 'vo' && e.target.value && !kit.applying) f('subtitles').checked = st.type !== 'highlights';
    if (e.target.closest('[data-clips]')) {
      if (e.target.dataset.bin) {
        const b = e.target.dataset.bin;
        shown().filter((m) => (m.bin || 'Other') === b).forEach((m) => (e.target.checked ? st.clips.add(m.id) : st.clips.delete(m.id)));
        renderClips();
      } else if (e.target.value) { e.target.checked ? st.clips.add(e.target.value) : st.clips.delete(e.target.value); e.target.closest('.ag-tile')?.classList.toggle('on', e.target.checked); renderClips(); }
    }
    if (e.target.name !== 'ask') show();
  });
  // ready to run? (what the old steps checked on Next)
  const ready = () => {
    if (!st.clips.size) { toast('Select some footage', 'err'); openPick(true); return false; }
    if (f('editStyle').value === 'song' && !f('music').value) { toast('Choose the song (Music) - the song edit is cut to it', 'err'); f('music').focus(); return false; }
    // reference: its own shots never go into the edit
    if (st.type === 'reference') { if (!f('reference').value) { toast('Choose the reference video', 'err'); f('reference').focus(); return false; } st.clips.delete(f('reference').value); }
    return true;
  };
  const label = () => JOBS.find((x) => x.id === st.job)?.label || TYPES.find((x) => x.id === st.type)?.label;
  body.addEventListener('click', async (e) => {
    const jb = e.target.closest('[data-job]'); if (jb) applyJob(jb.dataset.job === st.job ? null : jb.dataset.job);
    const chip = e.target.closest('[data-chip]');
    if (chip) {
      const c = CHIPS.find((x) => x.key === chip.dataset.chip);
      return chipMenu(chip, c.items(), c.get(), (v) => {
        kit.byHand(c.key);
        if (c.key === 'type') setType(v);
        else { const el = f(c.key); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); kit.byHand(c.key); }
        show();
      });
    }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'guide') openPromptGuide({ box });
    if (a === 'pick') openPick();
    if (a === 'all') { shown().forEach((m) => st.clips.add(m.id)); renderClips(); }
    if (a === 'none') { st.clips.clear(); renderClips(); }
    if (a === 'openall') { const all = $$('[data-binrow]', body), open = all.some((d) => !d.open); all.forEach((d) => { d.open = open; }); e.target.textContent = open ? 'Close all folders' : 'Open all folders'; }
    const kb = e.target.closest('[data-kind]'); if (kb) { pick.kind = kb.dataset.kind; $$('[data-kind]', body).forEach((x) => x.classList.toggle('on', x === kb)); renderClips(); }
    if (a === 'addFolder') {
      const folder = await pickFolder('Footage folder for the agent');
      if (!folder) return;
      const r = await api('POST', `/api/import?p=${enc(S.proj)}`, { folder });
      toast(`${r.added} files imported - reading them…`);
      for (let i = 0; i < 60; i++) { await refreshMedia(); if (!S.queue.quick) break; await new Promise((ok) => setTimeout(ok, 1500)); }
      S.media.filter((m) => m.kind === 'video' || m.kind === 'image').forEach((m) => st.clips.add(m.id));
      renderClips();
    }
    if (a === 'learnStyle') {
      const n = prompt('Name for this style (e.g. "GenZ lyric video")', `${S.project.name || S.proj} style`);
      if (!n) return;
      try { const r = await api('POST', `/api/styles/learn?p=${enc(S.proj)}`, { name: n, makeDefault: true }); await fillStyles(r.name); toast(`Learnt "${r.name}" - now the default for every edit (untick Default to stop): ${r.summary}`); }
      catch (err) { toast(err.message, 'err'); }
    }
    if (a === 'aivo') openVoiceOver({ text: scr.scenes?.map((s) => s.vo).filter(Boolean).join('\n\n') || '', onDone: (id, r) => { const m = S.mediaById[id]; if (!m) return; f('vo').insertAdjacentHTML('beforeend', `<option value="${id}">${esc(m.name)} (${fmt(m.duration)})</option>`); f('vo').value = id; show(); if (r.subs) f('subtitles').checked = true; } });
    if (a === 'plan') { await kit.flush(); return showPlan(body.querySelector('[data-plan]'), e.target.closest('[data-a]'), opts()); }
    if (a === 'planclose') { const p = body.querySelector('[data-plan]'); p.hidden = true; p.innerHTML = ''; }
    if (a === 'make') {
      if (st.type === 'autoreels') { dlg.close(); return openReels(setBusy); }
      if (st.type === 'script') { dlg.close(); return openScriptEdit(setBusy); }
      if (st.type === 'multicam') { dlg.close(); return openMulticam(setBusy); }
      await kit.flush();
      if (!ready()) return;
      // the built-in agent on this PC: the words go with it (intent + the constraints read from them)
      const o = opts();
      if (!sequenceForAgent(label() || 'Agent edit', o.aspect)) return;
      dlg.close(); return runAgentWith(o, setBusy, { ask: false });
    }
    if (a === 'claude') {
      await kit.flush();
      if (!ready()) return;
      // the edit is made by Claude, the way it edits in this folder (engine/claude-guide.md): it looks at the footage and
      // the song, plans a story, cuts on the beats and checks its own work; the words are in its brief
      dlg.close(); editWithClaude(opts(), label());
    }
  });

  // the settings the engine reads (the same keys as before), plus the words: intent, constraints, keep
  const opts = () => {
    const text = box.value.trim(), c = kit.parsed?.constraints;
    return {
      ...kit.extra,
      clips: [...st.clips].filter((id) => st.type !== 'reference' || id !== f('reference').value), vo: f('vo').value || null, voLang: f('voLang').value, whisperModel: f('whisperModel').value,
      music: f('music').value || null, musicBest: f('musicBest').checked, keepSound: f('keepSound').checked, outline: f('outline').value,
      // "Same as the reference" becomes the reference's real shape here ('ref' used to become the new sequence's
      // frame size, which is no size at all, and Claude was told "Format ref")
      aspect: f('aspect').value === 'ref' ? refAspect(S.mediaById[f('reference').value]) : f('aspect').value, pace: f('pace').value, clipSpeed: +f('clipSpeed').value, stabilize: f('stabilize').checked, cinematic: f('cinematic').checked, fx: f('fx').checked, sfx: f('sfx').checked, look: f('look').value, editStyle: f('editStyle').value, stock: false, ...(scr.scenes?.length ? { scenes: scr.scenes } : {}), target: +f('target').value, autoColor: f('autoColor').checked, detectLog: f('detectLog').checked,
      ...(st.type === 'reference' && f('reference').value ? { reference: f('reference').value } : {}),
      subtitles: f('subtitles').checked, style: f('style').value, title: f('title').value.trim(), endText: f('endText').value.trim(), names: f('names').value.trim(),
      styleName: f('styleName').value, notes: text,
      ...(f('editStyle').value === 'song' ? { songPart: f('songPart').value, lyricsOnScreen: f('lyricsOnScreen').checked, lyrics: f('lyrics').value.trim(), musicBest: false } : {}),
      ...(text ? { intent: text } : {}), ...(c ? { constraints: c } : {}), ...(c?.keep ? { keep: c.keep } : {}),
    };
  };

  applyType(); show();
  if (job) applyJob(job);
  stylesIn.then(() => { pickLearnt(); show(); }); // (the styles come a moment later: a learnt one matching the job is picked then)
  setTimeout(() => box.focus());
}


// The wizard's / Re-edit's choices as a brief for Claude (Assistant > Claude mode), who edits like it does in this
// folder: footage first, a story, cuts on the beats, a self-check. No stock footage - only the project's own clips.
// the frame shape of a reference video: 9:16 / 4:5 / 1:1 / 16:9 (a turned phone video counts as turned)
function refAspect(m) {
  if (!m?.width || !m?.height) return '16:9';
  const turned = Math.abs(+m.rotation || 0) % 180 === 90, r = (turned ? m.height : m.width) / (turned ? m.width : m.height);
  return r < 0.7 ? '9:16' : r < 0.9 ? '4:5' : r < 1.25 ? '1:1' : '16:9';
}
export function claudeBrief(o, label = 'edit', changes = null) {
  const nm = (id) => S.mediaById[id]?.name, yes = (b, s) => (b ? s : '');
  const ref = o.reference && S.mediaById[o.reference];
  return [
    // Copy a reference: Claude was never told about the reference before, so it made an ordinary edit
    ref ? `REFERENCE - make the SAME edit as this video, with this project's own footage: "${ref.name}" (id ${ref.id}, file "${ref.path}"). Never put the reference itself (or any of its shots) on the timeline. First take it apart: node engine/edtool.mjs ref "${ref.path}" and Read the sheet it prints (for a long one also look "${ref.path}" --from/--to). Then rebuild it: the same kinds of shots in the same order, the same shot lengths and cut rhythm (on the song's beats if there is one), the same kinds of transitions and effects, the same text style and position, the same look and frame shape. When done, say in 2-4 lines how close it is and what differs.` : '',
    changes ? `Re-edit the current edit on the timeline (it was made from these settings). What changes:\n${changes}\nKeep what still fits; rebuild what the changes need (e.g. a new song = recut to its beats).` : `Make a ${label} from this project's footage.`,
    `Format ${o.aspect}, ${o.music ? `song/music: "${nm(o.music)}" (id ${o.music})${o.editStyle === 'song' ? ` - cut the whole edit to the song (${o.songPart === 'best' ? `its best ${o.target}s` : 'the full song'})` : ''}${o.musicBest ? ' (its best part)' : ''}` : `length ~${o.target}s`}.`,
    o.vo ? `Voice-over: "${nm(o.vo)}" (id ${o.vo}) - the shots follow what is said.` : '',
    `Footage: only these ${o.clips.length} files of the project (ids: ${o.clips.filter((id) => id !== o.reference).slice(0, 400).join(',')}). No stock footage.`,
    o.styleName && o.styleName !== 'none' ? `Style: cut like "${o.styleName}" (node engine/edtool.mjs styles).` : `Pace: ${o.pace}${o.editStyle ? `, edit style: ${o.editStyle}` : ''}.`,
    `Finish: look ${o.look || 'natural'}${yes(o.autoColor, ', auto colour each shot')}${yes(o.cinematic, ', cinematic finish')}${yes(o.stabilize, ', stabilize shaky shots')}${yes(o.fx, ', teaser effects on the cuts')}${yes(o.sfx, ', sound effects')}; transitions: ${o.style === 'cinematic' ? 'dissolves between ideas' : 'clean cuts'}${o.clipSpeed && o.clipSpeed !== 1 ? `; clip speed ${o.clipSpeed}x` : ''}${yes(o.keepSound, '; keep the clips\' own sound under the music')}.`,
    o.subtitles ? 'Subtitles: yes.' : '', o.outline ? `Story outline:\n${o.outline}` : '', o.scenes?.length ? `Script scenes: ${o.scenes.map((s, i) => `${i + 1}. ${s.vo || s.text || ''}`).join(' / ').slice(0, 1500)}` : '',
    o.lyrics ? `Lyrics:\n${o.lyrics}` : '', o.lyricsOnScreen ? 'Show the lyrics on screen.' : '', o.title ? `Title: "${o.title}".` : '', o.endText ? `End card: "${o.endText}".` : '', o.names ? `Names / spellings: ${o.names}` : '',
    o.notes ? `The editor's own words (do this too):\n${o.notes}` : '',
    'Look at the footage first, plan the story, then put it on the timeline and check it yourself with a contact sheet. End with 2-4 lines on what you made.',
  ].filter(Boolean).join('\n');
}
// hands the brief to Claude; the settings are kept (S.project.agentOpts) so Re-edit starts from them
export function editWithClaude(o, label, changes = null) {
  // a new edit on a timeline that has one: in a new sequence (the old edit stays); a re-edit works on the open one
  if (!changes && !sequenceForAgent(label || 'Agent edit', o.aspect)) return;
  S.project.agentOpts = { ...o, stock: false };
  commit(changes ? 'Re-edit settings' : 'Edit settings');
  import('./assistant.js').then((m) => m.askClaude(claudeBrief(o, label, changes)));
}

// Runs the agent and puts its edit on the timeline. Also used by the Assistant to re-edit with changed settings.
export async function runAgentWith(o, setBusy, { ask = true } = {}) {
  if (ask && Object.values(S.project.tracks).flat().length && !confirm('The agent will replace the clips on your timeline (V1, V2 titles, A1, A2). Continue?\n\nTip: Ctrl+Z brings the old edit back.')) return;
  const job = await api('POST', `/api/agent?p=${enc(S.proj)}`, o).catch((e) => { toast(e.message, 'err'); return null; });
  if (job) await followAgentJob(job.id, o, setBusy);
}

// Agent jobs run on the server; this follows one to the end and puts its edit on the timeline. Also picks up a job
// that is still running after the page was refreshed or reopened (resumeAgentJob), so a refresh never loses an edit.
const following = new Set();
export async function followAgentJob(jobId, o, setBusy) {
  if (following.has(jobId)) return;
  following.add(jobId);
  const pg = progressDialog(jobId);
  setBusy?.(true, 'Agent working…');
  try {
    const j = await watchJob(jobId, (x) => { pg.update(x.progress, x.stage || x.log.slice(-1)[0], x.started); const c = pg.clock.tick(x.progress); setBusy?.(true, `Agent ${x.progress}%${c.left ? ` · ~${c.left} left` : ''}`); });
    pg.close();
    await applyAgentResult(j.result, o);
  } catch (err) { pg.close(); toast(err.job ? `Agent stopped: ${err.job.log.slice(-1)[0]}` : err.message, 'err'); }
  finally { setBusy?.(false); following.delete(jobId); }
}
// Puts a finished agent edit on the timeline and tells the server it is used (so it is not offered again on reopen).
async function applyAgentResult(r, o) {
  // a copy of the edit as it was, so this agent edit can be taken back any time (header Undo AI)
  await import('./aiundo.js').then((m) => m.aiSnapshot(`Agent edit${o.styleName && o.styleName !== 'none' ? ` (${o.styleName})` : ''}${o.editStyle && o.editStyle !== 'standard' ? ` - ${o.editStyle}` : ''}`)).catch(() => {});
  if (r.stockIds?.length || o.stock) await refreshMedia(); // stock clips were added to the project
  const asp = r.aspect || o.aspect; // 'ref' = the reference's shape, resolved by the server
  if (asp && asp !== 'ref') S.project.settings.aspect = asp;
  S.project.tracks.V1 = r.tracks.V1; S.project.tracks.V2 = r.tracks.V2; S.project.tracks.A1 = r.tracks.A1; S.project.tracks.A2 = r.tracks.A2;
  // sound design: the agent's effects replace its earlier ones; your own A3 sounds stay
  if (r.tracks.A3?.length) { await refreshMedia(); S.project.tracks.A3 = [...(S.project.tracks.A3 || []).filter((c) => !c.sfx), ...r.tracks.A3]; }
  // the reference's effects as adjustment layers above the story (the ones from an earlier reference edit go)
  if (r.refLooks) { const tr = placeRefLooks(S.project, r.refLooks, S.mediaById); if (tr) toast(`${r.refLooks.length} adjustment layer${r.refLooks.length > 1 ? 's' : ''} on ${tr} copy the reference's effects - change them in Effect Controls`); }
  for (const [k, v] of Object.entries(r.trackState)) S.project.trackState[k] = { ...S.project.trackState[k], ...v };
  // an edit copying a reference: V2 its looks (adjustment layers), V3 comps, V4 text - nothing covering anything
  if (r.refLooks || o?.reference) arrangeLayers(S.project, S.mediaById);
  if (r.subtitles) S.project.subtitles = { ...S.project.subtitles, file: r.subtitles };
  if (r.captions) S.project.captions = r.captions; // lyrics on screen
  if (o.stabilize) stabilizeAll(S.project, 'medium');
  if (o.cinematic) applyCinematic(S.project); else if ('cinematic' in o) S.project.settings.look = { letterbox: '', vignette: 0, grain: 0 };
  if (o.look !== undefined) setFilmLook(S.project, o.look, o.look ? 0.85 : 0);
  // a learnt style brings its own look (film LUT, bars) and photo zoom setting
  if (r.settings) { if (r.settings.look) S.project.settings.look = r.settings.look; if ('kenburns' in r.settings) S.project.settings.kenburns = r.settings.kenburns; }
  S.project.agentReport = { at: Date.now(), ...r.report };
  // (keep is for one run - a later re-edit from the Assistant with new music must not keep these shots)
  // (the scope too: the next re-edit starts from the whole edit again)
  if (o.clips) { const { keep, ...was } = o; void keep; if (was.constraints?.scope) { was.constraints = { ...was.constraints }; delete was.constraints.scope; } S.project.agentOpts = { ...was, ...(asp && asp !== 'ref' ? { aspect: asp } : {}) }; } // remembered so the edit can be redone with changes (Assistant: "music badlo aur dobara edit karo")
  S.sel.clear(); S.playhead = 0;
  commit('Agent edit');
  emit('subs'); emit('fit');
  toast(`Edit ready: ${r.tracks.V1.length} shots, ${fmt(r.duration)}. Press Space to watch.`);
  showReport();
  import('./aiundo.js').then((m) => m.offerAiUndo('Agent edit')).catch(() => {});
  api("POST", `/api/agent/applied?p=${enc(S.proj)}`).catch(() => {});
}

export async function resumeAgentJob(setBusy) {
  const running = await api('GET', '/api/jobs').catch(() => []);
  const job = running.find((j) => j.kind === 'agent' && j.project === S.proj);
  if (!job) {
    // an edit that finished while this page was closed or not following it
    const p = await api('GET', `/api/agent/pending?p=${enc(S.proj)}`).catch(() => null);
    if (!p?.result) return;
    if (confirm(`An agent edit finished while it was not on screen (${p.result.tracks.V1.length} shots, ${new Date(p.at).toLocaleTimeString()}).

Put it on the timeline now? Ctrl+Z brings your current edit back.`)) await applyAgentResult(p.result, p.opts || {});
    else api('POST', `/api/agent/applied?p=${enc(S.proj)}`).catch(() => {});
    return;
  }
  toast('The agent is still working on this project - picking it up again');
  // settings the edit was started with (stored with the job); older jobs fall back to this project's last ones
  followAgentJob(job.id, job.opts || {}, setBusy); // without saved settings only the edit itself is applied
}

function progressDialog(jobId = null) {
  const steps = ['Analysing clips', 'Listening to the voice-over', 'Looking at the footage', 'Choosing the best moments', 'Colour-correcting'];
  const SKIP = 'Skip - edit with the clips looked at so far';
  const body = h(`<div class="ag-prog"><div class="ag-pct"><b data-pct>0%</b><span class="muted" data-eta>starting…</span></div><div class="bar"><div></div></div><ol>${steps.map((s) => `<li>${s}</li>`).join('')}</ol><p class="muted small" data-msg></p>
    ${jobId ? `<div class="row-in" data-skiprow hidden><button type="button" class="small accent" data-skip>${SKIP}</button></div><small class="muted" data-skiprow hidden>Clips already looked at are remembered, so the next run starts from them.</small>` : ''}
    ${jobId ? '<div class="row-in"><button type="button" class="small" data-stop>Stop the agent</button></div>' : ''}</div>`);
  const d = modal('Agent is editing', body, { width: 460 });
  // stops the run at its next step (clips looked at so far are remembered for the next run)
  const st = body.querySelector('[data-stop]');
  if (st) st.onclick = async () => {
    st.disabled = true; st.textContent = 'Stopping…';
    await api('POST', `/api/claude/stop?id=${enc(jobId)}`).catch((e) => { toast(e.message, 'err'); st.disabled = false; st.textContent = 'Stop the agent'; });
  };
  const sk = body.querySelector('[data-skip]');
  if (sk) sk.onclick = async () => {
    sk.disabled = true; sk.textContent = 'Skipping…';
    await api('POST', `/api/jobs/skip?id=${enc(jobId)}`).catch((e) => toast(e.message, 'err'));
    setTimeout(() => { sk.disabled = false; sk.textContent = SKIP; }, 4000);
  };
  let clock = progressClock(), synced = false;
  return {
    get clock() { return clock; },
    update(p, msg, started) {
      if (started && !synced) { clock = progressClock(started); synced = true; } // count from the job's real start
      $('.bar div', body).style.width = `${p}%`;
      $('[data-pct]', body).textContent = `${Math.round(p)}%`;
      $('[data-eta]', body).textContent = clock.tick(p).text;
      $('[data-msg]', body).textContent = msg || '';
      $$('[data-skiprow]', body).forEach((r) => (r.hidden = !(p < 56 && !(p >= 25 && p < 48)))); // while clips are being read
      const k = p < 25 ? 0 : p < 45 ? 1 : p < 70 ? 2 : p < 80 ? 3 : 4;
      $$('li', body).forEach((li, i) => { li.classList.toggle('done', i < k); li.classList.toggle('now', i === k); });
    },
    close: () => d.close(),
  };
}

// Frame of the filmstrip nearest to time t (the strip holds 12 frames spread over the clip).
function thumbAt(m, t) {
  if (!m) return '';
  if (!m.urls.strip || !m.duration) return m.urls.thumb ? `background-image:url('${m.urls.thumb}')` : '';
  const k = Math.max(0, Math.min(11, Math.round((t / m.duration) * 12 - 0.5)));
  return `background-image:url('${m.urls.strip}');background-size:1200% 100%;background-position:${(k / 11) * 100}% 0`;
}

// Report: every shot with its voice-over line and how well the picture matches.
// Per shot: jump to it, Change (the agent's next-best moment), Choose (its other options or any clip), Delete.
// On top, the edit as a storyboard: every shot as a thumbnail in a row (click one to open its options).
export function showReport() {
  const r = S.project.agentReport;
  if (!r) return toast('Run the agent first');
  const body = h(`<div class="ag-rep">${r.warnings?.length ? `<ul class="warns">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <div class="ag2-story" data-story role="list" aria-label="Storyboard"></div>
    <p class="muted small"><b>Change</b> swaps in the agent's next-best shot for that line, <b>Choose</b> shows all options to pick from, <b>Delete</b> removes the shot (the rest moves up). Click a row to jump to its shot. Everything can be undone (Ctrl+Z).</p>
    <table><thead><tr><th>#</th><th></th><th>At</th><th>Voice-over / idea</th><th>Shot</th><th>Match</th><th></th></tr></thead><tbody></tbody></table></div>`);
  const d = modal('Agent report', body, { width: 980 });
  let open = null; // slot index whose chooser is open
  const footage = () => {
    const ids = S.project.agentOpts?.clips?.length ? S.project.agentOpts.clips : S.media.filter((m) => m.kind === 'video' || m.kind === 'image').map((m) => m.id);
    return ids.map((id) => S.mediaById[id]).filter((m) => m && (m.kind === 'video' || m.kind === 'image'));
  };
  const story = () => {
    $('[data-story]', body).innerHTML = r.slots.map((s, i) => {
      const f = findClip(s.clipId), c = f?.clip, m = c && S.mediaById[c.mediaId];
      const pct = s.match === null || s.match === undefined ? null : Math.max(0, Math.min(100, Math.round(((s.match + 1) / 4) * 100)));
      return `<button type="button" role="listitem" class="ag2-sb${s.weak ? ' weak' : ''}${f ? '' : ' gone'}${open === i ? ' on' : ''}" data-sb="${i}" title="${esc(s.text || m?.name || '')}">
        <span class="th" style="${thumbAt(m, c?.in || 0)}"></span><i>${i + 1}</i>${s.weak ? `<em>${ic('warn')}</em>` : ''}
        <small>${esc((s.text || m?.name || (f ? '' : 'deleted')).slice(0, 38))}</small>${pct === null ? '' : `<span class="meterbar"><i style="width:${pct}%"></i></span>`}</button>`;
    }).join('');
  };
  const draw = () => {
    story();
    const L = layout().V1;
    $('tbody', body).innerHTML = r.slots.map((s, i) => {
      const f = findClip(s.clipId), x = L.find((y) => y.clip.id === s.clipId), c = f?.clip, m = c && S.mediaById[c.mediaId];
      const pct = s.match === null || s.match === undefined ? null : Math.max(0, Math.min(100, Math.round(((s.match + 1) / 4) * 100)));
      const row = `<tr data-clip="${s.clipId}" class="${s.weak ? 'weak' : ''}${f ? '' : ' gone'}">
        <td>${i + 1}</td><td><span class="th" style="${thumbAt(m, c?.in || 0)}"></span></td>
        <td>${x ? fmt(x.start) : '-'}</td>
        <td data-jump>${s.text ? `${esc(s.text)}${s.en && s.en !== s.text ? `<br><small class="muted">${esc(s.en)}</small>` : ''}` : '<span class="muted">(music / no speech)</span>'}</td>
        <td>${f ? `${esc(m?.name || s.media)}<br><small class="muted">at ${fmt(c.in || 0)}</small>` : '<span class="muted">deleted</span>'}</td>
        <td>${pct === null ? '<span class="muted">-</span>' : `<span class="meterbar"><i style="width:${pct}%"></i></span>${s.weak ? '<b class="warn">check</b>' : ''}`}</td>
        <td class="rep-act">${f ? `<button class="small" data-change="${i}" title="Next-best shot for this line">Change</button><button class="small" data-choose="${i}" title="See all options">Choose</button><button class="small" data-del="${i}" title="Delete this shot" aria-label="Delete">${ic('trash')}</button>` : ''}</td></tr>`;
      if (open !== i || !f) return row;
      const alts = (s.alts || []).filter((a) => S.mediaById[a.mediaId]);
      const tile = (mid, at, label, k) => `<button class="rep-tile" data-pick="${i}" data-m="${mid}" data-in="${at}" title="${esc(S.mediaById[mid].name)}"><span class="th" style="${thumbAt(S.mediaById[mid], at)}"></span><small>${label}</small></button>`;
      return `${row}<tr class="rep-choose"><td></td><td colspan="6">
        ${alts.length ? `<div class="muted small">Agent's other picks for this line</div><div class="rep-tiles">${alts.map((a, k) => tile(a.mediaId, a.in, `${k + 1}. ${esc(S.mediaById[a.mediaId].name.slice(0, 18))} @${fmt(a.in)}`)).join('')}</div>` : ''}
        <div class="muted small">Any clip from the footage (a good middle part is used)</div><div class="rep-tiles">${footage().map((fm) => tile(fm.id, -1, esc(fm.name.slice(0, 22)))).join('')}</div></td></tr>`;
    }).join('');
  };
  // put another moment into the shot; its length on the timeline stays the same
  const apply = (i, mediaId, at, match) => {
    const s = r.slots[i], f = findClip(s.clipId); if (!f) return;
    const c = f.clip, len = clipDur(c, S.mediaById), m = S.mediaById[mediaId];
    if (c.mediaId !== mediaId) delete c.color; // the old grade was made for the old footage
    c.mediaId = mediaId;
    if (m.kind === 'image') { c.type = 'image'; delete c.in; delete c.out; delete c.speed; c.dur = +len.toFixed(3); }
    else {
      c.type = 'video'; delete c.dur; delete c.speed;
      let a = at >= 0 ? at : Math.max(0, (m.duration - len) / 2);
      if (a + len > m.duration) a = Math.max(0, m.duration - len - 0.05);
      c.in = +a.toFixed(3); c.out = +Math.min(m.duration, a + len).toFixed(3);
      if (c.out - c.in < len - 0.05) c.speed = +Math.max(0.5, (c.out - c.in) / len).toFixed(3);
    }
    Object.assign(s, { media: m.name, in: c.in || 0, match: match ?? null, weak: false });
    commit('Change shot'); emit('select');
  };
  body.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.sb !== undefined) {
      const i = +b.dataset.sb; open = findClip(r.slots[i].clipId) ? (open === i ? null : i) : null; draw();
      body.querySelector(`tr[data-clip="${r.slots[i].clipId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    if (b?.dataset.change !== undefined) {
      const i = +b.dataset.change, s = r.slots[i], c = findClip(s.clipId).clip;
      const alts = (s.alts || []).filter((a) => S.mediaById[a.mediaId]);
      if (!alts.length) { open = i; return draw(); }
      s.altIdx = ((s.altIdx ?? -1) + 1) % alts.length;
      let a = alts[s.altIdx];
      if (a.mediaId === c.mediaId && Math.abs(a.in - (c.in || 0)) < 0.2) { s.altIdx = (s.altIdx + 1) % alts.length; a = alts[s.altIdx]; }
      apply(i, a.mediaId, a.in, a.match);
      toast(`Shot ${i + 1}: option ${s.altIdx + 1} of ${alts.length}`);
      return draw();
    }
    if (b?.dataset.choose !== undefined) { open = open === +b.dataset.choose ? null : +b.dataset.choose; return draw(); }
    if (b?.dataset.pick !== undefined) { apply(+b.dataset.pick, b.dataset.m, +b.dataset.in, null); open = null; return draw(); }
    if (b?.dataset.del !== undefined) {
      const f = findClip(r.slots[+b.dataset.del].clipId);
      if (f) { S.project.tracks[f.track].splice(f.index, 1); if (f.track === 'V1' && f.index === 0 && S.project.tracks.V1[0]) delete S.project.tracks.V1[0].transitionIn; S.sel.clear(); commit('Delete shot'); }
      return draw();
    }
    const tr = e.target.closest('tr[data-clip]');
    if (!tr || !e.target.closest('[data-jump], td')) return;
    const x = layout().V1.find((y) => y.clip.id === tr.dataset.clip);
    if (!x) return toast('That shot was removed');
    S.sel = new Set([tr.dataset.clip]); emit('select'); emit('seek', x.start + 0.01); d.close();
  });
  draw();
}

