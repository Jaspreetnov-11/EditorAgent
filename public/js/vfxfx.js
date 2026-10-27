// 💥 VFX picture effects - the ones that change the shot's own pixels: heat haze, shockwave ripple, digital glitch,
// hologram, Chroma Key Pro (spill + light wrap) and the AI ones (sky replacement, depth fog, depth of field, which read a
// matte made by engine/vfxai.py). They join the clip effects registry (effects.js VFX, cat 'VFX'), so Effect Controls,
// the Effects panel, the viewer and engine/render2.mjs all know them:
//   ff(p, ctx)  -> { graph(in, out) } FFmpeg filters. ctx = { W, H, F, clip, aux(spec) -> label of a matte / picture input
//                  lined up with the shot (render2 segment()), absent where there is none - the AI part is then left out }
//   pix(g, W, H, p, info) -> the live monitor: the same maths in a WebGL shader (vfxgl.js) on the layer's canvas
// The moving ones work through low-resolution displacement maps (geq at 320 px, scaled up), so a 4K render stays quick.
// p._k = { param: Motion-style keyframes } (keyframes made on the VFX page); p.ai / p.aiT0 = the AI matte (cache path,
// source second it starts at); p.subj / p.subjT0 = a subject matte: the subject is kept clean of the effect.
import { val, bezier } from './motion.js';
import { runGL } from './vfxgl.js';

const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const f5 = (x) => (+x).toFixed(5);
const hex3 = (c) => { const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(c || ''); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [1, 1, 1]; };
const ffHex = (c) => `0x${String(c || '#ffffff').replace('#', '').slice(0, 6)}`;
// a keyframed parameter (Motion keys { t, v, e, hold }) as an FFmpeg expression of T: linear pieces, eased segments
// sampled into eight
export function kexpr(prop, T = 'T') {
  const K = prop?.k;
  if (!Array.isArray(K) || !K.length) return f5(num(prop, 0));
  const pts = [];
  K.forEach((a, i) => {
    const b = K[i + 1];
    pts.push([+a.t, +a.v]);
    if (!b) return;
    if (a.hold) { pts.push([+b.t - 1e-4, +a.v]); return; }
    const e = a.e || [0, 0, 1, 1];
    if (e[0] !== e[1] || e[2] !== e[3]) for (let j = 1; j < 8; j++) pts.push([+a.t + ((b.t - a.t) * j) / 8, +a.v + (b.v - a.v) * bezier(e, j / 8)]);
  });
  let ex = f5(pts[pts.length - 1][1]);
  for (let i = pts.length - 2; i >= 0; i--) {
    const [t0, v0] = pts[i], [t1, v1] = pts[i + 1];
    ex = `if(lt(${T},${f5(t1)}),${f5(v0)}+(${f5(v1 - v0)})*(${T}-${f5(t0)})/${f5(Math.max(1e-6, t1 - t0))},${ex})`;
  }
  return `if(lt(${T},${f5(pts[0][0])}),${f5(pts[0][1])},${ex})`;
}
const def = (type, k) => VX[type].params[k]?.def;
// a parameter now (live) / at the start (render filters without expressions) / as an expression of T (render maps)
const at = (type, p, k, t = 0) => (p?._k?.[k] ? num(val(p._k[k], t), def(type, k)) : typeof def(type, k) === 'number' ? num(p?.[k], def(type, k)) : p?.[k] ?? def(type, k));
const ex = (type, p, k) => (p?._k?.[k] ? `(${kexpr(p._k[k])})` : f5(at(type, p, k)));
const h = (n) => `(sin(${n})*43758.5453-floor(sin(${n})*43758.5453))`;
// a displacement map pair made from the picture itself (so it lasts exactly as long), 320 px wide, then full size
const MW = 320;
function dispGraph(a, b, W, H, dx, dy, extra = []) {
  const mh = Math.max(2, Math.round((MW * H) / W / 2) * 2);
  return [`[${a}]split[${b}s][${b}m]`, `[${b}m]scale=${MW}:${mh},format=gray,split[${b}m1][${b}m2]`,
    `[${b}m1]geq=lum='${dx}',scale=${W}:${H}:flags=bicubic,format=gbrp[${b}x]`, `[${b}m2]geq=lum='${dy}',scale=${W}:${H}:flags=bicubic,format=gbrp[${b}y]`,
    `[${b}s]format=gbrp[${b}g]`, `[${b}g][${b}x][${b}y]displace=edge=smear${extra.length ? '' : ',format=yuv420p'}[${extra.length ? `${b}d` : b}]`, ...extra].join(';');
}
const P = (k, label, d, min, max, step, unit = '') => [k, { label, def: d, min, max, step, ...(unit ? { unit } : {}) }];
const SEL = (k, label, d, options) => [k, { label, type: 'select', def: d, options }];
const COL = (k, label, d) => [k, { label, type: 'color', def: d }];
const params = (...a) => Object.fromEntries(a);
// which parameters may be keyframed (the render turns them into expressions)
export const ANIM = { vxhaze: ['amount'], vxshock: ['strength', 'glow'], vxglitch: ['amount'], vxfog: ['density'] };
// the AI matte each one needs ('depth' | 'sky')
export const NEEDS_AI = { vxsky: 'sky', vxfog: 'depth', vxdof: 'depth' };

