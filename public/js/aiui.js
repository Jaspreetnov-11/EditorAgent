// 🤖 AI section of Effect Controls (video shots): 🎯 Follow faces (reframe), 🙈 Blur all faces, ✨ Smooth slow motion,
// 🧽 Clean up picture. The looking is done on the server (engine/vision.py); public/js/aitools.js makes the edits.
import { S, commit, findClip, emit, layout } from './store.js';
import { api, enc, watchJob } from './api.js';
import { ASPECTS, seqOf } from './model.js';
import { esc, toast, modal } from './ui.js';
import { followKeys, faceMasks, fillWindow } from './aitools.js';

// ▭ what a box drawn over a logo / text does (clip.masks entries with area: true; tracking.js / render2.mjs)
const MASK_MODES = [['remove', 'Remove (fill from around)'], ['blur', 'Blur'], ['pixelate', 'Pixelate'], ['black', 'Black box']];
export const ENHANCE = [['', 'Off'], ['light', 'Light (clean noise)'], ['strong', 'Strong (old / phone / low-light footage)'], ['upscale', 'Strong + sharper upscale (small or SD footage)']];

async function look(c, label) {
  const m = S.mediaById[c.mediaId];
  emit('job', { running: true, label });
  try {
    const job = await api('POST', `/api/ai/vision?p=${enc(S.proj)}`, { mediaId: c.mediaId, in: c.in || 0, out: c.out ?? m.duration });
    return (await watchJob(job.id, (j) => emit('job', { running: true, label: `${label} ${j.progress}%` }))).result;
  } finally { emit('job', { running: false }); }
}
const frame = () => ASPECTS[S.project.settings.aspect] || [1920, 1080];

// 🎯 one shot; returns a short report or null
async function follow(c) {
  const m = S.mediaById[c.mediaId], [W, H] = frame(), { axis } = fillWindow(m, W, H);
  if (!axis) return { skip: 'already the shape of the frame' };
  if (c.ramp) return { skip: 'has a speed ramp' };
  const r = await look(c, '🎯 Finding faces…');
  const k = followKeys(r.samples, c, m, W, H);
  if (!k) return { skip: 'nothing to follow' };
  c.fit = 'fill';
  c.keys = { ...(c.keys || {}), [k.axis]: k.keys };
  return { moves: k.moves, faces: k.faces };
}

