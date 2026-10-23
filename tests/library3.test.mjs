// 🎞 custom templates (MOGRT / logo animations / videos with transparency): the zip reader, a MOGRT's text fields,
// image sequences - and end to end on a second editor (own port, own throwaway data folder; only with
// `node tests/run.mjs --server`): import, tags, use in a project, and a render that keeps the transparency.
import { test, eq as same, assert } from './harness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzip, mogrtInfo, findSequence } from '../engine/gfxlib.mjs';
import { makeZip } from './zipwrite.mjs';

const ON = process.env.VEDIT_TEST_SERVER === '1';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3919, B = `http://127.0.0.1:${PORT}`, NAME = 'Library Test', P = encodeURIComponent(NAME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body, raw = false) {
  const r = await fetch(B + url, { method, headers: raw ? {} : { 'content-type': 'application/json' }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(j?.error || `${r.status}`), { status: r.status });
  return j;
}
async function job(j, ms = 180000) {
  for (let t = 0; t < ms; t += 400) { const x = await api('GET', `/api/job?id=${j.id}`); if (x.status !== 'running') { if (x.status !== 'done') throw new Error(x.log.slice(-1)[0] || x.status); return x.result; } await sleep(400); }
  throw new Error('job did not finish');
}
const ff = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status !== 0) throw new Error(String(r.stderr)); };
// one pixel of a video at t seconds -> [r, g, b]
const pixel = (file, t, x, y) => [...spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }).stdout];
const DEF = { capsuleName: { strDB: [{ localeString: 'en_US', str: 'Lower Third Pro' }] }, clientControls: [
  { id: 'a1', type: 6, uiName: { strDB: [{ localeString: 'en_US', str: 'Name' }] }, value: { strDB: [{ localeString: 'en_US', str: 'Jaspreet Singh' }] } },
  { id: 'a2', type: 2, uiName: { strDB: [{ localeString: 'en_US', str: 'Size' }] }, value: 50 },
  { id: 'a3', type: 6, uiName: { strDB: [{ localeString: 'hi_IN', str: 'नाम' }, { localeString: 'en_US', str: 'Title' }] }, value: { strDB: [{ localeString: 'en_US', str: 'Director' }] } }] };

test('🎞 a .mogrt is read as a zip (a zip inside it too); its text fields come from definition.json, not its sliders', () => {
  const inner = makeZip([['footage/a.txt', 'hello']]), z = makeZip([['definition.json', JSON.stringify(DEF)], ['project.aegraphic', inner]]);
  const e = unzip(z);
  same(e.map((x) => x.name), ['definition.json', 'project.aegraphic']);
  same(unzip(e[1].data())[0].data().toString(), 'hello');
  const info = mogrtInfo(JSON.parse(e[0].data().toString()));
  same(info.name, 'Lower Third Pro');
  same(info.fields, [{ id: 'a1', name: 'Name', value: 'Jaspreet Singh' }, { id: 'a3', name: 'Title', value: 'Director' }]);
  let bad = null; try { unzip(Buffer.from('not a zip at all, no')); } catch (x) { bad = x; }
  assert(bad && /zip/i.test(bad.message), 'a file that is not a zip says so');
});

test('🎞 image sequences: the longest numbered run of frames, as an FFmpeg pattern from its first frame', () => {
  const s = findSequence(['x/logo_0007.png', 'x/logo_0008.png', 'x/logo_0009.png', 'x/other_1.png', 'x/notes.txt', 'y/a1.jpg', 'y/a2.jpg']);
  same(s.pattern, 'logo_%04d.png'); same(s.start, 7); same(s.count, 3); same(s.dir, 'x');
  same(findSequence(['one_0001.png', 'readme.txt']), null);
});

