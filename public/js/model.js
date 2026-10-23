// Shared timeline model - imported by the browser UI *and* by engine/render2.mjs,
// so the timeline you see and the video that renders always agree on timing.
//
// Project (version 2):
//   settings: { aspect, fps, loudness, crf, kenburns }
//   tracks:   { V2: [], V1: [], A1: [], A2: [], A3: [] }
//     V1  main story, magnetic: clips play back-to-back (an optional transitionIn overlaps the previous clip)
//     V2  overlays & titles, free position: clip.start in seconds
//     A1  voice-over, A2 music, A3 sound effects - free position: clip.start
//   trackState: { V1: { mute, hide, lock, volume }, ... }
//   logo, subtitles
// Clip types: video | image | title (V1/V2), audio (A-tracks). Source trims: in/out (seconds in the file).

// frame shapes by name (1080-based; exports scale them) - and any "W x H" as "2560x1080" for a custom frame size
// (Sequence settings › Custom size), read through the same ASPECTS[...] everywhere
const SHAPES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '4:3': [1440, 1080], '3:4': [1080, 1440], '21:9': [2520, 1080], '2.39:1': [2582, 1080], '17:9 DCI': [2048, 1080] };
const customSize = (k) => { const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(k)); return m ? [Math.max(16, Math.min(8192, +m[1])) & ~1, Math.max(16, Math.min(8192, +m[2])) & ~1] : undefined; };
export const ASPECTS = new Proxy(SHAPES, { get: (t, k) => (k in t ? t[k] : customSize(k)), has: (t, k) => k in t || !!customSize(k) });
export const shapeLabel = (k) => (SHAPES[k] ? k : customSize(k) ? `${customSize(k).join(' × ')} (custom)` : String(k || ''));

export const TRACKS = [
  { id: 'V2', kind: 'video', name: 'V2', label: 'Overlays & titles' },
  { id: 'V1', kind: 'video', name: 'V1', label: 'Main story' },
  { id: 'A1', kind: 'audio', name: 'A1', label: 'Voice-over' },
  { id: 'A2', kind: 'audio', name: 'A2', label: 'Music' },
  { id: 'A3', kind: 'audio', name: 'A3', label: 'Sound FX' },
];

// ---------------- tracks ----------------
// Any number of tracks: V1 is the magnetic main story, V2, V3… are free overlays (a higher number sits on top),
// A1 voice-over, A2 music (ducked under speech), A3, A4… sound effects / extra audio. project.tracks holds them all;
// trackState[id].name can rename one. trackList() gives the order they are drawn in the timeline (top to bottom).
export const trackKind = (id) => (String(id)[0] === 'A' ? 'audio' : 'video');
export const trackNum = (id) => +String(id).slice(1) || 0;
const DEFAULT_LABEL = { V1: 'Main story', V2: 'Overlays & titles', V3: 'Overlays', A1: 'Voice-over', A2: 'Music', A3: 'Sound FX' };
// a new project starts with V1-V3 and A1-A2 (like Premiere's default sequence); A3 (sound effects) comes when sound
// design or another audio track is added. Older projects keep the tracks they have.
const START_TRACKS = ['V3', 'V2', 'V1', 'A1', 'A2'];
export function trackList(project) {
  // every timeline shows V1-V3 and A1-A2 (older projects too); an empty, unnamed A3 stays out of the way until sound
  // effects (or a new audio track) need it
  const has = Object.keys(project?.tracks || {}).filter((id) => !(id === 'A3' && !(project.tracks.A3 || []).length && !project.trackState?.A3?.name));
  const ids = new Set([...START_TRACKS, ...has]);
  const v = [...ids].filter((id) => trackKind(id) === 'video').sort((a, b) => trackNum(b) - trackNum(a));
  const a = [...ids].filter((id) => trackKind(id) === 'audio').sort((x, y) => trackNum(x) - trackNum(y));
  return [...v, ...a].map((id) => ({ id, kind: trackKind(id), name: id, label: project?.trackState?.[id]?.name || DEFAULT_LABEL[id] || (trackKind(id) === 'video' ? 'Overlay' : 'Audio') }));
}
// overlay video tracks, bottom to top (V2 first)
export const overlayTracks = (project) => trackList(project).filter((t) => t.kind === 'video' && t.id !== 'V1').map((t) => t.id).reverse();
export const audioTracks = (project) => trackList(project).filter((t) => t.kind === 'audio').map((t) => t.id);
// 🎚 adjustment layers copying a reference's looks (refstyle.mjs refAdjustLayers): the old ones go, the new ones sit
// on the first video track that is free over their time and above every overlay used there (so the look reaches the
// B-roll too); a new track when there is none. Returns the track id.
export function placeRefLooks(project, clips, media = {}) {
  for (const id of Object.keys(project.tracks)) project.tracks[id] = project.tracks[id].filter((c) => !c.refLook);
  if (!clips?.length) return null;
  const a = Math.min(...clips.map((c) => c.start)), b = Math.max(...clips.map((c) => c.start + c.dur));
  const ov = Object.keys(project.tracks).filter((id) => trackKind(id) === 'video' && id !== 'V1').sort((x, y) => trackNum(x) - trackNum(y));
  const busy = (id) => project.tracks[id].some((c) => (c.start || 0) < b && (c.start || 0) + clipDur(c, media) > a);
  const lastBusy = ov.reduce((k, id, i) => (busy(id) ? i : k), -1);
  const id = ov.slice(lastBusy + 1).find((t) => !busy(t)) || addTrack(project, 'video');
  project.tracks[id].push(...clips);
  return id;
}
// 🎬 Motion comps and ✨ Fusions on the edit: from V3 up (V1 the story, V2 titles and B-roll) - and above the clip they
// were made from - on the first video track that is free for their whole time, so they never sit over another clip;
// a new track on top when every one is busy. Returns the track id (created in project.tracks if it was only shown).
export function compTrack(project, start, dur, media = {}, over = 'V1') {
  const low = Math.max(3, trackNum(over) + 1);
  const ids = trackList(project).filter((t) => t.kind === 'video' && trackNum(t.id) >= low).map((t) => t.id).reverse(); // bottom up
  const free = (id) => !(project.tracks[id] || []).some((x) => (x.start || 0) < start + dur - 1e-3 && (x.start || 0) + clipDur(x, media) > start + 1e-3);
  const id = ids.find(free) || addTrack(project, 'video');
  project.tracks[id] ||= [];
  project.trackState[id] ||= { mute: false, hide: false, lock: false, volume: 1 };
  return id;
}
// 🧱 The layers of an edit in fixed places (a reference copied, or Sequence › Arrange layers): V1 the story, V2 adjustment
// layers (their effects reach everything below), V3 Motion comps / Fusions, V4 text (titles, lower thirds, kinetic text).
// B-roll stays under its adjustment layer. A clip that would cover another one at that time goes one track up (a new
// track on top when needed) - nothing is ever hidden under something else. Returns how many clips changed track.
const layerOf = (c) => (c.type === 'adjust' ? 'fx' : c.type === 'graphic' && ['comp', 'fusion'].includes(c.gfx?.tpl) ? 'comp' : c.type === 'title' || c.type === 'graphic' ? 'text' : 'broll');
export function arrangeLayers(project, media = {}) {
  const over = Object.keys(project.tracks).filter((id) => trackKind(id) === 'video' && id !== 'V1');
  const all = over.flatMap((id) => project.tracks[id].map((c) => ({ c, was: id })));
  if (!all.length) return 0;
  const lanes = {}; // track number -> [[start, end]]
  const free = (n, a, b) => !(lanes[n] || []).some(([x, y]) => x < b - 1e-3 && y > a + 1e-3);
  const out = {};
  let moved = 0;
  // b-roll first (on V2, under its look), then the looks, the comps and the text - each from its own track up
  for (const [kind, base] of [['broll', 2], ['fx', 2], ['comp', 3], ['text', 4]]) {
    for (const { c, was } of all.filter((x) => layerOf(x.c) === kind).sort((x, y) => (x.c.start || 0) - (y.c.start || 0))) {
      const a = c.start || 0, b = a + clipDur(c, media);
      let n = base;
      // (an adjustment layer always above the b-roll it covers; comps above the looks; text above everything)
      const floor = kind === 'fx' ? Math.max(base, ...Object.entries(lanes).filter(([, l]) => l.some(([x, y, k]) => k === 'broll' && x < b && y > a)).map(([k]) => +k + 1))
        : kind === 'comp' || kind === 'text' ? Math.max(base, ...Object.entries(lanes).filter(([, l]) => l.some(([x, y, k]) => k !== kind && x < b && y > a)).map(([k]) => +k + 1)) : base;
      n = Math.max(n, floor);
      while (!free(n, a, b)) n++;
      (lanes[n] ||= []).push([a, b, kind]);
      const id = `V${n}`;
      (out[id] ||= []).push(c);
      if (id !== was) moved++;
    }
  }
  for (const id of over) project.tracks[id] = [];
  for (const [id, list] of Object.entries(out)) {
    project.tracks[id] = list;
    project.trackState[id] ||= { mute: false, hide: false, lock: false, volume: 1 };
  }
  return moved;
}
export function addTrack(project, kind) {
  const pre = kind === 'audio' ? 'A' : 'V';
  const n = Math.max(2, ...Object.keys(project.tracks).filter((id) => id[0] === pre).map(trackNum)) + 1;
  const id = `${pre}${n}`;
  project.tracks[id] = [];
  project.trackState[id] = { mute: false, hide: false, lock: false, volume: 1 };
  return id;
}
// a track that is shown but not in project.tracks yet (V3 of an older project, a new top / bottom track): made now
export function ensureTrack(project, id) {
  project.tracks[id] ||= [];
  (project.trackState ||= {})[id] ||= { mute: false, hide: false, lock: false, volume: 1 };
  return id;
}

