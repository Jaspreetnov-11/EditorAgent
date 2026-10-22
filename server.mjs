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
import { newProject, uid, placed, clipDur, seqOf, seqHash, ASPECTS, normalizeProject, rangeOf, totalDuration } from './public/js/model.js';
import { gfxKey } from './public/js/graphics.js';
import { CAPTION_LANGS, translatePrompt, parseTranslation } from './public/js/captions.js';
import { stabOf } from './public/js/effects.js';
import { ensureLuts, guessLogLut } from './engine/lutgen.mjs';
import { ensureLooks } from './engine/looklut.mjs';
import { keywords, searchStock, downloadStock } from './engine/stock.mjs';
import { measure, autoGrade, looksLog, matchGrade } from './engine/colorstats.mjs';
import { colorFilters, stager, isNeutral } from './engine/color.mjs';
import { cutFxDur } from './public/js/fx.js';
import { exportTimeline } from './engine/nlexport.mjs';
import { presetById } from './public/js/presets.js';
import { applyOps } from './public/js/livepatch.js';
import { learnStyle, describeStyle } from './engine/editstyle.mjs';
import { analyzeClip, extractFrames } from './engine/analyze.mjs';
import { addBeat, prune as prunePresence, summary as presenceSummary, KEEP_DAYS } from './engine/presence.mjs';
import { toEnglishQuery } from './engine/searchwords.mjs';
import { mentioned, textHits, loadLibrary, saveLibrary, label as peopleLabel } from './engine/people.mjs';
import { readXmeml, aspectOf } from './engine/xmlimport.mjs';
import { ensureSfx, listSfx, SFX_KINDS } from './engine/sfx.mjs';
import { gyroflowExe, findLog, gyroSamples, stabilise, LOG_EXT as GF_LOG } from './engine/gyroflow.mjs';
import { runNightly, mirrorLive, restoreProject, nights as backupNights, standbyState, liveDir, dayOf, safeDir } from './engine/safety.mjs';
import * as QC from './engine/qc.mjs';
import { archiveRoutes } from './engine/archive.mjs';
import { startHealth, noteRequest, healthSeries } from './engine/health.mjs';
import { ReviewStore, Limiter, findLink, sameSecret, pwOk, pwCookie, cleanText, cleanName, cleanDraw, renderPath, expired, latest, clientView, ownerView, readLimited, newId, hashPw as rvHashPw, MAX_COMMENTS } from './engine/clientreview.mjs';

// more file workers for Node (default 4): slow NAS reads of scans / probes took all four and the Program monitor's
// video waited behind them (~0.1 MB/s for a 70 Mbps clip - a black monitor). Set here, before the first file read
// starts the pool, so it holds however the server is started (an old tray script in memory did not pass it).
process.env.UV_THREADPOOL_SIZE ||= '32';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// VEDIT_DATA: where projects, settings and queues live (default: this folder). The auto-tests run a second editor
// with its own throwaway folder, so it never touches the real projects or the real render queue (tests/run.mjs --server).
const DATA = process.env.VEDIT_DATA ? path.resolve(process.env.VEDIT_DATA) : ROOT;
const PROJECTS = path.join(DATA, 'Projects');
const GLOBAL_LUTS = path.join(ROOT, 'LUTs');
fs.mkdirSync(PROJECTS, { recursive: true });
// 📍 a project can be saved in any folder this computer can open (Z:\ on the NAS, D:\Edits, \\GUNA-PC\D\...), chosen in
// New project. project-places.json remembers where each one outside Projects is ({ name: its folder }); projDir finds it.
const PLACES_FILE = path.join(DATA, 'project-places.json');
let placesCache = null;
let placesMt = 0;
// (read again when the file changed - ⚙ project workers and the main process each keep a copy)
const projectPlaces = () => { let mt = 0; try { mt = fs.statSync(PLACES_FILE).mtimeMs; } catch {} if (!placesCache || mt !== placesMt) { placesCache = readJSON(PLACES_FILE, {}); placesMt = mt; } return placesCache; };
function setPlace(name, dir) { const pl = { ...projectPlaces() }; if (dir) pl[name] = dir; else delete pl[name]; placesCache = pl; writeJSON(PLACES_FILE, pl); }
// every project: the ones in Projects, then the ones saved elsewhere (a drive that is not connected right now is left out)
const allProjects = () => [...fs.readdirSync(PROJECTS).filter((n) => fs.existsSync(path.join(PROJECTS, n, 'project.json'))),
  ...Object.entries(projectPlaces()).filter(([n, d]) => !fs.existsSync(path.join(PROJECTS, n, 'project.json')) && fs.existsSync(path.join(d, 'project.json'))).map(([n]) => n)];
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
// 🧬 same-voice dubbing has its own Python (its pinned torch / transformers would break the editor's other AI tools)
const AIVOICE_PY = path.join(ROOT, 'tools', 'aivoice', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const aiVoiceReady = () => fs.existsSync(path.join(ROOT, 'tools', 'aivoice', 'venv', 'Lib', 'site-packages', 'chatterbox', 'mtl_tts.py'));
let aiVoiceSetup = null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.srt': 'text/plain; charset=utf-8', '.ass': 'text/plain; charset=utf-8',
};
const EXT_KIND = (ext) => (/\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|mxf|mpg|mpeg|3gp|wmv|flv)$/i.test(ext) ? 'video'
  : /\.(jpg|jpeg|png|webp|bmp|tif|tiff|heic)$/i.test(ext) ? 'image'
  : /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|aif|aiff|mpga)$/i.test(ext) ? 'audio' : /\.(srt|ass)$/i.test(ext) ? 'subs'
  : /\.cube$/i.test(ext) ? 'lut' : 'other');

// 10-02 03-25 (local time) for generated file names
const localStamp = () => { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`; };
const safeName = (n) => String(n).replace(/[\\/:*?"<>|]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || 'untitled';
const err = (code, msg) => Object.assign(new Error(msg), { code });

// ---------------- ⚙ project workers (config.cluster.workers, 🩺 Mazbooti) ----------------
// Off (0) = one process does everything, as always. On (N): this process (the main one) keeps the doors (ports 3000,
// team, farm, phone review), sign-ins, the render queue, publish / batch, backups and the settings, and starts N worker
// processes (127.0.0.1:3401…). Every project belongs to one worker (by its name), which alone keeps it in memory: its
// live editing, media list, thumbnails / previews, jobs. A project's heavy moment (a 5000-clip save, a slow NAS) then only
// slows the projects of its own worker. The main process never holds a project's state, so two processes never write
// one project's files; it hands every request about a project to its worker (handle -> forward).
const WORKER_K = +process.env.VEDIT_WORKER || 0; // 1…N in a worker, 0 in the main process
const WORKERS = Math.max(0, Math.min(16, WORKER_K ? +process.env.VEDIT_WORKERS || 0 : +(process.env.VEDIT_CLUSTER ?? config().cluster?.workers) || 0)); // (VEDIT_CLUSTER: the auto-tests)
const IS_WORKER = WORKER_K > 0, CLUSTER = WORKERS > 0;
const CL_KEY = process.env.VEDIT_KEY || crypto.randomBytes(18).toString('hex'); // (only the main process may talk to a worker)
const workerPort = (k) => (+process.env.WORKER_BASE || 3400) + k;
function ownerOf(name) {
  if (!CLUSTER) return 0;
  let h = 2166136261; for (const ch of safeName(name).toLowerCase()) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return 1 + (h % WORKERS);
}
const owns = (name) => !CLUSTER || (IS_WORKER && ownerOf(name) === WORKER_K); // this process keeps the project in memory

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
// ⚡ the editor's own files (public/: scripts, styles, icons) are kept in memory once read: reading them goes through
// Node's few file workers, which slow camera files on the NAS (scans, proxies) can keep busy for seconds - every
// one of ~100 scripts then waited, and the editor stayed black for a minute
const PUBLIC_DIR = path.join(ROOT, 'public'), memFiles = new Map(); // file -> { mtime, size, buf }
function serveFile(req, res, file, cache = false) {
  if (file && file.startsWith(PUBLIC_DIR) && !req.headers.range) {
    let st = null; try { st = fs.statSync(file); } catch {}
    if (st?.isFile() && st.size < 4e6) {
      let hit = memFiles.get(file);
      if (!hit || hit.mtime !== st.mtimeMs || hit.size !== st.size) { hit = { mtime: st.mtimeMs, size: st.size, buf: fs.readFileSync(file) }; memFiles.set(file, hit); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache ? 'max-age=31536000' : 'no-store', 'Content-Length': hit.buf.length });
      return res.end(req.method === 'HEAD' ? undefined : hit.buf);
    }
  }
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
  const at = projectPlaces()[safeName(name)];
  if (at && !fs.existsSync(path.join(PROJECTS, safeName(name), 'project.json'))) return at;
  const d = path.join(PROJECTS, safeName(name));
  if (!d.startsWith(PROJECTS)) throw err(400, 'bad project name');
  return d;
};
const P = (name, ...parts) => path.join(projDir(name), ...parts);
function ensureProjectDirs(name) {
  // (the folder for XML exports and thumbnails was called "exports" before - it is "output" now)
  try { if (fs.existsSync(P(name, 'exports')) && !fs.existsSync(P(name, 'output'))) fs.renameSync(P(name, 'exports'), P(name, 'output')); } catch {}
  for (const d of ['imports', 'cache/thumbs', 'cache/strips', 'cache/waves', 'cache/proxies', 'cache/analysis', 'subs', 'renders', 'output', 'backups', 'luts'])
    fs.mkdirSync(P(name, d), { recursive: true });
}
function needProject(name) {
  if (!name || !fs.existsSync(P(name, 'project.json'))) throw err(404, `project "${name}" not found`);
  return name;
}

const mediaCache = new Map(); // project -> { items: [] }
const mediaRead = new Map(); // ⚙ project kept by another process -> when its copy here was read
function mediaDb(name) {
  // (⚙ another process keeps it: a fresh read, held 2 s - while a change made here is waiting to be written, until then)
  if (!owns(name) && mediaCache.has(name) && !saveTimers.has(name) && Date.now() - (mediaRead.get(name) || 0) > 2000) mediaCache.delete(name);
  if (!mediaCache.has(name)) { mediaCache.set(name, readJSON(P(name, 'media.json'), { items: [] })); mediaRead.set(name, Date.now()); }
  return mediaCache.get(name);
}
const saveTimers = new Map();
function saveMedia(name, now = false) {
  clearTimeout(saveTimers.get(name));
  // the project folder may have been deleted meanwhile - then there is nothing to save
  const write = () => { const db = mediaCache.get(name); saveTimers.delete(name); if (db && fs.existsSync(projDir(name))) writeJSON(P(name, 'media.json'), db); };
  if (now) write(); else saveTimers.set(name, setTimeout(write, 500));
}
const mediaItem = (name, id) => mediaDb(name).items.find((m) => m.id === id);

// an uploaded file (whole, or its last piece arrived) into the project: imports/ (or luts/, subs/), then into Media - in
// the 📁 folder that was open (bin) - and read ahead of any big folder still being read (the agent may wait for it)
function finishUpload(name, tmp, rawName, rawBin) {
  let fname = safeName(path.basename(rawName || 'upload'));
  const { name: b, ext } = path.parse(fname), kind = EXT_KIND(ext);
  const dir = kind === 'lut' ? P(name, 'luts') : kind === 'subs' ? P(name, 'subs') : P(name, 'imports');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; fs.existsSync(path.join(dir, fname)); i++) fname = `${b}_${i}${ext}`;
  const dest = path.join(dir, fname);
  // (a project on the NAS: the rename can fail - the upload then fails with a message, the editor keeps running)
  try { fs.renameSync(tmp, dest); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw err(500, `Could not save ${fname} into the project folder: ${e.code || e.message}`); }
  if (kind === 'lut' || kind === 'subs') return { kind, name: fname };
  const it = addMediaFile(name, dest, { bin: String(rawBin || '').replace(/\\/g, '/').slice(0, 120) || 'Uploads', imported: true });
  saveMedia(name, true);
  if (it) { const k = quickQ.findIndex((x) => x.proj === name && x.id === it.id); if (k > 0) quickQ.unshift(...quickQ.splice(k, 1)); pump(); }
  return it ? publicMedia(name, it) : { kind: 'other', name: fname, error: 'Not a video, image or audio file' };
}
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

function scanFolder(dir, { max = 5000, depth = 8, other = null } = {}) {
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
      else if (other && NOT_MEDIA[path.extname(e.name).toLowerCase()]) { const x = path.extname(e.name).toLowerCase(); other[x] = (other[x] || 0) + 1; } // (RAW / project files: told, not taken)
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
// the same without holding the server (a big project on the NAS has many thousands of files)
async function dirSizeAsync(d) {
  let n = 0, files = 0;
  const walk = async (x) => { let ents = []; try { ents = await fs.promises.readdir(x, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const f = path.join(x, e.name); if (e.isDirectory()) await walk(f); else { try { n += (await fs.promises.stat(f)).size; files++; } catch {} } } };
  await walk(d);
  return { bytes: n, files };
}
const DISK_PARTS = [
  ['segments', ['cache', 'segments'], 'Rendered shots (cache) - made again on the next render', true],
  ['proxies', ['cache', 'proxies'], 'Preview copies (small files for playback)', false],
  ['undo', ['cache', 'undo'], '↶ AI undo ki copies', true],
  ['renders', ['renders'], 'Bani hui videos (renders)', false],
  ['exports', ['output'], 'Output (XML, thumbnails…)', false],
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
  for (const d of ['imports', 'renders', 'output', 'backups', 'subs', 'luts', 'cache/thumbs', 'cache/strips', 'cache/waves', 'cache/proxies', 'cache/analysis']) fs.mkdirSync(path.join(out, d), { recursive: true });
  const info = { from: name, packedAt: Date.now(), files: plan.length, bytes: total, all: !!opts.all, missing: missing.map((m) => m.name) };
  writeJSON(path.join(out, 'pack-info.json'), info);
  job.progress = 100;
  return { folder: out, ...info };
}

// ---------------- media processing: probe, thumbnail, filmstrip, waveform, proxy ----------------
const quickQ = [], proxyQ = [];
const jobs = new Map(); // background jobs (renders, agent, transcription...) - see startJob / startTask
let quickActive = 0, proxyActive = 0;
function enqueue(proj, id) { if (!owns(proj)) return; quickQ.push({ proj, id }); pump(); } // (⚙ its own worker reads it - handOver)

// ❗ why a file cannot be used, in words (instead of "Could not read this file")
function whyUnreadable(file, stderr = '') {
  let size = -1; try { size = fs.statSync(file).size; } catch {}
  const e = String(stderr).toLowerCase();
  if (size === 0) return 'The file is empty (0 bytes) - copy it again from the card or drive';
  if (size >= 0 && size < 2048) return 'The file is too small to be a video / photo / sound - it may not have finished copying';
  if (/moov atom not found|invalid data found|end of file|truncat/.test(e)) return 'The file is damaged or not fully copied (often a recording that stopped early) - copy it again, or repair it';
  if (/permission denied|access is denied/.test(e)) return 'The editor is not allowed to open this file (Windows permissions / the NAS share)';
  if (/no such file/.test(e)) return 'The file is not there any more';
  if (/unknown|unsupported|not implemented/.test(e)) return `This file's format cannot be read here (${path.extname(file) || 'no extension'}) - export it as MP4 (H.264) or MOV (ProRes) first`;
  return `This file cannot be read${stderr ? ` (${String(stderr).trim().split(/\r?\n/).pop().slice(0, 120)})` : ''} - try exporting it again as MP4`;
}
// camera RAW / project files a folder may hold: listed when a folder is imported, so they are not silently missing
const NOT_MEDIA = { '.braw': 'Blackmagic RAW - export as ProRes / MP4 from DaVinci Resolve', '.r3d': 'RED RAW - export as ProRes / MP4 from REDCINE-X or Resolve',
  '.ari': 'ARRI RAW - export as ProRes from Resolve', '.crm': 'Canon Cinema RAW - export as MP4 / ProRes', '.mxf.part': 'an unfinished copy',
  '.cr2': 'a camera RAW photo - save it as JPG', '.cr3': 'a camera RAW photo - save it as JPG', '.nef': 'a camera RAW photo - save it as JPG', '.arw': 'a camera RAW photo - save it as JPG', '.dng': 'a RAW photo - save it as JPG',
  '.psd': 'a Photoshop file - save it as PNG / JPG', '.ai': 'an Illustrator file - save it as PNG', '.prproj': 'a Premiere project - open it in Premiere, or export an XML (File › Open here)',
  '.aep': 'an After Effects project - render it to a video first', '.drp': 'a Resolve project - export a timeline XML' };
