// Limelight Video Editor (v2) - local web app. Run: node server.mjs  ->  http://localhost:3000
//
// Every project lives in its own folder:  Projects/<name>/
//   project.json   timeline + settings          media.json   media pool (references to files, nothing is copied)
//   imports/       files uploaded through the browser (music, logos, VO...)
//   cache/         thumbs, filmstrips, waveforms, proxies (small H.264 copies the browser can play), analysis
//   subs/ renders/ backups/ luts/
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import dns from 'node:dns';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { newProject, uid, placed, clipDur, seqOf, seqHash, ASPECTS } from './public/js/model.js';
import { gfxKey } from './public/js/graphics.js';
import { ensureLuts, guessLogLut } from './engine/lutgen.mjs';
import { ensureLooks } from './engine/looklut.mjs';
import { keywords, searchStock, downloadStock } from './engine/stock.mjs';
import { measure, autoGrade, looksLog, matchGrade } from './engine/colorstats.mjs';
import { colorFilters, stager, isNeutral } from './engine/color.mjs';
import { exportTimeline } from './engine/nlexport.mjs';
import { presetById } from './public/js/presets.js';
import { applyOps } from './public/js/livepatch.js';
import { learnStyle, describeStyle } from './engine/editstyle.mjs';
import { analyzeClip, extractFrames } from './engine/analyze.mjs';
import { addBeat, prune as prunePresence, summary as presenceSummary, KEEP_DAYS } from './engine/presence.mjs';
import { toEnglishQuery } from './engine/searchwords.mjs';
import { ensureSfx, listSfx, SFX_KINDS } from './engine/sfx.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// VEDIT_DATA: where projects, settings and queues live (default: this folder). The auto-tests run a second editor
// with its own throwaway folder, so it never touches the real projects or the real render queue (tests/run.mjs --server).
const DATA = process.env.VEDIT_DATA ? path.resolve(process.env.VEDIT_DATA) : ROOT;
const PROJECTS = path.join(DATA, 'Projects');
const GLOBAL_LUTS = path.join(ROOT, 'LUTs');
fs.mkdirSync(PROJECTS, { recursive: true });
// 🗑 the Recycle Bin: deleted projects wait here (next to Projects) until restored or deleted for good. An older
// "Deleted projects" folder is taken in once.
const recycleBin = () => path.join(DATA, 'Recycle Bin');
{
  const old = path.join(DATA, 'Deleted projects');
  try {
    if (fs.existsSync(old)) {
      fs.mkdirSync(recycleBin(), { recursive: true });
      for (const e of fs.readdirSync(old)) if (!fs.existsSync(path.join(recycleBin(), e))) fs.renameSync(path.join(old, e), path.join(recycleBin(), e));
      if (!fs.readdirSync(old).length) fs.rmdirSync(old);
    }
  } catch {}
}
// 🧾 every delete / restore is written down (delete-log.jsonl next to Projects): when, who, what, how big
function binLog(req, action, project, bytes = 0) {
  try { fs.appendFileSync(path.join(DATA, 'delete-log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), who: req.who?.name || 'Owner', from: req.socket?.remoteAddress || '', action, project, mb: Math.round(bytes / 1048576) })}
`); } catch (e) { logCrash('delete log', e); }
}
// a folder inside the Recycle Bin (by its name only - never a path elsewhere)
function binEntry(folder) {
  const f = path.join(recycleBin(), path.basename(String(folder || '')));
  if (!folder || path.dirname(f) !== recycleBin() || !fs.existsSync(path.join(f, 'project.json'))) throw err(404, 'Not in the Recycle Bin');
  return f;
}
fs.mkdirSync(GLOBAL_LUTS, { recursive: true });
ensureLuts(GLOBAL_LUTS); // built-in LOG -> Rec.709 LUTs (S-Log3, LogC3, V-Log)
ensureLooks(path.join(GLOBAL_LUTS, 'Looks')); // cinematic looks that go over the whole edit
const STOCK = path.join(ROOT, 'Stock'); // your own stock clips; Stock/online = clips downloaded from Pexels / Pixabay
fs.mkdirSync(path.join(STOCK, 'online'), { recursive: true });
// presets, brand kit and project templates, shared by every project
const LIB = path.join(ROOT, 'Library');
fs.mkdirSync(path.join(LIB, 'templates'), { recursive: true });
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o && k in o).map((k) => [k, o[k]]));
const SFX = path.join(ROOT, 'SFX'); // sound effects: the built-in library (made once) + your own files dropped in here
let sfxReady = null;
const sfxMade = () => (sfxReady ||= ensureSfx(SFX).catch((e) => logCrash('sfx library', e)));
setTimeout(sfxMade, 3000); // made in the background shortly after start
// app settings (stock API keys) - kept only on this computer, never sent anywhere except the stock site they belong to
const CONFIG = path.join(DATA, 'config.json');
const config = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
// One bad request or background job must never take the whole editor down: log it and keep running.
const ERRLOG = path.join(DATA, 'server-errors.log');
const logCrash = (kind, e) => {
  const line = `[${new Date().toISOString()}] ${kind}: ${e?.stack || e}\n`;
  console.error(line);
  try { fs.appendFileSync(ERRLOG, line); } catch {}
};
// Turning team editing / render farm / phone review back on at start: when this copy replaced an older one, the older
// one may still hold the port for a moment - try again for ~15 s instead of staying off (it used to stay off silently).
function resumeServer(start, label) {
  let n = 0;
  const go = () => start().catch((e) => {
    if (/busy/i.test(e.message) && ++n < 10) return setTimeout(go, 1500);
    logCrash(label, e);
  });
  go();
}

process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));
const PORT = +process.env.PORT || 3000;
const BUILD = String(Math.round(Math.max(...[path.join(ROOT, 'server.mjs'), ...['engine', 'public/js'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).map((f) => path.join(ROOT, d, f)))]
  .filter((f) => /\.(m?js|py)$/.test(f) && !/edtool\.mjs$/.test(f)).map((f) => fs.statSync(f).mtimeMs)))); // (edtool is Claude's command-line tool, not the server)
const APP_URL = `http://localhost:${PORT}`;

// Installers (winget) update PATH in the registry, but already-open shells and apps keep the old one.
if (process.platform === 'win32') {
  const regPath = (key) => {
    const r = spawnSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8' });
    const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(r.stdout || '');
    return m ? m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`) : '';
  };
  const user = regPath('HKCU\\Environment'), machine = regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
  process.env.PATH = [user, machine, process.env.PATH].filter(Boolean).join(';');
}
// "python" can be the Microsoft Store stub, which starts but fails - require a real exit 0.
const PYTHON = ['python', 'python3', 'py'].find((b) => spawnSync(b, ['--version']).status === 0) || 'python';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.srt': 'text/plain; charset=utf-8', '.ass': 'text/plain; charset=utf-8',
};
const EXT_KIND = (ext) => (/\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|mxf|mpg|mpeg|3gp|wmv|flv)$/i.test(ext) ? 'video'
  : /\.(jpg|jpeg|png|webp|bmp|tif|tiff|heic)$/i.test(ext) ? 'image'
  : /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|aif|aiff|mpga)$/i.test(ext) ? 'audio' : /\.(srt|ass)$/i.test(ext) ? 'subs'
  : /\.cube$/i.test(ext) ? 'lut' : 'other');

// 10-02 03-25 (local time) for generated file names
const localStamp = () => { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`; };
const safeName = (n) => String(n).replace(/[\\/:*?"<>|]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || 'untitled';
const err = (code, msg) => Object.assign(new Error(msg), { code });

function send(res, code, body, type = 'application/json') {
  const out = type === 'application/json' ? JSON.stringify(body) : body;
  // big answers (a 1000-file media list is ~1.3 MB) go gzipped when the browser takes it - ~10x smaller over the
  // internet (editor.limelightcorp.in), where the media list used to take a long while to arrive
  if (typeof out === 'string' && out.length > 16384 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')) {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    return res.end(zlib.gzipSync(out, { level: 4 }));
  }
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(out);
}
const readBody = (req) => new Promise((ok, bad) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => ok(Buffer.concat(chunks).toString('utf8'))); req.on('error', bad);
});
const readJson = async (req) => JSON.parse((await readBody(req)) || '{}');

// files being streamed right now (a project delete closes the ones in that project - Windows can't move an open file)
const openStreams = new Set();
const track = (st, file, res) => { st.file = file; openStreams.add(st); const done = () => openStreams.delete(st); st.on('close', done); res.on('close', () => { st.destroy(); done(); }); return st; };
function serveFile(req, res, file, cache = false) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  const size = fs.statSync(file).size, type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache ? 'max-age=31536000' : 'no-store' };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? +m[2] : size - 1;
    if (start >= size || end >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return track(fs.createReadStream(file, { start, end }), file, res).pipe(res);
  }
  const headers = { ...base, 'Content-Length': size };
  if (new URL(req.url, 'http://x').searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  res.writeHead(200, headers);
  track(fs.createReadStream(file), file, res).pipe(res);
}

// Run a process without blocking the server; resolves { code, stdout, stderr }.
function run(cmd, args, { onLine, cwd } = {}) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { windowsHide: true, ...(cwd ? { cwd } : {}) });
    let out = '', errOut = '', partial = '';
    p.stdout.on('data', (d) => {
      out += d;
      if (onLine) { const lines = (partial + d).split(/\r?\n/); partial = lines.pop(); lines.forEach(onLine); }
    });
    p.stderr.on('data', (d) => { errOut += d; if (errOut.length > 20000) errOut = errOut.slice(-10000); });
    p.on('error', (e) => ok({ code: -1, stdout: out, stderr: String(e) }));
    p.on('close', (code) => ok({ code, stdout: out, stderr: errOut }));
  });
}
const writeJSON = (file, obj) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, file); };
const readJSON = (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } };

// ---------------- projects ----------------
const projDir = (name) => {
  const d = path.join(PROJECTS, safeName(name));
  if (!d.startsWith(PROJECTS)) throw err(400, 'bad project name');
  return d;
};
const P = (name, ...parts) => path.join(projDir(name), ...parts);
function ensureProjectDirs(name) {
  for (const d of ['imports', 'cache/thumbs', 'cache/strips', 'cache/waves', 'cache/proxies', 'cache/analysis', 'subs', 'renders', 'exports', 'backups', 'luts'])
    fs.mkdirSync(P(name, d), { recursive: true });
}
function needProject(name) {
  if (!name || !fs.existsSync(P(name, 'project.json'))) throw err(404, `project "${name}" not found`);
  return name;
}

const mediaCache = new Map(); // project -> { items: [] }
function mediaDb(name) {
  if (!mediaCache.has(name)) mediaCache.set(name, readJSON(P(name, 'media.json'), { items: [] }));
  return mediaCache.get(name);
}
const saveTimers = new Map();
function saveMedia(name, now = false) {
  clearTimeout(saveTimers.get(name));
  // the project folder may have been deleted meanwhile - then there is nothing to save
  const write = () => { if (fs.existsSync(projDir(name))) writeJSON(P(name, 'media.json'), mediaDb(name)); };
  if (now) write(); else saveTimers.set(name, setTimeout(write, 500));
}
const mediaItem = (name, id) => mediaDb(name).items.find((m) => m.id === id);

function addMediaFile(proj, file, { bin = '', imported = false } = {}) {
  const db = mediaDb(proj);
  const abs = path.resolve(file);
  const existing = db.items.find((m) => m.path.toLowerCase() === abs.toLowerCase());
  if (existing) return null;
  const kind = EXT_KIND(path.extname(abs));
  if (!['video', 'image', 'audio'].includes(kind)) return null;
  const st = fs.statSync(abs);
  const item = { id: crypto.createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 12), name: path.basename(abs), path: abs, bin,
    kind, size: st.size, mtime: st.mtimeMs, imported, status: 'queued', proxy: kind === 'video' ? 'pending' : 'none', added: Date.now() };
  db.items.push(item);
  enqueue(proj, item.id);
  return item;
}

// Same file in another project (e.g. a reel cut from this one): copy the media entry and its thumbnails/proxy
// instead of processing the file again. Media ids come from the file path, so they match across projects.
function cloneMedia(from, to, id) {
  const m = mediaItem(from, id);
  if (!m || mediaItem(to, id)) return;
  mediaDb(to).items.push(JSON.parse(JSON.stringify({ ...m, bin: '' })));
  for (const [d, ext] of [['thumbs', 'jpg'], ['strips', 'jpg'], ['waves', 'png'], ['proxies', 'mp4']]) {
    const f = P(from, 'cache', d, `${id}.${ext}`);
    if (fs.existsSync(f)) fs.copyFileSync(f, P(to, 'cache', d, `${id}.${ext}`));
  }
  const an = P(from, 'cache', 'analysis', `${id}.json`);
  if (fs.existsSync(an)) fs.copyFileSync(an, P(to, 'cache', 'analysis', `${id}.json`));
}

// 📋 Paste from another project: the media its clips use comes along - the same file has the same id in every project,
// so the pasted clips work as they are. Thumbnails / filmstrips / waveforms are copied, the preview copy is hard-linked
// (instant, no extra space on the same drive; a copy otherwise). A nested-sequence copy becomes a plain clip here.
const clipboards = new Map(); // person -> what they copied (📋, kept while the editor runs)
function linkOrCopy(a, b) { try { fs.linkSync(a, b); } catch { fs.copyFileSync(a, b); } }
function bringMedia(from, to, id) {
  const m = mediaItem(from, id);
  if (!m) return false;
  if (mediaItem(to, id)) return true;
  const c = JSON.parse(JSON.stringify(m));
  c.bin = `📋 ${from}`; delete c.seqOf; delete c.seqHash;
  mediaDb(to).items.push(c);
  for (const [d, ext] of [['thumbs', 'jpg'], ['strips', 'jpg'], ['waves', 'png'], ['proxies', 'mp4'], ['analysis', 'json']]) {
    const f = P(from, 'cache', d, `${id}.${ext}`), t = P(to, 'cache', d, `${id}.${ext}`);
    if (fs.existsSync(f) && !fs.existsSync(t)) { fs.mkdirSync(path.dirname(t), { recursive: true }); d === 'proxies' ? linkOrCopy(f, t) : fs.copyFileSync(f, t); }
  }
  return true;
}

// Add stock files / folders to a project (bin "Stock") and wait until the editor has read them. Returns ready media ids.
async function importStock(name, paths, log = () => {}) {
  const ids = [];
  for (const src of paths) {
    if (!fs.existsSync(src)) continue;
    const list = fs.statSync(src).isDirectory() ? scanFolder(src).filter((f) => EXT_KIND(path.extname(f.file)) === 'video') : [{ file: src }];
    for (const f of list) {
      const it = addMediaFile(name, f.file, { bin: 'Stock' }) || mediaDb(name).items.find((m) => m.path.toLowerCase() === path.resolve(f.file).toLowerCase());
      if (it) ids.push(it.id);
    }
  }
  saveMedia(name, true);
  if (activeProject !== name) { activeProject = name; pump(); }
  for (let i = 0; i < 240; i++) {
    const waiting = ids.filter((id) => !['ready', 'error', 'offline'].includes(mediaItem(name, id)?.status));
    if (!waiting.length) break;
    if (i % 5 === 0) log(`Reading stock clips… ${ids.length - waiting.length}/${ids.length}`);
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return ids.filter((id) => mediaItem(name, id)?.status === 'ready');
}

// The sound-effects library inside a project (bin "SFX"), ready to use: { kind: { mediaId, peak, label, duration } }.
// Your own file of a kind wins over the built-in one.
async function sfxLib(name) {
  await sfxMade();
  const lib = {}, list = listSfx(SFX), ids = [];
  for (const x of list) {
    if (lib[x.kind]) continue;
    const it = addMediaFile(name, x.file, { bin: 'SFX' }) || mediaDb(name).items.find((m) => m.path.toLowerCase() === path.resolve(x.file).toLowerCase());
    if (!it) continue;
    lib[x.kind] = { mediaId: it.id, peak: x.peak ?? SFX_KINDS[x.kind]?.peak ?? 0, label: x.label };
    ids.push(it.id);
  }
  saveMedia(name, true);
  if (activeProject !== name) { activeProject = name; pump(); }
  for (let i = 0; i < 60 && ids.some((id) => !['ready', 'error', 'offline'].includes(mediaItem(name, id)?.status)); i++) await new Promise((ok) => setTimeout(ok, 500));
  for (const k of Object.keys(lib)) { const m = mediaItem(name, lib[k].mediaId); if (m?.status !== 'ready') delete lib[k]; else lib[k].duration = m.duration; }
  return lib;
}

function scanFolder(dir,{ max = 5000, depth = 8 } = {}) {
  const found = [];
  const walk = (d, rel, lvl) => {
    if (lvl > depth || found.length >= max) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name.startsWith('$') || /^(System Volume Information|node_modules)$/i.test(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, rel ? `${rel}/${e.name}` : e.name, lvl + 1);
      else if (['video', 'image', 'audio'].includes(EXT_KIND(path.extname(e.name)))) found.push({ file: full, bin: rel });
      if (found.length >= max) return;
    }
  };
  walk(dir, '', 0);
  return found;
}

// ---------------- 🗂 Media sambhaal (Phase 17): offline files, relink, pack, disk ----------------
// Offline: a file that was read fine once but is gone now (drive unplugged, folder moved / renamed). Checked when the
// media list is asked for (at most every 10s per project). A packed project (📦 Pack) remembers each file's place inside
// its own folder (m.packRel), so a packed folder copied to another computer finds its footage by itself.
const offlineChecked = new Map();
// 🔗 auto-relink (Phase 21): every relink teaches the editor where a folder went (Z:\Shoot -> Y:\Shoot, or
// D:\Raw -> E:\Archive\Raw - config.relinkMap). A file that goes missing is first looked for through those moves, at
// once, in every project; if that fails a background search links the sure matches (same name + size) by itself.
const relinkMap = () => config().relinkMap || [];
function learnMove(oldPath, newPath) {
  const a = path.resolve(oldPath).split(/[\\/]/), b = path.resolve(newPath).split(/[\\/]/);
  while (a.length > 1 && b.length > 1 && a[a.length - 1].toLowerCase() === b[b.length - 1].toLowerCase()) { a.pop(); b.pop(); }
  const from = a.join(path.sep), to = b.join(path.sep);
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return;
  const c = config();
  c.relinkMap = [{ from, to, at: Date.now() }, ...(c.relinkMap || []).filter((x) => x.from.toLowerCase() !== from.toLowerCase())].slice(0, 40);
  try { fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1)); } catch (e) { logCrash('relink map', e); }
}
function viaMoves(p) {
  for (const { from, to } of relinkMap()) {
    if (!p.toLowerCase().startsWith(`${from.toLowerCase()}${path.sep}`)) continue;
    const c = to + p.slice(from.length);
    if (fs.existsSync(c)) return c;
  }
  return null;
}
// tell everyone who has the project open (their media list refreshes, a short note shows)
const notice = (name, text) => { const L = live.get(name); if (L) liveSend(L, { type: 'notice', text, media: true }); };
const autoRelinked = new Map(); // project -> when the background search last ran
// known: path -> there, already looked up (checkOfflineSoon); without it every file is asked here, one by one
function checkOffline(name, force = false, known = null) {
  if (!known) {
    if (!force && Date.now() - (offlineChecked.get(name) || 0) < 10000) return;
    offlineChecked.set(name, Date.now());
  }
  let changed = false, fixed = 0, newlyOff = 0;
  // a drive that is not there (network drive dropped, USB unplugged) is asked once, not once per file - asking a
  // dead network path file by file can hold the editor for seconds
  const drives = new Map(), driveUp = (p) => { const r = path.parse(p).root; if (!drives.has(r)) drives.set(r, fs.existsSync(r)); return drives.get(r); };
  for (const m of mediaDb(name).items) {
    if (known && !known.has(m.path)) continue; // (added while the background check ran: next time)
    const there = known ? known.get(m.path) : driveUp(m.path) && fs.existsSync(m.path);
    if (!there && m.packRel) {
      const f = P(name, m.packRel);
      if (fs.existsSync(f)) { m.path = f; changed = true; continue; }
    }
    if (!there) {
      const moved = viaMoves(m.path);
      if (moved && relinkOne(name, m, moved, false)) { fixed++; changed = true; continue; }
    }
    if (!there && m.status !== 'offline' && ['ready', 'error'].includes(m.status)) { m.status = 'offline'; m.wasStatus = 'ready'; changed = true; newlyOff++; }
    else if (there && m.status === 'offline') {
      // back (drive plugged in again): a file read before is ready at once, one never read is read now
      if (m.wasStatus === 'ready') m.status = 'ready'; else { m.status = 'queued'; enqueue(name, m.id); }
      delete m.wasStatus; changed = true;
    }
  }
  if (changed) saveMedia(name);
  if (fixed) notice(name, `🔗 ${fixed} moved file${fixed > 1 ? 's' : ''} relinked automatically`);
  // still missing: search the usual places in the background (at most every 3 minutes per project)
  if ((newlyOff || force) && missingMedia(name).length && Date.now() - (autoRelinked.get(name) || 0) > 180000) {
    autoRelinked.set(name, Date.now());
    setTimeout(() => autoRelink(name).catch((e) => logCrash('auto relink', e)), 200);
  }
}
// The media list is asked for often (every open editor, every few seconds), so its check runs in the background with
// many files at once and the list goes out right away. It used to ask every file one by one inside the request:
// 1267 files on network drives held the whole editor - every user's every request - for ~12 s.
const offlineBusy = new Set();
function checkOfflineSoon(name) {
  if (offlineBusy.has(name) || Date.now() - (offlineChecked.get(name) || 0) < 10000) return;
  offlineChecked.set(name, Date.now()); offlineBusy.add(name);
  const ok = (p) => fs.promises.access(p).then(() => true, () => false);
  const paths = [...new Set(mediaDb(name).items.map((m) => m.path).filter(Boolean))], known = new Map(), drives = new Map();
  (async () => {
    for (const r of new Set(paths.map((p) => path.parse(p).root))) drives.set(r, await ok(r));
    let i = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (i < paths.length) { const p = paths[i++]; known.set(p, drives.get(path.parse(p).root) ? await ok(p) : false); }
    }));
    if (fs.existsSync(projDir(name))) checkOffline(name, false, known);
  })().catch((e) => logCrash('offline check', e)).finally(() => offlineBusy.delete(name));
}
async function autoRelink(name) {
  if (!fs.existsSync(projDir(name))) return;
  const r = await relinkScan(name, relinkDirs(name));
  const sure = r.found.filter((f) => f.sure);
  if (!sure.length) return;
  const n = relinkApply(name, sure.map((f) => ({ id: f.id, to: f.to })));
  if (n) notice(name, `🔗 ${n} offline file${n > 1 ? 's' : ''} found and relinked automatically`);
}
const missingMedia = (name) => mediaDb(name).items.filter((m) => !fs.existsSync(m.path));

// every media id a project uses: all its sequences' clips, the logo, nested sequence copies
function usedMediaIds(name) {
  const pj = liveOf(name).pj, ids = new Set();
  const add = (data) => { for (const c of Object.values(data?.tracks || {}).flat()) if (c?.mediaId) ids.add(c.mediaId); };
  add(pj);
  for (const s of Object.values(pj.sequences || {})) add(s.data);
  if (pj.logo?.mediaId) ids.add(pj.logo.mediaId);
  return ids;
}

// 🔗 relink: look for the missing files in these folders (by name, then size; a renamed file by size + type alone)
async function relinkScan(name, dirs, onStep = () => {}) {
  const missing = missingMedia(name);
  if (!missing.length) return { found: [], notFound: [], searched: [] };
  const byName = new Map(), bySize = new Map(), searched = [];
  for (const d of dirs) {
    if (!d || !fs.existsSync(d) || searched.some((x) => d.toLowerCase().startsWith(x.toLowerCase()))) continue;
    searched.push(d);
    onStep(`Searching: ${d}`);
    await new Promise((ok) => setImmediate(ok)); // let the editor answer others between folders
    for (const f of scanFolder(d, { max: 40000, depth: 10 })) {
      let size = 0; try { size = fs.statSync(f.file).size; } catch { continue; }
      const k = path.basename(f.file).toLowerCase();
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push({ file: f.file, size });
      if (size > 1048576) { if (!bySize.has(size)) bySize.set(size, []); bySize.get(size).push(f.file); }
    }
  }
  const found = [], notFound = [], taken = new Set();
  // the folder a found file moved to tells where its neighbours went (same old folder -> same new folder)
  const moves = new Map();
  for (const m of missing) {
    const cands = (byName.get(path.basename(m.path).toLowerCase()) || []).filter((c) => !taken.has(c.file.toLowerCase()));
    let pick = null, how = '';
    const sameSize = cands.filter((c) => !m.size || c.size === m.size);
    if (sameSize.length) {
      const hint = moves.get(path.dirname(m.path).toLowerCase());
      pick = (hint && sameSize.find((c) => path.dirname(c.file).toLowerCase() === hint)) || sameSize[0];
      how = m.size ? 'naam + size' : 'naam';
    } else if (m.size > 1048576 && bySize.get(m.size)?.length === 1 && EXT_KIND(path.extname(bySize.get(m.size)[0])) === m.kind) {
      pick = { file: bySize.get(m.size)[0] }; how = 'size (naam badla hua)';
    } else if (cands.length === 1) { pick = cands[0]; how = 'name only, size differs - check it'; }
    if (pick) {
      taken.add(pick.file.toLowerCase());
      moves.set(path.dirname(m.path).toLowerCase(), path.dirname(pick.file).toLowerCase());
      found.push({ id: m.id, name: m.name, from: m.path, to: pick.file, how, sure: !how.startsWith('name only') });
    } else notFound.push({ id: m.id, name: m.name, from: m.path });
  }
  return { found, notFound, searched };
}
// where to look by default: what is left of the old folders, the team's shared folders, the folders the project's
// other files are in, and this computer's usual places
function relinkDirs(name, extra = []) {
  const dirs = [...extra];
  for (const m of missingMedia(name)) {
    let d = path.dirname(m.path);
    for (let i = 0; i < 4 && d && !fs.existsSync(d); i++) d = path.dirname(d);
    // what is left of the old folder, and one level above it (a folder moved next door / into an archive folder)
    if (d && fs.existsSync(d) && path.parse(d).root !== d) dirs.push(d, path.dirname(d));
  }
  dirs.push(...(teamCfg().libraries || []));
  for (const m of mediaDb(name).items) if (fs.existsSync(m.path)) dirs.push(path.dirname(path.dirname(m.path)));
  dirs.push(P(name));
  const home = process.env.USERPROFILE || process.env.HOME;
  dirs.push(...['Desktop', 'Videos', 'Downloads', 'Documents'].map((d) => path.join(home, d)));
  return [...new Set(dirs.map((d) => path.resolve(d)))].filter((d) => fs.existsSync(d) && path.parse(d).root !== d).sort((a, b) => a.length - b.length);
}
// one file to its new place: the same file (same size) keeps its thumbnails and preview copy and is ready at once
function relinkOne(name, m, to, learn = true) {
  if (!to || !fs.existsSync(to) || !fs.statSync(to).isFile()) return false;
  const st = fs.statSync(to), same = m.size && st.size === m.size;
  if (learn) learnMove(m.path, to);
  Object.assign(m, { path: path.resolve(to), size: st.size, mtime: st.mtimeMs });
  delete m.packRel; delete m.wasStatus;
  if (same && (m.proxy !== 'ready' || fs.existsSync(P(name, 'cache', 'proxies', `${m.id}.mp4`)))) m.status = 'ready';
  else { m.status = 'queued'; if (m.proxy === 'ready') m.proxy = 'pending'; enqueue(name, m.id); }
  return true;
}
function relinkApply(name, pairs) {
  let n = 0;
  for (const { id, to } of pairs || []) { const m = mediaItem(name, id); if (m && relinkOne(name, m, to)) n++; }
  saveMedia(name, true);
  offlineChecked.delete(name);
  // the same move fixes the other projects' copies of these files too, next time they are looked at
  for (const other of mediaCache.keys()) if (other !== name) offlineChecked.delete(other);
  return n;
}

// 💾 disk: what a project's folder holds, by kind
const dirSize = (d) => {
  let n = 0, files = 0;
  const walk = (x) => { let ents = []; try { ents = fs.readdirSync(x, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const f = path.join(x, e.name); if (e.isDirectory()) walk(f); else { try { n += fs.statSync(f).size; files++; } catch {} } } };
  walk(d);
  return { bytes: n, files };
};
const DISK_PARTS = [
  ['segments', ['cache', 'segments'], 'Rendered shots (cache) - made again on the next render', true],
  ['proxies', ['cache', 'proxies'], 'Preview copies (small files for playback)', false],
  ['undo', ['cache', 'undo'], '↶ AI undo ki copies', true],
  ['renders', ['renders'], 'Bani hui videos (renders)', false],
  ['exports', ['exports'], 'Exports (XML, thumbnails…)', false],
  ['imports', ['imports'], 'Editor ki banayi files (VO, music, nested sequences)', false],
  ['backups', ['backups'], 'Project ki purani copies (backups)', true],
  ['media', ['Media'], 'Pack ki gayi footage', false],
];
function diskOf(name) {
  const parts = DISK_PARTS.map(([key, rel, label, cleanable]) => ({ key, label, cleanable, ...dirSize(P(name, ...rel)) }));
  const total = dirSize(projDir(name));
  const known = parts.reduce((n, x) => n + x.bytes, 0);
  parts.push({ key: 'other', label: 'Other cache (thumbnails, waveforms, analysis…)', cleanable: false, bytes: Math.max(0, total.bytes - known), files: 0 });
  // cache files of media no longer in the project (removed from the pool): safe to delete
  const ids = new Set(mediaDb(name).items.map((m) => m.id));
  let orphanBytes = 0, orphanFiles = 0;
  for (const d of ['thumbs', 'strips', 'waves', 'proxies', 'analysis']) {
    let ents = []; try { ents = fs.readdirSync(P(name, 'cache', d)); } catch { continue; }
    for (const f of ents) if (!ids.has(f.split('.')[0])) { try { orphanBytes += fs.statSync(P(name, 'cache', d, f)).size; orphanFiles++; } catch {} }
  }
  let renders = [];
  try { renders = fs.readdirSync(P(name, 'renders')).filter((f) => !f.startsWith('_')).map((f) => { const st = fs.statSync(P(name, 'renders', f)); return { file: f, bytes: st.size, mtime: st.mtimeMs }; }).sort((a, b) => b.mtime - a.mtime); } catch {}
  return { project: name, total: total.bytes, parts, orphans: { bytes: orphanBytes, files: orphanFiles }, renders, offline: missingMedia(name).length };
}
const projectBusy = (name) => [...jobs.values()].some((j) => j.status === 'running' && j.project === name) || (rqActive && rq.items.find((x) => x.id === rqActive.id)?.project === name);
function diskClean(name, what, files = []) {
  if (projectBusy(name)) throw err(409, 'A render / job is running on this project - clean up after it finishes');
  let freed = 0;
  const rm = (f) => { try { freed += fs.statSync(f).isDirectory() ? dirSize(f).bytes : fs.statSync(f).size; fs.rmSync(f, { force: true, recursive: true }); } catch {} };
  const keepNewest = (dir, n) => { let ents = []; try { ents = fs.readdirSync(dir).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t); } catch {} ents.slice(n).forEach((x) => rm(path.join(dir, x.f))); };
  if (what === 'segments') rm(P(name, 'cache', 'segments'));
  else if (what === 'undo') keepNewest(P(name, 'cache', 'undo'), 3);
  else if (what === 'backups') keepNewest(P(name, 'backups'), 5);
  else if (what === 'orphans') {
    const ids = new Set(mediaDb(name).items.map((m) => m.id));
    for (const d of ['thumbs', 'strips', 'waves', 'proxies', 'analysis']) { let ents = []; try { ents = fs.readdirSync(P(name, 'cache', d)); } catch { continue; } for (const f of ents) if (!ids.has(f.split('.')[0])) rm(P(name, 'cache', d, f)); }
  } else if (what === 'renders') {
    for (const f of files) { const b = path.basename(String(f)); if (b && !b.startsWith('.')) rm(P(name, 'renders', b)); }
  } else throw err(400, 'Unknown cleanup');
  return { freed };
}

