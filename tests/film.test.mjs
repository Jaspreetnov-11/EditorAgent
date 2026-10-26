// 🎞 Limelight Film (public/js/film.js): the look's filters, the whole graph renders in FFmpeg, the live viewer's CSS
import { test, eq, assert } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import { VFX, effectsCss } from '../public/js/effects.js';
import { FILM_LOOKS, FILM_PARAMS, lookChain, filmGraph } from '../public/js/film.js';
import { setFilmLayer, filmLayerOf } from '../public/js/looks.js';

test('film: it is a clip effect with its settings; every look has a curve, a dye mix and a CSS stand-in', () => {
  assert(VFX.film && VFX.film.label === 'Limelight Film' && VFX.film.params === FILM_PARAMS);
  eq(FILM_PARAMS.look.options.map(([k]) => k), Object.keys(FILM_LOOKS));
  for (const [k, l] of Object.entries(FILM_LOOKS)) {
    assert(l.curve.length >= 3 && l.curve[0][0] === 0 && l.curve.at(-1)[0] === 1, `${k} curve`);
    assert(l.mix.length === 3 && l.mix.every((r) => r.length === 3) && l.css, `${k} mix / css`);
  }
});

test('film: look strength 0 changes nothing; full strength uses the look; values out of range are held in it', () => {
  eq(lookChain('golden', 0), '');
  const full = lookChain('golden', 1);
  assert(full.startsWith("curves=all='0.000/0.020") && full.includes('colorchannelmixer=') && full.includes('colorbalance=') && full.includes('eq=saturation=1.060'), full);
  assert(!lookChain('clean', 1).includes('colorchannelmixer'), 'no dye mix when the look has none');
  const g = filmGraph({ look: 'nope', grain: 9, halation: -3, grainSize: 'huge' }, { W: 1280, H: 720, F: 24 }).graph('a', 'b');
  assert(g.includes("curves=all='0.000/0.012") && !g.includes('[bh0]') && g.includes('color=c=0x808080:s=752x424:r=24'), 'unknown look -> Classic, halation 0 -> none, grain 1 medium');
});

test('film: the whole graph (look, halation, bloom, grain, vignette, weave, flicker) renders in FFmpeg at the frame size', () => {
  const W = 320, H = 180, F = 25;
  const g = `[0:v]format=yuv420p[a];${VFX.film.ff({ look: 'tungsten', halation: 0.6, bloom: 0.4, grain: 0.5, grainSize: 'coarse', vignette: 0.5, weave: 0.6, flicker: 0.5 }, { W, H, F }).graph('a', 'b')}`;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${F}:d=0.4`, '-filter_complex', g, '-map', '[b]', '-f', 'null', '-'], { encoding: 'utf8' });
  if (r.error?.code === 'ENOENT') return 'skip';
  eq(r.status, 0, r.stderr);
  const p = spawnSync('ffprobe', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${F}:d=0.4,format=yuv420p[a];${VFX.film.ff({ weave: 1 }, { W, H, F }).graph('a', 'out0')}`, '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'csv=p=0'], { encoding: 'utf8' });
  if (p.status === 0) eq(p.stdout.trim(), `${W},${H},10`, 'same size and frame count out (gate weave scales back)');
});

test('film: the live viewer gets the look as a CSS filter, the grain and the vignette as overlays', () => {
  const css = VFX.film.css({ look: 'silver', strength: 1, grain: 0.5, vignette: 0.6 });
  assert(css.filter.includes('grayscale(1.000)') && css.grain && css.overlay.startsWith('url(') && css.overlays[0].startsWith('radial-gradient'), JSON.stringify(css).slice(0, 200));
  const half = VFX.film.css({ look: 'bleach', strength: 0.5, grain: 0, vignette: 0 });
  assert(half.filter.includes('contrast(1.110)') && !half.grain && !half.overlays, half.filter);
  const ef = effectsCss({ effects: [{ id: 'e1', type: 'film', on: true, p: { grain: 0.4, vignette: 0.5 } }] });
  assert(ef.grain && ef.overlay.startsWith('radial-gradient'), 'grain and vignette both reach the viewer');
});

test('film: the Agent / Assistant / edtool layer - one adjustment layer over the whole edit, changed in place, taken away', () => {
  const media = { m1: { id: 'm1', duration: 30 }, m2: { id: 'm2', duration: 30 } };
  const p = { tracks: { V1: [{ id: 'a', type: 'video', mediaId: 'm1', start: 0, in: 0, out: 6 }, { id: 'b', type: 'video', mediaId: 'm2', start: 6, in: 2, out: 12 }], V2: [{ id: 't', type: 'title', start: 1, dur: 3 }], A1: [] }, trackState: {} };
  const tr = setFilmLayer(p, 'golden', media, { grain: 0.5 });
  const L = filmLayerOf(p);
  assert(tr && tr !== 'V1' && tr !== 'V2' && p.tracks[tr].length === 1, `own track: ${tr}`);
  eq([L.type, L.start, L.dur, L.effects[0].type, L.effects[0].p.look, L.effects[0].p.grain], ['adjust', 0, 16, 'film', 'golden', 0.5]);
  eq(setFilmLayer(p, 'silver', media), tr, 'again: the same track, the new look');
  eq(Object.values(p.tracks).flat().filter((c) => c.filmLook).length, 1);
  eq(filmLayerOf(p).effects[0].p.look, 'silver');
  eq(setFilmLayer(p, 'nope', media), null, 'an unknown look takes it away');
  eq(filmLayerOf(p), null);
  eq(setFilmLayer({ tracks: { V1: [], A1: [] }, trackState: {} }, 'classic', media), null, 'nothing on the timeline: nothing to put it over');
});
