// 🧠 Smart footage: the picture model looks at every clip once (engine/footage.py) - then shot tags in the pool
// (wide, close-up, drone, people…), "jharna dikhao" search, near-duplicate and problem clips, and matching the
// colour of several cameras to one of them.
import { S, emit, commit } from './store.js';
import { api, enc, watchJob } from './api.js';
import { fmt } from './model.js';
import { $, $$, esc, toast, modal, progressClock } from './ui.js';
import { refreshMedia } from './mediapool.js';
import { placeMedia } from './timeline.js';

export const TAGS = [['wide', 'Wide'], ['medium', 'Medium'], ['close-up', 'Close-up'], ['detail', 'Detail'], ['drone', 'Drone'], ['people', 'People'], ['crowd', 'Crowd'],
  ['outdoor', 'Outdoor'], ['indoor', 'Indoor'], ['sunset', 'Sunset'], ['night', 'Night'], ['text', 'Text']];
let footage = { dups: [] };
export const dupIds = () => new Set(footage.dups.flat());
export async function loadFootage() { try { footage = await api('GET', `/api/footage?p=${enc(S.proj)}`); } catch { footage = { dups: [] }; } emit('media'); }

const thumb = (m) => (m?.urls?.thumb ? `<span class="sm-th" style="background-image:url('${m.urls.thumb}')"></span>` : '<span class="sm-th"></span>');
const onTimeline = () => new Set(Object.values(S.project.tracks).flat().map((c) => c.mediaId));

export function openSmart(tab = 'scan', query = '') {
  const dlg = modal('🧠 Smart footage', `<div class="ptabs sm-tabs" role="tablist">
      <button role="tab" data-st="scan">Scan</button><button role="tab" data-st="find">🔎 Find</button><button role="tab" data-st="check">⚠ Check</button><button role="tab" data-st="cams">🎨 Cameras</button></div>
    <div class="sm-body" data-body></div>`, { width: 760 });
  const body = $('[data-body]', dlg.el);
  const show = (t) => { $$('[data-st]', dlg.el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.st === t))); ({ scan, find, check, cams })[t](body, dlg, query); query = ''; };
  dlg.el.addEventListener('click', (e) => { const t = e.target.closest('[data-st]')?.dataset.st; if (t) show(t); });
  const scanned = S.media.some((m) => m.tags);
  show(scanned ? tab : 'scan');
}

// ---- Scan ----
function scan(body) {
  const vis = S.media.filter((m) => (m.kind === 'video' || m.kind === 'image') && !m.seqOf), done = vis.filter((m) => m.tags).length;
  body.innerHTML = `<p>The editor looks at every clip once and learns what is in it. Then:</p>
    <ul class="muted"><li><b>Tags</b> in Media: wide / medium / close-up / detail, drone, people, crowd, sunset, night…</li>
      <li><b>🔎 Find</b> a shot by what it shows - "jharna dikhao", "पहाड़ पर बादल", "crowd at night"</li>
      <li><b>⚠ Check</b>: near-identical copies and clips that are too dark, soft, shaky or very short</li></ul>
    <p class="muted small">${done}/${vis.length} clips looked at. Runs on this computer (no internet). Big camera files are read once (only their key frames); clips the ✨ Agent has already seen are quick.</p>
    <button class="primary" data-go>${done ? 'Look again (new clips too)' : 'Look at all footage'}</button>
    <div class="job" data-job hidden><div class="job-top"><span data-l></span><span data-t></span></div><div class="bar"><div data-b></div></div></div>`;
  $('[data-go]', body).onclick = async (e) => {
    e.target.disabled = true;
    const box = $('[data-job]', body); box.hidden = false;
    try {
      const job = await api('POST', `/api/footage/scan?p=${enc(S.proj)}`, {});
      const clock = progressClock();
      const j = await watchJob(job.id, (x) => { $('[data-l]', body).textContent = x.stage || 'Looking…'; $('[data-b]', body).style.width = `${Math.max(2, x.progress)}%`; $('[data-t]', body).textContent = clock.tick(x.progress).text; emit('job', { running: true, label: `Smart scan ${x.progress}%` }); });
      await refreshMedia(); await loadFootage(); emit('media');
      const r = j.result;
      $('[data-l]', body).textContent = `Done: ${r.tagged} clips tagged · ${r.dups.length} group${r.dups.length === 1 ? '' : 's'} of near-copies · ${r.bad.length} clip${r.bad.length === 1 ? '' : 's'} to check`;
      toast('Smart scan done - tags are in Media; try 🔎 Find');
    } catch (err) { toast(err.job ? `Scan failed: ${err.job.log.slice(-1).join(' ')}` : err.message, 'err'); box.hidden = true; }
    finally { e.target.disabled = false; emit('job', { running: false }); }
  };
}

