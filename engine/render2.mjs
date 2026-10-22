#!/usr/bin/env node
// render2.mjs - renders a multi-track (version 2) project with FFmpeg.
// Usage: node render2.mjs <job.json>
// job: { project, media: { id: { path, duration, hasAudio, kind } }, output, preview: bool, luts: { name: path },
//        export?: { aspect, fit, short, fps, crf, maxrate, abr, sizeMB, loudness, codec } }  (a delivery preset, see public/js/presets.js)
//
// Pipeline: every V1/V2 clip -> normalised segment (size, fps, 48k stereo, colour, text) ->
// V1 joined with cuts/transitions -> final pass: V2 overlays, titles, logo, subtitles, audio tracks mix, loudness.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { ASPECTS, clipDur, placed, totalDuration, keysExpr, rampPts, sourceAt, overlayTracks, audioTracks, syncLinked } from '../public/js/model.js';
import { fxFilters } from '../public/js/audiofx.js';
import { colorFilters, stager } from './color.mjs';
import { cutFxDur, wordWindows, isKinetic } from '../public/js/fx.js';
import { VFX, activeEffects } from '../public/js/effects.js';
import { buildAss } from '../public/js/captions.js';
import { maskTrack } from '../public/js/tracking.js';
import { gfxKey } from '../public/js/graphics.js';
import { maskAlpha, movedMask, maskKey } from '../public/js/shapemask.js';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
const { project, media } = job;
const S = project.settings;
const EX = job.export || {};
// A preset can reframe the edit (e.g. a 16:9 film delivered as a 9:16 reel), cap the resolution and cap the frame rate.
const [FW, FH] = ASPECTS[EX.aspect || S.aspect] || ASPECTS['16:9'];
const reframed = !!EX.aspect && EX.aspect !== S.aspect;
// EX.res = an exact output size chosen on Deliver (4K renders at 2160 even from a 1080 edit); EX.short = a preset's ceiling
// (the Accurate preview is 1080p - it used to be 37.5% size from the small proxies, too soft to judge the picture)
// ⚡ Fast preview (chosen on the monitor): 720p from the small proxy copies, quick to encode - for checking timing, not the picture
const FAST = !!(job.preview && job.fastPreview);
const scale = job.preview ? Math.min(1, (FAST ? 720 : 1080) / Math.min(FW, FH)) : EX.res ? EX.res / Math.min(FW, FH) : Math.min(1, (EX.short || Infinity) / Math.min(FW, FH));
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const W = even(FW * scale), H = even(FH * scale), F = job.preview ? Math.min(30, S.fps || 30) : EX.fpsOut || Math.min(EX.fps || Infinity, S.fps || 30);
const DEVA = /[\u0900-\u097F]/;
const FONTS = {
  latin: ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  deva: ['C:/Windows/Fonts/NirmalaB.ttf', 'C:/Windows/Fonts/Nirmala.ttf', 'C:/Windows/Fonts/Nirmala.ttc', '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf'],
};
const AFMT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
const ENC = (crf, preset) => ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(F),
  '-c:a', 'aac', '-b:a', job.preview ? '128k' : '192k', '-ar', '48000', '-ac', '2'];
// NVIDIA encoder (NVENC) for the final file: the FFmpeg 7.1 copy in tools/ runs it on older drivers than the system FFmpeg
// needs. Only the encoding happens there - the system FFmpeg still does every filter (7.1's LUT / colour / stabilise
// filters give a different picture) and hands it the finished frames through a pipe. A failed GPU encode falls back to the CPU.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FF7 = path.join(HERE, '..', 'tools', 'ffmpeg-7.1.1-essentials_build', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const NV = job.preview || EX.gpu === false || job.gpu === false ? null : [fs.existsSync(FF7) ? FF7 : null, 'ffmpeg'].filter(Boolean).find((b) =>
  spawnSync(b, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { windowsHide: true }).status === 0) || null;
// shot pieces stay on the CPU: they are small, and on the GPU they measured slower (the decode is the slow part)
const SEG_ENC = job.preview ? (FAST ? ENC(26, 'ultrafast') : ENC(20, 'veryfast')) : ENC(16, 'veryfast');
// shots rendered side by side (each FFmpeg already uses several cores; camera files come from a slow drive)
const PAR = Math.max(1, +job.parallel || (FAST ? 4 : 3)); // (a 1080p preview reads the camera files too)

const die = (m) => { console.error(`render: ${m}`); process.exit(1); };
const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit2-'));
const ts = project.trackState || {};
const stageLut = stager(wd);
const M = (id) => media[id] || die(`media ${id} is missing from the project`);

