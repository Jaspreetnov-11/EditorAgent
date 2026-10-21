// Track audio effects - one definition used by the renderer (FFmpeg filters) and the live preview (Web Audio).
// fx = { hpf: Hz (0 = off), low / mid / high: dB, nr: 0..1, deess: 0..1, comp: 0..1, gain: dB, limit: bool }
//   hpf    high-pass, removes rumble / wind / AC hum below the cutoff
//   low    shelf at 120 Hz (body), mid: bell at 2.5 kHz (presence / clarity), high: shelf at 8 kHz (air)
//   nr     noise reduction (render only - FFT denoiser)
//   nr2    deep noise reduction: a second, adaptive FFT pass for fans / wind / crowd (render only)
//   gate   noise gate: pushes the hiss down between words (render only)
//   deess  tames harsh "s" sounds (render only)
//   comp   compressor: evens out loud and soft words
//   limit  brick-wall limiter at -1 dBFS
export const FX_DEFAULT = { hpf: 0, low: 0, mid: 0, high: 0, nr: 0, nr2: 0, gate: 0, deess: 0, comp: 0, gain: 0, limit: false };

export const FX_PRESETS = {
  voice: { label: 'Voice clean-up', fx: { hpf: 90, low: -1, mid: 2.5, high: 1.5, nr: 0.45, deess: 0.4, comp: 0.55, gain: 1, limit: true } },
  interview: { label: 'Interview (noisy location)', fx: { hpf: 110, low: -2, mid: 3, high: 1, nr: 0.7, deess: 0.35, comp: 0.6, gain: 2, limit: true } },
  heavy: { label: 'Heavy clean-up (fan, wind, crowd)', fx: { hpf: 100, low: -2, mid: 3, high: 0.5, nr: 1, nr2: 0.7, gate: 0.6, deess: 0.3, comp: 0.6, gain: 2, limit: true } },
  studio: { label: 'Studio voice (warm, clear, even)', fx: { hpf: 85, low: 1.5, mid: 2.5, high: 2.5, nr: 0.55, nr2: 0.25, gate: 0.25, deess: 0.5, comp: 0.75, gain: 2, limit: true } },
  light: { label: 'Light polish (already clean)', fx: { hpf: 80, low: 0, mid: 1.5, high: 1, nr: 0.15, deess: 0.25, comp: 0.4, gain: 0, limit: true } },
  music: { label: 'Music bed', fx: { hpf: 30, low: 0, mid: -2, high: 0, nr: 0, deess: 0, comp: 0.2, gain: 0, limit: false } },
  ambience: { label: 'Ambience / crowd', fx: { hpf: 60, low: -2, mid: 0, high: -1, nr: 0.2, deess: 0, comp: 0.2, gain: 0, limit: false } },
  flat: { label: 'Off (no effects)', fx: { ...FX_DEFAULT } },
};

const n = (x) => (Number.isFinite(+x) ? +x : 0);
export const fxActive = (fx) => !!fx && (n(fx.hpf) > 0 || n(fx.low) || n(fx.mid) || n(fx.high) || n(fx.nr) > 0 || n(fx.nr2) > 0 || n(fx.gate) > 0 || n(fx.deess) > 0 || n(fx.comp) > 0 || n(fx.gain) || !!fx.limit);
const compParams = (c) => ({ thrDb: -12 - 18 * c, ratio: 2 + 6 * c, makeupDb: 4 * c });

