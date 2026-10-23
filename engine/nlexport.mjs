// nlexport.mjs - hands the timeline to Premiere Pro / DaVinci Resolve as a Final Cut Pro 7 XML (xmeml v4), which both import.
//
// What carries over: every clip on its track with the same source in/out and timeline position (original camera files,
// not proxies), cross dissolves, speed changes, clip volume, V2 opacity, fit-to-frame scale x zoom, position, rotation,
// the logo, markers, and the subtitle file (.srt next to the XML). Titles become PNG stills (+ a marker with the text).
// What does not: colour grades/LUTs, keyframes, masks, audio effects and ducking - listed in notes.
//
// exportTimeline({ project, media, outDir, base, subtitlesPath }) -> { xml, files: [...], notes: [...] }
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ASPECTS, placed, totalDuration, rampPts, rampAvg, overlayTracks, audioTracks } from '../public/js/model.js';
import { isNeutral } from '../public/js/colormath.js';
import { bakeCube } from './lutbake.mjs';

const FONTS = {
  latin: ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  deva: ['C:/Windows/Fonts/NirmalaB.ttf', 'C:/Windows/Fonts/Nirmala.ttf', 'C:/Windows/Fonts/Nirmala.ttc', '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf'],
};
const DEVA = /[\u0900-\u097F]/;
const X = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const B = (v) => (v ? 'TRUE' : 'FALSE');

// 29.97 -> timebase 30 + NTSC, 25 -> 25
function rateOf(fps) {
  const f = +fps || 30, tb = Math.round(f);
  return { tb, ntsc: Math.abs(f - tb) > 0.01 };
}
const rateXml = (r) => `<rate><timebase>${r.tb}</timebase><ntsc>${B(r.ntsc)}</ntsc></rate>`;
const pathUrl = (p) => `file://localhost/${path.resolve(p).replace(/\\/g, '/').split('/').map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s.replace(':', '%3a') : encodeURIComponent(s))).join('/')}`;

function param(id, name, value, min, max) {
  return `<parameter><parameterid>${id}</parameterid><name>${name}</name>${min !== undefined ? `<valuemin>${min}</valuemin><valuemax>${max}</valuemax>` : ''}<value>${value}</value></parameter>`;
}
const motion = (name, id, params) => `<filter><effect><name>${name}</name><effectid>${id}</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>${params}</effect></filter>`;
const audioLevel = (v) => `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>${param('level', 'Level', +Math.max(0, Math.min(3.98109, v)).toFixed(4), 0, 3.98109)}</effect></filter>`;
const timeRemap = (speed) => motion('Time Remap', 'timeremap',
  param('variablespeed', 'variablespeed', 0, 0, 1) + param('speed', 'speed', +(speed * 100).toFixed(2), -100000, 100000) + param('reverse', 'reverse', 'FALSE') + param('frameblending', 'frameblending', 'FALSE'));

function transition(seq, start, end, video) {
  const eff = video
    ? '<effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effectcategory>Dissolve</effectcategory><effecttype>transition</effecttype><mediatype>video</mediatype><wipecode>0</wipecode><wipeaccuracy>100</wipeaccuracy><startratio>0</startratio><endratio>1</endratio><reverse>FALSE</reverse></effect>'
    : '<effect><name>Cross Fade (+3dB)</name><effectid>KGAudioTransCrossFade3dB</effectid><effecttype>transition</effecttype><mediatype>audio</mediatype></effect>';
  return `<transitionitem>${rateXml(seq)}<start>${start}</start><end>${end}</end><alignment>center</alignment>${eff}</transitionitem>`;
}

