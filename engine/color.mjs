// color.mjs - turns a clip's colour settings into FFmpeg filters.
// The maths lives in public/js/colormath.js and is shared with the WebGL preview, so what you grade is what renders.
//   1. LUT                                    lut3d (tetrahedral)
//   2-5. exposure, white balance, contrast/pivot, lift/gain/offset, gamma    one lutrgb (per-channel curve)
//   6. saturation around Rec.709 luma         colorchannelmixer
//   7. tone (highlights…blacks), creative (look, faded, vibrance, tints), RGB + hue curves, HSL secondary
//                                              lut3d of a baked .cube (colormath.js postFn, same as the preview)
//   8. sharpen                                 unsharp
//   9. vignette                                geq (colormath.js vigFactor)
// Switched-off Lumetri sections (color.off) are left out first (activeGrade).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { LUMA, isNeutral, channelParams, activeGrade, hasPost, postFn, hasVig, cubeSampler, parseCube } from '../public/js/colormath.js';

export { LUMA, isNeutral, channelParams };

export function colorFilters(c0, { luts = {}, stage = (p) => p, aspect = 16 / 9 } = {}) {
  if (isNeutral(c0)) return [];
  const c = activeGrade(c0);
  const f = [];
  if (c.lut && luts[c.lut] && fs.existsSync(luts[c.lut])) f.push(`lut3d=file=${stage(luts[c.lut])}:interp=tetrahedral`);
  const ps = ['r', 'g', 'b'].map((ch) => channelParams(c, ch));
  const identity = ps.every((p) => p.mul === 1 && p.contrast === 1 && p.gain === 1 && !p.lift && !p.offset && p.gamma === 1);
  if (!identity) {
    const curves = ['r', 'g', 'b'].map((ch, i) => {
      const p = ps[i];
      const v = `(val/maxval*${p.mul.toFixed(5)})`;
      const con = `((${v}-${p.pivot})*${p.contrast.toFixed(4)}+${p.pivot})`;
      const lgo = `(${con}*${p.gain.toFixed(4)}+${p.lift.toFixed(4)}*(1-${con})+${p.offset.toFixed(4)})`;
      return `${ch}='clip(pow(clip(${lgo},0,1),${(1 / p.gamma).toFixed(4)})*maxval,minval,maxval)'`;
    });
    f.push(`lutrgb=${curves.join(':')}`);
  }
  const s = Number.isFinite(+c.saturation) ? +c.saturation : 1;
  if (s !== 1) {
    const [wr, wg, wb] = LUMA, k = 1 - s, x = (v) => v.toFixed(5);
    f.push(`colorchannelmixer=rr=${x(wr * k + s)}:rg=${x(wg * k)}:rb=${x(wb * k)}:gr=${x(wr * k)}:gg=${x(wg * k + s)}:gb=${x(wb * k)}:br=${x(wr * k)}:bg=${x(wg * k)}:bb=${x(wb * k + s)}`);
  }
  if (hasPost(c)) f.push(`lut3d=file=${stage(postCube(c, luts))}:interp=tetrahedral`);
  const sh = +c.sharpen || 0;
  if (sh > 0) f.push(`unsharp=5:5:${(sh * 1.5).toFixed(3)}:5:5:0`);
  if (hasVig(c)) f.push(vignetteGeq(c.vig, aspect));
  return f;
}

// The post stage baked into a 45-point .cube, kept by content in the temp folder (made once per different grade)
const POST_KEYS = ['highlights', 'shadows', 'whites', 'blacks', 'look', 'lookAmt', 'faded', 'vibrance', 'csat', 'shTint', 'hiTint', 'tintBal', 'curves', 'hue', 'hsl'];
export function postCube(c0, luts = {}, N = 45) {
  const c = { ...c0, ...(c0.hsl ? { hsl: { ...c0.hsl, show: false } } : {}) }; // (the HSL key view is for the viewer only)
  const lookFile = c.look && luts[c.look] && fs.existsSync(luts[c.look]) ? luts[c.look] : null;
  const key = crypto.createHash('sha1').update(JSON.stringify([POST_KEYS.map((k) => c[k] ?? null), lookFile && fs.statSync(lookFile).mtimeMs, N, 2])).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), 'vedit-curves'), file = path.join(dir, `post-${key}.cube`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  const fn = postFn(c, { look: lookFile ? cubeSampler(parseCube(fs.readFileSync(lookFile, 'utf8'))) : null }), lines = [`LUT_3D_SIZE ${N}`];
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++)
    lines.push(fn([r / (N - 1), g / (N - 1), b / (N - 1)]).map((v) => v.toFixed(5)).join(' '));
  fs.writeFileSync(`${file}.tmp`, lines.join('\n')); fs.renameSync(`${file}.tmp`, file);
  return file;
}

// vignette as one geq (same formula as colormath.js vigFactor / the preview shader); works on RGB planes
export function vignetteGeq(V, aspect) {
  const a = Math.max(-1, Math.min(1, +V.amount || 0)), k = Math.pow(aspect, Math.min(1, Math.max(-1, +V.round || 0))), mid = Number.isFinite(+V.mid) ? +V.mid : 0.5, fe = Math.max(0.02, Number.isFinite(+V.feather) ? +V.feather : 0.5);
  const d = `hypot((X/W-0.5)*2*${k.toFixed(5)},(Y/H-0.5)*2)/${Math.hypot(k, 1).toFixed(5)}`;
  const t = `clip((${d}-(${(mid - fe / 2).toFixed(4)}))/${fe.toFixed(4)},0,1)`, f = `(${t}*${t}*(3-2*${t})*${a.toFixed(4)})`;
  const ch = (p) => (a < 0 ? `${p}(X,Y)*(1+${f})` : `${p}(X,Y)+(255-${p}(X,Y))*${f}`);
  return `format=gbrp,geq=r='${ch('r')}':g='${ch('g')}':b='${ch('b')}'`;
}

// Copies a file into the FFmpeg work dir and returns the bare name (drive letters break filtergraphs).
export function stager(wd) {
  let k = 0;
  return (p) => { const name = `lut${k++}${path.extname(p)}`; fs.copyFileSync(p, path.join(wd, name)); return name; };
}
