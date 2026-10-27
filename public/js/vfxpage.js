// 💥 VFX page - Hollywood-style effects three ways, on the shot picked on the timeline:
//   Presets  a gallery (live previews on hover): muzzle flash, explosion, sparks, smoke, fire, lightning, beams, force
//            field, glitch, hologram, light leaks, flares, lens dirt, rain / snow / dust, heat haze, shockwave, film
//            burn, bullet time, speed ramps, Chroma Key Pro, sky replacement, depth fog / focus, screen replacement
//   Manual   any element (vfxlib.js) or picture effect (vfxfx.js) and every parameter, keyframed at the playhead (◆)
//   AI       a sentence becomes a preset with its settings; depth / sky / subject mattes; tracking an element to what is
//            under it (track.py) or a screen's corners (planar.py)
// The page borrows the Edit page's Program monitor and timeline (put back when it closes, as the Deliver page does),
// so what you see is the real edit playing - the same drawing the render bakes / the same maths FFmpeg runs.
import { ic } from './lineicons.js';
import { S, on, emit, commit, layout, findClip } from './store.js';
import { RAMPS, rampPts } from './model.js';
import { $, $$, esc, toast, clamp } from './ui.js';
import { api, enc, watchJob } from './api.js';
import * as CV from './compvideo.js';
import { KINDS, newVfx, drawVfx } from './vfxlib.js';
import { VFX_PIC, ANIM, NEEDS_AI, setVfxAux } from './vfxfx.js';
import { PRESETS, CATS, applyPreset, fromPrompt } from './vfxpresets.js';
import { val, setKey, delKey, keyAt, animated } from './motion.js';

let root, tab = 'presets', cat = 'All', query = '', sel = null, shotId = null, homes = null, aiState = null, aiAsked = 0, busy = false;
const fps = () => S.project?.settings?.fps || 30;
const tc = (t) => { const f = fps(), fr = Math.round(Math.max(0, t) * f); return `${Math.floor(fr / f / 60)}:${String(Math.floor(fr / f) % 60).padStart(2, '0')}:${String(fr % f).padStart(2, '0')}`; };
const trackNum = (id) => +String(id).slice(1) || 0;

// 🎞 the live monitor reads the AI mattes / a new sky picture through the Edit viewer's video pool
const skyImgs = new Map();
setVfxAux((f, t, rate) => {
  if (f.startsWith('media:')) {
    const m = S.mediaById[f.slice(6)]; if (!m) return null;
    if (m.kind === 'video') return S.progPlaying ? CV.follow('view', m.id, t % (m.duration || 1e9), 1) : CV.frame('view', m.id, t % (m.duration || 1e9), () => emit('live'));
    let im = skyImgs.get(m.id);
    if (!im) { im = new Image(); im.onload = () => emit('live'); im.src = m.urls?.play; skyImgs.set(m.id, im); }
    return im.complete && im.naturalWidth ? im : null;
  }
  const id = `url:/api/vfxai/file?p=${encodeURIComponent(S.proj)}&f=${encodeURIComponent(f)}`;
  return S.progPlaying ? CV.follow('view', id, Math.max(0, t), rate) : CV.frame('view', id, Math.max(0, t), () => emit('live'));
});

// ---------------- the shot and its VFX ----------------
const placedAll = () => Object.entries(layout()).flatMap(([track, l]) => l.map((x) => ({ ...x, track })));
const isShot = (x) => x && x.track[0] === 'V' && (x.clip.type === 'video' || x.clip.type === 'image');
const shotAt = (all, t) => all.filter((y) => isShot(y) && t >= y.start && t < y.end).sort((a, b) => trackNum(b.track) - trackNum(a.track))[0] || null;
function target() {
  if (!S.project) return null;
  const all = placedAll(), id = [...S.sel][0], x = id && all.find((y) => y.clip.id === id);
  if (x?.clip.gfx?.tpl === 'vfx') { const s = all.find((y) => y.clip.id === x.clip.vfxOf) || shotAt(all, x.start + 0.01); if (s) { sel = { kind: 'el', id: x.clip.id }; shotId = s.clip.id; return s; } }
  if (isShot(x)) { if (shotId !== x.clip.id) { shotId = x.clip.id; sel = null; } return x; }
  const keep = shotId && all.find((y) => y.clip.id === shotId);
  if (keep) return keep;
  const s = shotAt(all, S.playhead); if (s) shotId = s.clip.id;
  return s;
}
function layersOf(x) {
  if (!x) return [];
  const els = placedAll().filter((y) => y.clip.gfx?.tpl === 'vfx' && (y.clip.vfxOf === x.clip.id || (!y.clip.vfxOf && y.start < x.end && y.end > x.start)))
    .map((y) => ({ kind: 'el', id: y.clip.id, c: y.clip, start: y.start, end: y.end, track: y.track, label: KINDS[y.clip.gfx.vfx?.kind]?.label || 'Element' }));
  const fx = (x.clip.effects || []).filter((e) => VFX_PIC[e.type]).map((e) => ({ kind: 'fx', id: e.id, e, label: VFX_PIC[e.type].label }));
  return [...els, ...fx];
}
const shotName = (x) => (x ? `${x.track} · ${S.mediaById[x.clip.mediaId]?.name || 'clip'}` : '');

