// helpers.mjs - 🖥 helper PCs (Phase 23). Office PCs running engine/worker.mjs say what they are (cores, RAM, NVIDIA
// encoder); each project is given to one of them for its heavy work - reading new footage (probe, thumbnail, filmstrip,
// waveform) and making preview copies - while editing itself stays on the editor. Pure functions: server.mjs keeps the
// state and hands the runs out, worker.mjs runs them (it is fetched on its own, so it does not import this file).

// how much work a PC can take, from what it said about itself
export function helperScore(sp = {}) {
  return Math.max(1, +sp.cores || 1) + (sp.nvenc ? 8 : 0) + Math.min(64, +sp.ramGB || 0) / 8;
}

// the PC for a project: a pinned one (when it is on), else the one it already has (when it is on), else the PC with
// the least projects for its strength. helpers: [{ id, name, specs, paused }], assigned: Map project -> helper id,
// pins: { project: PC name }. need: what the run needs on that PC - one name or a list ('ffprobe', ['torch', 'cv2']).
// A PC whose own user is busy on it (paused) takes nothing: its projects go to the others meanwhile.
export function pickHelper(proj, helpers, assigned, pins = {}, need = null) {
  const can = (h) => [].concat(need || []).every((k) => h.specs[k]);
  const on = helpers.filter((h) => h.specs && !h.paused);
  if (!on.length) return null;
  const pin = pins[proj] && on.find((h) => h.name === pins[proj]);
  const cur = assigned.get(proj), had = cur && on.find((h) => h.id === cur);
  const h = pin || had || (() => {
    const load = (x) => { let n = 0; for (const [p, id] of assigned) if (id === x.id && p !== proj) n++; return n; };
    return on.reduce((best, x) => (!best || (load(x) + 1) / helperScore(x.specs) < (load(best) + 1) / helperScore(best.specs) ? x : best), null);
  })();
  assigned.set(proj, h.id);
  return can(h) ? h : null;
}

// the editor's arguments with its own files swapped for {{INn}} / {{OUTn}} (every argument that is exactly one of them);
// the helper swaps them back for where it reads / writes each one (fromTaskArgs in engine/worker.mjs)
export function toTaskArgs(args, inputs, outs) {
  return args.map((a) => {
    const i = inputs.indexOf(a); if (i >= 0) return `{{IN${i}}}`;
    const o = outs.indexOf(a); return o >= 0 ? `{{OUT${o}}}` : a;
  });
}
