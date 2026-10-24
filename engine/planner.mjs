// planner.mjs - chooses the shot for every slot of the edit at once. The old agent filled the slots one after the other
// (greedy): an early slot could take the one shot a later line needed, and the flow from shot to shot (the same clip
// twice, three close-ups in a row, a colour jump) was never weighed. Here every slot gets a short list of good moments
// (scored on their own: meaning, beauty, sharpness, motion, people, the reference), then a beam search walks the slots
// keeping the best few dozen part-edits, adding what the cut between two shots costs (same clip back to back, the same
// shot size three times, wide -> medium -> close within an idea, colour jumps, look-alikes, reuse). Constraints come
// first: the first / last shot, clips that must be in, clips to avoid, the shots a re-edit keeps. Rejected clips
// (vision2: a screen, a GPS overlay, sideways, a render, too blurry) are never used unless the user picked them.
// The result is written into the slots exactly as before (slot.pick, slot.alts) so finish / report / apply work as they did.
import { imageCost } from './editstyle.mjs';
import { loadPeople, loadLibrary, mentioned, textHits, faceTimes } from './people.mjs';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r3 = (x) => Math.round(x * 1000) / 1000;
const SIZE_ORDER = { wide: 0, medium: 1, close: 2, xclose: 3 };
// one idea = one section (a teaser's music-only slots carry copies of their section, so compare what it is, not the object)
const sameSec = (a, b) => a === b || (!!a && !!b && a.textId === b.textId && a.start === b.start && a.end === b.end);
// first index i with arr[i] >= x (arr ascending)
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
const zstats = (arr) => { const m = mean(arr), sd = Math.sqrt(mean(arr.map((x) => (x - m) ** 2))) || 1; return { m, sd }; };
const isRejected = (rj) => !!rj && (rj.screen || rj.gps || rj.sideways || rj.render || rj.blurry || rj.card);
export const rejectWhy = (rj) => rj?.why || ['screen', 'gps', 'sideways', 'render', 'blurry', 'card'].filter((k) => rj?.[k]).join(', ');

