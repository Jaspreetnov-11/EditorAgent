// report.mjs - 📊 the day's report of the editor for Limelight Flow (the office's own automation app, flow/): who worked
// and on what, the renders, and how the editor itself held up. Pure functions - server.mjs gathers the records
// (sessions log, render queue, health logs) and answers /report/... on the team door to whoever has the report token.

const dayStart = (day) => { const d = day ? new Date(`${day}T00:00:00`) : new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// people: presence.summary(); renders: the render queue's items; health: the day's health samples of the editor and its
// project workers ({ t, lagMax, start }); errors: the times of the day's logged crashes; more: anything else to pass on
export function dayReport({ day, people = [], renders = [], health = [], errors = [], more = {} }, now = Date.now()) {
  const t0 = dayStart(day), t1 = t0 + 864e5;
  const inDay = (t) => t >= t0 && t < t1;
  const ppl = people.map((p) => {
    const list = (p.list || []).filter((s) => inDay(s.start));
    const projects = {};
    for (const s of list) if (s.project) projects[s.project] = (projects[s.project] || 0) + s.ms;
    return { name: p.name, ms: list.reduce((n, s) => n + s.ms, 0), sessions: list.length, first: list.length ? Math.min(...list.map((s) => s.start)) : null,
      last: list.length ? Math.max(...list.map((s) => s.end)) : null, online: !!p.online, projects: Object.entries(projects).sort((a, b) => b[1] - a[1]).map(([name, ms]) => ({ name, ms })) };
  }).filter((p) => p.ms > 0).sort((a, b) => b.ms - a.ms);
  const rs = renders.filter((r) => inDay(r.ended || r.added || 0));
  const done = rs.filter((r) => r.state === 'done'), failed = rs.filter((r) => r.state === 'failed');
  const samples = health.filter((h) => inDay(h.t));
  return {
    day: dayKey(t0), at: now,
    people: ppl, totalMs: ppl.reduce((n, p) => n + p.ms, 0),
    renders: { done: done.length, failed: failed.length, waiting: renders.filter((r) => r.state === 'waiting').length, rendering: renders.filter((r) => r.state === 'rendering').length,
      failures: failed.map((r) => ({ project: r.project, label: r.label, by: r.by || '', error: String(r.error || '').slice(0, 160) })),
      byPerson: count(done.map((r) => r.by || 'Owner')) },
    health: { worstStallMs: samples.reduce((m, h) => Math.max(m, +h.lagMax || 0), 0), stalls: samples.filter((h) => h.lagMax > 1000).length,
      restarts: samples.filter((h) => h.start).length, errors: errors.filter(inDay).length },
    ...more,
  };
}
const count = (xs) => { const o = {}; for (const x of xs) o[x] = (o[x] || 0) + 1; return o; };

const hm = (ms) => { const m = Math.round(ms / 60e3); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const clock = (t) => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const DAYS = ['Ravivar', 'Somvar', 'Mangalvar', 'Budhvar', 'Guruvar', 'Shukravar', 'Shanivar'];

// the report as a WhatsApp message (WhatsApp's own *bold*)
export function reportText(r) {
  const d = new Date(`${r.day}T12:00:00`);
  const lines = [`📊 *Limelight - ${DAYS[d.getDay()]} ${d.getDate()} ${d.toLocaleString('en-IN', { month: 'short' })}*`];
  lines.push(r.people.length ? `👥 ${r.people.length} log ne kaam kiya, kul ${hm(r.totalMs)}` : '👥 Aaj editor par kisi ne kaam nahi kiya');
  for (const p of r.people.slice(0, 15)) lines.push(`  • ${p.name} ${hm(p.ms)}${p.first ? ` (${clock(p.first)}-${clock(p.last)})` : ''}${p.projects[0] ? ` - ${p.projects[0].name}` : ''}${p.online ? ' 🟢' : ''}`);
  const rd = r.renders;
  lines.push(`🎬 Renders: ${rd.done} bane${rd.failed ? `, ${rd.failed} fail` : ''}${rd.waiting ? `, ${rd.waiting} line mein` : ''}${rd.rendering ? `, ${rd.rendering} chal rahe` : ''}`);
  for (const f of rd.failures.slice(0, 5)) lines.push(`  ✗ ${f.project}${f.by ? ` (${f.by})` : ''}: ${f.error.slice(0, 80)}`);
  const h = r.health;
  lines.push(h.stalls || h.restarts > 1 || h.errors
    ? `🩺 Editor: ${h.stalls} freeze (sabse lamba ${(h.worstStallMs / 1000).toFixed(1)} s), ${h.restarts} restart, ${h.errors} error`
    : '🩺 Editor: koi freeze nahi, sab theek');
  if (r.pendingSaves) lines.push(`💾 ${r.pendingSaves} save NAS ka intezaar kar rahe hain`);
  if (r.cert && r.cert.daysLeft < 21) lines.push(`🔒 HTTPS certificate: ${r.cert.daysLeft} din baaki - renew karna hai`);
  if (r.standby) lines.push(`🖥 Standby PC chal raha hai (${r.standby})`);
  return lines.join('\n');
}

// who is in the editor right now, as a message
export function onlineText(people) {
  const on = people.filter((p) => p.online);
  return on.length ? `🟢 Abhi online (${on.length}): ${on.map((p) => p.name).join(', ')}` : 'Abhi editor par koi online nahi hai';
}
