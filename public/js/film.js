// film.js - 🎞 Limelight Film: a film look in one effect - a print look (film curve, dye crosstalk, colour of shadows /
// mids / highlights, saturation), halation (the red-orange glow film gets around bright lights), bloom, film grain that
// sits in the midtones, vignette, gate weave and flicker. Our own maths and our own looks, made with FFmpeg's filters
// (engine/render2.mjs runs it through effects.js VFX.film) and approximated with CSS in the live viewer (exact in
// Accurate preview). Amounts are for a 1920-wide frame and scaled to the render's size.
const n = (v, d) => (Number.isFinite(+v) ? +v : d);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f3 = (v) => (+v).toFixed(3);

// the looks: curve = the film's tone curve (x/y points, 0..1), mix = how the dyes bleed into each other (3x3, rows r g b),
// bal = colour of shadows / mids / highlights (FFmpeg colorbalance, -1..1 per r g b), sat = saturation,
// css = what the live viewer shows instead (approximate)
export const FILM_LOOKS = {
  clean: { label: 'Clean Negative', curve: [[0, 0.01], [0.25, 0.22], [0.5, 0.51], [0.75, 0.79], [1, 0.98]], mix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], bal: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], sat: 1, css: 'contrast(1.06)' },
  golden: { label: 'Golden Hour Print', curve: [[0, 0.02], [0.25, 0.21], [0.5, 0.52], [0.75, 0.81], [1, 0.97]], mix: [[1.04, -0.02, -0.02], [0.02, 0.99, -0.01], [-0.02, 0.04, 0.98]], bal: [[0.02, 0, -0.04], [0.05, 0.01, -0.06], [0.08, 0.03, -0.08]], sat: 1.06, css: 'contrast(1.08) saturate(1.06) sepia(0.16)' },
  monsoon: { label: 'Monsoon Cool', curve: [[0, 0.03], [0.25, 0.23], [0.5, 0.5], [0.75, 0.77], [1, 0.95]], mix: [[0.97, 0.03, 0], [0.01, 1, -0.01], [0, 0.05, 0.98]], bal: [[-0.04, 0.01, 0.05], [-0.03, 0.01, 0.03], [-0.02, 0, 0.02]], sat: 0.9, css: 'contrast(1.04) saturate(0.9) hue-rotate(-6deg)' },
  faded: { label: 'Faded Print', curve: [[0, 0.08], [0.25, 0.26], [0.5, 0.5], [0.75, 0.74], [1, 0.92]], mix: [[1, 0, 0], [0.02, 0.98, 0], [0, 0.02, 0.98]], bal: [[0.03, 0.01, -0.01], [0.02, 0, -0.02], [0.01, 0, -0.02]], sat: 0.82, css: 'contrast(0.88) saturate(0.82) brightness(1.03) sepia(0.08)' },
  bleach: { label: 'Bleach Bypass', curve: [[0, 0], [0.25, 0.17], [0.5, 0.5], [0.75, 0.85], [1, 1]], mix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], bal: [[0, 0, 0.01], [0, 0, 0], [0.01, 0.01, 0]], sat: 0.55, css: 'contrast(1.22) saturate(0.55)' },
  tungsten: { label: 'Night Tungsten', curve: [[0, 0.01], [0.25, 0.2], [0.5, 0.5], [0.75, 0.81], [1, 0.98]], mix: [[1.02, -0.02, 0], [-0.01, 1.01, 0], [-0.03, 0.03, 1]], bal: [[-0.05, 0, 0.07], [0, 0, 0], [0.07, 0.02, -0.06]], sat: 1.04, css: 'contrast(1.1) saturate(1.04)' },
  classic: { label: 'Classic Cinema', curve: [[0, 0.015], [0.25, 0.19], [0.5, 0.5], [0.75, 0.82], [1, 0.975]], mix: [[1.03, -0.01, -0.02], [-0.02, 1.03, -0.01], [-0.01, -0.03, 1.04]], bal: [[0, 0.01, 0.02], [0.02, 0, -0.01], [0.03, 0.01, -0.02]], sat: 1.08, css: 'contrast(1.12) saturate(1.08)' },
  silver: { label: 'Silver B&W', curve: [[0, 0.01], [0.25, 0.19], [0.5, 0.5], [0.75, 0.83], [1, 0.99]], mix: [[0.36, 0.54, 0.1], [0.36, 0.54, 0.1], [0.36, 0.54, 0.1]], bal: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], sat: 1, css: 'grayscale(1) contrast(1.15)' },
};
// grain size: how much smaller the noise picture is made before it is scaled up (bigger = coarser grain)
const GRAIN_SIZE = { fine: 1, medium: 1.7, coarse: 2.8 };

