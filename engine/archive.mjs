// archive.mjs - 📦 Archive search (Phase 22): all the old footage on the NAS / drives is looked at once (a few frames of
// every video and every photo, understood by the picture model - engine/footage.py, the same as 🧠 Smart scan), then any
// project can find "drone shot of a river at sunrise" or "jharna" in it and bring the shot in (linked, not copied).
//   <data>/archive/index.json   { roots: [folders], items: { id: { path, size, mtime, kind, dur, w, h, frames, at } }, at }
//   <data>/archive/frames/<id>/ the frames looked at (also the thumbnails)    <data>/archive/emb/<id>.npz  what they show
// The scan is incremental (a file that has not changed is not looked at again) and can be stopped and run again.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const VIDEO = /\.(mp4|mov|m4v|mkv|avi|mts|m2ts|mxf|mpg|mpeg|wmv|3gp|webm)$/i, PHOTO = /\.(jpe?g|png|heic|webp|tiff?)$/i;
// folders that are never footage: the editor's own caches, renders, previews, recycle bins
const SKIP = /^(cache|proxies|renders|exports|thumbs|strips|waves|analysis|node_modules|\$recycle\.bin|recycle bin|system volume information|\.[^.].*)$/i;

function probe(file) {
  return new Promise((ok) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], { windowsHide: true });
    let out = ''; p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { try { const j = JSON.parse(out), v = (j.streams || []).find((s) => s.codec_type === 'video'); ok({ dur: +j.format?.duration || 0, w: v?.width || 0, h: v?.height || 0 }); } catch { ok(null); } });
    p.on('error', () => ok(null));
  });
}

