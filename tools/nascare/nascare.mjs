// nascare.mjs - Limelight NAS Care: a local web app (http://localhost:3390) that keeps the office NAS healthy and tidy.
//   node tools/nascare/nascare.mjs            start (or double-click "Start NAS Care.bat")
// Health: free space + growth ("full in N days"), a write/read-back speed check, ransomware canaries and a mass-change
// watch, NAS hardware (disks / SMART / temperature / volumes over read-only SNMP). Clean-up: duplicate files, unused and
// junk files, empty folders - all into a bin on the same share that can be put back. Organise: sort loose files into
// folders (by type, by date, or the Limelight project template), with undo.
// The app protects itself and the NAS: it listens on this PC only, every request needs the page's token, it starts in
// read-only mode, it never copies between shares, never deletes outside its own bin, and slows down while the editor renders.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from './core.mjs';
import { qnapHealth } from './snmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.NASCARE_DATA || path.join(process.env.LOCALAPPDATA || os.homedir(), 'LimelightNASCare');
const PORT = +process.env.NASCARE_PORT || 3390;
const TOKEN = crypto.randomBytes(18).toString('hex');
fs.mkdirSync(DATA, { recursive: true });
const LOG = path.join(DATA, 'nascare.log');
const log = (s) => { const line = `${new Date().toISOString()} ${s}\n`; fs.appendFile(LOG, line, () => {}); process.stdout.write(line); };

// ---------------- settings ----------------
function mappedDrives() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-PSDrive -PSProvider FileSystem | ? DisplayRoot | % { $_.Name + '|' + $_.DisplayRoot }"], { encoding: 'utf8', timeout: 15000 });
    return out.split(/\r?\n/).filter((l) => l.includes('|')).map((l) => { const [id, unc] = l.trim().split('|'); return { id, root: id + ':\\', unc, name: unc.split('\\').filter(Boolean).pop() }; });
  } catch { return []; }
}
const DEFAULTS = {
  shares: [],
  protect: ['Limelight Standby', 'Limelight Backups', 'Limelight Render Farm', 'Limelight Kit', 'Limelight Access', 'Limelight Flow', 'Limelight MeshLink', 'Limelight Office Watch', 'Limelight Move', 'Limelight Bench', 'Agent Bus', 'Editor Projects'],
  projectRoots: [path.resolve(process.env.NASCARE_PROJECTS || path.join(HERE, '..', '..', 'Projects'))],
  editorUrls: ['http://127.0.0.1:3000'],
  readMBs: 40, scanConcurrency: 3, gentleMs: 15,
  unusedDays: 365, protectDays: 7, minDupMB: 5, binKeepDays: 7,
  minFreePct: 15, critFreePct: 8,
  canaries: true, watch: true, watchLimit: 3000,
  snmp: { host: '', community: '' },
  whatsapp: { phone: '', apikey: '' },
};
const SETTINGS = path.join(DATA, 'settings.json');
let S = { ...DEFAULTS };
try { S = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) }; } catch { /* first start */ }
if (!S.shares.length) { S.shares = mappedDrives(); fs.writeFileSync(SETTINGS, JSON.stringify(S, null, 1)); }
const saveSettings = () => fsp.writeFile(SETTINGS, JSON.stringify(S, null, 1));
const shareOf = (id) => { const s = S.shares.find((x) => x.id === id); if (!s) throw err(404, 'no such share'); return s; };
const uncMap = () => Object.fromEntries(S.shares.filter((s) => s.unc).map((s) => [s.unc, s.root]));
const file = (kind, id) => path.join(DATA, `${kind}-${id}.json`);
const readJson = async (f, d = null) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return d; } };

