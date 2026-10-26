// styles.mjs - 🎓 every editor's style, learnt from their own timeline edits (on by default). For now two things are
// kept: the motion templates they make (the graphic as they set it up - words, colours, logo, font, length) and the
// LUTs they grade with. Each live edit names its editor and the clips it touched (ops paths carry '#<clip id>'), so
// only what that editor changed is counted as theirs. One file per editor: Library/styles/editors/<name>.json - the
// Presets page shows them, later the agent can edit "in the style of" an editor.
import fs from 'node:fs';
import path from 'node:path';

const MAX_TEMPLATES = 80;
const SKIP_TPL = new Set(['comp', 'fusion']); // (Motion comps / node graphs live on their own pages)

export function createStyles(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cache = new Map(), dirty = new Set();
  let timer = null;
  const fileOf = (who) => path.join(dir, `${String(who).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 60) || 'Owner'}.json`);
  const load = (who) => {
    if (!cache.has(who)) { let s = null; try { s = JSON.parse(fs.readFileSync(fileOf(who), 'utf8')); } catch {} cache.set(who, s && typeof s === 'object' ? s : { name: who, templates: [], luts: {} }); }
    return cache.get(who);
  };
  const flush = () => {
    timer = null;
    for (const who of dirty) { try { const s = cache.get(who); s.updated = Date.now(); fs.writeFileSync(fileOf(who), JSON.stringify(s, null, 1)); } catch {} }
    dirty.clear();
  };
  const touch = (who) => { dirty.add(who); if (!timer) timer = setTimeout(flush, 4000); };

  // the clips an edit touched: '#id' steps in its paths and the ids of whole clips it put in
  function touchedIds(ops) {
    const ids = new Set();
    for (const op of ops || []) {
      for (const k of op.p || []) if (typeof k === 'string' && k[0] === '#') ids.add(k.slice(1));
      if (op.v && typeof op.v === 'object' && typeof op.v.id === 'string') ids.add(op.v.id);
    }
    return ids;
  }
  // every clip with one of those ids, anywhere in the project (sequences, nested tracks)
  function findClips(pj, ids) {
    const out = [], seen = new Set();
    const walk = (x, d) => {
      if (!x || typeof x !== 'object' || d > 12) return;
      if (Array.isArray(x)) { for (const y of x) walk(y, d + 1); return; }
      if (typeof x.id === 'string' && ids.has(x.id) && (x.type || x.gfx || x.color) && !seen.has(x.id)) { seen.add(x.id); out.push(x); }
      for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v, d + 1);
    };
    walk(pj, 0);
    return out;
  }

  // one live edit by `who` on project `project`
  function learn(who, project, pj, ops) {
    if (!who || !pj) return;
    const ids = touchedIds(ops);
    if (!ids.size) return;
    let changed = false;
    const s = load(who);
    for (const c of findClips(pj, ids)) {
      // 🎬 a motion template as this editor set it up (one entry per clip: the latest state wins, typing included)
      if (c.type === 'graphic' && c.gfx?.tpl && !SKIP_TPL.has(c.gfx.tpl)) {
        const gfx = JSON.parse(JSON.stringify(c.gfx)), sig = JSON.stringify(gfx);
        let t = s.templates.find((x) => x.clip === c.id && x.project === project);
        if (!t) t = s.templates.find((x) => JSON.stringify(x.gfx) === sig);
        if (t) { if (JSON.stringify(t.gfx) !== sig || t.dur !== c.dur) { t.gfx = gfx; t.dur = c.dur; } t.last = Date.now(); }
        else s.templates.push({ clip: c.id, project, tpl: gfx.tpl, gfx, dur: c.dur, first: Date.now(), last: Date.now() });
        changed = true;
      }
      // 🎨 LUTs: the technical LUT and the creative look
      for (const [kind, name] of [['lut', c.color?.lut], ['look', c.color?.look]]) {
        if (!name || typeof name !== 'string') continue;
        const k = `${kind}:${name}`, l = (s.luts[k] ||= { name, kind, uses: 0, clips: [], first: Date.now() });
        if (!l.clips.includes(c.id)) { l.clips.push(c.id); if (l.clips.length > 200) l.clips.shift(); l.uses++; }
        l.last = Date.now(); changed = true;
      }
    }
    if (!changed) return;
    // the same graphic copied around counts once; the newest kept when there are too many
    s.templates.sort((a, b) => b.last - a.last);
    if (s.templates.length > MAX_TEMPLATES) s.templates.length = MAX_TEMPLATES;
    touch(who);
  }

  const list = () => {
    flush();
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      try { const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { name: s.name, templates: s.templates?.length || 0, luts: Object.keys(s.luts || {}).length, updated: s.updated || 0 }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.updated - a.updated);
  };
  const get = (who) => { flush(); return load(who); };
  return { learn, list, get, flush, touchedIds };
}
