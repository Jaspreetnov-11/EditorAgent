// Inspector: properties of the selected clip, or project settings when nothing is selected.
import { guarded } from './errlog.js';
import { S, on, emit, commit, findClip, layout, duration, saveNow } from './store.js';
import { ASPECTS, shapeLabel, TRANSITIONS, clipDur, fmt, parseTime, fmtTC, KEYABLE, propAt, hasKeys, RAMPS, EASES, BLEND_MODES, setTransition, keepLength } from './model.js';
import { api, enc } from './api.js';
import { openTemplates } from './titlesui.js';
import { CUTFX } from './fx.js';
import { VFX, VFX_CATS, newEffect, defaultsOf } from './effects.js';
import { anglesFor, switchAngle } from './multicam.js';
import { openDub } from './voiceover.js';
import { openReplace } from './replace.js';
import { saveFxPreset } from './library.js';
import { trackingHTML, bindTracking } from './trackui.js';
import { aiHTML, bindAi } from './aiui.js';
import { gfxInspector, bindGfxInspector } from './gfxui.js';
import { FX_PRESETS, FX_DEFAULT } from './audiofx.js';
import { AFX, AFX_CATS, ATRANS, newAudioEffect, afxDefaults } from './audioeffects.js';

// 🔊 Essential Sound types: [key, label, what it does]
const ESSENTIAL = [['dialogue', 'Dialogue', 'Speech: voice clean-up (rumble, noise, harsh s, even level)'], ['music', 'Music', 'Music bed: music EQ, at half level, ducks under speech'],
  ['sfx', 'SFX', 'Sound effect: no clean-up, a little under full level'], ['ambience', 'Ambience', 'Room tone / crowd / nature: softened, well under the speech']];
function applySoundType(c, k) {
  if (!k) { delete c.soundType; return; }
  c.soundType = k;
  const fx = { dialogue: 'voice', music: 'music', ambience: 'ambience' }[k];
  if (fx) c.afx = { ...FX_DEFAULT, ...FX_PRESETS[fx].fx }; else delete c.afx;
  if (k === 'music') c.duck = true; else delete c.duck;
  if (c.volume === undefined || c.volume === 1) { const v = { music: 0.5, sfx: 0.8, ambience: 0.4 }[k]; if (v) c.volume = v; else delete c.volume; }
}
import { FILM_LOOKS, lookLut, LETTERBOX, STABILIZE, applyCinematic, removeCinematic, stabilizeAll } from './looks.js';
import { $, $$, esc, fieldsHTML, bindFields, toast, modal, getPath, setPath } from './ui.js';
import { mountRamp } from './rampui.js';
import { MASK_SHAPES, newMask } from './shapemask.js';
import { gyroHTML, bindGyro } from './gyroui.js';
import { kgTwirl, kgRow, mountKeyGraphs } from './kfgraph.js';
import { inSel, pickKeys, moveKeys, settleKeys, deleteKeys } from './kfsel.js';

let lastClip = null;
let root, selfCommit = false, openSections = new Set(['clip', 'transform', 'text', 'audio', 'transition', 'project', 'logo', 'vfx', 'cutfx', 'omask']);

