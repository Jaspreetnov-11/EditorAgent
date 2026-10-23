// 🎚 The bottom of a monitor laid out like Premiere's (Program and Source): a time ruler that can be zoomed into, the
// zoom / scroll bar under it (drag a round end to zoom, the middle to scroll, double-click = the whole clip), and the
// wrench's small settings menu. The look stays Limelight's; only the layout follows Premiere.

// marks along a time ruler showing [a, b] (shares of the duration d) over w px. -> [{ t, major }]
const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
export function timeTicks(d, a, b, w, fps = 30, minGap = 7, labelGap = 90) {
  if (!(d > 0) || !(w > 0) || !(b > a)) return [];
  const span = d * (b - a), pps = w / span, f = 1 / (fps || 30);
  const all = [f, 2 * f, 5 * f, 10 * f, ...STEPS];
  const minor = all.find((s) => s * pps >= minGap) ?? all.at(-1);
  const major = all.find((s) => s * pps >= labelGap && Math.abs(s / minor - Math.round(s / minor)) < 1e-6) ?? minor * 10;
  const t0 = d * a, t1 = d * b, out = [];
  for (let i = Math.ceil(t0 / minor - 1e-9), n = 0; n < 2000; i++, n++) {
    const t = +(i * minor).toFixed(6);
    if (t > t1 + 1e-9 || t > d + 1e-9) break;
    out.push({ t, major: Math.abs(t / major - Math.round(t / major)) < 1e-6 });
  }
  return out;
}
// a share of the duration -> left % in a ruler showing [a, b], and back
export const toView = (x, a, b) => ((x - a) / (b - a)) * 100;
export const fromView = (u, a, b) => a + u * (b - a);
// the visible part after dragging: which = 'l' | 'r' | 'mid', du = how far (share of the bar), keeps at least min wide
export function dragView([a, b], which, du, min = 0.01) {
  if (which === 'mid') { const w = b - a, na = Math.max(0, Math.min(1 - w, a + du)); return [na, na + w]; }
  if (which === 'l') return [Math.max(0, Math.min(b - min, a + du)), b];
  return [a, Math.min(1, Math.max(a + min, b + du))];
}

// the zoom / scroll bar: host gets a track with a thumb and two round handles; onChange([a, b]) on every move
export function zoomBar(host, onChange) {
  let v = [0, 1];
  host.classList.add('mz-bar');
  host.innerHTML = '<div class="mz-thumb"><i class="mz-h l"></i><i class="mz-h r"></i></div>';
  host.title = 'Zoom the time ruler: drag a round end in or out, drag the middle to move; double-click: the whole clip';
  const th = host.firstElementChild;
  const draw = () => { th.style.left = `${v[0] * 100}%`; th.style.width = `${(v[1] - v[0]) * 100}%`; host.classList.toggle('mz-zoomed', v[1] - v[0] < 0.999); };
  host.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const b = host.getBoundingClientRect(), h = e.target.closest('.mz-h'), which = h ? (h.classList.contains('l') ? 'l' : 'r') : 'mid';
    let v0 = v, x0 = e.clientX;
    // a click on the bare track: the thumb jumps there (centred)
    if (!h && !e.target.closest('.mz-thumb')) { const w = v[1] - v[0], c = (e.clientX - b.left) / b.width; v0 = dragView(v, 'mid', c - (v[0] + w / 2)); set(v0); }
    try { host.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => set(dragView(v0, which, (ev.clientX - x0) / b.width));
    const up = () => { host.removeEventListener('pointermove', move); host.removeEventListener('pointerup', up); };
    host.addEventListener('pointermove', move); host.addEventListener('pointerup', up);
  });
  host.addEventListener('dblclick', () => set([0, 1]));
  function set(nv) { v = [Math.max(0, nv[0]), Math.min(1, nv[1])]; draw(); onChange?.(v); }
  draw();
  return { get: () => v, set, reset: () => set([0, 1]) };
}

// the wrench's menu: items [{ label, on?: bool, act() } | '-'], placed under the button
export function wrenchMenu(btn, items) {
  document.querySelector('.mz-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'mz-menu';
  m.innerHTML = items.map((x, i) => (x === '-' ? '<hr>' : `<button data-i="${i}" class="${x.on ? 'on' : ''}"><span class="mz-chk">${x.on ? '✓' : ''}</span>${x.label}</button>`)).join('');
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = `${Math.max(4, Math.min(innerWidth - mw - 4, r.right - mw))}px`;
  m.style.top = `${r.bottom + mh + 4 > innerHeight ? Math.max(4, r.top - mh - 4) : r.bottom + 4}px`;
  const close = (e) => { if (e && m.contains(e.target)) return; m.remove(); document.removeEventListener('pointerdown', close, true); };
  m.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (!b) return; close(); items[+b.dataset.i].act(); });
  setTimeout(() => document.addEventListener('pointerdown', close, true));
}

// line icons for the monitors' buttons that lineicons.js has no match for (stroke = text colour)
const MI = {
  marker: '<path d="M4.5 2.5h7v8.5L8 13.5 4.5 11z"/>',
  in: '<path d="M6 3H4v10h2"/><path d="M9 8h4"/>', out: '<path d="M10 3h2v10h-2"/><path d="M3 8h4"/>',
  goin: '<path d="M4 3v10"/><path d="M12 4 7 8l5 4"/>', goout: '<path d="M12 3v10"/><path d="M4 4l5 4-5 4"/>',
  lift: '<path d="M2 13h3.5M10.5 13h3.5"/><path d="M8 11V3"/><path d="M5.5 5.5 8 3l2.5 2.5"/>',
  extract: '<path d="M2 13h12"/><path d="M8 10V3"/><path d="M5.5 5.5 8 3l2.5 2.5"/>',
  wrench: '<path d="M10.5 2.5a3 3 0 0 0-3.2 4L2.8 11a1.3 1.3 0 0 0 1.9 1.9l4.5-4.5a3 3 0 0 0 4-3.2l-1.8 1.8-1.7-.4-.4-1.7z"/>',
};
export const monIco = (k) => `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MI[k]}</svg>`;
