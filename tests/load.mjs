// ⚙ Load test (not part of the auto-tests): many editors at once on a TEST editor - never on the real one.
// Each fake editor opens one project's live stream and every 1.5-3 s makes a small edit (the way a browser does) and
// now and then reads the media list. One "heavy" project is saved whole, over and over (a 5000-clip timeline): the
// question is how much that slows everyone else. Prints how long the others' edits took (p50 / p95 / p99 / max).
// Usage: node tests/load.mjs --url http://127.0.0.1:3055 --editors 100 --projects 60 --secs 60 [--heavy "Big"]
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const URL0 = opt('url', 'http://127.0.0.1:3055'), EDITORS = +opt('editors', 100), PROJECTS = +opt('projects', 60), SECS = +opt('secs', 60), HEAVY = opt('heavy', '');
if (/:3000\b/.test(URL0) && !argv.includes('--yes-real')) { console.log('This is the real editor (port 3000) - run it on a test editor.'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

const all = (await (await fetch(`${URL0}/api/projects`)).json()).map((p) => p.name).filter((n) => n !== HEAVY);
const projects = all.slice(0, PROJECTS);
console.log(`${EDITORS} editors on ${projects.length} projects for ${SECS} s${HEAVY ? `, "${HEAVY}" saved whole every 1.5 s` : ''} → ${URL0}`);

const lat = { edit: [], media: [], heavy: [] }, fails = { edit: 0, media: 0 };
let stop = false;
const streams = [];
async function editor(i) {
  const p = projects[i % projects.length], client = `load-${i}`;
  const ac = new AbortController(); streams.push(ac);
  fetch(`${URL0}/api/live?p=${enc(p)}&client=${client}`, { signal: ac.signal }).then(async (r) => { const rd = r.body.getReader(); for (;;) { const { done } = await rd.read(); if (done) break; } }).catch(() => {});
  await sleep(Math.random() * 3000);
  let n = 0;
  while (!stop) {
    const t = performance.now();
    try {
      const r = await fetch(`${URL0}/api/live/ops?p=${enc(p)}&client=${client}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'load test', ops: [{ o: 'set', p: ['settings', `load${i}`], v: ++n }] }) });
      await r.arrayBuffer(); if (!r.ok) fails.edit++; else lat.edit.push(performance.now() - t);
    } catch { fails.edit++; }
    if (Math.random() < 0.15) {
      const t2 = performance.now();
      try { const r = await fetch(`${URL0}/api/media?p=${enc(p)}`); await r.arrayBuffer(); if (r.ok) lat.media.push(performance.now() - t2); else fails.media++; } catch { fails.media++; }
    }
    await sleep(1500 + Math.random() * 1500);
  }
}
async function heavy() {
  if (!HEAVY) return;
  const pj = await (await fetch(`${URL0}/api/project?p=${enc(HEAVY)}`)).json(); delete pj._rev;
  const body = JSON.stringify(pj);
  console.log(`heavy project: ${Object.values(pj.tracks).flat().length} clips, ${(body.length / 1048576).toFixed(1)} MB`);
  while (!stop) {
    const t = performance.now();
    try { const r = await fetch(`${URL0}/api/project?p=${enc(HEAVY)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body }); await r.arrayBuffer(); lat.heavy.push(performance.now() - t); } catch {}
    await sleep(1500);
  }
}
const q = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const sum = (a) => ({ n: a.length, p50: q(a, 0.5), p95: q(a, 0.95), p99: q(a, 0.99), max: Math.round(Math.max(0, ...a)), over1s: a.filter((x) => x > 1000).length });
const runs = [...Array(EDITORS)].map((_, i) => editor(i));
const h = heavy();
await sleep(SECS * 1000);
stop = true; await Promise.allSettled([...runs, h]); for (const s of streams) s.abort();
console.log(JSON.stringify({ edits: sum(lat.edit), mediaLists: sum(lat.media), heavySaves: sum(lat.heavy), fails }, null, 1));
process.exit(0);
