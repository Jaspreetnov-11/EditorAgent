// 👆 Touch (tablet and phone): the timeline and the Program monitor with fingers. Nothing here runs for a mouse.
// - one finger on a clip drags it as the mouse does (the timeline already works with pointer events; mobile.css lets
//   them through with touch-action: none) - held still for a moment, the clip's right-click menu opens instead
// - one finger on empty track space moves the timeline (a tap puts the playhead there and clears the selection)
// - two fingers: apart / together zooms the timeline in time, moving them scrolls it
// - two fingers on the monitor zoom the picture (as the mouse wheel does)
// - a touch the browser takes over (pointercancel) ends a drag as if the finger was lifted, so nothing is left half-dragged
import { S, emit } from './store.js';
import { setZoom } from './timeline.js';
import { pinchZoom } from './phonecore.js';
import { onDevice, deviceNow } from './phone.js';

// (only in the touch layouts - a desktop, even one with a touch screen, works exactly as before)
const touchUI = () => document.documentElement.classList.contains('touch');
const isTouch = (e) => (e.pointerType === 'touch' || e.pointerType === 'pen') && touchUI();
// (the events made here are not fingers: the finger bookkeeping below leaves them alone)
let synth = false;
const fire = (target, ev) => { synth = true; try { target.dispatchEvent(ev); } finally { synth = false; } };
const fake = (type, at, src) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, pointerId: src?.pointerId ?? 1, pointerType: src?.pointerType || 'touch', isPrimary: true, button: 0, buttons: 0 });

// ⛑ the browser took the touch (a scroll, a system gesture): what was being dragged is let go where it was
addEventListener('pointercancel', (e) => {
  if (!isTouch(e) || synth) return;
  fire(e.target instanceof Element ? e.target : window, fake('pointerup', { x: e.clientX, y: e.clientY }, e));
}, true);

// the parts of the timeline a finger may grab (everything else is empty space: it moves the timeline)
const GRAB = '.clip, .tr-box, .tl-ruler, #tlPlayhead, button, input, select, textarea, [data-fade], [data-trdur], .kf, .tl-kf, .tl-marquee';
const fingers = new Map(); // pointerId -> { x, y } (on the timeline)
let two = null, pan = null, hold = null, ctxAt = 0;

function scroller() { return document.getElementById('tlScroll'); }

addEventListener('pointerdown', (e) => {
  if (!isTouch(e) || synth) return;
  const sc = e.target instanceof Element && e.target.closest('#tlScroll');
  if (!sc) return;
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (fingers.size === 2) {
    // the second finger: whatever the first one started is let go where it began, and the two fingers zoom / scroll
    e.stopPropagation(); e.preventDefault();
    clearHold();
    const [a, b] = [...fingers.values()];
    if (pan) pan = null; else fire(window, fake('pointerup', a, e));
    two = { d: Math.hypot(a.x - b.x, a.y - b.y), z: S.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    return;
  }
  if (fingers.size > 2) { e.stopPropagation(); return; }
  if (S.tool !== 'select' || e.target.closest(GRAB)) {
    // ✋ a clip held still: its menu (iPad Safari has no long-press menu of its own; Android's is caught below)
    const el = e.target.closest('.clip');
    if (el) hold = { t: setTimeout(() => openMenu(el, e), 550), x: e.clientX, y: e.clientY };
    return;
  }
  e.stopPropagation(); e.preventDefault();
  pan = { x: e.clientX, y: e.clientY, l: sc.scrollLeft, t: sc.scrollTop, moved: false };
}, true);

addEventListener('pointermove', (e) => {
  if (!isTouch(e) || synth || !fingers.has(e.pointerId)) return;
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) clearHold();
  const sc = scroller(); if (!sc) return;
  if (two && fingers.size >= 2) {
    e.stopPropagation();
    const [a, b] = [...fingers.values()], cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const z = pinchZoom(two.z, two.d, Math.hypot(a.x - b.x, a.y - b.y), 0.5, 2000);
    if (Math.abs(z - S.zoom) / S.zoom > 0.01) setZoom(z, false, cx);
    sc.scrollLeft -= cx - two.cx; sc.scrollTop -= cy - two.cy;
    two.cx = cx; two.cy = cy;
    return;
  }
  if (pan) {
    e.stopPropagation();
    if (!pan.moved && Math.hypot(e.clientX - pan.x, e.clientY - pan.y) < 8) return;
    pan.moved = true;
    sc.scrollLeft = pan.l - (e.clientX - pan.x); sc.scrollTop = pan.t - (e.clientY - pan.y);
  }
}, true);

function lift(e) {
  if (!isTouch(e) || synth || !fingers.has(e.pointerId)) return;
  fingers.delete(e.pointerId);
  clearHold();
  if (two) { e.stopPropagation(); if (!fingers.size) two = null; return; }
  if (pan) {
    e.stopPropagation();
    const sc = scroller(), p = pan; pan = null;
    if (!p.moved && sc) { // a tap on empty space: the playhead goes there, the selection is cleared
      const t = Math.max(0, (e.clientX - sc.getBoundingClientRect().left + sc.scrollLeft) / S.zoom);
      S.sel.clear(); emit('select'); emit('seek', t);
    }
  }
}
addEventListener('pointerup', lift, true);
addEventListener('pointercancel', lift, true);

function clearHold() { if (hold) { clearTimeout(hold.t); hold = null; } }
function openMenu(el, e) {
  hold = null;
  if (Date.now() - ctxAt < 1000) return; // (the browser opened it already)
  fire(window, fake('pointerup', { x: e.clientX, y: e.clientY }, e)); // (the drag it started ends where it began)
  ctxAt = Date.now();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 2 }));
}
// Android opens its own long-press menu event too: only one menu
addEventListener('contextmenu', (e) => {
  if (!e.isTrusted || !(e.target instanceof Element) || !e.target.closest('#tlScroll') || !touchUI()) return;
  if (Date.now() - ctxAt < 1000) { e.preventDefault(); e.stopPropagation(); return; }
  ctxAt = Date.now(); clearHold();
}, true);

// ---- 🔍 the Program monitor: two fingers zoom the picture (the same steps as the mouse wheel) ----
let mon = null, armed = false;
const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
// (put on only once a touch layout shows: a desktop page keeps no blocking touch listener)
const arm = (m) => { if (m === 'desktop' || armed) return; armed = true; monitorPinch(); };
onDevice(arm); arm(deviceNow());
function monitorPinch() {
  addEventListener('touchstart', (e) => {
    const st = touchUI() && e.target instanceof Element && e.target.closest('#vwStage');
    if (st && e.touches.length === 2) mon = { st, d: dist(e.touches), sx: st.scrollLeft, sy: st.scrollTop, cx: (e.touches[0].clientX + e.touches[1].clientX) / 2, cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
  }, { passive: true, capture: true });
  addEventListener('touchmove', (e) => {
    if (!mon || e.touches.length !== 2) return;
    e.preventDefault();
    const d = dist(e.touches), cx = (e.touches[0].clientX + e.touches[1].clientX) / 2, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    // one wheel step is 15%: a step for each 15% the fingers opened / closed
    const r = d / mon.d;
    if (r > 1.15 || r < 1 / 1.15) { mon.st.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: r > 1 ? -100 : 100, clientX: cx, clientY: cy })); mon.d = d; }
    mon.st.scrollLeft -= cx - mon.cx; mon.st.scrollTop -= cy - mon.cy; mon.cx = cx; mon.cy = cy;
  }, { passive: false, capture: true });
  addEventListener('touchend', (e) => { if (e.touches.length < 2) mon = null; }, { capture: true });
}