// 🎭 Opacity › Blend Mode, Premiere's list in its groups. key = FFmpeg's blend all_mode (the render, render2.mjs);
// css = the monitor's mix-blend-mode (an approximation where the browser has no such mode - exact in Accurate preview).
export const BLEND_MODES = [['', 'Normal'],
  ['darken', 'Darken'], ['multiply', 'Multiply'], ['burn', 'Color Burn'], ['linearburn', 'Linear Burn'],
  ['lighten', 'Lighten'], ['screen', 'Screen'], ['dodge', 'Color Dodge'], ['addition', 'Linear Dodge (Add)'],
  ['overlay', 'Overlay'], ['softlight', 'Soft Light'], ['hardlight', 'Hard Light'], ['vividlight', 'Vivid Light'], ['linearlight', 'Linear Light'], ['pinlight', 'Pin Light'], ['hardmix', 'Hard Mix'],
  ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['subtract', 'Subtract'], ['divide', 'Divide']];
export const BLEND_CSS = { addition: 'plus-lighter', softlight: 'soft-light', hardlight: 'hard-light', dodge: 'color-dodge', burn: 'color-burn', linearburn: 'multiply',
  vividlight: 'color-dodge', linearlight: 'hard-light', pinlight: 'hard-light', hardmix: 'hard-light', subtract: 'difference', divide: 'color-dodge' };
// FFmpeg has no Linear Burn: A + B - 1 (per channel, 0-255)
export const BLEND_FF = { linearburn: "all_expr='max(0,A+B-255)'" };
export const blendFF = (k) => BLEND_FF[k] || `all_mode=${k}`;

// ⇅ Alt+↑ / Alt+↓ (Premiere's Nudge clip selection up / down): the clips go one track up (dir 1) or down (-1) on
// screen and keep their time. A video's linked sound goes the same way out from the middle, as a drag takes it
// (V2 -> V3 with A2 -> A3). Above the top video / below the last audio track a new track is made. A clip whose new track
// is busy at its time (or is locked) stays. Main story (V1): opt.liftV1(clip, index) leaves its gap and gives its start,
// opt.toV1(clip, t) puts a clip in; without them V1 clips stay. Returns { moved, stayed }.
export function moveClipsTrack(project, media, ids, dir, opt = {}) {
  const P = placed(project, media), ts = project.trackState || {}, at = new Map();
  for (const [tr, list] of Object.entries(P)) for (const x of list) at.set(x.clip.id, { tr, x });
  const want = new Set(ids), go = [];
  const sel = [...want].map((id) => at.get(id)).filter((f) => f && !f.x.clip.gap && !f.x.clip.locked && !ts[f.tr]?.lock);
  const vidLinks = new Set(sel.filter((f) => trackKind(f.tr) === 'video' && f.x.clip.link).map((f) => f.x.clip.link));
  let stayed = 0;
  for (const f of sel) {
    const c = f.x.clip, kind = trackKind(f.tr), n = trackNum(f.tr);
    if (kind === 'audio' && c.link && vidLinks.has(c.link)) continue; // (goes with its picture, below)
    if (kind === 'video') {
      go.push({ ...f, to: `V${n + dir}` });
      if (c.link) for (const [, g] of at) if (g.x.clip.link === c.link && g.x.clip !== c && trackKind(g.tr) === 'audio' && !ts[g.tr]?.lock) go.push({ ...g, to: `A${trackNum(g.tr) + dir}`, mate: c.id });
    } else go.push({ ...f, to: `A${n - dir}` });
  }
  const leaving = new Set(go.map((g) => g.x.clip));
  const busy = (tr, a, b) => (project.tracks[tr] || []).some((o) => !leaving.has(o) && !o.gap && (o.start || 0) < b - 1e-3 && (o.start || 0) + clipDur(o, media) > a + 1e-3);
  const ok = new Set();
  for (const g of go) {
    const a = g.x.start, b = g.x.end, n = trackNum(g.to);
    g.ok = n >= 1 && !ts[g.to]?.lock && (g.to === 'V1' ? !!opt.toV1 && g.x.clip.type !== 'adjust' : g.tr === 'V1' ? !!opt.liftV1 && !busy(g.to, a, b) : !busy(g.to, a, b));
    if (g.mate && !ok.has(g.mate)) g.ok = false; // (the picture stayed: its sound stays too)
    if (g.ok) ok.add(g.x.clip.id); else if (!g.mate) stayed++;
  }
  // last V1 shot first, so the earlier ones keep their index while gaps are put in
  const moving = go.filter((g) => g.ok).sort((p, q) => (p.tr === 'V1' && q.tr === 'V1' ? project.tracks.V1.indexOf(q.x.clip) - project.tracks.V1.indexOf(p.x.clip) : 0));
  for (const g of moving) {
    const c = g.x.clip, t = +g.x.start.toFixed(3);
    if (g.tr === 'V1') opt.liftV1(c, project.tracks.V1.indexOf(c));
    else { const l = project.tracks[g.tr], i = l.indexOf(c); if (i >= 0) l.splice(i, 1); }
    ensureTrack(project, g.to);
    if (g.to === 'V1') opt.toV1(c, t);
    else { delete c.transitionIn; c.start = t; project.tracks[g.to].push(c); }
  }
  return { moved: moving.filter((g) => !g.mate).length, stayed };
}

// 📐 right-click › Set to Frame Size / Fill Frame (Premiere): Motion's Scale that shows the whole picture inside the
// frame ('fit') or covers the frame ('fill'), from the clip's own width x height. Stored zoom is a factor on the clip's
// framing (fit / fill / blur, as fitOf in the inspector), so it is the size wanted over the size it already has.
export function frameScale(c, m, aspect, projFit, mode) {
  const [W, H] = ASPECTS[aspect] || ASPECTS['16:9'];
  const rot = Math.abs(m?.rotation || 0) % 180 === 90, w = (rot ? m?.height : m?.width) || W, h = (rot ? m?.width : m?.height) || H;
  const framing = c?.fit || projFit || (H > W ? 'blur' : 'fit');
  const base = framing === 'fill' ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
  const want = mode === 'fill' ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
  return +(want / base).toFixed(4);
}