async function ffprobe(file) {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) { ffprobe.lastErr = r.stderr; return null; }
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
  if (!info) { m.status = 'error'; m.error = whyUnreadable(m.path, ffprobe.lastErr); return; }
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
// 🔊 the sound's real peaks for the timeline's waveform: one byte (0-255 = silence-full scale) every 10 ms, mono.
// The timeline draws them at any zoom, so a word, a breath or a beat is where it is heard (the 1600 px picture of the
// whole file, stretched over a long voice-over, did not match it). Made once, on first ask.
const PEAKS_PER_SEC = 100, peaksMaking = new Map();
function makePeaks(file, out) {
  if (peaksMaking.has(out)) return peaksMaking.get(out);
  const job = new Promise((ok) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { windowsHide: true });
    const per = 8000 / PEAKS_PER_SEC, peaks = [];
    let carry = Buffer.alloc(0), n = 0, max = 0;
    p.stdout.on('data', (d) => {
      const b = carry.length ? Buffer.concat([carry, d]) : d, len = b.length - (b.length % 2);
      for (let i = 0; i < len; i += 2) {
        const v = Math.abs(b.readInt16LE(i));
        if (v > max) max = v;
        if (++n === per) { peaks.push(Math.min(255, Math.round((max / 32767) * 255))); n = 0; max = 0; }
      }
      carry = b.subarray(len);
    });
    p.on('error', () => ok(false));
    p.on('close', () => {
      if (n) peaks.push(Math.min(255, Math.round((max / 32767) * 255)));
      if (peaks.length) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, Buffer.from(peaks)); }
      ok(peaks.length > 0);
    });
  }).finally(() => peaksMaking.delete(out));
  peaksMaking.set(out, job);
  return job;
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
// 🎞 old 540p preview copies of the files on a project's timelines are made again at 1080p, in the background (once
// per project and server start). Files the monitor plays itself (HEVC, H.264 - see player.js) are left as they are.
const upQueued = new Set();
const playsItself = (m) => (m.vcodec === 'hevc' && /^yuv420p(10le)?$/.test(m.pixfmt || '')) || (m.vcodec === 'h264' && /^yuvj?420p$/.test(m.pixfmt || ''));
function upgradeProxies(proj) {
  if (upQueued.has(proj)) return;
  upQueued.add(proj);
  const used = usedMediaIds(proj);
  for (const m of mediaDb(proj).items) {
    // (a proxyUp left from a server stopped half way is taken up again: this runs once per start)
    if (!used.has(m.id) || m.kind !== 'video' || m.proxy !== 'ready' || (m.proxyH || 0) >= PROXY_H || playsItself(m)) continue;
    m.proxyUp = 'queued'; proxyQ.push({ proj, id: m.id });
  }
  pump();
}
function ensureLite(proj) {
  if (liteQueued.has(proj)) return;
  liteQueued.add(proj);
  for (const m of mediaDb(proj).items) {
    if (!heavy(m) || m.lite === 'ready' && fs.existsSync(P(proj, 'cache', 'proxies', `${m.id}.mp4`))) continue;
    m.lite = 'queued'; proxyQ.push({ proj, id: m.id });
  }
  pump();
}
// 🎞 The preview copy of a file the browser cannot play (MXF, ProRes, 4:2:2, 10-bit H.264) is 1080p and nearly as good
// as the file (crf 18) - the monitor is to look like the footage, as in Premiere. It was 540p / crf 26 and the monitor
// looked soft. (The light copy for editors over the internet stays small: it has to stream.) PROXY_H marks the new ones.
const PROXY_H = 1080;
async function processProxy(proj, id) {
  const m = mediaItem(proj, id);
  if (!m || !fs.existsSync(m.path)) return;
  const lite = m.proxy === 'none'; // (a light copy of a file that plays as it is)
  const up = !lite && m.proxy === 'ready' && m.proxyUp; // (a sharper copy replacing an old 540p one: the old one plays meanwhile)
  if (lite) { m.lite = 'making'; } else if (up) { m.proxyUp = 'making'; } else { m.proxy = 'making'; m.proxyPct = 0; }
  const out = P(proj, 'cache', 'proxies', `${id}.mp4`), tmp = `${out}.part.mp4`;
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', m.path, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', lite ? 'scale=-2:540,format=yuv420p' : `scale=-2:'min(ih,${PROXY_H})',format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', lite ? '26' : '18', '-g', '12', '-c:a', 'aac', '-b:a', lite ? '128k' : '192k', '-ac', '2',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp],
  { onLine: (l) => { const k = /^out_time_ms=(\d+)/.exec(l); if (k && m.duration && !lite) m.proxyPct = Math.min(99, Math.round((+k[1] / 1e6 / m.duration) * 100)); } });
  if (lite) {
    if (r.code === 0 && fs.existsSync(tmp)) { fs.renameSync(tmp, out); m.lite = 'ready'; } else { fs.rmSync(tmp, { force: true }); m.lite = 'error'; }
    return;
  }
  if (up) {
    if (r.code === 0 && fs.existsSync(tmp)) { fs.renameSync(tmp, out); m.proxyH = PROXY_H; m.mtimeProxy = Date.now(); } else fs.rmSync(tmp, { force: true });
    delete m.proxyUp;
    return;
  }
  if (r.code === 0 && fs.existsSync(tmp)) {
    fs.renameSync(tmp, out); m.proxy = 'ready'; m.proxyPct = 100; m.proxyH = PROXY_H;
    if (m.hasAudio && !m.wave) m.wave = await makeWave(out, P(proj, 'cache', 'waves', `${id}.png`));
    // the agent's per-second analysis, from the small proxy right away, so the agent never has to read the camera file
    await analyzeClip(out, P(proj, 'cache', 'analysis', `${id}.json`), { hasAudio: m.hasAudio, duration: m.duration }).catch(() => {});
  } else { fs.rmSync(tmp, { force: true }); m.proxy = 'error'; m.error = r.stderr.slice(-300); }
}

// Several files at a time; the project that is open in the browser goes first.
// 3 proxies at once: decoding 4K camera files is the slow part and spreads over the cores; more would only wait on the drive
// (⚙ project workers share these out, so N workers together read no more files at once than one editor did)
const QUICK_WORKERS = IS_WORKER ? Math.max(1, Math.ceil(4 / WORKERS)) : 3, PROXY_WORKERS = IS_WORKER ? Math.max(1, Math.ceil(3 / WORKERS)) : 3;
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
for (const proj of process.env.VEDIT_NO_RESUME && !IS_WORKER ? [] : allProjects().filter(owns)) { // (⚙ a worker: its own projects)
  ensureProjectDirs(proj);
  for (const m of mediaDb(proj).items) {
    if (m.status !== 'ready' && m.status !== 'offline') { m.status = 'queued'; quickQ[m.kind === 'audio' ? 'unshift' : 'push']({ proj, id: m.id }); }
    else if (['queued', 'making', 'pending'].includes(m.proxy)) { m.proxy = 'queued'; proxyQ.push({ proj, id: m.id }); }
  }
}
pump();

// Media as the browser needs it (no absolute paths needed client side except for display).
function publicMedia(proj, m) {
  const base = `/pm/${encodeURIComponent(proj)}/${m.subOf || m.id}`; // (✂ a subclip shows and plays its whole file)
  const playable = m.kind === 'video' ? (m.proxy === 'ready' || m.proxy === 'none') : m.kind !== 'image' || true;
  return { ...m, camera: m.kind === 'video' && m.width && !m.seqOf ? cameraKey(m) : null, urls: { play: `${base}/play`, thumb: m.thumb ? `${base}/thumb` : null, strip: m.strip ? `${base}/strip` : null, wave: m.wave ? `${base}/wave` : null, peaks: m.hasAudio ? `${base}/peaks` : null }, playable };
}

// ---------------- jobs ----------------
let jobSeq = 0;
// (⚙ a worker's jobs say whose they are - w3-12 - so the main process sends 'how far is it' to that worker)
const JOB_ID = () => `${IS_WORKER ? `w${WORKER_K}-` : ''}${++jobSeq}`;
function startJob(kind, cmd, args, onDone, meta = {}) {
  const id = JOB_ID();
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
// (✨ AI fill: one at a time - it fills the GPU's memory)
const SLOTS = { agent: Math.max(1, +process.env.VEDIT_MAX_AGENTS || 2), claude: Math.max(1, +process.env.VEDIT_MAX_CLAUDE || 4), inpaint: 1 };
const lines = { agent: [], claude: [], inpaint: [] }, inUse = { agent: 0, claude: 0, inpaint: 0 };
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
  const id = JOB_ID();
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
// 🎥 two stabilised copies for the monitor at a time (each FFmpeg uses every core); the others wait their turn
let stabBusy = 0;
const stabWait = [];
const stabLine = (fn) => new Promise((ok, bad) => {
  const go = () => { stabBusy++; fn().then(ok, bad).finally(() => { stabBusy--; stabWait.shift()?.(); }); };
  if (stabBusy < 2) go(); else stabWait.push(go);
});
// Prefer the small proxy for analysis (much faster); colours are the same.
const analysisFile = (proj, m) => (m.proxy === 'ready' ? P(proj, 'cache', 'proxies', `${m.id}.mp4`) : m.path);

const outReserved = new Map(); // `${project}/${file}` -> when a render was promised that name
// Validate the timeline and write the job file render2.mjs reads. b = { project?, preview?, filename?, seq?, whole? }
// 🎬 the timeline's In / Out (settings.range) is all that is made, unless b.whole (Export > Whole timeline)
// o.write = false: b.project is only a copy to render (the render queue), not the edit to save; o.jobFile: where to write
function prepareRender(name, b, o = {}) {
  checkOffline(name, true); // 🔗 a moved file is found again before the render needs it
  const saved = normalizeProject(b.project || readJSON(P(name, 'project.json'))); // (🛡 sound before it is rendered)
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
    ...(+qy.crf ? { crf: +qy.crf } : {}), ...(+qy.abr ? { abr: +qy.abr } : {}), ...(qy.gpu === 'off' ? { gpu: false } : qy.gpu && healthCache?.nvenc ? { gpu: true } : {}),
    ...(qy.burnTC ? { burnTC: true } : {}), ...(qy.burnName ? { burnName: true } : {}) } : null; // (⏱ burn-in for review copies)
  const base = safeName(b.filename || pj.name || name) + (pr && b.tag !== false ? `_${pr.tag}` : '') + (b.tag !== false && exp?.res ? { 2160: '_4K', 1440: '_2K', 1080: '_1080p', 720: '_720p', 480: '_480p' }[exp.res] || '' : '');
  const cod = exp?.codec || pr?.codec;
  // (🎞 DNxHR / ProRes .mov · 🎧 WAV / MP3 sound only · GIF · 🖼 PNG frames into a folder named like a file, no extension)
  const ext = { prores: 'mov', dnxhr: 'mov', wav: 'wav', mp3: 'mp3', gif: 'gif', png: '' }[cod] ?? 'mp4';
  let out = '_preview.mp4';
  // names already promised to renders still waiting in the queue count as taken
  // (and names just given to a render started a moment ago - two renders at once used to write into the same file)
  const taken = (f) => fs.existsSync(P(name, 'renders', f)) || rq.items.some((x) => x.project === name && x.out === f && ['waiting', 'rendering'].includes(x.state))
    || Date.now() - (outReserved.get(`${name}/${f}`) || 0) < 6 * 3600e3;
  const fname = (v) => (ext ? `${base}_v${v}.${ext}` : `${base}_v${v} frames`);
  if (!preview) { let v = 1; while (taken(fname(v))) v++; out = fname(v); outReserved.set(`${name}/${out}`, Date.now()); }
  const media = Object.fromEntries([...used].map((id) => [id, { path: byId[id].path, duration: byId[id].duration, hasAudio: byId[id].hasAudio, kind: byId[id].kind, width: byId[id].width, height: byId[id].height, rotation: byId[id].rotation, size: byId[id].size, mtime: byId[id].mtime, subOf: byId[id].subOf }]));
  const jobFile = o.jobFile || P(name, 'cache', preview ? 'render-job-preview.json' : `render-job-${safeName(out)}.json`);
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  const range = b.whole ? null : rangeOf(pj, totalDuration(pj, byId));
  // segCache: shots that did not change since an earlier render are reused from cache/segments (engine/render2.mjs)
  writeJSON(jobFile, { project: pj, media, output: P(name, 'renders', out), preview, range, fastPreview: preview && !!b.fast, luts: lutMap(name), export: exp, segCache: P(name, 'cache', 'segments'), gfxDir: P(name, 'cache', 'graphics'),
    farm: !preview && farmCfg().on ? { url: APP_URL } : null,
    subtitlesPath: pj.subtitles?.file ? P(name, 'subs', path.basename(pj.subtitles.file)) : null });
  const D = Math.max(0, ...Object.values(placed(pj, byId)).flat().map((x) => x.end));
  return { jobFile, out, preview, duration: range ? range.out - range.in : D, range };
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
if (!IS_WORKER) setTimeout(pumpQueue, 4000); // (⚙ the render queue is the main process's) whatever was waiting when the editor closed

// one entry per platform: { preset, aspect, fit, filename, quality, seq } - the timeline is copied now
// 📁 "Save to" (Deliver): a folder of the owner's choice where the finished file is also put (the project keeps its copy
// in renders/). Only the owner may choose one - a team member cannot make the editor write anywhere on this computer.
// Editors may choose a folder inside the team's Shared folders only (Team & users > Shared folders, e.g. Z:Exports).
// 💾 from another PC only the NAS can be browsed and used (folder picker, save a project, open one, import footage) -
// this computer's own C: / D: / E: stay private. config.team.remoteDrives, default ["Z:\\"]; this PC itself: anything.
const remoteDrives = () => (teamCfg().remoteDrives?.length ? teamCfg().remoteDrives : ['Z:\\']).map((d) => path.resolve(d));
const underDrive = (p, d) => { const a = path.resolve(String(p)).toLowerCase(), r = d.toLowerCase(); return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };
function folderAllowed(req, p) {
  if (!p || req.who?.local) return;
  if (!remoteDrives().some((d) => underDrive(p, d))) throw err(403, `From another PC only the NAS (${remoteDrives().join(', ')}) can be used - not ${p}`);
}
// 👤 a person's own folder for new projects: Z:\Editor Projects\<the folder named like them> ("Vishal", "Venky Visuals"
// for venky); on this PC itself, the owner's. config.team.userProjects changes the parent folder.
function userHome(who) {
  const base = teamCfg().userProjects || 'Z:\\Editor Projects';
  const name = String(who?.local ? (teamCfg().users || []).find((x) => x.role === 'owner')?.name || '' : who?.name || '').trim();
  if (!name || !fs.existsSync(base)) return null;
  let dirs = []; try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  const n = name.toLowerCase(), hit = dirs.find((d) => d.toLowerCase() === n) || dirs.find((d) => d.toLowerCase().startsWith(`${n} `));
  return path.join(base, hit || safeName(name[0].toUpperCase() + name.slice(1)));
}
const sharedDirs = () => (teamCfg().libraries || []).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
const insideShared = (p) => sharedDirs().some((l) => { let r; try { r = fs.realpathSync(l); } catch { r = path.resolve(l); } const rel = path.relative(r, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); });
function saveToDir(who, d) {
  if (!d || !who || who.role === 'viewer' || !path.isAbsolute(String(d))) return null;
  let p; try { p = fs.realpathSync(path.resolve(String(d))); if (!fs.statSync(p).isDirectory()) return null; } catch { return null; }
  return who.role !== 'viewer' ? p : null; // (every editor may save anywhere on the editing computer, like the owner)
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
    const { jobFile, out, duration, range } = prepareRender(name, { ...b, project: saved }, { write: false, jobFile: P(name, 'cache', 'queue', `${id}.json`) });
    const seqName = b.seq ? seqView(saved, b.seq).seq?.name : saved.seq?.name;
    const pl = presetById(b.preset)?.label || 'Custom';
    const it = { id, project: name, seq: seqName || null, preset: b.preset, aspect: b.aspect, label: (b.aspect && !pl.includes(b.aspect) ? `${pl} · ${b.aspect}` : pl) + (range ? ' · In-Out' : ''),
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
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('project_') && f.endsWith('.json')).sort();
  const last = files[files.length - 1];
  if (!force && last && Date.now() - fs.statSync(path.join(dir, last)).mtimeMs < 5 * 60 * 1000) return;
  fs.copyFileSync(P(proj, 'project.json'), path.join(dir, `project_${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  for (const f of files.slice(0, Math.max(0, files.length - 40))) fs.rmSync(path.join(dir, f), { force: true });
  // 📅 and one for every day it was edited (its last state), kept 60 days - the 40 above only reach back a few hours
  const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  try { fs.copyFileSync(P(proj, 'project.json'), path.join(dir, `daily_${day}.json`)); } catch {}
  const days = fs.readdirSync(dir).filter((f) => /^daily_\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
  for (const f of days.slice(0, Math.max(0, days.length - 60))) fs.rmSync(path.join(dir, f), { force: true });
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

function createProject({ name, aspect, fps, place }) {
  const n = safeName(name);
  if (fs.existsSync(P(n, 'project.json')) || fs.existsSync(path.join(PROJECTS, n, 'project.json'))) throw err(409, `A project called "${n}" already exists`);
  // 📍 saved in a folder of your choice: the project gets its own folder inside it
  if (place) {
    const base = path.resolve(String(place)), dir = path.join(base, n);
    if (!fs.existsSync(base) && fs.existsSync(path.dirname(base))) try { fs.mkdirSync(base); } catch {} // (a new person's own folder)
    if (!fs.existsSync(base)) throw err(400, `Folder not found: ${base}`);
    if (fs.existsSync(path.join(dir, 'project.json'))) throw err(409, `${dir} already has a project - use 📂 Open project folder on Home to add it`);
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); } catch (e) { throw err(400, `Cannot save in ${base} (${e.code || e.message}) - pick a folder you can write to`); }
    if (dir.toLowerCase() !== path.join(PROJECTS, n).toLowerCase()) setPlace(n, dir);
  }
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
const FACE_MODELS = ['face_detection_yunet_2023mar.onnx', 'face_recognition_sface_2021dec.onnx'].map((f) => path.join(ROOT, 'Models', f));
async function checkHealth() {
  // nvenc: a tiny test encode, because the encoder is listed even when the NVIDIA driver is too old to run it
  const [ff, py, clip, nv, cv, ocr] = await Promise.all([run('ffmpeg', ['-version']), run(PYTHON, ['-c', 'import faster_whisper']), run(PYTHON, ['-c', 'import open_clip']),
    run(fs.existsSync(FF_GPU) ? FF_GPU : 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-']),
    run(PYTHON, ['-c', 'import cv2; cv2.FaceRecognizerSF']), run(PYTHON, ['-c', 'import easyocr'])]);
  healthCache = { ffmpeg: ff.code === 0, whisper: py.code === 0, clip: clip.code === 0, nvenc: nv.code === 0, projectsFolder: PROJECTS, lutsFolder: GLOBAL_LUTS,
    // 🧑 faces (OpenCV + the two face models in Models/) and ✍ text on the footage (EasyOCR)
    people: cv.code === 0 && FACE_MODELS.every((f) => fs.existsSync(f)), ocr: ocr.code === 0 };
  return healthCache;
}
checkHealth();

// ---------------- 🛟 Mazbooti (Phase 21): nightly backup, live mirror for a standby PC, health watch ----------------
// config.safety = { on, dest, hour, keep, mirror } (🩺 Mazbooti window). engine/safety.mjs does the copying,
// engine/health.mjs the watching, engine/standby.mjs runs on the second PC. A standby's own editor (VEDIT_STANDBY) runs
// from the mirror and makes no backups or mirror of its own.
const STANDBY = process.env.VEDIT_STANDBY || null;
startHealth(path.join(DATA, 'logs'), IS_WORKER ? `-w${WORKER_K}` : ''); // (⚙ each project worker its own file)
function safetyCfg() {
  const s = config().safety || {};
  const dest = s.dest || (fs.existsSync('Z:\\') ? 'Z:\\Limelight Backups' : ''); // (the NAS, when this PC has it)
  return { on: s.on !== false && !!dest, dest, hour: Number.isInteger(s.hour) ? s.hour : 2, keep: Math.max(3, Math.min(60, +s.keep || 14)), mirror: !!s.mirror && !!dest };
}
function saveSafety(patch) { const c = config(); c.safety = { ...(c.safety || {}), ...patch }; fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1)); }
const safetyRun = { busy: null, last: null, failedAt: 0, mirrorAt: 0, mirrorErr: null, mirrored: new Map(), pull: null };
const safeProjects = () => allProjects().map((name) => ({ name, dir: projDir(name) })).filter((p) => fs.existsSync(path.join(p.dir, 'project.json')));
// what goes with the projects: into each night everything; into the live mirror only what a standby's editor reads
// from its data folder (its Library and LUTs are its own)
const appOf = (night) => (night
  ? { files: [[PLACES_FILE, 'project-places.json'], [path.join(DATA, 'project-folders.json'), 'project-folders.json']], dirs: [[LIB, 'Library'], [GLOBAL_LUTS, 'LUTs']], config: config() }
  : { files: [[path.join(DATA, 'project-folders.json'), 'project-folders.json']], config: config() });
// (⚙ with project workers: each worker saves what it keeps)
async function flushLive() { for (const [name, L] of live) { try { liveWrite(name, L, true); } catch {} } if (CLUSTER && !IS_WORKER) await Promise.all([...Array(WORKERS)].map((_, i) => askWorker(i + 1, 'flush').catch(() => {}))); }

async function nightlyBackup(force = false) {
  const s = safetyCfg();
  if (STANDBY || safetyRun.busy || (!force && !s.on) || !s.dest) return null;
  const st = readJSON(path.join(s.dest, 'status.json'), null), lastOk = (st?.history || []).find((x) => x.ok);
  if (!force) {
    // after the hour: once a day; before it: only when a night was missed (the very first one waits for the hour, or Back up now)
    const now = new Date(), due = now.getHours() >= s.hour ? lastOk?.night !== dayOf(now) : !!lastOk && Date.now() - lastOk.at > 30 * 3600e3;
    if (!due || Date.now() - safetyRun.failedAt < 3600e3) return null; // (a failed night is tried again after an hour)
  }
  safetyRun.busy = { kind: 'backup', step: 'starting', at: Date.now() };
  try {
    fs.mkdirSync(s.dest, { recursive: true });
    await flushLive();
    const r = await runNightly({ dest: s.dest, projects: safeProjects(), app: appOf(true), keep: s.keep, onProgress: (step) => { safetyRun.busy.step = step; } });
    safetyRun.last = r; if (!r.ok) { safetyRun.failedAt = Date.now(); logCrash('nightly backup', r.errors.join('; ')); }
    console.log(`🌙 Nightly backup ${r.ok ? 'done' : 'done with errors'}: ${r.projects} projects, ${Math.round(r.bytes / 1048576)} MB copied, ${r.secs} s → ${s.dest}`);
    return r;
  } catch (e) {
    safetyRun.last = { night: dayOf(), at: Date.now(), ok: false, errors: [e.message] }; safetyRun.failedAt = Date.now();
    logCrash('nightly backup', e);
    return safetyRun.last;
  } finally { safetyRun.busy = null; }
}
// 🔁 every 5 minutes: the projects that changed go to the live mirror (only while Standby is on, and never over edits a
// standby PC made that are not back here yet)
async function mirrorTick(all = false) {
  const s = safetyCfg();
  if (STANDBY || !s.mirror || safetyRun.mirroring) return;
  const sb = standbyState(s.dest);
  if (sb && sb.state !== 'pulled') return;
  safetyRun.mirroring = true;
  try {
    await flushLive();
    const key = (p) => ['project.json', 'media.json'].map((f) => { try { return fs.statSync(path.join(p.dir, f)).mtimeMs; } catch { return 0; } }).join('|');
    const changed = safeProjects().filter((p) => all || safetyRun.mirrored.get(p.name) !== key(p));
    if (changed.length || Date.now() - safetyRun.mirrorAt > 30 * 60e3) {
      await mirrorLive({ dest: s.dest, projects: changed, app: appOf(false), host: os.hostname() });
      for (const p of changed) safetyRun.mirrored.set(p.name, key(p));
    }
    safetyRun.mirrorAt = Date.now(); safetyRun.mirrorErr = null;
  } catch (e) { safetyRun.mirrorErr = e.message; logCrash('live mirror', e); }
  finally { safetyRun.mirroring = false; }
}
// 🖥 a standby PC that ran the editor (engine/standby.mjs): while it runs, this editor only shows (no two editors write
// the same project); once it has handed back, its edits come in here - its timeline wins (this editor was down
// meanwhile; the one from before goes into Versions), files added there are added here
let standbyHold = null; // { host, since, pending?, error? } - edits are held back
function writeStandby(dest, o) { const f = path.join(liveDir(dest), 'standby.json'); fs.writeFileSync(`${f}.tmp`, JSON.stringify(o, null, 1)); fs.renameSync(`${f}.tmp`, f); }
// one project's edits from the standby's copy in folder pd - run by the process that keeps the project (⚙ its worker)
function pullProject(name, pd) {
  const lp = P(name, 'project.json');
  // (opening a project on the standby touches its file - only a real change comes back)
  const same = (f) => { const pj = normalizeProject(readJSON(f, {})); delete pj.modified; delete pj._rev; return JSON.stringify(pj); };
  const changed = same(path.join(pd, 'project.json')) !== same(lp);
  if (changed) {
    const L = live.get(name); if (L) { clearTimeout(L.timer); L.timer = null; }
    backup(name, true); fs.copyFileSync(path.join(pd, 'project.json'), lp); const now = new Date(); fs.utimesSync(lp, now, now);
    if (L) liveOf(name); // (the open editors switch to it)
  }
  let added = 0;
  const db = mediaDb(name), have = new Set(db.items.map((m) => m.id)), sdb = readJSON(path.join(pd, 'media.json'), { items: [] });
  for (const m of sdb.items || []) {
    if (have.has(m.id)) continue;
    let p = m.origPath || m.path;
    if (!m.origPath && p && path.resolve(p).toLowerCase().startsWith(pd.toLowerCase() + path.sep)) { // uploaded on the standby
      const to = P(name, path.resolve(p).slice(pd.length + 1));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (!fs.existsSync(to)) fs.copyFileSync(p, to);
      p = to;
    }
    const it = { ...m, path: p, status: 'queued', proxy: m.kind === 'video' ? 'pending' : 'none' }; delete it.origPath; delete it.lite;
    db.items.push(it); enqueue(name, it.id); added++;
  }
  if (added) saveMedia(name, true);
  return { changed, added };
}
async function pullBack(dest, sb) {
  const L = liveDir(dest), info = readJSON(path.join(L, 'mirror.json'), { projects: {} }), res = { projects: [], added: 0 };
  for (const folder of fs.existsSync(path.join(L, 'Projects')) ? fs.readdirSync(path.join(L, 'Projects')) : []) {
    const pd = path.join(L, 'Projects', folder), pf = path.join(pd, 'project.json');
    if (!fs.existsSync(pf) || fs.statSync(pf).mtimeMs < (sb.since || 0) - 1000) continue; // (not changed on the standby)
    const name = info.projects?.[folder]?.name || folder;
    if (!allProjects().includes(name)) { // made on the standby: comes in as a project of its own
      const to = path.join(PROJECTS, safeName(name));
      await restoreProject({ dest, night: 'live', folder, to });
      ensureProjectDirs(name); mediaCache.delete(name);
      for (const m of mediaDb(name).items) if (m.status === 'queued') enqueue(name, m.id);
      await handOver(name);
      res.projects.push(`${name} (new)`); continue;
    }
    const r = CLUSTER && !IS_WORKER ? await askWorker(ownerOf(name), 'pull', name, 60000, { dir: pd }) : pullProject(name, pd);
    res.added += r.added || 0;
    if (r.changed || r.added) res.projects.push(name);
  }
  writeStandby(dest, { ...sb, state: 'pulled', pulledAt: Date.now(), result: res });
  safetyRun.mirrored.clear(); // (the mirror is renewed from this editor next)
  safetyRun.pull = { at: Date.now(), host: sb.host, ...res };
  console.log(`🖥 Edits from the standby PC ${sb.host} brought back: ${res.projects.join(', ') || 'none'}${res.added ? ` (${res.added} new files)` : ''}`);
  return res;
}
async function standbyTick() {
  const s = safetyCfg();
  if (STANDBY || !s.dest) { standbyHold = null; return; }
  const sb = standbyState(s.dest);
  if (!sb || sb.state === 'pulled') { standbyHold = null; return; }
  if (sb.state === 'active' && Date.now() - (sb.beat || 0) < 3 * 60e3) { standbyHold = { host: sb.host, since: sb.since }; return; }
  // handed back (or it stopped without saying so - what it saved is in the mirror): bring its edits in
  standbyHold = { host: sb.host, since: sb.since, pending: true };
  try { await pullBack(s.dest, sb); standbyHold = null; } catch (e) { standbyHold.error = e.message; logCrash('standby pull back', e); }
}
if (!process.env.VEDIT_NO_RESUME) {
  setTimeout(() => { standbyTick().then(() => mirrorTick()).catch(() => {}); nightlyBackup().catch(() => {}); }, 60000);
  setInterval(() => nightlyBackup().catch((e) => logCrash('nightly backup', e)), 10 * 60e3).unref?.();
  setInterval(() => mirrorTick().catch((e) => logCrash('live mirror', e)), 5 * 60e3).unref?.();
  setInterval(() => standbyTick().catch((e) => logCrash('standby', e)), 30000).unref?.();
}
// the server-errors.log of the last 24 h: how many, and the latest few
function recentErrors() {
  try {
    const fd = fs.openSync(ERRLOG, 'r'), size = fs.fstatSync(fd).size, n = Math.min(size, 512 * 1024), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
    const since = Date.now() - 864e5, list = [];
    for (const l of buf.toString('utf8').split('\n')) { const m = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] ([^:]+): (.*)$/.exec(l); if (m && Date.parse(m[1]) >= since) list.push({ t: Date.parse(m[1]), kind: m[2], msg: m[3].slice(0, 200) }); }
    return { count: list.length, latest: list.slice(-6).reverse() };
  } catch { return { count: 0, latest: [] }; }
}
// free space where the projects, the editor's data and the backups are (a drive that does not answer in 3 s is left out)
async function diskInfo() {
  const s = safetyCfg(), roots = new Map();
  const add = (p, what) => { if (!p) return; const r = path.parse(path.resolve(p)).root; if (!roots.has(r)) roots.set(r, new Set()); roots.get(r).add(what); };
  add(DATA, 'Editor data'); add(s.dest, 'Backups');
  for (const n of allProjects()) { try { add(projDir(n), 'Projects'); } catch {} }
  const out = [];
  await Promise.all([...roots].map(async ([root, what]) => {
    try {
      const st = await Promise.race([fs.promises.statfs(root), sleep(3000).then(() => { throw new Error('no answer'); })]);
      out.push({ root, what: [...what], free: st.bavail * st.bsize, total: st.blocks * st.bsize });
    } catch (e) { out.push({ root, what: [...what], error: e.message }); }
  }));
  return out.sort((a, b) => a.root.localeCompare(b.root));
}
async function healthView() {
  const s = safetyCfg(), h = healthSeries(), disks = await diskInfo(), errs = recentErrors();
  const st = s.dest ? readJSON(path.join(s.dest, 'status.json'), null) : null, lastOk = (st?.history || []).find((x) => x.ok), last = safetyRun.last || st?.last || null;
  const recent = h.samples.slice(-10), warn = [];
  const W = (level, text) => warn.push({ level, text });
  if (standbyHold) W('bad', standbyHold.pending ? `Edits made on the standby PC ${standbyHold.host} are being brought back${standbyHold.error ? ` - failed: ${standbyHold.error}` : ''}` : `The standby PC ${standbyHold.host} is running the editor (since ${new Date(standbyHold.since).toLocaleString()}) - this one only shows until it hands back`);
  for (const d of disks) {
    if (d.error) { W('warn', `${d.root} (${d.what.join(', ')}) does not answer`); continue; }
    const pct = d.free / d.total, gb = d.free / 1073741824;
    if (pct < 0.05 || gb < 10) W('bad', `${d.root} is almost full: ${gb.toFixed(0)} GB free (${(pct * 100).toFixed(0)}%)`);
    else if (pct < 0.1 || gb < 30) W('warn', `${d.root} is filling up: ${gb.toFixed(0)} GB free (${(pct * 100).toFixed(0)}%)`);
  }
  if (!STANDBY) {
    if (!s.on) W('warn', 'Nightly backup is off');
    else if (last && !last.ok) W('bad', `Last night's backup failed: ${(last.errors || [])[0] || 'see the errors'}`);
    else if (!lastOk || Date.now() - lastOk.at > 30 * 3600e3) W('warn', lastOk ? `No backup since ${new Date(lastOk.at).toLocaleString()}` : 'No backup has been made yet');
    if (s.mirror && safetyRun.mirrorErr) W('bad', `Live mirror for the standby PC failed: ${safetyRun.mirrorErr}`);
  }
  const lagNow = Math.max(0, ...recent.map((x) => x.lag)), p95Now = Math.max(0, ...recent.map((x) => x.p95));
  if (lagNow > 1000) W('bad', `The editor is getting stuck (up to ${(lagNow / 1000).toFixed(1)} s in the last 10 minutes)`); else if (lagNow > 250) W('warn', `The editor is slow to answer at times (${lagNow} ms stalls)`);
  if (p95Now > 3000) W('warn', `Some actions take long (${(p95Now / 1000).toFixed(1)} s)`);
  if (h.now.rss > 6144) W('warn', `The editor uses a lot of memory (${(h.now.rss / 1024).toFixed(1)} GB) - a restart when nobody works frees it`);
  if (errs.count > 50) W('warn', `${errs.count} errors in the last 24 hours`);
  // ⚙ project workers: each one's own stuck time (a project's heavy moment shows in its worker only)
  const wl = await workerStates();
  for (const w of wl) { if (w.down) W('bad', `Project worker ${w.k} does not answer - it is being started again`); else if (w.lag > 1000) W('warn', `Project worker ${w.k} is getting stuck (${w.lag} ms) - ${w.projects.map((x) => x.name).join(', ') || 'its projects'}`); }
  const starts24 = h.starts.filter((t) => t > Date.now() - 864e5).length;
  if (starts24 > 3) W('warn', `The editor started ${starts24} times in the last 24 hours`);
  return { warn, standby: STANDBY, host: os.hostname(), series: h, disks, errors: errs, cluster: { on: WORKERS, want: +config().cluster?.workers || 0, workers: wl.map((w) => ({ ...w, starts: workerProcs.get(w.k)?.starts || 0 })) },
    work: { jobs: [...jobs.values()].filter((j) => j.status === 'running').length, renders: rq.items.filter((x) => ['waiting', 'rendering'].includes(x.state)).length,
      people: [...live.values()].reduce((n, L) => n + L.subs.size, 0), farm: farmWorkers().length },
    backup: { ...s, busy: safetyRun.busy, last, lastOk, history: (st?.history || []).slice(0, 14), mirrorAt: safetyRun.mirrorAt, mirrorErr: safetyRun.mirrorErr, pull: safetyRun.pull,
      hold: standbyHold, standbyFile: s.dest ? standbyState(s.dest) : null, mainLink: teamServer ? `http://${os.hostname()}:${TEAM_PORT}` : null } };
}