// ---- Find ----
function find(body, dlg, query) {
  body.innerHTML = `<div class="row-in"><input data-q placeholder='e.g. jharna dikhao · पहाड़ पर बादल · crowd at night · drone shot of a temple' aria-label="Find shots by what they show"><button class="primary" data-go>Find</button></div>
    <p class="muted small" data-info>Type what the shot should show, in Hindi, Hinglish or English. Click a result to open it in the Source viewer at that moment.</p>
    <div class="sm-res" data-res></div>`;
  const q = $('[data-q]', body);
  const go = async () => {
    if (!q.value.trim()) return;
    $('[data-info]', body).textContent = 'Looking… (the first search loads the picture model, a few seconds)';
    try {
      const r = await api('POST', `/api/footage/search?p=${enc(S.proj)}`, { q: q.value });
      const top = r.results[0]?.score || 0, list = r.results.filter((x) => x.score > Math.max(0.17, top - 0.08));
      $('[data-info]', body).innerHTML = `Searched for <b>${esc(r.q)}</b> - ${list.length} good match${list.length === 1 ? '' : 'es'}, best first.`;
      $('[data-res]', body).innerHTML = list.map((x) => { const m = S.mediaById[x.id]; return m ? `<div class="sm-hit" data-id="${x.id}" data-t="${x.t}" title="Open at ${fmt(x.t)}">
          ${thumb(m)}<div class="grow"><div class="sm-name">${esc(m.name)}</div><div class="muted small">at ${fmt(x.t)}${m.tags ? ` · ${esc(m.tags.join(', '))}` : ''}</div>
          <div class="sm-score"><i style="width:${Math.round(Math.min(1, Math.max(0, (x.score - 0.15) / 0.2)) * 100)}%"></i></div></div>
          <button class="small" data-add="${x.id}" data-t="${x.t}" title="Put 4 seconds around that moment at the end of V1">+ Timeline</button></div>` : ''; }).join('') || '<div class="muted pad">Nothing looks like that. Try other words.</div>';
    } catch (e) { $('[data-info]', body).textContent = e.message; }
  };
  $('[data-go]', body).onclick = go;
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('[data-res]', body).addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const m = S.mediaById[add.dataset.add], t = +add.dataset.t, a = Math.max(0, t - 1.5), b = Math.min(m.duration || t + 2.5, a + 4);
      if (placeMedia(m.id, 'V1', 1e9, m.kind === 'video' ? { in: +a.toFixed(2), out: +b.toFixed(2) } : {})) { commit('Add found shot'); toast(`${m.name} (${fmt(a)}-${fmt(b)}) added at the end of V1`); }
      return;
    }
    const hit = e.target.closest('[data-id]');
    if (hit) { dlg.close(); emit('openSource', { id: hit.dataset.id, t: +hit.dataset.t }); }
  });
  if (query) { q.value = query; go(); } else setTimeout(() => q.focus(), 50);
}

// ---- Check: near-duplicates + problem clips ----
async function check(body) {
  await loadFootage();
  const tl = onTimeline(), bad = S.media.filter((m) => m.bad?.length && !m.seqOf), groups = footage.dups.map((g) => g.map((id) => S.mediaById[id]).filter(Boolean)).filter((g) => g.length > 1);
  body.innerHTML = `<h4>Near-identical clips (${groups.length})</h4>
    <p class="muted small">The same shot imported twice, or two takes that look the same. Moving the extra copies to a "Duplicates" folder keeps the media pool clean - nothing is deleted.</p>
    <div class="sm-list">${groups.map((g, i) => `<div class="sm-grp">${g.map((m) => `<div class="sm-mini" data-open="${m.id}" title="${esc(m.name)}">${thumb(m)}<span class="small">${esc(m.name)}${tl.has(m.id) ? ' <b class="good">● on timeline</b>' : ''}<br><span class="muted">${fmt(m.duration)} · ${esc(m.bin || '')}</span></span></div>`).join('')}
      <button class="small" data-dup="${i}" title="Keep the first (or the one on the timeline), move the others">Move copies to Duplicates</button></div>`).join('') || '<div class="muted pad">None found.</div>'}</div>
    <h4>Clips worth a second look (${bad.length})</h4>
    <div class="sm-list">${bad.map((m) => `<div class="sm-hit" data-open="${m.id}">${thumb(m)}<div class="grow"><div class="sm-name">${esc(m.name)}${tl.has(m.id) ? ' <b class="good">● on timeline</b>' : ''}</div><div class="warn small">${esc(m.bad.join(' · '))}</div></div></div>`).join('') || '<div class="muted pad">Nothing looks wrong.</div>'}</div>
    ${bad.length ? '<div class="dv-actions"><button data-rej>Move these to a "Rejects" folder</button></div>' : ''}`;
  const move = async (ids, bin) => { await api('POST', `/api/media/bin?p=${enc(S.proj)}`, { ids, bin }); await refreshMedia(); toast(`${ids.length} clip${ids.length > 1 ? 's' : ''} moved to the "${bin}" folder in Media`); };
  body.onclick = async (e) => {
    const d = e.target.closest('[data-dup]');
    if (d) { const g = groups[+d.dataset.dup], keep = g.find((m) => tl.has(m.id)) || g[0]; await move(g.filter((m) => m !== keep).map((m) => m.id), 'Duplicates'); return check(body); }
    if (e.target.closest('[data-rej]')) { await move(bad.filter((m) => !tl.has(m.id)).map((m) => m.id), 'Rejects'); if (bad.some((m) => tl.has(m.id))) toast('Clips that are on the timeline stayed where they were', ''); return check(body); }
    const o = e.target.closest('[data-open]'); if (o) emit('openSource', o.dataset.open);
  };
}

