// sync.mjs - lines up recordings of the same event (multicam angles, an external recorder) by their sound.
// Each file's audio becomes an onset envelope (how fast the loudness rises, 100 per second); the envelopes are
// cross-correlated with an FFT and the strongest match gives the offset. Robust to different mics / levels.
import { spawn } from 'node:child_process';

const RATE = 4000, HOP = 40; // 4 kHz mono, one envelope value per 10 ms

function pcm(file, maxSec) {
  return new Promise((ok) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-t', String(maxSec), '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('close', () => { const b = Buffer.concat(chunks); ok(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4))); });
    p.on('error', () => ok(new Float32Array(0)));
  });
}

// log-energy per 10 ms, then the positive change (onsets), mean-removed
export function envelope(x) {
  const n = Math.floor(x.length / HOP), e = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < HOP; k++) { const v = x[i * HOP + k]; s += v * v; } e[i] = Math.log10(1e-9 + s / HOP); }
  const d = new Float64Array(n);
  for (let i = 1; i < n; i++) d[i] = Math.max(0, e[i] - e[i - 1]);
  let m = 0; for (const v of d) m += v; m /= n || 1;
  let sd = 0; for (let i = 0; i < n; i++) { d[i] -= m; sd += d[i] * d[i]; }
  sd = Math.sqrt(sd / (n || 1)) || 1;
  for (let i = 0; i < n; i++) d[i] /= sd;
  return d;
}

// in-place iterative radix-2 FFT
function fft(re, im, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// Offset (seconds) of b inside a: b's start sits at `offset` seconds of a (negative = b starts before a).
// confidence = how far the best peak stands out (z-score); above ~8 is a sure match.
export function correlate(a, b) {
  let n = 1; while (n < a.length + b.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a); br.set(b);
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] + ai[i] * bi[i], im = ai[i] * br[i] - ar[i] * bi[i]; ar[i] = r; ai[i] = im; }
  fft(ar, ai, true);
  // ar[k] = sum a[t+k] b[t]: lag k >= 0 means b starts k frames into a; negative lags wrap to the end
  let best = -Infinity, at = 0, sum = 0, sq = 0, cnt = 0;
  for (let k = -(b.length - 1); k < a.length; k++) {
    const v = ar[(k + n) % n];
    // normalise by the overlap so short overlaps at the edges do not win by accident
    const ov = Math.min(a.length, k + b.length) - Math.max(0, k);
    if (ov < Math.max(300, 0.5 * Math.min(a.length, b.length))) continue; // at least 3 s, and half the shorter recording, in common
    const s = v / Math.sqrt(ov);
    sum += s; sq += s * s; cnt++;
    if (s > best) { best = s; at = k; }
  }
  const mean = sum / (cnt || 1), sd = Math.sqrt(Math.max(1e-12, sq / (cnt || 1) - mean * mean));
  return { offset: (at * HOP) / RATE, confidence: (best - mean) / sd };
}

// files: [{ id, path }] - the first (or `ref`) is the reference. Returns { id: { offset, confidence } } in seconds of the ref.
export async function syncByAudio(files, { ref = files[0]?.id, maxSec = 1800 } = {}) {
  const env = {};
  for (const f of files) env[f.id] = envelope(await pcm(f.path, maxSec));
  const out = { [ref]: { offset: 0, confidence: Infinity } };
  for (const f of files) {
    if (f.id === ref) continue;
    if (env[f.id].length < 300 || env[ref].length < 300) { out[f.id] = { offset: 0, confidence: 0 }; continue; }
    out[f.id] = correlate(env[ref], env[f.id]);
  }
  return out;
}
