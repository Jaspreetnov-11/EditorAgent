// 💥 VFX page: the elements (vfxlib.js) draw at any time with any settings, the picture effects (vfxfx.js) run in FFmpeg -
// keyframes turned into expressions, AI mattes lined up by render2 - the presets apply to a shot, and the AI prompt reads
// English / Hinglish into a preset with its settings.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert, eq } from './harness.mjs';
import { VFX, activeEffects } from '../public/js/effects.js';
import { KINDS, newVfx, drawVfx, paramsAt, vfxVideos, hash } from '../public/js/vfxlib.js';
import { VFX_PIC, ANIM, NEEDS_AI, kexpr } from '../public/js/vfxfx.js';
import { PRESETS, CATS, applyPreset, fromPrompt } from '../public/js/vfxpresets.js';
import { RAMPS, clipDur } from '../public/js/model.js';
import { gfxKey, drawGraphic } from '../public/js/graphics.js';
import { val } from '../public/js/motion.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasFF = spawnSync('ffmpeg', ['-hide_banner', '-version'], { windowsHide: true }).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-vfx-'));
// a 2D context that records nothing (Node has no canvas): enough to run every drawing path
function fakeCtx(log = []) {
  const grad = { addColorStop: (o, c) => { if (!(o >= 0 && o <= 1) || /NaN/.test(c)) log.push(`stop ${o} ${c}`); } };
  return new Proxy({ canvas: { width: 320, height: 180 }, globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none' }, {
    get: (o, k) => (k in o ? o[k] : k === 'createRadialGradient' || k === 'createLinearGradient' ? (...a) => { if (a.some((x) => !Number.isFinite(x))) log.push(`${k} ${a}`); return grad; } : (...a) => { if (['arc', 'ellipse', 'lineTo', 'moveTo', 'fillRect', 'drawImage'].includes(k) && a.slice(k === 'drawImage' ? 1 : 0).some((x) => typeof x === 'number' && !Number.isFinite(x))) log.push(`${k} ${a.slice(1)}`); }),
    set: (o, k, v) => { if (k === 'globalAlpha' && !(v >= 0 && v <= 1)) log.push(`alpha ${v}`); o[k] = v; return true; },
  });
}

test('vfx: 16 elements, each with labelled defaults, a blend and a drawing; same seed = same randoms', () => {
  eq(Object.keys(KINDS).length, 16);
  for (const [k, d] of Object.entries(KINDS)) {
    assert(d.label && typeof d.draw === 'function' && ['screen', ''].includes(d.blend), k);
    for (const [pk, x] of Object.entries(d.params)) assert(x.label && x.def !== undefined, `${k}.${pk}`);
  }
  eq(hash(5, 9), hash(5, 9)); assert(hash(5, 9) !== hash(6, 9) && hash(5, 9) >= 0 && hash(5, 9) < 1);
});

test('vfx: every element draws at many times and sizes without NaN, bad alpha or a throw', () => {
  for (const kind of Object.keys(KINDS)) for (const [W, H] of [[1920, 1080], [1080, 1920], [64, 36]]) for (const t of [0, 0.05, 0.2, 0.5, 1.3, 4, 30]) {
    const log = [];
    drawVfx(fakeCtx(log), W, H, newVfx(kind, {}, 42), t, 5);
    eq(log, [], `${kind} ${W}x${H} t=${t}`);
  }
  // unknown kind / empty: cleared, nothing else
  drawVfx(fakeCtx(), 100, 100, { kind: 'nope' }, 1, 2);
});

test('vfx: keyframed parameters (Motion keys) are worked out per frame; missing ones get their default', () => {
  const v = newVfx('sparks', { x: { k: [{ t: 0, v: 10, e: [0, 0, 1, 1] }, { t: 2, v: 30, e: [0, 0, 1, 1] }] }, rate: 'x' });
  const p = paramsAt(v, 1);
  eq(p.x, 20); eq(p.rate, KINDS.sparks.params.rate.def); eq(p.color, '#ffc35a');
  eq(paramsAt(v, 5).x, 30);
  eq(vfxVideos(newVfx('screen', { mediaId: 'm1', srcIn: 2 }), 1.5), [{ id: 'm1', t: 3.5 }]);
  eq(vfxVideos(newVfx('rain'), 1), []);
});