// ---- Cameras: one colour across several cameras ----
function cams(body) {
  const clips = Object.entries(S.project.tracks).filter(([t]) => t[0] === 'V').flatMap(([, l]) => l).filter((c) => c.type === 'video' && S.mediaById[c.mediaId]?.camera);
  const groups = {};
  for (const c of clips) (groups[S.mediaById[c.mediaId].camera] ||= []).push(c);
  const keys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  body.innerHTML = keys.length < 2 ? `<p>Every video clip on this timeline comes from ${keys.length ? 'one camera' : 'no camera yet'} (same format, size and frame rate) - nothing to match.</p>
      <p class="muted small">Clips count as one camera when they share codec, frame size, frame rate and bit depth.</p>`
    : `<p>Clips on this timeline come from <b>${keys.length} cameras</b>. Pick the camera whose colour you like - the others are matched to it (a correction laid over each clip's own grade; Undo takes it back).</p>
    <div class="sm-list">${keys.map((k, i) => `<label class="sm-cam"><input type="radio" name="refcam" value="${esc(k)}"${i === 0 ? ' checked' : ''}>
      <span class="sm-thumbs">${groups[k].slice(0, 4).map((c) => thumb(S.mediaById[c.mediaId])).join('')}</span><span class="grow"><b>${esc(k)}</b><br><span class="muted small">${groups[k].length} clip${groups[k].length > 1 ? 's' : ''}</span></span></label>`).join('')}</div>
    <p class="muted small">Grade the reference camera first (Color page) if you want its look to travel. Best for the same scene shot by different cameras.</p>
    <div class="dv-actions"><button class="primary" data-go>Match the other cameras</button></div><div class="muted" data-st></div>`;
  const b = $('[data-go]', body);
  if (!b) return;
  b.onclick = async () => {
    const ref = $('input[name="refcam"]:checked', body).value;
    b.disabled = true;
    try {
      const job = await api('POST', `/api/footage/matchcams?p=${enc(S.proj)}`, { ref, clips: clips.map((c) => ({ id: c.id, mediaId: c.mediaId, in: c.in, out: c.out, color: c.color })) });
      const j = await watchJob(job.id, (x) => { $('[data-st]', body).textContent = x.stage || 'Measuring…'; });
      let n = 0;
      for (const { fix, clips: ids } of Object.values(j.result.cameras)) for (const id of ids) {
        const c = clips.find((x) => x.id === id); if (!c) continue;
        c.color = layOver(c.color || {}, fix); n++;
      }
      commit('Match cameras'); emit('select');
      $('[data-st]', body).textContent = `${n} clip${n === 1 ? '' : 's'} matched to ${ref}.`;
      toast(`Cameras matched: ${n} clips now look like ${ref} - Undo (Ctrl+Z) takes it back`);
    } catch (e) { toast(e.job ? `Matching failed: ${e.job.log.slice(-1).join(' ')}` : e.message, 'err'); }
    finally { b.disabled = false; }
  };
}
// A per-channel correction (out = in * (1 + g) + o, measured on the graded picture) laid over a grade: the grade's own
// gain / offset are composed with it, so what was there stays and the correction comes after it.
function layOver(color, fix) {
  const c = JSON.parse(JSON.stringify(color)), G = c.gain || {}, O = c.offset || {};
  const gain = { ...G }, offset = { ...O };
  for (const ch of ['r', 'g', 'b']) {
    const k = 1 + (fix.gain[ch] || 0), f = fix.offset[ch] || 0;
    const g0 = 1 + (G.y || 0) + (G[ch] || 0), o0 = (O.y || 0) + (O[ch] || 0);
    gain[ch] = +(g0 * k - 1 - (G.y || 0)).toFixed(4);
    offset[ch] = +(o0 * k + f - (O.y || 0)).toFixed(4);
  }
  return { ...c, gain: { y: G.y || 0, ...gain }, offset: { y: O.y || 0, ...offset } };
}
