// ✂️ Auto Reels: a long talk / speech / interview -> the best moments, each as its own 9:16 project with the speaker
// kept in frame and word-by-word captions; optionally rendered straight away (Instagram Reel preset).
import { S, emit, saveNow } from './store.js';
import { api, enc, watchJob } from './api.js';
import { fmt } from './model.js';
import { $, $$, h, esc, toast, modal, progressClock } from './ui.js';

const LENGTHS = [['15-30', '15-30 s (Shorts)'], ['20-45', '20-45 s'], ['30-60', '30-60 s (Reels)'], ['45-90', '45-90 s'], ['60-120', '1-2 min']];
const FACE = { tracked: ['Speaker tracked', 'ok'], vertical: ['Already vertical', 'ok'], none: ['No face found - blurred background', 'warn'] };

export function openReels(setBusy) {
  const videos = S.media.filter((m) => m.kind === 'video' && m.hasAudio && m.status === 'ready').sort((a, b) => b.duration - a.duration);
  if (!videos.length) return toast('Import the long video (a talk, speech or interview) first', 'err');
  const body = h(`<div class="ag rl">
    <div class="rl-form">
      <div class="fgrid">
        <label class="fld wide"><span>Long video</span><select name="mediaId">${videos.map((m) => `<option value="${m.id}">${esc(m.name)} (${fmt(m.duration)})</option>`).join('')}</select></label>
        <label class="fld"><span>Spoken language</span><select name="lang"><option value="hi">Hindi</option><option value="en">English</option><option value="auto" selected>Auto-detect / Hinglish</option></select></label>
        <label class="fld"><span>Listening accuracy</span><select name="model"><option value="small">Fast draft</option><option value="medium">Good</option><option value="large-v3-turbo" selected>Best</option></select></label>
        <label class="fld"><span>How many reels</span><select name="count">${[1, 2, 3, 4, 5, 6, 8, 10].map((n) => `<option${n === 3 ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="fld"><span>Length of each</span><select name="len">${LENGTHS.map(([v, l]) => `<option value="${v}"${v === '30-60' ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="fld wide"><span>Topics / keywords to look for (optional) - also improves spelling</span><input name="keywords" placeholder="Viksit Bharat, yuva, startup, Chhattisgarh, speaker names…"></label>
        <label class="chk"><input type="checkbox" name="tighten" checked> Cut out long pauses (tighter, faster reels)</label>
      </div>
      <div class="ag-foot"><span class="muted small">Long videos take a while: about 1 minute of listening for every 3-5 minutes of video.</span><span class="grow"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" data-a="find">Find the best moments</button></div>
    </div>
    <div class="rl-prog" hidden><div class="bar"><div></div></div><p class="muted small" data-msg></p></div>
    <div class="rl-res" hidden>
      <ul class="warns" data-warn hidden></ul>
      <div class="rl-top"><video data-prev controls playsinline></video>
        <div class="fgrid">
          <label class="fld"><span>Captions</span><select name="captions"><option value="karaoke">Word-by-word highlight</option><option value="plain">Plain lines</option><option value="none">No captions</option></select></label>
          <label class="fld"><span>Background music (optional, ducked)</span><select name="music"><option value="">None</option>${S.media.filter((m) => m.kind === 'audio').map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
          <label class="chk wide"><input type="checkbox" name="hookTitle" checked> Show the opening line as a title for the first 3 s</label>
          <p class="muted small wide">Each ticked moment becomes its own project (9:16) that you can still edit: trim, swap crops, fix caption words on Deliver. Your logo comes along.</p>
        </div></div>
      <div class="rl-list" data-list></div>
      <div class="ag-foot"><button type="button" data-a="back">Back</button><span class="grow"></span><button type="button" data-close>Close</button>
        <button type="button" data-a="make">Create reel projects</button><button type="button" class="primary" data-a="render">Create + render all</button></div>
    </div>
    <div class="rl-done" hidden></div>
  </div>`);
  const dlg = modal('Auto Reels - best moments from a long video', body, { width: 900 });
  const f = (n) => body.querySelector(`[name="${n}"]`);
  const show = (part) => ['form', 'prog', 'res', 'done'].forEach((p) => ($(`.rl-${p}`, body).hidden = p !== part));
  let found = null;
  const prev = $('[data-prev]', body);
  let stopAt = null;
  prev.addEventListener('timeupdate', () => { if (stopAt !== null && prev.currentTime >= stopAt) { prev.pause(); stopAt = null; } });

  let clock = progressClock();
  const progress = (p, msg) => {
    if (p <= 3) clock = progressClock();
    $('.rl-prog .bar div', body).style.width = `${Math.max(3, p)}%`;
    $('[data-msg]', body).textContent = `${Math.round(p)}% · ${clock.tick(p).text}${msg ? ` - ${msg}` : ''}`;
  };

  async function find() {
    const [minLen, maxLen] = f('len').value.split('-').map(Number);
    const req = { mediaId: f('mediaId').value, lang: f('lang').value, model: f('model').value, count: +f('count').value, minLen, maxLen, keywords: f('keywords').value.trim(), tighten: f('tighten').checked };
    show('prog'); progress(2, 'Starting…');
    setBusy?.(true, 'Finding reels…');
    try {
      const job = await api('POST', `/api/reels/find?p=${enc(S.proj)}`, req);
      const j = await watchJob(job.id, (x) => { progress(x.progress, x.stage); setBusy?.(true, `Reels ${x.progress}%`); });
      found = { ...j.result, mediaId: req.mediaId };
      drawResults();
      show('res');
    } catch (e) { show('form'); toast(e.job ? e.job.log.slice(-1)[0] : e.message, 'err'); }
    finally { setBusy?.(false); }
  }

  function drawResults() {
    const m = S.mediaById[found.mediaId];
    prev.src = m.urls.play;
    const w = found.warnings || [];
    $('[data-warn]', body).hidden = !w.length;
    $('[data-warn]', body).innerHTML = w.map((x) => `<li>${esc(x)}</li>`).join('');
    const best = Math.max(...found.candidates.map((c) => c.score), 1);
    $('[data-list]', body).innerHTML = found.candidates.map((c) => {
      const [fl, fk] = FACE[c.face] || FACE.none;
      return `<label class="rl-card${c.suggested ? '' : ' spare'}">
        <input type="checkbox" value="${c.id}"${c.suggested ? ' checked' : ''}>
        <div class="rl-main"><div class="rl-head"><b>#${c.rank}</b><span class="muted">${fmt(c.start)} - ${fmt(c.end)} in the video</span><span>→ ${Math.round(c.length)} s reel</span>
          <span class="meterbar" title="Score ${c.score}"><i style="width:${Math.round((c.score / best) * 100)}%"></i></span>
          <span class="rl-badge ${fk}">${fl}</span>${c.suggested ? '' : '<span class="muted small">spare</span>'}</div>
          <div class="rl-hook">“${esc(c.hook)}”</div>
          <div class="rl-text muted">${esc(c.text.length > 260 ? `${c.text.slice(0, 260)}…` : c.text)}</div>
          <div class="rl-why muted small">${why(c.parts)}</div></div>
        <button type="button" class="small" data-play="${c.start}" data-end="${c.end}">Watch</button></label>`;
    }).join('');
  }
  const why = (p) => [p.hook >= 0.6 && 'strong opening line', p.keywords > 0 && 'mentions your topics', p.applause > 0 && 'ends on applause / a reaction',
    p.energy > 0.6 && 'high energy', p.speech > 0.9 && 'no dead air', p.clean >= 0.8 && 'starts and ends cleanly'].filter(Boolean).join(' · ') || 'solid, complete thought';

  async function make(render) {
    const ids = $$('[data-list] input:checked', body).map((i) => i.value);
    if (!ids.length) return toast('Tick at least one moment', 'err');
    await saveNow();
    const req = { mediaId: found.mediaId, ids, captions: f('captions').value, hookTitle: f('hookTitle').checked, music: f('music').value || null, render };
    show('prog'); progress(3, render ? 'Building and rendering the reels…' : 'Building the reel projects…');
    setBusy?.(true, 'Making reels…');
    try {
      let r = await api('POST', `/api/reels/make?p=${enc(S.proj)}`, req);
      if (r.id && r.status) r = (await watchJob(r.id, (x) => { progress(x.progress, x.stage); setBusy?.(true, `Rendering ${x.progress}%`); })).result;
      const done = $('.rl-done', body);
      done.innerHTML = `<p><b>${r.projects.length} reel${r.projects.length > 1 ? 's' : ''} ready.</b> Each is its own project, so you can open it, adjust it and export it again.</p>
        <div class="rl-made">${r.projects.map((x) => `<div class="rl-made-i">
          ${x.url ? `<video src="${x.url}" controls playsinline preload="metadata"></video>` : '<div class="rl-ph">Not rendered yet</div>'}
          <b>${esc(x.project)}</b><span class="muted small">${Math.round(x.duration)} s${x.error ? ` · <span class="warn">render failed: ${esc(x.error)}</span>` : ''}</span>
          <div class="row-in">${x.url ? `<a class="btn small" href="${x.url}?download" download>Download</a>` : ''}<button type="button" class="small" data-open="${esc(x.project)}">Open project</button></div></div>`).join('')}</div>
        <div class="ag-foot"><button type="button" data-a="back">Back to moments</button><span class="grow"></span><button type="button" class="primary" data-close>Done</button></div>`;
      show('done');
      toast(`${r.projects.length} reel project${r.projects.length > 1 ? 's' : ''} created`);
    } catch (e) { show('res'); toast(e.job ? e.job.log.slice(-1)[0] : e.message, 'err'); }
    finally { setBusy?.(false); }
  }

  body.addEventListener('click', (e) => {
    const pl = e.target.closest('[data-play]');
    if (pl) { e.preventDefault(); prev.currentTime = +pl.dataset.play; stopAt = +pl.dataset.end; prev.play().catch(() => {}); return; }
    const op = e.target.closest('[data-open]');
    if (op) { dlg.close(); emit('openProject', op.dataset.open); return; }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'find') find();
    if (a === 'back') show(found ? 'res' : 'form');
    if (a === 'make') make(false);
    if (a === 'render') make(true);
  });
  // "Back" on the results page goes to the settings
  $('.rl-res [data-a="back"]', body).addEventListener('click', (e) => { e.stopPropagation(); show('form'); });
  show('form');
}
