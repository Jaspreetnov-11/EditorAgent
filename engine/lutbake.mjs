// lutbake.mjs - turns a clip's whole grade (input LUT + exposure, white balance, contrast, lift/gamma/gain/offset,
// saturation, curves) into one 33-point .cube LUT, using the same maths as the preview and the renderer (public/js/colormath.js).
// Premiere (Lumetri > Creative/Input LUT) and Resolve (Color > LUTs) apply it to give the exact look.
import fs from 'node:fs';
import { LUMA, channelParams, transfer, parseCube, hasPost, postFn, activeGrade } from '../public/js/colormath.js';

function sampler(cube) {
  const { size: n, data, min, max } = cube;
  const at = (r, g, b, ch) => data[3 * (r + n * (g + n * b)) + ch];
  return (rgb) => {
    const p = rgb.map((v, i) => Math.min(n - 1, Math.max(0, ((v - min[i]) / (max[i] - min[i])) * (n - 1))));
    const i0 = p.map(Math.floor), i1 = i0.map((v) => Math.min(n - 1, v + 1)), f = p.map((v, i) => v - i0[i]);
    const out = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      let v = 0;
      for (let k = 0; k < 8; k++) {
        const rI = k & 1 ? i1[0] : i0[0], gI = k & 2 ? i1[1] : i0[1], bI = k & 4 ? i1[2] : i0[2];
        const w = (k & 1 ? f[0] : 1 - f[0]) * (k & 2 ? f[1] : 1 - f[1]) * (k & 4 ? f[2] : 1 - f[2]);
        v += w * at(rI, gI, bI, ch);
      }
      out[ch] = v;
    }
    return out;
  };
}

// color: the clip's grade; lutPath: file of its input LUT (if any). Returns .cube text.
export function bakeCube(color0, lutPath = null, title = 'Limelight grade', N = 33) {
  const color = activeGrade(color0 || {});
  const input = lutPath && fs.existsSync(lutPath) ? sampler(parseCube(fs.readFileSync(lutPath, 'utf8'))) : (x) => x;
  const ps = ['r', 'g', 'b'].map((ch) => channelParams(color || {}, ch));
  const post = hasPost(color) ? postFn(color, {}) : null;
  const sat = Number.isFinite(+color?.saturation) ? +color.saturation : 1;
  const lines = [`TITLE "${title.replace(/"/g, '')}"`, `LUT_3D_SIZE ${N}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    let v = input([r / (N - 1), g / (N - 1), b / (N - 1)]);
    v = v.map((x, i) => transfer(x, ps[i]));
    if (sat !== 1) { const y = LUMA[0] * v[0] + LUMA[1] * v[1] + LUMA[2] * v[2]; v = v.map((x) => y + (x - y) * sat); }
    if (post) v = post(v);
    lines.push(v.map((x) => Math.min(1, Math.max(0, x)).toFixed(6)).join(' '));
  }
  return `${lines.join('\n')}\n`;
}
