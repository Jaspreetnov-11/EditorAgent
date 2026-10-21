#!/usr/bin/env node
// vedit.mjs - FFmpeg wrapper for the video-editor skill.
// Usage:
//   node vedit.mjs check
//   node vedit.mjs probe <file>
//   node vedit.mjs frames <file> [--every 5] [--cols 4] [--out sheet.jpg]
//   node vedit.mjs scenes <file> [--threshold 0.3]
//   node vedit.mjs silences <file> [--db -35] [--min 0.6]
//   node vedit.mjs audio <file> [--out audio.wav]        (16 kHz mono WAV for transcription)
//   node vedit.mjs render <edit.json> [--keep]           (render an edit decision list, see references/edl.md)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ASPECTS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] };
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);
const FONTS = {
  latin: ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  deva: ['C:/Windows/Fonts/NirmalaB.ttf', 'C:/Windows/Fonts/Nirmala.ttf', 'C:/Windows/Fonts/Nirmala.ttc',
    '/System/Library/Fonts/Kohinoor.ttc', '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf'],
};
const DEVA = /[\u0900-\u097F]/;

function die(msg) { console.error(`vedit: ${msg}`); process.exit(1); }

function args(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else pos.push(argv[i]);
  }
  return { pos, opt };
}

function ff(argv, { cwd, capture = false } = {}) {
  const quiet = capture ? [] : ['-loglevel', 'error', '-stats'];
  const r = spawnSync('ffmpeg', ['-hide_banner', '-y', ...quiet, ...argv], {
    cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: capture ? 'pipe' : ['ignore', 'inherit', 'inherit'],
  });
  if (r.error) die(`ffmpeg not runnable (${r.error.code}). Run "node vedit.mjs check".`);
  if (r.status !== 0) die(`ffmpeg failed (exit ${r.status})${capture ? '\n' + r.stderr.slice(-3000) : ''}`);
  return r;
}

