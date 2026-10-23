// 🎞 Custom templates (Library/graphics/<id>/): After Effects / Premiere MOGRTs, logo animations, any video with
// transparency (ProRes 4444 / QuickTime Animation / PNG .mov, VP9 .webm with alpha) or an image sequence, kept once for
// every project. Each becomes
//   master.mov    ProRes 4444 with its alpha (what renders use - a copy goes into the project that uses it)
//   preview.webm  VP9 with alpha, small (what the browser's monitor plays)
//   thumb.png     a frame from the middle, transparent where the template is
//   template.json { id, name, kind, source, alpha, width, height, fps, duration, hasAudio, fields, tags, saved, by }
// A MOGRT's live After Effects composition cannot be rendered again here (that needs After Effects): its rendered video
// is used as it is, and its text fields (definition.json) are listed so they can be added as the editor's own text.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const VIDEO = /\.(mov|mp4|m4v|webm|mkv|avi|mxf)$/i, FRAME = /^(.*?)(\d+)\.(png|tga|tiff?|jpe?g|bmp|exr|dpx)$/i;
const ZIPS = /\.(mogrt|zip|aegraphic|prgraphic)$/i;

function run(cmd, args) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '', errs = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (errs = (errs + d).slice(-4000)));
    p.on('error', (e) => ok({ code: -1, stdout: '', stderr: String(e.message) }));
    p.on('close', (code) => ok({ code, stdout: out, stderr: errs }));
  });
}

// ---- a .zip / .mogrt read in memory (stored and deflated entries, zip64 sizes) ----
export function unzip(buf) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('Not a zip file (a .mogrt is a zip - this one could not be opened)');
  let n = buf.readUInt16LE(e + 10), off = buf.readUInt32LE(e + 16);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('The zip is damaged');
    const method = buf.readUInt16LE(off + 10), nl = buf.readUInt16LE(off + 28), xl = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32);
    let csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24), loc = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nl);
    // zip64: the real sizes / offset are in the 0x0001 extra field, in this order, for the ones that are 0xFFFFFFFF
    for (let x = off + 46 + nl; x < off + 46 + nl + xl - 4;) {
      const id = buf.readUInt16LE(x), sz = buf.readUInt16LE(x + 2);
      if (id === 1) {
        let p = x + 4;
        if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(p)); p += 8; }
        if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(p)); p += 8; }
        if (loc === 0xffffffff) loc = Number(buf.readBigUInt64LE(p));
      }
      x += 4 + sz;
    }
    off += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
    out.push({ name, size: usize, data: () => {
      const raw = buf.subarray(start, start + csize);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`${name}: packed in a way this editor cannot open (method ${method})`);
    } });
  }
  return out;
}

// every file of a zip into dir (names cleaned: nothing outside dir); zips inside it (a MOGRT's project.aegraphic /
// .prgraphic) are opened too, into <name>_files
export async function extractAll(file, dir, depth = 0) {
  const entries = unzip(await fsp.readFile(file));
  for (const en of entries) {
    const rel = en.name.replace(/\\/g, '/').split('/').filter((s) => s && s !== '..' && !/^[a-z]:$/i.test(s)).join(path.sep);
    if (!rel) continue;
    const to = path.join(dir, rel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.writeFile(to, en.data());
    if (depth < 2 && ZIPS.test(to)) await extractAll(to, `${to}_files`, depth + 1).catch(() => {});
  }
}

// ---- a MOGRT's definition.json: its name and the text it lets you change ----
const strOf = (v) => (typeof v === 'string' ? v : Array.isArray(v?.strDB) ? (v.strDB.find((s) => /^en/i.test(s.localeString || ''))?.str ?? v.strDB[0]?.str) : null);
export function mogrtInfo(def) {
  const fields = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    for (const c of Array.isArray(o.clientControls) ? o.clientControls : []) {
      const label = strOf(c.uiName) ?? c.name ?? '', value = strOf(c.value);
      // text controls (type 6 in After Effects / Premiere MOGRTs) - a slider, colour or checkbox has no words
      if ((c.type === 6 || c.type === 'text' || (typeof value === 'string' && c.type == null)) && typeof value === 'string')
        fields.push({ id: String(c.id ?? fields.length), name: String(label || `Text ${fields.length + 1}`).slice(0, 80), value: value.slice(0, 500) });
    }
    for (const [k, v] of Object.entries(o)) if (k !== 'clientControls' && v && typeof v === 'object') walk(v);
  };
  walk(def);
  const name = strOf(def?.capsuleName) ?? def?.sourceInfoLocalized?.en_US?.name ?? (typeof def?.name === 'string' ? def.name : null);
  return { name: name ? String(name).slice(0, 80) : null, fields: fields.filter((f, i) => fields.findIndex((g) => g.id === f.id) === i) };
}

