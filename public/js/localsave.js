// 💻 Save to THIS PC: a folder on the computer you are sitting at (not the editing computer). Chrome / Edge let a page
// write into a folder you pick (File System Access) - but only on a secure link (https://… or localhost). The folder is
// remembered in this browser (IndexedDB); finished renders and exported timelines (.zip) you started are written into it.
const DB = 've-local', STORE = 'h';
export const localSaveAvailable = () => typeof window.showDirectoryPicker === 'function';
export const whyNoLocal = () => (window.isSecureContext
  ? 'This browser cannot save into a folder (use Chrome or Edge).'
  : 'Saving straight into a folder of this PC needs the secure link https://editor.limelightcorp.in (being set up) - or, once, in Chrome on this PC: chrome://flags → "Insecure origins treated as secure" → add this editor\'s address → Relaunch. Until then use ⬇ Download.');

const idb = () => new Promise((ok, bad) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
async function put(k, v) { const d = await idb(); return new Promise((ok, bad) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, k); t.oncomplete = ok; t.onerror = () => bad(t.error); }); }
async function get(k) { const d = await idb(); return new Promise((ok, bad) => { const r = d.transaction(STORE).objectStore(STORE).get(k); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); }); }

let dir = null;
export async function localDir() { if (!dir) { try { dir = (await get('dir')) || null; } catch { dir = null; } } return dir; }
export async function pickLocalDir() {
  const d = await window.showDirectoryPicker({ id: 'limelight-exports', mode: 'readwrite' });
  dir = d; await put('dir', d).catch(() => {});
  return d;
}
export async function forgetLocalDir() { dir = null; await put('dir', null).catch(() => {}); }
// permission is asked again after the browser restarts; asking needs a click (user gesture) - see ensure()
async function allowed(d, ask) {
  const o = { mode: 'readwrite' };
  if ((await d.queryPermission?.(o)) === 'granted') return true;
  return ask ? (await d.requestPermission?.(o)) === 'granted' : false;
}
// write the file at `url` into the chosen folder as `name` (streamed - big videos are fine)
export async function saveToLocal(url, name, { ask = false } = {}) {
  const d = await localDir(); if (!d) throw new Error('No folder on this PC chosen yet');
  if (!(await allowed(d, ask))) { const e = new Error('needs permission'); e.permission = true; throw e; }
  let fname = name, n = 2;
  const { base, ext } = (() => { const i = name.lastIndexOf('.'); return i > 0 ? { base: name.slice(0, i), ext: name.slice(i) } : { base: name, ext: '' }; })();
  for (;;) { try { await d.getFileHandle(fname); fname = `${base} (${n++})${ext}`; } catch { break; } } // never overwrite
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const fh = await d.getFileHandle(fname, { create: true }), w = await fh.createWritable();
  await res.body.pipeTo(w);
  return `${d.name}\\${fname}`;
}
