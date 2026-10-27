// Premiere's Effects panel, the rest of it (engine/premiere-effects-gap.md): the new video effects, transitions and the
// Adaptive Noise Reduction audio effect - every one is run through FFmpeg, a few checked to the pixel, and (with --server)
// a whole render2 job with them.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert, eq as same } from './harness.mjs';
import { VFX, VFX_CATS, defaultsOf, newEffect } from '../public/js/effects.js';
import { TRANSITIONS } from '../public/js/model.js';
import { XFADE_EXPR, xfadeOf, trLive, polyCss } from '../public/js/fx.js';
import { AFX, aeffectFilters } from '../public/js/audioeffects.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW = ['levels', 'procamp', 'extract', 'lighting', 'autolevels', 'unsharp', 'flicker', 'solidcomp', 'arith', 'ascdl', 'changecolor', 'changetocolor', 'chanmix', 'colorbalance', 'colorbalancehls', 'equalize', 'limiter', 'magnify', 'spherize', 'twirl', 'transform', 'turbulent', 'grad4', 'ramp', 'circle', 'ellipse', 'checker', 'grid', 'flare', 'cbrgb', 'colorreplace', 'gamma', 'lumakey', 'colorkey', 'noise', 'median', 'dust', 'noisehls', 'bevel', 'emboss', 'coloremboss', 'findedges', 'posterize', 'solarize', 'threshold', 'replicate', 'edgefeather', 'linwipe', 'radwipe', 'blinds', 'blockdiss', 'cineon', 'timecode', 'clipname',
  // round 2: the ones first left out
  'convkernel', 'shadowhl', 'camerablur', 'channelblur', 'blendfx', 'lightning', 'cellpattern', 'eyedropper', 'writeon', 'vrproj', 'vrrotate', 'vrplane', 'alphaadjust', 'despill', 'noisealpha', 'dropshadow', 'radialshadow', 'bevelalpha', 'roughen', 'texturize', 'hhold', 'vhold', 'gradwipe', 'sdrconform',
  // done in Python with OpenCV (engine/pyfx.py)
  'paintbucket', 'brushstrokes', 'rollingshutter'];
