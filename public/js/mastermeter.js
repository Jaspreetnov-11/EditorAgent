// 🎚 Audio Meters at the right of the timeline, like Premiere's: the master's left and right level while it plays
// (player.js masterLevels - after every track fader, what the speakers get), a peak-hold line on each bar that waits
// 1.5 s and then falls, a red light at the top when the sound reaches 0 dB (click it to reset) and the dB scale.
import { masterLevels } from './player.js';

const FLOOR = -60, TICKS = [0, -6, -12, -18, -24, -30, -36, -42, -48, -54], HOLD = 1500;
const y01 = (db) => Math.max(0, Math.min(1, (db - FLOOR) / -FLOOR)); // 0 at -60 dB, 1 at 0 dB
// the level shown falls back smoothly (rises at once) and the peak line holds, like a ballistic meter
export function meterStep(st, db, now, dtMs) {
  st.lvl = db >= st.lvl ? db : Math.max(db, st.lvl - (dtMs / 1000) * 24); // 24 dB a second down
  if (db >= st.pk || now - st.pkAt > HOLD) { if (db >= st.pk) { st.pk = db; st.pkAt = now; } else st.pk = Math.max(db, st.pk - (dtMs / 1000) * 18); }
  if (db >= -0.1) st.clip = true;
  return st;
}
const fresh = () => ({ lvl: FLOOR, pk: FLOOR, pkAt: 0, clip: false });

export function mountMasterMeter(host) {
  const el = document.createElement('div');
  el.className = 'tl-meter'; el.title = 'Audio Meters: the whole mix, left and right (dB). The red lights show it reached 0 dB - click them to reset';
  el.innerHTML = '<canvas aria-label="Master audio meter"></canvas>';
  host.append(el);
  const cv = el.querySelector('canvas'), ch = [fresh(), fresh()];
  let last = performance.now(), quietSince = 0;
  cv.addEventListener('click', (e) => { if (e.offsetY < 16) { ch.forEach((c) => { c.clip = false; }); draw(); } });
  function draw() {
    const dpr = devicePixelRatio || 1, W = el.clientWidth, H = el.clientHeight; if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#121110'; g.fillRect(0, 0, W, H);
    const top = 16, bot = H - 14, h = bot - top, bw = Math.max(5, Math.min(10, (W - 26) / 2 - 2)), x0 = W - 4 - bw * 2 - 3;
    const yOf = (db) => bot - y01(db) * h;
    // the dB scale
    g.font = '9px Segoe UI, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const t of TICKS) { const y = Math.round(yOf(t)) + 0.5; g.fillStyle = '#6f6a62'; g.fillText(String(t), x0 - 4, y); g.fillStyle = '#2a2724'; g.fillRect(x0 - 2, y, bw * 2 + 5, 1); }
    g.textAlign = 'center'; g.fillStyle = '#6f6a62'; g.fillText('dB', x0 - 10, H - 6);
    ch.forEach((c, i) => {
      const x = x0 + i * (bw + 3);
      g.fillStyle = '#1d1b19'; g.fillRect(x, top, bw, h);
      // green to -18, yellow to -6, red above (Premiere's colours)
      const lv = yOf(c.lvl);
      for (const [a, b, col] of [[FLOOR, -18, '#2fbf5b'], [-18, -6, '#e6c229'], [-6, 0, '#e5483b']]) {
        const ya = yOf(a), yb = yOf(b), y = Math.max(lv, yb);
        if (y < ya) { g.fillStyle = col; g.fillRect(x, y, bw, ya - y); }
      }
      if (c.pk > FLOOR + 0.5) { g.fillStyle = c.pk > -6 ? '#ff6b5e' : c.pk > -18 ? '#ffe066' : '#7dffa4'; g.fillRect(x, Math.round(yOf(c.pk)) - 1, bw, 2); }
      g.fillStyle = c.clip ? '#ff3b30' : '#3a2a28'; g.fillRect(x, 3, bw, 8); // (the clip light)
      g.fillStyle = '#6f6a62'; g.fillText(i ? 'R' : 'L', x + bw / 2, H - 6);
    });
  }
  function tick(now) {
    const dt = Math.min(100, now - last); last = now;
    const L = masterLevels();
    const lv = L || [{ peak: FLOOR }, { peak: FLOOR }];
    lv.forEach((m, i) => meterStep(ch[i], Math.max(FLOOR, m.peak), now, dt));
    draw();
    // silent and settled: stop drawing until there is sound again (checked a few times a second)
    const settled = ch.every((c) => c.lvl <= FLOOR + 0.1 && c.pk <= FLOOR + 0.1);
    if (settled) { quietSince ||= now; } else quietSince = 0;
    if (quietSince && now - quietSince > 500) { setTimeout(() => requestAnimationFrame(tick), 250); return; }
    requestAnimationFrame(tick);
  }
  new ResizeObserver(draw).observe(el);
  requestAnimationFrame(tick);
  return el;
}