// ---------------- versions ----------------
// Auto backups (backups/project_<time>.json, every 5 min while editing, last 40) and named versions you save yourself
// (backups/named/<time> <name>.json, kept until you delete them). A short summary of each for the Versions list.
function versionInfo(name, file, named) {
  const pj = readJSON(file, null), st = fs.statSync(file);
  if (!pj) return null;
  const items = Object.fromEntries(mediaDb(name).items.map((m) => [m.id, m]));
  const seqs = 1 + Object.keys(pj.sequences || {}).length;
  let dur = 0; try { dur = Math.max(0, ...Object.values(placed(pj, items)).flat().map((x) => x.end)); } catch {}
  const label = named ? path.parse(file).name.replace(/^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d ?/, '') : /^daily_/.test(path.basename(file)) ? '📅 End of that day' : '';
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
        return send(res, 200, allProjects().map((n) => ({
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

// ---------------- 🔗 client review links (internet) ----------------
// "Send for review" on a finished render makes a secret link <team door>/review/<token> (https://<domain>/review/… once
// the domain works). No team sign-in: the link shows only its own render(s) and their comments - never project data or
// other files. The client comments at moments, replies, and approves or asks for changes per version; each comment also
// lands in <project>/review-notes.json, which the editor takes onto its timeline like phone notes. The links live in
// client-reviews.json next to the projects (engine/clientreview.mjs); only the main process keeps them.
const reviews = IS_WORKER ? null : new ReviewStore(path.join(DATA, 'client-reviews.json'));
const rvLimit = new Limiter(), rvNews = []; // (rvNews: the last client comments / decisions, for the editor's toast)
const REVIEW_DIR = path.join(ROOT, 'public', 'review'), REVIEW_ASSETS = new Set(['client.js', 'client.css']);
const RV_HEADERS = { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' };
const reviewUrl = (l) => `${permaLink()}review/${l.token}`;
function reviewToProject(l, v, note, by, t, id) {
  try {
    const f = reviewNotesFile(l.project), list = readJSON(f, []);
    list.push({ id, t, note, by, render: v.render, at: Date.now(), client: true, review: l.id, version: v.n });
    writeJSON(f, list);
  } catch (e) { logCrash('client review note', e); }
  rvNews.push({ at: Date.now(), project: l.project, title: l.title, link: l.id, by, note: note.slice(0, 140) }); rvNews.splice(0, rvNews.length - 100);
}
async function clientReview(req, res, u) {
  const out = (code, body, type = 'application/json', more = {}) => { res.writeHead(code, { ...RV_HEADERS, 'Content-Type': type, ...more }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  const body = async (max) => { try { return JSON.parse((await readLimited(req, max)) || '{}'); } catch (e) { throw e.code === 413 ? e : err(400, 'Bad request'); } };
  try {
    const a = /^\/review\/_\/([a-z]+\.(?:js|css))$/.exec(u.pathname);
    if (a) return REVIEW_ASSETS.has(a[1]) && req.method === 'GET' ? out(200, fs.readFileSync(path.join(REVIEW_DIR, a[1])), MIME[path.extname(a[1])]) : out(404, 'Not found', 'text/plain');
    const m = /^\/review\/([^/]+)(\/.*)?$/.exec(u.pathname), l = m && reviews ? findLink(reviews.links, m[1]) : null;
    if (!l) { await sleep(300); return out(404, 'This review link does not exist.', 'text/plain; charset=utf-8'); }
    const sub = m[2] || '/', ip = ipOf(req), get = req.method === 'GET' || req.method === 'HEAD', post = req.method === 'POST';
    if (get && sub === '/') return out(200, fs.readFileSync(path.join(REVIEW_DIR, 'client.html')), 'text/html; charset=utf-8');
    if (expired(l)) return out(410, { error: l.off ? 'This review link was turned off.' : 'This review link has expired - ask for a new one.' });
    if (post && sub === '/api/unlock') {
      if (!rvLimit.hit(`pw:${ip}`, 8, 10 * 60e3)) return out(429, { error: 'Too many tries - wait a few minutes' });
      const b = await body(2048);
      if (!pwOk(String(b.password ?? ''), l.pw)) { await sleep(600); return out(401, { error: 'Wrong password' }); }
      return out(200, { ok: true }, 'application/json', { 'Set-Cookie': `rv_${l.id}=${pwCookie(reviews.secret, l)}; HttpOnly; SameSite=Strict; Path=/review/${l.token}; Max-Age=2592000${req.socket.encrypted ? '; Secure' : ''}` });
    }
    if (l.pw && !sameSecret(cookieOf(req, `rv_${l.id}`) || '', pwCookie(reviews.secret, l))) return out(401, { needPw: true, title: l.title });
    if (get && sub === '/api/info') return out(200, clientView(l));
    const mv = /^\/v\/(\d{1,4})$/.exec(sub);
    if (get && mv) { // the render, by its stored name only
      const v = l.versions.find((x) => x.n === +mv[1]), f = v && renderPath(P(l.project, 'renders'), v.render);
      return f ? serveFile(req, res, f) : out(404, { error: 'This version is not there any more' });
    }
    if (post && sub === '/api/comment') {
      if (!rvLimit.hit(`c:${l.id}:${ip}`, 40, 10 * 60e3) || !rvLimit.hit(`c:${l.id}`, 150, 10 * 60e3)) return out(429, { error: 'Too many comments in a short time - wait a few minutes' });
      if (l.comments.length >= MAX_COMMENTS) return out(409, { error: 'This link has too many comments - ask for a new one' });
      const b = await body(), text = cleanText(b.text), by = cleanName(b.by) || l.client || 'Client';
      if (!text) return out(400, { error: 'Write a comment first' });
      const parent = (b.parent && l.comments.find((c) => c.id === b.parent && !c.parent)) || null;
      const v = l.versions.find((x) => x.n === (parent ? parent.v : +b.v)) || latest(l);
      const c = { id: newId(), v: v.n, t: parent ? parent.t : Math.round(Math.min(36000, Math.max(0, +b.t || 0)) * 1000) / 1000, text, by, at: Date.now(), parent: parent?.id || null, draw: parent ? null : cleanDraw(b.draw) };
      l.comments.push(c); reviews.save();
      reviewToProject(l, v, `${parent ? '↪ ' : ''}${text}${c.draw ? ' ✏️' : ''}`, by, c.t, c.id);
      return out(200, c);
    }
    if (post && sub === '/api/decide') {
      if (!rvLimit.hit(`d:${l.id}:${ip}`, 12, 10 * 60e3)) return out(429, { error: 'Too many tries - wait a few minutes' });
      const b = await body(), v = l.versions.find((x) => x.n === +b.v), ok = b.decision === 'approve', by = cleanName(b.by) || l.client || 'Client', text = cleanText(b.text);
      if (!v || !['approve', 'changes'].includes(b.decision)) return out(400, { error: 'Bad request' });
      Object.assign(v, { status: ok ? 'approved' : 'changes', decidedBy: by, decidedAt: Date.now() });
      const c = { id: newId(), v: v.n, t: 0, text: `${ok ? '✅ Approved' : '✏️ Changes requested'}${text ? `: ${text}` : ''}`, by, at: Date.now(), parent: null, draw: null };
      l.comments.push(c); reviews.save();
      reviewToProject(l, v, `${c.text} (Version ${v.n})`, by, 0, c.id);
      return out(200, clientView(l));
    }
    out(404, { error: 'not found' });
  } catch (e) { if (!res.headersSent) out(e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.code >= 400 && e.code < 600 ? e.message : 'Something went wrong' }); }
}

// ---------------- 🧠 smart footage ----------------
// engine/footage.py (pictures) and people.py (faces + text) stay running (the model loads once, then searches are
// instant) and stop themselves after 10 idle minutes. One request at a time: { req, onProgress, ok, bad }.
const pyWorkers = {};
const footageWorker = () => pyWorker('footage.py', 'The picture model');
const peopleWorker = () => pyWorker('people.py', 'The face and text reader');
function pyWorker(script, what) {
  if (pyWorkers[script]) { clearTimeout(pyWorkers[script].idle); return pyWorkers[script]; }
  const p = spawn(PYTHON, [path.join(ROOT, 'engine', script)], { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  p.stdout.setEncoding('utf8'); // (a Hindi letter split between two chunks must not turn into junk)
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
  const fail = (e) => { for (const c of [w.cur, ...w.waiting].filter(Boolean)) c.bad(new Error(`${what} stopped: ${e || w.err.trim().split(/\r?\n/).pop() || 'unknown error'}`)); if (pyWorkers[script] === w) delete pyWorkers[script]; };
  p.on('error', (e) => fail(String(e)));
  p.on('close', () => fail());
  pyWorkers[script] = w;
  return w;
}
// 🧑✍ engine/people.py on the given clips (the preview copy when there is one - the same file each time, so its cache
// holds): faces grouped into people (named ones from Library/people), text read off the pictures. Writes
// cache/people.json ({ at, people, text: { id: [{ t, text }] } }) and m.people (keys) / m.ocr (the words) in media.json.
async function lookAtPeople(name, items, onProgress) {
  const crops = P(name, 'cache', 'people');
  fs.rmSync(crops, { recursive: true, force: true }); // (old face pictures: their numbers are given out again)
  const src = (m) => { const px = P(name, 'cache', 'proxies', `${m.id}.mp4`); return m.proxy === 'ready' && fs.existsSync(px) ? px : m.path; };
  const r = await peopleWorker().send({ cmd: 'look', cacheDir: P(name, 'cache', 'agent', 'people'), cropDir: crops, faces: true, ocr: !!healthCache?.ocr,
    det: FACE_MODELS[0], rec: FACE_MODELS[1], library: loadLibrary(ROOT),
    media: items.map((m) => { const txt = (m.tags || []).includes('text'); return { id: m.id, file: src(m), duration: m.duration || 0, image: m.kind === 'image', ocr: txt ? 6 : 2, rotate: txt }; }) }, onProgress);
  const d = { at: Date.now(), people: r.people.map((p) => ({ ...p, thumb: p.thumb ? path.basename(p.thumb) : null })), text: r.text || {} };
  writeJSON(P(name, 'cache', 'people.json'), d);
  peopleToMedia(name, d, new Set(items.map((m) => m.id)));
  return d;
}
// m.people / m.ocr of the clips that were looked at (shown in Media, searched by name)
function peopleToMedia(name, d, ids) {
  const byMedia = {};
  for (const p of d.people) for (const id of Object.keys(p.media)) (byMedia[id] ||= []).push(p.key);
  for (const m of mediaDb(name).items) {
    if (!ids.has(m.id)) continue;
    if (byMedia[m.id]) m.people = byMedia[m.id]; else delete m.people;
    const words = [...new Set((d.text[m.id] || []).map((x) => x.text))].join(' · ').slice(0, 400);
    if (words) m.ocr = words; else delete m.ocr;
  }
  saveMedia(name, true);
}
// change cache/people.json (name / join / remove) and keep media.json in step
function editPeople(name, fn) {
  const f = P(name, 'cache', 'people.json'), d = readJSON(f, null);
  if (!d) throw err(400, 'Run 🧠 Smart scan first - it finds the people in the footage');
  const out = fn(d);
  writeJSON(f, d);
  peopleToMedia(name, d, new Set(mediaDb(name).items.filter((m) => m.people || d.text[m.id] || d.people.some((p) => p.media[m.id])).map((m) => m.id)));
  const { emb, ...rest } = out || {};
  return rest;
}
function mergeInto(d, keep, rest) {
  let n = keep.count;
  const emb = keep.emb ? keep.emb.map((v) => v * keep.count) : null;
  for (const x of rest) {
    for (const [id, ts] of Object.entries(x.media)) keep.media[id] = [...new Set([...(keep.media[id] || []), ...ts])].sort((a, b) => a - b);
    if (emb && x.emb) x.emb.forEach((v, i) => { emb[i] += v * x.count; });
    n += x.count;
  }
  if (emb) { const len = Math.hypot(...emb) || 1; keep.emb = emb.map((v) => +(v / len).toFixed(5)); }
  keep.count = n;
  d.people = d.people.filter((x) => !rest.includes(x));
}
// 💬 Claude reads numbered transcript lines and answers with line numbers (from..to), so every quote starts and ends
// exactly where the words do. The transcript goes in on stdin (too long for a command line).
async function claudeQuotes(exe, lines, n, brief) {
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  let body = '', prev = null;
  for (const [i, l] of lines.entries()) {
    if (l.id !== prev) { body += `\n## clip ${l.id}\n`; prev = l.id; }
    body += `L${i} [${mmss(l.start)}] ${l.text}\n`;
    if (body.length > 150000) break; // (very long footage: the start is enough to find good lines)
  }
  const ask = `You pick soundbites for a video edit (Indian government / documentary / event films, Hindi or English).
${brief ? `The edit is about: ${brief}\n` : ''}Below are transcript lines, numbered L0, L1, ... grouped by clip. Pick the ${n} best quotes: complete thoughts that make sense on their own,
5-30 seconds, strong, emotional or informative, no filler or half sentences, and from different clips / speakers where possible.
A quote is one line or several consecutive lines of the same clip. Answer with JSON only, best first:
{"quotes":[{"from":<first line number>,"to":<last line number>,"why":"<a few words, in the quote's language>"}]}
${body}`;
  const out = await new Promise((ok, bad) => {
    const p = spawn(exe, ['-p', 'Do what the input asks. Reply with the JSON only.', '--output-format', 'json', '--model', 'sonnet', '--max-turns', '1'], { cwd: os.tmpdir(), windowsHide: true });
    let so = '', se = '';
    const timer = setTimeout(() => { p.kill(); bad(new Error('no answer in 4 minutes')); }, 240000);
    p.stdout.on('data', (d) => { so += d; }); p.stderr.on('data', (d) => { se += d; });
    p.on('error', (e) => { clearTimeout(timer); bad(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? ok(so) : bad(new Error(String(se || so).trim().slice(0, 200) || `stopped (${code})`)); });
    p.stdin.end(ask);
  });
  const res = JSON.parse(out);
  if (res.is_error) throw new Error(String(res.result || 'error').slice(0, 200));
  const picks = JSON.parse(/\{[\s\S]*\}/.exec(String(res.result || ''))?.[0] || '{}').quotes || [];
  const quotes = [];
  for (const q0 of picks) {
    let a = Math.round(+q0.from), z = Math.round(+q0.to);
    if (!(a >= 0 && a < lines.length)) continue;
    if (!(z >= a && z < lines.length)) z = a;
    while (z > a && lines[z].id !== lines[a].id) z--;
    const part = lines.slice(a, z + 1);
    quotes.push({ mediaId: lines[a].id, start: +part[0].start.toFixed(2), end: +part.at(-1).end.toFixed(2), text: part.map((l) => l.text).join(' '), why: String(q0.why || '').slice(0, 120) });
  }
  if (!quotes.length) throw new Error('it picked no lines');
  return quotes.slice(0, n);
}
// 💬 without Claude: runs of lines of one clip, 5-30 s, that end a sentence, with enough words and few filler words
function ruleQuotes(lines, n) {
  const FILL = /^(and|so|but|um+|uh+|aur|to|toh|ki|ki ye|matlab|haan|ha|ji|ok|okay)\b/i;
  const c = [];
  for (let i = 0; i < lines.length; i++) {
    let text = '';
    for (let k = i; k < lines.length && lines[k].id === lines[i].id; k++) {
      text += `${text ? ' ' : ''}${lines[k].text}`;
      const dur = lines[k].end - lines[i].start, words = text.split(/\s+/).length;
      if (dur > 30) break;
      if (dur < 5) continue;
      let s = Math.min(words, 60) / 60 + (/[.!?।]$/.test(lines[k].text) ? 0.5 : 0) - (FILL.test(lines[i].text) ? 0.4 : 0) + (/\d/.test(text) ? 0.1 : 0) - Math.abs(dur - 14) / 40;
      c.push({ mediaId: lines[i].id, start: +lines[i].start.toFixed(2), end: +lines[k].end.toFixed(2), text, why: '', s });
    }
  }
  const out = [];
  for (const q0 of c.sort((a, b) => b.s - a.s)) {
    if (out.some((o) => o.mediaId === q0.mediaId && q0.start < o.end && q0.end > o.start)) continue;
    const { s, ...rest } = q0; out.push(rest);
    if (out.length >= n) break;
  }
  return out;
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
    const file = P(it.project, 'renders', path.basename(it.render)), thumb = it.thumbnail ? P(it.project, 'output', 'thumbnails', path.basename(it.thumbnail)) : null;
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
if (!IS_WORKER) { setInterval(pumpPublish, 20000); setTimeout(pumpPublish, 6000); } // (⚙ main process only)
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
    const { jobFile, out } = prepareRender(name, { project: pj, preset: o.preset || 'whatsapp', filename: path.parse(m.name).name, aspect, whole: true }, { write: false, jobFile: P(name, 'cache', 'queue', `batch-${it.id}.json`) });
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
if (!IS_WORKER) { setInterval(pumpBatch, 15000); setTimeout(pumpBatch, 5000); } // (⚙ main process only)
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
  for (const name of allProjects()) {
    const f = autoFile(name);
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
// 🔑 signed-in team members: kept in team-sessions.json next to the projects, so a restart of the editor (or of a project
// worker) never signs everyone out. Stored by a hash of the cookie - the cookie itself is never written down; 30 days,
// like the cookie. sessKey(cookie) is the key.
const SESS_FILE = path.join(DATA, 'team-sessions.json'), SESS_MS = 30 * 864e5;
const sessKey = (tok) => (tok ? crypto.createHash('sha256').update(String(tok)).digest('hex') : '-');
class SavedSessions extends Map {
  load() { const o = readJSON(SESS_FILE, {}); for (const [k, s] of Object.entries(o)) if (s && Date.now() - (s.at || 0) < SESS_MS) super.set(k, s); return this; }
  save() { clearTimeout(this.t); this.t = setTimeout(() => { try { writeJSON(SESS_FILE, Object.fromEntries(this)); } catch (e) { logCrash('team sessions', e); } }, 300); }
  set(k, v) { super.set(k, v); if (this.ready) this.save(); return this; }
  delete(k) { const r = super.delete(k); if (r) this.save(); return r; }
  clear() { super.clear(); this.save(); }
}
const sessions = IS_WORKER ? new Map() : new SavedSessions().load(); // hash of the cookie -> { name, role, at }
sessions.ready = true;
// Every signed-in editor may do everything; only the team itself stays the owner's: who may sign in (users and
// passwords), the sign-in / sessions tracking and the team settings (/api/team…). Viewers still only watch.
// (🧠 Claude is open to editors too, with its reading kept to the projects - see claudeRun)
const OWNER_ONLY = [/^\/api\/team(\/|$)/, /^\/api\/safety(\/|$)/]; // (🛟 backups and restores: the owner's)
function allowed(who, method, p) {
  if (who.role === 'owner') return true;
  if (/^\/api\/(me|lock|unlock|clientlog)$/.test(p)) return true;
  // (reading the settings only tells whether keys are set; the publish list and accounts show no tokens)
  if (OWNER_ONLY.some((r) => r.test(p))) return method === 'GET' && p === '/api/team/shortcut'; // (the shortcut is only a link)
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
    if (u.pathname.startsWith('/review/')) return clientReview(req, res, u); // 🔗 client review links: no sign-in, only that link's render
    if (u.pathname === '/team/login' && req.method === 'POST') {
      const b = await readJson(req).catch(() => ({})), t = teamCfg(), usr = (t.users || []).find((x) => x.name.toLowerCase() === String(b.name || '').trim().toLowerCase());
      if (!usr || hashPw(b.password || '', usr.salt) !== usr.hash) { await sleep(600); return send(res, 401, { error: 'Wrong name or password' }); }
      const tok = crypto.randomBytes(24).toString('hex');
      sessions.set(sessKey(tok), { name: usr.name, role: usr.role, at: Date.now() });
      (presence.logins ||= []).push({ t: Date.now(), name: usr.name, ip: ipOf(req) }); savePresence(); // 📊 sign-ins, for the Sessions view
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `ve_sess=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
      return res.end(JSON.stringify({ ok: true, name: usr.name, role: usr.role }));
    }
    // 🔗 a Desktop shortcut to the editor for this PC (offered on the sign-in page; no sign-in needed - it is only the link)
    if (u.pathname === '/team/shortcut.url') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Limelight Editor.url"' });
      return res.end(shortcutFile());
    }
    // 🖥 the standby PC asks this every 15 s whether the editor is up (engine/standby.mjs) - no sign-in, says nothing else
    if (u.pathname === '/team/ping') return send(res, 200, { ok: true });
    if (u.pathname === '/team/logout') { sessions.delete(sessKey(cookieOf(req, 've_sess'))); res.writeHead(302, { 'Set-Cookie': 've_sess=; Path=/; Max-Age=0', Location: '/' }); return res.end(); }
    const s = sessions.get(sessKey(cookieOf(req, 've_sess')));
    // a user removed (or demoted) by the owner loses access at once
    const usr = s && (teamCfg().users || []).find((x) => x.name === s.name);
    if (!s || !usr) {
      if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/pm/') || u.pathname.startsWith('/pf/')) return send(res, 401, { error: 'Sign in again' });
      if (/^\/(css|js|img)\//.test(u.pathname)) return serveFile(req, res, path.join(ROOT, 'public', path.normalize(decodeURIComponent(u.pathname)))); // (img: the logo on the sign-in page)
      if (/^\/(manifest\.webmanifest|sw\.js)$/.test(u.pathname)) return serveFile(req, res, path.join(ROOT, 'public', u.pathname.slice(1))); // (🖥 install as a Desktop app, from the sign-in page)
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
if (!IS_WORKER) { setInterval(checkDomain, 5 * 60 * 1000).unref?.(); setTimeout(checkDomain, 2000); }
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
  // (newer app versions keep it in Local\Claude-Data\claude_<package>\claude-code - updated together with the app)
  const dataDirs = (() => { try { return fs.readdirSync(path.join(local, 'Claude-Data')).filter((d) => /^claude/i.test(d)).map((d) => path.join(local, 'Claude-Data', d, 'claude-code')); } catch { return []; } })();
  for (const base of [...dataDirs, path.join(process.env.APPDATA || '', 'Claude', 'claude-code'), ...pkgs.map((d) => path.join(local, 'Packages', d, 'LocalCache', 'Roaming', 'Claude', 'claude-code'))]) try {
    const vers = fs.readdirSync(base).filter((v) => /^\d/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of vers) for (const h of fs.readdirSync(path.join(base, v))) { const f = path.join(base, v, h, process.platform === 'win32' ? 'claude.exe' : 'claude'); if (fs.existsSync(f)) return f; }
  } catch {}
  // Claude Code's own installer (~/.local/bin) and npm - an update of the Claude app once moved its copy away and every
  // PC lost the Assistant's Claude; these are looked at too (the server runs from the tray, whose PATH may not have them)
  const home = process.env.USERPROFILE || process.env.HOME || '';
  for (const f of [path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'), path.join(local, 'Programs', 'claude', 'claude.exe')])
    if (f && fs.existsSync(f)) return f;
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
// 🎞 every sequence has its own Claude conversation, so people on different sequences each talk to their own Claude
// (the team's main sequence keeps the old session.json)
const claudeSeq = (name, seq) => { const s = String(seq || ''); return s && /^[\w-]{1,80}$/.test(s) && s !== seqOf(liveOf(name).pj).id ? s : ''; };
const claudeSession = (name, seq) => P(name, 'cache', 'claude', seq ? `session-${seq}.json` : 'session.json');
function claudeChat(name, message, reset, who = null, seq = '') {
  const exe = claudeExe();
  if (!exe) throw err(400, 'Claude Code is not installed on this computer');
  const sfile = claudeSession(name, seq);
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
    try { return await claudeRun(exe, name, sfile, String(message), model, job, ev, seq); }
    catch (e) {
      // the main model's limit ran out (now or partway): the same conversation goes on with the backup model
      if (model === backup || job.stopped || !limitHit(e.message)) throw e;
      model = backup;
      ev({ k: 'wait', text: `Opus limit reached - carrying on with ${backup}…` });
      return claudeRun(exe, name, sfile, readJSON(sfile, {}).id ? 'Your usage limit stopped you partway through. Carry on from where you stopped and finish the task I gave you.' : String(message), model, job, ev, seq);
    }
  }, { project: name, seq, events: [] });
}
function claudeRun(exe, name, sfile, message, model, job, ev, seq = '') {
  const sid = readJSON(sfile, {}).id || null;
  const args = ['-p', message, '--output-format', 'stream-json', '--verbose', '--append-system-prompt-file', path.join(ROOT, 'engine', 'claude-guide.md'),
    '--allowedTools', (job.tools || CLAUDE_TOOLS).join(','), '--permission-mode', 'default', ...(sid ? ['--resume', sid] : []), '--model', model];
  return new Promise((ok, bad) => {
    const p = spawn(exe, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, VEDIT_PROJECT: name, VEDIT_SEQ: seq, VEDIT_PORT: String(PORT), VEDIT_NO_SNAP: '1', PYTHONIOENCODING: 'utf-8' } });
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

// 🌐 caption lines through Claude (POST /api/captions/translate): one turn, no tools, the prompt on stdin. The reply
// must be a JSON array of the same length (asked again once if not); a used-up limit moves on to the next model.
async function translateBatch(exe, texts, to, from, job) {
  const models = [...new Set([String(config().translateModel || 'sonnet'), CLAUDE_BACKUP(), 'haiku'])];
  let why = '';
  for (const model of models) {
    for (let tryNo = 0; tryNo < 2; tryNo++) {
      if (job.stopped) throw new Error('Stopped');
      const r = await claudeAsk(exe, translatePrompt(texts, to, from), model, job);
      if (!r.ok) { why = r.text; if (!LIMIT_RE.test(why)) throw new Error(why); break; }
      const got = parseTranslation(r.text, texts.length);
      if (got) return got;
      why = 'Claude gave back a different number of lines - try again';
    }
  }
  throw new Error(why || 'Claude could not translate');
}
function claudeAsk(exe, prompt, model, job) {
  return new Promise((ok) => {
    const p = spawn(exe, ['-p', '--output-format', 'json', '--max-turns', '1', '--model', model], { cwd: os.tmpdir(), windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    Object.defineProperty(job, 'proc', { value: p, writable: true, configurable: true, enumerable: false }); // (Stop can kill it; not sent with the job)
    let out = '', e = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (e = (e + d).slice(-2000)));
    p.on('error', (x) => ok({ ok: false, text: String(x?.message || x) }));
    p.on('close', (code) => {
      let j = {}; try { j = JSON.parse(out); } catch {}
      ok(code === 0 && !j.is_error && j.result ? { ok: true, text: j.result } : { ok: false, text: String(j.result || e.trim().split(/\r?\n/).pop() || `Claude stopped (code ${code})`) });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(prompt, 'utf8');
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
  // ⚙ kept by another process (its worker): a look at the saved file, never written from here (liveWrite skips it)
  if (!owns(name)) return { rev: 0, pj: normalizeProject(readJSON(f)), mtime: mt, log: [], subs: new Map(), timer: null, colorN: 0, view: true };
  let L = live.get(name);
  if (!L) { L = { rev: 1, pj: normalizeProject(readJSON(f)), mtime: mt, log: [], subs: new Map(), timer: null, colorN: 0 }; live.set(name, L); return L; }
  if (mt !== L.mtime) {
    // written by something else: that version wins, and every open editor switches to it
    clearTimeout(L.timer); L.timer = null;
    L.pj = normalizeProject(readJSON(f)); L.mtime = mt; L.rev++; L.log = [];
    liveSend(L, { type: 'reset', rev: L.rev, project: L.pj });
  }
  return L;
}
function liveSend(L, msg, only = null) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const [c, sub] of L.subs) if (!only || only === c) { try { sub.res.write(data); } catch {} }
}
function liveWrite(name, L, now = false) {
  if (L.view) { logCrash('live save', `${name}: not written here - its project worker keeps it`); return; }
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
// the request comes from this computer itself - also through the team link (the PC's own LAN address). One that came
// through a tunnel / proxy (cloudflared on this PC also connects from 127.0.0.1) says where it really came from.
function samePC(req) {
  if (req.who?.local) return true;
  const fwd = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = (fwd || ipOf(req)).replace(/^::ffff:/, '');
  return ip === '::1' || (!fwd && ip.startsWith('127.')) || lanIps().includes(ip);
}
// L:\Day 4\a.mp4 -> \\Limeligt\Limelight NAS\Day 4\a.mp4: a mapped drive as its network path (net use), so another PC
// with other drive letters (or none) can open it. Read once a minute at most.
let netUse = { at: 0, map: {} };
function toUnc(p) {
  const d = /^([a-z]):[\\/]/i.exec(p || '')?.[1]?.toUpperCase();
  if (!d || process.platform !== 'win32') return p || '';
  if (Date.now() - netUse.at > 60e3) {
    const map = {};
    const r = spawnSync('net', ['use'], { encoding: 'utf8', windowsHide: true });
    for (const l of String(r.stdout || '').split(/\r?\n/)) { const m = /^\S*\s+([A-Z]):\s+(\\\\.+?)(?:\s{2,}\S.*)?\s*$/.exec(l); if (m) map[m[1]] = m[2].trim(); }
    netUse = { at: Date.now(), map };
  }
  return netUse.map[d] ? netUse.map[d] + p.slice(2) : p;
}
const whoLabel = (who) => (who.local ? `${who.name} (this PC)` : who.name);

// 🧬 voice-over in the voice of a recording (Phase 22, like ElevenLabs voice cloning): up to 15 s of b.refMediaId (from
// b.refIn) is the voice; the script is spoken sentence by sentence (a blank line = a longer pause) and joined, with
// subtitles timed per sentence. lang: 'hi' for Devanagari scripts, else 'en'.
function cloneVoiceOver(name, b, lang) {
  const m = mediaItem(name, b.refMediaId);
  if (!m || !(m.hasAudio || m.kind === 'audio')) throw err(400, 'Pick the recording whose voice should speak');
  if (!aiVoiceReady()) throw err(400, 'Same-voice AI is not set up yet - press "Set up same-voice AI" on the Labs page first');
  // sentences (। . ! ?), long ones cut at commas; paragraphs remember the pause after them
  const chunks = [];
  for (const para of String(b.text).replace(/\*+/g, '').split(/\n\s*\n/)) {
    const ss = para.replace(/\s+/g, ' ').trim().split(/(?<=[।॥.!?])\s+/).filter(Boolean);
    for (const s of ss) {
      // (short pieces: the voice model wanders off - made-up words - more often on long ones)
      if (s.length <= 150) { chunks.push({ text: s, gap: 0.3 }); continue; }
      let cur = '';
      for (const w of s.split(/(?<=[,،;])\s+|\s+(?=(?:और|तथा|लेकिन|क्योंकि|जिससे|and|but|which)\s)/)) { if (cur && (cur + w).length > 150) { chunks.push({ text: cur.trim(), gap: 0.12 }); cur = ''; } cur += `${w} `; }
      if (cur.trim()) chunks.push({ text: cur.trim(), gap: 0.3 });
    }
    if (chunks.length) chunks[chunks.length - 1].gap = 0.75;
  }
  if (!chunks.length) throw err(400, 'Write the voice-over text first');
  return startTask('tts', async (job) => {
    const wd = fs.mkdtempSync(P(name, 'cache', 'vo-'));
    try {
      job.stage = 'Listening to the voice…'; job.progress = 2;
      const ref = path.join(wd, 'voice.wav');
      const rr = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, +b.refIn || 0)), '-i', m.path, '-vn', '-af', 'silenceremove=start_periods=1:start_threshold=-40dB', '-t', '15', '-ac', '1', '-ar', '24000', ref]);
      if (rr.code !== 0) throw new Error(`Could not take the voice sample: ${rr.stderr.slice(-200)}`);
      const files = chunks.map((_, k) => path.join(wd, `s${k}.wav`)), jf = path.join(wd, 'clone.json');
      writeJSON(jf, { ref, lang, lines: chunks.map((c, k) => ({ text: c.text, out: files[k] })) });
      const r = await run(AIVOICE_PY, [path.join(ROOT, 'engine', 'voiceclone.py'), jf], { onLine: (x) => { const p = /^PROGRESS (\d+) (.*)/.exec(x); if (p) { job.progress = Math.round(+p[1] * 0.9); job.stage = `Speaking ${p[2]}…`; } } });
      const res = (() => { try { return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch { return { error: r.stderr.slice(-300) || 'the voice model stopped' }; } })();
      if (res.error) throw new Error(`Voice AI: ${res.error}`);
      // joined with the pauses; subtitles from where each sentence lands
      const durs = [];
      for (const f of files) durs.push(+(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).stdout || 0);
      const g = files.map((_, k) => `[${k}:a]aresample=48000,aformat=channel_layouts=stereo,apad=pad_dur=${chunks[k].gap}[a${k}]`);
      g.push(`${files.map((_, k) => `[a${k}]`).join('')}concat=n=${files.length}:v=0:a=1[out]`);
      const base = safeName(`AI VO ${m.name.replace(/\.[^.]+$/, '').slice(0, 30)} voice ${localStamp()}`);
      const out = P(name, 'imports', `${base}.mp3`);
      const gf = path.join(wd, 'graph.txt'); fs.writeFileSync(gf, g.join(';'));
      const cr = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...files.flatMap((f) => ['-i', f]), '-/filter_complex', gf, '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '192k', out]);
      if (cr.code !== 0) throw new Error(`Could not join the voice-over: ${cr.stderr.slice(-300)}`);
      let srt = null;
      if (b.subtitles) {
        const tc = (t) => { const ms = Math.round(t * 1000), p = (x, w = 2) => String(x).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
        let t = 0; const cues = [];
        chunks.forEach((c, k) => { cues.push(`${k + 1}\n${tc(t)} --> ${tc(t + durs[k])}\n${c.text}\n`); t += durs[k] + c.gap; });
        srt = P(name, 'subs', `${base}.srt`); fs.writeFileSync(srt, cues.join('\n'), 'utf8');
      }
      const it = addMediaFile(name, out, { bin: 'AI voice-over', imported: true });
      saveMedia(name, true);
      for (let i = 0; i < 40 && it && mediaItem(name, it.id)?.status !== 'ready'; i++) await new Promise((ok) => setTimeout(ok, 300));
      return { mediaId: it?.id, subs: srt ? path.basename(srt) : null, duration: mediaItem(name, it?.id)?.duration ?? durs.reduce((a, d, k) => a + d + chunks[k].gap, 0), sentences: chunks.length };
    } finally { fs.rmSync(wd, { recursive: true, force: true }); }
  }, { project: name });
}

const routes = {
  // 📦 Archive search (Phase 22): engine/archive.mjs
  ...archiveRoutes({ DATA, PROJECTS, config, readJson, err, startTask, footageWorker, extractFrames, toEnglishQuery, serveFile, writeJSON, readJSON }),
  'GET /api/health': () => healthCache || checkHealth(),
  // version handshake: a newer copy started from the .bat asks an older running one to step aside
  // busy: work that a restart would cut off (an agent edit, Claude, a render) - a newer copy starting then leaves this one running
  // 🛟 Mazbooti (owner only): health, the nightly backup, restores and the standby PC
  'GET /api/safety': () => healthView(),
  'POST /api/safety': async (req) => {
    const b = await readJson(req), patch = {};
    if (typeof b.on === 'boolean') patch.on = b.on;
    if (typeof b.mirror === 'boolean') patch.mirror = b.mirror;
    if (Number.isInteger(b.hour) && b.hour >= 0 && b.hour <= 23) patch.hour = b.hour;
    if (+b.keep >= 3 && +b.keep <= 60) patch.keep = Math.round(+b.keep);
    // ⚙ project workers: how many after the next start (0 = off)
    if (Number.isInteger(b.workers) && b.workers >= 0 && b.workers <= 16) { const c = config(); c.cluster = { ...(c.cluster || {}), workers: b.workers }; fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1)); }
    if (typeof b.dest === 'string') {
      const d = b.dest.trim();
      if (!path.isAbsolute(d)) throw err(400, 'Give a full folder path, e.g. Z:\\Limelight Backups');
      const inside = (a, x) => { const r = path.relative(x, a); return !r.startsWith('..') && !path.isAbsolute(r); };
      if (inside(path.resolve(d), PROJECTS) || inside(PROJECTS, path.resolve(d))) throw err(400, 'The backup folder must be outside the Projects folder');
      try { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '.write-test'), 'ok'); fs.rmSync(path.join(d, '.write-test')); } catch (e) { throw err(400, `Cannot write in ${d}: ${e.message}`); }
      patch.dest = d;
    }
    saveSafety(patch);
    if (patch.mirror) setTimeout(() => mirrorTick(true).catch(() => {}), 500); // (the first full mirror starts now)
    return healthView();
  },
  'POST /api/safety/backup': () => {
    if (safetyRun.busy) throw err(409, 'A backup is running already');
    if (!safetyCfg().dest) throw err(400, 'Choose a backup folder first');
    nightlyBackup(true).catch(() => {});
    return { started: true };
  },
  'GET /api/safety/nights': () => { const s = safetyCfg(); return s.dest ? backupNights(s.dest) : []; },
  // a project from a night as a new project "<name> (backup <night>)" - nothing that exists is overwritten
  'POST /api/safety/restore': async (req) => {
    const b = await readJson(req), s = safetyCfg();
    if (!s.dest) throw err(400, 'No backup folder');
    const night = String(b.night || ''), nm = String(b.project || '');
    if (!/^\d{4}-\d\d-\d\d$/.test(night) || !nm) throw err(400, 'Pick a night and a project');
    const name = safeName(`${nm} (backup ${night})`);
    if (allProjects().includes(name)) throw err(409, `"${name}" is there already`);
    await restoreProject({ dest: s.dest, night, folder: safeDir(nm), to: path.join(PROJECTS, name) });
    ensureProjectDirs(name); mediaCache.delete(name);
    for (const m of mediaDb(name).items) if (m.status === 'queued') enqueue(name, m.id);
    await handOver(name);
    return { name };
  },
  // the standby PC's edits: bring them in now (after a failed try), or leave them (this editor's own state stays)
  'POST /api/safety/standby': async (req) => {
    const b = await readJson(req), s = safetyCfg(), sb = s.dest && standbyState(s.dest);
    if (!sb || sb.state === 'pulled') { standbyHold = null; return healthView(); }
    if (sb.state === 'active' && Date.now() - (sb.beat || 0) < 3 * 60e3) throw err(409, `The standby PC ${sb.host} is still running the editor - stop it there first (or wait for it to hand back)`);
    if (b.action === 'dismiss') { writeStandby(s.dest, { ...sb, state: 'pulled', pulledAt: Date.now(), dismissed: true }); standbyHold = null; safetyRun.mirrored.clear(); }
    else await standbyTick();
    return healthView();
  },
  // (⚙ the project workers' jobs count too - a newer editor never replaces one with an edit running in a worker)
  'GET /api/version': async () => ({ build: BUILD, busy: [...jobs.values()].filter((j) => j.status === 'running').length + (rqActive ? 1 : 0) + (await workerStates()).reduce((n, w) => n + (w.jobs?.length || 0), 0) }),
  'POST /api/shutdown': async (req, res) => {
    const busy = [...jobs.values()].filter((j) => j.status === 'running').length + (rqActive ? 1 : 0) + (await workerStates()).reduce((n, w) => n + (w.jobs?.length || 0), 0);
    if (busy) return send(res, 409, { error: `${busy} job(s) running - not closing` });
    send(res, 200, { ok: true }); console.log('A newer version of the editor is starting - closing this one.'); setTimeout(() => process.exit(0), 300); },

  // projects
  'GET /api/projects': () => { const pf = projectFolders(), pl = projectPlaces(); return allProjects()
    .map(projectSummary).filter(Boolean).map((p) => ({ ...p, group: pf.map[p.name] || null, place: pl[p.name] || null })).sort((a, b) => b.modified - a.modified); },
  // 📂 a project folder saved anywhere (another drive, the NAS, a shared PC folder) taken into the list. Body { dir }
  'POST /api/projects/open-folder': async (req) => {
    const dir = path.resolve(String((await readJson(req)).dir || ''));
    folderAllowed(req, dir);
    if (!fs.existsSync(path.join(dir, 'project.json'))) throw err(400, `No project in ${dir} - pick the folder that has project.json in it`);
    const name = safeName(path.basename(dir));
    if (path.resolve(path.join(PROJECTS, name)).toLowerCase() === dir.toLowerCase()) return { name };
    if (fs.existsSync(P(name, 'project.json')) && path.resolve(projDir(name)).toLowerCase() !== dir.toLowerCase()) throw err(409, `A project called "${name}" is already in the list - rename one of the folders first`);
    setPlace(name, dir); mediaCache.delete(name);
    ensureProjectDirs(name);
    return { name };
  },
  // 📁 folders on Home to sort projects into (only a grouping: the project folders on disk stay where they are)
  'GET /api/project-folders': () => projectFolders(),
  'POST /api/project-folders': async (req) => {
    const b = await readJson(req), folders = [], ids = new Set(), map = {};
    for (const f of (Array.isArray(b.folders) ? b.folders : []).slice(0, 300)) {
      const id = String(f?.id || '').replace(/[^\w-]/g, '').slice(0, 40), name = String(f?.name || '').trim().slice(0, 80);
      if (id && name && !ids.has(id)) { ids.add(id); folders.push({ id, name }); }
    }
    for (const [p, id] of Object.entries(b.map || {})) if (ids.has(id) && safeName(p) === p && fs.existsSync(P(p, 'project.json'))) map[p] = id;
    writeJSON(FOLDERS_FILE, { folders, map });
    return { folders, map };
  },
  // 📂 File > Open: a Premiere Pro / Resolve timeline (Final Cut Pro 7 XML) becomes a new project with the same cut -
  // the footage is used where the XML says it is (the NAS), nothing is copied. Body { xml: the file's text, place? }
  // -> { name, clips, missing: [files not found], notes: [what did not come across] }
  'POST /api/projects/open-xml': async (req) => {
    const b = await readJson(req);
    folderAllowed(req, b.place);
    let x; try { x = readXmeml(String(b.xml || '')); } catch (e) { throw err(400, e.message); }
    if (![...x.video, ...x.audio].some((t) => t.length)) throw err(400, 'This XML has an empty timeline');
    const base = safeName(x.name);
    let name = base;
    for (let k = 2; fs.existsSync(P(name, 'project.json')) || fs.existsSync(path.join(PROJECTS, name, 'project.json')); k++) name = `${base} (${k})`;
    createProject({ name, aspect: aspectOf(x.width, x.height), fps: Math.round(x.fps), place: b.place || undefined });
    const missing = new Set(), byPath = new Map();
    const mediaFor = (p) => {
      if (!p) return null;
      const key = path.resolve(p).toLowerCase();
      if (byPath.has(key)) return byPath.get(key);
      let it = null;
      if (!fs.existsSync(p)) missing.add(p);
      else it = addMediaFile(name, p, { bin: 'From XML' }) || mediaDb(name).items.find((m) => m.path.toLowerCase() === key) || null;
      byPath.set(key, it);
      return it;
    };
    const pj = readJSON(P(name, 'project.json')), r3 = (v) => +(+v).toFixed(3);
    const state = () => ({ mute: false, hide: false, lock: false, volume: 1 });
    let clips = 0;
    // V1: the main story in order (gaps where the XML has empty space); V2, V3…: each clip at its place
    x.video.forEach((list, k) => {
      const id = `V${k + 1}`, out = [];
      let at = 0;
      for (const c of list) {
        const m = mediaFor(c.path);
        if (!m || m.kind === 'audio') continue;
        let start = c.start, inS = c.in;
        const speed = (c.out - c.in) / (c.end - c.start);
        // (V1 shots that overlap under a transition: the later one starts where the earlier one ends)
        if (k === 0 && start < at - 0.01) { inS += (at - start) * speed; start = at; if (c.end - start < 0.04) continue; }
        const clip = m.kind === 'image' ? { id: uid(), type: 'image', mediaId: m.id, dur: r3(c.end - start) }
          : { id: uid(), type: 'video', mediaId: m.id, in: r3(inS), out: r3(c.out), mute: true, ...(Math.abs(speed - 1) > 0.01 ? { speed: r3(speed) } : {}) };
        if (!c.enabled) clip.disabled = true;
        if (k === 0) {
          if (start > at + 0.02) out.push({ id: uid(), type: 'title', gap: true, text: '', bg: '#000000', dur: r3(start - at) });
          at = c.end;
        } else clip.start = r3(start);
        out.push(clip); clips++;
      }
      pj.tracks[id] = out; pj.trackState[id] ||= state();
    });
    // the sound: A1, A2, … as in the XML (the pictures above are picture only, so nothing is heard twice)
    x.audio.forEach((list, k) => {
      const id = `A${k + 1}`, out = [];
      for (const c of list) {
        const m = mediaFor(c.path);
        if (!m || m.kind === 'image') continue;
        const speed = (c.out - c.in) / (c.end - c.start);
        out.push({ id: uid(), type: 'audio', mediaId: m.id, start: r3(c.start), in: r3(c.in), out: r3(c.out), volume: 1, ...(Math.abs(speed - 1) > 0.01 ? { speed: r3(speed) } : {}), ...(c.enabled ? {} : { disabled: true }) });
        clips++;
      }
      pj.tracks[id] = out; pj.trackState[id] ||= state();
    });
    writeJSON(P(name, 'project.json'), normalizeProject({ ...pj, modified: Date.now() }));
    saveMedia(name, true); pump(); // (the footage is read in the background: thumbnails, previews)
    await handOver(name); // (⚙ by its project worker)
    return { name, clips, missing: [...missing].slice(0, 50), missingCount: missing.size, notes: x.notes };
  },
  // 🚚 move a project to another folder (an editor's own folder on the NAS): copied there, the copy checked (same files,
  // same bytes), then the old folder removed. Files the project keeps inside itself (imports, voice-overs) are pointed
  // at the new place. Refused while anyone has it open or a render / job of it runs. Body { place } (the parent folder)
  'POST /api/projects/move': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), L = live.get(name);
    await askOwner(name, 'release'); // (⚙ its worker saves and lets go of it - refused while someone has it open)
    if (req.who?.role !== 'owner') throw err(403, 'Only the owner can move projects');
    folderAllowed(req, b.place);
    const people = L ? [...new Set([...L.subs.values()].map((x) => x.who.name))] : [];
    if (people.length) throw err(409, `Open right now by ${people.join(', ')} - ask them to close it first`);
    if (projectBusy(name) || rq.items.some((x) => x.project === name && ['waiting', 'rendering'].includes(x.state))) throw err(409, 'A render or job of this project is running or waiting - wait for it to finish');
    const from = path.resolve(projDir(name)), base = path.resolve(String(b.place || '')), to = path.join(base, name);
    if (!fs.existsSync(base) && fs.existsSync(path.dirname(base))) fs.mkdirSync(base);
    if (!fs.existsSync(base)) throw err(400, `Folder not found: ${base}`);
    if (to.toLowerCase() === from.toLowerCase()) return { name, folder: to, moved: false };
    if (fs.existsSync(to)) throw err(409, `${to} is there already - rename or remove it first`);
    if (L) { clearTimeout(L.timer); L.timer = null; liveWrite(name, L, true); }
    live.delete(name); mediaCache.delete(name);
    return startTask('move', async (job) => {
      job.stage = 'Counting its files…';
      const want = await dirSizeAsync(from);
      job.stage = `Copying ${(want.bytes / 1e9).toFixed(1)} GB to ${base}…`; job.progress = 5;
      try { await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true }); }
      catch (e) { await fs.promises.rm(to, { recursive: true, force: true }).catch(() => {}); throw new Error(`Copy failed (${e.code || e.message}) - the project stays where it was`); }
      job.stage = 'Checking the copy…'; job.progress = 90;
      const got = await dirSizeAsync(to);
      if (got.bytes !== want.bytes || got.files !== want.files) { await fs.promises.rm(to, { recursive: true, force: true }).catch(() => {}); throw new Error(`The copy did not match (${got.files}/${want.files} files) - the project stays where it was`); }
      // its own files (imports, voice-overs, packed footage) now live in the new folder
      const mf = path.join(to, 'media.json'), md = readJSON(mf, null), low = from.toLowerCase() + path.sep;
      if (md) { for (const m of md.items || []) if (m?.path && m.path.toLowerCase().startsWith(low)) m.path = path.join(to, m.path.slice(low.length)); writeJSON(mf, md); }
      if (to.toLowerCase() === path.join(PROJECTS, name).toLowerCase()) setPlace(name, null); else setPlace(name, to);
      mediaCache.delete(name); live.delete(name);
      job.stage = 'Removing the old copy…'; job.progress = 97;
      const dir = from.toLowerCase() + path.sep;
      for (const st of openStreams) if (String(st.file || '').toLowerCase().startsWith(dir)) st.destroy();
      // (Windows: a file still open for a moment - a thumbnail being made, a player - is tried again for a few seconds)
      for (let k = 0; ; k++) {
        try { await fs.promises.rm(from, { recursive: true, force: true }); if (!fs.existsSync(from)) break; } catch (e) { if (k >= 15) { job.log.push(`The old folder could not be removed fully (${e.code}) - delete ${from} by hand`); break; } }
        if (k >= 15) break;
        await new Promise((ok) => setTimeout(ok, 500));
      }
      return { name, folder: to, moved: true, bytes: got.bytes, files: got.files };
    }, { project: name });
  },
  // 🗑 delete a project (owner only): its folder moves to the Recycle Bin next to Projects - it can be brought back -
  // or, with ?permanent=1, is deleted for good. The footage it used is never touched (it lives outside the project).
  // Refused while anyone has it open or a render / job of it is running or waiting.
  'POST /api/projects/delete': async (req, res, u) => {
    const name = needProject(q(u, 'p')), L = live.get(name);
    await askOwner(name, 'release'); // (⚙ its worker saves and lets go of it - refused while someone has it open)
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
        // a project saved on another drive (Z:, D:) cannot be renamed into the Recycle Bin: copied there, then removed
        if (e.code === 'EXDEV') { fs.cpSync(projDir(name), to, { recursive: true }); fs.rmSync(projDir(name), { recursive: true, force: true }); break; }
        if (k < 12 && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { await new Promise((ok) => setTimeout(ok, 400)); continue; }
        throw err(409, `Could not move the project folder (${e.code || e.message}) - a program has one of its files open (a player, Explorer window or another app) - close it and try again`);
      }
    }
    live.delete(name); mediaCache.delete(name); offlineChecked.delete(name);
    if (projectPlaces()[name]) setPlace(name, null); // (brought back from the Recycle Bin it goes into Projects)
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
  'POST /api/projects/restore': async (req, res, u) => {
    const f = binEntry(q(u, 'folder'));
    const base = safeName(String(path.basename(f)).replace(/ \(deleted .*$/, ''));
    let name = base; for (let k = 2; fs.existsSync(path.join(PROJECTS, name)); k++) name = `${base} (restored${k > 2 ? ` ${k - 1}` : ''})`;
    fs.renameSync(f, path.join(PROJECTS, name));
    binLog(req, 'restored', name);
    await handOver(name);
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
    folderAllowed(req, b.place); folderAllowed(req, b.folder);
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
    await handOver(name); // (⚙ its project worker reads the footage)
    return { name, imported, folder: projDir(name) };
  },
  // the live copy when people are editing it (with its revision, for the event stream), else the file
  'GET /api/project': (req, res, u) => { const name = needProject(q(u, 'p')), L = liveOf(name); return { ...L.pj, _rev: L.rev }; },
  // a whole project at once (older tabs, tools): it replaces the live copy, and every open editor gets it
  'PUT /api/project': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const pj = normalizeProject(await readJson(req)); // (🛡 a whole project from the agent, Claude or an older tab: made sound before it is kept)
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
  // ⏸ Frame Hold: one frame of a file (seconds t) as a full-size still in the project (imports/stills), added to Media
  // (folder "Frame holds") - the timeline holds it as a still clip. Body { mediaId, t } -> { mediaId } once it is read.
  'POST /api/media/still': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), m = mediaItem(name, String(b.mediaId || ''));
    if (!m || m.kind !== 'video' || !fs.existsSync(m.path)) throw err(400, 'That clip has no video file here');
    const t = Math.max(0, Math.min((m.duration || 0) - 0.02, +b.t || 0)), dir = P(name, 'imports', 'stills');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${m.id}_${t.toFixed(3).replace('.', '_')}.png`);
    if (!fs.existsSync(out)) {
      const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', t.toFixed(3), '-i', m.path, '-frames:v', '1', '-update', '1', out]);
      if (r.code !== 0 || !fs.existsSync(out)) throw err(500, `Could not take that frame: ${r.stderr.trim().split(/\r?\n/).pop() || 'unknown'}`);
    }
    const it = addMediaFile(name, out, { bin: 'Frame holds', imported: true }) || mediaDb(name).items.find((x) => x.path.toLowerCase() === path.resolve(out).toLowerCase());
    saveMedia(name, true);
    if (activeProject !== name) { activeProject = name; pump(); }
    for (let i = 0; i < 50 && !['ready', 'error'].includes(mediaItem(name, it.id)?.status); i++) await new Promise((ok) => setTimeout(ok, 200));
    return { mediaId: it.id };
  },
  // 🎥 the monitor's stabilised copy of a shot (Warp Stabilizer / Stabilize, like Premiere's "Analyzing in background"):
  // the part of the file the shot uses (a second either side, so a small trim needs no new one), stabilised with the
  // shot's own settings (stabOf - the same as the export) into a 1080p copy with its sound, cache/stab/<key>.mp4. Made
  // from the camera file, not its 540p preview copy: the shake is measured on the real detail (and the copy is sharp).
  // Body { clip, a, b }: { ready, file, a } at once when it is there, else { job } - the job's result is the same.
  'POST /api/stab': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), c = b.clip || {}, m = mediaItem(name, String(c.mediaId || ''));
    const so = stabOf(c);
    if (!m || m.kind !== 'video' || !so) throw err(400, 'Not a stabilised video clip');
    const a = Math.max(0, +b.a || 0), z = Math.min(m.duration || Infinity, +b.b || 0);
    if (!(z - a > 0.1)) throw err(400, 'Nothing to stabilise');
    const key = crypto.createHash('sha1').update(`${m.id}|${a.toFixed(2)}|${z.toFixed(2)}|${so.key}`).digest('hex').slice(0, 16);
    const dir = P(name, 'cache', 'stab'), out = path.join(dir, `${key}.mp4`), info = { file: `${key}.mp4`, a };
    if (fs.existsSync(out)) return { ready: true, ...info };
    const running = [...jobs.values()].find((j) => j.kind === 'stab' && j.stabKey === key && j.status === 'running');
    if (running) return { job: running.id };
    const job = startTask('stab', async (job) => {
      job.stage = 'Waiting for the stabiliser…';
      return stabLine(async () => {
        fs.mkdirSync(dir, { recursive: true });
        const src = fs.existsSync(m.path) ? m.path : analysisFile(name, m), len = z - a, pre = "scale=-2:'min(ih,1080)'";
        const prog = (base) => (l) => { const t = /^out_time_ms=(\d+)/.exec(l); if (t) job.progress = Math.min(99, Math.round(base + 50 * (+t[1] / 1e6 / len))); };
        // (run in the folder: vid.stab's motion file then needs no Windows path inside the filter text)
        job.stage = 'Analysing the shake (1 of 2)…';
        let r = await run('ffmpeg', ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-y', '-ss', a.toFixed(3), '-t', len.toFixed(3), '-i', src, '-an', '-vf', `${pre},${so.detect}:result=${key}.trf`, '-f', 'null', '-'], { cwd: dir, onLine: prog(0) });
        if (r.code !== 0) throw new Error(`Could not analyse the shot: ${r.stderr.trim().split(/\r?\n/).pop()}`);
        job.stage = 'Stabilising (2 of 2)…';
        r = await run('ffmpeg', ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-y', '-ss', a.toFixed(3), '-t', len.toFixed(3), '-i', src, '-vf', `${pre},vidstabtransform=input=${key}.trf:${so.transform},format=yuv420p`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-g', '15', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', `${key}.part.mp4`], { cwd: dir, onLine: prog(50) });
        fs.rmSync(path.join(dir, `${key}.trf`), { force: true });
        if (r.code !== 0) { fs.rmSync(path.join(dir, `${key}.part.mp4`), { force: true }); throw new Error(`Could not stabilise the shot: ${r.stderr.trim().split(/\r?\n/).pop()}`); }
        fs.renameSync(path.join(dir, `${key}.part.mp4`), out);
        return { ready: true, ...info };
      });
    }, { project: name, stabKey: key, label: `🎥 Stabilising ${m.name}` });
    return { job: job.id };
  },
  'GET /api/stab/file': (req, res, u) => serveFile(req, res, P(needProject(q(u, 'p')), 'cache', 'stab', path.basename(String(q(u, 'f') || ''))), true),
  // 📂 Reveal in Explorer (right-click a file in Media or a clip on the timeline): the folder the file came from, with
  // the file selected. On the editor's own PC (also when it is opened through the team link) the server opens Explorer.
  // Another PC opens it itself through its Reveal helper (/api/reveal-helper) - so the answer carries the network path
  // (L:\… -> \\Limeligt\Limelight NAS\…), which every PC can open whatever drive letters it has.
  'POST /api/media/reveal': (req, res, u) => {
    const name = needProject(q(u, 'p')), m = mediaItem(name, String(q(u, 'id') || ''));
    if (!m) throw err(404, 'media not found');
    const file = m.path && fs.existsSync(m.path) ? m.path : null;
    const dir = file ? path.dirname(file) : [m.path && path.dirname(m.path)].find((d) => d && fs.existsSync(d)) || projDir(name);
    const opened = samePC(req) && process.platform === 'win32' && !q(u, 'copy'); // (copy=1: 📋 Copy folder path - only the path)
    if (opened) spawn('explorer', [file ? `/select,"${file}"` : `"${dir}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    return { path: m.path || '', unc: toUnc(file || dir), select: !!file, opened, missing: !file };
  },
  // the Reveal helper for another PC: one small file to run once there - it teaches Windows the limelight-reveal: link,
  // which opens Explorer at a file (or a folder) on that PC. Nothing else is installed; no admin rights.
  'GET /api/reveal-helper': (req, res) => {
    // the link is limelight-reveal:<s|f><hex of each UTF-16 letter> (s: select the file, f: open the folder) - hex, so
    // Hindi names reach Explorer whole (browsers and VBScript disagree about %-escapes)
    const vbs = ['Dim a, p, i: a = WScript.Arguments(0): a = Mid(a, InStr(a, ":") + 1)', 'Do While Left(a, 1) = "/": a = Mid(a, 2): Loop',
      'For i = 2 To Len(a) - 3 Step 4: p = p & ChrW(CLng("&H" & Mid(a, i, 4))): Next', 'Set s = CreateObject("WScript.Shell")',
      'If Left(a, 1) = "f" Then s.Run "explorer.exe """ & p & """", 1, False Else s.Run "explorer.exe /select,""" & p & """", 1, False'];
    const cmd = ['@echo off', 'rem Limelight Editor - Reveal helper: Right-click > Reveal in Explorer opens the NAS folder on this PC',
      String.raw`set "D=%LOCALAPPDATA%\Limelight"`, 'if not exist "%D%" mkdir "%D%"',
      // (written by PowerShell from base64: cmd's echo cannot write VBScript's quotes and & reliably)
      `powershell -NoProfile -Command "[IO.File]::WriteAllText($env:LOCALAPPDATA + '${'\\'}Limelight${'\\'}reveal.vbs', [Text.Encoding]::ASCII.GetString([Convert]::FromBase64String('${Buffer.from(vbs.join('\r\n'), 'ascii').toString('base64')}')))"`,
      String.raw`reg add "HKCU\Software\Classes\limelight-reveal" /ve /d "URL:Limelight Reveal" /f >nul`,
      String.raw`reg add "HKCU\Software\Classes\limelight-reveal" /v "URL Protocol" /d "" /f >nul`,
      String.raw`reg add "HKCU\Software\Classes\limelight-reveal\shell\open\command" /ve /d "wscript.exe \"%D%\reveal.vbs\" \"%%1\"" /f >nul`,
      'echo Done - Reveal in Explorer now opens the folder on this PC. You can close this window.', 'pause'].join('\r\n');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Limelight Reveal helper.cmd"' });
    res.end(cmd);
  },
  'POST /api/open-folder': (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const abs = saveToDir(req.who, q(u, 'path')); // (an export folder outside the project, chosen with 📁 Save to)
    // ("exports/…" from an editor tab opened before the folder became "output")
    const sub = String(q(u, 'sub') || '').replace(/^exports(?=\/|$)/, 'output'), dir = abs || (sub ? P(name, ...sub.split('/').map((s) => path.basename(s))) : projDir(name));
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
      if (!req.who?.local) { // (another PC: the NAS only)
        const nas = remoteDrives().filter((d) => { try { fs.readdirSync(d); return true; } catch { return false; } });
        return { path: '', parent: null, dirs: [...libs.filter((l) => nas.some((d) => underDrive(l.path, d))), ...nas.map((d) => ({ name: `💾 NAS ${d}`, path: d }))], mediaCount: 0 };
      }
      return { path: '', parent: null, dirs: [...libs, ...[...quick, ...roots].map((d) => ({ name: d, path: d }))], mediaCount: 0 };
    }
    folderAllowed(req, p);
    if (!fs.existsSync(p)) throw err(404, `Folder not found: ${p}`);
    let ents = [];
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { throw err(403, `Cannot open ${p}`); }
    const dirs = ents.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')).map((e) => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const files = ents.filter((e) => e.isFile() && EXT_KIND(path.extname(e.name)) !== 'other').map((e) => e.name);
    const parent = path.dirname(p) === p || (!req.who?.local && remoteDrives().some((d) => d.toLowerCase() === path.resolve(p).toLowerCase())) ? '' : path.dirname(p);
    return { path: p, parent, dirs, files: files.slice(0, 200), mediaCount: files.length };
  },

  // media pool
  'GET /api/media': (req, res, u) => {
    const name = needProject(q(u, 'p'));
    if (activeProject !== name) { activeProject = name; pump(); }
    checkOfflineSoon(name); // 🗂 files gone since they were read (moved, drive unplugged) show as offline (next list)
    if (!req.who?.local) ensureLite(name); // 🌐 someone over the internet has it open: light copies of its heavy files
    upgradeProxies(name); // 🎞 sharper (1080p) preview copies for the files on its timelines
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
    const added = [], skipped = [], other = {};
    for (const src of [].concat(b.folder || [], b.files || [])) {
      folderAllowed(req, src);
      if (!fs.existsSync(src)) throw err(400, `Not found: ${src}`);
      const list = fs.statSync(src).isDirectory() ? scanFolder(src, { other }) : [{ file: src, bin: '' }];
      const binRoot = fs.statSync(src).isDirectory() ? path.basename(src) : '';
      for (const f of list) {
        const it = addMediaFile(name, f.file, { bin: [binRoot, f.bin].filter(Boolean).join('/') });
        (it ? added : skipped).push(f.file);
      }
    }
    saveMedia(name, true);
    // files the editor cannot use (camera RAW, project files): how many of each, and what to do with them
    const notUsed = Object.entries(other).map(([ext, n]) => ({ ext, n, what: NOT_MEDIA[ext] }));
    return { added: added.length, skipped: skipped.length, notUsed };
  },
  // ⬆ big files in pieces (public/js/api.js uploadFile): each piece is added to imports/.up-<key>.part at its offset, so a
  // dropped connection carries on from what arrived instead of starting again. The last piece finishes the file like a
  // plain upload. ?key (the file's own id, from the browser) &off &total &name &bin
  'GET /api/upload/part': (req, res, u) => {
    const name = needProject(q(u, 'p')), f = P(name, 'imports', `.up-${String(q(u, 'key') || '').replace(/[^\w-]/g, '').slice(0, 64)}.part`);
    let have = 0; try { have = fs.statSync(f).size; } catch {}
    return { have };
  },
  'POST /api/upload/part': (req, res, u) => new Promise((ok, bad) => {
    const name = needProject(q(u, 'p')), key = String(q(u, 'key') || '').replace(/[^\w-]/g, '').slice(0, 64);
    if (!key) return bad(err(400, 'No upload key'));
    fs.mkdirSync(P(name, 'imports'), { recursive: true });
    const part = P(name, 'imports', `.up-${key}.part`), off = +q(u, 'off') || 0, total = +q(u, 'total') || 0;
    let have = 0; try { have = fs.statSync(part).size; } catch {}
    if (off !== have) { req.resume(); return ok({ have, again: true }); } // (a piece sent twice, or one missed: the browser goes on from here)
    const out = fs.createWriteStream(part, { flags: 'a' });
    req.pipe(out);
    req.on('error', (e) => { out.destroy(); bad(e); });
    out.on('error', (e) => bad(err(500, `Could not write into the project folder: ${e.code || e.message}`)));
    out.on('finish', () => {
      let now = 0; try { now = fs.statSync(part).size; } catch {}
      if (!total || now < total) return ok({ have: now });
      try { ok({ ...finishUpload(name, part, q(u, 'name'), q(u, 'bin')), have: now, done: true }); } catch (e) { bad(e); }
    });
  }),
  'POST /api/upload': (req, res, u) => new Promise((ok, bad) => {
    const name = needProject(q(u, 'p'));
    fs.mkdirSync(P(name, 'imports'), { recursive: true });
    const tmp = P(name, 'imports', `.up-${crypto.randomBytes(6).toString('hex')}.part`);
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => { try { ok(finishUpload(name, tmp, q(u, 'name'), q(u, 'bin'))); } catch (e) { bad(e); } });
    req.on('error', (e) => { fs.rmSync(tmp, { force: true }); bad(e); });
  }),
  'DELETE /api/media': (req, res, u) => {
    const name = needProject(q(u, 'p')), db = mediaDb(name);
    const ids = new Set(String(q(u, 'id')).split(','));
    for (const m of db.items) if (m.subOf && ids.has(m.subOf)) ids.add(m.id); // (✂ its subclips go with a file)
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
  'GET /api/disk/all': () => allProjects().map((n) => ({ project: n, ...dirSize(projDir(n)) })).sort((a, b) => b.bytes - a.bytes),
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
  'GET /api/renders': (req, res, u) => listDir(P(needProject(q(u, 'p')), 'renders'), (n) => (/\.(mp4|mov|wav|mp3|gif)$/i.test(n) || / frames$/.test(n)) && n !== '_preview.mp4')
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
    prepareRender(name, { project: saved, seq: b.seq, preset: 'master', quality: { res: 1080, crf: 16 }, filename: 'nest', whole: true }, { write: false, jobFile });
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
  // 📈 Loudness Meter / Radar (audio effects): one clip's loudness as heard - its clean-up and the effects before the
  // meter applied. Body { mediaId, in, out, afx, aeffects } -> { lufs, lra, peak }
  'POST /api/audio/measure': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), m = mediaItem(name, b.mediaId);
    if (!m?.hasAudio) throw err(404, 'This clip has no sound');
    const t0 = Math.max(0, +b.in || 0), t1 = Math.min(m.duration || Infinity, +b.out || m.duration || t0 + 600);
    const { fxFilters } = await import('./public/js/audiofx.js'), { aeffectFilters } = await import('./public/js/audioeffects.js');
    const chain = [...fxFilters(b.afx), ...aeffectFilters(Array.isArray(b.aeffects) ? b.aeffects : []), 'ebur128=peak=true'].join(',');
    const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(t0), '-t', String(Math.max(0.5, t1 - t0)), '-i', m.path, '-vn', '-af', chain, '-f', 'null', '-']);
    const s = r.stderr.slice(r.stderr.lastIndexOf('Summary')), num = (re) => { const x = re.exec(s); return x ? +x[1] : null; };
    const lufs = num(/I:\s*(-?[\d.]+) LUFS/), lra = num(/LRA:\s*(-?[\d.]+) LU/), peak = num(/Peak:\s*(-?[\d.]+) dBFS/);
    if (lufs === null) throw err(500, `Could not measure: ${r.stderr.trim().split(/\r?\n/).pop()}`);
    return { lufs, lra, peak };
  },
  // 🎵 beat grid of a music file: { period, first, bpm, duration }
  'GET /api/music/beats': async (req, res, u) => {
    const name = needProject(q(u, 'p')), m = mediaItem(name, q(u, 'id'));
    if (!m?.hasAudio) throw err(404, 'music not found');
    const { beats } = await import('./engine/music.mjs');
    return { ...(beats(m.path) || {}), duration: m.duration };
  },
  // 👥 who is asking, project locks, team settings (owner)
  'GET /api/me': (req) => ({ name: req.who.name, role: req.who.role, local: !!req.who.local, home: userHome(req.who), shared: req.who.role === 'viewer' ? [] : sharedDirs(), anyFolder: req.who.role !== 'viewer',
    standby: STANDBY, hold: standbyHold ? { host: standbyHold.host, since: standbyHold.since, pending: !!standbyHold.pending } : null }), // (🖥 standby PC: see Mazbooti) // (shared: where an editor may save exports)
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
      // 👤 their own folder for projects on the NAS (Z:\Editor Projects\<Name>), unless one named like them is there already
      try { const home = userHome({ name: n }); if (home && !fs.existsSync(home)) fs.mkdirSync(home); } catch {}
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
  // 📷 Export Frame: the frame at t of the open sequence, made by the export renderer (so it looks exactly like the export:
  // effects, titles, colour, logo) -> output/frames/<sequence> <timecode>.png. Body { t, seq }
  'POST /api/frame': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    const saved = normalizeProject(readJSON(P(name, 'project.json'))), pj = b.seq ? seqView(saved, b.seq) : saved;
    const byId = Object.fromEntries(mediaDb(name).items.map((m) => [m.id, m]));
    const F = pj.settings.fps || 30, D = totalDuration(pj, byId), len = Math.max(0.2, 3 / F);
    const t = Math.max(0, Math.min(+b.t || 0, D - len - 0.01));
    const jobFile = P(name, 'cache', 'render-job-frame.json'), mp4 = P(name, 'cache', 'frame.mp4');
    prepareRender(name, { project: { ...pj, settings: { ...pj.settings, range: { in: +t.toFixed(3), out: +(t + len).toFixed(3) } } }, preview: true }, { jobFile, write: false });
    writeJSON(jobFile, { ...readJSON(jobFile), output: mp4, preview: false, fastPreview: false, farm: null }); // (full quality, here)
    const tc = [Math.floor(t / 3600), Math.floor((t % 3600) / 60), Math.floor(t % 60), Math.floor((t % 1) * F)].map((x) => String(x).padStart(2, '0')).join('-');
    return startTask('frame', async (job) => {
      job.stage = 'Making the frame…';
      const r = await run(process.execPath, [path.join(ROOT, 'engine', 'render2.mjs'), jobFile]);
      if (r.code !== 0 || !fs.existsSync(mp4)) throw new Error(`The frame could not be made: ${String(r.stderr || r.stdout).trim().split(/\r?\n/).pop()}`);
      const dir = P(name, 'output', 'frames'); fs.mkdirSync(dir, { recursive: true });
      const base = safeName(`${seqOf(pj).name || name} ${tc}`);
      let f = `${base}.png`; for (let i = 2; fs.existsSync(path.join(dir, f)); i++) f = `${base} (${i}).png`;
      const x = await run('ffmpeg', ['-y', '-v', 'error', '-i', mp4, '-frames:v', '1', path.join(dir, f)]);
      fs.rmSync(mp4, { force: true });
      if (x.code !== 0) throw new Error(`The frame could not be saved: ${x.stderr.trim().split(/\r?\n/).pop()}`);
      const [w, h] = ASPECTS[pj.settings.aspect] || ASPECTS['16:9'];
      return { name: f, url: `/pf/${encodeURIComponent(name)}/frames/${encodeURIComponent(f)}`, width: w, height: h };
    }, { project: name });
  },
  // an exported frame into Media (folder "Frames"), like Premiere's "Import into project"
  'POST /api/frame/import': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), f = P(name, 'output', 'frames', path.basename(String(b.name || '')));
    if (!fs.existsSync(f)) throw err(404, 'That frame is not there any more');
    const it = addMediaFile(name, f, { bin: 'Frames' }); saveMedia(name, true);
    return { ok: true, id: it?.id || null };
  },
  'GET /api/thumb/cand': (req, res, u) => serveFile(req, res, P(needProject(q(u, 'p')), 'cache', 'thumbcand', path.basename(q(u, 'f') || ''))),
  // a finished thumbnail (PNG from the designer) -> output/thumbnails/<name>.png
  'POST /api/thumb/save': (req, res, u) => new Promise((ok, bad) => {
    const name = needProject(q(u, 'p')), dir = P(name, 'output', 'thumbnails');
    fs.mkdirSync(dir, { recursive: true });
    const base = safeName(q(u, 'name') || 'thumbnail').replace(/\.png$/i, '');
    let f = `${base}.png`; for (let i = 2; fs.existsSync(path.join(dir, f)); i++) f = `${base} ${i}.png`;
    const out = fs.createWriteStream(path.join(dir, f));
    req.pipe(out); out.on('finish', () => ok({ name: f, url: `/pf/${encodeURIComponent(name)}/thumbnails/${encodeURIComponent(f)}` })); req.on('error', bad);
  }),
  'GET /api/thumb/list': (req, res, u) => listDir(P(needProject(q(u, 'p')), 'output', 'thumbnails'), (n) => /\.png$/i.test(n)).map((x) => ({ ...x, url: `/pf/${encodeURIComponent(q(u, 'p'))}/thumbnails/${encodeURIComponent(x.name)}` })),
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
  // ✨ AI fill (content-aware): the boxes drawn over a logo / text (fractions of the picture) are filled in by LaMa
  // (engine/inpaint.py, GPU) for the clip's piece [in, out] of the file; the filled piece becomes a new file of the
  // project (bin "AI fill"), which the editor puts on the timeline in place of that piece. Body { mediaId, in, out, boxes }
  // 🛸 Gyroflow: a shaky shot stabilised with the camera's gyro data (engine/gyroflow.mjs) -> a new media item
  'GET /api/gyroflow/status': () => ({ installed: !!gyroflowExe(ROOT) }),
  'POST /api/gyroflow': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), m = mediaItem(name, b.mediaId), exe = gyroflowExe(ROOT);
    if (!exe) throw err(400, 'Gyroflow is not installed (tools/gyroflow)');
    if (!m || m.kind !== 'video') throw err(400, 'Pick a video clip');
    if (!fs.existsSync(m.path)) throw err(400, `File is offline: ${m.path}`);
    const given = String(b.gyroFile || '').trim().replace(/^"|"$/g, '');
    if (given && (!fs.existsSync(given) || !GF_LOG.test(given))) throw err(400, 'The flight log was not found (a .bbl / .bfl / .csv / .gcsv file)');
    const gyroFile = given || findLog(m.path);
    return startTask('gyroflow', async (job) => {
      const work = P(name, 'cache', 'gyroflow');
      fs.mkdirSync(work, { recursive: true });
      job.stage = gyroFile ? `Reading the flight log ${path.basename(gyroFile)}…` : 'Looking for gyro data in the file…'; job.progress = 2;
      const n = await gyroSamples(exe, m.path, gyroFile, work, job);
      if (n < 5) throw new Error(gyroFile ? `No motion data found in ${path.basename(gyroFile)} for this video` : 'This video has no gyro data inside. GoPro / DJI / Insta360 / Sony files have it; for an FPV drone give its flight log (.bbl / .bfl / .csv). Otherwise use Warp Stabilizer.');
      job.stage = 'Stabilising with Gyroflow…'; job.progress = 5;
      const out = await stabilise({ exe, video: m.path, gyroFile, outDir: path.join(work, `${m.id}_${Date.now().toString(36)}`), job,
        opts: { smoothness: +b.smoothness || 0.5, zoom: +b.zoom || 1, horizon: +b.horizon || 0 }, onProgress: (p) => { job.progress = Math.round(5 + 85 * p); } });
      job.stage = 'Adding it to Media…'; job.progress = 92;
      const it = addMediaFile(name, out, { bin: 'Gyroflow' });
      if (!it) throw new Error('Could not add the stabilised file to Media');
      saveMedia(name, true);
      if (activeProject !== name) { activeProject = name; pump(); }
      for (let i = 0; i < 300 && !['ready', 'error', 'offline'].includes(mediaItem(name, it.id)?.status); i++) await new Promise((ok) => setTimeout(ok, 1000));
      if (mediaItem(name, it.id)?.status !== 'ready') throw new Error('The stabilised file could not be read');
      return { mediaId: it.id, from: m.id, gyroFile: gyroFile ? path.basename(gyroFile) : null };
    }, { project: name });
  },
  'POST /api/inpaint': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), m = mediaItem(name, b.mediaId);
    if (!m || m.kind !== 'video') throw err(400, 'This needs a video clip');
    if (!fs.existsSync(path.join(ROOT, 'tools', 'models', 'big-lama.pt'))) throw err(400, 'The AI fill model is not installed (tools/models/big-lama.pt)');
    const boxes = (b.boxes || []).filter((x) => x && x.w > 0 && x.h > 0).map((x) => ({ x: +x.x, y: +x.y, w: +x.w, h: +x.h }));
    if (!boxes.length) throw err(400, 'Draw a box over the logo / text first');
    const t0 = Math.max(0, +(+b.in || 0).toFixed(3)), t1 = Math.min(m.duration || 1e9, +(+b.out || m.duration || 0).toFixed(3));
    if (!(t1 - t0 > 0.05)) throw err(400, 'The clip is too short');
    if (t1 - t0 > 600) throw err(400, 'Fill at most 10 minutes at a time - split the clip first');
    const [W, H] = Math.abs(m.rotation || 0) === 90 ? [m.height, m.width] : [m.width, m.height];
    const dir = P(name, 'imports'), base = `${path.parse(m.name).name} (AI fill ${t0.toFixed(1)}-${t1.toFixed(1)})`;
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(P(name, 'cache', 'inpaint'), { recursive: true });
    let out = path.join(dir, `${base}.mp4`);
    for (let i = 2; fs.existsSync(out); i++) out = path.join(dir, `${base} ${i}.mp4`);
    const bf = P(name, 'cache', 'inpaint', `${crypto.randomBytes(6).toString('hex')}.json`);
    writeJSON(bf, boxes);
    return startTask('inpaint', async (job) => {
      job.stage = 'Filling in the boxes (AI)…';
      const r = await run(PYTHON, [path.join(ROOT, 'engine', 'inpaint.py'), m.path, String(t0), String(t1), `${out}.part.mp4`, bf, String(W), String(H), String(m.fps || 25)], {
        onLine: (l) => { const x = /\[(\d+)\/(\d+)\]/.exec(l); if (x) job.progress = Math.min(99, Math.round((+x[1] / +x[2]) * 100)); } });
      fs.rmSync(bf, { force: true });
      if (r.code !== 0 || !fs.existsSync(`${out}.part.mp4`)) { fs.rmSync(`${out}.part.mp4`, { force: true }); throw new Error(`AI fill failed: ${r.stderr.trim().split(/\r?\n/).pop()}`); }
      fs.renameSync(`${out}.part.mp4`, out);
      const it = addMediaFile(name, out, { bin: 'AI fill', imported: true });
      saveMedia(name);
      return { mediaId: it?.id, file: path.basename(out), dur: +(t1 - t0).toFixed(3) };
    }, { project: name });
  },
  // ✨ AI Enhance (like Topaz): Real-ESRGAN (engine/enhance.py, GPU) cleans noise / compression, brings back detail and
  // can upscale the clip's piece [in, out]; a new file of the project (bin "AI enhance") takes the piece's place.
  // Body { mediaId, in, out, model: 'fast' | 'detail', denoise: 0..1, height: 0 (same) | 1080 | 2160 }
  'POST /api/enhance': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), m = mediaItem(name, b.mediaId);
    if (!m || m.kind !== 'video') throw err(400, 'This needs a video clip');
    if (!fs.existsSync(path.join(ROOT, 'tools', 'models', 'realesr-general-x4v3.pth'))) throw err(400, 'The AI enhance models are not installed (tools/models)');
    const t0 = Math.max(0, +(+b.in || 0).toFixed(3)), t1 = Math.min(m.duration || 1e9, +(+b.out || m.duration || 0).toFixed(3));
    if (!(t1 - t0 > 0.05)) throw err(400, 'The clip is too short');
    if (t1 - t0 > 300) throw err(400, 'Enhance at most 5 minutes at a time - split the clip first');
    const [W, H] = Math.abs(m.rotation || 0) === 90 ? [m.height, m.width] : [m.width, m.height];
    const th = [1080, 2160].includes(+b.height) ? +b.height : H, k = th / Math.min(W, H); // (the short side becomes the height asked)
    const ow = Math.round((W * k) / 2) * 2, oh = Math.round((H * k) / 2) * 2, model = b.model === 'detail' ? 'detail' : 'fast';
    const dir = P(name, 'imports'), base = `${path.parse(m.name).name} (AI enhance ${t0.toFixed(1)}-${t1.toFixed(1)})`;
    fs.mkdirSync(dir, { recursive: true });
    let out = path.join(dir, `${base}.mp4`);
    for (let i = 2; fs.existsSync(out); i++) out = path.join(dir, `${base} ${i}.mp4`);
    return startTask('inpaint', async (job) => { // (one GPU job at a time, like AI fill)
      job.stage = 'Enhancing (AI)…';
      const r = await run(PYTHON, [path.join(ROOT, 'engine', 'enhance.py'), m.path, String(t0), String(t1), `${out}.part.mp4`, String(W), String(H), String(m.fps || 25), String(ow), String(oh),
        '--model', model, '--denoise', String(Math.max(0, Math.min(1, b.denoise ?? 0.5)))], {
        onLine: (l) => { const x = /\[(\d+)\/(\d+)\]/.exec(l); if (x) job.progress = Math.min(99, Math.round((+x[1] / +x[2]) * 100)); } });
      if (r.code !== 0 || !fs.existsSync(`${out}.part.mp4`)) { fs.rmSync(`${out}.part.mp4`, { force: true }); throw new Error(`AI enhance failed: ${r.stderr.trim().split(/\r?\n/).pop()}`); }
      fs.renameSync(`${out}.part.mp4`, out);
      const it = addMediaFile(name, out, { bin: 'AI enhance', imported: true });
      saveMedia(name);
      return { mediaId: it?.id, file: path.basename(out), dur: +(t1 - t0).toFixed(3) };
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
      // 🧑 who is in it and ✍ what is written on it - every scanned clip, not only these (the faces are grouped across
      // the whole project; clips seen before come from the cache). If this part fails the rest of the scan still counts.
      let people = null;
      if (b.people !== false && healthCache?.people) {
        job.stage = 'Finding faces and reading text…'; job.progress = 95;
        try {
          const all = mediaDb(name).items.filter((m) => m.tags && (m.kind === 'video' || m.kind === 'image') && !m.seqOf);
          people = await lookAtPeople(name, all, (p, msg) => { job.progress = 95 + Math.round(p * 0.04); job.stage = /loading/.test(msg) ? `${msg[0].toUpperCase()}${msg.slice(1)}…` : 'Finding faces and reading text…'; });
        } catch (e) { job.log.push(`Faces / text: ${e.message}`); }
      }
      // duplicate groups: clips joined by near-identical pairs
      const parent = {}, find = (x) => (parent[x] === undefined || parent[x] === x ? x : (parent[x] = find(parent[x])));
      for (const [a, c] of r.dups) parent[find(a)] = find(c);
      const groups = {};
      for (const [a, c] of r.dups) for (const id of [a, c]) (groups[find(id)] ||= new Set()).add(id);
      const dups = Object.values(groups).map((g) => [...g]);
      writeJSON(P(name, 'cache', 'footage.json'), { at: Date.now(), dups });
      return { tagged: Object.keys(r.media).length, dups, bad, people: people?.people.length ?? null, withText: people ? Object.keys(people.text).length : null };
    }, { project: name });
  },
  'GET /api/footage': (req, res, u) => readJSON(P(needProject(q(u, 'p')), 'cache', 'footage.json'), { dups: [] }),
  // 🔎 "jharna dikhao": clips whose pictures look like the words (Hindi / Hinglish / English). Needs a smart scan first.
  // A named person ("CM sahab dikhao") finds the clips with their face, and words on a banner or super ("lok seva
  // guarantee") the clips showing them - those come first ({ why }), then what the pictures look like.
  'POST /api/footage/search': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    const d = readJSON(P(name, 'cache', 'people.json'), null), extra = [];
    if (d) {
      for (const p of mentioned(b.q, d.people, loadLibrary(ROOT))) for (const [id, ts] of Object.entries(p.media)) extra.push({ id, t: ts[Math.floor(ts.length / 2)], score: 1, why: `🧑 ${peopleLabel(p)}` });
      for (const h of textHits(b.q, d.text)) if (!extra.some((x) => x.id === h.id)) extra.push({ id: h.id, t: h.t, score: 0.9, why: `✍ "${h.text}"` });
    }
    const en = toEnglishQuery(b.q);
    if (!en && !extra.length) throw err(400, 'Type what to look for');
    const ids = mediaDb(name).items.filter((m) => m.tags).map((m) => m.id);
    if (!ids.length && !extra.length) throw err(400, 'Run 🧠 Smart scan once first - it lets the editor understand your footage');
    const r = en && ids.length ? await footageWorker().send({ cmd: 'search', cacheDir: P(name, 'cache', 'agent', 'emb'), ids, q: en, top: 40 }) : { results: [] };
    const seen = new Set(extra.map((x) => x.id));
    return { q: en || String(b.q), results: [...extra, ...r.results.filter((x) => !seen.has(x.id))] };
  },
  // 🧑 the people the Smart scan found in this project's footage. A name given here is kept in Library/people, so the
  // same face is known by that name in every project (and by the ✨ Agent and the Assistant's Claude).
  'GET /api/people': (req, res, u) => {
    const name = needProject(q(u, 'p')), d = readJSON(P(name, 'cache', 'people.json'), { people: [] }), lib = loadLibrary(ROOT);
    return { at: d.at || 0, ready: !!healthCache?.people, people: d.people.map(({ emb, ...p }) => ({ ...p, label: peopleLabel(p), aliases: lib.find((l) => l.id === p.libId)?.aliases || [],
      thumb: p.thumb ? `/api/people/thumb?p=${encodeURIComponent(name)}&f=${encodeURIComponent(p.thumb)}&v=${d.at || 0}` : null })) };
  },
  'GET /api/people/thumb': (req, res, u) => serveFile(req, res, P(needProject(q(u, 'p')), 'cache', 'people', path.basename(q(u, 'f') || '')), true),
  // name a person (or clear the name: ''). Body { key, name, aliases?: ['Vishnu Deo Sai', 'मुख्यमंत्री'] }
  'POST /api/people/name': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    return editPeople(name, (d) => {
      const p = d.people.find((x) => x.key === b.key);
      if (!p) throw err(404, 'That person is not in this project any more - scan again');
      const nm = String(b.name || '').trim().slice(0, 80);
      if (!nm) { p.name = null; p.libId = null; return p; }
      const lib = loadLibrary(ROOT);
      let lp = lib.find((l) => l.id === p.libId) || lib.find((l) => l.name.toLowerCase() === nm.toLowerCase());
      if (!lp) { lp = { id: `h${crypto.randomBytes(4).toString('hex')}`, name: nm, aliases: [], embs: [] }; lib.push(lp); }
      lp.name = nm;
      if (Array.isArray(b.aliases)) lp.aliases = b.aliases.map((s) => String(s).trim().slice(0, 80)).filter(Boolean).slice(0, 12);
      if (p.emb && !lp.embs.some((e) => e.every((v, i) => v === p.emb[i]))) lp.embs = [...lp.embs, p.emb].slice(-20);
      saveLibrary(ROOT, lib);
      Object.assign(p, { name: nm, libId: lp.id });
      // (the same name on another group of this project is the same person: they become one)
      const twin = d.people.find((x) => x !== p && x.libId === lp.id);
      if (twin) mergeInto(d, p, [twin]);
      return p;
    });
  },
  // one person found as two (with and without glasses, side face): Body { keys: [keep, ...others] }
  'POST /api/people/merge': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    return editPeople(name, (d) => {
      const [keep, ...rest] = (b.keys || []).map((k) => d.people.find((x) => x.key === k)).filter(Boolean);
      if (!keep || !rest.length) throw err(400, 'Pick two or more people to join');
      const named = [keep, ...rest].find((x) => x.libId);
      if (named && named !== keep) Object.assign(keep, { name: named.name, libId: named.libId });
      mergeInto(d, keep, rest);
      if (keep.libId) { const lib = loadLibrary(ROOT), lp = lib.find((l) => l.id === keep.libId); if (lp) { lp.embs = [...lp.embs, ...rest.map((x) => x.emb).filter(Boolean)].slice(-20); saveLibrary(ROOT, lib); } }
      return keep;
    });
  },
  // 💬 best quotes: the lines of interviews / speeches worth putting in an edit, from the transcripts (Text page or
  // ⚙ Batch › Transcript). Claude picks them when it is there, else a simple rule. Body { ids?, n?, brief? } -> job;
  // GET gives the last list ({ at, by, quotes: [{ mediaId, start, end, text, why }] }).
  'GET /api/quotes': (req, res, u) => readJSON(P(needProject(q(u, 'p')), 'cache', 'quotes.json'), { quotes: [] }),
  'POST /api/quotes': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), want = b.ids?.length ? new Set(b.ids) : null;
    const items = mediaDb(name).items.filter((m) => (!want || want.has(m.id)) && fs.existsSync(P(name, 'cache', 'transcripts', `${m.id}.json`)));
    if (!items.length) throw err(400, 'No transcripts yet - make one first (Text page, or ⚙ Batch › Transcript)');
    return startTask('quotes', async (job) => {
      const n = Math.max(3, Math.min(40, Math.round(+b.n || 12)));
      const lines = [];
      for (const m of items) for (const s of readJSON(P(name, 'cache', 'transcripts', `${m.id}.json`), {}).segments || [])
        if (String(s.text || '').trim() && Number.isFinite(+s.start) && +s.end > +s.start) lines.push({ id: m.id, start: +s.start, end: +s.end, text: String(s.text).trim() });
      if (!lines.length) throw new Error('The transcripts have no spoken lines (music or silence only)');
      let quotes = null, by = 'rule';
      job.stage = 'Asking Claude for the best lines…'; job.progress = 10;
      const st = await claudeStatus();
      if (st.available) {
        try { quotes = await claudeQuotes(st.exe, lines, n, String(b.brief || '').slice(0, 500)); by = 'claude'; }
        catch (e) { job.log.push(`Claude: ${e.message} - picked by the simple rule instead`); }
      }
      quotes ||= ruleQuotes(lines, n);
      const out = { at: Date.now(), by, quotes };
      writeJSON(P(name, 'cache', 'quotes.json'), out);
      return out;
    }, { project: name });
  },
  // not a person worth knowing (a poster, a passer-by): left out of this project's list. Body { key }
  'POST /api/people/remove': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    return editPeople(name, (d) => { d.people = d.people.filter((x) => x.key !== b.key); return { removed: b.key }; });
  },
  // move clips to another folder (bin) of the media pool, e.g. "Rejects". Body { ids, bin }
  // 🪄 Morph Cut (a jump cut in an interview made smooth) and ⏩ Extend: short new pictures made with optical flow
  // (FFmpeg minterpolate, motion-compensated) - a file in imports/morph, added to Media (folder "Morph cuts").
  //   Morph: Body { kind: 'morph', a: { mediaId, t }, b: { mediaId, t }, dur } - the frames in between the last frame of
  //     the first shot (a) and the first of the second (b), over dur seconds
  //   Extend: Body { kind: 'extend', a: { mediaId, t }, dur, from } - the last `from` seconds before t, slowed with
  //     in-between frames to last `dur` seconds (the shot carries on, slower, instead of stopping)
  // -> a job whose result is { mediaId }
  'POST /api/morph': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), A = mediaItem(name, String(b.a?.mediaId || ''));
    const B = b.kind === 'morph' ? mediaItem(name, String(b.b?.mediaId || '')) : null, dur = Math.min(3, Math.max(0.2, +b.dur || 0.5));
    if (!A || A.kind !== 'video' || !fs.existsSync(A.path) || (b.kind === 'morph' && (!B || !fs.existsSync(B.path)))) throw err(400, 'Those clips have no video file here');
    const pj = liveOf(name).pj, [W0, H0] = ASPECTS[pj.settings?.aspect] || [1920, 1080], fps = pj.settings?.fps || 30;
    const dir = P(name, 'imports', 'morph'); fs.mkdirSync(dir, { recursive: true });
    const key = crypto.createHash('sha1').update(JSON.stringify([b.kind, A.id, b.a.t, B?.id, b.b?.t, dur, b.from, W0, H0, fps])).digest('hex').slice(0, 12), out = path.join(dir, `${b.kind}_${key}.mp4`);
    const fit = `scale=${W0}:${H0}:force_original_aspect_ratio=decrease,pad=${W0}:${H0}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    return startTask('morph', async (job) => {
      if (!fs.existsSync(out)) {
        const tmp = path.join(dir, `${key}_tmp`); fs.mkdirSync(tmp, { recursive: true });
        // (scd=none: two different shots read as a scene change, and it would jump instead of morphing)
        const mi = `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=none`;
        let r;
        if (b.kind === 'morph') {
          job.stage = 'Making the frames in between…';
          for (const [f, m, t] of [['0.png', A, +b.a.t], ['2.png', B, +b.b.t]]) await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', Math.max(0, t).toFixed(3), '-i', m.path, '-frames:v', '1', '-vf', fit, path.join(tmp, f)]);
          fs.copyFileSync(path.join(tmp, '0.png'), path.join(tmp, '1.png')); fs.copyFileSync(path.join(tmp, '2.png'), path.join(tmp, '3.png'));
          // A, A, B, B - dur apart (minterpolate needs frames either side): every frame from the 2nd to the 3rd is made
          // from their motion, and only that part is kept
          const ms = Math.round(dur * 1000);
          r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-start_number', '0', '-framerate', `1000/${ms}`, '-i', path.join(tmp, '%d.png'),
            '-vf', `${mi},trim=start=${(ms / 1000).toFixed(3)}:end=${((2 * ms) / 1000).toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p`, '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', out]);
        } else {
          job.stage = 'Making the shot carry on…';
          const from = Math.min(dur, Math.max(0.2, +b.from || dur / 2)), t0 = Math.max(0, +b.a.t - from);
          r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', t0.toFixed(3), '-t', from.toFixed(3), '-i', A.path, '-an', '-vf', `${fit},setpts=${(dur / from).toFixed(4)}*PTS,${mi},format=yuv420p`, '-t', dur.toFixed(3), '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', out]);
        }
        fs.rmSync(tmp, { recursive: true, force: true });
        if (r.code !== 0 || !fs.existsSync(out)) { fs.rmSync(out, { force: true }); throw new Error(`Could not make it: ${r.stderr.trim().split(/\r?\n/).pop()}`); }
      }
      const it = addMediaFile(name, out, { bin: b.kind === 'morph' ? 'Morph cuts' : 'Extended', imported: true }) || mediaDb(name).items.find((x) => x.path.toLowerCase() === path.resolve(out).toLowerCase());
      saveMedia(name, true);
      if (activeProject !== name) { activeProject = name; pump(); }
      for (let i = 0; i < 100 && !['ready', 'error'].includes(mediaItem(name, it.id)?.status); i++) await new Promise((ok) => setTimeout(ok, 200));
      return { mediaId: it.id };
    }, { project: name });
  },
  // 🎬 Scene Edit Detection (right-click a clip): where the picture cuts inside a file (a finished video, an old
  // render, a YouTube download) between in and out - FFmpeg's scene change score, on the light preview copy when
  // there is one. Body { mediaId, in, out, threshold? } -> a job whose result is { cuts: [seconds in the file] }
  'POST /api/media/scenes': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), m = mediaItem(name, String(b.mediaId || ''));
    if (!m || m.kind !== 'video') throw err(400, 'Scene Edit Detection works on video clips');
    const px = analysisFile(name, m), src = fs.existsSync(px) ? px : m.path;
    if (!fs.existsSync(src)) throw err(404, 'The file is not there');
    const a = Math.max(0, +b.in || 0), z = Math.min(m.duration || Infinity, +b.out || m.duration || 0), th = Math.min(0.8, Math.max(0.1, +b.threshold || 0.3));
    return startTask('scenes', async (job) => {
      job.stage = `Looking for the cuts in ${m.name}…`;
      const cuts = [];
      const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', a.toFixed(3), '-t', (z - a).toFixed(3), '-i', src, '-an', '-vf', `scale=320:-2,select='gt(scene,${th})',metadata=print:file=-`, '-f', 'null', '-'],
        { onLine: (l) => { const t = /pts_time:([\d.]+)/.exec(l); if (t) { cuts.push(+(a + +t[1]).toFixed(3)); job.progress = Math.min(99, Math.round((+t[1] / Math.max(0.1, z - a)) * 100)); } } });
      if (r.code !== 0) throw new Error(`Could not read the video: ${r.stderr.trim().split(/\r?\n/).pop()}`);
      // (two cuts closer than half a second are one flash / one cut)
      return { cuts: cuts.filter((t, i) => t > a + 0.2 && t < z - 0.2 && (i === 0 || t - cuts[i - 1] > 0.5)) };
    }, { project: name });
  },
  // 🎞 Interpret Footage (Media, right-click): play a file as if it had another frame rate - 50 fps footage as 25 is
  // smooth 2x slow motion. Body { ids, fps } (fps 0 = as it was shot). The clips of these files on the timelines get
  // the matching speed in the browser (mediapool.js); here it is remembered on the file (m.interpretFps).
  'POST /api/media/interpret': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), ids = new Set(b.ids || []), fps = +b.fps || 0;
    let n = 0;
    for (const m of mediaDb(name).items) if (ids.has(m.id) && m.kind === 'video') { if (fps > 0) m.interpretFps = +fps.toFixed(3); else delete m.interpretFps; n++; }
    saveMedia(name, true);
    return { changed: n };
  },
  // ✂ Subclip (Premiere's Make Subclip, Ctrl+U): a part of a file (its Source In..Out) as its own item in Media - the
  // same file (nothing copied), shown and played through its file's thumbnails / preview copy (publicMedia), put on the
  // timeline with that part. Body { mediaId, in, out, name? } -> the new item
  'POST /api/media/subclip': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), db = mediaDb(name);
    const par0 = db.items.find((x) => x.id === b.mediaId), par = par0?.subOf ? db.items.find((x) => x.id === par0.subOf) : par0;
    if (!par || !['video', 'audio'].includes(par.kind)) throw err(400, 'Open a video or sound file in the Source monitor first');
    const a = Math.max(0, +b.in || 0), z = Math.min(par.duration || Infinity, +b.out || 0);
    if (!(z - a > 0.04)) throw err(400, 'Mark an In and an Out in the Source monitor first');
    const n = String(b.name || '').trim().slice(0, 120) || `${par.name.replace(/\.[^.]+$/, '')} - Subclip ${db.items.filter((x) => x.subOf === par.id).length + 1}`;
    const it = { ...JSON.parse(JSON.stringify(par)), id: crypto.randomBytes(6).toString('hex'), name: n, subOf: par.id, subIn: +a.toFixed(3), subOut: +z.toFixed(3), imported: false, bin: par.bin || '', added: Date.now() };
    delete it.tags; delete it.people; delete it.label;
    db.items.push(it); saveMedia(name, true);
    return publicMedia(name, it);
  },
  // 🏷 Colour label on files in Media (like Premiere's labels): Body { ids, label: '#hex' | '' }
  'POST /api/media/label': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), ids = new Set(b.ids || []), lab = /^#[0-9a-f]{6}$/i.test(b.label || '') ? b.label : '';
    let n = 0;
    for (const m of mediaDb(name).items) if (ids.has(m.id)) { if (lab) m.label = lab; else delete m.label; n++; }
    saveMedia(name, true);
    return { labelled: n };
  },
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
  // 🔗 client review links (?proj=, not ?p=: the links are kept by the main process, not by a project's worker)
  'GET /api/clientreview': (req, res, u) => {
    const name = needProject(q(u, 'proj'));
    return { door: !!teamServer, links: reviews.ofProject(name).map((l) => ownerView(l, reviewUrl(l))).reverse() };
  },
  // body { render, title, client, password, days } = a new link; { render, link } = the next version on that link
  'POST /api/clientreview': async (req, res, u) => {
    const name = needProject(q(u, 'proj')), b = await readJson(req), f = renderPath(P(name, 'renders'), b.render);
    if (!f || !fs.existsSync(f)) throw err(400, 'Pick a finished video (Renders)');
    let l = null;
    if (b.link) { l = reviews.byId(b.link); if (!l || l.project !== name) throw err(404, 'That review link is gone'); reviews.addVersion(l, b.render); }
    else l = reviews.create({ project: name, render: b.render, title: b.title, client: b.client, password: b.password, days: b.days, by: req.who?.name });
    return ownerView(l, reviewUrl(l));
  },
  // the team answers a client's comment (shown on the review page)
  'POST /api/clientreview/reply': async (req, res, u) => {
    const name = needProject(q(u, 'proj')), b = await readJson(req), l = reviews.byId(b.link), text = cleanText(b.text);
    const parent = l?.project === name && l.comments.find((c) => c.id === b.parent && !c.parent);
    if (!parent) throw err(404, 'That comment is gone');
    if (!text) throw err(400, 'Write a reply first');
    const c = { id: newId(), v: parent.v, t: parent.t, text, by: cleanName(req.who?.name === 'Owner' ? 'Limelight' : req.who?.name) || 'Limelight', at: Date.now(), parent: parent.id, draw: null, team: true };
    l.comments.push(c); reviews.save();
    return ownerView(l, reviewUrl(l));
  },
  // body { link, off, password ('' = none), days } - turn a link off / on, change its password or expiry; { link, remove }
  'POST /api/clientreview/edit': async (req, res, u) => {
    const name = needProject(q(u, 'proj')), b = await readJson(req), l = reviews.byId(b.link);
    if (!l || l.project !== name) throw err(404, 'That review link is gone');
    if (b.remove) { reviews.links = reviews.links.filter((x) => x !== l); reviews.save(); return { removed: true }; }
    if (b.off !== undefined) l.off = !!b.off;
    if (b.password !== undefined) l.pw = b.password ? rvHashPw(b.password) : null;
    if (b.days !== undefined) l.expires = +b.days > 0 ? Date.now() + Math.min(365, +b.days) * 864e5 : null;
    reviews.save();
    return ownerView(l, reviewUrl(l));
  },
  // what clients said since a moment (every project) - the editor shows a toast
  'GET /api/clientreview/news': (req, res, u) => rvNews.filter((x) => x.at > (+q(u, 'since') || 0)),
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
    const base = safeName(b.filename || pj.name || name), into = saveToDir(req.who, b.saveTo) || P(name, 'output'); // (📁 Save to)
    let v = 1; while (fs.existsSync(path.join(into, `${base} v${v}`))) v++;
    const folder = `${base} v${v}`, outDir = path.join(into, folder);
    const color = ['lut', 'bake'].includes(b.color) ? b.color : 'none', luts = lutMap(name);
    // 📦 collect: copy the media into the export folder so the XML works on another computer (b.collect: full | trim)
    const collect = ['full', 'trim'].includes(b.collect) ? b.collect : 'none';
    const make = (graded = {}, media = byId, extra = {}) => ({ ...exportTimeline({ project: pj, media, outDir, base: `${base}_v${v}`, color, luts, graded, collect,
      subtitlesPath: pj.subtitles?.file ? P(name, 'subs', path.basename(pj.subtitles.file)) : null }), folder, path: outDir, color, collect, ...extra });
    if (color !== 'bake' && collect === 'none') return make();
    const all = Object.keys(pj.tracks).flatMap((t) => pj.tracks[t].map((c) => ({ c, video: t[0] === 'V' })));
    // 🎞 the film look (Settings > LUT, with its mix) is baked into every clip too, and so are the cut effects that are a
    // brightness change (flash, strobe) - the rest of the cut effects stay a note in the README
    const lk = pj.settings?.look || {}, lookLut = color === 'bake' && lk.lut && luts[lk.lut] && fs.existsSync(luts[lk.lut]) ? luts[lk.lut] : null;
    const cutBake = (c) => color === 'bake' && ['flash', 'strobe'].includes(c.cutFx?.type) && cutFxDur(c) > 0.04;
    const needsBake = (c) => color === 'bake' && ((c.color && !isNeutral(c.color)) || lookLut || cutBake(c));
    // clips rendered into new files (1 s handles each side): graded ones when the colour is baked in; with 'trim', every
    // video clip (without colour unless baked) - ProRes, so any editor reads them and they cut frame-exact
    const todo = all.filter(({ c, video }) => video && c.type === 'video' && byId[c.mediaId] && (collect === 'trim' || needsBake(c))).map((x) => x.c);
    return startTask(collect !== 'none' ? 'xml-collect' : 'xml-graded', async (job) => {
      const mdir = path.join(outDir, 'Media'), gdir = collect !== 'none' ? mdir : path.join(outDir, `${base}_v${v} graded`), work = fs.mkdtempSync(path.join(P(name, 'cache'), 'grade-'));
      fs.mkdirSync(gdir, { recursive: true });
      const graded = {}, missing = [];
      const share = collect === 'full' ? 0.3 : 0.9; // of the progress bar: rendering vs copying
      for (const [k, c] of todo.entries()) {
        const m = byId[c.mediaId], dur = m.duration || 0, start = Math.max(0, (+c.in || 0) - 1), end = Math.min(dur, (c.out ?? dur) + 1);
        if (!fs.existsSync(m.path)) { missing.push(m.name); continue; }
        const bake = needsBake(c), stage = stager(work);
        const file = path.join(gdir, `${String(k + 1).padStart(3, '0')}_${safeName(path.parse(m.name).name).slice(0, 40)}.mov`);
        job.stage = `${bake ? 'Colouring' : 'Cutting out'} clip ${k + 1} of ${todo.length}: ${m.name}`; job.log.push(job.stage); job.progress = Math.round((k / todo.length) * 95 * share);
        // the same order as the render: clip grade, then the film look over it, then the cut effect at the clip's start
        const g = [`[0:v]${(bake ? colorFilters(c.color, { luts, stage }) : []).join(',') || 'null'}[c0]`];
        let cur = 'c0';
        if (bake && lookLut) {
          const mixK = Math.min(1, Math.max(0, lk.mix ?? 1)), f = `lut3d=file=${stage(lookLut)}:interp=tetrahedral`;
          g.push(mixK >= 0.99 ? `[c0]${f}[c1]` : `[c0]split[la][lb];[lb]${f}[lc];[la][lc]blend=all_mode=normal:all_opacity=${mixK.toFixed(2)}[c1]`);
          cur = 'c1';
        }
        const cut = bake && cutBake(c);
        if (cut) {
          // t counts from the start of the handle; the clip (and its effect) starts at its In point, d in source seconds
          const t0 = ((+c.in || 0) - start).toFixed(3), d = (cutFxDur(c) * (c.speed || 1)).toFixed(3);
          const kx = `if(lt(t,${t0}),0,max(0,1-(t-${t0})/${d}))`;
          g.push(c.cutFx.type === 'flash'
            ? `[${cur}]eq=brightness='0.85*pow(${kx},1.5)':contrast='1-0.5*${kx}':eval=frame[c2]`
            : `[${cur}]eq=brightness='if(between(t,${t0},${t0}+${d}),if(mod(floor((t-${t0})*20),2),0.6,-0.45),0)':eval=frame[c2]`);
          cur = 'c2';
        }
        g.push(`[${cur}]null[vout]`);
        const r = await run('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', '-ss', String(start), '-t', String(end - start), '-i', m.path, '-filter_complex', g.join(';'), '-map', '[vout]', '-map', '0:a?',
          '-c:v', 'prores_ks', '-profile:v', bake ? '2' : '1', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', file], { cwd: work });
        if (r.code !== 0) { job.log.push(`  failed: ${r.stderr.trim().split(/[\r\n]+/).pop()} - this clip keeps the original file`); continue; }
        graded[c.id] = { file, start, duration: end - start, cut };
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
    const dir = P(needProject(q(u, 'p')), 'output');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs, files: fs.readdirSync(path.join(dir, e.name)).filter((f) => !fs.statSync(path.join(dir, e.name, f)).isDirectory()) }))
      .sort((a, b) => b.mtime - a.mtime);
  },
  // ⬇ an exported timeline folder as one .zip, streamed to whoever asks - so every PC can keep it on its own disk
  // (Windows' own tar.exe writes the zip; videos are stored, not re-compressed, so it starts at once)
  'GET /api/export/zip': (req, res, u) => {
    const name = needProject(q(u, 'p')), folder = path.basename(String(q(u, 'name') || '')), dir = P(name, 'output');
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

  // 🧪 Auto QC (Phase 22, engine/qc.mjs): a finished render (b.file) or, without one, a fast preview of the edit is checked
  // for black holes, a stuck picture, flashing, broadcast-safe colour, loudness / peaks for the channel (b.target), and -
  // with b.spell - the spelling of every title (Claude). The report is kept next to the render (renders/<file>.qc.json).
  'POST /api/qc': async (req, res, u) => {
    const name = needProject(q(u, 'p'));
    const b = await readJson(req);
    const target = QC.TARGETS[b.target] ? b.target : 'youtube';
    let file = null, jobFile = null, out = null;
    if (b.file) { file = P(name, 'renders', path.basename(String(b.file))); if (!fs.existsSync(file)) throw err(404, 'That render is not there any more'); }
    else ({ jobFile, out } = prepareRender(name, { ...b, preview: true }));
    const pj = normalizeProject(b.project || readJSON(P(name, 'project.json')));
    const byId = Object.fromEntries(mediaDb(name).items.map((m) => [m.id, m]));
    const titles = Object.values(placed(pj, byId)).flat().filter((x) => x.clip.type === 'title' && String(x.clip.text || '').trim()).map((x) => ({ text: String(x.clip.text).trim(), t: +x.start.toFixed(2) }))
      .sort((x, y) => x.t - y.t).filter((x, i, a) => a.findIndex((y) => y.text === x.text) === i).slice(0, 120);
    return startTask('qc', async (job) => {
      if (!file) {
        job.stage = 'Making a preview of the edit…'; job.progress = 2;
        const r = await run(process.execPath, [path.join(ROOT, 'engine', 'render2.mjs'), jobFile], { onLine: (l) => { const m = /\[(\d+)\/(\d+)\]/.exec(l); if (m) job.progress = Math.round((+m[1] / +m[2]) * 45); } });
        if (r.code !== 0) throw new Error(`Preview failed: ${r.stderr.slice(-300)}`);
        file = P(name, 'renders', out);
      }
      const base = job.progress, span = (b.spell && titles.length ? 82 : 98) - base;
      job.stage = 'Checking every frame and the sound…';
      const a = await QC.analyze(file, (pc) => (job.progress = Math.round(base + (pc * span) / 100)));
      let rep = QC.qcReport(a, { target, aspect: pj.settings?.aspect });
      if (b.spell && titles.length) {
        job.stage = `Checking the spelling of ${titles.length} title${titles.length > 1 ? 's' : ''}…`; job.progress = Math.max(job.progress, 85);
        const exe = claudeExe();
        const ans = exe ? await claudeAsk(exe, QC.spellPrompt(titles), CLAUDE_BACKUP(), job) : { ok: false };
        rep = QC.addSpelling(rep, titles, ans.ok ? ans.text : '');
      } else if (b.spell) rep.items.push({ level: 'ok', kind: 'spell', text: '✍ No titles to check' });
      rep = { ...rep, file: path.basename(file), preview: !b.file, dur: a.info.dur, size: `${a.info.w}×${a.info.h}`, at: Date.now() };
      if (b.file) try { writeJSON(`${file}.qc.json`, rep); } catch {}
      return rep;
    }, { project: name });
  },
  'GET /api/qc': (req, res, u) => {
    const f = P(needProject(q(u, 'p')), 'renders', `${path.basename(q(u, 'file') || '')}.qc.json`);
    return fs.existsSync(f) ? readJSON(f) : null;
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

  // ---------------- 🌐 translate captions (CC panel "Translate to…" makes a new caption track) ----------------
  // { to: 'en' | 'hi' | 'hinglish', from?, lines: [text] } -> job; result { lines: [text] } in the same order, so the
  // new track keeps every timing. Claude (the Assistant's copy, one turn, no tools) translates 40 lines at a time.
  'POST /api/captions/translate': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    const lines = Array.isArray(b.lines) ? b.lines.map((x) => String(x ?? '').slice(0, 500)) : [];
    if (!lines.length) throw err(400, 'No caption lines to translate');
    if (lines.length > 5000) throw err(400, 'Too many caption lines (5000 at most)');
    const to = String(b.to || ''), from = String(b.from || '');
    if (!CAPTION_LANGS[to]) throw err(400, 'Translate to English, Hindi or Hinglish');
    const exe = claudeExe();
    if (!exe) throw err(400, 'Claude is not on this computer - translating captions needs it (install the Claude app)');
    return startTask('translate', async (job) => {
      const out = [], N = 40;
      for (let i = 0; i < lines.length; i += N) {
        if (job.stopped) throw new Error('Stopped');
        const part = lines.slice(i, i + N);
        job.stage = `Lines ${i + 1}-${i + part.length} of ${lines.length}`;
        out.push(...(await translateBatch(exe, part, to, from, job)));
        job.progress = Math.round(((i + part.length) / lines.length) * 100);
      }
      return { lines: out, to };
    }, { project: name });
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
    const seq = claudeSeq(name, b.seq);
    if (seq && !liveOf(name).pj.sequences?.[seq]) throw err(400, 'That sequence no longer exists');
    // one Claude at a time per sequence; people on other sequences of the same project can ask theirs meanwhile
    if ([...jobs.values()].some((j) => j.kind === 'claude' && j.status === 'running' && j.project === name && (j.seq || '') === seq)) throw err(409, 'Claude is still working on the last message for this sequence - wait or press Stop');
    const job = claudeChat(name, b.message, !!b.reset, req.who, seq);
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
  'POST /api/claude/new': (req, res, u) => { const name = needProject(q(u, 'p')); fs.rmSync(claudeSession(name, claudeSeq(name, q(u, 'seq'))), { force: true }); return { ok: true }; },
  // 🗂 an earlier chat opened in the Assistant: Claude carries on in that conversation (no id: a fresh one)
  'POST /api/claude/use': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), f = claudeSession(name, claudeSeq(name, q(u, 'seq')));
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
  // 🛡 an error in someone's editor, written down here (logs/client-errors.log) so it can be found and fixed
  'POST /api/clientlog': async (req) => {
    const b = await readJson(req).catch(() => ({}));
    const line = JSON.stringify({ at: new Date().toISOString(), who: req.who?.name || 'Owner', ...Object.fromEntries(['where', 'msg', 'stack', 'project', 'page', 'ua'].map((k) => [k, String(b[k] ?? '').slice(0, 3000)])) });
    try {
      const f = path.join(DATA, 'logs', 'client-errors.log');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (fs.existsSync(f) && fs.statSync(f).size > 5e6) fs.renameSync(f, `${f}.old`);
      fs.appendFileSync(f, `${line}\n`);
    } catch {}
    return { ok: true };
  },
  'GET /api/clientlog': (req, res, u) => { const f = path.join(DATA, 'logs', 'client-errors.log'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').slice(-(+q(u, 'n') || 50)).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []; },
  // 🔊 Audio gain › Normalize: the loudest moment (dB below full scale) of a clip's part of its file
  'GET /api/audio/peak': async (req, res, u) => {
    const name = needProject(q(u, 'p')), m = mediaItem(name, q(u, 'id'));
    if (!m) throw err(404, 'media not found');
    if (m.kind === 'video' && !m.hasAudio) throw err(400, 'This clip has no sound');
    const file = analysisFile(name, m), tin = +q(u, 'in') || 0, tout = +q(u, 'out') || 0;
    const r = await run('ffmpeg', ['-hide_banner', '-nostats', ...(tin ? ['-ss', String(tin)] : []), ...(tout > tin ? ['-t', String(tout - tin)] : []), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(r.stderr)?.[1];
    if (peak === undefined) throw err(400, 'Could not measure this clip');
    return { peak: +peak };
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
  // ▱ Planar tracking (Phase 22, engine/planar.py): body { mediaId, ts, t0, te, quad: [x0, y0, x1, y1, x2, y2, x3, y3] }
  // (seconds in the file: the shot's start, the drawn frame, its end; corners TL, TR, BL, BR as fractions of the picture).
  // Result { points: [{ t, q }], lost: [t] } - read from the preview copy when there is one (same picture, smaller).
  'POST /api/planar': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req), m = mediaItem(name, b.mediaId);
    if (!m || m.kind !== 'video') throw err(400, 'Planar tracking needs a video shot');
    const qd = (Array.isArray(b.quad) ? b.quad : []).map(Number);
    if (qd.length !== 8 || qd.some((v) => !(v >= 0 && v <= 1))) throw err(400, 'Click the four corners of the surface');
    const dur = m.duration || 1e9, t0 = Math.min(dur, Math.max(0, +b.t0 || 0)), ts = Math.max(0, Math.min(t0, +b.ts || 0)), te = Math.max(t0, Math.min(dur, +b.te || dur));
    if (te - ts > 300) throw err(400, 'That shot is longer than 5 minutes - cut it shorter first');
    return startTask('track', async (job) => {
      job.stage = 'Tracking the surface through the shot…'; job.progress = 10;
      const r = await run(PYTHON, [path.join(ROOT, 'engine', 'planar.py'), analysisFile(name, m), String(ts), String(t0), String(te), ...qd.map(String), '--fps', '25']);
      if (r.code !== 0) throw new Error(`Planar tracking failed: ${r.stderr.slice(-300)}`);
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
    // an English / Urdu voice given Hindi (Devanagari) text reads only the numbers in it - say so instead
    const deva = (String(b.text).match(/[ऀ-ॿ]/g) || []).length, latin = (String(b.text).match(/[A-Za-z]/g) || []).length;
    if ((b.provider || 'edge') === 'edge' && deva > latin * 0.3 && !/^(hi|mr|ne)-/i.test(String(b.voice || '')))
      throw err(400, `${String(b.voice || 'This voice').split('-').pop().replace('Neural', '')} cannot read Hindi (Devanagari) text - pick a Hindi voice (hi-IN: Swara, Madhur)`);
    if (b.provider === 'clone') return cloneVoiceOver(name, b, deva > latin * 0.3 ? 'hi' : 'en');
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
    { const all = lines.map((l) => l.text).join(' '), d = (all.match(/[ऀ-ॿ]/g) || []).length, l = (all.match(/[A-Za-z]/g) || []).length;
      if ((b.provider || 'edge') === 'edge' && d > l * 0.3 && !/^(hi|mr|ne)-/i.test(String(b.voice || ''))) throw err(400, 'That voice cannot read Hindi (Devanagari) lines - pick a Hindi voice (hi-IN: Swara, Madhur)'); }
    return startTask('dub', async (job) => {
      const { speak } = await import(`./engine/voices.mjs?v=${Math.round(fs.statSync(path.join(ROOT, 'engine', 'voices.mjs')).mtimeMs)}`);
      const wd = fs.mkdtempSync(P(name, 'cache', 'dub-')), parts = [];
      try {
        // 🧬 same voice (Phase 22): a sample of the speaker (up to 15 s from where they talk), then every line at once
        let cloned = null;
        if (b.provider === 'clone') {
          const m = mediaItem(name, b.mediaId);
          if (!m) throw new Error('The clip to take the voice from is missing');
          if (!aiVoiceReady()) throw new Error('Same-voice AI is not set up yet - press "Set up same-voice AI" on the Labs page first');
          // (the lines' times are seconds in the clip's own file - they come from its transcript)
          const s0 = Math.max(0, Math.min(...lines.map((l) => +l.start))), s1 = Math.min(s0 + 15, Math.max(...lines.map((l) => +l.end)));
          const ref = path.join(wd, 'speaker.wav');
          job.stage = 'Listening to the speaker\'s voice…'; job.progress = 3;
          const rr = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', s0.toFixed(3), '-t', Math.max(3, s1 - s0).toFixed(3), '-i', m.path, '-vn', '-ac', '1', '-ar', '24000', ref]);
          if (rr.code !== 0) throw new Error(`Could not take the voice sample: ${rr.stderr.slice(-200)}`);
          const jf = path.join(wd, 'clone.json');
          cloned = lines.map((l, k) => path.join(wd, `l${k}.wav`));
          writeJSON(jf, { ref, lang: b.lang || 'hi', lines: lines.map((l, k) => ({ text: l.text, out: cloned[k] })) });
          const r = await run(AIVOICE_PY, [path.join(ROOT, 'engine', 'voiceclone.py'), jf], { onLine: (x) => { const p = /^PROGRESS (\d+) (.*)/.exec(x); if (p) { job.progress = Math.round(+p[1] * 0.85); job.stage = `🧬 ${p[2]}…`; } } });
          const out = (() => { try { return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch { return { error: r.stderr.slice(-300) || 'the voice model stopped' }; } })();
          if (out.error) throw new Error(`Same-voice AI: ${out.error}`);
        }
        for (const [k, l] of lines.entries()) {
          job.stage = cloned ? 'Fitting the lines to the timing…' : `Speaking line ${k + 1}/${lines.length}…`; if (!cloned) job.progress = Math.round((k / lines.length) * 85);
          const f = cloned ? cloned[k] : path.join(wd, `l${k}.mp3`);
          if (!cloned) await speak({ provider: b.provider || 'edge', voice: b.voice, text: l.text, rate: +b.rate || 0, out: f, python: PYTHON, key: config().elevenlabs });
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
  // 🌐 dub lines into any language (Claude): short enough to be spoken in the same time as the original. { texts, to, from }
  'POST /api/dub/translate': async (req, res, u) => {
    const name = needProject(q(u, 'p')), b = await readJson(req);
    const texts = (Array.isArray(b.texts) ? b.texts : []).map((x) => String(x ?? '').slice(0, 600));
    const to = String(b.to || '').slice(0, 40), from = String(b.from || '').slice(0, 40);
    if (!texts.length || !to) throw err(400, 'Nothing to translate');
    const exe = claudeExe();
    if (!exe) throw err(400, 'Claude is not on this computer - translating needs it');
    return startTask('translate', async (job) => {
      const out = [];
      for (let i = 0; i < texts.length; i += 40) {
        const part = texts.slice(i, i + 40);
        job.stage = `Lines ${i + 1}-${i + part.length} of ${texts.length}`;
        const r = await claudeAsk(exe, `${translatePrompt(part, to, from)}\n\nThese lines will be DUBBED (spoken by a voice in place of the original): keep each about as long to say as the original line, natural spoken ${to}, written in its own script.`, CLAUDE_BACKUP(), job);
        const got = r.ok && parseTranslation(r.text, part.length);
        if (!got) throw new Error(r.ok ? 'Claude gave back a different number of lines - try again' : r.text);
        out.push(...got); job.progress = Math.round(((i + part.length) / texts.length) * 100);
      }
      return { lines: out, to };
    }, { project: name });
  },
  // 🧬 the same-voice model lives in its own Python (tools/aivoice/venv); set up once per computer
  'GET /api/aivoice': () => ({ ready: aiVoiceReady(), setting: aiVoiceSetup?.status === 'running' ? { id: aiVoiceSetup.id, stage: aiVoiceSetup.stage } : null }),
  'POST /api/aivoice/setup': (req) => {
    if (req.who && req.who.role !== 'owner' && !req.who.local) throw err(403, 'Only the owner can install the AI voice');
    if (aiVoiceSetup?.status === 'running') return aiVoiceSetup;
    aiVoiceSetup = startTask('setup', async (job) => {
      const venv = path.join(ROOT, 'tools', 'aivoice', 'venv');
      const step = async (stage, pct, cmd, args) => { job.stage = stage; job.progress = pct; const r = await run(cmd, args, { onLine: (l) => job.log.push(l.slice(0, 200)) }); if (r.code !== 0) throw new Error(`${stage} failed: ${r.stderr.slice(-400)}`); };
      if (!fs.existsSync(AIVOICE_PY)) await step('Making its own Python…', 2, PYTHON, ['-m', 'venv', venv]);
      await step('Downloading PyTorch for the GPU (~2.5 GB)…', 10, AIVOICE_PY, ['-m', 'pip', 'install', 'torch==2.6.0', 'torchaudio==2.6.0', '--index-url', 'https://download.pytorch.org/whl/cu124']);
      await step('Installing the voice model…', 60, AIVOICE_PY, ['-m', 'pip', 'install', 'chatterbox-tts==0.1.7']);
      job.stage = 'Ready'; return { ready: aiVoiceReady() };
    });
    return aiVoiceSetup;
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
        const { jobFile, out } = prepareRender(x.project, { preset: 'reel', filename: x.project, tag: false, whole: true });
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
  'GET /api/jobs': async () => [...[...jobs.values()].filter((j) => j.status === 'running').map(({ log, proc, events, ...j }) => j), ...(await workerStates()).flatMap((w) => w.jobs || [])],
};

// ---------------- ⚙ project workers: routing, the worker side, starting them ----------------
// Requests about a project that still belong to the main process: they use the render queue, publish / batch, the
// people library, project places / folders or the sessions log (shared by all projects). The project's worker saves
// first (flush), so what is read from disk is the latest; delete / move ask the worker to let go of it (release).
const MAIN_ROUTES = new Set(['POST /api/projects/move', 'POST /api/projects/delete', 'GET /api/presence', 'POST /api/queue', 'POST /api/publish', 'POST /api/styles/learn',
  'POST /api/library/template', 'GET /api/batch', 'POST /api/batch', 'POST /api/batch/cancel', 'POST /api/batch/clear']);
const JOB_ROUTES = /^\/api\/(job|jobs\/skip|claude\/events|claude\/stop)$/;
// which worker a request goes to (0 = this main process)
function routeOf(method, u) {
  if (JOB_ROUTES.test(u.pathname)) { const m = /^w(\d+)-/.exec(u.searchParams.get('id') || ''); return { k: m ? +m[1] : 0 }; }
  let p = u.searchParams.get('p');
  const m = /^\/(pm|pf)\/([^/]+)\//.exec(u.pathname); if (m) { try { p = decodeURIComponent(m[2]); } catch { p = null; } }
  if (!p) return { k: 0 };
  if (MAIN_ROUTES.has(`${method} ${u.pathname}`) || u.pathname.startsWith('/api/people')) return { k: 0, flush: p };
  return { k: ownerOf(p) };
}
const fwdAgent = new http.Agent({ keepAlive: true, maxSockets: 512 });
function forward(k, req, res, who) {
  const pr = http.request({ host: '127.0.0.1', port: workerPort(k), method: req.method, path: req.url, agent: fwdAgent,
    headers: { ...req.headers, 'x-vedit-key': CL_KEY, 'x-vedit-who': Buffer.from(JSON.stringify(who)).toString('base64') } }, (wr) => {
    res.writeHead(wr.statusCode, wr.headers); wr.pipe(res);
  });
  pr.on('error', () => { if (!res.headersSent) send(res, 503, { error: 'This project\'s worker is restarting - try again in a few seconds' }); else res.destroy(); });
  res.on('close', () => { if (!res.writableFinished) pr.destroy(); }); // (a closed live stream / player closes the worker's side too)
  req.pipe(pr);
}
// the main process asks a worker something about project p (flush, release, resume) or about itself (state)
async function askWorker(k, what, p = null, timeout = 15000, more = {}) {
  const qs = new URLSearchParams({ ...(p ? { p } : {}), ...more }).toString();
  const r = await fetch(`http://127.0.0.1:${workerPort(k)}/internal/${what}${qs ? `?${qs}` : ''}`, { method: what === 'state' ? 'GET' : 'POST', headers: { 'x-vedit-key': CL_KEY }, signal: AbortSignal.timeout(timeout) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw err(r.status, j.error || `worker ${k}: ${r.status}`);
  return j;
}
const askOwner = (p, what) => (CLUSTER && !IS_WORKER ? askWorker(ownerOf(p), what, p) : Promise.resolve({}));
// a project made / brought back / changed here (main process): what was read here is written now and forgotten, and its
// worker reads it afresh and makes its thumbnails and previews
async function handOver(name) {
  if (!CLUSTER || IS_WORKER) return;
  if (mediaCache.has(name)) { clearTimeout(saveTimers.get(name)); saveMedia(name, true); }
  mediaCache.delete(name);
  try { await askOwner(name, 'resume'); } catch (e) { logCrash('hand over', e); }
}
async function workerStates() {
  if (!CLUSTER || IS_WORKER) return [];
  return Promise.all([...Array(WORKERS)].map((_, i) => askWorker(i + 1, 'state', null, 3000).catch((e) => ({ k: i + 1, down: true, error: e.message }))));
}
// the worker side: /internal/… from the main process only
const INTERNAL = {
  pull: (p, u) => pullProject(p, String(u.searchParams.get('dir') || '')), // (🖥 the standby PC's edits of one of its projects)
  state: () => ({ k: WORKER_K, pid: process.pid, up: Math.round(process.uptime()), lag: healthSeries().now.lag, rss: Math.round(process.memoryUsage().rss / 1048576),
    projects: [...live].map(([name, L]) => ({ name, people: L.subs.size })), queue: quickQ.length + proxyQ.length,
    jobs: [...jobs.values()].filter((j) => j.status === 'running').map(({ log, proc, events, ...j }) => j) }),
  flush: (p) => {
    for (const [name, L] of live) if (!p || name === p) { if (L.timer) liveWrite(name, L, true); }
    for (const name of [...saveTimers.keys()]) if (!p || name === p) { clearTimeout(saveTimers.get(name)); saveMedia(name, true); }
    return { ok: true };
  },
  release: (p) => {
    const L = live.get(p), people = L ? [...new Set([...L.subs.values()].map((x) => x.who.name))] : [];
    if (people.length) throw err(409, `Open right now by ${people.join(', ')} - ask them to close it first`);
    if (projectBusy(p)) throw err(409, 'A job of this project is running - wait for it to finish');
    INTERNAL.flush(p);
    let dir = ''; try { dir = path.resolve(projDir(p)).toLowerCase() + path.sep; } catch {}
    for (const st of openStreams) if (dir && String(st.file || '').toLowerCase().startsWith(dir)) st.destroy();
    live.delete(p); mediaCache.delete(p); offlineChecked.delete(p);
    for (const qq of [quickQ, proxyQ]) for (let i = qq.length - 1; i >= 0; i--) if (qq[i].proj === p) qq.splice(i, 1);
    if (activeProject === p) activeProject = null;
    return { ok: true };
  },
  resume: (p) => {
    if (live.get(p)?.subs.size) { const L = live.get(p); L.mtime = -1; liveOf(p); } else live.delete(p); // (open: everyone switches to the file)
    mediaCache.delete(p); offlineChecked.delete(p);
    if (!fs.existsSync(P(p, 'project.json'))) return { ok: true };
    ensureProjectDirs(p);
    for (const m of mediaDb(p).items) {
      if (m.status !== 'ready' && m.status !== 'offline') { m.status = 'queued'; quickQ.push({ proj: p, id: m.id }); }
      else if (['queued', 'making', 'pending'].includes(m.proxy)) { m.proxy = 'queued'; proxyQ.push({ proj: p, id: m.id }); }
    }
    pump();
    return { ok: true };
  },
};
// main process: start the workers, and again when one stops
const workerProcs = new Map(); // k -> { proc, starts }
let stopping = false;
function startWorker(k) {
  const w = workerProcs.get(k) || { starts: 0 }; workerProcs.set(k, w);
  w.starts++; w.at = Date.now();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VEDIT_WORKER: String(k), VEDIT_WORKERS: String(WORKERS), VEDIT_KEY: CL_KEY, VEDIT_NO_RESUME: '1', UV_THREADPOOL_SIZE: '16' } });
  w.proc = proc;
  const pipe = (s, to) => s.on('data', (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) to.write(`[worker ${k}] ${l}\n`); });
  pipe(proc.stdout, process.stdout); pipe(proc.stderr, process.stderr);
  proc.on('exit', (code) => {
    w.proc = null;
    if (stopping) return;
    logCrash(`project worker ${k}`, `stopped (code ${code}) - starting it again`);
    setTimeout(() => startWorker(k), Date.now() - w.at < 10000 ? 5000 : 500); // (one that keeps failing at once: not in a tight loop)
  });
}
if (CLUSTER && !IS_WORKER) {
  for (let k = 1; k <= WORKERS; k++) startWorker(k);
  const stopAll = () => { stopping = true; for (const w of workerProcs.values()) try { w.proc?.kill(); } catch {} };
  process.on('exit', stopAll);
  console.log(`⚙ ${WORKERS} project workers (ports ${workerPort(1)}-${workerPort(WORKERS)})`);
}

// who: the person asking - the owner on this computer (port 3000), or a team member signed in over the network
async function handle(req, res, who) {
  const u = new URL(req.url, 'http://localhost');
  req.who = who;
  try {
    if (!allowed(who, req.method, u.pathname)) return send(res, 403, { error: who.role === 'viewer' ? 'You can only watch (viewer) - ask the owner for editor rights' : 'Only the owner can do this, on the editing computer' });
    // 🖥 a standby PC runs the editor (or its edits are not back yet): this one only shows - two editors never write
    // the same project
    if (standbyHold && req.method !== 'GET' && !/^\/api\/(safety|me|lock|unlock|clientlog|live\/presence|live\/save|shutdown)(\/|$)/.test(u.pathname))
      return send(res, 423, { error: standbyHold.pending ? `Edits made on the standby PC ${standbyHold.host} are being brought back - try again in a minute` : `The standby PC ${standbyHold.host} is running the editor (since ${new Date(standbyHold.since).toLocaleTimeString()}). Edit there - this editor takes over again about 2 minutes after it is back.` });
    // ⚙ a project's request goes to its worker (the main process keeps no project in memory)
    if (CLUSTER && !IS_WORKER) {
      const r = routeOf(req.method, u);
      if (r.k) return forward(r.k, req, res, who);
      if (r.flush) await askOwner(r.flush, 'flush').catch(() => {});
    }
    const route = routes[`${req.method} ${u.pathname}`];
    if (route) {
      const t0 = performance.now();
      const out = await route(req, res, u);
      if (!res.headersSent) { send(res, 200, out); noteRequest(performance.now() - t0); } // (🩺 streams and files are not timed)
      return;
    }
    // project media: /pm/<project>/<id>/<play|orig|thumb|strip|wave|peaks>
    let m = /^\/pm\/([^/]+)\/([0-9a-f]+)\/(play|orig|thumb|strip|wave|peaks)$/.exec(u.pathname);
    if (req.method === 'GET' && m) {
      const proj = decodeURIComponent(m[1]), it = mediaItem(needProject(proj), m[2]);
      if (!it) return send(res, 404, { error: 'media not found' });
      const C = (d, f) => P(proj, 'cache', d, f);
      if (m[3] === 'peaks') {
        const f = C('waves', `${it.id}.peaks`);
        if (!fs.existsSync(f) && !(it.hasAudio && fs.existsSync(it.path) && (await makePeaks(it.path, f)))) return send(res, 404, { error: 'no sound' });
        return serveFile(req, res, f, true);
      }
      const file = { thumb: C('thumbs', `${it.id}.jpg`), strip: C('strips', `${it.id}.jpg`), wave: C('waves', `${it.id}.png`), orig: it.path,
        play: it.kind === 'video' && it.proxy !== 'none' ? (it.proxy === 'ready' ? C('proxies', `${it.id}.mp4`) : null)
          // over the internet a heavy file plays from its light copy once made (ensureLite); here, the file itself
          : it.lite === 'ready' && !req.who?.local && fs.existsSync(C('proxies', `${it.id}.mp4`)) ? C('proxies', `${it.id}.mp4`) : it.path }[m[3]];
      if (!file) return send(res, 409, { error: 'proxy not ready yet' });
      return serveFile(req, res, file, m[3] !== 'play' && m[3] !== 'orig');
    }
    // project files: /pf/<project>/<renders|subs>/<file>
    m = /^\/pf\/([^/]+)\/(renders|subs|thumbnails|frames)\/(.+)$/.exec(u.pathname);
    if (req.method === 'GET' && m) return serveFile(req, res, P(needProject(decodeURIComponent(m[1])), ...(m[2] === 'thumbnails' || m[2] === 'frames' ? ['output', m[2]] : [m[2]]), path.basename(decodeURIComponent(m[3]))));
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
// ⚙ a project worker: only the main process talks to it (its key), saying who asks; it stops when the main one is gone
if (IS_WORKER) {
  const ws = http.createServer(async (req, res) => {
    if (req.headers['x-vedit-key'] !== CL_KEY) { res.writeHead(403); return res.end(); }
    const u = new URL(req.url, 'http://localhost');
    const m = /^\/internal\/(\w+)$/.exec(u.pathname);
    if (m && INTERNAL[m[1]]) { try { return send(res, 200, await INTERNAL[m[1]](u.searchParams.get('p'), u)); } catch (e) { return send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); } }
    let who = OWNER; try { who = JSON.parse(Buffer.from(String(req.headers['x-vedit-who'] || ''), 'base64').toString('utf8')) || OWNER; } catch {}
    handle(req, res, who);
  });
  let tries = 0;
  ws.on('error', (e) => { if (e.code === 'EADDRINUSE' && ++tries < 30) return setTimeout(() => ws.listen(workerPort(WORKER_K), '127.0.0.1'), 1000); console.error(e); process.exit(1); });
  ws.listen(workerPort(WORKER_K), '127.0.0.1', () => console.log(`project worker ${WORKER_K}/${WORKERS} ready (pid ${process.pid})`));
  const parent = process.ppid;
  setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 5000).unref?.();
}
const server = http.createServer((req, res) => (req.url.startsWith('/review/') ? clientReview(req, res, new URL(req.url, 'http://x')) : handle(req, res, OWNER)));
const listen = () => { if (!IS_WORKER) server.listen(PORT, '127.0.0.1'); };
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