// 🎯 Auto Reframe Sequence (Sequence menu), like Premiere: a copy of the open sequence in another frame shape - 9:16 for
// reels, 1:1, 4:5 - opens, and every video shot on it fills the new frame and follows the faces (the one speaking /
// moving). The original sequence stays as it is.
export function autoReframeSequence() {
  const cur = S.project.settings.aspect, shapes = Object.keys(ASPECTS).filter((a) => a !== cur);
  const d = modal('🎯 Auto Reframe Sequence', `<p>A copy of <b>${esc(seqOf(S.project).name)}</b> (${cur}) is made in the new shape and opens; every video shot then follows the faces. The original stays as it is.</p>
    <div class="segbtns" role="radiogroup">${shapes.map((a, i) => `<button data-shape="${a}" aria-pressed="${i === 0}">${a}${a === '9:16' ? ' (reel)' : a === '1:1' ? ' (square)' : a === '4:5' ? ' (feed)' : ''}</button>`).join('')}</div>
    <p class="muted small">Reading the faces takes a few seconds per shot. Shots already of the new shape, speed-ramped or without anyone in them are left centred.</p>
    <div class="dlg-actions"><button class="accent" data-action="go">Make the reframed sequence</button><button data-close>Cancel</button></div>`, {
    width: 520,
    onAction: async (a) => {
      if (a !== 'go') return;
      const shape = d.el.querySelector('[data-shape][aria-pressed="true"]')?.dataset.shape || shapes[0];
      d.close();
      const { copySequenceAs } = await import('./sequences.js');
      copySequenceAs(shape);
      // a cinema letterbox (2.39 bars) on a taller frame leaves only a thin strip - the reframed copy goes without it
      const lb = S.project.settings.look?.letterbox;
      if (lb) S.project.settings.look = { ...S.project.settings.look, letterbox: undefined };
      const list = Object.entries(S.project.tracks).filter(([t]) => t[0] === 'V').flatMap(([, l]) => l).filter((x) => x.type === 'video' && !x.gap);
      let done = 0, skipped = 0;
      try {
        for (const [i, x] of list.entries()) {
          emit('job', { running: true, label: `🎯 Reframing shot ${i + 1}/${list.length}…` });
          try { const r = await follow(x); if (r.skip) { x.fit = 'fill'; skipped++; } else done++; } catch { skipped++; }
        }
      } finally { emit('job', { running: false }); }
      commit(`Auto Reframe ${shape}`);
      toast(`🎯 ${seqOf(S.project).name}: ${done} shot${done === 1 ? '' : 's'} follow the faces${skipped ? `, ${skipped} filled and centred` : ''}${lb ? ` - the ${lb} letterbox is off in this copy` : ''}`);
    },
  });
  d.el.addEventListener('click', (e) => { const b = e.target.closest('[data-shape]'); if (b) d.el.querySelectorAll('[data-shape]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
}

export function aiHTML(c) {
  if (c.type !== 'video') return '';
  const m = S.mediaById[c.mediaId], [W, H] = frame(), win = m ? fillWindow(m, W, H) : { axis: null };
  const following = c.keys?.cropX?.length || c.keys?.cropY?.length, autoMasks = (c.masks || []).filter((x) => x.auto === 'faces').length;
  const slow = (c.speed || 1) < 1 || c.ramp;
  // Generative Fill (Effect Controls): four plain groups - Reframe, Remove & hide, Enhance, Picture - no emoji
  const boxes = (c.masks || []).map((mk, i) => [mk, i]).filter(([mk]) => mk.area);
  return `<div class="gf">
    <div class="gf-g"><div class="gf-h">Reframe</div>
      <div class="gf-row"><button class="small" data-ai="follow"${win.axis ? '' : ' disabled title="This shot already has the shape of the frame - nothing to reframe"'} title="Fill the ${S.project.settings.aspect} frame and keep the person (the one speaking / moving) in it - pans for small moves, cuts between people">Follow faces</button>
        ${following ? '<button class="small" data-ai="unfollow">Stop following</button>' : ''}<button class="small" data-ai="followall" title="Follow faces on every video shot of the main story (V1) - e.g. after making a 9:16 copy of a 16:9 film">All V1 shots</button></div>
      ${following ? '<small class="hint">The frame follows the faces (Crop position keyframes) - press Space to watch.</small>' : ''}</div>
    <div class="gf-g"><div class="gf-h">Remove &amp; hide</div>
      <div class="gf-row"><button class="small" data-ai="hidearea" title="Draw a box on the Program monitor over a logo, a watermark or burnt-in text - it is removed (filled in from the picture around it), blurred, pixelated or blacked out for the whole shot">Draw a box over logo / text</button>
        <button class="small" data-ai="blurfaces" title="Every face in this shot gets a moving blur (privacy: children, crowds, bystanders)">Blur all faces</button>${autoMasks ? `<button class="small" data-ai="unblur">Remove face blur (${autoMasks})</button>` : ''}</div>
      ${boxes.map(([mk, i], k) => `<div class="gf-box"><span>Box ${k + 1}</span><select data-mk-mode="${i}">${MASK_MODES.map(([v, l]) => `<option value="${v}"${mk.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select><button class="link small" data-mk-del="${i}" title="Take this box away">Remove</button></div>`).join('')}
      ${boxes.length ? `<button class="small accent gf-wide" data-ai="aifill" title="Content-aware fill (AI, on the GPU): the boxes are filled in with what would be behind the logo / text, frame by frame - a new copy of this piece of the shot goes on the timeline (Ctrl+Z or Original shot brings it back)">Generative fill the boxes</button>
        <small class="hint">Makes a new copy of this shot with the boxes filled in (~10 s of work per second of video). Quick modes above: the viewer shows them blurred, the render applies them.</small>` : '<small class="hint">Draw a box, then fill it in with what would be behind it.</small>'}</div>
    <div class="gf-g"><div class="gf-h">Enhance</div>
      <div class="gf-grid"><label class="fld"><span>Model</span><select data-enh-model><option value="fast">Fast</option><option value="detail">Most detail (slow)</option></select></label>
        <label class="fld"><span>Size</span><select data-enh-h><option value="0">Same size</option><option value="1080">1080p</option><option value="2160">4K</option></select></label>
        <label class="fld"><span>Noise</span><select data-enh-dn><option value="0.7">Clean it</option><option value="0.4">A little</option><option value="0">Keep the grain</option></select></label></div>
      <button class="small accent gf-wide" data-ai="enhance" title="Real-ESRGAN on the GPU: noise and compression out, detail back, optionally bigger - a new copy of this piece of the shot goes on the timeline (Original shot brings it back). ~25 s of work per second of 1080p.">Enhance this shot</button></div>
    ${c.filled ? `<button class="small gf-wide" data-ai="unfill" title="Put the original shot back">Original shot (undo ${c.filled.kind === 'enhance' ? 'enhance' : 'fill'})</button>` : ''}
    <div class="gf-g"><div class="gf-h">Picture</div>
      <label class="chk${slow ? '' : ' muted'}"><input type="checkbox" data-ai-smooth${c.smooth ? ' checked' : ''}${slow ? '' : ' disabled'}> Smooth slow motion (makes in-between frames)</label>
      ${slow ? '' : '<small class="hint">Set Speed below 1× (or a speed ramp) to use it.</small>'}
      <label class="fld"><span>Clean up picture</span><select data-ai-enh>${ENHANCE.map(([v, l]) => `<option value="${v}"${(c.enhance || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <small class="hint">Smooth slow motion and Clean up show in Accurate preview and renders (they make the render slower).</small></div>
  </div>`;
}

// a new copy of the shot's piece (AI fill / AI enhance) takes its place on the timeline with the same timing; what was
// there is kept (clip.filled) for ↶ Original shot. areas: the boxes the copy has baked in (they come off the clip)
async function swapIn(clip, r, a0, a1, kind, areas) {
  const { refreshMedia } = await import('./mediapool.js');
  for (let i = 0; i < 60; i++) { await refreshMedia(); const n = S.mediaById[r.mediaId]; if (n && ['ready', 'error'].includes(n.status)) break; await new Promise((ok) => setTimeout(ok, 1000)); }
  const now = clip(); if (!now) return false;
  if (!now.filled) now.filled = { kind, mediaId: now.mediaId, in: a0, out: now.out, masks: areas };
  else now.filled.kind = kind; // (a copy of a copy: ↶ still goes back to the very first)
  now.mediaId = r.mediaId; now.in = 0; now.out = +(a1 - a0).toFixed(3);
  if (areas.length) { now.masks = (now.masks || []).filter((x) => !x.area); if (!now.masks.length) delete now.masks; }
  return true;
}

export function bindAi(root, id, render) {
  const clip = () => findClip(id)?.clip;
  root.querySelectorAll('[data-ai]').forEach((b) => b.addEventListener('click', async () => {
    const c = clip(); if (!c) return;
    const a = b.dataset.ai;
    b.disabled = true;
    try {
      if (a === 'follow') {
        const r = await follow(c);
        if (r.skip) toast(`Nothing to do: this shot ${r.skip}`);
        else { commit('Follow faces'); render(); toast(r.faces > 0.2 ? `🎯 The frame now follows the faces (${r.moves} move${r.moves === 1 ? '' : 's'}) - press Space to watch` : `🎯 Few faces in this shot - the frame follows the action instead (${r.moves} moves)`); }
      }
      if (a === 'unfollow') { delete c.keys.cropX; delete c.keys.cropY; if (!Object.keys(c.keys).length) delete c.keys; commit('Stop following faces'); render(); }
      if (a === 'blurfaces') {
        const r = await look(c, '🙈 Finding faces…'), masks = faceMasks(r.samples);
        if (!masks.length) toast('No faces found in this shot');
        else { c.masks = [...(c.masks || []).filter((x) => x.auto !== 'faces'), ...masks]; commit('Blur faces'); render(); toast(`🙈 ${masks.length} face${masks.length === 1 ? '' : 's'} blurred through the shot${r.yunet ? '' : ' (basic face finder - side faces may be missed)'}`); }
      }
      if (a === 'hidearea') {
        // the playhead goes onto this shot so the box is drawn over its picture
        const x = layout().V1.find((p) => p.clip.id === c.id) || Object.values(layout()).flat().find((p) => p.clip.id === c.id);
        if (!x) return;
        if (S.playhead < x.start || S.playhead >= x.end) { S.playhead = x.start + Math.min(0.5, (x.end - x.start) / 2); emit('playhead'); }
        const P = await import('./player.js'), box = await P.pickBox('Drag a box over the logo / text to hide (Esc cancels)');
        if (!box || box.w < 0.005 || box.h < 0.005) return;
        const s = P.frameBoxToSource(c, x.start, box), m = S.mediaById[c.mediaId];
        // a box that stays the whole shot: the same place at the start and the end of the file
        (c.masks ||= []).push({ id: Math.random().toString(36).slice(2, 9), area: true, exact: true, type: 'remove', path: [{ t: 0, ...s }, { t: Math.max(1, m?.duration || 1e6), ...s }] });
        commit('Hide an area (mask)'); render();
        toast('▭ Box added - it is removed in the render (the viewer shows it blurred). Change it to Blur / Pixelate / Black in Effect Controls.');
      }
      if (a === 'aifill') {
        const m = S.mediaById[c.mediaId], areas = (c.masks || []).filter((x) => x.area);
        if (!m || !areas.length) return toast('Draw a box over the logo / text first (▭ Hide logo / text)', 'err');
        const a0 = c.in || 0, a1 = c.out ?? m.duration;
        emit('job', { running: true, label: '✨ AI fill…' });
        // (it takes a while - ~10 s a second of video: the button itself says how far it is, so it never looks dead)
        b.textContent = '✨ Filling… starting'; toast(`✨ AI fill started - about ${Math.max(10, Math.round((a1 - a0) * 10))} s for this ${(a1 - a0).toFixed(1)} s shot`);
        const job = await api('POST', `/api/inpaint?p=${enc(S.proj)}`, { mediaId: c.mediaId, in: a0, out: a1, boxes: areas.map((x) => { const { t, ...b } = x.path[0]; return b; }) });
        const j = await watchJob(job.id, (x) => { const l = x.stage?.startsWith('Waiting') ? `✨ ${x.stage}` : `✨ Filling… ${x.progress || 0}%`; b.textContent = l; emit('job', { running: true, label: l }); });
        if (await swapIn(clip, j.result, a0, a1, 'fill', areas)) { commit('AI fill'); render(); toast('✨ Filled - the shot now plays the AI-filled copy (↶ Original shot brings it back)'); }
      }
      if (a === 'enhance') {
        const m = S.mediaById[c.mediaId]; if (!m) return;
        const a0 = c.in || 0, a1 = c.out ?? m.duration, q = (s) => root.querySelector(s).value;
        emit('job', { running: true, label: '✨ Enhancing…' });
        b.textContent = '✨ Enhancing… starting'; toast(`✨ AI enhance started - about ${Math.max(15, Math.round((a1 - a0) * (q('[data-enh-model]') === 'detail' ? 80 : 28)))} s for this ${(a1 - a0).toFixed(1)} s shot`);
        const job = await api('POST', `/api/enhance?p=${enc(S.proj)}`, { mediaId: c.mediaId, in: a0, out: a1, model: q('[data-enh-model]'), height: +q('[data-enh-h]'), denoise: +q('[data-enh-dn]') });
        const j = await watchJob(job.id, (x) => { const l = x.stage?.startsWith('Waiting') ? `✨ ${x.stage}` : `✨ Enhancing… ${x.progress || 0}%`; b.textContent = l; emit('job', { running: true, label: l }); });
        if (await swapIn(clip, j.result, a0, a1, 'enhance', [])) { commit('AI enhance'); render(); toast('✨ Enhanced - the shot now plays the enhanced copy (↶ Original shot brings it back)'); }
      }
      if (a === 'unfill') {
        const f = c.filled; if (!f) return;
        Object.assign(c, { mediaId: f.mediaId, in: f.in, ...(f.out !== undefined ? { out: f.out } : {}) });
        c.masks = [...(c.masks || []), ...(f.masks || [])]; delete c.filled;
        commit('Undo AI fill'); render();
      }
      if (a === 'unblur') { c.masks = c.masks.filter((x) => x.auto !== 'faces'); if (!c.masks.length) delete c.masks; commit('Remove face blur'); render(); }
      if (a === 'followall') {
        const list = S.project.tracks.V1.filter((x) => x.type === 'video');
        let done = 0, skipped = 0;
        for (const [i, x] of list.entries()) {
          emit('job', { running: true, label: `🎯 Shot ${i + 1}/${list.length}…` });
          try { const r = await follow(x); if (r.skip) skipped++; else done++; } catch { skipped++; }
        }
        commit('Follow faces on all shots'); render();
        toast(`🎯 ${done} shot${done === 1 ? '' : 's'} now follow the faces${skipped ? ` (${skipped} skipped: already the right shape, ramped or unreadable)` : ''}`);
      }
    } catch (e) { toast(e.job ? `Failed: ${e.job.log.slice(-1).join(' ')}` : e.message, 'err'); }
    finally { b.disabled = false; emit('job', { running: false }); }
  }));
  root.querySelectorAll('[data-mk-mode]').forEach((s) => (s.onchange = () => { const c = clip(); c.masks[+s.dataset.mkMode].type = s.value; commit('Mask: what it does'); render(); }));
  root.querySelectorAll('[data-mk-del]').forEach((b) => (b.onclick = () => { const c = clip(); c.masks.splice(+b.dataset.mkDel, 1); if (!c.masks.length) delete c.masks; commit('Remove mask'); render(); }));
  const sm = root.querySelector('[data-ai-smooth]');
  if (sm) sm.onchange = () => { const c = clip(); if (sm.checked) c.smooth = true; else delete c.smooth; commit('Smooth slow motion'); };
  const en = root.querySelector('[data-ai-enh]');
  if (en) en.onchange = () => { const c = clip(); if (en.value) c.enhance = en.value; else delete c.enhance; commit('Clean up picture'); };
}