export const FILM_PARAMS = {
  look: { label: 'Look', type: 'select', def: 'classic', options: Object.entries(FILM_LOOKS).map(([k, l]) => [k, l.label]) },
  strength: { label: 'Look strength', min: 0, max: 1, step: 0.05, def: 0.8 },
  halation: { label: 'Halation', min: 0, max: 1, step: 0.05, def: 0.35 },
  halRadius: { label: 'Halation size', min: 4, max: 60, step: 1, def: 18, unit: 'px' },
  bloom: { label: 'Bloom', min: 0, max: 1, step: 0.05, def: 0.15 },
  grain: { label: 'Grain', min: 0, max: 1, step: 0.05, def: 0.35 },
  grainSize: { label: 'Grain size', type: 'select', def: 'medium', options: [['fine', 'Fine (35mm)'], ['medium', 'Medium (16mm)'], ['coarse', 'Coarse (8mm)']] },
  vignette: { label: 'Vignette', min: 0, max: 1, step: 0.05, def: 0.25 },
  weave: { label: 'Gate weave', min: 0, max: 1, step: 0.05, def: 0 },
  flicker: { label: 'Flicker', min: 0, max: 1, step: 0.05, def: 0 },
};
const P = (p, k) => (FILM_PARAMS[k].type === 'select' ? (p[k] in (k === 'look' ? FILM_LOOKS : GRAIN_SIZE) ? p[k] : FILM_PARAMS[k].def) : clamp(n(p[k], FILM_PARAMS[k].def), FILM_PARAMS[k].min, FILM_PARAMS[k].max));

// the look's colour part as one filter chain, blended toward "no change" by s (0..1)
export function lookChain(lookKey, s) {
  const L = FILM_LOOKS[lookKey] || FILM_LOOKS.classic, f = [];
  if (s <= 0) return '';
  const pts = L.curve.map(([x, y]) => `${f3(x)}/${f3(x + (y - x) * s)}`).join(' ');
  f.push(`curves=all='${pts}'`);
  const m = L.mix.map((row, i) => row.map((v, j) => (i === j ? 1 : 0) + (v - (i === j ? 1 : 0)) * s));
  if (m.some((row, i) => row.some((v, j) => Math.abs(v - (i === j ? 1 : 0)) > 1e-4))) {
    const k = ['r', 'g', 'b'];
    f.push(`colorchannelmixer=${m.map((row, i) => row.map((v, j) => `${k[i]}${k[j]}=${f3(v)}`).join(':')).join(':')}`);
  }
  if (L.bal.flat().some((v) => v)) {
    const [sh, mi, hi] = L.bal;
    f.push(`colorbalance=rs=${f3(sh[0] * s)}:gs=${f3(sh[1] * s)}:bs=${f3(sh[2] * s)}:rm=${f3(mi[0] * s)}:gm=${f3(mi[1] * s)}:bm=${f3(mi[2] * s)}:rh=${f3(hi[0] * s)}:gh=${f3(hi[1] * s)}:bh=${f3(hi[2] * s)}`);
  }
  if (Math.abs(L.sat - 1) > 1e-3) f.push(`eq=saturation=${f3(1 + (L.sat - 1) * s)}`);
  return f.join(',');
}