export function archiveRoutes({ DATA, PROJECTS, config, readJson, err, startTask, footageWorker, extractFrames, toEnglishQuery, serveFile, writeJSON, readJSON }) {
  const dir = path.join(DATA, 'archive'), idxFile = path.join(dir, 'index.json');
  const load = () => { const d = readJSON(idxFile, null) || {}; return { roots: d.roots || [PROJECTS, ...(config().archiveRoots || [])], items: d.items || {}, at: d.at || 0 }; };
  let scanJob = null;
  const idOf = (f, st) => crypto.createHash('sha1').update(`${f.toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 16);
  const frameDir = (id) => path.join(dir, 'frames', id);
  // every footage file under the roots (the editor's own folders skipped). Asynchronous: a whole NAS archive read with
  // readdirSync / statSync held the main process - every PC's every request - for minutes.
  async function* walk(root, depth = 0) {
    let ents = []; try { ents = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(root, e.name);
      if (e.isDirectory()) { if (!SKIP.test(e.name) && depth < 12) yield* walk(f, depth + 1); }
      else if (VIDEO.test(e.name) || PHOTO.test(e.name)) yield f;
    }
  }
  const view = (d) => ({ roots: d.roots, count: Object.values(d.items).filter((x) => x.frames).length, at: d.at, scanning: scanJob && scanJob.status === 'running' ? { id: scanJob.id, progress: scanJob.progress, stage: scanJob.stage } : null });

  return {
    'GET /api/archive': () => view(load()),
    // the folders to look in (owner): { roots: ['Z:\\Shoots', 'E:\\Archive'] }
    'POST /api/archive/roots': async (req) => {
      if (req.who && req.who.role !== 'owner' && !req.who.local) throw err(403, 'Only the owner can change the archive folders');
      const b = await readJson(req), d = load();
      d.roots = [...new Set((b.roots || []).map((r) => String(r).trim()).filter(Boolean))].slice(0, 30);
      const missing = d.roots.filter((r) => !fs.existsSync(r));
      if (missing.length) throw err(400, `Not found: ${missing.join(', ')}`);
      fs.mkdirSync(dir, { recursive: true }); writeJSON(idxFile, d);
      return view(d);
    },
    // look at every new / changed file (a few frames each, then the picture model, 25 files at a time)
    'POST /api/archive/scan': async () => {
      if (scanJob?.status === 'running') return scanJob;
      fs.mkdirSync(dir, { recursive: true });
      scanJob = startTask('archive', async (job) => {
        const d = load(), seen = new Set(), todo = [];
        job.stage = 'Finding footage files…';
        for (const root of d.roots) for await (const f of walk(root)) {
          let st; try { st = await fs.promises.stat(f); } catch { continue; }
          if (st.size < 15e3) continue; // (icons, tiny stills)
          const id = idOf(f, st); seen.add(id);
          if (!d.items[id]?.frames) { d.items[id] = { path: f, size: st.size, mtime: Math.round(st.mtimeMs), kind: VIDEO.test(f) ? 'video' : 'image' }; todo.push(id); }
          else d.items[id].path = f; // (moved / renamed folders: same file, new place)
          if (seen.size % 500 === 0) job.stage = `Finding footage files… ${seen.size}`;
        }
        for (const id of Object.keys(d.items)) if (!seen.has(id)) { delete d.items[id]; fs.rmSync(frameDir(id), { recursive: true, force: true }); fs.rmSync(path.join(dir, 'emb', `${id}.npz`), { force: true }); }
        let done = 0;
        for (let k = 0; k < todo.length; k += 25) {
          if (job.cancelled) break;
          const batch = [];
          for (const id of todo.slice(k, k + 25)) {
            const it = d.items[id];
            job.stage = `Looking at ${path.basename(it.path)} (${done + batch.length + 1} of ${todo.length})`;
            try {
              if (it.kind === 'video') { const p = await probe(it.path); if (!p?.dur) continue; Object.assign(it, p); }
              // a long camera file: keyframes only (read in seconds, not minutes); a short clip may have one keyframe, so
              // it is read whole - and anything that gave no frames is read whole once more
              const o = { duration: it.dur || 0, image: it.kind === 'image' };
              let fr = await extractFrames(it.path, frameDir(id), { ...o, keyOnly: it.kind === 'video' && it.dur > 60 });
              if (!fr.length && it.kind === 'video') { fs.rmSync(frameDir(id), { recursive: true, force: true }); fr = await extractFrames(it.path, frameDir(id), o); }
              if (fr.length) batch.push({ id, frames: fr });
            } catch (e) { job.log.push(`${it.path}: ${e.message}`); }
          }
          if (batch.length) {
            const r = await footageWorker().send({ cmd: 'scan', cacheDir: path.join(dir, 'emb'), media: batch }, () => {});
            for (const b of batch) if (r.media?.[b.id]) Object.assign(d.items[b.id], { frames: b.frames.length, tags: r.media[b.id].tags, shot: r.media[b.id].shot, at: Date.now() });
          }
          done = Math.min(todo.length, k + 25);
          job.progress = Math.round((done / Math.max(1, todo.length)) * 100);
          d.at = Date.now(); writeJSON(idxFile, d); // (saved as it goes: stopping keeps what was looked at)
        }
        d.at = Date.now(); writeJSON(idxFile, d);
        return { files: seen.size, looked: done, total: Object.values(d.items).filter((x) => x.frames).length };
      });
      return scanJob;
    },
    // { q: 'jharna' | 'drone shot of a river', top?, skip?: [paths already in the project] } -> { results: [{ id, path, t, score, kind, dur, thumb }] }
    'POST /api/archive/search': async (req) => {
      const b = await readJson(req), d = load();
      const en = toEnglishQuery(String(b.q || ''));
      if (!en) throw err(400, 'Type what to look for');
      const skip = new Set((b.skip || []).map((p) => String(p).toLowerCase()));
      const ids = Object.entries(d.items).filter(([id, x]) => x.frames && !skip.has(x.path.toLowerCase()) && fs.existsSync(path.join(dir, 'emb', `${id}.npz`))).map(([id]) => id);
      if (!ids.length) throw err(400, 'The archive has not been scanned yet - press Scan archive first');
      const r = await footageWorker().send({ cmd: 'search', cacheDir: path.join(dir, 'emb'), ids, q: en, top: Math.min(100, +b.top || 40) });
      return { q: en, results: r.results.map((x) => { const it = d.items[x.id]; return { ...x, path: it.path, kind: it.kind, dur: it.dur || 0, name: path.basename(it.path), folder: path.dirname(it.path), thumb: `/api/archive/thumb?id=${x.id}&t=${x.t}` }; }) };
    },
    // the looked-at frame nearest to t
    'GET /api/archive/thumb': (req, res, u) => {
      const id = String(u.searchParams.get('id') || '').replace(/[^0-9a-f]/g, ''), t = +u.searchParams.get('t') || 0;
      let fr = []; try { fr = Object.values(JSON.parse(fs.readFileSync(fs.readdirSync(frameDir(id)).filter((f) => f.startsWith('done-')).map((f) => path.join(frameDir(id), f))[0], 'utf8'))); } catch {}
      if (!fr.length) throw err(404, 'no thumbnail');
      const best = fr.reduce((a, x) => (Math.abs(x.t - t) < Math.abs(a.t - t) ? x : a), fr[0]);
      return serveFile(req, res, best.path, true);
    },
  };
}