// 📦 pack: the project and the footage it uses copied into one folder (itself a project folder: put it in Projects on
// any computer and it opens with its footage). opts: { dest, all (whole media pool, not only what the timelines use),
// proxies (also the preview copies - opens faster, bigger) }
async function packProject(name, opts, job) {
  const destRoot = String(opts.dest || '');
  if (!destRoot || !fs.existsSync(destRoot)) throw err(400, 'Folder not found');
  let out = path.join(destRoot, name);
  for (let k = 2; fs.existsSync(out); k++) out = path.join(destRoot, `${name} (${k})`);
  if (path.resolve(out).toLowerCase().startsWith(projDir(name).toLowerCase())) throw err(400, 'Cannot pack into the project itself - choose another folder');
  const L = liveOf(name);
  liveWrite(name, L, true);
  saveMedia(name, true);
  const used = usedMediaIds(name), items = mediaDb(name).items.filter((m) => opts.all || used.has(m.id));
  const missing = items.filter((m) => !fs.existsSync(m.path));
  // where every file goes: Media/<its bin>/<its name> (the editor's own files keep their place in the project)
  const names = new Set(), plan = [];
  for (const m of items) {
    if (!fs.existsSync(m.path)) continue;
    const inside = path.resolve(m.path).toLowerCase().startsWith(projDir(name).toLowerCase() + path.sep);
    let rel = inside ? path.relative(projDir(name), m.path) : path.join('Media', ...(m.bin || '').split('/').filter(Boolean).map(safeName), path.basename(m.path));
    while (names.has(rel.toLowerCase())) rel = rel.replace(/(\.[^.]+)?$/, `_${m.id.slice(0, 4)}$1`);
    names.add(rel.toLowerCase());
    plan.push({ m, rel, bytes: fs.statSync(m.path).size });
  }
  const small = [];
  for (const d of ['subs', 'luts']) for (const f of (fs.existsSync(P(name, d)) ? fs.readdirSync(P(name, d)) : [])) small.push(path.join(d, f));
  for (const d of ['thumbs', 'strips', 'waves', 'analysis', ...(opts.proxies ? ['proxies'] : [])])
    for (const m of items) for (const ext of ['jpg', 'png', 'json', 'mp4']) { const r = path.join('cache', d, `${m.id}.${ext}`); if (fs.existsSync(P(name, r))) small.push(r); }
  const total = plan.reduce((n, x) => n + x.bytes, 0) + small.reduce((n, r) => n + fs.statSync(P(name, r)).size, 0);
  // room on the target drive
  try { const sf = fs.statfsSync(destRoot); if (sf.bavail * sf.bsize < total * 1.02) throw err(400, `Not enough space: ${(total / 1073741824).toFixed(1)} GB needed, ${(sf.bavail * sf.bsize / 1073741824).toFixed(1)} GB free`); } catch (e) { if (e.code === 400) throw e; }
  fs.mkdirSync(out, { recursive: true });
  let done = 0;
  const copy = async (from, rel) => {
    const to = path.join(out, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    await fs.promises.copyFile(from, to);
    done += fs.statSync(to).size;
    job.progress = Math.min(99, Math.round((done / Math.max(1, total)) * 100));
  };
  for (const [k, x] of plan.entries()) { job.stage = `Copy ${k + 1}/${plan.length}: ${x.m.name}`; await copy(x.m.path, x.rel); }
  job.stage = 'Project files…';
  for (const r of small) await copy(P(name, r), r);
  // the copy's media list points into the copy, and remembers each file's place inside it (m.packRel)
  const relOf = new Map(plan.map((x) => [x.m.id, x.rel]));
  const media = { ...mediaDb(name), items: items.map((m) => {
    const c = JSON.parse(JSON.stringify(m)), rel = relOf.get(m.id);
    if (rel) { c.path = path.join(out, rel); c.packRel = rel; }
    if (!opts.proxies && c.proxy === 'ready') c.proxy = 'pending';
    if (c.status !== 'ready' && rel) c.status = 'queued';
    return c;
  }) };
  writeJSON(path.join(out, 'media.json'), media);
  writeJSON(path.join(out, 'project.json'), { ...L.pj, modified: Date.now() });
  for (const d of ['imports', 'renders', 'exports', 'backups', 'subs', 'luts', 'cache/thumbs', 'cache/strips', 'cache/waves', 'cache/proxies', 'cache/analysis']) fs.mkdirSync(path.join(out, d), { recursive: true });
  const info = { from: name, packedAt: Date.now(), files: plan.length, bytes: total, all: !!opts.all, missing: missing.map((m) => m.name) };
  writeJSON(path.join(out, 'pack-info.json'), info);
  job.progress = 100;
  return { folder: out, ...info };
}

// ---------------- media processing: probe, thumbnail, filmstrip, waveform, proxy ----------------
const quickQ = [], proxyQ = [];
const jobs = new Map(); // background jobs (renders, agent, transcription...) - see startJob / startTask
let quickActive = 0, proxyActive = 0;
function enqueue(proj, id) { quickQ.push({ proj, id }); pump(); }

async function ffprobe(file) {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) return null;
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const [fn, fd] = String(v?.avg_frame_rate || v?.r_frame_rate || '0/1').split('/').map(Number);
  const rot = v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? +(v?.tags?.rotate || 0);
  return {
    duration: +(+j.format.duration || +v?.duration || +a?.duration || 0).toFixed(3),
    width: v?.width, height: v?.height, fps: fd ? +(fn / fd).toFixed(3) : 0, rotation: rot,
    vcodec: v?.codec_name, pixfmt: v?.pix_fmt, profile: v?.profile, acodec: a?.codec_name, hasAudio: !!a, hasVideo: !!v,
    format: j.format.format_name, bitrate: +j.format.bit_rate || 0,
  };
}

// Browsers play only 8-bit 4:2:0 H.264/VP9/AV1 in MP4/WebM; camera files (MXF, 10-bit, 4:2:2, HEVC, ProRes) need a proxy.
function needsProxy(m) {
  if (m.kind !== 'video') return false;
  const ext = path.extname(m.path).toLowerCase();
  const okContainer = ['.mp4', '.m4v', '.mov', '.webm'].includes(ext);
  const okCodec = ['h264', 'vp9', 'av1', 'vp8'].includes(m.vcodec);
  const okPix = ['yuv420p', 'yuvj420p'].includes(m.pixfmt);
  // size check by pixel count, so vertical 1080x1920 phone video plays directly
  return !(okContainer && okCodec && okPix && (m.width || 0) * (m.height || 0) <= 2560 * 1440);
}

async function processQuick(proj, id) {
  const m = mediaItem(proj, id);
  if (!m) return;
  if (!fs.existsSync(m.path)) { m.status = 'offline'; return; }
  m.status = 'probing';
  const info = await ffprobe(m.path);
  if (!info) { m.status = 'error'; m.error = 'Could not read this file'; return; }
  Object.assign(m, info);
  if (m.kind !== 'image') m.kind = info.hasVideo ? 'video' : info.hasAudio ? 'audio' : m.kind; // trust contents over extension
  const C = (d, f) => P(proj, 'cache', d, f);
  if (m.kind === 'video' || m.kind === 'image') {
    const seek = m.kind === 'video' ? ['-ss', String(Math.min(1, m.duration / 2))] : [];
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...seek, '-i', m.path, '-frames:v', '1', '-vf', 'scale=320:-2', '-update', '1', C('thumbs', `${id}.jpg`)]);
    m.thumb = fs.existsSync(C('thumbs', `${id}.jpg`));
  }
  if (m.kind === 'video' && m.duration > 0) await makeStrip(m.path, m.duration, C('strips', `${id}.jpg`)).then((ok) => (m.strip = ok));
  const proxy = needsProxy(m);
  // Waveforms need the whole audio track; for big camera files read it from the small proxy later instead.
  if (m.hasAudio && !proxy) m.wave = await makeWave(m.path, C('waves', `${id}.png`));
  m.status = 'ready';
  if (proxy) { m.proxy = 'queued'; proxyQ.push({ proj, id }); } else m.proxy = 'none';
}

// Filmstrip: 12 evenly spaced frames side by side (timeline clip background).
// Each frame is a fast seek (-ss before -i), so a long 4K intra-frame MXF is not decoded end to end.
async function makeStrip(file, dur, out) {
  const ins = [], g = [];
  for (let i = 0; i < 12; i++) {
    ins.push('-ss', ((dur * (i + 0.5)) / 12).toFixed(3), '-i', file);
    g.push(`[${i}:v:0]trim=end_frame=1,scale=-2:90,setsar=1[f${i}]`);
  }
  g.push(`${Array.from({ length: 12 }, (_, i) => `[f${i}]`).join('')}hstack=inputs=12[s]`);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...ins, '-filter_complex', g.join(';'), '-map', '[s]', '-frames:v', '1', '-update', '1', '-q:v', '5', out]);
  return fs.existsSync(out);
}
async function makeWave(file, out) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-filter_complex',
    'aformat=channel_layouts=mono,showwavespic=s=1600x100:colors=#7fd3a8|#7fd3a8', '-frames:v', '1', '-update', '1', out]);
  return fs.existsSync(out);
}

// 🌐 A file the browser can play but that is heavy (a 21 Mbps 1080p camera file, 4K) gets a light copy too - the same
// small 540p proxy - for editors over the internet: streaming the camera file to them, every 2 s cut jumping to a new
// place in it, kept the viewer black. On this computer the file itself still plays (full quality, it is right here).
const heavy = (m) => m.kind === 'video' && m.proxy === 'none' && ((m.bitrate || 0) > 8e6 || (m.width || 0) * (m.height || 0) > 1920 * 1080);
const liteQueued = new Set(); // projects whose light copies were asked for since the start
function ensureLite(proj) {
  if (liteQueued.has(proj)) return;
  liteQueued.add(proj);
  for (const m of mediaDb(proj).items) {
    if (!heavy(m) || m.lite === 'ready' && fs.existsSync(P(proj, 'cache', 'proxies', `${m.id}.mp4`))) continue;
    m.lite = 'queued'; proxyQ.push({ proj, id: m.id });
  }
  pump();
}
async function processProxy(proj, id) {
  const m = mediaItem(proj, id);
  if (!m || !fs.existsSync(m.path)) return;
  const lite = m.proxy === 'none'; // (a light copy of a file that plays as it is)
  if (lite) { m.lite = 'making'; } else { m.proxy = 'making'; m.proxyPct = 0; }
  const out = P(proj, 'cache', 'proxies', `${id}.mp4`), tmp = `${out}.part.mp4`;
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', m.path, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', 'scale=-2:540,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '12', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp],
  { onLine: (l) => { const k = /^out_time_ms=(\d+)/.exec(l); if (k && m.duration && !lite) m.proxyPct = Math.min(99, Math.round((+k[1] / 1e6 / m.duration) * 100)); } });
  if (lite) {
    if (r.code === 0 && fs.existsSync(tmp)) { fs.renameSync(tmp, out); m.lite = 'ready'; } else { fs.rmSync(tmp, { force: true }); m.lite = 'error'; }
    return;
  }
  if (r.code === 0 && fs.existsSync(tmp)) {
    fs.renameSync(tmp, out); m.proxy = 'ready'; m.proxyPct = 100;
    if (m.hasAudio && !m.wave) m.wave = await makeWave(out, P(proj, 'cache', 'waves', `${id}.png`));
    // the agent's per-second analysis, from the small proxy right away, so the agent never has to read the camera file
    await analyzeClip(out, P(proj, 'cache', 'analysis', `${id}.json`), { hasAudio: m.hasAudio, duration: m.duration }).catch(() => {});
  } else { fs.rmSync(tmp, { force: true }); m.proxy = 'error'; m.error = r.stderr.slice(-300); }
}

// Several files at a time; the project that is open in the browser goes first.
// 3 proxies at once: decoding 4K camera files is the slow part and spreads over the cores; more would only wait on the drive
const QUICK_WORKERS = 3, PROXY_WORKERS = 3;
let activeProject = null;
// shots on the open project's timeline first (so the viewer can play them), then the rest of that project, then others
let tlCache = { proj: null, mtime: 0, ids: new Set() };
function timelineIds(proj) {
  try {
    const f = P(proj, 'project.json'), mt = fs.statSync(f).mtimeMs;
    if (tlCache.proj !== proj || tlCache.mtime !== mt) {
      const pj = readJSON(f, {});
      const all = [pj.tracks || {}, ...Object.values(pj.sequences || {}).map((x) => x.data?.tracks || {})].flatMap((t) => Object.values(t).flat());
      tlCache = { proj, mtime: mt, ids: new Set(all.map((c) => c.mediaId).filter(Boolean)) };
    }
    return tlCache.ids;
  } catch { return new Set(); }
}
function takeNext(q, onTimelineFirst = false) {
  let i = -1;
  if (onTimelineFirst) {
    // the open project's timeline; before a browser has opened one (just after a restart), any project's timeline
    for (const proj of activeProject ? [activeProject] : [...new Set(q.map((x) => x.proj))]) {
      const ids = timelineIds(proj);
      i = q.findIndex((x) => x.proj === proj && ids.has(x.id));
      if (i >= 0) break;
    }
  }
  if (i < 0) i = activeProject ? q.findIndex((x) => x.proj === activeProject) : -1;
  if (i < 0) i = 0;
  return q.splice(i, 1)[0];
}
async function pump() {
  while (quickActive < QUICK_WORKERS && quickQ.length) {
    quickActive++;
    const { proj, id } = takeNext(quickQ);
    (async () => {
      try { await processQuick(proj, id); } catch (e) { const m = mediaItem(proj, id); if (m) { m.status = 'error'; m.error = String(e); } }
      saveMedia(proj); quickActive--; pump();
    })();
  }
  // proxies wait until the open project's files have all been read (thumbnails first, then previews)
  const openPending = activeProject && quickQ.some((x) => x.proj === activeProject);
  // while an agent reads footage, only one proxy at a time: both read the same (often slow, external) drive. (It used to
  // be none at all - with several people editing, some agent is nearly always running and new footage never got previews.)
  const agentBusy = [...jobs.values()].some((j) => j.kind === 'agent' && j.status === 'running' && !j.waiting);
  while (proxyActive < (agentBusy ? 1 : PROXY_WORKERS) && proxyQ.length && !openPending) {
    proxyActive++;
    const { proj, id } = takeNext(proxyQ, true);
    (async () => {
      try { await processProxy(proj, id); } catch (e) { const m = mediaItem(proj, id); if (m) m.proxy = 'error'; }
      saveMedia(proj); proxyActive--; pump();
    })();
  }
}

// On start, resume anything left unfinished last time (VEDIT_NO_RESUME=1: a second test server leaves that to the main one).
for (const proj of process.env.VEDIT_NO_RESUME ? [] : fs.readdirSync(PROJECTS)) {
  if (!fs.existsSync(path.join(PROJECTS, proj, 'project.json'))) continue;
  ensureProjectDirs(proj);
  for (const m of mediaDb(proj).items) {
    if (m.status !== 'ready' && m.status !== 'offline') { m.status = 'queued'; quickQ[m.kind === 'audio' ? 'unshift' : 'push']({ proj, id: m.id }); }
    else if (['queued', 'making', 'pending'].includes(m.proxy)) { m.proxy = 'queued'; proxyQ.push({ proj, id: m.id }); }
  }
}
pump();

// Media as the browser needs it (no absolute paths needed client side except for display).
function publicMedia(proj, m) {
  const base = `/pm/${encodeURIComponent(proj)}/${m.id}`;
  const playable = m.kind === 'video' ? (m.proxy === 'ready' || m.proxy === 'none') : m.kind !== 'image' || true;
  return { ...m, camera: m.kind === 'video' && m.width && !m.seqOf ? cameraKey(m) : null, urls: { play: `${base}/play`, thumb: m.thumb ? `${base}/thumb` : null, strip: m.strip ? `${base}/strip` : null, wave: m.wave ? `${base}/wave` : null }, playable };
}

// ---------------- jobs ----------------
let jobSeq = 0;
function startJob(kind, cmd, args, onDone, meta = {}) {
  const id = String(++jobSeq);
  const job = { id, kind, status: 'running', progress: 0, log: [], started: Date.now(), result: null, ...meta };
  jobs.set(id, job);
  const p = spawn(cmd, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  let partial = '';
  const onData = (buf) => {
    const lines = (partial + buf.toString('utf8')).split(/\r\n|\r|\n/);
    partial = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      const m = /\[(\d+)\/(\d+)\]/.exec(l);
      if (m) job.progress = Math.round(((+m[1] - 1) / +m[2]) * 90);
      if (/^frame=/.test(l) && /^frame=/.test(job.log[job.log.length - 1] || '')) job.log[job.log.length - 1] = l;
      else job.log.push(l);
      if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
    }
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('error', (e) => { job.status = 'error'; job.log.push(String(e)); });
  p.on('close', (code) => {
    if (partial.trim()) job.log.push(partial);
    job.status = code === 0 ? 'done' : 'error';
    job.progress = code === 0 ? 100 : job.progress;
    job.ended = Date.now();
    if (code === 0 && onDone) try { job.result = onDone(); } catch (e) { job.status = 'error'; job.log.push(String(e)); }
  });
  return job;
}

// 🚦 How many of a kind run at once. With many people on one editor, 20 agent edits at a time would each load Whisper
// onto the one GPU and read the drive at once - everything stalls. The rest wait in line (status stays 'running', the
// stage says where they are in the line), so nobody gets an error. VEDIT_MAX_AGENTS / VEDIT_MAX_CLAUDE change the limits.
const SLOTS = { agent: Math.max(1, +process.env.VEDIT_MAX_AGENTS || 2), claude: Math.max(1, +process.env.VEDIT_MAX_CLAUDE || 4) };
const lines = { agent: [], claude: [] }, inUse = { agent: 0, claude: 0 };
function lineNotes(kind) {
  lines[kind].forEach((w, i) => {
    w.job.stage = `Waiting in line (${i ? `${i} ahead` : 'next'}) - ${inUse[kind]} running for others…`;
    w.job.events?.push({ at: Date.now(), k: 'wait', text: w.job.stage }); // (the Assistant shows it on its progress bar)
  });
}
// resolves true with a slot, false when the job was stopped while it waited
function takeSlot(job) {
  const kind = job.kind;
  if (!SLOTS[kind]) return Promise.resolve(false);
  if (inUse[kind] < SLOTS[kind]) { inUse[kind]++; return Promise.resolve(true); }
  job.waiting = true;
  return new Promise((ok) => { lines[kind].push({ job, ok }); lineNotes(kind); });
}
function freeSlot(kind) {
  const next = lines[kind].shift();
  if (next) { next.job.waiting = false; next.job.stage = 'Starting…'; next.ok(true); } else inUse[kind]--;
  lineNotes(kind);
}
// Stop pressed on a job still waiting in line: it leaves the line (true), or it was not waiting (false)
function leaveLine(job) {
  const L = lines[job.kind], i = L ? L.findIndex((w) => w.job === job) : -1;
  if (i < 0) return false;
  const [w] = L.splice(i, 1); job.cancelled = true; job.waiting = false; w.ok(false); lineNotes(job.kind);
  return true;
}

// In-process background task (same polling API as spawned jobs).
function startTask(kind, fn, meta = {}) {
  const id = String(++jobSeq);
  const job = { id, kind, status: 'running', progress: 0, log: [], started: Date.now(), result: null, ...meta };
  jobs.set(id, job);
  let slot = false;
  takeSlot(job).then((got) => { slot = got; if (job.cancelled) throw new Error('Stopped before it started'); return fn(job); }).then((r) => {
    job.result = r; job.status = 'done'; job.progress = 100;
    // a finished agent edit is kept on disk until the editor has put it on the timeline (refresh / closed tab safe)
    if (kind === 'agent' && job.project) try { writeJSON(P(job.project, 'cache', 'agent', 'pending-result.json'), { jobId: id, at: Date.now(), opts: job.opts, result: r }); } catch {}
  })
    .catch((e) => { job.status = 'error'; job.log.push(String(e?.message || e)); })
    .finally(() => {
      job.ended = Date.now();
      if (slot) freeSlot(kind);
      if (kind === 'agent') pump();
    });
  return job;
}
// Prefer the small proxy for analysis (much faster); colours are the same.
const analysisFile = (proj, m) => (m.proxy === 'ready' ? P(proj, 'cache', 'proxies', `${m.id}.mp4`) : m.path);

const outReserved = new Map(); // `${project}/${file}` -> when a render was promised that name
// Validate the timeline and write the job file render2.mjs reads. b = { project?, preview?, filename?, seq? }
// o.write = false: b.project is only a copy to render (the render queue), not the edit to save; o.jobFile: where to write
function prepareRender(name, b, o = {}) {
  checkOffline(name, true); // 🔗 a moved file is found again before the render needs it
  const saved = b.project || readJSON(P(name, 'project.json'));
  // (a preview's copy is never saved: it can be one editor's own view of the project - 🎞 my sequence)
  if (b.project && o.write !== false && !b.preview) writeJSON(P(name, 'project.json'), { ...saved, modified: Date.now() });
  // another sequence of the project (Teaser, Reel…) renders as if it were the open timeline
  const pj = b.seq ? seqView(saved, b.seq) : saved;
  const items = mediaDb(name).items, byId = Object.fromEntries(items.map((m) => [m.id, m]));
  const used = new Set([...Object.values(pj.tracks).flat().map((c) => c.mediaId), pj.logo?.mediaId].filter(Boolean));
  for (const id of used) {
    if (!byId[id]) throw err(400, 'A clip on the timeline points to media that was removed - delete that clip first');
    if (!fs.existsSync(byId[id].path)) throw err(400, `File is offline: ${byId[id].path}`);
  }
  if (!Object.values(pj.tracks).flat().length) throw err(400, 'The timeline is empty');
  // 📊 motion graphics are baked by the editor (public/js/gfxui.js) into cache/graphics/<key>.mov
  const [BW, BH] = ASPECTS[pj.settings.aspect] || ASPECTS['16:9'];
  for (const c of Object.entries(pj.tracks).filter(([t]) => t[0] === 'V').flatMap(([, l]) => l).filter((x) => x.type === 'graphic'))
    if (!fs.existsSync(P(name, 'cache', 'graphics', `${gfxKey(c.gfx, BW, BH, pj.settings.fps, clipDur(c, byId))}.mov`)))
      throw err(400, 'A motion graphic is not prepared yet - open this sequence in the editor and wait a few seconds, then render again');
  const preview = !!b.preview;
  // delivery preset (public/js/presets.js): optional reframe to another aspect, resolution/fps caps, bitrate, codec
  const pr = !preview && b.preset ? presetById(b.preset) : null;
  if (b.preset && !preview && !pr) throw err(400, `Unknown preset: ${b.preset}`);
  // b.quality (Deliver > Quality): exact resolution / frame rate / codec / quality / audio / GPU override the preset
  const qy = !preview && b.quality ? b.quality : {};
  const exp0 = pr ? { short: pr.short, fps: pr.fps, crf: pr.crf, maxrate: pr.maxrate, abr: pr.abr, sizeMB: pr.sizeMB, loudness: pr.loudness, codec: pr.codec,
    ...(b.aspect && b.aspect !== pj.settings.aspect ? { aspect: b.aspect, fit: b.fit || 'blur' } : {}) } : null;
  const exp = exp0 || Object.keys(qy).length ? { ...(exp0 || {}),
    ...(+qy.res ? { res: +qy.res } : {}), ...(+qy.fps ? { fpsOut: +qy.fps } : {}), ...(qy.codec ? { codec: qy.codec } : {}),
    ...(+qy.crf ? { crf: +qy.crf } : {}), ...(+qy.abr ? { abr: +qy.abr } : {}), ...(qy.gpu === 'off' ? { gpu: false } : qy.gpu && healthCache?.nvenc ? { gpu: true } : {}) } : null;
  const base = safeName(b.filename || pj.name || name) + (pr && b.tag !== false ? `_${pr.tag}` : '') + (b.tag !== false && exp?.res ? { 2160: '_4K', 1440: '_2K', 1080: '_1080p', 720: '_720p', 480: '_480p' }[exp.res] || '' : '');
  const ext = (exp?.codec || pr?.codec) === 'prores' ? 'mov' : 'mp4';
  let out = '_preview.mp4';
  // names already promised to renders still waiting in the queue count as taken
  // (and names just given to a render started a moment ago - two renders at once used to write into the same file)
  const taken = (f) => fs.existsSync(P(name, 'renders', f)) || rq.items.some((x) => x.project === name && x.out === f && ['waiting', 'rendering'].includes(x.state))
    || Date.now() - (outReserved.get(`${name}/${f}`) || 0) < 6 * 3600e3;
  if (!preview) { let v = 1; while (taken(`${base}_v${v}.${ext}`)) v++; out = `${base}_v${v}.${ext}`; outReserved.set(`${name}/${out}`, Date.now()); }
  const media = Object.fromEntries([...used].map((id) => [id, { path: byId[id].path, duration: byId[id].duration, hasAudio: byId[id].hasAudio, kind: byId[id].kind, width: byId[id].width, height: byId[id].height, rotation: byId[id].rotation, size: byId[id].size, mtime: byId[id].mtime }]));
  const jobFile = o.jobFile || P(name, 'cache', preview ? 'render-job-preview.json' : `render-job-${safeName(out)}.json`);
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  // segCache: shots that did not change since an earlier render are reused from cache/segments (engine/render2.mjs)
  writeJSON(jobFile, { project: pj, media, output: P(name, 'renders', out), preview, luts: lutMap(name), export: exp, segCache: P(name, 'cache', 'segments'), gfxDir: P(name, 'cache', 'graphics'),
    farm: !preview && farmCfg().on ? { url: APP_URL } : null,
    subtitlesPath: pj.subtitles?.file ? P(name, 'subs', path.basename(pj.subtitles.file)) : null });
  return { jobFile, out, preview, duration: Math.max(0, ...Object.values(placed(pj, byId)).flat().map((x) => x.end)) };
}

// ---------------- sequences ----------------
// A project can hold several timelines (Full film, Teaser 30s, Reel…); see public/js/model.js. The open one lives at the
// top level of project.json, so everything else keeps working on it. seqView: the project as if sequence `id` were open.
function seqView(pj, id) {
  if (!id || id === seqOf(pj).id) return pj;
  const s = pj.sequences?.[id];
  if (!s) throw err(400, 'That sequence no longer exists');
  return { ...pj, ...s.data, seq: { id, name: s.name } };
}

// ---------------- render queue ----------------
// Renders wait here and run one after another in the background, so editing carries on meanwhile. Each entry keeps
// its own copy of the timeline as it was when it was queued (cache/queue/<id>.json), and the list survives a restart.
const QFILE = path.join(DATA, 'render-queue.json');
const rq = readJSON(QFILE, { items: [] });
for (const it of rq.items) if (it.state === 'rendering') { it.state = 'waiting'; it.progress = 0; } // cut off by a restart: again
let rqActive = null; // { id, proc }
const saveQueue = () => { try { writeJSON(QFILE, rq); } catch (e) { logCrash('render queue', e); } };
const killTree = (p) => { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }); else p.kill('SIGKILL'); };

function pumpQueue() {
  if (rqActive) return;
  const it = rq.items.find((x) => x.state === 'waiting');
  if (!it) return;
  if (!fs.existsSync(it.jobFile)) { it.state = 'failed'; it.error = 'Its timeline copy is missing - add it to the queue again'; saveQueue(); return pumpQueue(); }
  Object.assign(it, { state: 'rendering', started: Date.now(), progress: 0, stage: 'Starting…', log: [] });
  saveQueue();
  const p = spawn(process.execPath, [path.join(ROOT, 'engine', 'render2.mjs'), it.jobFile], { cwd: ROOT, windowsHide: true });
  rqActive = { id: it.id, proc: p };
  let partial = '', step = 0, steps = 1, D = it.duration || 1;
  const onData = (buf) => {
    const lines = (partial + buf.toString('utf8')).split(/\r\n|\r|\n/);
    partial = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      let m;
      if ((m = /^Rendering .*?, ([\d.]+)s/.exec(l))) D = +m[1] || D;
      if ((m = /\[(\d+)\/(\d+)\]\s*(.*)/.exec(l))) { step = +m[1]; steps = +m[2]; it.stage = m[3].replace(/\.{3}$/, '…'); }
      // inside a step, ffmpeg's time= says how far that piece is; the last step (the final mix) is the long one
      const tm = /time=(\d+):(\d+):([\d.]+)/.exec(l), last = step === steps;
      const within = tm && last ? Math.min(1, (+tm[1] * 3600 + +tm[2] * 60 + +tm[3]) / D) : 0;
      // pieces (shots, the join) are the first 55%, the final mix the rest
      it.progress = Math.min(99, Math.round(last ? 55 + 44 * within : (Math.max(0, step - 1) / Math.max(1, steps - 1)) * 55));
      if (/^frame=/.test(l)) continue;
      it.log.push(l); if (it.log.length > 60) it.log.splice(0, it.log.length - 60);
    }
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('close', (code) => {
    rqActive = null;
    it.ended = Date.now();
    if (it.state === 'cancelled') it.error = 'Stopped';
    else if (code === 0) { Object.assign(it, { state: 'done', progress: 100, stage: 'Done', url: `/pf/${encodeURIComponent(it.project)}/renders/${encodeURIComponent(it.out)}` }); copyToSaveTo(it); }
    else Object.assign(it, { state: 'failed', error: (it.log.filter((l) => /render:|error|failed/i.test(l)).pop() || it.log[it.log.length - 1] || `exit ${code}`).slice(0, 300) });
    if (it.state !== 'failed') fs.rmSync(it.jobFile, { force: true });
    saveQueue();
    pumpQueue();
  });
}
setTimeout(pumpQueue, 4000); // whatever was waiting when the editor closed

