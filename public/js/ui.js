// Small DOM helpers, toasts, dialogs and a data-bound form builder shared by every panel.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const fmtSize = (b) => (b > 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${(b / (1 << 20)).toFixed(1)} MB`);

let toastTimer;
export function toast(msg, kind = '') {
  let t = $('#toast');
  if (!t) { t = h('<div id="toast" class="toast" role="status" aria-live="polite"></div>'); document.body.append(t); }
  t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), kind === 'err' ? 6000 : 2600);
}

// Modal dialog. Returns { el, close }. Buttons with data-close close it; onAction(value) gets data-action values.
export function modal(title, body, { width = 560, onAction, onClose } = {}) {
  const d = h(`<dialog class="dlg" style="width:min(${width}px, calc(100vw - 32px))">
    <div class="dlg-head"><h3>${title}</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="dlg-body"></div></dialog>`);
  const b = $('.dlg-body', d);
  if (typeof body === 'string') b.innerHTML = body; else b.append(body);
  document.body.append(d);
  const close = () => { d.close(); };
  d.addEventListener('close', () => { onClose?.(); d.remove(); });
  d.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
    const a = e.target.closest('[data-action]');
    if (a) onAction?.(a.dataset.action, a);
  });
  d.showModal();
  return { el: d, close };
}

// ---- data-bound fields ----
export const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
export function setPath(o, p, v) {
  const ks = p.split('.'), last = ks.pop();
  const t = ks.reduce((a, k) => (a[k] ??= {}), o);
  if (v === undefined) delete t[last]; else t[last] = v;
}

// def: { k, label, type: range|num|text|area|select|check|color|time, min, max, step, options, def, unit, hint, fmt }
export function fieldsHTML(defs, obj) {
  return defs.map((d) => {
    if (d.type === 'section') return `<div class="sect">${esc(d.label)}</div>`;
    if (d.type === 'html') return d.html;
    const v = getPath(obj, d.k), a = `data-k="${d.k}" data-type="${d.type}"`;
    const val = v ?? d.def;
    let input;
    switch (d.type) {
      case 'range': input = `<div class="rng"><input type="range" ${a} min="${d.min}" max="${d.max}" step="${d.step}" value="${val}">
        <input class="rng-num" type="number" data-mirror="${d.k}" min="${d.min}" max="${d.max}" step="${d.step}" value="${+(+val).toFixed(3)}">
        <button class="icon-btn reset" data-reset="${d.k}" data-def="${d.def}" title="Reset">${ic('reset')}</button></div>`; break;
      case 'select': input = `<select ${a}>${d.options.map(([ov, ol]) => `<option value="${esc(ov)}"${String(val ?? '') === String(ov) ? ' selected' : ''}>${esc(ol)}</option>`).join('')}</select>`; break;
      case 'check': return `<label class="chk"><input type="checkbox" ${a}${val ? ' checked' : ''}> ${esc(d.label)}</label>`;
      case 'area': input = `<textarea ${a} rows="${d.rows || 2}" placeholder="${esc(d.ph || '')}">${esc(val ?? '')}</textarea>`; break;
      case 'color': input = `<input type="color" list="brandSw" ${a} value="${esc(val || '#000000')}">`; break;
      case 'time': input = `<input ${a} value="${esc(d.fmt ? d.fmt(val) : val ?? '')}" placeholder="${esc(d.ph || '')}">`; break;
      case 'num': input = `<input type="number" ${a} step="${d.step ?? 'any'}" min="${d.min ?? ''}" max="${d.max ?? ''}" value="${val ?? ''}" placeholder="${esc(d.ph || '')}">`; break;
      default: input = `<input ${a} value="${esc(val ?? '')}" placeholder="${esc(d.ph || '')}">`;
    }
    return `<label class="fld${d.wide ? ' wide' : ''}"><span>${esc(d.label)}${d.unit ? ` <i>${esc(d.unit)}</i>` : ''}</span>${input}${d.hint ? `<small>${d.hint}</small>` : ''}</label>`;
  }).join('');
}

// live(k, v) on every input (no history); commit(k, v) once the user lets go / leaves the field.
export function bindFields(root, getObj, { live, commit, parse = {} } = {}) {
  const read = (el) => {
    const t = el.dataset.type;
    if (t === 'check') return el.checked;
    if (t === 'range' || t === 'num') return el.value === '' ? undefined : +el.value;
    if (t === 'select') return el.value === '' ? undefined : /^-?\d+(\.\d+)?$/.test(el.value) ? +el.value : el.value === 'true' ? true : el.value === 'false' ? false : el.value;
    if (parse[el.dataset.k]) return parse[el.dataset.k](el.value);
    return el.value === '' ? undefined : el.value;
  };
  const apply = (k, v, final) => {
    const obj = getObj(); if (!obj) return;
    setPath(obj, k, v);
    live?.(k, v);
    if (final) commit?.(k, v);
  };
  $$('[data-k]', root).forEach((el) => {
    const t = el.dataset.type;
    const evLive = t === 'range' ? 'input' : null;
    if (evLive) el.addEventListener('input', () => {
      const m = $(`[data-mirror="${el.dataset.k}"]`, root); if (m) m.value = +(+el.value).toFixed(3);
      apply(el.dataset.k, read(el), false);
    });
    el.addEventListener('change', () => apply(el.dataset.k, read(el), true));
    if (t === 'text' || t === 'area' || t === undefined) el.addEventListener('input', () => apply(el.dataset.k, read(el), false));
  });
  $$('[data-mirror]', root).forEach((m) => m.addEventListener('change', () => {
    const r = $(`[data-k="${m.dataset.mirror}"]`, root); r.value = m.value; apply(m.dataset.mirror, +m.value, true);
  }));
  $$('[data-reset]', root).forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    const k = b.dataset.reset, d = +b.dataset.def, r = $(`[data-k="${k}"]`, root), m = $(`[data-mirror="${k}"]`, root);
    if (r) r.value = d; if (m) m.value = d;
    apply(k, d, true);
  }));
}

// Progress clock for long jobs: "1:20 done · about 1:40 left". Call tick(percent) on every update.
// The time left comes from the recent speed (smoothed), so it settles after the first few percent.
// started = when the job really began (ms), so a page opened halfway through still shows the true times.
export function progressClock(started = Date.now()) {
  const t0 = started;
  let rate = null, lastP = null, lastT = Date.now();
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return {
    tick(p) {
      const now = Date.now(), el = (now - t0) / 1000;
      if (lastP === null) { lastP = p; lastT = now; } // first look: the speed so far is p / elapsed
      else if (p > lastP && now - lastT > 800) {
        const r = (p - lastP) / ((now - lastT) / 1000); // percent per second, recently
        rate = rate === null ? r : rate * 0.7 + r * 0.3;
        lastP = p; lastT = now;
      }
      const overall = p > 0 ? p / Math.max(1, el) : 0, sp = rate === null ? overall : rate * 0.3 + overall * 0.7; // mostly the average speed, a little of the recent one
      const left = p >= 100 ? 0 : p >= 3 && el >= 4 && sp > 0 ? (100 - p) / sp : null;
      return { elapsed: mmss(el), left: left === null ? null : mmss(Math.max(1, left)), text: `${mmss(el)} done${left === null ? ' · estimating time left…' : ` · about ${mmss(Math.max(1, left))} left`}` };
    },
  };
}import { ic } from './lineicons.js';