function ff(args, bin = 'ffmpeg', soft = false) {
  const r = spawnSync(bin, ['-hide_banner', '-y', '-loglevel', 'error', '-stats', ...args], { cwd: wd, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error) die('ffmpeg not found');
  if (r.status !== 0) { if (soft) return false; die(`ffmpeg failed (exit ${r.status})`); }
  return true;
}
// the same in the background (shots render side by side); rejects with FFmpeg's last error line
function ffAsync(args, bin = 'ffmpeg') {
  return new Promise((ok, no) => {
    const p = spawn(bin, ['-hide_banner', '-y', '-loglevel', 'error', ...args], { cwd: wd, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    p.on('error', () => no(new Error('ffmpeg not found')));
    p.on('close', (code) => (code === 0 ? ok() : no(new Error(`ffmpeg failed (exit ${code}) ${err.trim().split(/\r?\n/).pop() || ''}`))));
  });
}
// a long filter graph goes in a file (-/filter_complex): Windows cuts a command line at 32k characters, and the final
// pass of a 200-shot song edit joins every shot in one graph
let fcN = 0;
const fcArgs = (graph) => {
  if (graph.length < 4000) return ['-filter_complex', graph];
  const f = `graph${fcN++}.txt`;
  fs.writeFileSync(path.join(wd, f), graph, 'utf8');
  return ['-/filter_complex', f];
};
// files in the work folder are passed by their short name (FFmpeg runs there)
const short = (f) => (path.dirname(path.resolve(f)) === path.resolve(wd) ? path.basename(f) : f);
// preview renders read the small proxy copy (cache/proxies/<id>.mp4) instead of the camera file when there is one
// (not any more: a 1080p preview needs the camera files - the proxies are small, and made it soft)
const proxyOf = (id) => {
  if (!job.preview || !job.segCache || !id || !(FAST || job.useProxies === true)) return null;
  const f = path.resolve(path.dirname(job.segCache), 'proxies', `${id}.mp4`);
  return fs.existsSync(f) ? f : null;
};
function probeDur(f) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' });
  return +r.stdout || 0;
}

// Fonts/text files are copied into the work dir and referenced by bare name: Windows drive letters break filtergraphs.
let fontN = 0, textN = 0;
function font(text) {
  const src = (DEVA.test(text || '') ? FONTS.deva : FONTS.latin).find((f) => fs.existsSync(f));
  if (!src) die('no usable font found');
  const name = `font${fontN++}${path.extname(src)}`;
  fs.copyFileSync(src, path.join(wd, name));
  return name;
}
function textfile(text) { const n = `text${textN++}.txt`; fs.writeFileSync(path.join(wd, n), text, 'utf8'); return n; }

const hexColor = (c, a = 1) => (/^#[0-9a-f]{6}$/i.test(c || '') ? `0x${c.slice(1)}@${a}` : c);
const TRI = ['0xFF9933', '0xFFFFFF', '0x138808'];
// Text with the title-template extras (public/js/templates.js): box colour, accent bar, full-width strip, tricolour bands,
// slide-in. Returns one or more comma-joined filters (boxes first, text on top).
// opts: { style, size, color, box (bool), boxColor, accent, strip, tricolour, card, slide: start time, enable, alpha }
function drawtext(text, { style = 'lower', size, color = 'white', box = true, boxColor, accent, strip, tricolour, card = false, slide = null, pop = null, follow = null, enable = '', alpha = '' } = {}) {
  const lines = String(text).split('\n'), longest = Math.max(...lines.map((l) => [...l].length), 1);
  const base = style === 'center' ? Math.min(H * 0.06, W * 0.075) : Math.min(H * 0.04, W * 0.045);
  const fs_ = Math.max(12, Math.round(size ? size * scale : Math.min(base, (W * 0.88) / (longest * 0.58))));
  const pad = Math.round(fs_ * 0.45), th = Math.round(fs_ * (1.3 * lines.length - 0.3));
  const x0 = Math.round(W * 0.06), y0 = style === 'center' ? Math.round((H - th) / 2) : style === 'top' ? Math.round(H * 0.08) : Math.round(H - H * 0.12 - th);
  // slide-in: lower thirds come in from the left, other styles rise a little; boxes wipe open with them
  const p = slide !== null ? `pow(max(0\\,1-(t-${slide.toFixed(3)})/0.45)\\,2)` : null;
  let x = style === 'lower' ? `${x0}` : '(w-text_w)/2', y = style === 'center' ? '(h-text_h)/2' : `${y0}`;
  if (p && style === 'lower') x = `'${x0}-(${x0}+text_w+${pad * 3})*${p}'`;
  else if (p) y = `'${style === 'center' ? '(h-text_h)/2' : y0}+${Math.round(H * 0.04)}*${p}'`;
  // follow (motion tracking): the text moves with the tracked thing
  if (follow) { const un = (e) => String(e).replace(/^'|'$/g, ''); x = `'(${un(x)})+(${follow.x})'`; y = `'(${un(y)})+(${follow.y})'`; }
  const out = [], en = enable;
  const wipe = (w) => (slide !== null ? `'(${w})*min(1\\,(t-${slide.toFixed(3)})/0.35)'` : `${w}`);
  if (strip) {
    const sy = y0 - pad, sh = th + pad * 2;
    out.push(`drawbox=x=0:y=${sy}:w=${wipe('iw')}:h=${sh}:color=${hexColor(strip, 0.92)}:t=fill${en}`);
    if (tricolour) TRI.forEach((c, k) => out.push(`drawbox=x=0:y=${sy + sh + k * Math.max(2, Math.round(fs_ * 0.09))}:w=${wipe('iw')}:h=${Math.max(2, Math.round(fs_ * 0.09))}:color=${c}:t=fill${en}`));
  } else if (tricolour && card) {
    const bh = Math.max(3, Math.round(H * 0.014));
    TRI.forEach((c, k) => out.push(`drawbox=x=0:y=${H - bh * (3 - k)}:w=iw:h=${bh}:color=${c}:t=fill${en}`));
  }
  if (accent) {
    if (style === 'lower' && !card) out.push(`drawbox=x=${Math.max(0, x0 - pad - Math.round(fs_ * 0.22))}:y=${y0 - pad}:w=${Math.max(3, Math.round(fs_ * 0.16))}:h=${wipe(th + pad * 2)}:color=${hexColor(accent)}:t=fill${en}`);
    else out.push(`drawbox=x=${Math.round((W - fs_ * 2.4) / 2)}:y=${y0 + th + Math.round(fs_ * 0.55)}:w=${wipe(Math.round(fs_ * 2.4))}:h=${Math.max(3, Math.round(fs_ * 0.1))}:color=${hexColor(accent)}:t=fill${en}`);
  }
  const boxed = box && (boxColor || style !== 'center') && !strip;
  const deco = boxed
    ? `:box=1:boxcolor=${boxColor ? hexColor(boxColor, 0.92) : 'black@0.55'}:boxborderw=${pad}`
    : `:shadowcolor=black@0.7:shadowx=${Math.ceil(fs_ / 20)}:shadowy=${Math.ceil(fs_ / 20)}`;
  out.push(`drawtext=fontfile=${font(text)}:textfile=${textfile(text)}:expansion=none:fontsize=${pop !== null ? `'${fs_}*(1+0.25*pow(max(0,1-(t-${pop.toFixed(3)})/0.2),2))'` : fs_}:fontcolor=${hexColor(color)}` +
    `:line_spacing=${Math.round(fs_ * 0.3)}${deco}:x=${x}:y=${y}${en}${alpha}`);
  return out.join(',');
}
// the template extras of a title clip, as drawtext options
const titleLook = (c) => ({ box: c.box !== 'none', boxColor: c.box && c.box !== 'none' ? c.box : undefined, accent: c.accent, strip: c.strip, tricolour: c.tricolour });

function fit(inp, out, mode, c = {}) {
  // crop position: fixed, or keyframed (🎯 Follow faces) - t is seconds since the clip started, as the keys are
  const pos = (p, d) => (c.keys?.[p]?.length ? `'(${d})*clip(${keysExpr(c.keys[p], 't')},0,1)'` : `(${d})*${c[p] ?? 0.5}`);
  const cx = pos('cropX', 'iw-ow'), cy = pos('cropY', 'ih-oh');
  if (mode === 'fill')
    return `[${inp}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:${cx}:${cy},setsar=1[${out}]`;
  if (mode === 'blur')
    return `[${inp}]split[${out}b][${out}f];[${out}b]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:3,eq=brightness=-0.08[${out}bb];` +
      `[${out}f]scale=${W}:${H}:force_original_aspect_ratio=decrease[${out}ff];[${out}bb][${out}ff]overlay=(W-w)/2:(H-h)/2,setsar=1[${out}]`;
  return `[${inp}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[${out}]`;
}
// ⏩ the sound of a clip at another speed: same pitch (atempo), or - "Maintain audio pitch" off (c.keepPitch === false) -
// higher / lower like a tape played faster / slower
const speedAudio = (c, speed) => (speed === 1 ? '' : c.keepPitch === false ? `aresample=48000,asetrate=${Math.round(48000 * speed)},aresample=48000` : atempo(speed));
function atempo(speed) {
  const parts = []; let s = speed;
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  parts.push(+s.toFixed(4));
  return parts.map((p) => `atempo=${p}`).join(',');
}

// Transform (zoom / position / rotation) applied on the fitted frame, so it behaves like Premiere's Motion.
function transformFilters(c) {
  const t = c.transform || {}, K = c.keys || {};
  const animMove = ['transform.zoom', 'transform.x', 'transform.y'].some((p) => K[p]?.length);
  const f = [];
  if (animMove) {
    // Keyframed zoom/position: put the frame in the middle of a 2x black canvas and move a window over it with zoompan.
    // Window = W/zoom wide, centred on the frame and shifted by -x% of its width (so +x moves the picture right).
    const ex = (p, dflt) => (K[p]?.length ? `(${keysExpr(K[p], 'it')})` : String(+getP(c, p) || dflt));
    const Z = `max(0.5,${ex('transform.zoom', 1)})`, X = ex('transform.x', 0), Y = ex('transform.y', 0);
    f.push(`pad=${W * 2}:${H * 2}:${W / 2}:${H / 2}:black`);
    f.push(`zoompan=z='2*${Z}':x='${W}-(${X})/100*${W}/(${Z})-${W}/(2*(${Z}))':y='${H}-(${Y})/100*${H}/(${Z})-${H}/(2*(${Z}))':d=1:s=${W}x${H}:fps=${F}`);
    f.push('setsar=1');
  }
  const z = +t.zoom || 1, x = +t.x || 0, y = +t.y || 0, r = +t.rotation || 0;
  if (K['transform.rotation']?.length) f.push(`rotate=a='(${keysExpr(K['transform.rotation'], 't')})*PI/180':fillcolor=black`);
  if (animMove) return f;
  if (z !== 1 || x || y) {
    f.push(`scale=${even(W * z)}:${even(H * z)}`);
    // positive x/y move the picture right/down (percent of frame), then crop back to frame size
    f.push(`pad=${even(Math.max(W, W * z) + Math.abs(x) * W * 2 / 100)}:${even(Math.max(H, H * z) + Math.abs(y) * H * 2 / 100)}:(ow-iw)/2:(oh-ih)/2:black`);
    f.push(`crop=${W}:${H}:(iw-${W})/2-(${x / 100}*${W}):(ih-${H})/2-(${y / 100}*${H})`);
  }
  if (r && !K['transform.rotation']?.length) f.push(`rotate=${(r * Math.PI) / 180}:fillcolor=black`);
  return f;
}
// a clip's own audio clean-up (clip.afx, same settings as the track effects), before speed and volume
const clipFx = (c) => { const f = fxFilters(c.afx); return f.length ? `${f.join(',')},` : ''; };
const getP = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
// Clip volume: static value, or the keyframed curve evaluated per audio frame (t = time since the clip started).
const volumeFilter = (c, dflt = 1) => (c.keys?.volume?.length ? `volume='${keysExpr(c.keys.volume, 't')}':eval=frame` : `volume=${c.volume ?? dflt}`);

// Cut effect (public/js/fx.js) on the first moments of a clip; t = seconds since the clip started. Returns the out label.
// Effects that only exist for a moment are built from timeline-enabled filters or from a trimmed copy overlaid on top.
function cutFxGraph(c, inL, dur, g) {
  const D = Math.min(cutFxDur(c), dur - 0.02);
  if (!(D > 0.04)) return inL;
  const d = D.toFixed(3), k = `max(0,1-t/${d})`, out = `vfx${segN}`, px = (f) => Math.max(1, Math.round(W * f));
  const slices = (n, fn) => Array.from({ length: n }, (_, i) => fn(i, `:enable='between(t,${((D * i) / n).toFixed(3)},${((D * (i + 1)) / n).toFixed(3)})'`)).join(',');
  const moving = (z, x, y) => // a moving window over a short trimmed copy, laid over the clip's first D seconds
    `[${inL}]split[${out}a][${out}b];[${out}b]trim=0:${d},setpts=PTS-STARTPTS,zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${F},setsar=1[${out}c];` +
    `[${out}a][${out}c]overlay=eof_action=pass,setsar=1[${out}]`;
  const leak = (cols, pos) => `gradients=s=${W}x${H}:r=${F}:d=${d}:type=radial:nb_colors=${cols.length}:${cols.map((x, i) => `c${i}=${x}`).join(':')}:${pos}:speed=0.04,` +
    `fade=t=in:d=${(D * 0.35).toFixed(3)},fade=t=out:st=${(D * 0.45).toFixed(3)}:d=${(D * 0.55).toFixed(3)},format=gbrp[${out}l];` +
    `[${inL}]format=gbrp[${out}g];[${out}g][${out}l]blend=all_mode=screen:eof_action=pass:repeatlast=0,format=yuv420p[${out}]`;
  const seed = parseInt(crypto.createHash('md5').update(String(c.id || segN)).digest('hex').slice(0, 6), 16) % 997;
  const hs = (i) => { const x = Math.sin((seed * 7 + i) * 12.9898) * 43758.5453; return x - Math.floor(x); };
  const f = {
    flash: () => `[${inL}]eq=brightness='0.85*pow(${k},1.5)':contrast='1-0.5*${k}':eval=frame[${out}]`,
    strobe: () => `[${inL}]eq=brightness='if(lt(t,${d}),if(mod(floor(t*20),2),0.6,-0.45),0)':eval=frame[${out}]`,
    punch: () => moving(`1+0.22*pow(max(0,1-it/${d}),2)`, 'iw/2-iw/zoom/2', 'ih/2-ih/zoom/2'),
    shake: () => moving('1.08', `iw/2-iw/zoom/2+iw*0.03*max(0,1-it/${d})*sin(it*71)`, `ih/2-ih/zoom/2+ih*0.03*max(0,1-it/${d})*cos(it*97)`),
    glitch: () => `[${inL}]${slices(4, (i, en) => `rgbashift=rh=${px(0.004 + 0.012 * hs(i))}:bh=-${px(0.004 + 0.012 * hs(i + 9))}:gv=${Math.round((hs(i + 3) - 0.5) * px(0.01))}${en}`)},` +
      `hue=H='if(lt(t,${d}),2*PI*sin(t*90),0)',noise=alls=30:allf=t:enable='lt(t,${d})'[${out}]`,
    rgb: () => `[${inL}]${slices(3, (i, en) => `rgbashift=rh=${px(0.012 / (i + 1))}:bh=-${px(0.012 / (i + 1))}${en}`)}[${out}]`,
    whip: () => `[${inL}]${slices(3, (i, en) => `dblur=angle=0:radius=${px(0.04 / (i + 1))}${en}`)}[${out}]`,
    blur: () => `[${inL}]${slices(4, (i, en) => `gblur=sigma=${Math.max(1, Math.round(W * 0.016 / (i + 1)))}${en}`)}[${out}]`,
    leak: () => leak(['0xffaf46', '0xff5f00', '0x000000'], `x0=${Math.round(W * 0.1)}:y0=${Math.round(H * 0.08)}:x1=${Math.round(W * 0.85)}:y1=${Math.round(H * 0.95)}`),
    burn: () => leak(['0xfff6d0', '0xff6a00', '0x000000'], `x0=${Math.round(W * 0.7)}:y0=${Math.round(H * 0.6)}:x1=${Math.round(W * 0.05)}:y1=${Math.round(H * 0.05)}`),
  }[c.cutFx.type];
  if (!f) return inL;
  g.push(f());
  return out;
}

// a clip's video effects in order; chain effects are joined, graph effects (glow, mirror) get their own labels.
// Chroma key is left to the final pass, where the overlay keeps its transparency.
// ◯ An effect with a mask (public/js/shapemask.js) works on a copy of the picture, which is then laid back over it
// through the mask - the effect shows only inside (or, inverted, outside). addMask(file) -> the mask picture's label.
function vfxGraph(c, inL, g, pre = `vx${segN}`, addMask = null) {
  let cur = inL, k = 0;
  for (const e of activeEffects(c)) {
    if (e.type === 'chromakey') continue;
    const r = VFX[e.type].ff(e.p || {}, { W, H }), out = `${pre}_${k++}`;
    if (r === 'null') continue;
    const masked = e.mask?.shape && addMask;
    const src = masked ? `${out}s` : cur, dst = masked ? `${out}f` : out;
    if (masked) g.push(`[${cur}]split[${out}a][${out}s]`);
    g.push(typeof r === 'string' ? `[${src}]${r}[${dst}]` : r.graph(src, dst));
    if (masked) {
      const mk = addMask(maskPng(e.mask));
      g.push(`[${dst}]format=yuva420p[${out}g]`, `[${out}g][${mk}]alphamerge[${out}h]`, `[${out}a][${out}h]overlay=format=auto,format=yuv420p[${out}]`);
    }
    cur = out;
  }
  return cur;
}
// a mask as a grey PNG of the output size in the work folder (made once per mask)
const maskPngs = new Map();
function maskPng(m) {
  const key = `${maskKey(m)}|${W}x${H}`;
  if (maskPngs.has(key)) return maskPngs.get(key);
  const name = `mask_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 10)}.png`;
  const a = maskAlpha(m, W, H), raw = Buffer.alloc((W + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; raw.set(a.subarray(y * W, (y + 1) * W), y * (W + 1) + 1); }
  const chunk = (type, data) => { const len = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'latin1'), data]), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 0; // 8-bit greyscale
  fs.writeFileSync(path.join(wd, name), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  maskPngs.set(key, name);
  return name;
}

// Tracked blur / mosaic (public/js/tracking.js): a box of fixed size moves along the tracked path; the picture inside
// it is cut out, blurred or pixelated, and laid back at the same place - only while the thing was tracked.
function maskGraph(c, inL, g, mode) {
  if (c.type !== 'video' || !c.masks?.length) return inL;
  let cur = inL;
  c.masks.forEach((mk, i) => {
    const tr = maskTrack(mk, c, media[c.mediaId], W, H, mode);
    if (!tr || tr.BW >= W || tr.BH >= H) return;
    const p = `mk${segN}_${i}`, X = `clip(${keysExpr(tr.xs, 't')},0,${W - tr.BW})`, Y = `clip(${keysExpr(tr.ys, 't')},0,${H - tr.BH})`, amt = mk.amount ?? 0.6;
    const on = `enable='between(t,${Math.max(0, tr.a).toFixed(3)},${tr.b.toFixed(3)})'`;
    // ▭ a box drawn over a logo / text: Remove = filled in from the picture around it (delogo; the box must stay a
    // pixel inside the frame), Black = a solid box. Both stay put (a drawn box does not move).
    if (mk.type === 'remove' || mk.type === 'black') {
      const x = Math.max(1, Math.min(W - 3, tr.xs[0].v)), y = Math.max(1, Math.min(H - 3, tr.ys[0].v));
      const w = Math.max(2, Math.min(W - 1 - x, tr.BW)), h = Math.max(2, Math.min(H - 1 - y, tr.BH));
      g.push(`[${cur}]${mk.type === 'remove' ? `delogo=x=${x}:y=${y}:w=${w}:h=${h}` : `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black:t=fill`}:${on}[${p}]`);
      cur = p; return;
    }
    const fx = mk.type === 'pixelate'
      ? `scale=${Math.max(2, Math.round(tr.BW / (4 + 18 * amt)))}:${Math.max(2, Math.round(tr.BH / (4 + 18 * amt)))},scale=${tr.BW}:${tr.BH}:flags=neighbor`
      : `boxblur=${Math.max(2, Math.round(Math.min(tr.BW, tr.BH) * (0.08 + 0.12 * amt)))}:3`;
    g.push(`[${cur}]split[${p}a][${p}b]`, `[${p}b]crop=${tr.BW}:${tr.BH}:'${X}':'${Y}',${fx}[${p}c]`,
      `[${p}a][${p}c]overlay=x='${X}':y='${Y}':${on}[${p}]`);
    cur = p;
  });
  return cur;
}

// ---------------- smart cache ----------------
// A shot is the same when its clip settings, its file, the frame size / rate and the encoder are the same: then the
// piece rendered last time (job.segCache/<key>.mp4) is used again instead of being rendered from the camera file.
const SEG_V = 2; // bump when segment() changes what it draws (2: frame-exact shot lengths)
const segKey = (c, label, mode, fixed) => crypto.createHash('sha1').update(JSON.stringify({ SEG_V, c, fixed, v1: label.startsWith('V1'), mode, W, H, F, preview: !!job.preview, SEG_ENC,
  m: c.mediaId ? media[c.mediaId] : null, px: proxyOf(c.mediaId), kb: S.kenburns, luts: job.luts || {} })).digest('hex').slice(0, 24);
const CACHE_MB = job.segCacheMB || 30000;
function trimCache() {
  if (!job.segCache || !fs.existsSync(job.segCache)) return;
  const files = fs.readdirSync(job.segCache).filter((f) => f.endsWith('.mp4')).map((f) => { const p = path.join(job.segCache, f), st = fs.statSync(p); return { p, size: st.size, t: st.mtimeMs }; })
    .sort((a, b) => b.t - a.t);
  let sum = 0;
  for (const x of files) { sum += x.size; if (sum > CACHE_MB * 1048576) { fs.rmSync(x.p, { force: true }); fs.rmSync(x.p.replace(/\.mp4$/, '.json'), { force: true }); } }
}
let reused = 0;

let segN = 0, smoothAfterFit = '';
// 🧽 clean up: noise out, detail back (output size); 'upscale' also scales small footage up with lanczos
const ENHANCE = { light: 'hqdn3d=2:1.5:4:3,unsharp=5:5:0.4', strong: 'nlmeans=s=3:p=5:r=11,unsharp=5:5:0.7', upscale: 'nlmeans=s=3:p=5:r=11,unsharp=7:7:0.9' };
// fixed: the shot's length snapped to whole frames from its cut times on the timeline (see v1Segs), so rounding each
// shot to frames never adds up - over 40 shots of 0.65 s half a frame each was ~80 ms off the beat by the end
function segment(c, label, fixed = null) {
  const exact = (d) => (fixed && Math.abs(fixed - d) < 1.5 / F ? fixed : d);
  smoothAfterFit = '';
  const mode = (reframed && EX.fit) || c.fit || S.fit || (H > W ? 'blur' : 'fit');
  const key = job.segCache ? segKey(c, label, mode, fixed) : null, hit = key && path.join(job.segCache, `${key}.mp4`);
  if (hit && fs.existsSync(hit) && fs.existsSync(hit.replace(/\.mp4$/, '.json'))) {
    const meta = JSON.parse(fs.readFileSync(hit.replace(/\.mp4$/, '.json'), 'utf8'));
    const now = new Date(); try { fs.utimesSync(hit, now, now); } catch {}
    console.log(`    unchanged - reused from the last render`);
    // linked into the work folder under a short name (no copy; a copy only if linking is not possible)
    const local = path.join(wd, `seg${String(segN++).padStart(4, '0')}.mp4`);
    try { fs.linkSync(hit, local); } catch { try { fs.copyFileSync(hit, local); } catch {} }
    reused++;
    return { file: fs.existsSync(local) ? local : hit, dur: meta.dur };
  }
  const inputs = [], g = [], preCmds = [], maskIns = [];
  const addMask = (file) => { const l = `mki${maskIns.length}`; maskIns.push({ file, l }); return l; };
  let dur, aSrc;
  if (c.type === 'video') {
    const m = M(c.mediaId), full = m.duration || probeDur(m.path), src = proxyOf(c.mediaId) || m.path;
    const tin = Math.max(0, +c.in || 0), tout = Math.min(c.out ?? full, full);
    if (tout - tin < 0.05) die(`${label}: In/Out leaves no video`);
    const speed = c.speed || 1, ramp = rampPts(c);
    dur = exact(ramp ? clipDur({ ...c, in: tin, out: tout }, media) : (tout - tin) / speed);
    inputs.push('-ss', String(tin), '-t', String(tout - tin), '-i', src);
    let stab = '';
    const ws = activeEffects(c).find((e) => VFX[e.type]?.stab); // 🎥 Warp Stabilizer (effect) - wins over the simple Stabilize
    if (ws || c.stabilize) {
      // Stabilise (vid.stab, two passes) on a 1080p working copy: pass 1 measures the shake of exactly this piece,
      // pass 2 smooths the camera path and frames the picture (zoom / crop / filled edges) as the settings say.
      const p = ws?.p || {}, st = { light: [5, 12], medium: [7, 20], strong: [10, 35] }[c.stabilize] || [7, 20];
      const detailed = p.detail === 'on', tripod = ws && p.result === 'nomotion';
      const shake = ws ? (detailed ? 9 : 6) : st[0], acc = detailed ? 15 : 12;
      const smoothing = ws ? Math.max(1, Math.round((Math.min(100, Math.max(1, +p.smoothness || 50)) / 100) * 60)) : st[1];
      const framing = ws ? ({ stabilize: 'optzoom=0:crop=black', crop: 'optzoom=1', synth: 'optzoom=0:crop=keep', cropscale: 'optzoom=2:zoomspeed=0.25' }[p.framing] || 'optzoom=2:zoomspeed=0.25') : 'optzoom=1:zoomspeed=0.2';
      const extra = ws ? Math.max(0, Math.min(50, (+p.addscale || 100) - 100)) : 0;
      const trf = `stab${segN}.trf`, pre = `scale=-2:'min(ih,1080)'`;
      console.log(`    stabilising ${label}${ws ? ' (Warp Stabilizer)' : ''}…`);
      preCmds.push(['-ss', String(tin), '-t', String(tout - tin), '-i', src, '-an', '-vf', `${pre},vidstabdetect=shakiness=${shake}:accuracy=${acc}${tripod ? ':tripod=1' : ''}:result=${trf}`, '-f', 'null', '-']);
      stab = `${pre},vidstabtransform=input=${trf}:smoothing=${smoothing}:${framing}${extra ? `:zoom=${extra}` : ''}${tripod ? ':tripod=1' : ''}${p.method === 'position' ? ':maxangle=0' : ''}:interpol=bicubic,unsharp=5:5:0.5:3:3:0.2,`;
    }
    // ✨ smooth slow motion: in-between frames are made after framing (at output size - much faster than on 4K)
    const smooth = c.smooth && (ramp || speed < 1), rate = smooth ? '' : `,fps=${F}`;
    if (ramp) {
      // speed ramp: every source frame at T seconds is shown at the timeline time where the ramp reaches it
      // (the inverse of sourceAt, as a piecewise-linear curve with 64 pieces); fps then repeats / drops frames evenly
      const K = 64, keys = Array.from({ length: K + 1 }, (_, k) => ({ t: sourceAt({ ...c, in: 0 }, (dur * k) / K, dur), v: (dur * k) / K }));
      g.push(`[0:v]${stab}setpts='(${keysExpr(keys, 'T')})/TB'${rate}[v0]`);
    } else g.push(`[0:v]${stab}${c.reverse ? 'reverse,' : ''}setpts=(PTS-STARTPTS)/${speed}${rate}[v0]`); // (⏪ Reverse speed: the shot backwards)
    // Time interpolation (Clip Speed / Duration): 'blend' = frame blending (quick), true = optical flow (smoothest)
    if (smooth) smoothAfterFit = job.preview || c.smooth === 'blend' ? `minterpolate=fps=${F}:mi_mode=blend` : `minterpolate=fps=${F}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`;
    if (ramp) { /* ramped clips are silent (music carries them) */ } else if (m.hasAudio && !c.mute) aSrc = `[0:a]asetpts=PTS-STARTPTS,${c.reverse ? 'areverse,' : ''}${clipFx(c)}${speedAudio(c, speed) ? `${speedAudio(c, speed)},` : ''}${volumeFilter(c)},${AFMT}[a]`;
  } else if (c.type === 'image') {
    const m = M(c.mediaId);
    dur = exact(clipDur(c, media));
    // -loop only exists for plain image files (jpg / png / bmp / tif): iPhone HEIC, HEIF, AVIF, WebP and GIF are turned
    // into a PNG first (FFmpeg puts a HEIC's tiles back together into the full photo)
    let still = m.path;
    if (!/\.(jpe?g|png|bmp|tiff?)$/i.test(m.path)) { still = `still${segN}.png`; preCmds.push(['-i', m.path, '-frames:v', '1', still]); }
    inputs.push('-loop', '1', '-framerate', String(F), '-t', String(dur), '-i', still);
    const kb = c.kenburns ?? (S.kenburns ? 'in' : false);
    if (kb) {
      const N = Math.max(1, Math.round(dur * F)), z = kb === 'out' ? `1.15-0.15*on/${N}` : `1+0.15*on/${N}`;
      g.push(`[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},` +
        `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${F},setsar=1[v0]`);
    } else g.push(`[0:v]fps=${F}[v0]`);
  } else if (c.type === 'title') {
    dur = exact(clipDur(c, media));
    inputs.push('-f', 'lavfi', '-i', `color=c=${c.bg || '#0b2545'}:s=${W}x${H}:r=${F}:d=${dur}`);
    g.push('[0:v]null[v0]');
  } else die(`${label}: unknown clip type ${c.type}`);

  let cur = 'v0';
  const preFitted = c.type === 'title' || (c.type === 'image' && (c.kenburns ?? S.kenburns));
  if (!preFitted) { g.push(fit(cur, 'v1', mode, c).replace(/scale=(\d+):(\d+):force/, c.enhance === 'upscale' ? 'scale=$1:$2:flags=lanczos:force' : 'scale=$1:$2:force')); cur = 'v1'; }
  if (smoothAfterFit) { g.push(`[${cur}]${smoothAfterFit}[vsm]`); cur = 'vsm'; }
  if (c.type === 'video' && ENHANCE[c.enhance]) { g.push(`[${cur}]${ENHANCE[c.enhance]}[ven]`); cur = 'ven'; }
  cur = maskGraph(c, cur, g, mode);
  // colour, then the clip's video effects (public/js/effects.js), then Motion - Premiere's order
  const col = colorFilters(c.color, { luts: job.luts || {}, stage: stageLut }), mot = transformFilters(c);
  if (col.length) { g.push(`[${cur}]${col.join(',')}[vc]`); cur = 'vc'; }
  cur = vfxGraph(c, cur, g, `vx${segN}`, addMask);
  // ◐ Opacity mask on the main story: outside it is black (overlays get theirs in the final pass, over the shot below)
  if (c.omask?.shape && label.startsWith('V1') && (c.type === 'video' || c.type === 'image')) {
    const mk = addMask(maskPng(c.omask));
    g.push(`[${cur}]split[om1][om2]`, `[om2]format=yuva420p[om3]`, `[om3][${mk}]alphamerge[om4]`, `[om1]drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill[om5]`, `[om5][om4]overlay=format=auto,format=yuv420p[vom]`);
    cur = 'vom';
  }
  if (mot.length) { g.push(`[${cur}]${mot.join(',')}[vp]`); cur = 'vp'; }
  cur = cutFxGraph(c, cur, dur, g);
  // opacity on V1: the picture fades towards the black below it (static, or keyframed per frame with geq)
  const opK = c.keys?.opacity?.length, opS = c.opacity ?? 1;
  if (label.startsWith('V1') && (opK || opS < 1)) {
    const O = opK ? `clip(${keysExpr(c.keys.opacity, 'T')},0,1)` : null;
    g.push(`[${cur}]${O ? `format=yuv420p,geq=lum='16+(lum(X,Y)-16)*${O}':cb='128+(cb(X,Y)-128)*${O}':cr='128+(cr(X,Y)-128)*${O}'` : `colorlevels=romax=${opS}:gomax=${opS}:bomax=${opS}`}[vop]`);
    cur = 'vop';
  }
  const vf = [];
  if (c.type === 'title' && c.text) vf.push(drawtext(c.text, { style: 'center', size: c.size, color: c.textColor || 'white', ...titleLook(c), box: !!(c.box && c.box !== 'none'), card: true }));
  else if (c.text) vf.push(drawtext(c.text, { style: c.textStyle || 'lower', size: c.size, enable: c.textDuration ? `:enable='lt(t,${c.textDuration})'` : '' }));
  if (c.fadeIn) vf.push(`fade=t=in:st=0:d=${c.fadeIn}`);
  if (c.fadeOut) vf.push(`fade=t=out:st=${Math.max(0, dur - c.fadeOut)}:d=${c.fadeOut}`);
  vf.push('format=yuv420p');
  g.push(`[${cur}]${vf.join(',')}[v]`);
  if (!aSrc) { inputs.push('-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=48000:cl=stereo'); aSrc = `[1:a]${AFMT}[a]`; }
  g.push(aSrc);
  // the mask pictures come last, so the inputs above keep their numbers
  for (const mi of maskIns) { const idx = inputs.filter((a) => a === '-i').length; inputs.push('-loop', '1', '-framerate', String(F), '-t', String(dur + 0.5), '-i', mi.file); g.push(`[${idx}:v]format=gray,setsar=1[${mi.l}]`); }
  const out = path.join(wd, `seg${String(segN++).padStart(4, '0')}.mp4`);
  return { file: out, dur, label, hit, pre: preCmds, main: [...inputs, ...fcArgs(g.join(';')), '-map', '[v]', '-map', '[a]', '-t', String(dur)] };
}
// render one planned shot (stabilise pass first) on the GPU encoder when there is one, then put it in the cache
async function runSegment(s) {
  if (!s.main) return;
  for (const a of s.pre) await ffAsync(a);
  await ffAsync([...s.main, ...SEG_ENC, s.file]);
  if (s.hit) {
    // into the cache for next time (a failed copy only costs the reuse)
    try { fs.mkdirSync(job.segCache, { recursive: true }); fs.copyFileSync(s.file, s.hit); fs.writeFileSync(s.hit.replace(/\.mp4$/, '.json'), JSON.stringify({ dur: s.dur, label: s.label })); } catch {}
  }
}

// ---------------- 🖥 render farm (Phase 16) ----------------
// A shot can be rendered on another computer (engine/worker.mjs) when it needs nothing but its footage: no stabilise
// pass, and no file of this work folder in its filters (text files, LUTs, subtitles). Its footage files become
// placeholders the worker fills with links to this editor; the piece comes back to s.file. job.farm.url: the editor.
function farmReq(method, p, body) {
  return new Promise((ok) => {
    const u = new URL(p, job.farm.url), data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(u, { method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} ok({ code: res.statusCode, body: j }); });
    });
    r.on('error', () => ok({ code: 0, body: null }));
    if (data) r.write(data);
    r.end();
  });
}
async function farmStatus() { const r = await farmReq('GET', '/api/farm/status'); return r.code === 200 ? +r.body?.slots || 0 : 0; }
const LOCAL_ONLY = /textfile=|lut3d|haldclut|subtitles=|movie=|\.cube|\.ass\b|fontsdir|sendcmd/i;
function farmable(s) {
  if (!s.main || s.pre?.length) return null;
  const args = [], inputs = [];
  let graph = null;
  for (let i = 0; i < s.main.length; i++) {
    const a = s.main[i];
    if (a === '-/filter_complex') { graph = fs.readFileSync(path.join(wd, s.main[++i]), 'utf8'); args.push('-/filter_complex', '{{GRAPH}}'); continue; }
    if (a === '-filter_complex') { graph = s.main[++i]; args.push('-/filter_complex', '{{GRAPH}}'); continue; }
    if (a === '-i') {
      const v = s.main[++i];
      if (s.main[i - 2] === 'lavfi' && s.main[i - 3] === '-f') { args.push('-i', v); continue; }
      if (!path.isAbsolute(v) || !fs.existsSync(v)) return null; // a file of the work folder
      args.push('-i', `{{IN${inputs.length}}}`); inputs.push(v);
      continue;
    }
    if (typeof a === 'string' && a.length < 200 && !a.startsWith('-') && fs.existsSync(path.join(wd, a))) return null;
    args.push(a);
  }
  if (graph && LOCAL_ONLY.test(graph)) return null;
  return { inputs, args: [...args, ...SEG_ENC], graph };
}
// the name of the computer that rendered it, or null (then it is rendered here)
async function runOnFarm(s) {
  const r = await farmReq('POST', '/api/farm/run', { label: s.label, ...s.farm, out: path.resolve(s.file), limitSec: Math.max(120, Math.round(s.dur * 90)) });
  if (r.code !== 200 || !fs.existsSync(s.file) || !fs.statSync(s.file).size) return null;
  if (s.hit) { try { fs.mkdirSync(job.segCache, { recursive: true }); fs.copyFileSync(s.file, s.hit); fs.writeFileSync(s.hit.replace(/\.mp4$/, '.json'), JSON.stringify({ dur: s.dur, label: s.label })); } catch {} }
  return r.body?.worker || 'farm';
}

