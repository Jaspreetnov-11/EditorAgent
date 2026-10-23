// analyze.mjs - per-second facts about a clip for the agent (cached): motion, loudness, brightness, blur, shot cuts,
// plus small frames for CLIP. Uses async processes so the server stays responsive.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function run(cmd, args, { onErr } = {}) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '', part = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      const s = String(d); err += s; if (err.length > 4e6) err = err.slice(-2e6);
      if (onErr) { const lines = (part + s).split(/\r?\n/); part = lines.pop(); lines.forEach(onErr); }
    });
    p.on('error', (e) => ok({ code: -1, stdout: out, stderr: String(e) }));
    p.on('close', (code) => ok({ code, stdout: out, stderr: err }));
  });
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// Facts per second: motion (scene score), luma (0..255), blur (blurdetect, higher = softer), loud (LUFS momentary).
// keyOnly: big camera originals (4K HEVC / high frame rate) are read once, decoding only their keyframes (about one or
// two a second - all this needs) with the loudness measured in the same pass; 3-10x faster than decoding every frame.
// framesDir: also write the CLIP frames (as extractFrames would) in that same pass - one read of the file instead of three.
// remote(args, { inputs, outs }): the same FFmpeg run on a 🖥 helper PC (server.mjs runMedia, spread over every helper that
// is on) - resolves its { code, stdout, stderr } or null when no helper took it, and then it runs here as before. A
// helper writes one file per output, so there the CLIP frames come as one MJPEG stream that is cut into the JPGs here.
// onlyRemote: no helper took it - give up (null) instead of running it here (🌙 the night shift never loads the editor).
export async function analyzeClip(file, cacheFile, { hasAudio = true, duration = 0, keyOnly = false, framesDir = null, remote = null, onlyRemote = false } = {}) {
  const st = fs.statSync(file);
  if (cacheFile && fs.existsSync(cacheFile)) {
    try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c.v === 3 && c.size === st.size && c.mtime === st.mtimeMs) return c; } catch {}
  }
  const secs = Math.max(1, Math.ceil(duration || 1));
  const motion = Array.from({ length: secs }, () => []), luma = Array.from({ length: secs }, () => []), blur = Array.from({ length: secs }, () => []);
  const cuts = [];
  let t = 0;
  const vf = "scale=320:-2,blurdetect=block_width=32:block_height=32,select='gte(scene,0)',signalstats,metadata=print";
  const fr = keyOnly && framesDir ? framesPlan(framesDir, duration) : null;
  const keyArgs = (framesOut) => ['-hide_banner', '-nostats', '-y', '-skip_frame', 'nokey', '-i', file, '-map', '0:v:0', '-an', '-vf', vf, '-f', 'null', '-',
    ...(hasAudio ? ['-map', '0:a:0?', '-vn', '-af', 'ebur128', '-f', 'null', '-'] : []),
    ...(fr && !fr.done ? ['-map', '0:v:0', '-an', '-vf', `fps=1/${fr.step.toFixed(3)}:round=near,scale=-2:224`, '-q:v', '5', ...framesOut] : [])];
  const allArgs = ['-hide_banner', '-nostats', '-i', file, '-an', '-vf', `fps=2,${vf}`, '-f', 'null', '-'];
  let r = null;
  if (remote) {
    const mj = fr && !fr.done ? path.join(framesDir, '_frames.mjpeg') : null;
    r = await remote(keyOnly ? keyArgs(mj ? ['-f', 'mjpeg', mj] : []) : allArgs, { inputs: [file], outs: mj ? [mj] : [] }).catch(() => null);
    if (r?.code !== 0 || (mj && !splitMjpeg(mj, framesDir))) r = null;
  }
  if (!r && onlyRemote) return null;
  r ||= keyOnly ? await run('ffmpeg', keyArgs([path.join(framesDir || '.', '%04d.jpg')])) : await run('ffmpeg', allArgs);
  if (fr && !fr.done) fr.finish();
  for (const line of r.stderr.split(/\r?\n/)) {
    let m;
    if ((m = /pts_time:([\d.]+)/.exec(line))) t = +m[1];
    else if ((m = /lavfi\.scene_score=([\d.]+)/.exec(line))) {
      const s = +m[1], k = Math.min(secs - 1, Math.floor(t));
      motion[k].push(s);
      if (s > 0.3 && t > 0.3 && !(cuts.length && t - cuts[cuts.length - 1] < 0.4)) cuts.push(+t.toFixed(2));
    } else if ((m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line))) luma[Math.min(secs - 1, Math.floor(t))].push(+m[1]);
    else if ((m = /lavfi\.blur=([\d.]+)/.exec(line))) blur[Math.min(secs - 1, Math.floor(t))].push(+m[1]);
  }
  const loud = new Array(secs).fill(null);
  if (hasAudio) {
    const loudArgs = ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'];
    let a = keyOnly ? r : null;
    if (!a && remote) { a = await remote(loudArgs, { inputs: [file], outs: [] }).catch(() => null); if (a?.code !== 0) a = null; }
    if (!a && onlyRemote) return null;
    a ||= await run('ffmpeg', loudArgs);
    const lo = Array.from({ length: secs }, () => []);
    for (const m of a.stderr.matchAll(/t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+|-inf)/g)) lo[Math.min(secs - 1, Math.floor(+m[1]))].push(m[2] === '-inf' ? -70 : +m[2]);
    lo.forEach((x, i) => (loud[i] = x.length ? mean(x) : null));
  }
  const res = { v: 3, size: st.size, mtime: st.mtimeMs, duration, motion: motion.map(mean), luma: luma.map((x) => (x.length ? mean(x) : 128)), blur: blur.map((x) => (x.length ? mean(x) : 0)), loud, cuts };
  if (cacheFile) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(res)); }
  return res;
}

