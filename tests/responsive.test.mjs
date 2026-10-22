// 📌 ⏱ Responsive Design for graphics: a pinned graphic stays on its edge / corner whatever the frame shape, inside
// title safe, and a stretched animated template keeps its intro and outro (only the middle gets longer).
import { test, assert } from './harness.mjs';
import { pinBox, pinOn, rtimeMap, rtimeOf, rtimeOn, textLayout, newGraphic, gfxKey, SAFE } from '../public/js/graphics.js';

const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const FRAMES = [[1920, 1080], [1080, 1920], [1080, 1080], [1080, 1350]];
const fakeCtx = () => ({ font: '10px x', measureText(s) { return { width: String(s).length * (parseFloat(/(\d+(\.\d+)?)px/.exec(this.font)?.[1]) || 10) * 0.55 }; } });

test('pinned bottom-left sits on the title-safe corner on every frame shape', () => {
  const box = { x: 700, y: 400, w: 500, h: 120 }, g = { tpl: 'lower3', pin: 'bl' };
  for (const [W, H] of FRAMES) {
    const p = pinBox(box, W, H, g);
    assert(near(p.x, W * SAFE) && near(p.y + p.h, H * (1 - SAFE)), `${W}x${H}: at the bottom-left of title safe (${p.x}, ${p.y + p.h})`);
  }
});

test('every pin: margins inward from its edge, centre pins centred', () => {
  const W = 1920, H = 1080, b = { x: 0, y: 0, w: 200, h: 100 }, R = { x: W * SAFE, y: H * SAFE, w: W * 0.8, h: H * 0.8 };
  const at = (pin, mx = 0, my = 0) => pinBox(b, W, H, { tpl: 'text', pin, pinMX: mx, pinMY: my });
  assert(near(at('tl', 5, 5).x, R.x + W * 0.05) && near(at('tl', 5, 5).y, R.y + H * 0.05), 'top-left + margin');
  assert(near(at('tr', 5).x + 200, R.x + R.w - W * 0.05), 'top-right: margin from the right');
  assert(near(at('br', 0, 5).y + 100, R.y + R.h - H * 0.05), 'bottom: margin from the bottom');
  assert(near(at('c').x + 100, W / 2) && near(at('c').y + 50, H / 2), 'centre');
  assert(near(at('t').x + 100, W / 2) && near(at('t').y, R.y), 'top centre');
  assert(near(at('l').y + 50, H / 2) && near(at('r').x + 200, R.x + R.w), 'left / right middle');
});

test('safe area: kept inside title safe (fitted when too big); off = frame edges', () => {
  const W = 1080, H = 1920, big = { x: 0, y: 0, w: 1400, h: 200 };
  const p = pinBox(big, W, H, { tpl: 'lower3', pin: 'bl' });
  assert(near(p.w, W * 0.8) && p.k < 1 && p.x >= W * SAFE - 1e-6 && p.x + p.w <= W * (1 - SAFE) + 1e-6, 'too wide for 9:16: shrunk into title safe');
  const q = pinBox({ x: 0, y: 0, w: 300, h: 100 }, W, H, { tpl: 'lower3', pin: 'bl', pinMX: -30 });
  assert(near(q.x, W * SAFE), 'a margin pushing it out is held at title safe');
  const o = pinBox({ x: 0, y: 0, w: 300, h: 100 }, W, H, { tpl: 'lower3', pin: 'br', pinSafe: false });
  assert(near(o.x + 300, W) && near(o.y + 100, H), 'safe off: on the frame edge');
});

test('scale with frame width keeps the share of the width it was pinned with', () => {
  const g = { tpl: 'text', pin: 'b', pinW: true, pinRef: [1920, 1080] }, b = { x: 0, y: 0, w: 384, h: 80 }; // 20% of 1920
  const p = pinBox(b, 1080, 1920, g);
  assert(near(p.w / 1080, 0.2), `9:16: still 20% of the width (${p.w / 1080})`);
  assert(near(pinBox(b, 1920, 1080, g).k, 1), 'on its own frame: unchanged');
  assert(near(pinBox(b, 1080, 1920, { ...g, pinW: false }).k, 1), 'off: the template keeps its own size');
});

test('pinned Type tool text: its box moves to the edge, hit-test box = drawn box', () => {
  const g = { ...newGraphic('text'), text: 'Hello', size: 80, x: 50, y: 50, pin: 'bl', bg: false };
  for (const [W, H] of FRAMES) {
    const L = textLayout(fakeCtx(), W, H, g);
    assert(near(L.x, W * SAFE, 1e-3) && near(L.y + L.h, H * (1 - SAFE), 1e-3), `${W}x${H}: text block at bottom-left`);
    assert(near(L.cx, L.x + L.w / 2, 1e-3) && near(L.cy, L.y + L.h / 2, 1e-3), 'centre follows the box');
  }
  const un = textLayout(fakeCtx(), 1920, 1080, { ...g, pin: undefined });
  assert(near(un.cx, 960) && near(un.cy, 540), 'not pinned: where it was put');
  const full = { ...newGraphic('kinetic'), pos: 'full', pin: 'bl' };
  assert(!pinOn(full) && pinOn({ ...full, pos: 'center' }), 'a full-screen graphic cannot be pinned');
});

test('responsive time: intro and outro keep their length, only the middle stretches', () => {
  const D0 = 5, I = 1, O = 0.5;
  for (const d of [5, 12, 30]) {
    assert(near(rtimeMap(0.4, d, D0, I, O), 0.4) && near(rtimeMap(I, d, D0, I, O), I), `${d}s: intro as designed`);
    assert(near(rtimeMap(d - 0.3, d, D0, I, O), D0 - 0.3) && near(rtimeMap(d, d, D0, I, O), D0), `${d}s: outro as designed`);
    const m = rtimeMap((I + d - O) / 2, d, D0, I, O);
    assert(near(m, (I + D0 - O) / 2), `${d}s: middle maps to the middle`);
  }
  assert(near(rtimeMap(2.5, 5, D0, I, O), 2.5), 'at its own length nothing changes');
  const s = [0, 0.3, 0.6, 0.9, 1.2].map((t) => rtimeMap(t, 1.2, D0, I, O));
  assert(s.every((v, i) => !i || v >= s[i - 1]) && near(s[4], D0), 'shorter than intro + outro: squeezed, still runs to the end');
  const g = newGraphic('lower3');
  assert(!rtimeOn(g) && rtimeOn({ ...g, rtime: true }) && rtimeOf({ ...g, rtime: true })[2] === 5, 'off unless switched on (old projects); design length = template length');
  assert(!rtimeOn({ ...newGraphic('ticker'), rtime: true }), 'news strip / credits run the whole clip: no intro / outro');
});

test('bake key changes with the pin and the frame, not for unpinned old graphics', () => {
  const g = newGraphic('lower3'), k = gfxKey(g, 1920, 1080, 25, 5);
  assert(k === gfxKey({ ...g, pin: undefined }, 1920, 1080, 25, 5), 'old graphic: same key as before');
  assert(k !== gfxKey({ ...g, pin: 'bl' }, 1920, 1080, 25, 5), 'pin changes the key');
  assert(gfxKey({ ...g, pin: 'bl' }, 1920, 1080, 25, 5) !== gfxKey({ ...g, pin: 'bl' }, 1080, 1920, 25, 5), 'frame size changes the key');
});
