// xmlimport.mjs - File > Open: a Premiere Pro / DaVinci Resolve timeline (Final Cut Pro 7 XML, "xmeml") read into the
// editor's own timeline. The other half of nlexport.mjs. What comes across: every video / still / sound clip with its
// place, In / Out and speed, on the same tracks; the sequence's frame size and rate. What does not (effects, titles made
// in Premiere, transitions other than cuts) is listed in `notes`.
//
//   readXmeml(text) -> { name, fps, width, height, video: [[clip]], audio: [[clip]], notes: [] }
//   clip: { start, end, in, out (seconds), path, name, enabled }   (path: the file as Windows sees it, or null)

// ---- a small XML reader: elements, attributes, text (enough for xmeml; no DTD, no namespaces) ----
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m));
export function parseXml(text) {
  const root = { tag: '#root', attrs: {}, kids: [], text: '' }, stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[?!][^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m; (m = re.exec(text));) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unent(a[2] ?? a[3]);
      const el = { tag: m[3], attrs, kids: [], text: '' };
      top.kids.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6]) top.text += unent(m[6]);
  }
  return root;
}
const kid = (el, tag) => el?.kids.find((k) => k.tag === tag);
const kids = (el, tag) => el?.kids.filter((k) => k.tag === tag) || [];
const txt = (el, ...path) => { let e = el; for (const p of path) e = kid(e, p); return e ? e.text.trim() : ''; };
const num = (el, ...path) => { const v = parseFloat(txt(el, ...path)); return Number.isFinite(v) ? v : null; };
const find = (el, tag) => { if (!el) return null; for (const k of el.kids) { if (k.tag === tag) return k; const f = find(k, tag); if (f) return f; } return null; };

// file://localhost/Z:/a%20b/c.mp4, file:///Z:/…, file://server/share/… -> a Windows path
export function urlToPath(u) {
  let s = String(u || '').trim();
  if (!s) return null;
  if (!/^file:/i.test(s)) return s;
  s = s.replace(/^file:\/\/localhost\//i, 'file:///');
  let p;
  try { p = decodeURIComponent(s.replace(/^file:/i, '')); } catch { p = s.replace(/^file:/i, ''); }
  if (/^\/\/\/[a-z]:/i.test(p)) p = p.slice(3); // ///Z:/x -> Z:/x
  else if (/^\/[a-z]:/i.test(p)) p = p.slice(1);
  else if (/^\/\/[^/]/.test(p)) return `\\\\${p.slice(2).replace(/\//g, '\\')}`; // //server/share/x
  return p.replace(/\//g, '\\');
}

const rateOf = (el) => {
  const r = kid(el, 'rate'), tb = num(r, 'timebase') || null, ntsc = /true/i.test(txt(r, 'ntsc'));
  return tb ? { tb, fps: ntsc ? (tb * 1000) / 1001 : tb } : null;
};

export function readXmeml(text) {
  const doc = parseXml(text), xm = find(doc, 'xmeml');
  if (!xm) throw new Error('This is not a Premiere Pro / Resolve XML (Final Cut Pro 7 XML) - export it from Premiere: File > Export > Final Cut Pro XML');
  const seq = find(xm, 'sequence');
  if (!seq) throw new Error('No sequence (timeline) in this XML');
  const r = rateOf(seq) || { tb: 25, fps: 25 }, fps = r.fps;
  const vf = find(kid(kid(seq, 'media'), 'video'), 'samplecharacteristics');
  const width = num(vf, 'width') || 1920, height = num(vf, 'height') || 1080;
  const notes = new Set(), files = {};
  // a <file> is written in full once, then only referred to by its id
  const fileOf = (el) => {
    const f = kid(el, 'file'); if (!f) return null;
    const id = f.attrs.id;
    if (kid(f, 'pathurl') || kid(f, 'name')) {
      const full = { path: urlToPath(txt(f, 'pathurl')), name: txt(f, 'name'), dur: num(f, 'duration'), rate: rateOf(f) };
      if (id) files[id] = full;
      return full;
    }
    return files[id] || null;
  };
  const sec = (fr) => (fr ?? 0) / fps;
  const clipsOf = (track, kind) => {
    const out = [];
    for (const it of track.kids) {
      if (it.tag === 'transitionitem') { const n = txt(it, 'effect', 'name'); if (!/cross dissolve|dissolve|constant power|crossfade/i.test(n)) notes.add(`Transitions other than dissolves (${n || 'some'}) come across as cuts.`); continue; }
      if (it.tag === 'generatoritem') { notes.add('Titles and graphics made in Premiere / Resolve (generators) are not brought in - add titles here.'); continue; }
      if (it.tag !== 'clipitem') continue;
      let start = num(it, 'start'), end = num(it, 'end');
      const inF = num(it, 'in') ?? 0, outF = num(it, 'out') ?? inF;
      // -1 = the clip sits under a transition: its edge is where the transition is
      if (start === null || start < 0) start = end !== null && end >= 0 ? end - (outF - inF) : null;
      if (end === null || end < 0) end = start !== null ? start + (outF - inF) : null;
      if (start === null || end === null || end <= start) continue;
      const f = fileOf(it);
      if (kid(it, 'filter') && kind === 'video') notes.add('Effects and colour from Premiere / Resolve (Lumetri, Motion keyframes…) are not brought in - only the cut.');
      out.push({ start: sec(start), end: sec(end), in: sec(inF), out: sec(outF), path: f?.path || null, name: f?.name || txt(it, 'name'), enabled: !/false/i.test(txt(it, 'enabled') || 'true') });
    }
    return out.sort((a, b) => a.start - b.start);
  };
  const media = kid(seq, 'media');
  const video = kids(kid(media, 'video'), 'track').map((t) => clipsOf(t, 'video'));
  const audio = kids(kid(media, 'audio'), 'track').map((t) => clipsOf(t, 'audio'));
  return { name: txt(seq, 'name') || 'Imported timeline', fps, width, height, video, audio, notes: [...notes] };
}

// the editor's aspect closest to the sequence's frame
export function aspectOf(w, h) {
  const r = w / h, all = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };
  return Object.entries(all).sort((a, b) => Math.abs(a[1] - r) - Math.abs(b[1] - r))[0][0];
}
