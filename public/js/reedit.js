// 🔁 Re-edit with AI: change the voice-over (pick one or upload a new file), the music, pace, format or finish,
// and the agent rebuilds the whole edit with the same footage and settings as last time. Ctrl+Z brings the old edit back.
import { S } from './store.js';
import { api, enc } from './api.js';
import { fmt } from './model.js';
import { $, h, esc, toast, modal } from './ui.js';
import { uploadAudioInto, uploadFiles, refreshMedia, pickFolder } from './mediapool.js';
import { runAgentWith, editWithClaude } from './agent.js';
import { scriptPicker } from './scriptedit.js';
import { defaultFootage, whyLeftOut } from './footagepick.js';
import { ideasLine } from './promptguide.js';

const PACES = [['fast', 'Fast cuts (~1.7 s)'], ['medium', 'Medium (~2.8 s)'], ['slow', 'Slow, cinematic (~4 s)']];
const ASPECTS = [['9:16', '9:16 Reel / Shorts'], ['16:9', '16:9 YouTube / Film'], ['1:1', '1:1 Square'], ['4:5', '4:5 Feed']];

// The settings of the edit on the timeline: what the agent used last time, or (for older edits) read off the timeline.
export function currentEditOpts() {
  const pj = S.project, saved = pj.agentOpts;
  if (saved) return { ...saved };
  const V1 = pj.tracks.V1, footage = [...new Set(V1.filter((c) => c.mediaId && S.mediaById[c.mediaId]).map((c) => c.mediaId))];
  const media = V1.filter((c) => c.type !== 'title'), avg = media.length ? media.reduce((s, c) => s + (c.dur || (c.out ?? 0) - (c.in || 0)), 0) / media.length : 2.8;
  const firstTitle = pj.tracks.V2.find((c) => c.type === 'title'), endCard = V1[V1.length - 1]?.type === 'title' ? V1[V1.length - 1] : null;
  return {
    clips: footage, vo: pj.tracks.A1[0]?.mediaId || null, voLang: 'hi', whisperModel: 'medium',
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
  const body = h(`<div class="ag re">
    <p class="muted">The agent rebuilds the edit with your changes. Same footage, and it again picks the best shot for every line. <b>Ctrl+Z</b> (or "undo" in the Assistant) brings the current edit back.</p>
    <div class="fgrid">
      <label class="fld wide" data-ask><span>What to change - in your words (Claude reads this; Quick re-edit does not)</span>
        <textarea name="ask" rows="2" placeholder="e.g. music dheema karo, pehle 5 sec mein CM sahab ka shot"></textarea></label>
      <div class="fld wide re-box${focus === 'vo' ? ' hi' : ''}"><span>Voice-over: the shots follow what is said</span>
        <div class="row-in"><select name="vo">${opt(audio(), o.vo, 'No voice-over')}</select><label class="btn small re-up">Upload new VO<input type="file" accept="audio/*,video/*" hidden name="voFile"></label></div>
        <small data-vonote></small></div>
      <label class="fld"><span>VO language</span><select name="voLang"><option value="hi">Hindi</option><option value="en">English</option><option value="auto">Auto-detect</option></select></label>
      <label class="fld"><span>Listening accuracy</span><select name="whisperModel"><option value="small">Fast</option><option value="medium">Good</option><option value="large-v3">Best (slow)</option></select></label>
      <div class="fld wide re-box${focus === 'music' ? ' hi' : ''}"><span>Music</span>
        <div class="row-in"><select name="music">${opt(audio(), o.music, 'No music')}</select><label class="btn small re-up">Upload music<input type="file" accept="audio/*" hidden name="musicFile"></label></div></div>
      <label class="chk"><input type="checkbox" name="musicBest"> Best part of the music, cuts on the beat</label>
      <label class="chk"><input type="checkbox" name="keepSound"> Keep some of the clips' own sound</label>
<label class="fld"><span>Clip speed</span><select name="clipSpeed"><option value="0.5">0.5x slow motion</option><option value="0.75">0.75x gentle slow-mo</option><option value="1" selected>1x normal</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x fast</option></select></label>
      <label class="fld"><span>Edit style</span><select name="editStyle"><option value="standard">Standard</option><option value="teaser">Cinematic teaser (trailer: slow open, build, fast climax)</option><option value="montage">Fast montage (cut on every beat)</option></select></label>
      <label class="fld"><span>Pace</span><select name="pace">${PACES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <label class="fld"><span>Format</span><select name="aspect">${ASPECTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <label class="fld"><span>Length</span><select name="target"><option value="15">15 s</option><option value="20">20 s</option><option value="30">30 s</option><option value="45">45 s</option><option value="60">1 min</option><option value="90">1.5 min</option><option value="120">2 min</option><option value="180">3 min</option><option value="300">5 min</option></select><small data-lennote></small></label>
      <div class="fld wide re-box"><span>Footage</span>
        <div class="row-in"><select name="footage"><option value="same">Same as this edit (${base.clips.length} clips)</option><option value="all">All the project's footage (${allFootage.length} - no logos, rejects or bad clips)</option></select>
          <label class="btn small">Add new clips<input type="file" hidden multiple name="clipFiles" accept="video/*,image/*,.mxf,.mts,.mov"></label><button type="button" class="btn small" data-a="folder">Add a folder</button></div>
        <small data-newclips></small></div>
      <label class="fld"><span>Transitions</span><select name="style"><option value="cuts">Clean cuts</option><option value="cinematic">Dissolves between ideas</option></select></label>
      <label class="chk"><input type="checkbox" name="autoColor"> Auto colour every shot</label>
      <label class="fld"><span>Film look (colour of the whole edit)</span><select name="look"><option value="">None (just balanced)</option><option selected>Teal & Orange</option><option>Warm Film</option><option>Golden Hour</option><option>Moody Dark</option><option>Travel Vivid</option><option>Indian Heritage</option><option>Bleach Bypass</option><option>Clean Natural</option></select></label>
      <label class="chk"><input type="checkbox" name="stabilize"> Stabilize shaky shots (slower render)</label>
        <label class="chk"><input type="checkbox" name="cinematic"> Cinematic finish (film grade, bars, vignette, grain)</label>
        <label class="chk"><input type="checkbox" name="fx" checked> Teaser effects (light leaks, whip, flash, shake on the cuts - teaser / montage styles)</label>
        <label class="chk"><input type="checkbox" name="sfx" checked> Sound design (whooshes, hits, a riser into the drop - teaser / montage styles)</label>
      <label class="chk"><input type="checkbox" name="subtitles"> Subtitles from the voice-over</label>
      <label class="fld"><span>Title on the first shot</span><input name="title"></label>
      <label class="fld"><span>End card</span><input name="endText"></label>
    </div>
    <div class="ag-foot"><span class="grow"></span><button type="button" data-close>Cancel</button><button type="button" data-a="go" data-quick="1" title="The fast built-in agent (no Claude)">Quick re-edit</button><button type="button" class="primary" data-a="go">Re-edit (Claude)</button></div>
  </div>`);
  const dlg = modal('Re-edit with AI', body, { width: 720 });
  const f = (n) => body.querySelector(`[name="${n}"]`);
  for (const k of ['voLang', 'whisperModel', 'pace', 'aspect', 'style', 'title', 'endText']) if (o[k] !== undefined) f(k).value = o[k];
  f('clipSpeed').value = String(o.clipSpeed || 1);
  f('editStyle').value = o.editStyle || 'standard';
  f('look').value = o.look ?? (S.project.settings.look?.lut || '').replace(' (look).cube', '');
  f('stabilize').checked = !!o.stabilize; f('fx').checked = o.fx !== false; f('sfx').checked = o.sfx !== false; f('cinematic').checked = !!(o.cinematic ?? +S.project.settings.look?.vignette);
  $('[data-ask]', body).append(ideasLine(() => f('ask'), { picks: ['music dheema karo', 'pehle 5 sec mein CM sahab ka shot', 'colour warm karo', 'opening slow hai, pehle 10 sec tight karo'] }));
  if (changes.ask) f('ask').value = changes.ask;
  const scr = { scenes: o.scenes || null };
  body.querySelector('.re-box').after(scriptPicker(scr));
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
  f('vo').onchange = () => { voNote(); lenNote(); }; voNote(); lenNote();

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
  };
  f('clipFiles').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    const before = new Set(S.media.map((m) => m.id));
    await uploadFiles(files);
    await waitNew(before, 'Reading the new clips');
  };
  body.addEventListener('click', async (e) => {
    if (e.target.closest('[data-a="folder"]')) {
      const folder = await pickFolder('Folder with new footage', 'Every video and photo inside is added to the project and used in the re-edit.');
      if (!folder) return;
      const before = new Set(S.media.map((m) => m.id));
      try { const r = await api('POST', `/api/import?p=${enc(S.proj)}`, { folder }); if (!r.added) return toast('No new media files in that folder'); } catch (err) { return toast(err.message, 'err'); }
      await waitNew(before, 'Reading the folder');
    }
  });
  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-a="go"]')) {
      const next = {
        ...base, vo: f('vo').value || null, voLang: f('voLang').value, whisperModel: f('whisperModel').value, music: f('music').value || null,
        musicBest: f('musicBest').checked, keepSound: f('keepSound').checked, pace: f('pace').value, aspect: f('aspect').value, style: f('style').value,
        autoColor: f('autoColor').checked, subtitles: f('subtitles').checked, title: f('title').value.trim(), endText: f('endText').value.trim(),
        target: +tg.value, clipSpeed: +f('clipSpeed').value, stabilize: f('stabilize').checked, cinematic: f('cinematic').checked, fx: f('fx').checked, sfx: f('sfx').checked, look: f('look').value, editStyle: f('editStyle').value, stock: false, scenes: scr.scenes?.length ? scr.scenes : undefined,
        clips: [...new Set([...(f('footage').value === 'all' ? allFootage.map((m) => m.id) : base.clips), ...extra])],
      };
      if (!next.clips.length) return toast('No footage to edit with', 'err');
      // a song picked as both: it is the voice-over (the shots follow its lyrics) and the music at once, laid once
      if (next.vo && next.vo === next.music) next.music = null;
      if (base.vo && base.vo === base.music) base.music = null;
      dlg.close();
      if (e.target.closest('[data-a="go"]').dataset.quick) return runAgentWith(next, setBusy, { ask: false });
      // 🧠 Claude re-edits: it gets what changed and the full settings, and rebuilds the edit the way it edits
      const label = { vo: 'voice-over', music: 'music', pace: 'pace', aspect: 'format', target: 'length', look: 'look', style: 'transitions', editStyle: 'edit style', clipSpeed: 'clip speed', title: 'title', endText: 'end card', subtitles: 'subtitles', autoColor: 'auto colour', cinematic: 'cinematic finish', fx: 'teaser effects', sfx: 'sound effects', stabilize: 'stabilize', keepSound: 'clip sound', musicBest: 'best part of the music' };
      const nm = (k, v) => ((k === 'vo' || k === 'music') && v ? `"${S.mediaById[v]?.name || v}"` : JSON.stringify(v ?? null));
      const ch = Object.keys(label).filter((k) => JSON.stringify(base[k] ?? null) !== JSON.stringify(next[k] ?? null)).map((k) => `- ${label[k]}: ${nm(k, base[k])} → ${nm(k, next[k])}`);
      if (next.clips.length !== base.clips.length) ch.push(`- footage: ${base.clips.length} → ${next.clips.length} files (new ones: use them)`);
      const ask = f('ask').value.trim();
      if (ask) ch.push(`- in the editor's own words: ${ask}`);
      editWithClaude(next, 'edit', ch.length ? ch.join('\n') : '- nothing in the settings: make a fresh, better version of the edit');
    }
  });
}
