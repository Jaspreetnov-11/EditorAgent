// ✨ Effects panel (Premiere's Effects panel): transitions, cut effects, video effects and audio clean-ups in folders,
// with search. Drag an item onto a clip on the timeline (a transition onto a cut), or select clips and double-click
// it. Applied effects are then adjusted in Effect Controls (the Inspector).
import { S, on, emit, commit, findClip } from './store.js';
import { loadLib, libCached, applyFxPreset, deletePreset } from './library.js';
import { TRANSITIONS, RAMPS, setRamp, setTransition } from './model.js';
import { CUTFX } from './fx.js';
import { VFX, VFX_CATS, newEffect } from './effects.js';
import { FX_PRESETS, FX_DEFAULT } from './audiofx.js';
import { $, esc, toast } from './ui.js';

const ICON = { transition: '⧓', cutfx: '⚡', vfx: '✦', afx: '🎚', preset: '⭐', ramp: '⏩' };
const RAMP_CAT = '⏩ Speed ramp (presets)';
let root, query = '', open = new Set(['⭐ My presets', 'Transitions', RAMP_CAT]), trDur = 0.5;

function items() {
  const out = [];
  const mine = libCached()?.presets?.fx || [];
  if (mine.length) out.push(['⭐ My presets', mine.map((p) => ({ kind: 'preset', type: p.id, label: p.name }))]);
  out.push(['Transitions', TRANSITIONS.filter(([k]) => k !== 'cut').map(([k, l]) => ({ kind: 'transition', type: k, label: l }))]);
  // (speed ramp presets live in Effect Controls › ⏩ Speed ramp, not in the Effects panel)
  out.push(['Cut effects (on the cut, keep the beat)', Object.entries(CUTFX).map(([k, x]) => ({ kind: 'cutfx', type: k, label: x.label }))]);
  for (const cat of VFX_CATS) out.push([`Video effects · ${cat}`, Object.entries(VFX).filter(([, x]) => x.cat === cat).map(([k, x]) => ({ kind: 'vfx', type: k, label: x.label, hint: x.v2only ? 'V2 overlays' : '' }))]);
  out.push(['Audio clean-up', Object.entries(FX_PRESETS).filter(([k]) => k !== 'flat').map(([k, x]) => ({ kind: 'afx', type: k, label: x.label }))]);
  return out;
}

export function mountFxPanel(el) {
  root = el;
  el.innerHTML = `<div class="fxp-bar"><input type="search" placeholder="Search effects" data-q aria-label="Search effects">
      <label class="muted small" title="Length of transitions you add">⧓ <input type="number" min="0.1" max="3" step="0.1" value="${trDur}" data-trdur> s</label></div>
    <div class="fxp-list" data-list></div>
    <p class="fxp-help muted small">Drag onto a clip (a transition onto a cut), or select clips and double-click. Adjust in <b>Effect Controls</b> →</p>`;
  $('[data-q]', el).oninput = (e) => { query = e.target.value.toLowerCase(); draw(); };
  $('[data-trdur]', el).onchange = (e) => { trDur = Math.min(3, Math.max(0.1, +e.target.value || 0.5)); };
  el.addEventListener('click', async (e) => {
    const dp = e.target.closest('[data-delpreset]')?.dataset.delpreset;
    if (dp) { e.stopPropagation(); if (confirm('Delete this preset?')) { await deletePreset('fx', dp); draw(); } return; }
    const h = e.target.closest('[data-cat]'); if (!h) return;
    const k = h.dataset.cat; open.has(k) ? open.delete(k) : open.add(k); draw();
  });
  el.addEventListener('dblclick', (e) => { const it = e.target.closest('[data-fx]'); if (it) applyToSelection(JSON.parse(it.dataset.fx)); });
  el.addEventListener('dragstart', (e) => {
    const it = e.target.closest('[data-fx]'); if (!it) return;
    e.dataTransfer.setData('text/x-fx', it.dataset.fx); e.dataTransfer.effectAllowed = 'copy';
    // (only the types can be read while dragging: this one tells the timeline to show where a transition would sit)
    if (JSON.parse(it.dataset.fx).kind === 'transition') e.dataTransfer.setData('text/x-fx-transition', '1');
  });
  on('library', draw);
  loadLib().then(draw).catch(() => {});
  draw();
}