export const TRANSITIONS = [
  ['cut', 'Cut'], ['fade', 'Cross dissolve'], ['fadeblack', 'Dip to black'], ['fadewhite', 'Dip to white'],
  ['dissolve', 'Dissolve (grain)'], ['wipeleft', 'Wipe left'], ['wiperight', 'Wipe right'], ['slideleft', 'Slide left'],
  ['slideup', 'Slide up'], ['smoothleft', 'Smooth left'], ['circleopen', 'Circle open'], ['zoomin', 'Zoom in'],
  // teaser transitions
  ['hblur', 'Whip blur'], ['fadefast', 'Flash cut'], ['pixelize', 'Pixelize'], ['radial', 'Radial wipe'], ['squeezeh', 'Squeeze'],
  ['hlslice', 'Slice'], ['circlecrop', 'Iris'], ['distance', 'Distance'],
  // more of Premiere's transitions (FFmpeg xfade; the monitor draws the wipes / irises / slides live - fx.js trLive - the
  // rest as a dissolve; Accurate preview / export exactly)
  ['slideright', 'Push right'], ['slidedown', 'Push down'], ['coverleft', 'Cover (slide over)'], ['revealleft', 'Reveal (slide away)'],
  ['wipeup', 'Wipe up'], ['wipedown', 'Wipe down'], ['diagtl', 'Diagonal wipe'], ['wipetl', 'Corner wipe'],
  ['vertopen', 'Barn doors (open)'], ['horzopen', 'Barn doors (horizontal)'], ['vertclose', 'Split (close)'], ['circleclose', 'Circle close'],
  ['rectcrop', 'Box (iris square)'], ['fadegrays', 'Film dissolve (through grey)'], ['fadeslow', 'Slow fade'], ['hlwind', 'Wind'],
  ['squeezev', 'Squeeze vertical'], ['smoothright', 'Smooth right'], ['hrslice', 'Slice right'], ['vuslice', 'Slice up'],
  // the rest of Premiere's Video Transitions (engine/premiere-effects-gap.md): xfade built-ins and fx.js XFADE_EXPR shapes
  ['coverright', 'Slide right (cover)'], ['coverup', 'Slide up (cover)'], ['coverdown', 'Slide down (cover)'], ['horzclose', 'Split (horizontal close)'],
  ['adddissolve', 'Additive dissolve'], ['nonadddissolve', 'Non-additive dissolve'], ['iriscross', 'Iris cross'], ['irisdiamond', 'Iris diamond'],
  ['clockwipe', 'Clock wipe'], ['wedgewipe', 'Wedge wipe'], ['pinwheel', 'Pinwheel'], ['inset', 'Inset'], ['venetian', 'Venetian blinds'],
  ['bandwipe', 'Band wipe'], ['checkerwipe', 'Checker wipe'], ['checkerboard', 'CheckerBoard'], ['randomblocks', 'Random blocks'],
  ['centersplit', 'Center split'], ['bandslide', 'Band slide'], ['flipover', 'Flip over'],
  ['cubespin', 'Cube spin'], ['pageturn', 'Page turn'], ['pagepeel', 'Page peel'], ['gradientwipe', 'Gradient wipe'],
  ['spiralboxes', 'Spiral boxes'], ['zigzag', 'Zig-zag blocks'], ['randomwipe', 'Random wipe'], ['paintsplatter', 'Paint splatter'],
  ['morphcut', 'Morph cut (Python, optical flow)'],
];

export function newProject(name, { aspect = '16:9', fps = 30 } = {}) {
  const now = Date.now();
  return {
    version: 2, name, created: now, modified: now,
    settings: { aspect, fps, loudness: -14, crf: 20, kenburns: true },
    tracks: Object.fromEntries(START_TRACKS.map((id) => [id, []])),
    trackState: Object.fromEntries(START_TRACKS.map((id) => [id, { mute: false, hide: false, lock: false, volume: 1 }])),
    logo: { mediaId: '', pos: 'tr', scale: 0.12, opacity: 0.9 },
    subtitles: { file: '', style: {} },
    markers: [],
  };
}

// 🛡 A project as the editor expects it, whatever wrote it (an older version, Claude, the agent, a half-saved file):
// missing parts are filled in, wrong kinds of values are replaced, clips that are not clips are dropped - so no panel
// ever meets something it cannot draw. Changes the project in place (and returns it); a sound project is left as it is.
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const CLIP_TYPES = new Set(['video', 'image', 'audio', 'title', 'adjust', 'graphic']);
function normSeqData(d, base) {
  d.settings = { ...base.settings, ...(isObj(d.settings) ? d.settings : {}) };
  if (!isObj(d.tracks)) d.tracks = {};
  for (const id of ['V1', 'V2', 'A1', 'A2']) if (!Array.isArray(d.tracks[id])) d.tracks[id] = [];
  for (const id of Object.keys(d.tracks)) {
    if (!/^[VA]\d+$/.test(id)) { delete d.tracks[id]; continue; }
    const l = Array.isArray(d.tracks[id]) ? d.tracks[id] : [];
    d.tracks[id] = l.filter((c) => isObj(c) && CLIP_TYPES.has(c.type));
    for (const c of d.tracks[id]) {
      if (typeof c.id !== 'string' || !c.id) c.id = uid();
      for (const k of ['start', 'in', 'out', 'dur', 'speed', 'volume', 'opacity']) if (k in c && c[k] !== undefined && c[k] !== null && !Number.isFinite(+c[k])) delete c[k];
      for (const k of ['effects', 'masks']) if (k in c && !Array.isArray(c[k])) delete c[k];
      if (Array.isArray(c.effects)) c.effects = c.effects.filter((e) => isObj(e) && typeof e.type === 'string').map((e) => ({ ...e, id: e.id || uid(), p: isObj(e.p) ? e.p : {} }));
      for (const k of ['color', 'transform', 'keys', 'cutFx', 'transitionIn', 'omask', 'gfx']) if (k in c && !isObj(c[k])) delete c[k];
      if (c.type === 'graphic' && !isObj(c.gfx)) c.gfx = { tpl: 'text', text: '' };
      if (c.type === 'title' && typeof c.text !== 'string') c.text = String(c.text ?? '');
    }
  }
  if (!isObj(d.trackState)) d.trackState = {};
  for (const id of Object.keys(d.tracks)) d.trackState[id] = { mute: false, hide: false, lock: false, volume: 1, ...(isObj(d.trackState[id]) ? d.trackState[id] : {}) };
  if (!Array.isArray(d.markers)) d.markers = [];
  d.markers = d.markers.filter((m) => isObj(m) && Number.isFinite(+m.t));
  if ('captions' in d) {
    if (!isObj(d.captions)) delete d.captions;
    else { if (!Array.isArray(d.captions.cues)) d.captions.cues = []; if (!isObj(d.captions.style)) d.captions.style = {}; }
    // 🗂 the 2nd, 3rd… caption tracks (public/js/captions.js): each with an id, a cue list and a style
    if (isObj(d.captions) && 'tracks' in d.captions) {
      d.captions.tracks = Array.isArray(d.captions.tracks) ? d.captions.tracks.filter(isObj) : [];
      d.captions.tracks.forEach((t, i) => { if (!t.id) t.id = `cct${i + 2}`; if (!Array.isArray(t.cues)) t.cues = []; if (!isObj(t.style)) t.style = {}; });
    }
  }
  if (!isObj(d.subtitles)) d.subtitles = { ...base.subtitles };
  return d;
}
export function normalizeProject(p) {
  if (!isObj(p)) return p;
  const base = newProject(typeof p.name === 'string' ? p.name : 'Project');
  if (typeof p.name !== 'string') p.name = base.name;
  normSeqData(p, base);
  if (!isObj(p.logo)) p.logo = { ...base.logo };
  if ('sequences' in p) {
    if (!isObj(p.sequences)) delete p.sequences;
    else for (const [id, s] of Object.entries(p.sequences)) {
      if (!isObj(s)) { delete p.sequences[id]; continue; }
      if (!isObj(s.data)) s.data = {};
      if (typeof s.name !== 'string') s.name = 'Sequence';
      normSeqData(s.data, base);
    }
  }
  if ('seq' in p && !(isObj(p.seq) && typeof p.seq.id === 'string')) delete p.seq;
  return p;
}

