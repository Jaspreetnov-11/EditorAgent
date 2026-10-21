// 📊 Sessions: pings become sessions; pauses and project changes split them; the month is kept, older goes.
import { test, eq as same, assert } from './harness.mjs';
import { addBeat, prune, summary, sessionMs, GAP, KEEP_DAYS } from '../engine/presence.mjs';

const M = 60000, T = new Date(2026, 9, 20, 10, 0).getTime();

test('pings a minute apart are one session; a long pause starts another', () => {
  const log = {};
  for (let i = 0; i <= 30; i++) addBeat(log, { name: 'vishal', project: 'A' }, T + i * M);
  addBeat(log, { name: 'vishal', project: 'A' }, T + 30 * M + GAP + M);
  same(log.sessions.length, 2);
  same(sessionMs(log.sessions[0]), 31 * M, '30 minutes of pings + the last minute');
});

test('another project or another person is its own session', () => {
  const log = {};
  addBeat(log, { name: 'vishal', project: 'A' }, T); addBeat(log, { name: 'venky', project: 'A' }, T + M);
  addBeat(log, { name: 'vishal', project: 'B' }, T + 2 * M); addBeat(log, { name: 'venky', project: 'A' }, T + 2 * M);
  same(log.sessions.map((s) => [s.name, s.project]), [['vishal', 'A'], ['venky', 'A'], ['vishal', 'B']]);
});

test('summary: today, 7 days, 30 days, online now, per day', () => {
  const log = {};
  for (let i = 0; i < 10; i++) addBeat(log, { name: 'a' }, T + i * M);              // today 10 min
  for (let i = 0; i < 20; i++) addBeat(log, { name: 'a' }, T - 3 * 86400000 + i * M); // 3 days ago 20 min
  for (let i = 0; i < 5; i++) addBeat(log, { name: 'a' }, T - 20 * 86400000 + i * M); // 20 days ago 5 min
  const [p] = summary(log, T + 10 * M);
  same([p.today, p.week, p.month].map((x) => x / M), [10, 30, 35]);
  assert(p.online, 'online: pinged within the gap');
  same(Object.keys(p.days).length, 3); same(p.sessions, 3);
});

test('prune keeps the last month only', () => {
  const log = {};
  addBeat(log, { name: 'a' }, T - (KEEP_DAYS + 2) * 86400000); addBeat(log, { name: 'a' }, T);
  prune(log, T);
  same(log.sessions.length, 1);
});
