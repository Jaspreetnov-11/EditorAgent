// 🎨 Lumetri panel (Color page, right): Premiere's Lumetri Color sections, each with an on / off switch -
// Basic Correction · Creative · Curves · Color Wheels & Match · HSL Secondary · Vignette. Values live in clip.color
// (colormath.js SECTION_KEYS); a switched-off section stays in the clip but is left out of the preview and the render.
import { ic } from './lineicons.js';
import { $, $$, esc } from './ui.js';
import { HSL_DEF } from './colormath.js';

// [path, label, min, max, step, default, unit / hint]
const BASIC = [['temp', 'Temperature', -1, 1, 0.01, 0, 'cool – warm'], ['tint', 'Tint', -1, 1, 0.01, 0, 'green – magenta'], ['exposure', 'Exposure', -3, 3, 0.01, 0, 'stops'],
  ['contrast', 'Contrast', 0.3, 2.5, 0.01, 1], ['pivot', 'Contrast pivot', 0.1, 0.9, 0.005, 0.435], ['highlights', 'Highlights', -1, 1, 0.01, 0], ['shadows', 'Shadows', -1, 1, 0.01, 0],
  ['whites', 'Whites', -1, 1, 0.01, 0], ['blacks', 'Blacks', -1, 1, 0.01, 0], ['saturation', 'Saturation', 0, 2.5, 0.01, 1]];
const CREATIVE = [['lookAmt', 'Look intensity', 0, 1, 0.01, 1], ['faded', 'Faded film', 0, 1, 0.01, 0], ['sharpen', 'Sharpen', 0, 1, 0.01, 0], ['vibrance', 'Vibrance', -1, 1, 0.01, 0],
  ['csat', 'Saturation', 0, 2, 0.01, 1], ['shTint.amt', 'Shadow tint', 0, 1, 0.01, 0], ['hiTint.amt', 'Highlight tint', 0, 1, 0.01, 0], ['tintBal', 'Tint balance', -1, 1, 0.01, 0]];
const HSL_KEY = [['hsl.hue', 'Hue (centre)', 0, 1, 0.002, HSL_DEF.hue, 'hue'], ['hsl.width', 'Hue range', 0.01, 1, 0.005, HSL_DEF.width], ['hsl.sat.0', 'Saturation from', 0, 1, 0.01, HSL_DEF.sat[0]], ['hsl.sat.1', 'Saturation to', 0, 1, 0.01, HSL_DEF.sat[1]],
  ['hsl.luma.0', 'Brightness from', 0, 1, 0.01, HSL_DEF.luma[0]], ['hsl.luma.1', 'Brightness to', 0, 1, 0.01, HSL_DEF.luma[1]], ['hsl.soft', 'Softness', 0.005, 0.4, 0.005, HSL_DEF.soft]];
const HSL_FIX = [['hsl.temp', 'Temperature', -1, 1, 0.01, 0], ['hsl.tint', 'Tint', -1, 1, 0.01, 0], ['hsl.exposure', 'Exposure', -2, 2, 0.01, 0], ['hsl.contrast', 'Contrast', -1, 1, 0.01, 0],
  ['hsl.hueShift', 'Hue shift °', -180, 180, 1, 0], ['hsl.sat2', 'Saturation', 0, 2, 0.01, 1]];
const VIG = [['vig.amount', 'Amount', -1, 1, 0.01, 0, '- darker · + lighter'], ['vig.mid', 'Midpoint', 0, 1.2, 0.01, 0.5], ['vig.round', 'Roundness', -1, 1, 0.01, 0, 'frame – circle'], ['vig.feather', 'Feather', 0.02, 1, 0.01, 0.5]];
const SECS = [['basic', 'Basic Correction'], ['creative', 'Creative'], ['curves', 'Curves'], ['wheels', 'Color Wheels & Match'], ['hsl', 'HSL Secondary'], ['vignette', 'Vignette']];

const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function set(o, p, v) { const ks = p.split('.'); let a = o; ks.slice(0, -1).forEach((k, i) => { if (a[k] == null) a[k] = /^\d+$/.test(ks[i + 1]) ? [] : {}; else a[k] = Array.isArray(a[k]) ? [...a[k]] : { ...a[k] }; a = a[k]; }); a[ks[ks.length - 1]] = v; }
const row = (c, [p, label, min, max, step, def, hint]) => {
  const v = get(c, p) ?? def;
  return `<label class="pr${p === 'hsl.hue' ? ' lm-hue' : ''}"><span>${label}${hint ? ` <i>${hint}</i>` : ''}</span><input type="range" data-lp="${p}" min="${min}" max="${max}" step="${step}" value="${v}">
    <input type="number" class="pr-n" data-ln="${p}" step="${step}" value="${+(+v).toFixed(3)}"><button class="icon-btn reset" data-lr="${p}" data-def="${def}" title="Reset">${ic('reset')}</button></label>`;
};