test('vfx: a VFX element is a graphic the bake knows (drawn by graphics.js, its own drawing version in the key)', () => {
  const g = { tpl: 'vfx', vfx: newVfx('fire', {}, 3) };
  drawGraphic(fakeCtx(), 320, 180, g, 0.5, 2);
  const k = gfxKey(g, 1920, 1080, 30, 2);
  assert(/^[0-9a-f]{8}$/.test(k) && k !== gfxKey({ ...g, tpl: 'vfx2' }, 1920, 1080, 30, 2));
});

test('vfx: picture effects join the clip effects (folder VFX); keyframable and AI ones are listed', () => {
  eq(Object.keys(VFX_PIC).sort(), ['vxdof', 'vxfog', 'vxglitch', 'vxhaze', 'vxholo', 'vxkey', 'vxshock', 'vxsky']);
  for (const [k, d] of Object.entries(VFX_PIC)) {
    assert(VFX[k] === d && d.cat === 'VFX' && d.pix, k);
    for (const pk of ANIM[k] || []) assert(d.params[pk] && typeof d.params[pk].def === 'number', `${k}.${pk} keyframable`);
  }
  eq(NEEDS_AI, { vxsky: 'sky', vxfog: 'depth', vxdof: 'depth' });
  assert(VFX.vxkey.key && VFX.vxkey.ff({}) === 'null', 'Chroma Key Pro keys in the final pass');
  eq(activeEffects({ effects: [{ type: 'vxhaze' }, { type: 'vxglitch', on: false }] }).map((e) => e.type), ['vxhaze']);
});

// an FFmpeg expression of T, worked out in JS (if / lt only - what kexpr writes)
const evalExpr = (e, T) => Function('T', 'iff', 'lt', `return ${e.replace(/\bif\(/g, 'iff(')}`)(T, (c, a, b) => (c ? a : b), (a, b) => (a < b ? 1 : 0));
test('vfx: keyframes become FFmpeg expressions - linear, eased (sampled), hold; a plain number stays a number', () => {
  eq(kexpr(7), '7.00000');
  const lin = kexpr({ k: [{ t: 1, v: 0, e: [0, 0, 1, 1] }, { t: 3, v: 10, e: [0, 0, 1, 1] }] });
  for (const [t, v] of [[0, 0], [1, 0], [2, 5], [3, 10], [9, 10]]) assert(Math.abs(evalExpr(lin, t) - v) < 1e-3, `linear at ${t}: ${evalExpr(lin, t)}`);
  const ease = { k: [{ t: 0, v: 0, e: [0.33, 0, 0.67, 1] }, { t: 2, v: 100 }] };
  for (const t of [0.25, 0.5, 1, 1.5]) assert(Math.abs(evalExpr(kexpr(ease), t) - val(ease, t)) < 2.5, `eased at ${t}: ${evalExpr(kexpr(ease), t)} vs ${val(ease, t)}`);
  const hold = kexpr({ k: [{ t: 0, v: 4, hold: true }, { t: 1, v: 9 }] });
  eq([evalExpr(hold, 0.5), evalExpr(hold, 1.2)], [4, 9]);
});

