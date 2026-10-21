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

export const ASPECTS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] };

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
export function addTrack(project, kind) {
  const pre = kind === 'audio' ? 'A' : 'V';
  const n = Math.max(2, ...Object.keys(project.tracks).filter((id) => id[0] === pre).map(trackNum)) + 1;
  const id = `${pre}${n}`;
  project.tracks[id] = [];
  project.trackState[id] = { mute: false, hide: false, lock: false, volume: 1 };
  return id;
}
export const BLEND_MODES = [['', 'Normal'], ['screen', 'Screen (lighten, light leaks)'], ['multiply', 'Multiply (darken)'], ['overlay', 'Overlay (contrast)'], ['softlight', 'Soft light'], ['addition', 'Add (glow)'], ['lighten', 'Lighten'], ['darken', 'Darken'], ['difference', 'Difference']];

export const TRANSITIONS = [
  ['cut', 'Cut'], ['fade', 'Cross dissolve'], ['fadeblack', 'Dip to black'], ['fadewhite', 'Dip to white'],
  ['dissolve', 'Dissolve (grain)'], ['wipeleft', 'Wipe left'], ['wiperight', 'Wipe right'], ['slideleft', 'Slide left'],
  ['slideup', 'Slide up'], ['smoothleft', 'Smooth left'], ['circleopen', 'Circle open'], ['zoomin', 'Zoom in'],
  // teaser transitions
  ['hblur', 'Whip blur'], ['fadefast', 'Flash cut'], ['pixelize', 'Pixelize'], ['radial', 'Radial wipe'], ['squeezeh', 'Squeeze'],
  ['hlslice', 'Slice'], ['circlecrop', 'Iris'], ['distance', 'Distance'],
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
function profileAt(pts, u) {
  if (u <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, sa] = pts[i], [b, sb] = pts[i + 1];
    if (u <= b) return sa + (sb - sa) * smooth((u - a) / Math.max(1e-6, b - a));
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
// how much of an existing transition each side lent (an older one does not say: nothing is taken back from it, so a
// change never cuts into a shot - at worst the cut ends up a little later)
export const trHandles = (tr) => ({ hA: tr?.hA ?? 0, hB: tr?.hB ?? 0 });
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
  if (hA + hB < 0.05) { delete B.transitionIn; return null; } // (neither shot has frames to spare)
  lend(A, hA, 'tail', media); lend(B, hB, 'head', media);
  B.transitionIn = { type, dur: +(hA + hB).toFixed(3), hA: +hA.toFixed(3), hB: +hB.toFixed(3) };
  return B.transitionIn;
}

export function placed(project, media) {
  const out = { V1: layoutV1(project, media) };
  for (const id of Object.keys(project.tracks)) if (id !== 'V1')
    out[id] = (project.tracks[id] || []).map((clip) => ({ clip, start: clip.start || 0, end: (clip.start || 0) + clipDur(clip, media), overlap: 0 }));
  return out;
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

export function fmtTC(s, fps = 30) {
  s = Math.max(0, +s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), f = Math.floor((s % 1) * fps);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(sec)}:${p(f)}`;
}
export function fmt(s) {
  if (s === undefined || s === null || isNaN(s)) return '';
  s = Math.max(0, +s);
  const m = Math.floor(s / 60), r = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${r}`;
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
  cropX: { label: 'Crop position ↔', def: 0.5 },
  cropY: { label: 'Crop position ↕', def: 0.5 },
};
export const EASES = [['', 'Linear'], ['io', 'Smooth (ease in + out)'], ['in', 'Ease in (starts slow)'], ['out', 'Ease out (ends slow)'], ['hold', 'Hold (jump)']];
const easeFn = (e, u) => (e === true || e === 'io' ? u * u * (3 - 2 * u) : e === 'in' ? u * u : e === 'out' ? 1 - (1 - u) * (1 - u) : e === 'hold' ? 0 : u);
const getP = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);

export function evalKeys(keys, t) {
  if (!keys?.length) return undefined;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t < b.t) {
      const u = easeFn(a.ease, (t - a.t) / Math.max(1e-6, b.t - a.t));
      return a.v + (b.v - a.v) * u;
    }
  }
  return keys[keys.length - 1].v;
}

// Value of a property at clip-relative time t (keyframes win over the static value).
export function propAt(c, path, t) {
  const k = c.keys?.[path];
  if (k?.length) return evalKeys(k, t);
  const v = getP(c, path);
  return v ?? KEYABLE[path]?.def;
}
export const hasKeys = (c, path) => !!c.keys?.[path]?.length;

// FFmpeg expression of the same curve in variable `T` (e.g. 't' or 'it'). Commas are fine inside quoted filter args.
export function keysExpr(keys, T = 't') {
  const f = (x) => (+x).toFixed(5);
  if (keys.length === 1) return f(keys[0].v);
  let e = f(keys[keys.length - 1].v);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1], d = Math.max(1e-6, b.t - a.t);
    const u = `((${T}-${f(a.t)})/${f(d)})`;
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