function probe(file) {
  if (!fs.existsSync(file)) die(`file not found: ${file}`);
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  if (r.error) die('ffprobe not found. Run "node vedit.mjs check".');
  if (r.status !== 0) die(`ffprobe failed on ${file}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const duration = (file) => parseFloat(probe(file).format.duration);
const hasAudio = (file) => probe(file).streams.some((s) => s.codec_type === 'audio');

// "75", "1:15", "00:01:15.5" -> seconds
function secs(t) {
  if (t === undefined || t === null || t === '') return undefined;
  if (typeof t === 'number') return t;
  return String(t).split(':').reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}
const fmt = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(2).padStart(5, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${x}`;
};

// Fonts and text files are copied into the work dir and referenced by bare names, because
// Windows drive letters ("C:") break FFmpeg filtergraph parsing.
let fontN = 0, textN = 0;
function font(wd, text) {
  const list = DEVA.test(text || '') ? FONTS.deva : FONTS.latin;
  const src = list.find((f) => fs.existsSync(f));
  if (!src) die(`no usable font found (tried ${list.join(', ')})`);
  const name = `font${fontN++}${path.extname(src)}`;
  fs.copyFileSync(src, path.join(wd, name));
  return name;
}
function textfile(wd, text) {
  const name = `text${textN++}.txt`;
  fs.writeFileSync(path.join(wd, name), text, 'utf8');
  return name;
}

function fit(inp, out, mode, W, H, c = {}) {
  const cx = c.cropX ?? 0.5, cy = c.cropY ?? 0.5;
  if (mode === 'fill')
    return `[${inp}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-${W})*${cx}:(ih-${H})*${cy},setsar=1[${out}]`;
  if (mode === 'blur')
    return `[${inp}]split[${out}b][${out}f];[${out}b]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:3,eq=brightness=-0.08[${out}bb];` +
      `[${out}f]scale=${W}:${H}:force_original_aspect_ratio=decrease[${out}ff];[${out}bb][${out}ff]overlay=(W-w)/2:(H-h)/2,setsar=1[${out}]`;
  return `[${inp}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[${out}]`;
}

function atempo(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  parts.push(+s.toFixed(4));
  return parts.map((p) => `atempo=${p}`).join(',');
}

// Lower-third / caption text on a clip. style: "lower" (left, bottom), "center", "top".
function drawtext(wd, text, W, H, { style = 'lower', until, size } = {}) {
  // Auto size: scale to the frame, then shrink so the longest line fits ~88% of the width
  // (drawtext does not wrap; ~0.58 em per character is a safe average for Arial/Nirmala bold).
  const longest = Math.max(...text.split('\n').map((l) => [...l].length), 1);
  const auto = Math.min(style === 'center' ? Math.min(H * 0.06, W * 0.075) : Math.min(H * 0.04, W * 0.045), (W * 0.88) / (longest * 0.58));
  const fs_ = size || Math.max(18, Math.round(auto));
  const x = style === 'lower' ? `${Math.round(W * 0.06)}` : '(w-text_w)/2';
  const y = style === 'center' ? '(h-text_h)/2' : style === 'top' ? `${Math.round(H * 0.08)}` : `h-text_h-${Math.round(H * 0.12)}`;
  const box = style === 'center' ? `:shadowcolor=black@0.7:shadowx=${Math.ceil(fs_ / 20)}:shadowy=${Math.ceil(fs_ / 20)}` : `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(fs_ * 0.45)}`;
  const en = until ? `:enable='lt(t,${until})'` : '';
  return `drawtext=fontfile=${font(wd, text)}:textfile=${textfile(wd, text)}:expansion=none:fontsize=${fs_}:fontcolor=white:line_spacing=${Math.round(fs_ * 0.3)}${box}:x=${x}:y=${y}${en}`;
}

const ENC = (F, crf = 18, preset = 'veryfast') =>
  ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(F),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
const AFMT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

function renderSegment(c, i, cfg, wd) {
  const { W, H, F, fitMode } = cfg;
  const mode = c.fit || fitMode;
  const type = c.type || (c.src ? (IMAGE_EXT.has(path.extname(c.src).toLowerCase()) ? 'image' : 'video') : 'card');
  const inputs = [], g = [];
  let dur, aSrc;

  if (type === 'video') {
    const full = duration(c.src);
    const tin = secs(c.in) ?? 0, tout = Math.min(secs(c.out) ?? full, full);
    if (tout <= tin) die(`clip ${i}: out (${tout}) must be after in (${tin})`);
    const speed = c.speed || 1;
    dur = (tout - tin) / speed;
    inputs.push('-ss', String(tin), '-t', String(tout - tin), '-i', c.src);
    g.push(`[0:v]setpts=(PTS-STARTPTS)/${speed},fps=${F}[v0]`);
    if (hasAudio(c.src) && !c.mute) aSrc = `[0:a]asetpts=PTS-STARTPTS,${atempo(speed)},volume=${c.volume ?? 1},${AFMT}[a]`;
  } else if (type === 'image') {
    dur = secs(c.duration) || 4; // 0 or blank -> default, matching the app's timeline
    inputs.push('-loop', '1', '-framerate', String(F), '-t', String(dur), '-i', c.src);
    const kb = c.kenburns ?? cfg.kenburns;
    if (kb) {
      const N = Math.round(dur * F), z = kb === 'out' ? `1.15-0.15*on/${N}` : `1+0.15*on/${N}`;
      g.push(`[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},` +
        `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${F},setsar=1[v0]`);
    } else g.push(`[0:v]fps=${F}[v0]`);
  } else if (type === 'card') {
    dur = secs(c.duration) || 3;
    inputs.push('-f', 'lavfi', '-i', `color=c=${c.bg || 'black'}:s=${W}x${H}:r=${F}:d=${dur}`);
    g.push(`[0:v]null[v0]`);
  } else die(`clip ${i}: unknown type "${type}"`);

  let cur = 'v0';
  const preFitted = type === 'card' || (type === 'image' && (c.kenburns ?? cfg.kenburns));
  if (!preFitted) { g.push(fit(cur, 'v1', mode, W, H, c)); cur = 'v1'; }
  const vf = [];
  if (c.color) vf.push(`eq=brightness=${+c.color.brightness || 0}:contrast=${c.color.contrast ?? 1}:saturation=${c.color.saturation ?? 1}`);
  if (type === 'card' && c.text) vf.push(drawtext(wd, c.text, W, H, { style: 'center', size: c.size }));
  else if (c.text) vf.push(drawtext(wd, c.text, W, H, { style: c.textStyle || 'lower', until: c.textDuration, size: c.size }));
  if (c.fadeIn) vf.push(`fade=t=in:st=0:d=${c.fadeIn}`);
  if (c.fadeOut) vf.push(`fade=t=out:st=${Math.max(0, dur - c.fadeOut)}:d=${c.fadeOut}`);
  vf.push('format=yuv420p');
  g.push(`[${cur}]${vf.join(',')}[v]`);

  if (!aSrc) {
    inputs.push('-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=48000:cl=stereo');
    aSrc = `[1:a]${AFMT}[a]`;
  }
  g.push(aSrc);

  const out = path.join(wd, `seg${String(i).padStart(3, '0')}.mp4`);
  console.log(`  [${i + 1}/${cfg.count}] ${type} ${c.src ? path.basename(c.src) : JSON.stringify(c.text || '')} -> ${dur.toFixed(2)}s`);
  ff([...inputs, '-filter_complex', g.join(';'), '-map', '[v]', '-map', '[a]', '-t', String(dur), ...ENC(F), out], { cwd: wd });
  return out;
}

function join(segs, cfg, wd) {
  const out = path.join(wd, 'joined.mp4');
  const tr = cfg.transition;
  if (segs.length === 1) return segs[0];
  if (!tr || tr.type === 'cut' || tr.type === 'none') {
    const list = path.join(wd, 'list.txt');
    fs.writeFileSync(list, segs.map((s) => `file '${s.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
    return out;
  }
  const T = tr.duration ?? 0.5;
  const durs = segs.map(duration);
  if (durs.some((d) => d <= T)) die(`transition (${T}s) is longer than a clip; shorten it or the clip`);
  const g = [];
  let off = 0, v = '0:v', a = '0:a';
  for (let i = 1; i < segs.length; i++) {
    off += durs[i - 1] - T;
    g.push(`[${v}][${i}:v]xfade=transition=${tr.type}:duration=${T}:offset=${off.toFixed(3)}[xv${i}]`);
    g.push(`[${a}][${i}:a]acrossfade=d=${T}[xa${i}]`);
    v = `xv${i}`; a = `xa${i}`;
  }
  ff([...segs.flatMap((s) => ['-i', s]), '-filter_complex', g.join(';'), '-map', `[${v}]`, '-map', `[${a}]`, ...ENC(cfg.F), out]);
  return out;
}

function finish(base, cfg, wd, outFile) {
  const { W, H, F } = cfg;
  const D = duration(base);
  const inputs = ['-i', base], g = [];
  let n = 1, v = '0:v', a = '0:a';

  if (cfg.logo) {
    const L = cfg.logo, i = n++;
    inputs.push('-i', L.src);
    const m = Math.round(W * 0.04);
    const pos = { tl: `${m}:${m}`, tr: `W-w-${m}:${m}`, bl: `${m}:H-h-${m}`, br: `W-w-${m}:H-h-${m}` }[L.pos || 'tr'];
    g.push(`[${i}:v]scale=${Math.round(W * (L.scale ?? 0.12))}:-1,format=rgba,colorchannelmixer=aa=${L.opacity ?? 0.9}[lg]`);
    g.push(`[${v}][lg]overlay=${pos}[vl]`);
    v = 'vl';
  }
  if (cfg.subtitles) {
    const ext = path.extname(cfg.subtitles).toLowerCase();
    const name = `subs${ext}`;
    const body = fs.readFileSync(cfg.subtitles, 'utf8');
    fs.writeFileSync(path.join(wd, name), body, 'utf8');
    fs.mkdirSync(path.join(wd, 'fonts'), { recursive: true });
    for (const f of [...FONTS.latin, ...FONTS.deva]) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(wd, 'fonts', path.basename(f)));
    let style = '';
    if (ext === '.srt') {
      const vertical = H > W;
      const S = { FontName: DEVA.test(body) ? 'Nirmala UI' : 'Arial', FontSize: vertical ? 11 : 18, Bold: 1,
        PrimaryColour: '&H00FFFFFF', OutlineColour: '&H00000000', BorderStyle: 1, Outline: 2, Shadow: 0,
        MarginV: vertical ? 70 : 28, ...(cfg.subtitleStyle || {}) };
      style = `:force_style='${Object.entries(S).map(([k, x]) => `${k}=${x}`).join(',')}'`;
    }
    g.push(`[${v}]subtitles=${name}:fontsdir=fonts${style}[vs]`);
    v = 'vs';
  }
  g.push(`[${v}]format=yuv420p[vout]`);

  // Audio: original + voice-over = speech bus; music is ducked under speech.
  const am = cfg.audio || {};
  g.push(`[${a}]volume=${am.originalVolume ?? 1},${AFMT}[orig]`);
  let speech = 'orig';
  if (cfg.vo) {
    const i = n++, ms = Math.round((secs(cfg.vo.start) ?? 0) * 1000);
    inputs.push('-i', cfg.vo.src);
    g.push(`[${i}:a]${AFMT},adelay=${ms}|${ms},volume=${cfg.vo.volume ?? 1}[vo]`);
    g.push(`[orig][vo]amix=inputs=2:normalize=0:duration=first[sp]`);
    speech = 'sp';
  }
  let mix = speech;
  if (cfg.music) {
    const M = cfg.music, i = n++;
    const fo = Math.min(2, D / 4);
    const mIn = secs(M.in) ?? 0, mOut = secs(M.out);
    let src;
    if (mIn > 0 || mOut !== undefined) {
      // Use only the chosen part of the song, looping that part if the video is longer.
      const seg = Math.max(0.5, (mOut ?? duration(M.src)) - mIn);
      inputs.push('-i', M.src);
      src = `[${i}:a]${AFMT},atrim=start=${mIn}:end=${mIn + seg},asetpts=PTS-STARTPTS,aloop=loop=-1:size=${Math.ceil(seg * 48000)},atrim=0:${D},asetpts=PTS-STARTPTS`;
    } else {
      inputs.push('-stream_loop', '-1', '-i', M.src);
      src = `[${i}:a]atrim=0:${D},asetpts=PTS-STARTPTS,${AFMT}`;
    }
    // Starting mid-song on a strong section: a short fade keeps the hit instead of swelling in.
    g.push(`${src},volume=${M.volume ?? 0.2},afade=t=in:d=${mIn > 0 ? 0.15 : 1},afade=t=out:st=${(D - fo).toFixed(2)}:d=${fo}[mus]`);
    if (M.duck !== false) {
      g.push(`[${speech}]asplit=2[sp1][sp2]`);
      g.push(`[mus][sp2]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=400[md]`);
      g.push(`[sp1][md]amix=inputs=2:normalize=0:duration=first[mx]`);
    } else g.push(`[${speech}][mus]amix=inputs=2:normalize=0:duration=first[mx]`);
    mix = 'mx';
  }
  const lufs = am.loudness ?? -14;
  g.push(lufs === false ? `[${mix}]anull[aout]` : `[${mix}]loudnorm=I=${lufs}:TP=-1.5:LRA=11,${AFMT}[aout]`);

  console.log('  finishing (graphics, subtitles, audio mix, loudness)...');
  ff([...inputs, '-filter_complex', g.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', String(D),
    ...ENC(F, cfg.crf ?? 20, cfg.preset ?? 'medium'), '-movflags', '+faststart', path.resolve(outFile)], { cwd: wd });
}

function render(edlPath, opt) {
  const dir = path.dirname(path.resolve(edlPath));
  const edl = JSON.parse(fs.readFileSync(edlPath, 'utf8').replace(/^﻿/, ''));
  const R = (p) => (p ? path.resolve(dir, p) : p);
  const [W, H] = edl.size || ASPECTS[edl.aspect || '16:9'] || die(`unknown aspect ${edl.aspect}`);
  if (!edl.clips?.length) die('EDL has no clips');
  const cfg = {
    ...edl, W, H, F: edl.fps || 30, fitMode: edl.fit || (H > W ? 'blur' : 'fit'), count: edl.clips.length,
    subtitles: R(edl.subtitles),
    logo: edl.logo && { ...edl.logo, src: R(edl.logo.src) },
    music: edl.music && { ...edl.music, src: R(edl.music.src) },
    vo: edl.vo && { ...edl.vo, src: R(edl.vo.src) },
  };
  for (const f of [cfg.subtitles, cfg.logo?.src, cfg.music?.src, cfg.vo?.src]) if (f && !fs.existsSync(f)) die(`missing file: ${f}`);
  const clips = edl.clips.map((c) => ({ ...c, src: R(c.src) }));
  for (const c of clips) if (c.src && !fs.existsSync(c.src)) die(`missing clip: ${c.src}`);

  const out = R(edl.output || 'output.mp4');
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-'));
  console.log(`Rendering ${clips.length} clip(s) at ${W}x${H}@${cfg.F} -> ${out}`);
  const segs = clips.map((c, i) => renderSegment(c, i, cfg, wd));
  const joined = join(segs, cfg, wd);
  finish(joined, cfg, wd, out);
  if (!opt.keep) fs.rmSync(wd, { recursive: true, force: true });
  else console.log(`  work dir kept: ${wd}`);
  summarize(out);
}

function summarize(file) {
  const p = probe(file), v = p.streams.find((s) => s.codec_type === 'video'), a = p.streams.find((s) => s.codec_type === 'audio');
  const rot = v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate;
  console.log(JSON.stringify({
    file, duration: +(+p.format.duration).toFixed(2), durationHms: fmt(+p.format.duration),
    sizeMB: +(p.format.size / 1048576).toFixed(1),
    video: v && { codec: v.codec_name, width: v.width, height: v.height, fps: v.r_frame_rate, rotation: rot ?? 0 },
    audio: a ? { codec: a.codec_name, channels: a.channels, rate: a.sample_rate } : null,
  }, null, 2));
}

function check() {
  let ok = true;
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
    if (r.error) { ok = false; console.log(`MISSING  ${bin}`); continue; }
    console.log(`OK       ${r.stdout.split('\n')[0]}`);
    if (bin === 'ffmpeg') for (const lib of ['libx264', 'libass', 'libfreetype', 'libharfbuzz'])
      console.log(`${r.stdout.includes(`--enable-${lib}`) ? 'OK      ' : 'MISSING '} ${lib}`);
  }
  for (const [k, list] of Object.entries(FONTS)) {
    const f = list.find((x) => fs.existsSync(x));
    console.log(`${f ? 'OK      ' : 'MISSING '} font(${k}) ${f || ''}`);
  }
  const py = ['python', 'python3', 'py'].map((b) => spawnSync(b, ['-c', 'import faster_whisper;print("ok")'], { encoding: 'utf8' }))
    .find((r) => !r.error && r.stdout.includes('ok'));
  console.log(`${py ? 'OK      ' : 'MISSING '} python + faster-whisper (only needed for auto subtitles)`);
  if (!ok) console.log('\nInstall FFmpeg (Windows): winget install --id Gyan.FFmpeg -e   then open a new terminal.');
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = args(rest);
switch (cmd) {
  case 'check': check(); break;
  case 'probe': summarize(pos[0] || die('probe <file>')); break;
  case 'render': render(pos[0] || die('render <edit.json>'), opt); break;
  case 'audio': {
    const f = pos[0] || die('audio <file>');
    const out = opt.out || f.replace(/\.[^.]+$/, '') + '.16k.wav';
    ff(['-i', f, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
    console.log(out); break;
  }
  case 'frames': {
    const f = pos[0] || die('frames <file>');
    const D = duration(f), every = +(opt.every || Math.max(1, Math.ceil(D / 24))), cols = +(opt.cols || 4);
    const rows = Math.ceil(Math.ceil(D / every) / cols);
    const out = path.resolve(opt.out || f.replace(/\.[^.]+$/, '') + '.sheet.jpg');
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-'));
    const fnt = font(wd, '');
    ff(['-i', path.resolve(f), '-vf', `fps=1/${every},scale=480:-2,setsar=1,drawtext=fontfile=${fnt}:text='%{pts\\:hms}':x=8:y=8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=${cols}x${rows}:padding=4`,
      '-frames:v', '1', '-update', '1', '-q:v', '3', out], { cwd: wd });
    fs.rmSync(wd, { recursive: true, force: true });
    console.log(`${out}  (one frame every ${every}s, ${cols} columns)`); break;
  }
  case 'scenes': {
    const f = pos[0] || die('scenes <file>');
    const r = ff(['-i', f, '-an', '-vf', `select='gt(scene,${opt.threshold || 0.3})',showinfo`, '-f', 'null', '-'], { capture: true });
    const cuts = [...r.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => +m[1]);
    console.log(JSON.stringify(cuts.map((t) => ({ t: +t.toFixed(2), hms: fmt(t) })), null, 1)); break;
  }
  case 'silences': {
    const f = pos[0] || die('silences <file>');
    const r = ff(['-i', f, '-vn', '-af', `silencedetect=noise=${opt.db || -35}dB:d=${opt.min || 0.6}`, '-f', 'null', '-'], { capture: true });
    const s = [...r.stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
    const e = [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
    console.log(JSON.stringify(s.map((x, i) => ({ start: +x.toFixed(2), end: e[i] !== undefined ? +e[i].toFixed(2) : null })), null, 1)); break;
  }
  default:
    console.log('commands: check | probe <f> | frames <f> | scenes <f> | silences <f> | audio <f> | render <edit.json>');
}