// el: the panel; api: { clip(), live(), commit(label, coalesce), luts(), pane(name), auto(), picking(on) }
export function mountLumetri(el, api) {
  const open = new Set(['basic']);
  function render() {
    const cl = api.clip(), c = cl?.color || {}, off = c.off || {};
    el.innerHTML = `<h3 class="lm-title">Lumetri Color</h3>${SECS.map(([k, t]) => `<details class="lm-sec${off[k] ? ' off' : ''}" data-ls="${k}"${open.has(k) ? ' open' : ''}>
      <summary><span class="grow">${t}</span><label class="lm-sw" title="${off[k] ? 'Off - switch on' : 'On - switch off to compare'}"><input type="checkbox" data-off="${k}"${off[k] ? '' : ' checked'}><i></i></label></summary>
      <div class="lm-body">${body(k, c)}</div></details>`).join('')}`;
    $$('details.lm-sec', el).forEach((d) => d.addEventListener('toggle', () => (d.open ? open.add(d.dataset.ls) : open.delete(d.dataset.ls))));
    $$('[data-off]', el).forEach((x) => { x.onclick = (e) => e.stopPropagation(); x.onchange = () => { const k = api.clip(); if (!k) return; k.color = { ...(k.color || {}) }; const o = { ...(k.color.off || {}) }; if (x.checked) delete o[x.dataset.off]; else o[x.dataset.off] = true; if (Object.keys(o).length) k.color.off = o; else delete k.color.off; api.commit(`${x.checked ? 'On' : 'Off'}: ${SECS.find((s) => s[0] === x.dataset.off)[1]}`); }; });
    const edit = (p, v, final) => { const k = api.clip(); if (!k) return; k.color = { ...(k.color || {}) }; if (p.startsWith('hsl.') && !k.color.hsl) k.color.hsl = { ...HSL_DEF, sat: [...HSL_DEF.sat], luma: [...HSL_DEF.luma] }; set(k.color, p, v); if (final) api.commit(`Lumetri: ${p}`, `${k.id}:lm:${p}`); else api.live(); };
    $$('[data-lp]', el).forEach((r) => { r.oninput = () => { $(`[data-ln="${r.dataset.lp}"]`, el).value = r.value; edit(r.dataset.lp, +r.value); }; r.onchange = () => edit(r.dataset.lp, +r.value, true); });
    $$('[data-ln]', el).forEach((n) => (n.onchange = () => edit(n.dataset.ln, +n.value, true)));
    $$('[data-lr]', el).forEach((b) => (b.onclick = () => edit(b.dataset.lr, +b.dataset.def, true)));
    $$('[data-lc]', el).forEach((i) => { i.oninput = () => edit(i.dataset.lc, i.value); i.onchange = () => edit(i.dataset.lc, i.value, true); });
    $$('[data-lsel]', el).forEach((s) => (s.onchange = () => { const k = api.clip(); if (!k) return; k.color = { ...(k.color || {}) }; if (s.value) k.color[s.dataset.lsel] = s.value; else delete k.color[s.dataset.lsel]; api.commit(`Lumetri: ${s.dataset.lsel}`); }));
    $$('[data-lchk]', el).forEach((x) => (x.onchange = () => edit(x.dataset.lchk, x.checked, true)));
    $$('[data-pane]', el).forEach((b) => (b.onclick = () => api.pane(b.dataset.pane)));
    $('[data-lauto]', el)?.addEventListener('click', () => api.auto());
    $('[data-lpick]', el)?.addEventListener('click', (e) => { api.picking(true); e.target.classList.add('on'); });
    $('[data-lhslreset]', el)?.addEventListener('click', () => { const k = api.clip(); if (k?.color?.hsl) { delete k.color.hsl; api.commit('Reset HSL secondary'); } });
    el.classList.toggle('dis', !cl);
  }
  function body(k, c) {
    const luts = api.luts();
    if (k === 'basic') return `<label class="pr"><span>Input LUT</span><select data-lsel="lut"><option value="">None</option>${luts.map((l) => `<option${l === c.lut ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <button class="small" data-lauto>Auto</button>${BASIC.map((d) => row(c, d)).join('')}`;
    if (k === 'creative') return `<label class="pr"><span>Look</span><select data-lsel="look"><option value="">None</option>${luts.map((l) => `<option${l === c.look ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      ${CREATIVE.map((d) => row(c, d) + (d[0] === 'shTint.amt' ? `<label class="pr"><span>Shadow tint colour</span><input type="color" data-lc="shTint.color" value="${c.shTint?.color || '#3b6fd8'}"></label>` : d[0] === 'hiTint.amt' ? `<label class="pr"><span>Highlight tint colour</span><input type="color" data-lc="hiTint.color" value="${c.hiTint?.color || '#ffb15c'}"></label>` : '')).join('')}`;
    if (k === 'curves') return `<p class="muted small">RGB curves and Hue / Saturation curves are drawn in the panel in the middle.</p><div class="btn-grid"><button data-pane="rgb">RGB Curves</button><button data-pane="hue">Hue Saturation Curves</button></div>`;
    if (k === 'wheels') return `<p class="muted small">Lift / Gamma / Gain / Offset wheels are in the middle panel; Shot match is on the left.</p><div class="btn-grid"><button data-pane="wheels">Show wheels</button></div>`;
    if (k === 'hsl') return `<p class="muted small">Pick a colour range, then change only that range (skin, sky, a saffron flag…).</p>
      <div class="btn-grid"><button data-lpick title="Click a colour in the viewer">Pick colour from viewer</button><button data-lhslreset>Reset</button></div>
      <label class="chk"><input type="checkbox" data-lchk="hsl.show"${c.hsl?.show ? ' checked' : ''}> Show the mask (white = changed)</label>
      <div class="lm-sub">Key</div>${HSL_KEY.map((d) => row(c, d)).join('')}<div class="lm-sub">Correction</div>${HSL_FIX.map((d) => row(c, d)).join('')}`;
    if (k === 'vignette') return VIG.map((d) => row(c, d)).join('');
    return '';
  }
  return { render };
}