export function mountInspector(el) {
  root = el;
  on('select', render);
  on('change', () => { if (!selfCommit) render(); });
  on('media', render);
  on('playhead', () => updateKeyUI());
  on('maskEdit', () => { root.querySelectorAll('[data-medit]').forEach((b) => { const sc = b.closest('[data-mscope]').dataset.mscope, on2 = !!S.maskEdit && (S.maskEdit.effId || 'clip') === sc; b.classList.toggle('on', on2); b.textContent = on2 ? '✎ Editing on monitor' : '✎ Edit on monitor'; }); });
  on('inspect', (sec) => { openSections.add(sec); document.querySelector('.ui-dock [data-dock="ec"]')?.click(); render(); $(`[data-sec="${sec}"]`, root)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  root.addEventListener('click', (e) => {
    const s = e.target.closest('.isec > summary');
    if (s) { const k = s.parentElement.dataset.sec; setTimeout(() => (s.parentElement.open ? openSections.add(k) : openSections.delete(k))); }
  });
  render();
}

const sec = (key, title, body, extra = '') => `<details class="isec" data-sec="${key}"${openSections.has(key) ? ' open' : ''}><summary>${title}${extra}</summary><div class="fgrid">${body}</div></details>`;
const timeDef = (k, label, ph) => ({ k, label, type: 'time', fmt: (v) => (v === undefined ? '' : fmt(v)), ph });

function doCommit(label, key) { selfCommit = true; commit(label, key); selfCommit = false; }

function render() { return guarded(root, 'Effect Controls', renderNow); }
function renderNow() {
  if (!root || !S.project) return;
  if (S.sel.size === 1) return renderClip([...S.sel][0]);
  if (S.sel.size > 1) {
    root.innerHTML = `<div class="ihead"><b>${S.sel.size} clips selected</b></div>
      <div class="ibody"><p class="muted">Shift/Ctrl-click to add or remove clips. Drag one to move them together.</p>
      <button class="danger wide" data-a="del">Delete ${S.sel.size} clips</button></div>`;
    $('[data-a="del"]', root).onclick = () => emit('deleteSelected');
    return;
  }
  renderProject();
}

// ---------------- clip ----------------
function renderClip(id) {
  const f = findClip(id);
  if (!f) { root.innerHTML = ''; return; }
  const c = f.clip, m = S.mediaById[c.mediaId], track = f.track, L = layout()[track].find((x) => x.clip.id === id);
  const obj = c, isVid = c.type === 'video', isImg = c.type === 'image', isTitle = c.type === 'title', isAud = c.type === 'audio', isAdj = c.type === 'adjust';
  const head = `<div class="ec-title">Effect Controls</div><div class="ihead"><span class="trk">${track}</span><b title="${esc(m?.name || '')}">${esc(isTitle ? 'Title' : isAdj ? '◩ Adjustment layer' : m?.name || 'Missing media')}</b>
    <span class="muted">${fmtTC(L?.start || 0, S.project.settings.fps)} · ${fmt((L?.end || 0) - (L?.start || 0))}</span></div>`;
  let html = '';
  if (c.gap) { // a lifted clip's empty place on the main story
    root.innerHTML = `<div class="ec-title">Effect Controls</div><div class="ihead"><span class="trk">${track}</span><b>Gap</b><span class="muted">${fmtTC(L?.start || 0, S.project.settings.fps)} · ${fmt((L?.end || 0) - (L?.start || 0))}</span></div>
      <div class="ibody"><p class="muted small">An empty place in the story (black, silent when played) - left by a deleted clip so nothing after it moved. Drop a clip from Media here, or close it.</p><div class="iactions"><button class="danger" data-a="del">⇤ Close gap</button></div></div>`;
    root.onclick = (e) => { if (e.target.closest('[data-a="del"]')) emit('deleteSelected'); };
    return;
  }
  if (c.type === 'graphic') {
    root.innerHTML = `<div class="ec-title">Effect Controls</div><div class="ihead"><span class="trk">${track}</span><b>Motion graphic</b><span class="muted">${fmtTC(L?.start || 0, S.project.settings.fps)} · ${fmt((L?.end || 0) - (L?.start || 0))}</span></div><div class="ibody">${gfxInspector(c)}<div class="iactions"><button data-a="dup">Duplicate</button><button class="danger" data-a="del">Delete</button></div></div>`;
    bindGfxInspector(root, id, render);
    root.onclick = (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'del') emit('deleteSelected'); if (a === 'dup') emit('duplicateSelected'); };
    return;
  }

  const clipDefs = [];
  if (track !== 'V1') clipDefs.push(timeDef('start', 'Starts at (timeline)', '0:00.0'));
  if (isVid || isAud) clipDefs.push(timeDef('in', 'Source In', '0:00.0'), timeDef('out', 'Source Out', 'end of file'),
    { k: 'speed', label: 'Speed', type: 'select', options: [['', '1×'], [0.25, '0.25×'], [0.5, '0.5× slow-mo'], [0.75, '0.75×'], [1.25, '1.25×'], [1.5, '1.5×'], [2, '2×'], [3, '3×'], [4, '4×']] });
  if (isVid) clipDefs.push({ k: 'ramp', label: 'Speed ramp (speed changes inside the shot)', type: 'select', options: [['', 'None'], ...Object.entries(RAMPS).map(([k, r]) => [k, r.label]), ['custom', 'Custom (draw it in Speed ramp below)']] });
  const ang = isVid && anglesFor(c);
  if (ang) clipDefs.unshift({ k: 'mcAngle', label: 'Camera angle (multicam - stays in sync)', type: 'select', options: ang.map((a) => [a.mediaId, S.mediaById[a.mediaId]?.name || a.mediaId]) });
  if (isVid) clipDefs.push({ k: 'stabilize', label: 'Stabilize (shaky footage)', type: 'select', options: STABILIZE });
  if (isImg || isTitle || isAdj) clipDefs.push({ k: 'dur', label: 'Duration', type: 'num', min: 0.2, step: 0.1, unit: 'sec', def: isTitle ? 3 : 4 });
  if (isAdj) clipDefs.push({ k: 'opacity', label: 'Strength (how much of it shows)', type: 'range', min: 0, max: 1, step: 0.01, def: 1 });
  if (isAud) clipDefs.push({ k: 'loop', label: 'Loop to fill a longer duration', type: 'check' }, ...(c.loop ? [{ k: 'dur', label: 'Loop length', type: 'num', min: 0.5, step: 0.5, unit: 'sec' }] : []));
  if (isVid || isImg) clipDefs.push({ k: 'fit', label: 'Framing', type: 'select', options: [['', 'Project default'], ['fit', 'Fit (letterbox)'], ['fill', 'Fill (crop)'], ['blur', 'Blur background']] },
    ...(track !== 'V1' ? [{ k: 'blend', label: 'Blend mode', type: 'select', options: BLEND_MODES }] : []));
  if (isImg) clipDefs.push({ k: 'kenburns', label: 'Ken Burns', type: 'select', options: [['', 'Project default'], ['in', 'Zoom in'], ['out', 'Zoom out'], [false, 'Static']] });
  if (isVid) html += `<details class="isec" data-sec="ramp"${openSections.has('ramp') || c.ramp ? ' open' : ''}><summary>Speed ramp${c.ramp ? ' <span class="tag">on</span>' : ''}</summary><div class="ramp-ed" data-ramp-ed></div></details>`;
  // (the 'Clip' section was removed on request - speed ramp stays in its own section above)
  void clipDefs;

  if (!isAud && !isAdj && !(isTitle && track !== 'V1')) {
    // 🎬 like Premiere's Effect Controls: one line per property - ⏱ animate on / off, its name, its value (drag it left /
    // right, or click and type), ◂ ◆ ▸ and its keyframes on a little timeline of the clip, all in the same line
    html += sec('transform', 'Motion', motionHTML(c, (L?.end || 0) - (L?.start || 0), isVid, (isVid || isImg) && track) + `<div class="motion-presets"><button class="small" data-motion="zin">Zoom in</button><button class="small" data-motion="zout">Zoom out</button>
      <button class="small" data-motion="pan">Pan →</button><button class="small" data-motion="panl">← Pan</button><button class="small" data-motion="clear">Reset</button></div>`);
  }
  if (isVid) html += sec('ai', 'Generative Fill', aiHTML(c));
  if (isVid) html += sec('gyro', `Gyroflow (gyro stabilize)${c.gyroflow ? ' <span class="tag">on</span>' : ''}`, gyroHTML(c));
  if (isVid || (track !== 'V1' && (isImg || isTitle))) html += sec('trk', 'Tracking', trackingHTML(c, track));
  if (isVid || isImg) html += sec('cutfx', `Cut effect${c.cutFx?.type ? ` <span class="tag">${esc(CUTFX[c.cutFx.type]?.label || c.cutFx.type)}</span>` : ''}`, fieldsHTML([
    { k: 'cutFx.type', label: 'Effect (plays on the cut into this shot)', type: 'select', options: [['', 'None'], ...Object.entries(CUTFX).map(([k, x]) => [k, x.label])] },
    ...(c.cutFx?.type ? [{ k: 'cutFx.dur', label: 'Effect length', type: 'num', min: 0.1, max: 3, step: 0.05, unit: 'sec', def: CUTFX[c.cutFx.type]?.dur }] : [])], obj));
  if (isVid || isImg) html += sec('omask', `◐ Opacity mask${c.omask?.shape ? ' <span class="tag">on</span>' : ''}`, maskHTML(c.omask, 'clip', id) + `<small class="hint">${track === 'V1' ? 'Only the inside shows - the rest is black.' : 'Only the inside shows - the tracks below show around it.'} Exact in Accurate preview and renders.</small>`);
  if (isVid || isImg || isAdj || (isTitle && track === 'V1')) html += sec('vfx', `✦ Video effects${c.effects?.length ? ` <span class="muted">${c.effects.length}</span>` : ''}`, effectsHTML(c, track));

  if (isTitle) { // (a shot's lower-third text is not in Effect Controls any more - only a title's own words and look)
    const tdefs = [{ k: 'text', label: isTitle ? 'Title text' : 'Text (super / lower third)', type: 'area', rows: 3, ph: isTitle ? 'युवा शक्ति\nYuva Shakti' : 'Name, Designation, Place', wide: true }];
    if (!(isTitle && track === 'V1')) tdefs.push({ k: 'textStyle', label: 'Position', type: 'select', options: [['', isTitle ? 'Center' : 'Lower third'], ['lower', 'Lower third'], ['top', 'Top'], ['center', 'Center']] });
    if (!isTitle) tdefs.push({ k: 'textDuration', label: 'Show for', type: 'num', min: 0, step: 0.5, unit: 'sec', ph: 'whole clip' });
    tdefs.push({ k: 'size', label: 'Font size', type: 'num', min: 10, step: 2, unit: 'px @1080', ph: 'auto' }, { k: 'textColor', label: 'Colour', type: 'color', def: '#ffffff' });
    if (isTitle && track === 'V1') tdefs.push({ k: 'bg', label: 'Background', type: 'color', def: '#0b2545' });
    if (isTitle) tdefs.push(
      { k: 'box', label: 'Box', type: 'select', options: [['', 'Auto'], ['none', 'No box'], ['#0b2545', 'Navy'], ['#e8740c', 'Saffron'], ['#000000', 'Black'], ['#ffffff', 'White'], ['#b71c1c', 'Red'], ['#138808', 'Green']] },
      { k: 'accent', label: 'Accent bar', type: 'select', options: [['', 'None'], ['#ff9933', 'Saffron'], ['#138808', 'Green'], ['#ffffff', 'White'], ['#ffd28a', 'Gold']] },
      ...(track === 'V2' ? [{ k: 'strip', label: 'Full-width strip', type: 'select', options: [['', 'None'], ['#0b2545', 'Navy'], ['#b71c1c', 'Red'], ['#e8740c', 'Saffron'], ['#000000', 'Black']] },
        { k: 'anim', label: 'Animation', type: 'select', options: [['', 'Fade'], ['slide', 'Slide in'], ['words', 'Kinetic: one word at a time'], ['build', 'Kinetic: words add up'], ['none', 'None']] }] : []),
      { k: 'tricolour', label: 'Tricolour band', type: 'check' });
    html += sec('text', isTitle ? 'Title' : 'Text', fieldsHTML(tdefs, obj) + (isTitle ? '<div class="iactions"><button class="small accent" data-a="tplstyle">Change style (templates)</button></div>' : ''));
  }

  if (false) { // (colour lives on the Color page)
    html += sec('color', 'Color (quick)', fieldsHTML([
      { k: 'color.lut', label: 'LUT', type: 'select', options: [['', 'None'], ...S.luts.map((l) => [l, l])] },
      { k: 'color.exposure', label: 'Exposure', type: 'range', min: -3, max: 3, step: 0.05, def: 0, unit: 'stops' },
      { k: 'color.temp', label: 'Temperature', type: 'range', min: -1, max: 1, step: 0.01, def: 0 },
      { k: 'color.tint', label: 'Tint', type: 'range', min: -1, max: 1, step: 0.01, def: 0 },
      { k: 'color.contrast', label: 'Contrast', type: 'range', min: 0.3, max: 2, step: 0.01, def: 1 },
      { k: 'color.saturation', label: 'Saturation', type: 'range', min: 0, max: 2.5, step: 0.01, def: 1 },
    ], obj) + '<small class="hint">Full wheels, scopes and auto colour arrive with the Color page (Phase 2). Live preview is approximate; renders are exact.</small>');
  }

  if (isAud) { // (a video's sound: its linked audio clip, the Audio page and the timeline's volume line)
    const adefs = [{ k: 'volume', label: 'Volume', type: 'range', min: 0, max: 2, step: 0.01, def: track === 'V2' ? 0 : 1 }, { k: 'mute', label: 'Mute this clip', type: 'check' }];
    if (isAud) adefs.push({ k: 'fadeIn', label: 'Fade in', type: 'num', min: 0, step: 0.25, unit: 'sec' }, { k: 'fadeOut', label: 'Fade out', type: 'num', min: 0, step: 0.25, unit: 'sec' });
    // 🎚 the fades' shape (Premiere's Crossfade transitions)
    if (isAud && (c.fadeIn || c.fadeOut)) adefs.push({ k: 'fadeInCurve', label: 'Fade in shape', type: 'select', options: ATRANS.map(([k, l]) => [k, l]) }, { k: 'fadeOutCurve', label: 'Fade out shape', type: 'select', options: ATRANS.map(([k, l]) => [k, l]) });
    if (track === 'A2') adefs.push({ k: 'duck', label: 'Duck under speech (clip sound + voice-over)', type: 'check' });
    const afxNow = Object.entries(FX_PRESETS).find(([, p]) => JSON.stringify({ ...FX_DEFAULT, ...p.fx }) === JSON.stringify({ ...FX_DEFAULT, ...(c.afx || {}) }))?.[0] || (c.afx ? 'custom' : 'flat');
    const clean = track === 'A2' || !(isVid ? m?.hasAudio : true) ? '' : `<div class="iactions"><label class="fld"><span>Clean-up (this clip only)</span><select data-afx>${Object.entries(FX_PRESETS).map(([k, p]) => `<option value="${k}"${k === afxNow ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}${afxNow === 'custom' ? '<option value="custom" selected>Custom</option>' : ''}</select></label>
      <button class="small accent" data-a="autoclean" title="Measures the noise between words and picks a clean-up">Auto clean</button>
      <button class="small" data-a="dub" title="Speak this clip's lines again with an AI voice: translated to English, re-voiced, or your own lines">Dub / re-voice</button></div><small class="hint">Clean-up is heard in Accurate preview and renders.</small>`;
    // 🔊 Essential Sound: what this sound is - the clean-up / level / ducking that suits it goes on with one click
    const ess = `<div class="iactions es-row"><span class="es-l" title="Essential Sound, like Premiere: tag the clip and its settings follow">Audio type</span><div class="segbtns">${ESSENTIAL.map(([k, l, tip]) => `<button data-es="${k}" aria-pressed="${c.soundType === k}" title="${tip}">${l}</button>`).join('')}</div></div>`;
    html += sec('audio', 'Audio', ess + fieldsHTML(adefs, obj) + clean + (track === 'A2' ? '<button class="accent wide" data-a="best">Use the best part of this music</button>' : ''));
    if (!isVid || m?.hasAudio) html += sec('aeffects', `Audio effects${c.aeffects?.length ? ` <span class="muted">${c.aeffects.length}</span>` : ''}`, aeffectsHTML(c));
  }

  if (false) { // (a transition is changed by clicking it on the timeline)
    const t = c.transitionIn || { type: 'cut', dur: 0.5 };
    html += sec('transition', 'Transition in', fieldsHTML([
      { k: 'transitionIn.type', label: 'Type', type: 'select', options: TRANSITIONS },
      { k: 'transitionIn.dur', label: 'Duration', type: 'num', min: 0.1, max: 5, step: 0.1, unit: 'sec', def: 0.5 },
    ], { transitionIn: t }) + '<button class="small" data-a="transAll">Apply to all cuts</button>');
  }
  if (false) {
    html += sec('fades', 'Fade to black', fieldsHTML([
      { k: 'fadeIn', label: 'Fade in', type: 'num', min: 0, step: 0.25, unit: 'sec' },
      { k: 'fadeOut', label: 'Fade out', type: 'num', min: 0, step: 0.25, unit: 'sec' },
    ], obj));
  }
  html += `<div class="iactions">${c.mediaId ? '<button data-a="replace" title="Swap this clip for another one - same place, length and effects">Replace…</button>' : ''}<button data-a="split">Split at playhead</button><button data-a="dup">Duplicate</button><button class="danger" data-a="del">Delete</button></div>`;
  // (the same clip drawn again - after adding a mask, an effect… - stays scrolled where it was)
  const keep = lastClip === id ? [root.scrollTop, root.querySelector('.ibody')?.scrollTop || 0] : null; lastClip = id;
  root.innerHTML = head + `<div class="ibody">${html}</div>`;
  if (keep) { root.scrollTop = keep[0]; const ib = root.querySelector('.ibody'); if (ib) ib.scrollTop = keep[1]; }
  // ⏩ the speed ramp graph (presets + draw your own)
  const rampBox = root.querySelector('[data-ramp-ed]');
  if (rampBox) mountRamp(rampBox, () => findClip(id)?.clip, () => emit('live'), (label) => { doCommit(label); const s = root.querySelector('[data-k="ramp"], select[name="ramp"]'); if (s) s.value = findClip(id)?.clip.ramp || ''; });
  addKeyButtons(id);
  bindMotion(id);
  bindEffects(id);
  bindAEffects(id); // (🔊)
  bindMasks(id);
  bindGyro(root, id, render);
  bindTracking(root, id, render);
  bindAi(root, id, render);
  bindKeyLane(id);
  bindKeyGraphs(id);

  const parse = { in: parseTime, out: parseTime, start: parseTime };
  bindFields(root, () => findClip(id)?.clip, {
    parse,
    live: (k, v) => { if (k.startsWith('transitionIn')) return; keyValue(id, k, v); emit('live'); },
    commit: (k, v) => {
      const cl = findClip(id)?.clip; if (!cl) return;
      if (k === 'mcAngle') { delete cl.mcAngle; if (switchAngle(cl, v)) { doCommit('Switch camera angle'); render(); } return; }
      if (k === 'in' || k === 'out') validateTimes(cl);
      const D0 = k === 'speed' || k === 'ramp' ? clipDur(cl, S.mediaById) : 0; // 📌 the shot keeps its length (keepLength)
      keyValue(id, k, v);
      if (k === 'loop' && v && !cl.dur) cl.dur = +Math.max(5, duration() - (cl.start || 0)).toFixed(2);
      if (k === 'textColor' && v === '#ffffff') delete cl.textColor;
      if (k === 'cutFx.type') { if (!v) delete cl.cutFx; else cl.cutFx.dur = CUTFX[v].dur; }
      if (k === 'ramp') { if (v === 'custom') cl.rampPts ||= [[0, 1], [0.4, 1], [0.6, 0.35], [1, 0.35]]; else delete cl.rampPts; }
      cleanup(cl);
      if (D0) keepLength(S.project, cl, D0, S.mediaById);
      doCommit(`Change ${k}`, `${id}:${k}`);
      if (['loop', 'in', 'out', 'speed', 'ramp', 'cutFx.type'].includes(k)) render();
    },
  });
  // 🔊 Essential Sound: the type on this clip and every other selected sound clip
  root.querySelectorAll('[data-es]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.es, cl = findClip(id)?.clip; if (!cl) return;
    const off = cl.soundType === k, list = [...new Set([id, ...S.sel])].map((x) => findClip(x)?.clip).filter((x) => x && (x.type === 'audio' || (x.type === 'video' && S.mediaById[x.mediaId]?.hasAudio)));
    for (const x of list) applySoundType(x, off ? null : k);
    doCommit(off ? 'Audio type off' : `Audio type: ${k}`); render();
    toast(off ? 'Audio type taken off (its settings stay)' : `${ESSENTIAL.find((e) => e[0] === k)[1]} on ${list.length} clip${list.length > 1 ? 's' : ''}${k === 'music' ? ' - ducks under speech on the music track (A2)' : ''}`);
  }));
  root.querySelector('[data-afx]')?.addEventListener('change', (e) => {
    const cl = findClip(id)?.clip, k = e.target.value; if (!cl || k === 'custom') return;
    if (k === 'flat') delete cl.afx; else cl.afx = { ...FX_DEFAULT, ...FX_PRESETS[k].fx };
    doCommit('Clip clean-up');
  });
  // transition fields edit c.transitionIn (bound to a temp object above)
  $$('[data-sec="transition"] [data-k]', root).forEach((el) => el.addEventListener('change', () => {
    const cl = findClip(id)?.clip, type = $('[data-sec="transition"] [data-k="transitionIn.type"]', root).value;
    const dur = +$('[data-sec="transition"] [data-k="transitionIn.dur"]', root).value || 0.5;
    // (the cut stays put and no shot gets shorter: model.js setTransition)
    if (!setTransition(S.project, S.mediaById, findClip(id).index, type === 'cut' ? null : type, dur) && type !== 'cut') toast('These shots have no frames to spare beyond their ends for a transition', 'err');
    doCommit('Transition');
  }));
  root.onclick = async (e) => {
    if (onKeyClick(e, id)) return;
    if (e.target.closest('[data-a="tplstyle"]')) return openTemplates({ target: id });
    const mo = e.target.closest('[data-motion]')?.dataset.motion;
    if (mo) return motionPreset(id, mo);
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'del') emit('deleteSelected');
    if (a === 'dup') emit('duplicateSelected');
    if (a === 'split') emit('splitAtPlayhead');
    if (a === 'transAll') {
      const tr = findClip(id)?.clip.transitionIn;
      S.project.tracks.V1.forEach((cl, i) => { if (i > 0) setTransition(S.project, S.mediaById, i, tr?.type || null, tr?.dur || 0); });
      commit('Transition on all cuts'); toast(tr ? `${tr.type} on every cut` : 'All transitions removed');
    }
    if (a === 'dub') return openDub(id);
    if (a === 'replace') return openReplace(id);
    if (a === 'autoclean') {
      const b = e.target.closest('button'), cl = findClip(id)?.clip; if (!cl) return;
      b.disabled = true; b.textContent = 'Listening…';
      try {
        const r = await api('GET', `/api/audio/autoclean?p=${enc(S.proj)}&id=${cl.mediaId}&in=${cl.in || 0}&out=${cl.out ?? ''}`);
        cl.afx = r.fx; doCommit('Auto clean audio'); render();
        toast(`${r.label} - speech is ${r.snr} dB above the noise`);
      } catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = 'Auto clean'; }
    }
    if (a === 'best') {
      const b = e.target.closest('button'), cl = findClip(id)?.clip;
      const len = Math.max(5, Math.ceil(duration() - (cl.start || 0)));
      b.disabled = true; b.textContent = 'Listening…';
      try {
        const best = await api('GET', `/api/music/best?p=${enc(S.proj)}&id=${cl.mediaId}&dur=${len}`);
        Object.assign(cl, { in: best.in, out: best.out, loop: true, dur: len });
        commit('Best part of music');
        toast(`Music now uses ${fmt(best.in)} → ${fmt(best.out)}${best.bpm ? ` (~${best.bpm} BPM)` : ''}`);
      } catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = 'Use the best part of this music'; }
    }
  };
}

// ---------------- video effects (clip.effects, public/js/effects.js) ----------------
// ---------------- 🔊 audio effects (public/js/audioeffects.js) ----------------
function aeffectsHTML(c) {
  const list = (c.aeffects || []).map((e, i) => {
    const def = AFX[e.type]; if (!def) return '';
    const params = Object.entries(def.params).map(([k, p]) => {
      const v = e.p?.[k] ?? p.def;
      if (p.type === 'select') return `<label class="fld"><span>${esc(p.label)}</span><select data-aep="${k}">${p.options.map(([o, l]) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
      return `<label class="fld"><span>${esc(p.label)} <b data-aev="${k}">${v}${p.unit || ''}</b></span><input type="range" data-aep="${k}" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}"></label>`;
    }).join('');
    const note = def.meter ? `<div class="row-in"><button class="small accent" data-ameasure>Measure this clip</button><span class="muted small" data-ameter>${e.last ? esc(e.last) : 'Loudness (LUFS), range and true peak - after the effects above it'}</span></div>`
      : !def.live ? '<small class="hint">Heard in Accurate preview and renders.</small>' : def.hint ? `<small class="hint">${esc(def.hint)}</small>` : '';
    return `<div class="efx${e.on === false ? ' off' : ''}" data-aefx="${e.id}">
      <div class="efx-h"><button class="icon-btn small" data-aea="toggle" title="${e.on === false ? 'Turn on' : 'Turn off'}" aria-label="On / off">${e.on === false ? '◌' : '●'}</button><b>${esc(def.label)}</b><span class="grow"></span>
        <button class="icon-btn small" data-aea="up" title="Earlier in the order"${i === 0 ? ' disabled' : ''}>▲</button><button class="icon-btn small" data-aea="down" title="Later in the order"${i === c.aeffects.length - 1 ? ' disabled' : ''}>▼</button>
        <button class="icon-btn small" data-aea="reset" title="Reset to defaults">↺</button><button class="icon-btn small" data-aea="del" title="Remove effect">✕</button></div>
      ${params ? `<div class="fgrid">${params}</div>` : ''}${note}</div>`;
  }).join('');
  const opts = AFX_CATS.map((cat) => `<optgroup label="${esc(cat)}">${Object.entries(AFX).filter(([, x]) => x.cat === cat).map(([k, x]) => `<option value="${k}">${esc(x.label)}</option>`).join('')}</optgroup>`).join('');
  return `<div class="efx-list">${list || '<p class="muted small">No audio effects yet.</p>'}</div>
    <div class="row-in"><select data-addafx><option value="">+ Add audio effect…</option>${opts}</select></div>
    <small class="hint">Applied top to bottom after the clean-up, before the volume. Heard while playing (except where it says so). More in the Effects panel.</small>`;
}
function bindAEffects(id) {
  const get = (el) => { const c = findClip(id)?.clip, e = c?.aeffects?.find((x) => x.id === el.closest('[data-aefx]')?.dataset.aefx); return { c, e }; };
  root.querySelectorAll('[data-aep]').forEach((inp) => {
    const k = inp.dataset.aep;
    inp.addEventListener('input', () => {
      const { e } = get(inp); if (!e) return;
      e.p = { ...(e.p || {}), [k]: inp.tagName === 'SELECT' ? inp.value : +inp.value };
      const lab = inp.closest('[data-aefx]').querySelector(`[data-aev="${k}"]`); if (lab) lab.textContent = `${inp.value}${AFX[e.type].params[k].unit || ''}`;
      emit('live');
    });
    inp.addEventListener('change', () => doCommit(`Audio effect ${k}`, `${id}:afx:${k}`));
  });
  root.querySelector('[data-addafx]')?.addEventListener('change', (ev) => {
    const t = ev.target.value; if (!t) return;
    const c = findClip(id)?.clip; (c.aeffects ||= []).push(newAudioEffect(t));
    openSections.add('aeffects'); doCommit(`Add ${AFX[t].label}`); render();
  });
  root.querySelectorAll('[data-aea]').forEach((b) => b.addEventListener('click', () => {
    const { c, e } = get(b); if (!e) return;
    const a = b.dataset.aea, i = c.aeffects.indexOf(e);
    if (a === 'toggle') e.on = e.on === false;
    if (a === 'reset') e.p = afxDefaults(e.type);
    if (a === 'del') c.aeffects.splice(i, 1);
    if (a === 'up' && i > 0) [c.aeffects[i - 1], c.aeffects[i]] = [c.aeffects[i], c.aeffects[i - 1]];
    if (a === 'down' && i < c.aeffects.length - 1) [c.aeffects[i + 1], c.aeffects[i]] = [c.aeffects[i], c.aeffects[i + 1]];
    if (!c.aeffects.length) delete c.aeffects;
    doCommit(`Audio effect ${a}`); render();
  }));
  // 📈 Loudness Meter / Radar: the clip measured with the effects before it (server: POST /api/audio/measure)
  root.querySelectorAll('[data-ameasure]').forEach((b) => b.addEventListener('click', async () => {
    const { c, e } = get(b); if (!e) return;
    const out = b.closest('[data-aefx]').querySelector('[data-ameter]'), before = c.aeffects.slice(0, c.aeffects.indexOf(e));
    b.disabled = true; out.textContent = 'Measuring…';
    try {
      const r = await api('POST', `/api/audio/measure?p=${enc(S.proj)}`, { mediaId: c.mediaId, in: c.in || 0, out: c.out, afx: c.afx, aeffects: before });
      out.textContent = `${r.lufs} LUFS integrated · range ${r.lra} LU · true peak ${r.peak} dBTP${r.lufs > -13 ? ' - loud' : r.lufs < -24 ? ' - quiet' : ''} (reels / YouTube ≈ -14)`;
    } catch (err) { out.textContent = err.message; }
    finally { b.disabled = false; }
  }));
}

