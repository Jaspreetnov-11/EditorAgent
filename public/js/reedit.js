// Re-edit: say what should change (Hindi / Hinglish / English) or change the voice-over, music, pace, format or finish,
// and the agent rebuilds the edit with the same footage and settings as last time - keeping the shots that still fit
// (a partial re-edit). Every setting is in the Advanced drawer. Ctrl+Z brings the old edit back.
import { S, layout } from './store.js';
import { api, enc } from './api.js';
import { fmt } from './model.js';
import { $, h, esc, toast, modal } from './ui.js';
import { ic } from './lineicons.js';
import { uploadAudioInto, uploadFiles, refreshMedia, pickFolder } from './mediapool.js';
import { runAgentWith, editWithClaude, wireBrief, understoodHTML, chipsHTML, chipMenu, showPlan, tc, scopeText } from './agent.js';
import { scriptPicker } from './scriptedit.js';
import { defaultFootage, whyLeftOut } from './footagepick.js';
import { ideasLine } from './promptguide.js';

const PACES = [['fast', 'Fast cuts (~1.7 s)'], ['medium', 'Medium (~2.8 s)'], ['slow', 'Slow, cinematic (~4 s)']];
const ASPECTS = [['9:16', '9:16 Reel / Shorts'], ['16:9', '16:9 YouTube / Film'], ['1:1', '1:1 Square'], ['4:5', '4:5 Feed']];
const STYLES = [['standard', 'Standard'], ['teaser', 'Cinematic teaser'], ['montage', 'Fast montage'], ['song', 'Song / music video']];
const KEEPS = [['shots', 'Keep the shots that still fit'], ['all', 'Keep every shot - only the finish changes'], ['none', 'Make it fresh - pick every shot again']];
const LABEL = { vo: 'voice-over', music: 'music', pace: 'pace', aspect: 'format', target: 'length', look: 'look', style: 'transitions', editStyle: 'edit style', clipSpeed: 'clip speed', title: 'title', endText: 'end card', subtitles: 'subtitles', autoColor: 'auto colour', cinematic: 'cinematic finish', fx: 'teaser effects', sfx: 'sound effects', stabilize: 'stabilize', keepSound: 'clip sound', musicBest: 'best part of the music' };

// a timecode typed by hand: 12 / 12.5 / 0:12 / 1:02.5 / 1:02:03 -> seconds (NaN when it is not one)
const parseTc = (v) => {
  const p = String(v || '').trim().replace(/\s*s(ec)?$/i, '').split(':');
  if (!p[0] || p.length > 3 || p.some((x) => !/^\d+(\.\d+)?$/.test(x.trim()))) return NaN;
  return p.reduce((a, x) => a * 60 + +x, 0);
};

// The settings of the edit on the timeline: what the agent used last time, or (for older edits) read off the timeline.
export function currentEditOpts() {
  const pj = S.project, saved = pj.agentOpts;
  if (saved) return { ...saved };
  const V1 = pj.tracks.V1, footage = [...new Set(V1.filter((c) => c.mediaId && S.mediaById[c.mediaId]).map((c) => c.mediaId))];
  const media = V1.filter((c) => c.type !== 'title'), avg = media.length ? media.reduce((s, c) => s + (c.dur || (c.out ?? 0) - (c.in || 0)), 0) / media.length : 2.8;
  const firstTitle = pj.tracks.V2.find((c) => c.type === 'title'), endCard = V1[V1.length - 1]?.type === 'title' ? V1[V1.length - 1] : null;
  return {
    clips: footage, vo: pj.tracks.A1[0]?.mediaId || null, voLang: 'hi', whisperModel: 'large-v3-turbo',
    music: pj.tracks.A2[0]?.mediaId || null, musicBest: true, keepSound: (pj.trackState.V1?.volume ?? 1) > 0.2, outline: '',
    aspect: pj.settings.aspect, pace: avg < 2.2 ? 'fast' : avg < 3.5 ? 'medium' : 'slow', target: Math.round(media.reduce((s, c) => s + (c.dur || (c.out ?? 0) - (c.in || 0)), 0)) || 30,
    autoColor: true, detectLog: true, subtitles: !!pj.subtitles?.file, style: V1.some((c) => c.transitionIn?.type && c.transitionIn.type !== 'cut') ? 'cinematic' : 'cuts',
    title: firstTitle?.text || '', endText: endCard?.text || '', names: '',
  };
}