// ---------------- sequences ----------------
// Several timelines in one project (Full film, Teaser 30s, Reel…). The open one is the project's own tracks / settings
// (so every page and the render work on it unchanged); the others wait in project.sequences[id] = { name, data, modified },
// data holding the same SEQ_FIELDS. project.seq = { id, name } names the open one.
export const SEQ_FIELDS = ['tracks', 'trackState', 'markers', 'captions', 'subtitles', 'settings'];
export const seqOf = (project) => project.seq || { id: 'main', name: 'Main edit' };
export const seqData = (project) => JSON.parse(JSON.stringify(Object.fromEntries(SEQ_FIELDS.filter((k) => k in project).map((k) => [k, project[k]]))));
// every sequence, the open one first: [{ id, name, open, data }]
export function seqList(project) {
  const cur = seqOf(project);
  return [{ ...cur, open: true, data: project }, ...Object.entries(project.sequences || {}).map(([id, s]) => ({ id, name: s.name, open: false, data: s.data }))];
}
// open another sequence: the current one is put away, the chosen one comes to the top level
export function openSeq(project, id) {
  const cur = seqOf(project), s = project.sequences?.[id];
  if (!s || id === cur.id) return false;
  project.sequences[cur.id] = { name: cur.name, data: seqData(project), modified: Date.now() };
  for (const k of SEQ_FIELDS) delete project[k];
  Object.assign(project, JSON.parse(JSON.stringify(s.data)));
  delete project.sequences[id];
  project.seq = { id, name: s.name };
  return true;
}
// a fingerprint of a sequence's content: a nested copy is out of date when its sequence's fingerprint changed
export function seqHash(data) {
  const str = JSON.stringify(SEQ_FIELDS.map((k) => data?.[k] ?? null));
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

// ---------------- speed ramps ----------------
// clip.ramp = preset id: the speed changes INSIDE the shot (e.g. normal -> slow motion -> normal). Points are
// [u, s]: u = position in the shot (0..1 of its timeline length), s = speed multiplier (x clip.speed); smooth between.
// clip.ramp = 'custom' uses the clip's own points, clip.rampPts (drawn in Effect Controls > Speed ramp, rampui.js).
export const RAMPS = {
  hit: { label: 'Slow-mo hit (normal → slow → normal)', pts: [[0, 1], [0.3, 1], [0.42, 0.3], [0.72, 0.3], [0.84, 1], [1, 1]] },
  in: { label: 'Ramp into slow motion', pts: [[0, 1], [0.35, 1], [0.6, 0.3], [1, 0.3]] },
  punch: { label: 'Fast in, slow out (impact)', pts: [[0, 2.5], [0.25, 2.5], [0.45, 0.45], [1, 0.45]] },
  hero: { label: 'Hero ending (slows to a crawl)', pts: [[0, 1.2], [0.4, 1.2], [0.62, 0.25], [1, 0.25]] },
  whoosh: { label: 'Speed-up whoosh (normal → fast → normal)', pts: [[0, 1], [0.35, 1], [0.5, 3], [0.65, 1], [1, 1]] },
  out: { label: 'Slow motion into fast', pts: [[0, 0.3], [0.5, 0.3], [0.75, 1.6], [1, 1.6]] },
  double: { label: 'Double hit (two slow-mo moments)', pts: [[0, 1.4], [0.15, 1.4], [0.25, 0.3], [0.38, 0.3], [0.48, 1.6], [0.6, 1.6], [0.7, 0.3], [0.85, 0.3], [0.95, 1.2], [1, 1.2]] },
  bullet: { label: 'Bullet time (fast → almost frozen → fast)', pts: [[0, 2], [0.3, 2], [0.42, 0.12], [0.62, 0.12], [0.74, 2], [1, 2]] },
  timelapse: { label: 'Time-lapse build (slow → very fast)', pts: [[0, 0.6], [0.3, 1], [0.7, 3.5], [1, 4]] },
  beat: { label: 'Beat pulse (fast / slow on the beat)', pts: [[0, 2], [0.2, 2], [0.25, 0.5], [0.45, 0.5], [0.5, 2], [0.7, 2], [0.75, 0.5], [1, 0.5]] },
  easeIn: { label: 'Smooth speed-up (ease in)', pts: [[0, 0.4], [0.6, 1.5], [1, 2]] },
  easeOut: { label: 'Smooth slow-down (ease out)', pts: [[0, 2], [0.4, 1.5], [1, 0.4]] },
  reveal: { label: 'Slow reveal, quick exit', pts: [[0, 0.35], [0.65, 0.35], [0.8, 2.2], [1, 2.2]] },
};
export const rampOk = (pts) => Array.isArray(pts) && pts.length >= 2 && pts.every((p) => Array.isArray(p) && p[1] > 0);
export const rampPts = (c) => (c?.type === 'video' && (c.ramp === 'custom' ? (rampOk(c.rampPts) ? c.rampPts : null) : RAMPS[c.ramp]?.pts)) || null;
const smooth = (u) => u * u * (3 - 2 * u);
// The ease of a segment: smooth from its point to the next. A segment left over from a cut is only a piece of the
// segment that was there - its point says which piece ([u, s, e0, e1]: e0..e1 of the old ease), so the speed follows
// exactly the curve that was drawn and the cut part needs no extra points.
// ⏩ the shape of a ramp from one keyframe to the next (the point's 5th item, like After Effects / Premiere): Easy Ease
// (the S-curve, the default), Linear, Ease In (starts gently), Ease Out (arrives gently), Hold (jumps at the next keyframe)
export const RAMP_EASES = [['io', 'Easy Ease (F9)'], ['linear', 'Linear'], ['in', 'Ease In'], ['out', 'Ease Out'], ['hold', 'Hold']];
const SHAPE = { linear: (x) => x, in: (x) => x * x, out: (x) => 1 - (1 - x) * (1 - x) };
function ease(x, e0 = 0, e1 = 1, mode) {
  if (mode === 'hold') return e1 >= 1 - 1e-9 && x >= 1 - 1e-9 ? 1 : 0;
  const f = SHAPE[mode] || smooth;
  if (e0 === 0 && e1 === 1) return f(x);
  const s0 = f(e0), s1 = f(e1);
  return s1 - s0 > 1e-9 ? (f(e0 + (e1 - e0) * x) - s0) / (s1 - s0) : x;
}
export function profileAt(pts, u) {
  if (u <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, sa, e0, e1, mode] = pts[i], [b, sb] = pts[i + 1];
    if (u <= b) return sa + (sb - sa) * ease((u - a) / Math.max(1e-6, b - a), e0, e1, mode);
  }
  return pts[pts.length - 1][1];
}
// cumulative source per unit of the shot: cum[k] = integral of the profile from 0 to k/RN (cached per preset)
const RN = 200, cumCache = new Map();
function cumOf(pts) {
  const key = JSON.stringify(pts);
  if (!cumCache.has(key)) {
    const cum = new Float64Array(RN + 1);
    for (let k = 1; k <= RN; k++) cum[k] = cum[k - 1] + (profileAt(pts, (k - 0.5) / RN) / RN);
    cumCache.set(key, cum);
  }
  return cumCache.get(key);
}
export const rampAvg = (pts) => cumOf(pts)[RN]; // average speed multiplier over the shot
function rampCum(pts, u) {
  const cum = cumOf(pts), x = Math.min(1, Math.max(0, u)) * RN, k = Math.floor(x);
  return k >= RN ? cum[RN] : cum[k] + (cum[k + 1] - cum[k]) * (x - k);
}
// Source time (seconds in the file) shown at `rel` seconds into a clip of timeline length D; and the speed there.
export function sourceAt(c, rel, D) {
  const pts = rampPts(c), sp = c.speed || 1;
  if (!pts || !(D > 0)) return (c.in || 0) + rel * sp;
  return (c.in || 0) + sp * D * rampCum(pts, rel / D);
}
// A part of a ramped shot (u0..u1 of its length, 0..1) as a shot of its own: the bit of the file it plays and its own
// speed curve, so a cut or a trim keeps the part where it was and the same frames at its ends - the parts used to get
// the WHOLE ramp again each, change length, and move the story after them. Its curve is the user's own points inside
// the part plus one point at each cut (the speed there) - it used to be 24 evenly sampled points, so every cut filled
// the graph with dots instead of the ramp that was drawn.
export function rampPart(c, u0, u1, D) {
  const pts = rampPts(c), sp = c.speed || 1, a = sourceAt(c, u0 * D, D), b = sourceAt(c, u1 * D, D), len = (u1 - u0) * D, w = u1 - u0;
  const near = 0.004 * w, X = [u0, ...pts.map(([u]) => u).filter((u) => u > u0 + near && u < u1 - near), u1];
  const raw = X.map((x, j) => {
    const p = [+((x - u0) / w).toFixed(5), profileAt(pts, x)], y = X[j + 1];
    if (y === undefined) return p;
    // the old segment this piece comes from, and which part of its ease it is (inside an older piece: of that one)
    const mid = (x + y) / 2, i = pts.findIndex((q, k) => k < pts.length - 1 && mid >= q[0] && mid <= pts[k + 1][0]);
    if (i < 0) return p; // (before the first point / after the last: the speed is flat there)
    const [qa, , E0 = 0, E1 = 1, mode] = pts[i], qb = pts[i + 1][0], t = (v) => Math.min(1, Math.max(0, (v - qa) / Math.max(1e-9, qb - qa)));
    const e0 = E0 + (E1 - E0) * t(x), e1 = E0 + (E1 - E0) * t(y);
    // (the piece keeps its segment's ease too - Linear / Ease In / Out / Hold)
    return e0 > 1e-6 || e1 < 1 - 1e-6 || mode ? [...p, +e0.toFixed(6), +e1.toFixed(6), ...(mode ? [mode] : [])] : p;
  });
  const k = (b - a) / (sp * len) / rampAvg(raw); // (≈ 1: only rounding - the part keeps its length)
  return { in: +a.toFixed(3), out: +b.toFixed(3), ramp: 'custom', rampPts: raw.map(([u, s, ...e]) => [u, +(s * k).toFixed(5), ...e]) };
}
export function speedAt(c, rel, D) {
  const pts = rampPts(c);
  return (c.speed || 1) * (pts && D > 0 ? profileAt(pts, rel / D) : 1);
}

