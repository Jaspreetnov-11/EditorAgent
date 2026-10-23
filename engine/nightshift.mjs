// nightshift.mjs - 🌙 the night shift (Phase 25): at night, while the office PCs are idle, the 🖥 helper PCs get the
// recent projects' new footage ready for the ✨ Agent - each clip's analysis (motion, light, blur, loudness, cuts) and its
// CLIP frames - so a morning edit starts at once instead of reading every clip first. Only on helpers: when none takes a
// clip, it waits for the next night (the editor is never loaded by it). Pure choices here; server.mjs runs it.

// is `d` inside the night window (local hours; from 21 to 7 runs over midnight)
export function inNight(d, from = 21, to = 7) {
  const h = d.getHours() + d.getMinutes() / 60;
  return from === to ? false : from < to ? h >= from && h < to : h >= from || h < to;
}

// the file the Agent will read for a clip, the same rule as engine/agent.mjs: its preview copy when there is one, else
// the camera file (then only its keyframes). A clip whose preview copy is still being made is left for later: an
// analysis of the camera file would not be used once the copy is there.
export function nightSource(m, proxyFile, exists) {
  if (m.kind !== 'video' || m.status !== 'ready' || !(m.duration >= 1) || m.seqOf) return null;
  if (proxyFile && exists(proxyFile)) return { file: proxyFile, keyOnly: false };
  if (['pending', 'queued', 'making'].includes(m.proxy)) return null;
  return { file: m.path, keyOnly: true };
}

// projects worth it: touched in the last `days` days, newest first, at most `max`
export function recentProjects(list, now = Date.now(), days = 14, max = 10) {
  return list.filter((p) => p.mtime && now - p.mtime < days * 864e5).sort((a, b) => b.mtime - a.mtime).slice(0, max).map((p) => p.name);
}
