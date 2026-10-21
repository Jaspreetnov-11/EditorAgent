// ✨ Fusion page (Resolve-style nodes): a clip's picture flows MediaIn → nodes → MediaOut. Drag a node's right dot
// (output) onto another node's left dot (input) to connect; click a connected input dot to cut it; drag nodes to
// arrange; Delete removes the selected node. The viewer shows the output, or the selected node (press 1 / 2).
// Right-click a video clip on the timeline → "✨ Open in Fusion", or start from a style on the left.
import { S, on, emit, commit, layout } from './store.js';
import { ASPECTS, uid, trackList, addTrack, clipDur } from './model.js';
import { $, $$, esc, toast, clamp } from './ui.js';
import * as F from './fusion.js';
import * as CV from './compvideo.js';
import { api, enc, watchJob } from './api.js';
import { matteId, cutOut } from './mattecut.js';

let root, fid = null, selId = null, T = 0, playing = false, raf = 0, view = 'out', pan = [0, 0];
const fusions = () => (S.project.fusions ||= {});
const fu = () => S.project && fusions()[fid];
const node = (id) => fu()?.nodes.find((n) => n.id === id);
const fps = () => S.project?.settings?.fps || 30;
const tc = (t) => { const f = fps(), fr = Math.round(t * f); return `${Math.floor(fr / f / 60)}:${String(Math.floor(fr / f) % 60).padStart(2, '0')}:${String(fr % f).padStart(2, '0')}`; };
const frameSize = () => ASPECTS[S.project.settings.aspect] || [1920, 1080];

function save(label, coalesce) {
  const f = fu(); if (!f) return;
  const copy = JSON.parse(JSON.stringify(f));
  const fix = (tracks) => { for (const [t, l] of Object.entries(tracks || {})) if (t[0] === 'V') for (const x of l) if (x.type === 'graphic' && x.gfx?.tpl === 'fusion' && x.gfx.fusionId === f.id) { x.gfx = { tpl: 'fusion', fusionId: f.id, fusion: copy }; x.dur = f.dur; } };
  fix(S.project.tracks);
  for (const s of Object.values(S.project.sequences || {})) fix(s.data?.tracks);
  commit(label, coalesce);
}

