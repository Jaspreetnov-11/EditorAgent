// selfcheck.mjs - the agent looks over its own plan before it builds the timeline, the way an editor scrubs a first cut:
// black / very dark or blurry shots, the same moment used twice, shots too short to read (< 0.4 s), jump cuts inside one
// clip, weak matches, long pauses in the voice-over with nothing under them, music that loops or stops mid-phrase.
// What can be fixed is fixed here (the next-best alternative, a tiny slot merged into its neighbour); the rest becomes
// plain warnings for the report.
const r3 = (x) => Math.round(x * 1000) / 1000;
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// P: { slots, facts, v2, voSegs, lead, total, fullLen, music, musicIn, song, songMode }
export function selfCheck(P) {
  const { slots, facts = {}, v2 = {} } = P;
  const warnings = [], fixes = [];
  const win = (s, p = s.pick) => [p.in, p.in + (p.m.kind === 'video' ? (s.end - s.start) * (s.sp || 1) : 0)];
  const secMean = (arr, a, b, skipZero = false) => { if (!arr?.length) return null; const s0 = Math.max(0, Math.floor(a)), s1 = Math.min(arr.length, Math.max(s0 + 1, Math.ceil(b))); const x = arr.slice(s0, s1).filter((y) => !skipZero || y > 0); return x.length ? x.reduce((p, q) => p + q, 0) / x.length : null; };
  // all the project's blur numbers (blurdetect: only comparable inside one project): a shot far softer than the rest is blurry
  const allBlur = Object.values(facts).flatMap((f) => (f?.blur || []).filter((x) => x > 0)).sort((a, b) => a - b);
  const bHi = allBlur.length > 20 ? allBlur[Math.floor(allBlur.length * 0.97)] : Infinity;
  const problem = (s, p = s.pick) => {
    if (!p?.m) return null;
    const [a, b] = win(s, p), f = facts[p.m.id];
    if (p.m.kind === 'video' && f) {
      const lum = secMean(f.luma, a, Math.max(b, a + 0.1));
      if (lum !== null && lum < 20) return 'dark';
      const bl = secMean(f.blur, a, Math.max(b, a + 0.1), true);
      if (bl !== null && bl > bHi) return 'blurry';
    }
    const smp = v2[p.m.id]?.samples?.filter((x) => x.t >= a - 0.5 && x.t <= b + 0.5);
    if (smp?.length && Math.max(...smp.map((x) => x.sharp ?? 1)) < 0.2) return 'blurry';
    if (smp?.length && Math.max(...smp.map((x) => x.card || 0)) > 0.5) return 'card';
    return null;
  };
  const clashes = (i, p) => slots.some((o, j) => {
    if (j === i || !o.pick || o.pick.m.id !== p.m.id || p.m.kind !== 'video') return false;
    const [a, b] = win(slots[i], p), [c, d] = win(o);
    return a < d - 0.1 && c < b - 0.1;
  });
  const jump = (i, p) => [slots[i - 1], slots[i + 1]].some((o) => o?.pick && o.pick.m.id === p.m.id);
  const fits = (s, p) => p.m.kind !== 'video' || p.in + (s.end - s.start) * (s.sp || 1) <= p.m.duration - 0.02;
  // the best alternative of slot i that has none of the problems
  const swap = (i, why) => {
    const s = slots[i];
    for (const alt of s.alts || []) {
      const p = { ...alt, len: (s.end - s.start) * (s.sp || 1) };
      if (!fits(s, p) || problem(s, p) || clashes(i, p) || jump(i, p)) continue;
      const old = s.pick;
      s.pick = { ...p, swapped: why };
      s.alts = [{ m: old.m, in: old.in, len: old.len, sim: old.sim, q: old.q, score: old.score }, ...s.alts.filter((x) => x !== alt)].slice(0, 5);
      fixes.push(`${why} at ${mmss(s.start)}`);
      return true;
    }
    return false;
  };

  // 1. shots too short to read: merged into the neighbour of the same idea (the earlier one when it has footage to spare)
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i], L = s.end - s.start;
    if (L >= 0.4 || slots.length < 2) continue;
    const prev = slots[i - 1], next = slots[i + 1];
    const room = (o, extra) => !o?.pick || o.pick.m.kind !== 'video' || o.pick.in + (o.end - o.start + extra) * (o.sp || 1) <= o.pick.m.duration - 0.02;
    if (prev && (prev.sec === s.sec || (prev.sec?.textId === s.sec?.textId && prev.sec?.start === s.sec?.start) || !next) && room(prev, L)) { prev.end = s.end; slots.splice(i, 1); i--; fixes.push(`a ${r3(L)} s shot merged at ${mmss(s.start)}`); continue; }
    if (next && next.pick && (next.pick.m.kind !== 'video' || next.pick.in - L * (next.sp || 1) >= 0)) {
      if (next.pick.m.kind === 'video') next.pick.in = r3(next.pick.in - L * (next.sp || 1));
      next.start = s.start; slots.splice(i, 1); i--; fixes.push(`a ${r3(L)} s shot merged at ${mmss(s.start)}`); continue;
    }
    warnings.push(`A very short shot (${r3(L)} s) at ${mmss(s.start)} - it may flash by`);
  }
  // 2. dark / blurry, 3. the same moment twice, 4. jump cuts inside one clip
  const left = { dark: [], blurry: [], card: [], repeat: [], jump: [] };
  slots.forEach((s, i) => {
    if (!s.pick) return;
    const pb = problem(s);
    if (pb) { if (!swap(i, pb === 'dark' ? 'a dark shot replaced' : pb === 'card' ? 'a title card replaced' : 'a blurry shot replaced')) left[pb].push(s.start); return; }
    if (clashes(i, s.pick) && slots.findIndex((o) => o.pick && o.pick.m.id === s.pick.m.id) < i) { if (!swap(i, 'a repeated shot replaced')) left.repeat.push(s.start); return; }
    const pv = slots[i - 1]?.pick;
    if (pv && pv.m.id === s.pick.m.id && s.pick.m.kind === 'video' && Math.abs(s.pick.in - (pv.in + (slots[i - 1].end - slots[i - 1].start) * (slots[i - 1].sp || 1))) < 1.5) {
      if (!swap(i, 'a jump cut replaced')) left.jump.push(s.start);
    }
  });
  const at = (ts) => ts.slice(0, 4).map(mmss).join(', ') + (ts.length > 4 ? '…' : '');
  if (left.dark.length) warnings.push(`${left.dark.length} shot${left.dark.length > 1 ? 's are' : ' is'} very dark (at ${at(left.dark)}) - no brighter shot fits there`);
  if (left.blurry.length) warnings.push(`${left.blurry.length} shot${left.blurry.length > 1 ? 's look' : ' looks'} soft / out of focus (at ${at(left.blurry)})`);
  if (left.card.length) warnings.push(`${left.card.length} shot${left.card.length > 1 ? 's are' : ' is'} a title card / credits (at ${at(left.card)}) - nothing else fits there`);
  if (left.repeat.length) warnings.push(`The same moment is used twice (at ${at(left.repeat)}) - there was not enough different footage`);
  if (left.jump.length) warnings.push(`Two shots in a row come from the same clip (at ${at(left.jump)}) - it can look like a jump cut`);

  // 5. the voice-over: long pauses with nothing under them
  if (P.voSegs?.length && !P.music) {
    const gaps = [];
    for (let i = 1; i < P.voSegs.length; i++) { const g = P.voSegs[i].start - P.voSegs[i - 1].end; if (g > 3.5) gaps.push([P.lead + P.voSegs[i - 1].end, g]); }
    if (gaps.length) warnings.push(`The voice-over pauses for ${gaps.slice(0, 3).map(([t, g]) => `${Math.round(g)} s at ${mmss(t)}`).join(', ')} with no music under it - add music or tighten the VO`);
  }
  // 6. the music: shorter than the edit (it starts again), or it stops in the middle of a phrase
  if (P.music && !P.songMode) {
    const end = (P.musicIn || 0) + (P.fullLen || P.total || 0), dur = P.song?.duration || P.music.duration || 0;
    if (dur && end > dur + 0.5) warnings.push(`The music (${Math.round(dur - (P.musicIn || 0))} s) is shorter than the edit - it starts again from the top at ${mmss(dur - (P.musicIn || 0))}`);
    else if (P.song?.downbeats?.length && dur - end > 2) {
      const ends = [...(P.song.sections || []).map((x) => x.end), ...(P.song.sections || []).map((x) => x.start)];
      const nearPart = ends.some((t) => Math.abs(t - end) < 1.5), nearBar = P.song.downbeats.some((t) => Math.abs(t - end) < 0.25);
      if (!nearPart && !nearBar) warnings.push('The music is cut in the middle of a phrase at the end (it fades out over the last 2.5 s)');
    }
  }
  return { fixes, warnings };
}
