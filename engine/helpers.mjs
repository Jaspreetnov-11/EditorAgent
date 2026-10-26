// helpers.mjs - 🖥 helper PCs (Phase 23). Office PCs running engine/worker.mjs say what they are (cores, RAM, NVIDIA
// encoder); each project is given to one of them for its heavy work - reading new footage (probe, thumbnail, filmstrip,
// waveform) and making preview copies - while editing itself stays on the editor. Pure functions: server.mjs keeps the
// state and hands the runs out, worker.mjs runs them (it is fetched on its own, so it does not import this file).

// how much work a PC can take, from what it said about itself
export function helperScore(sp = {}) {
  return Math.max(1, +sp.cores || 1) + (sp.nvenc ? 8 : 0) + Math.min(64, +sp.ramGB || 0) / 8;
}

// 🎯 which of the PCs asking for work (in the task's lane) takes a task: the one expected to finish it first. Its measured
// speed in that lane (w.rate[lane]: MB of input per second, an average of its last tasks - see noteRate) when known, else
// its strength (helperScore; an NVIDIA card counts thrice for a preview copy); slowed by the tasks it is already doing
// for its slots, by the load of the person working on it and by its recent failures (w.failScore). A first come
// first served pick used to give a 4K camera file to whichever PC asked first - often the slowest one.
// polls: [{ w: { id, specs, busy, slots, load, rate, failScore } }], t: { lane, helper, sizes, tag }. Answers an index or -1.
export function bestPoll(polls, t) {
  const lane = t.lane || 'heavy', mb = (t.sizes || []).reduce((n, x) => n + (+x || 0), 0) / 1e6;
  let best = -1, bestCost = Infinity;
  polls.forEach((p, i) => {
    if (p.lane !== lane || (t.helper && p.w.id !== t.helper)) return;
    const w = p.w, measured = +w.rate?.[lane] > 0 ? +w.rate[lane] : 0;
    const speed = measured || helperScore(w.specs) * (t.tag === 'proxy' && w.specs?.nvenc ? 3 : 1);
    const cost = (Math.max(1, mb) / speed) * (1 + (w.busy || 0) / Math.max(1, w.slots || 1)) * (1 + Math.min(100, +w.load || 0) / 100) * (1 + 2 * Math.min(1, +w.failScore || 0));
    if (cost < bestCost) { bestCost = cost; best = i; }
  });
  return best;
}
// a task finished on a PC: its speed in that lane (an average that follows the last few tasks) and its failure score
export function noteRate(w, lane, mb, secs, failed) {
  w.failScore = (+w.failScore || 0) * 0.7 + (failed ? 0.3 : 0);
  if (failed || !(mb >= 5) || !(secs > 0.5)) return;
  const r = mb / secs; w.rate ||= {};
  w.rate[lane] = w.rate[lane] ? w.rate[lane] * 0.7 + r * 0.3 : r;
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

// ⚡ a preview copy made wholly on the NVIDIA card: decoded (NVDEC), scaled (scale_cuda) and encoded (NVENC) there.
// The slow part of a 4K HEVC 10-bit camera file is decoding it: on the CPU a 20 s DJI clip took 62 s, this way 12 s, as
// sharp (SSIM 0.985). Answers null when the arguments are not a preview copy's; a file the card cannot decode (ProRes,
// 4:2:2) fails and is made the usual way. (engine/worker.mjs has the same, for helper PCs.)
export function gpuProxyArgs(args) {
  const i = args.indexOf('-i'), v = args.indexOf('-vf'), c = args.indexOf('libx264');
  if (i < 0 || v < 0 || c < 1 || args[c - 1] !== '-c:v') return null;
  const m = /^scale=-2:(.+),format=yuv420p$/.exec(args[v + 1]);
  if (!m) return null;
  const out = [...args];
  out[v + 1] = `scale_cuda=-2:${m[1]}:format=yuv420p`;
  out[c] = 'h264_nvenc';
  const p = out.indexOf('-preset'); if (p >= 0) out[p + 1] = 'p4';
  // (a capped bitrate: "-cq 19 -b:v 0" made 31-35 Mbit/s 1080p copies - 6x the CPU ones - and every editor streams them from
  // the NAS while scrubbing; no B-frames, so a jump lands on its frame at once)
  const q = out.indexOf('-crf'), lite = q >= 0 && +out[q + 1] >= 24;
  if (q >= 0) out.splice(q, 2, '-rc', 'vbr', '-cq', lite ? '28' : '23', '-b:v', lite ? '2M' : '6M', '-maxrate', lite ? '3M' : '9M', '-bufsize', lite ? '4M' : '12M', '-bf', '0');
  out.splice(i, 0, '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
  return out;
}

// the editor's arguments with its own files swapped for {{INn}} / {{OUTn}} (every argument that is exactly one of them);
// the helper swaps them back for where it reads / writes each one (fromTaskArgs in engine/worker.mjs)
export function toTaskArgs(args, inputs, outs) {
  return args.map((a) => {
    const i = inputs.indexOf(a); if (i >= 0) return `{{IN${i}}}`;
    const o = outs.indexOf(a); return o >= 0 ? `{{OUT${o}}}` : a;
  });
}