// Puts a speed ramp on a shot (key: preset id, 'custom' with its points, or '' = none) and keeps the shot's length on
// the timeline - only the speed inside changes; the part of the file it plays gets longer / shorter to fit (as far as
// the file goes). It used to keep the file part instead, so a 2 s shot with bullet time became ~4 s and the whole
// story after it moved off the voice-over and the beats.
// D: the length to keep (a curve being drawn keeps the length it had when the drag began)
export function setRamp(c, key, media, pts = null, D = clipDur(c, media)) {
  if (c?.type !== 'video') return false;
  if (!key) { delete c.ramp; delete c.rampPts; } else { c.ramp = key; if (key === 'custom') c.rampPts = pts; else delete c.rampPts; }
  const P = rampPts(c), need = (c.in || 0) + D * (c.speed || 1) * (P ? rampAvg(P) : 1), max = media?.[c.mediaId]?.duration;
  c.out = +(max ? Math.min(max, need) : need).toFixed(3);
  return true;
}

// 📌 A clip stays where it was put: after its speed or ramp changes, the shot keeps its length D on the timeline (it
// plays more or less of the file), so nothing after it moves. When the file runs out first, a gap after it on V1 (the
// magnetic track) holds the rest of the story at the same timestamps. Changing the speed used to make the shot
// shorter / longer and slid every later shot on V1 - the edit drifted off the voice-over and the beats.
export function keepLength(project, c, D, media) {
  if (!c || !(D > 0) || c.gap || (c.loop && c.dur > 0)) return;
  if (c.type === 'video' || c.type === 'audio') {
    const pts = rampPts(c), need = (c.in || 0) + D * (c.speed || 1) * (pts ? rampAvg(pts) : 1), max = media?.[c.mediaId]?.duration;
    c.out = +(max ? Math.min(max, need) : need).toFixed(3);
  }
  const V1 = project?.tracks?.V1 || [], i = V1.indexOf(c), left = D - clipDur(c, media);
  if (i < 0 || i === V1.length - 1 || left < 0.01) return;
  const nx = V1[i + 1];
  if (nx.gap) nx.dur = +(clipDur(nx, media) + left).toFixed(3);
  else V1.splice(i + 1, 0, { id: uid(), type: 'title', gap: true, text: '', bg: '#000000', dur: +left.toFixed(3) });
}

// Seconds a clip occupies on the timeline.
export function clipDur(c, media) {
  if (c.type === 'video' || c.type === 'audio') {
    if (c.loop && c.dur > 0) return c.dur;
    const m = media?.[c.mediaId];
    const end = c.out ?? m?.duration ?? 0;
    const pts = rampPts(c);
    return Math.max(0, (end - (c.in || 0)) / ((c.speed || 1) * (pts ? rampAvg(pts) : 1)));
  }
  return c.dur > 0 ? c.dur : c.type === 'title' ? 3 : 4;
}

export function transIn(c) {
  const t = c?.transitionIn;
  return t && t.type && t.type !== 'cut' && t.dur > 0 ? t : null;
}

// V1 is magnetic: each clip starts where the previous ends, minus its transition overlap.
export function layoutV1(project, media) {
  if (!Array.isArray(project?.tracks?.V1)) return []; // (no project open - e.g. a seek arriving as the editor goes back Home)
  let t = 0, prev = 0;
  return project.tracks.V1.map((clip, i) => {
    const d = clipDur(clip, media), tr = i > 0 ? transIn(clip) : null;
    const overlap = tr ? Math.max(0, Math.min(tr.dur, d - 0.1, prev - 0.1)) : 0;
    const start = Math.max(0, t - overlap);
    t = start + d; prev = d;
    return { clip, start, end: t, overlap };
  });
}

// ⧓ Puts / changes / takes off the transition into V1 clip i - like Premiere: the cut stays where it is and nothing on
// the timeline moves or gets shorter. The two shots lend frames from beyond their ends ("handles") for it, half after
// the cut from the shot before and half before the cut from the shot after (one side short: the other gives more).
// It used to slide the second shot back over the first, so every transition made the whole story shorter.
// transitionIn.hA / hB: the seconds each side lent (given back when the transition changes or goes).
const lendable = (c, side, want, media) => {
  if (!c) return 0;
  if (c.type !== 'video') return want; // a photo / title / graphic is simply made longer
  if (rampPts(c)) return 0;
  const m = media?.[c.mediaId], sp = c.speed || 1;
  const room = side === 'tail' ? ((m?.duration ?? c.out ?? 0) - (c.out ?? m?.duration ?? 0)) / sp : (c.in || 0) / sp;
  return Math.max(0, Math.min(want, room - 0.01));
};
function lend(c, sec, side, media) {
  if (!c || !sec) return;
  if (c.type !== 'video') { c.dur = +Math.max(0.2, clipDur(c, media) + sec).toFixed(3); return; }
  const m = media?.[c.mediaId], sp = c.speed || 1;
  if (side === 'tail') c.out = +((c.out ?? m?.duration ?? 0) + sec * sp).toFixed(3);
  else c.in = +Math.max(0, (c.in || 0) - sec * sp).toFixed(3);
}
// how much of an existing transition each side lent. An older one does not say: it is taken as all from the shot before
// - its tail was under the next shot (made by the agent it was even added for it), so taking it back changes nothing on
// screen and the story after it stays where it is (taking back nothing made every later shot move by its length)
export const trHandles = (tr) => (tr?.hA !== undefined || tr?.hB !== undefined ? { hA: tr.hA ?? 0, hB: tr.hB ?? 0 } : { hA: tr?.dur || 0, hB: 0 });
// sides: { hA, hB } to set each side on its own (dragging one end of the box in the timeline); dur is then ignored
export function setTransition(project, media, i, type, dur, sides = null) {
  const V1 = project.tracks.V1, A = V1[i - 1], B = V1[i];
  if (!B) return null;
  const old = transIn(B);
  if (old && A) { const h = trHandles(old); lend(A, -h.hA, 'tail', media); lend(B, -h.hB, 'head', media); }
  if (sides) dur = (sides.hA || 0) + (sides.hB || 0);
  if (!A || !type || type === 'cut' || !(dur > 0)) { delete B.transitionIn; return null; }
  let hA, hB;
  if (sides) { hA = lendable(A, 'tail', Math.max(0, sides.hA || 0), media); hB = lendable(B, 'head', Math.max(0, sides.hB || 0), media); }
  else {
    hA = lendable(A, 'tail', dur / 2, media); hB = lendable(B, 'head', dur / 2, media);
    if (hA < dur / 2) hB = lendable(B, 'head', dur - hA, media);
    if (hB < dur / 2) hA = lendable(A, 'tail', dur - hB, media);
  }
  // 📌 a transition longer than a shot cannot overlap fully (layoutV1 keeps 0.1 s of each) - the shots after it then
  // moved by the difference; each side lends at most what the other shot can cover, so every cut stays put
  hA = Math.min(hA, Math.max(0, clipDur(B, media) - 0.1)); hB = Math.min(hB, Math.max(0, clipDur(A, media) - 0.1));
  if (hA + hB < 0.05) { delete B.transitionIn; return null; } // (neither shot has frames to spare)
  lend(A, hA, 'tail', media); lend(B, hB, 'head', media);
  B.transitionIn = { type, dur: +(hA + hB).toFixed(3), hA: +hA.toFixed(3), hB: +hB.toFixed(3) };
  return B.transitionIn;
}

