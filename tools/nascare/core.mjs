// core.mjs - Limelight NAS Care: the scanner, the duplicate and unused-file reports, the safe bin, the folder organiser
// and the health checks. Safety rules that everything here keeps:
//  - nothing is ever deleted by a report or a clean-up: files are RENAMED into "<share>\_NAS Care Bin\<batch>\..." on the
//    same share (an instant server-side move, no copy, no extra space) and every batch can be put back from its manifest
//  - a file is never copied between shares (a rename that would need a copy is refused)
//  - NAS system folders (@Recycle, @Recently-Snapshot, .@__thumb, #recycle...), protected folders, files changed in the
//    last few days and files used by editor / Premiere / After Effects projects are never touched
//  - duplicates are checked byte-for-byte (full SHA-256) right before they move; a file that changed since the scan stays
//  - reading is throttled and pauses while the editor is rendering, so the NAS keeps serving the team first
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import readline from 'node:readline';

export const BIN = '_NAS Care Bin';
export const SKIP_DIR = /^(@|\.@__thumb|#recycle|#snapshot|\$RECYCLE\.BIN$|System Volume Information$|\.streams$|\.AppleDouble$|\.Trashes$|_NAS Care Bin$)/i;
export const SKIP_FILE = /^(thumbs\.db|desktop\.ini|\.ds_store|partition_identifier.*|\._.*)$/i;
const DAY = 864e5;

const KINDS = {
  video: 'mp4 mov mxf avi mkv mts m2ts wmv flv webm 3gp r3d braw mpg mpeg m4v vob insv lrv',
  photo: 'jpg jpeg png heic heif tif tiff bmp gif webp cr2 cr3 nef arw dng orf raf rw2',
  graphics: 'psd psb ai eps svg indd cdr xd fig sketch afdesign afphoto',
  audio: 'mp3 wav aac m4a flac ogg aif aiff wma opus',
  project: 'prproj aep aepx drp fcpxml veg mogrt prel plproj aet',
  document: 'pdf doc docx xls xlsx ppt pptx txt csv rtf odt ods odp srt vtt md',
  archive: 'zip rar 7z tar gz tgz iso',
  font: 'ttf otf woff woff2',
};
const KIND_OF = {};
for (const [k, list] of Object.entries(KINDS)) for (const e of list.split(' ')) KIND_OF[e] = k;
export const kindOf = (name) => KIND_OF[path.extname(name).slice(1).toLowerCase()] || 'other';

// junk: safe to clear, the apps make these again by themselves
const TEMP_FILE = /(^~\$|\.(tmp|temp|part|crdownload|download|partial|!ut|bak~)$)/i;
const CACHE_FILE = /\.(pek|cfa|ims|mcdb|pkf|xmpses)$/i;
const CACHE_DIR = /[\\/](Media Cache Files|Media Cache|Peak Files|Adobe Premiere Pro Video Previews|Adobe Premiere Pro Audio Previews|Adobe After Effects Disk Cache|CacheClip|\.cache)[\\/]/i;
// ransomware signs (QNAP ones too: Qlocker, eCh0raix, DeadBolt)
const RANSOM_EXT = /\.(encrypt|encrypted|locked|crypt|crypted|deadbolt|ech0raix|wncry|wnry|locky|cerber\d?|zepto|odin|qlocker|lockbit|ryk|conti)$/i;
const RANSOM_NOTE = /(decrypt|ransom|restore[_ -]?(my[_ -]?)?files|how[_ -]?to[_ -]?(recover|restore|unlock)|readme[_ -]?for[_ -]?decrypt|!!!.*read)/i;
export const suspicious = (name) => RANSOM_EXT.test(name) || (RANSOM_NOTE.test(name) && /\.(txt|html?|hta|url)$/i.test(name));
export const junkKind = (rel, name, size) => (TEMP_FILE.test(name) ? 'temp' : CACHE_FILE.test(name) || CACHE_DIR.test('\\' + rel) ? 'cache' : size === 0 ? 'empty' : null);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
export function inside(child, parent) { const c = norm(child), p = norm(parent); return c === p || c.startsWith(p.endsWith('\\') || p.endsWith('/') ? p : p + path.sep); }

// a byte-rate cap shared by everything that reads file contents
export class Throttle {
  constructor(mbps) { this.rate = mbps * 1048576 / 1000; this.t = 0; }
  async take(bytes) { if (!(this.rate > 0)) return; const now = Date.now(); this.t = Math.max(this.t, now) + bytes / this.rate; const w = this.t - now; if (w > 5) await sleep(w); }
}

export function isProtected(rel, protect = []) {
  const r = rel.toLowerCase().replace(/\//g, '\\');
  return protect.some((p) => { const q = p.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, ''); return q && (r === q || r.startsWith(q + '\\')); });
}

// ---------------- scan ----------------
// Walks one share and writes its index (one [relPath, size, mtimeMs] per line) plus a summary. job: { stop, note, gate() }
export async function scanShare(share, outDir, job = {}, opts = {}) {
  const root = share.root, conc = opts.concurrency || 3, gentleMs = opts.gentleMs ?? 15;
  await fsp.mkdir(outDir, { recursive: true });
  const tmp = path.join(outDir, `index-${share.id}.ndjson.tmp`);
  const ws = fs.createWriteStream(tmp);
  const write = async (line) => { if (!ws.write(line + '\n')) await new Promise((r) => ws.once('drain', r)); };
  const started = Date.now();
  const sum = { share: share.id, root, started, files: 0, dirs: 0, bytes: 0, byKind: {}, byTop: {}, byYear: {}, junk: { temp: [0, 0], cache: [0, 0], empty: [0, 0] }, emptyDirs: [], suspicious: [], errors: [], errorCount: 0, largest: [] };
  const q = [root];
  let active = 0, n = 0;
  const add = (o, k, size) => { const x = (o[k] ||= { files: 0, bytes: 0 }); x.files++; x.bytes += size; return x; };
  async function dir(d) {
    let h;
    try { h = await fsp.opendir(d); } catch (e) { sum.errorCount++; if (sum.errors.length < 200) sum.errors.push(`${d}: ${e.code || e.message}`); return; }
    let count = 0;
    for await (const e of h) {
      count++;
      if (job.stop) break;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) { q.push(abs); sum.dirs++; } continue; }
      if (!e.isFile() || SKIP_FILE.test(e.name)) continue;
      let st;
      try { st = await fsp.stat(abs); } catch (err) { sum.errorCount++; if (sum.errors.length < 200) sum.errors.push(`${abs}: ${err.code || err.message}`); continue; }
      const rel = path.relative(root, abs), size = st.size, m = Math.round(st.mtimeMs);
      await write(JSON.stringify([rel, size, m]));
      sum.files++; sum.bytes += size;
      add(sum.byKind, kindOf(e.name), size);
      const top = rel.includes(path.sep) ? rel.split(path.sep)[0] : '(files at the top)';
      const t = add(sum.byTop, top, size); t.newest = Math.max(t.newest || 0, m);
      add(sum.byYear, String(new Date(m).getFullYear()), size);
      const j = junkKind(rel, e.name, size); if (j) { sum.junk[j][0]++; sum.junk[j][1] += size; }
      if (suspicious(e.name) && sum.suspicious.length < 500) sum.suspicious.push(rel);
      if (sum.largest.length < 100 || size > sum.largest[sum.largest.length - 1][1]) { sum.largest.push([rel, size, m]); sum.largest.sort((a, b) => b[1] - a[1]); sum.largest.length = Math.min(100, sum.largest.length); }
      if (++n % 250 === 0) { job.note = `${sum.files.toLocaleString('en-IN')} files, ${gb(sum.bytes)} - ${path.relative(root, d) || 'top'}`; if (gentleMs) await sleep(gentleMs); if (job.gate) await job.gate(); }
    }
    if (count === 0 && d !== root && sum.emptyDirs.length < 20000) sum.emptyDirs.push(path.relative(root, d));
  }
  await Promise.all(Array.from({ length: conc }, async () => {
    while (!job.stop) {
      const d = q.pop();
      if (!d) { if (!active) return; await sleep(30); continue; }
      active++;
      try { await dir(d); } finally { active--; }
    }
  }));
  await new Promise((r) => ws.end(r));
  sum.ended = Date.now(); sum.seconds = Math.round((sum.ended - started) / 1000); sum.complete = !job.stop;
  await fsp.rename(tmp, path.join(outDir, `index-${share.id}.ndjson`));
  await fsp.writeFile(path.join(outDir, `summary-${share.id}.json`), JSON.stringify(sum));
  return sum;
}
export const gb = (b) => (b >= 1099511627776 ? (b / 1099511627776).toFixed(2) + ' TB' : b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : (b / 1048576).toFixed(1) + ' MB');