// Title text -> PNG still (full frame; transparent for overlays, coloured card for V1), drawn like the renderer draws it.
function titlePng(file, c, W, H, card) {
  const text = c.text || ' ';
  const fontSrc = (DEVA.test(text) ? FONTS.deva : FONTS.latin).find((f) => fs.existsSync(f));
  if (!fontSrc) return false;
  const dir = path.dirname(file), tmpFont = path.join(dir, `_font${path.extname(fontSrc)}`), tmpText = path.join(dir, '_title.txt');
  fs.copyFileSync(fontSrc, tmpFont); fs.writeFileSync(tmpText, text, 'utf8');
  const style = card ? 'center' : c.textStyle || 'center';
  const longest = Math.max(...String(text).split('\n').map((l) => [...l].length), 1);
  const base = style === 'center' ? Math.min(H * 0.06, W * 0.075) : Math.min(H * 0.04, W * 0.045);
  const size = Math.max(12, Math.round(c.size || Math.min(base, (W * 0.88) / (longest * 0.58))));
  const x = style === 'lower' ? `${Math.round(W * 0.06)}` : '(w-text_w)/2';
  const y = style === 'center' ? '(h-text_h)/2' : style === 'top' ? `${Math.round(H * 0.08)}` : `h-text_h-${Math.round(H * 0.12)}`;
  const deco = !card && style !== 'center' ? `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(size * 0.45)}` : `:shadowcolor=black@0.7:shadowx=${Math.ceil(size / 20)}:shadowy=${Math.ceil(size / 20)}`;
  const src = card ? `color=c=${c.bg || '#0b2545'}:s=${W}x${H}` : `color=c=black@0.0:s=${W}x${H},format=rgba`;
  const vf = `drawtext=fontfile=${path.basename(tmpFont)}:textfile=${path.basename(tmpText)}:expansion=none:fontsize=${size}:fontcolor=${c.textColor || 'white'}:line_spacing=${Math.round(size * 0.3)}${deco}:x=${x}:y=${y}`;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', '-vf', vf, path.basename(file)], { cwd: dir });
  fs.rmSync(tmpFont, { force: true }); fs.rmSync(tmpText, { force: true });
  return r.status === 0;
}

