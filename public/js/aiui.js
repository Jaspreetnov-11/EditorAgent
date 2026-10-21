// 🤖 AI section of Effect Controls (video shots): 🎯 Follow faces (reframe), 🙈 Blur all faces, ✨ Smooth slow motion,
// 🧽 Clean up picture. The looking is done on the server (engine/vision.py); public/js/aitools.js makes the edits.
import { S, commit, findClip, emit, layout } from './store.js';
import { api, enc, watchJob } from './api.js';
import { ASPECTS } from './model.js';
import { toast } from './ui.js';
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

export function aiHTML(c) {
  if (c.type !== 'video') return '';
  const m = S.mediaById[c.mediaId], [W, H] = frame(), win = m ? fillWindow(m, W, H) : { axis: null };
  const following = c.keys?.cropX?.length || c.keys?.cropY?.length, autoMasks = (c.masks || []).filter((x) => x.auto === 'faces').length;
  const slow = (c.speed || 1) < 1 || c.ramp;
  return `<div class="ai-row"><button class="small" data-ai="follow"${win.axis ? '' : ' disabled title="This shot already has the shape of the frame - nothing to reframe"'} title="Fill the ${S.project.settings.aspect} frame and keep the person (the one speaking / moving) in it - pans for small moves, cuts between people">🎯 Follow faces</button>
      ${following ? '<button class="small" data-ai="unfollow">✕ Stop following</button>' : ''}</div>
    ${following ? `<small class="hint">The frame follows the faces (Crop position keyframes) - press Space to watch.</small>` : ''}
    <div class="ai-row"><button class="small" data-ai="blurfaces" title="Every face in this shot gets a moving blur (privacy: children, crowds, bystanders)">🙈 Blur all faces</button>
      ${autoMasks ? `<button class="small" data-ai="unblur">✕ Remove (${autoMasks})</button>` : ''}</div>
    <div class="ai-row"><button class="small" data-ai="hidearea" title="Draw a box on the Program monitor over a logo, a watermark or burnt-in text - it is removed (filled in from the picture around it), blurred, pixelated or blacked out for the whole shot">▭ Hide logo / text (mask)</button></div>
    ${(c.masks || []).map((mk, i) => (mk.area ? `<div class="ai-row"><span class="small">▭ Box ${(c.masks || []).slice(0, i + 1).filter((x) => x.area).length}</span><select data-mk-mode="${i}">${MASK_MODES.map(([v, l]) => `<option value="${v}"${mk.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select><button class="link small" data-mk-del="${i}" title="Take this box away">✕</button></div>` : '')).join('')}
    ${(c.masks || []).some((x) => x.area && x.type === 'remove') ? '<small class="hint">Remove fills the box in from the picture around it - the viewer shows it blurred; Accurate preview and the render show it removed.</small>' : ''}
    <label class="chk${slow ? '' : ' muted'}"><input type="checkbox" data-ai-smooth${c.smooth ? ' checked' : ''}${slow ? '' : ' disabled'}> ✨ Smooth slow motion (makes in-between frames)</label>
    ${slow ? '' : '<small class="hint">Set Speed below 1× (or a speed ramp) to use it.</small>'}
    <label class="fld"><span>🧽 Clean up picture</span><select data-ai-enh>${ENHANCE.map(([v, l]) => `<option value="${v}"${(c.enhance || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="ai-row"><button class="small" data-ai="followall" title="🎯 Follow faces on every video shot of the main story (V1) - e.g. after making a 9:16 copy of a 16:9 film">🎯 Follow faces on all V1 shots</button></div>
    <small class="hint">Smooth slow motion and Clean up show in Accurate preview and renders (they make the render slower).</small>`;
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