// a filter graph on a small test picture -> raw RGB of one frame
function run(graph, inputs = [], at = 0.5) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=1.2', ...inputs, '-filter_complex', graph, '-map', '[o]', '-ss', String(at), '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { cwd: tmp, windowsHide: true, maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(String(r.stderr).slice(0, 500));
  return r.stdout;
}
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
test('vfx: every picture effect runs in FFmpeg and changes the picture (AI ones with a matte, subject kept clean)', () => {
  if (!hasFF) return 'skip';
  const plain = run('[0:v]format=rgb24[o]');
  // a matte input: a left-to-right ramp (depth: far on the left; sky: the left side)
  const matte = ['-f', 'lavfi', '-i', 'gradients=s=320x180:c0=black:c1=white:x0=0:y0=0:x1=319:y1=0:d=1.2:r=25'];
  const ctx = { W: 320, H: 180, F: 25, clip: { in: 0 }, aux: () => 'mx' };
  const cases = { vxhaze: { amount: 20 }, vxshock: { start: 0.2, strength: 40 }, vxglitch: { amount: 1 }, vxholo: {}, vxsky: { ai: 'vfxai/x.mp4' }, vxfog: { ai: 'vfxai/x.mp4', density: 1, near: 0 }, vxdof: { ai: 'vfxai/x.mp4', focus: 1, range: 0, blur: 30 } };
  for (const [k, p] of Object.entries(cases)) {
    const g = VFX[k].ff(p, ctx).graph('a', 'b');
    const ai = !!NEEDS_AI[k], out = run(`[0:v]format=yuv420p[a];${ai ? '[1:v]format=gray[mx];' : ''}${g};[b]format=rgb24[o]`, ai ? matte : []);
    assert(diff(out, plain) > 2, `${k} changed nothing (${diff(out, plain).toFixed(2)})`);
  }
  // no matte (the shot is ramped / an adjustment layer): the AI part is left out, the picture passes
  for (const k of ['vxsky', 'vxfog', 'vxdof']) eq(VFX[k].ff({ ai: 'vfxai/x.mp4' }, { W: 320, H: 180 }).graph('a', 'b'), '[a]null[b]');
  // 🧍 subject kept clean with a white matte = no change at all; keyframed amount 0 -> 40 = more change later
  const white = ['-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=25:d=1.2'];
  const kept = run(`[0:v]format=yuv420p[a];[1:v]format=gray[mx];${VFX.vxhaze.ff({ amount: 30, subj: 'mattes/s.mp4' }, ctx).graph('a', 'b')};[b]format=rgb24[o]`, white);
  assert(diff(kept, plain) < 1.5, `the subject was not kept clean (${diff(kept, plain).toFixed(2)})`);
  const keyed = VFX.vxhaze.ff({ _k: { amount: { k: [{ t: 0, v: 0, e: [0, 0, 1, 1] }, { t: 1, v: 40, e: [0, 0, 1, 1] }] } } }, ctx).graph('a', 'b');
  const early = run(`[0:v]format=yuv420p[a];${keyed};[b]format=rgb24[o]`, [], 0), late = run(`[0:v]format=yuv420p[a];${keyed};[b]format=rgb24[o]`, [], 0.96);
  const p0 = run('[0:v]format=rgb24[o]', [], 0), p1 = run('[0:v]format=rgb24[o]', [], 0.96);
  assert(diff(early, p0) * 3 < diff(late, p1) && diff(late, p1) > 3, `keyframed haze: ${diff(early, p0).toFixed(2)} then ${diff(late, p1).toFixed(2)}`);
});

test('vfx: Chroma Key Pro takes the green out, removes spill and wraps the edge (final-pass key chain)', () => {
  if (!hasFF) return 'skip';
  const k = VFX.vxkey.key({ wrap: 0 });
  assert(k.startsWith('chromakey=0x00b140:') && k.includes("a='alpha(X,Y)'"));
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x00b140:s=160x90:d=0.2', '-f', 'lavfi', '-i', 'color=c=0x2040c0:s=160x90:d=0.2', '-filter_complex', `[0:v]drawbox=x=60:y=20:w=40:h=50:c=0xd0a080:t=fill,${k}[k];[1:v][k]overlay,format=rgb24[o]`, '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22 });
  eq(r.status, 0, String(r.stderr));
  const px = (x, y) => [...r.stdout.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
  assert(px(10, 10)[2] > 150 && px(10, 10)[1] < 100, `the screen became the background (${px(10, 10)})`);
  assert(px(80, 45)[0] > 150, `the subject stayed (${px(80, 45)})`);
});