// one entry per platform: { preset, aspect, fit, filename, quality, seq } - the timeline is copied now
// 📁 "Save to" (Deliver): a folder of the owner's choice where the finished file is also put (the project keeps its copy
// in renders/). Only the owner may choose one - a team member cannot make the editor write anywhere on this computer.
// Editors may choose a folder inside the team's Shared folders only (Team & users > Shared folders, e.g. Z:Exports).
const sharedDirs = () => (teamCfg().libraries || []).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
const insideShared = (p) => sharedDirs().some((l) => { let r; try { r = fs.realpathSync(l); } catch { r = path.resolve(l); } const rel = path.relative(r, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); });
function saveToDir(who, d) {
  if (!d || !who || who.role === 'viewer' || !path.isAbsolute(String(d))) return null;
  let p; try { p = fs.realpathSync(path.resolve(String(d))); if (!fs.statSync(p).isDirectory()) return null; } catch { return null; }
  return who.role === 'owner' || (who.role === 'editor' && teamCfg().editorsAnyFolder) || insideShared(p) ? p : null;
}
function copyToSaveTo(it) {
  if (!it.saveTo) return;
  const src = P(it.project, 'renders', it.out), { name: b, ext } = path.parse(it.out);
  let dest = path.join(it.saveTo, it.out);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(it.saveTo, `${b} (${i})${ext}`);
  it.stage = 'Copying to your folder…'; saveQueue();
  fs.copyFile(src, dest, (e) => { if (e) it.copyError = e.message; else it.copiedTo = dest; it.stage = 'Done'; saveQueue(); });
}
function enqueueRender(name, list) {
  const saved = readJSON(P(name, 'project.json'));
  const made = [];
  for (const b of list) {
    const id = crypto.randomBytes(5).toString('hex');
    const { jobFile, out, duration } = prepareRender(name, { ...b, project: saved }, { write: false, jobFile: P(name, 'cache', 'queue', `${id}.json`) });
    const seqName = b.seq ? seqView(saved, b.seq).seq?.name : saved.seq?.name;
    const pl = presetById(b.preset)?.label || 'Custom';
    const it = { id, project: name, seq: seqName || null, preset: b.preset, aspect: b.aspect, label: b.aspect && !pl.includes(b.aspect) ? `${pl} · ${b.aspect}` : pl,
      out, jobFile, duration, state: 'waiting', progress: 0, added: Date.now(), ...(b.saveTo ? { saveTo: b.saveTo } : {}) };
    rq.items.push(it); made.push(it);
  }
  saveQueue();
  pumpQueue();
  return made;
}
const queueView = (it) => { const { jobFile, log, ...x } = it; return { ...x, last: (log || []).slice(-3) }; };

function lutMap(proj) {
  const map = {};
  for (const dir of [GLOBAL_LUTS, path.join(GLOBAL_LUTS, 'Looks'), P(proj, 'luts')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (/\.cube$/i.test(f)) map[f] = path.join(dir, f);
  }
  return map;
}

function backup(proj, force = false) {
  const dir = P(proj, 'backups');
  fs.mkdirSync(dir, { recursive: true }); // (a project folder copied in by hand may not have one)
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const last = files[files.length - 1];
  if (!force && last && Date.now() - fs.statSync(path.join(dir, last)).mtimeMs < 5 * 60 * 1000) return;
  fs.copyFileSync(P(proj, 'project.json'), path.join(dir, `project_${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  for (const f of files.slice(0, Math.max(0, files.length - 40))) fs.rmSync(path.join(dir, f), { force: true });
}

function listDir(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => !n.startsWith('.') && !n.endsWith('.part.mp4') && filter(n)).map((n) => {
    const st = fs.statSync(path.join(dir, n));
    return { name: n, size: st.size, mtime: st.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
}

// 📁 Home folders: { folders: [{ id, name }], map: { project: folderId } }
const FOLDERS_FILE = path.join(DATA, 'project-folders.json');
function projectFolders() {
  const x = readJSON(FOLDERS_FILE, null) || {};
  return { folders: Array.isArray(x.folders) ? x.folders : [], map: x.map && typeof x.map === 'object' ? x.map : {} };
}
function projectSummary(name) {
  const pj = readJSON(P(name, 'project.json'), null);
  if (!pj) return null;
  const items = mediaDb(name).items, byId = Object.fromEntries(items.map((m) => [m.id, m]));
  let duration = 0;
  try { duration = Math.max(0, ...Object.values(placed(pj, byId)).flat().map((x) => x.end)); } catch {}
  const first = pj.tracks?.V1?.find((c) => byId[c.mediaId]?.thumb) || null;
  const thumbM = first ? byId[first.mediaId] : items.find((m) => m.thumb);
  return { name, folder: projDir(name), aspect: pj.settings?.aspect, modified: fs.statSync(P(name, 'project.json')).mtimeMs,
    media: items.length, clips: Object.values(pj.tracks || {}).flat().length, duration: +duration.toFixed(1),
    thumb: thumbM ? `/pm/${encodeURIComponent(name)}/${thumbM.id}/thumb` : null };
}

function createProject({ name, aspect, fps }) {
  const n = safeName(name);
  if (fs.existsSync(P(n, 'project.json'))) throw err(409, `A project called "${n}" already exists`);
  ensureProjectDirs(n);
  writeJSON(P(n, 'project.json'), newProject(n, { aspect, fps: +fps || 30 }));
  writeJSON(P(n, 'media.json'), { items: [] });
  mediaCache.delete(n);
  return n;
}

// v1 (single folder "data/") -> first v2 project, so earlier uploads and the last timeline are not lost.
function migrateV1() {
  const legacy = path.join(ROOT, 'data');
  if (!fs.existsSync(path.join(legacy, 'media')) || fs.readdirSync(PROJECTS).length) return;
  const name = createProject({ name: 'Pehla Project', aspect: '9:16', fps: 30 });
  const files = scanFolder(path.join(legacy, 'media'), { depth: 0 });
  const byName = {};
  for (const f of files) { const it = addMediaFile(name, f.file, { bin: 'Uploads (v1)' }); if (it) byName[it.name] = it.id; }
  const old = readJSON(path.join(legacy, 'projects', 'untitled.project.json'), null);
  if (old?.clips?.length) {
    const pj = readJSON(P(name, 'project.json'));
    pj.settings.aspect = old.aspect || '9:16';
    pj.tracks.V1 = old.clips.map((c) => ({ id: uid(), type: c.type === 'card' ? 'title' : c.type, mediaId: byName[c.src] || '', in: c.in, out: c.out,
      dur: c.duration, speed: c.speed, volume: c.volume, mute: c.mute, text: c.text, textStyle: c.textStyle, textDuration: c.textDuration,
      bg: c.bg, fit: c.fit, cropX: c.cropX, fadeIn: c.fadeIn, fadeOut: c.fadeOut })).filter((c) => c.type === 'title' || c.mediaId);
    if (old.music?.src && byName[old.music.src]) pj.tracks.A2 = [{ id: uid(), type: 'audio', mediaId: byName[old.music.src], start: 0, in: old.music.in || 0, loop: true, dur: 30, volume: old.music.volume ?? 0.5, duck: !!old.music.duck }];
    pj.trackState.V1.volume = old.audio?.originalVolume ?? 1;
    writeJSON(P(name, 'project.json'), pj);
  }
  saveMedia(name, true);
  console.log(`Moved your earlier files into the project "${name}"`);
}
migrateV1();

// FFmpeg 7.1 in tools/: its NVENC works on older NVIDIA drivers than the system FFmpeg's (engine/render2.mjs encodes with it)
const FF_GPU = path.join(ROOT, 'tools', 'ffmpeg-7.1.1-essentials_build', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
// Importing torch takes seconds, so check the tools once in the background and remember the answer.
let healthCache = null;
async function checkHealth() {
  // nvenc: a tiny test encode, because the encoder is listed even when the NVIDIA driver is too old to run it
  const [ff, py, clip, nv] = await Promise.all([run('ffmpeg', ['-version']), run(PYTHON, ['-c', 'import faster_whisper']), run(PYTHON, ['-c', 'import open_clip']),
    run(fs.existsSync(FF_GPU) ? FF_GPU : 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'])]);
  healthCache = { ffmpeg: ff.code === 0, whisper: py.code === 0, clip: clip.code === 0, nvenc: nv.code === 0, projectsFolder: PROJECTS, lutsFolder: GLOBAL_LUTS };
  return healthCache;
}
checkHealth();

// ---------------- versions ----------------
// Auto backups (backups/project_<time>.json, every 5 min while editing, last 40) and named versions you save yourself
// (backups/named/<time> <name>.json, kept until you delete them). A short summary of each for the Versions list.
function versionInfo(name, file, named) {
  const pj = readJSON(file, null), st = fs.statSync(file);
  if (!pj) return null;
  const items = Object.fromEntries(mediaDb(name).items.map((m) => [m.id, m]));
  const seqs = 1 + Object.keys(pj.sequences || {}).length;
  let dur = 0; try { dur = Math.max(0, ...Object.values(placed(pj, items)).flat().map((x) => x.end)); } catch {}
  const label = named ? path.parse(file).name.replace(/^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d ?/, '') : '';
  return { file: path.basename(file), named, label, mtime: st.mtimeMs, clips: Object.values(pj.tracks || {}).flat().length, seqs, seq: pj.seq?.name || 'Main edit', duration: +dur.toFixed(1) };
}
const versionPath = (name, file, named) => path.join(P(name, 'backups', ...(named ? ['named'] : [])), path.basename(String(file || '')));

// ---------------- 📱 phone review (local network) ----------------
// Off by default. When on, a second small server listens on the local network (port 3030) and answers only under a
// secret link /r/<token>/: the review page, the finished renders to watch, and notes typed on the phone. Notes wait in
// <project>/review-notes.json until the editor takes them onto its timeline (so the editor's own saving never loses them).
const SHARE_PORT = +process.env.SHARE_PORT || 3030;
let shareServer = null;
const lanIps = () => Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal && !/^169\.254\./.test(n.address)).map((n) => n.address);
// the computer's name first: http://<name>:3100 keeps working when the router gives this computer another IP
const lanHosts = () => [os.hostname(), ...lanIps()];
function shareInfo() {
  const c = config().share || {};
  return { on: !!shareServer, token: c.token || null, port: SHARE_PORT, urls: shareServer && c.token ? lanHosts().map((ip) => `http://${ip}:${SHARE_PORT}/r/${c.token}/`) : [] };
}
const reviewNotesFile = (name) => P(name, 'review-notes.json');
function startShare() {
  if (shareServer) return Promise.resolve(shareInfo());
  const c = config();
  c.share = { ...(c.share || {}), on: true, token: c.share?.token || crypto.randomBytes(6).toString('base64url') };
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1));
  const token = c.share.token;
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = /^\/r\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m || m[1] !== token) return send(res, 404, 'Not found', 'text/plain');
    const sub = m[2] || '/';
    try {
      if (req.method === 'GET' && (sub === '/' || sub === '/index.html')) return serveFile(req, res, path.join(ROOT, 'public', 'review', 'index.html'));
      if (req.method === 'GET' && sub === '/api/projects') {
        return send(res, 200, fs.readdirSync(PROJECTS).filter((n) => fs.existsSync(path.join(PROJECTS, n, 'project.json'))).map((n) => ({
          name: n, renders: listDir(P(n, 'renders'), (f) => /\.mp4$/i.test(f) && f !== '_preview.mp4').slice(0, 30) })).filter((p) => p.renders.length)
          .sort((a, b) => b.renders[0].mtime - a.renders[0].mtime));
      }
      let mm = /^\/v\/([^/]+)\/([^/]+)$/.exec(sub);
      if (req.method === 'GET' && mm) return serveFile(req, res, P(needProject(decodeURIComponent(mm[1])), 'renders', path.basename(decodeURIComponent(mm[2]))));
      if (sub === '/api/notes') {
        const name = needProject(u.searchParams.get('p'));
        if (req.method === 'GET') {
          const pj = readJSON(P(name, 'project.json'), {});
          const mine = [pj.markers || [], ...Object.values(pj.sequences || {}).map((x) => x.data?.markers || [])].flat().filter((k) => k.note);
          return send(res, 200, [...mine, ...readJSON(reviewNotesFile(name), [])].filter((k) => !u.searchParams.get('render') || k.render === u.searchParams.get('render')));
        }
        if (req.method === 'POST') {
          const b = await readJson(req), text = String(b.text || '').trim().slice(0, 1000);
          if (!text) return send(res, 400, { error: 'Write a note first' });
          const list = readJSON(reviewNotesFile(name), []);
          const note = { id: crypto.randomBytes(4).toString('hex'), t: Math.max(0, +b.t || 0), note: text, by: String(b.by || 'Phone').trim().slice(0, 40) || 'Phone', render: path.basename(String(b.render || '')), at: Date.now(), phone: true };
          list.push(note); writeJSON(reviewNotesFile(name), list);
          return send(res, 200, note);
        }
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); }
  });
  return new Promise((ok, bad) => {
    srv.once('error', (e) => { bad(err(500, e.code === 'EADDRINUSE' ? `Port ${SHARE_PORT} is busy - close the other program using it` : e.message)); });
    srv.listen(SHARE_PORT, process.env.SHARE_HOST || '0.0.0.0', () => { shareServer = srv; console.log(`Phone review is on: ${shareInfo().urls.join('  ')}`); ok(shareInfo()); });
  });
}
function stopShare() {
  if (shareServer) { shareServer.close(); shareServer.closeAllConnections?.(); shareServer = null; }
  const c = config(); if (c.share) { c.share.on = false; fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1)); }
  return shareInfo();
}
if (config().share?.on && !process.env.VEDIT_NO_RESUME) resumeServer(startShare, 'phone review');

// ---------------- 🧠 smart footage ----------------
// engine/footage.py stays running (the picture model loads once, then searches are instant) and stops itself after
// 10 idle minutes. One request at a time: { req, onProgress, ok, bad }.
let fw = null;
function footageWorker() {
  if (fw) { clearTimeout(fw.idle); return fw; }
  const p = spawn(PYTHON, [path.join(ROOT, 'engine', 'footage.py')], { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  const w = { p, waiting: [], cur: null, out: '', err: '' };
  const next = () => { if (w.cur || !w.waiting.length) return; w.cur = w.waiting.shift(); p.stdin.write(`${JSON.stringify(w.cur.req)}\n`); };
  w.send = (req, onProgress) => new Promise((ok, bad) => { clearTimeout(w.idle); w.waiting.push({ req, onProgress, ok, bad }); next(); });
  p.stdout.on('data', (d) => {
    w.out += d;
    let i;
    while ((i = w.out.indexOf('\n')) >= 0) {
      const line = w.out.slice(0, i); w.out = w.out.slice(i + 1);
      const c = w.cur; w.cur = null;
      if (c) { try { const j = JSON.parse(line); j.error ? c.bad(new Error(j.error)) : c.ok(j); } catch (e) { c.bad(e); } }
      next();
      if (!w.cur) w.idle = setTimeout(() => { p.stdin.end(); }, 10 * 60 * 1000);
    }
  });
  p.stderr.on('data', (d) => {
    const t = String(d); w.err = (w.err + t).slice(-4000);
    for (const m of t.matchAll(/PROGRESS (\d+) ?([^\r\n]*)/g)) w.cur?.onProgress?.(+m[1], m[2]);
  });
  const fail = (e) => { for (const c of [w.cur, ...w.waiting].filter(Boolean)) c.bad(new Error(`The picture model stopped: ${e || w.err.trim().split(/\r?\n/).pop() || 'unknown error'}`)); fw = null; };
  p.on('error', (e) => fail(String(e)));
  p.on('close', () => fail());
  fw = w;
  return w;
}
// camera of a clip: same codec, frame size, frame rate and bit depth = same camera (for colour matching)
const cameraKey = (m) => `${(m.vcodec || '?').toUpperCase()} ${m.width}×${m.height} ${Math.round(m.fps || 0)}p${/10|12/.test(m.pixfmt || '') ? ' 10-bit' : ''}`;
// Problems worth a second look, from the per-second analysis and the picture model's "good shot" score.
function badReasons(m, a, quality) {
  const r = [];
  const med = (arr) => { const v = (arr || []).filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  if (m.kind === 'video' && m.duration < 1) r.push('very short (under 1 second)');
  const y = med(a?.luma), bl = med(a?.blur), mo = med(a?.motion);
  if (y !== null && y < 32) r.push('too dark');
  if (y !== null && y > 228) r.push('too bright / washed out');
  // blurdetect also rises on smooth skies / sunsets, so a middling value counts only when the picture model agrees
  if (bl !== null && (bl > 11 || (bl > 8.5 && (quality ?? 0) < 0.01))) r.push('soft / out of focus');
  if (mo !== null && mo > 0.22) r.push('very shaky or fast camera');
  if (quality !== undefined && quality < -0.035) r.push('looks like a bad shot (blur, floor, black)');
  return r;
}

// ---------------- 🚀 publish (YouTube / Facebook / Instagram) ----------------
// Uploads wait in publish.json and go one at a time. YouTube and Facebook schedule natively (the video is uploaded now
// and goes live at the set time); Instagram cannot schedule through its API, so a later Instagram post waits here and
// is uploaded at its time - the editor has to be running then. Accounts / tokens live only in config.json.
const PUBFILE = path.join(DATA, 'publish.json');
const pub = readJSON(PUBFILE, { items: [] });
for (const it of pub.items) if (it.state === 'uploading') { it.state = 'failed'; it.error = 'The editor closed during the upload - press ⟳ to try again'; }
const savePub = () => { try { writeJSON(PUBFILE, pub); } catch (e) { logCrash('publish', e); } };
const pubCfg = () => config().publish || {};
const savePubCfg = (p) => { const c = config(); c.publish = p; fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1)); };
let pubBusy = false;
async function pumpPublish() {
  if (pubBusy) return;
  const now = Date.now(), it = pub.items.find((x) => x.state === 'waiting' || (x.state === 'scheduled' && new Date(x.publishAt).getTime() <= now));
  if (!it) return;
  pubBusy = true;
  Object.assign(it, { state: 'uploading', progress: 0, started: Date.now(), error: null });
  savePub();
  try {
    const P2 = await import(`./engine/publish.mjs?v=${Math.round(fs.statSync(path.join(ROOT, 'engine', 'publish.mjs')).mtimeMs)}`);
    const file = P(it.project, 'renders', path.basename(it.render)), thumb = it.thumbnail ? P(it.project, 'exports', 'thumbnails', path.basename(it.thumbnail)) : null;
    if (!fs.existsSync(file)) throw new Error(`The video ${it.render} is no longer in Renders`);
    const prog = (k) => { it.progress = Math.round(k * 100); };
    const cfg = pubCfg(), page = (cfg.meta?.pages || []).find((p) => p.id === it.pageId);
    let r;
    if (it.platform === 'youtube') {
      if (!cfg.youtube?.refreshToken) throw new Error('YouTube is not connected');
      r = await P2.youtubeUpload(cfg.youtube, file, { title: it.title, description: it.description, tags: it.tags, privacy: it.privacy, publishAt: it.publishAt && new Date(it.publishAt) > new Date() ? it.publishAt : null, thumbnail: thumb, shorts: it.shorts }, prog);
    } else if (it.platform === 'facebook') {
      if (!page) throw new Error('That Facebook Page is not connected any more');
      r = await P2.facebookUpload(page, file, { title: it.title, description: it.description, publishAt: it.publishAt && new Date(it.publishAt) > new Date(Date.now() + 10 * 60e3) ? it.publishAt : null, thumbnail: thumb }, prog);
    } else if (it.platform === 'instagram') {
      if (!page) throw new Error('That Instagram account is not connected any more');
      r = await P2.instagramUpload(page, file, { caption: it.description, thumbOffsetMs: it.coverAt ? it.coverAt * 1000 : 0, shareToFeed: true }, prog);
    } else throw new Error(`Unknown platform ${it.platform}`);
    Object.assign(it, { state: 'done', progress: 100, result: r, ended: Date.now() });
  } catch (e) { Object.assign(it, { state: 'failed', error: String(e.message || e).slice(0, 400), ended: Date.now() }); }
  pubBusy = false;
  savePub();
  pumpPublish();
}
setInterval(pumpPublish, 20000);
setTimeout(pumpPublish, 6000);
const pubView = (it) => it;

// ---------------- ⚙ batch + automation ----------------
// One list of jobs for many clips (batch.json), done one at a time in the background: subtitles, a transcript for the
// Text page, a smart scan, or a render of each clip on its own (convert). runAt: start later (overnight). A project can
// also watch a folder (automation.json): new files are imported and get the chosen jobs.
const BFILE = path.join(DATA, 'batch.json');
const bq = readJSON(BFILE, { items: [] });
for (const it of bq.items) if (it.state === 'running') { it.state = 'waiting'; it.progress = 0; }
const saveBatch = () => { try { writeJSON(BFILE, bq); } catch (e) { logCrash('batch', e); } };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
// call one of our own routes from the server (same checks and code as when the editor calls it)
const callRoute = (key, name, body = {}) => routes[key](Readable.from([Buffer.from(JSON.stringify(body))]), null, new URL(`http://x/?p=${encodeURIComponent(name)}`));
async function waitJob(job, it) {
  while (job.status === 'running') { it.progress = job.progress; it.stage = job.stage || job.log[job.log.length - 1] || ''; await sleep(1000); }
  if (job.status !== 'done') throw new Error((job.log[job.log.length - 1] || 'failed').slice(0, 300));
  return job.result;
}
const BATCH_LABEL = { subs: 'Subtitles', transcript: 'Transcript (Text page)', scan: 'Smart scan', convert: 'Render on its own' };
async function runBatchItem(it) {
  const name = it.project, m = mediaItem(name, it.mediaId);
  if (!m) throw new Error('The clip is no longer in the project');
  const o = it.opts || {};
  if (it.action === 'subs') return waitJob(await callRoute('POST /api/transcribe', name, { mediaId: m.id, lang: o.lang || 'auto', model: o.model || 'medium', words: o.words ?? 0 }), it);
  if (it.action === 'transcript') {
    if (fs.existsSync(P(name, 'cache', 'transcripts', `${m.id}.json`))) return { skipped: 'already transcribed' };
    return waitJob(await callRoute('POST /api/transcript', name, { mediaId: m.id, lang: o.lang || 'auto', model: o.model || 'medium' }), it);
  }
  if (it.action === 'scan') return waitJob(await callRoute('POST /api/footage/scan', name, { ids: [m.id] }), it);
  if (it.action === 'convert') {
    // the clip alone as an edit: its own shape (or the chosen one), the project logo, its subtitles burned in
    const vertical = (m.rotation && Math.abs(m.rotation) === 90 ? m.width > m.height : m.height > m.width);
    const aspect = o.aspect || (vertical ? '9:16' : '16:9'), pj = newProject(`${m.name}`, { aspect, fps: Math.min(60, Math.round(m.fps) || 30) });
    pj.tracks.V1 = [m.kind === 'image' ? { id: uid(), type: 'image', mediaId: m.id, dur: 5 } : { id: uid(), type: 'video', mediaId: m.id, in: 0 }];
    if (o.logo) { const src = readJSON(P(name, 'project.json'), {}); if (src.logo?.mediaId && mediaItem(name, src.logo.mediaId)) pj.logo = { ...src.logo }; }
    if (o.subs) {
      const base = path.parse(m.name).name, srt = listDir(P(name, 'subs'), (f) => f.startsWith(base) && f.endsWith('.srt'))[0];
      if (srt) pj.subtitles = { file: srt.name, style: {} };
    }
    const { jobFile, out } = prepareRender(name, { project: pj, preset: o.preset || 'whatsapp', filename: path.parse(m.name).name, aspect }, { write: false, jobFile: P(name, 'cache', 'queue', `batch-${it.id}.json`) });
    const r = await run(process.execPath, [path.join(ROOT, 'engine', 'render2.mjs'), jobFile], { onLine: (l) => { const x = /\[(\d+)\/(\d+)\]/.exec(l); if (x) { it.progress = Math.round((+x[1] / +x[2]) * 100); it.stage = l.trim(); } } });
    fs.rmSync(jobFile, { force: true });
    if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/).pop());
    return { output: out, url: `/pf/${encodeURIComponent(name)}/renders/${encodeURIComponent(out)}` };
  }
  throw new Error(`Unknown job ${it.action}`);
}
let bBusy = false;
async function pumpBatch() {
  if (bBusy) return;
  const now = Date.now();
  // a clip still being read (just imported) waits; anything due and ready goes
  const it = bq.items.find((x) => x.state === 'waiting' && (!x.runAt || new Date(x.runAt).getTime() <= now) && ['ready', 'error', 'offline', undefined].includes(mediaItem(x.project, x.mediaId)?.status));
  if (!it) return;
  bBusy = true;
  Object.assign(it, { state: 'running', started: Date.now(), progress: 0, stage: 'Starting…' }); saveBatch();
  try { it.result = await runBatchItem(it); it.state = 'done'; it.progress = 100; }
  catch (e) { it.state = 'failed'; it.error = String(e.message || e).slice(0, 300); }
  it.ended = Date.now(); bBusy = false; saveBatch();
  setTimeout(pumpBatch, 200);
}
setInterval(pumpBatch, 15000);
setTimeout(pumpBatch, 5000);
function addBatch(name, ids, actions, opts = {}, runAt = null) {
  const made = [];
  for (const id of ids) for (const a of actions) {
    const m = mediaItem(name, id); if (!m) continue;
    if ((a === 'subs' || a === 'transcript') && !m.hasAudio) continue;
    if (a === 'scan' && !['video', 'image'].includes(m.kind)) continue;
    const it = { id: crypto.randomBytes(5).toString('hex'), project: name, mediaId: id, name: m.name, action: a, label: BATCH_LABEL[a], opts: opts[a] || {}, runAt, state: 'waiting', progress: 0, added: Date.now() };
    bq.items.push(it); made.push(it);
  }
  saveBatch(); setTimeout(pumpBatch, 300);
  return made;
}
// 👁 watch folders: every minute, new files in a project's watched folder are imported (bin "Watched/…") and queued
const autoFile = (name) => P(name, 'automation.json');
async function watchTick() {
  for (const name of fs.readdirSync(PROJECTS)) {
    const f = path.join(PROJECTS, name, 'automation.json');
    if (!fs.existsSync(f)) continue;
    const a = readJSON(f, {});
    if (!a.watch?.on || !a.watch.folder || !fs.existsSync(a.watch.folder)) continue;
    const added = [];
    for (const x of scanFolder(a.watch.folder)) {
      const it = addMediaFile(name, x.file, { bin: ['Watched', path.basename(a.watch.folder), x.bin].filter(Boolean).join('/') });
      if (it) added.push(it.id);
    }
    a.watch.checked = Date.now();
    if (added.length) {
      saveMedia(name, true);
      a.watch.found = (a.watch.found || 0) + added.length;
      const acts = ['scan', 'transcript', 'subs'].filter((k) => a.watch[k]);
      if (acts.length) addBatch(name, added, acts, { subs: { lang: a.watch.lang || 'auto' }, transcript: { lang: a.watch.lang || 'auto' } });
      console.log(`Watch folder: ${added.length} new file(s) in ${name}`);
    }
    writeJSON(f, a);
  }
}
if (!process.env.VEDIT_NO_RESUME) setInterval(() => watchTick().catch((e) => logCrash('watch folder', e)), 60000);

