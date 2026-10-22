// people.mjs - 🧑 who is in the footage and ✍ what is written in it (engine/people.py finds them), for the server, the
// ✨ Agent and edtool. A project's people are in cache/people.json ({ people: [{ key, name, libId, count, media: { id: [t] },
// emb, thumb }] }); the people you have named are kept for every project in Library/people/people.json
// ([{ id, name, aliases: [], embs: [[128]] }]) so "CM Sahab" named once is known in the next project too.
import fs from 'node:fs';
import path from 'node:path';
import { toRoman } from './translit.mjs';

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
export const libFile = (root) => path.join(root, 'Library', 'people', 'people.json');
export const loadLibrary = (root) => readJSON(libFile(root), []);
export function saveLibrary(root, lib) {
  const f = libFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(lib)); fs.renameSync(`${f}.tmp`, f);
}
export const loadPeople = (cacheDir) => readJSON(path.join(cacheDir, 'people.json'), { people: [] });

// words that are only respect / filler around a name: "CM sahab", "Vishnu Deo Sai ji", "Shri ...", "ने कहा"
const SOFT = new Set('ji jee sahab saheb saab sahib shri sri shree mr mrs ms dr smt kumari ne ka ki ke ko se ka hon honble hon\'ble mananiya maananeey maananiy'.split(' '));
// Hindi / Hinglish / English to the same plain Roman words (मुख्यमंत्री -> mukhyamantri, "Mukhyamantree" -> mukhyamantri)
const fold = (w) => w.replace(/aa/g, 'a').replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u').replace(/w/g, 'v').replace(/y$/, 'i').replace(/([bcdfghjklmnpqrstvxyz])\1/g, '$1');
export const words = (s) => toRoman(String(s || '')).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).map(fold);
const nameWords = (s) => { const w = words(s), hard = w.filter((x) => !SOFT.has(x)); return hard.length ? hard : w; };
const has = (hay, needle) => needle.length > 0 && hay.some((_, i) => needle.every((w, k) => hay[i + k] === w));

// the named people a sentence talks about: every word of a name (or of one of its aliases) in a row, respect words aside
export function mentioned(text, people, library = []) {
  const hay = words(text);
  if (!hay.length) return [];
  const libById = Object.fromEntries(library.map((p) => [p.id, p]));
  return people.filter((p) => {
    const lp = p.libId && libById[p.libId];
    const names = [p.name, ...(lp ? [lp.name, ...(lp.aliases || [])] : [])].filter(Boolean);
    return names.some((n) => has(hay, nameWords(n)));
  });
}

// text read off the footage (banners, logos, supers) that contains the words looked for
export function textHits(q, textOf) {
  const qw = words(q).filter((w) => w.length > 1);
  if (!qw.length) return [];
  const out = [];
  for (const [id, list] of Object.entries(textOf || {})) {
    let best = null;
    for (const x of list) {
      const tw = words(x.text), n = qw.filter((w) => tw.some((t) => t === w || (w.length > 3 && t.startsWith(w)))).length;
      if (n && (!best || n > best.n)) best = { id, t: x.t, n, text: x.text };
    }
    if (best && best.n >= Math.min(qw.length, 2)) out.push(best);
  }
  return out.sort((a, b) => b.n - a.n);
}

// seconds of a clip where a person's face was seen
export const faceTimes = (person, mediaId) => person?.media?.[mediaId] || [];
// shown name of a person: their name, or "Person 3"
export const label = (p) => p.name || `Person ${String(p.key).replace(/^p/, '')}`;
