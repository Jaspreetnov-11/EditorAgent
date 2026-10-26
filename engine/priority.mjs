// priority.mjs - ⭐ who goes first (server.mjs): renders in the queue and jobs waiting in an AI job line.
// Render priority: 2 = started on the server PC, 1 = urgent (an editor's choice), 0 = normal (old entries too).

// the queue in the order it is rendered: highest priority first, first come first within a level (a stable sort)
export const byPriority = (items) => [...items].sort((a, b) => (b.priority || 0) - (a.priority || 0));

// where a job joins its line: one started on the server PC in front of the others (behind the server-PC jobs already
// waiting), any other at the end
export function lineIndex(line, job) {
  if (!job.fromServer) return line.length;
  const i = line.findIndex((w) => !w.job.fromServer);
  return i < 0 ? line.length : i;
}

// ⚖ fair share: within one priority level the people whose renders wait take turns - one of each person's in turn, each
// person's own in the order they added them - so one person's ten exports do not keep everyone else waiting. A render of
// theirs already running counts as a turn had. Only the waiting ones are put in turn order (the rest come first, as
// they are: the queue skips them). by = who added it ('' = the owner / older entries).
export function fairOrder(items) {
  const waiting = items.filter((x) => x.state === 'waiting'), out = byPriority(items.filter((x) => x.state !== 'waiting'));
  const running = new Map();
  for (const x of items) if (x.state === 'rendering') running.set(x.by || '', (running.get(x.by || '') || 0) + 1);
  for (const level of [...new Set(waiting.map((x) => x.priority || 0))].sort((a, b) => b - a)) {
    const lines = new Map(); // person -> their waiting renders at this level, in order
    for (const x of waiting) if ((x.priority || 0) === level) { const k = x.by || ''; if (!lines.has(k)) lines.set(k, []); lines.get(k).push(x); }
    const turns = new Map([...lines.keys()].map((k) => [k, running.get(k) || 0]));
    for (let left = [...lines.values()].reduce((n, l) => n + l.length, 0); left > 0; left--) {
      // the person with the fewest turns so far; on a tie, whose next render was added first
      let pick = null;
      for (const [k, l] of lines) if (l.length && (!pick || turns.get(k) < turns.get(pick) || (turns.get(k) === turns.get(pick) && waiting.indexOf(l[0]) < waiting.indexOf(lines.get(pick)[0])))) pick = k;
      out.push(lines.get(pick).shift()); turns.set(pick, turns.get(pick) + 1);
    }
  }
  return out;
}
