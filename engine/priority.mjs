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