let srv, tmp, media = [], tpl = null;
test('🎞 start a test editor (own port, own data folder) with a blue shot', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-lib3-'));
  const shoot = path.join(tmp, 'shoot'); fs.mkdirSync(shoot, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=25:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(shoot, 'Blue.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=1280x720:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(shoot, 'Red.mp4')]);
  // a logo animation with transparency: an orange box sliding over nothing (ProRes 4444)
  ff(['-f', 'lavfi', '-i', 'color=c=black@0.0:s=1280x720:r=25:d=3,format=rgba', '-f', 'lavfi', '-i', 'color=c=orange:s=300x200:r=25:d=3,format=rgba',
    '-filter_complex', '[0][1]overlay=x=100+t*200:y=200:format=auto,format=yuva444p10le', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', path.join(tmp, 'sting.mov')]);
  fs.writeFileSync(path.join(tmp, 'lt.mogrt'), makeZip([['definition.json', JSON.stringify(DEF)], ['thumb.png', 'x'], ['project.aegraphic', makeZip([['(Footage)/sting.mov', fs.readFileSync(path.join(tmp, 'sting.mov'))]])]]));
  fs.writeFileSync(path.join(tmp, 'empty.mogrt'), makeZip([['definition.json', JSON.stringify(DEF)], ['project.aegraphic', makeZip([['comp.aep', 'x']])]]));
  srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 60; i++) { try { await api('GET', '/api/version'); break; } catch { await sleep(500); } if (i === 59) throw new Error(`test editor did not start:\n${log.slice(-800)}`); }
  await api('POST', '/api/projects', { name: NAME, folder: shoot });
  for (let i = 0; i < 120; i++) { media = (await api('GET', `/api/media?p=${P}`)).items; if (media.length === 2 && media.every((m) => m.status === 'ready')) return; await sleep(500); }
  throw new Error('media not ready');
});

test('🎞 a MOGRT uploaded into the Library: its rendered video with transparency, its text fields; one with no video says what to do', async () => {
  if (!ON) return 'skip';
  tpl = await job(await api('POST', '/api/library/graphics/import?name=lt.mogrt', fs.readFileSync(path.join(tmp, 'lt.mogrt')), true));
  same(tpl.kind, 'mogrt'); same(tpl.name, 'Lower Third Pro'); same(tpl.alpha, true); same(tpl.fields.length, 2); same(tpl.duration, 3);
  for (const f of ['master.mov', 'preview.webm', 'thumb.png', 'template.json']) assert(fs.existsSync(path.join(tmp, 'Library', 'graphics', tpl.id, f)), `${f} made`);
  assert(!fs.existsSync(path.join(ROOT, 'Library', 'graphics', tpl.id)), 'the real Library is not touched');
  const r = await fetch(`${B}/lg/${tpl.id}/preview.webm`); same(r.headers.get('content-type'), 'video/webm');
  let e = null; try { await job(await api('POST', '/api/library/graphics/import?name=empty.mogrt', fs.readFileSync(path.join(tmp, 'empty.mogrt')), true)); } catch (x) { e = x; }
  assert(e && /ProRes 4444/.test(e.message), `a MOGRT with no rendered video explains itself: ${e?.message}`);
  e = null; try { await api('POST', '/api/library/graphics/import?name=virus.exe', Buffer.from('x'), true); } catch (x) { e = x; }
  same(e?.status, 400);
  same((await api('GET', '/api/library/graphics')).map((t) => t.id), [tpl.id], 'the failed one left nothing behind');
  const t2 = await job(await api('POST', '/api/library/graphics/import-path', { path: path.join(tmp, 'sting.mov'), name: 'Sting' }));
  same([t2.kind, t2.alpha, t2.fields.length], ['video', true, 0]);
  await api('POST', '/api/library/graphics/delete', { id: t2.id });
});

test('🎞 template tags and name are kept; in a project it is a media item that plays its own preview with transparency', async () => {
  if (!ON) return 'skip';
  const u = await api('POST', '/api/library/graphics/update', { id: tpl.id, name: 'LT', tags: ['Logo', ' intro ', 'logo', ''] });
  same([u.name, u.tags], ['LT', ['logo', 'intro']]);
  const m = await api('POST', `/api/library/graphics/use?p=${P}`, { id: tpl.id });
  same([m.status, m.alpha, m.template.id, m.bin, m.proxy], ['ready', true, tpl.id, 'Templates', 'none']);
  assert(m.path.startsWith(path.join(tmp, 'Projects', NAME, 'imports', 'templates')), 'its copy is in the project folder (helper PCs render from there)');
  const r = await fetch(`${B}${m.urls.play}`); same(r.headers.get('content-type'), 'video/webm');
  same((await api('POST', `/api/library/graphics/use?p=${P}`, { id: tpl.id })).id, m.id, 'used again: the same media item');
  media = (await api('GET', `/api/media?p=${P}`)).items;
});

test('🎞 rendered over the shot below: the box where the template is, the shot where it is clear (Motion moves it)', async () => {
  if (!ON) return 'skip';
  const blue = media.find((m) => m.name === 'Blue.mp4'), t = media.find((m) => m.template);
  const pj = await api('GET', `/api/project?p=${P}`);
  pj.tracks.V1 = [{ id: 'b1', type: 'video', mediaId: blue.id, in: 0, out: 4 }];
  pj.tracks.V2 = [{ id: 't1', type: 'video', mediaId: t.id, in: 0, start: 0 }];
  const out = await job(await api('POST', `/api/render?p=${P}`, { preset: 'master', filename: 'tpl', project: pj }));
  const f = path.join(tmp, 'Projects', NAME, 'renders', out.output);
  // at 1.8 s the box spans x 460-760, y 200-400 of 1280x720 -> x 690-1140, y 300-600 of the 1920x1080 render
  const [r, g, b] = pixel(f, 1.8, 900, 450), [r2, g2, b2] = pixel(f, 1.8, 300, 900);
  assert(r > 200 && g > 120 && g < 210 && b < 60, `orange box: ${[r, g, b]}`);
  assert(r2 < 40 && g2 < 40 && b2 > 200, `the blue shot shows through around it: ${[r2, g2, b2]}`);
  pj.tracks.V2[0].transform = { zoom: 0.5, x: 25, y: 0 };
  const out2 = await job(await api('POST', `/api/render?p=${P}`, { preset: 'master', filename: 'tpl', project: pj }));
  const f2 = path.join(tmp, 'Projects', NAME, 'renders', out2.output);
  const [r3, , b3] = pixel(f2, 1.8, 900, 450);
  assert(b3 > 200 && r3 < 40, `moved away: blue where the box was (${[r3, b3]})`);
});

test('🎞 stop the library test editor and remove its folder', async () => {
  if (!ON) return 'skip';
  srv?.kill(); await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
