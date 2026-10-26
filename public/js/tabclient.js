// 🗂 Project tabs: this editor is one tab of the tab strip (tabs.js, the page around it - one editor per open project,
// like Explorer's tabs). A tab that is not shown sleeps: it looks "hidden" to the editor (so the 🔴 live stream lets go
// of its connection and the player / presence act as in a background browser tab), the playback and the open page's
// loops stop, and it comes back exactly as it was. Before its tab closes it saves. Outside a tab nothing here runs.
import { S, on, emit, saveNow, disconnectLive } from './store.js';
import { pause, viewerMode } from './player.js';
import { hideDeliver, showDeliver } from './deliver.js';
import { hideColor } from './colorpage.js';
import { hideAudio, showAudio } from './audiopage.js';
import { hideAI } from './aipage.js';
import { hidePresets } from './presetspage.js';
import { hideText, showText } from './textedit.js';
import { hideMotion } from './motionpage.js';
import { hideFusion } from './fusionpage.js';

const TAB = new URLSearchParams(location.search).get('tab');
const host = (() => { try { return TAB && window.parent !== window ? window.parent.veTabs || null : null; } catch { return null; } })();
export const inTab = !!host;

// what leaving / coming back to a page does (only what the page's own loops need: the rest stays as it was)
const HIDE = { deliver: hideDeliver, color: hideColor, audio: hideAudio, ai: hideAI, presets: hidePresets, text: hideText, motion: hideMotion, fusion: hideFusion };
const SHOW = { deliver: showDeliver, audio: showAudio, text: showText };

// 🔑 another tab has this project open already: the tab strip shows that one instead (false = do not open it here)
export const tabClaim = (name) => !host || host.claim(TAB, name) !== false;

if (host) {
  let asleep = !host.isActive(TAB);
  const real = (k) => Object.getOwnPropertyDescriptor(Document.prototype, k).get.call(document);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => asleep || real('hidden') });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (asleep ? 'hidden' : real('visibilityState')) });
  const run = (fn) => { try { fn?.(); } catch (e) { console.warn('tab:', e); } };

  // 🔌 every <video> / <audio> given a file here - in the page or not (the player's sound of each clip is an Audio of its
  // own) - so a sleeping tab can let go of their downloads. The editor's server speaks HTTP/1.1, and the browser keeps
  // only 6 connections to it for ALL its tabs: a paused, half-loaded clip holds one, so 3-4 sleeping tabs used to take
  // them all and the tab in front waited for its preview, thumbnails and saves. A sleeping tab also gives back its video
  // decoders. Waking up, every element gets its file back at the same moment.
  const seen = new WeakSet(), refs = [];
  const srcProp = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, enumerable: srcProp.enumerable, get: srcProp.get,
    set(v) { if (!seen.has(this)) { seen.add(this); refs.push(new WeakRef(this)); } srcProp.set.call(this, v); } });
  let parked = [];
  function park() {
    const all = new Set(document.querySelectorAll('video, audio'));
    for (let i = refs.length - 1; i >= 0; i--) { const el = refs[i].deref(); if (el) all.add(el); else refs.splice(i, 1); }
    for (const el of all) {
      const src = el.getAttribute('src');
      run(() => el.pause());
      if (!src) continue;
      parked.push({ el, src, t: el.currentTime });
      run(() => { el.removeAttribute('src'); el.load(); }); // (aborts the download, frees the decoder)
    }
  }
  function unpark() {
    for (const { el, src, t } of parked) {
      if (el.getAttribute('src')) continue; // (the editor gave it another file meanwhile)
      if (t) el.addEventListener('loadedmetadata', () => { if (!el.currentTime) run(() => { el.currentTime = t; }); }, { once: true });
      run(() => el.setAttribute('src', src));
    }
    parked = [];
  }

  // ⏸ animation frames wait while asleep (like a browser tab in the background): every loop - meters, monitors, the
  // timeline - stops where it is and goes on when the tab is shown
  const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
  const held = new Map(); let heldId = 0;
  window.requestAnimationFrame = (f) => { if (!asleep) return raf(f); const id = -(++heldId); held.set(id, f); return id; };
  window.cancelAnimationFrame = (id) => { if (id < 0) held.delete(id); else caf(id); };
  const release = () => { if (!held.size) return; const fs = [...held.values()]; held.clear(); raf((t) => fs.forEach((f) => run(() => f(t)))); };

  function setVisible(v) {
    if (asleep === !v) return;
    asleep = !v;
    if (asleep) {
      run(pause);
      run(HIDE[S.page]);
      park();
    } else {
      unpark();
      run(SHOW[S.page]);
      release();
      dispatchEvent(new Event('resize')); // (the host window may have changed size while this tab slept)
      if (S.project && viewerMode() === 'program') run(() => emit('seek', S.playhead)); // (the monitor shows the frame at the playhead again)
    }
    document.dispatchEvent(new Event('visibilitychange'));
  }
  // closing the tab: what is not saved yet goes to the server first (false = it could not be saved)
  async function close() {
    run(() => setVisible(false));
    try { if (S.proj) await saveNow(true); } catch {}
    const ok = !S.proj || S.readOnly || S.saveState === 'saved';
    if (ok) run(disconnectLive);
    return ok;
  }
  window.veTab = { setVisible, close };
  const report = () => { try { host.report(TAB, { proj: S.proj || null, save: S.saveState, busy: !!S.tabBusy }); } catch {} };
  on('save', report);
  on('job', (j) => { S.tabBusy = !!j?.running; report(); });
  new MutationObserver(report).observe(document.head, { subtree: true, childList: true, characterData: true }); // (document.title = the project)
  addEventListener('load', report);
  // Ctrl+Tab / Ctrl+PageDown: the next tab (Shift / PageUp: the one before) - where the browser lets the page have them
  addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const d = e.key === 'Tab' ? (e.shiftKey ? -1 : 1) : e.key === 'PageDown' ? 1 : e.key === 'PageUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault(); e.stopImmediatePropagation(); host.step(d);
  }, true);
  // signing out is for the whole window, not one tab
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href="/team/logout"]'); if (!a) return;
    e.preventDefault(); window.top.location.href = a.href;
  }, true);
  if (asleep) document.dispatchEvent(new Event('visibilitychange'));
}