// ---------------- page ----------------
export function mountVfx(el) {
  root = el;
  el.innerHTML = `<div class="vx">
    <div class="panel vx-lib">
      <div class="vx-tabs" role="tablist" aria-label="VFX"><button role="tab" data-tab="presets">${ic('star')}Presets</button><button role="tab" data-tab="manual">${ic('adjust')}Manual</button><button role="tab" data-tab="ai">${ic('sparkle')}AI</button></div>
      <div class="vx-body" id="vxBody"></div>
    </div>
    <div class="panel vx-mon">
      <div class="vx-mhead"><b class="vx-title">VFX</b><span class="vx-shot" id="vxShot"></span><span class="grow"></span><span class="vx-live"><i></i>Live preview · the render draws the same</span></div>
      <div class="vx-host" id="vxMon"></div>
    </div>
    <div class="panel vx-insp" id="vxInsp"></div>
    <div class="vx-tl" id="vxTl"></div>
  </div>`;
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  el.addEventListener('change', onChange);
  el.addEventListener('mouseover', (e) => { const c = e.target.closest('[data-preset]'); if (c && c !== hoverCard) hoverOn(c); });
  el.addEventListener('mouseout', (e) => { const c = e.target.closest('[data-preset]'); if (c && !c.contains(e.relatedTarget)) hoverOff(); });
  on('change', () => { if (S.page === 'vfx') refresh(); });
  on('select', () => { if (S.page === 'vfx') refresh(); });
  on('playhead', () => { if (S.page === 'vfx') tick(); });
  on('openVfx', (c) => openVfxClip(c));
}
export function showVfx() {
  // the Program monitor and the timeline come over from the Edit page
  const v = document.getElementById('viewer'), t = document.getElementById('timeline');
  homes ||= { v: v && { p: v.parentElement, n: v.nextSibling }, t: t && { p: t.parentElement, n: t.nextSibling } };
  if (v && v.parentElement !== $('#vxMon', root)) $('#vxMon', root).append(v);
  if (t && t.parentElement !== $('#vxTl', root)) $('#vxTl', root).append(t);
  dispatchEvent(new Event('resize'));
  checkAi();
  refresh();
}
export function hideVfx() {
  hoverOff();
  for (const [k, id] of [['v', 'viewer'], ['t', 'timeline']]) {
    const e = document.getElementById(id), h = homes?.[k];
    if (e && h && e.parentElement !== h.p) h.p.insertBefore(e, h.n && h.n.parentElement === h.p ? h.n : null);
  }
  dispatchEvent(new Event('resize'));
}
export function openVfxClip(c) { if (c?.id) { S.sel.clear(); S.sel.add(c.id); } emit('gotoPage', 'vfx'); }

