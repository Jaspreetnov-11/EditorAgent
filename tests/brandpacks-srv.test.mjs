// 🏷 Client brand packs end to end, on a second editor (own port, own throwaway data folder; only with
// `node tests/run.mjs --server`): the old brand kit migrated, a pack made with an uploaded logo and intro, a project
// started from it, another pack's files brought into a project, duplicate and delete.
import { test, eq as same, assert } from './harness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ON = process.env.VEDIT_TEST_SERVER === '1';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3937, B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let srv = null, tmp = null;
async function api(method, url, body, raw = false) {
  const r = await fetch(B + url, { method, headers: raw ? {} : { 'content-type': 'application/json' }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(j?.error || `${r.status}`), { status: r.status });
  return j;
}
const ff = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status !== 0) throw new Error(String(r.stderr)); };
let logo = '', intro = '', packA = null, packB = null;

test('packs: a test editor starts and the old brand kit is the first pack', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-packs-srv-'));
  fs.mkdirSync(path.join(tmp, 'Library'), { recursive: true });
  logo = path.join(tmp, 'logo.png'); intro = path.join(tmp, 'intro.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=orange:s=200x100', '-frames:v', '1', logo]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', intro]);
  fs.writeFileSync(path.join(tmp, 'Library', 'brand.json'), JSON.stringify({ primary: '#123456', accent: '#ff9933', text: '#ffffff', logo, endText: 'mybharat.gov.in', capPreset: 'box' }));
  srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { await api('GET', '/api/version'); break; } catch { await sleep(500); } if (i === 59) throw new Error(`test editor did not start:\n${log.slice(-800)}`); }
  const l = await api('GET', '/api/library/brandpacks');
  same(l.map((p) => [p.name, p.primary, p.endText, p.has.logo]), [['Brand kit', '#123456', 'mybharat.gov.in', true]]);
});

test('packs: make one, upload its logo, take its intro from a file, refuse a second of the same name', async () => {
  if (!ON) return 'skip';
  packA = await api('POST', '/api/library/brandpacks/save', { pack: { name: 'Khelo India', primary: '#b71c1c', accent: '#ffd400', ltTitle: 'lt-strip', capPreset: 'reel' } });
  const up = await api('POST', `/api/library/brandpacks/upload?id=${packA.id}&slot=logo&name=KI%20logo.png`, fs.readFileSync(logo), true);
  same(up.logo, 'logo.png');
  same((await api('POST', '/api/library/brandpacks/addpath', { id: packA.id, slot: 'intro', path: intro })).intro, 'intro.mp4');
  const r = await fetch(`${B}/api/library/brandpacks/file?id=${packA.id}&slot=logo`);
  same([r.status, (await r.arrayBuffer()).byteLength], [200, fs.statSync(logo).size]);
  const e = await api('POST', '/api/library/brandpacks/save', { pack: { name: 'khelo india' } }).catch((x) => x);
  same(e.status, 409);
  packB = (await api('GET', '/api/library/brandpacks')).find((p) => p.name === 'Brand kit');
});

test('packs: a new project starts from a pack (logo, intro, styles), the other pack comes in by "use"', async () => {
  if (!ON) return 'skip';
  await api('POST', '/api/projects', { name: 'Pack Test', pack: packA.id });
  const pj = await api('GET', '/api/project?p=Pack%20Test');
  same([pj.brand.pack.name, pj.brand.primary, pj.brand.lt, pj.captions.style.font, pj.logo.pack], ['Khelo India', '#b71c1c', 'lt-strip', 'Arial', packA.id]);
  same(pj.tracks.V1.map((c) => c.brandClip), ['intro']);
  const media = (await api('GET', '/api/media?p=Pack%20Test')).items;
  assert(media.some((m) => m.id === pj.logo.mediaId && m.path.includes(path.join('imports', 'brand', packA.id))), 'the logo is a copy inside the project');
  const u = await api('POST', '/api/library/brandpacks/use?p=Pack%20Test', { id: packB.id });
  same([u.pack.name, Object.keys(u.files)], ['Brand kit', ['logo']]);
  same(u.files.logo.status, 'ready');
});

test('packs: duplicate keeps the files, delete takes it away', async () => {
  if (!ON) return 'skip';
  const d = await api('POST', '/api/library/brandpacks/duplicate', { id: packA.id });
  same([d.name, d.logo, d.intro], ['Khelo India copy', 'logo.png', 'intro.mp4']);
  await api('POST', '/api/library/brandpacks/delete', { id: d.id });
  same((await api('GET', '/api/library/brandpacks')).map((p) => p.name), ['Brand kit', 'Khelo India']);
  same((await api('POST', '/api/library/brandpacks/use?p=Pack%20Test', { id: d.id }).catch((x) => x)).status, 404);
});

test('packs: stop the test editor', async () => {
  if (!ON) return 'skip';
  srv?.kill(); await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
