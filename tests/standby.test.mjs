// 🖥 standby with the NAS down too (only with `node tests/run.mjs --server`): engine/standby.mjs keeps its own copy of
// the live mirror while "the NAS" answers; then the NAS folder goes away and the main editor does not answer - the
// standby still starts the editor, from its own copy, and the project is there. (About a minute: it waits 30 s.)
import { test, eq as same, assert } from './harness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const PORT = 3933;
let sb = null, tmp = null, log = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (p) => { if (!p) return; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); else p.kill('SIGKILL'); };

test('standby: keeps its own copy of the mirror, and starts from it when the NAS is gone', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-standby-'));
  const live = path.join(tmp, 'nas', 'live'), local = path.join(tmp, 'local');
  const pd = path.join(live, 'Projects', 'Mirror Test');
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(live, 'mirror.json'), JSON.stringify({ host: 'MAIN', at: Date.now(), projects: { 'Mirror Test': { name: 'Mirror Test', dir: 'Z:\\Editor Projects\\Mirror Test', at: Date.now() } } }));
  fs.writeFileSync(path.join(pd, 'project.json'), JSON.stringify({ name: 'Mirror Test', settings: { aspect: '16:9', fps: 25 }, tracks: { V1: [], A1: [] } }));
  fs.writeFileSync(path.join(pd, 'media.json'), JSON.stringify({ items: [] }));
  sb = spawn(process.execPath, [path.join(ROOT, 'engine', 'standby.mjs'), '--main', 'http://127.0.0.1:9/', '--mirror', live, '--local', local, '--after', '30', '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  sb.stdout.on('data', (d) => { log += d; }); sb.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 40 && !fs.existsSync(path.join(local, 'Projects', 'Mirror Test', 'project.json')); i++) await sleep(250);
  assert(fs.existsSync(path.join(local, 'mirror.json')), `the mirror was copied to this PC:\n${log}`);
  fs.renameSync(path.join(tmp, 'nas'), path.join(tmp, 'nas-gone')); // (the NAS stops answering)
  let up = null;
  for (let i = 0; i < 120 && !up; i++) { await sleep(1000); try { const r = await fetch(`http://127.0.0.1:${PORT}/api/projects`, { signal: AbortSignal.timeout(2000) }); if (r.ok) up = await r.json(); } catch {} }
  assert(up, `the standby editor started:\n${log.slice(-1500)}`);
  assert(up.some((x) => (x.name || x) === 'Mirror Test'), 'the project from its own copy is there');
  assert(/running from this PC's copy/.test(log), 'it says it runs from its own copy');
});

test('standby: stop it', async () => {
  if (!ON) return 'skip';
  killTree(sb); await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
