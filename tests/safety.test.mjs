// 🛟 Mazbooti (Phase 21): the nightly copy, restoring a project as a copy, the live mirror and getting it ready for a
// standby PC - in a throwaway folder (engine/safety.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, assert, eq } from './harness.mjs';
import { runNightly, mirrorLive, restoreProject, prepareStandby, nights, copyIfChanged, safeDir } from '../engine/safety.mjs';

function scratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-safety-'));
  const proj = path.join(d, 'Projects', 'Film'), dest = path.join(d, 'backup');
  for (const sub of ['imports', 'subs', 'backups/named', 'cache/proxies']) fs.mkdirSync(path.join(proj, sub), { recursive: true });
  fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({ tracks: { V1: [] }, markers: [{ t: 1 }] }));
  fs.writeFileSync(path.join(proj, 'imports', 'vo.wav'), 'voice');
  fs.writeFileSync(path.join(proj, 'subs', 'film.srt'), '1');
  fs.writeFileSync(path.join(proj, 'backups', 'named', 'v1.json'), '{}');
  fs.writeFileSync(path.join(proj, 'cache', 'proxies', 'a.mp4'), 'big');
  fs.writeFileSync(path.join(proj, 'media.json'), JSON.stringify({ items: [
    { id: 'a', path: path.join(proj, 'imports', 'vo.wav'), status: 'ready', proxy: 'none' },
    { id: 'b', path: 'Z:\\Footage\\shot.mp4', status: 'ready', proxy: 'ready' }] }));
  return { d, proj, dest, done: () => fs.rmSync(d, { recursive: true, force: true }) };
}
// (uploads are mirrored only when the backup is on another drive; here both are in the temp folder, so the test says
// "another drive" by looking at a different root - the mirror itself is checked through mirrorLive's own copy below)

test('a night: timeline, media list, named versions and subtitles go; caches do not; settings keep only what goes with projects', async () => {
  const s = scratch();
  try {
    const r = await runNightly({ dest: s.dest, projects: [{ name: 'Film', dir: s.proj }], app: { files: [], dirs: [], config: { team: { on: true }, stock: { key: 'secret' } } } });
    assert(r.ok && r.projects === 1, JSON.stringify(r));
    const n = path.join(s.dest, 'nights', r.night, 'projects', 'Film');
    for (const f of ['project.json', 'media.json', 'subs/film.srt', 'backups/named/v1.json', 'place.json']) assert(fs.existsSync(path.join(n, f)), `${f} copied`);
    assert(!fs.existsSync(path.join(n, 'cache')), 'no caches');
    eq(JSON.parse(fs.readFileSync(path.join(s.dest, 'nights', r.night, '_app', 'config.json'), 'utf8')), { team: { on: true } }, 'no stock / publish keys in the backup');
    eq(nights(s.dest).map((x) => x.projects), [['Film']]);
  } finally { s.done(); }
});

test('only changed files are copied again', async () => {
  const s = scratch();
  try {
    const a = path.join(s.proj, 'subs', 'film.srt'), b = path.join(s.d, 'copy.srt');
    assert((await copyIfChanged(a, b)) > 0, 'first copy');
    eq(await copyIfChanged(a, b), 0, 'same file again');
    fs.writeFileSync(a, '12'); eq(await copyIfChanged(a, b), 2, 'changed file');
  } finally { s.done(); }
});

test('nights beyond "keep" go, the newest stay', async () => {
  const s = scratch();
  try {
    for (const n of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) fs.mkdirSync(path.join(s.dest, 'nights', n), { recursive: true });
    const r = await runNightly({ dest: s.dest, projects: [{ name: 'Film', dir: s.proj }], app: {}, keep: 3 });
    eq(fs.readdirSync(path.join(s.dest, 'nights')).sort(), ['2026-01-03', '2026-01-04', r.night]);
  } finally { s.done(); }
});

test('restore comes back as a new folder, never over one that exists, and is made ready again', async () => {
  const s = scratch();
  try {
    const r = await runNightly({ dest: s.dest, projects: [{ name: 'Film', dir: s.proj }], app: {} });
    const to = path.join(s.d, 'Projects', 'Film (backup)');
    await restoreProject({ dest: s.dest, night: r.night, folder: safeDir('Film'), to });
    const pj = JSON.parse(fs.readFileSync(path.join(to, 'project.json'), 'utf8'));
    eq(pj.markers, [{ t: 1 }]);
    const m = JSON.parse(fs.readFileSync(path.join(to, 'media.json'), 'utf8')).items;
    eq(m.map((x) => x.status), ['queued', 'queued'], 'thumbnails / previews are made again');
    eq(m[1].proxy, 'pending');
    let refused = false; try { await restoreProject({ dest: s.dest, night: r.night, folder: 'Film', to }); } catch { refused = true; }
    assert(refused, 'an existing folder is never overwritten');
  } finally { s.done(); }
});

test('standby: uploads are read from the mirror copy, the way back is kept, NAS footage stays', async () => {
  const s = scratch();
  try {
    await mirrorLive({ dest: s.dest, projects: [{ name: 'Film', dir: s.proj }], app: {}, host: 'MAIN' });
    const live = path.join(s.dest, 'live'), pd = path.join(live, 'Projects', 'Film');
    // (same drive: the uploads were not copied - put one there as a mirror on the NAS would have it)
    fs.mkdirSync(path.join(pd, 'imports'), { recursive: true }); fs.writeFileSync(path.join(pd, 'imports', 'vo.wav'), 'voice');
    eq(prepareStandby(live), 1);
    const m = JSON.parse(fs.readFileSync(path.join(pd, 'media.json'), 'utf8')).items;
    eq(m[0].path, path.join(pd, 'imports', 'vo.wav'));
    eq(m[0].origPath, path.join(s.proj, 'imports', 'vo.wav'));
    eq(m[1].path, 'Z:\\Footage\\shot.mp4');
    eq(prepareStandby(live), 0, 'a second run changes nothing');
  } finally { s.done(); }
});
