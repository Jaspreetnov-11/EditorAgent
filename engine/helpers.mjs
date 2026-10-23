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
  const q = out.indexOf('-crf'); if (q >= 0) out.splice(q, 2, '-rc', 'vbr', '-cq', String(+out[q + 1] + 1), '-b:v', '0');
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
