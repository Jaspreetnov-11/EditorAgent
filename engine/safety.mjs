// 🛟 Mazbooti (Phase 21): the editor's own data kept safe somewhere else (a backup folder - on the NAS by default).
//
//   <dest>/nights/<YYYY-MM-DD>/projects/<project>/   each night: the timeline (project.json), the media list (media.json),
//                                                    named versions, subtitles and its LUTs + place.json (where it was)
//   <dest>/nights/<YYYY-MM-DD>/_app/                 the editor's settings: project places / folders, sign-ins, Library, LUTs
//   <dest>/live/                                     the live mirror, renewed every few minutes - a folder the editor itself
//                                                    can run from (VEDIT_DATA), so a standby PC can take over (engine/standby.mjs)
//   <dest>/live/Projects/<project>/imports/          uploaded files (VO, music, logos, copied footage): one copy, only new /
//                                                    changed files are copied - shared by every night and the standby
//   <dest>/live/standby.json                         { state: active | done | pulled, host, since, until } while / after a
//                                                    standby PC ran the editor (the main one then brings its edits back)
//   <dest>/status.json                               the last nights' results
// Footage is never copied (it stays where it is - mostly on the NAS); the projects' caches and renders are left out too.
// Every copy goes through the file thread pool (fs/promises), so a long copy never holds the editor up.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const dayOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const safeDir = (n) => String(n || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim() || '_';
const LIGHT = ['project.json', 'media.json'];
const LIGHT_DIRS = [['backups', 'named'], ['subs'], ['luts']];
// settings that go with the projects; anything else in config.json (stock / publish keys, farm token) stays on this PC
const CONFIG_KEEP = ['team', 'defaultStyle', 'relinkMap'];
export const liveDir = (dest) => path.join(dest, 'live');
export const sameDrive = (a, b) => path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase();

