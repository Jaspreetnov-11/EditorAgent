// 💾 the NAS going away while a project is open (only with `node tests/run.mjs --server`): a second editor on a spare
// port with a throwaway data folder, where one folder plays "the NAS" (team.remoteDrives). The NAS goes away (a file
// takes its place, so not even a folder can be made there - like a drive that is gone): the open project still takes
// edits, kept in <data>/PendingSaves, and the health page says so; the NAS comes back: the kept save is written onto it.
import { test, eq as same, assert } from './harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const PORT = 3935, B = `http://127.0.0.1:${PORT}`, NAME = 'Nas Test', P = encodeURIComponent(NAME);
let srv = null, tmp = null, nas = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(m, u, b) {
  const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${m} ${u} -> ${r.status} ${t.slice(0, 200)}`);
  return j;
}
const op = (id, text) => ({ label: 'add title', ops: [{ o: 'ins', p: ['tracks', 'V1'], v: { id, type: 'title', text, dur: 2 }, after: null }], inv: [{ o: 'del', p: ['tracks', 'V1'], id }] });
const kept = () => { try { return fs.readdirSync(path.join(tmp, 'PendingSaves')).filter((f) => f.endsWith('.json')); } catch { return []; } };

test('nas down: a test editor with a project on "the NAS"', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-nasdown-'));
  nas = path.join(tmp, 'nas'); fs.mkdirSync(nas);
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ team: { users: [], remoteDrives: [nas] } }));
  srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1', VEDIT_CLUSTER: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) { try { await api('GET', '/api/version'); break; } catch {} if (i > 60) throw new Error(`test editor did not start:\n${log.slice(-800)}`); await sleep(500); }
  await api('POST', '/api/projects', { name: NAME, place: nas });
  await api('GET', `/api/project?p=${P}`);
  await api('POST', `/api/live/ops?p=${P}&client=t1`, op('t1', 'before'));
  await sleep(800);
  assert(fs.readFileSync(path.join(nas, NAME, 'project.json'), 'utf8').includes('before'), 'saved on the NAS');
});

test('nas down: edits are kept here while the NAS is away, and written back when it answers', async () => {
  if (!ON) return 'skip';
  fs.renameSync(nas, `${nas}-away`); fs.writeFileSync(nas, ''); // (the NAS stops answering: not even a folder can be made there)
  await api('POST', `/api/live/ops?p=${P}&client=t1`, op('t2', 'while away'));
  await sleep(1000);
  same(kept().length, 1);
  assert(fs.readFileSync(path.join(tmp, 'PendingSaves', kept()[0]), 'utf8').includes('while away'), 'the edit is kept on this PC');
  assert((await api('GET', `/api/project?p=${P}`)).tracks.V1.some((c) => c.text === 'while away'), 'the open project still has it');
  const health = await api('GET', '/api/safety');
  assert(health.warn.some((w) => /NAS is not answering/.test(w.text)), 'the health page says so');
  fs.rmSync(nas); fs.renameSync(`${nas}-away`, nas); // (the NAS is back)
  for (let i = 0; i < 40 && kept().length; i++) await sleep(1000);
  same(kept().length, 0);
  const onNas = fs.readFileSync(path.join(nas, NAME, 'project.json'), 'utf8');
  assert(onNas.includes('while away') && onNas.includes('before'), 'both edits are on the NAS');
});

test('nas down: a second NAS gets the live mirror too (safety.replica)', async () => {
  if (!ON) return 'skip';
  const backups = path.join(tmp, 'backups'), nas2 = path.join(tmp, 'nas2');
  // (the editor looks at the NAS projects every 15 s: after the NAS was away, until then it is not on the list)
  for (let i = 0; i < 40 && !(await api('GET', '/api/projects')).some((x) => (x.name || x) === NAME); i++) await sleep(500);
  await api('POST', '/api/safety', { dest: backups, mirror: true, replica: nas2 });
  const f = path.join(nas2, 'live', 'Projects', NAME, 'project.json');
  for (let i = 0; i < 40 && !fs.existsSync(f); i++) await sleep(250);
  assert(fs.existsSync(f), `the project is on the second NAS (${JSON.stringify((await api('GET', '/api/safety')).warn)})`);
  assert(fs.readFileSync(f, 'utf8').includes('while away'), 'with the latest edits');
  assert(fs.existsSync(path.join(backups, 'live', 'Projects', NAME, 'project.json')), 'and in the usual mirror');
});

test('nas down: stop the test editor', async () => {
  if (!ON) return 'skip';
  srv?.kill(); await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
