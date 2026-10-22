// 🩺 Health watch (Phase 21): how the editor itself is doing, sampled every minute and kept 7 days
// (logs/health-<day>.jsonl). One sample: { t, lag, lagMax (ms the server was stuck - event-loop delay p99 / max),
// reqs, p50, p95 (ms an API call took), slow (calls over 2 s), rss (MB), cpu (% of the whole computer) }. A start of
// the editor is written as { t, start: true }, so restarts show.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { dayOf } from './safety.mjs';

let dir = null, tag = '', timer = null, durs = [], last = [], cpu0 = process.cpuUsage(), wall0 = performance.now();
const lag = monitorEventLoopDelay({ resolution: 20 });
const KEEP_DAYS = 7, MEM_MIN = 24 * 60; // samples kept in memory: the last 24 h

const fileOf = (d) => path.join(dir, `health${tag}-${d}.jsonl`); // (tag: -w3 for project worker 3)
function write(o) { try { fs.appendFileSync(fileOf(dayOf(new Date(o.t))), `${JSON.stringify(o)}\n`); } catch {} }

// an API call took ms (the server's own handler, not streams or file downloads)
export function noteRequest(ms) { if (durs.length < 20000) durs.push(ms); }

function sample() {
  const s = durs.sort((a, b) => a - b), q = (p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : 0);
  const c = process.cpuUsage(cpu0), wall = performance.now() - wall0;
  const o = { t: Date.now(), lag: Math.round((lag.percentile(99) || 0) / 1e6), lagMax: Math.round((lag.max || 0) / 1e6), reqs: s.length, p50: q(0.5), p95: q(0.95), slow: s.filter((x) => x > 2000).length,
    rss: Math.round(process.memoryUsage().rss / 1048576), cpu: Math.round(((c.user + c.system) / 1000 / wall / os.cpus().length) * 100) };
  durs = []; lag.reset(); cpu0 = process.cpuUsage(); wall0 = performance.now();
  last.push(o); if (last.length > MEM_MIN) last.shift();
  write(o);
}

export function startHealth(logDir, ownTag = '') {
  if (timer) return;
  dir = logDir; tag = ownTag; fs.mkdirSync(dir, { recursive: true });
  // the last 24 h from the files (samples from before a restart stay on the charts)
  const since = Date.now() - 864e5;
  for (const d of [dayOf(new Date(since)), dayOf()]) {
    try { for (const l of fs.readFileSync(fileOf(d), 'utf8').split('\n')) { if (!l) continue; const o = JSON.parse(l); if (o.t >= since && !last.some((x) => x.t === o.t)) last.push(o); } } catch {}
  }
  last.sort((a, b) => a.t - b.t);
  const st = { t: Date.now(), start: true }; last.push(st); write(st);
  lag.enable();
  timer = setInterval(sample, 60000); timer.unref?.();
  // files older than a week go
  try { for (const f of fs.readdirSync(dir)) { const m = /^health(?:-w\d+)?-(\d{4}-\d\d-\d\d)\.jsonl$/.exec(f); if (m && Date.parse(m[1]) < Date.now() - KEEP_DAYS * 864e5) fs.rmSync(path.join(dir, f), { force: true }); } } catch {}
}

// the samples since `since` (ms) and the editor's starts in the last 7 days
export function healthSeries(since = Date.now() - 864e5) {
  const starts = [];
  for (let i = 0; i < KEEP_DAYS; i++) {
    try { for (const l of fs.readFileSync(fileOf(dayOf(new Date(Date.now() - i * 864e5))), 'utf8').split('\n')) if (l.includes('"start":true')) starts.push(JSON.parse(l).t); } catch {}
  }
  return { samples: last.filter((x) => x.t >= since && !x.start), starts: starts.sort((a, b) => b - a), now: { lag: Math.round((lag.percentile(99) || 0) / 1e6), rss: Math.round(process.memoryUsage().rss / 1048576), up: Math.round(process.uptime()) } };
}