async function statOr(f) { try { return await fsp.stat(f); } catch { return null; } }
// one file, only when it is new or changed (same size and time = the same file); returns the bytes copied
export async function copyIfChanged(src, dst) {
  const s = await fsp.stat(src), d = await statOr(dst);
  if (d && d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 2000) return 0;
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.part`;
  await fsp.copyFile(src, tmp);
  await fsp.utimes(tmp, s.atime, s.mtime);
  await fsp.rename(tmp, dst);
  return s.size;
}
// a folder into another (files that went from src stay in dst - a mirror never loses anything)
export async function mirrorDir(src, dst, out = { files: 0, bytes: 0 }) {
  let list; try { list = await fsp.readdir(src, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    if (e.name.startsWith('.') || e.name.endsWith('.part') || e.name.endsWith('.tmp')) continue;
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) await mirrorDir(a, b, out);
    else if (e.isFile()) { const n = await copyIfChanged(a, b); if (n) { out.files++; out.bytes += n; } }
  }
  return out;
}
const writeJson = async (f, o) => { await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(`${f}.tmp`, JSON.stringify(o, null, 1)); await fsp.rename(`${f}.tmp`, f); };
export const readJsonFile = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
export const standbyState = (dest) => (dest ? readJsonFile(path.join(liveDir(dest), 'standby.json'), null) : null);

// one project's own files into folder `to` (+ its uploads into the shared copy, unless they sit on the backup's drive
// already - then they are as safe as the copy would be, and the NAS is not filled twice)
async function projectFiles(p, to, dest, sum) {
  for (const f of LIGHT) { const s = path.join(p.dir, f); if (fs.existsSync(s)) { const n = await copyIfChanged(s, path.join(to, f)); if (n) { sum.files++; sum.bytes += n; } } }
  for (const d of LIGHT_DIRS) await mirrorDir(path.join(p.dir, ...d), path.join(to, ...d), sum);
  await writeJson(path.join(to, 'place.json'), { name: p.name, dir: p.dir });
  if (!sameDrive(p.dir, dest)) await mirrorDir(path.join(p.dir, 'imports'), path.join(liveDir(dest), 'Projects', safeDir(p.name), 'imports'), sum);
}
async function appFiles(app, to, sum) {
  for (const [src, name] of app.files || []) if (fs.existsSync(src)) { const n = await copyIfChanged(src, path.join(to, name)); if (n) { sum.files++; sum.bytes += n; } }
  for (const [src, name] of app.dirs || []) await mirrorDir(src, path.join(to, name), sum);
  if (app.config) await writeJson(path.join(to, 'config.json'), Object.fromEntries(CONFIG_KEEP.filter((k) => k in app.config).map((k) => [k, app.config[k]])));
}

// 🌙 the nightly copy. projects: [{ name, dir }]; app: { files: [[src, name]], dirs: [[src, name]], config }
export async function runNightly({ dest, projects, app, keep = 14, onProgress = () => {} }) {
  const night = dayOf(), nd = path.join(dest, 'nights', night), t0 = Date.now();
  const r = { night, at: t0, ok: true, projects: 0, files: 0, bytes: 0, errors: [] };
  await fsp.mkdir(nd, { recursive: true });
  let i = 0;
  for (const p of projects) {
    onProgress(`${++i}/${projects.length} ${p.name}`);
    try { await projectFiles(p, path.join(nd, 'projects', safeDir(p.name)), dest, r); r.projects++; } catch (e) { r.errors.push(`${p.name}: ${e.message}`); }
  }
  try { await appFiles(app, path.join(nd, '_app'), r); } catch (e) { r.errors.push(`settings: ${e.message}`); }
  // older nights beyond `keep` go (the shared uploads copy stays)
  const nights = (await fsp.readdir(path.join(dest, 'nights')).catch(() => [])).filter((n) => /^\d{4}-\d\d-\d\d$/.test(n)).sort();
  for (const n of nights.slice(0, Math.max(0, nights.length - keep))) await fsp.rm(path.join(dest, 'nights', n), { recursive: true, force: true }).catch(() => {});
  r.ok = !r.errors.length; r.secs = Math.round((Date.now() - t0) / 1000);
  const st = readJsonFile(path.join(dest, 'status.json'), { history: [] });
  st.last = r; st.history = [r, ...(st.history || []).filter((x) => x.night !== night)].slice(0, 30);
  await writeJson(path.join(dest, 'status.json'), st);
  return r;
}
export function nights(dest) {
  const d = path.join(dest, 'nights');
  let list = []; try { list = fs.readdirSync(d).filter((n) => /^\d{4}-\d\d-\d\d$/.test(n)).sort().reverse(); } catch {}
  return list.map((n) => ({ night: n, projects: (() => { try { return fs.readdirSync(path.join(d, n, 'projects')).map((p) => readJsonFile(path.join(d, n, 'projects', p, 'place.json'), { name: p }).name); } catch { return []; } })() }));
}

// 🔁 the live mirror: the projects that changed since last time (and their uploads), the sign-ins and folders - what a
// standby PC needs to carry on. projects: [{ name, dir }]. Returns how many went.
export async function mirrorLive({ dest, projects, app, host }) {
  const L = liveDir(dest), sum = { files: 0, bytes: 0 };
  const info = readJsonFile(path.join(L, 'mirror.json'), { projects: {} });
  for (const p of projects) {
    await projectFiles(p, path.join(L, 'Projects', safeDir(p.name)), dest, sum);
    info.projects[safeDir(p.name)] = { name: p.name, dir: p.dir, at: Date.now() };
  }
  await appFiles(app, L, sum);
  Object.assign(info, { host, at: Date.now() });
  await writeJson(path.join(L, 'mirror.json'), info);
  return sum;
}

// 🖥 before a standby PC runs the editor from the live mirror: files that were in a project's own folder on the main
// PC (its uploads) are read from the mirror's copy instead (origPath keeps where they were, for the way back); footage on
// the NAS stays as it is. Thumbnails and previews are made again on the standby (the caches were not mirrored).
export function prepareStandby(live) {
  const info = readJsonFile(path.join(live, 'mirror.json'), { projects: {} });
  let n = 0;
  for (const folder of fs.existsSync(path.join(live, 'Projects')) ? fs.readdirSync(path.join(live, 'Projects')) : []) {
    const pd = path.join(live, 'Projects', folder), mf = path.join(pd, 'media.json'), db = readJsonFile(mf, null);
    if (!db) continue;
    const dir = info.projects?.[folder]?.dir, old = dir ? path.resolve(dir).toLowerCase() + path.sep : null;
    for (const m of db.items || []) {
      if (old && m.path && !m.origPath && path.resolve(m.path).toLowerCase().startsWith(old)) {
        const nw = path.join(pd, path.resolve(m.path).slice(old.length));
        if (fs.existsSync(nw)) { m.origPath = m.path; m.path = nw; n++; }
      }
      if (m.status === 'ready') { m.status = 'queued'; if (m.proxy === 'ready') m.proxy = 'pending'; delete m.lite; }
    }
    fs.writeFileSync(mf, JSON.stringify(db, null, 1));
  }
  return n;
}

// ♻ a project from a night (or from the live mirror: night = 'live') as a new project in folder `to` (nothing that exists
// is overwritten). Its uploads come from the shared copy; media paths into its old folder are pointed at the new one.
export async function restoreProject({ dest, night, folder, to }) {
  const from = night === 'live' ? path.join(liveDir(dest), 'Projects', folder) : path.join(dest, 'nights', path.basename(night), 'projects', path.basename(folder));
  if (!fs.existsSync(path.join(from, 'project.json'))) throw new Error('That backup has no timeline');
  if (fs.existsSync(to)) throw new Error('A project with that name exists already');
  const place = readJsonFile(path.join(from, 'place.json'), {});
  await mirrorDir(from, to);
  await fsp.rm(path.join(to, 'place.json'), { force: true });
  const up = path.join(liveDir(dest), 'Projects', safeDir(place.name || folder), 'imports');
  if (night !== 'live' && fs.existsSync(up)) await mirrorDir(up, path.join(to, 'imports'));
  const mf = path.join(to, 'media.json'), db = readJsonFile(mf, { items: [] });
  // the files that were in its own folder (uploads): now in the new one when they came back, else where they were
  const old = place.dir ? path.resolve(place.dir).toLowerCase() + path.sep : null;
  for (const m of db.items || []) {
    if (old && m.path && path.resolve(m.path).toLowerCase().startsWith(old)) {
      const nw = path.join(to, path.resolve(m.path).slice(old.length));
      if (fs.existsSync(nw)) m.path = nw;
    }
    if (m.status === 'ready') { m.status = 'queued'; if (m.proxy === 'ready') m.proxy = 'pending'; } // (thumbnails and previews are made again)
  }
  await writeJson(mf, db);
  return { from, place };
}
