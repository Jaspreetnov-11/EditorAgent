// stock.mjs - stock footage for lines the user's own footage cannot show ("waterfall" said, no waterfall shot).
// Searches Pexels and Pixabay (free licences, commercial use allowed, no attribution required) with the user's own
// API keys and downloads one HD clip per search into the shared Stock/online folder (reused by every project).
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const STOP = new Set('a an the and or but if then so to of in on at by for with from into over under about as is are was were be been being this that these those it its their there here where when what which who whom how why not no only just also very more most much many some any each every all both our your my his her we you they he she i me us them can will would should could may might shall do does did have has had than too out up down off again further once own same such nor yet while because until during before after above below between through who whose let make get go come see look feel become becomes became made experience place places thing things way ways time times part'.split(' '));

// Words worth searching for: the content words of the (English) line, longest first, at most four.
export function keywords(text, max = 3) {
  const seen = new Set();
  return String(text || '').toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !seen.has(w) && seen.add(w))
    .slice(0, 8).sort((a, b) => b.length - a.length).slice(0, max).join(' ');
}

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (r.status === 401 || r.status === 403) throw new Error('the API key was not accepted');
  if (r.status === 429) throw new Error('too many searches - try again in a minute');
  if (!r.ok) throw new Error(`search failed (${r.status})`);
  return r.json();
}

// best file: the right orientation, close to the wanted height, mp4
function pick(files, { vertical, height }) {
  const ok = files.filter((f) => f.url && f.width && f.height && (vertical ? f.height > f.width : f.width >= f.height));
  const list = ok.length ? ok : files.filter((f) => f.url);
  return list.sort((a, b) => Math.abs(Math.min(a.width, a.height) - height) - Math.abs(Math.min(b.width, b.height) - height))[0] || null;
}

export async function searchStock(query, { keys, vertical = false, height = 1080, minDur = 4 }) {
  const out = [], errors = [];
  if (keys.pexels) {
    try {
      const j = await getJson(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=8&orientation=${vertical ? 'portrait' : 'landscape'}`, { Authorization: keys.pexels });
      for (const v of j.videos || []) {
        if (v.duration < minDur) continue;
        const f = pick((v.video_files || []).filter((x) => x.file_type === 'video/mp4').map((x) => ({ url: x.link, width: x.width, height: x.height })), { vertical, height });
        if (f) out.push({ source: 'pexels', id: v.id, url: f.url, width: f.width, height: f.height, duration: v.duration, page: v.url, author: v.user?.name || '' });
      }
    } catch (e) { errors.push(`Pexels: ${e.message}`); }
  }
  if (keys.pixabay) {
    try {
      const j = await getJson(`https://pixabay.com/api/videos/?key=${encodeURIComponent(keys.pixabay)}&q=${encodeURIComponent(query)}&per_page=8&safesearch=true`);
      for (const v of j.hits || []) {
        if (v.duration < minDur) continue;
        const f = pick(Object.values(v.videos || {}).map((x) => ({ url: x.url, width: x.width, height: x.height })), { vertical, height });
        if (f) out.push({ source: 'pixabay', id: v.id, url: f.url, width: f.width, height: f.height, duration: v.duration, page: v.pageURL, author: v.user || '' });
      }
    } catch (e) { errors.push(`Pixabay: ${e.message}`); }
  }
  return { results: out, errors };
}

export async function downloadStock(item, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${item.source}_${item.id}.mp4`);
  if (fs.existsSync(file) && fs.statSync(file).size > 10000) return file;
  const r = await fetch(item.url, { signal: AbortSignal.timeout(180000) });
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status})`);
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  fs.appendFileSync(path.join(dir, 'credits.txt'), `${path.basename(file)}\t${item.source}\t${item.author}\t${item.page}\n`);
  return file;
}
