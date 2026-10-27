// ⏱ Keyframes on effect settings (public/js/effects.js fxParamsAt / fxPieces): an effect's number settings animate with
// the same keys and curves as Motion - in the monitor (the values at the playhead) and in the render (engine/render2.mjs:
// the shot made in pieces, each with its settings at that moment). With --server a whole render2 job is checked.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert, eq as same } from './harness.mjs';
import { VFX, newEffect, defaultsOf, fxKeyPath, fxKeyable, fxHasKeys, fxParamsAt, fxPieces, effectsCss } from '../public/js/effects.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasFF = spawnSync('ffmpeg', ['-hide_banner', '-version'], { windowsHide: true }).status === 0;
const blur = () => ({ ...newEffect('blur'), p: { amount: 12 } });

test('effect keyframes: only number settings can be animated', () => {
  assert(fxKeyable('blur', 'amount') && fxKeyable('bricon', 'bright'));
  const col = Object.entries(VFX.tint.params).find(([, p]) => p.type === 'color' || p.type === 'select');
  if (col) assert(!fxKeyable('tint', col[0]), 'a colour / choice stays still');
  assert(!fxKeyable('blur', 'nope') && !fxKeyable('nope', 'amount'));
});

test('effect keyframes: the value at a moment follows the keys; without keys the setting itself', () => {
  const e = blur(), c = { effects: [e] };
  same(fxParamsAt(c, e, 1).amount, 12); assert(!fxHasKeys(c, e));
  c.keys = { [fxKeyPath(e, 'amount')]: [{ t: 0, v: 0 }, { t: 2, v: 40 }] };
  assert(fxHasKeys(c, e));
  same(fxParamsAt(c, e, 0).amount, 0); same(fxParamsAt(c, e, 1).amount, 20); same(fxParamsAt(c, e, 5).amount, 40);
  same(e.p.amount, 12, 'the effect itself is not changed');
  same(fxParamsAt(c, e, undefined).amount, 12, 'no moment: the static value');
  // the monitor's CSS look at two moments
  assert(effectsCss(c, 1, 0).filter.includes('blur(0.0px)') && effectsCss(c, 1, 2).filter.includes('blur(20.0px)'), effectsCss(c, 1, 2).filter);
});

test('effect keyframes: render pieces cover the shot once, pieces with the same values joined', () => {
  const e = blur(), c = { effects: [e], keys: { [fxKeyPath(e, 'amount')]: [{ t: 0, v: 0 }, { t: 1, v: 30, ip: 'hold' }, { t: 3, v: 30 }] } };
  const ps = fxPieces(c, e, 3, 0.1);
  same(ps[0].t0, 0); same(+ps[ps.length - 1].t1.toFixed(6), 3);
  for (let i = 1; i < ps.length; i++) assert(Math.abs(ps[i].t0 - ps[i - 1].t1) < 1e-9, 'no gap, no overlap');
  assert(ps[0].p.amount < ps[5].p.amount, 'rising while animated');
  const last = ps[ps.length - 1];
  assert(last.t0 <= 1.05 && last.p.amount === 30, `the held second part is one piece (${last.t0})`);
  assert(ps.length <= 12, `${ps.length} pieces`);
});

test('effect keyframes: a render with an animated Brightness gets brighter over the shot (render2.mjs, end to end)', () => {
  if (!process.env.VEDIT_TEST_SERVER || !hasFF) return 'skip';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-fxk-'));
  const src = path.join(tmp, 'grey.mp4').replace(/\\/g, '/');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=320x180:r=25:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src], { windowsHide: true });
  const media = { a: { id: 'a', name: 'grey.mp4', path: src, duration: 3, hasAudio: true, kind: 'video', width: 320, height: 180, fps: 25 } };
  const e = { ...newEffect('bricon'), p: defaultsOf('bricon') };
  const project = { version: 2, name: 't', settings: { aspect: '16:9', fps: 25, loudness: -14, crf: 20 }, trackState: {},
    tracks: { V1: [{ id: 'c1', type: 'video', mediaId: 'a', in: 0, out: 2, effects: [e], keys: { [fxKeyPath(e, 'bright')]: [{ t: 0, v: -100 }, { t: 2, v: 100 }] } }], V2: [], A1: [], A2: [] } };
  const out = path.join(tmp, 'out.mp4');
  fs.writeFileSync(path.join(tmp, 'job.json'), JSON.stringify({ project, media, output: out.replace(/\\/g, '/'), preview: true, gpu: false }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'engine', 'render2.mjs'), path.join(tmp, 'job.json')], { encoding: 'utf8', windowsHide: true });
  same(r.status, 0, (r.stderr || '').slice(-800));
  const d = +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout;
  assert(Math.abs(d - 2) < 0.15, `length kept (${d})`);
  const lum = (t) => { const f = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'scale=16:9', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }).stdout; return f.reduce((a, b) => a + b, 0) / f.length; };
  const a = lum(0.15), b = lum(1), c = lum(1.85);
  assert(a + 30 < b && b + 30 < c, `darker at the start, brighter at the end (${a.toFixed(0)} → ${b.toFixed(0)} → ${c.toFixed(0)})`);
});