// ---------------- build ----------------
// 🔗 linked sound clips follow their picture (an edit saved by a tool without the browser may have moved the picture)
try { syncLinked(project, media); } catch (e) { console.log(`  (linked audio: ${e.message})`); }
const P = placed(project, media);
const D = Math.max(0.5, totalDuration(project, media));
// 🎚 Solo (S on an audio track): when any track is soloed only the soloed ones are heard, like the preview
const anySolo = Object.entries(ts).some(([k, x]) => k[0] === 'A' && x?.solo);
const audible = (id) => !ts[id]?.mute && (!anySolo || !!ts[id]?.solo);
const v1 = ts.V1?.hide ? [] : P.V1;
// overlay tracks bottom to top (V2, V3, …; hidden ones left out); every entry remembers its track
const ovl = overlayTracks(project).filter((id) => !ts[id]?.hide).flatMap((id) => (P[id] || []).map((x) => ({ ...x, track: id })));
const ovMedia = ovl.filter((x) => x.clip.type === 'video' || x.clip.type === 'image');
const total = v1.length + ovMedia.length + 1;
let step = 0;
console.log(`Rendering ${W}x${H}@${F}, ${D.toFixed(2)}s${job.preview ? ' (preview)' : ''}${NV && !job.preview ? ', GPU encoder' : ''}, ${PAR} shots at a time`);