function draw() {
  if (!root) return;
  const html = items().map(([cat, list]) => {
    const vis = list.filter((x) => !query || x.label.toLowerCase().includes(query) || x.type.includes(query));
    if (!vis.length) return '';
    const isOpen = query || open.has(cat);
    return `<div class="fxp-cat"><button class="fxp-h" data-cat="${esc(cat)}" aria-expanded="${!!isOpen}">${isOpen ? '▾' : '▸'} ${esc(cat)} <span class="muted">${vis.length}</span></button>
      ${isOpen ? `<div class="fxp-items">${vis.map((x) => `<div class="fxp-it" draggable="true" data-fx='${esc(JSON.stringify({ kind: x.kind, type: x.type }))}' title="Drag onto a clip, or double-click to apply to the selected clips"><i>${ICON[x.kind]}</i><span>${esc(x.label)}</span>${x.hint ? `<small class="muted">${esc(x.hint)}</small>` : ''}${x.kind === 'preset' ? `<button class="link small" data-delpreset="${esc(x.type)}" title="Delete this preset">✕</button>` : ''}</div>`).join('')}</div>` : ''}</div>`;
  }).join('');
  $('[data-list]', root).innerHTML = html || '<p class="muted pad">No effect matches.</p>';
}

// Apply one effect to a clip. Returns a short message, or null when it does not fit that clip.
export function applyFx(fx, clipId) {
  const f = findClip(clipId), c = f?.clip; if (!c) return null;
  const visual = c.type === 'video' || c.type === 'image' || c.type === 'title';
  if (fx.kind === 'transition') {
    if (f.track !== 'V1') return 'Transitions go between shots on V1';
    if (f.index === 0) return 'The first shot has no cut before it';
    if (!setTransition(S.project, S.mediaById, f.index, fx.type, trDur)) return 'Neither shot has frames to spare beyond its ends for a transition';
    return `${TRANSITIONS.find(([k]) => k === fx.type)?.[1]} on the cut`;
  }
  if (fx.kind === 'ramp') { if (!setRamp(c, fx.type, S.mediaById)) return null; return `⏩ ${RAMPS[fx.type].label}`; }
  if (fx.kind === 'cutfx') { if (!visual || c.type === 'title') return null; c.cutFx = { type: fx.type, dur: CUTFX[fx.type].dur }; return CUTFX[fx.type].label; }
  if (fx.kind === 'vfx') {
    if (!visual) return null;
    if (VFX[fx.type].v2only && f.track !== 'V2') return 'Green screen works on a V2 overlay (it shows the shot below)';
    (c.effects ||= []).push(newEffect(fx.type));
    return VFX[fx.type].label;
  }
  if (fx.kind === 'preset') {
    const p = libCached()?.presets?.fx?.find((x) => x.id === fx.type);
    if (!p || !visual || c.type === 'title') return null;
    return `⭐ ${applyFxPreset(p, c)}`;
  }
  if (fx.kind === 'afx') {
    const m = S.mediaById[c.mediaId];
    if (!(c.type === 'audio' || (c.type === 'video' && m?.hasAudio))) return null;
    c.afx = { ...FX_DEFAULT, ...FX_PRESETS[fx.type].fx };
    return FX_PRESETS[fx.type].label;
  }
  return null;
}

function applyToSelection(fx) {
  const ids = [...S.sel];
  if (!ids.length) return toast('Select clips on the timeline first (or drag the effect onto one)', 'err');
  const msgs = ids.map((id) => applyFx(fx, id)).filter(Boolean);
  if (!msgs.length) return toast("That effect does not fit the selected clips", 'err');
  commit(`Apply ${fx.type}`); emit('select'); showInEC(fx);
  toast(`✨ ${msgs[msgs.length - 1]}${ids.length > 1 ? ` · ${ids.length} clips` : ''}`);
}
// 🎛 an effect just put on a clip opens in Effect Controls, ready to adjust by hand
const EC_SECTION = { vfx: 'vfx', preset: 'vfx', cutfx: 'cutfx', ramp: 'ramp', transition: 'transition', afx: 'audio' };
function showInEC(fx) { if (EC_SECTION[fx.kind]) emit('inspect', EC_SECTION[fx.kind]); }

export const transitionLength = () => trDur;
// timeline drop: a transition dropped near a clip's start goes on that cut, near its end on the next cut
export function dropFx(fx, clipId, relX) {
  let id = clipId;
  if (fx.kind === 'transition') {
    const f = findClip(clipId);
    if (f?.track === 'V1' && relX > 0.5) { const nx = S.project.tracks.V1[f.index + 1]; if (nx) id = nx.id; }
  }
  const msg = applyFx(fx, id);
  if (!msg) return toast('That effect does not fit this clip', 'err');
  S.sel = new Set([id]);
  commit(`Apply ${fx.type}`); emit('select'); showInEC(fx);
  toast(`✨ ${msg}`);
}