// P: { slots, clips, facts, vis, texts, v2, v2sims, opts, style, sty, ref, refId, cacheDir, root, constraints, prior,
//      report, beam, songMode }
// v2: { mediaId: vision2 cache json }   v2sims: { textId: { mediaId: [ { t, sim } ] } } (z-scored per line)
// prior: { keep: 'shots'|'all', slots: [ { start, end, mediaId, in, hand } ] } - the previous edit (partial re-edit)
export function planShots(P) {
  const t0 = Date.now();
  const { slots, facts, vis, opts = {}, style = 'standard', sty = null, ref = null, refId = null, report } = P;
  const C = { ...(P.constraints || {}) }, v2 = P.v2 || {}, v2sims = P.v2sims || null;
  // a first / last shot asked for in words that no footage shows ("ekdum mast lagna" is a mood, not a shot): dropped with
  // a plain warning instead of forcing a weak shot there (CLIP's own number: a real match is ~0.25+, a mood ~0.2)
  for (const [k, id] of [['first', '_first'], ['last', '_last']]) {
    if (!C[k]?.text || !vis) continue;
    let best = -1;
    for (const m of P.clips) for (const x of vis[m.id]?.sims?.[id] || []) if (x > best) best = x;
    if (best >= 0 && best < 0.24) { report?.warnings.push(`"${C[k].text}" was not found in the footage - the ${k} shot was chosen as usual`); C[k] = { ...C[k] }; delete C[k].text; }
  }
  const avoid = new Set(C.avoid || []), must = new Set((C.must || []).filter((id) => !avoid.has(id)));
  const prior = P.prior?.slots?.length && P.prior.keep !== 'none' ? P.prior : null;
  // picked by the user (must / first / last / a shot they chose by hand in the last edit): used even if vision2 rejects it
  const hand = new Set([...must, C.first?.mediaId, C.last?.mediaId, ...(prior?.slots || []).filter((s) => s.hand).map((s) => s.mediaId)].filter(Boolean));
  const rejected = [];
  let clips = P.clips.filter((m) => {
    if (avoid.has(m.id)) return false;
    if (isRejected(v2[m.id]?.reject) && !hand.has(m.id)) { rejected.push(m); return false; }
    return true;
  });
  if (!clips.length) { clips = P.clips.filter((m) => !avoid.has(m.id)); if (!clips.length) clips = [...P.clips]; report?.warnings.push('Every clip was left out (avoided or rejected) - the edit uses them anyway'); }
  if (rejected.length) report?.warnings.push(`Left out ${rejected.length} clip${rejected.length > 1 ? 's' : ''} that look unusable (${[...new Set(rejected.map((m) => rejectWhy(v2[m.id].reject)).filter(Boolean))].slice(0, 4).join('; ')}) - add one to "must use" to bring it back`);
  const nC = clips.length, mIndex = new Map(clips.map((m, i) => [m.id, i]));

  // ---- per-clip lookups (sorted frame times, prefix sums) so a window is scored without scanning the whole clip ----
  const simZ = {}, allQ = [];
  if (vis) {
    for (const t of P.texts || []) { const all = clips.flatMap((m) => vis[m.id]?.sims?.[t.id] || []); simZ[t.id] = zstats(all.length ? all : [0]); }
    clips.forEach((m) => allQ.push(...(vis[m.id]?.quality || [])));
  }
  const qz = zstats(allQ.length ? allQ : [0]);
  // blurdetect numbers are only comparable inside one project (and 0 = not measured): softness as a z-score among the footage
  const allBlur = clips.flatMap((m) => (facts[m.id]?.blur || []).filter((x) => x > 0)).sort((a, b) => a - b);
  const bMed = allBlur[allBlur.length >> 1] || 0, bIqr = Math.max(0.05, (allBlur[Math.floor(allBlur.length * 0.75)] || 0) - (allBlur[Math.floor(allBlur.length * 0.25)] || 0));
  const motionHi = {};
  for (const m of clips) { const f = facts[m.id]; if (f?.motion?.length) motionHi[m.id] = [...f.motion].sort((a, b) => a - b)[Math.floor(f.motion.length * 0.95)] || 1; }
  const prefix = (arr) => { const p = new Float64Array(arr.length + 1); for (let i = 0; i < arr.length; i++) p[i + 1] = p[i] + (+arr[i] || 0); return p; };
  const pre = {};
  for (const m of clips) {
    const f = facts[m.id], v = vis?.[m.id];
    const x = { };
    if (f) { x.mot = prefix(f.motion || []); x.lum = prefix(f.luma || []); x.blur = prefix((f.blur || []).map((b) => (b > 0 ? b : bMed))); x.n = (f.motion || []).length; }
    if (v?.times?.length) {
      const order = v.times.map((t, i) => i).sort((a, b) => v.times[a] - v.times[b]);
      x.times = order.map((i) => v.times[i]); x.qual = prefix(order.map((i) => v.quality?.[i] ?? qz.m)); x.order = order;
      if (v.emb?.length) x.emb = order.map((i) => { const e = Float32Array.from(v.emb[i] || []); let n = 0; for (const y of e) n += y * y; n = Math.sqrt(n) || 1; for (let k = 0; k < e.length; k++) e[k] /= n; return e; });
    }
    const s2 = v2[m.id]?.samples;
    if (s2?.length) { x.v2 = [...s2].sort((a, b) => a.t - b.t); x.v2t = x.v2.map((s) => s.t); }
    pre[m.id] = x;
  }
  // frame indices (in the sorted order) inside a..b (half a second of slack), or the frame nearest the middle
  const frameRange = (x, a, b) => {
    if (!x.times) return null;
    const i0 = lowerBound(x.times, a - 0.5), i1 = lowerBound(x.times, b + 0.5 + 1e-9);
    if (i1 > i0) return [i0, i1];
    const mid = (a + b) / 2; let k = clamp(lowerBound(x.times, mid), 0, x.times.length - 1);
    if (k > 0 && Math.abs(x.times[k - 1] - mid) < Math.abs(x.times[k] - mid)) k--;
    return [k, k + 1];
  };
  const secMean = (p, n, a, b) => { const s0 = clamp(Math.floor(a), 0, n), s1 = clamp(Math.max(Math.floor(a) + 1, Math.ceil(b)), 0, n); return s1 > s0 ? (p[s1] - p[s0]) / (s1 - s0) : 0; };
  const v2At = (x, a, b) => {
    if (!x.v2) return null;
    let i0 = lowerBound(x.v2t, a - 0.01), i1 = lowerBound(x.v2t, b + 0.01);
    if (i1 <= i0) { const k = clamp(lowerBound(x.v2t, (a + b) / 2), 0, x.v2.length - 1); i0 = k; i1 = k + 1; }
    const ss = x.v2.slice(i0, i1), mid = ss[ss.length >> 1];
    return { beauty: mean(ss.map((s) => s.beauty ?? 0.5)), sharp: Math.min(...ss.map((s) => s.sharp ?? 1)), size: mid.size || 'none', faces: Math.max(...ss.map((s) => s.faces || 0)), text: Math.max(...ss.map((s) => s.text || 0)), card: Math.max(...ss.map((s) => s.card || 0)), people: [...new Set(ss.flatMap((s) => s.people || []))] };
  };
  // (vision2 line scores sorted by time once, so a window is a binary search)
  const v2s = new Map();
  const v2sorted = (tid, id) => {
    const k = `${tid}|${id}`;
    if (!v2s.has(k)) { const l = v2sims?.[tid]?.[id]; if (!l?.length) v2s.set(k, null); else { const o = [...l].sort((p, q) => p.t - q.t); v2s.set(k, { t: o.map((y) => y.t), s: o.map((y) => y.sim) }); } }
    return v2s.get(k);
  };
  const simOf = (m, x, a, b, textId) => {
    let clipSim = null, v2Sim = null;
    const v = vis?.[m.id], r = frameRange(x, a, b);
    if (textId && r && v?.sims?.[textId] && simZ[textId]) { const raw = v.sims[textId], zs = simZ[textId]; let best = -Infinity; for (let i = r[0]; i < r[1]; i++) best = Math.max(best, (raw[x.order[i]] - zs.m) / zs.sd); clipSim = best; }
    const vs = textId ? v2sorted(textId, m.id) : null;
    if (vs) {
      let i0 = lowerBound(vs.t, a - 0.5), i1 = lowerBound(vs.t, b + 0.5 + 1e-9), best = -Infinity;
      for (let i = i0; i < i1; i++) best = Math.max(best, vs.s[i]);
      if (best === -Infinity) { const k = clamp(lowerBound(vs.t, (a + b) / 2), 0, vs.t.length - 1); best = vs.s[k > 0 && Math.abs(vs.t[k - 1] - (a + b) / 2) < Math.abs(vs.t[k] - (a + b) / 2) ? k - 1 : k]; }
      v2Sim = best;
    }
    // (multilingual vision2 reads the Hindi itself; CLIP the English translation - both, when both are there)
    return v2Sim !== null && clipSim !== null ? 0.65 * v2Sim + 0.35 * clipSim : v2Sim ?? clipSim ?? 0;
  };
  const qualOf = (x, a, b) => { const r = frameRange(x, a, b); return r ? ((x.qual[r[1]] - x.qual[r[0]]) / (r[1] - r[0]) - qz.m) / qz.sd : 0; };
  const winVec = (m, a, b) => {
    const x = pre[m.id], r = x && frameRange(x, a, b); if (!r || !x.emb) return null;
    const out = new Float32Array(x.emb[0].length);
    for (let i = r[0]; i < r[1]; i++) { const e = x.emb[i]; for (let k = 0; k < out.length; k++) out[k] += e[k]; }
    let n = 0; for (const y of out) n += y * y; n = Math.sqrt(n) || 1; for (let k = 0; k < out.length; k++) out[k] /= n;
    return out;
  };

  // ---- 🎯 reference (copying a reference edit): which clip looks most like each of its shots ----
  const unitDot = (a, b) => { let d = 0, na = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; } return d / (Math.sqrt(na) || 1); };
  const refEmb = {};
  if (refId && vis?.[refId]?.emb?.length) vis[refId].emb.forEach((e, i) => { const v = Float32Array.from(e), n = Math.hypot(...v) || 1; refEmb[vis[refId].times[i]] = v.map((y) => y / n); });
  const refStats = {}, refMotMax = ref ? Math.max(1e-3, ...ref.shots.map((s) => s.motion || 0)) : 1;
  const refLike = (m, a, b, k) => {
    const r = refEmb[k], x = pre[m.id]; if (!r || !x?.emb) return 0;
    if (!refStats[k]) { const all = clips.flatMap((c) => pre[c.id]?.emb?.map((f) => unitDot(f, r)) || []); const mu = mean(all); refStats[k] = { mu, sd: Math.sqrt(mean(all.map((y) => (y - mu) ** 2))) || 1 }; }
    const rg = frameRange(x, a, b); if (!rg) return 0;
    let best = -Infinity; for (let i = rg[0]; i < rg[1]; i++) best = Math.max(best, unitDot(x.emb[i], r));
    return (best - refStats[k].mu) / refStats[k].sd;
  };
  const bestFor = {}, claim = {};
  const rawLike = (m, k) => { const r = refEmb[k], E = pre[m.id]?.emb; return r && E ? Math.max(...E.map((f) => unitDot(f, r))) : -1; };
  if (Object.keys(refEmb).length) for (const k of new Set(slots.map((x) => x.refK).filter((x) => x !== undefined))) {
    const sc = clips.map((m) => ({ id: m.id, z: pre[m.id]?.emb ? refLike(m, -1e9, 1e9, k) : -9 })).sort((a, b) => b.z - a.z);
    if (!(sc[0] && sc[0].z > 0.5 && (!sc[1] || sc[0].z - sc[1].z > 0.5))) continue;
    const id = sc[0].id, raw = rawLike(clips[mIndex.get(id)], k);
    if (claim[id] && claim[id].raw >= raw) continue;
    if (claim[id]) delete bestFor[claim[id].k];
    claim[id] = { k, raw }; bestFor[k] = id;
  }
  const keptFor = (m, si) => slots.slice(si + 1).filter((x) => x.refK !== undefined && bestFor[x.refK] === m.id).length;

  // ---- people: a line naming someone wants their face; a banner saying the line's words helps a little ----
  const pdata = P.cacheDir ? loadPeople(P.cacheDir) : { people: [] }, plib = P.root ? loadLibrary(P.root) : [], named = pdata.people.filter((p) => p.name);
  const lineOf = (sec) => [sec.orig, sec.text, sec.visual].filter(Boolean).join(' ');
  const near = (ts, a, b) => ts.some((t) => t >= a - 1 && t <= b + 1);
  const personNamed = (q) => (q && named.length ? mentioned(String(q), named, plib)[0] || named.find((p) => p.name.toLowerCase() === String(q).toLowerCase()) : null);
  const personOf = (c) => (c?.personKey && pdata.people.find((p) => p.key === c.personKey)) || personNamed(c?.person);
  const firstWho = personOf(C.first), lastWho = personOf(C.last);
  if (C.first?.person && !firstWho) report?.warnings.push(`"${C.first.person}" is not a known face yet - run Smart scan (People) and name them, then the edit can open on them`);

  // ---- prior (partial re-edit): the shot the last edit had over this slot's time ----
  const priorFor = (sl) => {
    if (!prior) return null;
    let best = null, bo = 0;
    for (const p of prior.slots) { const o = Math.min(p.end, sl.end) - Math.max(p.start, sl.start); if (o > bo) { bo = o; best = p; } }
    if (!best || bo < 0.5 * (sl.end - sl.start)) return null;
    return best;
  };
  // ('avoid': a re-edit of part of the edit - the shots it had there are what the change is about, so others are preferred)
  const keepBonus = prior?.keep === 'all' ? 40 : prior?.keep === 'avoid' ? -1.5 : 2.5;

  // ---- 1. candidates per slot (scored on their own) ----
  const stockSet = new Set(opts.stockIds || []);
  const simW = (x) => Math.min(x, 2.2);
  const badQ = (q) => (q < -1.5 ? 2.5 * (-1.5 - q) + 1 : 0);
  const nSlots = slots.length, lastSi = nSlots - 1;
  const perClip = clamp(Math.ceil(160 / Math.max(1, nC)), 2, 10), K = nC <= 30 ? 64 : 48;
  const cands = [], slotAsk = [];
  let cid = 0;
  for (const [si, slot] of slots.entries()) {
    const L = slot.end - slot.start, tid = slot.sec.textId, SP = slot.sp || 1;
    const who = named.length && !slot.sec.actOnly ? mentioned(lineOf(slot.sec), named, plib) : [];
    const said = !slot.sec.actOnly && slot.sec.orig ? Object.fromEntries(textHits(slot.sec.orig, pdata.text).map((h) => [h.id, h.t])) : {};
    const known = (m, a, b) => (who.some((p) => near(faceTimes(p, m.id), a, b)) ? 1.5 : 0) + (said[m.id] !== undefined && near([said[m.id]], a - 1, b + 1) ? 0.6 : 0);
    slot.who = who.map((p) => p.name);
    slotAsk[si] = new Set([...who.map((p) => p.key), ...((si === 0 || si === lastSi) && (si === 0 ? firstWho : lastWho) ? [(si === 0 ? firstWho : lastWho).key] : [])]);
    // ("pehle 5 second mein CM": the opening constraint holds for every slot that starts in that window)
    const isFirst = si === 0 || (C.first?.within > 0 && slot.start < C.first.within), isLast = si === lastSi;
    const cons = isFirst ? C.first : isLast ? C.last : null, consWho = isFirst ? firstWho : isLast ? lastWho : null, consTid = cons?.text ? (isFirst ? '_first' : '_last') : null;
    const pr = priorFor(slot);
    // the opening and the ending want room (a wide shot), the climax wants people close
    const sizeFit = (z) => (style === 'standard' || !z ? 0 : slot.act === 'intro' || slot.act === 'outro' ? { wide: 0.35, medium: 0.05, close: -0.15, xclose: -0.25 }[z] || 0 : slot.act === 'climax' ? { close: 0.15, medium: 0.1 }[z] || 0 : 0);
    const motW = style === 'standard' ? 0.25 : { intro: 0.05, build: 0.25, climax: 0.65, outro: 0.05 }[slot.act] ?? 0.25;
    const extra = (m, a, b, sim) => {
      let s = known(m, a, b);
      if (cons) {
        if (cons.mediaId && cons.mediaId === m.id) s += 6;
        if (consWho && near(faceTimes(consWho, m.id), a, b)) s += 3;
        if (consTid) s += 1.5 * simW(simOf(m, pre[m.id], a, b, consTid));
      }
      if (must.has(m.id)) s += 0.3;
      void sim;
      return s;
    };
    const list = [];
    const add = (c) => { if (Number.isFinite(c.score)) list.push(c); };
    for (const m of clips) {
      const x = pre[m.id] || {}, stockPen = stockSet.has(m.id) ? 0.35 : 0;
      if (m.kind === 'image') {
        const sim = tid ? simOf(m, x, 0, 0, tid) : 0, q = qualOf(x, 0, 0), w2 = v2At(x, 0, 0);
        const rl = slot.refK !== undefined ? refLike(m, 0, 0, slot.refK) : 0;
        const kept = slot.refK !== undefined && bestFor[slot.refK] !== m.id ? keptFor(m, si) : 0;
        let s = -3.5 * kept + (tid ? simW(sim) : 0) + 0.45 * q - badQ(q) - stockPen - 0.15 - imageCost(sty) + 1.4 * clamp(rl, -2, 2.5) + extra(m, 0, 0, sim);
        if (w2) s += 1.2 * (w2.beauty - 0.5) - (w2.sharp < 0.35 ? 2 * (0.35 - w2.sharp) : 0) - (w2.text > 0.6 ? 0.25 : 0) - (w2.card > 0.5 ? 8 : 0);
        if (pr && pr.mediaId === m.id) s += pr.hand && keepBonus > 0 ? keepBonus + 1.5 : keepBonus;
        add({ m, in: 0, len: 0, score: s, sim, q, rl, w2 });
        continue;
      }
      const f = facts[m.id];
      if (!f || !(m.duration >= Math.min(L * SP, 1) + 0.2)) continue;
      const len = Math.min(L * SP, m.duration - 0.2);
      const cuts = [0, ...(f.cuts || []), m.duration];
      const step = Math.max(0.5, m.duration / 120);
      const own = [];
      const avoidAt = pr && pr.mediaId === m.id && keepBonus < 0 ? (pr.in ?? 0) + Math.max(0, slot.start - pr.start) * SP : null;
      const score = (a) => {
        const b = a + len;
        const mot = x.mot ? secMean(x.mot, x.n, a, b) / (motionHi[m.id] || 1) : 0, lum = x.lum ? secMean(x.lum, x.n, a, b) : 128, bl = x.blur ? secMean(x.blur, x.n, a, b) : bMed;
        const crossCut = cuts.some((ct) => ct > a + 0.2 && ct < b - 0.2);
        const sim = tid ? simOf(m, x, a, b, tid) : 0, q = qualOf(x, a, b), w2 = v2At(x, a, b);
        let s = (tid ? (slot.sec.actOnly ? 0.6 : 1.0) * simW(sim) : 0) + 0.45 * q - badQ(q) + motW * clamp(mot, 0, 1.5) - stockPen;
        if (lum < 28 || lum > 238) s -= lum < 14 ? 3 : 1.2; // (near black: never)
        const bz = (bl - bMed) / bIqr;
        if (bz > 0.5) s -= Math.min(2, 0.5 * (bz - 0.5));
        if (crossCut) s -= 0.45;
        if (w2) s += 1.2 * (w2.beauty - 0.5) - (w2.sharp < 0.35 ? 2 * (0.35 - w2.sharp) : 0) - (w2.text > 0.6 ? 0.25 : 0) - (w2.card > 0.5 ? 8 : 0) + sizeFit(w2.size);
        s += extra(m, a, b, sim);
        let rl = 0;
        if (slot.refK !== undefined && refEmb[slot.refK]) {
          rl = refLike(m, a, b, slot.refK);
          s += 1.4 * clamp(rl, -2, 2.5) - 0.5 * Math.abs(clamp(mot, 0, 1.5) - (ref.shots[slot.refK].motion || 0) / refMotMax);
          if (bestFor[slot.refK] !== m.id) s -= 3.5 * keptFor(m, si);
        }
        if (avoidAt !== null && Math.abs(a - avoidAt) < Math.max(L * SP, 1.5)) s += keepBonus;
        return { m, in: a, len, score: s, sim, q, rl, w2, lum, bz };
      };
      for (let a = 0.15; a + len <= m.duration - 0.05; a += step) own.push(score(a));
      // the shot the last edit had here: always a candidate, at the same moment of the clip
      if (pr && pr.mediaId === m.id && keepBonus > 0) {
        const a = clamp((pr.in ?? 0) + Math.max(0, slot.start - pr.start) * SP, 0, Math.max(0, m.duration - len - 0.05));
        const c = score(a); c.score += pr.hand ? keepBonus + 1.5 : keepBonus; c.prior = true; own.push(c);
      }
      // the best few moments of this clip that are far enough apart to be different shots
      own.sort((p, q) => q.score - p.score);
      const sel = [];
      for (const c of own) { if (sel.length >= perClip) break; if (sel.every((y) => Math.abs(y.in - c.in) >= Math.max(L, 2) || (c.prior && !y.prior))) sel.push(c); }
      sel.forEach(add);
    }
    list.sort((p, q) => q.score - p.score);
    let top = list.slice(0, K);
    // a must-use clip and the kept shot stay candidates even when they are not in the top
    for (const c of list.slice(K)) if (c.prior || (must.has(c.m.id) && !top.some((y) => y.m.id === c.m.id))) top.push(c);
    if (!top.length) {
      // footage exhausted / too short: the longest clip from a spot not used yet as much as possible
      const m = clips.filter((y) => y.kind === 'video').sort((p, q) => q.duration - p.duration)[0] || clips[0];
      top = [{ m, in: m.kind === 'video' ? (si * 1.7) % Math.max(0.1, m.duration - L) : 0, len: Math.min(L * SP, Math.max(0.1, m.duration - 0.2)), score: -9, sim: 0, q: 0, rl: 0, fallback: true }];
    }
    for (const c of top) { c.id = cid++; c.si = si; c.mi = mIndex.get(c.m.id) ?? 0; c.lab = v2[c.m.id]?.colour || null; c.size = c.w2?.size || null; }
    cands.push(top);
  }

  // ---- 2. beam search over the slots ----
  const W = clamp(+P.beam || (nSlots > 80 ? 24 : 32), 4, 64);
  const vecs = new Map(), alikeCache = new Map();
  const vecOf = (c) => { if (!vecs.has(c.id)) vecs.set(c.id, c.m.kind === 'video' ? winVec(c.m, c.in, c.in + (c.len || 0.1)) : winVec(c.m, 0, 0)); return vecs.get(c.id); };
  // 👥 who is in a window (the people scan's faces, named or not, + vision2's people), what kind of shot it is
  // (aerial / people / detail / ground) and which "subject" it shows (windows that look alike, clustered) - so the edit
  // does not come back to the same woman under the same tree four times, or run on drone shots alone
  const facesOf = {};
  for (const pp of pdata.people) for (const [id, ts] of Object.entries(pp.media || {})) (facesOf[id] ||= []).push([pp.key, ts]);
  const keyOfName = Object.fromEntries(pdata.people.filter((pp) => pp.name).map((pp) => [pp.name, pp.key]));
  const hasAerial = !!(simZ._aerial || v2sims?._aerial);
  const annotate = (c) => {
    const a = c.in || 0, b = c.m.kind === 'video' ? a + (c.len || 0.1) : 1e9;
    // (faces are looked for every second or so and not always found: a short clip counts as showing whoever is in it)
    const short = c.m.kind !== 'video' || (c.m.duration || 0) < 20;
    const keys = new Set((facesOf[c.m.id] || []).filter(([, ts]) => short || ts.some((t) => t >= a - 1.5 && t <= b + 1.5)).map(([k]) => k));
    for (const n of c.w2?.people || []) keys.add(keyOfName[n] || n);
    c.who = keys;
    const sz = c.size || 'none', x = pre[c.m.id];
    // (aerial: CLIP's own number for "an aerial drone shot" - not z-scored, a footage of mostly drone shots must still
    // count as mostly aerial; measured: drone footage ~0.26, ground footage 0.07-0.15. vision2's z-score when CLIP is missing)
    const v = vis?.[c.m.id], r = x && frameRange(x, a, Math.min(b, a + 60));
    if (v?.sims?._aerial && r) { let s = 0; for (let i = r[0]; i < r[1]; i++) s += v.sims._aerial[x.order[i]]; c.aerial = s / (r[1] - r[0]) > 0.22; }
    else c.aerial = hasAerial && x ? simOf(c.m, x, a, Math.min(b, a + 60), '_aerial') > 1.0 : false;
    c.kind = c.aerial ? 'aerial' : keys.size || ((c.w2?.faces || 0) > 0 && sz !== 'wide') ? 'people' : sz === 'close' || sz === 'xclose' ? 'detail' : 'ground';
  };
  // subjects: leader clustering of the windows' looks, on a fixed 64-number projection (cheap; cosine > 0.86 = one subject)
  const PROJ = (() => { let s = 12345; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1; const d = pre[clips.find((m) => pre[m.id]?.emb)?.id]?.emb?.[0]?.length || 0; return d ? Array.from({ length: 64 }, () => Float32Array.from({ length: d }, r)) : null; })();
  const leaders = [];
  const subjectOf = (c) => {
    const v = PROJ && vecOf(c); if (!v) return -1;
    const q = new Float32Array(64); let n = 0;
    for (let k = 0; k < 64; k++) { let d = 0; const row = PROJ[k]; for (let i = 0; i < v.length; i++) d += row[i] * v[i]; q[k] = d; n += d * d; }
    n = Math.sqrt(n) || 1; for (let k = 0; k < 64; k++) q[k] /= n;
    for (let j = 0; j < leaders.length; j++) { let d = 0; const L = leaders[j]; for (let k = 0; k < 64; k++) d += L[k] * q[k]; if (d > 0.86) return j; }
    leaders.push(q); return leaders.length - 1;
  };
  for (const list of cands) for (const c of list) { annotate(c); c.subj = subjectOf(c); }
  const limit = Math.max(2, Math.ceil(nSlots / 6));
  const alike = (c, p) => {
    const k = c.id * 1048576 + p.id;
    let d = alikeCache.get(k);
    if (d === undefined) { const a = vecOf(c), b = vecOf(p); d = 0; if (a && b && a.length === b.length) for (let i = 0; i < a.length; i++) d += a[i] * b[i]; alikeCache.set(k, d); }
    return d;
  };
  const overlaps = (p, c) => c.m.kind === 'video' && p.in < c.in + c.len - 0.1 && c.in < p.in + p.len - 0.1;
  const nearBy = (p, c) => c.m.kind === 'video' && p.in < c.in + c.len + 6 && c.in < p.in + p.len + 6;
  const nUsable = nC;
  const trans = (st, c, relaxed) => {
    const u = st.uses[c.mi];
    let t = -(0.9 * u ** 1.5 + (u && st.distinct < nUsable ? 1.2 : 0));
    let dmax = 0, clash = false, depth = 0, subjN = 0, kindN = 0;
    const ask = slotAsk[c.si] || new Set(), askSubj = (c.sim || 0) > 1.5 && slots[c.si]?.sec?.textId && !slots[c.si].sec.actOnly;
    const whoN = {};
    for (let h = st; h.cand; h = h.parent) {
      const p = h.cand; depth++;
      if (p.mi === c.mi && c.mi >= 0 && u) { if (overlaps(p, c)) clash = true; else if (nearBy(p, c)) t -= 0.6; }
      const d = alike(c, p); if (d > dmax) dmax = d;
      // the same subject / the same person again: close by costs most, and nobody / nothing fills more than ~1/6 of the edit
      if (c.subj >= 0 && p.subj === c.subj && !askSubj) { subjN++; if (depth <= 4) t -= 0.9 - 0.15 * (depth - 1); }
      if (c.who?.size && p.who?.size) { let shared = false; for (const k of c.who) if (!ask.has(k) && p.who.has(k)) { whoN[k] = (whoN[k] || 0) + 1; shared = true; } if (shared && depth <= 4) t -= 1.0 - 0.15 * (depth - 1); }
      if (p.kind === c.kind) kindN++;
    }
    if (subjN + 1 > limit) t -= 0.8 * (subjN + 1 - limit);
    for (const n of Object.values(whoN)) if (n + 1 > limit) t -= 0.8 * (n + 1 - limit);
    // variety: three of a kind in a row (drone, drone, drone), or one kind filling more than half the edit
    if (c.kind && !askSubj) {
      if (st.k1 === c.kind && st.k2 === c.kind) t -= st.k3 === c.kind ? 0.8 : 0.4;
      if (depth >= 6 && (kindN + 1) / (depth + 1) > 0.5) t -= c.kind === 'people' ? 0.15 : 0.3;
    }
    if (clash) { if (!relaxed) return null; t -= 6; }
    // (the same subject again - another take of the woman under the tree - from 0.8 alike; 0.95 costs ~1.6, a copy ~2.2)
    if (dmax > 0.8) t -= (dmax - 0.8) * 11;
    const pv = st.cand;
    if (pv) {
      if (pv.mi === c.mi && c.mi >= 0) { t -= 0.8; if (c.m.kind === 'video' && Math.abs(c.in - (pv.in + pv.len)) < 3) t -= 0.8; } // (a jump cut)
      const sameIdea = pv.si >= 0 && sameSec(slots[c.si].sec, slots[pv.si].sec);
      if (c.size && c.size !== 'none') {
        if (st.s1 === c.size && st.s2 === c.size) t -= 0.35; // the same shot size three times running
        const a = SIZE_ORDER[pv.size], b = SIZE_ORDER[c.size];
        if (a !== undefined && b !== undefined) {
          if (sameIdea) t += b === a + 1 ? 0.15 : b < a - 1 ? -0.1 : 0; // an idea opens wide and moves in
          else if (b === 0 && a > 0) t += 0.1;
        }
      }
      if (pv.lab && c.lab) {
        const dE = Math.hypot((pv.lab.l ?? 0) - (c.lab.l ?? 0), (pv.lab.a ?? 0) - (c.lab.a ?? 0), (pv.lab.b ?? 0) - (c.lab.b ?? 0));
        if (dE > 20) t -= Math.min(0.5, 0.015 * (dE - 20)) * (sameIdea ? 1 : 0.5);
      }
    }
    if (must.has(c.m.id) && !u) t += 2;
    return t;
  };
  let root = { score: 0, cand: null, parent: null, uses: new Uint16Array(nC), distinct: 0, s1: null, s2: null, relaxed: 0 };
  // ✂ a re-edit of part of the edit: the shots outside it stay - they count as used (no repeats, no look-alikes) and the
  // one just before the changed part is the shot the first new one cuts from (P.fixed: in time order, that one last)
  for (const f of P.fixed || []) {
    if (!f?.m) continue;
    const mi = mIndex.has(f.m.id) ? mIndex.get(f.m.id) : -1, x = pre[f.m.id];
    const c = { id: cid++, si: -1, m: f.m, mi, in: f.in || 0, len: f.len || 0, score: 0, lab: v2[f.m.id]?.colour || null };
    c.w2 = x ? v2At(x, c.in, c.in + Math.max(0.1, c.len)) : null; c.size = c.w2?.size || null;
    annotate(c); c.subj = subjectOf(c);
    const uses = root.uses.slice(); if (mi >= 0) uses[mi]++;
    root = { score: 0, cand: c, parent: root, uses, distinct: root.distinct + (mi >= 0 && !root.uses[mi] ? 1 : 0), s1: c.size, s2: root.s1, k1: c.kind, k2: root.k1, k3: root.k2, relaxed: 0 };
  }
  let beam = [root];
  for (let si = 0; si < nSlots; si++) {
    const expand = (relaxed) => {
      const out = [];
      for (const st of beam) for (const c of cands[si]) { const t = trans(st, c, relaxed); if (t !== null) out.push({ st, c, score: st.score + c.score + t, relaxed }); }
      return out;
    };
    let next = expand(false);
    if (!next.length) next = expand(true);
    next.sort((a, b) => b.score - a.score);
    const seen = new Set(), kept = [];
    for (const x of next) {
      const key = `${x.c.id}|${x.st.cand?.id ?? -1}`;
      if (seen.has(key)) continue;
      seen.add(key); kept.push(x);
      if (kept.length >= W) break;
    }
    beam = kept.map(({ st, c, score, relaxed }) => {
      const uses = st.uses.slice(); const fresh = !uses[c.mi]; uses[c.mi]++;
      return { score, cand: c, parent: st, uses, distinct: st.distinct + (fresh ? 1 : 0), s1: c.size, s2: st.s1, k1: c.kind, k2: st.k1, k3: st.k2, relaxed: st.relaxed + (relaxed ? 1 : 0), wasRelaxed: relaxed };
    });
  }
  // musts that never made it in cost the end state a lot
  const missing = (st) => [...must].filter((id) => mIndex.has(id) && !st.uses[mIndex.get(id)]).length;
  beam.sort((a, b) => (b.score - 5 * missing(b)) - (a.score - 5 * missing(a)));
  const end = beam[0];
  const chosen = new Array(nSlots);
  for (let h = end, si = nSlots - 1; h && h.cand && si >= 0; h = h.parent, si--) { chosen[si] = h.cand; if (h.wasRelaxed || h.cand.fallback) report?.warnings.push(`Ran out of fresh footage at ${r3(slots[si].start)}s - a shot was reused`); }
  const miss = [...must].filter((id) => !chosen.some((c) => c?.m.id === id));
  if (miss.length) report?.warnings.push(`${miss.length} clip${miss.length > 1 ? 's' : ''} you wanted in could not be fitted (too short or nothing fits)`);
  for (const [si, slot] of slots.entries()) {
    const c = chosen[si] || cands[si][0];
    slot.pick = { m: c.m, in: c.in, len: c.len, score: c.score, sim: c.sim, q: c.q, rl: c.rl, beauty: c.w2?.beauty, sharp: c.w2?.sharp, size: c.size, kind: c.kind, subj: c.subj, faces: c.who ? [...c.who] : [], prior: !!c.prior };
    // runners-up for "Change": the other good moments of this slot (other clips / far-apart moments), best first
    const alts = [];
    for (const x of cands[si]) {
      if (x === c || x.fallback) continue;
      if (x.m.id === c.m.id && Math.abs(x.in - c.in) < Math.max(slot.end - slot.start, 2)) continue;
      if (alts.some((y) => y.m.id === x.m.id && Math.abs(y.in - x.in) < Math.max(slot.end - slot.start, 2))) continue;
      alts.push(x); if (alts.length >= 5) break;
    }
    slot.alts = alts.map((x) => ({ m: x.m, in: x.in, len: x.len, sim: x.sim, q: x.q, score: x.score }));
  }
  return { ms: Date.now() - t0, beam: W, candidates: cid, rejected: rejected.map((m) => m.id), kept: slots.filter((s) => s.pick.prior).length };
}

