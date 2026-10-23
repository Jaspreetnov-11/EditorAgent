// End to end (only with `node tests/run.mjs --server`): a second editor on a spare port with a throwaway data folder
// (VEDIT_DATA), so the running editor and the real projects are never touched. Makes test footage with FFmpeg, then:
// project + import, live edits, 📜 activity take-back, 🗂 offline / relink / pack / disk, and a preview render.
import { test, eq as same, assert } from './harness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const PORT = 3917, B = `http://127.0.0.1:${PORT}`, NAME = 'Auto Test';
const P = encodeURIComponent(NAME);
let srv = null, tmp = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(m, u, b) {
  const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${m} ${u} -> ${r.status} ${t.slice(0, 200)}`);
  return j;
}
async function job(id, limit = 120000) {
  for (const t0 = Date.now(); Date.now() - t0 < limit;) { const j = await api('GET', `/api/job?id=${id}`); if (j.status !== 'running') { if (j.status !== 'done') throw new Error(`job ${j.kind} failed: ${j.log.slice(-2).join(' | ')}`); return j; } await sleep(400); }
  throw new Error('job timed out');
}
const media = async () => (await api('GET', `/api/media?p=${P}`)).items;
const ff = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status !== 0) throw new Error(String(r.stderr)); };

test('start a test editor (own port, own data folder)', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-test-'));
  const shoot = path.join(tmp, 'shoot', 'day1');
  fs.mkdirSync(shoot, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(shoot, 'A.mp4')]);
  ff(['-f', 'lavfi', '-i', 'smptebars=s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'sine=f=660:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(shoot, 'B.mp4')]);
  srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { await api('GET', '/api/version'); return; } catch { await sleep(500); } }
  throw new Error(`test editor did not start:\n${log.slice(-800)}`);
});

test('project from a footage folder; files are read', async () => {
  if (!ON) return 'skip';
  const r = await api('POST', '/api/projects', { name: NAME, folder: path.join(tmp, 'shoot') });
  same(r.imported, 2);
  for (let i = 0; i < 60; i++) { const it = await media(); if (it.every((m) => m.status === 'ready')) return; await sleep(500); }
  throw new Error('media not ready');
});

test('live edits: ops change the project; 📜 activity takes one back', async () => {
  if (!ON) return 'skip';
  const it = await media(), A = it.find((m) => m.name === 'A.mp4'), Bm = it.find((m) => m.name === 'B.mp4');
  const pj = await api('GET', `/api/project?p=${P}`);
  await api('POST', `/api/live/ops?p=${P}&client=t1`, { label: 'add A', ops: [{ o: 'ins', p: ['tracks', 'V1'], v: { id: 'cA', type: 'video', mediaId: A.id, in: 0, out: 3 }, after: null }], inv: [{ o: 'del', p: ['tracks', 'V1'], id: 'cA' }] });
  await api('POST', `/api/live/ops?p=${P}&client=t1`, { label: 'add B', ops: [{ o: 'ins', p: ['tracks', 'V1'], v: { id: 'cB', type: 'video', mediaId: Bm.id, in: 0, out: 2 }, after: 'cA' }], inv: [{ o: 'del', p: ['tracks', 'V1'], id: 'cB' }] });
  let now = await api('GET', `/api/project?p=${P}`);
  same(now.tracks.V1.map((c) => c.id), ['cA', 'cB']);
  assert(now._rev > pj._rev, 'revision went up');
  const act = await api('GET', `/api/activity?p=${P}`);
  const addA = act.find((a) => a.label === 'add A');
  assert(addA?.revertable, 'add A is in the activity log and can be taken back');
  await api('POST', `/api/activity/revert?p=${P}&id=${encodeURIComponent(addA.id)}`);
  now = await api('GET', `/api/project?p=${P}`);
  same(now.tracks.V1.map((c) => c.id), ['cB'], 'only that change was taken back');
});

test('🗂 a moved file shows offline, relink finds it, the timeline keeps it', async () => {
  if (!ON) return 'skip';
  const moved = path.join(tmp, 'archive', 'Day 1');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(path.join(tmp, 'shoot', 'day1'), moved);
  const off = await api('GET', `/api/media/offline?p=${P}`);
  same(off.missing.map((m) => m.name).sort(), ['A.mp4', 'B.mp4']);
  assert(off.missing.find((m) => m.name === 'B.mp4').used, 'B is on the timeline');
  const scan = await job((await api('POST', `/api/media/relink/scan?p=${P}`, { dirs: [path.join(tmp, 'archive')] })).id);
  same(scan.result.found.length, 2, 'both found');
  const ap = await api('POST', `/api/media/relink/apply?p=${P}`, { pairs: scan.result.found.map((f) => ({ id: f.id, to: f.to })) });
  same(ap, { relinked: 2, offline: 0 });
  assert((await media()).every((m) => m.status === 'ready' && m.path.includes('archive')), 'ready at the new place');
});

test('📦 pack: a project folder with its own footage', async () => {
  if (!ON) return 'skip';
  const dest = path.join(tmp, 'packs'); fs.mkdirSync(dest);
  const r = (await job((await api('POST', `/api/pack?p=${P}`, { dest })).id)).result;
  same(r.files, 1, 'only what the timeline uses');
  const pm = JSON.parse(fs.readFileSync(path.join(r.folder, 'media.json'), 'utf8')).items;
  same(pm.map((m) => m.packRel), [path.join('Media', 'day1', 'B.mp4')], 'kept in its bin folder');
  assert(fs.existsSync(path.join(r.folder, 'Media', 'day1', 'B.mp4')) && fs.existsSync(path.join(r.folder, 'project.json')), 'files are there');
});

test('preview render makes a playable file of the right length', async () => {
  if (!ON) return 'skip';
  const j = await job((await api('POST', `/api/render?p=${P}`, { preview: true })).id, 180000);
  const out = path.join(tmp, 'Projects', NAME, 'renders', j.result.output);
  assert(fs.existsSync(out), 'output exists');
  const d = +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout;
  assert(Math.abs(d - 2) < 0.25, `duration ${d}s (want 2s)`);
});

test('🎬 In / Out on the timeline: the preview and export make only that part, "whole" makes all of it', async () => {
  if (!ON) return 'skip';
  const len = (j) => +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(tmp, 'Projects', NAME, 'renders', j.result.output)], { encoding: 'utf8' }).stdout;
  const pj = await api('GET', `/api/project?p=${P}`);
  delete pj._rev;
  pj.settings.range = { in: 0.5, out: 1.5 };
  await api('PUT', `/api/project?p=${P}`, pj);
  const a = await job((await api('POST', `/api/render?p=${P}`, { preview: true })).id, 180000);
  assert(Math.abs(len(a) - 1) < 0.2, `In-Out preview is ${len(a)}s (want 1s)`);
  const b = await job((await api('POST', `/api/render?p=${P}`, { preset: 'master', filename: 'whole', whole: true })).id, 180000);
  assert(Math.abs(len(b) - 2) < 0.25, `whole timeline is ${len(b)}s (want 2s)`);
  delete pj.settings.range;
  await api('PUT', `/api/project?p=${P}`, pj);
});

test('two renders started together write two different files', async () => {
  if (!ON) return 'skip';
  const [a, b] = await Promise.all([1, 2].map(() => api('POST', `/api/render?p=${P}`, { preset: 'master', filename: 'twice' })));
  const [ja, jb] = await Promise.all([job(a.id, 180000), job(b.id, 180000)]);
  assert(ja.result.output !== jb.result.output, `both wrote ${ja.result.output}`);
  for (const j of [ja, jb]) {
    const f = path.join(tmp, 'Projects', NAME, 'renders', j.result.output);
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' });
    assert(r.status === 0 && !r.stderr.trim() && Math.abs(+r.stdout - 2) < 0.25, `${j.result.output}: ${r.stderr.slice(0, 200)}`);
  }
});

test('💾 disk: counts the render and cleans the render cache', async () => {
  if (!ON) return 'skip';
  const d = await api('GET', `/api/disk?p=${P}`);
  // (the preview is renders/_preview.mp4: counted in the folder size, but not offered for deleting with the real renders)
  assert(d.parts.find((x) => x.key === 'renders').bytes > 0 && !d.renders.some((r) => r.file.startsWith('_')), 'preview counted, not listed');
  const c = await api('POST', `/api/disk/clean?p=${P}`, { what: 'segments' });
  same(c.disk.parts.find((x) => x.key === 'segments').bytes, 0);
});

test('🗑 delete moves a project to the Recycle Bin; refused while open; restore brings it back', async () => {
  if (!ON) return 'skip';
  const ctl = new AbortController();
  const stream = fetch(`${B}/api/live?p=${P}&client=holder`, { signal: ctl.signal }).catch(() => {});
  await sleep(300);
  let refused = false;
  try { await api('POST', `/api/projects/delete?p=${P}`); } catch (e) { refused = /Open right now/.test(e.message); }
  ctl.abort(); await stream; await sleep(300);
  assert(refused, 'refused while someone has it open');
  const r = await api('POST', `/api/projects/delete?p=${P}`);
  assert(r.folder.includes('Recycle Bin') && fs.existsSync(path.join(r.folder, 'project.json')), 'moved to the Recycle Bin');
  assert(!(await api('GET', '/api/projects')).some((x) => x.name === NAME), 'gone from the list');
  const del = await api('GET', '/api/projects/deleted');
  same(del.length, 1); assert(del[0].bytes > 0, 'its size is shown');
  const back = await api('POST', `/api/projects/restore?folder=${encodeURIComponent(del[0].folder)}`);
  same(back.name, NAME);
  assert((await api('GET', '/api/projects')).some((x) => x.name === NAME), 'back in the list');
  assert((await media()).length === 2, 'its media list is read again');
});

test('🗑 Recycle Bin: delete forever, empty, permanent delete - and nothing outside the bin can be removed', async () => {
  if (!ON) return 'skip';
  // two throwaway projects (no footage) besides the test project
  for (const n of ['Bin A', 'Bin B', 'Bin C']) await api('POST', '/api/projects', { name: n });
  await api('POST', `/api/projects/delete?p=${encodeURIComponent('Bin A')}`);
  await api('POST', `/api/projects/delete?p=${encodeURIComponent('Bin B')}`);
  let bin = await api('GET', '/api/projects/deleted');
  same(bin.length, 2);
  // a name that tries to leave the bin is refused, and the real project stays
  for (const evil of ['..', '../Projects', `..\\Projects\\${NAME}`, `..\\..\\Projects\\${NAME}`, '']) {
    let blocked = false; try { await api('POST', `/api/projects/purge?folder=${encodeURIComponent(evil)}`); } catch { blocked = true; }
    assert(blocked, `blocked: "${evil}"`);
  }
  assert(fs.existsSync(path.join(tmp, 'Projects', NAME, 'project.json')), 'the test project is still there');
  const one = bin.find((x) => x.name === 'Bin A');
  await api('POST', `/api/projects/purge?folder=${encodeURIComponent(one.folder)}`);
  bin = await api('GET', '/api/projects/deleted');
  same(bin.map((x) => x.name), ['Bin B'], 'one deleted for good');
  const e = await api('POST', '/api/projects/empty-bin');
  same(e.removed, 1); same((await api('GET', '/api/projects/deleted')).length, 0);
  // permanent delete straight from the Projects list: gone, not in the bin
  const pd = await api('POST', `/api/projects/delete?p=${encodeURIComponent('Bin C')}&permanent=1`);
  assert(pd.permanent, 'permanent');
  same((await api('GET', '/api/projects/deleted')).length, 0, 'not in the bin');
  assert(!(await api('GET', '/api/projects')).some((x) => x.name === 'Bin C'), 'gone from the list');
  assert(!fs.existsSync(path.join(tmp, 'Projects', 'Bin C')), 'folder removed');
  // every step is in the delete log, one JSON line each
  const log = fs.readFileSync(path.join(tmp, 'delete-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const acts = log.map((x) => `${x.action}: ${x.project}`);
  for (const want of ['moved to the Recycle Bin: Auto Test', 'restored: Auto Test', 'moved to the Recycle Bin: Bin A', 'deleted for good: Bin C']) assert(acts.includes(want), `log has "${want}" (${acts.join(' | ')})`);
  assert(log.some((x) => x.action.startsWith('deleted for good from the Recycle Bin')) && log.some((x) => x.action.includes('emptied')), 'purge and empty are logged');
  assert(log.every((x) => x.at && x.who), 'when and who');
});

test('🔗 auto-relink: a moved folder is found by itself; a relink teaches the move for the other files', async () => {
  if (!ON) return 'skip';
  const N2 = 'Auto Relink', P2 = encodeURIComponent(N2), day = path.join(tmp, 'shoot2', 'day');
  fs.mkdirSync(day, { recursive: true });
  for (const [n, c] of [['X.mp4', 'red'], ['Y.mp4', 'blue']]) ff(['-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=25:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(day, n)]);
  await api('POST', '/api/projects', { name: N2, folder: path.join(tmp, 'shoot2') });
  const ready = async (pred, ms = 15000) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { const it = (await api('GET', `/api/media?p=${P2}`)).items; if (pred(it)) return it; await sleep(400); } return (await api('GET', `/api/media?p=${P2}`)).items; };
  await ready((it) => it.length === 2 && it.every((m) => m.status === 'ready'));
  // 1) moved next door: found and linked with no click
  fs.mkdirSync(path.join(tmp, 'shoot2', 'moved'), { recursive: true });
  fs.renameSync(day, path.join(tmp, 'shoot2', 'moved', 'day'));
  await api('GET', `/api/media/offline?p=${P2}`); // looks now (the editor also looks every 10 s)
  let it = await ready((x) => x.every((m) => m.status === 'ready' && m.path.includes('moved')));
  assert(it.every((m) => m.status === 'ready' && m.path.includes('moved')), `found by itself: ${it.map((m) => `${m.status} ${m.path}`).join(' | ')}`);
  // 2) moved far away (the search would not look there): one file relinked by hand, the other follows by itself
  fs.mkdirSync(path.join(tmp, 'far', 'away'), { recursive: true });
  fs.renameSync(path.join(tmp, 'shoot2', 'moved', 'day'), path.join(tmp, 'far', 'away', 'day'));
  await api('GET', `/api/media/offline?p=${P2}`);
  it = (await api('GET', `/api/media?p=${P2}`)).items;
  const X = it.find((m) => m.name === 'X.mp4');
  await api('POST', `/api/media/relink/apply?p=${P2}`, { pairs: [{ id: X.id, to: path.join(tmp, 'far', 'away', 'day', 'X.mp4') }] });
  await api('GET', `/api/media/offline?p=${P2}`);
  it = await ready((x) => x.every((m) => m.status === 'ready' && m.path.includes('away')), 5000);
  assert(it.every((m) => m.status === 'ready' && m.path.includes('away')), `Y followed X: ${it.map((m) => `${m.status} ${m.path}`).join(' | ')}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert((cfg.relinkMap || []).some((x) => x.to.includes('away')), 'the move was learnt');
});