// ---------------- state, alerts ----------------
const state = { allowChanges: false, allowUntil: 0, job: null, lastJob: null, health: {}, hardware: null, editorBusy: false, alerts: [] };
state.alerts = (await readJson(path.join(DATA, 'alerts.json'), [])).slice(-200);
const lastSent = new Map();
async function alert(level, text, key = text) {
  const now = Date.now();
  if (now - (lastSent.get(key) || 0) < 6 * 3600e3) return;
  lastSent.set(key, now);
  state.alerts.push({ t: now, level, text });
  state.alerts = state.alerts.slice(-200);
  log(`ALERT ${level}: ${text}`);
  fsp.writeFile(path.join(DATA, 'alerts.json'), JSON.stringify(state.alerts)).catch(() => {});
  if (level === 'danger' && S.whatsapp.phone && S.whatsapp.apikey) {
    const u = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(S.whatsapp.phone)}&apikey=${encodeURIComponent(S.whatsapp.apikey)}&text=${encodeURIComponent('NAS Care: ' + text)}`;
    fetch(u, { signal: AbortSignal.timeout(15000) }).catch(() => {});
  }
}

let busyAt = 0;
async function editorBusy() {
  if (Date.now() - busyAt < 20000) return state.editorBusy;
  busyAt = Date.now();
  let busy = false;
  for (const u of S.editorUrls) {
    try { const r = await fetch(u.replace(/\/$/, '') + '/api/jobs', { signal: AbortSignal.timeout(3000) }); const j = await r.json(); if (Array.isArray(j) && j.length) busy = true; } catch { /* editor off */ }
  }
  return (state.editorBusy = busy);
}

// ---------------- jobs (one heavy job at a time, so the NAS is never hammered) ----------------
const throttle = () => new C.Throttle(S.readMBs);
function startJob(kind, share, fn) {
  if (state.job) throw err(409, `busy with "${state.job.kind}" - wait for it or stop it`);
  const job = { kind, share, started: Date.now(), note: 'starting', stop: false };
  job.gate = async () => {
    while (!job.stop && await editorBusy()) { job.note = 'paused - the editor is rendering / an agent is working'; await C.sleep(30000); }
  };
  state.job = job;
  log(`job ${kind} ${share || ''} started`);
  (async () => {
    try { job.result = await fn(job); job.ok = true; } catch (e) { job.error = e.message; log(`job ${kind} failed: ${e.stack || e}`); }
    job.ended = Date.now(); delete job.gate;
    state.lastJob = { kind, share, started: job.started, ended: job.ended, ok: !!job.ok, error: job.error, stopped: job.stop, note: job.note, summary: job.summaryText };
    state.job = null;
    log(`job ${kind} ended ${job.ok ? 'ok' : job.error}`);
  })();
  return job;
}
const scan = async (job, sh) => {
  const sum = await C.scanShare(sh, DATA, job, { concurrency: S.scanConcurrency, gentleMs: S.gentleMs });
  if (sum.suspicious.length) alert('danger', `${sum.suspicious.length} files on ${sh.id}: look like ransomware (e.g. ${sum.suspicious[0]}). Check the NAS now.`, 'ransom-scan-' + sh.id);
  job.summaryText = `${sum.files.toLocaleString('en-IN')} files, ${C.gb(sum.bytes)} in ${Math.round(sum.seconds / 60)} min`;
  return sum;
};
// project files: the editor's own projects + every Premiere / AE / Resolve project the scans found on any share
let refs = new Set((await readJson(path.join(DATA, 'refs.json'), [])));
async function buildRefs(job) {
  const files = [];
  for (const r of S.projectRoots) {
    if (!fs.existsSync(r)) continue;
    for (const d of await fsp.readdir(r, { withFileTypes: true })) if (d.isDirectory()) for (const f of ['media.json', 'project.json']) { const p = path.join(r, d.name, f); if (fs.existsSync(p)) files.push(p); }
  }
  for (const sh of S.shares) for await (const [rel] of C.readIndex(path.join(DATA, `index-${sh.id}.ndjson`))) if (/\.(prproj|aep|aepx|drp|fcpxml|xml|edl|veg)$/i.test(rel) && !/[\\/](Auto-Save|Adobe Premiere Pro Auto-Save)[\\/]/i.test(rel) && (!/\.xml$/i.test(rel) || /premiere|fcp|resolve|export/i.test(rel))) files.push(path.join(sh.root, rel));
  const set = await C.projectRefs(files, uncMap(), job, throttle());
  if (!job.stop) { refs = set; await fsp.writeFile(path.join(DATA, 'refs.json'), JSON.stringify([...set])); await fsp.writeFile(path.join(DATA, 'refs-info.json'), JSON.stringify({ t: Date.now(), projects: files.length, paths: set.size })); }
  return { projects: files.length, paths: set.size };
}
async function unusedReport(sh) {
  const r = await C.findUnused(path.join(DATA, `index-${sh.id}.ndjson`), sh.root, { days: S.unusedDays, protect: S.protect, refs });
  const sum = await readJson(file('summary', sh.id), {});
  r.emptyDirs = (sum.emptyDirs || []).filter((d) => !C.isProtected(d, S.protect));
  r.t = Date.now();
  await fsp.writeFile(file('unused', sh.id), JSON.stringify(r));
  return r;
}
async function dupReport(sh, job) {
  const r = await C.findDuplicates(path.join(DATA, `index-${sh.id}.ndjson`), sh.root, { minBytes: S.minDupMB * 1048576, protect: S.protect, refs }, job, throttle());
  r.t = Date.now();
  await fsp.writeFile(file('dups', sh.id), JSON.stringify(r));
  job.summaryText = `${r.groups.length} duplicate groups, ${C.gb(r.wasted)} can be freed`;
  return { groups: r.groups.length, wasted: r.wasted };
}
const JOBS = {
  scan: (sh) => (job) => scan(job, sh),
  refs: () => (job) => buildRefs(job),
  unused: (sh) => async (job) => { await buildRefs(job); return unusedReport(sh).then((r) => ({ totals: r.totals })); },
  dups: (sh) => async (job) => { await buildRefs(job); return dupReport(sh, job); },
  full: (sh) => async (job) => { await scan(job, sh); if (job.stop) return; await buildRefs(job); if (job.stop) return; await unusedReport(sh); return dupReport(sh, job); },
};

// ---------------- clean-up with checks right before each move ----------------
function needChanges() {
  if (state.allowChanges && Date.now() > state.allowUntil) state.allowChanges = false;
  if (!state.allowChanges) throw err(403, 'NAS Care is in read-only mode. Turn on "Allow changes" first.');
}
const DAY = 864e5;
function fileCheck(rec) {
  return async (abs) => {
    const rel = path.relative(rec.root, abs);
    if (C.isProtected(rel, S.protect)) return 'protected folder';
    if (refs.has(C.norm(abs))) return 'used by a project';
    let st; try { st = await fsp.stat(abs); } catch { return 'not there any more'; }
    if (rec.size != null && st.size !== rec.size) return 'changed since the scan';
    if (rec.m != null && Math.abs(st.mtimeMs - rec.m) > 2000) return 'changed since the scan';
    if (Date.now() - st.mtimeMs < S.protectDays * DAY) return `changed in the last ${S.protectDays} days`;
    return null;
  };
}
async function cleanFiles(sh, cat, rels, job) {
  const rep = await readJson(file('unused', sh.id));
  if (!rep) throw err(400, 'make the unused report first');
  if (cat === 'emptyDirs') {
    const ok = new Set(rep.emptyDirs);
    const items = rels.filter((r) => ok.has(r)).map((rel) => ({ rel }));
    return C.moveBatch(sh, items, { kind: 'bin', reason: 'empty folders', dataDir: DATA, job, check: async (abs) => { try { return (await fsp.readdir(abs)).length ? 'not empty any more' : null; } catch { return 'not there any more'; } } });
  }
  const list = rep.cats[cat];
  if (!list) throw err(400, 'unknown list');
  const map = new Map(list.map(([rel, size, m]) => [rel, { size, m }]));
  const items = rels.filter((r) => map.has(r)).map((rel) => ({ rel, ...map.get(rel) }));
  const batch = await C.moveBatch(sh, items, { kind: 'bin', reason: { old: `not used for ${S.unusedDays} days`, temp: 'temporary files', cache: 'cache files', empty: 'zero-byte files' }[cat], dataDir: DATA, job, check: (abs, it) => fileCheck({ root: sh.root, size: it.size, m: it.m })(abs) });
  const moved = new Set(batch.moved.map((x) => x.from));
  rep.cats[cat] = list.filter(([rel]) => !moved.has(rel));
  await fsp.writeFile(file('unused', sh.id), JSON.stringify(rep));
  job.summaryText = `${batch.moved.length} files (${C.gb(batch.bytes)}) moved to the bin, ${batch.skipped.length} left`;
  return batch;
}
// duplicates: hash the kept copy and each other copy in full; only exact byte-for-byte copies move
async function cleanDups(sh, ids, job) {
  const rep = await readJson(file('dups', sh.id));
  if (!rep) throw err(400, 'make the duplicate report first');
  const want = new Set(ids), th = throttle();
  const items = [], skipped = [];
  let n = 0;
  for (const g of rep.groups.filter((x) => want.has(x.id))) {
    if (job.stop) break;
    n++; job.note = `checking group ${n} of ${want.size} byte for byte (${C.gb(g.size)} each)`;
    await job.gate();
    let keepHash;
    try { keepHash = await C.fullHash(path.join(sh.root, g.keep), th, job); } catch (e) { skipped.push({ rel: g.keep, why: 'the copy to keep cannot be read - group left alone' }); continue; }
    for (const m of g.members) {
      if (m.rel === g.keep) continue;
      try {
        const h = await C.fullHash(path.join(sh.root, m.rel), th, job);
        if (h === keepHash) items.push({ rel: m.rel, size: m.size, m: m.m, keep: g.keep }); else skipped.push({ rel: m.rel, why: 'not the same inside - kept' });
      } catch { skipped.push({ rel: m.rel, why: 'cannot be read' }); }
    }
  }
  const batch = await C.moveBatch(sh, items, { kind: 'bin', reason: 'duplicates (an exact copy is kept)', dataDir: DATA, job, check: (abs, it) => fs.existsSync(path.join(sh.root, it.keep)) ? fileCheck({ root: sh.root, size: it.size, m: it.m })(abs) : Promise.resolve('the kept copy is gone') });
  batch.skipped.push(...skipped);
  await C.saveBatch(batch, DATA);
  const moved = new Set(batch.moved.map((x) => x.from));
  for (const g of rep.groups) g.members = g.members.filter((m) => !moved.has(m.rel));
  rep.groups = rep.groups.filter((g) => g.members.length > 1);
  rep.wasted = rep.groups.reduce((a, g) => a + g.size * (g.members.length - 1), 0);
  await fsp.writeFile(file('dups', sh.id), JSON.stringify(rep));
  job.summaryText = `${batch.moved.length} duplicate files (${C.gb(batch.bytes)}) moved to the bin, ${batch.skipped.length} kept`;
  return batch;
}

// ---------------- health loop ----------------
async function checkSpace() {
  for (const sh of S.shares) {
    const h = (state.health[sh.id] ||= { id: sh.id });
    try {
      const sp = await C.space(sh.root);
      Object.assign(h, sp, { online: true, checked: Date.now() });
      const histFile = file('space', sh.id), hist = await readJson(histFile, []);
      if (!hist.length || Date.now() - hist[hist.length - 1].t > 15 * 60e3) { hist.push({ t: Date.now(), used: sp.used, free: sp.free }); await fsp.writeFile(histFile, JSON.stringify(hist.slice(-3000))); }
      h.perDay = C.growth(hist);
      h.fullInDays = h.perDay > 0 ? Math.round(sp.free / h.perDay) : null;
      h.snapshots = fs.existsSync(path.join(sh.root, '@Recently-Snapshot')) || fs.existsSync(path.join(sh.root, '#snapshot'));
      h.recycle = fs.existsSync(path.join(sh.root, '@Recycle')) || fs.existsSync(path.join(sh.root, '#recycle'));
      if (sp.freePct < S.critFreePct) alert('danger', `${sh.id}: (${sh.name}) only ${sp.freePct}% free (${C.gb(sp.free)}). A NAS this full slows down and can fail writes - clear space now.`, 'space-crit-' + sh.id);
      else if (sp.freePct < S.minFreePct) alert('warn', `${sh.id}: (${sh.name}) is ${(100 - sp.freePct).toFixed(1)}% full - keep at least ${S.minFreePct}% free for speed and safety.`, 'space-' + sh.id);
    } catch (e) { h.online = false; h.error = e.code || e.message; alert('danger', `${sh.id}: (${sh.name}) cannot be reached: ${h.error}`, 'down-' + sh.id); }
  }
}
async function checkProbe() {
  for (const sh of S.shares) {
    const h = (state.health[sh.id] ||= { id: sh.id });
    if (h.online === false) continue;
    try { h.probe = { ...(await C.probe(sh.root)), t: Date.now() }; if (!h.probe.same) alert('danger', `${sh.id}: data written to the NAS read back DIFFERENT - possible disk / RAM / network fault. Check the NAS storage manager.`, 'probe-' + sh.id); }
    catch (e) { h.probe = { error: e.code || e.message, t: Date.now() }; }
  }
}
async function checkCanaries() {
  if (!S.canaries) return;
  for (const sh of S.shares) {
    const h = (state.health[sh.id] ||= { id: sh.id });
    if (h.online === false) continue;
    try { const c = await C.canaries(sh.root, DATA, sh.id); h.canary = { ...c, t: Date.now() }; if (!c.ok) alert('danger', `${sh.id}: RANSOMWARE ALARM - canary files touched: ${c.bad.join('; ')}. Disconnect PCs from the NAS and check it now.`, 'canary-' + sh.id); }
    catch (e) { h.canary = { error: e.code || e.message, t: Date.now() }; }
  }
}
async function checkHardware() {
  if (!S.snmp.host || !S.snmp.community) return;
  try {
    const hw = await qnapHealth(S.snmp.host, S.snmp.community);
    state.hardware = { ...hw, t: Date.now() };
    for (const d of hw.disks) {
      if (d.smart && !/good|normal|ok/i.test(String(d.smart))) alert('danger', `NAS disk ${d.descr || d.index} (${d.model || ''}) SMART: ${d.smart} - replace it soon, check backups.`, 'smart-' + d.index);
      const t = parseInt(d.temp, 10); if (t >= 55) alert('warn', `NAS disk ${d.descr || d.index} is hot: ${d.temp}`, 'temp-' + d.index);
      if (d.status != null && !/^(0|ready|good|normal)/i.test(String(d.status))) alert('warn', `NAS disk ${d.descr || d.index} status: ${d.status}`, 'dstat-' + d.index);
    }
    for (const v of hw.volumes) if (v.status && !/ready|normal|good/i.test(String(v.status))) alert('danger', `NAS volume ${v.descr}: ${v.status}`, 'vol-' + v.index);
    const st = parseInt(hw.sysTemp, 10); if (st >= 60) alert('warn', `NAS system temperature ${hw.sysTemp}`, 'systemp');
  } catch (e) { state.hardware = { error: e.message, t: Date.now() }; }
}
// mass-change watch: ransomware renames thousands of files a minute; normal work does not
const watchers = {};
function startWatch() {
  for (const w of Object.values(watchers)) try { w.w.close(); } catch { /* */ }
  if (!S.watch) return;
  for (const sh of S.shares) {
    const rec = { n: 0, since: Date.now(), bad: 0 };
    try {
      rec.w = fs.watch(sh.root, { recursive: true }, (ev, name) => {
        if (!name || name.startsWith(C.BIN) || name.startsWith('@') || name.startsWith('.@__')) return;
        rec.n++;
        if (C.suspicious(path.basename(name))) { rec.bad++; alert('danger', `${sh.id}: a file that looks like ransomware just appeared: ${name}`, 'ransom-live-' + sh.id); }
      });
      rec.w.on('error', (e) => { rec.error = e.message; });
      watchers[sh.id] = rec;
    } catch (e) { watchers[sh.id] = { error: e.message }; }
  }
}
setInterval(() => {
  for (const [id, r] of Object.entries(watchers)) {
    if (r.n > S.watchLimit) alert('warn', `${id}: ${r.n.toLocaleString('en-IN')} file changes in the last minute - unusual. If nobody is copying a big job, check the NAS.`, 'mass-' + id);
    const h = (state.health[id] ||= { id }); h.changesPerMin = r.n; h.watchError = r.error; r.n = 0;
  }
}, 60e3).unref();
const every = (ms, fn) => { const run = () => fn().catch((e) => log('health: ' + e.message)); setTimeout(run, 2000); setInterval(run, ms).unref(); };
every(10 * 60e3, checkSpace); every(30 * 60e3, checkProbe); every(2 * 60e3, checkCanaries); every(10 * 60e3, checkHardware);
startWatch();

// ---------------- web ----------------
function err(code, msg) { const e = new Error(msg); e.code = code; return e; }
const plans = new Map();
function inShares(p) { const sh = S.shares.find((s) => C.inside(p, s.root)); if (!sh) throw err(400, 'that folder is not on a NAS share in the settings'); if (C.inside(p, path.join(sh.root, C.BIN))) throw err(400, 'that is the NAS Care bin'); if (p.split(/[\\/]/).some((x) => C.SKIP_DIR.test(x))) throw err(400, 'NAS system folder'); return sh; }
const csv = (rows) => rows.map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
const day = (m) => new Date(m).toISOString().slice(0, 10);

const API = {
  'GET /api/state': async () => {
    await editorBusy();
    if (state.allowChanges && Date.now() > state.allowUntil) state.allowChanges = false;
    const reports = {};
    for (const sh of S.shares) {
      const [sum, un, du] = await Promise.all([readJson(file('summary', sh.id)), fsp.stat(file('unused', sh.id)).catch(() => null), fsp.stat(file('dups', sh.id)).catch(() => null)]);
      reports[sh.id] = { scanned: sum?.ended || null, complete: sum?.complete, files: sum?.files, bytes: sum?.bytes, unused: un?.mtimeMs || null, dups: du?.mtimeMs || null };
    }
    const { whatsapp, ...rest } = S;
    return {
      settings: { ...rest, whatsapp: { phone: whatsapp.phone, apikey: whatsapp.apikey ? '••••' : '' } },
      allowChanges: state.allowChanges, allowUntil: state.allowUntil, editorBusy: state.editorBusy,
      job: state.job && { kind: state.job.kind, share: state.job.share, started: state.job.started, note: state.job.note },
      lastJob: state.lastJob, health: state.health, hardware: state.hardware, alerts: state.alerts.slice(-50).reverse(), reports,
      refs: await readJson(path.join(DATA, 'refs-info.json')), data: DATA,
    };
  },
  'POST /api/job': async (b) => { const f = JOBS[b.kind]; if (!f) throw err(400, 'unknown job'); const sh = b.kind === 'refs' ? null : shareOf(b.share); startJob(b.kind, sh?.id, f(sh)); return { ok: true }; },
  'POST /api/stop': async () => { if (state.job) { state.job.stop = true; state.job.note = 'stopping...'; } return { ok: true }; },
  'POST /api/check': async () => { await Promise.all([checkSpace(), checkProbe(), checkCanaries(), checkHardware()]); return { ok: true }; },
  'GET /api/summary': async (q) => readJson(file('summary', q.share)),
  'GET /api/dups': async (q) => { const r = await readJson(file('dups', q.share)); if (r) r.groups = r.groups.slice(0, +q.limit || 1000); return r; },
  'GET /api/unused': async (q) => { const r = await readJson(file('unused', q.share)); if (r) { for (const k of Object.keys(r.cats)) r.cats[k] = r.cats[k].slice(0, +q.limit || 2000); r.emptyDirs = r.emptyDirs.slice(0, +q.limit || 2000); } return r; },
  'POST /api/allow': async (b) => {
    if (!b.on) { state.allowChanges = false; return { ok: true }; }
    if (b.confirm !== 'YES') throw err(400, 'type YES to allow changes');
    state.allowChanges = true; state.allowUntil = Date.now() + 60 * 60e3; log('changes allowed for 60 min'); return { ok: true };
  },
  'POST /api/clean/files': async (b) => { needChanges(); const sh = shareOf(b.share); if (!Array.isArray(b.rels) || !b.rels.length) throw err(400, 'nothing chosen'); if (b.rels.length > 20000) throw err(400, 'at most 20,000 at a time'); startJob('clean', sh.id, (job) => cleanFiles(sh, b.cat, b.rels, job)); return { ok: true }; },
  'POST /api/clean/dups': async (b) => { needChanges(); const sh = shareOf(b.share); if (!Array.isArray(b.ids) || !b.ids.length) throw err(400, 'nothing chosen'); startJob('clean-dups', sh.id, (job) => cleanDups(sh, b.ids, job)); return { ok: true }; },
  'GET /api/batches': async () => C.listBatches(DATA),
  'POST /api/restore': async (b) => { needChanges(); if (state.job) throw err(409, 'wait for the running job'); const r = await C.restoreBatch(b.id, DATA); log(`restored ${b.id}: ${r.ok}`); return r; },
  'POST /api/purge': async (b) => { needChanges(); if (b.confirm !== 'DELETE') throw err(400, 'type DELETE to empty this batch for good'); const r = await C.purgeBatch(b.id, DATA, { minAgeDays: S.binKeepDays }); log(`purged ${b.id}: ${r.purged} files`); return r; },
  'GET /api/browse': async (q) => {
    if (!q.path) return S.shares.map((s) => ({ name: `${s.id}: ${s.name || ''}`, path: s.root }));
    inShares(q.path);
    const list = await fsp.readdir(q.path, { withFileTypes: true });
    return list.filter((d) => d.isDirectory() && !C.SKIP_DIR.test(d.name)).map((d) => ({ name: d.name, path: path.join(q.path, d.name) })).sort((a, b) => a.name.localeCompare(b.name));
  },
  'POST /api/organise/plan': async (b) => {
    const sh = inShares(b.folder);
    if (!['type', 'date', 'template'].includes(b.mode)) throw err(400, 'choose how to sort');
    const plan = await C.planOrganise(b.folder, sh.root, b.mode, { includeMedia: !!b.includeMedia, refs, protect: S.protect });
    plan.id = crypto.randomBytes(6).toString('hex'); plan.share = sh.id; plans.set(plan.id, plan);
    return { ...plan, moves: plan.moves.slice(0, 3000) };
  },
  'POST /api/organise/apply': async (b) => {
    needChanges();
    const plan = plans.get(b.id); if (!plan) throw err(404, 'make the plan again');
    const sh = shareOf(plan.share);
    startJob('organise', sh.id, async (job) => {
      const batch = await C.moveBatch(sh, plan.moves, { kind: 'folder', reason: `organised "${path.basename(plan.folder)}" by ${plan.mode}`, toFolder: true, dataDir: DATA, job, check: async (abs, it) => { try { const st = await fsp.stat(abs); return Math.abs(st.mtimeMs - it.m) > 2000 ? 'changed since the plan' : null; } catch { return 'not there any more'; } } });
      plans.delete(b.id);
      job.summaryText = `${batch.moved.length} files sorted, ${batch.skipped.length} left`;
      return batch;
    });
    return { ok: true };
  },
  'POST /api/newproject': async (b) => { needChanges(); const sh = inShares(b.parent); return { dir: await C.makeProjectFolders(b.parent, b.name, sh.root) }; },
  'POST /api/settings': async (b) => {
    const n = { ...S };
    for (const k of ['readMBs', 'scanConcurrency', 'gentleMs', 'unusedDays', 'protectDays', 'minDupMB', 'binKeepDays', 'minFreePct', 'critFreePct', 'watchLimit']) if (b[k] != null) n[k] = Math.max(0, +b[k] || 0);
    n.protectDays = Math.max(1, n.protectDays); n.binKeepDays = Math.max(1, n.binKeepDays); n.scanConcurrency = Math.min(8, Math.max(1, n.scanConcurrency)); n.readMBs = Math.min(500, Math.max(1, n.readMBs));
    for (const k of ['canaries', 'watch']) if (b[k] != null) n[k] = !!b[k];
    for (const k of ['protect', 'projectRoots', 'editorUrls']) if (Array.isArray(b[k])) n[k] = b[k].map(String).map((s) => s.trim()).filter(Boolean);
    if (Array.isArray(b.shares)) n.shares = b.shares.filter((s) => s.id && s.root).map((s) => ({ id: String(s.id).replace(/[^A-Za-z0-9_-]/g, ''), root: String(s.root), unc: s.unc || '', name: s.name || '' }));
    if (b.snmp) n.snmp = { host: String(b.snmp.host || ''), community: String(b.snmp.community || '') };
    if (b.whatsapp) n.whatsapp = { phone: String(b.whatsapp.phone || ''), apikey: b.whatsapp.apikey === '••••' ? S.whatsapp.apikey : String(b.whatsapp.apikey || '') };
    if (b.detectShares) n.shares = mappedDrives();
    S = n; await saveSettings(); startWatch(); return { ok: true };
  },
  'GET /api/export': async (q) => {
    const sh = shareOf(q.share);
    if (q.what === 'dups') { const r = await readJson(file('dups', sh.id), { groups: [] }); const rows = [['group', 'action', 'path', 'size MB', 'modified', 'used by a project']]; for (const g of r.groups) for (const m of g.members) rows.push([g.id.slice(0, 8), m.rel === g.keep ? 'KEEP' : 'duplicate', path.join(sh.root, m.rel), (m.size / 1048576).toFixed(1), day(m.m), m.used ? 'yes' : '']); return { csv: csv(rows), name: `NAS ${sh.id} duplicates.csv` }; }
    const r = await readJson(file('unused', sh.id), { cats: {} }); const rows = [['list', 'path', 'size MB', 'modified']]; for (const [k, l] of Object.entries(r.cats)) for (const [rel, size, m] of l) rows.push([k, path.join(sh.root, rel), (size / 1048576).toFixed(1), day(m)]); for (const d of r.emptyDirs || []) rows.push(['empty folder', path.join(sh.root, d), 0, '']);
    return { csv: csv(rows), name: `NAS ${sh.id} unused and junk.csv` };
  },
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  // only this PC, only by its own name (stops other web pages and DNS tricks from reaching it)
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(403, { error: 'local only' });
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return send(200, (await fsp.readFile(path.join(HERE, 'ui.html'), 'utf8')).replace('__TOKEN__', TOKEN), 'text/html; charset=utf-8');
    const h = API[`${req.method} ${u.pathname}`];
    if (!h) return send(404, { error: 'not found' });
    if (req.headers['x-nascare'] !== TOKEN) return send(403, { error: 'reload the page' });
    let body = {};
    if (req.method === 'POST') { let s = ''; for await (const c of req) { s += c; if (s.length > 8e6) throw err(413, 'too big'); } body = s ? JSON.parse(s) : {}; }
    send(200, await h(req.method === 'GET' ? Object.fromEntries(u.searchParams) : body));
  } catch (e) { send(typeof e.code === 'number' ? e.code : e.code ? 500 : 400, { error: e.message }); }
});
server.on('error', (e) => { if (e.code === 'EADDRINUSE') { console.log(`NAS Care is already running: http://localhost:${PORT}`); process.exit(0); } throw e; });
server.listen(PORT, '127.0.0.1', () => log(`NAS Care on http://localhost:${PORT} (data in ${DATA}); shares: ${S.shares.map((s) => s.id + ':' + s.root).join(', ') || 'none'}`));
