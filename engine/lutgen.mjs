// lutgen.mjs - writes "LOG -> Rec.709" conversion LUTs from the camera makers' published curves and gamut matrices,
// with a soft filmic shoulder. They are good starting points (labelled "approx"); exact manufacturer LUTs can be
// dropped into the LUTs folder alongside them.
import fs from 'node:fs';
import path from 'node:path';

const SIZE = 33;
// Video files are decoded limited -> full range, so x = 0..1 corresponds to 10-bit code values 64..940.
const code = (x) => (64 + x * 876) / 1023;

const CURVES = {
  slog3: (x) => { const cv = code(x) * 1023; return cv >= 171.2102946929 ? Math.pow(10, (cv - 420) / 261.5) * 0.19 - 0.01 : ((cv - 95) * 0.01125) / (171.2102946929 - 95); },
  logc3: (x) => { const t = code(x); return t > 0.149658 ? (Math.pow(10, (t - 0.385537) / 0.24719) - 0.052272) / 5.555556 : (t - 0.092809) / 5.367655; },
  vlog: (x) => { const t = code(x); return t < 0.181 ? (t - 0.125) / 5.6 : Math.pow(10, (t - 0.598206) / 0.241514) - 0.00873; },
};
const MATRIX = { // camera gamut -> Rec.709 primaries (linear)
  slog3: [[1.6269474, -0.5401385, -0.0868089], [-0.1785155, 1.4179409, -0.2394254], [-0.0444361, -0.1959199, 1.240356]],
  logc3: [[1.617523, -0.537287, -0.080237], [-0.070573, 1.334613, -0.26404], [-0.021102, -0.226954, 1.248056]],
  vlog: [[1.806576, -0.695697, -0.110879], [-0.17009, 1.305955, -0.135865], [-0.025206, -0.154468, 1.179674]],
};
// ACES-style filmic fit; 0.55 pre-scale puts 18% grey near 42% on screen.
const tone = (x) => { x = Math.max(0, x * 0.55); return Math.min(1, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)); };
const encode = (l) => Math.pow(Math.min(1, Math.max(0, l)), 1 / 2.4);

export const LUTS = [
  ['Sony S-Log3 SGamut3.Cine to Rec709 (approx).cube', 'slog3'],
  ['ARRI LogC3 to Rec709 (approx).cube', 'logc3'],
  ['Panasonic V-Log to Rec709 (approx).cube', 'vlog'],
];

function build(kind) {
  const f = CURVES[kind], M = MATRIX[kind];
  const lines = [`TITLE "${kind} to Rec709 (Limelight approx)"`, `LUT_3D_SIZE ${SIZE}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < SIZE; b++) for (let g = 0; g < SIZE; g++) for (let r = 0; r < SIZE; r++) {
    const lin = [f(r / (SIZE - 1)), f(g / (SIZE - 1)), f(b / (SIZE - 1))];
    const out = M.map((row) => encode(tone(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])));
    lines.push(out.map((v) => v.toFixed(6)).join(' '));
  }
  return `${lines.join('\n')}\n`;
}

export function ensureLuts(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, kind] of LUTS) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, build(kind));
  }
}

// Guess which LOG curve a camera file uses (only a hint; the user can change the LUT).
export function guessLogLut(m) {
  const n = `${m.name} ${m.format || ''} ${m.vcodec || ''}`.toLowerCase();
  if (/\.(ari|arx)$|arri|alexa/.test(n)) return LUTS[1][0];
  if (/\.(mov)$/.test(m.name?.toLowerCase() || '') && /prores/.test(n)) return LUTS[1][0];
  if (/\.(rw2)$|panasonic|lumix|vlog/.test(n)) return LUTS[2][0];
  return LUTS[0][0]; // Sony MXF / XAVC and most others
}