// ---------------- 👥 team (office network) ----------------
// Off until the owner turns it on. Then a second server listens on the office network (port 3100) and everyone signs in
// with a name + password the owner made. Roles: owner (everything), editor (edit, render, import - not settings,
// accounts or the team), viewer (look only). Everyone with edit rights works on the same timeline at once (🔴 live, below).
const TEAM_PORT = +process.env.TEAM_PORT || 3100;
const teamCfg = () => config().team || { users: [], libraries: [] };
const saveTeam = (t) => { const c = config(); c.team = t; fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1)); };
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const sessions = new Map(); // token -> { name, role, at }
// (🧠 Claude is open to editors too - Assistant, Copy a reference - with its reading kept to the projects, see claudeRun)
const OWNER_ONLY = [/^\/api\/(shutdown|settings|share|team|farm|projects\/(delete|restore|deleted|purge|empty-bin)|publish|health\/recheck|open-folder|open-sfx|open-stock)/, /^\/api\/library\/(brand|template\/delete)/];
function allowed(who, method, p) {
  if (who.role === 'owner') return true;
  if (/^\/api\/(me|lock|unlock)$/.test(p)) return true;
  // (reading the settings only tells whether keys are set; the publish list and accounts show no tokens)
  if (OWNER_ONLY.some((r) => r.test(p))) return method === 'GET' && /^\/api\/(settings|publish\/(list|accounts))$/.test(p);
  if (who.role === 'viewer') return method === 'GET';
  return true;
}
const locks = new Map(); // project -> { name, client, at }
const LOCK_MS = 45000;
function lockHolder(name, client) {
  const l = locks.get(name);
  return l && l.client !== client && Date.now() - l.at < LOCK_MS ? l : null;
}
let teamServer = null;
const cookieOf = (req, k) => (new RegExp(`(?:^|; )${k}=([^;]+)`).exec(req.headers.cookie || '') || [])[1];
function startTeam() {
  if (teamServer) return Promise.resolve();
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/team/login' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({})), t = teamCfg(), usr = (t.users || []).find((x) => x.name.toLowerCase() === String(b.name || '').trim().toLowerCase());
      if (!usr || hashPw(b.password || '', usr.salt) !== usr.hash) { await sleep(600); return send(res, 401, { error: 'Wrong name or password' }); }
      const tok = crypto.randomBytes(24).toString('hex');
      sessions.set(tok, { name: usr.name, role: usr.role, at: Date.now() });
      (presence.logins ||= []).push({ t: Date.now(), name: usr.name, ip: ipOf(req) }); savePresence(); // 📊 sign-ins, for the Sessions view
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `ve_sess=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
      return res.end(JSON.stringify({ ok: true, name: usr.name, role: usr.role }));
    }
    // 🔗 a Desktop shortcut to the editor for this PC (offered on the sign-in page; no sign-in needed - it is only the link)
    if (u.pathname === '/team/shortcut.url') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Limelight Editor.url"' });
      return res.end(shortcutFile());
    }
    if (u.pathname === '/team/logout') { sessions.delete(cookieOf(req, 've_sess')); res.writeHead(302, { 'Set-Cookie': 've_sess=; Path=/; Max-Age=0', Location: '/' }); return res.end(); }
    const s = sessions.get(cookieOf(req, 've_sess'));
    // a user removed (or demoted) by the owner loses access at once
    const usr = s && (teamCfg().users || []).find((x) => x.name === s.name);
    if (!s || !usr) {
      if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/pm/') || u.pathname.startsWith('/pf/')) return send(res, 401, { error: 'Sign in again' });
      if (/^\/(css|js|img)\//.test(u.pathname)) return serveFile(req, res, path.join(ROOT, 'public', path.normalize(decodeURIComponent(u.pathname)))); // (img: the logo on the sign-in page)
      return serveFile(req, res, path.join(ROOT, 'public', 'team', 'login.html'));
    }
    return handle(req, res, { name: usr.name, role: usr.role, local: false });
  });
  return new Promise((ok, bad) => {
    srv.once('error', (e) => bad(err(500, e.code === 'EADDRINUSE' ? `Port ${TEAM_PORT} is busy` : e.message)));
    srv.listen(TEAM_PORT, process.env.TEAM_HOST || '0.0.0.0', () => { teamServer = srv; console.log(`Team editing on: ${lanIps().map((ip) => `http://${ip}:${TEAM_PORT}`).join('  ')}`); writeShortcut(); startTeamWeb(srv); startTeamTls(srv); ok(); });
  });
}
// 🔗 the short permanent link: the same team door also on port 80, so other PCs open just http://<computer name>
// (e.g. http://Jaspreet). Optional - if port 80 is taken (IIS, Skype…) the :3100 link keeps working. A restarting editor
// may find the old one still on it for a moment, so it tries again a few times. Off for the test editors.
const TEAM_WEB_PORT = +process.env.TEAM_WEB_PORT || 80;
let teamWeb = null;
// 🔒 HTTPS for the office domain (certificate from engine/ssl.mjs in ssl/<domain>.crt/.key): the same team door on 443.
// A renewed certificate is picked up within the hour, without a restart.
const SSL_DIR = path.join(ROOT, 'ssl'), TEAM_TLS_PORT = +process.env.TEAM_TLS_PORT || 443;
const sslFiles = (d) => ({ key: path.join(SSL_DIR, `${d}.key`), cert: path.join(SSL_DIR, `${d}.crt`) });
let teamTls = null, tlsInfo = null;
function readTls(d) {
  const f = sslFiles(d);
  try { const cert = fs.readFileSync(f.cert), key = fs.readFileSync(f.key); return { key, cert, validTo: Date.parse(new crypto.X509Certificate(cert).validTo), mtime: fs.statSync(f.cert).mtimeMs }; } catch { return null; }
}
function startTeamTls(main, tries = 10) {
  const d = (teamCfg().domain || '').toLowerCase();
  if (teamTls || teamServer !== main || process.env.VEDIT_NO_RESUME || !d) return;
  const t = readTls(d); if (!t) return;
  const srv = https.createServer({ key: t.key, cert: t.cert }, (req, res) => main.emit('request', req, res));
  srv.once('error', (e) => { if (e.code === 'EADDRINUSE' && tries > 0) setTimeout(() => startTeamTls(main, tries - 1), 1500); else console.log(`  (https on port ${TEAM_TLS_PORT} not available: ${e.code || e.message})`); });
  srv.listen(TEAM_TLS_PORT, process.env.TEAM_HOST || '0.0.0.0', () => {
    if (teamServer !== main) return srv.close();
    teamTls = srv; tlsInfo = { domain: d, validTo: t.validTo, mtime: t.mtime }; writeShortcut();
    console.log(`Team editing also on: https://${d}`);
  });
}
setInterval(() => { // a renewed certificate on disk: swap it in
  if (!teamTls || !tlsInfo) return;
  const t = readTls(tlsInfo.domain);
  if (t && t.mtime !== tlsInfo.mtime) { try { teamTls.setSecureContext({ key: t.key, cert: t.cert }); tlsInfo = { ...tlsInfo, validTo: t.validTo, mtime: t.mtime }; console.log('https certificate renewed'); } catch (e) { logCrash('https renew', e); } }
}, 60 * 60 * 1000).unref?.();
const tlsView = () => (tlsInfo ? { domain: tlsInfo.domain, url: `https://${tlsInfo.domain}`, validTo: tlsInfo.validTo, daysLeft: Math.floor((tlsInfo.validTo - Date.now()) / 86400000) } : null);
function startTeamWeb(main, tries = 10) {
  if (teamWeb || teamServer !== main || process.env.VEDIT_NO_RESUME || TEAM_WEB_PORT === TEAM_PORT) return;
  const w = http.createServer((req, res) => {
    // 🔒 the domain has a certificate: http:// goes to https:// (the IP / computer-name links stay plain http)
    if (teamTls && tlsInfo && (req.headers.host || '').split(':')[0].toLowerCase() === tlsInfo.domain) { res.writeHead(301, { Location: `https://${tlsInfo.domain}${req.url}` }); return res.end(); }
    main.emit('request', req, res);
  });
  w.once('error', (e) => { if (e.code === 'EADDRINUSE' && tries > 0) setTimeout(() => startTeamWeb(main, tries - 1), 1500); else if (tries <= 0 || e.code !== 'EADDRINUSE') console.log(`  (short link on port ${TEAM_WEB_PORT} not available: ${e.code || e.message})`); });
  w.listen(TEAM_WEB_PORT, process.env.TEAM_HOST || '0.0.0.0', () => { if (teamServer !== main) return w.close(); teamWeb = w; writeShortcut(); console.log(`Team editing also on: http://${os.hostname()}`); });
}
function stopTeam() {
  if (teamTls) { teamTls.close(); teamTls.closeAllConnections?.(); teamTls = null; }
  if (teamWeb) { teamWeb.close(); teamWeb.closeAllConnections?.(); teamWeb = null; }
  if (teamServer) { teamServer.close(); teamServer.closeAllConnections?.(); teamServer = null; } sessions.clear();
}
// the permanent link (computer name, the short one when port 80 is ours) as a Windows .url shortcut with the logo
// 🌐 the office domain (config team.domain, e.g. editor.limelight.in): used as THE link once its DNS points at this
// computer (checked now and every 5 minutes); until then the computer's name is the link
let domainOk = false;
function checkDomain() {
  const d = teamCfg().domain || process.env.TEAM_DOMAIN;
  if (!d) { domainOk = false; return; }
  dns.promises.lookup(d, { all: true, family: 4 }).then((r) => {
    const was = domainOk; domainOk = r.some((x) => lanIps().includes(x.address));
    if (domainOk !== was) { writeShortcut(); if (domainOk) console.log(`Team editing on: http://${d}`); }
  }).catch(() => { if (domainOk) { domainOk = false; writeShortcut(); } });
}
setInterval(checkDomain, 5 * 60 * 1000).unref?.(); setTimeout(checkDomain, 2000);
const shortHost = () => (domainOk && teamWeb ? teamCfg().domain || process.env.TEAM_DOMAIN : os.hostname());
const permaLink = () => (teamTls && domainOk ? `https://${tlsInfo.domain}/` : `http://${shortHost()}${teamWeb ? '' : `:${TEAM_PORT}`}/`);
const shortcutFile = () => `[InternetShortcut]\r\nURL=${permaLink()}\r\nIconFile=${permaLink()}img/favicon.ico\r\nIconIndex=0\r\n`;
function writeShortcut() { try { fs.writeFileSync(path.join(ROOT, 'Limelight Editor.url'), shortcutFile()); } catch {} } // (a copy here, to send to other PCs)
const teamUrls = () => (teamServer ? [...(teamTls && domainOk ? [`https://${tlsInfo.domain}`] : []), ...(teamWeb ? [...new Set([`http://${shortHost()}`, `http://${os.hostname()}`])] : []), ...lanHosts().map((ip) => `http://${ip}:${TEAM_PORT}`)] : []);
const teamView = () => { const t = teamCfg(); return { on: !!teamServer, port: TEAM_PORT, short: teamTls && domainOk ? `https://${tlsInfo.domain}` : teamWeb ? `http://${shortHost()}` : null, tls: tlsView(), domain: teamCfg().domain || null, domainOk, urls: teamUrls(), users: (t.users || []).map(({ name, role }) => ({ name, role })), libraries: t.libraries || [], editorsAnyFolder: !!t.editorsAnyFolder,
  online: [...new Set([...sessions.values()].map((x) => x.name))], locks: [...live.entries()].flatMap(([p, L]) => [...new Set([...L.subs.values()].map((x) => x.who.name))].map((n) => ({ project: p, name: n }))) }; };
if (teamCfg().on && !process.env.VEDIT_NO_RESUME) resumeServer(startTeam, 'team');

// ---------------- 🖥 Render farm (Phase 16) ----------------
// Other office computers help render: each runs a small worker (`node worker.mjs http://<this computer>:3200 <token>`,
// engine/worker.mjs, served at /farm/worker.mjs). render2.mjs hands it shots that need nothing but their footage; the
// worker reads that footage from here over HTTP (so files on this computer's own drives work too), renders the shot with
// its own FFmpeg and sends the piece back. The final join stays here. A shot nobody takes - or a worker that fails -
// is simply rendered here instead, so a render never waits on the farm.
const FARM_PORT = +process.env.FARM_PORT || 3200;
const farmCfg = () => config().farm || {};
const saveFarm = (f) => { const c = config(); c.farm = { ...farmCfg(), ...f }; fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1)); };
const farm = { server: null, workers: new Map(), tasks: new Map(), waiting: [], polls: [] }; // polls: workers waiting for a task
const FARM_SEEN_MS = 40000;
const farmWorkers = () => [...farm.workers.values()].filter((w) => Date.now() - w.seen < FARM_SEEN_MS);
const farmToken = () => { let t = farmCfg().token; if (!t) { t = crypto.randomBytes(12).toString('hex'); saveFarm({ token: t }); } return t; };
const farmView = () => ({ on: !!farm.server, port: FARM_PORT, token: farm.server ? farmToken() : null,
  urls: farm.server ? lanHosts().map((ip) => `http://${ip}:${FARM_PORT}`) : [],
  workers: farmWorkers().map(({ id, name, host, busy, done, failed, slots }) => ({ id, name, host, busy, done, failed, slots })),
  waiting: farm.waiting.length, running: [...farm.tasks.values()].filter((t) => t.state === 'taken').length });
