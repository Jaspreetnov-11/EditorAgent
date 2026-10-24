// 🏷 Client brand packs on disk: Library/brandpacks/<id>/pack.json plus the pack's own files (logo.png, intro.mp4,
// outro.mp4), so a pack still works when the project its files came from is gone, and every PC sees the same packs
// (they are read through the editor server). What a pack holds and how it goes onto a project: public/js/brandpack.js.
// The old single brand kit (Library/brand.json) becomes the first pack once (migrateBrandKit).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cleanPack, PACK_SLOTS } from '../public/js/brandpack.js';

const fail = (code, message) => Object.assign(new Error(message), { code }); // (code = the HTTP status the server answers with)
const okId = (id) => typeof id === 'string' && /^[a-z0-9]{6,32}$/i.test(id);
export const newPackId = () => crypto.randomBytes(5).toString('hex');
export function packDir(root, id) {
  if (!okId(id)) throw fail(400, 'Not a brand pack');
  return path.join(root, id);
}
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); };

// one pack, or a 404 when it is not in the Library (any more)
export function readPack(root, id) {
  const p = readJSON(path.join(packDir(root, id), 'pack.json'), null);
  if (!p) throw fail(404, 'This brand pack is no longer in the Library');
  return { ...cleanPack(p), id };
}
// every pack, A to Z
export function listPacks(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(okId).map((id) => { try { return readPack(root, id); } catch { return null; } })
    .filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}
const nameTaken = (root, name, id) => listPacks(root).some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase());

// create (no id) or change a pack. Its files are not set here (setPackFile) - a file field may only be cleared
// ('' = no logo / intro / outro) or keep the name it has; one pack per name.
export function savePack(root, b = {}, { by = '' } = {}) {
  const old = b.id ? readPack(root, b.id) : null, id = old?.id || newPackId();
  const p = cleanPack({ ...(old || {}), ...b, id, saved: Date.now(), by: by || old?.by || '' });
  for (const s of PACK_SLOTS) if (p[s] && p[s] !== old?.[s]) p[s] = old?.[s] || '';
  if (nameTaken(root, p.name, id)) throw fail(409, `A brand pack named "${p.name}" is already in the Library`);
  fs.mkdirSync(packDir(root, id), { recursive: true });
  for (const s of PACK_SLOTS) if (old?.[s] && !p[s]) dropFile(root, id, old[s]);
  writeJSON(path.join(packDir(root, id), 'pack.json'), p);
  return p;
}
// a pack's file inside its folder is deleted when the pack stops using it (a full path elsewhere never is)
function dropFile(root, id, f) {
  if (f && !path.isAbsolute(f)) fs.rmSync(path.join(packDir(root, id), path.basename(f)), { force: true });
}

// where a pack's logo / intro / outro is: inside its folder, or the full path an older kit kept; null when missing
export function packFile(root, pack, slot) {
  const f = pack?.[slot];
  if (!f) return null;
  const abs = path.isAbsolute(f) ? f : path.join(packDir(root, pack.id), path.basename(f));
  return fs.existsSync(abs) ? abs : null;
}

// a file becomes the pack's logo / intro / outro: copied (or, move = true, moved - an upload) into its folder as
// <slot>.<ext>, replacing the one before
export function setPackFile(root, id, slot, src, { origName = '', move = false } = {}) {
  if (!PACK_SLOTS.includes(slot)) throw fail(400, 'A pack file is its logo, intro or outro');
  const p = readPack(root, id), ext = (path.extname(origName || src) || '').toLowerCase();
  const okExt = slot === 'logo' ? /^\.(png|jpe?g|webp|bmp)$/ : /^\.(mp4|mov|m4v|mkv|webm|avi|mxf|png|jpe?g|webp)$/;
  if (!okExt.test(ext)) throw fail(400, slot === 'logo' ? 'The logo is a picture (.png, .jpg, .webp)' : 'The intro / outro is a video (.mp4, .mov) or a picture');
  if (!fs.existsSync(src)) throw fail(400, `File not found: ${src}`);
  const name = `${slot}${ext}`, to = path.join(packDir(root, id), name);
  if (p[slot] && p[slot] !== name) dropFile(root, id, p[slot]);
  if (move) { try { fs.renameSync(src, to); } catch { fs.copyFileSync(src, to); fs.rmSync(src, { force: true }); } }
  else if (path.resolve(src).toLowerCase() !== to.toLowerCase()) fs.copyFileSync(src, to);
  const out = cleanPack({ ...p, [slot]: name, saved: Date.now() });
  writeJSON(path.join(packDir(root, id), 'pack.json'), out);
  return out;
}

// a copy of a pack with its files, under a new name ("<name> copy", "<name> copy 2", …)
export function duplicatePack(root, id, { name = '', by = '' } = {}) {
  const p = readPack(root, id), nid = newPackId();
  let n = (name || '').trim() || `${p.name} copy`;
  for (let i = 2; nameTaken(root, n, nid); i++) n = `${(name || '').trim() || `${p.name} copy`} ${i}`;
  fs.cpSync(packDir(root, id), packDir(root, nid), { recursive: true });
  const out = cleanPack({ ...p, id: nid, name: n, saved: Date.now(), by: by || p.by });
  writeJSON(path.join(packDir(root, nid), 'pack.json'), out);
  return out;
}

export function deletePack(root, id) {
  fs.rmSync(packDir(root, id), { recursive: true, force: true });
  return { ok: true };
}

// once: the old shared brand kit (brand.json) becomes a pack named "Brand kit" (its files stay where they are).
// A marker file remembers it was done, so deleting that pack does not bring it back.
export function migrateBrandKit(root, brandFile) {
  const mark = path.join(root, '.migrated');
  if (fs.existsSync(mark)) return null;
  fs.mkdirSync(root, { recursive: true });
  const b = readJSON(brandFile, null);
  let made = null;
  if (b && ['logo', 'intro', 'outro', 'primary', 'endText'].some((k) => b[k])) {
    const id = newPackId();
    fs.mkdirSync(packDir(root, id), { recursive: true });
    made = cleanPack({ ...b, id, name: nameTaken(root, 'Brand kit', id) ? 'Brand kit (old)' : 'Brand kit', saved: Date.now() });
    writeJSON(path.join(packDir(root, id), 'pack.json'), made);
  }
  fs.writeFileSync(mark, new Date().toISOString());
  return made;
}