export function placed(project, media) {
  const out = { V1: layoutV1(project, media) };
  for (const id of Object.keys(project?.tracks || {})) if (id !== 'V1')
    out[id] = (project.tracks[id] || []).map((clip) => ({ clip, start: clip.start || 0, end: (clip.start || 0) + clipDur(clip, media), overlap: 0 }));
  return out;
}

// 🎬 the timeline's In / Out (settings.range, set with I / O): the part Export and the preview make. null = all of it.
// Only one of them set: from In to the end, or from the start to Out.
export function rangeOf(project, D) {
  const r = project?.settings?.range;
  if (!r || (r.in === undefined && r.out === undefined)) return null;
  const a = Math.max(0, Math.min(D, +r.in || 0)), b = Math.max(0, Math.min(D, r.out === undefined ? D : +r.out));
  return b - a >= 0.1 && (a > 0.001 || b < D - 0.001) ? { in: +a.toFixed(3), out: +b.toFixed(3) } : null;
}
export function totalDuration(project, media) {
  const p = placed(project, media);
  return Math.max(0, ...Object.values(p).flat().map((x) => x.end));
}

export const uid = () => Math.random().toString(36).slice(2, 10);

// ---------------- linked audio (Premiere-style [V] + [A]) ----------------
// A camera clip on the timeline is two clips sharing clip.link: the picture (type video, mute: true) on a V track and
// its sound (type audio, same mediaId) on an A track. syncLinked() keeps each pair together after any edit: the
// sound starts where the picture starts and uses the same in / out / speed. `lead` = id of the clip the user dragged
// or trimmed: when that is the sound, the picture follows it instead (a V1 picture keeps its place in the story).
// A split picture gets its own copy of the sound; a sound whose picture was deleted goes too; a picture whose sound
// was deleted stays silent. Clips without link (older projects, agent edits) keep their sound inside the video clip.
const LINKED = ['in', 'out', 'speed', 'disabled', 'mediaId']; // (🔄 Replace clip swaps the sound too)
export function syncLinked(project, media, lead = null) {
  const P = placed(project, media), vids = new Map(), auds = new Map();
  for (const [tr, list] of Object.entries(P)) for (const x of list) {
    const c = x.clip, kind = trackKind(tr);
    if (!c.link) continue;
    const map = kind === 'video' && c.type === 'video' ? vids : kind === 'audio' && c.type === 'audio' ? auds : null;
    if (map) { if (!map.has(c.link)) map.set(c.link, []); map.get(c.link).push({ tr, x }); }
  }
  let changed = false;
  const set = (o, k, v) => {
    if (v === undefined || v === null) { if (k in o) { delete o[k]; changed = true; } } else if (o[k] !== v) { o[k] = v; changed = true; }
  };
  const drop = (tr, c) => { const l = project.tracks[tr], i = l.indexOf(c); if (i >= 0) { l.splice(i, 1); changed = true; } };
  for (const [L, as] of auds) if (!vids.has(L)) for (const a of as) drop(a.tr, a.x.clip);
  for (const [L, vs] of vids) {
    const as = auds.get(L) || [];
    if (!as.length) continue;
    vs.sort((p, q) => p.x.start - q.x.start); as.sort((p, q) => p.x.start - q.x.start);
    for (const a of as.slice(vs.length)) drop(a.tr, a.x.clip);
    vs.forEach((v, i) => {
      let a = as[i];
      if (!a) {
        const tpl = as[as.length - 1], c = JSON.parse(JSON.stringify(tpl.x.clip));
        c.id = uid(); project.tracks[tpl.tr].push(c); changed = true;
        a = { tr: tpl.tr, x: { clip: c, start: 0 } };
      }
      const V = v.x.clip, A = a.x.clip;
      if (i > 0 && (V.link === vs[0].x.clip.link)) { const nl = uid(); V.link = nl; A.link = nl; changed = true; }
      const fromA = lead && A.id === lead && V.id !== lead;
      for (const k of LINKED) fromA ? set(V, k, A[k]) : set(A, k, V[k]);
      if (fromA && v.tr !== 'V1') set(V, 'start', +(A.start || 0).toFixed(3));
      else set(A, 'start', +v.x.start.toFixed(3));
      if (media?.[A.mediaId]?.hasAudio === false) drop(a.tr, A); // (replaced by a video without sound)
    });
  }
  return changed;
}
// the audio track a clip's sound goes on over [t0, t1): A1 when it is free there, then any free audio track but the
// music track (A2), else a new one
export function freeAudioTrack(project, media, t0, t1, skipId = null) {
  const P = placed(project, media);
  const free = (id) => !(P[id] || []).some((x) => x.clip.id !== skipId && x.start < t1 - 0.01 && x.end > t0 + 0.01);
  return audioTracks(project).filter((id) => id !== 'A2').find(free) || addTrack(project, 'audio');
}
// the sound of a video clip as its own linked clip on an audio track (the video clip goes silent)
export function linkAudioOf(project, media, V) {
  const m = media?.[V.mediaId];
  if (!V || V.type !== 'video' || !m || m.hasAudio === false) return null;
  const x = Object.values(placed(project, media)).flat().find((p) => p.clip === V);
  if (!x) return null;
  const link = uid(), A = { id: uid(), type: 'audio', mediaId: V.mediaId, link, start: +x.start.toFixed(3) };
  for (const k of LINKED) if (V[k] !== undefined) A[k] = V[k];
  if (V.volume !== undefined) A.volume = V.volume;
  if (V.afx) A.afx = V.afx;
  if (V.keys?.volume?.length) A.keys = { volume: V.keys.volume };
  const tr = freeAudioTrack(project, media, x.start, x.end);
  project.tracks[tr].push(A);
  V.link = link; V.mute = true;
  return { audio: A, track: tr };
}
// the given clip ids plus their linked halves (copy / nest take a picture together with its sound)
export function linkedIds(project, ids) {
  const out = new Set(ids), links = new Set();
  for (const l of Object.values(project.tracks)) for (const c of l) if (out.has(c.id) && c.link) links.add(c.link);
  if (links.size) for (const l of Object.values(project.tracks)) for (const c of l) if (c.link && links.has(c.link)) out.add(c.id);
  return out;
}
// fresh link ids for copied clips (a pasted / nested pair is its own pair, not tied to the original)
export function relink(clips) {
  const map = new Map();
  for (const c of clips) if (c.link) { if (!map.has(c.link)) map.set(c.link, uid()); c.link = map.get(c.link); }
  return clips;
}
// partner of a linked clip: { clip, track } or null
export function linkedPartner(project, c) {
  if (!c?.link) return null;
  for (const [tr, list] of Object.entries(project.tracks)) for (const o of list) if (o !== c && o.link === c.link) return { clip: o, track: tr };
  return null;
}