// focus: 'vo' | 'music' | null - opens with that part highlighted. changes: pre-filled values (e.g. from the Assistant).
export function openReedit(setBusy, { focus = null, changes = {} } = {}) {
  if (!S.project.tracks.V1.length) return toast('Make an edit first (Agent), then you can re-edit it', 'err');
  const base = currentEditOpts(), o = { ...base, ...changes };
  const audio = () => S.media.filter((m) => m.kind === 'audio');
  const opt = (list, cur, none) => `${none ? `<option value="">${none}</option>` : ''}${list.map((m) => `<option value="${m.id}"${m.id === cur ? ' selected' : ''}>${esc(m.name)} (${fmt(m.duration)})</option>`).join('')}`;
  // "all footage" = the project's footage without logos, rejects, bad clips and copies (footagepick.js); "same" = the
  // clips this edit was made from, without what is not footage (older edits took every file of the project)
  const allFootage = defaultFootage().ids.map((id) => S.mediaById[id]).filter(Boolean);
  const onEdit = new Set(S.project.tracks.V1.map((c) => c.mediaId));
  base.clips = (base.clips || []).filter((id) => S.mediaById[id] && (onEdit.has(id) || !whyLeftOut(S.mediaById[id])));
  const body = h(`<div class="ag ag2 re">
    <section class="ag2-hero">
      <label class="ag2-q" for="ag2Ask">What should change?</label>
      <textarea id="ag2Ask" name="ask" rows="3" placeholder="e.g. music dheema karo, pehle 5 sec tight karo, colour warm, end mein logo" spellcheck="false"></textarea>
      <div class="ag2-understood" data-understood aria-live="polite"></div>
      <div class="ag2-chips" data-chips></div>
      <div data-ideas></div>
    </section>
    <section class="ag2-inputs">
      <div class="ag2-in" data-in="footage"><div class="ag2-in-h">${ic('film')}<b>Footage</b><span class="grow"></span><span class="ag2-count" data-fcount></span></div>
        <div class="row-in"><select name="footage" aria-label="Footage"><option value="same">This edit's clips (${base.clips.length})</option><option value="all" title="No logos, rejects or bad clips">All the footage (${allFootage.length})</option></select>
          <label class="btn small" title="Add new clips">${ic('plus')}<input type="file" hidden multiple name="clipFiles" accept="video/*,image/*,.mxf,.mts,.mov"></label><button type="button" class="btn small" data-a="folder" title="Add a folder of new footage">${ic('folder')}</button></div>
        <small class="ag2-in-why" data-newclips></small></div>
      <div class="ag2-in${focus === 'vo' ? ' hi' : ''}" data-in="vo"><div class="ag2-in-h">${ic('mic')}<b>Voice-over</b><span class="grow"></span><small>shots follow what is said</small></div>
        <div class="row-in"><select name="vo" aria-label="Voice-over">${opt(audio(), o.vo, 'No voice-over')}</select><label class="btn small" title="Upload a new voice-over">${ic('upload')}<input type="file" accept="audio/*,video/*" hidden name="voFile"></label></div>
        <small class="ag2-in-why" data-vonote></small></div>
      <div class="ag2-in${focus === 'music' ? ' hi' : ''}" data-in="music"><div class="ag2-in-h">${ic('music')}<b>Music</b><span class="grow"></span><small>the beat sets the cuts</small></div>
        <div class="row-in"><select name="music" aria-label="Music">${opt(audio(), o.music, 'No music')}</select><label class="btn small" title="Upload music">${ic('upload')}<input type="file" accept="audio/*" hidden name="musicFile"></label></div></div>
    </section>
    <section class="ag2-scope" aria-label="Scope"><div class="ag2-scope-h">${ic('target')}<b>Scope</b><small>What may change - everything outside stays exactly as it is</small></div>
      <div class="ag2-scope-row">
        <div class="ag2-seg" role="radiogroup" aria-label="Scope">
          <label><input type="radio" name="scopeKind" value="all" checked><span>Whole edit</span></label>
          <label><input type="radio" name="scopeKind" value="range"><span>Time range</span></label>
          <label data-selwrap><input type="radio" name="scopeKind" value="clips"><span data-sellabel>Selected clips</span></label>
        </div>
        <div class="ag2-range" data-range hidden>
          <label><span>From</span><input name="scopeFrom" inputmode="decimal" placeholder="0:10" aria-label="From (timeline time)"></label>
          <label><span>To</span><input name="scopeTo" inputmode="decimal" placeholder="0:25" aria-label="To (timeline time)"></label>
          <button type="button" class="btn small" data-a="useInOut" title="The In and Out marks of the timeline (I / O)">Use In/Out</button>
        </div>
        <small class="ag2-in-why" data-scopenote></small>
      </div></section>
    <section class="ag2-plan" data-plan hidden></section>
    <details class="ag2-adv"><summary><b>Advanced</b><small data-advsum></small></summary>
      <div class="re-sections">
        <section class="re-card"><header class="re-card-h"><b>Cut &amp; format</b><small>Style, pace and size of the edit</small></header><div class="fgrid">
          <label class="fld"><span>Edit style</span><select name="editStyle"><option value="standard">Standard</option><option value="teaser">Cinematic teaser (trailer: slow open, build, fast climax)</option><option value="montage">Fast montage (cut on every beat)</option><option value="song">Song / music video (beat + lyrics)</option></select></label>
          <label class="fld"><span>Pace</span><select name="pace">${PACES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
          <label class="fld"><span>Clip speed</span><select name="clipSpeed"><option value="0.5">0.5x slow motion</option><option value="0.75">0.75x gentle slow-mo</option><option value="1" selected>1x normal</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x fast</option></select></label>
          <label class="fld"><span>Format</span><select name="aspect">${ASPECTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
          <label class="fld"><span>Length</span><select name="target"><option value="15">15 s</option><option value="20">20 s</option><option value="30">30 s</option><option value="45">45 s</option><option value="60">1 min</option><option value="90">1.5 min</option><option value="120">2 min</option><option value="180">3 min</option><option value="300">5 min</option></select><small data-lennote></small></label>
          <label class="fld"><span>Transitions</span><select name="style"><option value="cuts">Clean cuts</option><option value="cinematic">Dissolves between ideas</option></select></label>
        </div></section>
        <section class="re-card"><header class="re-card-h"><b>Voice &amp; script</b><small>How the voice-over is heard</small></header><div class="fgrid" data-voice>
          <label class="fld"><span>VO language</span><select name="voLang"><option value="hi">Hindi</option><option value="en">English</option><option value="auto">Auto-detect</option></select></label>
          <label class="fld"><span>Listening accuracy</span><select name="whisperModel"><option value="small">Fast</option><option value="medium">Good</option><option value="large-v3-turbo">Best</option></select></label>
        </div></section>
        <section class="re-card"><header class="re-card-h"><b>Music &amp; sound</b><small>The beat sets the cuts</small></header><div class="fgrid">
          <label class="chk"><input type="checkbox" name="musicBest"> Best part of the music, cuts on the beat</label>
          <label class="chk"><input type="checkbox" name="keepSound"> Keep some of the clips' own sound</label>
          <label class="chk"><input type="checkbox" name="sfx" checked> Sound design (whooshes, hits, a riser into the drop - teaser / montage styles)</label>
        </div></section>
        <section class="re-card"><header class="re-card-h"><b>Look &amp; finish</b><small>Colour, steadiness and effects</small></header><div class="fgrid">
          <label class="fld"><span>Film look (colour of the whole edit)</span><select name="look"><option value="">None (just balanced)</option><option selected>Teal & Orange</option><option>Warm Film</option><option>Golden Hour</option><option>Moody Dark</option><option>Travel Vivid</option><option>Indian Heritage</option><option>Bleach Bypass</option><option>Clean Natural</option></select></label>
          <label class="chk"><input type="checkbox" name="autoColor"> Auto colour every shot</label>
          <label class="chk"><input type="checkbox" name="stabilize"> Stabilize shaky shots (slower render)</label>
          <label class="chk"><input type="checkbox" name="cinematic"> Cinematic finish (film grade, bars, vignette, grain)</label>
          <label class="chk"><input type="checkbox" name="fx" checked> Teaser effects (light leaks, whip, flash, shake on the cuts - teaser / montage styles)</label>
        </div></section>
        <section class="re-card"><header class="re-card-h"><b>Titles</b><small>Words on the screen</small></header><div class="fgrid">
          <label class="chk"><input type="checkbox" name="subtitles"> Subtitles from the voice-over</label>
          <label class="fld"><span>Title on the first shot</span><input name="title"></label>
          <label class="fld"><span>End card</span><input name="endText"></label>
        </div></section>
      </div>
      <p class="muted small ag2-foot-note">Same footage as before unless you add or choose more. Ctrl+Z (or "undo" in the Assistant) brings the current edit back.</p>
    </details>
    <section class="ag2-changes" aria-live="polite"><div class="ag2-changes-h"><b>What will change</b><span class="grow"></span>
      <label class="ag2-keep"><span>Shots</span><select name="keep" aria-label="What to keep">${KEEPS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label></div>
      <div data-chlist></div></section>
    <div class="ag-foot ag2-foot"><button type="button" data-a="plan" title="See the outline of the new edit before it is made">${ic('chart')}Plan</button><span class="grow"></span><button type="button" data-close>Cancel</button>
      <button type="button" data-a="go" title="Limelight AI re-edits it the way it edits in this folder: it looks at the footage and checks its own work (slower)">${ic('sparkle')}Polish with Limelight AI</button>
      <button type="button" class="primary" data-a="go" data-quick="1" title="The built-in agent on this PC: the shots that still fit stay">Re-edit</button></div>
  </div>`);
  const dlg = modal('Re-edit', body, { width: 980 });
  const f = (n) => body.querySelector(`[name="${n}"]`);
  for (const k of ['voLang', 'whisperModel', 'pace', 'aspect', 'style', 'title', 'endText']) if (o[k] !== undefined) f(k).value = o[k];
  f('clipSpeed').value = String(o.clipSpeed || 1);
  f('editStyle').value = o.editStyle || 'standard';
  f('look').value = o.look ?? (S.project.settings.look?.lut || '').replace(' (look).cube', '');
  f('stabilize').checked = !!o.stabilize; f('fx').checked = o.fx !== false; f('sfx').checked = o.sfx !== false; f('cinematic').checked = !!(o.cinematic ?? +S.project.settings.look?.vignette);
  $('[data-ideas]', body).append(ideasLine(() => f('ask'), { picks: ['music dheema karo', 'pehle 5 sec mein CM sahab ka shot', 'colour warm karo', 'opening slow hai, pehle 10 sec tight karo'] }));
  if (changes.ask) f('ask').value = changes.ask;
  const scr = { scenes: o.scenes || null };
  let live = false; // (the script picker reports once while it is built, before the rest is ready)
  body.querySelector('[data-voice]').append(scriptPicker(scr, () => { if (live) show(); }));
  for (const k of ['musicBest', 'keepSound', 'autoColor', 'subtitles']) f(k).checked = o[k] !== false && !!(o[k] ?? true);
  f('subtitles').checked = !!o.subtitles;
  const voNote = () => {
    const changed = (f('vo').value || null) !== (base.vo || null);
    $('[data-vonote]', body).textContent = changed ? (f('vo').value ? 'New voice-over: the whole edit is re-timed to it.' : 'Without a voice-over the edit follows the music / length instead.') : '';
    if (changed && f('vo').value && !f('subtitles').checked && base.subtitles) f('subtitles').checked = true;
  };
  // length: set by the voice-over when there is one, otherwise by this choice
  const tg = f('target'), want = +o.target || 30;
  if (![...tg.options].some((x) => +x.value === want)) tg.add(new Option(`${want} s (this edit)`, want), 0);
  tg.value = String(want);
  const lenNote = () => {
    const v = S.mediaById[f('vo').value];
    tg.disabled = !!v;
    $('[data-lennote]', body).textContent = v ? `Follows the voice-over: about ${fmt(v.duration + 1.8)}` : '';
  };
  voNote(); lenNote();

  f('voFile').onchange = (e) => uploadAudioInto(e.target, f('vo'));
  f('musicFile').onchange = (e) => uploadAudioInto(e.target, f('music'));

  // new footage: uploaded files or a whole folder; the agent uses them on top of the chosen footage
  const extra = new Set();
  const waitNew = async (before, label) => {
    let fresh = [];
    for (let i = 0; i < 90; i++) {
      await refreshMedia();
      fresh = S.media.filter((m) => !before.has(m.id) && (m.kind === 'video' || m.kind === 'image'));
      $('[data-newclips]', body).textContent = `${label}: ${fresh.filter((m) => m.status === 'ready').length}/${fresh.length} read…`;
      if (fresh.length && fresh.every((m) => ['ready', 'error', 'offline'].includes(m.status))) break;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    fresh.filter((m) => m.status === 'ready').forEach((m) => extra.add(m.id));
    $('[data-newclips]', body).textContent = extra.size ? `+ ${extra.size} new clip${extra.size > 1 ? 's' : ''} will be used too` : 'No new clips were added';
    show();
  };
  f('clipFiles').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    const before = new Set(S.media.map((m) => m.id));
    await uploadFiles(files);
    await waitNew(before, 'Reading the new clips');
  };

  // a song picked as both: it is the voice-over (the shots follow its lyrics) and the music at once, laid once
  if (base.vo && base.vo === base.music) base.music = null;
  // the settings for the run (the same keys as before)
  const next = () => {
    const n = {
      ...base, ...kit.extra, vo: f('vo').value || null, voLang: f('voLang').value, whisperModel: f('whisperModel').value, music: f('music').value || null,
      musicBest: f('musicBest').checked, keepSound: f('keepSound').checked, pace: f('pace').value, aspect: f('aspect').value, style: f('style').value,
      autoColor: f('autoColor').checked, subtitles: f('subtitles').checked, title: f('title').value.trim(), endText: f('endText').value.trim(),
      target: +tg.value, clipSpeed: +f('clipSpeed').value, stabilize: f('stabilize').checked, cinematic: f('cinematic').checked, fx: f('fx').checked, sfx: f('sfx').checked, look: f('look').value, editStyle: f('editStyle').value, stock: false, scenes: scr.scenes?.length ? scr.scenes : undefined,
      clips: [...new Set([...(f('footage').value === 'all' ? allFootage.map((m) => m.id) : base.clips), ...extra])],
    };
    if (n.vo && n.vo === n.music) n.music = null;
    return n;
  };
  // ... plus the words: intent, the constraints read from them (on top of the edit's own) and what to keep
  const withWords = (n) => {
    const c = kit.parsed?.constraints, keep = f('keep').value;
    return { ...n, intent: box.value.trim(), intentApplied: true, mode: 'reedit', constraints: { ...(base.constraints || {}), ...(c || {}), keep, scope: getScope() }, keep };
  };
  // what changed in the settings, in words (for "What will change" and for Claude)
  const nm = (k, v) => ((k === 'vo' || k === 'music') && v ? `"${S.mediaById[v]?.name || v}"` : k === 'target' && v ? `${v} s` : v === true ? 'on' : v === false ? 'off' : v === '' || v == null ? 'none' : String(v));
  const diffs = (n, skip = new Set(), was = base) => {
    const ch = Object.keys(LABEL).filter((k) => !skip.has(k) && JSON.stringify(was[k] ?? null) !== JSON.stringify(n[k] ?? null)).map((k) => `${LABEL[k]}: ${nm(k, was[k])} → ${nm(k, n[k])}`);
    if (n.clips.length !== base.clips.length) ch.push(`footage: ${base.clips.length} → ${n.clips.length} files${extra.size ? ' (the new ones are used)' : ''}`);
    return ch;
  };

  // Scope: the whole edit, a time range of the timeline, or some clips (the V1 clips selected on the timeline, or the
  // clips / shots named in the words). Sent as constraints.scope; the engine keeps everything outside as it is.
  const editEnd = () => layout().V1.reduce((m, x) => Math.max(m, x.end ?? 0), 0);
  const selV1 = () => S.project.tracks.V1.filter((c) => S.sel.has(c.id)).map((c) => c.id);
  const inOut = () => { const rg = S.project.settings.range; return rg && rg.in != null && rg.out != null && rg.out > rg.in ? rg : null; };
  const sc = { kind: 'all', ids: null, index: null, byHand: false, auto: false };
  const fillRange = (a, b) => { f('scopeFrom').value = tc(a); f('scopeTo').value = tc(b); };
  { // prefilled: the In / Out marks, else a few seconds around the playhead
    const io = inOut(), end = editEnd() || 30, t = Math.max(0, Math.min(S.playhead || 0, end));
    if (io) fillRange(io.in, io.out); else fillRange(Math.max(0, t - 3), Math.min(end, Math.max(t + 3, 6)));
  }
  const getScope = () => {
    if (sc.kind === 'range') return { kind: 'range', from: parseTc(f('scopeFrom').value), to: parseTc(f('scopeTo').value) };
    if (sc.kind === 'clips') return { kind: 'clips', ids: sc.ids || selV1() };
    if (sc.kind === 'slots') return { kind: 'slots', index: sc.index };
    return { kind: 'all' };
  };
  const badScope = () => {
    const x = getScope();
    if (x.kind === 'range' && !(x.from >= 0 && x.to > x.from)) return 'The time range is not valid - From must be before To (e.g. 0:10 and 0:25)';
    if (x.kind === 'clips' && !x.ids.length) return 'No clip is selected on the timeline';
    return '';
  };
  const drawScope = () => {
    const n = selV1().length, radio = (v) => body.querySelector(`[name="scopeKind"][value="${v}"]`);
    radio(sc.kind === 'slots' ? 'clips' : sc.kind).checked = true;
    body.querySelector('[data-range]').hidden = sc.kind !== 'range';
    body.querySelector('[data-sellabel]').textContent = sc.kind === 'slots' ? `Shot ${sc.index.map((i) => i + 1).join(', ')}`
      : sc.kind === 'clips' && sc.ids ? `${sc.ids.length} clip${sc.ids.length > 1 ? 's' : ''} (from your words)` : `Selected clips${n ? ` (${n})` : ''}`;
    radio('clips').disabled = !n && !sc.ids && sc.kind !== 'slots';
    body.querySelector('[data-selwrap]').title = n ? `${n} clip${n > 1 ? 's' : ''} selected on V1` : 'Select clips on the timeline (V1) first';
    $('[data-a="useInOut"]', body).disabled = !inOut();
    const bad = sc.kind !== 'all' && badScope(), note = body.querySelector('[data-scopenote]');
    note.textContent = bad || sc.note || (sc.auto ? 'Read from your words' : '');
    note.classList.toggle('bad', !!bad);
  };
  // the words named a part ("0:10 se 0:25 tak", "teesra shot", "ye clip"): the control follows, unless it was set by hand
  const scopeFromWords = (x) => {
    sc.note = '';
    if (sc.byHand) return;
    if (!x?.kind || x.kind === 'all') { if (sc.auto) Object.assign(sc, { kind: 'all', ids: null, index: null, auto: false }); return; }
    if (x.kind === 'range' && x.from >= 0 && x.to > x.from) { fillRange(x.from, x.to); Object.assign(sc, { kind: 'range', ids: null, index: null, auto: true }); }
    else if (x.kind === 'clips') {
      // ids: [] = "this clip" = the timeline selection
      const ids = (x.ids || []).filter((id) => S.project.tracks.V1.some((c) => c.id === id));
      if (ids.length || selV1().length) Object.assign(sc, { kind: 'clips', ids: ids.length ? ids : null, index: null, auto: true });
      else { Object.assign(sc, { kind: 'all', ids: null, index: null, auto: false }); sc.note = 'Your words mean the selected clip - select it on the timeline (V1) first'; }
    } else if (x.kind === 'slots' && x.index?.length) Object.assign(sc, { kind: 'slots', ids: null, index: x.index, auto: true });
  };

  const box = f('ask');
  const kit = wireBrief(body, {
    box, mode: 'reedit', opts: () => next(),
    onResult: (r, err) => {
      body.querySelector('[data-understood]').innerHTML = understoodHTML(r, err, kit.thinking);
      if (!kit.manual.has('keep')) f('keep').value = r?.constraints?.keep || 'shots';
      scopeFromWords(r?.constraints?.scope);
      show();
    },
  });
  const CHIPS = [
    { key: 'aspect', label: 'Format', items: () => ASPECTS, get: () => f('aspect').value, text: () => ASPECTS.find(([v]) => v === f('aspect').value)?.[1].replace(/ \/.*$/, '') || f('aspect').value },
    { key: 'target', label: 'Length', items: () => [...tg.options].map((x) => [x.value, x.textContent]), get: () => tg.value,
      text: () => (S.mediaById[f('vo').value] ? `${fmt(S.mediaById[f('vo').value].duration)} (the VO)` : tg.selectedOptions[0]?.textContent || `${tg.value} s`),
      disabled: () => (S.mediaById[f('vo').value] ? 'The voice-over decides the length' : '') },
    { key: 'editStyle', label: 'Style', items: () => STYLES, get: () => f('editStyle').value, text: () => STYLES.find(([v]) => v === f('editStyle').value)?.[1] || f('editStyle').value },
  ];
  // "What will change": what the words asked for (the parser's list), then the settings changed by hand
  const drawChanges = () => {
    const r = kit.parsed, n = next(), text = box.value.trim();
    const asked = (r?.changes || []).filter((c) => !kit.manual.has(c.key)); // (a setting changed by hand after the words: the hand wins)
    const fromWords = asked.map((c) => c.label || `${LABEL[c.key] || c.key}: ${nm(c.key, c.from)} → ${nm(c.key, c.to)}`);
    const byHand = diffs(n, new Set(asked.map((c) => c.key)), start);
    const said = fromWords.length ? [] : (r?.understood || []).filter((u) => !(sc.kind !== 'all' && /^only /i.test(u))); // (the scope line says it already)
    const scope = sc.kind !== 'all' && !badScope() ? scopeText(getScope()) : '';
    const items = [...(scope ? [[`${scope} - everything else stays as it is`, 'scope']] : []), ...fromWords.map((t) => [t, 'words']), ...said.map((t) => [t, 'words']), ...byHand.map((t) => [t, 'hand'])];
    body.querySelector('[data-chlist]').innerHTML = items.length
      ? `<ul>${items.map(([t, k]) => `<li class="${k}">${ic(k === 'scope' ? 'target' : k === 'words' ? 'chat' : 'edit')}<span>${esc(t)}</span></li>`).join('')}</ul>`
      : `<p class="ag2-calm">${text ? 'Nothing in the settings yet - Limelight AI reads your words; the built-in agent makes a fresh, better version.' : 'Nothing yet - write what should change, or change a setting.'}</p>`;
  };
  const advSum = () => [STYLES.find(([v]) => v === f('editStyle').value)?.[1], `pace ${f('pace').value}`, f('look').value || 'no film look', f('subtitles').checked ? 'subtitles' : '',
    f('style').value === 'cinematic' ? 'dissolves' : 'cuts', scr.scenes?.length ? 'script' : '', +f('clipSpeed').value !== 1 ? `${f('clipSpeed').value}x` : ''].filter(Boolean).join(' · ');
  const show = () => {
    body.querySelector('[data-chips]').innerHTML = chipsHTML(CHIPS, kit);
    body.querySelector('[data-advsum]').textContent = advSum();
    body.querySelector('[data-fcount]').innerHTML = `<b>${next().clips.length}</b> clips`;
    drawScope(); drawChanges();
  };
  // the list compares with the window as it opened (an older edit has no clip speed saved: that is no change), except what
  // was handed in already changed (the Assistant's new voice-over)
  const start = { ...next(), ...Object.fromEntries(Object.keys(changes).filter((k) => k in LABEL).map((k) => [k, base[k]])) };
  body.addEventListener('change', (e) => {
    if (e.target.name === 'scopeKind') Object.assign(sc, { kind: e.target.value, ids: null, index: null, byHand: true, auto: false, note: '' });
    if (e.target.name === 'scopeFrom' || e.target.name === 'scopeTo') Object.assign(sc, { byHand: true, auto: false });
    if (e.target.name === 'vo') { voNote(); lenNote(); }
    if (e.target.name !== 'ask') show();
  });

  body.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-chip]');
    if (chip) {
      const c = CHIPS.find((x) => x.key === chip.dataset.chip);
      return chipMenu(chip, c.items(), c.get(), (v) => { const el = f(c.key); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); kit.byHand(c.key); show(); });
    }
    if (e.target.closest('[data-a="folder"]')) {
      const folder = await pickFolder('Folder with new footage', 'Every video and photo inside is added to the project and used in the re-edit.');
      if (!folder) return;
      const before = new Set(S.media.map((m) => m.id));
      try { const r = await api('POST', `/api/import?p=${enc(S.proj)}`, { folder }); if (!r.added) return toast('No new media files in that folder'); } catch (err) { return toast(err.message, 'err'); }
      await waitNew(before, 'Reading the folder');
    }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'useInOut') { const io = inOut(); if (!io) return toast('No In / Out on the timeline (I and O set them)'); fillRange(io.in, io.out); Object.assign(sc, { kind: 'range', byHand: true, auto: false }); return show(); }
    if (a === 'plan') { await kit.flush(); return showPlan(body.querySelector('[data-plan]'), e.target.closest('[data-a]'), withWords(next())); }
    if (a === 'planclose') { const p = body.querySelector('[data-plan]'); p.hidden = true; p.innerHTML = ''; }
    if (a === 'go') {
      const quick = !!e.target.closest('[data-a="go"]').dataset.quick;
      await kit.flush();
      const n = next();
      if (!n.clips.length) return toast('No footage to edit with', 'err');
      if (sc.kind !== 'all' && badScope()) return toast(badScope(), 'err');
      dlg.close();
      // the built-in agent: a partial re-edit - the shots that still fit stay, only what the change touches is planned again
      if (quick) return runAgentWith(withWords(n), setBusy, { ask: false });
      // Claude re-edits: it gets what changed and the full settings, and rebuilds the edit the way it edits
      const ch = diffs(n).map((x) => `- ${x}`);
      const ask = box.value.trim();
      if (ask) ch.push(`- in the editor's own words: ${ask}`);
      const sct = sc.kind !== 'all' && scopeText(getScope());
      if (sct) ch.unshift(`- SCOPE: ${sct} (${JSON.stringify(getScope())}, timeline time in seconds) - keep everything outside exactly as it is: same shots, same in/out, same timing`);
      (kit.parsed?.understood || []).forEach((u) => ch.push(`  (understood: ${u})`));
      editWithClaude(n, 'edit', ch.length ? ch.join('\n') : '- nothing in the settings: make a fresh, better version of the edit');
    }
  });
  box.addEventListener('input', drawChanges);
  for (const n of ['scopeFrom', 'scopeTo']) f(n).addEventListener('input', () => { Object.assign(sc, { byHand: true, auto: false }); drawScope(); drawChanges(); });
  live = true; show();
  if (changes.ask) kit.read();
  setTimeout(() => box.focus());
}