test('📁 Home folders: projects grouped, bad ids and unknown projects dropped, a deleted project leaves its folder', async () => {
  if (!ON) return 'skip';
  const r = await api('POST', '/api/project-folders', { folders: [{ id: 'f1', name: 'Clients' }, { id: '../x', name: 'Bad id' }, { id: 'f1', name: 'dup' }], map: { [NAME]: 'f1', 'No such project': 'f1' } });
  assert(r.folders.length === 2 && r.folders[1].id === 'x', `ids cleaned: ${JSON.stringify(r.folders)}`);
  assert(Object.keys(r.map).length === 1 && r.map[NAME] === 'f1', `only real projects: ${JSON.stringify(r.map)}`);
  const list = await api('GET', '/api/projects');
  assert(list.find((p) => p.name === NAME)?.group === 'f1', 'the project list says which folder');
});

test('📍 project saved in another folder: listed, opened from its folder, deleted to the Recycle Bin', async () => {
  if (!ON) return 'skip';
  const place = path.join(tmp, 'elsewhere');
  fs.mkdirSync(place, { recursive: true });
  const r = await api('POST', '/api/projects', { name: 'Placed', place });
  same(r.folder, path.join(place, 'Placed'));
  assert(fs.existsSync(path.join(place, 'Placed', 'project.json')), 'project.json is in the chosen folder');
  assert(!fs.existsSync(path.join(tmp, 'Projects', 'Placed')), 'nothing in Projects');
  let p = (await api('GET', '/api/projects')).find((x) => x.name === 'Placed');
  same(p?.place, path.join(place, 'Placed'));
  same((await api('GET', '/api/project?p=Placed')).name, 'Placed');
  // a project folder from somewhere else (as if made on another drive) is taken into the list
  const other = path.join(tmp, 'nas', 'Old Edit');
  fs.cpSync(path.join(place, 'Placed'), other, { recursive: true });
  same((await api('POST', '/api/projects/open-folder', { dir: other })).name, 'Old Edit');
  assert((await api('GET', '/api/projects')).some((x) => x.name === 'Old Edit'), 'opened project is listed');
  await api('POST', '/api/projects/delete?p=Placed');
  assert(!fs.existsSync(path.join(place, 'Placed')), 'moved out of its folder');
  assert(!(await api('GET', '/api/projects')).some((x) => x.name === 'Placed'), 'gone from the list');
  assert((await api('GET', '/api/projects/deleted')).some((x) => x.name === 'Placed'), 'in the Recycle Bin');
});

