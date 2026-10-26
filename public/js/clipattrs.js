// clipattrs.js - 🎛 Clip Attributes, laid out like Resolve's: Stabilization, Lens Correction, Retime and Scaling (retime
// process, motion estimation, scaling, resize filter) and AI Super Scale - one place for what was spread over the Clip
// Speed dialog, the AI section and the framing menu. The renderer (engine/render2.mjs) does each one:
//   c.stabilize ''|light|medium|strong   vid.stab            c.lens -1..1          lenscorrection (- barrel, + pincushion)
//   c.smooth ''|'blend'|true             retime (only when the speed changes: slow motion or a ramp)
//   c.motionEst sfast|sbetter|efast|ebetter   how hard optical flow looks for movement (minterpolate)
//   c.fit fit|fill|stretch|blur          scaling            c.resize sharper|smoother|bicubic|bilinear|nearest
//   AI Super Scale: Real-ESRGAN (engine/enhance.py) makes a bigger, cleaner copy of the shot's piece (aiui.js enhanceClip)
import { S, commit, findClip } from './store.js';
import { esc, toast } from './ui.js';
import { STABILIZE } from './looks.js';
import { enhanceClip } from './aiui.js';

export const RETIME = [['', 'Nearest frame'], ['blend', 'Frame Blend'], [true, 'Optical Flow']];
export const MOTION_EST = [['', 'Project settings (Standard Better)'], ['sfast', 'Standard Faster'], ['sbetter', 'Standard Better'], ['efast', 'Enhanced Faster'], ['ebetter', 'Enhanced Better']];
export const SCALING = [['', 'Project settings'], ['fill', 'Crop'], ['fit', 'Fit'], ['stretch', 'Stretch'], ['blur', 'Fit, blurred background']];
export const RESIZE = [['', 'Project settings (Bicubic)'], ['sharper', 'Sharper (Lanczos)'], ['smoother', 'Smoother (Spline)'], ['bicubic', 'Bicubic'], ['bilinear', 'Bilinear'], ['nearest', 'Nearest (pixel art)']];

const opt = (list, v) => list.map(([o, l], i) => `<option value="${i}"${o === (v ?? '') || (o === true && v === true) ? ' selected' : ''}>${esc(l)}</option>`).join('');
// one line: the name on the left, the control on the right (as in Resolve's Inspector); hint: a small line under it
const row = (label, body, hint = '') => `<div class="ca-r"><span class="ca-l">${esc(label)}</span><div class="ca-c">${body}</div>${hint ? `<small class="ca-hint">${hint}</small>` : ''}</div>`;
// a group: its name, a dot that lights when it changes the shot, and Reset (puts its settings back)
const group = (t, on, keys, body) => `<section class="ca-g${on ? ' on' : ''}"><header><span class="ca-dot" title="${on ? 'Changes this shot' : 'Off'}"></span><b>${esc(t)}</b>
  ${keys && on ? `<button class="link small" data-ca-reset="${keys}" title="Put ${esc(t)} back as it was">Reset</button>` : ''}</header>${body}</section>`;