// plan every shot first (cheap), then render them side by side
const frames = (t) => Math.round(t * F);
// 🎬 In / Out (job.range): only that part is made - shots wholly outside it become plain black of the same length (nothing
// is read or graded for them) and the final pass keeps only In to Out
const R = job.range && +job.range.out > +job.range.in ? { in: +job.range.in, out: Math.min(D, +job.range.out) } : null;
const outside = (x) => R && (x.end < R.in - 1 || x.start > R.out + 1);
const blank = (dur, label) => ({ file: path.join(wd, `seg${String(segN++).padStart(4, '0')}.mp4`), dur, label: `${label} (outside In-Out)`, hit: null, pre: [],
  main: ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${F}:d=${dur.toFixed(3)}`, '-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', '-t', dur.toFixed(3)] });
const v1Segs = v1.map((x, i) => { const d = (frames(x.end) - frames(x.start)) / F; return outside(x) ? blank(d, `V1 clip ${i + 1}`) : segment(x.clip, `V1 clip ${i + 1}`, d); });
const ovSegs = new Map(ovMedia.filter((x) => !outside(x)).map((x, i) => [x, segment(x.clip, `${x.track} clip ${i + 1}`)]));
if (R) console.log(`  In-Out: ${R.in.toFixed(2)}s to ${R.out.toFixed(2)}s (${(R.out - R.in).toFixed(2)}s)`);
{
  const all = [...v1Segs, ...ovSegs.values()], pending = [...all];
  // 🖥 render farm: other computers take shots from the end of the list while this one works from the start
  const farmSlots = job.farm ? await farmStatus() : 0;
  if (farmSlots) { for (const s of all) s.farm = farmable(s); console.log(`  render farm: ${farmSlots} worker slot${farmSlots > 1 ? 's' : ''}, ${all.filter((x) => x.farm).length} shots can go there`); }
  const takeLocal = () => pending.shift();
  const takeFarm = () => { for (let i = pending.length - 1; i >= 0; i--) if (pending[i].farm) return pending.splice(i, 1)[0]; return null; };
  const worker = async () => {
    for (let s; (s = takeLocal());) {
      await runSegment(s);
      console.log(`  [${++step}/${total}] ${s.label || 'shot'} ${s.main ? 'ready' : 'reused'}`);
    }
  };
  const farmWorker = async () => {
    for (let s; (s = takeFarm());) {
      const by = await runOnFarm(s);
      if (!by) await runSegment(s); // nobody took it / it failed there: here instead
      console.log(`  [${++step}/${total}] ${s.label || 'shot'} ready${by ? ` (🖥 ${by})` : ''}`);
    }
  };
  try { await Promise.all([...Array.from({ length: Math.min(PAR, all.length) }, worker), ...Array.from({ length: farmSlots }, farmWorker)]); } catch (e) { die(e.message); }
}

// Join V1 inside the final pass (it used to be an encode of its own): cuts via concat, transitions via xfade/acrossfade
// at the layout's start times; pad to the full length.
const inputs = [], g = [];
{
  if (!v1Segs.length) {
    inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${F}:d=${D}`, '-f', 'lavfi', '-t', String(D), '-i', 'anullsrc=r=48000:cl=stereo');
    g.push('[0:v]format=yuv420p[jvout]', `[1:a]${AFMT}[jaout]`);
  } else {
    // xfade needs identical timebase + frame rate on both inputs, and concat changes the timebase - normalise everywhere
    const TB = `settb=AVTB,fps=${F}`;
    v1Segs.forEach((s, i) => { inputs.push('-i', s.file); g.push(`[${i}:v]${TB},setpts=PTS-STARTPTS[s${i}v]`, `[${i}:a]asetpts=PTS-STARTPTS[s${i}a]`); });
    let v = 's0v', a = 's0a', len = v1Segs[0].dur;
    for (let i = 1; i < v1Segs.length; i++) {
      const lay = v1[i], tr = lay.clip.transitionIn;
      if (lay.overlap > 0) {
        g.push(`[${v}][s${i}v]xfade=transition=${tr.type}:duration=${lay.overlap.toFixed(3)}:offset=${(len - lay.overlap).toFixed(3)},${TB}[jv${i}]`);
        g.push(`[${a}][s${i}a]acrossfade=d=${lay.overlap.toFixed(3)}[ja${i}]`);
      } else {
        g.push(`[${v}][s${i}v]concat=n=2:v=1:a=0,${TB}[jv${i}]`, `[${a}][s${i}a]concat=n=2:v=0:a=1[ja${i}]`);
      }
      len += v1Segs[i].dur - lay.overlap;
      v = `jv${i}`; a = `ja${i}`;
    }
    const pad = Math.max(0, D - len);
    g.push(`[${v}]${pad > 0.01 ? `tpad=stop_mode=add:stop_duration=${pad.toFixed(3)}:color=black,` : ''}format=yuv420p[jvout]`);
    g.push(`[${a}]${pad > 0.01 ? `apad=pad_dur=${pad.toFixed(3)},` : ''}${AFMT}[jaout]`);
  }
}