function effectsHTML(c, track) {
  const list = (c.effects || []).map((e, i) => {
    const def = VFX[e.type]; if (!def) return '';
    const params = Object.entries(def.params).map(([k, p]) => {
      const v = e.p?.[k] ?? p.def;
      if (p.type === 'color') return `<label class="fld"><span>${esc(p.label)}</span><input type="color" data-ep="${k}" value="${esc(v)}"></label>`;
      if (p.type === 'select') return `<label class="fld"><span>${esc(p.label)}</span><select data-ep="${k}">${p.options.map(([o, l]) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
      return `<label class="fld"><span>${esc(p.label)} <b data-ev="${k}">${v}${p.unit || ''}</b></span><input type="range" data-ep="${k}" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}"></label>`;
    }).join('');
    const canMask = !def.stab && !def.key && !def.post && !def.blend;
    const warn = def.v2only && track !== 'V2' ? '<small class="hint warn">Works on V2 overlays only (it shows the shot below).</small>' : def.stab ? '<small class="hint">Analysed and stabilised when rendering (Accurate preview / export) - the render takes longer for this shot. Perspective / Subspace Warp work like Position, Scale, Rotation here.</small>' : !def.css ? '<small class="hint">Seen in Accurate preview and renders.</small>' : '';
    return `<div class="efx${e.on === false ? ' off' : ''}" data-efx="${e.id}">
      <div class="efx-h"><button class="icon-btn small" data-ea="toggle" title="${e.on === false ? 'Turn on' : 'Turn off'}" aria-label="On / off">${e.on === false ? '◌' : '●'}</button><b>${esc(def.label)}</b><span class="grow"></span>
        <button class="icon-btn small" data-ea="up" title="Earlier in the order"${i === 0 ? ' disabled' : ''}>▲</button><button class="icon-btn small" data-ea="down" title="Later in the order"${i === c.effects.length - 1 ? ' disabled' : ''}>▼</button>
        <button class="icon-btn small" data-ea="reset" title="Reset to defaults">↺</button><button class="icon-btn small" data-ea="del" title="Remove effect">✕</button></div>
      ${params ? `<div class="fgrid">${params}</div>` : ''}${canMask ? maskHTML(e.mask, e.id, c.id) : ''}${warn}</div>`;
  }).join('');
  const opts = VFX_CATS.map((cat) => `<optgroup label="${esc(cat)}">${Object.entries(VFX).filter(([, x]) => x.cat === cat).map(([k, x]) => `<option value="${k}">${esc(x.label)}</option>`).join('')}</optgroup>`).join('');
  return `<div class="efx-list">${list || '<p class="muted small">No effects yet.</p>'}</div>
    <div class="row-in"><select data-addfx><option value="">+ Add effect…</option>${opts}</select></div>
    <div class="row-in"><button class="small" data-savelook title="Save this clip's effects, colour, cut effect and blend as a preset for any clip">Save look as preset</button></div>
    <small class="hint">Applied top to bottom, before Motion. More in the Effects panel (drag onto a clip).</small>`;
}
function bindEffects(id) {
  const get = (el) => { const c = findClip(id)?.clip, e = c?.effects?.find((x) => x.id === el.closest('[data-efx]')?.dataset.efx); return { c, e }; };
  root.querySelectorAll('[data-ep]').forEach((inp) => {
    const k = inp.dataset.ep;
    inp.addEventListener('input', () => {
      const { e } = get(inp); if (!e) return;
      e.p = { ...(e.p || {}), [k]: inp.type === 'color' || inp.tagName === 'SELECT' ? inp.value : +inp.value };
      const lab = inp.closest('[data-efx]').querySelector(`[data-ev="${k}"]`); if (lab) lab.textContent = `${inp.value}${VFX[e.type].params[k].unit || ''}`;
      emit('live');
    });
    inp.addEventListener('change', () => doCommit(`Effect ${k}`, `${id}:fx:${k}`));
  });
  root.querySelector('[data-savelook]')?.addEventListener('click', () => saveFxPreset(id));
  root.querySelector('[data-addfx]')?.addEventListener('change', (ev) => {
    const t = ev.target.value; if (!t) return;
    const c = findClip(id)?.clip; (c.effects ||= []).push(newEffect(t));
    openSections.add('vfx'); doCommit(`Add ${t}`); render();
  });
  root.querySelectorAll('[data-ea]').forEach((b) => b.addEventListener('click', () => {
    const { c, e } = get(b); if (!e) return;
    const a = b.dataset.ea, i = c.effects.indexOf(e);
    if (a === 'toggle') e.on = e.on === false;
    if (a === 'reset') e.p = defaultsOf(e.type);
    if (a === 'del') c.effects.splice(i, 1);
    if (a === 'up' && i > 0) [c.effects[i - 1], c.effects[i]] = [c.effects[i], c.effects[i - 1]];
    if (a === 'down' && i < c.effects.length - 1) [c.effects[i + 1], c.effects[i]] = [c.effects[i], c.effects[i + 1]];
    if (!c.effects.length) delete c.effects;
    doCommit(`Effect ${a}`); render();
  }));
}