// the FFmpeg graph: in label a -> out label b. ctx = { W, H, F } (output size and frame rate)
export function filmGraph(p0, { W = 1920, H = 1080, F = 30 } = {}) {
  const p = Object.fromEntries(Object.keys(FILM_PARAMS).map((k) => [k, P(p0 || {}, k)]));
  const k = W / 1920, fps = Math.max(1, Math.round(n(F, 30)));
  return { graph: (a, b) => {
    const g = [];
    let cur = a;
    const step = (body, label) => { g.push(`[${cur}]${body}[${label}]`); cur = label; };
    const look = lookChain(p.look, p.strength);
    step(`${look ? `${look},` : ''}format=gbrp`, `${b}l`);
    // halation: only the bright parts, blurred wide, turned red-orange, laid over with screen
    if (p.halation > 0) {
      g.push(`[${cur}]split[${b}h0][${b}h1]`);
      g.push(`[${b}h1]curves=all='0/0 0.6/0 0.85/0.55 1/1',gblur=sigma=${f3(Math.max(1, p.halRadius * k))},colorchannelmixer=rr=1:rg=0:rb=0:gr=0.32:gg=0.06:gb=0:br=0.05:bg=0:bb=0.04[${b}h2]`);
      g.push(`[${b}h0][${b}h2]blend=all_mode=screen:all_opacity=${f3(clamp(p.halation * 0.9, 0, 1))}[${b}h]`);
      cur = `${b}h`;
    }
    // bloom: a softer, wider, neutral glow from the highlights
    if (p.bloom > 0) {
      g.push(`[${cur}]split[${b}b0][${b}b1]`);
      g.push(`[${b}b1]curves=all='0/0 0.5/0 1/0.9',gblur=sigma=${f3(Math.max(2, 42 * k))}[${b}b2]`);
      g.push(`[${b}b0][${b}b2]blend=all_mode=screen:all_opacity=${f3(clamp(p.bloom * 0.6, 0, 1))}[${b}bl]`);
      cur = `${b}bl`;
    }
    // grain: grey noise (new every frame), made smaller and scaled up for a coarser grain, laid over with "overlay" -
    // strongest in the midtones, almost none in deep black and bright white, like film
    if (p.grain > 0) {
      const sz = GRAIN_SIZE[p.grainSize], gw = Math.max(16, Math.round(W / sz / 2) * 2), gh = Math.max(16, Math.round(H / sz / 2) * 2);
      // (mostly luma, a trace of colour; softened a touch so it reads as grain, not as digital noise)
      g.push(`color=c=0x808080:s=${gw}x${gh}:r=${fps},format=yuv444p,noise=c0s=${Math.round(8 + 22 * p.grain)}:c0f=t:c1s=${Math.round(1 + 2 * p.grain)}:c1f=t:c2s=${Math.round(1 + 2 * p.grain)}:c2f=t,gblur=sigma=0.6,scale=${W}:${H}:flags=bicubic,format=gbrp[${b}g0]`);
      g.push(`[${cur}][${b}g0]blend=all_mode=overlay:all_opacity=${f3(clamp(0.2 + 0.45 * p.grain, 0, 1))}:shortest=1[${b}gr]`);
      cur = `${b}gr`;
    }
    const tail = [];
    if (p.vignette > 0) tail.push(`vignette=angle=${f3(0.18 + 0.42 * p.vignette)}`);
    // gate weave: the frame drifts a pixel or two the way film does in the gate (cropped a little, scaled back)
    if (p.weave > 0) {
      const m = Math.max(1, Math.round((1 + 4 * p.weave) * k));
      tail.push(`crop=w=iw-${2 * m}:h=ih-${2 * m}:x='${m}+${f3(m * 0.6)}*sin(n*1.37)+${f3(m * 0.4)}*sin(n*0.29)':y='${m}+${f3(m * 0.5)}*sin(n*1.11+1)'`, `scale=${W}:${H}`);
    }
    if (p.flicker > 0) tail.push(`eq=brightness='${f3(0.03 * p.flicker)}*(sin(t*29)+0.5*sin(t*53))':eval=frame`);
    tail.push('format=yuv420p');
    g.push(`[${cur}]${tail.join(',')}[${b}]`);
    return g.join(';');
  } };
}

// the live viewer's approximation: a CSS filter for the look, glow as brightness, the grain and the vignette as overlays
export function filmCss(p0, grainCss) {
  const p = Object.fromEntries(Object.keys(FILM_PARAMS).map((k) => [k, P(p0 || {}, k)]));
  const L = FILM_LOOKS[p.look], f = [];
  if (p.strength > 0) f.push(L.css.replace(/(contrast|saturate|brightness)\(([\d.]+)\)/g, (_, fn, v) => `${fn}(${f3(1 + (v - 1) * p.strength)})`).replace(/(sepia|grayscale)\(([\d.]+)\)/g, (_, fn, v) => `${fn}(${f3(v * p.strength)})`).replace(/hue-rotate\((-?[\d.]+)deg\)/g, (_, v) => `hue-rotate(${f3(v * p.strength)}deg)`));
  if (p.halation + p.bloom > 0) f.push(`brightness(${f3(1 + 0.05 * p.halation + 0.07 * p.bloom)})`);
  const vig = p.vignette > 0 ? `radial-gradient(ellipse at center, rgba(0,0,0,0) ${Math.round(70 - 30 * p.vignette)}%, rgba(0,0,0,${f3(0.25 + 0.5 * p.vignette)}) 100%)` : '';
  return { filter: f.join(' '), ...(p.grain > 0 ? { overlay: grainCss(p.grain), grain: true } : {}), ...(vig ? { overlays: [vig] } : {}) };
}