// 🎵 Hold a strong shot one beat longer: a beautiful / high-quality pick takes a beat from the next shot of the same idea
// (the cut moves one beat later, so it is still on the beat; a new line / part always keeps its cut).
export function holdStrong(slots, facts, { minLen = 0.6, maxLen = 6 } = {}) {
  let n = 0;
  const most = Math.ceil(slots.length / 6); // (a few held shots give the cutting a breath; many would just slow it)
  for (let i = 0; i + 1 < slots.length && n < most; i++) {
    const s = slots[i], nx = slots[i + 1], b = s.beat, p = s.pick;
    if (!b || !p || s.held || nx.held || !sameSec(s.sec, nx.sec) || s.run !== nx.run || s.ramp || nx.ramp) continue;
    const strong = (p.beauty ?? 0) >= 0.72 || (p.q ?? 0) > 1.0;
    if (!strong) continue;
    const L = s.end - s.start, NL = nx.end - nx.start;
    if (L + b > maxLen || NL - b < Math.max(minLen, b * 0.99)) continue;
    // the next shot must not be the stronger one
    if ((nx.pick?.score ?? -9) > p.score + 0.5) continue;
    if (p.m.kind === 'video') {
      const sp = s.sp || 1, need = p.in + (L + b) * sp, f = facts[p.m.id];
      if (need > p.m.duration - 0.05) continue;
      if ((f?.cuts || []).some((ct) => ct > p.in + 0.2 && ct < need - 0.2)) continue;
      if (slots.some((o, j) => j !== i && o.pick?.m.id === p.m.id && o.pick.in < need && p.in < o.pick.in + (o.end - o.start) * (o.sp || 1))) continue;
      p.len = (L + b) * sp;
    }
    s.end = r3(s.end + b); nx.start = s.end; s.held = true; nx.held = true; n++;
  }
  return n;
}
