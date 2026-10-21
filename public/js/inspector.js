// Inspector: properties of the selected clip, or project settings when nothing is selected.
import { S, on, emit, commit, findClip, layout, duration, saveNow } from './store.js';
import { TRANSITIONS, clipDur, fmt, parseTime, fmtTC, KEYABLE, propAt, hasKeys, RAMPS, EASES, BLEND_MODES } from './model.js';
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
import { FILM_LOOKS, lookLut, LETTERBOX, STABILIZE, applyCinematic, removeCinematic, stabilizeAll } from './looks.js';
import { $, $$, esc, fieldsHTML, bindFields, toast, modal } from './ui.js';
import { mountRamp } from './rampui.js';

let root, selfCommit = false, openSections = new Set(['clip', 'transform', 'text', 'audio', 'transition', 'project', 'logo']);

export function mountInspector(el) {
  root = el;
  on('select', render);
  on('change', () => { if (!selfCommit) render(); });
  on('media', render);
  on('playhead', () => updateKeyUI());
  on('inspect', (sec) => { openSections.add(sec); render(); $(`[data-sec="${sec}"]`, root)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  root.addEventListener('click', (e) => {
    const s = e.target.closest('.isec > summary');
    if (s) { const k = s.parentElement.dataset.sec; setTimeout(() => (s.parentElement.open ? openSections.add(k) : openSections.delete(k))); }
  });
  render();
}

const sec = (key, title, body, extra = '') => `<details class="isec" data-sec="${key}"${openSections.has(key) ? ' open' : ''}><summary>${title}${extra}</summary><div class="fgrid">${body}</div></details>`;
const timeDef = (k, label, ph) => ({ k, label, type: 'time', fmt: (v) => (v === undefined ? '' : fmt(v)), ph });

function doCommit(label, key) { selfCommit = true; commit(label, key); selfCommit = false; }

function render() {
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
    root.innerHTML = `<div class="ec-title">Effect Controls</div><div class="ihead"><span class="trk">${track}</span><b>📊 Motion graphic</b><span class="muted">${fmtTC(L?.start || 0, S.project.settings.fps)} · ${fmt((L?.end || 0) - (L?.start || 0))}</span></div><div class="ibody">${gfxInspector(c)}<div class="iactions"><button data-a="dup">Duplicate</button><button class="danger" data-a="del">Delete</button></div></div>`;
    bindGfxInspector(root, id, render);
    root.onclick = (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'del') emit('deleteSelected'); if (a === 'dup') emit('duplicateSelected'); };
    return;
  }

  const clipDefs = [];
  if (track !== 'V1') clipDefs.push(timeDef('start', 'Starts at (timeline)', '0:00.0'));
  if (isVid || isAud) clipDefs.push(timeDef('in', 'Source In', '0:00.0'), timeDef('out', 'Source Out', 'end of file'),
    { k: 'speed', label: 'Speed', type: 'select', options: [['', '1×'], [0.25, '0.25×'], [0.5, '0.5× slow-mo'], [0.75, '0.75×'], [1.25, '1.25×'], [1.5, '1.5×'], [2, '2×'], [3, '3×'], [4, '4×']] });
  if (isVid) clipDefs.push({ k: 'ramp', label: 'Speed ramp (speed changes inside the shot)', type: 'select', options: [['', 'None'], ...Object.entries(RAMPS).map(([k, r]) => [k, r.label]), ['custom', '✏ Custom (draw it in Speed ramp below)']] });
  const ang = isVid && anglesFor(c);
  if (ang) clipDefs.unshift({ k: 'mcAngle', label: '🎥 Camera angle (multicam - stays in sync)', type: 'select', options: ang.map((a) => [a.mediaId, S.mediaById[a.mediaId]?.name || a.mediaId]) });
  if (isVid) clipDefs.push({ k: 'stabilize', label: 'Stabilize (shaky footage)', type: 'select', options: STABILIZE });
  if (isVid || isImg) clipDefs.push({ k: 'cutFx.type', label: 'Cut effect (plays on the cut into this shot)', type: 'select', options: [['', 'None'], ...Object.entries(CUTFX).map(([k, x]) => [k, x.label])] },
    ...(c.cutFx?.type ? [{ k: 'cutFx.dur', label: 'Effect length', type: 'num', min: 0.1, max: 3, step: 0.05, unit: 'sec', def: CUTFX[c.cutFx.type]?.dur }] : []));
  if (isImg || isTitle || isAdj) clipDefs.push({ k: 'dur', label: 'Duration', type: 'num', min: 0.2, step: 0.1, unit: 'sec', def: isTitle ? 3 : 4 });
  if (isAdj) clipDefs.push({ k: 'opacity', label: 'Strength (how much of it shows)', type: 'range', min: 0, max: 1, step: 0.01, def: 1 });
  if (isAud) clipDefs.push({ k: 'loop', label: 'Loop to fill a longer duration', type: 'check' }, ...(c.loop ? [{ k: 'dur', label: 'Loop length', type: 'num', min: 0.5, step: 0.5, unit: 'sec' }] : []));
  if (isImg) clipDefs.push({ k: 'kenburns', label: 'Ken Burns', type: 'select', options: [['', 'Project default'], ['in', 'Zoom in'], ['out', 'Zoom out'], [false, 'Static']] });
  if (isVid) html += `<details class="isec" data-sec="ramp"${openSections.has('ramp') || c.ramp ? ' open' : ''}><summary>⏩ Speed ramp${c.ramp ? ' <span class="tag">on</span>' : ''}</summary><div class="ramp-ed" data-ramp-ed></div></details>`;
  html += sec('clip', 'Clip', fieldsHTML(clipDefs, ang ? { ...obj, mcAngle: c.mediaId } : obj) + (m ? `<div class="srcinfo">${esc(m.width ? `${m.width}×${m.height} · ${m.fps} fps · ` : '')}${esc(m.vcodec || m.acodec || '')} · ${fmt(m.duration)}<br><span title="${esc(m.path)}">${esc(m.path)}</span></div>` : ''));

  if (!isAud && !isAdj && !(isTitle && track !== 'V1')) {
    html += sec('transform', '🎬 Motion & opacity', fieldsHTML([
      { k: 'fit', label: 'Framing', type: 'select', options: [['', 'Project default'], ['fit', 'Fit (letterbox)'], ['fill', 'Fill (crop)'], ['blur', 'Blur background']] },
      { k: 'cropX', label: 'Crop position ↔', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
      { k: 'transform.zoom', label: 'Zoom', type: 'range', min: 0.5, max: 4, step: 0.01, def: 1 },
      { k: 'transform.x', label: 'Position X', type: 'range', min: -100, max: 100, step: 0.5, def: 0, unit: '%' },
      { k: 'transform.y', label: 'Position Y', type: 'range', min: -100, max: 100, step: 0.5, def: 0, unit: '%' },
      { k: 'transform.rotation', label: 'Rotation', type: 'range', min: -180, max: 180, step: 0.5, def: 0, unit: '°' },
      { k: 'opacity', label: track !== 'V1' ? 'Opacity' : 'Opacity (black shows through)', type: 'range', min: 0, max: 1, step: 0.01, def: 1 },
      ...(track !== 'V1' && (isVid || isImg) ? [{ k: 'blend', label: 'Blend mode (with the tracks below)', type: 'select', options: BLEND_MODES }] : []),
    ], obj) + `<div class="motion-presets"><span class="muted">Motion:</span>
      <button class="small" data-motion="zin">Slow zoom in</button><button class="small" data-motion="zout">Slow zoom out</button>
      <button class="small" data-motion="pan">Pan →</button><button class="small" data-motion="panl">← Pan</button>
      <button class="small" data-motion="clear">Clear motion</button></div>
      <small class="hint">◆ adds a keyframe at the playhead; with keyframes, moving a slider sets the value at the playhead.</small>`);
    html += sec('keys', '⏱ Keyframes', keyLaneHTML(c, (L?.end || 0) - (L?.start || 0)));
  }
  if (isVid) html += sec('ai', '🤖 AI picture tools', aiHTML(c));
  if (isVid || (track !== 'V1' && (isImg || isTitle))) html += sec('trk', '🎯 Tracking', trackingHTML(c, track));
  if (isVid || isImg || isAdj || (isTitle && track === 'V1')) html += sec('vfx', `✦ Video effects${c.effects?.length ? ` <span class="muted">${c.effects.length}</span>` : ''}`, effectsHTML(c, track));

  if (!isAud && !isAdj) {
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
    html += sec('text', isTitle ? 'Title' : 'Text', fieldsHTML(tdefs, obj) + (isTitle ? '<div class="iactions"><button class="small accent" data-a="tplstyle">🎨 Change style (templates)</button></div>' : ''));
  }

  if (isVid || isImg || isAdj) {
    html += sec('color', 'Color (quick)', fieldsHTML([
      { k: 'color.lut', label: 'LUT', type: 'select', options: [['', 'None'], ...S.luts.map((l) => [l, l])] },
      { k: 'color.exposure', label: 'Exposure', type: 'range', min: -3, max: 3, step: 0.05, def: 0, unit: 'stops' },
      { k: 'color.temp', label: 'Temperature', type: 'range', min: -1, max: 1, step: 0.01, def: 0 },
      { k: 'color.tint', label: 'Tint', type: 'range', min: -1, max: 1, step: 0.01, def: 0 },
      { k: 'color.contrast', label: 'Contrast', type: 'range', min: 0.3, max: 2, step: 0.01, def: 1 },
      { k: 'color.saturation', label: 'Saturation', type: 'range', min: 0, max: 2.5, step: 0.01, def: 1 },
    ], obj) + '<small class="hint">Full wheels, scopes and auto colour arrive with the Color page (Phase 2). Live preview is approximate; renders are exact.</small>');
  }

  if (isVid || isAud) {
    const adefs = [{ k: 'volume', label: 'Volume', type: 'range', min: 0, max: 2, step: 0.01, def: track === 'V2' ? 0 : 1 }, { k: 'mute', label: 'Mute this clip', type: 'check' }];
    if (isAud) adefs.push({ k: 'fadeIn', label: 'Fade in', type: 'num', min: 0, step: 0.25, unit: 'sec' }, { k: 'fadeOut', label: 'Fade out', type: 'num', min: 0, step: 0.25, unit: 'sec' });
    if (track === 'A2') adefs.push({ k: 'duck', label: 'Duck under speech (clip sound + voice-over)', type: 'check' });
    const afxNow = Object.entries(FX_PRESETS).find(([, p]) => JSON.stringify({ ...FX_DEFAULT, ...p.fx }) === JSON.stringify({ ...FX_DEFAULT, ...(c.afx || {}) }))?.[0] || (c.afx ? 'custom' : 'flat');
    const clean = track === 'A2' || !(isVid ? m?.hasAudio : true) ? '' : `<div class="iactions"><label class="fld"><span>Clean-up (this clip only)</span><select data-afx>${Object.entries(FX_PRESETS).map(([k, p]) => `<option value="${k}"${k === afxNow ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}${afxNow === 'custom' ? '<option value="custom" selected>Custom</option>' : ''}</select></label>
      <button class="small accent" data-a="autoclean" title="Measures the noise between words and picks a clean-up">✨ Auto clean</button>
      <button class="small" data-a="dub" title="Speak this clip's lines again with an AI voice: translated to English, re-voiced, or your own lines">🌐 Dub / re-voice</button></div><small class="hint">Clean-up is heard in Accurate preview and renders.</small>`;
    html += sec('audio', 'Audio', fieldsHTML(adefs, obj) + clean + (track === 'A2' ? '<button class="accent wide" data-a="best">✨ Use the best part of this music</button>' : ''));
  }

  if (track === 'V1' && f.index > 0) {
    const t = c.transitionIn || { type: 'cut', dur: 0.5 };
    html += sec('transition', 'Transition in', fieldsHTML([
      { k: 'transitionIn.type', label: 'Type', type: 'select', options: TRANSITIONS },
      { k: 'transitionIn.dur', label: 'Duration', type: 'num', min: 0.1, max: 5, step: 0.1, unit: 'sec', def: 0.5 },
    ], { transitionIn: t }) + '<button class="small" data-a="transAll">Apply to all cuts</button>');
  }
  if (isVid || isImg || (isTitle && track === 'V1')) {
    html += sec('fades', 'Fade to black', fieldsHTML([
      { k: 'fadeIn', label: 'Fade in', type: 'num', min: 0, step: 0.25, unit: 'sec' },
      { k: 'fadeOut', label: 'Fade out', type: 'num', min: 0, step: 0.25, unit: 'sec' },
    ], obj));
  }
  html += `<div class="iactions">${c.mediaId ? '<button data-a="replace" title="Swap this clip for another one - same place, length and effects">🔄 Replace…</button>' : ''}<button data-a="split">Split at playhead</button><button data-a="dup">Duplicate</button><button class="danger" data-a="del">Delete</button></div>`;
  root.innerHTML = head + `<div class="ibody">${html}</div>`;
  // ⏩ the speed ramp graph (presets + draw your own)
  const rampBox = root.querySelector('[data-ramp-ed]');
  if (rampBox) mountRamp(rampBox, () => findClip(id)?.clip, () => emit('live'), (label) => { doCommit(label); const s = root.querySelector('[data-k="ramp"], select[name="ramp"]'); if (s) s.value = findClip(id)?.clip.ramp || ''; });
  addKeyButtons(id);
  bindEffects(id);
  bindTracking(root, id, render);
  bindAi(root, id, render);
  bindKeyLane(id);

  const parse = { in: parseTime, out: parseTime, start: parseTime };
  bindFields(root, () => findClip(id)?.clip, {
    parse,
    live: (k, v) => { if (k.startsWith('transitionIn')) return; keyValue(id, k, v); emit('live'); },
    commit: (k, v) => {
      const cl = findClip(id)?.clip; if (!cl) return;
      if (k === 'mcAngle') { delete cl.mcAngle; if (switchAngle(cl, v)) { doCommit('Switch camera angle'); render(); } return; }
      if (k === 'in' || k === 'out') validateTimes(cl);
      keyValue(id, k, v);
      if (k === 'loop' && v && !cl.dur) cl.dur = +Math.max(5, duration() - (cl.start || 0)).toFixed(2);
      if (k === 'textColor' && v === '#ffffff') delete cl.textColor;
      if (k === 'cutFx.type') { if (!v) delete cl.cutFx; else cl.cutFx.dur = CUTFX[v].dur; }
      if (k === 'ramp') { if (v === 'custom') cl.rampPts ||= [[0, 1], [0.4, 1], [0.6, 0.35], [1, 0.35]]; else delete cl.rampPts; }
      cleanup(cl);
      doCommit(`Change ${k}`, `${id}:${k}`);
      if (['loop', 'in', 'out', 'speed', 'ramp', 'cutFx.type'].includes(k)) render();
    },
  });
  root.querySelector('[data-afx]')?.addEventListener('change', (e) => {
    const cl = findClip(id)?.clip, k = e.target.value; if (!cl || k === 'custom') return;
    if (k === 'flat') delete cl.afx; else cl.afx = { ...FX_DEFAULT, ...FX_PRESETS[k].fx };
    doCommit('Clip clean-up');
  });
  // transition fields edit c.transitionIn (bound to a temp object above)
  $$('[data-sec="transition"] [data-k]', root).forEach((el) => el.addEventListener('change', () => {
    const cl = findClip(id)?.clip, type = $('[data-sec="transition"] [data-k="transitionIn.type"]', root).value;
    const dur = +$('[data-sec="transition"] [data-k="transitionIn.dur"]', root).value || 0.5;
    cl.transitionIn = type === 'cut' ? undefined : { type, dur };
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
      S.project.tracks.V1.forEach((cl, i) => { if (i > 0) cl.transitionIn = tr ? { ...tr } : undefined; });
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
        toast(`✨ ${r.label} - speech is ${r.snr} dB above the noise`);
      } catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = '✨ Auto clean'; }
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
      } catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = '✨ Use the best part of this music'; }
    }
  };
}

// ---------------- video effects (clip.effects, public/js/effects.js) ----------------
function effectsHTML(c, track) {
  const list = (c.effects || []).map((e, i) => {
    const def = VFX[e.type]; if (!def) return '';
    const params = Object.entries(def.params).map(([k, p]) => {
      const v = e.p?.[k] ?? p.def;
      if (p.type === 'color') return `<label class="fld"><span>${esc(p.label)}</span><input type="color" data-ep="${k}" value="${esc(v)}"></label>`;
      if (p.type === 'select') return `<label class="fld"><span>${esc(p.label)}</span><select data-ep="${k}">${p.options.map(([o, l]) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
      return `<label class="fld"><span>${esc(p.label)} <b data-ev="${k}">${v}${p.unit || ''}</b></span><input type="range" data-ep="${k}" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}"></label>`;
    }).join('');
    const warn = def.v2only && track !== 'V2' ? '<small class="hint warn">Works on V2 overlays only (it shows the shot below).</small>' : def.stab ? '<small class="hint">🎥 Analysed and stabilised when rendering (Accurate preview / export) - the render takes longer for this shot. Perspective / Subspace Warp work like Position, Scale, Rotation here.</small>' : !def.css ? '<small class="hint">Seen in Accurate preview and renders.</small>' : '';
    return `<div class="efx${e.on === false ? ' off' : ''}" data-efx="${e.id}">
      <div class="efx-h"><button class="icon-btn small" data-ea="toggle" title="${e.on === false ? 'Turn on' : 'Turn off'}" aria-label="On / off">${e.on === false ? '◌' : '●'}</button><b>${esc(def.label)}</b><span class="grow"></span>
        <button class="icon-btn small" data-ea="up" title="Earlier in the order"${i === 0 ? ' disabled' : ''}>▲</button><button class="icon-btn small" data-ea="down" title="Later in the order"${i === c.effects.length - 1 ? ' disabled' : ''}>▼</button>
        <button class="icon-btn small" data-ea="reset" title="Reset to defaults">↺</button><button class="icon-btn small" data-ea="del" title="Remove effect">✕</button></div>
      ${params ? `<div class="fgrid">${params}</div>` : ''}${warn}</div>`;
  }).join('');
  const opts = VFX_CATS.map((cat) => `<optgroup label="${esc(cat)}">${Object.entries(VFX).filter(([, x]) => x.cat === cat).map(([k, x]) => `<option value="${k}">${esc(x.label)}</option>`).join('')}</optgroup>`).join('');
  return `<div class="efx-list">${list || '<p class="muted small">No effects yet.</p>'}</div>
    <div class="row-in"><select data-addfx><option value="">+ Add effect…</option>${opts}</select></div>
    <div class="row-in"><button class="small" data-savelook title="Save this clip's effects, colour, cut effect and blend as a preset for any clip">💾 Save look as preset</button></div>
    <small class="hint">Applied top to bottom, before Motion. More in the ✨ Effects panel (drag onto a clip).</small>`;
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
function bindKeyLane(id) {
  const kl = root.querySelector('[data-kl]'); if (!kl) return;
  const D = +kl.dataset.d || 1;
  const clipStart = () => { const f = findClip(id); return layout()[f.track].find((x) => x.clip.id === id)?.start || 0; };
  const tAt = (track, x) => { const r = track.getBoundingClientRect(); return Math.min(D, Math.max(0, ((x - r.left) / r.width) * D)); };
  kl.addEventListener('pointerdown', (e) => {
    const track = e.target.closest('.kl-track'); if (!track) return;
    const p = track.closest('[data-kp]').dataset.kp, k = e.target.closest('.kl-k');
    if (!k) { emit('seek', clipStart() + tAt(track, e.clientX)); return; }
    e.preventDefault(); try { k.setPointerCapture(e.pointerId); } catch {}
    const c = findClip(id).clip, keys = c.keys[p], j = +k.dataset.kj, key = keys[j];
    const lo = j > 0 ? keys[j - 1].t + 0.02 : 0, hi = j < keys.length - 1 ? keys[j + 1].t - 0.02 : D;
    let moved = false;
    const mv = (ev) => { key.t = +Math.min(hi, Math.max(lo, tAt(track, ev.clientX))).toFixed(3); k.style.left = `${(key.t / D) * 100}%`; moved = true; emit('live'); };
    const up = () => { k.removeEventListener('pointermove', mv); k.removeEventListener('pointerup', up); if (moved) doCommit('Move keyframe'); else emit('seek', clipStart() + key.t); };
    k.addEventListener('pointermove', mv); k.addEventListener('pointerup', up);
  });
  kl.addEventListener('dblclick', (e) => {
    const k = e.target.closest('.kl-k'); if (!k) return;
    const p = k.closest('[data-kp]').dataset.kp, c = findClip(id).clip;
    c.keys[p].splice(+k.dataset.kj, 1);
    if (!c.keys[p].length) delete c.keys[p];
    if (!Object.keys(c.keys).length) delete c.keys;
    doCommit('Delete keyframe'); render();
  });
  moveLanePlayhead();
}
function moveLanePlayhead() {
  const kl = root?.querySelector('[data-kl]'); if (!kl || S.sel.size !== 1) return;
  const id = [...S.sel][0], f = findClip(id); if (!f) return;
  const x = layout()[f.track].find((p) => p.clip.id === id), D = +kl.dataset.d || 1, rel = S.playhead - (x?.start || 0);
  kl.querySelectorAll('.kl-ph').forEach((b) => { b.hidden = rel < 0 || rel > D; b.style.left = `${(rel / D) * 100}%`; });
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
  if (key === projKey && root.querySelector('#bkList')) return;
  projKey = key;
  root.innerHTML = `<div class="ihead"><b>Project</b><span class="muted">${esc(p.name)}</span></div><div class="ibody">
    ${sec('project', 'Settings', fieldsHTML([
      { k: 'settings.aspect', label: 'Format', type: 'select', options: [['16:9', '16:9 · YouTube / Film'], ['9:16', '9:16 · Reel / Shorts'], ['1:1', '1:1 · Square'], ['4:5', '4:5 · Feed']] },
      { k: 'settings.fps', label: 'Frame rate', type: 'select', options: [[24, '24'], [25, '25'], [30, '30'], [50, '50'], [60, '60']] },
      { k: 'settings.fit', label: 'Default framing', type: 'select', options: [['', 'Auto (blur for vertical)'], ['fit', 'Fit'], ['fill', 'Fill'], ['blur', 'Blur background']] },
      { k: 'settings.kenburns', label: 'Slow zoom on photos', type: 'check' },
      { k: 'settings.loudness', label: 'Loudness', type: 'select', options: [[-14, 'Social -14 LUFS'], [-16, 'YouTube / web -16'], [-23, 'Broadcast -23'], ['off', 'Leave as is']] },
      { k: 'settings.crf', label: 'Quality', type: 'select', options: [[16, 'Master (big)'], [18, 'High'], [20, 'Standard'], [24, 'Small (WhatsApp)'], [28, 'Very small']] },
    ], p))}
    ${sec('look', '🎬 Cinematic finish', fieldsHTML([
      { k: 'settings.look.lut', label: 'Film look (whole edit)', type: 'select', options: [['', 'None'], ...FILM_LOOKS.map(([n]) => [lookLut(n), n])] },
      { k: 'settings.look.mix', label: 'Look strength', type: 'range', min: 0, max: 1, step: 0.05, def: 0.85 },
      { k: 'settings.look.letterbox', label: 'Letterbox bars', type: 'select', options: LETTERBOX },
      { k: 'settings.look.vignette', label: 'Vignette', type: 'range', min: 0, max: 1, step: 0.05, def: 0 },
      { k: 'settings.look.grain', label: 'Film grain', type: 'range', min: 0, max: 1, step: 0.05, def: 0 },
    ], p) + `<div class="iactions"><button class="small accent" data-a="cine">🎬 Make it cinematic</button><button class="small" data-a="nocine">Remove</button><button class="small" data-a="stab">🎥 Stabilize all shots</button><button class="small" data-a="nostab">No stabilize</button></div><small class="hint">Stabilize, grain and bars show in Accurate preview and renders (stabilizing makes renders slower).</small>`)}
    ${sec('logo', 'Logo / watermark', fieldsHTML([
      { k: 'logo.mediaId', label: 'Logo image', type: 'select', options: [['', 'None'], ...images.map((m) => [m.id, m.name])] },
      { k: 'logo.pos', label: 'Position', type: 'select', options: [['tr', 'Top right'], ['tl', 'Top left'], ['br', 'Bottom right'], ['bl', 'Bottom left']] },
      { k: 'logo.scale', label: 'Size', type: 'range', min: 0.04, max: 0.4, step: 0.01, def: 0.12 },
      { k: 'logo.opacity', label: 'Opacity', type: 'range', min: 0.1, max: 1, step: 0.01, def: 0.9 },
    ], p))}
    ${sec('subs', 'Subtitles', fieldsHTML([
      { k: 'subtitles.file', label: 'Burn into the video', type: 'select', options: [['', 'None'], ...S.subs.map((s) => [s.name, s.name])] },
    ], p) + '<small class="hint">Generate and proof-read subtitles on the Deliver page.</small>')}
    ${sec('backups', 'Backups', '<div id="bkList" class="muted">Loading…</div>')}
    <div class="iactions"><button data-a="folder">Open project folder</button></div>
  </div>`;
  bindFields(root, () => S.project, { live: () => emit('live'), commit: (k) => { doCommit(`Project ${k}`, k); if (k === 'settings.aspect') emit('aspect'); } });
  root.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'folder') { const r = await api('POST', `/api/open-folder?p=${enc(S.proj)}`); toast(r.folder); }
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
      <select class="kfe" data-kease="${path}" title="How the value moves between keyframes">${EASES.map(([v, l]) => `<option value="${v}">${l.split(' (')[0]}</option>`).join('')}</select></span>`);
  }
  root.querySelectorAll('[data-kease]').forEach((cb) => cb.addEventListener('change', () => {
    const c = findClip(id)?.clip; const keys = c?.keys?.[cb.dataset.kease];
    if (!keys?.length) { cb.value = ''; return toast('Add keyframes first'); }
    keys.forEach((k) => (k.ease = cb.value || undefined));
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
    const ks = el.querySelector('[data-kease]'); if (document.activeElement !== ks) ks.value = keys.length > 1 ? (keys[0].ease === true ? 'io' : keys[0].ease || '') : '';
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
  updateKeyUI();
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