// ⛓ Groups (Ctrl+G), like Premiere: clips sharing clip.grp are selected, moved, nudged and deleted together
// (Ctrl+Shift+G ungroups). The given clip ids plus every clip in their groups.
export function groupedIds(project, ids) {
  const out = new Set(ids), gs = new Set();
  for (const l of Object.values(project.tracks)) for (const c of l) if (out.has(c.id) && c.grp) gs.add(c.grp);
  if (gs.size) for (const l of Object.values(project.tracks)) for (const c of l) if (c.grp && gs.has(c.grp)) out.add(c.id);
  return out;
}

// 📍 Ripple Sequence Markers (Markers menu, like Premiere; settings.rippleMarkers): when the story ripples, the
// sequence markers after that point move with it, so a marker stays on its moment
export function rippleMarkers(project, at, by) {
  if (!project.settings?.rippleMarkers || !by) return 0;
  let n = 0;
  for (const m of project.markers || []) if (m.t >= at - 0.01) { m.t = +Math.max(0, m.t + by).toFixed(3); n++; }
  return n;
}

// 🔒 Sync Lock (the ⇋ button on a track header), like Premiere: when the main story ripples - Ripple delete, Q / W,
// Insert, a ripple trim, Paste Insert, Trim mode - the clips on a sync-locked track that start at / after `at` move by
// `by` seconds too, so titles, music and B-roll stay with the shots they belong to. Off unless turned on (clips never
// move on their own). A sound linked to a V1 picture follows its picture anyway (syncLinked). Returns how many moved.
export function syncShift(project, at, by) {
  if (!by || Math.abs(by) < 1e-4) return 0;
  rippleMarkers(project, at, by);
  const ts = project.trackState || {}, v1Links = new Set((project.tracks.V1 || []).map((c) => c.link).filter(Boolean));
  let n = 0;
  for (const [id, list] of Object.entries(project.tracks)) {
    if (id === 'V1' || !ts[id]?.sync || ts[id]?.lock) continue;
    for (const c of list) {
      if (c.link && v1Links.has(c.link)) continue;
      if ((c.start || 0) >= at - 0.01) { c.start = +Math.max(0, (c.start || 0) + by).toFixed(3); n++; }
    }
  }
  return n;
}

export function fmtTC(s, fps = 30) {
  s = Math.max(0, +s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), f = Math.floor((s % 1) * fps);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(sec)}:${p(f)}`;
}
// ⚙ time as the sequence shows it (Sequence Settings › Display format): timecode, frames or seconds
export function fmtTime(s, st = {}) { const fps = st.fps || 30; return st.tcMode === 'frames' ? String(Math.round(Math.max(0, +s || 0) * fps)) : st.tcMode === 'secs' ? fmt(s) : fmtTC(s, fps); }
export function fmt(s) {
  if (s === undefined || s === null || isNaN(s)) return '';
  s = Math.max(0, +s);
  const m = Math.floor(s / 60), r = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${r}`;
}
// ⌨ a typed timecode, like Premiere's timecode fields: 00:01:10:12, 1:10:12 or 1;10 (frames last), plain digits read
// as HHMMSSFF from the right (1012 = 10 s 12 frames, 300 = 3 s), 2.5 = seconds. A leading + / - makes it relative.
// -> { sec, rel } (rel: 0 absolute, 1 later, -1 earlier) or null when it is not a timecode.
export function parseTC(v, fps = 30) {
  const m = /^([+-]?)([\d:;.]+)$/.exec(String(v ?? '').replace(/\s+/g, ''));
  if (!m || !/\d/.test(m[2])) return null;
  const body = m[2];
  let sec;
  if (body.includes('.') && !/[:;]/.test(body)) sec = parseFloat(body);
  else {
    const parts = /[:;]/.test(body) ? body.split(/[:;]/) : body.length <= 8 ? body.padStart(8, '0').match(/\d\d/g) : null;
    if (!parts || parts.length > 4 || parts.some((p) => !/^\d*$/.test(p))) return null;
    const [f = 0, s = 0, mi = 0, h = 0] = parts.map((p) => +p || 0).reverse();
    sec = h * 3600 + mi * 60 + s + f / fps;
  }
  if (!isFinite(sec)) return null;
  return { sec: Math.round(sec * 1000) / 1000, rel: m[1] === '+' ? 1 : m[1] === '-' ? -1 : 0 };
}
export function parseTime(v) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = String(v).trim().split(':').reduce((a, p) => a * 60 + parseFloat(p), 0);
  return isNaN(n) ? undefined : Math.round(n * 1000) / 1000;
}

// ---------------- keyframes ----------------
// clip.keys = { 'transform.zoom': [{ t, v, ease }], ... }   t = seconds from the clip's start on the timeline.
// Between two keys the value moves as the first key's ease says: linear (none), true / 'io' = smooth S-curve,
// 'in' = starts slow, 'out' = ends slow, 'hold' = stays put until the next key (a jump).
// The same curve is evaluated in the browser (evalKeys) and turned into an FFmpeg expression (keysExpr).
export const KEYABLE = {
  'transform.zoom': { label: 'Zoom', def: 1 },
  'transform.x': { label: 'Position X', def: 0 },
  'transform.y': { label: 'Position Y', def: 0 },
  'transform.rotation': { label: 'Rotation', def: 0 },
  opacity: { label: 'Opacity', def: 1 },
  volume: { label: 'Volume', def: 1 },
  // where a Fill-framed picture is cut (0 = left / top edge, 1 = right / bottom): keyed by 🎯 Follow faces
  cropX: { label: 'Crop position ', def: 0.5 },
  cropY: { label: 'Crop position ', def: 0.5 },
};
export const EASES = [['', 'Linear'], ['io', 'Smooth (ease in + out)'], ['in', 'Ease in (starts slow)'], ['out', 'Ease out (ends slow)'], ['hold', 'Hold (jump)']];
const easeFn = (e, u) => (e === true || e === 'io' ? u * u * (3 - 2 * u) : e === 'in' ? u * u : e === 'out' ? 1 - (1 - u) * (1 - u) : e === 'hold' ? 0 : u);
const getP = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);

