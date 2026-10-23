// 📏 Monitor rulers, like Premiere's View > Show Rulers: a ruler along the top and the left of the Program / Source
// monitor, in the frame's own pixels (0-1080 across a 1080x1920 frame), lined up with the picture as it is drawn (Fit,
// zoom, scroll). The stage makes room for them, so they never cover the picture. Drag a guide out of a ruler (top ruler:
// a horizontal guide, left: a vertical one), drag it back onto a ruler to remove it; right-click a ruler: clear guides.
// On / off and the guides are kept per monitor in this browser (localStorage).
export const RULER = 16; // px, the ruler's thickness
const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];

// the marks along one ruler. o: screen px (from the ruler's start) where frame pixel 0 sits; k: screen px per frame
// pixel; len: the ruler's length in px. -> [{ pos, v, kind: 'major' | 'mid' | 'minor', label? }]
export function rulerTicks(o, k, len, minGap = 6, labelGap = 50) {
  if (!(k > 0) || !(len > 0) || !Number.isFinite(o)) return [];
  const minor = STEPS.find((s) => s * k >= minGap) ?? STEPS.at(-1);
  const major = STEPS.find((s) => s * k >= labelGap && s % minor === 0) ?? minor * 10;
  const mid = major / 2 % minor === 0 && major / 2 > minor ? major / 2 : 0;
  const out = [];
  for (let i = Math.ceil(-o / k / minor), n = 0; n < 3000; i++, n++) {
    const v = i * minor, pos = o + v * k;
    if (pos > len) break;
    const kind = v % major === 0 ? 'major' : mid && v % mid === 0 ? 'mid' : 'minor';
    out.push(kind === 'major' ? { pos, v, kind, label: String(v) } : { pos, v, kind });
  }
  return out;
}

// a screen point on the picture -> frame pixels (rounded), for a guide dragged there
export const toFramePx = (client, edge, k) => Math.round((client - edge) / k);