const PREMIERE_FOLDERS = ['VFX', 'Adjust', 'Blur & sharpen', 'Channel', 'Color Correction', 'Colour', 'Distort', 'Generate', 'Image Control', 'Keying', 'Noise & Grain', 'Perspective', 'Stylize', 'Time', 'Transform', 'Transition', 'Utility', 'Video', 'Immersive Video'];
const hasFF = spawnSync('ffmpeg', ['-hide_banner', '-version'], { windowsHide: true }).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-pfx-'));
fs.copyFileSync(['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f)) || process.execPath, path.join(tmp, 'f.ttf'));
let tn = 0;
const CTX = { W: 160, H: 90, F: 25, clip: { in: 12.5, speed: 1 }, name: 'C0001.MP4', font: () => 'f.ttf', textfile: (t) => { const f = `t${tn++}.txt`; fs.writeFileSync(path.join(tmp, f), t); return f; } };
// a filter graph on a small test picture; returns the raw RGB bytes of its first frame (or throws FFmpeg's error)
function run(graph, src = 'testsrc2=s=160x90:r=25:d=0.2', inputs = []) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', src, ...inputs, '-filter_complex', graph, '-map', '[o]', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { cwd: tmp, windowsHide: true, maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(String(r.stderr).slice(0, 400));
  return r.stdout;
}
const fxGraph = (k, p = defaultsOf(k)) => { const d = VFX[k], r = d.key ? d.key(p) : d.ff(p, CTX); return typeof r === 'string' ? `[0:v]${r},format=rgb24[o]` : `${r.graph('0:v', 'e')};[e]format=rgb24[o]`; };
const px = (buf, x = 80, y = 45, w = 160) => [...buf.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];

test('every new Premiere effect is in the registry, in one of Premiere\'s folders, with defaults for its parameters', () => {
  for (const k of NEW) {
    const d = VFX[k];
    assert(d && d.label && PREMIERE_FOLDERS.includes(d.cat), `${k}: ${d?.cat}`);
    for (const [pk, x] of Object.entries(d.params)) assert(x.def !== undefined && x.label, `${k}.${pk}`);
  }
  for (const c of VFX_CATS) assert(PREMIERE_FOLDERS.includes(c), c);
});

test('the filters come out the same from defaults, a half-filled effect or numbers typed as text - never NaN', () => {
  for (const k of Object.keys(VFX)) {
    const d = VFX[k], a = d.ff(defaultsOf(k), CTX), b = d.ff({}, CTX), s = (r) => (typeof r === 'string' ? r : r.graph('i', 'o')).replace(/t\d+\.txt/, 'text');
    assert(!/NaN|undefined|Infinity/.test(s(a)), `${k}: ${s(a)}`);
    if (NEW.includes(k)) same(s(b), s(a), k);
  }
  const p = Object.fromEntries(Object.entries(defaultsOf('levels')).map(([k, v]) => [k, String(v)]));
  same(VFX.levels.ff(p, CTX), VFX.levels.ff(defaultsOf('levels'), CTX));
});

test('every video effect runs in FFmpeg (keys in the final pass, text with the render\'s font)', () => {
  if (!hasFF) return 'skip';
  const bad = [];
  for (const k of Object.keys(VFX)) {
    if (VFX[k].stab || (!VFX[k].key && VFX[k].ff(defaultsOf(k), CTX) === 'null')) continue;
    try { run(fxGraph(k)); } catch (e) { bad.push(`${k}: ${e.message}`); }
  }
  same(bad, []);
});

test('to the pixel: Posterize, Solarize, ASC CDL, Levels, Gamma Correction, Color Balance (RGB), Solid Composite', () => {
  if (!hasFF) return 'skip';
  const grey = 'color=c=0xc04020:s=160x90:r=25:d=0.2';
  // (the test colour itself shifts a few steps on its way through YUV)
  const near = (got, want, tol = 6) => assert(got.every((v, i) => Math.abs(v - want[i]) <= tol), `got ${got}, want ${want}`);
  near(px(run(fxGraph('posterize', { levels: 2 }), grey)), [255, 0, 0]); // 192 -> the top half, 64 / 32 -> the bottom
  near(px(run(fxGraph('solarize', { thr: 100 }), grey)), [63, 64, 32]);
  near(px(run(fxGraph('ascdl', { ...defaultsOf('ascdl'), rs: 0.5, go: 0.25, bp: 2 }), grey)), [96, 128, 4]);
  near(px(run(fxGraph('levels', { ib: 32, iw: 160, gamma: 1, ob: 0, ow: 255 }), grey)), [255, 64, 0]);
  near(px(run(fxGraph('cbrgb', { r: 50, g: 200, b: 100 }), grey)), [96, 128, 32]);
  near(px(run(fxGraph('gamma', { g: 20 }), 'color=c=0x808080:s=160x90:r=25:d=0.2')), [64, 64, 64], 5); // 0.5^2
  near(px(run(fxGraph('solidcomp', { color: '#ffffff', opacity: 0.5 }), 'color=c=0x000000:s=160x90:r=25:d=0.2')), [128, 128, 128], 4);
});

test('Transform moves the picture (black where it left); Replicate tiles it; Circle paints its colour only inside', () => {
  if (!hasFF) return 'skip';
  const src = 'color=c=0xff0000:s=160x90:r=25:d=0.2';
  const t = run(fxGraph('transform', { ...defaultsOf('transform'), x: 50 }), src);
  assert(px(t, 20, 45)[0] < 40 && px(t, 140, 45)[0] > 200, 'left half black, right half red');
  const c = run(fxGraph('circle', { ...defaultsOf('circle'), radius: 10, feather: 0, color: '#00ff00' }), src);
  assert(px(c)[1] > 200 && px(c)[0] < 60 && px(c, 5, 5)[0] > 200, 'green in the middle, red at the corner');
});

test('Timecode burns the source time in: in-point + time into the clip', () => {
  const tc = VFX.timecode.ff(defaultsOf('timecode'), CTX);
  assert(/^drawtext=fontfile=f\.ttf:textfile=t\d+\.txt:fontsize=4:/.test(tc), tc);
  const text = fs.readFileSync(path.join(tmp, tc.match(/textfile=(t\d+\.txt)/)[1]), 'utf8');
  assert(text.includes('(t*1.0000+12.5000)') && text.split('%{eif:').length === 5, text);
  same(VFX.timecode.ff(defaultsOf('timecode'), { W: 1920, H: 1080 }), 'null'); // (no font given: nothing drawn)
  assert(VFX.clipname.ff(defaultsOf('clipname'), CTX).includes('expansion=none'), 'a file name is not read as a % expansion');
});

test('Luma Key and Color Key key like Green screen: only on V2, in the final pass, with transparency', () => {
  for (const k of ['lumakey', 'colorkey', 'chromakey']) {
    assert(VFX[k].v2only && VFX[k].ff({}, CTX) === 'null' && typeof VFX[k].key(defaultsOf(k)) === 'string', k);
  }
  assert(VFX.lumakey.key(defaultsOf('lumakey')).startsWith('format=yuva420p,lumakey='));
  assert(/format=rgba,colorkey=0x00ff00:.*,format=yuva420p$/.test(VFX.colorkey.key(defaultsOf('colorkey'))));
  const r2 = fs.readFileSync(path.join(ROOT, 'engine', 'render2.mjs'), 'utf8');
  assert(r2.includes('if (VFX[e.type].key) continue;') && r2.includes('activeEffects(c).filter((e) => VFX[e.type].key)'), 'render2 keys every key effect in the final pass');
});

test('live preview: each new effect has a CSS / SVG look, a canvas drawing, or is said to be Accurate-preview-only', () => {
  const look = (k) => VFX[k].css || VFX[k].pix || VFX[k].blend, live = NEW.filter(look), accurate = NEW.filter((k) => !look(k));
  same(accurate.sort(), ['autolevels', 'blockdiss', 'colorbalance', 'dust', 'equalize', 'limiter', 'spherize', 'turbulent', 'twirl',
    'channelblur', 'cellpattern', 'vrproj', 'vrrotate', 'vrplane', 'despill', 'bevelalpha', 'roughen', 'texturize', 'hhold', 'vhold', 'sdrconform', 'paintbucket', 'brushstrokes', 'rollingshutter'].sort());
  assert(live.length >= 55, `${live.length} live`);
  // (in Node there is no page: SVG filters come back empty, the rest as CSS)
  same(VFX.procamp.css(defaultsOf('procamp')).filter, 'brightness(1.0000) contrast(1.0000) saturate(1.0000) hue-rotate(0deg)');
  assert(/linear-gradient\(270deg/.test(VFX.linwipe.css({ ...defaultsOf('linwipe'), angle: 270 }).overlay));
});

test('40 + 29 transitions: each an FFmpeg xfade built-in, one of the custom shapes or Morph Cut (Python)', () => {
  same(TRANSITIONS.length, 69);
  const custom = TRANSITIONS.filter(([k]) => XFADE_EXPR[k]).map(([k]) => k);
  same(custom.length, 24);
  for (const k of custom) assert(!/\b(st|ld)\(/.test(XFADE_EXPR[k]), `${k}: xfade shares st/ld registers between its threads`);
  assert(xfadeOf('fade') === 'transition=fade' && xfadeOf('iriscross').startsWith("transition=custom:expr='"));
  if (!hasFF) return;
  const help = spawnSync('ffmpeg', ['-hide_banner', '-h', 'filter=xfade'], { encoding: 'utf8' }).stdout;
  for (const [k] of TRANSITIONS) if (k !== 'cut' && !XFADE_EXPR[k] && k !== 'morphcut') assert(new RegExp(`^\\s+${k}\\s`, 'm').test(help), `${k} is not an xfade transition`);
});

test('the custom transitions run in FFmpeg, start on A and end on B', () => {
  if (!hasFF) return 'skip';
  const A = 'color=c=0xff0000:s=160x90:r=25:d=2', B = ['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=160x90:r=25:d=2'];
  for (const k of Object.keys(XFADE_EXPR)) {
    const at = (s) => run(`[0:v][1:v]xfade=${xfadeOf(k)}:duration=1:offset=0.5,trim=start=${s},setpts=PTS-STARTPTS,format=rgb24[o]`, A, B);
    const a = at(0.52), b = at(1.48), red = (p) => p[0] > 150 && p[2] < 100, blue = (p) => p[2] > 150 && p[0] < 100;
    assert([[40, 20], [80, 45], [120, 70]].every(([x, y]) => red(px(a, x, y))), `${k}: A at the start`);
    assert([[40, 20], [80, 45], [120, 70]].every(([x, y]) => blue(px(b, x, y))), `${k}: B at the end`);
  }
});

test('the monitor draws wipes, irises and slides live: the incoming shot grows from nothing to the whole frame', () => {
  const area = (pts) => Math.abs(pts.reduce((s, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return s + x * y2 - x2 * y; }, 0)) / 2;
  for (const k of ['wipeleft', 'wiperight', 'wipeup', 'wipedown', 'vertopen', 'horzopen', 'inset', 'irisdiamond', 'iriscross', 'venetian', 'bandwipe', 'checkerwipe', 'checkerboard', 'wedgewipe', 'clockwipe', 'spiralboxes', 'zigzag', 'randomwipe', 'pageturn', 'pagepeel']) {
    const s0 = trLive(k, 0).show, s5 = trLive(k, 0.5).show, s1 = trLive(k, 1).show;
    assert(area(s0) < 1 && area(s5) > 5 && area(s1) >= 9900, `${k}: ${area(s0)} ${area(s5)} ${area(s1)}`);
    assert(s5.flat().every(Number.isFinite), k);
  }
  same(trLive('slideleft', 0.25), { cur: { tx: 75 }, prev: { tx: -25 } });
  same(trLive('fade', 0.5), null); // (a dissolve: the opacity, as before)
  same(polyCss([[0, 0], [50.5, 0], [0, 100]]), 'polygon(0% 0%, 50.5% 0%, 0% 100%)');
  assert(polyCss([[0, 0]], true).startsWith('polygon(evenodd, '));
});

test('Adaptive Noise Reduction: afftdn that follows the noise', () => {
  assert(AFX.adaptivenr.cat === 'Noise Reduction/Restoration');
  same(aeffectFilters([{ type: 'adaptivenr', p: {} }]), ['aformat=channel_layouts=stereo', 'afftdn=nr=20:nf=-50:tn=1:ad=0.5']);
  if (!hasFF) return;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=0.5:a=0.1', '-af', aeffectFilters([{ type: 'adaptivenr', p: { a: 30 } }]).join(','), '-f', 'null', '-'], { encoding: 'utf8' });
  same(r.status, 0, r.stderr);
});

test('Drop Shadow / Radial Shadow / Bevel Alpha: on the layer\'s outline - shadow beside the picture, the rest see-through', () => {
  if (!hasFF) return 'skip';
  // a 80 x 45 picture in the middle of a 160 x 90 see-through layer, over blue
  const blue = [0x33, 0x66, 0xaa], near = (a, b, t = 12) => a.every((v, i) => Math.abs(v - b[i]) <= t);
  for (const k of ['dropshadow', 'radialshadow', 'bevelalpha']) {
    const p = { ...defaultsOf(k), ...(k === 'dropshadow' ? { dist: 240, soft: 4, opacity: 1 } : k === 'radialshadow' ? { dist: 40, soft: 4, opacity: 1 } : {}) };
    const g = `[0:v]scale=80:45,format=yuva420p,pad=160:90:40:22:color=black@0[a];${VFX[k].post(p, { W: 160, H: 90 })('a', 'b')};[1:v][b]overlay=format=auto,format=rgb24[o]`;
    const f = run(g, 'testsrc2=s=160x90:r=25:d=0.2', ['-f', 'lavfi', '-i', 'color=c=0x3366aa:s=160x90:r=25:d=0.2']);
    assert(near(px(f, 3, 3), blue), `${k}: the corner far away is the blue below (${px(f, 3, 3)})`);
    assert(!near(px(f, 80, 45), blue), `${k}: the picture is there`);
    if (k !== 'bevelalpha') assert(px(f, 128, 75).every((v, i) => v < blue[i] - 15), `${k}: darker beside the picture (${px(f, 128, 75)})`);
  }
});

test('the Blend effect: Crossfade is opacity, the other modes blend with the shots below (live: mix-blend-mode)', async () => {
  const { blendOf } = await import('../public/js/effects.js');
  same(blendOf({ effects: [newEffect('blendfx')] }), { mode: 'crossfade', amount: 0.5, css: 'normal' });
  same(blendOf({ effects: [{ ...newEffect('blendfx'), p: { mode: 'colour', amount: 0 } }] }).css, 'color');
  same(blendOf({ effects: [] }), null);
  assert(VFX.blendfx.v2only && VFX.blendfx.ff({}, CTX) === 'null');
});

test('round 2 to the pixel: Eyedropper Fill takes the colour under its point, VR Plane to Sphere leaves black around', () => {
  if (!hasFF) return 'skip';
  const e = run(fxGraph('eyedropper', { ...defaultsOf('eyedropper'), x: 50, y: 50, radius: 4 }), 'color=c=0x20c040:s=160x90:r=25:d=0.2');
  assert(Math.abs(px(e)[1] - 0xc0) < 8 && px(e)[0] < 50, `${px(e)}`);
  const v = run(fxGraph('vrplane'), 'color=c=0xff0000:s=160x90:r=25:d=0.2');
  assert(px(v, 2, 2).every((x) => x < 20) && px(v)[0] > 200, 'black far out, the picture in front');
});

test('a render with the new effects, a custom transition and a Luma Key overlay (render2.mjs, end to end)', () => {
  if (!process.env.VEDIT_TEST_SERVER || !hasFF) return 'skip';
  const mk = (n, src) => { const f = path.join(tmp, n).replace(/\\/g, '/'); spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${src}=s=320x180:r=25:d=3`, '-f', 'lavfi', '-i', 'sine=d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]); return f; };
  const m = (id, f) => ({ id, name: `${id}.mp4`, path: f, duration: 3, hasAudio: true, kind: 'video', width: 320, height: 180, fps: 25 });
  const media = { a: m('a', mk('a.mp4', 'testsrc2')), b: m('b', mk('b.mp4', 'smptebars')) };
  const fx = (type, p = {}) => ({ ...newEffect(type), p: { ...defaultsOf(type), ...p } });
  const project = { version: 2, name: 't', settings: { aspect: '16:9', fps: 25, loudness: -14, crf: 20 }, trackState: {},
    tracks: { V1: [{ id: 'c1', type: 'video', mediaId: 'a', in: 0, out: 2, transform: { zoom: 0.8 }, effects: [fx('twirl'), fx('levels', { gamma: 1.4 }), fx('timecode'), fx('dropshadow', { dist: 60, opacity: 1 })] },
      { id: 'c2', type: 'video', mediaId: 'b', in: 0.5, out: 2.5, transitionIn: { type: 'iriscross', dur: 0.6 }, effects: [fx('changecolor'), fx('grad4', { opacity: 0.3 })] }],
    V2: [{ id: 'o1', type: 'video', mediaId: 'b', start: 0.5, in: 0, out: 1.5, volume: 0, effects: [fx('lumakey', { thr: 0.1 }), fx('clipname')] },
      { id: 'o2', type: 'video', mediaId: 'a', start: 2.2, in: 0, out: 1, volume: 0, effects: [fx('blendfx', { mode: 'colour', amount: 0 })] }], A1: [], A2: [] } };
  const out = path.join(tmp, 'out.mp4');
  fs.writeFileSync(path.join(tmp, 'job.json'), JSON.stringify({ project, media, output: out.replace(/\\/g, '/'), preview: true, gpu: false }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'engine', 'render2.mjs'), path.join(tmp, 'job.json')], { encoding: 'utf8', windowsHide: true });
  same(r.status, 0, (r.stderr || '').slice(-600));
  const d = +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout;
  assert(Math.abs(d - 3.4) < 0.15, `length ${d}`);
  // (a Blend layer later on must not black out the frames before it; the main shot is 80 % with its shadow around)
  const f = spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.2', '-i', out, '-frames:v', '1', '-vf', 'scale=160:90', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 }).stdout;
  assert(px(f).some((v) => v > 60), `the picture at 0.2 s (${px(f)})`);
  assert(px(f, 2, 2).every((v) => v < 30), `black outside the 80 % shot (${px(f, 2, 2)})`);
});

// ---------- 🐍 the Python / OpenCV ones (engine/pyfx.py) ----------
const PY = ['python', 'python3', 'py'].find((b) => spawnSync(b, ['-c', 'import cv2, numpy'], { windowsHide: true }).status === 0);
const PYFX = path.join(ROOT, 'engine', 'pyfx.py');
const mp4 = (name, src, d = 1) => { const f = path.join(tmp, name); spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${src}:s=160x90:r=25:d=${d}`, '-f', 'lavfi', '-i', `sine=d=${d}`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]); return f; };
const frameOf = (f, t = 0.3, w = 160) => spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 }).stdout;

test('Python effects: marked, left out of the FFmpeg stack, handed to pyfx.py with every parameter', async () => {
  const { pyEffects, usesPython } = await import('../public/js/effects.js');
  for (const k of ['paintbucket', 'brushstrokes', 'rollingshutter']) assert(VFX[k].py && VFX[k].ff({}, CTX) === 'null', k);
  same(pyEffects({ effects: [{ ...newEffect('paintbucket'), p: { tol: 30 } }, newEffect('blur')] }).map((e) => [e.type, e.p.tol, e.p.color]), [['paintbucket', 30, '#ff3b30']]);
  assert(usesPython({ tracks: { V1: [{ type: 'video', transitionIn: { type: 'morphcut', dur: 1 } }] } }));
  assert(usesPython({ tracks: { V2: [{ type: 'video', effects: [newEffect('brushstrokes')] }] } }));
  assert(!usesPython({ tracks: { V1: [{ type: 'video', effects: [newEffect('blur')], transitionIn: { type: 'fade' } }] } }));
});

test('a render with Python effects goes only to a helper PC with OpenCV (else it is made on the editor)', async () => {
  const { pickHelper } = await import('../engine/helpers.mjs');
  const hs = [{ id: 'a', name: 'A', specs: { cores: 16, render: true } }, { id: 'b', name: 'B', specs: { cores: 4, render: true, cv2: true } }];
  same(pickHelper('p1', hs, new Map([['p1', 'a']]), {}, ['render', 'cv2']), null);
  same(pickHelper('p2', hs, new Map([['p2', 'b']]), {}, ['render', 'cv2'])?.id, 'b');
  assert(fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8').includes("usesPython(job.project) ? ['render', 'cv2'] : ['render']"), 'server.mjs asks for cv2');
  // (any free PC may take a render when the project's own is busy - bestPoll still only gives it to one with OpenCV)
  const { bestPoll } = await import('../engine/helpers.mjs');
  same(bestPoll(hs.map((w) => ({ lane: 'render', w })), { lane: 'render', needs: ['render', 'cv2'] }), 1);
});

test('pyfx.py: Paint Bucket fills the area round its point, Brush Strokes and Rolling Shutter Repair keep length and sound', () => {
  if (!PY || !hasFF) return 'skip';
  const src = mp4('pysrc.mp4', 'color=c=0x2050c0', 1);
  const run1 = (name, fx) => { const out = path.join(tmp, name), r = spawnSync(PY, [PYFX, 'effects', src, '0', '0.8', out, JSON.stringify(fx)], { encoding: 'utf8' }); same(r.status, 0, r.stderr); return out; };
  const pb = run1('pb.mp4', [{ type: 'paintbucket', p: { ...defaultsOf('paintbucket'), color: '#ffd400', tol: 10, feather: 0 } }]);
  const p = px(frameOf(pb));
  assert(p[0] > 200 && p[1] > 180 && p[2] < 80, `filled yellow: ${p}`);
  for (const [n, fx] of [['bs.mp4', [{ type: 'brushstrokes', p: defaultsOf('brushstrokes') }]], ['rs.mp4', [{ type: 'rollingshutter', p: defaultsOf('rollingshutter') }]]]) {
    const f = run1(n, fx), info = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', f], { encoding: 'utf8' }).stdout, j = JSON.parse(info);
    assert(Math.abs(+j.format.duration - 0.8) < 0.1 && j.streams.some((s) => s.codec_type === 'audio'), `${n}: ${info}`);
  }
});

test('pyfx.py Morph Cut: starts on the outgoing frame, ends on the incoming one, as long as the overlap', () => {
  if (!PY || !hasFF) return 'skip';
  const a = mp4('ma.mp4', 'color=c=0xff0000'), b = mp4('mb.mp4', 'color=c=0x0000ff'), out = path.join(tmp, 'morph.mp4');
  const r = spawnSync(PY, [PYFX, 'morph', a, '0.5', b, '0.2', '0.6', '25', '160', '90', out], { encoding: 'utf8' });
  same(r.status, 0, r.stderr);
  const n = +spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout;
  same(n, 15);
  const first = px(frameOf(out, 0)), last = px(frameOf(out, 0.5));
  assert(first[0] > 200 && first[2] < 60 && last[2] > 200 && last[0] < 60, `${first} -> ${last}`);
});

test('a render with Python effects and a Morph Cut (render2.mjs runs pyfx.py, end to end)', () => {
  if (!process.env.VEDIT_TEST_SERVER || !hasFF || !PY) return 'skip';
  const m = (id, f) => ({ id, name: `${id}.mp4`, path: f, duration: 2, hasAudio: true, kind: 'video', width: 160, height: 90, fps: 25 });
  const media = { a: m('a', mp4('ra.mp4', 'color=c=0x2050c0', 2)), b: m('b', mp4('rb.mp4', 'testsrc2=alpha=255', 2)) };
  const fx = (type, p = {}) => ({ ...newEffect(type), p: { ...defaultsOf(type), ...p } });
  const project = { version: 2, name: 't', settings: { aspect: '16:9', fps: 25, loudness: -14, crf: 20 }, trackState: {},
    tracks: { V1: [{ id: 'c1', type: 'video', mediaId: 'a', in: 0, out: 1.5, effects: [fx('paintbucket', { color: '#ffd400', tol: 10, feather: 0 })] },
      { id: 'c2', type: 'video', mediaId: 'b', in: 0.2, out: 1.7, transitionIn: { type: 'morphcut', dur: 0.4 }, effects: [fx('rollingshutter'), fx('brushstrokes')] }], V2: [], A1: [], A2: [] } };
  const out = path.join(tmp, 'pyout.mp4');
  fs.writeFileSync(path.join(tmp, 'pyjob.json'), JSON.stringify({ project, media, output: out.split(path.sep).join('/'), preview: true, gpu: false }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'engine', 'render2.mjs'), path.join(tmp, 'pyjob.json')], { encoding: 'utf8', windowsHide: true });
  same(r.status, 0, (r.stderr || '').slice(-600));
  const d = +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout;
  assert(Math.abs(d - 2.6) < 0.15, `length ${d}`);
  const p = px(frameOf(out, 0.4));
  assert(p[0] > 200 && p[2] < 80, `the first shot filled yellow by Paint Bucket: ${p}`);
});