// Final pass
console.log(`  [${++step}/${total}] finishing (joining, overlays, titles, audio mix, loudness)...`);
let n = inputs.filter((x) => x === '-i').length, v = 'jvout';
const fxOf = (id) => { const f = fxFilters(ts[id]?.fx); return f.length ? `${f.join(',')},` : ''; };
const speechParts = [`[jaout]${fxOf('V1')}volume=${ts.V1?.mute || (anySolo && !ts.V1?.solo) ? 0 : ts.V1?.volume ?? 1},${AFMT}[orig]`];
const speechLabels = ['orig'];

// a mask picture as an input of the final pass -> its label
const finalMask = (file, len = D + 0.5) => { const mi = n++; inputs.push('-loop', '1', '-framerate', String(F), '-t', String(len.toFixed(3)), '-i', file); g.push(`[${mi}:v]format=gray,setsar=1[fmk${mi}]`); return `fmk${mi}`; };
// Adjustment layer: everything below it in its time window gets its colour / effects (opacity = strength).
function adjustLayer(c, inL, st, en, k) {
  const col = colorFilters(c.color, { luts: job.luts || {}, stage: stageLut }), p = `aj${k}`;
  g.push(`[${inL}]split[${p}a][${p}b]`, `[${p}b]trim=start=${st.toFixed(3)}:end=${en.toFixed(3)},setpts=PTS-STARTPTS${col.length ? `,${col.join(',')}` : ''}[${p}c]`);
  const cur = vfxGraph(c, `${p}c`, g, `${p}x`, finalMask), op = c.opacity ?? 1;
  g.push(`[${cur}]${op < 1 ? `format=rgba,colorchannelmixer=aa=${op},` : ''}setpts=PTS+${st.toFixed(3)}/TB[${p}o]`);
  g.push(`[${p}a][${p}o]overlay=eof_action=pass:enable='between(t,${st.toFixed(3)},${en.toFixed(3)})'[${p}]`);
  return p;
}