export function mountFusion(el) {
  root = el;
  el.innerHTML = `<div class="fu">
    <div class="panel fu-lib"><div class="mo-head"><b>Fusions</b><span class="grow"></span><button class="small" data-f="new" title="New fusion from a clip in Media">＋ New ▾</button></div>
      <div class="mo-list" id="fuList"></div>
      <div class="mo-head sub"><b>Styles</b><span class="muted small">replace the graph</span></div><div class="fu-styles" id="fuStyles"></div>
      <div class="mo-head sub"><b>Nodes</b><span class="muted small">click to add</span></div><div class="fu-nodes" id="fuNodes"></div></div>
    <div class="panel fu-view">
      <div class="mo-head"><div class="segbtns"><button data-view="out">Output (1)</button><button data-view="sel">Selected node (2)</button></div><span class="grow"></span>
        <button class="accent small" data-f="toTimeline" title="Put this fusion on the edit's timeline at the playhead">⤵ Add to timeline</button></div>
      <div class="mo-stage" id="fuStage"><div class="mo-canvas"><canvas id="fuCanvas"></canvas></div><div class="mo-empty" id="fuEmpty">Right-click a video clip on the Edit timeline → ✨ Open in Fusion, or ＋ New.</div></div>
      <div class="mo-trans"><button class="icon-btn" data-f="start">⏮</button><button class="icon-btn" data-f="play">▶</button><input type="range" id="fuPos" min="0" max="1" step="0.001" value="0" aria-label="Time"><span class="tc" id="fuTC">0:00:00</span></div>
    </div>
    <div class="panel fu-insp" id="fuInsp"></div>
    <div class="panel fu-graph"><div class="mo-head"><b>Nodes</b><span class="muted small">drag ● output → ● input to connect · click a connected input to cut · Delete removes · drag empty space to pan · wheel zooms · double-click empty = fit</span></div>
      <div class="fu-gwrap" id="fuGWrap"><canvas id="fuGraph"></canvas></div></div>
  </div>`;
  el.addEventListener('click', onClick);
  $('#fuPos', el).oninput = (e) => { stop(); seek(+e.target.value * (fu()?.dur || 0)); };
  new ResizeObserver(() => { size(); draw(); }).observe($('#fuStage', el));
  new ResizeObserver(() => drawGraph()).observe($('#fuGWrap', el));
  wireGraph(); wireKeys();
  on('change', () => { if (S.page === 'fusion') refresh(); });
}
export function showFusion() { if (!fu()) fid = Object.keys(fusions())[0] || null; refresh(); }
export function hideFusion() { stop(); }
function refresh() {
  if (!root || !S.project) return;
  if (fid && !fu()) { fid = Object.keys(fusions())[0] || null; selId = null; }
  if (selId && !node(selId)) selId = null;
  T = clamp(T, 0, fu()?.dur || 0);
  renderLib(); renderInsp(); size(); draw(); drawGraph();
  $('#fuEmpty', root).hidden = !!fu();
  $$('[data-view]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
}

// ---------------- library ----------------
function renderLib() {
  const list = Object.values(fusions());
  $('#fuList', root).innerHTML = list.length ? list.map((f) => `<div class="mo-comp${f.id === fid ? ' on' : ''}" data-fid="${f.id}" title="Double-click to rename"><span>✨</span><span class="grow">${esc(f.name)}</span><span class="muted small">${f.dur}s</span><button class="icon-btn" data-fdel="${f.id}" title="Delete">✕</button></div>`).join('') : '<div class="muted small pad">No fusions yet.</div>';
  $$('[data-fid]', root).forEach((r) => {
    r.onclick = (e) => { if (e.target.closest('button')) return; fid = r.dataset.fid; selId = null; T = 0; refresh(); };
    r.ondblclick = () => { const f = fusions()[r.dataset.fid], n = prompt('Fusion name', f.name)?.trim(); if (n) { f.name = n; save('Rename fusion'); } };
  });
  $$('[data-fdel]', root).forEach((b) => (b.onclick = () => { const f = fusions()[b.dataset.fdel]; if (!confirm(`Delete the fusion "${f.name}"? Clips of it already on the timeline stay as they are.`)) return; delete fusions()[f.id]; commit('Delete fusion'); }));
  $('#fuStyles', root).innerHTML = Object.entries(F.STYLES).map(([k, s]) => `<button class="mo-preset" data-style="${k}">${esc(s.name)}</button>`).join('');
  $('#fuNodes', root).innerHTML = F.GROUPS.map((g) => `<div class="fu-grp">${g}</div>` + Object.entries(F.NODES).filter(([k, d]) => d.group === g && k !== 'mediaOut').map(([k, d]) => `<button class="fu-nb" data-add="${k}" style="--nc:${d.color}">${esc(d.label)}</button>`).join('')).join('');
}
function newFrom(mediaId, srcIn = 0, speed = 1, dur = 5, name) {
  const [w, h] = frameSize(), m = S.mediaById[mediaId];
  const f = F.newFusion(name || `${(m?.name || 'Fusion').replace(/\.[^.]+$/, '')} fusion`, w, h, dur, { mediaId, srcIn, speed });
  fusions()[f.id] = f; fid = f.id; selId = null; T = 0;
  return f;
}
function onClick(e) {
  const b = e.target.closest('[data-f], [data-style], [data-add], [data-view]'); if (!b) return;
  if (b.dataset.view) { view = b.dataset.view; refresh(); return; }
  if (b.dataset.style) {
    const f = fu(); if (!f) return toast('Make or open a fusion first', 'err');
    const src = f.nodes.find((n) => n.type === 'mediaIn') || F.newNode('mediaIn', 40, 160);
    const keep = { ...src, in: {}, x: 40, y: 160 }, g = F.STYLES[b.dataset.style].make(keep);
    f.nodes = g.nodes; f.out = g.out; selId = null;
    save(`Fusion style: ${F.STYLES[b.dataset.style].name}`);
    // ✂ the text-behind style finds the subject right away (one click)
    const sb = f.nodes.find((x) => x.type === 'subject' && !x.p.matte);
    if (sb) findSubject(sb);
    return;
  }
  if (b.dataset.add) {
    const f = fu(); if (!f) return toast('Make or open a fusion first', 'err');
    const wr = $('#fuGWrap', root), n = F.newNode(b.dataset.add, wr.clientWidth / 2 - pan[0] - 60 + Math.random() * 40, wr.clientHeight / 2 - pan[1] - 20 + Math.random() * 40);
    // dropped after the selected node: wired in between it and what it fed
    const s = node(selId);
    if (s && F.NODES[n.type].ins.length && s.type !== 'mediaOut') {
      const slot = F.NODES[n.type].ins[0];
      for (const o of f.nodes) for (const [k, v] of Object.entries(o.in || {})) if (v === s.id) o.in[k] = n.id;
      n.in[slot] = s.id; n.x = s.x + 170; n.y = s.y + 60;
    }
    clearSpot(f, n); f.nodes.push(n); selId = n.id;
    return save(`Add ${F.NODES[n.type].label}`);
  }
  const a = b.dataset.f;
  if (a === 'play') playing ? stop() : play();
  if (a === 'start') seek(0);
  if (a === 'toTimeline') toTimeline();
  if (a === 'new') {
    const vids = S.media.filter((m) => m.kind === 'video');
    if (!vids.length) return toast('Bring a video into Media first', 'err');
    pick(b, vids.slice(0, 80).map((m) => [m.id, m.name]), (id) => { newFrom(id, 0, 1, Math.min(10, +(S.mediaById[id].duration || 5).toFixed(2))); commit('New fusion'); });
  }
}
function pick(anchor, items, fn) {
  document.querySelector('.ui-menu')?.remove();
  const m = document.createElement('div'); m.className = 'ui-menu';
  m.innerHTML = items.map(([k, l]) => `<button data-k="${esc(k)}">${esc(l)}</button>`).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect(); m.style.top = `${Math.min(innerHeight - m.offsetHeight - 8, r.bottom + 4)}px`; m.style.left = `${Math.max(8, r.left)}px`;
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
  m.onclick = (e) => { const x = e.target.closest('[data-k]'); if (!x) return; m.remove(); document.removeEventListener('pointerdown', close, true); fn(x.dataset.k); };
}

// ---------------- the fusion on the edit ----------------
function placeOver(f, start, track) {
  const ids = trackList(S.project).filter((x) => x.kind === 'video').map((x) => x.id), from = Math.max(0, ids.indexOf(track));
  const free = (id) => !(S.project.tracks[id] || []).some((x) => (x.start || 0) < start + f.dur && (x.start || 0) + clipDur(x, S.mediaById) > start);
  const tr = ids.slice(from + 1).find(free) || addTrack(S.project, 'video');
  S.project.tracks[tr].push({ id: uid(), type: 'graphic', start: +start.toFixed(3), dur: f.dur, gfx: { tpl: 'fusion', fusionId: f.id, fusion: JSON.parse(JSON.stringify(f)) } });
  return tr;
}
function toTimeline() { const f = fu(); if (!f) return; const tr = placeOver(f, S.playhead || 0, 'V1'); commit(`Add fusion "${f.name}" to the timeline`); toast(`⤵ "${f.name}" is on ${tr} at the playhead`); }
// right-click a video clip → ✨ Open in Fusion: a fusion of that clip, laid exactly over it (the clip keeps its sound)
export function fusionFromClip(clipId, findClip) {
  const f0 = findClip(clipId), c = f0?.clip, m = c && S.mediaById[c.mediaId];
  if (!c || c.type !== 'video' || !m) { toast('Right-click a video clip', 'err'); return false; }
  const start = Object.values(layout()).flat().find((x) => x.clip.id === c.id)?.start ?? c.start ?? 0, dur = +clipDur(c, S.mediaById).toFixed(3);
  const f = newFrom(m.id, +(c.in || 0), c.speed || 1, dur);
  const tr = placeOver(f, start, f0.track);
  commit(`Open in Fusion: ${m.name}`);
  toast(`✨ "${f.name}" made on ${tr} over the clip (maroon) - double-click it to open it in Fusion`);
  return true;
}
export function openFusionClip(clip) {
  const g = clip.gfx || {};
  if (!fusions()[g.fusionId] && g.fusion) { const f = JSON.parse(JSON.stringify(g.fusion)); fusions()[f.id] = f; g.fusionId = f.id; commit('Bring back fusion'); }
  fid = g.fusionId; selId = null; T = 0;
}

// ---------------- viewer ----------------
function size() {
  const st = $('#fuStage', root), f = fu(), cv = $('#fuCanvas', root); if (!st || !f) return;
  const k = Math.min((st.clientWidth - 24) / f.w, (st.clientHeight - 24) / f.h), w = Math.max(16, Math.round(f.w * k)), h = Math.max(9, Math.round(f.h * k));
  cv.style.width = `${w}px`; cv.style.height = `${h}px`; $('.mo-canvas', root).style.width = `${w}px`; $('.mo-canvas', root).style.height = `${h}px`;
  const dpr = Math.min(1.5, devicePixelRatio || 1); cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
}
function draw() {
  const f = fu(), cv = $('#fuCanvas', root); if (!cv) return;
  const g = cv.getContext('2d');
  if (!f) { g.clearRect(0, 0, cv.width, cv.height); return; }
  const video = (id, t) => (playing ? CV.get('fusion', id) : CV.frame('fusion', id, t, draw));
  try { F.drawFusion(g, cv.width, cv.height, f, T, { video, placeholder: true, cut: cutOut }, view === 'sel' && selId ? selId : null); } catch (e) { console.error(e); }
  $('#fuTC', root).textContent = `${tc(T)} / ${tc(f.dur)}`;
  $('#fuPos', root).value = f.dur ? T / f.dur : 0;
}
function seek(t) { T = clamp(t, 0, fu()?.dur || 0); draw(); }
function play() {
  const f = fu(); if (!f) return;
  playing = true; $('[data-f="play"]', root).textContent = '❚❚';
  if (T >= f.dur - 0.05) T = 0;
  let last = performance.now();
  const step = (now) => { if (!playing) return; T += (now - last) / 1000; last = now; if (T >= f.dur) T = 0; CV.play('fusion', F.fusionVideos(f, T)); draw(); raf = requestAnimationFrame(step); };
  raf = requestAnimationFrame(step);
}
function stop() { playing = false; cancelAnimationFrame(raf); CV.pause('fusion'); const b = root && $('[data-f="play"]', root); if (b) b.textContent = '▶'; if (root && fu()) setTimeout(draw, 0); }

// ---------------- inspector ----------------
function renderInsp() {
  const el = $('#fuInsp', root), n = node(selId);
  if (!n) { el.innerHTML = '<div class="mo-head"><b>Inspector</b></div><div class="muted pad small">Click a node in the graph to change its settings.<br><br>Tip: pick a style on the left first, then fine-tune its nodes here.</div>'; return; }
  const d = F.NODES[n.type];
  el.innerHTML = `<div class="mo-head"><span class="fu-dot" style="background:${d.color}"></span><b>${esc(d.label)}</b><span class="grow"></span>${n.type !== 'mediaOut' ? '<button class="small danger" data-ndel>Delete</button>' : ''}</div>
    <div class="mo-scroll fu-params">${d.params.map(([k, label, kind, def, a, b, step]) => {
      const v = n.p?.[k] ?? def;
      const inp = kind === 'num' ? `<input type="range" min="${a}" max="${b}" step="${step}" value="${v}" data-pk="${k}"><input type="number" class="mo-num" step="${step}" value="${v}" data-pn="${k}">`
        : kind === 'color' ? `<input type="color" value="${v}" data-pk="${k}">`
        : kind === 'select' ? `<select data-pk="${k}">${a.map((o) => `<option${String(o) === String(v) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
        : kind === 'matte' ? `<button class="accent small" data-findsubj>${v ? '↻ Find the subject again' : '✂ Find the subject (AI)'}</button><span class="muted small">${v ? 'Ready ✓ - follows the subject in every frame' : 'Not made yet'}</span>`
        : kind === 'media' ? `<select data-pk="${k}">${S.media.filter((m) => m.kind === 'video' || m.kind === 'image').slice(0, 400).map((m) => `<option value="${m.id}"${m.id === v ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`
        : `<textarea rows="2" data-pk="${k}">${esc(v)}</textarea>`;
      return `<label class="fu-p"><span>${label}</span><span class="fu-pi">${inp}</span></label>`;
    }).join('') || '<div class="muted small">MediaOut: what reaches the edit. Connect the last node into it.</div>'}
    ${d.ins.length ? `<div class="muted small fu-ins">Inputs: ${d.ins.map((s) => `<b>${s}</b> ← ${esc(F.NODES[node(n.in?.[s])?.type]?.label || '-')}`).join(' · ')}</div>` : ''}</div>`;
  $$('[data-pk]', el).forEach((i) => {
    const k = i.dataset.pk, num = i.type === 'range';
    i.oninput = () => { n.p[k] = num ? +i.value : i.value; if (num) $(`[data-pn="${k}"]`, el).value = i.value; draw(); };
    i.onchange = () => save(`${d.label}: ${k}`, `fu-${n.id}-${k}`);
  });
  $$('[data-pn]', el).forEach((i) => (i.onchange = () => { n.p[i.dataset.pn] = +i.value; save(`${d.label}: ${i.dataset.pn}`); }));
  $('[data-ndel]', el)?.addEventListener('click', delSel);
  $('[data-findsubj]', el)?.addEventListener('click', () => findSubject(n));
}
// ✂ one-click roto: the AI matte of the fusion's clip (engine/matte.py on the editor's GPU), for a Subject Matte node
let finding = false;
async function findSubject(n) {
  const f = fu(), src = f?.nodes.find((x) => x.type === 'mediaIn' && x.p.mediaId);
  if (!src) return toast('Connect a MediaIn with a clip first', 'err');
  if (finding) return toast('Already finding the subject - one moment');
  finding = true;
  const sp = +src.p.speed || 1, a = +src.p.srcIn || 0;
  try {
    emit('job', { running: true, label: '✂ Finding the subject (AI)…' });
    const job = await api('POST', `/api/matte?p=${enc(S.proj)}`, { mediaId: src.p.mediaId, in: a, out: a + f.dur * sp, fps: fps() });
    const j = await watchJob(job.id, (x) => emit('job', { running: true, label: `✂ Finding the subject (AI)… ${x.progress || 0}%` }));
    n.p.matte = matteId(S.proj, j.result.file); n.p.mSpeed = sp;
    save('Subject matte (AI)');
    toast('✂ Subject found in every frame - it now sits in front of what is behind it');
  } catch (e) { toast(e.job ? `Could not find the subject: ${e.job.log?.slice(-1)[0] || ''}` : e.message, 'err'); }
  finally { finding = false; emit('job', { running: false }); }
}
function delSel() {
  const f = fu(), n = node(selId); if (!f || !n || n.type === 'mediaOut') return;
  // whatever it fed now gets what fed it (keeps the chain joined)
  const up = n.in?.input || n.in?.background || null;
  for (const o of f.nodes) for (const [k, v] of Object.entries(o.in || {})) if (v === n.id) { if (up) o.in[k] = up; else delete o.in[k]; }
  f.nodes = f.nodes.filter((x) => x !== n); selId = null;
  save(`Delete ${F.NODES[n.type].label}`);
}

// ---------------- node graph ----------------
const NW = 132, NH = 38;
// a new node never lands on top of another one: it moves down (then right) to the first free place
function clearSpot(f, n) {
  const hit = () => f.nodes.some((o) => o !== n && Math.abs(o.x - n.x) < NW + 12 && Math.abs(o.y - n.y) < NH + 14);
  for (let k = 0; k < 40 && hit(); k++) { n.y += NH + 16; if (k % 6 === 5) { n.y -= 6 * (NH + 16); n.x += NW + 30; } }
  n.x = Math.round(n.x); n.y = Math.round(n.y);
}
let gz = 1; // graph zoom (mouse wheel; fitted when a fusion opens)
const portIn = (n, i, cnt) => [n.x * gz + pan[0], (n.y + (NH * (i + 1)) / (cnt + 1)) * gz + pan[1]];
const portOut = (n) => [(n.x + NW) * gz + pan[0], (n.y + NH / 2) * gz + pan[1]];
// centre the nodes in the graph panel (a fusion opened / a style picked)
let fitted = '';
function fitGraph(force) {
  const f = fu(), wr = $('#fuGWrap', root); if (!f || !wr?.clientWidth) return;
  const key = `${f.id}:${f.out}`; if (!force && key === fitted) return; fitted = key;
  const xs = f.nodes.map((n) => n.x), ys = f.nodes.map((n) => n.y), x0 = Math.min(...xs), x1 = Math.max(...xs) + NW, y0 = Math.min(...ys), y1 = Math.max(...ys) + NH;
  gz = Math.min(1, (wr.clientWidth - 40) / (x1 - x0), (wr.clientHeight - 30) / (y1 - y0));
  pan = [Math.round(wr.clientWidth / 2 - ((x0 + x1) / 2) * gz), Math.round(wr.clientHeight / 2 - ((y0 + y1) / 2) * gz)];
}
function drawGraph() {
  fitGraph();
  const wr = $('#fuGWrap', root), cv = $('#fuGraph', root); if (!wr) return;
  const W = wr.clientWidth, H = wr.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
  cv.style.width = `${W}px`; cv.style.height = `${H}px`; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#0d0e12'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#ffffff0c'; for (let x = (pan[0] % 24 + 24) % 24; x < W; x += 24) for (let y = (pan[1] % 24 + 24) % 24; y < H; y += 24) g.fillRect(x, y, 1.5, 1.5);
  const f = fu(); if (!f) return;
  // wires
  for (const n of f.nodes) {
    const ins = F.NODES[n.type].ins;
    ins.forEach((s, i) => {
      const src = node(n.in?.[s]); if (!src) return;
      const [x1, y1] = portOut(src), [x2, y2] = portIn(n, i, ins.length), dx = Math.max(40, (x2 - x1) / 2);
      g.strokeStyle = s === 'mask' ? '#8a8f99' : s === 'foreground' ? '#e0c050' : '#c9ced8'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x1, y1); g.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2); g.stroke();
    });
  }
  if (wire) { const [x1, y1] = portOut(wire.from); g.strokeStyle = '#ff9933'; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(x1, y1); g.lineTo(wire.x, wire.y); g.stroke(); g.setLineDash([]); }
  // nodes
  g.font = '12px "Segoe UI", sans-serif'; g.textBaseline = 'middle';
  for (const n of f.nodes) {
    const d = F.NODES[n.type], on = n.id === selId, isOut = f.out === n.id, x = 0, y = 0;
    g.save(); g.translate(n.x * gz + pan[0], n.y * gz + pan[1]); g.scale(gz, gz);
    g.fillStyle = '#1b1e25'; g.strokeStyle = on ? '#ff9933' : '#ffffff22'; g.lineWidth = on ? 2 : 1;
    g.beginPath(); g.roundRect ? g.roundRect(x, y, NW, NH, 6) : g.rect(x, y, NW, NH); g.fill(); g.stroke();
    g.fillStyle = d.color; g.fillRect(x, y + 4, 4, NH - 8);
    g.fillStyle = '#e6e9ef'; g.fillText(d.label, x + 12, y + NH / 2 - (n.type === 'mediaIn' || n.type === 'text' ? 6 : 0));
    if (n.type === 'mediaIn' || n.type === 'text') { g.fillStyle = '#8a93a3'; g.font = '10px "Segoe UI"'; g.fillText(String(n.type === 'text' ? n.p.text : S.mediaById[n.p.mediaId]?.name || '').slice(0, 20), x + 12, y + NH / 2 + 8); g.font = '12px "Segoe UI", sans-serif'; }
    if (isOut) { g.fillStyle = '#ff9933'; g.fillText('◉', x + NW - 22, y + 10); }
    g.restore();
    d.ins.forEach((s, i) => { const [px, py] = portIn(n, i, d.ins.length); g.fillStyle = n.in?.[s] ? (s === 'mask' ? '#8a8f99' : s === 'foreground' ? '#e0c050' : '#c9ced8') : '#3a3f4a'; g.beginPath(); g.arc(px, py, 5, 0, 7); g.fill(); });
    if (n.type !== 'mediaOut') { const [px, py] = portOut(n); g.fillStyle = '#ff9933'; g.beginPath(); g.arc(px, py, 5, 0, 7); g.fill(); }
  }
}
let drag = null, wire = null;
function hitPort(x, y) {
  const f = fu(); if (!f) return null;
  for (const n of f.nodes) {
    if (n.type !== 'mediaOut') { const [px, py] = portOut(n); if (Math.hypot(px - x, py - y) < 9) return { kind: 'out', n }; }
    const ins = F.NODES[n.type].ins;
    for (let i = 0; i < ins.length; i++) { const [px, py] = portIn(n, i, ins.length); if (Math.hypot(px - x, py - y) < 9) return { kind: 'in', n, slot: ins[i] }; }
  }
  return null;
}
const hitNode = (x, y) => [...(fu()?.nodes || [])].reverse().find((n) => x >= n.x * gz + pan[0] && x <= (n.x + NW) * gz + pan[0] && y >= n.y * gz + pan[1] && y <= (n.y + NH) * gz + pan[1]);
function wireGraph() {
  const cv = $('#fuGraph', root);
  const pt = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener('pointerdown', (e) => {
    const f = fu(); if (!f || S.readOnly) return;
    const [x, y] = pt(e); cv.setPointerCapture(e.pointerId);
    const p = hitPort(x, y);
    if (p?.kind === 'out') { wire = { from: p.n, x, y }; return; }
    if (p?.kind === 'in') { if (p.n.in?.[p.slot]) { delete p.n.in[p.slot]; save('Disconnect'); } return; }
    const n = hitNode(x, y);
    if (n) { selId = n.id; drag = { n, dx: (x - pan[0]) / gz - n.x, dy: (y - pan[1]) / gz - n.y }; renderInsp(); drawGraph(); if (view === 'sel') draw(); return; }
    drag = { pan: true, x0: x, y0: y, p0: [...pan] };
  });
  cv.addEventListener('wheel', (e) => { // zoom around the pointer
    e.preventDefault(); const [x, y] = pt(e), k = Math.min(2, Math.max(0.25, gz * (e.deltaY < 0 ? 1.1 : 1 / 1.1))) / gz;
    pan = [x - (x - pan[0]) * k, y - (y - pan[1]) * k]; gz *= k; drawGraph();
  }, { passive: false });
  cv.addEventListener('dblclick', (e) => { if (!hitNode(...pt(e))) { fitGraph(true); drawGraph(); } });
  cv.addEventListener('pointermove', (e) => {
    const [x, y] = pt(e);
    if (wire) { wire.x = x; wire.y = y; drawGraph(); return; }
    if (!drag) return;
    if (drag.pan) { pan = [drag.p0[0] + x - drag.x0, drag.p0[1] + y - drag.y0]; drawGraph(); return; }
    drag.n.x = Math.round((x - pan[0]) / gz - drag.dx); drag.n.y = Math.round((y - pan[1]) / gz - drag.dy); drag.moved = true; drawGraph();
  });
  cv.addEventListener('pointerup', (e) => {
    const [x, y] = pt(e), f = fu();
    if (wire) {
      const p = hitPort(x, y), from = wire.from; wire = null;
      if (p?.kind === 'in' && p.n !== from) {
        if (F.wouldLoop(f, from.id, p.n.id)) { toast('That would make a loop', 'err'); drawGraph(); return; }
        const had = p.n.in[p.slot];
        if (had && had !== from.id && p.slot !== 'mask') {
          // an input takes one picture: a second one dropped on it gets a Merge in between (like Resolve) -
          // what was there becomes the background, the new one the foreground
          const old = node(had), mg = F.newNode('merge', Math.round((Math.max(old?.x ?? 0, from.x) + p.n.x) / 2), Math.round(((old?.y ?? p.n.y) + from.y) / 2));
          mg.in.background = had; mg.in.foreground = from.id;
          clearSpot(f, mg); f.nodes.push(mg); p.n.in[p.slot] = mg.id; selId = mg.id;
          if (p.n.type === 'mediaOut') f.out = p.n.id;
          toast(`Merge added: ${F.NODES[old?.type]?.label || 'the old input'} is the background, ${F.NODES[from.type].label} the foreground - change Apply mode / Blend in the Inspector`);
          return save('Merge two inputs');
        }
        p.n.in[p.slot] = from.id; if (p.n.type === 'mediaOut') f.out = p.n.id;
        save(`Connect ${F.NODES[from.type].label} → ${F.NODES[p.n.type].label}`);
      } else drawGraph();
      return;
    }
    const d = drag; drag = null;
    if (d?.moved) save('Move node', `fu-move-${d.n.id}`);
  });
}
function wireKeys() {
  document.addEventListener('keydown', (e) => {
    if (S.page !== 'fusion' || !S.project || document.querySelector('dialog[open]')) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.ctrlKey || e.metaKey) return;
    let done = true;
    if (e.key === ' ') playing ? stop() : play();
    else if (e.key === 'Delete' || e.key === 'Backspace') delSel();
    else if (e.key === '1') { view = 'out'; refresh(); }
    else if (e.key === '2') { view = 'sel'; refresh(); }
    else if (e.key === 'ArrowLeft') { stop(); seek(T - 1 / fps()); }
    else if (e.key === 'ArrowRight') { stop(); seek(T + 1 / fps()); }
    else if (e.key === 'Home') seek(0);
    else done = false;
    if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
