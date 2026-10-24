// 🛡 the pre-deploy blockers (only with `node tests/run.mjs --server`): a second editor on spare ports with a throwaway
// data folder (VEDIT_DATA) - the running editor, its team and config are never touched. Checks:
//   the owner port refuses other sites' pages and other host names · relink only to a file of the clip's kind (and from
//   another PC only on the NAS) · sign-in: small body, tries limited · disk / delete answer without holding the server ·
//   config.json: a half-written file does not lose the team · media files: ranges and a missing file.
import { test, eq as same, assert } from './harness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const PORT = 3923, TEAM = 3924, L = `http://127.0.0.1:${PORT}`, T = `http://127.0.0.1:${TEAM}`, NAME = 'Guard Test', P = encodeURIComponent(NAME);
let srv = null, tmp = null, clip = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(base, m, u, b, headers = {}) {
  const r = await fetch(base + u, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: b === undefined ? undefined : typeof b === 'string' ? b : JSON.stringify(b) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, cookie: (/ve_sess=([^;]*)/.exec(r.headers.get('set-cookie') || '') || [])[0] };
}
const ff = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status !== 0) throw new Error(String(r.stderr)); };

test('guard: start a test editor (own ports, own data folder)', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-guard-'));
  fs.mkdirSync(path.join(tmp, 'shoot'));
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(tmp, 'shoot', 'A.mp4')]);
  ff(['-f', 'lavfi', '-i', 'smptebars=s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(tmp, 'B.mp4')]);
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'not a clip');
  for (const junk of ['Adobe Premiere Pro Video Previews', '@Recycle']) { fs.mkdirSync(path.join(tmp, 'shoot', junk)); fs.copyFileSync(path.join(tmp, 'shoot', 'A.mp4'), path.join(tmp, 'shoot', junk, 'Rendered.mp4')); }
  srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TEAM_PORT: String(TEAM), VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1', VEDIT_CLUSTER: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) { try { if ((await call(L, 'GET', '/api/version')).status === 200) break; } catch {} if (i > 60) throw new Error(`test editor did not start:\n${log.slice(-800)}`); await sleep(500); }
  same((await call(L, 'POST', '/api/projects', { name: NAME, folder: path.join(tmp, 'shoot') })).status, 200);
  for (let i = 0; i < 80; i++) { const m = (await call(L, 'GET', `/api/media?p=${P}`)).body.items || []; clip = m.find((x) => x.name === 'A.mp4'); if (clip?.status === 'ready') break; await sleep(400); }
  assert(clip?.status === 'ready', 'the clip was read');
  same((await call(L, 'GET', `/api/media?p=${P}`)).body.items.map((x) => x.name), ['A.mp4']); // (Premiere previews / NAS recycle bin left out)
  for (const u of [{ name: 'Ravi', password: 'ravi-pass-1', role: 'editor' }]) same((await call(L, 'PUT', '/api/team', { addUser: u })).status, 200);
  same((await call(L, 'PUT', '/api/team', { on: true })).status, 200);
});

test('guard: the owner port refuses other host names and other sites\' pages', async () => {
  if (!ON) return 'skip';
  same((await call(L, 'GET', '/api/version')).status, 200); // (edtool, the tray: no Origin)
  // (plain requests: fetch sets Host and the Sec-Fetch headers itself - these are the headers a browser sends)
  const raw = (method, p, headers) => new Promise((ok, bad) => { const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (s) => { s.resume(); ok(s.statusCode); }); r.on('error', bad); r.end(method === 'POST' ? 'x' : undefined); });
  same(await raw('GET', '/api/projects', { Host: `evil.example:${PORT}` }), 403); // (DNS rebinding)
  same(await raw('POST', `/api/projects/delete?p=${P}&permanent=1`, { 'Content-Type': 'text/plain', Origin: 'https://evil.example' }), 403);
  same(await raw('POST', '/api/shutdown', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' }), 403);
  same(await raw('GET', '/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' }), 200); // (a link to the editor still opens it)
  same(await raw('GET', `/api/project?p=${P}`, { Origin: `http://localhost:${PORT}`, 'Sec-Fetch-Site': 'same-origin' }), 200);
  assert((await call(L, 'GET', '/api/projects')).body.some((x) => (x.name || x) === NAME), 'the project is still there');
});