// ---------------- ◯ masks (public/js/shapemask.js) ----------------
// scope: an effect id (the effect shows only inside), or 'clip' (the clip's Opacity mask)
function maskHTML(m, scope, clipId) {
  if (!m?.shape) return `<div class="efx-mask" data-mscope="${scope}"><div class="mk-row"><b>Mask</b>${MASK_SHAPES.map(([k, l]) => `<button class="small" data-madd="${k}" title="Limit ${scope === 'clip' ? 'the clip' : 'this effect'} to a ${k === 'rect' ? 'rectangle' : 'ellipse'} - drag it on the monitor">${l}</button>`).join('')}</div></div>`;
  const editing = S.maskEdit?.clipId === clipId && (S.maskEdit.effId || 'clip') === scope;
  const rng = (k, label, min, max, step, unit = '', mul = 1) => `<label class="fld"><span>${label} <b data-mv="${k}">${Math.round((m[k] ?? 0) * mul)}${unit}</b></span><input type="range" data-mp="${k}" data-mul="${mul}" min="${min}" max="${max}" step="${step}" value="${(m[k] ?? 0) * mul}"></label>`;
  return `<div class="efx-mask" data-mscope="${scope}"><div class="mk-row"><b>${m.shape === 'rect' ? '▭' : '◯'} Mask</b><span class="grow"></span>
      <button class="small${editing ? ' on' : ''}" data-medit title="Show the mask on the monitor to move / size it">✎ ${editing ? 'Editing on monitor' : 'Edit on monitor'}</button><button class="icon-btn small" data-mdel title="Remove the mask">✕</button></div>
    <div class="fgrid"><label class="fld"><span>Shape</span><select data-mp="shape">${MASK_SHAPES.map(([k, l]) => `<option value="${k}"${k === m.shape ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      ${rng('feather', 'Feather', 0, 300, 1, ' px')}${rng('expand', 'Expansion', -200, 200, 1, ' px')}${rng('opacity', 'Mask opacity', 0, 100, 1, '%', 100)}
      <label class="chk"><input type="checkbox" data-mp="invert"${m.invert ? ' checked' : ''}> Inverted (the outside instead)</label></div></div>`;
}
function bindMasks(id) {
  const get = (el) => {
    const c = findClip(id)?.clip, sc = el.closest('[data-mscope]')?.dataset.mscope; if (!c || !sc) return {};
    const e = sc === 'clip' ? null : c.effects?.find((x) => x.id === sc);
    return { c, sc, e, m: sc === 'clip' ? c.omask : e?.mask, set: (v) => { if (sc === 'clip') { if (v) c.omask = v; else delete c.omask; } else if (e) { if (v) e.mask = v; else delete e.mask; } } };
  };
  root.querySelectorAll('[data-madd]').forEach((b) => b.addEventListener('click', () => {
    const g = get(b); if (!g.c) return;
    g.set(newMask(b.dataset.madd));
    S.maskEdit = { clipId: id, effId: g.sc === 'clip' ? null : g.sc };
    openSections.add(g.sc === 'clip' ? 'omask' : 'vfx');
    doCommit('Add mask'); render(); emit('maskEdit');
    toast('Mask added - drag it on the monitor (Esc when done)');
  }));
  root.querySelectorAll('[data-mdel]').forEach((b) => b.addEventListener('click', () => {
    const g = get(b); if (!g.c) return;
    g.set(null); if (S.maskEdit?.clipId === id) S.maskEdit = null;
    doCommit('Remove mask'); render(); emit('maskEdit');
  }));
  root.querySelectorAll('[data-medit]').forEach((b) => b.addEventListener('click', () => {
    const g = get(b); if (!g.m) return;
    const scope = g.sc === 'clip' ? null : g.sc, on2 = S.maskEdit?.clipId === id && (S.maskEdit.effId || null) === scope;
    S.maskEdit = on2 ? null : { clipId: id, effId: scope };
    emit('maskEdit');
  }));
  root.querySelectorAll('[data-mp]').forEach((inp) => {
    const k = inp.dataset.mp, mul = +inp.dataset.mul || 1;
    const read = () => (k === 'invert' ? inp.checked : k === 'shape' ? inp.value : +inp.value / mul);
    inp.addEventListener('input', () => {
      const g = get(inp); if (!g.m) return;
      g.set({ ...g.m, [k]: read() });
      const lab = inp.closest('.fld')?.querySelector(`[data-mv="${k}"]`); if (lab) lab.textContent = `${Math.round(+inp.value)}${k === 'opacity' ? '%' : ' px'}`;
      emit('live'); // (the viewer redraws the mask)
    });
    inp.addEventListener('change', () => { const g = get(inp); if (!g.m) return; g.set({ ...g.m, [k]: read() }); doCommit(`Mask ${k}`, `${id}:mask:${k}`); if (k === 'shape') emit('maskEdit'); });
  });
}

// ---------------- 🎬 Motion, Premiere style ----------------
// show: how the value reads (Scale / Opacity / Crop as %), min / max / step in the stored units
const MOTION = [
  { p: 'transform.x', label: 'Position X', min: -200, max: 200, step: 0.5, unit: '', pr: 'x' },
  { p: 'transform.y', label: 'Position Y', min: -200, max: 200, step: 0.5, unit: '', pr: 'y' },
  { p: 'transform.zoom', label: 'Scale', min: 0.1, max: 5, step: 0.01, unit: '', pr: 'scale' },
  { p: 'transform.rotation', label: 'Rotation', min: -720, max: 720, step: 0.5, unit: '°' },
  { p: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, k: 100, unit: '%' },
  { p: 'cropX', label: 'Reframe ', min: 0, max: 1, step: 0.01, k: 100, unit: '%' },
  { p: 'cropY', label: 'Reframe ', min: 0, max: 1, step: 0.01, k: 100, unit: '%' },
  { p: 'volume', label: 'Volume', min: 0, max: 2, step: 0.01, k: 100, unit: '%', vid: true },
];
// Premiere's numbers: Position in sequence pixels (centre = W/2, H/2), Scale in % of the source's own pixels (a 4K shot
// fitted into a 1080p frame reads 50) - the same values the XML export hands Premiere. Stored: x/y % offset, zoom x fit.
function frameWH() { return ASPECTS[S.project?.settings?.aspect] || ASPECTS['16:9']; }
function fitOf(c) {
  const [W, H] = frameWH(), m = S.mediaById?.[c?.mediaId] || {};
  const rot = Math.abs(m.rotation || 0) % 180 === 90, w = (rot ? m.height : m.width) || W, h = (rot ? m.width : m.height) || H;
  const mode = c?.fit || S.project?.settings?.fit || (H > W ? 'blur' : 'fit');
  return mode === 'fill' ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
}
function toShown(r, v, c) {
  v = +v || 0;
  const [W, H] = frameWH();
  if (r.pr === 'x') return W / 2 + (v / 100) * W;
  if (r.pr === 'y') return H / 2 + (v / 100) * H;
  if (r.pr === 'scale') return v * fitOf(c) * 100;
  return v * (r.k || 1);
}
function fromShown(r, n, c) {
  const [W, H] = frameWH();
  if (r.pr === 'x') return ((n - W / 2) / W) * 100;
  if (r.pr === 'y') return ((n - H / 2) / H) * 100;
  if (r.pr === 'scale') return n / (fitOf(c) * 100 || 1);
  return n / (r.k || 1);
}
const mShow = (r, v, c) => `${+toShown(r, v, c).toFixed(r.pr ? 1 : r.k ? 0 : 1)}${r.unit}`;
function motionVal(c, p, rel) { return hasKeys(c, p) && rel !== null ? propAt(c, p, rel) : getPath(c, p) ?? KEYABLE[p].def; }
// 🎭 Opacity › Blend Mode (Premiere): how this clip mixes with the tracks below it (clip.blend, FFmpeg's blend mode)
function blendHTML(c, track) {
  const v1 = track === 'V1';
  return `<div class="pm-row pm-blend"><span></span><span class="pm-n">Blend Mode</span>
    <select data-blend${v1 ? ' disabled title="On the main story there is nothing below to blend with - put the clip on V2 or higher"' : ' title="How this clip mixes with the tracks below it. Darken / Multiply… make it darker, Lighten / Screen / Add lighter, Overlay / Soft Light add contrast. Exact in Accurate preview and the render."'}>${BLEND_MODES.map(([k, l]) => `<option value="${k}"${(c.blend || '') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`;
}
function motionHTML(c, D, isVid, blendTrack) {
  const rel = relTime(c.id), ks = kSel.id === c.id ? kSel.list : [];
  return `<div class="pm" data-kl data-d="${D}">${MOTION.filter((r) => !r.vid || isVid).map((r) => {
    const keys = c.keys?.[r.p] || [];
    return `<div class="pm-row" data-kp="${r.p}" data-kpath="${r.p}">
      <button class="pm-sw${keys.length ? ' on' : ''}" data-sw="${r.p}" title="${keys.length ? 'Animated - click to stop animating (removes its keyframes)' : 'Animate: a keyframe at the playhead, then change the value elsewhere'}">⏱</button>
      <span class="pm-n">${kgTwirl(c, r.p)}${r.label}</span>
      <span class="pm-v" data-pv="${r.p}" tabindex="0" title="Drag left / right (Shift: faster) or click to type">${mShow(r, motionVal(c, r.p, rel), c)}</span>
      <span class="pm-k"><button class="kfb" data-kprev="${r.p}" title="Previous keyframe">◂</button><button class="kfd" data-kf="${r.p}" title="Add / remove a keyframe at the playhead">◆</button><button class="kfb" data-knext="${r.p}" title="Next keyframe">▸</button></span>
      <div class="kl-track">${keys.map((k, j) => `<i class="kl-k${k.ease ? ' ease' : ''}${k.ip ? ` ip-${k.ip}` : ''}${inSel(ks, k) ? ' sel' : ''}" data-kj="${j}" style="left:${Math.min(100, (k.t / Math.max(0.01, D)) * 100).toFixed(2)}%" title="${fmt(k.t)} · ${mShow(r, k.v, c)} - click to select (Shift / Ctrl: more, or drag a box), drag to move the selected ones, Delete removes them, right-click: interpolation"></i>`).join('')}<b class="kl-ph"></b></div>
    </div>${kgRow(c, r.p)}${r.p === 'opacity' && blendTrack ? blendHTML(c, blendTrack) : ''}`; // (📈 kfgraph.js: the value / velocity graphs when twirled open)
  }).join('')}</div>`;
}
function bindMotion(id) {
  const box = root.querySelector('.pm'); if (!box) return;
  const def = (p) => MOTION.find((r) => r.p === p);
  const setVal = (p, v) => {
    const c = findClip(id)?.clip, r = def(p); if (!c) return;
    v = +Math.min(r.max, Math.max(r.min, v)).toFixed(4);
    if (hasKeys(c, p)) keyValue(id, p, v); else setPath(c, p, v);
    const el = box.querySelector(`[data-pv="${p}"]`); if (el) el.textContent = mShow(r, v, c);
    emit('live');
  };
  const done = (p) => { const c = findClip(id)?.clip; if (!c) return; const n = c.keys?.[p]?.length || 0; cleanup(c); doCommit(`Change ${def(p).label}`, `${id}:${p}`); if (n) render(); }; // (a key made by the drag shows on the lane)
  box.querySelectorAll('[data-pv]').forEach((el) => {
    const p = el.dataset.pv, r = def(p);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const c = findClip(id)?.clip, v0 = +motionVal(c, p, relTime(id)), x0 = e.clientX;
      let moved = false;
      const mv = (ev) => { const dx = ev.clientX - x0; if (!moved && Math.abs(dx) < 3) return; moved = true; setVal(p, v0 + dx * r.step * (ev.shiftKey ? 10 : 1)); };
      const up = () => {
        window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
        if (moved) return done(p);
        // a click: type the value (in the units shown)
        const inp = document.createElement('input'); inp.className = 'pm-in'; inp.value = +toShown(r, motionVal(findClip(id)?.clip, p, relTime(id)), findClip(id)?.clip).toFixed(2);
        el.replaceWith(inp); inp.focus(); inp.select();
        const fin = (ok) => { if (ok && inp.value.trim() !== '' && !isNaN(+inp.value)) { setVal(p, fromShown(r, +inp.value, findClip(id)?.clip)); done(p); } render(); };
        inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') fin(true); if (ev.key === 'Escape') fin(false); });
        inp.addEventListener('blur', () => fin(true), { once: true });
      };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
  });
  box.querySelector('[data-blend]')?.addEventListener('change', (e) => {
    const c = findClip(id)?.clip; if (!c) return;
    if (e.target.value) c.blend = e.target.value; else delete c.blend;
    doCommit(`Blend mode: ${BLEND_MODES.find(([k]) => k === e.target.value)?.[1] || 'Normal'}`);
  });
  // ⏱ animate on (a first keyframe at the playhead, with the value now) / off (its keyframes go, the value stays)
  box.querySelectorAll('[data-sw]').forEach((b) => b.addEventListener('click', () => {
    const c = findClip(id)?.clip, p = b.dataset.sw; if (!c) return;
    if (c.keys?.[p]?.length) { const v = motionVal(c, p, relTime(id)); delete c.keys[p]; if (!Object.keys(c.keys).length) delete c.keys; setPath(c, p, v); doCommit(`Stop animating ${def(p).label}`); }
    else { const rel = relTime(id); if (rel === null) return toast('Move the playhead over this clip first'); (c.keys ||= {})[p] = [{ t: +rel.toFixed(3), v: +motionVal(c, p, null) }]; doCommit(`Animate ${def(p).label}`); }
    render();
  }));
}

// ---------------- keyframe lane (Premiere's mini timeline in Effect Controls) ----------------
// One row per animated property over the clip's length: click to move the playhead, drag a ◆ to retime it,
// double-click a ◆ to delete it. Keys are added with the ◆ buttons next to each slider.
function keyLaneHTML(c, D) {
  const rows = Object.entries(KEYABLE).filter(([p]) => p !== 'volume' || c.type === 'video');
  const any = rows.some(([p]) => c.keys?.[p]?.length);
  return `<div class="kl" data-kl data-d="${D}">${rows.filter(([p]) => !any || c.keys?.[p]?.length).map(([p, d]) => `<div class="kl-row" data-kp="${p}"><span>${esc(d.label)}</span>
      <div class="kl-track">${(c.keys?.[p] || []).map((k, j) => `<i class="kl-k${k.ease ? ' ease' : ''}" data-kj="${j}" style="left:${Math.min(100, (k.t / Math.max(0.01, D)) * 100).toFixed(2)}%" title="${fmt(k.t)} · ${(+k.v).toFixed(2)}"></i>`).join('')}<b class="kl-ph"></b></div></div>`).join('')}</div>
    <small class="hint">${any ? 'Drag ◆ to retime · double-click ◆ to delete · click the lane to move the playhead.' : 'No keyframes yet - press ◆ next to Zoom / Position / Rotation / Opacity above.'}</small>`;
}
// ◆ selecting keys (kfsel.js): click one, Shift / Ctrl+click more, drag a box over the lanes; drag a selected ◆ and all
// the selected ones move with it; Delete removes them. Click the lane (not a ◆) to move the playhead.
let kSel = { id: null, list: [] };
function bindKeyLane(id) {
  const kl = root.querySelector('[data-kl]'); if (!kl) return;
  if (kSel.id !== id) kSel = { id, list: [] };
  const D = +kl.dataset.d || 1, fps = S.project.settings.fps || 30;
  const clipStart = () => { const f = findClip(id); return layout()[f.track].find((x) => x.clip.id === id)?.start || 0; };
  const tAt = (track, x) => { const r = track.getBoundingClientRect(); return Math.min(D, Math.max(0, ((x - r.left) / r.width) * D)); };
  const keyOf = (el) => { const p = el.closest('[data-kp]').dataset.kp; return { p, k: findClip(id)?.clip.keys?.[p]?.[+el.dataset.kj] }; };
  const mark = () => kl.querySelectorAll('.kl-k').forEach((el) => el.classList.toggle('sel', inSel(kSel.list, keyOf(el).k)));
  kl.addEventListener('pointerdown', (e) => {
    const track = e.target.closest('.kl-track'); if (!track || e.button !== 0) return;
    const k = e.target.closest('.kl-k'), add = e.shiftKey || e.ctrlKey || e.metaKey;
    e.preventDefault();
    if (!k) return keyBox(e, track, add);
    const hit = keyOf(k); if (!hit.k) return;
    const was = inSel(kSel.list, hit.k);
    if (add) kSel.list = pickKeys(kSel.list, hit, 'toggle');
    else if (!was) kSel.list = pickKeys(kSel.list, hit, 'set');
    mark();
    if (!inSel(kSel.list, hit.k)) return; // (Ctrl+click took it out)
    const c = findClip(id).clip, list = kSel.list.filter((s) => c.keys?.[s.p]?.includes(s.k)), t0s = list.map((s) => s.k.t);
    const els = [...kl.querySelectorAll('.kl-k')].map((el) => ({ el, k: keyOf(el).k })).filter((x) => inSel(list, x.k));
    const x0 = e.clientX, a0 = tAt(track, x0);
    let moved = false;
    const mv = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      moveKeys(c, list, t0s, tAt(track, ev.clientX) - a0, D);
      for (const x of els) x.el.style.left = `${(x.k.t / D) * 100}%`;
      emit('live'); updateKeyUI();
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      if (moved) { settleKeys(c, list, fps); doCommit(list.length > 1 ? `Move ${list.length} keyframes` : 'Move keyframe'); render(); return; }
      if (was && !add && kSel.list.length > 1) { kSel.list = pickKeys(kSel.list, hit, 'set'); mark(); } // (a click on one of several: only it)
      emit('seek', clipStart() + hit.k.t);
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
  // a box dragged over the lanes selects the keys in it (Shift / Ctrl: adds them); a plain click moves the playhead
  function keyBox(e, track, add) {
    const x0 = e.clientX, y0 = e.clientY, base = add ? kSel.list : [];
    let box = null;
    const mv = (ev) => {
      if (!box && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      if (!box) { box = document.createElement('div'); box.className = 'kl-box'; document.body.append(box); }
      const l = Math.min(x0, ev.clientX), t = Math.min(y0, ev.clientY), r = Math.max(x0, ev.clientX), b = Math.max(y0, ev.clientY);
      Object.assign(box.style, { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${b - t}px` });
      const hits = [...kl.querySelectorAll('.kl-k')].filter((el) => { const q = el.getBoundingClientRect(), cx = q.left + q.width / 2, cy = q.top + q.height / 2; return cx >= l && cx <= r && cy >= t && cy <= b; }).map(keyOf).filter((h) => h.k);
      kSel.list = hits.reduce((acc, h) => pickKeys(acc, h, 'add'), base);
      mark();
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      if (box) { box.remove(); if (kSel.list.length) toast(`${kSel.list.length} keyframe${kSel.list.length > 1 ? 's' : ''} selected - drag one to move them, Delete removes them`); return; }
      if (!add) { kSel.list = []; mark(); }
      emit('seek', clipStart() + tAt(track, ev.clientX));
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }
  kl.addEventListener('dblclick', (e) => {
    const k = e.target.closest('.kl-k'); if (!k) return;
    const hit = keyOf(k), c = findClip(id).clip; if (!hit.k) return;
    deleteKeys(c, [hit]); kSel.list = kSel.list.filter((s) => s.k !== hit.k);
    doCommit('Delete keyframe'); render();
  });
  moveLanePlayhead();
}
// Delete / Backspace with keys selected in Effect Controls: they go (and not the clip). true when it took the key press.
export function deleteSelectedKeys() {
  if (!kSel.list.length || S.sel.size !== 1 || !S.sel.has(kSel.id)) return false;
  const c = findClip(kSel.id)?.clip; if (!c) { kSel.list = []; return false; }
  const n = deleteKeys(c, kSel.list.filter((s) => c.keys?.[s.p]?.includes(s.k)));
  kSel.list = [];
  if (!n) return false;
  doCommit(n > 1 ? `Delete ${n} keyframes` : 'Delete keyframe'); render();
  return true;
}
// a click anywhere outside the keyframe lanes lets the selection go (Delete is the clip's again)
document.addEventListener('pointerdown', (e) => { if (kSel.list.length && !e.target.closest?.('.pm .kl-track, .kg, .kg-menu')) { kSel.list = []; root?.querySelectorAll('.kl-k.sel').forEach((el) => el.classList.remove('sel')); } }, true);
function moveLanePlayhead() {
  const kl = root?.querySelector('[data-kl]'); if (!kl || S.sel.size !== 1) return;
  const id = [...S.sel][0], f = findClip(id); if (!f) return;
  const x = layout()[f.track].find((p) => p.clip.id === id), D = +kl.dataset.d || 1, rel = S.playhead - (x?.start || 0);
  kl.querySelectorAll('.kl-ph').forEach((b) => { b.hidden = rel < 0 || rel > D; b.style.left = `${(rel / D) * 100}%`; });
}

// 📈 the value / velocity graphs under a twirled-open property (kfgraph.js)
function bindKeyGraphs(id) {
  const kl = root.querySelector('.pm'); if (!kl) return;
  const def = (p) => MOTION.find((r) => r.p === p), clipStart = () => { const f = findClip(id); return layout()[f.track].find((x) => x.clip.id === id)?.start || 0; };
  mountKeyGraphs(root, {
    id, D: +kl.dataset.d || 1, fps: S.project.settings.fps || 30,
    clip: () => findClip(id)?.clip, rel: () => relTime(id), seek: (t) => emit('seek', clipStart() + t),
    live: () => { emit('live'); updateKeyUI(); }, commit: (label) => doCommit(label), rerender: render, deleteSel: () => deleteSelectedKeys(),
    shown: (p, v) => toShown(def(p), v, findClip(id)?.clip), unit: (p) => def(p).unit, clamp: (p, v) => Math.min(def(p).max, Math.max(def(p).min, v)),
  });
}

function validateTimes(c) {
  const d = S.mediaById[c.mediaId]?.duration;
  if (!d) return;
  if (c.in !== undefined && c.in >= d - 0.1) { c.in = Math.max(0, +(d - 1).toFixed(2)); toast(`In was past the end of the file - moved to ${fmt(c.in)}`, 'err'); }
  if (c.out !== undefined && c.out > d) { delete c.out; toast('Out was past the end of the file - plays to the end', 'err'); }
  if (c.out !== undefined && c.out <= (c.in || 0) + 0.1) { delete c.out; toast('Out must be after In - cleared Out', 'err'); }
}
// drop neutral values so the project file stays readable and the "CC"/"◰" badges stay honest
function cleanup(c) {
  if (c.transform) { const t = c.transform; if ((t.zoom ?? 1) === 1 && !t.x && !t.y && !t.rotation) delete c.transform; }
  if (c.color) {
    const k = c.color;
    for (const [p, d] of [['exposure', 0], ['temp', 0], ['tint', 0], ['contrast', 1], ['saturation', 1]]) if (k[p] === d) delete k[p];
    if (!k.lut) delete k.lut;
    if (!Object.keys(k).length) delete c.color;
  }
  for (const k of ['speed', 'volume']) if (c[k] === 1 && !(k === 'volume' && c.type === 'video')) delete c[k];
}

// ---------------- project ----------------
// ⚡ Phase 18: the project panel is drawn again only when something it shows changed (it was rebuilt - with a logo list of
// every image in the pool and a backups request - after every trim on the timeline)
let projKey = '';
function renderProject() {
  const p = S.project, images = S.media.filter((m) => m.kind === 'image');
  const key = JSON.stringify([S.proj, p.name, p.settings, p.logo, p.subtitles, images.length, images[images.length - 1]?.id, S.subs.map((x) => x.name)]);
  if (key === projKey && root.querySelector('[data-sec="project"]')) return;
  projKey = key;
  root.innerHTML = `<div class="ihead"><b>Project</b><span class="muted">${esc(p.name)}</span></div><div class="ibody">
    ${sec('project', 'Settings', fieldsHTML([
      { k: 'settings.aspect', label: 'Format', type: 'select', options: [['16:9', '16:9 · YouTube / Film'], ['9:16', '9:16 · Reel / Shorts'], ['1:1', '1:1 · Square'], ['4:5', '4:5 · Feed'],
        ['4:3', '4:3 · Old TV / slides'], ['3:4', '3:4 · Portrait'], ['21:9', '21:9 · Ultrawide'], ['2.39:1', '2.39:1 · Cinema scope'], ['17:9 DCI', '17:9 · DCI (cinema)'],
        ...(ASPECTS[p.settings.aspect] && !['16:9', '9:16', '1:1', '4:5', '4:3', '3:4', '21:9', '2.39:1', '17:9 DCI'].includes(p.settings.aspect) ? [[p.settings.aspect, `${shapeLabel(p.settings.aspect)}`]] : [])] },
      { type: 'html', html: '<div class="iactions"><button class="small" data-a="seqset" title="All the sequence settings, like Premiere">Sequence Settings…</button><button class="small" data-a="customsize" title="Any frame size, e.g. 4096 × 2160 (4K DCI), 1280 × 720, 3840 × 1600">Custom size…</button></div>' },
      { k: 'settings.fps', label: 'Frame rate', type: 'select', options: [[24, '24'], [25, '25'], [30, '30'], [50, '50'], [60, '60']] },
      { k: 'settings.fit', label: 'Default framing', type: 'select', options: [['', 'Auto (blur for vertical)'], ['fit', 'Fit'], ['fill', 'Fill'], ['blur', 'Blur background']] },
      { k: 'settings.kenburns', label: 'Slow zoom on photos', type: 'check' },
      { k: 'settings.loudness', label: 'Loudness', type: 'select', options: [[-14, 'Social -14 LUFS'], [-16, 'YouTube / web -16'], [-23, 'Broadcast -23'], ['off', 'Leave as is']] },
      { k: 'settings.crf', label: 'Quality', type: 'select', options: [[16, 'Master (big)'], [18, 'High'], [20, 'Standard'], [24, 'Small (WhatsApp)'], [28, 'Very small']] },
    ], p))}
    ${sec('look', 'Cinematic finish', fieldsHTML([
      { k: 'settings.look.lut', label: 'Film look (whole edit)', type: 'select', options: [['', 'None'], ...FILM_LOOKS.map(([n]) => [lookLut(n), n])] },
      { k: 'settings.look.mix', label: 'Look strength', type: 'range', min: 0, max: 1, step: 0.05, def: 0.85 },
      { k: 'settings.look.letterbox', label: 'Letterbox bars', type: 'select', options: LETTERBOX },
      { k: 'settings.look.vignette', label: 'Vignette', type: 'range', min: 0, max: 1, step: 0.05, def: 0 },
      { k: 'settings.look.grain', label: 'Film grain', type: 'range', min: 0, max: 1, step: 0.05, def: 0 },
    ], p) + `<div class="iactions"><button class="small accent" data-a="cine">Make it cinematic</button><button class="small" data-a="nocine">Remove</button><button class="small" data-a="stab">Stabilize all shots</button><button class="small" data-a="nostab">No stabilize</button></div><small class="hint">Stabilize, grain and bars show in Accurate preview and renders (stabilizing makes renders slower).</small>`)}
    ${'' && sec('logo', 'Logo / watermark', fieldsHTML([
      { k: 'logo.mediaId', label: 'Logo image', type: 'select', options: [['', 'None'], ...images.map((m) => [m.id, m.name])] },
      { k: 'logo.pos', label: 'Position', type: 'select', options: [['tr', 'Top right'], ['tl', 'Top left'], ['br', 'Bottom right'], ['bl', 'Bottom left']] },
      { k: 'logo.scale', label: 'Size', type: 'range', min: 0.04, max: 0.4, step: 0.01, def: 0.12 },
      { k: 'logo.opacity', label: 'Opacity', type: 'range', min: 0.1, max: 1, step: 0.01, def: 0.9 },
    ], p))}
    ${'' && sec('subs', 'Subtitles', fieldsHTML([
      { k: 'subtitles.file', label: 'Burn into the video', type: 'select', options: [['', 'None'], ...S.subs.map((s) => [s.name, s.name])] },
    ], p) + '<small class="hint">Generate and proof-read subtitles on the Deliver page.</small>')}

    <div class="iactions"><button data-a="folder">Open project folder</button></div>
  </div>`;
  bindFields(root, () => S.project, { live: () => emit('live'), commit: (k) => { doCommit(`Project ${k}`, k); if (k === 'settings.aspect') emit('aspect'); } });
  root.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'folder') { const r = await api('POST', `/api/open-folder?p=${enc(S.proj)}`); toast(r.folder); }
    if (a === 'seqset') return import('./seqsettings.js').then((x) => x.openSequenceSettings());
    if (a === 'customsize') { // 📐 any frame size (stored as "WxH"; ASPECTS reads it everywhere)
      const cur = ASPECTS[S.project.settings.aspect] || [1920, 1080];
      const v = prompt('Frame size, width × height in pixels (e.g. 4096 x 2160, 1280 x 720, 3840 x 1600)', `${cur[0]} x ${cur[1]}`);
      const m = /^\s*(\d{2,5})\s*[x×*,]\s*(\d{2,5})\s*$/i.exec(v || '');
      if (v === null) return;
      if (!m) return toast('Write it as width x height, e.g. 1920 x 1080', 'err');
      const key = `${+m[1] & ~1}x${+m[2] & ~1}`;
      S.project.settings.aspect = key; commit(`Frame size ${key}`); emit('aspect'); toast(`Frame size ${shapeLabel(key)}`);
      return;
    }
    if (a === 'cine') { applyCinematic(S.project); commit('Cinematic look'); toast('Cinematic: film grade, 2.39 bars (16:9), vignette, grain'); }
    if (a === 'nocine') { removeCinematic(S.project); commit('Remove cinematic look'); }
    if (a === 'stab' || a === 'nostab') { const n = stabilizeAll(S.project, a === 'stab' ? 'medium' : ''); commit(a === 'stab' ? 'Stabilize all' : 'No stabilize'); toast(a === 'stab' ? `${n} shots will be stabilized in the render` : 'Stabilize off'); }
    const rs = e.target.closest('[data-restore]')?.dataset.restore;
    if (rs && confirm(`Restore the timeline saved at ${rs.replace('project_', '').slice(0, 19).replace('T', ' ')}?\n\nThe current version is backed up first.`)) {
      await saveNow(true);
      S.project = await api('POST', `/api/restore?p=${enc(S.proj)}&file=${enc(rs)}`);
      commit('Restore backup'); toast('Backup restored');
    }
  };
  api('GET', `/api/backups?p=${enc(S.proj)}`).then((b) => {
    const el = $('#bkList', root); if (!el) return;
    el.innerHTML = b.length ? b.slice(0, 12).map((x) => `<button class="link" data-restore="${esc(x.name)}">${new Date(x.mtime).toLocaleString()}</button>`).join('') : 'Saved automatically every few minutes while you work.';
  }).catch(() => {});
}

// ---------------- keyframes ----------------
// Time of the playhead inside the selected clip (null when the playhead is outside it).
function relTime(id) {
  const f = findClip(id); if (!f) return null;
  const x = layout()[f.track].find((p) => p.clip.id === id);
  if (!x) return null;
  const r = S.playhead - x.start;
  return r >= -1e-3 && r <= x.end - x.start + 1e-3 ? Math.max(0, Math.min(r, x.end - x.start)) : null;
}
const keyAt = (keys, t) => (keys || []).findIndex((k) => Math.abs(k.t - t) < 0.5 / (S.project.settings.fps || 30));

function addKeyButtons(id) {
  for (const path of Object.keys(KEYABLE)) {
    const input = root.querySelector(`[data-k="${path}"]`);
    if (!input) continue;
    const span = input.closest('.fld')?.querySelector(':scope > span');
    if (!span) continue;
    span.insertAdjacentHTML('beforeend', `<span class="kfc" data-kpath="${path}">
      <button class="kfb" data-kprev="${path}" title="Previous keyframe">◂</button><button class="kfd" data-kf="${path}" title="Add / remove keyframe at the playhead">◆</button><button class="kfb" data-knext="${path}" title="Next keyframe">▸</button>
      <select class="kfe" data-kease="${path}" title="How the value moves between keyframes">${EASES.map(([v, l]) => `<option value="${v}">${l.split(' (')[0]}</option>`).join('')}<option value="custom" disabled hidden>Custom</option></select></span>`);
  }
  root.querySelectorAll('[data-kease]').forEach((cb) => cb.addEventListener('change', () => {
    const c = findClip(id)?.clip; const keys = c?.keys?.[cb.dataset.kease];
    if (!keys?.length) { cb.value = ''; return toast('Add keyframes first'); }
    keys.forEach((k) => { k.ease = cb.value || undefined; delete k.ip; delete k.in; delete k.out; }); // (📈 replaces per-key interpolation)
    doCommit('Keyframe easing');
  }));
  updateKeyUI();
}

export function updateKeyUI() {
  if (!root || S.sel.size !== 1) return;
  moveLanePlayhead();
  const id = [...S.sel][0], c = findClip(id)?.clip;
  if (!c) return;
  const rel = relTime(id);
  root.querySelectorAll('[data-kpath]').forEach((el) => {
    const path = el.dataset.kpath, keys = c.keys?.[path] || [];
    const d = el.querySelector('[data-kf]');
    d.classList.toggle('has', keys.length > 0);
    d.classList.toggle('on', rel !== null && keyAt(keys, rel) >= 0);
    d.disabled = rel === null;
    const ks = el.querySelector('[data-kease]'); if (ks && document.activeElement !== ks) ks.value = keys.length > 1 ? (keys.some((k) => k.ip) ? 'custom' : keys[0].ease === true ? 'io' : keys[0].ease || '') : '';
    const pv = el.querySelector('[data-pv]'), md = MOTION.find((r) => r.p === path);
    if (pv && md) pv.textContent = mShow(md, motionVal(c, path, rel), c); // (🎬 the value at the playhead)
    el.querySelector('[data-kprev]').disabled = !keys.some((k) => rel !== null && k.t < rel - 1e-3);
    el.querySelector('[data-knext]').disabled = !keys.some((k) => rel === null || k.t > rel + 1e-3);
    if (keys.length && rel !== null) {
      // show the animated value at the playhead
      const v = propAt(c, path, rel), r = root.querySelector(`[data-k="${path}"]`), m = root.querySelector(`[data-mirror="${path}"]`);
      if (r && document.activeElement !== r) r.value = v;
      if (m && document.activeElement !== m) m.value = +(+v).toFixed(3);
    }
  });
}

// With keyframes on a property, editing it sets/creates the key at the playhead instead of the static value.
function keyValue(id, path, v) {
  if (!(path in KEYABLE)) return;
  const c = findClip(id)?.clip;
  if (!c || !hasKeys(c, path) || v === undefined) return;
  const rel = relTime(id);
  if (rel === null) { toast('Move the playhead over this clip to set a keyframe'); return; }
  const keys = c.keys[path], i = keyAt(keys, rel);
  if (i >= 0) keys[i].v = v; else { keys.push({ t: +rel.toFixed(3), v }); keys.sort((a, b) => a.t - b.t); }
  updateKeyUI();
}

function onKeyClick(e, id) {
  const kf = e.target.closest('[data-kf]')?.dataset.kf, prev = e.target.closest('[data-kprev]')?.dataset.kprev, next = e.target.closest('[data-knext]')?.dataset.knext;
  if (!kf && !prev && !next) return false;
  e.preventDefault();
  const f = findClip(id), c = f?.clip; if (!c) return true;
  const x = layout()[f.track].find((p) => p.clip.id === id), rel = relTime(id);
  if (prev || next) {
    const keys = c.keys?.[prev || next] || [];
    const k = prev ? [...keys].reverse().find((q) => q.t < (rel ?? Infinity) - 1e-3) : keys.find((q) => q.t > (rel ?? -Infinity) + 1e-3);
    if (k) emit('seek', x.start + k.t);
    return true;
  }
  if (rel === null) { toast('Move the playhead over this clip first'); return true; }
  c.keys = c.keys || {};
  const keys = (c.keys[kf] = c.keys[kf] || []), i = keyAt(keys, rel);
  if (i >= 0) keys.splice(i, 1);
  else { keys.push({ t: +rel.toFixed(3), v: +propAt(c, kf, rel) }); keys.sort((a, b) => a.t - b.t); }
  if (!keys.length) delete c.keys[kf];
  if (!Object.keys(c.keys).length) delete c.keys;
  doCommit(i >= 0 ? 'Remove keyframe' : 'Add keyframe');
  render(); // (the lane shows the new / removed ◆ - it used to be added unseen, so the button looked dead)
  return true;
}

function motionPreset(id, kind) {
  const f = findClip(id), c = f?.clip; if (!c) return;
  const x = layout()[f.track].find((p) => p.clip.id === id), d = +(x.end - x.start).toFixed(3);
  c.keys = { ...(c.keys || {}) };
  for (const p of ['transform.zoom', 'transform.x', 'transform.y']) delete c.keys[p];
  if (kind === 'zin') c.keys['transform.zoom'] = [{ t: 0, v: 1, ease: true }, { t: d, v: 1.15 }];
  if (kind === 'zout') c.keys['transform.zoom'] = [{ t: 0, v: 1.15, ease: true }, { t: d, v: 1 }];
  if (kind === 'pan' || kind === 'panl') {
    const a = kind === 'pan' ? -6 : 6;
    c.keys['transform.zoom'] = [{ t: 0, v: 1.15 }];
    c.keys['transform.x'] = [{ t: 0, v: a, ease: true }, { t: d, v: -a }];
  }
  if (!Object.keys(c.keys).length) delete c.keys;
  doCommit(kind === 'clear' ? 'Clear motion' : 'Motion preset');
  render();
  toast(kind === 'clear' ? 'Motion cleared' : 'Motion added - press Space to watch');
}
