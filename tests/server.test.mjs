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

test('stop the test editor and remove its folder', async () => {
  if (!ON) return 'skip';
  srv?.kill();
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
