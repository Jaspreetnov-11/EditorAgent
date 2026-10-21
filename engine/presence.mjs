// 📊 Sessions: who worked in the editor, when and for how long (Team & users > Sessions, owner only).
// Every open editor tab pings about once a minute while someone is really using it (tab in front, mouse / keys in the
// last few minutes). Pings closer than GAP make one session; a new project, or a longer pause, starts a new one.
// The log keeps KEEP_DAYS days. Pure functions here (tested in tests/presence.test.mjs); server.mjs loads / saves the file.
export const GAP = 3 * 60 * 1000;          // a pause longer than this ends the session
export const BEAT = 60 * 1000;             // a ping counts for up to one minute of work
export const KEEP_DAYS = 31;

// log = { sessions: [{ name, start, end, project, where }] }  (newest last)
export function addBeat(log, { name, project = '', where = '' }, now = Date.now()) {
  log.sessions ||= [];
  // the person's latest session (searched from the end - they are in time order)
  for (let i = log.sessions.length - 1; i >= 0; i--) {
    const s = log.sessions[i];
    if (s.name !== name) continue;
    if (Math.abs(now - s.end) <= GAP && (s.project || '') === (project || '')) { s.end = Math.max(s.end, now); if (where && !s.where) s.where = where; return s; }
    break;
  }
  const s = { name, start: now, end: now, project: project || '', where: where || '' };
  log.sessions.push(s);
  return s;
}
// a session's length: from its first ping to one minute after its last (the work that ping stood for)
export const sessionMs = (s) => Math.max(BEAT, s.end - s.start + BEAT);

export function prune(log, now = Date.now()) {
  const cut = now - KEEP_DAYS * 86400000;
  log.sessions = (log.sessions || []).filter((s) => s.end >= cut);
  return log;
}

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// per person: today / last 7 days / last 30 days, last seen, online now, the time per day, and their sessions (newest first)
export function summary(log, now = Date.now()) {
  const sod = new Date(now); sod.setHours(0, 0, 0, 0);
  const t0 = sod.getTime(), d7 = t0 - 6 * 86400000, d30 = t0 - 29 * 86400000;
  const people = {};
  for (const s of log.sessions || []) {
    const p = (people[s.name] ||= { name: s.name, today: 0, week: 0, month: 0, sessions: 0, lastSeen: 0, online: false, days: {}, list: [] });
    const ms = sessionMs(s);
    if (s.start >= t0) p.today += ms;
    if (s.start >= d7) p.week += ms;
    if (s.start >= d30) { p.month += ms; p.sessions++; }
    p.days[dayKey(s.start)] = (p.days[dayKey(s.start)] || 0) + ms;
    p.lastSeen = Math.max(p.lastSeen, s.end);
    if (now - s.end <= GAP) p.online = true;
    p.list.push({ start: s.start, end: s.end, ms, project: s.project, where: s.where });
  }
  for (const p of Object.values(people)) p.list.sort((a, b) => b.start - a.start);
  return Object.values(people).sort((a, b) => b.lastSeen - a.lastSeen);
}