// ---- live: the matte / sky pictures come from the page (set by vfxpage.js); null in Node ----
let auxPic = null;
export function setVfxAux(fn) { auxPic = fn; }
const srcT = (c, rel) => (+c?.in || 0) + (rel || 0) * (+c?.speed || 1);
function pixGL(type, g, W, H, p, info, uni) {
  const c = info.c, rel = info.rel || 0, sp = +c?.speed || 1;
  const aux = p.ai && auxPic ? auxPic(p.ai, srcT(c, rel) - num(p.aiT0, 0), sp) : null;
  const subj = p.subj && auxPic ? auxPic(p.subj, srcT(c, rel) - num(p.subjT0, 0), sp) : null;
  const sky = p.skyMedia && auxPic ? auxPic(`media:${p.skyMedia}`, rel, 1) : null;
  const out = runGL(type, g.canvas, W, H, { T: rel, aux, subj, sky, ...uni });
  if (!out) return;
  g.save(); g.globalCompositeOperation = 'copy'; g.drawImage(out, 0, 0, W, H); g.restore();
}
// 🧍 the subject kept clean: the effect's result and the original merged through the subject matte (render)
function protect(p, ctx, a, b, core) {
  const lab = p.subj && ctx.aux ? ctx.aux({ cache: p.subj, t0: num(p.subjT0, 0) }) : null;
  if (!lab) return core(a, b);
  return [`[${a}]split[${b}o0][${b}i]`, core(`${b}i`, `${b}e`), `[${b}e]format=gbrp[${b}e2]`, `[${b}o0]format=gbrp[${b}o]`, `[${lab}]format=gbrp[${b}sm]`, `[${b}e2][${b}o][${b}sm]maskedmerge,format=yuv420p[${b}]`].join(';');
}

