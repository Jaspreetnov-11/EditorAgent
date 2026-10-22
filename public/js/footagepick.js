// 🎞 What the ✨ Agent and 🔁 Re-edit edit with, unless you tick other clips: the files selected in Media (or the folder
// open there); with nothing chosen, the project's footage without what is not footage - logo / watermark / end-slate
// stills, the Rejects / Duplicates / Brand / Stock folders, clips flagged ⚠ bad, a second copy of the same shot, nested
// sequences and clips under a second. They used to take every ready file, so logos and rejects turned up in edits.
import { S } from './store.js';
import { poolSelection, poolFolder } from './mediapool.js';
import { dupGroups } from './smart.js';

const isFootage = (m) => (m.kind === 'video' || m.kind === 'image') && m.status === 'ready' && !m.seqOf;
const SKIP_BIN = /^(rejects?|duplicates?|brand|stock)(\/|$)/i;
const GRAPHIC = /(logo|watermark|end[\s_-]*(slate|slide|card|frame)|lower[\s_-]*third|title[\s_-]*card|thumbnail|icon|qr[\s_-]*code|background|\bbg\b)/i;

// why a file is left out by default ('' = it is footage the agent may use)
export function whyLeftOut(m) {
  if ((m.bin || '') && SKIP_BIN.test(m.bin)) return `in the "${m.bin.split('/')[0]}" folder`;
  if (m.bad?.length) return `flagged: ${m.bad[0]}`;
  if (m.kind === 'image' && GRAPHIC.test(m.name)) return 'a logo / graphic, not footage';
  if (m.kind === 'video' && (m.duration || 0) < 1) return 'shorter than a second';
  return '';
}

// { ids, from: 'selection' | 'folder' | 'auto', left: [{ m, why }] }
export function defaultFootage() {
  const all = S.media.filter(isFootage);
  const sel = new Set(poolSelection()), picked = all.filter((m) => sel.has(m.id));
  if (picked.length) return { ids: picked.map((m) => m.id), from: 'selection', left: [] };
  const folder = poolFolder();
  const pool = folder ? all.filter((m) => (m.bin || '') === folder || (m.bin || '').startsWith(`${folder}/`)) : all;
  const left = [], ids = [];
  // near-copies (🧠 Smart scan): only the first of each group stays
  const copy = new Set(dupGroups().flatMap((g) => g.slice(1)));
  for (const m of pool) {
    const why = whyLeftOut(m) || (copy.has(m.id) ? 'a copy of another clip' : '');
    if (why) left.push({ m, why }); else ids.push(m.id);
  }
  return { ids: ids.length ? ids : pool.map((m) => m.id), from: folder ? 'folder' : 'auto', left: ids.length ? left : [] };
}