test('guard: relink only to a file of the clip\'s own kind; from another PC only on the NAS', async () => {
  if (!ON) return 'skip';
  const toCfg = await call(L, 'POST', `/api/media/relink/apply?p=${P}`, { pairs: [{ id: clip.id, to: path.join(tmp, 'config.json') }] });
  same(toCfg.status, 400);
  same((await call(L, 'POST', `/api/media/relink/apply?p=${P}`, { pairs: [{ id: clip.id, to: path.join(tmp, 'notes.txt') }] })).status, 400);
  const ed = (await call(T, 'POST', '/team/login', { name: 'Ravi', password: 'ravi-pass-1' })).cookie;
  // (🔐 the project is the owner's: another PC's editor does not even see it until it is shared with them)
  same((await call(T, 'POST', `/api/media/relink/apply?p=${P}`, { pairs: [{ id: clip.id, to: path.join(tmp, 'B.mp4') }] }, { Cookie: ed })).status, 404);
  same((await call(L, 'POST', `/api/projects/share?p=${P}`, { shared: ['Ravi'] })).status, 200);
  const remote = await call(T, 'POST', `/api/media/relink/apply?p=${P}`, { pairs: [{ id: clip.id, to: path.join(tmp, 'B.mp4') }] }, { Cookie: ed });
  same(remote.status, 403); // (the test files are not on the NAS drive)
  const ok = await call(L, 'POST', `/api/media/relink/apply?p=${P}`, { pairs: [{ id: clip.id, to: path.join(tmp, 'B.mp4') }] });
  same(ok.status, 200); same(ok.body.relinked, 1);
});

test('guard: media files - a byte range, and a missing file is a clean 404', async () => {
  if (!ON) return 'skip';
  const m = (await call(L, 'GET', `/api/media?p=${P}`)).body.items.find((x) => x.id === clip.id);
  const r = await fetch(L + m.urls.play.replace(/\/play$/, '/orig'), { headers: { Range: 'bytes=0-99' } });
  same(r.status, 206); same((await r.arrayBuffer()).byteLength, 100);
  // 💾 the browser keeps it: asked again with its ETag -> 304, nothing read; an older ETag with If-Range -> the whole file
  const tag = r.headers.get('etag');
  assert(tag && /no-cache/.test(r.headers.get('cache-control')), 'cacheable, with an ETag');
  same((await fetch(L + m.urls.play.replace(/\/play$/, '/orig'), { headers: { 'If-None-Match': tag } })).status, 304);
  same((await fetch(L + m.urls.play.replace(/\/play$/, '/orig'), { headers: { Range: 'bytes=0-99', 'If-Range': '"old-version"' } })).status, 200);
  fs.renameSync(path.join(tmp, 'B.mp4'), path.join(tmp, 'B-gone.mp4'));
  try { same((await fetch(L + m.urls.play.replace(/\/play$/, '/orig'))).status, 404); }
  finally { fs.renameSync(path.join(tmp, 'B-gone.mp4'), path.join(tmp, 'B.mp4')); }
  same((await call(L, 'GET', '/api/version')).status, 200); // (still answering)
});

test('guard: sign-in - a huge body is refused, wrong tries are limited per name', async () => {
  if (!ON) return 'skip';
  same((await call(T, 'POST', '/team/login', { name: 'Ravi', password: 'x'.repeat(10000) })).status, 413);
  for (let i = 0; i < 10; i++) same((await call(T, 'POST', '/team/login', { name: 'ravi', password: `wrong-${i}` })).status, 401);
  const locked = await call(T, 'POST', '/team/login', { name: 'Ravi', password: 'ravi-pass-1' });
  same(locked.status, 429); assert(/wait/i.test(locked.body.error), 'says to wait');
});

test('guard: disk sizes and the Recycle Bin answer (asynchronously)', async () => {
  if (!ON) return 'skip';
  const all = await call(L, 'GET', '/api/disk/all');
  same(all.status, 200); assert(all.body.find((x) => x.project === NAME)?.bytes > 0, 'project size');
  const one = await call(L, 'GET', `/api/disk?p=${P}`);
  same(one.status, 200); assert(one.body.total > 0 && Array.isArray(one.body.parts), 'disk parts');
  same((await call(L, 'POST', '/api/projects', { name: 'Throwaway' })).status, 200);
  const del = await call(L, 'POST', `/api/projects/delete?p=${encodeURIComponent('Throwaway')}`);
  same(del.status, 200);
  const bin = await call(L, 'GET', '/api/projects/deleted');
  assert(bin.body.some((x) => x.name === 'Throwaway' && x.bytes >= 0), 'in the Recycle Bin with its size');
  const purge = await call(L, 'POST', '/api/projects/empty-bin');
  same(purge.status, 200); same(purge.body.removed, 1);
});

test('guard: a half-written config.json does not lose the team', async () => {
  if (!ON) return 'skip';
  const cf = path.join(tmp, 'config.json'), good = fs.readFileSync(cf, 'utf8');
  fs.writeFileSync(cf, good.slice(0, Math.floor(good.length / 2))); // (caught half way through a save)
  try {
    const team = await call(L, 'GET', '/api/team');
    same(team.status, 200); assert(team.body.users.some((x) => x.name === 'Ravi'), 'the users are still known');
    const bad = await call(L, 'PUT', '/api/team', { libraries: [] }); // (a save now uses the last good copy)
    same(bad.status, 200);
    assert(JSON.parse(fs.readFileSync(cf, 'utf8')).team.users.some((x) => x.name === 'Ravi'), 'the save kept the users');
  } finally { if (!fs.readFileSync(cf, 'utf8').trim().endsWith('}')) fs.writeFileSync(cf, good); }
});

test('guard: stop the test editor', async () => {
  if (!ON) return 'skip';
  srv?.kill(); await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