export async function* readIndex(file) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line) { try { yield JSON.parse(line); } catch { /* a cut line from a stopped scan */ } }
}

// ---------------- files used by projects ----------------
// Paths named inside Limelight editor projects (media.json / project.json), Premiere (.prproj, gzip XML),
// After Effects / Resolve / other project files. Returns a Set of normalised absolute paths, in drive-letter form.
const PATH_RE = /(?:[A-Za-z]:|\\\\[^\\/:*?"<>|\r\n]+\\[^\\/:*?"<>|\r\n]+)[\\/][^:*?"<>|\r\n\0]{1,400}?\.[A-Za-z0-9]{2,5}(?![A-Za-z0-9])/g;
const unxml = (s) => s.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
export function pathsIn(text) { return [...text.matchAll(PATH_RE)].map((m) => unxml(m[0]).replace(/\//g, '\\')); }
export async function projectRefs(files, uncMap = {}, job = {}, throttle) {
  const refs = new Set();
  const toDrive = (p) => {
    for (const [unc, drive] of Object.entries(uncMap)) if (p.toLowerCase().startsWith(unc.toLowerCase() + '\\')) return drive + p.slice(unc.length + 1);
    return p;
  };
  let i = 0;
  for (const f of files) {
    if (job.stop) break;
    i++; job.note = `reading project ${i} of ${files.length}: ${path.basename(f)}`;
    try {
      const st = await fsp.stat(f);
      if (st.size > 300 * 1048576) continue;
      if (throttle) await throttle.take(st.size);
      let buf = await fsp.readFile(f);
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      const text = /\.json$/i.test(f) ? JSON.stringify(JSON.parse(buf.toString('utf8'))).replace(/\\\\/g, '\\') : buf.toString(/\.(prproj|xml|fcpxml|drp|aepx)$/i.test(f) ? 'utf8' : 'latin1');
      for (const p of pathsIn(text)) refs.add(norm(toDrive(p)));
      if (/\.aep$/i.test(f)) for (const p of pathsIn(buf.toString('utf16le'))) refs.add(norm(toDrive(p)));
    } catch { /* unreadable project: skip */ }
    if (job.gate && i % 20 === 0) await job.gate();
  }
  return refs;
}

// ---------------- duplicates ----------------
// Same size -> same sample hash (start, middle, end) = "likely the same". Full SHA-256 is done right before a move.
export async function sampleHash(file, size, throttle) {
  const h = crypto.createHash('sha256'); h.update(String(size));
  const fd = await fsp.open(file, 'r');
  try {
    const chunk = 65536, spots = size <= chunk * 3 ? [0] : [0, Math.floor(size / 2) - chunk / 2, size - chunk];
    for (const at of spots) {
      const n = size <= chunk * 3 ? size : chunk, buf = Buffer.alloc(n);
      if (throttle) await throttle.take(n);
      const { bytesRead } = await fd.read(buf, 0, n, at);
      h.update(buf.subarray(0, bytesRead));
    }
  } finally { await fd.close(); }
  return h.digest('hex').slice(0, 32);
}
export async function fullHash(file, throttle, job = {}) {
  const h = crypto.createHash('sha256');
  const s = fs.createReadStream(file, { highWaterMark: 1048576 });
  for await (const c of s) { if (job.stop) { s.destroy(); throw new Error('stopped'); } if (throttle) await throttle.take(c.length); h.update(c); }
  return h.digest('hex');
}
// which copy to keep: one a project uses, then one in a protected folder (it may not move anyway), then the oldest, then the shortest path
export function pickKeeper(members) {
  return [...members].sort((a, b) => (b.used - a.used) || (b.prot - a.prot) || (a.m - b.m) || (a.rel.length - b.rel.length))[0];
}
export async function findDuplicates(indexFile, root, { minBytes = 1048576, protect = [], refs = new Set() } = {}, job = {}, throttle) {
  const sizes = new Map();
  for await (const [, size] of readIndex(indexFile)) if (size >= minBytes) sizes.set(size, (sizes.get(size) || 0) + 1);
  const bySize = new Map();
  for await (const [rel, size, m] of readIndex(indexFile)) if (size >= minBytes && sizes.get(size) > 1) { if (!bySize.has(size)) bySize.set(size, []); bySize.get(size).push({ rel, size, m }); }
  sizes.clear();
  const groups = [];
  let done = 0; const total = [...bySize.values()].reduce((a, l) => a + l.length, 0);
  for (const [size, list] of bySize) {
    if (job.stop) break;
    const byHash = new Map();
    for (const f of list) {
      done++;
      if (done % 20 === 0) { job.note = `comparing ${done.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} same-size files`; if (job.gate) await job.gate(); }
      try { const h = await sampleHash(path.join(root, f.rel), size, throttle); if (!byHash.has(h)) byHash.set(h, []); byHash.get(h).push(f); } catch { /* gone or locked */ }
    }
    for (const [h, members] of byHash) if (members.length > 1) {
      for (const x of members) { x.used = refs.has(norm(path.join(root, x.rel))) ? 1 : 0; x.prot = isProtected(x.rel, protect) ? 1 : 0; }
      const keep = pickKeeper(members);
      groups.push({ id: h, size, wasted: size * (members.length - 1), keep: keep.rel, members });
    }
  }
  groups.sort((a, b) => b.wasted - a.wasted);
  return { groups, wasted: groups.reduce((a, g) => a + g.wasted, 0), complete: !job.stop };
}

// ---------------- unused & junk ----------------
export async function findUnused(indexFile, root, { days = 365, minBytes = 0, protect = [], refs = new Set(), now = Date.now(), cap = 5000 } = {}) {
  const old = now - days * DAY;
  const cats = { old: [], temp: [], cache: [], empty: [] }, totals = { old: [0, 0], temp: [0, 0], cache: [0, 0], empty: [0, 0] };
  let usedSkipped = 0, protSkipped = 0;
  for await (const [rel, size, m] of readIndex(indexFile)) {
    const name = path.basename(rel);
    const j = junkKind(rel, name, size);
    const isOld = m < old && size >= minBytes;
    if (!j && !isOld) continue;
    if (isProtected(rel, protect)) { protSkipped++; continue; }
    if (refs.has(norm(path.join(root, rel)))) { usedSkipped++; continue; }
    const cat = j || 'old';
    totals[cat][0]++; totals[cat][1] += size;
    cats[cat].push([rel, size, m]);
  }
  for (const k of Object.keys(cats)) { cats[k].sort((a, b) => b[1] - a[1]); cats[k].length = Math.min(cap, cats[k].length); }
  return { days, cats, totals, usedSkipped, protSkipped };
}

// ---------------- the bin: move, put back, empty ----------------
export const batchId = (d = new Date()) => d.toISOString().slice(0, 19).replace(/[:T]/g, '-') + '-' + crypto.randomBytes(2).toString('hex');
async function freeName(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
  for (let i = 2; i < 1000; i++) { const c = `${base} (${i})${ext}`; if (!fs.existsSync(c)) return c; }
  throw new Error('no free name');
}
// check(abs, item) -> null when it may move, or the reason it stays
export async function moveBatch(share, items, { kind, reason, dataDir, check, toFolder, job = {} }) {
  const root = share.root, id = batchId();
  const binRoot = path.join(root, BIN, id);
  const batch = { id, share: share.id, root, kind, reason, created: Date.now(), moved: [], skipped: [] };
  for (const it of items) {
    if (job.stop) break;
    const from = path.join(root, it.rel);
    try {
      if (!inside(from, root) || inside(from, path.join(root, BIN))) throw new Error('outside the share');
      const why = check ? await check(from, it) : null;
      if (why) { batch.skipped.push({ rel: it.rel, why }); continue; }
      const to = toFolder ? await freeName(path.join(root, it.to)) : path.join(binRoot, it.rel);
      if (!inside(to, root)) throw new Error('target outside the share');
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
      batch.moved.push({ from: path.relative(root, from), to: path.relative(root, to), size: it.size || 0 });
    } catch (e) {
      batch.skipped.push({ rel: it.rel, why: e.code === 'EXDEV' ? 'would need a copy - left alone' : e.code === 'EBUSY' || e.code === 'EPERM' ? 'in use / no permission' : e.code || e.message });
    }
    if (batch.moved.length % 200 === 199 && job.gate) await job.gate();
  }
  batch.bytes = batch.moved.reduce((a, x) => a + x.size, 0);
  await saveBatch(batch, dataDir);
  if (!toFolder && batch.moved.length) await fsp.writeFile(path.join(binRoot, 'manifest.json'), JSON.stringify(batch, null, 1)).catch(() => {});
  return batch;
}
export async function saveBatch(batch, dataDir) {
  await fsp.mkdir(path.join(dataDir, 'batches'), { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'batches', batch.id + '.json'), JSON.stringify(batch));
}
export async function listBatches(dataDir) {
  const d = path.join(dataDir, 'batches');
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of await fsp.readdir(d)) if (f.endsWith('.json')) { try { const b = JSON.parse(await fsp.readFile(path.join(d, f), 'utf8')); out.push({ ...b, moved: b.moved.length, skipped: b.skipped.length, sample: b.moved.slice(0, 5) }); } catch { /* */ } }
  return out.sort((a, b) => b.created - a.created);
}
export async function restoreBatch(id, dataDir) {
  const file = path.join(dataDir, 'batches', path.basename(id) + '.json');
  const b = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (b.restored) throw new Error('already put back');
  if (b.purged) throw new Error('this batch was emptied from the bin');
  let ok = 0; const fail = [];
  for (const x of [...b.moved].reverse()) {
    const from = path.join(b.root, x.to), to = await freeName(path.join(b.root, x.from));
    try { await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.rename(from, to); ok++; } catch (e) { fail.push(`${x.from}: ${e.code || e.message}`); }
  }
  // tidy folders the batch made that are empty now (bin folders, or organiser folders)
  const dirs = new Set(b.moved.map((x) => path.dirname(path.join(b.root, x.to))));
  for (const d of [...dirs].sort((a, c) => c.length - a.length)) { try { await fsp.rmdir(d); } catch { /* not empty */ } }
  if (b.kind !== 'folder') await fsp.rm(path.join(b.root, BIN, b.id, 'manifest.json'), { force: true }).catch(() => {});
  if (b.kind !== 'folder') await rmEmptyTree(path.join(b.root, BIN, b.id));
  b.restored = Date.now(); b.restoreFailed = fail;
  await fsp.writeFile(file, JSON.stringify(b));
  return { ok, fail };
}
async function rmEmptyTree(d) {
  let entries; try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory()) await rmEmptyTree(path.join(d, e.name));
  try { await fsp.rmdir(d); } catch { /* */ }
}
// the only real delete in the app: one bin batch, old enough, typed confirmation, path checked to be inside the bin
export async function purgeBatch(id, dataDir, { minAgeDays = 7, now = Date.now() } = {}) {
  const file = path.join(dataDir, 'batches', path.basename(id) + '.json');
  const b = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (b.kind === 'folder') throw new Error('organiser batches are not in the bin');
  if (b.restored || b.purged) throw new Error('nothing left in the bin for this batch');
  if (now - b.created < minAgeDays * DAY) throw new Error(`the bin keeps files ${minAgeDays} days first (so a mistake can still be put back)`);
  const target = path.join(b.root, BIN, path.basename(b.id));
  if (!inside(target, path.join(b.root, BIN)) || norm(target) === norm(path.join(b.root, BIN))) throw new Error('unsafe path');
  await fsp.rm(target, { recursive: true, force: true });
  b.purged = Date.now();
  await fsp.writeFile(file, JSON.stringify(b));
  return { purged: b.moved.length, bytes: b.bytes };
}

// ---------------- folder organiser ----------------
const BY_TYPE = { video: 'Videos', photo: 'Photos', audio: 'Audio', graphics: 'Graphics', project: 'Project Files', document: 'Documents', archive: 'Archives', font: 'Fonts' };
const TEMPLATE = { video: '01 Footage', audio: '02 Audio', graphics: '03 Graphics', project: '04 Project Files', export: '05 Exports', document: '06 Documents', photo: '07 Photos', font: '03 Graphics\\Fonts', archive: '08 Archives' };
export const TEMPLATE_FOLDERS = ['01 Footage', '02 Audio', '03 Graphics', '04 Project Files', '05 Exports', '06 Documents', '07 Photos'];
const MEDIA = new Set(['video', 'photo', 'audio', 'graphics']);
export function targetFor(name, m, mode) {
  const k = kindOf(name);
  if (mode === 'type') return BY_TYPE[k] || null;
  if (mode === 'date') { const d = new Date(m); return `${d.getFullYear()}\\${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
  if (mode === 'template') return k === 'video' && /(final|export|output|render|_v\d+\b|master)/i.test(name) ? TEMPLATE.export : TEMPLATE[k] || null;
  return null;
}
// a plan for the loose files at the top of one folder; nothing moves until applyPlan
export async function planOrganise(folder, root, mode, { includeMedia = false, refs = new Set(), protect = [], now = Date.now() } = {}) {
  const entries = await fsp.readdir(folder, { withFileTypes: true });
  const hasProjects = entries.some((e) => e.isFile() && kindOf(e.name) === 'project');
  const moves = [], skipped = [], warnings = [];
  if (hasProjects && !includeMedia) warnings.push('This folder has project files (.prproj / .aep / .drp). Media files are left where they are so those projects do not lose their links. Tick "move media too" only if you will relink.');
  const relFolder = path.relative(root, folder);
  if (isProtected(relFolder, protect)) throw new Error('this folder is protected in the settings');
  for (const e of entries) {
    if (!e.isFile() || SKIP_FILE.test(e.name)) continue;
    const abs = path.join(folder, e.name);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) continue;
    const sub = targetFor(e.name, st.mtimeMs, mode);
    if (!sub) { skipped.push({ name: e.name, why: 'no folder for this type' }); continue; }
    if (now - st.mtimeMs < 10 * 60e3) { skipped.push({ name: e.name, why: 'changed in the last 10 minutes (may still be copying)' }); continue; }
    if (refs.has(norm(abs))) { skipped.push({ name: e.name, why: 'used by a project' }); continue; }
    if (hasProjects && !includeMedia && MEDIA.has(kindOf(e.name))) { skipped.push({ name: e.name, why: 'media next to a project file' }); continue; }
    moves.push({ rel: path.relative(root, abs), to: path.join(relFolder, sub, e.name), sub, name: e.name, size: st.size, m: Math.round(st.mtimeMs) });
  }
  return { folder, mode, moves, skipped, warnings, hasProjects };
}
export async function makeProjectFolders(parent, name, root) {
  const clean = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
  if (!clean) throw new Error('give the project a name');
  const dir = path.join(parent, clean);
  if (!inside(dir, root)) throw new Error('outside the share');
  if (fs.existsSync(dir)) throw new Error('a folder with that name is already there');
  for (const f of TEMPLATE_FOLDERS) await fsp.mkdir(path.join(dir, f), { recursive: true });
  return dir;
}

// ---------------- health ----------------
export async function space(root) {
  const s = await fsp.statfs(root);
  const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
  return { total, free, used: total - free, freePct: total ? +(100 * free / total).toFixed(1) : 0 };
}
// growth per day from the recorded history (least squares over the last 14 days)
export function growth(points, now = Date.now()) {
  const p = points.filter((x) => now - x.t < 14 * DAY);
  if (p.length < 3 || p[p.length - 1].t - p[0].t < 6 * 3600e3) return null;
  const mt = p.reduce((a, x) => a + x.t, 0) / p.length, mu = p.reduce((a, x) => a + x.used, 0) / p.length;
  let num = 0, den = 0;
  for (const x of p) { num += (x.t - mt) * (x.used - mu); den += (x.t - mt) ** 2; }
  return den ? num / den * DAY : null;
}
// a small write / read-back check in the bin's own folder: speed, and that what was written reads back the same
export async function probe(root, mb = 4) {
  const dir = path.join(root, BIN, '.health');
  await fsp.mkdir(dir, { recursive: true });
  const f = path.join(dir, `probe-${process.pid}.bin`), data = crypto.randomBytes(mb * 1048576);
  const t0 = Date.now();
  const st0 = Date.now(); await fsp.stat(root); const latency = Date.now() - st0;
  const fh = await fsp.open(f, 'w'); await fh.write(data); await fh.sync(); await fh.close();
  const t1 = Date.now();
  const back = await fsp.readFile(f);
  const t2 = Date.now();
  await fsp.rm(f, { force: true });
  const same = crypto.createHash('sha256').update(back).digest('hex') === crypto.createHash('sha256').update(data).digest('hex');
  return { latencyMs: latency, writeMBs: +(mb / Math.max(0.001, (t1 - t0) / 1000)).toFixed(1), readMBs: +(mb / Math.max(0.001, (t2 - t1) / 1000)).toFixed(1), same };
}
// canary files: random content nobody should change. If ransomware or a bad script touches them, NAS Care raises the alarm.
export async function canaries(root, dataDir, shareId) {
  const dir = path.join(root, BIN, '!canary - do not open or change');
  const rec = path.join(dataDir, `canary-${shareId}.json`);
  const names = ['! Accounts 2026.xlsx', '! Client list.docx', '! Photo 0001.jpg', '! Project backup.zip'];
  let known = {};
  try { known = JSON.parse(await fsp.readFile(rec, 'utf8')); } catch { /* first time */ }
  const bad = [];
  if (!Object.keys(known).length) {
    await fsp.mkdir(dir, { recursive: true });
    for (const n of names) { const d = crypto.randomBytes(48 * 1024); await fsp.writeFile(path.join(dir, n), d); known[n] = crypto.createHash('sha256').update(d).digest('hex'); }
    await fsp.writeFile(rec, JSON.stringify(known));
    return { ok: true, made: true, bad };
  }
  for (const [n, h] of Object.entries(known)) {
    try { const d = await fsp.readFile(path.join(dir, n)); if (crypto.createHash('sha256').update(d).digest('hex') !== h) bad.push(`${n} was changed`); } catch { bad.push(`${n} is gone`); }
  }
  try { for (const f of await fsp.readdir(dir)) if (!known[f]) bad.push(`new file next to the canaries: ${f}`); } catch { bad.push('the canary folder is gone'); }
  return { ok: !bad.length, bad };
}
