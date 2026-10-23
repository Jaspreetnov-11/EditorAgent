// 🔤 The fonts installed on this computer, by family (server.mjs /api/fonts): the family name, weight and italic of
// every .ttf / .otf / .ttc in the Windows font folders (the system one and the user's own), read from the files' own
// name and OS/2 tables - so every editor in the office can pick them and get the files from here (fontpick.js).
import fs from 'node:fs';
import path from 'node:path';

// the sfnt fonts inside a file (one, or several in a .ttc collection): their offsets
function faces(b) {
  if (b.length < 12) return [];
  if (b.toString('latin1', 0, 4) === 'ttcf') { const n = b.readUInt32BE(8); return Array.from({ length: Math.min(n, 64) }, (_, i) => b.readUInt32BE(12 + i * 4)); }
  return [0];
}
function tables(b, off) {
  const n = b.readUInt16BE(off + 4), t = {};
  for (let i = 0; i < n; i++) { const r = off + 12 + i * 16; if (r + 16 > b.length) break; t[b.toString('latin1', r, r + 4)] = { off: b.readUInt32BE(r + 8), len: b.readUInt32BE(r + 12) }; }
  return t;
}
// name id -> text (Windows Unicode English first, any Windows Unicode, then Mac Roman)
function names(b, nt) {
  if (!nt || nt.off + 6 > b.length) return {};
  const count = b.readUInt16BE(nt.off + 2), store = nt.off + b.readUInt16BE(nt.off + 4), out = {}, rank = {};
  for (let i = 0; i < count; i++) {
    const r = nt.off + 6 + i * 12; if (r + 12 > b.length) break;
    const plat = b.readUInt16BE(r), enc = b.readUInt16BE(r + 2), lang = b.readUInt16BE(r + 4), id = b.readUInt16BE(r + 6), len = b.readUInt16BE(r + 8), o = store + b.readUInt16BE(r + 10);
    if (![1, 2, 4, 16, 17].includes(id) || o + len > b.length) continue;
    let txt = null, k = 0;
    if (plat === 3 && (enc === 1 || enc === 10)) { const s = Buffer.from(b.subarray(o, o + len)); s.swap16(); txt = s.toString('utf16le'); k = lang === 0x409 ? 3 : 2; }
    else if (plat === 1 && enc === 0) { txt = b.toString('latin1', o, o + len); k = 1; }
    if (txt && k > (rank[id] || 0)) { out[id] = txt.replace(/\0/g, '').trim(); rank[id] = k; }
  }
  return out;
}
// one file -> [{ family, weight, italic }]
export function fontFaces(buf) {
  const out = [];
  for (const off of faces(buf)) {
    try {
      const t = tables(buf, off), n = names(buf, t.name), os2 = t['OS/2'];
      const family = n[16] || n[1]; if (!family) continue;
      const sub = (n[17] || n[2] || '').toLowerCase();
      const weight = os2 && os2.off + 8 <= buf.length ? buf.readUInt16BE(os2.off + 4) : /bold/.test(sub) ? 700 : 400;
      const italic = os2 && os2.off + 64 <= buf.length ? !!(buf.readUInt16BE(os2.off + 62) & 1) : /italic|oblique/.test(sub);
      out.push({ family, weight: Math.max(100, Math.min(900, weight || 400)), italic });
    } catch {}
  }
  return out;
}
export const FONT_DIRS = () => [path.join(process.env.WINDIR || 'C:/Windows', 'Fonts'), ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')] : [])];
// every family here: { family: [{ file, weight, italic }] } (file = its name in one of FONT_DIRS)
export function listFonts(dirs = FONT_DIRS()) {
  const fams = {};
  for (const dir of dirs) {
    let files = []; try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!/\.(ttf|otf|ttc)$/i.test(f)) continue;
      let buf; try { buf = fs.readFileSync(path.join(dir, f)); } catch { continue; }
      for (const x of fontFaces(buf)) (fams[x.family] ||= []).push({ file: f, weight: x.weight, italic: x.italic });
    }
  }
  return fams;
}
// the path of a font file asked for by name - only a file that is in one of the font folders
export function fontFile(name, dirs = FONT_DIRS()) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name || !/\.(ttf|otf|ttc)$/i.test(base)) return null;
  for (const dir of dirs) { const p = path.join(dir, base); if (fs.existsSync(p)) return p; }
  return null;
}
