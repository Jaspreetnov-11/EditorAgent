// summarize.mjs - 🛡 a thread (worker_threads) that reads a project's project.json + media.json and sums it up for Home,
// so the main process never reads or parses them itself: a big media list (thousands of clips, MBs) on a busy NAS stopped
// the main process - which every PC's every request goes through - for seconds each time someone opened Home.
// Message in: { id, name, pf, mf }. Message out: { id, s: { name, aspect, media, clips, duration, thumb } } or { id, error }.
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { placed } from '../public/js/model.js';

parentPort.on('message', async ({ id, name, pf, mf }) => {
  try {
    const pj = JSON.parse(await fs.promises.readFile(pf, 'utf8'));
    let items = [];
    try { items = JSON.parse(await fs.promises.readFile(mf, 'utf8')).items || []; } catch {}
    const byId = Object.fromEntries(items.map((m) => [m.id, m]));
    let duration = 0;
    try { duration = Math.max(0, ...Object.values(placed(pj, byId)).flat().map((x) => x.end)); } catch {}
    const first = pj.tracks?.V1?.find((x) => byId[x.mediaId]?.thumb) || null;
    const thumbM = first ? byId[first.mediaId] : items.find((m) => m.thumb);
    parentPort.postMessage({ id, s: { name, aspect: pj.settings?.aspect, media: items.length, clips: Object.values(pj.tracks || {}).flat().length,
      duration: +duration.toFixed(1), thumb: thumbM ? `/pm/${encodeURIComponent(name)}/${thumbM.id}/thumb` : null } });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
});
