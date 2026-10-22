// 🔊 Clip audio effects (Premiere's "Audio Effects"): clip.aeffects = [{ id, type, on, p: { param: value } }], applied in
// order to the clip's own sound, after its clean-up (clip.afx) and before its volume. One registry for the Effects
// panel, Effect Controls, the live mix (player.js, Web Audio) and engine/render2.mjs (exact FFmpeg filters).
//   ff(p)        -> FFmpeg audio filters (string, may be ''), the sound is stereo by then
//   live(ctx, p) -> { input, output } Web Audio nodes for playback; missing = heard in Accurate preview / renders only
//   meter        -> changes nothing; Effect Controls measures the clip's loudness instead (Loudness Meter / Radar)
// Folders and names as in Premiere. Approximations are said so in the label's hint (hint).
import { uid } from './model.js';

const n = (v, d) => (Number.isFinite(+v) ? +v : d);
const db = (x) => Math.pow(10, n(x, 0) / 20);
const f3 = (x) => (+x).toFixed(3);
const R = (label, min, max, step, def, unit = '') => ({ label, min, max, step, def, unit });
const SEL = (label, options, def) => ({ label, type: 'select', options, def });
// the 2x2 mix of the channels: L' = a*L + b*R, R' = c*L + d*R
const matrix = (a, b, c, d) => `pan=stereo|c0=${f3(a)}*c0+${f3(b)}*c1|c1=${f3(c)}*c0+${f3(d)}*c1`;

// ---- Web Audio building blocks (live) ----
const chain = (ctx, nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return { input: nodes[0], output: nodes[nodes.length - 1] }; };
const gain = (ctx, g) => { const x = ctx.createGain(); x.gain.value = g; return x; };
const biquad = (ctx, type, f, q = 0.707, g = 0) => { const x = ctx.createBiquadFilter(); x.type = type; x.frequency.value = Math.max(10, Math.min(22000, f)); x.Q.value = q; x.gain.value = g; return x; };
function liveMatrix(ctx, a, b, c, d) {
  const inp = gain(ctx, 1); inp.channelCount = 2; inp.channelCountMode = 'explicit'; inp.channelInterpretation = 'speakers';
  const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
  inp.connect(sp);
  [[0, 0, a], [1, 0, b], [0, 1, c], [1, 1, d]].forEach(([from, to, k]) => { const g = gain(ctx, k); sp.connect(g, from); g.connect(mg, 0, to); });
  return { input: inp, output: mg };
}
function comp(ctx, thr, ratio, att = 0.01, rel = 0.15, makeup = 0, knee = 6) {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = Math.max(-100, Math.min(0, thr)); c.ratio.value = Math.max(1, Math.min(20, ratio)); c.attack.value = att; c.release.value = rel; c.knee.value = knee;
  return chain(ctx, [c, gain(ctx, db(makeup))]);
}
// dry + wet (wet = the given chain), mix 0..1
function dryWet(ctx, wet, mix) {
  const inp = gain(ctx, 1), out = gain(ctx, 1), dry = gain(ctx, 1 - mix * 0.5), w = gain(ctx, mix);
  inp.connect(dry); dry.connect(out); inp.connect(wet.input); wet.output.connect(w); w.connect(out);
  return { input: inp, output: out };
}
function echo(ctx, ms, fb, damp = 0) {
  const d = ctx.createDelay(5), g = gain(ctx, Math.min(0.95, fb)); d.delayTime.value = Math.min(4.9, ms / 1000);
  const lp = biquad(ctx, 'lowpass', 18000 - 14000 * damp);
  d.connect(lp); lp.connect(g); g.connect(d);
  return { input: d, output: lp };
}
const irCache = new Map();
function reverbIR(ctx, secs, size) {
  const k = `${secs.toFixed(2)}:${size.toFixed(2)}:${ctx.sampleRate}`;
  if (irCache.has(k)) return irCache.get(k);
  const len = Math.max(1, Math.round(ctx.sampleRate * Math.min(8, secs))), buf = ctx.createBuffer(2, len, ctx.sampleRate), pre = Math.round(ctx.sampleRate * (0.005 + 0.03 * size));
  for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = pre; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(10, (-3 * (i - pre)) / len); }
  irCache.set(k, buf); return buf;
}
function reverb(ctx, secs, size, mix, damp = 0.4) {
  const cv = ctx.createConvolver(); cv.buffer = reverbIR(ctx, secs, size);
  return dryWet(ctx, chain(ctx, [cv, biquad(ctx, 'lowpass', 16000 - 12000 * damp)]), mix);
}
function shaper(ctx, drive, kind = 'tanh') {
  const ws = ctx.createWaveShaper(), N = 2048, curve = new Float32Array(N), k = 1 + 20 * drive;
  for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 2 - 1; curve[i] = kind === 'atan' ? (2 / Math.PI) * Math.atan(k * x) : Math.tanh(k * x) / Math.tanh(k); }
  ws.curve = curve; ws.oversample = '2x';
  return chain(ctx, [ws, gain(ctx, 1 / (1 + drive))]);
}
function modDelay(ctx, baseMs, depthMs, rate, fb = 0) {
  const d = ctx.createDelay(0.1); d.delayTime.value = baseMs / 1000;
  const osc = ctx.createOscillator(), og = gain(ctx, depthMs / 1000); osc.frequency.value = rate; osc.connect(og); og.connect(d.delayTime); osc.start();
  if (fb) { const g = gain(ctx, fb); d.connect(g); g.connect(d); }
  return { input: d, output: d };
}