// CLIP frames written by analyzeClip's single pass (keyframes nearest to every `step` seconds from 0), in the same
// folder and with the same marker as extractFrames, so extractFrames finds them done.
function framesPlan(dir, duration) {
  fs.mkdirSync(dir, { recursive: true });
  const step = Math.min(4, Math.max(1, duration / 30)), marker = path.join(dir, `done-${step.toFixed(3)}.json`);
  if (fs.existsSync(marker)) return { step, done: true };
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  return { step, done: false, finish: () => {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
    if (!files.length) return;
    fs.writeFileSync(marker, JSON.stringify(files.map((f, i) => ({ t: +(i * step).toFixed(3), path: path.join(dir, f) })).filter((x) => x.t < duration)));
  } };
}

// Small frames for CLIP: one every `step` seconds (about 30 per clip, 1-4 s apart). Returns [{ t, path }].
// remote: as analyzeClip's - on a helper PC when one takes it (the frames as one MJPEG stream), else here.
export async function extractFrames(file, dir, { duration = 0, image = false, keyOnly = false, remote = null, onlyRemote = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const step = image ? 0 : Math.min(4, Math.max(1, duration / 30));
  const marker = path.join(dir, `done-${image ? 'img' : step.toFixed(3)}.json`);
  if (fs.existsSync(marker)) return JSON.parse(fs.readFileSync(marker, 'utf8'));
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  if (image) {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', 'scale=-2:224', '-update', '1', path.join(dir, '0001.jpg')]);
    const fr = [{ t: 0, path: path.join(dir, '0001.jpg') }];
    fs.writeFileSync(marker, JSON.stringify(fr));
    return fr;
  }
  // fps filter emits frame k at about k*step (the first at 0); shift by half a step so frames sit inside each second
  const args = (out) => ['-hide_banner', '-loglevel', 'error', '-y', ...(keyOnly ? ['-skip_frame', 'nokey'] : []), '-ss', (step / 2).toFixed(3), '-i', file, '-an', '-vf', `fps=1/${step.toFixed(3)},scale=-2:224`, '-q:v', '5', ...out];
  const mj = path.join(dir, '_frames.mjpeg');
  const there = remote ? await remote(args(['-f', 'mjpeg', mj]), { inputs: [file], outs: [mj] }).catch(() => null) : null;
  if (!(there?.code === 0 && splitMjpeg(mj, dir))) { if (onlyRemote) return null; await run('ffmpeg', args([path.join(dir, '%04d.jpg')])); }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
  const fr = files.map((f, i) => ({ t: +(step / 2 + i * step).toFixed(3), path: path.join(dir, f) })).filter((x) => x.t < duration);
  fs.writeFileSync(marker, JSON.stringify(fr));
  return fr;
}

// an MJPEG stream (JPEG after JPEG - a helper PC's frames in one file) cut into 0001.jpg, 0002.jpg… next to it; the
// stream is removed. false when it holds no picture (then the frames are made here).
export function splitMjpeg(file, dir) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return false; }
  fs.rmSync(file, { force: true });
  const starts = [];
  // a JPEG starts FF D8 FF; a new one starts right after the end (FF D9) of the one before
  for (let i = 0; i + 2 < buf.length; i++) if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff && (i === 0 || (buf[i - 2] === 0xff && buf[i - 1] === 0xd9))) starts.push(i);
  if (!starts.length) return false;
  starts.forEach((s, k) => fs.writeFileSync(path.join(dir, `${String(k + 1).padStart(4, '0')}.jpg`), buf.subarray(s, starts[k + 1] ?? buf.length)));
  return true;
}