// color: 'none' | 'lut' (one .cube per graded clip, named on the clip) | 'bake' (graded copies made by the server:
// graded = { clipId: { file, start, duration } } - the XML then points at those files and the look is already in the picture)
// collect: 'none' (the XML points at the files on this computer) | 'full' / 'trim' (the server copied the media into
// <outDir>/Media first - whole files, or just the used parts as clips with handles - and `media` / `graded` point there)
export function exportTimeline({ project, media, outDir, base, subtitlesPath, color = 'none', luts = {}, graded = {}, collect = 'none' }) {
  const S = project.settings, ts = project.trackState || {};
  const [W, H] = ASPECTS[S.aspect] || ASPECTS['16:9'];
  const seq = rateOf(S.fps), fps = seq.tb * (seq.ntsc ? 1000 / 1001 : 1);
  const fr = (t) => Math.round(t * fps), secOf = (f) => f / fps;
  const P = placed(project, media), D = totalDuration(project, media);
  const notes = new Set(), files = [], markers = [], lutsUsed = new Set();
  let clipN = 0;

  // <file>: a placeholder now; when the XML is assembled the first one in document order gets the full description
  // and the rest become references (clips are visited in a different order than they appear in the file).
  const fileDefs = new Map();
  function fileXml(key, info) {
    if (!fileDefs.has(key)) fileDefs.set(key, fileBody(info));
    return `@@FILE[${key}]@@`;
  }
  function fileBody({ name, file, kind, fps, width, height, hasAudio, duration, rotation }) {
    const r = kind === 'image' ? seq : rateOf(fps || S.fps);
    const rot = Math.abs(rotation || 0) % 180 === 90;
    const vid = kind !== 'audio' ? `<video><samplecharacteristics>${rateXml(r)}<width>${(rot ? height : width) || W}</width><height>${(rot ? width : height) || H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>` : '';
    const aud = hasAudio ? '<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>' : '';
    const dur = kind === 'image' ? '' : `<duration>${Math.round((duration || 0) * r.tb * (r.ntsc ? 1000 / 1001 : 1))}</duration>`;
    return `<name>${X(name)}</name><pathurl>${pathUrl(file)}</pathurl>${rateXml(r)}${dur}` +
      `<timecode>${rateXml(r)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media>${vid}${aud}</media>`;
  }

  // scale (%) that makes the picture fit / fill the sequence frame, times the clip's own zoom
  function fitScale(m, c) {
    const rot = Math.abs(m.rotation || 0) % 180 === 90;
    const w = (rot ? m.height : m.width) || W, h = (rot ? m.width : m.height) || H;
    const mode = c.fit || S.fit || (H > W ? 'blur' : 'fit');
    if (mode === 'blur') notes.add('Blurred-background fill for vertical frames is shown as plain fit (black bars) - add a blurred copy underneath if needed.');
    const s = mode === 'fill' ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
    return +(s * 100 * (c.transform?.zoom || 1)).toFixed(3);
  }

  // ▭ a rectangle Opacity mask -> Premiere's Crop effect (% of the source picture from each edge; applied before Motion)
  function cropFilter(m, c) {
    const k = c.omask;
    if (k?.shape !== 'rect' || k.invert) return '';
    const rot = Math.abs(m.rotation || 0) % 180 === 90;
    const w = (rot ? m.height : m.width) || W, h = (rot ? m.width : m.height) || H;
    const mode = c.fit || S.fit || (H > W ? 'blur' : 'fit');
    const s = mode === 'fill' ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
    // the mask is in fractions of the frame the picture was fitted into; the picture fills pw x ph of it, centred
    const pw = (w * s) / W, ph = (h * s) / H;
    const pct = (v) => +Math.min(100, Math.max(0, v * 100)).toFixed(3);
    const L = pct(((k.x ?? 0.5) - (k.w ?? 0.3) / 2 - (0.5 - pw / 2)) / pw), R = pct((0.5 + pw / 2 - ((k.x ?? 0.5) + (k.w ?? 0.3) / 2)) / pw);
    const T = pct(((k.y ?? 0.5) - (k.h ?? 0.3) / 2 - (0.5 - ph / 2)) / ph), Bt = pct((0.5 + ph / 2 - ((k.y ?? 0.5) + (k.h ?? 0.3) / 2)) / ph);
    if (!L && !R && !T && !Bt) return '';
    return motion('Crop', 'crop', param('left', 'left', L, 0, 100) + param('right', 'right', R, 0, 100) +
      param('top', 'top', T, 0, 100) + param('bottom', 'bottom', Bt, 0, 100) + param('edgefeather', 'edgefeather', 0, 0, 100));
  }

  function noteLosses(c) {
    if (c.ramp) notes.add('Speed ramps come across as the average speed of the shot - redo the ramp with Time Remapping (Premiere) or Retime Curve (Resolve).');
    if (c.cutFx?.type && !graded[c.id]?.cut) notes.add(`Cut effects (${color === 'bake' ? 'glitch, light leak, whip, shake... - flash and strobe are baked in' : 'flash, glitch, light leak, whip, shake...'}) are not in the XML - add them in your editor, or deliver the MP4 from this app.`);
    // a black chroma key only makes the empty frame around a shrunk picture see-through - Premiere / Resolve leave it
    // see-through anyway, so it needs nothing
    const blackKey = (e) => e.type === 'chromakey' && /^#?0{6}$/.test(String(e.p?.color || '#00ff00'));
    if (c.effects?.some((e) => e.on !== false && !blackKey(e))) notes.add('Video effects from the Effects panel (blur, black & white, glow, crop, green screen...) are not in the XML - add them again in your editor.');
    if (c.type === 'title' && (c.anim === 'words' || c.anim === 'build')) notes.add('Kinetic (word by word) titles come across as one still title PNG.');
    if (color === 'none' && c.color && !isNeutral(c.color)) { notes.add('Colour grades/LUTs are not in the XML - re-grade in Lumetri / Resolve Color'); if (c.color.lut) lutsUsed.add(c.color.lut); }
    if (c.keys && Object.values(c.keys).some((k) => k?.length)) notes.add('Keyframed zoom / position / volume animations need to be redone (the clip starts where its still settings put it).');
    if (c.omask?.shape && (c.omask.shape !== 'rect' || c.omask.invert)) notes.add('Ellipse / inverted opacity masks are not in the XML - draw them again (Premiere: Opacity > mask; Resolve: Power Window). Rectangle masks come across as Crop.');
    if (c.fadeIn || c.fadeOut) notes.add('Clip fade-ins/outs need to be redone (cross dissolves between V1 clips are carried over).');
    if (c.text && c.type !== 'title') notes.add('Text burned onto clips (lower thirds on footage) is exported as markers only.');
  }

  // One video clipitem (+ its audio clipitem when the clip has sound); startF/endF in sequence frames, srcInSec in the file.
  const lutRows = [];
  function clipItems(c, startF, endF, srcInSec, track, opts = {}) {
    // a clip whose media was removed from the project: left out (a gap there), said in the README
    if (!media[c.mediaId]) { notes.add('Some clips point to media that was removed from the project - they are left out (gaps in the XML).'); return { v: '', a: '' }; }
    let m = media[c.mediaId], fileKey = c.mediaId, label = m.name;
    const g = graded[c.id];
    if (g) {
      m = { ...m, path: g.file, name: path.basename(g.file), duration: g.duration }; fileKey = `g:${c.id}`; srcInSec -= g.start; label = m.name;
      const rel = path.relative(outDir, g.file); if (!files.includes(rel)) files.push(rel);
    }
    else if (color === 'lut' && track === 'video' && c.color && !isNeutral(c.color)) {
      // one LUT per graded clip, named on the clip so it is easy to apply
      const dir = path.join(outDir, `${base} LUTs`), n = String(lutRows.length + 1).padStart(2, '0');
      const lname = `${n}_${path.parse(m.name).name.replace(/[^A-Za-z0-9.-]+/g, '_').slice(0, 40)}.cube`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, lname), bakeCube(c.color, c.color.lut ? luts[c.color.lut] : null, `${n} ${m.name}`));
      files.push(path.relative(outDir, path.join(dir, lname)));
      lutRows.push(`  ${n}  ${m.name} @ ${srcInSec.toFixed(2)}s  ->  ${lname}`);
      label = `${m.name} [LUT ${n}]`;
    }
    const speed = (c.speed || 1) * (rampPts(c) ? rampAvg(rampPts(c)) : 1), id = ++clipN; // a ramp = its average speed
    const inF = fr(srcInSec), outF = inF + Math.round((endF - startF) * speed);
    const isImg = m.kind === 'image';
    const head = (kind) => `<clipitem id="clipitem-${id}${kind}"><name>${X(label)}</name><enabled>${B(opts.enabled ?? true)}</enabled><duration>${isImg ? endF - startF : Math.max(outF, fr(m.duration || 0))}</duration>${rateXml(seq)}` +
      `<start>${startF}</start><end>${endF}</end><in>${isImg ? 0 : inF}</in><out>${isImg ? endF - startF : outF}</out>`;
    const file = fileXml(fileKey, { ...m, name: m.name, file: m.path });
    let v = '';
    if (track === 'video') {
      // position: x/y are % of the frame (+ = right/down); xmeml's Center runs -1..1 from edge to edge (half a frame per
      // unit), so Premiere's Position = W/2 + horiz*W/2
      const t = c.transform || {}, cx = +t.x || 0, cy = +t.y || 0, rot = +t.rotation || 0;
      const moveP = (cx || cy ? `<parameter><parameterid>center</parameterid><name>Center</name><value><horiz>${+(cx / 50).toFixed(5)}</horiz><vert>${+(cy / 50).toFixed(5)}</vert></value></parameter>` : '') +
        (rot ? param('rotation', 'Rotation', +rot.toFixed(3), -8640, 8640) : '');
      const filters = cropFilter(m, c) + motion('Basic Motion', 'basic', param('scale', 'Scale', opts.scale ?? fitScale(m, c), 0, 1000) + moveP) +
        (opts.opacity !== undefined && opts.opacity < 1 ? motion('Opacity', 'opacity', param('opacity', 'Opacity', Math.round(opts.opacity * 100), 0, 100)) : '') +
        (speed !== 1 ? timeRemap(speed) : '');
      v = `${head('')}${isImg ? '<stillframe>TRUE</stillframe>' : ''}${file}${filters}<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack></clipitem>`;
    }
    let a = '';
    if (m.hasAudio && (track === 'audio' || opts.withAudio)) {
      a = `${head(track === 'video' ? '-a' : '')}${file}${audioLevel(opts.volume ?? 1)}<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack></clipitem>`;
      if (speed !== 1) notes.add('Audio on speed-changed clips may need its speed set again in the editor.');
    }
    return { v, a };
  }

  const titleDir = path.join(outDir, `${base} titles`);
  let titleN = 0;
  function titleClip(c, startF, endF, card) {
    fs.mkdirSync(titleDir, { recursive: true });
    const name = `title_${String(++titleN).padStart(2, '0')}.png`, file = path.join(titleDir, name);
    if (!titlePng(file, c, W, H, card)) { notes.add('Some titles could not be drawn as images - they are listed as markers.'); return ''; }
    files.push(path.relative(outDir, file));
    const key = `title:${name}`, id = ++clipN;
    return `<clipitem id="clipitem-${id}"><name>${X((c.text || 'Title').split('\n')[0].slice(0, 40))}</name><enabled>TRUE</enabled><duration>${endF - startF}</duration>${rateXml(seq)}` +
      `<start>${startF}</start><end>${endF}</end><in>0</in><out>${endF - startF}</out><stillframe>TRUE</stillframe>` +
      `${fileXml(key, { name, file, kind: 'image', width: W, height: H })}${motion('Basic Motion', 'basic', param('scale', 'Scale', 100, 0, 1000))}` +
      `<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack></clipitem>`;
  }

  // ---- V1: magnetic main story, overlaps become centred cross dissolves at the middle of the overlap ----
  const v1 = P.V1, v1Video = [], v1Audio = [];
  const cuts = v1.map((x, i) => (i === 0 ? fr(x.start) : fr(x.start + x.overlap / 2)));
  v1.forEach((x, i) => {
    const c = x.clip;
    const startF = cuts[i], endF = i + 1 < v1.length ? cuts[i + 1] : fr(x.end);
    if (i > 0 && x.overlap > 0) {
      const h = Math.max(1, Math.round(fr(x.overlap) / 2));
      v1Video.push(transition(seq, startF - h, startF + h, true));
      if (c.type === 'video' && v1[i - 1].clip.type === 'video' && media[c.mediaId]?.hasAudio && media[v1[i - 1].clip.mediaId]?.hasAudio) v1Audio.push(transition(seq, startF - h, startF + h, false));
      if (c.transitionIn?.type && !['fade', 'dissolve'].includes(c.transitionIn.type)) notes.add('Wipes, slides, zooms and dips are exported as cross dissolves - swap the transition in the editor if needed.');
    }
    if (c.type === 'title') {
      v1Video.push(titleClip(c, startF, endF, true));
      markers.push({ at: startF, name: `Title: ${c.text || ''}` });
      return;
    }
    noteLosses(c);
    const srcIn = (+c.in || 0) + (secOf(startF) - x.start) * (c.speed || 1); // the cut moved into the overlap
    const { v, a } = clipItems(c, startF, endF, Math.max(0, srcIn), 'video', { withAudio: c.type === 'video' && !c.mute, volume: (c.volume ?? 1) * (ts.V1?.volume ?? 1), enabled: true });
    v1Video.push(v);
    if (a) v1Audio.push(ts.V1?.mute ? a.replace('<enabled>TRUE</enabled>', '<enabled>FALSE</enabled>') : a);
    if (c.text) markers.push({ at: startF, name: c.text });
  });

  // ---- V2, V3…: overlays (free position) + titles as transparent PNGs, each track above the one before ----
  const v2Tracks = [], v2AudioTracks = [];
  for (const tid of overlayTracks(project)) {
  if (ts[tid]?.hide) continue;
  const lanes = [[]], alanes = [[]];
  for (const x of [...(P[tid] || [])].sort((a, b) => a.start - b.start)) {
    const c = x.clip, startF = fr(x.start), endF = fr(x.end);
    if (c.type === 'adjust') { notes.add('Adjustment layers are not in the XML - add an Adjustment Layer in Premiere / Resolve with the same colour and effects.'); continue; }
    if (c.blend) notes.add('Blend modes (screen, multiply…) are not in the XML - set them again on those clips (Opacity > Blend Mode / Composite Mode).');
    // overlapping overlays of one track go on extra tracks so nothing is hidden
    let t = lanes.findIndex((tr) => !tr.length || tr[tr.length - 1].endF <= startF);
    if (t < 0) { t = lanes.length; lanes.push([]); alanes.push([]); }
    if (c.type === 'title') {
      lanes[t].push({ endF, xml: titleClip(c, startF, endF, false) });
      markers.push({ at: startF, name: `Title: ${c.text || ''}` });
      continue;
    }
    // motion graphics have no file of their own (the editor draws them) - a note instead of a clip
    if (!media[c.mediaId]) { notes.add(c.type === 'graphic' ? 'Motion graphics (lower thirds, kinetic text, logo reveals) are not in the XML - render that track alone from the editor and lay the video over.' : `Some ${c.type || ''} clips without a file are not in the XML.`); continue; }
    noteLosses(c);
    const { v, a } = clipItems(c, startF, endF, +c.in || 0, 'video', { opacity: c.opacity ?? 1, withAudio: c.type === 'video' && (c.volume ?? 0) > 0, volume: (c.volume ?? 0) * (ts[tid]?.volume ?? 1) });
    lanes[t].push({ endF, xml: v });
    if (a) alanes[t].push({ xml: a });
  }
  v2Tracks.push(...lanes); v2AudioTracks.push(...alanes);
  }

  // ---- logo: still on its own top track for the whole film ----
  let logoTrack = '';
  if (project.logo?.mediaId && media[project.logo.mediaId]) {
    const m = media[project.logo.mediaId], L = project.logo;
    const sc = m.width ? +(((W * (L.scale ?? 0.12)) / m.width) * 100).toFixed(3) : 20;
    const { v } = clipItems({ mediaId: L.mediaId, type: 'image' }, 0, fr(D), 0, 'video', { scale: sc, opacity: L.opacity ?? 0.9 });
    logoTrack = v;
    notes.add(`The logo is on the top video track at the right size - drag it to the ${{ tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' }[L.pos || 'tr']} corner.`);
  }

  // ---- audio tracks A1 voice-over, A2 music, A3 SFX (music loops are laid out as repeated clips) ----
  function audioTrack(id) {
    const out = [];
    for (const x of P[id]) {
      const c = x.clip, m = media[c.mediaId];
      if (!m?.hasAudio) continue;
      noteLosses(c);
      const vol = (c.volume ?? 1) * (ts[id]?.volume ?? 1), enabled = !ts[id]?.mute;
      if (c.loop) {
        const tin = +c.in || 0, seg = Math.max(0.5, (c.out ?? m.duration) - tin);
        for (let s = x.start; s < x.end - 0.04; s += seg)
          out.push(clipItems(c, fr(s), fr(Math.min(x.end, s + seg)), tin, 'audio', { volume: vol, enabled }).a);
      } else out.push(clipItems(c, fr(x.start), fr(x.end), +c.in || 0, 'audio', { volume: vol, enabled }).a);
    }
    if (id === 'A2' && project.tracks.A2.some((c) => c.duck)) notes.add('Music ducking under speech is not in the XML - use Essential Sound > Ducking (Premiere) or Fairlight sidechain (Resolve).');
    return out.filter(Boolean);
  }
  // the film look over the whole edit: baked into the clips with color 'bake', otherwise a note
  if (S.look?.lut && !(color === 'bake' && Object.keys(graded).length))
    notes.add(`The film look "${S.look.lut}" (${Math.round((S.look.mix ?? 1) * 100)}%) is not in the XML - put an Adjustment Layer over the edit with that LUT (Lumetri > Creative > Look), or export with Colour "Colour + film LUT + flash effects baked into new clips".`);
  const anyFx = Object.values(ts).some((t) => t?.fx && Object.values(t.fx).some((f) => f?.on || f?.enabled));
  if (anyFx) notes.add('Track EQ / compressor / noise reduction need to be set again.');

  for (const mk of project.markers || []) markers.push({ at: fr(mk.t), name: mk.label || mk.name || 'Marker' });

  // ---- assemble ----
  const track = (items) => `<track><enabled>TRUE</enabled><locked>FALSE</locked>${items.join('')}</track>`;
  const vTracks = [track(v1Video), ...v2Tracks.filter((t) => t.length).map((t) => track(t.map((i) => i.xml))), ...(logoTrack ? [track([logoTrack])] : [])];
  const aTracks = [v1Audio.length ? track(v1Audio) : null, ...v2AudioTracks.filter((t) => t.length).map((t) => track(t.map((i) => i.xml))),
    ...audioTracks(project).map((id) => { const t = audioTrack(id); return t.length ? track(t) : null; })].filter(Boolean);
  if (!aTracks.length) aTracks.push(track([]));
  const fmt = `<format><samplecharacteristics>${rateXml(seq)}<width>${W}</width><height>${H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`;
  const mk = markers.sort((a, b) => a.at - b.at).map((m) => `<marker><name>${X(m.name.slice(0, 120))}</name><comment>${X(m.name)}</comment><in>${m.at}</in><out>-1</out></marker>`).join('');
  let n = 0;
  const seen = new Set();
  const ids = new Map([...fileDefs.keys()].map((k) => [k, `file-${++n}`]));
  const xml = (`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence id="sequence-1"><name>${X(base)}</name><duration>${fr(D)}</duration>${rateXml(seq)}` +
    `<timecode>${rateXml(seq)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>` +
    `<media><video>${fmt}${vTracks.join('')}</video><audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${aTracks.join('')}</audio></media>${mk}</sequence></xmeml>\n`)
    .replace(/@@FILE\[(.+?)\]@@/g, (_, k) => (seen.has(k) ? `<file id="${ids.get(k)}"/>` : (seen.add(k), `<file id="${ids.get(k)}">${fileDefs.get(k)}</file>`)));

  fs.mkdirSync(outDir, { recursive: true });
  const xmlName = `${base}.xml`;
  fs.writeFileSync(path.join(outDir, xmlName), xml, 'utf8');
  files.unshift(xmlName);
  if (subtitlesPath && fs.existsSync(subtitlesPath)) {
    const sub = `${base}${path.extname(subtitlesPath)}`;
    fs.copyFileSync(subtitlesPath, path.join(outDir, sub)); files.push(sub);
    notes.add(`Subtitles are in ${sub} - import it as captions (Premiere: File > Import; Resolve: drag onto the timeline).`);
  }
  // (one line for the grades, whichever clips have a LUT - it used to come twice, with and without the LUT's name)
  const notesList = [...notes].map((n) => (n.startsWith('Colour grades/LUTs') ? `${n}${lutsUsed.size ? ` (LUT${lutsUsed.size > 1 ? 's' : ''} used: ${[...lutsUsed].join(', ')}; in the LUTs folder)` : ''}.` : n));
  const readme = [
    `${base} - timeline for Premiere Pro / DaVinci Resolve`,
    '',
    'Premiere Pro:  File > Import > choose the .xml  (a new sequence with all clips appears in the Project panel)',
    'DaVinci Resolve:  File > Import > Timeline > choose the .xml  (tick "Automatically import source clips into media pool")',
    '',
    ...(collect === 'none' ? [
      'The XML points to the original camera files on this computer. On another computer, copy the footage too and use',
      'Link Media / Relink when the editor asks for missing files.',
    ] : [
      `All the footage, photos and sound this edit uses are in the "Media" folder next to this XML${collect === 'trim' ? ' (videos: only the used parts, with 1 s extra on each side)' : ''}.`,
      'Send / copy this WHOLE folder (XML + Media + titles together).',
      'On another computer the clips may show as offline at first - link them once:',
      '  Premiere Pro: select all clips in the Project panel > right-click > Link Media > Locate > pick the first missing file',
      '                inside the Media folder - the rest are found automatically.',
      '  DaVinci Resolve: Media Pool > select all > right-click > Relink Selected Clips > choose the Media folder.',
    ]),
    '',
    ...(notesList.length ? ['Redo these by hand:', ...notesList.map((n) => `  - ${n}`)] : ['Everything in this edit carries over.']),
    ...(lutRows.length ? ['', 'Colour: one LUT per graded clip (on the timeline those clips end in [LUT nn]):', '  Premiere: select the clip > Lumetri Color > Basic Correction > Input LUT > Browse > pick its .cube', '  Resolve: File > Import > LUTs (or copy the folder into Resolve LUTs), then Color page > right-click the clip > LUTs', ...lutRows] : []),
    ...(color === 'bake' && Object.keys(graded).length ? ['', 'Colour is already inside the graded clips - no grading needed.'] : []),
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(outDir, `${base} - README.txt`), readme, 'utf8');
  files.push(`${base} - README.txt`);
  return { xml: xmlName, files, notes: notesList, clips: clipN };
}