// overlays in track order (V2 first, a higher track on top); adjustment layers act on what is below them
ovl.forEach((x, k) => {
  const c = x.clip, st = x.start, en = x.end;
  if (c.type === 'adjust') { v = adjustLayer(c, v, st, en, k); return; }
  if (c.type !== 'video' && c.type !== 'image') return; // titles are drawn after the film look (below)
  const s = ovSegs.get(x);
  if (!s) return; // (outside In-Out: not made)
  const i = n++;
  inputs.push('-i', s.file);
  const op = c.opacity ?? 1;
  // keyframed opacity: per-frame alpha (geq's T = seconds into the clip, before it is moved to its start)
  // green screen on an overlay: keyed here so the shot below shows through
  const key = activeEffects(c).find((e) => e.type === 'chromakey');
  let keyF = key ? `${VFX.chromakey.key(key.p || {})},` : '', src = `${i}:v`;
  // ◐ Opacity mask: the shot below shows outside it (where Motion has put the picture)
  if (c.omask?.shape) {
    const mk = finalMask(maskPng(movedMask(c.omask, c.transform)), en - st + 0.5);
    g.push(`[${src}]${keyF}format=yuva420p[oma${k}]`, `[oma${k}][${mk}]alphamerge[omb${k}]`);
    src = `omb${k}`; keyF = '';
  }
  const opA = c.keys?.opacity?.length ? `format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${key || c.omask?.shape ? 'alpha(X,Y)' : '255'}*clip(${keysExpr(c.keys.opacity, 'T')},0,1)',` : op < 1 ? `format=rgba,colorchannelmixer=aa=${op},` : '';
  g.push(c.blend ? `[${src}]${keyF}setpts=PTS-STARTPTS[ov${k}]` : `[${src}]${keyF}${opA}setpts=PTS-STARTPTS+${st.toFixed(3)}/TB[ov${k}]`);
  if (c.blend) {
    g.push(`[ov${k}]tpad=start_duration=${st.toFixed(3)}:color=black,format=gbrp[ob${k}]`, `[${v}]format=gbrp[ub${k}]`,
      `[ub${k}][ob${k}]blend=all_mode=${c.blend}:all_opacity=${Math.min(1, op).toFixed(2)}:eof_action=pass:enable='between(t,${st.toFixed(3)},${en.toFixed(3)})',format=yuv420p[vo${k}]`);
  } else g.push(`[${v}][ov${k}]overlay=eof_action=pass:enable='between(t,${st.toFixed(3)},${en.toFixed(3)})'[vo${k}]`);
  v = `vo${k}`;
  if (!ts[x.track]?.mute && !c.mute && (c.volume ?? 0) > 0) {
    const ms = Math.round(st * 1000);
    g.push(`[${i}:a]${fxOf(x.track)}volume=${c.volume},adelay=${ms}|${ms},${AFMT}[v2a${k}]`);
    speechLabels.push(`v2a${k}`);
  }
});