// 📈 Per-keyframe interpolation (Premiere / After Effects), on top of the old per-segment `ease`:
// key.ip = 'linear' | 'bezier' | 'cont' (Continuous Bezier) | 'auto' (Auto Bezier) | 'hold'
// key.in / key.out = { s, f }: the handle's speed (value per second) and influence (0..1 of the segment's time).
// A segment whose two keys have no `ip` keeps the old ease, so old projects play exactly as before.
export const KEY_IPS = [['linear', 'Linear'], ['bezier', 'Bezier'], ['auto', 'Auto Bezier'], ['cont', 'Continuous Bezier'], ['hold', 'Hold'], ['easein', 'Ease In'], ['easeout', 'Ease Out'], ['easy', 'Easy Ease']];
const F3 = 1 / 3;
const slopeOf = (a, b) => (b.v - a.v) / Math.max(1e-6, b.t - a.t);
// The handle of key i on one side ('in' = towards the key before, 'out' = towards the key after): { s, f }.
export function keyHandle(keys, i, side) {
  const k = keys[i], p = keys[i - 1], n = keys[i + 1], nb = side === 'in' ? p : n;
  if (!nb) return { s: 0, f: F3 };
  const m = side === 'in' ? slopeOf(p, k) : slopeOf(k, n);
  if (!k.ip) {
    // an old key: the handle that draws its old ease exactly (smooth = flat ends, ease in = u², ease out = 1-(1-u)²)
    const owner = side === 'in' ? p : k;
    if (side === 'in' && p.ip) return { s: m, f: F3 };
    const e = owner.ease === true ? 'io' : owner.ease;
    if (e === 'io') return { s: 0, f: F3 };
    if (e === 'in') return { s: side === 'out' ? 0 : 2 * m, f: F3 };
    if (e === 'out') return { s: side === 'out' ? 2 * m : 0, f: F3 };
    return { s: m, f: F3 };
  }
  if (k.ip === 'linear' || (k.ip === 'hold' && !k[side])) return { s: m, f: F3 };
  if (k.ip === 'auto' || !k[side]) return { s: p && n ? (n.v - p.v) / Math.max(1e-6, n.t - p.t) : 0, f: F3 };
  return { s: +k[side].s || 0, f: Math.min(1, Math.max(0.01, k[side].f ?? F3)) };
}
// How the value moves from key i to key i+1: 'hold', an old ease, or a cubic bezier (x = share of the time, y = value)
function segOf(keys, i) {
  const a = keys[i], b = keys[i + 1], d = Math.max(1e-6, b.t - a.t);
  if (a.ip === 'hold' || (!a.ip && a.ease === 'hold')) return { hold: true };
  if (!a.ip && !b.ip) return { ease: a.ease };
  const o = keyHandle(keys, i, 'out'), n = keyHandle(keys, i + 1, 'in');
  return { x1: o.f, x2: 1 - n.f, y0: a.v, y1: a.v + o.s * o.f * d, y2: b.v - n.s * n.f * d, y3: b.v };
}
const cub = (p0, p1, p2, p3, s) => { const r = 1 - s; return r * r * r * p0 + 3 * r * r * s * p1 + 3 * r * s * s * p2 + s * s * s * p3; };
// handles of a third of the time each: x moves evenly, so the curve is a plain cubic in u (no solving)
const evenX = (g) => Math.abs(g.x1 - F3) < 1e-4 && Math.abs(g.x2 - 2 * F3) < 1e-4;
function bezAt(g, u) {
  let s = u;
  if (!evenX(g)) { let lo = 0, hi = 1; for (let k = 0; k < 40; k++) { s = (lo + hi) / 2; if (cub(0, g.x1, g.x2, 1, s) < u) lo = s; else hi = s; } s = (lo + hi) / 2; }
  return cub(g.y0, g.y1, g.y2, g.y3, s);
}

export function evalKeys(keys, t) {
  if (!keys?.length) return undefined;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t < b.t) {
      const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
      if (!a.ip && !b.ip) return a.v + (b.v - a.v) * easeFn(a.ease, u);
      const g = segOf(keys, i);
      return g.hold ? a.v : bezAt(g, u);
    }
  }
  return keys[keys.length - 1].v;
}

// Turn a property's old keys into per-key interpolation with the same curve (before editing handles / interpolation).
export function keysToIp(keys) {
  if (!keys?.length || keys.every((k) => k.ip)) return keys;
  const h = keys.map((k, i) => ({ in: keyHandle(keys, i, 'in'), out: keyHandle(keys, i, 'out') }));
  keys.forEach((k, i) => {
    if (k.ip) return;
    const lin = (side) => { const nb = keys[side === 'in' ? i - 1 : i + 1]; return !nb || Math.abs(h[i][side].s - (side === 'in' ? slopeOf(nb, k) : slopeOf(k, nb))) < 1e-9; };
    k.ip = k.ease === 'hold' ? 'hold' : lin('in') && lin('out') ? 'linear' : 'bezier';
    if (k.ip !== 'linear') { k.in = { s: +h[i].in.s.toFixed(5), f: F3 }; if (k.ip === 'bezier') k.out = { s: +h[i].out.s.toFixed(5), f: F3 }; }
    delete k.ease;
  });
  return keys;
}
// Premiere's right-click > Temporal Interpolation (and F9 / Shift+F9 / Ctrl+Shift+F9) on key i.
export function setKeyIp(keys, i, mode) {
  keysToIp(keys);
  const k = keys[i]; if (!k) return;
  const cur = { in: keyHandle(keys, i, 'in'), out: keyHandle(keys, i, 'out') }, flat = { s: 0, f: F3 };
  delete k.in; delete k.out;
  if (mode === 'linear' || mode === 'auto') { k.ip = mode; return; }
  if (mode === 'hold') { k.ip = 'hold'; k.in = cur.in; return; }
  k.ip = 'bezier'; k.in = cur.in; k.out = cur.out;
  if (mode === 'cont') { const s = +((cur.in.s + cur.out.s) / 2).toFixed(5); k.ip = 'cont'; k.in = { ...cur.in, s }; k.out = { ...cur.out, s }; }
  if (mode === 'easein' || mode === 'easy') k.in = { ...flat };
  if (mode === 'easeout' || mode === 'easy') k.out = { ...flat };
}

// Value of a property at clip-relative time t (keyframes win over the static value).
export function propAt(c, path, t) {
  const k = c.keys?.[path];
  if (k?.length) return evalKeys(k, t);
  const v = getP(c, path);
  return v ?? KEYABLE[path]?.def;
}
export const hasKeys = (c, path) => !!c.keys?.[path]?.length;

// 📈 One bezier segment as an FFmpeg expression (`rest` = the expression after key b). Even handles: the exact cubic in
// u; uneven ones (influence dragged): 24 points along the curve joined by straight lines - within a hair of evalKeys.
function bezExpr(g, a, b, d, T, u, rest, f) {
  if (g.hold) return `if(lt(${T},${f(b.t)}),${f(a.v)},${rest})`;
  if (evenX(g)) {
    const c1 = 3 * (g.y1 - g.y0), c2 = 3 * (g.y0 - 2 * g.y1 + g.y2), c3 = g.y3 - g.y0 + 3 * (g.y1 - g.y2);
    return `if(lt(${T},${f(b.t)}),${f(g.y0)}+${u}*(${f(c1)}+${u}*(${f(c2)}+${u}*(${f(c3)}))),${rest})`;
  }
  const N = 24, pts = [];
  for (let j = 0; j <= N; j++) { const s = j / N, t = a.t + cub(0, g.x1, g.x2, 1, s) * d; if (j === N || !pts.length || t - pts[pts.length - 1][0] > 1e-4) pts.push([j === N ? b.t : t, cub(g.y0, g.y1, g.y2, g.y3, s)]); }
  let e = rest;
  for (let j = pts.length - 1; j >= 1; j--) {
    const [t0, v0] = pts[j - 1], [t1, v1] = pts[j];
    e = `if(lt(${T},${f(t1)}),${f(v0)}+(${f((v1 - v0) / Math.max(1e-6, t1 - t0))})*(${T}-${f(t0)}),${e})`;
  }
  return e;
}

// FFmpeg expression of the same curve in variable `T` (e.g. 't' or 'it'). Commas are fine inside quoted filter args.
export function keysExpr(keys, T = 't') {
  const f = (x) => (+x).toFixed(5);
  if (keys.length === 1) return f(keys[0].v);
  let e = f(keys[keys.length - 1].v);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1], d = Math.max(1e-6, b.t - a.t);
    const u = `((${T}-${f(a.t)})/${f(d)})`;
    if (a.ip || b.ip) { e = bezExpr(segOf(keys, i), a, b, d, T, u, e, f); continue; }
    const s = a.ease === true || a.ease === 'io' ? `(${u}*${u}*(3-2*${u}))` : a.ease === 'in' ? `(${u}*${u})` : a.ease === 'out' ? `(1-(1-${u})*(1-${u}))` : a.ease === 'hold' ? '0' : u;
    e = `if(lt(${T},${f(b.t)}),${f(a.v)}+(${f(b.v - a.v)})*${s},${e})`;
  }
  return `if(lt(${T},${f(keys[0].t)}),${f(keys[0].v)},${e})`;
}

// Set a property the way the Inspector does: with keyframes on it, set / add the key at clip time `rel`
// (keys closer than half a frame are the same key); otherwise set the static value (e.g. c.transform.x).
export function setAnimated(c, path, v, rel, fps = 30) {
  const keys = c.keys?.[path];
  if (keys?.length) {
    const i = keys.findIndex((k) => Math.abs(k.t - rel) < 0.5 / fps);
    if (i >= 0) keys[i].v = v; else { keys.push({ t: +rel.toFixed(3), v }); keys.sort((a, b) => a.t - b.t); }
    return;
  }
  const parts = path.split('.'), last = parts.pop();
  let o = c;
  for (const p of parts) o = o[p] ||= {};
  o[last] = v;
}