const load = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// host: the panel (rulers are placed in it, over the stage's padding); stage: the scrolling area the frame sits in;
// frame: the picture; size(): the frame's [w, h] in pixels, or null (nothing open); onToggle(): re-fit the picture
export function monitorRulers({ key, host, stage, frame, size, onToggle }) {
  let on = !!load(`ve-rulers-${key}`, false), guides = load(`ve-rguides-${key}`, []), mouse = null, raf = 0, dragging = false;
  if (!Array.isArray(guides)) guides = [];
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const mk = (tag, cls) => { const e = document.createElement(tag); e.className = cls; host.appendChild(e); return e; };
  const H = mk('canvas', 'mruler mr-h'), V = mk('canvas', 'mruler mr-v'), C = mk('div', 'mruler mr-corner');
  H.title = 'Ruler (frame pixels) - drag down onto the picture for a guide; right-click: clear guides';
  V.title = 'Ruler (frame pixels) - drag right onto the picture for a guide; right-click: clear guides';
  const gl = document.createElement('div'); gl.className = 'lyr mr-guides'; frame.appendChild(gl);

  function geom() {
    const sz = size(), sr = stage.getBoundingClientRect(), fr = frame.getBoundingClientRect();
    if (!sz || !sr.width || !fr.width) return null;
    return { sr, fr, kx: fr.width / sz[0], ky: fr.height / sz[1], w: sz[0], h: sz[1] };
  }
  function place() {
    const show = on && stage.offsetParent !== null;
    for (const e of [H, V, C]) e.hidden = !show;
    gl.hidden = !on;
    if (!show) return false;
    const sr = stage.getBoundingClientRect(), hr = host.getBoundingClientRect(), x = sr.left - hr.left + host.scrollLeft, y = sr.top - hr.top + host.scrollTop;
    Object.assign(H.style, { left: `${x + RULER}px`, top: `${y}px`, width: `${Math.max(0, sr.width - RULER)}px`, height: `${RULER}px` });
    Object.assign(V.style, { left: `${x}px`, top: `${y + RULER}px`, width: `${RULER}px`, height: `${Math.max(0, sr.height - RULER)}px` });
    Object.assign(C.style, { left: `${x}px`, top: `${y}px`, width: `${RULER}px`, height: `${RULER}px` });
    return true;
  }
  function paint(cv, horiz, g) {
    const dpr = window.devicePixelRatio || 1, cw = cv.clientWidth, ch = cv.clientHeight;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
    const c = cv.getContext('2d'); if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, cw, ch);
    const cs = getComputedStyle(cv), len = horiz ? cw : ch;
    if (!g) return;
    const start = horiz ? g.sr.left + RULER : g.sr.top + RULER, o = (horiz ? g.fr.left : g.fr.top) - start, k = horiz ? g.kx : g.ky, n = horiz ? g.w : g.h;
    // the frame's own extent, a little lighter
    c.fillStyle = cs.getPropertyValue('--mr-frame') || '#ffffff10';
    const a = Math.max(0, o), b = Math.min(len, o + n * k);
    if (b > a) horiz ? c.fillRect(a, 0, b - a, ch) : c.fillRect(0, a, cw, b - a);
    c.strokeStyle = cs.color; c.fillStyle = cs.color; c.lineWidth = 1; c.font = '9px system-ui, sans-serif'; c.textBaseline = 'top';
    c.beginPath();
    for (const t of rulerTicks(o, k, len)) {
      const p = Math.round(t.pos) + 0.5, l = t.kind === 'major' ? RULER : t.kind === 'mid' ? RULER * 0.5 : RULER * 0.3;
      if (horiz) { c.moveTo(p, ch); c.lineTo(p, ch - l); } else { c.moveTo(cw, p); c.lineTo(cw - l, p); }
      if (t.label) {
        if (horiz) c.fillText(t.label, p + 2, 1);
        else { c.save(); c.translate(1, p - 2); c.rotate(-Math.PI / 2); c.fillText(t.label, 0, 0); c.restore(); }
      }
    }
    c.stroke();
    // where the mouse is (like Premiere's ruler cursor)
    if (mouse) {
      const p = Math.round((horiz ? mouse.x : mouse.y) - start) + 0.5;
      if (p >= 0 && p <= len) { c.strokeStyle = cs.getPropertyValue('--mr-cursor') || '#e8b04a'; c.beginPath(); horiz ? (c.moveTo(p, 0), c.lineTo(p, ch)) : (c.moveTo(0, p), c.lineTo(cw, p)); c.stroke(); }
    }
  }
  function drawGuides(g) {
    const want = g ? guides : [];
    gl.innerHTML = want.map((x, i) => `<i class="mr-g ${x.d}" data-g="${i}" style="${x.d === 'h' ? 'top' : 'left'}:${(x.v / (x.d === 'h' ? g.h : g.w)) * 100}%" title="${x.d === 'h' ? 'y' : 'x'} ${x.v} px - drag to move, onto a ruler to remove"></i>`).join('');
  }
  function draw() {
    cancelAnimationFrame(raf); raf = 0;
    if (!place()) { drawGuides(null); return; }
    const g = geom();
    paint(H, true, g); paint(V, false, g);
    if (!dragging) drawGuides(g);
  }
  const later = () => { if (!raf) raf = requestAnimationFrame(draw); };

  // drag a guide: out of a ruler (new) or an existing one; dropped on a ruler (or off the picture past it) = removed
  function dragGuide(e, d, idx) {
    e.preventDefault(); e.stopPropagation();
    const g0 = geom(); if (!g0) return;
    if (idx < 0) { guides.push({ d, v: 0 }); idx = guides.length - 1; }
    dragging = true; drawGuides(g0);
    const line = gl.querySelector(`[data-g="${idx}"]`);
    const move = (ev) => {
      const g = geom(); if (!g) return;
      const v = d === 'h' ? toFramePx(ev.clientY, g.fr.top, g.ky) : toFramePx(ev.clientX, g.fr.left, g.kx);
      guides[idx].v = v; mouse = { x: ev.clientX, y: ev.clientY };
      if (line) { line.style[d === 'h' ? 'top' : 'left'] = `${(v / (d === 'h' ? g.h : g.w)) * 100}%`; line.title = `${d === 'h' ? 'y' : 'x'} ${v} px`; }
      line?.classList.toggle('gone', d === 'h' ? ev.clientY < g.sr.top + RULER : ev.clientX < g.sr.left + RULER);
      later();
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      const g = geom();
      if (!g || (d === 'h' ? ev.clientY < g.sr.top + RULER : ev.clientX < g.sr.left + RULER)) guides.splice(idx, 1);
      dragging = false; save(`ve-rguides-${key}`, guides); draw();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    move(e);
  }
  H.addEventListener('pointerdown', (e) => { if (e.button === 0) dragGuide(e, 'h', -1); });
  V.addEventListener('pointerdown', (e) => { if (e.button === 0) dragGuide(e, 'v', -1); });
  gl.addEventListener('pointerdown', (e) => { const l = e.target.closest('[data-g]'); if (l && e.button === 0) dragGuide(e, l.classList.contains('h') ? 'h' : 'v', +l.dataset.g); });
  for (const cv of [H, V, C]) cv.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!guides.length) return;
    guides = []; save(`ve-rguides-${key}`, guides); draw();
    import('./ui.js').then((x) => x.toast('Guides cleared')).catch(() => {});
  });

  stage.addEventListener('pointermove', (e) => { if (on) { mouse = { x: e.clientX, y: e.clientY }; later(); } });
  stage.addEventListener('pointerleave', () => { if (on && !dragging) { mouse = null; later(); } });
  stage.addEventListener('scroll', later);
  window.addEventListener('resize', later);
  const ro = new ResizeObserver(later); ro.observe(stage); ro.observe(frame); ro.observe(host);

  function set(v) {
    on = !!v; save(`ve-rulers-${key}`, on);
    stage.classList.toggle('mr-on', on);
    onToggle?.(); draw();
  }
  stage.classList.toggle('mr-on', on);
  draw();
  return { on: () => on, pad: () => (on ? RULER : 0), set, toggle: () => set(!on), draw: later, busy: () => dragging };
}