test('⬆ upload in pieces: a piece sent twice is skipped, a break carries on, the file lands in the open folder', async () => {
  if (!ON) return 'skip';
  const src = path.join(tmp, 'up-src.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
  const data = fs.readFileSync(src), half = Math.floor(data.length / 2), key = 'testkey123';
  const qs = `p=${P}&key=${key}&total=${data.length}&name=Pieces.mp4&bin=Interviews`;
  const put = async (off, buf) => (await fetch(`${B}/api/upload/part?${qs}&off=${off}`, { method: 'POST', body: buf })).json();
  same((await put(0, data.subarray(0, half))).have, half);
  same((await put(0, data.subarray(0, half))).again, true); // (the same piece again: nothing added)
  same((await api('GET', `/api/upload/part?p=${P}&key=${key}`)).have, half);
  const r = await put(half, data.subarray(half));
  same(r.done, true);
  same(r.bin, 'Interviews');
  const m = (await media()).find((x) => x.id === r.id);
  same(fs.readFileSync(m.path).length, data.length);
  assert(!fs.readdirSync(path.join(tmp, 'Projects', NAME, 'imports')).some((f) => f.endsWith('.part')), 'no piece file left');
});

test('📅 every edited day keeps a backup of its own, listed in Versions', async () => {
  if (!ON) return 'skip';
  const pj = await api('GET', `/api/project?p=${P}`); delete pj._rev;
  pj.markers = [...(pj.markers || []), { id: 'mk-daily', t: 0.5, note: 'daily backup test' }];
  await api('PUT', `/api/project?p=${P}&backup=1`, pj);
  const dir = path.join(tmp, 'Projects', NAME, 'backups');
  for (let i = 0; i < 20 && !fs.readdirSync(dir).some((f) => f.startsWith('daily_')); i++) await sleep(250);
  assert(fs.readdirSync(dir).some((f) => /^daily_\d{4}-\d\d-\d\d\.json$/.test(f)), 'a daily_<date>.json backup');
  assert((await api('GET', `/api/versions?p=${P}`)).some((v) => /End of that day/.test(v.label)), 'it is in the Versions list');
});

test('❗ files that cannot be used say why: an empty video, camera RAW in a folder', async () => {
  if (!ON) return 'skip';
  const dir = path.join(tmp, 'mixed');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Empty.mp4'), '');
  fs.writeFileSync(path.join(dir, 'A001.braw'), 'x'.repeat(4096));
  fs.writeFileSync(path.join(dir, 'Edit.prproj'), 'x');
  const r = await api('POST', `/api/import?p=${P}`, { folder: dir });
  same(r.added, 1);
  same(r.notUsed.map((x) => x.ext).sort(), ['.braw', '.prproj']);
  let m;
  for (let i = 0; i < 40; i++) { m = (await media()).find((x) => x.name === 'Empty.mp4'); if (m?.status === 'error') break; await sleep(250); }
  same(m?.status, 'error');
  assert(/empty/i.test(m.error), `says why: ${m.error}`);
});

test('📂 File > Open: an exported Premiere XML comes back as a new project with the same cut', async () => {
  if (!ON) return 'skip';
  const name = 'XmlSrc', shoot = path.join(tmp, 'xmlshoot');
  fs.mkdirSync(shoot, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=4', '-f', 'lavfi', '-i', 'sine=f=300:d=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(shoot, 'X.mp4')]);
  await api('POST', '/api/projects', { name, folder: shoot });
  let m;
  for (let i = 0; i < 60; i++) { m = (await api('GET', `/api/media?p=${name}`)).items[0]; if (m?.status === 'ready') break; await sleep(300); }
  const pj = await api('GET', `/api/project?p=${name}`); delete pj._rev;
  pj.tracks.V1 = [{ id: 'a1', type: 'video', mediaId: m.id, in: 0.5, out: 2 }, { id: 'a2', type: 'video', mediaId: m.id, in: 2.5, out: 3.5 }];
  pj.tracks.V2 = [{ id: 'b1', type: 'video', mediaId: m.id, start: 1, in: 0, out: 1 }];
  await api('PUT', `/api/project?p=${name}`, pj);
  const ex = await api('POST', `/api/export/timeline?p=${name}`, { filename: 'roundtrip', color: 'none', collect: 'none' });
  const xmlFile = fs.readdirSync(ex.path).find((f) => f.endsWith('.xml'));
  const r = await api('POST', '/api/projects/open-xml', { xml: fs.readFileSync(path.join(ex.path, xmlFile), 'utf8') });
  same(r.missingCount, 0);
  const got = await api('GET', `/api/project?p=${encodeURIComponent(r.name)}`);
  const v1 = got.tracks.V1.filter((c) => !c.gap);
  same(v1.map((c) => [c.in, c.out]), [[0.5, 2], [2.5, 3.5]]);
  same(got.tracks.V2.map((c) => [c.start, c.in, c.out]), [[1, 0, 1]]);
  assert(got.tracks.V1.every((c) => c.gap || c.mute), 'pictures are picture only (their sound is on the A tracks)');
  assert(Object.entries(got.tracks).some(([t, l]) => t[0] === 'A' && l.length), 'the sound came across on an A track');
});

