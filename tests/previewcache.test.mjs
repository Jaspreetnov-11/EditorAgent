// 💽 preview copies of NAS projects kept on this PC's drive (only with `node tests/run.mjs --server`): a second editor on
// a spare port with a throwaway data folder, where one folder plays "the NAS" (team.remoteDrives). The first play of a
// preview copy copies it to <data>/PreviewCache; later plays come from there with the same ETag (browsers keep theirs).
import { test, eq as same, assert } from './harness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const PORT = 3927, B = `http://127.0.0.1:${PORT}`, NAME = 'Cache Test', P = encodeURIComponent(NAME);
let srv = null, tmp = null, nas = null, clip = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(m, u, b) {
  const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${m} ${u} -> ${r.status} ${t.slice(0, 200)}`);
  return j;
}

test('preview cache: a test editor with a project on "the NAS" and a clip that needs a preview copy', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-pcache-'));
  nas = path.join(tmp, 'nas'); fs.mkdirSync(path.join(nas, 'shoot'), { recursive: true });
  // (MPEG-2: the browser cannot play it, so the editor makes a preview copy)
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=2', '-c:v', 'mpeg2video', '-q:v', '4', path.join(nas, 'shoot', 'A.mpg')]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ team: { users: [], remoteDrives: [nas] } }));
  srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1', VEDIT_CLUSTER: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) { try { await api('GET', '/api/version'); break; } catch {} if (i > 60) throw new Error(`test editor did not start:\n${log.slice(-800)}`); await sleep(500); }
  await api('POST', '/api/projects', { name: NAME, folder: path.join(nas, 'shoot'), place: nas });
  for (let i = 0; i < 120; i++) { clip = (await api('GET', `/api/media?p=${P}`)).items[0]; if (clip?.proxy === 'ready') break; await sleep(500); }
  same(clip?.proxy, 'ready');
  assert(fs.existsSync(path.join(nas, NAME, 'cache', 'proxies', `${clip.id}.mp4`)), 'the preview copy is in the project on "the NAS"');
});

test('preview cache: first play copies it to this PC; then it comes from there, same ETag', async () => {
  if (!ON) return 'skip';
  const first = await fetch(B + clip.urls.play);
  same(first.status, 200); const tag = first.headers.get('etag'); await first.arrayBuffer();
  const dir = path.join(tmp, 'PreviewCache');
  for (let i = 0; i < 40 && !(fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.mp4'))); i++) await sleep(150);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4'));
  same(files.length, 1);
  same(fs.statSync(path.join(dir, files[0])).size, fs.statSync(path.join(nas, NAME, 'cache', 'proxies', `${clip.id}.mp4`)).size);
  // played again: from the local copy, with the same ETag, so a browser's kept copy stays good
  const nasCopy = path.join(nas, NAME, 'cache', 'proxies', `${clip.id}.mp4`);
  const second = await fetch(B + clip.urls.play, { headers: { Range: 'bytes=0-99' } });
  same(second.status, 206); same(second.headers.get('etag'), tag);
  same((await fetch(B + clip.urls.play, { headers: { 'If-None-Match': tag } })).status, 304);
  assert(fs.existsSync(nasCopy), 'the NAS copy stays the real one');
});

test('preview cache: stop the test editor', async () => {
  if (!ON) return 'skip';
  srv?.kill(); await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