export function attrsHTML(c) {
  const m = S.mediaById?.[c.mediaId] || {}, slow = (c.speed && c.speed < 1) || !!c.ramp;
  const small = Math.min(m.width || 1920, m.height || 1080) < 1080, lens = +c.lens || 0;
  return `<div class="ca">
    ${group('Stabilization', !!c.stabilize, 'stabilize', row('Stabilize', `<select data-ca="stabilize">${opt(STABILIZE, c.stabilize)}</select>`))}
    ${group('Lens Correction', !!lens, 'lens', row('Distortion', `<input type="range" data-ca="lens" min="-1" max="1" step="0.05" value="${lens}"><output class="ca-v">${lens > 0 ? '+' : ''}${lens.toFixed(2)}</output>`,
      '− straightens barrel / fisheye · + pincushion'))}
    ${group('Retime and Scaling', !!(c.smooth || c.fit || c.resize), 'smooth,motionEst,fit,resize',
      row('Retime Process', `<select data-ca="smooth">${opt(RETIME, c.smooth)}</select>`, slow ? '' : 'Used when the clip is slowed down or ramped')
      + (c.smooth === true ? row('Motion Estimation', `<select data-ca="motionEst">${opt(MOTION_EST, c.motionEst)}</select>`) : '')
      + row('Scaling', `<select data-ca="fit">${opt(SCALING, c.fit)}</select>`)
      + row('Resize Filter', `<select data-ca="resize">${opt(RESIZE, c.resize)}</select>`))}
    ${group('AI Super Scale', false, '', `<p class="ca-note">${m.width ? `<b>Source ${m.width}×${m.height}.</b> ` : ''}${small ? 'Smaller than 1080p - Super Scale makes a sharper, bigger copy.' : 'Real-ESRGAN on the graphics card makes a bigger, cleaner copy of this shot.'} The shot then plays the copy (Original shot brings it back).</p>
      ${row('Size', `<select data-ca-ss-h><option value="1080"${small ? ' selected' : ''}>1080p (2×)</option><option value="2160"${small ? '' : ' selected'}>4K</option></select>`)}
      ${row('Detail', `<select data-ca-ss-model><option value="fast">Faster</option><option value="detail">Better (slow)</option></select>`)}
      ${row('Noise reduction', `<select data-ca-ss-dn><option value="0.7">Clean it</option><option value="0.4" selected>A little</option><option value="0">Keep the grain</option></select>`)}
      <button class="small primary ca-ss" data-ca-ss>✨ Super Scale this shot</button>`)}
  </div>`;
}

const LABEL = { stabilize: 'Stabilize', lens: 'Lens correction', smooth: 'Retime process', motionEst: 'Motion estimation', fit: 'Scaling', resize: 'Resize filter' };
const LISTS = { stabilize: STABILIZE, smooth: RETIME, motionEst: MOTION_EST, fit: SCALING, resize: RESIZE };
export function bindAttrs(root, id, render) {
  const clip = () => findClip(id)?.clip;
  root.querySelectorAll('[data-ca]').forEach((el) => {
    const k = el.dataset.ca;
    el.addEventListener(el.type === 'range' ? 'change' : 'change', () => {
      const c = clip(); if (!c) return;
      const v = el.type === 'range' ? +(+el.value).toFixed(2) : LISTS[k][+el.value][0];
      if (v === '' || v === 0 || v == null) delete c[k]; else c[k] = v;
      if (k === 'smooth' && c.smooth !== true) delete c.motionEst;
      commit(LABEL[k]); render();
    });
  });
  // the slider's number follows while dragging (the change itself is saved on release)
  root.querySelectorAll('input[data-ca="lens"]').forEach((el) => el.addEventListener('input', () => { const o = el.nextElementSibling, v = +el.value; if (o) o.textContent = `${v > 0 ? '+' : ''}${v.toFixed(2)}`; }));
  root.querySelectorAll('[data-ca-reset]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    const c = clip(); if (!c) return;
    for (const k of b.dataset.caReset.split(',')) delete c[k];
    commit('Reset clip attributes'); render();
  }));
  const ss = root.querySelector('[data-ca-ss]');
  if (ss) ss.onclick = async () => {
    const c = clip(); if (!c) return;
    const q = (s) => root.querySelector(s).value;
    ss.disabled = true;
    try { await enhanceClip(clip, { model: q('[data-ca-ss-model]'), height: +q('[data-ca-ss-h]'), denoise: +q('[data-ca-ss-dn]') }, (l) => { ss.textContent = l; }, render); }
    catch (e) { toast(e.message, 'err'); }
    finally { ss.disabled = false; ss.textContent = '✨ Super Scale this shot'; }
  };
}