test('🚚 move a project to an editor\'s folder: copied, its own files pointed at the new place, old folder gone', async () => {
  if (!ON) return 'skip';
  await api('POST', '/api/projects', { name: 'Mover' });
  const own = path.join(tmp, 'Projects', 'Mover', 'imports', 'own.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', own]);
  await api('POST', '/api/import?p=Mover', { files: [own] });
  const dest = path.join(tmp, 'nas', 'Editor Projects', 'Vishal');
  fs.mkdirSync(path.dirname(dest), { recursive: true }); // (Vishal's own folder is made by the move)
  const j = await api('POST', '/api/projects/move?p=Mover', { place: dest });
  let r = null;
  for (let i = 0; i < 60 && !r; i++) { const x = await api('GET', `/api/job?id=${j.id}`); if (x.status !== 'running') r = x; else await sleep(300); }
  same(r?.status, 'done');
  assert(!fs.existsSync(path.join(tmp, 'Projects', 'Mover')), 'old folder removed');
  assert(fs.existsSync(path.join(dest, 'Mover', 'project.json')), 'project in the new folder');
  same((await api('GET', '/api/projects')).find((x) => x.name === 'Mover')?.place, path.join(dest, 'Mover'));
  same((await api('GET', '/api/media?p=Mover')).items[0]?.path, path.join(dest, 'Mover', 'imports', 'own.mp4'));
});