test('vfx: presets - 40 in 9 groups; each names real elements, effects and ramps; ids are unique', () => {
  eq(PRESETS.length, 40); eq(CATS.length, 9);
  eq(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
  for (const p of PRESETS) {
    assert(CATS.includes(p.cat) && p.name && p.words, p.id);
    for (const l of p.layers || []) { assert(KINDS[l.kind], `${p.id}: ${l.kind}`); for (const k of Object.keys(l.p)) assert(k in KINDS[l.kind].params, `${p.id}: ${l.kind}.${k}`); }
    for (const e of p.effects || []) { assert(VFX_PIC[e.type], `${p.id}: ${e.type}`); for (const k of Object.keys(e.p)) assert(k in VFX_PIC[e.type].params, `${p.id}: ${e.type}.${k}`); }
    if (p.ramp) assert(RAMPS[p.ramp], `${p.id}: ramp ${p.ramp}`);
    if (p.ai) eq(p.effects.every((e) => !NEEDS_AI[e.type] || NEEDS_AI[e.type] === p.ai), true, p.id);
  }
  const cover = ['muzzle', 'explosion', 'sparks', 'smoke', 'fire', 'lightning', 'beam', 'forcefield', 'leak', 'flare', 'dirt', 'rain', 'snow', 'dust', 'burn', 'screen'];
  for (const k of cover) assert(PRESETS.some((p) => p.layers?.some((l) => l.kind === k)), `no preset uses ${k}`);
  for (const k of Object.keys(VFX_PIC)) assert(PRESETS.some((p) => p.effects?.some((e) => e.type === k)), `no preset uses ${k}`);
});

test('vfx: applying a preset - elements on free tracks over the shot, effects on the shot, bullet time ramps and keeps the length', () => {
  const media = { m: { id: 'm', kind: 'video', duration: 20 } };
  const shot = { id: 's1', type: 'video', mediaId: 'm', in: 2, out: 6 };
  const project = { tracks: { V1: [shot], V2: [{ id: 'o', type: 'title', start: 0, dur: 10 }], A1: [] }, trackState: {} };
  const ex = PRESETS.find((p) => p.id === 'explosion');
  const r = applyPreset(project, shot, ex, media, { start: 0, dur: 4 }, 'V1', { explosion: { size: 60 } });
  eq(r.clips.length, 2); eq(r.effects.length, 1);
  const [a, b] = r.clips;
  assert(a.track !== b.track && !['V1', 'V2'].includes(a.track) && !['V1', 'V2'].includes(b.track), `tracks ${a.track} ${b.track}`);
  eq([a.clip.type, a.clip.gfx.tpl, a.clip.gfx.vfx.kind, a.clip.blend, a.clip.vfxOf, a.clip.start, a.clip.dur], ['graphic', 'vfx', 'explosion', 'screen', 's1', 0, 4]);
  eq(a.clip.gfx.vfx.p.size, 60); eq(b.clip.blend, undefined);
  eq(shot.effects.map((e) => e.type), ['vxshock']);
  // film burn: its peak in the middle of the shot
  const burn = applyPreset(project, shot, PRESETS.find((p) => p.id === 'burn'), media, { start: 0, dur: 4 });
  eq(burn.clips[0].clip.gfx.vfx.p.at, 2);
  // ⏱ bullet time: the ramp, optical-flow in-betweens, a push-in - and the shot keeps its 4 s on the timeline
  const D0 = clipDur(shot, media);
  const bt = applyPreset(project, shot, PRESETS.find((p) => p.id === 'bullet'), media, { start: 0, dur: 4 });
  eq([bt.ramp, shot.ramp, shot.smooth], ['bullet', 'bullet', true]);
  assert(Math.abs(clipDur(shot, media) - D0) < 0.01, `length ${clipDur(shot, media)} vs ${D0}`);
  eq(shot.keys['transform.zoom'].at(-1).v, 1.1);
  // a title is no shot: picture effects are not put on it
  const t = { id: 't', type: 'title', text: 'x', dur: 3 };
  eq(applyPreset(project, t, PRESETS.find((p) => p.id === 'glitch'), media, { start: 0, dur: 3 }).effects, []);
});

test('vfx: the AI prompt reads English / Hinglish into a preset with colour, size, strength, place and time', () => {
  const r = (s) => fromPrompt(s);
  eq(r(''), null);
  const ex = r('a big blue explosion behind him at 2s');
  eq(ex.preset.id, 'explosion'); eq(ex.over.explosion.color, '#2f8cff'); assert(ex.over.explosion.size > KINDS.explosion.params.size.def);
  eq(ex.over.explosion.at, 2); eq(ex.over.smoke.at, 2.25); eq(ex.over.vxshock.start, 2); eq(ex.subject, true);
  assert(!ex.over.smoke?.color, 'the smoke of an explosion keeps its own colour');
  eq(r('heavy barish').preset.id, 'rain'); assert(r('heavy barish').over.rain.density > 350);
  eq(r('halka dhuan left').over.smoke.x, 25);
  eq(r('bijli').preset.id, 'lightning'); eq(r('aag').preset.id, 'fire'); eq(r('kohra').preset.id, 'fog');
  eq(r('green screen').preset.id, 'key'); eq(r('sunset sky').preset.id, 'skysunset'); eq(r('bullet time').preset.id, 'bullet');
  eq(r('laser red').over.beam.color, '#ff2a2a'); eq(r('dust in the light').preset.id, 'dust');
  assert(r('extreme glitch').over.vxglitch.amount <= 1, 'kept inside the parameter range');
  eq(r('zzz qqq'), null);
});

test('vfx: a render2 job lines the AI depth matte up with the shot (Depth fog) and keys the element bake', () => {
  if (!hasFF) return 'skip';
  const cache = path.join(tmp, 'cache'); fs.mkdirSync(path.join(cache, 'vfxai'), { recursive: true }); fs.mkdirSync(path.join(cache, 'segments'), { recursive: true });
  const src = path.join(tmp, 'a.mp4').replace(/\\/g, '/'), matte = path.join(cache, 'vfxai', 'd.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x202020:s=320x180:r=25:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
  // the matte covers source seconds 1..4: black (far) for the first 1.5 s of it, then white (near)
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=25:d=1.5', '-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=25:d=1.5', '-filter_complex', '[0][1]concat=n=2,format=yuv420p', matte]);
  const media = { a: { id: 'a', name: 'a.mp4', path: src, duration: 4, hasAudio: false, kind: 'video', width: 320, height: 180, fps: 25 } };
  const fog = { id: 'f', type: 'vxfog', on: true, p: { density: 1, near: 0, far: 0.5, color: '#ffffff', ai: 'vfxai/d.mp4', aiT0: 1 } };
  const project = { version: 2, name: 't', settings: { aspect: '16:9', fps: 25, crf: 20 }, trackState: {}, tracks: { V1: [{ id: 'c', type: 'video', mediaId: 'a', in: 1.5, out: 3.5, mute: true, effects: [fog] }], A1: [], A2: [] } };
  const out = path.join(tmp, 'out.mp4');
  fs.writeFileSync(path.join(tmp, 'job.json'), JSON.stringify({ project, media, output: out.replace(/\\/g, '/'), preview: true, gpu: false, segCache: path.join(cache, 'segments').replace(/\\/g, '/') }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'engine', 'render2.mjs'), path.join(tmp, 'job.json')], { encoding: 'utf8', windowsHide: true });
  eq(r.status, 0, (r.stderr || r.stdout || '').slice(-800));
  const luma = (t) => spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'scale=16:9,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }).stdout[60];
  // shot second 0.5 = source 2.0 = matte 1.0 (far: white fog); shot second 1.5 = matte 2.0 (near: no fog, the dark shot)
  assert(luma(0.4) > 200, `far part fogged (${luma(0.4)})`);
  assert(luma(1.6) < 70, `near part clear (${luma(1.6)})`);
});