const VX = {
  vxhaze: { label: 'Heat haze', cat: 'VFX', params: params(P('amount', 'Amount', 7, 0, 40, 0.5, 'px'), P('scale', 'Ripple size', 1, 0.3, 3, 0.05), P('speed', 'Speed', 1, 0, 4, 0.05), SEL('area', 'Where', 'all', [['all', 'Whole picture'], ['bottom', 'Rising from the ground']])),
    ff: (p, ctx) => ({ graph: (a, b) => protect(p, ctx, a, b, (a2, b2) => {
      const { W } = ctx, A = `${ex('vxhaze', p, 'amount')}*${f5(W / 1920)}`, sc = f5(at('vxhaze', p, 'scale')), sp = f5(at('vxhaze', p, 'speed')), m = at('vxhaze', p, 'area') === 'bottom' ? 'clip((Y/H-0.25)/0.75,0,1)' : '1';
      return dispGraph(a2, b2, W, ctx.H, `128+${A}*(0.6*sin(Y/H*40/${sc}+T*${sp}*4+3*sin(X/W*9/${sc}+T*${sp}))+0.4*sin(X/W*23/${sc}-T*${sp}*3+Y/H*17/${sc}))*${m}`, `128+${A}*0.5*sin(X/W*31/${sc}+T*${sp}*5+2*sin(Y/H*11/${sc}))*${m}`);
    }) }),
    pix: (g, W, H, p, info) => pixGL('heathaze', g, W, H, p, info, { u: [(at('vxhaze', p, 'amount', info.rel) * W) / 1920, at('vxhaze', p, 'scale'), at('vxhaze', p, 'speed'), at('vxhaze', p, 'area') === 'bottom' ? 1 : 0] }) },
  vxshock: { label: 'Shockwave ripple', cat: 'VFX', params: params(P('x', 'Centre X', 50, 0, 100, 0.5, '%'), P('y', 'Centre Y', 50, 0, 100, 0.5, '%'), P('start', 'Goes off at', 0.2, 0, 60, 0.05, 's'), P('speed', 'Speed', 0.9, 0.1, 3, 0.05), P('width', 'Ring width', 0.06, 0.01, 0.3, 0.005), P('strength', 'Strength', 45, 0, 120, 1, 'px'), P('glow', 'Ring glow', 0.35, 0, 1, 0.05), COL('color', 'Glow colour', '#bfe4ff')),
    ff: (p, ctx) => ({ graph: (a, b) => protect(p, ctx, a, b, (a2, b2) => {
      const { W, H } = ctx, A = (k) => f5(at('vxshock', p, k)), cx = f5(at('vxshock', p, 'x') / 100), cy = f5(at('vxshock', p, 'y') / 100), ar = f5(H / W);
      const kk = `st(0,max(hypot(X/W-${cx},(Y/H-${cy})*${ar}),0.001));st(1,(T-${A('start')})*${A('speed')});st(2,gte(T,${A('start')})*exp(-pow((ld(0)-ld(1))/${A('width')},2))*clip(1-ld(1)/1.2,0,1))`;
      const S = `${ex('vxshock', p, 'strength')}*${f5(W / 1920)}`, [r, g2, bl] = hex3(at('vxshock', p, 'color')), mh = Math.max(2, Math.round((MW * H) / W / 2) * 2);
      const glow = [`[${b2}d]split[${b2}d1][${b2}d2]`, `[${b2}d2]scale=${MW}:${mh},format=gray,geq=lum='${kk};255*${ex('vxshock', p, 'glow')}*ld(2)*0.6',scale=${W}:${H}:flags=bicubic,format=gbrp,colorchannelmixer=rr=${f5(r)}:gg=${f5(g2)}:bb=${f5(bl)}[${b2}gl]`,
        `[${b2}d1][${b2}gl]blend=all_mode=addition,format=yuv420p[${b2}]`];
      return dispGraph(a2, b2, W, H, `${kk};128+${S}*ld(2)*(X/W-${cx})/ld(0)`, `${kk};128+${S}*ld(2)*(Y/H-${cy})*${ar}/ld(0)`, glow);
    }) }),
    pix: (g, W, H, p, info) => pixGL('shockwave', g, W, H, p, info, { u: [at('vxshock', p, 'x') / 100, at('vxshock', p, 'y') / 100, at('vxshock', p, 'start'), at('vxshock', p, 'speed'), at('vxshock', p, 'width'), (at('vxshock', p, 'strength', info.rel) * W) / 1920, at('vxshock', p, 'glow', info.rel), H / W], c1: hex3(at('vxshock', p, 'color')) }) },
  vxglitch: { label: 'Glitch (digital)', cat: 'VFX', params: params(P('amount', 'Amount', 0.5, 0, 1, 0.01), P('blocks', 'Rows', 18, 4, 60, 1), P('speed', 'Changes a second', 10, 1, 30, 1), P('rgb', 'Colour split', 10, 0, 40, 1, 'px')),
    ff: (p, ctx) => ({ graph: (a, b) => protect(p, ctx, a, b, (a2, b2) => {
      const { W } = ctx, amt = ex('vxglitch', p, 'amount'), sp = f5(at('vxglitch', p, 'speed')), bk = f5(at('vxglitch', p, 'blocks'));
      const dx = `st(0,floor(T*${sp}));st(1,floor(Y/H*${bk}));st(2,gte(${h(`floor(T*${sp}/3)*5.3+1.7`)},0.35));128+gte(${h('ld(1)*12.9898+ld(0)*78.233')},1-${amt}*0.6)*ld(2)*(${h('ld(1)*3.1+ld(0)*1.7')}-0.5)*2*${amt}*0.06*${W}`;
      const o = Math.round((at('vxglitch', p, 'rgb') * at('vxglitch', p, 'amount') * W) / 1920);
      return dispGraph(a2, b2, W, ctx.H, dx, '128', o ? [`[${b2}d]rgbashift=rh=${o}:bh=${-o},format=yuv420p[${b2}]`] : [`[${b2}d]format=yuv420p[${b2}]`]);
    }) }),
    pix: (g, W, H, p, info) => pixGL('glitch', g, W, H, p, info, { u: [at('vxglitch', p, 'amount', info.rel), at('vxglitch', p, 'blocks'), at('vxglitch', p, 'speed'), Math.round((at('vxglitch', p, 'rgb') * at('vxglitch', p, 'amount') * W) / 1920)] }) },
  vxholo: { label: 'Hologram', cat: 'VFX', params: params(COL('color', 'Colour', '#36e0ff'), P('lines', 'Scan line spacing', 4, 2, 20, 1, 'px'), P('flicker', 'Flicker', 0.5, 0, 1, 0.05)),
    ff: (p, ctx) => ({ graph: (a, b) => protect(p, ctx, a, b, (a2, b2) => {
      const [r, g2, bl] = hex3(at('vxholo', p, 'color')).map((x) => x * 1.4), sp = Math.max(2, Math.round((at('vxholo', p, 'lines') * ctx.H) / 1080)), fl = at('vxholo', p, 'flicker');
      const m = (c) => `${c[0]}r=${f5(0.299 * c[1])}:${c[0]}g=${f5(0.587 * c[1])}:${c[0]}b=${f5(0.114 * c[1])}`;
      return `[${a2}]format=gbrp,colorchannelmixer=${m(['r', r])}:${m(['g', g2])}:${m(['b', bl])},format=yuv420p,drawgrid=x=-4:y=0:w=${ctx.W + 64}:h=${sp}:t=${Math.max(1, Math.floor(sp / 2))}:color=black@0.35${fl ? `,eq=brightness='${f5(fl * 0.08)}*sin(t*50)':eval=frame` : ''}[${b2}]`;
    }) }),
    pix: (g, W, H, p, info) => pixGL('hologram', g, W, H, p, info, { u: [Math.max(2, (at('vxholo', p, 'lines') * H) / 1080), at('vxholo', p, 'flicker')], c1: hex3(at('vxholo', p, 'color')) }) },
  // (a key: done in the render's final pass on the overlay, so the shots below show through - V2 and up)
  vxkey: { label: 'Chroma Key Pro (spill + light wrap)', cat: 'VFX', v2only: true, params: params(COL('color', 'Screen colour', '#00b140'), P('sim', 'Similarity', 0.18, 0.01, 0.6, 0.01), P('soft', 'Softness', 0.08, 0, 0.4, 0.01), P('spill', 'Spill removal', 0.8, 0, 1, 0.05), SEL('screen', 'Screen', 'green', [['green', 'Green'], ['blue', 'Blue']]), P('wrap', 'Light wrap', 0.35, 0, 1, 0.05), COL('wrapColor', 'Light wrap colour (the new background)', '#ffcf9a')),
    ff: () => 'null',
    key: (p) => {
      const A = (k) => at('vxkey', p, k), S = f5(A('spill')), wr = f5(A('wrap')), [wR, wG, wB] = hex3(A('wrapColor')).map((x) => f5(x * 255)), blue = A('screen') === 'blue';
      const sp = (c, o1, o2) => `(${c}(X,Y)-${S}*max(0,${c}(X,Y)-max(${o1}(X,Y),${o2}(X,Y))))`, w = `${wr}*(1-alpha(X,Y)/255)*gt(alpha(X,Y),0)`;
      const R = 'r(X,Y)', G = blue ? 'g(X,Y)' : sp('g', 'r', 'b'), B = blue ? sp('b', 'r', 'g') : 'b(X,Y)';
      return `chromakey=${ffHex(A('color'))}:${f5(A('sim'))}:${f5(Math.max(0.001, A('soft')))},format=rgba,geq=r='${R}+(${wR}-${R})*${w}':g='${G}+(${wG}-${G})*${w}':b='${B}+(${wB}-${B})*${w}':a='alpha(X,Y)'`;
    },
    pix: (g, W, H, p, info) => pixGL('keypro', g, W, H, p, info, { u: [at('vxkey', p, 'sim'), at('vxkey', p, 'soft'), at('vxkey', p, 'spill'), at('vxkey', p, 'wrap'), at('vxkey', p, 'screen') === 'blue' ? 1 : 0], c1: hex3(at('vxkey', p, 'color')), c2: hex3(at('vxkey', p, 'wrapColor')) }) },
  vxsky: { label: 'Sky replacement (AI)', cat: 'VFX', params: params(COL('top', 'Sky top', '#1d3b78'), COL('horizon', 'Sky at the horizon', '#ff9a5a'), P('bright', 'Sky brightness', 1, 0.3, 2, 0.05), P('edge', 'Edge softness', 3, 0, 20, 0.5, 'px')),
    ff: (p, ctx) => ({ graph: (a, b) => {
      const S = p.ai && ctx.aux ? ctx.aux({ cache: p.ai, t0: num(p.aiT0, 0) }) : null;
      if (!S) return `[${a}]null[${b}]`;
      const { W, H } = ctx, A = (k) => at('vxsky', p, k), [tr, tg, tb] = hex3(A('top')), [hr, hg, hb] = hex3(A('horizon')), br = A('bright');
      const sky = p.skyMedia && ctx.aux({ media: p.skyMedia });
      const gr = (t2, h2) => `'255*min(1,${f5(br)}*(${f5(t2)}+(${f5(h2 - t2)})*pow(Y/(H-1),0.8)))'`;
      const skyG = sky ? [`[${sky}]format=gbrp${br !== 1 ? `,colorchannelmixer=rr=${f5(br)}:gg=${f5(br)}:bb=${f5(br)}` : ''}[${b}k]`]
        : [`[${b}q]scale=2:64,format=gbrp,geq=r=${gr(tr, hr)}:g=${gr(tg, hg)}:b=${gr(tb, hb)},scale=${W}:${H}:flags=bicubic[${b}k]`];
      const e = (A('edge') * W) / 1920 / 2;
      return [sky ? `[${a}]format=gbrp[${b}p]` : `[${a}]split[${b}p0][${b}q]`, ...(sky ? [] : [`[${b}p0]format=gbrp[${b}p]`]), ...skyG,
        `[${S}]format=gray${e > 0.2 ? `,gblur=sigma=${f5(e)}` : ''},format=gbrp[${b}m]`, `[${b}p][${b}k][${b}m]maskedmerge,format=yuv420p[${b}]`].join(';');
    } }),
    pix: (g, W, H, p, info) => pixGL('skyreplace', g, W, H, p, info, { u: [(at('vxsky', p, 'edge') * W) / 1920 / 2, at('vxsky', p, 'bright')], c1: hex3(at('vxsky', p, 'top')), c2: hex3(at('vxsky', p, 'horizon')) }) },
  vxfog: { label: 'Depth fog (AI)', cat: 'VFX', params: params(P('density', 'Density', 0.7, 0, 1, 0.01), P('near', 'Fog starts (near 0 - far 1)', 0.35, 0, 1, 0.01), P('far', 'Thickest at', 0.95, 0, 1, 0.01), COL('color', 'Fog colour', '#c9d3dc')),
    ff: (p, ctx) => ({ graph: (a, b) => protect(p, ctx, a, b, (a2, b2) => {
      const D = p.ai && ctx.aux ? ctx.aux({ cache: p.ai, t0: num(p.aiT0, 0) }) : null;
      if (!D) return `[${a2}]null[${b2}]`;
      const { W, H } = ctx, A = (k) => at('vxfog', p, k), nr = f5(A('near')), sp = f5(Math.max(0.001, A('far') - A('near'))), mh = Math.max(2, Math.round((MW * H) / W / 2) * 2);
      return [`[${a2}]split[${b2}p0][${b2}s]`, `[${b2}s]drawbox=c=${ffHex(A('color'))}:t=fill,format=gbrp[${b2}c]`, `[${b2}p0]format=gbrp[${b2}p]`,
        `[${D}]format=gray,scale=${MW}:${mh},geq=lum='st(0,clip(((255-lum(X,Y))/255-${nr})/${sp},0,1));255*clip(${ex('vxfog', p, 'density')}*ld(0)*ld(0)*(3-2*ld(0)),0,1)',scale=${W}:${H}:flags=bicubic,format=gbrp[${b2}m]`,
        `[${b2}p][${b2}c][${b2}m]maskedmerge,format=yuv420p[${b2}]`].join(';');
    }) }),
    pix: (g, W, H, p, info) => pixGL('depthfog', g, W, H, p, info, { u: [at('vxfog', p, 'density', info.rel), at('vxfog', p, 'near'), at('vxfog', p, 'far')], c1: hex3(at('vxfog', p, 'color')) }) },
  vxdof: { label: 'Depth of field (AI)', cat: 'VFX', params: params(P('focus', 'In focus at (far 0 - near 1)', 0.75, 0, 1, 0.01), P('range', 'Sharp range', 0.12, 0, 0.5, 0.01), P('blur', 'Background blur', 14, 0, 60, 0.5, 'px')),
    ff: (p, ctx) => ({ graph: (a, b) => protect(p, ctx, a, b, (a2, b2) => {
      const D = p.ai && ctx.aux ? ctx.aux({ cache: p.ai, t0: num(p.aiT0, 0) }) : null;
      if (!D) return `[${a2}]null[${b2}]`;
      const { W, H } = ctx, A = (k) => at('vxdof', p, k), mh = Math.max(2, Math.round((MW * H) / W / 2) * 2);
      return [`[${a2}]split[${b2}p0][${b2}q]`, `[${b2}q]gblur=sigma=${f5(Math.max(0.1, (A('blur') * W) / 1920 / 2))},format=gbrp[${b2}bl]`, `[${b2}p0]format=gbrp[${b2}p]`,
        `[${D}]format=gray,scale=${MW}:${mh},geq=lum='255*clip((abs(lum(X,Y)/255-${f5(A('focus'))})-${f5(A('range'))})/0.25,0,1)',scale=${W}:${H}:flags=bicubic,format=gbrp[${b2}m]`,
        `[${b2}p][${b2}bl][${b2}m]maskedmerge,format=yuv420p[${b2}]`].join(';');
    }) }),
    pix: (g, W, H, p, info) => pixGL('depthdof', g, W, H, p, info, { u: [at('vxdof', p, 'focus'), at('vxdof', p, 'range'), (at('vxdof', p, 'blur') * W) / 1920] }) },
};
export const VFX_PIC = VX;