// Cinematic finish: vignette, film grain and letterbox bars over the picture (titles, logo and subtitles stay on top)
{
  const lk = S.look || {}, fx = [];
  // the film look (LUTs/Looks) goes over the whole picture so every shot shares one colour; mix = strength 0..1
  const lookPath = lk.lut && job.luts?.[lk.lut];
  if (lookPath && fs.existsSync(lookPath)) {
    const mixK = Math.min(1, Math.max(0, lk.mix ?? 1)), f = `lut3d=file=${stageLut(lookPath)}:interp=tetrahedral`;
    if (mixK >= 0.99) g.push(`[${v}]${f}[vlut]`);
    else g.push(`[${v}]split[lka][lkb]`, `[lkb]${f}[lkc]`, `[lka][lkc]blend=all_mode=normal:all_opacity=${mixK.toFixed(2)}[vlut]`);
    v = 'vlut';
  }
  if (+lk.vignette > 0) fx.push(`vignette=angle=${(0.25 + 0.4 * Math.min(1, +lk.vignette)).toFixed(3)}`);
  if (+lk.grain > 0) fx.push(`noise=alls=${Math.round(4 + 14 * Math.min(1, +lk.grain))}:allf=t`);
  const ratio = { '2.39': 2.39, '2.0': 2, '1.85': 1.85 }[lk.letterbox];
  if (ratio && W / H < ratio) { const bar = Math.round((H - W / ratio) / 2); if (bar > 1) fx.push(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`, `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`); }
  if (fx.length) { g.push(`[${v}]${fx.join(',')}[vlook]`); v = 'vlook'; }
}

// V2 titles: transparent text over the picture, with a short fade in/out
const titles = ovl.filter((x) => x.clip.type === 'title');
if (titles.length) {
  const tf = titles.map((x) => {
    const s = x.start, e = x.end, f = Math.min(0.3, (e - s) / 4);
    if (isKinetic(x.clip)) {
      // kinetic: one drawtext per word window; 'words' punches each word in big, 'build' adds them up at one size
      const c = x.clip, ws = wordWindows(c, s, e), full = String(c.text || '').replace(/\s+/g, ' ');
      const sizeOf = (w) => c.size || (c.anim === 'words' ? Math.min(150, (FW * 0.78) / (Math.max(3, [...w].length) * 0.7 * 1.25)) : Math.min(FH * 0.07, (FW * 0.88) / (Math.max(8, [...full].length) * 0.58)));
      return ws.map((w, i) => drawtext(w.text, {
        style: c.textStyle || 'center', size: sizeOf(c.anim === 'words' ? w.text : full), color: c.textColor || 'white', ...titleLook(c),
        box: !!(c.box && c.box !== 'none'), pop: c.anim === 'words' ? w.a : null,
        enable: `:enable='between(t,${w.a.toFixed(3)},${w.b.toFixed(3)})'`,
        alpha: `:alpha='${i === ws.length - 1 ? `if(gt(t,${(e - f).toFixed(3)}),(${e.toFixed(3)}-t)/${f.toFixed(3)},min(1,(t-${w.a.toFixed(3)})/0.06))` : `min(1,(t-${w.a.toFixed(3)})/0.06)`}'`,
      })).join(',');
    }
    const fk = x.clip.follow, follow = fk?.x?.length ? { x: `(${keysExpr(fk.x, `(t-${s.toFixed(3)})`)})*${W}/100`, y: `(${keysExpr(fk.y, `(t-${s.toFixed(3)})`)})*${H}/100` } : null;
    return drawtext(x.clip.text || '', { follow,
      style: x.clip.textStyle || 'center', size: x.clip.size, color: x.clip.textColor || 'white', ...titleLook(x.clip),
      box: x.clip.box ? x.clip.box !== 'none' : x.clip.textStyle !== 'center', slide: x.clip.anim === 'slide' ? s : null,
      enable: `:enable='between(t,${s.toFixed(3)},${e.toFixed(3)})'`,
      alpha: x.clip.anim === 'none' ? '' : `:alpha='if(lt(t,${(s + f).toFixed(3)}),(t-${s.toFixed(3)})/${f.toFixed(3)},if(gt(t,${(e - f).toFixed(3)}),(${e.toFixed(3)}-t)/${f.toFixed(3)},1))'`,
    });
  });
  g.push(`[${v}]${tf.join(',')}[vt]`); v = 'vt';
}

// 📊 motion graphics (baked by the editor at the edit's own frame size, transparent); a reframed export fits them in
ovl.filter((x) => x.clip.type === 'graphic').forEach((x, k) => {
  const [BW, BH] = ASPECTS[S.aspect] || ASPECTS['16:9'], f = path.join(job.gfxDir || '', `${gfxKey(x.clip.gfx, BW, BH, S.fps, x.end - x.start)}.mov`);
  if (!job.gfxDir || !fs.existsSync(f)) die('a motion graphic is not prepared - open the project in the editor and render again');
  const i = n++, st = x.start.toFixed(3), en = x.end.toFixed(3);
  inputs.push('-i', f);
  g.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,format=rgba,setpts=PTS-STARTPTS+${st}/TB[gx${k}]`);
  g.push(`[${v}][gx${k}]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:enable='between(t,${st},${en})'[vg${k}]`); v = `vg${k}`;
});

if (project.logo?.mediaId && media[project.logo.mediaId]) {
  const L = project.logo, i = n++, m = Math.round(W * 0.04);
  inputs.push('-i', media[L.mediaId].path);
  const pos = { tl: `${m}:${m}`, tr: `W-w-${m}:${m}`, bl: `${m}:H-h-${m}`, br: `W-w-${m}:H-h-${m}` }[L.pos || 'tr'];
  g.push(`[${i}:v]scale=${Math.round(W * (L.scale ?? 0.12))}:-1,format=rgba,colorchannelmixer=aa=${L.opacity ?? 0.9}[lg]`);
  g.push(`[${v}][lg]overlay=${pos}[vl]`); v = 'vl';
}

// Captions edited in the app (public/js/captions.js) win over a subtitles file
const caps = project.captions?.on && project.captions.cues?.length ? project.captions : null;
if (caps) {
  fs.writeFileSync(path.join(wd, 'captions.ass'), buildAss(caps, W, H), 'utf8');
  fs.mkdirSync(path.join(wd, 'fonts'), { recursive: true });
  for (const f2 of [...FONTS.latin, ...FONTS.deva, 'C:/Windows/Fonts/ariblk.ttf', 'C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/verdanab.ttf', 'C:/Windows/Fonts/georgiab.ttf', 'C:/Windows/Fonts/impact.ttf', 'C:/Windows/Fonts/mangal.ttf']) if (fs.existsSync(f2)) fs.copyFileSync(f2, path.join(wd, 'fonts', path.basename(f2)));
  g.push(`[${v}]subtitles=captions.ass:fontsdir=fonts[vcap]`); v = 'vcap';
}
if (!caps && project.subtitles?.file && job.subtitlesPath && fs.existsSync(job.subtitlesPath)) {
  const ext = path.extname(job.subtitlesPath).toLowerCase(), body = fs.readFileSync(job.subtitlesPath, 'utf8');
  fs.writeFileSync(path.join(wd, `subs${ext}`), body, 'utf8');
  fs.mkdirSync(path.join(wd, 'fonts'), { recursive: true });
  for (const f of [...FONTS.latin, ...FONTS.deva]) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(wd, 'fonts', path.basename(f)));
  let style = '';
  if (ext === '.srt') {
    const vertical = FH > FW;
    const st = { FontName: DEVA.test(body) ? 'Nirmala UI' : 'Arial', FontSize: vertical ? 11 : 18, Bold: 1, PrimaryColour: '&H00FFFFFF',
      OutlineColour: '&H00000000', BorderStyle: 1, Outline: 2, Shadow: 0, MarginV: vertical ? 70 : 28, ...(project.subtitles.style || {}) };
    style = `:force_style='${Object.entries(st).map(([k, x]) => `${k}=${x}`).join(',')}'`;
  }
  g.push(`[${v}]subtitles=subs${ext}:fontsdir=fonts${style}[vs]`); v = 'vs';
}
g.push(`[${v}]format=yuv420p[vout]`);

