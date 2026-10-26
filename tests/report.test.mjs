// 📊 the day's report for Limelight Flow (engine/report.mjs): who worked and on what, renders, the editor's health
import { test, eq, assert } from './harness.mjs';
import { dayReport, reportText, onlineText } from '../engine/report.mjs';

const at = (h, m = 0) => new Date(`2026-10-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`).getTime();
const people = [
  { name: 'Vishal', online: false, list: [{ start: at(10), end: at(13), ms: 3 * 3600e3, project: 'MP Video' }, { start: at(14), end: at(15), ms: 3600e3, project: 'Reel' }, { start: at(9) - 864e5, end: at(10) - 864e5, ms: 3600e3, project: 'Old' }] },
  { name: 'Amit', online: true, list: [{ start: at(11), end: at(12, 30), ms: 1.5 * 3600e3, project: 'Tourism' }] },
  { name: 'Kanha', online: false, list: [{ start: at(9) - 864e5, end: at(10) - 864e5, ms: 3600e3, project: 'Old' }] },
];
const renders = [
  { state: 'done', ended: at(12), by: 'Vishal', project: 'MP Video' }, { state: 'done', ended: at(16), project: 'Reel' },
  { state: 'failed', ended: at(17), by: 'Amit', project: 'Tourism', label: 'Reel 9:16', error: 'render: no such file' },
  { state: 'done', ended: at(12) - 864e5 }, { state: 'waiting', added: at(18) },
];

test('report: the day only - people by time worked, their main project, renders and health', () => {
  const r = dayReport({ day: '2026-10-24', people, renders, health: [{ t: at(9), lagMax: 40 }, { t: at(10), lagMax: 2500 }, { t: at(11), start: true }], errors: [at(10), at(9) - 864e5], more: { pendingSaves: 0 } }, at(20));
  eq(r.people.map((p) => [p.name, p.ms / 3600e3, p.projects[0].name]), [['Vishal', 4, 'MP Video'], ['Amit', 1.5, 'Tourism']]);
  eq(r.totalMs, 5.5 * 3600e3);
  eq([r.renders.done, r.renders.failed, r.renders.waiting], [2, 1, 1]);
  eq(r.renders.byPerson, { Vishal: 1, Owner: 1 });
  eq(r.health, { worstStallMs: 2500, stalls: 1, restarts: 1, errors: 1 });
  const t = reportText(r);
  assert(t.includes('Shanivar 24 Oct') && t.includes('2 log ne kaam kiya, kul 5h 30m'), t);
  assert(t.includes('Vishal 4h 00m') && t.includes('Amit 1h 30m') && t.includes('🟢'), t);
  assert(t.includes('2 bane, 1 fail, 1 line mein') && t.includes('Tourism (Amit): render: no such file'), t);
  assert(t.includes('1 freeze'), t);
});

test('report: a quiet day, and who is online', () => {
  const r = dayReport({ day: '2026-10-25', people, renders: [] }, at(20) + 864e5);
  assert(reportText(r).includes('kisi ne kaam nahi kiya') && reportText(r).includes('sab theek'));
  eq(onlineText(people), '🟢 Abhi online (1): Amit');
  eq(onlineText([]), 'Abhi editor par koi online nahi hai');
});