test('⭐ a render queued on the server PC itself goes first; Urgent cannot move it down', async () => {
  if (!ON) return 'skip';
  const { added } = await api('POST', `/api/queue?p=${P}`, { items: [{ preset: 'master', filename: 'prio-a' }, { preset: 'master', filename: 'prio-b', urgent: true }] });
  same(added.map((x) => x.priority), [2, 2], 'this test talks to the editor from its own PC');
  const waiting = (await api('GET', '/api/queue')).items.find((x) => added.some((a) => a.id === x.id) && x.state === 'waiting');
  if (waiting) same((await api('POST', `/api/queue/urgent?id=${waiting.id}&on=0`)).priority, 2);
  for (const a of added) await api('POST', `/api/queue/cancel?id=${a.id}`).catch(() => {});
});

test('✏ rename a project: its folder, its own files and the list follow; a taken name or an open project is refused', async () => {
  if (!ON) return 'skip';
  await api('POST', '/api/projects', { name: 'Old Name' });
  const own = path.join(tmp, 'Projects', 'Old Name', 'imports', 'take.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', own]);
  await api('POST', '/api/import?p=Old%20Name', { files: [own] });
  await api('POST', '/api/projects', { name: 'Taken' });
  let refused = null;
  try { await api('POST', '/api/projects/rename?p=Old%20Name', { name: 'taken' }); } catch (e) { refused = e.message; }
  assert(/already/.test(refused || ''), `a taken name is refused (${refused})`);
  // open (someone is in it): refused
  const ac = new AbortController();
  fetch(`${B}/api/live?p=Old%20Name&client=t9`, { signal: ac.signal }).then((r) => r.body.getReader().read()).catch(() => {});
  await sleep(500);
  refused = null;
  try { await api('POST', '/api/projects/rename?p=Old%20Name', { name: 'New Name' }); } catch (e) { refused = e.message; }
  ac.abort(); await sleep(500);
  assert(/Open right now/.test(refused || ''), `an open project is refused (${refused})`);
  const r = await api('POST', '/api/projects/rename?p=Old%20Name', { name: 'New Name' });
  same(r.name, 'New Name');
  assert(!fs.existsSync(path.join(tmp, 'Projects', 'Old Name')) && fs.existsSync(path.join(tmp, 'Projects', 'New Name', 'project.json')), 'the folder has the new name');
  const names = (await api('GET', '/api/projects')).map((x) => x.name);
  assert(names.includes('New Name') && !names.includes('Old Name'), `the list has only the new name: ${names}`);
  same((await api('GET', '/api/media?p=New%20Name')).items[0]?.path, path.join(tmp, 'Projects', 'New Name', 'imports', 'take.mp4'));
});

test('stop the test editor and remove its folder', async () => {
  if (!ON) return 'skip';
  srv?.kill();
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