export function fxFilters(fx) {
  if (!fxActive(fx)) return [];
  const f = [];
  if (n(fx.hpf) > 0) f.push(`highpass=f=${n(fx.hpf)}:poles=2`);
  if (n(fx.nr) > 0) f.push(`afftdn=nr=${(6 + 24 * n(fx.nr)).toFixed(1)}:nf=${n(fx.nr2) > 0 ? -28 : -35}:tn=1`);
  if (n(fx.nr2) > 0) f.push(`afftdn=nr=${(8 + 16 * n(fx.nr2)).toFixed(1)}:nf=-35:tn=1`, 'lowpass=f=12000');
  if (n(fx.gate) > 0) f.push(`agate=threshold=${(0.015 + 0.035 * n(fx.gate)).toFixed(3)}:ratio=${(2 + 5 * n(fx.gate)).toFixed(1)}:attack=5:release=200`);
  if (n(fx.low)) f.push(`bass=g=${n(fx.low)}:f=120:w=0.6`);
  if (n(fx.mid)) f.push(`equalizer=f=2500:t=q:w=0.9:g=${n(fx.mid)}`);
  if (n(fx.high)) f.push(`treble=g=${n(fx.high)}:f=8000:w=0.6`);
  if (n(fx.deess) > 0) f.push(`deesser=i=${Math.min(1, n(fx.deess)).toFixed(2)}:m=0.5:f=0.5`);
  if (n(fx.comp) > 0) {
    const p = compParams(n(fx.comp));
    f.push(`acompressor=threshold=${Math.pow(10, p.thrDb / 20).toFixed(5)}:ratio=${p.ratio.toFixed(2)}:attack=8:release=180:makeup=${Math.pow(10, p.makeupDb / 20).toFixed(3)}`);
  }
  if (n(fx.gain)) f.push(`volume=${n(fx.gain)}dB`);
  if (fx.limit) f.push('alimiter=limit=0.891:level=false');
  return f;
}

// Live preview chain: input -> HPF -> low shelf -> presence -> high shelf -> compressor -> gain -> limiter -> output.
// Noise reduction and de-essing are heard only in renders.
export function buildFxNodes(ctx) {
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.707;
  const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 120;
  const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 2500; mid.Q.value = 0.9;
  const hi = ctx.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 8000;
  const comp = ctx.createDynamicsCompressor(); comp.attack.value = 0.008; comp.release.value = 0.18; comp.knee.value = 6;
  const gain = ctx.createGain();
  const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -1; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.05; lim.knee.value = 0;
  hp.connect(lo); lo.connect(mid); mid.connect(hi); hi.connect(comp); comp.connect(gain); gain.connect(lim);
  const out = ctx.createGain();
  lim.connect(out);
  return {
    input: hp, output: out,
    set(fx = {}) {
      const t = ctx.currentTime;
      hp.frequency.setTargetAtTime(n(fx.hpf) > 0 ? n(fx.hpf) : 1, t, 0.02);
      lo.gain.setTargetAtTime(n(fx.low), t, 0.02); mid.gain.setTargetAtTime(n(fx.mid), t, 0.02); hi.gain.setTargetAtTime(n(fx.high), t, 0.02);
      const c = n(fx.comp), p = compParams(c);
      comp.threshold.setTargetAtTime(c > 0 ? p.thrDb : 0, t, 0.02); comp.ratio.setTargetAtTime(c > 0 ? p.ratio : 1, t, 0.02);
      gain.gain.setTargetAtTime(Math.pow(10, ((c > 0 ? p.makeupDb : 0) + n(fx.gain)) / 20), t, 0.02);
      lim.threshold.setTargetAtTime(fx.limit ? -1 : 0, t, 0.02); lim.ratio.setTargetAtTime(fx.limit ? 20 : 1, t, 0.02);
    },
  };
}

// Picks a clean-up from a recording's measured loudness spread: momentary loudness (LUFS, every 100 ms) -
// the quiet 10th percentile is roughly the noise between words, the loud 90th the speech.
export function autoCleanFx(p10, p90) {
  const snr = p90 - p10;
  // loud all the way through with little gap = music or a crowd under everything, not hiss: denoising would eat it
  const bed = p10 > -32 && snr < 12;
  const key = bed ? 'voice' : snr > 30 ? 'light' : snr > 22 ? 'voice' : snr > 15 ? 'interview' : 'heavy';
  const fx = { ...FX_DEFAULT, ...FX_PRESETS[key].fx, ...(bed ? { nr: 0.1, nr2: 0, gate: 0 } : {}) };
  return { key, snr: +snr.toFixed(1), label: bed ? 'Gentle clean-up (music / crowd under the voice)' : FX_PRESETS[key].label, fx, bed };
}