// the biggest numbered run of frames in a folder tree: { dir, pattern (FFmpeg %0Nd), start, count, ext }
export function findSequence(files) {
  const groups = new Map();
  for (const f of files) {
    const m = FRAME.exec(path.basename(f)); if (!m) continue;
    const key = `${path.dirname(f)}|${m[1]}|${m[2].length}|${m[3].toLowerCase()}`;
    const g = groups.get(key) || { dir: path.dirname(f), prefix: m[1], digits: m[2].length, ext: m[3], nums: [] };
    g.nums.push(+m[2]); groups.set(key, g);
  }
  const best = [...groups.values()].filter((g) => g.nums.length >= 2).sort((a, b) => b.nums.length - a.nums.length)[0];
  if (!best) return null;
  return { dir: best.dir, pattern: `${best.prefix.replace(/%/g, '%%')}%0${best.digits}d.${best.ext}`, start: Math.min(...best.nums), count: best.nums.length, ext: best.ext };
}

export const ALPHA_FMT = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya\d|rgba64|bgra64)/;
export async function probe(file) {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) return null;
  const j = JSON.parse(r.stdout), v = j.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1), a = j.streams.find((s) => s.codec_type === 'audio');
  if (!v) return null;
  const [fn, fd] = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number);
  const vp9Alpha = /^(1|true)$/i.test(v.tags?.alpha_mode || v.tags?.ALPHA_MODE || '');
  return { duration: +(+j.format.duration || +v.duration || 0).toFixed(3), width: v.width, height: v.height, fps: fd ? +(fn / fd).toFixed(3) : 0,
    vcodec: v.codec_name, pixfmt: v.pix_fmt, alpha: ALPHA_FMT.test(v.pix_fmt || '') || vp9Alpha, vp9Alpha, hasAudio: !!a, size: +j.format.size || 0 };
}

async function walkFiles(dir, out = []) {
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, d.name);
    if (d.isDirectory()) await walkFiles(f, out); else out.push(f);
  }
  return out;
}

// what a MOGRT / zip / folder holds to use: the video with transparency first, then the longest video, then frames
async function pickSource(dir) {
  const files = await walkFiles(dir), vids = [];
  for (const f of files.filter((x) => VIDEO.test(x))) { const p = await probe(f); if (p && p.duration > 0) vids.push({ file: f, ...p }); }
  vids.sort((a, b) => (b.alpha - a.alpha) || (b.duration * b.width - a.duration * a.width));
  const seq = findSequence(files);
  if (vids[0]?.alpha || !seq) return vids[0] ? { video: vids[0], files } : { files };
  return { seq, files };
}