// Audio tracks: each clip trimmed, faded and placed at its start; A1 joins the speech bus, A2 is ducked under speech.
function trackBus(id) {
  if (!audible(id)) return null;
  const labels = [];
  (P[id] || []).forEach((x, k) => {
    const c = x.clip, m = media[c.mediaId];
    if (!m || !m.hasAudio) return;
    const i = n++, len = x.end - x.start, tin = +c.in || 0, speed = c.speed || 1;
    const fi = c.fadeIn || 0, fo = c.fadeOut || 0, ms = Math.round(x.start * 1000);
    let chain;
    if (c.loop) {
      const seg = Math.max(0.5, (c.out ?? m.duration) - tin);
      inputs.push('-i', m.path);
      chain = `[${i}:a]${AFMT},atrim=start=${tin}:end=${tin + seg},asetpts=PTS-STARTPTS,aloop=loop=-1:size=${Math.ceil(seg * 48000)},atrim=0:${len.toFixed(3)},asetpts=PTS-STARTPTS`;
    } else {
      inputs.push('-ss', String(tin), '-t', String(len * speed), '-i', m.path);
      chain = `[${i}:a]asetpts=PTS-STARTPTS,${c.reverse ? 'areverse,' : ''}${clipFx(c)}${speed !== 1 ? `${speedAudio(c, speed)},` : ''}${AFMT}`;
    }
    chain += `,${volumeFilter(c)}${fi ? `,afade=t=in:d=${fi}` : ''}${fo ? `,afade=t=out:st=${Math.max(0, len - fo).toFixed(3)}:d=${fo}` : ''}`;
    chain += `,adelay=${ms}|${ms}[${id}c${k}]`;
    g.push(chain);
    labels.push(`${id}c${k}`);
  });
  if (!labels.length) return null;
  const vol = ts[id]?.volume ?? 1;
  g.push(`${labels.map((l) => `[${l}]`).join('')}${labels.length > 1 ? `amix=inputs=${labels.length}:normalize=0,` : ''}${fxOf(id)}volume=${vol}[${id}bus]`);
  return `${id}bus`;
}
// 🔗 a track carrying clips' own sound (linked [A] clips) joins the speech bus like the clip sound always did:
// the music ducks under it
const isClipSound = (id) => (project.tracks[id] || []).some((c) => c.link);
const a1 = trackBus('A1'), a2 = trackBus('A2');
const a3 = isClipSound('A3') ? null : trackBus('A3');
// A4, A5…: more sound effects / audio, mixed like A3
const aMore = audioTracks(project).filter((id) => !['A1', 'A2', 'A3'].includes(id) && !isClipSound(id)).map(trackBus).filter(Boolean);
const aSpeech = audioTracks(project).filter((id) => id !== 'A1' && id !== 'A2' && isClipSound(id)).map(trackBus).filter(Boolean);
if (a1) speechLabels.push(a1);
speechLabels.push(...aSpeech);
g.push(...speechParts);
g.push(`${speechLabels.map((l) => `[${l}]`).join('')}${speechLabels.length > 1 ? `amix=inputs=${speechLabels.length}:normalize=0:duration=first` : 'anull'}[speech]`);
let mixIn = ['speech'];
if (a2) {
  const duck = project.tracks.A2.some((c) => c.duck);
  // duck depth 6..30 dB -> compressor ratio; lower threshold = ducks for quieter speech too
  const depth = ts.A2?.duckDepth ?? 14, duckRatio = Math.min(20, Math.max(1.5, 1 + (depth - 4) * 0.7)).toFixed(2);
  const duckThr = (ts.A2?.duckThreshold ?? 0.02).toFixed(4), duckRel = Math.round(ts.A2?.duckRelease ?? 400);
  if (duck) {
    g.push('[speech]asplit=2[sp1][sp2]', `[${a2}][sp2]sidechaincompress=threshold=${duckThr}:ratio=${duckRatio}:attack=15:release=${duckRel}[a2d]`);
    mixIn = ['sp1', 'a2d'];
  } else mixIn.push(a2);
}
if (a3) mixIn.push(a3);
mixIn.push(...aMore);
g.push(`${mixIn.map((l) => `[${l}]`).join('')}${mixIn.length > 1 ? `amix=inputs=${mixIn.length}:normalize=0:duration=first` : 'anull'}[mix]`);
const lufs = EX.loudness ?? S.loudness ?? -14;
// loudnorm's true-peak control is approximate and AAC encoding adds inter-sample peaks, so a final limiter at
// about -2 dBFS keeps delivered files under the -1 dBTP that Instagram / YouTube / broadcast specs ask for.
g.push(lufs === false || lufs === 'off' ? '[mix]anull[aout]' : `[mix]loudnorm=I=${lufs}:TP=-2:LRA=11,${AFMT},alimiter=limit=0.79:attack=3:release=60:level=false[aout]`);

fs.mkdirSync(path.dirname(path.resolve(job.output)), { recursive: true });
// Final encode: ProRes 422 HQ for editing/broadcast hand-off, otherwise H.264 under the preset's bitrate ceiling.
let finalEnc, cpuEnc;
if (!job.preview && EX.codec === 'prores') {
  finalEnc = ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', '-r', String(F), '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2'];
} else {
  finalEnc = ENC(job.preview ? (FAST ? 27 : 21) : EX.crf ?? S.crf ?? 20, job.preview ? (FAST ? 'ultrafast' : 'veryfast') : 'medium');
  if (!job.preview && EX.codec === 'hevc') {
    // H.265: about half the size of H.264 at the same quality; hvc1 tag so Apple devices / QuickTime play it
    const i = finalEnc.indexOf('libx264'); finalEnc.splice(i, 1, 'libx265'); finalEnc.push('-tag:v', 'hvc1', '-x265-params', 'log-level=error');
  }
  cpuEnc = finalEnc.slice();
  if (!job.preview && NV) {
    // NVIDIA encoder: much faster for 4K; constant-quality mode instead of CRF
    const c = finalEnc.indexOf('-c:v'), cq = finalEnc[finalEnc.indexOf('-crf') + 1];
    finalEnc.splice(c, 6, '-c:v', EX.codec === 'hevc' ? 'hevc_nvenc' : 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', String(+cq + 2), '-b:v', '0');
    const t = finalEnc.indexOf('-x265-params'); if (t >= 0) finalEnc.splice(t, 2);
  }
  if (!job.preview) {
    const abr = EX.abr || 192;
    finalEnc[finalEnc.indexOf('-b:a') + 1] = `${abr}k`;
    cpuEnc[cpuEnc.indexOf('-b:a') + 1] = `${abr}k`;
    let cap = EX.maxrate || 0;
    if (EX.sizeMB) cap = Math.min(cap || Infinity, Math.max(300, Math.floor((EX.sizeMB * 8192 * 0.95) / D - abr)));
    if (cap) for (const e of [finalEnc, cpuEnc]) e.push('-maxrate', `${cap}k`, '-bufsize', `${cap * 2}k`);
  }
}
const finalArgs = [...inputs.map((x, i) => (inputs[i - 1] === '-i' ? short(x) : x)), ...fcArgs(g.join(';')), '-map', '[vout]', '-map', '[aout]', ...(R ? ['-ss', R.in.toFixed(3), '-t', (R.out - R.in).toFixed(3)] : ['-t', String(D)])];
const gpuFinal = !!(!job.preview && NV && EX.codec !== 'prores');
// GPU: the system FFmpeg filters and sends raw frames + audio (NUT) down a pipe to the encoder FFmpeg
function ffPipe(args, enc, out) {
  return new Promise((ok) => {
    const a = spawn('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', '-stats', ...args, '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_f32le', '-f', 'nut', 'pipe:1'],
      { cwd: wd, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    const b = spawn(NV, ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'nut', '-i', 'pipe:0', ...enc, out], { cwd: wd, stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true });
    a.stdout.pipe(b.stdin);
    b.stdin.on('error', () => {});
    let codes = [];
    const done = (k) => (c) => { codes[k] = c; if (codes.length === 2 && codes.every((x) => x !== undefined)) ok(codes[0] === 0 && codes[1] === 0); };
    a.on('close', done(0)); b.on('close', done(1));
    a.on('error', () => ok(false)); b.on('error', () => ok(false));
  });
}
const outFile = path.resolve(job.output);
if (!gpuFinal || !(await ffPipe(finalArgs, [...finalEnc, '-movflags', '+faststart'], outFile))) {
  if (gpuFinal) console.log('GPU encoder failed - finishing on the CPU');
  ff([...finalArgs, ...(cpuEnc || finalEnc), '-movflags', '+faststart', outFile]);
}
if (!job.keep) fs.rmSync(wd, { recursive: true, force: true });
if (reused) console.log(`Reused ${reused} unchanged shot${reused > 1 ? 's' : ''} from earlier renders`);
try { trimCache(); } catch {}
console.log(JSON.stringify({ output: job.output, duration: +(R ? R.out - R.in : D).toFixed(2), width: W, height: H }));
