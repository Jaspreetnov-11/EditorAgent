// 🌙 night shift and 🖥 Agent analysis on helper PCs (Phase 25): the night window, which file a clip is read from,
// which projects, the MJPEG frames a helper sends cut into JPGs, and a remote run that no helper took (engine/*.mjs)
import { test, assert, eq } from './harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inNight, nightSource, recentProjects } from '../engine/nightshift.mjs';
import { splitMjpeg, analyzeClip, extractFrames } from '../engine/analyze.mjs';

const at = (h, m = 0) => new Date(2026, 9, 24, h, m);
const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]).status === 0;

test('🌙 the night window: over midnight (21 to 7), within a day, and none when from = to', () => {
  eq([20, 21, 23, 0, 6, 7, 12].map((h) => inNight(at(h), 21, 7)), [false, true, true, true, true, false, false]);
  eq(inNight(at(6, 59), 21, 7), true);
  eq([1, 2, 5, 6].map((h) => inNight(at(h), 2, 6)), [false, true, true, false]);
  eq(inNight(at(3), 5, 5), false);
});

test('🌙 a clip is read as the Agent will read it: its preview copy, else the camera file (keyframes); not while its copy is being made', () => {
  const v = { kind: 'video', status: 'ready', duration: 12, path: 'Z:/a.mp4' };
  eq(nightSource(v, 'P/x.mp4', () => true), { file: 'P/x.mp4', keyOnly: false });
  eq(nightSource({ ...v, proxy: 'none' }, 'P/x.mp4', () => false), { file: 'Z:/a.mp4', keyOnly: true });
  for (const p of ['pending', 'queued', 'making']) eq(nightSource({ ...v, proxy: p }, 'P/x.mp4', () => false), null, p);
  eq(nightSource({ ...v, kind: 'image' }, null, () => false), null, 'photos are not analysed');
  eq(nightSource({ ...v, duration: 0.5 }, null, () => false), null, 'under a second');
  eq(nightSource({ ...v, status: 'offline' }, null, () => false), null, 'offline');
  eq(nightSource({ ...v, seqOf: 's1' }, null, () => false), null, 'a nested sequence');
});

test('🌙 recent projects: touched in the last 14 days, newest first, at most 10', () => {
  const now = Date.parse('2026-10-24T12:00:00Z'), d = 864e5;
  const list = [{ name: 'old', mtime: now - 20 * d }, { name: 'b', mtime: now - 2 * d }, { name: 'a', mtime: now - d }, { name: 'never', mtime: 0 },
    ...Array.from({ length: 12 }, (_, k) => ({ name: `p${k}`, mtime: now - (3 + k * 0.5) * d }))];
  const r = recentProjects(list, now);
  eq(r.length, 10); eq(r.slice(0, 3), ['a', 'b', 'p0']); assert(!r.includes('old') && !r.includes('never'));
});

test('🖥 a helper\'s frames come as one MJPEG stream: cut into 0001.jpg… exactly as FFmpeg writes them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-mj-')), a = path.join(dir, 'a'), b = path.join(dir, 'b');
  try {
    fs.mkdirSync(a); fs.mkdirSync(b);
    const src = path.join(dir, 't.mp4');
    if (!ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src])) return 'skip';
    ff(['-i', src, '-vf', 'fps=1/2,scale=-2:224', '-q:v', '5', path.join(a, '%04d.jpg')]);
    ff(['-i', src, '-vf', 'fps=1/2,scale=-2:224', '-q:v', '5', '-f', 'mjpeg', path.join(b, '_frames.mjpeg')]);
    eq(splitMjpeg(path.join(b, '_frames.mjpeg'), b), true);
    const fa = fs.readdirSync(a).sort(), fb = fs.readdirSync(b).sort();
    eq(fb, fa, 'same files (the stream itself is gone)');
    assert(fa.every((f) => fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f)))), 'same bytes');
    fs.writeFileSync(path.join(b, 'empty.mjpeg'), Buffer.from('nothing here'));
    eq(splitMjpeg(path.join(b, 'empty.mjpeg'), b), false, 'no picture: made here instead');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('🖥 a remote run nobody took: the analysis is done here as before - or not at all for the night shift (onlyRemote)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-rm-'));
  try {
    const src = path.join(dir, 't.mp4');
    if (!ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-shortest', '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src])) return 'skip';
    let asked = 0;
    const nobody = async () => { asked++; return null; };
    const night = await analyzeClip(src, path.join(dir, 'n.json'), { duration: 6, keyOnly: true, framesDir: path.join(dir, 'fn'), remote: nobody, onlyRemote: true });
    eq(night, null); assert(!fs.existsSync(path.join(dir, 'n.json')), 'nothing written');
    const here = await analyzeClip(src, path.join(dir, 'h.json'), { duration: 6, keyOnly: true, framesDir: path.join(dir, 'fh'), remote: nobody });
    assert(here && here.motion.length === 6 && here.loud.some((x) => x !== null), 'analysed here');
    assert(fs.readdirSync(path.join(dir, 'fh')).some((f) => f.startsWith('done-')), 'frames made here');
    eq(await extractFrames(src, path.join(dir, 'fx'), { duration: 6, remote: nobody, onlyRemote: true }), null);
    assert(asked >= 3, 'the helper was asked each time');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
