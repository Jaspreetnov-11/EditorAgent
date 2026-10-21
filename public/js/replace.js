// 🔄 Replace clip: swap the media of a timeline clip for another, keeping its place, length, speed / ramp, cut
// effect, transition, motion and text. The new clip's best moment (from the agent's analysis), its start or its
// middle is used. With an agent edit, the agent's own runner-up shots for that slot are offered first.
import { S, commit, findClip } from './store.js';
import { api, enc } from './api.js';
import { clipDur, rampPts, rampAvg, fmt } from './model.js';
import { h, esc, toast, modal } from './ui.js';

const r3 = (x) => Math.round(x * 1000) / 1000;

// thumbnail of media m at source time t (its 12-frame filmstrip)
function thumbAt(m, t) {
  if (!m?.urls.strip || !m.duration) return m?.urls.thumb ? `background-image:url('${m.urls.thumb}');background-size:cover` : '';
  const k = Math.max(0, Math.min(11, Math.round((t / m.duration) * 12 - 0.5)));
  return `background-image:url('${m.urls.strip}');background-size:1200% 100%;background-position:${(k / 11) * 100}% 0`;
}

export async function replaceClip(id, mediaId, { at = 'best', inPoint = null } = {}) {
  const f = findClip(id), c = f?.clip, m = S.mediaById[mediaId];
  if (!c || !m) return false;
  const L = clipDur(c, S.mediaById); // the length it has on the timeline now
  if (m.kind === 'image') {
    Object.assign(c, { type: 'image', mediaId, dur: r3(L) });
    for (const k of ['in', 'out', 'speed', 'ramp', 'stabilize', 'color', 'mute', 'afx']) delete c[k];
  } else {
    if (c.type === 'image') { c.type = 'video'; delete c.dur; delete c.kenburns; }
    const span = L * (c.speed || 1) * (rampPts(c) ? rampAvg(rampPts(c)) : 1); // source seconds the shot needs
    let tin = inPoint;
    if (tin === null) tin = at === 'start' ? 0 : at === 'middle' ? Math.max(0, (m.duration - span) / 2)
      : (await api('GET', `/api/media/best?p=${enc(S.proj)}&id=${mediaId}&len=${span.toFixed(2)}`).catch(() => ({ in: 0 }))).in;
    tin = Math.max(0, Math.min(tin, Math.max(0, (m.duration || span) - span)));
    c.mediaId = mediaId; c.in = r3(tin); c.out = r3(Math.min(m.duration || tin + span, tin + span));
    delete c.color; delete c.afx; // the grade and audio clean-up belonged to the other clip
    if ((m.duration || 0) < span - 0.05) toast(`${m.name} is only ${fmt(m.duration)} long - this shot got shorter`, 'err');
  }
  delete c.mc;
  commit('Replace clip');
  return true;
}

export function openReplace(id) {
  const f = findClip(id), c = f?.clip;
  if (!c || !c.mediaId) return toast('Select a video or photo clip on the timeline', 'err');
  const audio = c.type === 'audio';
  const L = clipDur(c, S.mediaById);
  const pool = S.media.filter((m) => (audio ? m.kind === 'audio' : m.kind === 'video' || m.kind === 'image') && m.status === 'ready');
  // the agent's runner-up picks for this slot, if this is an agent edit
  const slot = S.project.agentReport?.slots?.find((s) => s.clipId === id);
  const alts = (slot?.alts || []).filter((a) => S.mediaById[a.mediaId]);
  const bins = [...new Set(pool.map((m) => m.bin || 'Other'))].sort();
  const body = h(`<div class="rp">
    <p class="muted small">Shot ${f.index + 1} on ${f.track} · ${fmt(L)} · now: <b>${esc(S.mediaById[c.mediaId]?.name || '')}</b>. The new clip keeps this place, length, speed, effects and transition.</p>
    ${alts.length ? `<div class="rp-h">✨ The agent's other choices for this moment</div><div class="rp-grid" data-alts>${alts.map((a, i) => `<button class="rp-tile" data-alt="${i}" title="${esc(S.mediaById[a.mediaId].name)}"><span class="th" style="${thumbAt(S.mediaById[a.mediaId], a.in)}"></span><small>${esc(S.mediaById[a.mediaId].name)}${a.match !== null && a.match !== undefined ? ` · match ${Math.round(a.match * 100)}` : ''}</small></button>`).join('')}</div>` : ''}
    <div class="row-in"><input type="search" placeholder="Search clips" data-q style="flex:1"><select data-bin><option value="">All folders</option>${bins.map((b) => `<option>${esc(b)}</option>`).join('')}</select>
      <select data-at title="Which part of the new clip"><option value="best">Best moment</option><option value="start">From its start</option><option value="middle">Its middle</option></select></div>
    <div class="rp-grid rp-all" data-all></div>
    <div class="ag-foot"><span class="grow"></span><button type="button" data-close>Cancel</button></div></div>`);
  const dlg = modal('🔄 Replace clip', body, { width: 760 });
  const draw = () => {
    const q = body.querySelector('[data-q]').value.toLowerCase(), b = body.querySelector('[data-bin]').value;
    const list = pool.filter((m) => m.id !== c.mediaId && (!q || m.name.toLowerCase().includes(q)) && (!b || (m.bin || 'Other') === b)).slice(0, 300);
    body.querySelector('[data-all]').innerHTML = list.map((m) => `<button class="rp-tile" data-m="${m.id}" title="${esc(m.name)}"><span class="th" style="${thumbAt(m, (m.duration || 0) / 2)}"></span><small>${esc(m.name)} · ${fmt(m.duration)}</small></button>`).join('') || '<p class="muted pad">No clips match.</p>';
  };
  body.addEventListener('input', draw);
  body.addEventListener('click', async (e) => {
    const alt = e.target.closest('[data-alt]'), one = e.target.closest('[data-m]');
    if (!alt && !one) return;
    dlg.close();
    const ok = alt ? await replaceClip(id, alts[+alt.dataset.alt].mediaId, { inPoint: alts[+alt.dataset.alt].in })
      : await replaceClip(id, one.dataset.m, { at: body.querySelector('[data-at]').value });
    if (ok) toast(`🔄 Replaced with ${S.mediaById[findClip(id).clip.mediaId].name}`);
  });
  draw();
}
