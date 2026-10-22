// 📋 Paste Attributes / Remove Attributes (right-click a clip, Ctrl+Alt+V), like Premiere: what a copied clip (Ctrl+C)
// has - its motion, opacity, speed, volume, effects, colour - put on the selected clips in one go, the parts ticked in
// the box; or those parts taken off the selected clips. A clip's file, place and length are never touched (a speed
// pasted on keeps each clip's length on the timeline - keepLength - so nothing after it moves).
import { S, commit, findClip } from './store.js';
import { clipDur, keepLength } from './model.js';
import { clipboard } from './clipboard.js';
import { $$, esc, toast, modal } from './ui.js';

// each part: the clip fields it is, and its keyframe lanes (clip.keys[name]) - a lane belongs to the part whose field
// it starts with ("transform.zoom" -> Motion)
const PARTS = [
  ['motion', 'Motion (position, scale, rotation, crop, framing)', ['transform', 'cropX', 'cropY', 'fit'], ['transform', 'crop']],
  ['opacity', 'Opacity and blend mode', ['opacity', 'blend'], ['opacity']],
  ['time', 'Time remapping (speed, speed ramp, reverse)', ['speed', 'ramp', 'rampPts', 'reverse', 'smooth', 'keepPitch'], []],
  ['volume', 'Volume and audio clean-up', ['volume', 'afx', 'mute'], ['volume']],
  ['effects', 'Video effects, masks, stabilise, cut effect', ['effects', 'masks', 'stabilize', 'enhance', 'cutFx'], []],
  ['color', 'Colour (grade, LUT, look)', ['color'], []],
  ['fades', 'Fades in / out', ['fadeIn', 'fadeOut'], []],
];
const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const selected = () => [...S.sel].map((id) => findClip(id)?.clip).filter((c) => c && !c.gap);
const laneOf = (lanes, k) => lanes.some((l) => k === l || k.startsWith(`${l}.`) || k.startsWith(l));

function ask(title, intro, has, go) {
  const d = modal(title, `<p class="muted small">${intro}</p>
    <div class="pa-list">${PARTS.map(([k, label]) => `<label class="chk${has(k) ? '' : ' muted'}"><input type="checkbox" data-pa="${k}"${has(k) ? ' checked' : ' disabled'}> ${esc(label)}</label>`).join('')}</div>
    <div class="dv-actions"><button class="primary" data-ok>OK</button><button data-close>Cancel</button></div>`, { width: 460 });
  d.el.querySelector('[data-ok]').onclick = () => { const ks = $$('[data-pa]', d.el).filter((x) => x.checked).map((x) => x.dataset.pa); d.close(); if (ks.length) go(ks); };
}

export function pasteAttributes() {
  // (a copied picture comes with its linked sound: the picture's attributes are the ones meant)
  const cb = clipboard(), items = cb?.kind === 'clips' ? cb.items || [] : [], src = (items.find((i) => i.clip?.type === 'video') || items[0])?.clip;
  if (!src) return toast('Copy a clip first (Ctrl+C), then select the clips to paste its attributes on', 'err');
  const to = selected();
  if (!to.length) return toast('Select the clips to paste on', 'err');
  const has = (k) => { const [, , f, lanes] = PARTS.find((p) => p[0] === k); return f.some((x) => src[x] !== undefined) || Object.keys(src.keys || {}).some((x) => laneOf(lanes, x)); };
  ask('Paste Attributes', `From the copied clip onto ${to.length} selected clip${to.length > 1 ? 's' : ''}:`, has, (ks) => {
    for (const c of to) {
      const D = clipDur(c, S.mediaById);
      for (const k of ks) {
        const [, , fields, lanes] = PARTS.find((p) => p[0] === k);
        for (const f of fields) { if (src[f] === undefined) delete c[f]; else c[f] = copy(src[f]); }
        if (lanes.length) {
          for (const l of Object.keys(c.keys || {})) if (laneOf(lanes, l)) delete c.keys[l];
          for (const [l, v] of Object.entries(src.keys || {})) if (laneOf(lanes, l)) (c.keys ||= {})[l] = copy(v);
        }
      }
      if (c.keys && !Object.keys(c.keys).length) delete c.keys;
      if (ks.includes('time')) keepLength(S.project, c, D, S.mediaById);
    }
    commit(`Paste attributes (${ks.join(', ')})`);
    toast(`Pasted on ${to.length} clip${to.length > 1 ? 's' : ''}`);
  });
}

export function removeAttributes() {
  const to = selected();
  if (!to.length) return toast('Select the clips first', 'err');
  const has = (k) => { const [, , f, lanes] = PARTS.find((p) => p[0] === k); return to.some((c) => f.some((x) => c[x] !== undefined) || Object.keys(c.keys || {}).some((x) => laneOf(lanes, x))); };
  ask('Remove Attributes', `Take these off ${to.length} selected clip${to.length > 1 ? 's' : ''} (back to plain):`, has, (ks) => {
    for (const c of to) {
      const D = clipDur(c, S.mediaById);
      for (const k of ks) {
        const [, , fields, lanes] = PARTS.find((p) => p[0] === k);
        for (const f of fields) delete c[f];
        for (const l of Object.keys(c.keys || {})) if (laneOf(lanes, l)) delete c.keys[l];
      }
      if (c.keys && !Object.keys(c.keys).length) delete c.keys;
      if (ks.includes('time')) keepLength(S.project, c, D, S.mediaById);
    }
    commit(`Remove attributes (${ks.join(', ')})`);
    toast(`Removed from ${to.length} clip${to.length > 1 ? 's' : ''}`);
  });
}