// ---- EQ helpers ----
const GEQ = (n) => { // band centres for 10 / 20 / 30 bands
  if (n === 10) return [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  if (n === 20) return Array.from({ length: 20 }, (_, i) => Math.round(31 * Math.pow(16000 / 31, i / 19)));
  return Array.from({ length: 30 }, (_, i) => Math.round(25 * Math.pow(2, i / 3)));
};
const fmtHz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f % 1000 ? 1 : 0)}k` : String(f));
function geq(nb) {
  const fs = GEQ(nb), w = nb === 10 ? 1 : nb === 20 ? 0.5 : 1 / 3;
  return { label: `Graphic Equalizer (${nb} Bands)`, cat: 'Filter and EQ',
    params: Object.fromEntries(fs.map((f, i) => [`b${i}`, R(`${fmtHz(f)} Hz`, -24, 24, 0.5, 0, ' dB')])),
    ff: (p) => fs.map((f, i) => (n(p[`b${i}`], 0) ? `equalizer=f=${f}:t=o:w=${f3(w)}:g=${n(p[`b${i}`], 0)}` : '')).filter(Boolean).join(','),
    live: (ctx, p) => chain(ctx, [gain(ctx, 1), ...fs.map((f, i) => biquad(ctx, 'peaking', f, 1 / (2 * Math.sinh((Math.LN2 / 2) * w)), n(p[`b${i}`], 0)))]) };
}
const PEQ = [100, 400, 1000, 3000, 8000];
const roomOf = { small: [0.3, 0.6], room: [0.45, 1.1], hall: [0.75, 2.4], church: [1, 4.5], plate: [0.25, 1.6] };
// a reverb by echoes (render): six taps from the room size, each quieter as the decay time says
function reverbFF(size, secs, mix, damp, wide = 0) {
  const base = 18 + 70 * size, taps = [1, 1.37, 1.73, 2.11, 2.53, 3.07].map((k) => Math.round(base * k));
  const dec = taps.map((t) => Math.max(0.02, Math.pow(10, (-3 * t) / (secs * 1000))).toFixed(3));
  return `aecho=0.85:${f3(Math.min(1, 0.25 + mix))}:${taps.join('|')}:${dec.join('|')}${damp > 0.05 ? `,treble=g=${(-10 * damp).toFixed(1)}:f=5000` : ''}${wide ? `,extrastereo=m=${f3(1 + wide)}` : ''}`;
}
// the mcompand band "attack,decay knee points crossover"
const band = (thr, ratio, xover, a = 0.005, d = 0.12) => `${a},${d} 6 -90/-90,${thr}/${thr},0/${(thr - thr / ratio).toFixed(1)} ${xover}`;

export const AFX_CATS = ['Amplitude and Compression', 'Delay and Echo', 'Filter and EQ', 'Modulation', 'Noise Reduction/Restoration', 'Reverb', 'Special', 'Stereo Imagery', 'Time and Pitch', 'Basic'];
export const AFX = {
  // ---------- Amplitude and Compression ----------
  amplify: { label: 'Amplify', cat: 'Amplitude and Compression', params: { l: R('Left', -30, 30, 0.5, 0, ' dB'), r: R('Right', -30, 30, 0.5, 0, ' dB') },
    ff: (p) => matrix(db(p.l), 0, 0, db(p.r)), live: (ctx, p) => liveMatrix(ctx, db(p.l), 0, 0, db(p.r)) },
  channelmixer: { label: 'Channel Mixer', cat: 'Amplitude and Compression', params: { ll: R('L → L', -100, 100, 1, 100, '%'), rl: R('R → L', -100, 100, 1, 0, '%'), lr: R('L → R', -100, 100, 1, 0, '%'), rr: R('R → R', -100, 100, 1, 100, '%') },
    ff: (p) => matrix(n(p.ll, 100) / 100, n(p.rl, 0) / 100, n(p.lr, 0) / 100, n(p.rr, 100) / 100), live: (ctx, p) => liveMatrix(ctx, n(p.ll, 100) / 100, n(p.rl, 0) / 100, n(p.lr, 0) / 100, n(p.rr, 100) / 100) },
  channelvolume: { label: 'Channel Volume', cat: 'Amplitude and Compression', params: { l: R('Left', -60, 12, 0.5, 0, ' dB'), r: R('Right', -60, 12, 0.5, 0, ' dB') },
    ff: (p) => matrix(db(p.l), 0, 0, db(p.r)), live: (ctx, p) => liveMatrix(ctx, db(p.l), 0, 0, db(p.r)) },
  deesser: { label: 'DeEsser', cat: 'Amplitude and Compression', params: { i: R('Intensity', 0, 1, 0.05, 0.5), f: R('Frequency', 2, 12, 0.5, 6.5, ' kHz') },
    ff: (p) => `deesser=i=${f3(n(p.i, 0.5))}:m=0.5:f=${f3(Math.min(1, n(p.f, 6.5) / 24))}`, live: (ctx, p) => chain(ctx, [biquad(ctx, 'peaking', n(p.f, 6.5) * 1000, 2, -9 * n(p.i, 0.5))]) },
  dynamics: { label: 'Dynamics', cat: 'Amplitude and Compression', params: { gate: R('Gate threshold (off at -90)', -90, 0, 1, -90, ' dB'), thr: R('Compressor threshold', -60, 0, 1, -20, ' dB'), ratio: R('Ratio', 1, 20, 0.5, 3), lim: R('Limiter', -12, 0, 0.5, -1, ' dB') },
    ff: (p) => [n(p.gate, -90) > -89 ? `agate=threshold=${f3(db(p.gate))}:ratio=4:attack=5:release=150` : '', `acompressor=threshold=${f3(db(p.thr ?? -20))}:ratio=${n(p.ratio, 3)}:attack=10:release=150`, `alimiter=limit=${f3(db(p.lim ?? -1))}:level=false`].filter(Boolean).join(','),
    live: (ctx, p) => { const c = comp(ctx, n(p.thr, -20), n(p.ratio, 3)), l = comp(ctx, n(p.lim, -1), 20, 0.001, 0.05, 0, 0); c.output.connect(l.input); return { input: c.input, output: l.output }; } },
  dynamicsproc: { label: 'Dynamics Processing', cat: 'Amplitude and Compression', params: { thr: R('Threshold', -60, 0, 1, -18, ' dB'), ratio: R('Ratio', 1, 20, 0.5, 4), att: R('Attack', 0.1, 200, 0.1, 10, ' ms'), rel: R('Release', 10, 2000, 10, 200, ' ms'), knee: R('Knee', 1, 8, 0.5, 3), make: R('Make-up', 0, 24, 0.5, 4, ' dB') },
    ff: (p) => `acompressor=threshold=${f3(db(p.thr ?? -18))}:ratio=${n(p.ratio, 4)}:attack=${n(p.att, 10)}:release=${n(p.rel, 200)}:knee=${n(p.knee, 3)}:makeup=${f3(Math.min(64, db(p.make ?? 4)))}`,
    live: (ctx, p) => comp(ctx, n(p.thr, -18), n(p.ratio, 4), n(p.att, 10) / 1000, n(p.rel, 200) / 1000, n(p.make, 4), n(p.knee, 3) * 3) },
  hardlimiter: { label: 'Hard Limiter', cat: 'Amplitude and Compression', params: { max: R('Maximum amplitude', -20, 0, 0.1, -0.1, ' dB'), boost: R('Input boost', 0, 24, 0.5, 0, ' dB'), rel: R('Release', 1, 500, 1, 50, ' ms') },
    ff: (p) => `${n(p.boost, 0) ? `volume=${n(p.boost, 0)}dB,` : ''}alimiter=limit=${f3(db(p.max ?? -0.1))}:release=${n(p.rel, 50)}:level=false`,
    live: (ctx, p) => { const g = gain(ctx, db(p.boost)), l = comp(ctx, n(p.max, -0.1), 20, 0.001, n(p.rel, 50) / 1000, 0, 0); g.connect(l.input); return { input: g, output: l.output }; } },
  multiband: { label: 'Multiband Compressor', cat: 'Amplitude and Compression', params: { lo: R('Low (below 200 Hz) threshold', -50, 0, 1, -24, ' dB'), mid: R('Mid threshold', -50, 0, 1, -20, ' dB'), hi: R('High (above 2.5 kHz) threshold', -50, 0, 1, -22, ' dB'), ratio: R('Ratio', 1, 10, 0.5, 3) },
    ff: (p) => `mcompand='${band(n(p.lo, -24), n(p.ratio, 3), 200)} | ${band(n(p.mid, -20), n(p.ratio, 3), 2500, 0.003, 0.08)} | ${band(n(p.hi, -22), n(p.ratio, 3), 22000, 0.001, 0.04)}'`,
    live: (ctx, p) => comp(ctx, (n(p.lo, -24) + n(p.mid, -20) + n(p.hi, -22)) / 3, n(p.ratio, 3)), hint: 'live: one band' },
  singleband: { label: 'Single-band Compressor', cat: 'Amplitude and Compression', params: { thr: R('Threshold', -60, 0, 1, -20, ' dB'), ratio: R('Ratio', 1, 20, 0.5, 4), att: R('Attack', 0.1, 200, 0.1, 10, ' ms'), rel: R('Release', 10, 2000, 10, 150, ' ms'), make: R('Output gain', 0, 24, 0.5, 3, ' dB') },
    ff: (p) => `acompressor=threshold=${f3(db(p.thr ?? -20))}:ratio=${n(p.ratio, 4)}:attack=${n(p.att, 10)}:release=${n(p.rel, 150)}:makeup=${f3(Math.min(64, db(p.make ?? 3)))}`,
    live: (ctx, p) => comp(ctx, n(p.thr, -20), n(p.ratio, 4), n(p.att, 10) / 1000, n(p.rel, 150) / 1000, n(p.make, 3)) },
  tube: { label: 'Tube-modeled Compressor', cat: 'Amplitude and Compression', params: { thr: R('Threshold', -60, 0, 1, -18, ' dB'), ratio: R('Ratio', 1, 20, 0.5, 3), make: R('Output gain', 0, 24, 0.5, 3, ' dB'), drive: R('Tube warmth', 0, 1, 0.05, 0.3) },
    ff: (p) => `acompressor=threshold=${f3(db(p.thr ?? -18))}:ratio=${n(p.ratio, 3)}:attack=15:release=200:makeup=${f3(Math.min(64, db(p.make ?? 3)))},volume=${(n(p.drive, 0.3) * 6).toFixed(1)}dB,asoftclip=type=tanh,volume=${(-n(p.drive, 0.3) * 5).toFixed(1)}dB`,
    live: (ctx, p) => { const c = comp(ctx, n(p.thr, -18), n(p.ratio, 3), 0.015, 0.2, n(p.make, 3)), s = shaper(ctx, n(p.drive, 0.3) * 0.5); c.output.connect(s.input); return { input: c.input, output: s.output }; } },

  // ---------- Delay and Echo ----------
  analogdelay: { label: 'Analog Delay', cat: 'Delay and Echo', params: { ms: R('Delay', 10, 2000, 5, 350, ' ms'), fb: R('Feedback', 0, 0.9, 0.05, 0.4), mix: R('Dry / wet', 0, 1, 0.05, 0.35), warm: R('Warmth', 0, 1, 0.05, 0.5) },
    ff: (p) => { const d = n(p.ms, 350), fb = n(p.fb, 0.4), taps = [1, 2, 3, 4].filter((k) => d * k < 9000 && Math.pow(fb, k) > 0.02); return `aecho=1:${f3(n(p.mix, 0.35))}:${taps.map((k) => Math.round(d * k)).join('|')}:${taps.map((k) => f3(Math.max(0.01, Math.pow(fb, k - 1) * 0.9))).join('|')}${n(p.warm, 0.5) > 0.05 ? `,treble=g=${(-6 * n(p.warm, 0.5)).toFixed(1)}:f=6000` : ''}`; },
    live: (ctx, p) => dryWet(ctx, echo(ctx, n(p.ms, 350), n(p.fb, 0.4), n(p.warm, 0.5)), n(p.mix, 0.35)) },
  delay: { label: 'Delay', cat: 'Delay and Echo', params: { ms: R('Delay', 1, 2000, 1, 250, ' ms'), mix: R('Mix', 0, 1, 0.05, 0.5) },
    ff: (p) => `aecho=1:${f3(n(p.mix, 0.5))}:${Math.round(n(p.ms, 250))}:0.9`, live: (ctx, p) => dryWet(ctx, echo(ctx, n(p.ms, 250), 0), n(p.mix, 0.5)) },
  multitap: { label: 'Multitap Delay', cat: 'Delay and Echo', params: { d1: R('Tap 1', 1, 2000, 1, 120, ' ms'), l1: R('Tap 1 level', 0, 1, 0.05, 0.6), d2: R('Tap 2', 1, 2000, 1, 240, ' ms'), l2: R('Tap 2 level', 0, 1, 0.05, 0.45), d3: R('Tap 3', 1, 2000, 1, 360, ' ms'), l3: R('Tap 3 level', 0, 1, 0.05, 0.3), d4: R('Tap 4', 1, 2000, 1, 480, ' ms'), l4: R('Tap 4 level', 0, 1, 0.05, 0.15) },
    ff: (p) => { const t = [1, 2, 3, 4].filter((k) => n(p[`l${k}`], 0) > 0); return t.length ? `aecho=1:1:${t.map((k) => Math.round(n(p[`d${k}`], 100 * k))).join('|')}:${t.map((k) => f3(n(p[`l${k}`], 0.5))).join('|')}` : ''; },
    live: (ctx, p) => { const inp = gain(ctx, 1), out = gain(ctx, 1); inp.connect(out); for (const k of [1, 2, 3, 4]) { const lv = n(p[`l${k}`], 0); if (!lv) continue; const d = ctx.createDelay(3); d.delayTime.value = Math.min(2.9, n(p[`d${k}`], 100 * k) / 1000); const g = gain(ctx, lv); inp.connect(d); d.connect(g); g.connect(out); } return { input: inp, output: out }; } },

  // ---------- Filter and EQ ----------
  bandpass: { label: 'Bandpass', cat: 'Filter and EQ', params: { f: R('Center', 20, 20000, 10, 1000, ' Hz'), q: R('Q', 0.1, 20, 0.1, 1) },
    ff: (p) => `bandpass=f=${n(p.f, 1000)}:width_type=q:w=${n(p.q, 1)}`, live: (ctx, p) => chain(ctx, [biquad(ctx, 'bandpass', n(p.f, 1000), n(p.q, 1))]) },
  bass: { label: 'Bass', cat: 'Filter and EQ', params: { g: R('Boost', -24, 24, 0.5, 6, ' dB'), f: R('Frequency', 40, 400, 5, 100, ' Hz') },
    ff: (p) => `bass=g=${n(p.g, 6)}:f=${n(p.f, 100)}`, live: (ctx, p) => chain(ctx, [biquad(ctx, 'lowshelf', n(p.f, 100), 0.707, n(p.g, 6))]) },
  fftfilter: { label: 'FFT Filter', cat: 'Filter and EQ', hint: 'steep low / high cut', params: { lo: R('Low cut', 0, 2000, 5, 80, ' Hz'), hi: R('High cut', 1000, 20000, 100, 16000, ' Hz') },
    ff: (p) => [n(p.lo, 80) > 0 ? `highpass=f=${n(p.lo, 80)}:poles=2,highpass=f=${n(p.lo, 80)}:poles=2` : '', n(p.hi, 16000) < 20000 ? `lowpass=f=${n(p.hi, 16000)}:poles=2,lowpass=f=${n(p.hi, 16000)}:poles=2` : ''].filter(Boolean).join(','),
    live: (ctx, p) => chain(ctx, [biquad(ctx, 'highpass', Math.max(10, n(p.lo, 80))), biquad(ctx, 'highpass', Math.max(10, n(p.lo, 80))), biquad(ctx, 'lowpass', n(p.hi, 16000)), biquad(ctx, 'lowpass', n(p.hi, 16000))]) },
  geq10: geq(10), geq20: geq(20), geq30: geq(30),
  highpass: { label: 'Highpass', cat: 'Filter and EQ', params: { f: R('Cutoff', 20, 2000, 5, 120, ' Hz') },
    ff: (p) => `highpass=f=${n(p.f, 120)}:poles=2`, live: (ctx, p) => chain(ctx, [biquad(ctx, 'highpass', n(p.f, 120))]) },
  lowpass: { label: 'Lowpass', cat: 'Filter and EQ', params: { f: R('Cutoff', 200, 20000, 50, 8000, ' Hz') },
    ff: (p) => `lowpass=f=${n(p.f, 8000)}:poles=2`, live: (ctx, p) => chain(ctx, [biquad(ctx, 'lowpass', n(p.f, 8000))]) },
  notch: { label: 'Notch Filter', cat: 'Filter and EQ', params: { f1: R('Notch 1', 20, 20000, 5, 1000, ' Hz'), f2: R('Notch 2 (0 = off)', 0, 20000, 5, 0, ' Hz'), f3: R('Notch 3 (0 = off)', 0, 20000, 5, 0, ' Hz'), depth: R('Depth', 0, 60, 1, 30, ' dB'), q: R('Q', 1, 60, 1, 20) },
    ff: (p) => ['f1', 'f2', 'f3'].filter((k) => n(p[k], k === 'f1' ? 1000 : 0) > 0).map((k) => `equalizer=f=${n(p[k], 1000)}:t=q:w=${n(p.q, 20)}:g=${-n(p.depth, 30)}`).join(','),
    live: (ctx, p) => chain(ctx, [gain(ctx, 1), ...['f1', 'f2', 'f3'].filter((k) => n(p[k], k === 'f1' ? 1000 : 0) > 0).map((k) => biquad(ctx, 'peaking', n(p[k], 1000), n(p.q, 20), -n(p.depth, 30)))]) },
  parametric: { label: 'Parametric Equalizer', cat: 'Filter and EQ',
    params: Object.fromEntries(PEQ.flatMap((f, i) => [[`f${i}`, R(`Band ${i + 1} frequency`, 20, 20000, 5, f, ' Hz')], [`g${i}`, R(`Band ${i + 1} gain`, -24, 24, 0.5, 0, ' dB')], [`q${i}`, R(`Band ${i + 1} Q`, 0.1, 20, 0.1, 1)]])),
    ff: (p) => PEQ.map((f, i) => (n(p[`g${i}`], 0) ? `equalizer=f=${n(p[`f${i}`], f)}:t=q:w=${n(p[`q${i}`], 1)}:g=${n(p[`g${i}`], 0)}` : '')).filter(Boolean).join(','),
    live: (ctx, p) => chain(ctx, [gain(ctx, 1), ...PEQ.map((f, i) => biquad(ctx, 'peaking', n(p[`f${i}`], f), n(p[`q${i}`], 1), n(p[`g${i}`], 0)))]) },
  scientific: { label: 'Scientific Filter', cat: 'Filter and EQ', params: { mode: SEL('Type', [['lowpass', 'Low pass'], ['highpass', 'High pass'], ['bandpass', 'Band pass']], 'lowpass'), f: R('Cutoff / center', 20, 20000, 10, 1000, ' Hz'), order: SEL('Order (steepness)', [['2', '2'], ['4', '4'], ['6', '6'], ['8', '8']], '4') },
    ff: (p) => { const k = Math.max(1, Math.round(n(p.order, 4) / 2)), m = p.mode || 'lowpass', f = n(p.f, 1000); return Array.from({ length: k }, () => (m === 'bandpass' ? `bandpass=f=${f}:width_type=q:w=1.4` : `${m}=f=${f}:poles=2`)).join(','); },
    live: (ctx, p) => chain(ctx, Array.from({ length: Math.max(1, Math.round(n(p.order, 4) / 2)) }, () => biquad(ctx, p.mode || 'lowpass', n(p.f, 1000), p.mode === 'bandpass' ? 1.4 : 0.707))) },
  simplenotch: { label: 'Simple Notch Filter', cat: 'Filter and EQ', params: { f: R('Center', 20, 20000, 5, 1000, ' Hz'), q: R('Q', 0.5, 60, 0.5, 10) },
    ff: (p) => `bandreject=f=${n(p.f, 1000)}:width_type=q:w=${n(p.q, 10)}`, live: (ctx, p) => chain(ctx, [biquad(ctx, 'notch', n(p.f, 1000), n(p.q, 10))]) },
  simpleparam: { label: 'Simple Parametric EQ', cat: 'Filter and EQ', params: { f: R('Center', 20, 20000, 5, 1000, ' Hz'), g: R('Boost', -24, 24, 0.5, 0, ' dB'), q: R('Q', 0.1, 20, 0.1, 1) },
    ff: (p) => (n(p.g, 0) ? `equalizer=f=${n(p.f, 1000)}:t=q:w=${n(p.q, 1)}:g=${n(p.g, 0)}` : ''), live: (ctx, p) => chain(ctx, [biquad(ctx, 'peaking', n(p.f, 1000), n(p.q, 1), n(p.g, 0))]) },
  treble: { label: 'Treble', cat: 'Filter and EQ', params: { g: R('Boost', -24, 24, 0.5, 4, ' dB'), f: R('Frequency', 2000, 16000, 100, 6000, ' Hz') },
    ff: (p) => `treble=g=${n(p.g, 4)}:f=${n(p.f, 6000)}`, live: (ctx, p) => chain(ctx, [biquad(ctx, 'highshelf', n(p.f, 6000), 0.707, n(p.g, 4))]) },

  // ---------- Modulation ----------
  chorusflanger: { label: 'Chorus/Flanger', cat: 'Modulation', params: { mode: SEL('Type', [['chorus', 'Chorus'], ['flanger', 'Flanger']], 'chorus'), rate: R('Speed', 0.1, 10, 0.1, 1, ' Hz'), depth: R('Depth', 0, 1, 0.05, 0.5), mix: R('Mix', 0, 1, 0.05, 0.5) },
    ff: (p) => (p.mode === 'flanger' ? `flanger=delay=2:depth=${(8 * n(p.depth, 0.5)).toFixed(1)}:regen=20:width=${Math.round(100 * n(p.mix, 0.5))}:speed=${n(p.rate, 1)}`
      : `chorus=0.8:${f3(0.5 + 0.4 * n(p.mix, 0.5))}:${Math.round(25 + 25 * n(p.depth, 0.5))}:0.5:${n(p.rate, 1)}:${f3(0.5 + 2 * n(p.depth, 0.5))}`),
    live: (ctx, p) => dryWet(ctx, p.mode === 'flanger' ? modDelay(ctx, 3, 2.5 * n(p.depth, 0.5), n(p.rate, 1), 0.3) : modDelay(ctx, 25, 8 * n(p.depth, 0.5), n(p.rate, 1)), n(p.mix, 0.5)) },
  flanger: { label: 'Flanger', cat: 'Modulation', params: { delay: R('Delay', 0, 30, 0.5, 2, ' ms'), depth: R('Depth', 0, 10, 0.5, 2, ' ms'), regen: R('Feedback', -95, 95, 1, 0, '%'), mix: R('Mix', 0, 100, 1, 71, '%'), speed: R('Speed', 0.1, 10, 0.1, 0.5, ' Hz') },
    ff: (p) => `flanger=delay=${n(p.delay, 2)}:depth=${n(p.depth, 2)}:regen=${n(p.regen, 0)}:width=${n(p.mix, 71)}:speed=${n(p.speed, 0.5)}`,
    live: (ctx, p) => dryWet(ctx, modDelay(ctx, Math.max(0.5, n(p.delay, 2)), n(p.depth, 2), n(p.speed, 0.5), Math.abs(n(p.regen, 0)) / 100), n(p.mix, 71) / 100) },
  phaser: { label: 'Phaser', cat: 'Modulation', params: { speed: R('Speed', 0.1, 2, 0.05, 0.5, ' Hz'), decay: R('Depth', 0, 0.99, 0.01, 0.4), mix: R('Mix', 0, 1, 0.05, 0.7) },
    ff: (p) => `aphaser=in_gain=0.4:out_gain=${f3(0.4 + 0.5 * n(p.mix, 0.7))}:delay=3:decay=${n(p.decay, 0.4)}:speed=${n(p.speed, 0.5)}:type=t`,
    live: (ctx, p) => { const aps = [1, 2, 3, 4].map(() => biquad(ctx, 'allpass', 800, 0.7)); const osc = ctx.createOscillator(), og = gain(ctx, 600 * (0.3 + n(p.decay, 0.4))); osc.frequency.value = n(p.speed, 0.5); osc.connect(og); aps.forEach((a) => og.connect(a.frequency)); osc.start(); return dryWet(ctx, chain(ctx, aps), n(p.mix, 0.7)); } },

  // ---------- Noise Reduction/Restoration ----------
  declick: { label: 'Automatic Click Remover', cat: 'Noise Reduction/Restoration', params: { s: R('Sensitivity', 0, 1, 0.05, 0.5) },
    ff: (p) => `adeclick=w=55:o=75:a=2:t=${(8 - 6 * n(p.s, 0.5)).toFixed(1)}` },
  dehummer: { label: 'DeHummer', cat: 'Noise Reduction/Restoration', params: { f: SEL('Mains hum', [['50', '50 Hz (India, Europe)'], ['60', '60 Hz (US)']], '50'), h: R('Harmonics', 1, 8, 1, 4), red: R('Reduction', 0, 60, 1, 30, ' dB') },
    ff: (p) => Array.from({ length: n(p.h, 4) }, (_, i) => `equalizer=f=${n(p.f, 50) * (i + 1)}:t=q:w=30:g=${-n(p.red, 30)}`).join(','),
    live: (ctx, p) => chain(ctx, Array.from({ length: n(p.h, 4) }, (_, i) => biquad(ctx, 'peaking', n(p.f, 50) * (i + 1), 30, -n(p.red, 30)))) },
  denoise: { label: 'DeNoise', cat: 'Noise Reduction/Restoration', params: { a: R('Amount', 0, 1, 0.05, 0.5), nf: R('Noise floor', -80, -20, 1, -40, ' dB') },
    ff: (p) => `afftdn=nr=${(6 + 30 * n(p.a, 0.5)).toFixed(1)}:nf=${n(p.nf, -40)}:tn=1` },
  dereverb: { label: 'DeReverb', cat: 'Noise Reduction/Restoration', hint: 'approximate', params: { a: R('Amount', 0, 1, 0.05, 0.5) },
    ff: (p) => `afftdn=nr=${(4 + 16 * n(p.a, 0.5)).toFixed(1)}:nf=-50:tn=1,agate=threshold=${f3(0.01 + 0.05 * n(p.a, 0.5))}:ratio=${f3(1.5 + 3 * n(p.a, 0.5))}:attack=2:release=${Math.round(120 - 80 * n(p.a, 0.5))}` },

  // ---------- Reverb ----------
  convolution: { label: 'Convolution Reverb', cat: 'Reverb', params: { room: SEL('Space', [['small', 'Small room'], ['room', 'Room'], ['hall', 'Concert hall'], ['church', 'Church / temple'], ['plate', 'Plate']], 'room'), mix: R('Mix', 0, 1, 0.05, 0.3) },
    ff: (p) => { const [s, t] = roomOf[p.room] || roomOf.room; return reverbFF(s, t, n(p.mix, 0.3), 0.3); },
    live: (ctx, p) => { const [s, t] = roomOf[p.room] || roomOf.room; return reverb(ctx, t, s, n(p.mix, 0.3), 0.3); } },
  studio: { label: 'Studio Reverb', cat: 'Reverb', params: { size: R('Room size', 0, 1, 0.05, 0.5), decay: R('Decay', 0.2, 8, 0.1, 1.5, ' s'), damp: R('Damping', 0, 1, 0.05, 0.4), mix: R('Mix', 0, 1, 0.05, 0.25) },
    ff: (p) => reverbFF(n(p.size, 0.5), n(p.decay, 1.5), n(p.mix, 0.25), n(p.damp, 0.4)), live: (ctx, p) => reverb(ctx, n(p.decay, 1.5), n(p.size, 0.5), n(p.mix, 0.25), n(p.damp, 0.4)) },
  surround: { label: 'Surround Reverb', cat: 'Reverb', hint: 'wide stereo', params: { size: R('Room size', 0, 1, 0.05, 0.6), decay: R('Decay', 0.2, 8, 0.1, 2, ' s'), mix: R('Mix', 0, 1, 0.05, 0.3), wide: R('Width', 0, 1, 0.05, 0.5) },
    ff: (p) => reverbFF(n(p.size, 0.6), n(p.decay, 2), n(p.mix, 0.3), 0.3, n(p.wide, 0.5)), live: (ctx, p) => reverb(ctx, n(p.decay, 2), n(p.size, 0.6), n(p.mix, 0.3)) },

  // ---------- Special ----------
  distortion: { label: 'Distortion', cat: 'Special', params: { drive: R('Drive', 0, 1, 0.05, 0.4), out: R('Output', -24, 6, 0.5, -6, ' dB') },
    ff: (p) => `volume=${(24 * n(p.drive, 0.4)).toFixed(1)}dB,asoftclip=type=atan,volume=${n(p.out, -6)}dB` },
  fillleft: { label: 'Fill Left with Right', cat: 'Special', params: {}, ff: () => matrix(0, 1, 0, 1), live: (ctx) => liveMatrix(ctx, 0, 1, 0, 1) },
  fillright: { label: 'Fill Right with Left', cat: 'Special', params: {}, ff: () => matrix(1, 0, 1, 0), live: (ctx) => liveMatrix(ctx, 1, 0, 1, 0) },
  guitar: { label: 'GuitarSuite', cat: 'Special', params: { comp: R('Compressor', 0, 1, 0.05, 0.5), drive: R('Distortion', 0, 1, 0.05, 0.3), tone: R('Amp tone', 1000, 12000, 100, 5000, ' Hz') },
    ff: (p) => `acompressor=threshold=${f3(db(-10 - 20 * n(p.comp, 0.5)))}:ratio=4:attack=5:release=120,volume=${(18 * n(p.drive, 0.3)).toFixed(1)}dB,asoftclip=type=tanh,lowpass=f=${n(p.tone, 5000)},volume=-6dB` },
  invert: { label: 'Invert', cat: 'Special', params: {}, ff: () => "aeval='-val(0)|-val(1)':c=same", live: (ctx) => chain(ctx, [gain(ctx, -1)]) },
  loudnessmeter: { label: 'Loudness Meter', cat: 'Special', params: {}, meter: true, ff: () => '' },
  loudnessradar: { label: 'Loudness Radar', cat: 'Special', params: {}, meter: true, ff: () => '' },
  mastering: { label: 'Mastering', cat: 'Special', params: { warm: R('Warmth (low end)', -6, 6, 0.5, 1.5, ' dB'), presence: R('Presence', -6, 6, 0.5, 2, ' dB'), exciter: R('Exciter (air)', 0, 1, 0.05, 0.3), width: R('Stereo width', 0.5, 1.6, 0.05, 1.15), limit: R('Ceiling', -6, 0, 0.1, -1, ' dB') },
    ff: (p) => `bass=g=${n(p.warm, 1.5)}:f=120,equalizer=f=3500:t=o:w=1.5:g=${n(p.presence, 2)}${n(p.exciter, 0.3) > 0.02 ? `,aexciter=amount=${f3(1 + 2 * n(p.exciter, 0.3))}:drive=8.5:blend=0:freq=7500` : ''},extrastereo=m=${f3(n(p.width, 1.15))},alimiter=limit=${f3(db(p.limit ?? -1))}:level=false`,
    live: (ctx, p) => { const w = n(p.width, 1.15), a = (1 + w) / 2, b = (1 - w) / 2, m = liveMatrix(ctx, a, b, b, a), l = comp(ctx, n(p.limit, -1), 20, 0.001, 0.05, 0, 0); const c = chain(ctx, [biquad(ctx, 'lowshelf', 120, 0.707, n(p.warm, 1.5)), biquad(ctx, 'peaking', 3500, 0.9, n(p.presence, 2)), m.input]); m.output.connect(l.input); return { input: c.input, output: l.output }; } },
  swap: { label: 'Swap Channels', cat: 'Special', params: {}, ff: () => matrix(0, 1, 1, 0), live: (ctx) => liveMatrix(ctx, 0, 1, 1, 0) },
  vocal: { label: 'Vocal Enhancer', cat: 'Special', params: { mode: SEL('Voice', [['male', 'Male'], ['female', 'Female'], ['music', 'Voice over music']], 'male') },
    ff: (p) => ({ male: 'highpass=f=80:poles=2,equalizer=f=220:t=q:w=1:g=-2,equalizer=f=3000:t=q:w=1:g=3,deesser=i=0.3:m=0.5:f=0.27',
      female: 'highpass=f=120:poles=2,equalizer=f=320:t=q:w=1:g=-2,equalizer=f=4500:t=q:w=1:g=3,deesser=i=0.35:m=0.5:f=0.3',
      music: 'highpass=f=100:poles=2,equalizer=f=2500:t=q:w=0.8:g=3,acompressor=threshold=0.1:ratio=3:attack=8:release=150:makeup=1.5' })[p.mode] || '',
    live: (ctx, p) => { const k = { male: [80, 220, 3000], female: [120, 320, 4500], music: [100, 1000, 2500] }[p.mode] || [80, 220, 3000]; return chain(ctx, [biquad(ctx, 'highpass', k[0]), biquad(ctx, 'peaking', k[1], 1, -2), biquad(ctx, 'peaking', k[2], 1, 3)]); } },

  // ---------- Stereo Imagery ----------
  stereoexp: { label: 'Stereo Expander', cat: 'Stereo Imagery', params: { w: R('Width (1 = as recorded, 0 = mono)', 0, 2, 0.05, 1.3) },
    ff: (p) => { const w = n(p.w, 1.3), a = (1 + w) / 2, b = (1 - w) / 2; return matrix(a, b, b, a); }, live: (ctx, p) => { const w = n(p.w, 1.3), a = (1 + w) / 2, b = (1 - w) / 2; return liveMatrix(ctx, a, b, b, a); } },

  // ---------- Time and Pitch ----------
  pitch: { label: 'Pitch Shifter', cat: 'Time and Pitch', params: { semi: R('Semitones', -12, 12, 1, 0), cents: R('Cents', -50, 50, 1, 0), formant: SEL('Formants', [['preserved', 'Keep the voice natural'], ['shifted', 'Shift with the pitch']], 'preserved') },
    ff: (p) => { const r = Math.pow(2, (n(p.semi, 0) + n(p.cents, 0) / 100) / 12); return Math.abs(r - 1) < 1e-4 ? '' : `rubberband=pitch=${r.toFixed(5)}:formant=${p.formant === 'shifted' ? 'shifted' : 'preserved'}`; } },

  // ---------- Basic (Premiere: Balance, Mute, Volume) ----------
  balance: { label: 'Balance', cat: 'Basic', params: { b: R('Balance (left - right)', -100, 100, 1, 0) },
    ff: (p) => { const b = n(p.b, 0) / 100; return matrix(b > 0 ? 1 - b : 1, 0, 0, b < 0 ? 1 + b : 1); }, live: (ctx, p) => { const b = n(p.b, 0) / 100; return liveMatrix(ctx, b > 0 ? 1 - b : 1, 0, 0, b < 0 ? 1 + b : 1); } },
  mute: { label: 'Mute', cat: 'Basic', params: {}, ff: () => 'volume=0', live: (ctx) => chain(ctx, [gain(ctx, 0)]) },
  volume: { label: 'Volume', cat: 'Basic', params: { db: R('Level', -60, 24, 0.5, 0, ' dB') }, ff: (p) => `volume=${n(p.db, 0)}dB`, live: (ctx, p) => chain(ctx, [gain(ctx, db(p.db))]) },
};
// (GuitarSuite and the restoration effects are heard in Accurate preview and renders; Distortion live uses a shaper)
AFX.distortion.live = (ctx, p) => { const s = shaper(ctx, n(p.drive, 0.4) * 2, 'atan'); const g = gain(ctx, db(p.out ?? -6)); s.output.connect(g); return { input: s.input, output: g }; };

export const afxDefaults = (type) => Object.fromEntries(Object.entries(AFX[type]?.params || {}).map(([k, x]) => [k, x.def]));
export const newAudioEffect = (type) => ({ id: uid(), type, on: true, p: afxDefaults(type) });
const on = (list) => (list || []).filter((e) => e && e.on !== false && AFX[e.type]);
// the FFmpeg filters of a clip's audio effects (made stereo first, so the channel effects work on mono sound too)
export function aeffectFilters(list) {
  const f = on(list).map((e) => AFX[e.type].ff({ ...afxDefaults(e.type), ...(e.p || {}) })).filter(Boolean);
  return f.length ? ['aformat=channel_layouts=stereo', ...f] : [];
}
// the live chain for a clip (null: nothing to hear live); effects without a live version pass the sound through
export function buildClipAudioChain(ctx, list) {
  const ok = on(list).filter((e) => AFX[e.type].live);
  if (!ok.length) return null;
  const nodes = ok.map((e) => AFX[e.type].live(ctx, { ...afxDefaults(e.type), ...(e.p || {}) }));
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].output.connect(nodes[i + 1].input);
  return { input: nodes[0].input, output: nodes[nodes.length - 1].output };
}
export const liveAudioFx = (type) => !!AFX[type]?.live;

// 🎚 audio transitions (Premiere's Crossfade folder): the shape of a fade - render (FFmpeg afade curve) and live (k 0..1)
export const ATRANS = [['gain', 'Constant Gain', 'tri'], ['power', 'Constant Power', 'qsin'], ['exp', 'Exponential Fade', 'exp']];
export const fadeCurve = (k) => (ATRANS.find((x) => x[0] === k) || ATRANS[0])[2];
export function fadeShape(x, k) {
  x = Math.max(0, Math.min(1, x));
  return k === 'power' ? Math.sin((x * Math.PI) / 2) : k === 'exp' ? x * x * x : x;
}