// a task to a worker that is waiting for one (or to the next one that asks)
function farmPump() {
  while (farm.waiting.length && farm.polls.length) {
    const t = farm.waiting.shift(), p = farm.polls.shift();
    if (t.state !== 'waiting') continue;
    clearTimeout(p.timer);
    t.state = 'taken'; t.worker = p.w.id; t.takenAt = Date.now(); p.w.busy = (p.w.busy || 0) + 1;
    // taken but never finished (the worker computer went off): the shot is rendered here
    t.timer = setTimeout(() => farmEnd(t, new Error(`${p.w.name} did not finish in time`)), t.limitMs);
    send(p.res, 200, { id: t.id, label: t.label, args: t.args, graph: t.graph, inputs: t.inputs.map((_, n) => `/farm/src/${t.id}/${n}`) });
  }
}
function farmEnd(t, e) {
  if (t.state === 'done' || t.state === 'failed') return;
  clearTimeout(t.timer);
  t.state = e ? 'failed' : 'done';
  const w = farm.workers.get(t.worker);
  if (w) { w.busy = Math.max(0, (w.busy || 0) - 1); if (e) w.failed = (w.failed || 0) + 1; else w.done = (w.done || 0) + 1; }
  farm.waiting = farm.waiting.filter((x) => x !== t);
  setTimeout(() => farm.tasks.delete(t.id), 60000);
  t.finish(e);
}
function startFarm() {
  if (farm.server) return Promise.resolve();
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname === '/farm/worker.mjs') return serveFile(req, res, path.join(ROOT, 'engine', 'worker.mjs'));
      if ((req.headers['x-farm-token'] || u.searchParams.get('t')) !== farmToken()) return send(res, 401, { error: 'Wrong farm token - copy it again from 👥 Team > Render farm' });
      let m;
      if (req.method === 'POST' && u.pathname === '/farm/hello') {
        const b = await readJson(req), id = String(b.id || crypto.randomBytes(5).toString('hex')).slice(0, 20);
        const old = farm.workers.get(id);
        farm.workers.set(id, { ...old, id, name: String(b.name || 'Worker').slice(0, 40), host: req.socket.remoteAddress, slots: Math.max(1, Math.min(8, +b.slots || 1)), seen: Date.now(), busy: old?.busy || 0, done: old?.done || 0, failed: old?.failed || 0 });
        return send(res, 200, { id, ffmpeg: true });
      }
      if (req.method === 'GET' && u.pathname === '/farm/next') {
        const w = farm.workers.get(u.searchParams.get('w'));
        if (!w) return send(res, 409, { error: 'Say hello first' });
        w.seen = Date.now();
        // a long poll: answered with a task, or empty after 25s (the worker asks again)
        const p = { w, res, timer: setTimeout(() => { farm.polls = farm.polls.filter((x) => x !== p); if (!res.headersSent) { res.writeHead(204); res.end(); } }, 25000) };
        req.on('close', () => { clearTimeout(p.timer); farm.polls = farm.polls.filter((x) => x !== p); });
        farm.polls.push(p); farmPump();
        return;
      }
      if (req.method === 'GET' && (m = /^\/farm\/src\/([0-9a-f]+)\/(\d+)$/.exec(u.pathname))) {
        const t = farm.tasks.get(m[1]), f = t?.inputs[+m[2]];
        if (!f || t.state !== 'taken') return send(res, 404, { error: 'No such task (finished or taken back)' });
        return serveFile(req, res, f);
      }
      if (req.method === 'PUT' && (m = /^\/farm\/result\/([0-9a-f]+)$/.exec(u.pathname))) {
        const t = farm.tasks.get(m[1]);
        if (!t || t.state !== 'taken') { req.resume(); return send(res, 409, { error: 'Too late - this shot was rendered here' }); }
        const part = `${t.out}.farm${crypto.randomBytes(3).toString('hex')}`;
        await new Promise((ok, bad) => { const ws = fs.createWriteStream(part); req.pipe(ws); ws.on('finish', ok); ws.on('error', bad); req.on('error', bad); });
        if (t.state !== 'taken' || !fs.statSync(part).size) { fs.rmSync(part, { force: true }); return send(res, 409, { error: 'Too late or empty' }); }
        fs.renameSync(part, t.out);
        farmEnd(t, null);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (m = /^\/farm\/fail\/([0-9a-f]+)$/.exec(u.pathname))) {
        const t = farm.tasks.get(m[1]), b = await readJson(req).catch(() => ({}));
        if (t) farmEnd(t, new Error(String(b.error || 'worker failed').slice(0, 300)));
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { if (!res.headersSent) send(res, 500, { error: e.message }); }
  });
  return new Promise((ok, bad) => {
    srv.once('error', (e) => bad(err(500, e.code === 'EADDRINUSE' ? `Port ${FARM_PORT} is busy` : e.message)));
    srv.listen(FARM_PORT, process.env.FARM_HOST || '0.0.0.0', () => { farm.server = srv; srv.requestTimeout = 0; console.log(`Render farm on: ${lanIps().map((ip) => `http://${ip}:${FARM_PORT}`).join('  ')}`); ok(); });
  });
}
function stopFarm() {
  if (farm.server) { farm.server.close(); farm.server.closeAllConnections?.(); farm.server = null; }
  for (const t of farm.tasks.values()) farmEnd(t, new Error('Render farm turned off'));
  farm.polls = []; farm.workers.clear();
}
if (farmCfg().on && !process.env.VEDIT_NO_RESUME) resumeServer(startFarm, 'farm');

// ---------------- 🧠 Claude in the editor ----------------
// The Assistant's 🧠 mode hands the message to Claude Code on this computer (the copy that comes with the Claude app, or
// one on PATH). Claude works through engine/edtool.mjs (look at footage, hear the song, change the timeline live, render),
// guided by engine/claude-guide.md. One conversation per project (cache/claude/session.json), resumed each message.
function claudeExe() {
  // the Claude app is a Store (MSIX) package: from outside the package its Roaming files live under Local\Packages\Claude_*
  const local = process.env.LOCALAPPDATA || '', pkgs = (() => { try { return fs.readdirSync(path.join(local, 'Packages')).filter((d) => /^Claude_/i.test(d)); } catch { return []; } })();
  for (const base of [path.join(process.env.APPDATA || '', 'Claude', 'claude-code'), ...pkgs.map((d) => path.join(local, 'Packages', d, 'LocalCache', 'Roaming', 'Claude', 'claude-code'))]) try {
    const vers = fs.readdirSync(base).filter((v) => /^\d/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of vers) for (const h of fs.readdirSync(path.join(base, v))) { const f = path.join(base, v, h, process.platform === 'win32' ? 'claude.exe' : 'claude'); if (fs.existsSync(f)) return f; }
  } catch {}
  const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.split(/\r?\n/)[0].trim() : null;
}
let claudeAuth = { at: 0, ok: null, msg: '' };
async function claudeStatus(force = false) {
  const exe = claudeExe();
  if (!exe) return { available: false, reason: 'Claude Code is not installed on this computer (install the Claude app, or Claude Code)' };
  if (!force && claudeAuth.ok !== null && Date.now() - claudeAuth.at < (claudeAuth.ok ? 3600000 : 60000)) return { available: claudeAuth.ok, exe, reason: claudeAuth.msg };
  const r = await run(exe, ['-p', 'Reply with OK', '--output-format', 'json', '--max-turns', '1', '--model', 'haiku'], {});
  let j = {}; try { j = JSON.parse(r.stdout); } catch {}
  const ok = r.code === 0 && !j.is_error;
  claudeAuth = { at: Date.now(), ok, msg: ok ? '' : String(j.result || r.stderr || 'Claude did not answer').slice(0, 300) };
  return { available: ok, exe, reason: claudeAuth.msg };
}
// kept narrow on purpose: read anything, write only its own edit files, run only the editor's own tool (engine/edtool.mjs)
const CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Write(Projects/**/cache/claude/**)', 'Edit(Projects/**/cache/claude/**)', 'Bash(node engine/edtool.mjs:*)'];
const tidy = (x, n = 400) => { const s = typeof x === 'string' ? x : Array.isArray(x) ? x.map((b) => b.text || (b.type === 'image' ? '[image]' : '')).join(' ') : JSON.stringify(x); return String(s || '').slice(0, n); };
// 🧠 The model: Opus first. When the plan's Opus usage runs out, the same task carries on with Sonnet (in the same
// conversation, from where it stopped), and Opus is tried again once its limit has reset (or after an hour).
// (The model is set here, not left to this computer's Claude settings - those said "sonnet", so edits ran on Sonnet.)
const CLAUDE_MAIN = () => String(process.env.VEDIT_CLAUDE_MODEL || config().claudeModel || 'opus');
const CLAUDE_BACKUP = () => String(process.env.VEDIT_CLAUDE_FALLBACK || config().claudeFallback || 'sonnet');
let mainLimitedUntil = 0;
const LIMIT_RE = /usage limit|limit reached|hit your limit|reached your limit|rate.?limit|weekly limit|session limit|limit (will )?resets?|out of (usage|credits)|overloaded/i;
function limitHit(why) {
  if (!LIMIT_RE.test(why)) return false;
  // "Claude AI usage limit reached|1792600000" carries the reset time; otherwise try again in an hour
  const t = +(/\|(\d{10})\b/.exec(why)?.[1] || 0) * 1000;
  mainLimitedUntil = t > Date.now() ? t : Date.now() + 3600e3;
  return true;
}
function claudeChat(name, message, reset, who = null) {
  const exe = claudeExe();
  if (!exe) throw err(400, 'Claude Code is not installed on this computer');
  const sfile = P(name, 'cache', 'claude', 'session.json');
  fs.mkdirSync(path.dirname(sfile), { recursive: true });
  if (reset) fs.rmSync(sfile, { force: true });
  try { aiSnap(name, `Claude: ${String(message).replace(/\s+/g, ' ').slice(0, 80)}`); } catch {}
  return startTask('claude', async (job) => {
    const ev = (e) => { job.events.push({ at: Date.now(), ...e }); if (e.k === 'tool') job.stage = e.text; };
    const backup = CLAUDE_BACKUP(), main = CLAUDE_MAIN();
    let model = Date.now() < mainLimitedUntil ? backup : main;
    if (model !== main) ev({ k: 'wait', text: `Opus limit is used up for now - working with ${backup}…` });
    // an editor's Claude reads only the projects and the editor's own engine (the owner's reads anything on this
    // computer); Glob / Grep would let it look around the rest of the drives, so they are the owner's only
    job.tools = who && who.role !== 'owner' ? ['Read(Projects/**)', 'Read(engine/**)', ...CLAUDE_TOOLS.filter((t) => !/^(Read|Glob|Grep)$/.test(t))] : CLAUDE_TOOLS;
    try { return await claudeRun(exe, name, sfile, String(message), model, job, ev); }
    catch (e) {
      // the main model's limit ran out (now or partway): the same conversation goes on with the backup model
      if (model === backup || job.stopped || !limitHit(e.message)) throw e;
      model = backup;
      ev({ k: 'wait', text: `Opus limit reached - carrying on with ${backup}…` });
      return claudeRun(exe, name, sfile, readJSON(sfile, {}).id ? 'Your usage limit stopped you partway through. Carry on from where you stopped and finish the task I gave you.' : String(message), model, job, ev);
    }
  }, { project: name, events: [] });
}
function claudeRun(exe, name, sfile, message, model, job, ev) {
  const sid = readJSON(sfile, {}).id || null;
  const args = ['-p', message, '--output-format', 'stream-json', '--verbose', '--append-system-prompt-file', path.join(ROOT, 'engine', 'claude-guide.md'),
    '--allowedTools', (job.tools || CLAUDE_TOOLS).join(','), '--permission-mode', 'default', ...(sid ? ['--resume', sid] : []), '--model', model];
  return new Promise((ok, bad) => {
    const p = spawn(exe, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, VEDIT_PROJECT: name, VEDIT_PORT: String(PORT), VEDIT_NO_SNAP: '1', PYTHONIOENCODING: 'utf-8' } });
    job.proc = p;
    let part = '', final = null, errText = '';
    p.stdout.on('data', (d) => {
      const lines = (part + d.toString('utf8')).split(/\r?\n/); part = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.type === 'system' && m.subtype === 'init' && m.session_id) { try { writeJSON(sfile, { id: m.session_id, at: Date.now() }); } catch {} ev({ k: 'session', id: m.session_id, model: m.model }); job.model = m.model; }
        else if (m.type === 'assistant') for (const b of m.message?.content || []) {
          if (b.type === 'text' && b.text.trim()) ev({ k: 'text', text: b.text });
          else if (b.type === 'tool_use') ev({ k: 'tool', name: b.name, text: b.name === 'Bash' ? tidy(b.input?.command, 300) : b.input?.file_path || b.input?.pattern || b.input?.query || tidy(b.input, 200) });
        } else if (m.type === 'user') for (const b of m.message?.content || []) { if (b.type === 'tool_result') ev({ k: 'result', error: !!b.is_error, text: tidy(b.content, 600) }); }
        else if (m.type === 'result') { final = m; if (m.session_id) try { writeJSON(sfile, { id: m.session_id, at: Date.now() }); } catch {} }
      }
    });
    p.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
    p.on('error', (e) => bad(e));
    p.on('close', (code) => {
      if (final && !final.is_error) { ev({ k: 'done', text: final.result || '', turns: final.num_turns, cost: final.total_cost_usd }); return ok({ text: final.result || '', turns: final.num_turns }); }
      const why = final?.result || errText.trim().split(/\r?\n/).pop() || `Claude stopped (code ${code})`;
      if (/auth|login|oauth|expired/i.test(why) && !LIMIT_RE.test(why)) claudeAuth = { at: Date.now(), ok: false, msg: why };
      // (a used-up Opus limit is not shown as an error: the task carries on with the backup model)
      if (job.stopped || model === CLAUDE_BACKUP() || !LIMIT_RE.test(why)) ev({ k: 'error', text: why });
      bad(new Error(why));
    });
  });
}

// 📜 activity: every change anyone made to a project (who, when, what; cache/activity.jsonl, newest 3000 kept). Small
// changes keep their inverse ops, so one person's one change can be taken back later without touching anyone else's.
const ACT_MAX_INV = 200000; // (bigger ones - a whole agent edit - are taken back with ↶ AI undo instead)
function logActivity(name, e) {
  try {
    const f = P(name, 'cache', 'activity.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const inv = e.inv && JSON.stringify(e.inv).length < ACT_MAX_INV ? e.inv : null;
    fs.appendFileSync(f, `${JSON.stringify({ id: `${e.at}-${Math.random().toString(36).slice(2, 7)}`, at: e.at, name: e.name, label: e.label, n: e.n || 0, inv, kind: e.kind || 'ops' })}\n`);
    if (fs.statSync(f).size > 20e6) { const lines = fs.readFileSync(f, 'utf8').trim().split('\n'); fs.writeFileSync(f, `${lines.slice(-3000).join('\n')}\n`); }
  } catch (err2) { logCrash('activity', err2); }
}
function readActivity(name, limit = 200) {
  const f = P(name, 'cache', 'activity.jsonl');
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').reverse()) { if (out.length >= limit) break; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

// ↶ AI undo: the project as it was before each Agent edit, Re-edit or Claude change (cache/undo/<time>.json, newest
// 20 kept). Survives a refresh and reaches every open editor; bringing one back first keeps the current edit, so an
// undo can itself be undone.
const UNDO_KEEP = 20;
function aiSnap(name, label) {
  const dir = P(name, 'cache', 'undo'), at = Date.now();
  fs.mkdirSync(dir, { recursive: true });
  const pj = { ...liveOf(name).pj }; delete pj._rev;
  writeJSON(path.join(dir, `${at}.json`), { id: String(at), label: String(label || 'AI edit').slice(0, 120), at, project: pj });
  const all = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - UNDO_KEEP))) fs.rmSync(path.join(dir, f), { force: true });
  return String(at);
}
function aiSnaps(name) {
  const dir = P(name, 'cache', 'undo');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort().reverse().map((f) => {
    const x = readJSON(path.join(dir, f), null); if (!x) return null;
    const clips = Object.values(x.project?.tracks || {}).flat().length;
    return { id: x.id, label: x.label, at: x.at, clips };
  }).filter(Boolean);
}

// 🎨 saved edit styles
const listStyles = () => { const d = path.join(LIB, 'styles'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJSON(path.join(d, f), null)).filter(Boolean) : []; };
const loadStyle = (n) => listStyles().find((x) => x.name === n) || null;

// ---------------- 🔴 live editing: many people on one timeline ----------------
// The server keeps the open project in memory. Every browser sends its changes as small ops (public/js/livepatch.js:
// "clip X: in = 4.2", "insert this clip after Y") and gets everyone else's over one event stream (SSE), so 20-30
// people can cut the same timeline at once. The file is written shortly after the last change. When project.json is
// changed some other way (restore, a version, a render that saved the edit) everyone gets the new copy ('reset').
const live = new Map(); // project -> { rev, pj, mtime, log: [{ rev, client, name, label, ops }], subs: Map(client -> sub), timer }
const LIVE_COLORS = ['#ff7a45', '#36cfc9', '#9254de', '#f759ab', '#73d13d', '#ffc53d', '#40a9ff', '#ff4d4f', '#13c2c2', '#d3adf7', '#95de64', '#ffd666'];
function liveOf(name) {
  const f = P(name, 'project.json'), mt = fs.statSync(f).mtimeMs;
  let L = live.get(name);
  if (!L) { L = { rev: 1, pj: readJSON(f), mtime: mt, log: [], subs: new Map(), timer: null, colorN: 0 }; live.set(name, L); return L; }
  if (mt !== L.mtime) {
    // written by something else: that version wins, and every open editor switches to it
    clearTimeout(L.timer); L.timer = null;
    L.pj = readJSON(f); L.mtime = mt; L.rev++; L.log = [];
    liveSend(L, { type: 'reset', rev: L.rev, project: L.pj });
  }
  return L;
}
function liveSend(L, msg, only = null) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const [c, sub] of L.subs) if (!only || only === c) { try { sub.res.write(data); } catch {} }
}
function liveWrite(name, L, now = false) {
  clearTimeout(L.timer);
  const go = () => { L.timer = null; L.pj.modified = Date.now(); writeJSON(P(name, 'project.json'), L.pj); L.mtime = fs.statSync(P(name, 'project.json')).mtimeMs; };
  if (now) go(); else L.timer = setTimeout(() => { try { go(); } catch (e) { logCrash('live save', e); } }, 400);
}
const livePeople = (L) => [...L.subs.entries()].map(([client, x]) => ({ client, name: x.who.name, role: x.who.role, color: x.color, ...x.at }));
const livePresence = (L) => liveSend(L, { type: 'presence', people: livePeople(L) });
// everything written to project.json outside the live path goes through here first, so the live copy follows it
function liveForget(name) { const L = live.get(name); if (L) { clearTimeout(L.timer); L.timer = null; } }

// ---------------- routes ----------------
const q = (u, k) => u.searchParams.get(k);
// 📊 Sessions (engine/presence.mjs): who worked when, for how long - the last 31 days, in sessions-log.json
const PRESENCE = path.join(DATA, 'sessions-log.json');
const presence = (() => { try { return JSON.parse(fs.readFileSync(PRESENCE, 'utf8')); } catch { return { sessions: [], logins: [] }; } })();
let presenceTimer = null;
function savePresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null; prunePresence(presence);
    const cut = Date.now() - KEEP_DAYS * 86400000; presence.logins = (presence.logins || []).filter((x) => x.t >= cut);
    try { fs.writeFileSync(PRESENCE + '.tmp', JSON.stringify(presence)); fs.renameSync(PRESENCE + '.tmp', PRESENCE); } catch (e) { logCrash('sessions log', e); }
  }, 5000);
}
const ipOf = (req) => String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
const whoLabel = (who) => (who.local ? `${who.name} (this PC)` : who.name);
const routes = {
  'GET /api/health': () => healthCache || checkHealth(),
  // version handshake: a newer copy started from the .bat asks an older running one to step aside
  // busy: work that a restart would cut off (an agent edit, Claude, a render) - a newer copy starting then leaves this one running
  'GET /api/version': () => ({ build: BUILD, busy: [...jobs.values()].filter((j) => j.status === 'running').length + (rqActive ? 1 : 0) }),
  'POST /api/shutdown': (req, res) => {
    const busy = [...jobs.values()].filter((j) => j.status === 'running').length + (rqActive ? 1 : 0);
    if (busy) return send(res, 409, { error: `${busy} job(s) running - not closing` });
    send(res, 200, { ok: true }); console.log('A newer version of the editor is starting - closing this one.'); setTimeout(() => process.exit(0), 300); },

  // projects
  'GET /api/projects': () => { const pf = projectFolders(); return fs.readdirSync(PROJECTS).filter((n) => fs.existsSync(path.join(PROJECTS, n, 'project.json')))
    .map(projectSummary).filter(Boolean).map((p) => ({ ...p, group: pf.map[p.name] || null })).sort((a, b) => b.modified - a.modified); },
  // 📁 folders on Home to sort projects into (only a grouping: the project folders on disk stay where they are)
  'GET /api/project-folders': () => projectFolders(),
  'POST /api/project-folders': async (req) => {
    const b = await readJson(req), folders = [], ids = new Set(), map = {};
    for (const f of (Array.isArray(b.folders) ? b.folders : []).slice(0, 300)) {
      const id = String(f?.id || '').replace(/[^\w-]/g, '').slice(0, 40), name = String(f?.name || '').trim().slice(0, 80);
      if (id && name && !ids.has(id)) { ids.add(id); folders.push({ id, name }); }
    }
    for (const [p, id] of Object.entries(b.map || {})) if (ids.has(id) && fs.existsSync(path.join(PROJECTS, safeName(p), 'project.json')) && safeName(p) === p) map[p] = id;
    writeJSON(FOLDERS_FILE, { folders, map });
    return { folders, map };
  },
  // 🗑 delete a project (owner only): its folder moves to the Recycle Bin next to Projects - it can be brought back -
  // or, with ?permanent=1, is deleted for good. The footage it used is never touched (it lives outside the project).
  // Refused while anyone has it open or a render / job of it is running or waiting.
  'POST /api/projects/delete': async (req, res, u) => {
    const name = needProject(q(u, 'p')), L = live.get(name);
    const people = L ? [...new Set([...L.subs.values()].map((x) => x.who.name))] : [];
    if (people.length) throw err(409, `Open right now by ${people.join(', ')} - ask them to close it first`);
    if (projectBusy(name) || rq.items.some((x) => x.project === name && ['waiting', 'rendering'].includes(x.state))) throw err(409, 'A render or job of this project is running or waiting - wait for it to finish');
    const bin = recycleBin(); fs.mkdirSync(bin, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    let to = path.join(bin, `${name} (deleted ${stamp})`);
    for (let k = 2; fs.existsSync(to); k++) to = path.join(bin, `${name} (deleted ${stamp}) ${k}`);
    if (L) { clearTimeout(L.timer); L.timer = null; }
    // (moved first in both cases: the project leaves the list at once, then a permanent delete removes the folder)
    // files of this project still being streamed to a browser are closed first; Windows lets go of them a moment later
    const dir = path.resolve(projDir(name)).toLowerCase() + path.sep;
    for (const st of openStreams) if (String(st.file || '').toLowerCase().startsWith(dir)) st.destroy();
    for (let k = 0; ; k++) {
      try { fs.renameSync(projDir(name), to); break; }
      catch (e) {
        if (k < 12 && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { await new Promise((ok) => setTimeout(ok, 400)); continue; }
        throw err(409, `Could not move the project folder (${e.code || e.message}) - a program has one of its files open (a player, Explorer window or another app) - close it and try again`);
      }
    }
    live.delete(name); mediaCache.delete(name); offlineChecked.delete(name);
    for (const qq of [quickQ, proxyQ]) for (let i = qq.length - 1; i >= 0; i--) if (qq[i].proj === name) qq.splice(i, 1);
    if (activeProject === name) activeProject = null;
    { const pf = projectFolders(); if (pf.map[name]) { delete pf.map[name]; writeJSON(FOLDERS_FILE, pf); } } // (out of its Home folder)
    if (q(u, 'permanent') === '1') { const bytes = dirSize(to).bytes; fs.rmSync(to, { recursive: true, force: true }); binLog(req, 'deleted for good', name, bytes); return { ok: true, permanent: true, freed: bytes }; }
    binLog(req, 'moved to the Recycle Bin', name, dirSize(to).bytes);
    return { ok: true, folder: to };
  },
  // the Recycle Bin: deleted projects, newest first, with their size
  'GET /api/projects/deleted': () => {
    const bin = recycleBin();
    if (!fs.existsSync(bin)) return [];
    return fs.readdirSync(bin).filter((n) => fs.existsSync(path.join(bin, n, 'project.json'))).map((n) => {
      const pj = readJSON(path.join(bin, n, 'project.json'), {}), st = fs.statSync(path.join(bin, n));
      return { folder: n, name: pj.name || n.replace(/ \(deleted .*$/, ''), deleted: st.mtimeMs, bytes: dirSize(path.join(bin, n)).bytes };
    }).sort((a, b) => b.deleted - a.deleted);
  },
  // bring a deleted project back under its own name (or "name (restored)" when that name is taken meanwhile)
  'POST /api/projects/restore': (req, res, u) => {
    const f = binEntry(q(u, 'folder'));
    const base = safeName(String(path.basename(f)).replace(/ \(deleted .*$/, ''));
    let name = base; for (let k = 2; fs.existsSync(path.join(PROJECTS, name)); k++) name = `${base} (restored${k > 2 ? ` ${k - 1}` : ''})`;
    fs.renameSync(f, path.join(PROJECTS, name));
    binLog(req, 'restored', name);
    return { ok: true, name };
  },
  // delete one project in the Recycle Bin for good
  'POST /api/projects/purge': (req, res, u) => {
    const f = binEntry(q(u, 'folder')), bytes = dirSize(f).bytes;
    fs.rmSync(f, { recursive: true, force: true });
    binLog(req, 'deleted for good from the Recycle Bin', path.basename(f), bytes);
    return { ok: true, freed: bytes };
  },
  // empty the Recycle Bin (every project in it, for good)
  'POST /api/projects/empty-bin': (req) => {
    const bin = recycleBin(); let freed = 0, n = 0;
    if (fs.existsSync(bin)) for (const e of fs.readdirSync(bin)) {
      const f = path.join(bin, e);
      if (!fs.statSync(f).isDirectory()) continue;
      const b = dirSize(f).bytes; freed += b; fs.rmSync(f, { recursive: true, force: true }); n++;
      binLog(req, 'deleted for good (Recycle Bin emptied)', e, b);
    }
    return { ok: true, removed: n, freed };
  },
  'POST /api/projects': async (req) => {
    const b = await readJson(req);
    const name = createProject(b);
    let imported = 0;
    // from a template (Library/templates): its settings, look, captions style, logo, titles and adjustment layers
    if (b.template) {
      const t = readJSON(path.join(LIB, 'templates', `${safeName(b.template)}.json`), null);
      if (t) {
        const pj = readJSON(P(name, 'project.json'));
        Object.assign(pj, { settings: { ...pj.settings, ...t.settings }, trackState: { ...pj.trackState, ...t.trackState }, ...(t.captions ? { captions: t.captions } : {}), ...(t.brand ? { brand: t.brand } : {}) });
        for (const [id, l] of Object.entries(t.tracks || {})) pj.tracks[id] = [...(pj.tracks[id] || []), ...l.map((c) => ({ ...c, id: crypto.randomBytes(4).toString('hex') }))];
        if (t.logo?.path && fs.existsSync(t.logo.path)) {
          const it = addMediaFile(name, t.logo.path, { bin: 'Brand' }) || mediaDb(name).items.find((m) => m.path.toLowerCase() === path.resolve(t.logo.path).toLowerCase());
          if (it) { const { path: _p, ...lg } = t.logo; pj.logo = { ...lg, mediaId: it.id }; saveMedia(name, true); }
        }
        writeJSON(P(name, 'project.json'), pj);
      }
    }
    if (b.folder) {
      if (!fs.existsSync(b.folder)) throw err(400, `Folder not found: ${b.folder}`);
      for (const f of scanFolder(b.folder)) if (addMediaFile(name, f.file, { bin: f.bin })) imported++;
      saveMedia(name, true);
    }
    return { name, imported, folder: projDir(name) };
  },
  // the live copy when people are editing it (with its revision, for the event stream), else the file
  'GET /api/project': (req, res, u) => { const name = needProject(q(u, 'p')), L = liveOf(name); return { ...L.pj, _rev: L.rev }; },
  // a whole project at once (older tabs, tools): it replaces the live copy, and every open editor gets it
  'PUT /api/project': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const pj = await readJson(req);
    delete pj._rev;
    const L = liveOf(name);
    L.pj = pj; L.rev++; L.log = [];
    liveWrite(name, L, true);
    liveSend(L, { type: 'reset', rev: L.rev, project: L.pj, by: req.who?.name });
    logActivity(name, { at: Date.now(), name: req.who?.name || 'Owner', label: String(q(u, 'label') || 'Replaced the whole edit (Agent / Claude / an older tab)').slice(0, 120), kind: 'replace' });
    if (q(u, 'backup')) backup(name, q(u, 'backup') === 'force');
    return { ok: true, modified: pj.modified, rev: L.rev };
  },
  // 🔴 the event stream of one project: everyone's changes (ops), who is here and what they look at (presence)
  'GET /api/live': (req, res, u) => {
    const name = needProject(q(u, 'p')), client = String(q(u, 'client') || '').slice(0, 40), since = +q(u, 'since') || 0;
    if (!client) throw err(400, 'client missing');
    const L = liveOf(name);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const old = L.subs.get(client);
    L.subs.set(client, { res, who: req.who || OWNER, color: old?.color || LIVE_COLORS[L.colorN++ % LIVE_COLORS.length], at: old?.at || {} });
    // what happened since this browser last looked: the ops, or the whole project when that is too long ago
    const first = L.log[0]?.rev;
    if (since && since < L.rev && first !== undefined && since >= first - 1) for (const e of L.log) { if (e.rev > since) liveSend(L, { type: 'ops', ...e }, client); }
    else if (since !== L.rev) liveSend(L, { type: 'reset', rev: L.rev, project: L.pj }, client);
    livePresence(L);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ping); if (L.subs.get(client)?.res === res) { L.subs.delete(client); livePresence(L); } });
  },
  'POST /api/live/ops': async (req, res, u) => {
    const name = needProject(q(u, 'p')), client = String(q(u, 'client') || ''), b = await readJson(req);
    if (!Array.isArray(b.ops)) throw err(400, 'ops missing');
    const L = liveOf(name);
    applyOps(L.pj, b.ops);
    const e = { rev: ++L.rev, client, name: req.who?.name || 'Owner', label: String(b.label || '').slice(0, 80), ops: b.ops };
    L.log.push(e); if (L.log.length > 2000) L.log.splice(0, L.log.length - 2000);
    logActivity(name, { at: Date.now(), name: e.name, label: e.label || 'Edit', n: b.ops.length, inv: Array.isArray(b.inv) ? b.inv : null });
    liveWrite(name, L);
    liveSend(L, { type: 'ops', ...e });
    return { rev: e.rev };
  },
  'POST /api/live/presence': async (req, res, u) => {
    const name = needProject(q(u, 'p')), client = String(q(u, 'client') || ''), b = await readJson(req);
    const L = liveOf(name), sub = L.subs.get(client);
    if (sub) { sub.at = { sel: (b.sel || []).slice(0, 50), playhead: +b.playhead || 0, page: String(b.page || ''), seq: String(b.seq || '') }; livePresence(L); }
    return { ok: true };
  },
  // Ctrl+S / leaving a project: write the file now (and keep a backup)
  'POST /api/live/save': (req, res, u) => {
    const name = needProject(q(u, 'p')), L = liveOf(name);
    liveWrite(name, L, true);
    if (q(u, 'backup')) backup(name, q(u, 'backup') === 'force');
    return { ok: true, modified: L.pj.modified, rev: L.rev };
  },
  'GET /api/backups': (req, res, u) => listDir(P(needProject(q(u, 'p')), 'backups'), (n) => n.endsWith('.json')),
  'POST /api/restore': (req, res, u) => {
    const name = needProject(q(u, 'p')), f = path.join(P(name, 'backups'), path.basename(q(u, 'file') || ''));
    if (!fs.existsSync(f)) throw err(404, 'backup not found');
    backup(name); fs.copyFileSync(f, P(name, 'project.json'));
    return readJSON(P(name, 'project.json'));
  },
  'POST /api/open-folder': (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const abs = saveToDir(req.who, q(u, 'path')); // (an export folder outside the project, chosen with 📁 Save to)
    const sub = q(u, 'sub'), dir = abs || (sub ? P(name, ...sub.split('/').map((s) => path.basename(s))) : projDir(name));
    if (!fs.existsSync(dir)) throw err(404, 'folder not found');
    if (process.platform === 'win32') spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
    return { folder: dir };
  },

  // file-system browser (the browser cannot give us real folder paths, so we list them ourselves)
  'GET /api/fs': (req, res, u) => {
    const p = q(u, 'path');
    if (!p) {
      const roots = process.platform === 'win32'
        ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\`).filter((d) => { try { fs.readdirSync(d); return true; } catch { return false; } })
        : ['/'];
      const home = process.env.USERPROFILE || process.env.HOME;
      const quick = ['Desktop', 'Videos', 'Downloads', 'Documents', 'Music', 'Pictures'].map((d) => path.join(home, d)).filter((d) => fs.existsSync(d));
      const libs = (teamCfg().libraries || []).filter((d) => fs.existsSync(d)).map((d) => ({ name: `⭐ ${d}`, path: d }));
      return { path: '', parent: null, dirs: [...libs, ...[...quick, ...roots].map((d) => ({ name: d, path: d }))], mediaCount: 0 };
    }
    if (!fs.existsSync(p)) throw err(404, `Folder not found: ${p}`);
    let ents = [];
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { throw err(403, `Cannot open ${p}`); }
    const dirs = ents.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')).map((e) => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const files = ents.filter((e) => e.isFile() && EXT_KIND(path.extname(e.name)) !== 'other').map((e) => e.name);
    const parent = path.dirname(p) === p ? '' : path.dirname(p);
    return { path: p, parent, dirs, files: files.slice(0, 200), mediaCount: files.length };
  },

  // media pool
  'GET /api/media': (req, res, u) => {
    const name = needProject(q(u, 'p'));
    if (activeProject !== name) { activeProject = name; pump(); }
    checkOfflineSoon(name); // 🗂 files gone since they were read (moved, drive unplugged) show as offline (next list)
    if (!req.who?.local) ensureLite(name); // 🌐 someone over the internet has it open: light copies of its heavy files
    const items = mediaDb(name).items;
    // counts for this project only (other projects keep processing in the background)
    return { items: items.map((m) => publicMedia(name, m)), queue: {
      quick: items.filter((m) => !['ready', 'offline', 'error'].includes(m.status)).length,
      proxy: items.filter((m) => ['queued', 'making'].includes(m.proxy)).length } };
  },
  // while files are being read: just the counts (the whole list of a 5000-file project is ~3 MB)
  'GET /api/media/status': (req, res, u) => {
    const name = needProject(q(u, 'p'));
    if (activeProject !== name) { activeProject = name; pump(); }
    const items = mediaDb(name).items;
    return { total: items.length, ready: items.filter((m) => m.status === 'ready').length, quick: items.filter((m) => !['ready', 'offline', 'error'].includes(m.status)).length,
      proxy: items.filter((m) => ['queued', 'making'].includes(m.proxy)).length };
  },
  'GET /api/media/item': (req, res, u) => {
    const name = needProject(q(u, 'p')), m = mediaItem(name, String(q(u, 'id')));
    if (!m) throw err(404, 'media not found');
    return publicMedia(name, m);
  },
  'POST /api/import': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const b = await readJson(req);
    const added = [], skipped = [];
    for (const src of [].concat(b.folder || [], b.files || [])) {
      if (!fs.existsSync(src)) throw err(400, `Not found: ${src}`);
      const list = fs.statSync(src).isDirectory() ? scanFolder(src) : [{ file: src, bin: '' }];
      const binRoot = fs.statSync(src).isDirectory() ? path.basename(src) : '';
      for (const f of list) {
        const it = addMediaFile(name, f.file, { bin: [binRoot, f.bin].filter(Boolean).join('/') });
        (it ? added : skipped).push(f.file);
      }
    }
    saveMedia(name, true);
    return { added: added.length, skipped: skipped.length };
  },
  'POST /api/upload': (req, res, u) => new Promise((ok, bad) => {
    const name = needProject(q(u, 'p'));
    let fname = safeName(path.basename(q(u, 'name') || 'upload'));
    const { name: b, ext } = path.parse(fname);
    for (let i = 1; fs.existsSync(P(name, 'imports', fname)); i++) fname = `${b}_${i}${ext}`;
    const kind = EXT_KIND(ext);
    const dest = kind === 'lut' ? P(name, 'luts', fname) : kind === 'subs' ? P(name, 'subs', fname) : P(name, 'imports', fname);
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => {
      fs.renameSync(tmp, dest);
      if (kind === 'lut' || kind === 'subs') return ok({ kind, name: fname });
      const it = addMediaFile(name, dest, { bin: 'Uploads', imported: true });
      saveMedia(name, true);
      // read it now, ahead of any big folder still being read (the agent window waits for this song / voice-over)
      if (it) { const k = quickQ.findIndex((x) => x.proj === name && x.id === it.id); if (k > 0) quickQ.unshift(...quickQ.splice(k, 1)); pump(); }
      ok(it ? publicMedia(name, it) : { kind: 'other', name: fname, error: 'Not a video, image or audio file' });
    });
    req.on('error', (e) => { fs.rmSync(tmp, { force: true }); bad(e); });
  }),
  'DELETE /api/media': (req, res, u) => {
    const name = needProject(q(u, 'p')), db = mediaDb(name);
    const ids = new Set(String(q(u, 'id')).split(','));
    for (const m of db.items.filter((x) => ids.has(x.id))) {
      for (const f of [['thumbs', 'jpg'], ['strips', 'jpg'], ['waves', 'png'], ['proxies', 'mp4']]) fs.rmSync(P(name, 'cache', f[0], `${m.id}.${f[1]}`), { force: true });
      if (m.imported && m.path.startsWith(P(name, 'imports'))) fs.rmSync(m.path, { force: true }); // only our own copy, never the raw footage
    }
    db.items = db.items.filter((x) => !ids.has(x.id));
    saveMedia(name, true);
    return { removed: ids.size };
  },
  // 🗂 Media sambhaal (Phase 17): offline files and relinking them, packing, disk use and cleanup
  'GET /api/media/offline': (req, res, u) => {
    const name = needProject(q(u, 'p')); checkOffline(name, true);
    const used = usedMediaIds(name);
    return { missing: missingMedia(name).map((m) => ({ id: m.id, name: m.name, path: m.path, used: used.has(m.id), kind: m.kind, size: m.size || 0 })), dirs: relinkDirs(name) };
  },
  // body { dirs?: [folders to search first], auto: also the usual places } -> a job whose result is { found, notFound, searched }
  'POST /api/media/relink/scan': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    const dirs = [...(b.dirs || []).filter((d) => d && fs.existsSync(d)).map((d) => path.resolve(d)), ...(b.auto === false ? [] : relinkDirs(name))];
    return startTask('relink-scan', (job) => relinkScan(name, [...new Set(dirs)], (t) => { job.stage = t; job.log.push(t); }), { project: name });
  },
  // body { pairs: [{ id, to }] }
  'POST /api/media/relink/apply': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    return { relinked: relinkApply(name, b.pairs), offline: missingMedia(name).length };
  },
  'GET /api/disk': (req, res, u) => diskOf(needProject(q(u, 'p'))),
  'GET /api/disk/all': () => fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(PROJECTS, e.name, 'project.json')))
    .map((e) => ({ project: e.name, ...dirSize(path.join(PROJECTS, e.name)) })).sort((a, b) => b.bytes - a.bytes),
  // body { what: segments | undo | backups | orphans | renders, files: [render file names] }
  'POST /api/disk/clean': async (req, res, u) => { const name = needProject(q(u, 'p')), b = await readJson(req); return { ...diskClean(name, b.what, b.files), disk: diskOf(name) }; },
  // body { dest: folder, all: whole media pool, proxies: also the preview copies } -> a job; result { folder, files, bytes, missing }
  'POST /api/pack': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    if (!b.dest || !fs.existsSync(b.dest)) throw err(400, 'Folder not found');
    return startTask('pack', (job) => packProject(name, b, job), { project: name });
  },
  // 📋 the clipboard, kept here per person: copy in one tab / browser / link / computer, paste in any other
  // (it used to live only in the browser, so a copy made at localhost:3000 was not there at the team link or in another browser)
  'GET /api/clipboard': (req) => clipboards.get(req.who?.name || 'Owner') || null,
  'PUT /api/clipboard': async (req) => {
    const b = await readBody(req);
    if (b.length > 20e6) throw err(413, 'Too much to copy at once');
    const x = JSON.parse(b || 'null');
    clipboards.set(req.who?.name || 'Owner', x);
    return { ok: true };
  },
  // 📋 body { from, ids: [media ids], luts: [project LUT file names], subs: subtitle file name } -> { added, missing }
  'POST /api/media/bring': async (req, res, u) => {
    const to = needProject(q(u, 'p')), b = await readJson(req), from = needProject(b.from);
    if (from === to) return { added: 0, missing: [] };
    let added = 0; const missing = [];
    for (const id of [...new Set(b.ids || [])]) {
      const had = !!mediaItem(to, id);
      if (bringMedia(from, to, id)) { if (!had) added++; } else missing.push(id);
    }
    for (const n of b.luts || []) {
      const f = P(from, 'luts', path.basename(String(n))), t = P(to, 'luts', path.basename(String(n)));
      if (fs.existsSync(f) && !fs.existsSync(t)) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.copyFileSync(f, t); }
    }
    if (b.subs) { const f = P(from, 'subs', path.basename(String(b.subs))), t = P(to, 'subs', path.basename(String(b.subs))); if (fs.existsSync(f) && !fs.existsSync(t)) fs.copyFileSync(f, t); }
    saveMedia(to, true);
    return { added, missing };
  },
  'POST /api/media/reprocess': (req, res, u) => {
    const name = needProject(q(u, 'p')), m = mediaItem(name, q(u, 'id'));
    if (!m) throw err(404, 'media not found');
    m.status = 'queued'; enqueue(name, m.id);
    return { ok: true };
  },

  // LUTs & colour
  'GET /api/luts': (req, res, u) => Object.keys(lutMap(needProject(q(u, 'p')))).sort(),
  'GET /api/lut/file': (req, res, u) => {
    const f = lutMap(needProject(q(u, 'p')))[q(u, 'name')];
    if (!f) throw err(404, 'LUT not found');
    send(res, 200, fs.readFileSync(f, 'utf8'), 'text/plain; charset=utf-8');
  },
  // Auto colour for many clips: LOG detection (+ LUT), white balance, exposure, levels, saturation.
  'POST /api/color/auto': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const b = await readJson(req), luts = lutMap(name);
    const list = (b.clips || []).filter((c) => mediaItem(name, c.mediaId));
    if (!list.length) throw err(400, 'No video or photo clips to colour');
    return startTask('autocolor', async (job) => {
      const grades = {};
      for (const [i, c] of list.entries()) {
        const m = mediaItem(name, c.mediaId), file = analysisFile(name, m), image = m.kind === 'image';
        const span = { tin: +c.in || 0, tout: c.out ?? m.duration ?? 0, image };
        job.log.push(`[${i + 1}/${list.length}] ${m.name}`);
        job.progress = Math.round((i / list.length) * 100);
        const raw = await measure(file, span);
        if (!raw) continue;
        let lut = c.lut && luts[c.lut] ? c.lut : null, log = false;
        if (!lut && b.detectLog !== false && looksLog(raw, m)) { const g = guessLogLut(m); if (luts[g]) { lut = g; log = true; } }
        const stats = lut ? await measure(file, { ...span, color: { lut }, luts }) : raw;
        grades[c.id] = { ...(lut ? { lut } : {}), ...autoGrade(stats || raw, { strength: b.strength ?? 1 }), _log: log };
      }
      return { grades };
    }, { project: name });
  },
  // Shot match: target clip -> look of a (graded) reference clip.
  'POST /api/color/match': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const b = await readJson(req), luts = lutMap(name);
    const tm = mediaItem(name, b.target?.mediaId), rm = mediaItem(name, b.ref?.mediaId);
    if (!tm || !rm) throw err(400, 'Pick a target and a reference clip');
    const span = (c, m) => ({ tin: +c.in || 0, tout: c.out ?? m.duration ?? 0, image: m.kind === 'image' });
    const tLut = b.target.color?.lut;
    const [ts, rs] = await Promise.all([
      measure(analysisFile(name, tm), { ...span(b.target, tm), color: tLut ? { lut: tLut } : null, luts }),
      measure(analysisFile(name, rm), { ...span(b.ref, rm), color: b.ref.color || null, luts }),
    ]);
    if (!ts || !rs) throw err(500, 'Could not read frames from one of the clips');
    return { ...(tLut ? { lut: tLut } : {}), ...matchGrade(ts, rs) };
  },

  // renders
  'GET /api/renders': (req, res, u) => listDir(P(needProject(q(u, 'p')), 'renders'), (n) => /\.(mp4|mov)$/i.test(n) && n !== '_preview.mp4')
    .map((r) => ({ ...r, url: `/pf/${encodeURIComponent(q(u, 'p'))}/renders/${encodeURIComponent(r.name)}` })),
  'POST /api/render': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const b = await readJson(req);
    const { jobFile, out, preview } = prepareRender(name, b);
    return startJob(preview ? 'preview' : 'render', process.execPath, [path.join(ROOT, 'engine', 'render2.mjs'), jobFile],
      () => { if (!preview) fs.rmSync(jobFile, { force: true }); return { output: out, url: `/pf/${encodeURIComponent(name)}/renders/${encodeURIComponent(out)}?t=${Date.now()}` }; }, { project: name });
  },
  // ⤵ Nest: a sequence becomes one clip of another. It is rendered (its own frame shape, 1080p, loudness left as it is)
  // into imports/sequences/<id>.mp4 and added to the media pool (bin "Sequences"); m.seqOf / m.seqHash remember which
  // sequence and which version of it, so the editor can tell when the copy is out of date. Body { seq }.
  'POST /api/seq/render': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    const saved = readJSON(P(name, 'project.json')), view = seqView(saved, b.seq), sname = view.seq?.name || seqOf(saved).name;
    const out = P(name, 'imports', 'sequences', `${safeName(b.seq)}.mp4`), jobFile = P(name, 'cache', `nest-${safeName(b.seq)}.json`);
    prepareRender(name, { project: saved, seq: b.seq, preset: 'master', quality: { res: 1080, crf: 16 }, filename: 'nest' }, { write: false, jobFile });
    const j = readJSON(jobFile);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    Object.assign(j, { output: `${out}.part.mp4` }); j.export = { ...j.export, loudness: 'off' };
    writeJSON(jobFile, j);
    return startTask('nest', async (job) => {
      job.stage = `Rendering "${sname}"…`;
      const r = await run(process.execPath, [path.join(ROOT, 'engine', 'render2.mjs'), jobFile], { onLine: (l) => { const m = /\[(\d+)\/(\d+)\]/.exec(l); if (m) job.progress = Math.round((+m[1] / +m[2]) * 90); } });
      fs.rmSync(jobFile, { force: true });
      if (r.code !== 0) { fs.rmSync(`${out}.part.mp4`, { force: true }); throw new Error(`Could not render "${sname}": ${r.stderr.trim().split(/\r?\n/).pop()}`); }
      fs.renameSync(`${out}.part.mp4`, out);
      let it = mediaDb(name).items.find((m) => m.seqOf === b.seq);
      if (it) { const st = fs.statSync(out); Object.assign(it, { size: st.size, mtime: st.mtimeMs, status: 'queued' }); enqueue(name, it.id); }
      else it = addMediaFile(name, out, { bin: 'Sequences' }) || mediaDb(name).items.find((m) => m.path.toLowerCase() === path.resolve(out).toLowerCase());
      Object.assign(it, { seqOf: b.seq, seqHash: seqHash(view), name: `🎞 ${sname}` });
      saveMedia(name, true);
      if (activeProject !== name) { activeProject = name; pump(); }
      for (let i = 0; i < 60 && !['ready', 'error', 'offline'].includes(mediaItem(name, it.id)?.status); i++) await new Promise((ok) => setTimeout(ok, 300));
      return { mediaId: it.id, duration: mediaItem(name, it.id)?.duration, name: sname };
    }, { project: name });
  },
  // 🎚 Audio studio - voice and music apart (Demucs, offline): body { mediaId, in, out } (seconds in the file; the part
  // the clip uses). Two WAVs in imports/stems -> media (bin "Stems"); they start at `in`, so they line up with the clip.
  'POST /api/audio/stems': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), m = mediaItem(name, b.mediaId);
    if (!m?.hasAudio) throw err(400, 'This clip has no sound');
    const t0 = Math.max(0, +b.in || 0), t1 = Math.min(m.duration || 1e9, +b.out || m.duration || 0);
    if (!(t1 - t0 > 0.5)) throw err(400, 'The part is too short');
    return startTask('stems', async (job) => {
      const base = safeName(`${path.parse(m.name).name} ${Math.round(t0)}-${Math.round(t1)}s`), dir = P(name, 'imports', 'stems'), work = fs.mkdtempSync(path.join(P(name, 'cache'), 'stems-'));
      fs.mkdirSync(dir, { recursive: true });
      try {
        job.stage = 'Reading the sound…'; job.progress = 3;
        const wav = path.join(work, 'in.wav');
        const a = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t0), '-t', String(t1 - t0), '-i', analysisFile(name, m), '-vn', '-ac', '2', '-ar', '44100', wav]);
        if (a.code !== 0) throw new Error(`Could not read the sound: ${a.stderr.slice(-200)}`);
        job.stage = 'Separating voice and music (first time: downloads the model, ~80 MB)…';
        const r = await run(PYTHON, ['-m', 'demucs', '--two-stems=vocals', '-n', 'htdemucs', '-o', work, wav], {
          onLine: () => {} });
        const out = path.join(work, 'htdemucs', 'in');
        if (r.code !== 0 || !fs.existsSync(path.join(out, 'vocals.wav'))) throw new Error(`Separation failed: ${r.stderr.trim().split(/\r?\n/).filter((l) => !/%\|/.test(l)).pop() || 'unknown error'}`);
        const voice = path.join(dir, `${base} - voice.wav`), music = path.join(dir, `${base} - music.wav`);
        fs.copyFileSync(path.join(out, 'vocals.wav'), voice); fs.copyFileSync(path.join(out, 'no_vocals.wav'), music);
        job.progress = 92;
        const ids = [voice, music].map((f) => (addMediaFile(name, f, { bin: 'Stems', imported: true }) || mediaDb(name).items.find((x) => x.path.toLowerCase() === path.resolve(f).toLowerCase()))?.id);
        saveMedia(name, true);
        if (activeProject !== name) { activeProject = name; pump(); }
        for (let i = 0; i < 60 && ids.some((id) => mediaItem(name, id)?.status !== 'ready'); i++) await sleep(300);
        return { voice: ids[0], music: ids[1], from: t0, to: t1 };
      } finally { fs.rmSync(work, { recursive: true, force: true }); }
    }, { project: name });
  },
  // 🎙 how loud each piece is (integrated LUFS) - podcast mode levels every mic the same. Body { clips: [{ id, mediaId, in, out }] }
  'POST /api/audio/levels': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), out = {};
    for (const c of (b.clips || []).slice(0, 200)) {
      const m = mediaItem(name, c.mediaId); if (!m?.hasAudio) continue;
      const t0 = +c.in || 0, t1 = c.out ?? m.duration;
      const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(t0), '-t', String(Math.max(0.5, t1 - t0)), '-i', analysisFile(name, m), '-vn', '-af', 'ebur128', '-f', 'null', '-']);
      const x = /I:\s*(-?[\d.]+) LUFS/.exec(r.stderr.slice(r.stderr.lastIndexOf('Summary')));
      if (x && +x[1] > -60) out[c.id] = +x[1];
    }
    return out;
  },
  // 🎵 beat grid of a music file: { period, first, bpm, duration }
  'GET /api/music/beats': async (req, res, u) => {
    const name = needProject(q(u, 'p')), m = mediaItem(name, q(u, 'id'));
    if (!m?.hasAudio) throw err(404, 'music not found');
    const { beats } = await import('./engine/music.mjs');
    return { ...(beats(m.path) || {}), duration: m.duration };
  },
  // 👥 who is asking, project locks, team settings (owner)
  'GET /api/me': (req) => ({ name: req.who.name, role: req.who.role, local: !!req.who.local, shared: req.who.role === 'viewer' ? [] : sharedDirs(), anyFolder: req.who.role === 'owner' || (req.who.role === 'editor' && !!teamCfg().editorsAnyFolder) }), // (shared: where an editor may save exports)
  // 📊 an editor tab in use pings this about once a minute (a GET, so viewers count too)
  'GET /api/presence': (req, res, u) => {
    addBeat(presence, { name: whoLabel(req.who), project: (q(u, 'p') || '').slice(0, 120), where: req.who.local ? 'this PC' : ipOf(req) });
    savePresence();
    return { ok: true };
  },
  // the owner's view: every person's time today / 7 days / 30 days, per day, each session, and the sign-ins
  'GET /api/team/sessions': () => ({ now: Date.now(), keepDays: KEEP_DAYS, people: presenceSummary(presence), logins: [...(presence.logins || [])].reverse().slice(0, 500) }),
  // heartbeat from an open project (every 15 s): { ok, holder } - ok false = someone else is editing it
  'POST /api/lock': (req, res, u) => {
    const name = needProject(q(u, 'p')), client = String(q(u, 'client') || ''), h = lockHolder(name, client);
    if (h) return { ok: false, holder: h.name, since: h.at };
    if (req.who.role !== 'viewer') locks.set(name, { name: req.who.name, client, at: Date.now() });
    return { ok: req.who.role !== 'viewer', holder: null };
  },
  'POST /api/unlock': (req, res, u) => { const l = locks.get(q(u, 'p')); if (l && l.client === q(u, 'client')) locks.delete(q(u, 'p')); return { ok: true }; },
  'GET /api/team': () => teamView(),
  // the Desktop shortcut file for other PCs (same as the sign-in page's ⬇ link)
  'GET /api/team/shortcut': (req, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Limelight Editor.url"' }); res.end(shortcutFile()); },
  // body { on?, addUser?: { name, password, role }, removeUser?: name, setRole?: { name, role }, resetPassword?: { name, password }, libraries? }
  'PUT /api/team': async (req) => {
    const b = await readJson(req), t = teamCfg();
    t.users ||= []; t.libraries ||= [];
    if (b.addUser) {
      const n = String(b.addUser.name || '').trim();
      if (!n || !b.addUser.password || String(b.addUser.password).length < 6) throw err(400, 'A name and a password of at least 6 characters');
      if (t.users.some((x) => x.name.toLowerCase() === n.toLowerCase())) throw err(400, 'That name is taken');
      const salt = crypto.randomBytes(12).toString('hex');
      t.users.push({ name: n, role: ['editor', 'viewer', 'owner'].includes(b.addUser.role) ? b.addUser.role : 'editor', salt, hash: hashPw(b.addUser.password, salt) });
    }
    if (b.removeUser) { t.users = t.users.filter((x) => x.name !== b.removeUser); for (const [k, s] of sessions) if (s.name === b.removeUser) sessions.delete(k); }
    if (b.setRole) { const x = t.users.find((y) => y.name === b.setRole.name); if (x) x.role = b.setRole.role; for (const s of sessions.values()) if (s.name === b.setRole.name) s.role = b.setRole.role; }
    if (b.resetPassword) { const x = t.users.find((y) => y.name === b.resetPassword.name); if (x) { x.salt = crypto.randomBytes(12).toString('hex'); x.hash = hashPw(b.resetPassword.password, x.salt); } for (const [k, s] of sessions) if (s.name === b.resetPassword.name) sessions.delete(k); }
    if (Array.isArray(b.libraries)) { for (const l of b.libraries) if (!fs.existsSync(l)) throw err(400, `Folder not found: ${l}`); t.libraries = b.libraries; }
    if (typeof b.editorsAnyFolder === 'boolean') t.editorsAnyFolder = b.editorsAnyFolder; // 📁 editors may save exports anywhere on this computer
    if (typeof b.on === 'boolean') { t.on = b.on; if (b.on && !t.users.length) throw err(400, 'Add at least one person first'); }
    saveTeam(t);
    if (b.on === true) await startTeam(); else if (b.on === false) stopTeam();
    // users of a team role change in their own sessions right away (see sessions); the role check uses the stored user
    for (const s of sessions.values()) { const x = t.users.find((y) => y.name === s.name); if (x) s.role = x.role; }
    return teamView();
  },
  // ⚙ Batch: body { ids, actions: ['subs'|'transcript'|'scan'|'convert'], opts: { subs: { lang, model }, convert: { preset, aspect, logo, subs } }, runAt }
  'POST /api/batch': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    if (!b.ids?.length) throw err(400, 'Pick some clips first');
    if (!b.actions?.length) throw err(400, 'Tick at least one job');
    const made = addBatch(name, b.ids, b.actions, b.opts || {}, b.runAt ? new Date(b.runAt).toISOString() : null);
    if (!made.length) throw err(400, 'None of those clips fits these jobs (subtitles need sound; scans need pictures)');
    return { added: made.length };
  },
  'GET /api/batch': (req, res, u) => bq.items.filter((x) => !q(u, 'p') || x.project === q(u, 'p')).slice(-200),
  'POST /api/batch/cancel': (req, res, u) => { for (const it of bq.items) if ((it.id === q(u, 'id') || q(u, 'all')) && it.state === 'waiting' && (!q(u, 'p') || it.project === q(u, 'p'))) it.state = 'cancelled'; saveBatch(); return { ok: true }; },
  'POST /api/batch/clear': (req, res, u) => { bq.items = bq.items.filter((x) => ['waiting', 'running'].includes(x.state) || (q(u, 'p') && x.project !== q(u, 'p'))); saveBatch(); return { ok: true }; },
  'POST /api/batch/retry': (req, res, u) => { const it = bq.items.find((x) => x.id === q(u, 'id') && x.state === 'failed'); if (it) { it.state = 'waiting'; it.error = null; saveBatch(); pumpBatch(); } return { ok: !!it }; },
  // 👁 watch folder of a project: { folder, on, scan, transcript, subs, lang }
  'GET /api/automation': (req, res, u) => readJSON(autoFile(needProject(q(u, 'p'))), { watch: {} }),
  'PUT /api/automation': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), a = readJSON(autoFile(name), {});
    if (b.watch?.folder && !fs.existsSync(b.watch.folder)) throw err(400, `Folder not found: ${b.watch.folder}`);
    a.watch = { ...(a.watch || {}), ...pick(b.watch || {}, ['folder', 'on', 'scan', 'transcript', 'subs', 'lang']) };
    writeJSON(autoFile(name), a);
    if (a.watch.on) watchTick().catch(() => {});
    return a;
  },
  // 📝 Text editing: a clip's words with their times (seconds in the file), made once and kept in
  // cache/transcripts/<id>.json ({ language, model, segments: [{ start, end, text, words: [{ s, e, w }] }] })
  'GET /api/transcript': (req, res, u) => {
    const f = P(needProject(q(u, 'p')), 'cache', 'transcripts', `${String(q(u, 'id')).replace(/[^0-9a-f]/g, '')}.json`);
    if (!fs.existsSync(f)) throw err(404, 'not transcribed yet');
    return readJSON(f);
  },
  'POST /api/transcript': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), m = mediaItem(name, b.mediaId);
    if (!m || !m.hasAudio) throw err(400, 'This clip has no sound to transcribe');
    const dir = P(name, 'cache', 'transcripts'); fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${m.id}.json`), tmp = path.join(dir, `${m.id}.part.json`);
    const args = [path.join(ROOT, 'engine', 'transcribe.py'), analysisFile(name, m), '--out', path.join(dir, `${m.id}.srt`), '--json', tmp,
      '--lang', b.lang || 'auto', '--model', b.model || 'medium', '--words', '99']; // > 0: every word with its time (the SRT is not used)
    if (b.prompt) args.push('--prompt', b.prompt);
    return startJob('transcript', PYTHON, args, () => {
      const j = readJSON(tmp, null);
      if (!j) throw new Error('No transcript was written');
      writeJSON(out, { ...j, model: b.model || 'medium', mediaId: m.id, at: Date.now() });
      fs.rmSync(tmp, { force: true }); fs.rmSync(path.join(dir, `${m.id}.srt`), { force: true });
      return { mediaId: m.id, segments: j.segments.length };
    }, { project: name, label: m.name });
  },
  // 🚀 Publish: accounts (never the tokens themselves), connect / disconnect, queue an upload, the history
  'GET /api/publish/accounts': () => {
    const c = pubCfg();
    return { youtube: { client: !!c.youtube?.clientId, connected: !!c.youtube?.refreshToken, channel: c.youtube?.channel || null, redirect: `${APP_URL}/oauth/youtube` },
      meta: { connected: !!c.meta?.pages?.length, pages: (c.meta?.pages || []).map((p) => ({ id: p.id, name: p.name, ig: p.ig })) } };
  },
  'PUT /api/publish/youtube': async (req) => {
    const b = await readJson(req), c = pubCfg();
    if (!String(b.clientId || '').includes('.apps.googleusercontent.com') || !b.clientSecret) throw err(400, 'Paste the OAuth Client ID (ends in .apps.googleusercontent.com) and its Client secret');
    c.youtube = { clientId: b.clientId.trim(), clientSecret: b.clientSecret.trim() }; savePubCfg(c);
    const { youtubeAuthUrl } = await import('./engine/publish.mjs');
    return { authUrl: youtubeAuthUrl({ clientId: c.youtube.clientId, redirect: `${APP_URL}/oauth/youtube` }) };
  },
  'GET /oauth/youtube': async (req, res, u) => {
    const page = (msg, ok) => send(res, 200, `<!doctype html><meta charset="utf-8"><title>YouTube</title><body style="font:16px Segoe UI,sans-serif;background:#0d0f13;color:#e6e8ed;display:grid;place-items:center;height:100vh"><div><h2 style="color:${ok ? '#36c27e' : '#ff5d5d'}">${ok ? '✓ YouTube connected' : 'Not connected'}</h2><p>${msg}</p><p>You can close this tab and go back to the editor.</p></div></body>`, 'text/html; charset=utf-8');
    if (q(u, 'error')) return page(`Google said: ${String(q(u, 'error')).replace(/[<>&]/g, '')}`, false);
    const c = pubCfg();
    if (!c.youtube?.clientId) return page('Set the OAuth client first (🚀 Publish > Accounts).', false);
    try {
      const P2 = await import('./engine/publish.mjs');
      const t = await P2.youtubeExchange({ clientId: c.youtube.clientId, clientSecret: c.youtube.clientSecret, redirect: `${APP_URL}/oauth/youtube`, code: q(u, 'code') });
      c.youtube.refreshToken = t.refresh_token;
      try { c.youtube.channel = await P2.youtubeChannel(c.youtube); } catch {}
      savePubCfg(c);
      return page(`Uploads will go to <b>${String(c.youtube.channel || 'your channel').replace(/[<>&]/g, '')}</b>.`, true);
    } catch (e) { return page(String(e.message).replace(/[<>&]/g, ''), false); }
  },
  'PUT /api/publish/meta': async (req) => {
    const b = await readJson(req);
    if (!String(b.token || '').trim()) throw err(400, 'Paste a Facebook access token');
    const { metaPages } = await import(`./engine/publish.mjs?v=${Math.round(fs.statSync(path.join(ROOT, 'engine', 'publish.mjs')).mtimeMs)}`);
    const pages = await metaPages(b.token.trim());
    if (!pages.length) throw err(400, 'This token can see no Facebook Page - it needs pages_show_list, pages_manage_posts (and instagram_content_publish for Instagram)');
    const c = pubCfg(); c.meta = { pages }; savePubCfg(c);
    return { pages: pages.map((p) => ({ id: p.id, name: p.name, ig: p.ig })) };
  },
  'POST /api/publish/disconnect': async (req, res, u) => { const c = pubCfg(); delete c[q(u, 'what') === 'youtube' ? 'youtube' : 'meta']; savePubCfg(c); return { ok: true }; },
  // body { render, title, description, tags[], thumbnail, coverAt, targets: [{ platform, pageId?, privacy?, publishAt? }] }
  'POST /api/publish': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    if (!b.render || !fs.existsSync(P(name, 'renders', path.basename(b.render)))) throw err(400, 'Pick a finished video (Renders)');
    if (!String(b.title || '').trim()) throw err(400, 'Write a title');
    if (!b.targets?.length) throw err(400, 'Tick at least one place to publish');
    const made = b.targets.map((t) => {
      const later = t.publishAt && new Date(t.publishAt).getTime() > Date.now() + 60e3;
      const it = { id: crypto.randomBytes(5).toString('hex'), project: name, render: path.basename(b.render), title: String(b.title).trim(), description: b.description || '', tags: b.tags || [],
        thumbnail: b.thumbnail || null, coverAt: +b.coverAt || 0, platform: t.platform, pageId: t.pageId || null, privacy: t.privacy || 'public', publishAt: later ? new Date(t.publishAt).toISOString() : null,
        shorts: !!b.shorts, state: later && t.platform === 'instagram' ? 'scheduled' : 'waiting', progress: 0, added: Date.now() };
      pub.items.push(it); return it;
    });
    savePub(); pumpPublish();
    return { added: made.map(pubView) };
  },
  'GET /api/publish/list': (req, res, u) => pub.items.filter((x) => !q(u, 'p') || x.project === q(u, 'p')).slice(-40).reverse().map(pubView),
  'POST /api/publish/cancel': (req, res, u) => { const it = pub.items.find((x) => x.id === q(u, 'id')); if (!it || !['waiting', 'scheduled'].includes(it.state)) throw err(400, 'Only a waiting post can be cancelled'); it.state = 'cancelled'; savePub(); return { ok: true }; },
  'POST /api/publish/retry': (req, res, u) => { const it = pub.items.find((x) => x.id === q(u, 'id')); if (!it || it.state !== 'failed') throw err(400, 'Only a failed upload can be tried again'); it.state = it.publishAt && new Date(it.publishAt) > new Date() && it.platform === 'instagram' ? 'scheduled' : 'waiting'; it.error = null; savePub(); pumpPublish(); return { ok: true }; },
  // 🖼 Thumbnail maker: the best frames of a render (or, with none, of the open timeline's shots) -> cache/thumbcand
  'POST /api/thumb/frames': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    let items = [];
    const renders = listDir(P(name, 'renders'), (n) => /\.mp4$/i.test(n) && n !== '_preview.mp4');
    const rname = b.render || renders[0]?.name;
    if (rname && fs.existsSync(P(name, 'renders', path.basename(rname)))) {
      const f = P(name, 'renders', path.basename(rname)), d = +(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).stdout || 0;
      items = Array.from({ length: 30 }, (_, i) => ({ file: f, t: +((d * (i + 0.5)) / 30).toFixed(2), src: path.basename(rname) }));
    } else {
      const pj = readJSON(P(name, 'project.json'));
      for (const c of (pj.tracks.V1 || []).filter((x) => x.type === 'video')) {
        const m = mediaItem(name, c.mediaId); if (!m) continue;
        const a = +c.in || 0, z = c.out ?? m.duration;
        for (const k of [0.2, 0.5, 0.8]) items.push({ file: analysisFile(name, m), t: +(a + (z - a) * k).toFixed(2), src: m.name });
      }
      items = items.filter((_, i) => i % Math.max(1, Math.ceil(items.length / 36)) === 0);
    }
    if (!items.length) throw err(400, 'Render the video first (or put shots on the timeline)');
    const dir = P(name, 'cache', 'thumbcand');
    fs.rmSync(dir, { recursive: true, force: true });
    return startTask('thumbs', async (job) => {
      job.stage = 'Looking for the best frames…';
      const reqFile = P(name, 'cache', 'thumbpick.json');
      writeJSON(reqFile, { items, out: dir, keep: 9, model: path.join(ROOT, 'Models', 'face_detection_yunet_2023mar.onnx') });
      const r = await run(PYTHON, [path.join(ROOT, 'engine', 'thumbpick.py'), reqFile]);
      if (r.code !== 0) throw new Error(`Could not read the frames: ${r.stderr.trim().split(/\r?\n/).pop()}`);
      const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
      return { from: rname || 'timeline', frames: out.frames.map((f) => ({ ...f, file: undefined, url: `/api/thumb/cand?p=${encodeURIComponent(name)}&f=${encodeURIComponent(path.basename(f.file))}&v=${Date.now()}` })) };
    }, { project: name });
  },
  'GET /api/thumb/cand': (req, res, u) => serveFile(req, res, P(needProject(q(u, 'p')), 'cache', 'thumbcand', path.basename(q(u, 'f') || ''))),
  // a finished thumbnail (PNG from the designer) -> exports/thumbnails/<name>.png
  'POST /api/thumb/save': (req, res, u) => new Promise((ok, bad) => {
    const name = needProject(q(u, 'p')), dir = P(name, 'exports', 'thumbnails');
    fs.mkdirSync(dir, { recursive: true });
    const base = safeName(q(u, 'name') || 'thumbnail').replace(/\.png$/i, '');
    let f = `${base}.png`; for (let i = 2; fs.existsSync(path.join(dir, f)); i++) f = `${base} ${i}.png`;
    const out = fs.createWriteStream(path.join(dir, f));
    req.pipe(out); out.on('finish', () => ok({ name: f, url: `/pf/${encodeURIComponent(name)}/thumbnails/${encodeURIComponent(f)}` })); req.on('error', bad);
  }),
  'GET /api/thumb/list': (req, res, u) => listDir(P(needProject(q(u, 'p')), 'exports', 'thumbnails'), (n) => /\.png$/i.test(n)).map((x) => ({ ...x, url: `/pf/${encodeURIComponent(q(u, 'p'))}/thumbnails/${encodeURIComponent(x.name)}` })),
  // 📊 motion graphics: the editor sends a graphic's frames (transparent PNGs) once, then it becomes cache/graphics/<key>.mov
  'GET /api/gfx/has': (req, res, u) => ({ ok: fs.existsSync(P(needProject(q(u, 'p')), 'cache', 'graphics', `${String(q(u, 'key')).replace(/[^0-9a-f]/g, '')}.mov`)) }),
  'POST /api/gfx/frame': (req, res, u) => new Promise((ok, bad) => {
    const name = needProject(q(u, 'p')), key = String(q(u, 'key')), i = +q(u, 'i');
    if (!/^[0-9a-f]{8}$/.test(key) || !(i >= 0 && i < 100000)) return bad(err(400, 'bad frame'));
    const dir = P(name, 'cache', 'graphics', key); fs.mkdirSync(dir, { recursive: true });
    const out = fs.createWriteStream(path.join(dir, `${String(i).padStart(5, '0')}.png`));
    req.pipe(out); out.on('finish', () => ok({ ok: true })); req.on('error', bad);
  }),
  'POST /api/gfx/done': async (req, res, u) => {
    const name = needProject(q(u, 'p')), key = String(q(u, 'key')), fps = +q(u, 'fps') || 30;
    if (!/^[0-9a-f]{8}$/.test(key)) throw err(400, 'bad key');
    const dir = P(name, 'cache', 'graphics', key), out = P(name, 'cache', 'graphics', `${key}.mov`);
    const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(dir, '%05d.png'), '-c:v', 'png', '-pix_fmt', 'rgba', `${out}.part.mov`]);
    if (r.code !== 0) throw err(500, `Could not build the graphic: ${r.stderr.slice(-200)}`);
    fs.renameSync(`${out}.part.mov`, out); fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  },
  // 🤖 AI picture tools: faces + motion through a piece of a clip (engine/vision.py), for 🎯 Follow faces and
  // 🙈 Blur faces (public/js/aitools.js turns them into keyframes / masks). Body { mediaId, in, out } (seconds in the file)
  'POST /api/ai/vision': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), m = mediaItem(name, b.mediaId);
    if (!m || m.kind !== 'video') throw err(400, 'This needs a video clip');
    const t0 = Math.max(0, +b.in || 0), t1 = Math.min(m.duration || 1e9, +b.out || m.duration || 0);
    if (!(t1 - t0 > 0.1)) throw err(400, 'The clip is too short');
    return startTask('vision', async (job) => {
      job.stage = 'Looking for faces…';
      const model = path.join(ROOT, 'Models', 'face_detection_yunet_2023mar.onnx');
      let partial = '';
      const r = await new Promise((ok) => {
        const p = spawn(PYTHON, [path.join(ROOT, 'engine', 'vision.py'), analysisFile(name, m), String(t0), String(t1), '--fps', String(+b.fps || 6), ...(fs.existsSync(model) ? ['--model', model] : [])], { windowsHide: true });
        let out = '', e = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => { e += d; partial = String(d); const x = /PROGRESS (\d+)/.exec(partial); if (x) job.progress = +x[1]; });
        p.on('close', (code) => ok({ code, out, e }));
      });
      if (r.code !== 0) throw new Error(`Could not look at the clip: ${r.e.trim().split(/\r?\n/).pop()}`);
      return { ...JSON.parse(r.out.trim().split(/\r?\n/).pop()), yunet: fs.existsSync(model) };
    }, { project: name });
  },
  // ✂ one-click roto: a subject matte video (white = the person / animal / vehicle) for a piece of a clip, made on the
  // GPU by engine/matte.py. Body { mediaId, in, out } (seconds in the file). Kept in cache/mattes (made once);
  // Motion and Fusion cut the subject out with it (text behind a person…).
  'POST /api/matte': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), m = mediaItem(name, b.mediaId);
    if (!m || m.kind !== 'video') throw err(400, 'This needs a video clip');
    const t0 = Math.max(0, +(+b.in || 0).toFixed(3)), t1 = Math.min(m.duration || 1e9, +(+b.out || m.duration || 0).toFixed(3));
    if (!(t1 - t0 > 0.1)) throw err(400, 'The clip is too short');
    const quality = b.quality === 'fast' ? 'fast' : 'best';
    const fps = Math.min(60, Math.max(10, +b.fps || m.fps || 30)), file = `${m.id}-${t0}-${t1}-${fps}-v2${quality}.mp4`, out = P(name, 'cache', 'mattes', file);
    if (fs.existsSync(out)) return startTask('matte', async () => ({ file, cached: true }), { project: name });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    return startTask('matte', async (job) => {
      job.stage = 'Finding the subject (AI)…';
      const r = await run(PYTHON, [path.join(ROOT, 'engine', 'matte.py'), analysisFile(name, m), String(t0), String(t1), `${out}.part.mp4`, '--fps', String(fps), '--quality', quality], {
        onLine: (l) => { const x = /\[(\d+)\/(\d+)\]/.exec(l); if (x) job.progress = Math.round((+x[1] / +x[2]) * 100); } });
      if (r.code !== 0 || !fs.existsSync(`${out}.part.mp4`)) { fs.rmSync(`${out}.part.mp4`, { force: true }); throw new Error(`Could not cut out the subject: ${r.stderr.trim().split(/\r?\n/).pop()}`); }
      fs.renameSync(`${out}.part.mp4`, out);
      return { file };
    }, { project: name });
  },
  'GET /api/matte/file': (req, res, u) => serveFile(req, res, P(needProject(q(u, 'p')), 'cache', 'mattes', path.basename(q(u, 'f') || '')), true),
  // 🧠 Smart scan: every video / photo gets shot tags (wide, close-up, drone, people…), and the scan finds near-identical
  // clips and clips worth a second look. Body { ids? } (default: all). Results go into media.json (m.tags, m.shot,
  // m.quality, m.bad) and cache/footage.json (duplicates).
  'POST /api/footage/scan': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    const want = b.ids?.length ? new Set(b.ids) : null;
    const list = mediaDb(name).items.filter((m) => (m.kind === 'video' || m.kind === 'image') && m.status === 'ready' && !m.seqOf && (!want || want.has(m.id)));
    if (!list.length) throw err(400, 'No ready videos or photos to look at yet');
    if (!(healthCache || (await checkHealth())).clip) throw err(400, 'The picture model (Python + open_clip) is not installed - the agent needs it too');
    return startTask('footage', async (job) => {
      const frames = {};
      for (const [k, m] of list.entries()) {
        job.stage = `Looking at ${m.name} (${k + 1}/${list.length})`; job.progress = Math.round((k / list.length) * 45);
        const proxy = m.proxy === 'ready' ? P(name, 'cache', 'proxies', `${m.id}.mp4`) : null, src = proxy || m.path;
        if (!fs.existsSync(src)) continue;
        const keyOnly = !proxy && m.kind === 'video' && needsProxy(m); // big camera file: only its keyframes (much faster)
        const fdir = P(name, 'cache', 'agent', 'frames', m.id), an = P(name, 'cache', 'analysis', `${m.id}.json`);
        try {
          if (m.kind === 'video') await analyzeClip(src, an, { hasAudio: m.hasAudio, duration: m.duration, keyOnly, framesDir: keyOnly ? fdir : null });
          frames[m.id] = await extractFrames(src, fdir, { duration: m.duration, image: m.kind === 'image', keyOnly });
        } catch (e) { job.log.push(`${m.name}: ${e.message}`); }
      }
      job.stage = 'Understanding the pictures…'; job.progress = 45;
      const r = await footageWorker().send({ cmd: 'scan', cacheDir: P(name, 'cache', 'agent', 'emb'), media: list.filter((m) => frames[m.id]?.length).map((m) => ({ id: m.id, frames: frames[m.id] })) },
        (p, msg) => { job.progress = 45 + Math.round(p * 0.5); if (/loading/.test(msg)) job.stage = 'Loading the picture model (first time: a minute)…'; else job.stage = 'Understanding the pictures…'; });
      const bad = [];
      for (const m of list) {
        const x = r.media[m.id];
        if (x) Object.assign(m, { tags: x.tags, shot: x.shot, quality: x.quality });
        const reasons = badReasons(m, readJSON(P(name, 'cache', 'analysis', `${m.id}.json`), null), x?.quality);
        if (reasons.length) { m.bad = reasons; bad.push({ id: m.id, reasons }); } else delete m.bad;
      }
      saveMedia(name, true);
      // duplicate groups: clips joined by near-identical pairs
      const parent = {}, find = (x) => (parent[x] === undefined || parent[x] === x ? x : (parent[x] = find(parent[x])));
      for (const [a, c] of r.dups) parent[find(a)] = find(c);
      const groups = {};
      for (const [a, c] of r.dups) for (const id of [a, c]) (groups[find(id)] ||= new Set()).add(id);
      const dups = Object.values(groups).map((g) => [...g]);
      writeJSON(P(name, 'cache', 'footage.json'), { at: Date.now(), dups });
      return { tagged: Object.keys(r.media).length, dups, bad };
    }, { project: name });
  },
  'GET /api/footage': (req, res, u) => readJSON(P(needProject(q(u, 'p')), 'cache', 'footage.json'), { dups: [] }),
  // 🔎 "jharna dikhao": clips whose pictures look like the words (Hindi / Hinglish / English). Needs a smart scan first.
  'POST /api/footage/search': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    const en = toEnglishQuery(b.q);
    if (!en) throw err(400, 'Type what to look for');
    const ids = mediaDb(name).items.filter((m) => m.tags).map((m) => m.id);
    if (!ids.length) throw err(400, 'Run 🧠 Smart scan once first - it lets the editor understand your footage');
    const r = await footageWorker().send({ cmd: 'search', cacheDir: P(name, 'cache', 'agent', 'emb'), ids, q: en, top: 40 });
    return { q: en, results: r.results };
  },
  // move clips to another folder (bin) of the media pool, e.g. "Rejects". Body { ids, bin }
  'POST /api/media/bin': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), ids = new Set(b.ids || []);
    let n = 0;
    for (const m of mediaDb(name).items) if (ids.has(m.id)) { m.bin = String(b.bin || '').replace(/[\\]/g, '/').slice(0, 120); n++; }
    saveMedia(name, true);
    return { moved: n };
  },
  // 🎨 cameras on the timeline: which clips came from which camera (same codec / size / frame rate / bit depth)
  // Body { clips: [{ id, mediaId, in, out, color }], ref: cameraKey } -> one correction per other camera, to lay over
  // each of its clips' grade so they all look like the reference camera.
  'POST /api/footage/matchcams': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), luts = lutMap(name);
    const groups = {};
    for (const c of b.clips || []) { const m = mediaItem(name, c.mediaId); if (m?.kind === 'video' && !m.seqOf) (groups[cameraKey(m)] ||= []).push({ c, m }); }
    if (!groups[b.ref]) throw err(400, 'Pick the camera to match the others to');
    if (Object.keys(groups).length < 2) throw err(400, 'All clips on the timeline come from one camera');
    return startTask('matchcams', async (job) => {
      // average look of a camera: a few of its clips, each with its own grade
      const look = async (list) => {
        const st = [];
        for (const { c, m } of list.filter((_, i) => i % Math.ceil(list.length / 5) === 0).slice(0, 5)) {
          const x = await measure(analysisFile(name, m), { tin: +c.in || 0, tout: c.out ?? m.duration ?? 0, color: c.color || null, luts });
          if (x) st.push(x);
        }
        if (!st.length) return null;
        const avg = (k) => [0, 1, 2].map((i) => st.reduce((s, x) => s + x[k][i], 0) / st.length);
        return { mean: avg('mean'), std: avg('std') };
      };
      job.stage = 'Measuring the reference camera…'; job.progress = 5;
      const ref = await look(groups[b.ref]);
      if (!ref) throw new Error('Could not read the reference camera clips');
      const out = {}, keys = Object.keys(groups).filter((k) => k !== b.ref);
      for (const [i, k] of keys.entries()) {
        job.stage = `Matching ${k} (${i + 1}/${keys.length})…`; job.progress = 10 + Math.round((i / keys.length) * 85);
        const t = await look(groups[k]);
        if (t) out[k] = { fix: matchGrade(t, ref), clips: groups[k].map((x) => x.c.id) };
      }
      return { ref: b.ref, cameras: out };
    }, { project: name });
  },
  // 🕘 Versions: auto backups + named versions, newest first
  'GET /api/versions': (req, res, u) => {
    const name = needProject(q(u, 'p')), dir = P(name, 'backups'), nd = path.join(dir, 'named');
    const list = [...(fs.existsSync(nd) ? fs.readdirSync(nd).filter((f) => f.endsWith('.json')).map((f) => versionInfo(name, path.join(nd, f), true)) : []),
      ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => versionInfo(name, path.join(dir, f), false))].filter(Boolean);
    return list.sort((a, b) => b.mtime - a.mtime);
  },
  'POST /api/versions/save': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), nd = P(name, 'backups', 'named');
    fs.mkdirSync(nd, { recursive: true });
    const d = new Date(), p2 = (x) => String(x).padStart(2, '0');
    const file = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())} ${safeName(b.label || 'Version').slice(0, 60)}.json`;
    fs.copyFileSync(P(name, 'project.json'), path.join(nd, file));
    return versionInfo(name, path.join(nd, file), true);
  },
  'GET /api/versions/file': (req, res, u) => {
    const f = versionPath(needProject(q(u, 'p')), q(u, 'file'), q(u, 'named') === '1');
    if (!fs.existsSync(f)) throw err(404, 'version not found');
    return readJSON(f);
  },
  // the whole project goes back to that version (the current state is kept as a backup first)
  'POST /api/versions/restore': (req, res, u) => {
    const name = needProject(q(u, 'p')), f = versionPath(name, q(u, 'file'), q(u, 'named') === '1');
    if (!fs.existsSync(f)) throw err(404, 'version not found');
    backup(name, true); fs.copyFileSync(f, P(name, 'project.json'));
    return { ok: true };
  },
  'POST /api/versions/delete': (req, res, u) => {
    const f = versionPath(needProject(q(u, 'p')), q(u, 'file'), true);
    fs.rmSync(f, { force: true });
    return { ok: true };
  },
  // 📱 phone review
  'GET /api/share': () => shareInfo(),
  'POST /api/share': async (req) => { const b = await readJson(req); return b.on ? startShare() : stopShare(); },
  // notes typed on a phone, waiting to be taken onto the timeline; ?take=1 empties the list (the editor has them now)
  'GET /api/review/notes': (req, res, u) => {
    const name = needProject(q(u, 'p')), list = readJSON(reviewNotesFile(name), []);
    if (q(u, 'take') && list.length) fs.rmSync(reviewNotesFile(name), { force: true });
    return list;
  },
  // 🎬 Render queue (all projects): body { items: [{ preset, aspect, fit, filename, quality, seq }] }
  'GET /api/queue': () => ({ items: rq.items.map(queueView), gpu: !!healthCache?.nvenc }),
  'POST /api/queue': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    if (!b.items?.length) throw err(400, 'Nothing to render');
    return { added: enqueueRender(name, b.items.map((x) => ({ ...x, saveTo: saveToDir(req.who, x.saveTo) }))).map(queueView) };
  },
  // stop a running render / take a waiting one out
  'POST /api/queue/cancel': (req, res, u) => {
    const it = rq.items.find((x) => x.id === q(u, 'id'));
    if (!it) throw err(404, 'not in the queue');
    if (it.state === 'rendering' && rqActive?.id === it.id) { it.state = 'cancelled'; killTree(rqActive.proc); }
    else if (it.state === 'waiting') { it.state = 'cancelled'; it.ended = Date.now(); fs.rmSync(it.jobFile, { force: true }); }
    saveQueue();
    return { ok: true };
  },
  'POST /api/queue/retry': (req, res, u) => {
    const it = rq.items.find((x) => x.id === q(u, 'id'));
    if (!it || it.state !== 'failed') throw err(400, 'Only a failed render can be tried again');
    Object.assign(it, { state: 'waiting', progress: 0, error: null, added: Date.now() });
    saveQueue(); pumpQueue();
    return { ok: true };
  },
  // move a waiting render up (dir -1) or down (+1)
  'POST /api/queue/move': (req, res, u) => {
    const i = rq.items.findIndex((x) => x.id === q(u, 'id')), d = +q(u, 'dir') || 0;
    const j = i + d;
    if (i < 0 || j < 0 || j >= rq.items.length || rq.items[i].state !== 'waiting' || rq.items[j].state !== 'waiting') return { ok: false };
    [rq.items[i], rq.items[j]] = [rq.items[j], rq.items[i]];
    saveQueue();
    return { ok: true };
  },
  'POST /api/queue/clear': () => {
    rq.items = rq.items.filter((x) => { const keep = ['waiting', 'rendering'].includes(x.state); if (!keep) fs.rmSync(x.jobFile, { force: true }); return keep; });
    saveQueue();
    return { ok: true };
  },
  // check the tools again (after a GPU driver update, without restarting the editor)
  'POST /api/health/recheck': () => checkHealth(),
  // Timeline hand-off to Premiere Pro / DaVinci Resolve: FCP7 XML + title PNGs + subtitles + README in exports/<name> vN/
  'POST /api/export/timeline': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const b = await readJson(req);
    const pj = b.project || readJSON(P(name, 'project.json'));
    if (!Object.values(pj.tracks).flat().length) throw err(400, 'The timeline is empty');
    const items = mediaDb(name).items, byId = Object.fromEntries(items.map((m) => [m.id, m]));
    for (const id of new Set([...Object.values(pj.tracks).flat().map((c) => c.mediaId), pj.logo?.mediaId].filter(Boolean)))
      if (!byId[id]) throw err(400, 'A clip on the timeline points to media that was removed - delete that clip first');
    const base = safeName(b.filename || pj.name || name), into = saveToDir(req.who, b.saveTo) || P(name, 'exports'); // (📁 Save to)
    let v = 1; while (fs.existsSync(path.join(into, `${base} v${v}`))) v++;
    const folder = `${base} v${v}`, outDir = path.join(into, folder);
    const color = ['lut', 'bake'].includes(b.color) ? b.color : 'none', luts = lutMap(name);
    // 📦 collect: copy the media into the export folder so the XML works on another computer (b.collect: full | trim)
    const collect = ['full', 'trim'].includes(b.collect) ? b.collect : 'none';
    const make = (graded = {}, media = byId, extra = {}) => ({ ...exportTimeline({ project: pj, media, outDir, base: `${base}_v${v}`, color, luts, graded, collect,
      subtitlesPath: pj.subtitles?.file ? P(name, 'subs', path.basename(pj.subtitles.file)) : null }), folder, path: outDir, color, collect, ...extra });
    if (color !== 'bake' && collect === 'none') return make();
    const all = Object.keys(pj.tracks).flatMap((t) => pj.tracks[t].map((c) => ({ c, video: t[0] === 'V' })));
    // clips rendered into new files (1 s handles each side): graded ones when the colour is baked in; with 'trim', every
    // video clip (without colour unless baked) - ProRes, so any editor reads them and they cut frame-exact
    const todo = all.filter(({ c, video }) => video && c.type === 'video' && byId[c.mediaId] && (collect === 'trim' || (color === 'bake' && c.color && !isNeutral(c.color)))).map((x) => x.c);
    return startTask(collect !== 'none' ? 'xml-collect' : 'xml-graded', async (job) => {
      const mdir = path.join(outDir, 'Media'), gdir = collect !== 'none' ? mdir : path.join(outDir, `${base}_v${v} graded`), work = fs.mkdtempSync(path.join(P(name, 'cache'), 'grade-'));
      fs.mkdirSync(gdir, { recursive: true });
      const graded = {}, missing = [];
      const share = collect === 'full' ? 0.3 : 0.9; // of the progress bar: rendering vs copying
      for (const [k, c] of todo.entries()) {
        const m = byId[c.mediaId], dur = m.duration || 0, start = Math.max(0, (+c.in || 0) - 1), end = Math.min(dur, (c.out ?? dur) + 1);
        if (!fs.existsSync(m.path)) { missing.push(m.name); continue; }
        const bake = color === 'bake' && c.color && !isNeutral(c.color);
        const file = path.join(gdir, `${String(k + 1).padStart(3, '0')}_${safeName(path.parse(m.name).name).slice(0, 40)}.mov`);
        job.stage = `${bake ? 'Colouring' : 'Cutting out'} clip ${k + 1} of ${todo.length}: ${m.name}`; job.log.push(job.stage); job.progress = Math.round((k / todo.length) * 95 * share);
        const vf = bake ? colorFilters(c.color, { luts, stage: stager(work) }).join(',') || 'null' : 'null';
        const r = await run('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', '-ss', String(start), '-t', String(end - start), '-i', m.path, '-map', '0:v:0', '-map', '0:a?',
          '-vf', vf, '-c:v', 'prores_ks', '-profile:v', bake ? '2' : '1', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', file], { cwd: work });
        if (r.code !== 0) { job.log.push(`  failed: ${r.stderr.trim().split(/[\r\n]+/).pop()} - this clip keeps the original file`); continue; }
        graded[c.id] = { file, start, duration: end - start };
      }
      fs.rmSync(work, { recursive: true, force: true });
      // whole files for everything not cut out above: photos, music, voice-over, the logo, clips that failed
      const media = { ...byId };
      let copied = 0, bytes = 0;
      if (collect !== 'none') {
        const need = [...new Set([...all.filter(({ c }) => c.mediaId && !graded[c.id]).map(({ c }) => c.mediaId), pj.logo?.mediaId].filter((id) => id && byId[id]))];
        const taken = new Set(fs.readdirSync(mdir).map((f) => f.toLowerCase()));
        for (const [k, id] of need.entries()) {
          const m = byId[id];
          if (!fs.existsSync(m.path)) { missing.push(m.name); continue; }
          const { name: nb, ext } = path.parse(path.basename(m.path));
          let fname = `${safeName(nb)}${ext}`;
          for (let i = 2; taken.has(fname.toLowerCase()); i++) fname = `${safeName(nb)}_${i}${ext}`;
          taken.add(fname.toLowerCase());
          job.stage = `Copying ${k + 1} of ${need.length}: ${m.name}`; job.progress = Math.round(95 * share + (k / need.length) * 95 * (1 - share));
          await fs.promises.copyFile(m.path, path.join(mdir, fname));
          media[id] = { ...m, path: path.join(mdir, fname) };
          copied++; bytes += fs.statSync(path.join(mdir, fname)).size;
        }
        for (const g of Object.values(graded)) bytes += fs.statSync(g.file).size;
      }
      const res = make(graded, media, { collected: { files: copied + Object.keys(graded).length, cut: collect === 'trim' ? Object.keys(graded).length : 0, mb: Math.round(bytes / 1048576), missing } });
      if (missing.length) res.notes = [`${missing.length} file${missing.length > 1 ? 's were' : ' was'} not found on this computer and could not be copied: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`, ...res.notes];
      return res;
    }, { project: name });
  },
  'GET /api/exports': (req, res, u) => {
    const dir = P(needProject(q(u, 'p')), 'exports');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs, files: fs.readdirSync(path.join(dir, e.name)).filter((f) => !fs.statSync(path.join(dir, e.name, f)).isDirectory()) }))
      .sort((a, b) => b.mtime - a.mtime);
  },
  // ⬇ an exported timeline folder as one .zip, streamed to whoever asks - so every PC can keep it on its own disk
  // (Windows' own tar.exe writes the zip; videos are stored, not re-compressed, so it starts at once)
  'GET /api/export/zip': (req, res, u) => {
    const name = needProject(q(u, 'p')), folder = path.basename(String(q(u, 'name') || '')), dir = P(name, 'exports');
    if (!folder || !fs.existsSync(path.join(dir, folder)) || !fs.statSync(path.join(dir, folder)).isDirectory()) throw err(404, 'export not found');
    const tar = process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\tar.exe') ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(folder)}.zip` });
    const p = spawn(tar, ['--format', 'zip', '--options', 'zip:compression=store', '-cf', '-', '-C', dir, folder], { windowsHide: true });
    p.stdout.pipe(res);
    p.on('error', () => res.destroy());
    req.on('close', () => { if (!res.writableEnded) try { p.kill(); } catch {} }); // (download stopped: stop zipping)
  },
  // Loudness of the finished mix (EBU R128): renders a fast preview, then measures it.
  'POST /api/loudness': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const b = await readJson(req);
    const { jobFile, out } = prepareRender(name, { ...b, preview: true });
    return startTask('loudness', async (job) => {
      job.log.push('[1/2] Mixing a preview…'); job.progress = 5;
      const r = await run(process.execPath, [path.join(ROOT, 'engine', 'render2.mjs'), jobFile], { onLine: (l) => { const m = /\[(\d+)\/(\d+)\]/.exec(l); if (m) job.progress = Math.round((+m[1] / +m[2]) * 80); } });
      if (r.code !== 0) throw new Error(`Preview mix failed: ${r.stderr.slice(-300)}`);
      job.log.push('[2/2] Measuring loudness…'); job.progress = 85;
      const m = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', P(name, 'renders', out), '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
      const sum = m.stderr.slice(m.stderr.lastIndexOf('Summary'));
      const num = (re) => { const x = re.exec(sum); return x ? +x[1] : null; };
      return { integrated: num(/I:\s*(-?[\d.]+) LUFS/), lra: num(/LRA:\s*(-?[\d.]+) LU/), truePeak: num(/Peak:\s*(-?[\d.]+) dBFS/), target: readJSON(P(name, 'project.json')).settings?.loudness };
    }, { project: name });
  },

  // subtitles
  'GET /api/subs': (req, res, u) => listDir(P(needProject(q(u, 'p')), 'subs'), (n) => /\.(srt|ass)$/i.test(n)),
  'GET /api/subs/file': (req, res, u) => {
    const f = P(needProject(q(u, 'p')), 'subs', path.basename(q(u, 'name') || ''));
    if (!q(u, 'name') || !fs.existsSync(f) || !fs.statSync(f).isFile()) throw err(404, 'subtitle file not found');
    return { name: path.basename(f), text: fs.readFileSync(f, 'utf8') };
  },
  'PUT /api/subs': async (req, res, u) => {
    const name = needProject(q(u, 'p')), f = path.basename(q(u, 'name') || '');
    if (!/\.(srt|ass)$/i.test(f)) throw err(400, 'name must end in .srt or .ass');
    fs.writeFileSync(P(name, 'subs', f), await readBody(req), 'utf8');
    return { name: f };
  },
  'POST /api/transcribe': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const b = await readJson(req);
    let src, base;
    if (b.render) { src = P(name, 'renders', path.basename(b.render)); base = path.parse(b.render).name; }
    else { const m = mediaItem(name, b.mediaId); if (!m) throw err(404, 'media not found'); src = m.path; base = path.parse(m.name).name; }
    if (!fs.existsSync(src)) throw err(404, 'file not found');
    let srt = `${base}${b.task === 'translate' ? '.en' : ''}.srt`;
    for (let i = 1; fs.existsSync(P(name, 'subs', srt)); i++) srt = `${base}${b.task === 'translate' ? '.en' : ''}_${i}.srt`;
    const args = [path.join(ROOT, 'engine', 'transcribe.py'), src, '--out', P(name, 'subs', srt),
      '--lang', b.lang || 'auto', '--task', b.task || 'transcribe', '--model', b.model || 'large-v3', '--words', String(+b.words || 0)];
    if (b.prompt) args.push('--prompt', b.prompt);
    // json: the sentences with each word's time (Captions panel: karaoke captions)
    const json = b.json ? srt.replace(/\.srt$/, '.json') : null;
    if (json) args.push('--json', P(name, 'subs', json));
    return startJob('transcribe', PYTHON, args, () => ({ subs: srt, json, segments: json ? readJSON(P(name, 'subs', json), {}).segments || [] : undefined }), { project: name });
  },

  // music: most energetic part (async so seeking/polling stay responsive)
  'GET /api/music/best': (req, res, u) => new Promise((ok, bad) => {
    const name = needProject(q(u, 'p')), m = mediaItem(name, q(u, 'id'));
    if (!m) return bad(err(404, 'music not found'));
    const p = spawn(process.execPath, [path.join(ROOT, 'engine', 'music.mjs'), 'best', m.path, String(+q(u, 'dur') || 30)], { windowsHide: true });
    let out = '', e = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (e += d));
    p.on('close', (code) => { if (code !== 0) return bad(new Error(e.slice(-400) || 'analysis failed')); try { ok(JSON.parse(out)); } catch (x) { bad(x); } });
  }),

  // The auto-edit agent: footage + VO/music/outline -> finished, editable timeline (see engine/agent.mjs).
  // 🎨 edit styles (engine/editstyle.mjs): learnt from a timeline, kept in Library/styles, one can be the default
  'GET /api/styles': () => ({ default: config().defaultStyle || null, styles: listStyles().map((x) => ({ name: x.name, from: x.from, at: x.at, summary: describeStyle(x) })) }),
  'POST /api/styles/learn': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    const sname = String(b.name || '').trim().slice(0, 60) || `${name} style`;
    const pj = liveOf(name).pj, byId = Object.fromEntries(mediaDb(name).items.map((m) => [m.id, m]));
    const prof = learnStyle(pj, byId, sname);
    fs.mkdirSync(path.join(LIB, 'styles'), { recursive: true });
    writeJSON(path.join(LIB, 'styles', `${safeName(sname)}.json`), prof);
    if (b.makeDefault) { const c = config(); c.defaultStyle = sname; fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1)); }
    return { name: sname, summary: describeStyle(prof), default: config().defaultStyle || null };
  },
  'PUT /api/styles/default': async (req) => {
    const b = await readJson(req), c = config();
    if (b.name && !loadStyle(b.name)) throw err(404, 'No such style');
    c.defaultStyle = b.name || null; fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1));
    return { default: c.defaultStyle };
  },
  'DELETE /api/styles': (req, res, u) => {
    const n = String(q(u, 'name') || ''); fs.rmSync(path.join(LIB, 'styles', `${safeName(n)}.json`), { force: true });
    const c = config(); if (c.defaultStyle === n) { c.defaultStyle = null; fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1)); }
    return { ok: true };
  },
  // 🖥 render farm: on / off and the workers (owner); render2.mjs hands a shot to the farm and waits for it
  'GET /api/farm': () => farmView(),
  'PUT /api/farm': async (req) => {
    const b = await readJson(req);
    if (b.newToken) { saveFarm({ token: crypto.randomBytes(12).toString('hex') }); for (const t of farm.tasks.values()) farmEnd(t, new Error('Token changed')); farm.workers.clear(); }
    if (b.on === true) { await startFarm(); saveFarm({ on: true }); }
    if (b.on === false) { stopFarm(); saveFarm({ on: false }); }
    return farmView();
  },
  'GET /api/farm/status': () => ({ on: !!farm.server, slots: farmWorkers().reduce((n, w) => n + (w.slots || 1), 0), workers: farmWorkers().length }),
  // body { label, inputs: [files], args, graph, out, limitSec }: answered when a worker has sent the piece back (200), or
  // 409 when no worker took it within a few seconds / it failed - render2 then renders the shot itself
  'POST /api/farm/run': async (req, res) => {
    const b = await readJson(req);
    if (!farm.server || !farmWorkers().length) throw err(409, 'No farm workers');
    for (const f of b.inputs || []) if (!fs.existsSync(f)) throw err(400, `Missing input ${f}`);
    const t = { id: crypto.randomBytes(6).toString('hex'), label: String(b.label || 'shot'), inputs: b.inputs || [], args: b.args || [], graph: b.graph || null, out: b.out,
      state: 'waiting', limitMs: Math.max(60, +b.limitSec || 600) * 1000 };
    const done = new Promise((ok) => { t.finish = ok; });
    farm.tasks.set(t.id, t); farm.waiting.push(t); farmPump();
    // the render was stopped (or render2 gave up): take the shot back so nothing writes its file any more
    res.on('close', () => { if (!res.writableEnded) farmEnd(t, new Error('Render stopped')); });
    // nobody free to take it soon: render it here instead (the local workers are faster than waiting)
    const idle = setTimeout(() => { if (t.state === 'waiting') farmEnd(t, new Error('No free worker')); }, (+b.waitSec || 4) * 1000);
    const e = await done; clearTimeout(idle);
    if (e) throw err(409, e.message);
    const w = farm.workers.get(t.worker);
    return { ok: true, worker: w?.name || 'worker', sec: +((Date.now() - t.takenAt) / 1000).toFixed(1) };
  },
  // 📜 activity: who changed what; take back one change (its inverse ops, applied like any other live change)
  'GET /api/activity': (req, res, u) => readActivity(needProject(q(u, 'p')), Math.min(1000, +q(u, 'limit') || 200)).map(({ inv, ...x }) => ({ ...x, revertable: !!inv?.length })),
  'POST /api/activity/revert': (req, res, u) => {
    const name = needProject(q(u, 'p')), id = String(q(u, 'id'));
    const x = readActivity(name, 3000).find((a) => a.id === id);
    if (!x) throw err(404, 'That change is no longer in the log');
    if (!x.inv?.length) throw err(400, 'This change was too big to take back here - use ↶ AI (undo) for agent / Claude edits');
    const L = liveOf(name);
    applyOps(L.pj, x.inv);
    const label = `Undone: ${x.label} (${x.name})`;
    const e = { rev: ++L.rev, client: 'activity', name: req.who?.name || 'Owner', label, ops: x.inv };
    L.log.push(e);
    liveWrite(name, L);
    liveSend(L, { type: 'ops', ...e });
    logActivity(name, { at: Date.now(), name: e.name, label, n: x.inv.length, inv: null });
    return { ok: true, label };
  },
  // ↶ AI undo
  'GET /api/aiundo': (req, res, u) => aiSnaps(needProject(q(u, 'p'))),
  'POST /api/aiundo/snap': async (req, res, u) => { const name = needProject(q(u, 'p')), b = await readJson(req); return { id: aiSnap(name, b.label) }; },
  'POST /api/aiundo/restore': (req, res, u) => {
    const name = needProject(q(u, 'p')), f = P(name, 'cache', 'undo', `${String(q(u, 'id')).replace(/\D/g, '')}.json`);
    if (!fs.existsSync(f)) throw err(404, 'That earlier version is no longer kept');
    const x = readJSON(f);
    aiSnap(name, `↶ undo: ${x.label}`);
    const L = liveOf(name);
    L.pj = { ...x.project, modified: Date.now() }; L.rev++; L.log = [];
    liveWrite(name, L, true);
    liveSend(L, { type: 'reset', rev: L.rev, project: L.pj, by: req.who?.name || 'Owner' });
    return { ok: true, label: x.label };
  },
  // 🧠 Claude: is it there / signed in; a message (job with live events); stop it
  'GET /api/claude/status': (req, res, u) => claudeStatus(q(u, 'force') === '1'),
  'POST /api/claude/chat': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    if (!String(b.message || '').trim()) throw err(400, 'Type a message');
    if ([...jobs.values()].some((j) => j.kind === 'claude' && j.status === 'running' && j.project === name)) throw err(409, 'Claude is still working on the last message - wait or press Stop');
    const job = claudeChat(name, b.message, !!b.reset, req.who);
    return { id: job.id };
  },
  'GET /api/claude/events': (req, res, u) => {
    const j = jobs.get(q(u, 'id')); if (!j) throw err(404, 'no such job');
    const from = +q(u, 'from') || 0;
    return { status: j.status, events: (j.events || []).slice(from), next: (j.events || []).length, error: j.status === 'error' ? j.log.slice(-1)[0] : null };
  },
  'POST /api/claude/stop': (req, res, u) => { const j = jobs.get(q(u, 'id')); if (j) j.stopped = true; if (j && !leaveLine(j) && j.proc) killTree(j.proc); return { ok: true }; },
  // 📎 a reference for Claude (Assistant): kept in cache/claude/refs, NOT in the media pool - its shots never go on the edit
  'POST /api/claude/ref': (req, res, u) => new Promise((ok, bad) => {
    const name = needProject(q(u, 'p')), dir = P(name, 'cache', 'claude', 'refs');
    fs.mkdirSync(dir, { recursive: true });
    let fname = safeName(path.basename(q(u, 'name') || 'reference'));
    const { name: b, ext } = path.parse(fname);
    if (!/^\.(mp4|mov|m4v|mkv|webm|avi|mxf|mts|jpe?g|png|webp|gif|bmp)$/i.test(ext)) return bad(err(400, 'Attach a video or a picture as the reference'));
    for (let i = 1; fs.existsSync(path.join(dir, fname)); i++) fname = `${b}_${i}${ext}`;
    const dest = path.join(dir, fname), tmp = `${dest}.part`, out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => { fs.renameSync(tmp, dest); ok({ name: fname, path: dest, kind: /^\.(jpe?g|png|webp|gif|bmp)$/i.test(ext) ? 'image' : 'video', size: fs.statSync(dest).size }); });
    req.on('error', (e) => { fs.rmSync(tmp, { force: true }); bad(e); });
  }),
  'POST /api/claude/new': (req, res, u) => { fs.rmSync(P(needProject(q(u, 'p')), 'cache', 'claude', 'session.json'), { force: true }); return { ok: true }; },
  // 🗂 an earlier chat opened in the Assistant: Claude carries on in that conversation (no id: a fresh one)
  'POST /api/claude/use': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), f = P(name, 'cache', 'claude', 'session.json');
    if (b.id && /^[\w-]{8,80}$/.test(String(b.id))) { fs.mkdirSync(path.dirname(f), { recursive: true }); writeJSON(f, { id: String(b.id), at: Date.now() }); } else fs.rmSync(f, { force: true });
    return { ok: true };
  },
  'POST /api/agent': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const opts = await readJson(req);
    opts.stock = false; // (stock footage is off: edits use only the project's own clips)
    // the chosen style, or the default one when the request does not say (Assistant / Re-edit of older edits)
    const sname = opts.styleName === undefined ? config().defaultStyle : opts.styleName;
    if (sname && sname !== 'none') { const st = loadStyle(sname); if (st) opts.styleProfile = st; }
    const items = mediaDb(name).items;
    const media = Object.fromEntries(items.map((m) => [m.id, { ...m, proxyPath: m.proxy === 'ready' ? P(name, 'cache', 'proxies', `${m.id}.mp4`) : null }]));
    return startTask('agent', async (job) => {
      // re-import when the file changes, so agent improvements apply without restarting the editor
      const agentFile = path.join(ROOT, 'engine', 'agent.mjs');
      const { runAgent } = await import(`./engine/agent.mjs?v=${Math.round(fs.statSync(agentFile).mtimeMs)}`);
      const log = (m) => { job.log.push(m); job.stage = m; };
      const mediaNow = () => Object.fromEntries(mediaDb(name).items.map((m) => [m.id, { ...m, proxyPath: m.proxy === 'ready' ? P(name, 'cache', 'proxies', `${m.id}.mp4`) : null }]));
      const go = (o, scale = [0, 100]) => runAgent({ opts: o, media: mediaNow(), cacheDir: P(name, 'cache'), subsDir: P(name, 'subs'), python: PYTHON, root: ROOT, luts: lutMap(name),
        log, skips: () => job.skips || 0, progress: (p) => { job.progress = Math.round(scale[0] + (p / 100) * (scale[1] - scale[0])); } });
      const o = { ...opts };
      // reference video: its cutting style is copied (engine/refstyle.mjs) but never its shots
      if (o.reference) {
        const rm = mediaItem(name, o.reference);
        if (!rm) throw new Error('The reference video is no longer in the project');
        log('Studying the reference video (cuts, effects, colour)…');
        const { analyzeReference } = await import(`./engine/refstyle.mjs?v=${Math.round(fs.statSync(path.join(ROOT, 'engine', 'refstyle.mjs')).mtimeMs)}`);
        o.refStyle = await analyzeReference(rm.path, { cacheFile: P(name, 'cache', 'analysis', `ref-${rm.id}.json`), width: rm.width, height: rm.height, duration: rm.duration });
        o.clips = (o.clips || []).filter((id) => id !== rm.id);
        if (!o.aspect || o.aspect === 'ref') o.aspect = o.refStyle.aspect || '16:9';
      }
      // sound design (whooshes, hits, risers on A3) for teasers / montages, unless switched off
      if (o.sfx !== false && ((o.editStyle && o.editStyle !== 'standard') || o.reference)) { log('Getting the sound effects ready…'); o.sfxLib = await sfxLib(name).catch(() => null); }
      if (!o.stock) return go(o);
      // stock: your own Stock folder joins the footage (own footage is still preferred when it fits)
      const own = await importStock(name, [path.join(STOCK)].filter((d) => fs.readdirSync(d).some((f) => EXT_KIND(path.extname(f)) === 'video')), log);
      const ownOnline = []; // (Stock/online is searched below, per line)
      o.stockIds = [...own]; o.clips = [...new Set([...o.clips, ...own])];
      const keys = config().stock || {};
      let r = await go(o, [0, keys.pexels || keys.pixabay ? 55 : 100]);
      // clips skipped in the first pass stay out of the re-edit (it would otherwise read them all again)
      if (r.skippedIds?.length) { const sk = new Set(r.skippedIds); o.clips = o.clips.filter((id) => !sk.has(id)); }
      if (!keys.pexels && !keys.pixabay) { if (!own.length) r.report.warnings.push('Stock footage is on, but there are no clips in the Stock folder and no Pexels / Pixabay key - add a key in ✨ Agent > Stock keys.'); return r; }
      // lines your footage could not show -> search stock for them
      const weak = r.report.slots.filter((s) => s.weak && s.en);
      const queries = [...new Set(weak.map((s) => keywords(s.en)).filter(Boolean))].slice(0, 8);
      if (!queries.length) return r;
      const got = [], errs = new Set();
      for (const [k, qy] of queries.entries()) {
        log(`Stock footage for "${qy}" (${k + 1}/${queries.length})…`); job.progress = 55 + Math.round((k / queries.length) * 15);
        const { results, errors } = await searchStock(qy, { keys, vertical: ['9:16', '4:5'].includes(o.aspect), height: 1080 });
        errors.forEach((e) => errs.add(e));
        for (const it of results.slice(0, 2)) { try { got.push({ q: qy, file: await downloadStock(it, path.join(STOCK, 'online')) }); } catch (e) { errs.add(e.message); } }
      }
      const ids = await importStock(name, got.map((x) => x.file), log);
      void ownOnline;
      if (!ids.length) { r.report.warnings.push(`No stock clips could be added${errs.size ? ` (${[...errs].join('; ')})` : ''}`); return r; }
      o.stockIds = [...o.stockIds, ...ids]; o.clips = [...new Set([...o.clips, ...ids])];
      log(`Re-editing with ${ids.length} stock clips…`);
      r = await go(o, [70, 100]);
      r.report.warnings.unshift(`Added ${ids.length} stock clips (Pexels / Pixabay, free licence) for: ${queries.join(', ')} - they are in the Stock bin`);
      r.stockIds = o.stockIds;
      return r;
    }, { project: name, opts }); // opts let a refreshed page finish the edit the same way
  },

  // rule-based auto edit (reference-match mode of the agent); returns v2 tracks
  'POST /api/autoedit': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const b = await readJson(req);
    const db = mediaDb(name), byId = Object.fromEntries(db.items.map((m) => [m.id, m]));
    const ids = (b.clips || []).filter((id) => byId[id]);
    if (!ids.length) throw err(400, 'Select at least one clip for auto edit.');
    const paths = Object.fromEntries([...ids, b.music, b.reference].filter((id) => id && byId[id]).map((id) => [id, byId[id].path]));
    const reqFile = P(name, 'cache', 'autoedit-req.json'), outFile = P(name, 'cache', 'autoedit-out.json');
    writeJSON(reqFile, { ...b, clips: ids, paths, dir: '', cacheDir: P(name, 'cache', 'analysis') });
    return startJob('autoedit', process.execPath, [path.join(ROOT, 'engine', 'autoedit.mjs'), reqFile, outFile], () => {
      const r = readJSON(outFile);
      const V1 = r.clips.map((c) => ({ id: uid(), type: c.type === 'card' ? 'title' : c.type, mediaId: c.src, in: c.in, out: c.out, dur: c.duration,
        text: c.text, textStyle: c.textStyle, textDuration: c.textDuration, bg: c.bg, fadeOut: c.fadeOut,
        color: c.color ? { offset: { y: c.color.brightness || 0 }, saturation: c.color.saturation ?? 1, contrast: c.color.contrast ?? 1 } : undefined }));
      const total = V1.reduce((s, c) => s + clipDur(c, byId), 0);
      const A2 = r.music?.src ? [{ id: uid(), type: 'audio', mediaId: r.music.src, start: 0, in: r.music.in || 0, loop: true, dur: +total.toFixed(2),
        volume: r.music.volume ?? 0.8, duck: !!r.music.duck, fadeOut: 2 }] : [];
      return { aspect: r.aspect, tracks: { V1, A2 }, clipVolume: r.audio?.originalVolume ?? 1 };
    }, { project: name });
  },

  // A/V script -> scenes (engine/script.mjs). Body: the file itself (?name=script.docx) or JSON { text } for pasted text.
  'POST /api/script/parse': async (req, res, u) => {
    needProject(q(u, 'p'));
    const name = q(u, 'name') || '';
    const { parseScript } = await import(`./engine/script.mjs?v=${Math.round(fs.statSync(path.join(ROOT, 'engine', 'script.mjs')).mtimeMs)}`);
    if (name) {
      const chunks = []; for await (const c of req) chunks.push(c);
      return parseScript({ buf: Buffer.concat(chunks), name, python: PYTHON });
    }
    return parseScript({ text: (await readJson(req)).text || '', python: PYTHON });
  },

  // ✨ Auto clean audio: measures the noise between words vs the speech of a clip (or a part: in / out seconds)
  // and picks a clean-up (public/js/audiofx.js autoCleanFx). Reads only the audio, from the proxy when there is one.
  'GET /api/audio/autoclean': async (req, res, u) => {
    const name = needProject(q(u, 'p')), m = mediaItem(name, q(u, 'id'));
    if (!m) throw err(404, 'media not found');
    if (!m.hasAudio) throw err(400, 'This clip has no sound');
    const file = analysisFile(name, m), tin = +q(u, 'in') || 0, tout = +q(u, 'out') || 0;
    const r = await run('ffmpeg', ['-hide_banner', '-nostats', ...(tin ? ['-ss', String(tin)] : []), '-t', String(tout > tin ? tout - tin : 600), '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-']);
    const v = [...r.stderr.matchAll(/M:\s*(-?[\d.]+)/g)].map((x) => +x[1]).filter((x) => x > -69).sort((a, b) => a - b);
    if (v.length < 10) throw err(400, 'Too little sound to measure');
    const { autoCleanFx } = await import('./public/js/audiofx.js');
    return autoCleanFx(v[Math.floor(v.length * 0.1)], v[Math.floor(v.length * 0.9)]);
  },
  // 🎯 Motion tracking (engine/track.py): body { mediaId, t0, t1, box: { x, y, w, h } } (seconds in the file, box as
  // fractions of the picture). Result { points: [{ t, x, y, w, h }], lost: [t] } - read from the preview copy when there is one.
  'POST /api/track': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), m = mediaItem(name, b.mediaId);
    if (!m || m.kind !== 'video') throw err(400, 'Tracking needs a video clip');
    const bx = b.box || {};
    if (!(bx.w > 0.005 && bx.h > 0.005)) throw err(400, 'Draw a box around the thing to follow');
    const t0 = Math.max(0, +b.t0 || 0), t1 = Math.min(m.duration || 1e9, +b.t1 || m.duration || 0);
    return startTask('track', async (job) => {
      job.stage = 'Following it through the shot…'; job.progress = 10;
      const r = await run(PYTHON, [path.join(ROOT, 'engine', 'track.py'), analysisFile(name, m), String(t0), String(t1), ...[bx.x, bx.y, bx.w, bx.h].map((v) => String(+v)), '--fps', '15']);
      if (r.code !== 0) throw new Error(`Tracking failed: ${r.stderr.slice(-300)}`);
      const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
      if (out.error) throw new Error(out.error);
      return out;
    }, { project: name });
  },
  // ---- Library (shared by every project): presets, brand kit, project templates - in <app>/Library ----
  'GET /api/library': () => ({ presets: readJSON(path.join(LIB, 'presets.json'), { fx: [], captions: [] }), brand: readJSON(path.join(LIB, 'brand.json'), {}),
    templates: fs.readdirSync(path.join(LIB, 'templates')).filter((f) => f.endsWith('.json')).map((f) => ({ name: path.parse(f).name, ...pick(readJSON(path.join(LIB, 'templates', f), {}), ['aspect', 'saved']) })) }),
  // { kind: 'fx' | 'captions', item: { id, name, data } } adds or replaces; { kind, id, remove: true } deletes
  'PUT /api/library/presets': async (req) => {
    const b = await readJson(req), f = path.join(LIB, 'presets.json'), all = readJSON(f, { fx: [], captions: [] });
    if (!['fx', 'captions'].includes(b.kind)) throw err(400, 'unknown preset kind');
    const list = (all[b.kind] ||= []).filter((x) => x.id !== (b.item?.id ?? b.id));
    if (!b.remove) list.push({ ...b.item, saved: Date.now() });
    all[b.kind] = list; writeJSON(f, all);
    return all;
  },
  'PUT /api/library/brand': async (req) => { const b = await readJson(req); writeJSON(path.join(LIB, 'brand.json'), { ...b, saved: Date.now() }); return b; },
  // a project's shape as a template: settings, look, captions style, logo, track names, titles and adjustment layers
  // (no footage, captions text or edits). Logo / intro / outro are kept as file paths.
  'POST /api/library/template': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), pj = readJSON(P(name, 'project.json'));
    const tname = safeName(b.name || `${name} template`), pathOf = (id) => mediaItem(name, id)?.path || null;
    const keep = (c) => c.type === 'title' || c.type === 'adjust';
    const t = { saved: Date.now(), aspect: pj.settings.aspect, settings: pj.settings, trackState: pj.trackState, logo: pj.logo?.mediaId ? { ...pj.logo, path: pathOf(pj.logo.mediaId) } : null,
      captions: pj.captions ? { on: pj.captions.on, style: pj.captions.style, cues: [] } : null, brand: pj.brand || null,
      tracks: Object.fromEntries(Object.entries(pj.tracks).map(([id, l]) => [id, id === 'V1' ? [] : l.filter(keep)])) };
    writeJSON(path.join(LIB, 'templates', `${tname}.json`), t);
    return { name: tname };
  },
  'POST /api/library/template/delete': async (req) => { const b = await readJson(req); fs.rmSync(path.join(LIB, 'templates', `${safeName(b.name)}.json`), { force: true }); return { ok: true }; },
  // add one file by its path (brand logo / intro / outro) to a project's media; returns the media item when it is read
  'POST /api/media/addpath': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    if (!b.path || !fs.existsSync(b.path)) throw err(400, `File not found: ${b.path}`);
    const it = addMediaFile(name, b.path, { bin: b.bin || 'Brand' }) || mediaDb(name).items.find((m) => m.path.toLowerCase() === path.resolve(b.path).toLowerCase());
    saveMedia(name, true);
    if (activeProject !== name) { activeProject = name; pump(); }
    for (let i = 0; i < 60 && !['ready', 'error', 'offline'].includes(mediaItem(name, it.id)?.status); i++) await new Promise((ok) => setTimeout(ok, 300));
    return publicMedia(name, mediaItem(name, it.id));
  },
  // A clip opened in the Source monitor without its preview copy yet: make that copy now, ahead of the queue
  // (an extra worker, so it does not wait for the ones already running)
  'POST /api/media/urgent': (req, res, u) => {
    const name = needProject(q(u, 'p')), id = q(u, 'id');
    const i = proxyQ.findIndex((x) => x.proj === name && x.id === id);
    if (i < 0) return { started: false, proxy: mediaItem(name, id)?.proxy };
    const [it] = proxyQ.splice(i, 1);
    proxyActive++;
    (async () => {
      try { await processProxy(it.proj, it.id); } catch (e) { const m = mediaItem(it.proj, it.id); if (m) m.proxy = 'error'; }
      saveMedia(it.proj); proxyActive--; pump();
    })();
    return { started: true };
  },
  // 🔄 Replace clip: the best `len` seconds of a clip from its cached per-second analysis (sharp, well exposed,
  // some movement); without analysis, the middle. Returns { in }.
  'GET /api/media/best': (req, res, u) => {
    const name = needProject(q(u, 'p')), m = mediaItem(name, q(u, 'id')), len = Math.max(0.2, +q(u, 'len') || 2);
    if (!m) throw err(404, 'media not found');
    const D = m.duration || 0;
    if (D <= len + 0.1) return { in: 0 };
    const a = readJSON(P(name, 'cache', 'analysis', `${m.id}.json`), null);
    if (!a?.motion?.length) return { in: +Math.max(0, D / 2 - len / 2).toFixed(3) };
    const sec = (arr, k, d) => arr?.[Math.min(arr.length - 1, k)] ?? d;
    let best = 0, bestS = -Infinity;
    for (let t = 0.3; t + len <= D - 0.2; t += 0.5) {
      let s = 0, n = 0;
      for (let k = Math.floor(t); k < Math.ceil(t + len); k++) {
        const y = sec(a.luma, k, 128), bl = sec(a.blur, k, 0), mo = sec(a.motion, k, 0);
        s += -Math.abs(y - 120) / 60 - bl * 0.15 + Math.min(mo, 0.15) * 4 - (mo > 0.4 ? 2 : 0); n++;
      }
      // a shot boundary inside the window would show two shots
      if ((a.cuts || []).some((c) => c > t + 0.15 && c < t + len - 0.15)) s -= 3 * n;
      if (s / n > bestS) { bestS = s / n; best = t; }
    }
    return { in: +best.toFixed(3) };
  },
  // 🎥 Multicam: line up 2+ recordings of the same event by their sound (engine/sync.mjs).
  // Body { ids: [mediaId], master }. Result { angles: [{ mediaId, offset, confidence, duration }] }, offsets in seconds of the master.
  'POST /api/multicam/sync': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    const items = (b.ids || []).map((id) => mediaItem(name, id)).filter((m) => m && m.hasAudio);
    if (items.length < 2) throw err(400, 'Choose at least two clips that have sound');
    const master = items.find((m) => m.id === b.master) || items[0];
    return startTask('multicam', async (job) => {
      job.log.push(`Listening to ${items.length} recordings…`); job.progress = 10;
      const { syncByAudio } = await import(`./engine/sync.mjs?v=${Math.round(fs.statSync(path.join(ROOT, 'engine', 'sync.mjs')).mtimeMs)}`);
      const r = await syncByAudio(items.map((m) => ({ id: m.id, path: analysisFile(name, m) })), { ref: master.id });
      return { master: master.id, angles: items.map((m) => ({ mediaId: m.id, offset: +r[m.id].offset.toFixed(3), confidence: Number.isFinite(r[m.id].confidence) ? +r[m.id].confidence.toFixed(1) : 99, duration: m.duration })) };
    }, { project: name });
  },
  // a finished agent edit not yet on the timeline (see startTask) / the editor has used it
  'GET /api/agent/pending': (req, res, u) => readJSON(P(needProject(q(u, 'p')), 'cache', 'agent', 'pending-result.json'), {}),
  'POST /api/agent/applied': (req, res, u) => { fs.rmSync(P(needProject(q(u, 'p')), 'cache', 'agent', 'pending-result.json'), { force: true }); return { ok: true }; },
  // sound effects library in this project: { kind: { mediaId, peak, label, duration } }
  'GET /api/sfx': async (req, res, u) => sfxLib(needProject(q(u, 'p'))),
  'POST /api/open-sfx': async () => { await sfxMade(); if (process.platform === 'win32') spawn('explorer', [SFX], { detached: true, stdio: 'ignore' }).unref(); return { folder: SFX }; },
  // app settings: stock footage keys (GET says only whether a key is set)
  'GET /api/settings': () => { const c = config(); return { stock: { pexels: !!c.stock?.pexels, pixabay: !!c.stock?.pixabay }, elevenlabs: !!c.elevenlabs, stockFolder: STOCK }; },
  // ElevenLabs key (AI voice-over): kept only in config.json on this computer; tested by listing your voices
  'PUT /api/settings/elevenlabs': async (req) => {
    const b = await readJson(req), c = config();
    if (typeof b.key === 'string') { if (b.key.trim()) c.elevenlabs = b.key.trim(); else delete c.elevenlabs; }
    fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1));
    if (!c.elevenlabs) return { elevenlabs: false };
    const { listVoices } = await import('./engine/voices.mjs');
    const v = await listVoices('eleven', { key: c.elevenlabs });
    return { elevenlabs: true, voices: v.length };
  },
  // 🎙 AI voice-over: voices of a provider ('edge' free / 'eleven' with your key)
  'GET /api/tts/voices': async (req, res, u) => {
    const { listVoices } = await import('./engine/voices.mjs');
    return listVoices(q(u, 'provider') || 'edge', { python: PYTHON, key: config().elevenlabs });
  },
  // speak a text -> imports/AI VO ….mp3 (+ subtitles), added to the media pool (bin "AI voice-over").
  // Body { provider, voice, text, rate (-50..50), subtitles: bool }
  'POST /api/tts': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    if (!String(b.text || '').trim()) throw err(400, 'Write the voice-over text first');
    return startTask('tts', async (job) => {
      job.log.push('Speaking…'); job.stage = 'Making the voice-over…'; job.progress = 20;
      const { speak } = await import(`./engine/voices.mjs?v=${Math.round(fs.statSync(path.join(ROOT, 'engine', 'voices.mjs')).mtimeMs)}`);
      const stamp = localStamp();
      const base = safeName(`AI VO ${String(b.voice || '').split('-').pop().replace('Neural', '') || 'voice'} ${stamp}`);
      const out = P(name, 'imports', `${base}.mp3`), srt = b.subtitles ? P(name, 'subs', `${base}.srt`) : null;
      const r = await speak({ provider: b.provider || 'edge', voice: b.voice, text: b.text, rate: +b.rate || 0, out, srt, python: PYTHON, key: config().elevenlabs });
      job.progress = 80;
      const it = addMediaFile(name, out, { bin: 'AI voice-over', imported: true });
      saveMedia(name, true);
      for (let i = 0; i < 40 && it && mediaItem(name, it.id)?.status !== 'ready'; i++) await new Promise((ok) => setTimeout(ok, 300));
      return { mediaId: it?.id, subs: r.srt ? path.basename(r.srt) : null, duration: mediaItem(name, it?.id)?.duration ?? r.duration };
    }, { project: name });
  },
  // 🌐 Dub / re-voice: every line is spoken by the AI voice and fitted into the time the original line took
  // (sped up a little when longer, up to 1.35x), then all lines are laid on one track at their times.
  // Body { provider, voice, rate, lines: [{ start, end, text }] } (seconds of the clip). Result: { mediaId, fitted }
  'POST /api/dub': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    const lines = (b.lines || []).filter((l) => String(l.text || '').trim() && l.end > l.start);
    if (!lines.length) throw err(400, 'No lines to dub');
    return startTask('dub', async (job) => {
      const { speak } = await import(`./engine/voices.mjs?v=${Math.round(fs.statSync(path.join(ROOT, 'engine', 'voices.mjs')).mtimeMs)}`);
      const wd = fs.mkdtempSync(P(name, 'cache', 'dub-')), parts = [];
      try {
        for (const [k, l] of lines.entries()) {
          job.stage = `Speaking line ${k + 1}/${lines.length}…`; job.progress = Math.round((k / lines.length) * 85);
          const f = path.join(wd, `l${k}.mp3`);
          await speak({ provider: b.provider || 'edge', voice: b.voice, text: l.text, rate: +b.rate || 0, out: f, python: PYTHON, key: config().elevenlabs });
          const d = +(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).stdout || 0;
          // room until the next line starts (a little spill past the original end is fine)
          const room = Math.max(0.3, (lines[k + 1]?.start ?? l.end + 1.5) - l.start - 0.05);
          parts.push({ f, at: l.start, tempo: d > room ? Math.min(1.35, d / room) : 1 });
        }
        job.stage = 'Laying the lines on the track…'; job.progress = 90;
        const total = Math.max(...lines.map((l) => l.end)) + 3;
        const stamp = localStamp();
        const out = P(name, 'imports', `${safeName(`AI dub ${stamp}`)}.wav`);
        const g = parts.map((p, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo${p.tempo > 1.001 ? `,atempo=${p.tempo.toFixed(3)}` : ''},adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)}[a${i}]`);
        g.push(`${parts.map((_, i) => `[a${i}]`).join('')}amix=inputs=${parts.length}:normalize=0,apad=whole_dur=${total.toFixed(2)}[out]`);
        const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...parts.flatMap((p) => ['-i', p.f]), '-filter_complex', g.join(';'), '-map', '[out]', '-t', total.toFixed(2), '-c:a', 'pcm_s16le', out]);
        if (r.code !== 0) throw new Error(`Could not build the dub track: ${r.stderr.slice(-300)}`);
        const it = addMediaFile(name, out, { bin: 'AI voice-over', imported: true });
        saveMedia(name, true);
        for (let i = 0; i < 40 && it && mediaItem(name, it.id)?.status !== 'ready'; i++) await new Promise((ok) => setTimeout(ok, 300));
        return { mediaId: it?.id, fitted: parts.filter((p) => p.tempo > 1.001).length, lines: parts.length };
      } finally { fs.rmSync(wd, { recursive: true, force: true }); }
    }, { project: name });
  },
  'PUT /api/settings': async (req) => {
    const b = await readJson(req), c = config();
    c.stock = { ...(c.stock || {}) };
    for (const k of ['pexels', 'pixabay']) if (typeof b[k] === 'string') { if (b[k].trim()) c.stock[k] = b[k].trim(); else delete c.stock[k]; }
    fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1));
    const test = await searchStock('waterfall', { keys: c.stock, minDur: 1 });
    return { stock: { pexels: !!c.stock.pexels, pixabay: !!c.stock.pixabay }, found: test.results.length, errors: test.errors };
  },
  'POST /api/open-stock': () => { if (process.platform === 'win32') spawn('explorer', [STOCK], { detached: true, stdio: 'ignore' }).unref(); return { folder: STOCK }; },

  // Auto Reels (engine/reels.mjs): long talk -> ranked moments; then chosen moments -> one 9:16 project each (+ render)
  'POST /api/reels/find': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const b = await readJson(req);
    const m = mediaItem(name, b.mediaId);
    if (!m || m.kind !== 'video' || !m.hasAudio) throw err(400, 'Pick a video with sound (a talk, speech or interview)');
    if (!fs.existsSync(m.path)) throw err(400, `File is offline: ${m.path}`);
    const mm = { ...m, proxyPath: m.proxy === 'ready' ? P(name, 'cache', 'proxies', `${m.id}.mp4`) : null };
    return startTask('reels', async (job) => {
      const reelsFile = path.join(ROOT, 'engine', 'reels.mjs');
      const { findReels } = await import(`./engine/reels.mjs?v=${Math.round(fs.statSync(reelsFile).mtimeMs)}`);
      const r = await findReels({ opts: b, m: mm, cacheDir: P(name, 'cache'), python: PYTHON, root: ROOT,
        log: (s) => { job.log.push(s); job.stage = s; }, progress: (p) => { job.progress = Math.round(p); } });
      writeJSON(P(name, 'cache', 'reels', `last-${m.id}.json`), { ...r, opts: b });
      return { ...r, candidates: r.candidates.map(({ words, ...c }) => c) }; // words stay on the server
    }, { project: name });
  },
  'POST /api/reels/make': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const b = await readJson(req);
    const found = readJSON(P(name, 'cache', 'reels', `last-${b.mediaId}.json`), null);
    if (!found) throw err(400, 'Find the moments first');
    const chosen = found.candidates.filter((c) => (b.ids || []).includes(c.id));
    if (!chosen.length) throw err(400, 'Tick at least one moment');
    const m = mediaItem(name, b.mediaId), src = readJSON(P(name, 'project.json'));
    const logo = src.logo?.mediaId && mediaItem(name, src.logo.mediaId) ? src.logo : null;
    const music = b.music && mediaItem(name, b.music) ? b.music : null;
    const { buildReel } = await import(`./engine/reels.mjs?v=${Math.round(fs.statSync(path.join(ROOT, 'engine', 'reels.mjs')).mtimeMs)}`);
    const base = safeName(b.name || path.parse(m.name).name).slice(0, 60);
    const made = chosen.map((c) => {
      let n = `${base} - Reel ${c.rank}`;
      for (let k = 2; fs.existsSync(P(n, 'project.json')); k++) n = `${base} - Reel ${c.rank} (${k})`;
      ensureProjectDirs(n);
      const pj = newProject(n, { aspect: '9:16', fps: Math.min(30, Math.round(m.fps) || 30) });
      const r = buildReel(c, m, { captions: b.captions || 'karaoke', hookTitle: b.hookTitle !== false, musicId: music });
      Object.assign(pj.tracks, r.tracks);
      Object.assign(pj.settings, { exportPreset: 'reel', loudness: -14, crf: 20 });
      if (music) pj.trackState.A2 = { ...pj.trackState.A2, duckDepth: 18 };
      if (logo) pj.logo = { ...logo };
      if (r.ass) { fs.writeFileSync(P(n, 'subs', 'captions.ass'), r.ass, 'utf8'); pj.subtitles = { file: 'captions.ass', style: {} }; }
      pj.reelOf = { project: name, media: m.name, start: c.start, end: c.end, text: c.text };
      writeJSON(P(n, 'media.json'), { items: [] });
      mediaCache.delete(n);
      for (const id of [m.id, music, logo?.mediaId].filter(Boolean)) cloneMedia(name, n, id);
      saveMedia(n, true);
      writeJSON(P(n, 'project.json'), pj);
      return { project: n, rank: c.rank, duration: r.duration };
    });
    if (!b.render) return { projects: made };
    // render the reels one after another with the Instagram Reel preset
    return startTask('reels-render', async (job) => {
      for (const [k, x] of made.entries()) {
        job.stage = `Rendering ${x.project} (${k + 1}/${made.length})`; job.log.push(job.stage);
        const { jobFile, out } = prepareRender(x.project, { preset: 'reel', filename: x.project, tag: false });
        const r = await run(process.execPath, [path.join(ROOT, 'engine', 'render2.mjs'), jobFile],
          { onLine: (l) => { const p = /\[(\d+)\/(\d+)\]/.exec(l); if (p) job.progress = Math.round(((k + +p[1] / +p[2]) / made.length) * 100); } });
        if (r.code !== 0) { x.error = r.stderr.trim().split('\n').pop(); job.log.push(`  failed: ${x.error}`); continue; }
        x.output = out; x.url = `/pf/${encodeURIComponent(x.project)}/renders/${encodeURIComponent(out)}`;
      }
      return { projects: made };
    }, { project: name });
  },

  'GET /api/job': (req, res, u) => {
    const j = jobs.get(q(u, 'id'));
    if (!j) throw err(404, 'no such job');
    return { ...j, log: j.log.slice(-80), elapsed: ((j.ended || Date.now()) - j.started) / 1000 };
  },
  // Skip: the agent stops reading more clips and edits with the ones it has looked at
  'POST /api/jobs/skip': (req, res, u) => { const j = jobs.get(q(u, 'id')); if (!j) throw err(404, 'job not found'); j.skips = (j.skips || 0) + 1; return { skips: j.skips }; },
  'GET /api/jobs': () => [...jobs.values()].filter((j) => j.status === 'running').map(({ log, proc, events, ...j }) => j),
};

// who: the person asking - the owner on this computer (port 3000), or a team member signed in over the network
async function handle(req, res, who) {
  const u = new URL(req.url, 'http://localhost');
  req.who = who;
  try {
    if (!allowed(who, req.method, u.pathname)) return send(res, 403, { error: who.role === 'viewer' ? 'You can only watch (viewer) - ask the owner for editor rights' : 'Only the owner can do this, on the editing computer' });
    const route = routes[`${req.method} ${u.pathname}`];
    if (route) {
      const out = await route(req, res, u);
      if (!res.headersSent) send(res, 200, out);
      return;
    }
    // project media: /pm/<project>/<id>/<play|orig|thumb|strip|wave>
    let m = /^\/pm\/([^/]+)\/([0-9a-f]+)\/(play|orig|thumb|strip|wave)$/.exec(u.pathname);
    if (req.method === 'GET' && m) {
      const proj = decodeURIComponent(m[1]), it = mediaItem(needProject(proj), m[2]);
      if (!it) return send(res, 404, { error: 'media not found' });
      const C = (d, f) => P(proj, 'cache', d, f);
      const file = { thumb: C('thumbs', `${it.id}.jpg`), strip: C('strips', `${it.id}.jpg`), wave: C('waves', `${it.id}.png`), orig: it.path,
        play: it.kind === 'video' && it.proxy !== 'none' ? (it.proxy === 'ready' ? C('proxies', `${it.id}.mp4`) : null)
          // over the internet a heavy file plays from its light copy once made (ensureLite); here, the file itself
          : it.lite === 'ready' && !req.who?.local && fs.existsSync(C('proxies', `${it.id}.mp4`)) ? C('proxies', `${it.id}.mp4`) : it.path }[m[3]];
      if (!file) return send(res, 409, { error: 'proxy not ready yet' });
      return serveFile(req, res, file, m[3] !== 'play' && m[3] !== 'orig');
    }
    // project files: /pf/<project>/<renders|subs>/<file>
    m = /^\/pf\/([^/]+)\/(renders|subs|thumbnails)\/(.+)$/.exec(u.pathname);
    if (req.method === 'GET' && m) return serveFile(req, res, P(needProject(decodeURIComponent(m[1])), ...(m[2] === 'thumbnails' ? ['exports', 'thumbnails'] : [m[2]]), path.basename(decodeURIComponent(m[3]))));
    if (req.method === 'GET') {
      const f = path.join(ROOT, 'public', u.pathname === '/' ? 'index.html' : path.normalize(decodeURIComponent(u.pathname)));
      if (f.startsWith(path.join(ROOT, 'public'))) return serveFile(req, res, f);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
  }
}
const OWNER = { name: 'Owner', role: 'owner', local: true };
const server = http.createServer((req, res) => handle(req, res, OWNER));
const listen = () => server.listen(PORT, '127.0.0.1');
server.on('listening', () => {
  console.log(`Video editor running at ${APP_URL}  (close this window to stop it)`);
  console.log(`Projects are saved in ${PROJECTS}`);
  if (process.argv.includes('--open')) openBrowser();
});
let retried = false;
server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') { console.error(e); process.exit(1); }
  // something already runs on the port: the same version -> just open it; an older version -> replace it
  let other = null;
  try { other = await (await fetch(`${APP_URL}/api/version`, { signal: AbortSignal.timeout(3000) })).json(); } catch {}
  if (other?.build === BUILD || retried || other?.busy) {
    console.log(other?.busy && other.build !== BUILD
      ? `The editor is already running and busy (${other.busy} job${other.busy > 1 ? 's' : ''}: an edit or a render) - it keeps running; start this again when it is done to load the newer version. Opening ${APP_URL}`
      : `The editor is already running - opening ${APP_URL}`);
    if (process.argv.includes('--open')) openBrowser();
    return setTimeout(() => process.exit(0), 500);
  }
  if (other?.build) {
    console.log('An older version of the editor is running - replacing it with this one…');
    try { await fetch(`${APP_URL}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) }); } catch {}
  } else {
    console.log(`Port ${PORT} is busy with an older editor that cannot be closed automatically.`);
    console.log('Close its black window (or restart the computer), then double-click Start Video Editor again.');
    if (process.platform === 'win32') spawnSync('cmd', ['/c', 'pause'], { stdio: 'inherit' });
    return process.exit(1);
  }
  retried = true;
  setTimeout(listen, 1200);
});
listen();

function openBrowser() {
  spawn(process.platform === 'win32' ? 'cmd' : 'open', process.platform === 'win32' ? ['/c', 'start', '', APP_URL] : [APP_URL], { detached: true, stdio: 'ignore' }).unref();
}
