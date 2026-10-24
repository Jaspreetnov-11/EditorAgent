// vision2.mjs - the agent's eyes, v2 (engine/vision2.py: multilingual SigLIP + YuNet faces + EasyOCR text): per second
// of every clip its shot size, beauty, sharpness, faces, people, text and colour, the clips not to use (screen
// recordings, GPS stamps, sideways, earlier renders, blurry), and Hindi / English words -> the moments that show them.
// One Python worker keeps the model loaded while an agent run lasts; it quits on stopVision() or after 3 idle minutes
// (the GPU is free again for renders and the LLM).
//
// Cache per clip: <project>/cache/vision2/<mediaId>.json (+ .npy, float16 image embeddings, one row per sample).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPeople } from './people.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const V = 1;
const MAX_SAMPLES = 600; // a 40 min YouTube film is looked at every 4 s, not every second (the cache stays small, the run quick)
const IDLE_MS = 3 * 60 * 1000;
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

// ---- where a project is (as server.mjs projDir: Projects/<name>, or the folder project-places.json names) ----
const safeName = (n) => String(n).replace(/[\\/:*?"<>|]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || 'untitled';
export function projectDir(proj, { dataDir } = {}) {
  if (path.isAbsolute(String(proj)) && fs.existsSync(path.join(proj, 'project.json'))) return proj;
  const data = dataDir || (process.env.VEDIT_DATA ? path.resolve(process.env.VEDIT_DATA) : ROOT);
  const projects = path.join(data, 'Projects');
  const at = readJSON(path.join(data, 'project-places.json'), {})[safeName(proj)];
  if (at && !fs.existsSync(path.join(projects, safeName(proj), 'project.json'))) return at;
  return path.join(projects, safeName(proj));
}
export const visionDir = (proj, o = {}) => path.join(o.cacheDir || path.join(projectDir(proj, o), 'cache'), 'vision2');

// media: [item] or { id: item } (media.json items, or the agent's items with proxyPath)
const list = (media) => (Array.isArray(media) ? media : Object.values(media || {})).filter((m) => m && (m.kind === 'video' || m.kind === 'image'));
const proxyOf = (m, cache) => {
  if (m.proxyPath && fs.existsSync(m.proxyPath)) return m.proxyPath;
  const px = path.join(cache, 'proxies', `${m.id}.mp4`);
  return m.proxy === 'ready' && fs.existsSync(px) ? px : null;
};
const stepOf = (m, step) => (m.kind === 'image' ? 0 : Math.max(step, (+m.duration || 0) / MAX_SAMPLES));
// a clip's cache is good while it is newer than the media file (and was made by this version)
function cached(dir, m) {
  const jf = path.join(dir, `${m.id}.json`), t = mtime(jf);
  if (!t || !fs.existsSync(path.join(dir, `${m.id}.npy`)) || t < mtime(m.path)) return null;
  const j = readJSON(jf, null);
  return j?.v === V ? j : null;
}

// ---- the worker ----
let worker = null;
let pythonExe = null;
const python = () => (pythonExe ||= process.env.VEDIT_PYTHON || ['python', 'python3', 'py'].find((b) => spawnSync(b, ['--version']).status === 0) || 'python');
function start() {
  if (worker) { clearTimeout(worker.idle); return worker; }
  const p = spawn(python(), [path.join(ROOT, 'engine', 'vision2.py')], { cwd: ROOT, windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', HF_HOME: process.env.VISION2_HF_HOME || path.join(ROOT, 'Models', 'hf') } });
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
      if (!w.cur) { clearTimeout(w.idle); w.idle = setTimeout(stopVision, IDLE_MS); w.idle.unref?.(); }
    }
  });
  p.stderr.on('data', (d) => {
    const t = String(d); w.err = (w.err + t).slice(-4000);
    for (const m of t.matchAll(/PROGRESS (\d+) ?([^\r\n]*)/g)) w.cur?.onProgress?.(+m[1], m[2]);
  });
  const fail = (e) => {
    for (const c of [w.cur, ...w.waiting].filter(Boolean)) c.bad(new Error(`The picture model stopped: ${e || w.err.trim().split(/\r?\n/).filter((l) => !l.startsWith('PROGRESS')).pop() || 'unknown error'}`));
    w.cur = null; w.waiting = [];
    if (worker === w) worker = null;
  };
  p.on('error', (e) => fail(String(e)));
  p.on('close', () => fail());
  worker = w;
  return w;
}
// frees the GPU: the worker quits (killed if it does not within 5 s)
export function stopVision() {
  const w = worker;
  if (!w) return;
  worker = null;
  clearTimeout(w.idle);
  try { w.p.stdin.write('{"cmd":"quit"}\n'); w.p.stdin.end(); } catch {}
  setTimeout(() => { try { w.p.kill(); } catch {} }, 5000).unref?.();
}

// ---- people (faces from the existing people.py / Smart scan) ----
// clips people.py has not looked at yet (its per-clip cache: cache/agent/people/<id>.npz)
export function needsPeople(proj, media, o = {}) {
  const dir = path.join(o.cacheDir || path.join(projectDir(proj, o), 'cache'), 'agent', 'people');
  return list(media).filter((m) => !fs.existsSync(path.join(dir, `${m.id}.npz`)));
}
// who is seen at each sample: a person counts at a sample when people.py saw their face within half a step of it
// (people.py looks every max(1, dur / 40) s, so its own step decides too). Names when named, else the key ("p3").
function addPeople(j, id, pdata) {
  const who = (pdata.people || []).filter((p) => p.media?.[id]?.length);
  const tol = Math.max(j.step || 1, Math.max(1, (j.dur || 0) / 40)) / 2 + 0.01;
  for (const s of j.samples) s.people = who.filter((p) => p.media[id].some((t) => Math.abs(t - s.t) <= tol)).map((p) => p.name || p.key);
  return j;
}

// the cached vision of these clips (people filled in), without running anything: { id: json }
export function loadVision(proj, mediaIds, o = {}) {
  const dir = visionDir(proj, o), pdata = loadPeople(path.dirname(dir));
  const out = {};
  for (const id of mediaIds) { const j = readJSON(path.join(dir, `${id}.json`), null); if (j?.v === V) out[id] = addPeople(j, id, pdata); }
  return out;
}

// Looks at every clip that has no (fresh) vision2 cache yet; returns { mediaId: json } for all of them, people filled in.
// o: { onProgress(pct 0..100, msg, { done, total, id }), dataDir, cacheDir (instead of proj's), step (s, default 1),
//      force, skips() (> 0: stop and return what is done), lookPeople(items) (the server's Smart people scan: awaited
//      first for the clips people.py has not seen), debug }
export async function analyzeVision(proj, media, o = {}) {
  const dir = visionDir(proj, o), cache = path.dirname(dir);
  fs.mkdirSync(dir, { recursive: true });
  const all = list(media), out = {}, todo = [];
  for (const m of all) {
    const c = !o.force && cached(dir, m);
    if (c) out[m.id] = c;
    else if (fs.existsSync(m.path) || proxyOf(m, cache)) todo.push(m);
  }
  const prog = (pct, msg, x) => { try { o.onProgress?.(Math.round(pct), msg, x); } catch {} };
  // faces first (the existing people scan) - it is quick for clips it has seen, and the samples name the people
  if (o.lookPeople) {
    const need = needsPeople(proj, all, o);
    if (need.length) {
      prog(0, `Finding the people in ${need.length} clip${need.length > 1 ? 's' : ''}…`, { done: 0, total: todo.length });
      try { await o.lookPeople(need); } catch (e) { prog(0, `Could not find the people: ${e.message}`, { done: 0, total: todo.length }); }
    }
  }
  // proxies first (small files), camera originals last; the long ones by length
  todo.sort((a, b) => (proxyOf(a, cache) ? 0 : 1) - (proxyOf(b, cache) ? 0 : 1) || (a.duration || 0) - (b.duration || 0));
  const total = todo.length;
  const errors = {};
  for (let k = 0; k < todo.length; k++) {
    if ((o.skips?.() || 0) > 0) break;
    const m = todo[k], px = proxyOf(m, cache), step = stepOf(m, o.step || 1);
    // no proxy and a 4K camera original or a very long film: only its keyframes are decoded (1080p H.264 decodes at
    // ~50x real time, so the rest are read whole - every sample a real frame)
    const keyOnly = !px && m.kind === 'video' && ((+m.duration || 0) > 600 || (m.width || 0) * (m.height || 0) > 1920 * 1088);
    const req = { cmd: 'analyze', id: m.id, path: m.path, proxy: px, orig: m.path, dur: +m.duration || 0, step, image: m.kind === 'image', keyOnly,
      out: path.join(dir, `${m.id}.json`), npy: path.join(dir, `${m.id}.npy`), embRel: `cache/vision2/${m.id}.npy`, debug: !!o.debug };
    prog((100 * k) / total, `Looking at the pictures… ${k + 1}/${total}`, { done: k, total, id: m.id });
    try {
      out[m.id] = await start().send(req, (p) => prog((100 * (k + p / 100)) / total, `Looking at the pictures… ${k + 1}/${total}`, { done: k, total, id: m.id }));
    } catch (e) {
      errors[m.id] = e.message; // one unreadable clip must not stop the rest (the planner falls back for it)
      if (/stopped/.test(e.message)) worker = null;
    }
  }
  if (total) prog(100, 'Pictures looked at', { done: total, total });
  const pdata = loadPeople(cache);
  for (const [id, j] of Object.entries(out)) addPeople(j, id, pdata);
  if (Object.keys(errors).length) Object.defineProperty(out, 'errors', { value: errors, enumerable: false });
  return out;
}

// Hindi / English lines -> { lineIndex: { mediaId: [ { t, sim } ] } }, sim z-scored per line over every sample of
// these clips (only clips analyzeVision has looked at count; the others are left out)
export async function textScores(proj, lines, mediaIds, o = {}) {
  const dir = visionDir(proj, o);
  const ids = (mediaIds || []).filter((id) => fs.existsSync(path.join(dir, `${id}.npy`)) && fs.existsSync(path.join(dir, `${id}.json`)));
  if (!lines?.length || !ids.length) return {};
  const r = await start().send({ cmd: 'text', lines: lines.map((l) => String(l ?? '')), ids, dir });
  return r.scores || {};
}

// the worker's device and GPU memory (for checks): { dev, peakMB, reservedMB } or null when it is not running
export const visionInfo = () => (worker ? worker.send({ cmd: 'ping' }) : Promise.resolve(null));