// src: the uploaded / picked file or folder; dir: the new template's folder (made here). Returns template.json.
export async function importTemplate({ src, origName = path.basename(src), dir, name = '', fps = 30, by = '', onStage = () => {} }) {
  await fsp.mkdir(dir, { recursive: true });
  const work = path.join(dir, '_src'), st = await fsp.stat(src);
  let kind = 'video', info = { name: null, fields: [] }, pick;
  try {
    if (st.isDirectory()) { kind = 'sequence'; pick = await pickSource(src); }
    else if (ZIPS.test(origName) || ZIPS.test(src)) {
      onStage('Opening the template…');
      await extractAll(src, work);
      kind = /\.mogrt$/i.test(origName) ? 'mogrt' : 'zip';
      const all = await walkFiles(work), defs = all.filter((f) => /definition\.json$/i.test(f));
      for (const d of defs) { try { const x = mogrtInfo(JSON.parse((await fsp.readFile(d, 'utf8')).replace(/^﻿/, ''))); info = { name: info.name || x.name, fields: [...info.fields, ...x.fields] }; } catch {} }
      pick = await pickSource(work);
    } else {
      const p = await probe(src);
      if (!p) throw new Error(`${origName}: not a video this editor can read`);
      pick = { video: { file: src, ...p } };
    }
    if (!pick.video && !pick.seq) throw new Error(kind === 'mogrt'
      ? 'This MOGRT has no rendered video inside it (only its After Effects project, which needs After Effects to play). In After Effects render the composition as QuickTime - Apple ProRes 4444 with RGB + Alpha - and import that .mov instead.'
      : 'No video or numbered image frames found in it');
    if (pick.seq) kind = kind === 'video' ? 'sequence' : kind;
    onStage('Making the master copy (ProRes 4444 with transparency)…');
    const master = path.join(dir, 'master.mov');
    const input = pick.video
      ? [...(pick.video.vp9Alpha ? ['-c:v', 'libvpx-vp9'] : []), '-i', pick.video.file]
      : ['-framerate', String(fps), '-start_number', String(pick.seq.start), '-i', path.join(pick.seq.dir, pick.seq.pattern)];
    let r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0', '-c:a', 'pcm_s16le', master]);
    if (r.code !== 0) throw new Error(`Could not read the template's video: ${r.stderr.trim().split(/\r?\n/).pop()}`);
    const m = await probe(master);
    if (!m) throw new Error('The master copy could not be read back');
    const alpha = pick.video ? pick.video.alpha : /png|tga|tiff?|exr/i.test(pick.seq.ext);
    onStage('Making the preview copy for the monitor…');
    r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', master, '-vf', `scale='min(1280,iw)':-2,format=${alpha ? 'yuva420p' : 'yuv420p'}`,
      '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-auto-alt-ref', '0', '-c:a', 'libopus', '-b:a', '96k', path.join(dir, 'preview.webm')]);
    if (r.code !== 0) throw new Error(`Could not make the preview copy: ${r.stderr.trim().split(/\r?\n/).pop()}`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String((m.duration * 0.6).toFixed(3)), '-i', master, '-frames:v', '1', '-vf', 'scale=320:-2', path.join(dir, 'thumb.png')]);
    const t = {
      id: path.basename(dir), name: String(name || info.name || path.parse(origName).name).trim().slice(0, 80) || 'Template', kind, source: origName,
      alpha, width: m.width, height: m.height, fps: m.fps || fps, duration: m.duration, hasAudio: m.hasAudio, fields: info.fields.slice(0, 40),
      // (no transparency - a MOGRT's preview on black: Screen blend lets the shots below show through the black)
      blend: alpha ? null : 'screen', tags: [], saved: Date.now(), by,
    };
    await fsp.writeFile(path.join(dir, 'template.json'), JSON.stringify(t, null, 1));
    return t;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export const newTemplateId = () => crypto.randomBytes(5).toString('hex');
export async function listTemplates(libDir) {
  let ds = [];
  try { ds = await fsp.readdir(libDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of ds.filter((x) => x.isDirectory() && /^[0-9a-f]{10}$/.test(x.name))) {
    try { out.push(JSON.parse(await fsp.readFile(path.join(libDir, d.name, 'template.json'), 'utf8'))); } catch {}
  }
  return out.sort((a, b) => (b.saved || 0) - (a.saved || 0));
}
export const templateDir = (libDir, id) => {
  if (!/^[0-9a-f]{10}$/.test(String(id || ''))) throw Object.assign(new Error('unknown template'), { code: 404 });
  return path.join(libDir, id);
};
export const exists = (f) => fs.promises.access(f).then(() => true, () => false);