function refresh() {
  if (!root || !S.project) return;
  $$('[data-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  const x = target();
  $('#vxShot', root).textContent = x ? shotName(x) : 'Click a shot on the timeline';
  renderBody(x);
  renderInsp(x);
}

// ---------------- left: presets / manual / AI ----------------
function renderBody(x) {
  const body = $('#vxBody', root);
  if (tab === 'presets') {
    const qq = query.trim().toLowerCase();
    const list = PRESETS.filter((p) => (cat === 'All' || p.cat === cat) && (!qq || `${p.name} ${p.words} ${p.cat}`.toLowerCase().includes(qq)));
    const keepQ = body.querySelector('#vxQ');
    if (!keepQ) body.innerHTML = `<div class="vx-search">${ic('search')}<input type="search" id="vxQ" placeholder="Search ${PRESETS.length} effects…" aria-label="Search effects"></div><div class="vx-cats" id="vxCats"></div><div class="vx-grid" id="vxGrid"></div>`;
    $('#vxCats', body).innerHTML = ['All', ...CATS].map((c) => `<button class="vx-chip${c === cat ? ' on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
    const sig = list.map((p) => p.id).join(',') + (x?.clip.mediaId || '');
    const grid = $('#vxGrid', body);
    if (grid.dataset.sig !== sig) {
      grid.dataset.sig = sig;
      grid.innerHTML = list.map((p) => `<button class="vx-card" data-preset="${p.id}" title="${esc(p.name)} - click to put it on the shot"><canvas width="224" height="126"></canvas><span class="vx-cn">${esc(p.name)}</span>${p.ai ? '<i class="vx-ai">AI</i>' : ''}${p.ramp ? '<i class="vx-ai vx-time">TIME</i>' : ''}</button>`).join('') || '<p class="muted small pad">Nothing found.</p>';
      sceneFor(x, () => $$('[data-preset]', grid).forEach((c) => drawCard(c)));
      $$('[data-preset]', grid).forEach((c) => drawCard(c));
    }
    return;
  }
  if (tab === 'manual') {
    if (body.dataset.tab === 'manual') return;
    body.innerHTML = `<div class="vx-sec"><b>Elements</b><small>drawn over the shot · each on its own track</small></div>
      <div class="vx-items">${Object.entries(KINDS).map(([k, d]) => `<button class="vx-item" data-add-el="${k}"><canvas width="64" height="36"></canvas><span>${esc(d.label)}</span>${ic('plus')}</button>`).join('')}</div>
      <div class="vx-sec"><b>Picture effects</b><small>change the shot's own pixels</small></div>
      <div class="vx-items">${Object.entries(VFX_PIC).map(([k, d]) => `<button class="vx-item" data-add-fx="${k}"><i class="vx-fxi">${ic('bolt')}</i><span>${esc(d.label.replace(' (AI)', ''))}</span>${NEEDS_AI[k] ? '<i class="vx-ai">AI</i>' : ''}${ic('plus')}</button>`).join('')}</div>
      <div class="vx-sec"><b>Time</b><small>speed ramps with optical-flow slow motion</small></div>
      <div class="vx-items">${['bullet', 'hit', 'in', 'punch', 'hero', 'whoosh'].map((k) => `<button class="vx-item" data-add-ramp="${k}"><i class="vx-fxi">${ic('ramp')}</i><span>${esc(RAMPS[k].label)}</span>${ic('plus')}</button>`).join('')}</div>
      <p class="hint small">Pick a shot on the timeline, add, then set every parameter on the right - ◆ makes a keyframe at the playhead.</p>`;
    body.dataset.tab = 'manual';
    $$('[data-add-el] canvas', body).forEach((cv) => { const k = cv.closest('[data-add-el]').dataset.addEl; drawMini(cv, k); });
    return;
  }
  // AI
  const st = aiState;
  body.innerHTML = `<div class="vx-ai-prompt">
      <label class="vx-sec"><b>Describe the effect</b><small>English, Hindi or Hinglish</small></label>
      <textarea id="vxPrompt" rows="3" placeholder="a big explosion behind him at 2 s · halki barish · blue laser from the left · sunset sky · heavy glitch"></textarea>
      <div class="vx-row"><button class="accent" data-ai="prompt">${ic('sparkle')}Make it</button><span class="muted small" id="vxPromptOut"></span></div></div>
    <div class="vx-sec"><b>One-click AI</b><small>on the selected shot</small></div>
    <div class="vx-aigrid">
      <button class="vx-aib" data-ai="sky"><b>Replace the sky</b><small>finds the sky in every frame</small></button>
      <button class="vx-aib" data-ai="fog"><b>Depth fog</b><small>thicker far away</small></button>
      <button class="vx-aib" data-ai="dof"><b>Depth of field</b><small>background goes soft</small></button>
      <button class="vx-aib" data-ai="subject"><b>Keep the person clean</b><small>selected effect stays off the subject</small></button>
      <button class="vx-aib" data-ai="track"><b>Track element</b><small>it follows what is under it</small></button>
      <button class="vx-aib" data-ai="planar"><b>Track a screen</b><small>corners follow a phone / TV</small></button>
    </div>
    <div class="vx-setup${st?.ready ? ' ok' : ''}">${st?.ready ? `${ic('check')}<span>VFX AI is ready on this PC (GPU)</span>`
      : st?.setting ? `<span class="vx-spin"></span><span>${esc(st.setting.stage || 'Setting up…')}</span>`
      : `<span>Depth and sky need the VFX AI on this PC (about 3 GB, once).</span><button class="small accent" data-ai="setup">Set up</button>`}</div>
    <p class="hint small">Models: Depth Anything V2 Small (Apache-2.0) for depth and sky, DeepLabV3 (BSD) for the subject, OpenCV tracking - all fine for client work.</p>`;
  body.dataset.tab = 'ai';
}
// 🖼 the picture under the gallery's previews: the shot's own thumbnail, or a dusk street drawn here
let scene = null, sceneKey = '';
function sceneFor(x, redraw) {
  const m = x && S.mediaById[x.clip.mediaId], key = m?.urls?.thumb || '';
  if (scene && key === sceneKey) return scene;
  sceneKey = key;
  const cv = document.createElement('canvas'); cv.width = 224; cv.height = 126;
  const g = cv.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 126);
  gr.addColorStop(0, '#1a2233'); gr.addColorStop(0.55, '#3b3a44'); gr.addColorStop(0.56, '#1d1c20'); gr.addColorStop(1, '#0d0d0f');
  g.fillStyle = gr; g.fillRect(0, 0, 224, 126);
  g.fillStyle = '#121216'; [[10, 40, 30], [44, 52, 22], [70, 30, 26], [150, 46, 30], [184, 36, 40]].forEach(([x0, h0, w0]) => g.fillRect(x0, 70 - h0, w0, h0));
  g.fillStyle = 'rgba(255,200,120,.5)'; for (let i = 0; i < 18; i++) g.fillRect(14 + ((i * 37) % 200), 36 + ((i * 13) % 28), 2, 2);
  scene = cv;
  if (key) { const im = new Image(); im.onload = () => { if (sceneKey !== key) return; const s = Math.max(224 / im.naturalWidth, 126 / im.naturalHeight); g.drawImage(im, (224 - im.naturalWidth * s) / 2, (126 - im.naturalHeight * s) / 2, im.naturalWidth * s, im.naturalHeight * s);
    g.fillStyle = 'rgba(0,0,0,.42)'; g.fillRect(0, 0, 224, 126); redraw?.(); }; im.src = key; } // (dimmed: the light effects read on a daylight shot)
  return scene;
}
const tmp = document.createElement('canvas');
// a card's picture at time t (seconds into the preset): the scene, its picture effects, then its elements
function drawCard(card, t = null) {
  const p = PRESETS.find((x) => x.id === card.dataset.preset), cv = card.querySelector('canvas'); if (!p || !cv) return;
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  t ??= idleT(p);
  g.globalCompositeOperation = 'source-over'; g.filter = 'none';
  g.drawImage(scene || sceneFor(null), 0, 0, W, H);
  for (const e of p.effects || []) {
    if (e.type === 'vxsky') { const gr = g.createLinearGradient(0, 0, 0, H * 0.55); gr.addColorStop(0, e.p.top || '#1d3b78'); gr.addColorStop(1, e.p.horizon || '#ff9a5a'); g.fillStyle = gr; g.fillRect(0, 0, W, H * 0.55); }
    else if (e.type === 'vxfog') { const gr = g.createLinearGradient(0, H, 0, 0); gr.addColorStop(0, 'rgba(201,211,220,0.05)'); gr.addColorStop(0.6, 'rgba(201,211,220,0.75)'); gr.addColorStop(1, 'rgba(201,211,220,0.85)'); g.fillStyle = gr; g.fillRect(0, 0, W, H); }
    else if (e.type === 'vxdof') { g.filter = 'blur(3px)'; g.drawImage(cv, 0, 0); g.filter = 'none'; g.save(); g.beginPath(); g.ellipse(W / 2, H * 0.62, W * 0.2, H * 0.35, 0, 0, Math.PI * 2); g.clip(); g.drawImage(scene, 0, 0, W, H); g.restore(); }
    else if (e.type === 'vxkey') { g.fillStyle = '#00b140'; g.fillRect(0, 0, W * 0.5, H); g.fillStyle = '#e8c9a0'; g.beginPath(); g.ellipse(W * 0.25, H * 0.7, W * 0.09, H * 0.32, 0, 0, Math.PI * 2); g.fill(); g.strokeStyle = 'rgba(255,207,154,.8)'; g.lineWidth = 2; g.stroke(); g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(W * 0.5 - 1, 0, 2, H); }
    else VFX_PIC[e.type]?.pix?.(g, W, H, { ...e.p }, { rel: t, c: {} });
  }
  if (p.ramp) {
    const pts = RAMPS[p.ramp].pts, mx = Math.max(...pts.map((q) => q[1]));
    g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, H - 42, W, 42);
    g.strokeStyle = '#ffc21a'; g.lineWidth = 2; g.beginPath(); pts.forEach(([u, s], i) => { const px = 10 + u * (W - 20), py = H - 8 - (s / mx) * 28; i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.stroke();
    const u = (t % 2.5) / 2.5; g.fillStyle = '#fff'; g.beginPath(); g.arc(10 + u * (W - 20), H - 8 - (rampAtU(pts, u) / mx) * 28, 3, 0, Math.PI * 2); g.fill();
  }
  if (tmp.width !== W || tmp.height !== H) { tmp.width = W; tmp.height = H; }
  const tg = tmp.getContext('2d');
  (p.layers || []).forEach((l, i) => {
    drawVfx(tg, W, H, newVfx(l.kind, l.kind === 'screen' ? { ...l.p, glare: 0.3 } : l.p, 7 + i), t, 3);
    g.globalCompositeOperation = KINDS[l.kind].blend === 'screen' ? 'screen' : 'source-over';
    g.drawImage(tmp, 0, 0); g.globalCompositeOperation = 'source-over';
  });
}
const rampAtU = (pts, u) => { for (let i = 0; i < pts.length - 1; i++) if (u <= pts[i + 1][0]) { const [a, sa] = pts[i], [b, sb] = pts[i + 1]; return sa + (sb - sa) * ((u - a) / Math.max(1e-6, b - a)); } return pts[pts.length - 1][1]; };
// the moment a card shows when still: just after its flash / strike / shot
function idleT(p) {
  const ats = (p.layers || []).map((l) => l.p.at ?? KINDS[l.kind].params.at?.def).filter((x) => x !== undefined);
  const sh = (p.effects || []).find((e) => e.type === 'vxshock');
  if (p.id === 'burn' || p.id === 'burnout') return 1.5;
  if (sh) return (sh.p.start ?? 0.2) + 0.32;
  return ats.length ? Math.max(...ats) + (p.layers.some((l) => l.kind === 'lightning') ? 0.01 : 0.22) : 1.2;
}
let hoverCard = null, hoverRaf = 0;
function hoverOn(c) {
  hoverOff(); hoverCard = c;
  const p = PRESETS.find((x) => x.id === c.dataset.preset), t0 = performance.now(), span = Math.max(2.5, idleT(p) + 1.5);
  const loop = () => { if (hoverCard !== c) return; drawCard(c, ((performance.now() - t0) / 1000) % span); hoverRaf = requestAnimationFrame(loop); };
  loop();
}
function hoverOff() { cancelAnimationFrame(hoverRaf); const c = hoverCard; hoverCard = null; if (c) drawCard(c); }
function drawMini(cv, kind) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.fillStyle = '#111114'; g.fillRect(0, 0, W, H);
  // (a moment each one shows well: inside the blast, the strike, a shot; the rest once they have built up)
  const d = KINDS[kind], at = { explosion: 0.5, lightning: 0.02, muzzle: 1 }[kind] ?? 1.5;
  if (tmp.width !== W || tmp.height !== H) { tmp.width = W; tmp.height = H; }
  drawVfx(tmp.getContext('2d'), W, H, newVfx(kind, {}, 11), at, 3);
  g.globalCompositeOperation = d.blend === 'screen' ? 'screen' : 'source-over'; g.drawImage(tmp, 0, 0); g.globalCompositeOperation = 'source-over';
}

// ---------------- right: the shot's VFX layers and the selected one's parameters ----------------
function renderInsp(x) {
  const box = $('#vxInsp', root);
  if (!x) { box.innerHTML = `<div class="vx-empty">${ic('target')}<b>Pick a shot</b><span>Click a video clip on the timeline below, then choose a preset or add an element.</span></div>`; return; }
  const L = layersOf(x);
  if (sel && !L.some((l) => l.kind === sel.kind && l.id === sel.id)) sel = null;
  if (!sel && L.length) sel = { kind: L[0].kind, id: L[0].id };
  const cur = L.find((l) => sel && l.kind === sel.kind && l.id === sel.id);
  box.innerHTML = `<div class="vx-ih"><b>On this shot</b><span class="muted small">${L.length} VFX</span></div>
    <div class="vx-layers">${L.map((l) => `<div class="vx-layer${cur === l ? ' on' : ''}${(l.kind === 'fx' ? l.e.on === false : S.project.trackState?.[l.track]?.hide) ? ' off' : ''}" data-layer="${l.kind}:${l.id}">
      <i class="vx-dot ${l.kind}"></i><span class="grow">${esc(l.label)}</span>${l.kind === 'fx' && NEEDS_AI[l.e.type] && !l.e.p?.ai ? '<i class="vx-ai warn" title="Its AI matte is not made yet - AI tab">AI</i>' : ''}${l.kind === 'fx' && l.e.p?.subj ? `<i class="vx-ai" title="The subject is kept clean">${ic('eye')}</i>` : ''}
      ${l.kind === 'fx' ? `<button class="icon-btn small" data-lact="toggle" title="${l.e.on === false ? 'Turn on' : 'Turn off'}">${ic(l.e.on === false ? 'circle' : 'radio')}</button>` : ''}<button class="icon-btn small" data-lact="del" title="Remove">✕</button></div>`).join('') || '<p class="muted small pad">No VFX on this shot yet - pick a preset on the left.</p>'}</div>
    <div class="vx-params" id="vxParams">${cur ? paramsHTML(x, cur) : ''}</div>`;
}
// the time a layer's parameters are read / keyed at: seconds into that element clip, or into the shot
const tOf = (x, l) => +(S.playhead - (l.kind === 'el' ? l.start : x.start)).toFixed(4);
const pdefs = (l) => (l.kind === 'el' ? KINDS[l.c.gfx.vfx.kind]?.params : VFX_PIC[l.e.type]?.params) || {};
const canKey = (l, k, d) => (l.kind === 'el' ? d.type !== 'select' && d.type !== 'media' : (ANIM[l.e.type] || []).includes(k));
function getP(l, k, t) {
  const d = pdefs(l)[k];
  if (l.kind === 'el') { const v = val(l.c.gfx.vfx.p?.[k], t); return v ?? d.def; }
  const p = l.e.p || {};
  return p._k?.[k] ? val(p._k[k], t) : p[k] ?? d.def;
}
const propOf = (l, k) => (l.kind === 'el' ? l.c.gfx.vfx.p?.[k] : l.e.p?._k?.[k]);
function paramsHTML(x, l) {
  const t = tOf(x, l), defs = pdefs(l);
  const rows = Object.entries(defs).map(([k, d]) => {
    const v = getP(l, k, t), pr = propOf(l, k), an = animated(pr), at = an && keyAt(pr, t) >= 0;
    const kf = canKey(l, k, d) ? `<button class="vx-kf${an ? ' an' : ''}${at ? ' at' : ''}" data-kf="${k}" title="${an ? (at ? 'Remove this keyframe' : 'Add a keyframe here') : 'Animate: a keyframe at the playhead'} (Shift-click: remove all its keyframes)">◆</button>` : '<span class="vx-kf none"></span>';
    if (d.type === 'color') return `<div class="vx-p">${kf}<label>${esc(d.label)}</label><input type="color" data-pk="${k}" value="${esc(v)}"></div>`;
    if (d.type === 'select') return `<div class="vx-p">${kf}<label>${esc(d.label)}</label><select data-pk="${k}">${d.options.map(([o, lb]) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(lb)}</option>`).join('')}</select></div>`;
    if (d.type === 'media') return `<div class="vx-p">${kf}<label>${esc(d.label)}</label><select data-pk="${k}"><option value="">Pick from Media…</option>${S.media.filter((m) => m.kind === 'image' || m.kind === 'video').slice(0, 1500).map((m) => `<option value="${m.id}"${m.id === v ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>`;
    if (d.type === 'quad') return `<div class="vx-p vx-quad">${kf}<label>${esc(d.label)}</label><div class="vx-q4">${(Array.isArray(v) ? v : d.def).map((n, i) => `<input type="number" step="0.5" data-pq="${k}:${i}" value="${(+n).toFixed(1)}" aria-label="${['TL x', 'TL y', 'TR x', 'TR y', 'BL x', 'BL y', 'BR x', 'BR y'][i]}">`).join('')}</div></div>`;
    return `<div class="vx-p">${kf}<label>${esc(d.label)}</label><input type="range" data-pk="${k}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}"><output data-pv="${k}">${fmtV(v, d)}</output></div>`;
  }).join('');
  const keys = keyTimes(l), head = `<div class="vx-ph"><b>${esc(l.label)}</b><span class="grow"></span>${keys.length ? `<button class="icon-btn small" data-kn="-1" title="Previous keyframe">${ic('prev')}</button><span class="muted small">${keys.length} keys</span><button class="icon-btn small" data-kn="1" title="Next keyframe">${ic('next')}</button>` : ''}</div>`;
  const timing = l.kind === 'el' ? `<div class="vx-timing"><label>Starts<input type="number" step="0.04" data-el="start" value="${(+l.c.start || 0).toFixed(2)}"></label><label>Length<input type="number" step="0.04" min="0.2" data-el="dur" value="${(+l.c.dur || 0).toFixed(2)}"></label>
      <label>Blend<select data-el="blend">${[['', 'Normal'], ['screen', 'Screen (light)'], ['addition', 'Add'], ['overlay', 'Overlay'], ['multiply', 'Multiply']].map(([o, lb]) => `<option value="${o}"${(l.c.blend || '') === o ? ' selected' : ''}>${lb}</option>`).join('')}</select></label>
      <button class="small" data-el="seed" title="A new random look (same settings)">${ic('rotate')}New look</button></div>` : '';
  const ai = l.kind === 'fx' && NEEDS_AI[l.e.type] ? `<div class="vx-row"><button class="small${l.e.p?.ai ? '' : ' accent'}" data-ai="${NEEDS_AI[l.e.type]}-this">${l.e.p?.ai ? 'Make the AI matte again' : `Make the ${NEEDS_AI[l.e.type]} matte (AI)`}</button>${l.e.type === 'vxsky' ? `<select data-sky aria-label="Sky picture"><option value="">Sky: the colours above</option>${S.media.filter((m) => m.kind === 'image' || m.kind === 'video').slice(0, 1500).map((m) => `<option value="${m.id}"${m.id === l.e.p?.skyMedia ? ' selected' : ''}>Sky: ${esc(m.name)}</option>`).join('')}</select>` : ''}</div>` : '';
  const sub = l.kind === 'fx' && l.e.type !== 'vxkey' && l.e.type !== 'vxsky' ? `<label class="vx-chk"><input type="checkbox" data-subj${l.e.p?.subj ? ' checked' : ''}> Keep the person clean (AI subject matte)</label>` : '';
  const trk = l.kind === 'el' && 'x' in pdefs(l) ? `<button class="small" data-ai="track">${ic('target')}Track to what is under it</button>` : l.kind === 'el' && l.c.gfx.vfx.kind === 'screen' ? `<button class="small" data-ai="planar">${ic('target')}Track the screen's corners</button>` : '';
  return `${head}${timing}${ai}<div class="vx-plist">${rows}</div>${sub}${trk ? `<div class="vx-row">${trk}</div>` : ''}
    <p class="hint small">◆ at a parameter = a keyframe at the playhead (${tc(S.playhead)}). Change it at another time and it animates between them.</p>`;
}
const fmtV = (v, d) => `${+(+v).toFixed(d.step < 0.1 ? 2 : d.step < 1 ? 1 : 0)}${d.unit || ''}`;
const keyTimes = (l) => [...new Set(Object.keys(pdefs(l)).flatMap((k) => (animated(propOf(l, k)) ? propOf(l, k).k.map((q) => q.t) : [])))].sort((a, b) => a - b);
// while the playhead moves: values and the ◆ marks follow (no rebuild)
function tick() {
  const x = target(); if (!x) return;
  const l = layersOf(x).find((y) => sel && y.kind === sel.kind && y.id === sel.id); if (!l) return;
  const t = tOf(x, l), defs = pdefs(l);
  $$('[data-kf]', root).forEach((b) => { const pr = propOf(l, b.dataset.kf), an = animated(pr); b.classList.toggle('an', an); b.classList.toggle('at', an && keyAt(pr, t) >= 0); });
  $$('[data-pk]', root).forEach((inp) => { const k = inp.dataset.pk; if (!animated(propOf(l, k)) || document.activeElement === inp) return; const v = getP(l, k, t); inp.value = v; const o = root.querySelector(`[data-pv="${k}"]`); if (o) o.textContent = fmtV(v, defs[k]); });
}
const curLayer = () => { const x = target(); return { x, l: x && layersOf(x).find((y) => sel && y.kind === sel.kind && y.id === sel.id) }; };
// a parameter set at the playhead: a keyframe when it is animated, else the still value
function setP(x, l, k, v) {
  const t = tOf(x, l);
  if (l.kind === 'el') { const p = l.c.gfx.vfx.p; p[k] = animated(p[k]) ? setKey(p[k], t, v) : v; return; }
  const p = (l.e.p ||= {});
  if (p._k?.[k]) p._k[k] = setKey(p._k[k], t, v); else p[k] = v;
}
function toggleKey(x, l, k, all) {
  const t = tOf(x, l), pr = propOf(l, k), cur = getP(l, k, t);
  let next;
  if (all) next = animated(pr) ? cur : pr;
  else if (!animated(pr)) next = setKey(cur, t, cur);
  else next = keyAt(pr, t) >= 0 ? delKey(pr, t) : setKey(pr, t, cur);
  if (l.kind === 'el') l.c.gfx.vfx.p[k] = next;
  else { const p = (l.e.p ||= {}); if (animated(next)) p._k = { ...(p._k || {}), [k]: next }; else { p[k] = next; if (p._k) { delete p._k[k]; if (!Object.keys(p._k).length) delete p._k; } } }
  commit(`VFX keyframe: ${k}`);
}

// ---------------- events ----------------
function onClick(e) {
  const b = e.target.closest('button, [data-layer]'); if (!b || !root.contains(b)) return;
  if (b.dataset.tab) { tab = b.dataset.tab; delete $('#vxBody', root).dataset.tab; $('#vxBody', root).innerHTML = ''; if (tab === 'ai') checkAi(true); return refresh(); }
  if (b.dataset.cat) { cat = b.dataset.cat; return renderBody(target()); }
  if (b.dataset.preset) return applyP(PRESETS.find((p) => p.id === b.dataset.preset));
  if (b.dataset.addEl) return applyP({ name: KINDS[b.dataset.addEl].label, layers: [{ kind: b.dataset.addEl, p: {} }] });
  if (b.dataset.addFx) return applyP({ name: VFX_PIC[b.dataset.addFx].label, effects: [{ type: b.dataset.addFx, p: {} }], ai: NEEDS_AI[b.dataset.addFx] });
  if (b.dataset.addRamp) return applyP({ name: RAMPS[b.dataset.addRamp].label, ramp: b.dataset.addRamp, zoom: b.dataset.addRamp === 'bullet' ? 1.1 : 0 });
  if (b.dataset.ai) return aiAction(b.dataset.ai);
  if (b.dataset.kn) { const { x, l } = curLayer(); if (!l) return; const ks = keyTimes(l), t = tOf(x, l), d = +b.dataset.kn, k = d > 0 ? ks.find((q) => q > t + 1e-3) : [...ks].reverse().find((q) => q < t - 1e-3); if (k !== undefined) emit('seek', (l.kind === 'el' ? l.start : x.start) + k); return; }
  if (b.dataset.kf) { const { x, l } = curLayer(); if (l) toggleKey(x, l, b.dataset.kf, e.shiftKey); return; }
  if (b.dataset.el === 'seed') { const { l } = curLayer(); if (l?.kind === 'el') { l.c.gfx.vfx.seed = Math.floor(Math.random() * 1e6); commit('VFX: new look'); } return; }
  const lay = b.closest('[data-layer]');
  if (lay) {
    const [kind, id] = lay.dataset.layer.split(':'), act = e.target.closest('[data-lact]')?.dataset.lact, x = target();
    if (act === 'del') {
      if (kind === 'el') { const f = findClip(id); if (f) S.project.tracks[f.track].splice(f.index, 1); } else x.clip.effects = x.clip.effects.filter((q) => q.id !== id);
      sel = null; commit('VFX: remove'); return;
    }
    if (act === 'toggle') { const q = x.clip.effects.find((y) => y.id === id); if (q) { q.on = q.on === false; commit(q.on ? 'VFX on' : 'VFX off'); } return; }
    sel = { kind, id };
    if (kind === 'el') { const f = findClip(id); if (f && !(S.playhead >= f.clip.start && S.playhead < f.clip.start + f.clip.dur)) emit('seek', f.clip.start + Math.min(0.5, f.clip.dur / 2)); }
    renderInsp(x);
  }
}
function onInput(e) {
  const inp = e.target;
  if (inp.id === 'vxQ') { query = inp.value; return renderBody(target()); }
  const { x, l } = curLayer(); if (!l) return;
  if (inp.dataset.pk) {
    const k = inp.dataset.pk, d = pdefs(l)[k], v = d.type === 'color' || d.type === 'select' || d.type === 'media' ? inp.value || null : +inp.value;
    setP(x, l, k, v);
    const o = root.querySelector(`[data-pv="${k}"]`); if (o) o.textContent = fmtV(v, d);
    emit('live');
  }
  if (inp.dataset.pq) {
    const [k, i] = inp.dataset.pq.split(':'), q = [...(getP(l, k, tOf(x, l)) || pdefs(l)[k].def)];
    q[+i] = +inp.value; setP(x, l, k, q); emit('live');
  }
}
function onChange(e) {
  const inp = e.target, { x, l } = curLayer(); if (!l) return;
  if (inp.dataset.pk || inp.dataset.pq) return commit(`VFX: ${inp.dataset.pk || 'corners'}`, `vfx:${l.id}:${inp.dataset.pk || inp.dataset.pq}`);
  if (inp.dataset.el && l.kind === 'el') {
    const k = inp.dataset.el;
    if (k === 'blend') { if (inp.value) l.c.blend = inp.value; else delete l.c.blend; }
    else l.c[k] = Math.max(k === 'dur' ? 0.2 : 0, +inp.value || 0);
    return commit(`VFX: ${k}`);
  }
  if (inp.matches('[data-sky]')) { l.e.p = { ...l.e.p }; if (inp.value) l.e.p.skyMedia = inp.value; else delete l.e.p.skyMedia; return commit('VFX: sky picture'); }
  if (inp.matches('[data-subj]')) {
    if (inp.checked) return makeSubject(x, [l.e.id]);
    l.e.p = { ...l.e.p }; delete l.e.p.subj; delete l.e.p.subjT0; return commit('VFX: subject not kept');
  }
}

// ---------------- doing ----------------
function applyP(p, over = {}, subject = false) {
  if (!p) return;
  if (S.readOnly) return toast('View only - this project cannot be changed here', 'err');
  const x = target();
  if (!x) return toast('Click a shot on the timeline first', 'err');
  if ((p.effects?.length || p.ramp) && x.clip.type !== 'video' && x.clip.type !== 'image') return toast('This one changes the picture itself - pick a video or photo clip', 'err');
  if (p.ramp && x.clip.type !== 'video') return toast('Speed ramps need a video clip', 'err');
  if (p.ramp && rampPts(x.clip)) toast('Its earlier speed ramp was replaced');
  const r = applyPreset(S.project, x.clip, p, S.mediaById, { start: x.start, dur: x.end - x.start }, x.track, over);
  if (r.clips[0]) { sel = { kind: 'el', id: r.clips[0].clip.id }; S.sel.clear(); S.sel.add(r.clips[0].clip.id); } else if (r.effects[0]) sel = { kind: 'fx', id: r.effects[0] };
  shotId = x.clip.id;
  commit(`VFX: ${p.name}`);
  toast(`${p.name} - on ${shotName(x)}${r.clips.length ? ` (${r.clips.map((c) => c.track).join(', ')})` : ''}`);
  if (p.ai && x.clip.type === 'video') makeAi(p.ai, x.clip.id);
  if (subject && r.effects.length) makeSubject(x, r.effects);
  else if (subject) toast('Elements are drawn over the picture - "keep the person clean" works on picture effects');
  return r;
}
async function checkAi(force = false) {
  if (!force && aiState && Date.now() - aiAsked < 30000) return aiState;
  aiAsked = Date.now();
  try { aiState = await api('GET', '/api/vfxai'); } catch { aiState = { ready: false }; }
  if (S.page === 'vfx' && tab === 'ai') renderBody(target());
  return aiState;
}
const range = (x) => { const c = x.clip, a = +c.in || 0; return [a, c.out ?? a + (x.end - x.start) * (c.speed || 1)]; };
async function makeAi(kind, clipId) {
  if (busy) return toast('An AI step is already running', 'err');
  const st = await checkAi(true);
  if (!st.ready) { tab = 'ai'; delete $('#vxBody', root).dataset.tab; refresh(); return toast('The VFX AI is not set up on this PC yet - press Set up (once)', 'err'); }
  const x = placedAll().find((y) => y.clip.id === clipId); if (!x || x.clip.type !== 'video') return toast('AI mattes need a video clip', 'err');
  const [a, b] = range(x);
  busy = true;
  try {
    const job = await api('POST', `/api/vfxai?p=${enc(S.proj)}`, { kind, mediaId: x.clip.mediaId, in: a, out: b, fps: fps() });
    const j = await watchJob(job.id, (y) => emit('job', { running: true, label: `${kind === 'sky' ? 'Finding the sky' : 'Measuring depth'} (AI)… ${y.progress || 0}%` }));
    const c = findClip(clipId)?.clip; if (!c) return;
    let n = 0;
    for (const e of c.effects || []) if (NEEDS_AI[e.type] === kind) { e.p = { ...e.p, ai: j.result.file, aiT0: j.result.t0 }; n++; }
    commit(`VFX AI: ${kind}`);
    toast(n ? `${kind === 'sky' ? 'Sky found' : 'Depth measured'} in every frame - the effect follows it` : 'Matte made');
  } catch (e) { toast(e.job ? `AI step failed: ${e.job.error || e.job.log?.slice(-1)[0] || ''}` : e.message, 'err'); }
  finally { busy = false; emit('job', { running: false }); }
}
async function makeSubject(x, effectIds) {
  if (busy) return toast('An AI step is already running', 'err');
  if (x.clip.type !== 'video') return toast('The subject matte needs a video clip', 'err');
  const [a, b] = range(x), id = x.clip.id;
  busy = true;
  try {
    const job = await api('POST', `/api/matte?p=${enc(S.proj)}`, { mediaId: x.clip.mediaId, in: a, out: b, fps: fps() });
    const j = await watchJob(job.id, (y) => emit('job', { running: true, label: `Finding the subject (AI)… ${y.progress || 0}%` }));
    const c = findClip(id)?.clip; if (!c) return;
    for (const e of c.effects || []) if (effectIds.includes(e.id)) e.p = { ...e.p, subj: `mattes/${j.result.file}`, subjT0: +(+a).toFixed(3) };
    commit('VFX: keep the person clean');
    toast('The person is kept clean of the effect');
  } catch (e) { toast(e.job ? `Could not find the subject: ${e.job.error || e.job.log?.slice(-1)[0] || ''}` : e.message, 'err'); }
  finally { busy = false; emit('job', { running: false }); }
}
async function aiAction(a) {
  const x = target();
  if (a === 'setup') {
    try {
      const job = await api('POST', '/api/vfxai/setup');
      aiState = { ready: false, setting: { stage: 'Starting…' } }; renderBody(x);
      await watchJob(job.id, (y) => { aiState = { ready: false, setting: { stage: `${y.stage || 'Setting up'} ${y.progress || 0}%` } }; if (tab === 'ai') renderBody(target()); });
      toast('VFX AI is ready on this PC');
    } catch (e) { toast(e.job ? `Setup failed: ${e.job.error || ''}` : e.message, 'err'); }
    return checkAi(true);
  }
  if (a === 'prompt') {
    const text = $('#vxPrompt', root)?.value || '', r = fromPrompt(text), out = $('#vxPromptOut', root);
    if (!r) { if (out) out.textContent = 'Not understood - try "explosion", "rain", "laser", "sunset sky"…'; return; }
    if (out) out.innerHTML = r.why.map((w) => `<i class="vx-chip on">${esc(w)}</i>`).join(' ');
    return applyP(r.preset, r.over, r.subject);
  }
  if (!x) return toast('Click a shot on the timeline first', 'err');
  if (a === 'sky') return applyP(PRESETS.find((p) => p.id === 'skysunset'));
  if (a === 'fog') return applyP(PRESETS.find((p) => p.id === 'fog'));
  if (a === 'dof') return applyP(PRESETS.find((p) => p.id === 'dof'));
  if (a === 'sky-this' || a === 'depth-this') return makeAi(a.split('-')[0], x.clip.id);
  const { l } = curLayer();
  if (a === 'subject') {
    if (l?.kind !== 'fx') return toast('Select a picture effect on the right (heat haze, fog, glitch…) - elements are drawn over the picture', 'err');
    return makeSubject(x, [l.id]);
  }
  if (a === 'track' || a === 'planar') return track(x, l, a === 'planar');
}
// 🎯 an element follows what is under it (its position keyed every frame the tracker gives), or a screen's corners
async function track(x, l, planar) {
  if (l?.kind !== 'el') return toast('Select an element on the right first', 'err');
  if (x.clip.type !== 'video') return toast('Tracking needs a video shot', 'err');
  if (busy) return toast('An AI step is already running', 'err');
  const v = l.c.gfx.vfx, c = x.clip, sp = c.speed || 1, tEl = tOf(x, l), [a, b] = range(x), rel = S.playhead - x.start, t0 = clamp(a + rel * sp, a, b - 0.1);
  const toEl = (ft) => +((ft - a) / sp + x.start - l.start).toFixed(3);
  busy = true;
  try {
    if (planar || v.kind === 'screen') {
      const q = val(v.p.q, tEl) || KINDS.screen.params.q.def;
      const job = await api('POST', `/api/planar?p=${enc(S.proj)}`, { mediaId: c.mediaId, ts: a, t0, te: b, quad: q.map((n) => clamp(n / 100, 0, 1)) });
      const j = await watchJob(job.id, (y) => emit('job', { running: true, label: `Tracking the screen… ${y.progress || 0}%` }));
      const pts = j.result.points || []; if (pts.length < 2) throw new Error('The screen could not be followed');
      v.p.q = { k: pts.map((pt) => ({ t: toEl(pt.t), v: pt.q.map((n) => +(n * 100).toFixed(2)), e: [0, 0, 1, 1] })) };
    } else {
      const px = +val(v.p.x, tEl), py = +val(v.p.y, tEl);
      const box = { x: clamp(px / 100 - 0.05, 0, 0.9), y: clamp(py / 100 - 0.05, 0, 0.9), w: 0.1, h: 0.1 };
      const job = await api('POST', `/api/track?p=${enc(S.proj)}`, { mediaId: c.mediaId, t0, t1: b, box });
      const j = await watchJob(job.id, (y) => emit('job', { running: true, label: `Tracking… ${y.progress || 0}%` }));
      const pts = (j.result.points || []).filter((_, i) => i % 2 === 0); if (pts.length < 2) throw new Error('Nothing to follow there - put the element on something with detail');
      const cx = (pt) => (pt.x + pt.w / 2) * 100, cy = (pt) => (pt.y + pt.h / 2) * 100, dx0 = cx(pts[0]) - px, dy0 = cy(pts[0]) - py;
      const keys = (f, off) => ({ k: pts.map((pt) => ({ t: toEl(pt.t), v: +(f(pt) - off).toFixed(2), e: [0, 0, 1, 1] })) });
      v.p.x = keys(cx, dx0); v.p.y = keys(cy, dy0);
      // (a beam / bolt: its far end moves with it)
      if ('x2' in KINDS[v.kind].params) { const x2 = +val(v.p.x2, tEl), y2 = +val(v.p.y2, tEl); v.p.x2 = keys((pt) => cx(pt) - px + x2, dx0); v.p.y2 = keys((pt) => cy(pt) - py + y2, dy0); }
    }
    commit('VFX: tracked');
    toast('Tracked - the element follows the shot now (keyframes on its position)');
  } catch (e) { toast(e.job ? `Tracking failed: ${e.job.error || e.job.log?.slice(-1)[0] || ''}` : e.message, 'err'); }
  finally { busy = false; emit('job', { running: false }); }
}
