// 🌈 HDR footage and HDR export (engine/hdr.mjs): what is HDR, the colour steps a source gets, and that FFmpeg takes them.
import { spawnSync } from 'node:child_process';
import { test, eq, assert } from './harness.mjs';
import { hdrOf, sourceIn, toSdr, pqToHlg, sdrToHlg, sdrToHlgAlpha, hlgOut } from '../engine/hdr.mjs';

test('HDR is read from the colour tags: PQ (HDR10) and HLG; everything else is SDR', () => {
  eq(hdrOf({ color_transfer: 'smpte2084' }), 'pq');
  eq(hdrOf({ color_transfer: 'arib-std-b67' }), 'hlg');
  for (const t of ['bt709', 'unknown', '', undefined]) eq(hdrOf({ color_transfer: t }), null, String(t));
  eq(hdrOf(null), null);
});

test('a source on its way in: SDR work tone-maps HDR; an HDR export keeps it (PQ goes to HLG); SDR footage is untouched', () => {
  eq(sourceIn(null, null), ''); eq(sourceIn(null, 'pq'), '');
  assert(sourceIn('pq', null).includes('tonemap=hable') && sourceIn('hlg', null).includes('tin=arib-std-b67'), 'tone-map');
  eq(sourceIn('hlg', 'hlg'), ''); eq(sourceIn('hlg', 'pq'), '');
  assert(sourceIn('pq', 'hlg').startsWith('zscale=tin=smpte2084') && sourceIn('pq', 'hlg').includes('t=arib-std-b67'), 'pq -> hlg');
  assert(sdrToHlg().endsWith('format=yuv420p') && sdrToHlg().includes('npl=203'), 'SDR white 203 nits');
  const ga = sdrToHlgAlpha('t', 'th'); assert(ga[0].startsWith('[t]') && ga[ga.length - 1].endsWith('[th]') && ga.some((l) => l.includes('alphaextract')), 'alpha kept apart');
  eq(hlgOut('hlg'), 'format=yuv420p10le'); assert(hlgOut('pq').includes('t=smpte2084'), 'pq out');
});

const ff = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
const zscale = ff.status === 0 && /\bzscale\b/.test(ff.stdout) && /\btonemap\b/.test(ff.stdout);
test('FFmpeg takes every HDR step (zscale + tonemap)', () => {
  if (!zscale) return 'skip';
  for (const [vf, src] of [[toSdr('pq'), 'yuv420p10le'], [toSdr('hlg'), 'yuv420p10le'], [pqToHlg(), 'yuv420p10le'], [sdrToHlg(), 'yuv420p'], [hlgOut('pq'), 'yuv420p10le']]) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=64x36:d=0.1,format=${src}`, '-vf', vf, '-f', 'null', '-'], { encoding: 'utf8' });
    assert(r.status === 0, `${vf}: ${r.stderr}`);
  }
});

test('a transparent title / logo keeps its place and its see-through parts in an HDR export', () => {
  if (!zscale) return 'skip';
  // left half clear, right half solid white: after the HLG step the left stays clear, the right solid
  const g = ['[0:v]format=rgba,geq=r=255:g=255:b=255:a=\'if(lt(X,32),0,255)\'[t]', ...sdrToHlgAlpha('t', 'th'), '[th]alphaextract,crop=32:36:0:0,signalstats,metadata=print:key=lavfi.signalstats.YMAX[l]'];
  const r = spawnSync('ffmpeg', ['-hide_banner', '-f', 'lavfi', '-i', 'color=black:s=64x36:d=0.04', '-filter_complex', g.join(';'), '-map', '[l]', '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
  assert(r.status === 0, r.stderr);
  eq(/YMAX=(\d+)/.exec(r.stderr)?.[1], '0', 'the clear half stays clear');
});
