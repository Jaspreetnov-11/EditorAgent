// agent.mjs - the auto-edit agent. Turns footage + (optional) voice-over, music and an outline into a finished,
// editable multi-track timeline:
//   1. analyse every clip (shots, motion, sound, brightness, blur)          analyze.mjs
//   2. transcribe the voice-over (and translate it to English for matching) transcribe.py
//   3. understand the pictures: CLIP similarity of frames to each VO line   clipmatch.py
//      + a CLIP "is this a good shot" score
//   4. plan shots: VO lines (or outline sections / beats) -> slots; cuts snap to the music beat
//   5. pick the best moment for every slot (meaning + quality + motion, no repeats, no blur / dark)
//   6. finish: auto colour (LOG -> LUT), voice clean-up on the VO, ducked music (best part), subtitles,
//      title and end card - all as normal clips the user can change.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { analyzeClip, extractFrames, run } from './analyze.mjs';
import { beats, bestSection, energyCurve } from './music.mjs';
import { measure, autoGrade, looksLog, matchGrade } from './colorstats.mjs';
import { describeRef } from './refstyle.mjs';
import { guessLogLut } from './lutgen.mjs';
import { FX_PRESETS } from '../public/js/audiofx.js';
import { uid, RAMPS, rampAvg, rampPts } from '../public/js/model.js';
import { soundKey } from './translit.mjs';
import { CUTFX, autoSfx } from '../public/js/fx.js';
import { fixLyrics, planSong, songFx } from './songplan.mjs';
import { imageCost, styleMotion, lyricTitles } from './editstyle.mjs';
import { cuesFromSegments, defaultCaptions } from '../public/js/captions.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r3 = (x) => Math.round(x * 1000) / 1000;
const PACE = { fast: 1.7, medium: 2.8, slow: 4.2 };
// at most n tasks at once; returns run(fn) -> promise of fn's result
function limiter(n) {
  let active = 0;
  const wait = [];
  const next = () => { if (active < n && wait.length) { active++; wait.shift()(); } };
  return (fn) => new Promise((ok, no) => { wait.push(() => fn().then(ok, no).finally(() => { active--; next(); })); next(); });
}

// ctx: { opts, media: {id: item}, cacheDir, subsDir, python, root, luts, log(msg), progress(pct) }
export async function runAgent(ctx) {
  const { opts, media, cacheDir, python, root, log, progress } = ctx;
  let clips = (opts.clips || []).map((id) => media[id]).filter((m) => m && (m.kind === 'video' || m.kind === 'image'));
  if (!clips.length) throw new Error('Choose at least one video or photo for the agent');
  const vo = opts.vo && media[opts.vo], music = opts.music && media[opts.music];
  const src = (m) => (m.proxyPath && fs.existsSync(m.proxyPath) ? m.proxyPath : m.path);
  const keyOnly = (m) => src(m) === m.path && m.kind === 'video'; // no proxy yet: read only the keyframes of the camera file
  const report = { warnings: [], slots: [] };
  // 🎨 a learnt edit style (engine/editstyle.mjs): shot length, footage, moves, grade, cuts and lyric titles like that edit
  const sty = opts.styleProfile || null;
  const fxOn = opts.fx !== false && !(sty && sty.cuts.fx < 0.05);
  const transStyle = sty ? (sty.cuts.transitions > 0.3 ? 'cinematic' : 'cuts') : opts.style;
  if (sty) report.style = sty.name;

  // ---- 2. voice-over (started first: it is heard while the clips are analysed) ----
  const voJob = vo ? hearVo() : Promise.resolve(null);
  voJob.catch(() => {}); // awaited below; this only stops an early failure from being reported as unhandled
  // 🎵 Song edit: the song is studied meanwhile too (engine/song.py + the sung lyrics)
  const songMode = opts.editStyle === 'song' && !!music;
  const songJob = songMode ? hearSong() : null;
  songJob?.catch(() => {});
  async function hearSong() {
    const key = crypto.createHash('sha1').update(JSON.stringify([music.path, music.size, music.mtime])).digest('hex').slice(0, 12);
    const dir = path.join(cacheDir, 'song', key), sj = path.join(dir, 'song.json');
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(sj)) {
      log('Listening to the song: beat, bars, verses and chorus, the singing voice on its own…');
      const r = await run(python, [path.join(root, 'engine', 'song.py'), music.path, dir, sj], {});
      if (r.code !== 0 || !fs.existsSync(sj)) throw new Error(`Could not read the song: ${r.stderr.slice(-300)}`);
    }
    const song = JSON.parse(fs.readFileSync(sj, 'utf8'));
    let segs = [], en = [];
    if (song.vocals && fs.existsSync(song.vocals) && opts.songLyrics !== false) {
      const lang = opts.voLang && opts.voLang !== 'auto' ? opts.voLang : 'hi', model = opts.whisperModel || 'medium';
      // (v3: the song heard in ~30 s pieces, each line on its own - see transcribe.py --song)
      const lj = path.join(dir, `lyrics3-${model}-${lang}.json`), le = path.join(dir, `lyrics3-${model}-${lang}.en.json`);
      if (!fs.existsSync(lj)) {
        log(`Hearing the lyrics (${model} model)…`);
        const r = await run(python, [path.join(root, 'engine', 'transcribe.py'), song.vocals, '--lang', lang, '--task', 'transcribe', '--model', model, '--words', '4', '--song',
          '--out', path.join(dir, 'lyrics.srt'), '--json', lj, ...(lang !== 'en' ? ['--translate-json', le] : [])], {});
        if (r.code !== 0) report.warnings.push('Could not hear the lyrics - the cuts follow the beat and the parts of the song only');
      }
      if (fs.existsSync(lj)) segs = JSON.parse(fs.readFileSync(lj, 'utf8')).segments || [];
      en = fs.existsSync(le) ? JSON.parse(fs.readFileSync(le, 'utf8')).segments || [] : segs;
    }
    return { song, segs, en };
  }

  // ---- 1. analyse clips ----
  log(`Analysing ${clips.length} clip${clips.length > 1 ? 's' : ''}…`);
  const facts = {};
  let done = 0;
  // already analysed clips first (instant), then the ones with a proxy (small files), the camera originals last;
  // ctx.skips() counts the user's presses of "Skip": a press stops the current stage and edits with the clips done so far
  // (stock clips just downloaded for this edit come first: they are why the re-edit runs.)
  // opts.quick: do not read camera originals that were never looked at (no analysis, no proxy) - the same as Skip, up front
  const stock = new Set(opts.stockIds || []);
  const cost = (m) => (stock.has(m.id) ? -1 : fs.existsSync(path.join(cacheDir, 'analysis', `${m.id}.json`)) ? 0 : keyOnly(m) ? 2 : 1);
  let pool = clips.filter((m) => m.kind === 'video').sort((x, y) => cost(x) - cost(y));
  const later = opts.quick ? pool.filter((m) => cost(m) === 2) : [];
  if (later.length) pool = pool.filter((m) => cost(m) !== 2);
  const skipsAt = (n0) => () => (ctx.skips?.() || 0) > n0;
  let skipped = skipsAt(ctx.skips?.() || 0);
  // camera originals live on a slow network drive: two read at a time measured fastest (70 MB/s, vs 63 for one and 61
  // for four - the drive and the 4K decode both limit); proxies and cached clips go 6 at a time
  const camLane = limiter(+opts.camReads || 2);
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (pool.length && !skipped()) {
      const m = pool.shift();
      const go = () => analyzeClip(src(m), path.join(cacheDir, 'analysis', `${m.id}.json`), { hasAudio: m.hasAudio, duration: m.duration, keyOnly: keyOnly(m), framesDir: path.join(cacheDir, 'agent', 'frames', m.id) });
      facts[m.id] = await (cost(m) === 2 ? camLane(go) : go());
      progress(2 + (23 * ++done) / clips.length);
      if (pool.length && done % 10 === 0) log(`Analysing clips… ${done}/${clips.length} (press Skip to edit with these)`);
    }
  }));
  const skippedIds = [...pool, ...later].map((m) => m.id);
  if (skippedIds.length) {
    const left = new Set(skippedIds);
    clips = clips.filter((m) => !left.has(m.id));
    report.warnings.push(`Skipped ${left.size} clips that were not looked at yet - the edit uses the other ${clips.length}. Run the agent again later to use all of them (finished clips are remembered).`);
    log(`Skipped - editing with ${clips.length} clips`);
  }

  // ---- 2. voice-over (heard in the background since the start) ----
  let voSegs = null, voDur = 0, srtFile = null;
  if (vo) {
    log('Waiting for the voice-over to be heard…');
    ({ voSegs, voDur, srtFile } = await voJob);
  }
  async function hearVo() {
    let voSegs = null, voDur = 0, srtFile = null;
    const model = opts.whisperModel || 'medium';
    const lang = opts.voLang || 'hi';
    // a voice-over already heard (same file, model, language and names) is reused: re-edits start right away
    const key = crypto.createHash('sha1').update(JSON.stringify([vo.path, vo.size, vo.mtime, model, lang, opts.names || ''])).digest('hex').slice(0, 12);
    const tjson = path.join(cacheDir, 'agent', `vo-${key}.json`), ejson = path.join(cacheDir, 'agent', `vo-${key}.en.json`);
    fs.mkdirSync(path.dirname(tjson), { recursive: true });
    const wantSubs = !!opts.subtitles;
    log(`Listening to the voice-over (${model} model; the first run downloads it)…`);
    const words = opts.aspect === '9:16' || opts.aspect === '4:5' ? 4 : 0;
    srtFile = path.join(ctx.subsDir, `agent_vo_${Date.now()}.srt`);
    // subtitles too: the captions of a heard VO are kept beside it (per caption length) and copied in
    const srtCache = path.join(cacheDir, 'agent', `vo-${key}-w${words}.srt`);
    const heard = fs.existsSync(tjson) && (!wantSubs || fs.existsSync(srtCache));
    if (heard && wantSubs) fs.copyFileSync(srtCache, srtFile);
    const a = heard ? { code: 0 } : await run(python, [path.join(root, 'engine', 'transcribe.py'), vo.path, '--lang', lang, '--task', 'transcribe', '--model', model,
      '--words', String(wantSubs ? words : 0), '--out', srtFile, '--json', tjson, ...(opts.names ? ['--prompt', opts.names] : []),
      // not English: the English version for picture matching comes from the same run (one model load, one decode)
      ...(lang !== 'en' && !fs.existsSync(ejson) ? ['--translate-json', ejson] : [])],
    {});
    if (a.code !== 0) throw new Error(`Voice-over transcription failed: ${a.stderr.slice(-300)}`);
    const orig = JSON.parse(fs.readFileSync(tjson, 'utf8'));
    voDur = vo.duration || orig.duration;
    let eng = orig;
    if (orig.language !== 'en') {
      log('Translating the voice-over to English for picture matching…');
      const b = fs.existsSync(ejson) ? { code: 0 } : await run(python, [path.join(root, 'engine', 'transcribe.py'), vo.path, '--lang', orig.language, '--task', 'translate', '--model', model,
        '--out', path.join(cacheDir, 'agent', 'vo-english.srt'), '--json', ejson],
      {});
      if (b.code === 0) eng = JSON.parse(fs.readFileSync(ejson, 'utf8'));
      else report.warnings.push('Could not translate the voice-over - matching used the original words');
    }
    // align English segments to the original ones by time (translation can merge/split sentences)
    voSegs = orig.segments.filter((s) => s.text.trim()).map((s, i) => {
      const en = eng.segments.filter((e) => e.end > s.start && e.start < s.end).map((e) => e.text).join(' ').trim() || s.text;
      return { id: `s${i}`, start: s.start, end: s.end, text: s.text, en };
    });
    if (!voSegs.length) report.warnings.push('No speech found in the voice-over file');
    if (wantSubs && !heard && fs.existsSync(srtFile)) fs.copyFileSync(srtFile, srtCache);
    if (!wantSubs) { fs.rmSync(srtFile, { force: true }); srtFile = null; }
    return { voSegs, voDur, srtFile };
  }
  progress(45);

  // ---- 3. plan sections and slots ----
  let lead = vo ? 0.6 : 0;
  const shot = sty ? clamp(sty.shots.median * 1.1, 0.6, 6) : PACE[opts.pace] || PACE.medium;
  const endCard = opts.endText ? 2.5 : 0;
  let total = vo ? lead + voDur + 1.2 : clamp(+opts.target || 30, 5, 1800);
  let sections, script = null, songPlan = null;
  if (songMode) {
    // 🎵 the song decides: one section per sung line (the pictures follow its meaning), parts set the cutting speed
    const sg = await songJob;
    const typed = opts.lyrics?.trim() || (opts.scenes || []).map((s) => s.vo).filter(Boolean).join('\n');
    const fx = fixLyrics(sg.segs, typed);
    if (typed) log(`Lyrics: ${fx.fixed} of ${sg.segs.length} sung lines matched your words`);
    const lines = fx.segs.map((s) => ({ ...s, en: sg.en.filter((e) => e.end > s.start && e.start < s.end).map((e) => e.text).join(' ').trim() || s.text }));
    // the whole song, or (a reel) its best stretch of the chosen length, from a bar line
    let w0 = 0, w1 = sg.song.duration;
    if (opts.songPart === 'best' && +opts.target > 0 && +opts.target < w1 - 5) {
      // the stretch of that length with the most energy, starting on a bar line - better still where a part (the
      // chorus / hook) begins - and ending on a bar line
      const { beats: Bt, energy: Et, downbeats: Dt, sections: St } = sg.song, len = +opts.target;
      const at = (t) => Dt.reduce((b, d) => (Math.abs(d - t) < Math.abs(b - t) ? d : b), Dt[0] ?? t);
      let best = { s: -1, t: 0 };
      for (const d of Dt) {
        if (d + len > sg.song.duration) break;
        const es = Et.filter((_, i) => Bt[i] >= d && Bt[i] < d + len), e = es.length ? mean(es) : 0;
        const partStart = St.some((p) => Math.abs(p.start - d) < 1.5) ? 0.08 : 0, lineStart = lines.some((l) => Math.abs(l.start - d) < 0.8) ? 0.04 : 0;
        if (e + partStart + lineStart > best.s) best = { s: e + partStart + lineStart, t: d };
      }
      w0 = best.t; w1 = Math.min(sg.song.duration, at(w0 + len));
      if (w1 - w0 < len * 0.8) w1 = Math.min(sg.song.duration, w0 + len);
    }
    songPlan = planSong({ song: sg.song, lines, w0, w1, pace: opts.pace, shotTarget: sty?.shots.median || null });
    songPlan.w0 = w0;
    songPlan.typedOk = !!typed && fx.fixed >= sg.segs.length * 0.4;
    ({ sections, total } = songPlan);
    lead = 0;
    if (!lines.length) report.warnings.push('No singing was heard in this song - the pictures follow the beat and the parts of the song only');
    report.song = { bpm: sg.song.bpm, parts: songPlan.parts, lines: lines.length, matched: fx.fixed };
    log(`Song: ${sg.song.bpm} BPM, ${songPlan.parts.map((p) => p.label).filter((x, i, a) => x !== a[i - 1]).join(' → ')}`);
  } else if (opts.scenes?.length) {
    // A/V script: every scene becomes a section; with a recorded VO its lines are found in the recording
    log(vo ? 'Lining the script up with the voice-over…' : 'Timing the script…');
    script = planScript(opts.scenes, voSegs, { voDur, hasVo: !!vo });
    ({ sections, lead, total } = script);
    report.warnings.push(...script.warnings);
  } else if (voSegs?.length) {
    // each spoken line gets the time until the next line; long pauses (music-only stretches) become free sections
    // where shots are chosen by quality and motion instead of stretching the previous line's meaning
    sections = [];
    voSegs.forEach((s, i) => {
      const a = i === 0 ? 0 : lead + s.start, nextStart = i === voSegs.length - 1 ? total : lead + voSegs[i + 1].start;
      const speechEnd = Math.min(nextStart, lead + s.end + 0.4);
      if (nextStart - speechEnd > shot * 1.2) {
        sections.push({ start: a, end: speechEnd, textId: s.id, text: s.en, orig: s.text });
        sections.push({ start: speechEnd, end: nextStart, textId: null, text: null, orig: null });
      } else sections.push({ start: a, end: nextStart, textId: s.id, text: s.en, orig: s.text });
    });
  } else if (opts.outline?.trim()) {
    const lines = opts.outline.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    sections = lines.map((l, i) => ({ start: (total * i) / lines.length, end: (total * (i + 1)) / lines.length, textId: `o${i}`, text: l, orig: l }));
  } else sections = [{ start: 0, end: total, textId: null, text: null }];

  // music: best section + beat grid so cuts land on beats
  let grid = null, musicIn = songPlan ? songPlan.w0 : 0;
  if (music && !songPlan) {
    log('Finding the beat and the best part of the music…');
    grid = await new Promise((ok) => ok(beats(music.path)));
    if (opts.musicBest !== false) {
      const sec = bestSection(music.path, total + endCard);
      if (sec?.in > 0) { musicIn = sec.in; if (grid) grid = { ...grid, first: 0 }; }
    }
  }
  const snapBeat = (t) => {
    if (!grid) return t;
    const k = Math.round((t - grid.first) / grid.period), b = grid.first + k * grid.period;
    return Math.abs(b - t) < grid.period * 0.5 ? b : t;
  };
  const style = opts.editStyle || 'standard';
  let slots = [];
  let energy = null;
  const ref = opts.refStyle?.shots?.length ? opts.refStyle : null;
  if (songPlan) {
    slots = songPlan.slots;
    log(`Cutting to the song: ${slots.length} shots, every cut on a beat, a new picture with every sung line`);
  } else if (ref) {
    // copy a reference video's cutting: its shot lengths in order (repeated if this edit is longer), on the beat when
    // the reference itself cuts on the beat, and what happens on each of its cuts (see refFx). Footage is all yours.
    if (grid && music) energy = energyCurve(music.path, musicIn, total + endCard + 1);
    const snap = ref.onBeat === null || ref.onBeat === undefined || ref.onBeat >= 0.4 ? snapBeat : (x) => x;
    const secAt = (x) => sections.find((s) => x >= s.start && x < s.end) || sections[sections.length - 1];
    let t = 0, k = 0;
    while (t < total - 0.3) {
      const s = ref.shots[k % ref.shots.length];
      let next = Math.min(total, snap(t + s.len));
      if (next - t < 0.3) next = Math.min(total, t + s.len);
      const mid = (t + next) / 2;
      slots.push({ start: t, end: next, sec: secAt(mid), act: actOf(mid, total), energy: energy ? energy.at(mid) : 0.5, refCut: k ? s.cutIn : null });
      t = next; k++;
    }
    if (slots.length) slots[slots.length - 1].end = total;
    report.reference = describeRef(ref);
    report.warnings.unshift(`Cut like the reference (only your footage used): ${report.reference}`);
    log(`Cutting like the reference: ${report.reference}`);
  } else if (grid && music) {
    energy = energyCurve(music.path, musicIn, total + endCard + 1);
    slots = beatSlots({ grid, energy, sections, total, shot, style });
    log(`Cutting on the beat: ${grid.bpm} BPM, ${slots.length} shots`);
  } else {
    for (const s of sections) {
      const len = s.end - s.start, n = Math.max(1, Math.round(len / shot));
      let a = s.start;
      for (let i = 1; i <= n; i++) {
        let b = i === n ? s.end : snapBeat(s.start + (len * i) / n);
        if (b - a < 0.8) continue;
        slots.push({ start: a, end: b, sec: s, act: actOf(a, total) });
        a = b;
      }
      if (slots.length && slots[slots.length - 1].end < s.end) slots[slots.length - 1].end = s.end;
    }
  }
  for (const sl of slots) sl.sp = clamp((+opts.clipSpeed || 1) * (style === 'teaser' && (sl.act === 'intro' || sl.act === 'outro') ? 0.7 : 1), 0.25, 4);
  // speed ramps (speed changes inside a shot): into slow motion right before the drop, whoosh / punch on longer climax
  // shots, a hero slow-down to end on. The source window is sized so the shot still fills its beat-locked slot.
  if (opts.ramps !== false && style !== 'standard' && !songPlan) {
    let n = 0;
    slots.forEach((sl, i) => {
      const L = sl.end - sl.start, next = slots[i + 1], prev = slots[i - 1];
      if (L < 1.3) return;
      if (style === 'teaser' && sl.act === 'build' && next?.act === 'climax') sl.ramp = 'in';
      else if (style === 'teaser' && sl.act === 'outro' && prev?.act !== 'outro') { sl.ramp = 'hero'; sl.sp = clamp(+opts.clipSpeed || 1, 0.25, 4); }
      else if (sl.act === 'climax' && n++ % 3 === 0) sl.ramp = n % 2 ? 'whoosh' : 'punch';
      else if (style === 'montage' && i % 8 === 4) sl.ramp = 'whoosh';
      if (sl.ramp) sl.sp = clamp(sl.sp * rampAvg(RAMPS[sl.ramp].pts), 0.1, 6);
    });
  }
  // teaser / montage: shots without a spoken line are picked for the part of the story they are in
  if (style !== 'standard') {
    for (const sl of slots) if (!sl.sec.textId) sl.sec = { ...sl.sec, textId: `act_${sl.act}`, text: ACT_PROMPTS[sl.act], orig: null, actOnly: true };
  }

  // ---- 4. CLIP: frames + similarities ----
  progress(48);
  log('Looking at the footage (CLIP)…');
  const frames = {};
  done = 0;
  let fpool = [...clips];
  if (opts.quick) {
    // quick: a camera original without a proxy whose frames were never taken is left out instead of being read again
    const ready = (m) => !keyOnly(m) || stock.has(m.id) || (fs.existsSync(path.join(cacheDir, 'agent', 'frames', m.id)) && fs.readdirSync(path.join(cacheDir, 'agent', 'frames', m.id)).some((f) => f.startsWith('done-')));
    const out = fpool.filter((m) => !ready(m));
    if (out.length) { fpool = fpool.filter(ready); clips = clips.filter(ready); skippedIds.push(...out.map((m) => m.id)); report.warnings.push(`Quick mode: ${out.length} more clips without a preview copy were left out - the edit uses ${clips.length}`); }
  }
  skipped = skipsAt(ctx.skips?.() || 0);
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (fpool.length && !skipped()) {
      const m = fpool.shift();
      const go = () => extractFrames(src(m), path.join(cacheDir, 'agent', 'frames', m.id), { duration: m.duration, image: m.kind === 'image', keyOnly: keyOnly(m) });
      frames[m.id] = await (keyOnly(m) ? camLane(go) : go());
      progress(48 + (8 * ++done) / clips.length);
    }
  }));
  if (fpool.length) { const n = clips.length; clips = clips.filter((m) => frames[m.id]?.length); report.warnings.push(`Skipped looking at ${n - clips.length} clips - the edit uses ${clips.length}`); }
  const texts = sections.filter((s) => s.text).map((s) => ({ id: s.textId, text: s.text.slice(0, 300) }));
  if (style !== 'standard') texts.push(...Object.entries(ACT_PROMPTS).map(([k, t]) => ({ id: `act_${k}`, text: t })));
  const reqFile = path.join(cacheDir, 'agent', 'clip-req.json'), outFile = path.join(cacheDir, 'agent', 'clip-out.json');
  fs.writeFileSync(reqFile, JSON.stringify({ cacheDir: path.join(cacheDir, 'agent', 'emb'), embeddings: true, texts, media: clips.map((m) => ({ id: m.id, frames: frames[m.id] })) }));
  let vis = null;
  const c = await run(python, [path.join(root, 'engine', 'clipmatch.py'), reqFile, outFile], { onErr: (l) => { const m = /^PROGRESS (\d+)/.exec(l); if (m) progress(56 + 14 * (+m[1] / 100)); } });
  if (c.code === 0) vis = JSON.parse(fs.readFileSync(outFile, 'utf8')).media;
  else report.warnings.push('Visual matching (CLIP) failed - shots were chosen by quality and motion only');
  progress(70);

  // ---- 5. score windows and fill slots ----
  log('Choosing the best moments…');
  // z-normalise CLIP similarities per text and quality globally (raw CLIP numbers are small and model-specific)
  const zstats = (arr) => { const m = mean(arr), sd = Math.sqrt(mean(arr.map((x) => (x - m) ** 2))) || 1; return { m, sd }; };
  const simZ = {}, allQ = [];
  if (vis) {
    for (const t of texts) { const all = clips.flatMap((m) => vis[m.id]?.sims[t.id] || []); simZ[t.id] = zstats(all); }
    clips.forEach((m) => allQ.push(...(vis[m.id]?.quality || [])));
  }
  const qz = zstats(allQ.length ? allQ : [0]);
  const motionHi = {};
  for (const [id, f] of Object.entries(facts)) motionHi[id] = [...f.motion].sort((a, b) => a - b)[Math.floor(f.motion.length * 0.95)] || 1;
  const used = Object.fromEntries(clips.map((m) => [m.id, []])), uses = Object.fromEntries(clips.map((m) => [m.id, 0]));
  const frameStats = (m, a, b, textId) => {
    const v = vis?.[m.id];
    if (!v || !v.times?.length) return { sim: 0, q: 0 }; // (an unreadable clip has no frames)
    const idx = v.times.map((t, i) => (t >= a - 0.5 && t <= b + 0.5 ? i : -1)).filter((i) => i >= 0);
    const pick = idx.length ? idx : [v.times.reduce((bi, t, i) => (Math.abs(t - (a + b) / 2) < Math.abs(v.times[bi] - (a + b) / 2) ? i : bi), 0)];
    const q = (mean(pick.map((i) => v.quality[i])) - qz.m) / qz.sd;
    if (!textId || !v.sims[textId]) return { sim: 0, q };
    const zs = simZ[textId];
    return { sim: Math.max(...pick.map((i) => (v.sims[textId][i] - zs.m) / zs.sd)), q };
  };
  // Look-alike guard: for every frame, how close it looks to any shot already used (CLIP cosine, 1 = identical).
  // Stops the same moment, the next second of it, or another take of the same scene coming back again and again.
  const emb = {}, dupAt = {};
  for (const m of clips) {
    const e = vis?.[m.id]?.emb;
    if (e?.length) { emb[m.id] = e.map((r) => Float32Array.from(r)); dupAt[m.id] = new Float32Array(e.length); }
  }
  const windowIdx = (m, a, b) => { const v = vis?.[m.id]; if (!v || !v.times?.length) return []; const idx = v.times.map((t, i) => (t >= a - 0.5 && t <= b + 0.5 ? i : -1)).filter((i) => i >= 0); return idx.length ? idx : [v.times.reduce((bi, t, i) => (Math.abs(t - (a + b) / 2) < Math.abs(v.times[bi] - (a + b) / 2) ? i : bi), 0)]; };
  const lookAlike = (m, a, b) => { const d = dupAt[m.id]; if (!d) return 0; const idx = windowIdx(m, a, b); return idx.length ? Math.max(...idx.map((i) => d[i])) : 0; };
  const markUsed = (m, a, b) => {
    const E = emb[m.id]; if (!E) return;
    const idx = windowIdx(m, a, b), look = new Float32Array(E[0].length);
    for (const i of idx) for (let k = 0; k < look.length; k++) look[k] += E[i][k];
    const n = Math.hypot(...look) || 1;
    for (const [id, F] of Object.entries(emb)) {
      const d = dupAt[id];
      for (let i = 0; i < F.length; i++) { let dot = 0; for (let k = 0; k < look.length; k++) dot += F[i][k] * look[k]; dot /= n; if (dot > d[i]) d[i] = dot; }
    }
  };
  const fresh = () => clips.some((m) => !uses[m.id]);
  const nearUsed = (m, a, b) => used[m.id].some(([u0, u1]) => a < u1 + 6 && b > u0 - 6);
  // (bursts of nearly the same photo / take: 0.95 alike costs ~1.4, a copy ~2)
  const dupPenalty = (m, a, b) => { const d = lookAlike(m, a, b); return d > 0.85 ? (d - 0.85) * 14 : 0; };
  // meaning helps up to a point: a frame that matches the words very well but is black / blurry still loses
  const simW = (x) => Math.min(x, 2.2);
  const badQ = (q) => (q < -1.5 ? 2.5 * (-1.5 - q) + 1 : 0);
  const stockSet = new Set(opts.stockIds || []);
  let prev = null;
  for (const [si, slot] of slots.entries()) {
    const L = slot.end - slot.start, tid = slot.sec.textId, SP = slot.sp || 1; // source seconds per timeline second
    let best = null;
    // runners-up for this slot (different clips / far-apart moments) so the report can offer "Change"
    const top = [];
    const consider = (x) => {
      if (!Number.isFinite(x.score)) return; // a broken number must never win a slot
      if (!best || x.score > best.score) best = x;
      const twin = top.findIndex((y) => y.m.id === x.m.id && Math.abs(y.in - x.in) < Math.max(L, 2));
      if (twin >= 0) { if (x.score > top[twin].score) top[twin] = x; } else top.push(x);
      if (top.length > 24) { top.sort((a, b) => b.score - a.score); top.length = 12; }
    };
    for (const m of clips) {
      // every extra use of the same clip costs more (1st repeat ~2, 2nd ~3.7), and much more while unused clips remain
      // stock clips fill gaps: a small handicap so your own footage wins whenever it fits about as well
      const stockPen = stockSet.has(m.id) ? 0.35 : 0;
      const reuse = stockPen + 0.9 * uses[m.id] ** 1.5 + (uses[m.id] && fresh() ? 1.2 : 0) + (prev === m.id ? 0.8 : 0);
      if (m.kind === 'image') {
        const { sim, q } = frameStats(m, 0, 0, tid);
        const s = (tid ? simW(sim) : 0) + 0.45 * q - badQ(q) - reuse - 0.15 - dupPenalty(m, 0, 0) - imageCost(sty);
        consider({ m, in: 0, score: s, sim, q });
        continue;
      }
      const f = facts[m.id];
      if (!f || m.duration < Math.min(L * SP, 1) + 0.2) continue;
      const len = Math.min(L * SP, m.duration - 0.2);
      const cuts = [0, ...f.cuts, m.duration];
      const step = Math.max(0.5, m.duration / 120);
      for (let a = 0.15; a + len <= m.duration - 0.05; a += step) {
        const b = a + len;
        if (used[m.id].some(([u0, u1]) => a < u1 - 0.1 && b > u0 + 0.1)) continue;
        const s0 = Math.floor(a), s1 = Math.max(s0 + 1, Math.ceil(b));
        const mot = mean(f.motion.slice(s0, s1)) / motionHi[m.id], lum = mean(f.luma.slice(s0, s1)), bl = mean(f.blur.slice(s0, s1));
        const crossCut = cuts.some((ct) => ct > a + 0.2 && ct < b - 0.2);
        const { sim, q } = frameStats(m, a, b, tid);
        // movement matters by part: steady for the opening / ending, lots of it for the climax
        const motW = style === 'standard' ? 0.25 : { intro: 0.05, build: 0.25, climax: 0.65, outro: 0.05 }[slot.act] ?? 0.25;
        let s = (tid ? (slot.sec.actOnly ? 0.6 : 1.0) * simW(sim) : 0) + 0.45 * q - badQ(q) + motW * clamp(mot, 0, 1.5) - reuse;
        if (lum < 28 || lum > 238) s -= lum < 14 ? 3 : 1.2; // (near black: never)
        if (bl > 0.6) s -= 0.4 * (bl - 0.6) * 5;
        if (crossCut) s -= 0.45;
        if (nearUsed(m, a, b)) s -= 0.6; // the seconds right next to a shot already in the edit
        s -= dupPenalty(m, a, b);
        consider({ m, in: a, score: s, sim, q, len });
      }
    }
    if (!best) {
      // footage exhausted: reuse the longest clip from a spot not used yet as much as possible
      const m = clips.filter((x) => x.kind === 'video').sort((x, y) => y.duration - x.duration)[0] || clips[0];
      best = { m, in: m.kind === 'video' ? (si * 1.7) % Math.max(0.1, m.duration - L) : 0, score: -9, sim: 0, q: 0 };
      report.warnings.push(`Ran out of fresh footage at ${r3(slot.start)}s - a shot was reused`);
    }
    uses[best.m.id]++;
    if (best.m.kind === 'video') used[best.m.id].push([best.in, best.in + (best.len || L * SP)]);
    markUsed(best.m, best.in, best.m.kind === 'video' ? best.in + (best.len || L * SP) : 0);
    prev = best.m.id;
    slot.pick = best;
    slot.alts = top.filter((x) => x !== best).sort((a, b) => b.score - a.score).slice(0, 5);
  }
  progress(78);

  // ---- 6. build tracks ----
  const V1 = slots.map((s, i) => {
    const p = s.pick, L = s.end - s.start, m = p.m;
    const clip = m.kind === 'image'
      ? { id: uid(), type: 'image', mediaId: m.id, dur: r3(L) }
      : { id: uid(), type: 'video', mediaId: m.id, in: r3(p.in), out: r3(Math.min(m.duration, p.in + L * (s.sp || 1))) };
    // speed up a too-short source window to fill the slot instead of leaving a gap
    // the chosen speed (slow motion / faster); a too-short source window is slowed further to fill the slot
    if (m.kind === 'video') {
      const avg = s.ramp ? rampAvg(RAMPS[s.ramp].pts) : 1, v = (clip.out - clip.in) / (L * avg);
      if (s.ramp) clip.ramp = s.ramp;
      if (Math.abs(v - 1) > 0.02) clip.speed = r3(Math.max(0.25, v));
    }
    if (transStyle === 'cinematic' && i > 0 && s.sec !== slots[i - 1].sec) clip.transitionIn = { type: 'fade', dur: 0.4 };
    report.slots.push({ clipId: clip.id, start: r3(s.start), end: r3(s.end), media: m.name, in: clip.in ?? 0, text: s.sec.orig || null, en: s.sec.text || null,
      match: s.sec.textId ? r3(p.sim) : null, quality: r3(p.q), weak: !!s.sec.textId && !s.sec.actOnly && p.sim < 0.4,
      alts: (s.alts || []).map((x) => ({ mediaId: x.m.id, in: r3(x.in), match: s.sec.textId ? r3(x.sim) : null })) });
    return clip;
  });
  if (songPlan) songFx(V1, slots, fxOn);
  else if (ref) refFx(V1, slots); else if (style !== 'standard') rhythmFx(V1, slots, style, fxOn);
  keepCutsInPlace(V1, media);
  styleMotion(V1, slots, sty); // the style's camera moves on every shot
  // a photo (or clip) of the other shape - an upright phone photo in a 16:9 edit - is shown over a blurred copy of
  // itself instead of between black bars
  {
    const [fw, fh] = { '9:16': [9, 16], '4:5': [4, 5], '1:1': [1, 1] }[opts.aspect] || [16, 9];
    for (const c of V1) {
      const m = media[c.mediaId]; if (!m?.width || !m?.height || c.fit) continue;
      const rot = Math.abs(m.rotation || 0) % 180 === 90, ar = rot ? m.height / m.width : m.width / m.height;
      if (Math.abs(Math.log(ar / (fw / fh))) > 0.2) c.fit = 'blur'; // (4:3 photos in 16:9 too)
    }
  }
  if (V1.length && !songPlan) { V1[0].fadeIn = style === 'teaser' ? 0.8 : 0.4; if (style === 'teaser' && !opts.endText) V1[V1.length - 1].fadeOut = 1.2; }
  if (opts.endText) V1.push({ id: uid(), type: 'title', text: opts.endText, dur: endCard, bg: '#0b2545', fadeOut: 1 });
  // teaser / montage title: kinetic, one word at a time on the opening
  const V2 = opts.title ? [{ id: uid(), type: 'title', text: opts.title, start: 0.3, dur: 3, textStyle: 'center', ...(style !== 'standard' && opts.fx !== false ? { anim: 'words', dur: 3.5 } : {}) }] : [];
  // script SUPERs: on-screen text over their scene (lower third; a super-only scene is a centred title)
  for (const s of sections) {
    if (!s.super) continue;
    const len = s.end - s.start, alone = !s.orig && !s.visual;
    V2.push({ id: uid(), type: 'title', text: s.super, start: r3(s.start + (alone ? 0.2 : 0.4)), dur: r3(clamp(len - 0.6, 1.5, 5)), textStyle: alone ? 'center' : 'lower' });
  }
  const A1 = vo ? [{ id: uid(), type: 'audio', mediaId: vo.id, start: lead, in: 0, volume: 1 }] : [];
  const fullLen = total + endCard;
  const A2 = music ? [{ id: uid(), type: 'audio', mediaId: music.id, start: 0, in: r3(musicIn), loop: true, dur: r3(fullLen), volume: vo ? 0.35 : style === 'standard' ? 0.85 : 1, duck: !!vo, fadeOut: 2.5 }] : [];
  const trackState = {
    V1: { volume: opts.keepSound ? (vo || music ? 0.35 : 1) : vo || music ? (style === 'standard' ? 0.12 : 0) : 1 },
    A1: vo ? { volume: 1, fx: { ...FX_PRESETS.voice.fx } } : {},
    A2: music ? { volume: 1, duckDepth: 14, fx: { ...FX_PRESETS.music.fx } } : {},
  };

  // ---- 7. auto colour ----
  if (opts.autoColor !== false) {
    log('Colour-correcting the chosen shots…');
    const graded = {};
    let k = 0;
    const vids = V1.filter((cl) => cl.mediaId);
    const keyOf = (cl) => `${cl.mediaId}:${Math.round((cl.in || 0) / 10)}`; // nearby moments of one clip share a grade
    const firstOf = new Map();
    for (const cl of vids) if (!firstOf.has(keyOf(cl))) firstOf.set(keyOf(cl), cl);
    const todo = [...firstOf.entries()];
    const colLane = limiter(6);
    await Promise.all(todo.map(([key, cl]) => { const m = media[cl.mediaId]; return colLane(async () => {
      {
        const span = { tin: cl.in || 0, tout: cl.out ?? m.duration ?? 0, image: m.kind === 'image' };
        const raw = await measure(src(m), span);
        let lut = null;
        if (raw && opts.detectLog !== false && looksLog(raw, m)) { const g = guessLogLut(m); if (ctx.luts[g]) lut = g; }
        const stats = lut ? await measure(src(m), { ...span, color: { lut }, luts: ctx.luts }) : raw;
        // with a reference: every shot's colour is pulled to the reference's (channel means / spreads, saturation)
        graded[key] = !stats ? null : ref?.color ? { ...(lut ? { lut } : {}), ...matchGrade(stats, ref.color), ...(ref.color.sat && stats.sat > 0.01 ? { saturation: r3(clamp(ref.color.sat / stats.sat, 0.6, 1.6)) } : {}) }
          : { ...(lut ? { lut } : {}), ...autoGrade(stats, { strength: 0.8 }) };
      }
      progress(80 + (17 * ++k) / todo.length);
    }); }));
    for (const cl of vids) if (graded[keyOf(cl)]) cl.color = JSON.parse(JSON.stringify(graded[keyOf(cl)]));
  }
  // the style's creative grade on top of the balance (contrast / saturation / temperature as that edit had them)
  if (sty?.color) for (const cl of V1) if (cl.type === 'video' || cl.type === 'image') cl.color = { ...(cl.color || {}), ...sty.color };

  // subtitles: shift the VO-relative times by the lead-in
  let subtitles = null;
  if (srtFile && fs.existsSync(srtFile)) {
    const shift = (tc) => {
      const [h, m, rest] = tc.split(':'); const [s, ms] = rest.split(',');
      const t = +h * 3600 + +m * 60 + +s + +ms / 1000 + lead;
      const p = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
      return `${p(t / 3600)}:${p((t % 3600) / 60)}:${p(t % 60)},${p(Math.round((t % 1) * 1000), 3)}`;
    };
    // with a script, the captions use the script's own words (exact spellings) on the recording's timing
    const fromScript = script?.cues?.length ? scriptSrt(script.cues, opts.aspect === '9:16' || opts.aspect === '4:5' ? 4 : 7) : null;
    fs.writeFileSync(srtFile, fromScript || fs.readFileSync(srtFile, 'utf8').replace(/(\d\d:\d\d:\d\d,\d\d\d)/g, shift), 'utf8');
    subtitles = path.basename(srtFile);
  }
  const weak = report.slots.filter((s) => s.weak).length;
  if (weak) report.warnings.push(`${weak} shot${weak > 1 ? 's' : ''} only loosely match what ${songPlan ? 'is sung' : 'the voice-over says'} - check them (marked in the report)`);
  progress(100);
  // sound design: whooshes / hits / a riser into the drop, lined up with the cuts and effects above
  const A3 = opts.sfxLib && Object.keys(opts.sfxLib).length ? autoSfx({ tracks: { V1, V2, A1, A2, A3: [] } }, media, opts.sfxLib) : [];
  if (A3.length) trackState.A3 = { volume: 0.8 };
  // 🎵 the lyrics on screen, word by word as they are sung (Captions panel: style, size, position)
  // with typed lyrics only the lines that matched them are shown (a misheard line on screen is worse than none)
  const capSrc = !songPlan ? [] : songPlan.typedOk ? songPlan.capLines.filter((c) => c.fixed) : songPlan.capLines.filter((c) => !/[�]/.test(c.text));
  // a style with lyric titles: the sung lines become big titles on V2 (instead of captions)
  const styleTitles = songPlan && sty?.lyrics?.titles ? lyricTitles(capSrc, sty, total) : [];
  V2.push(...styleTitles);
  const captions = songPlan && opts.lyricsOnScreen && capSrc.length && !styleTitles.length
    ? { ...defaultCaptions(), cues: cuesFromSegments(capSrc, opts.aspect === '9:16' || opts.aspect === '4:5' ? 4 : 6, 0) } : null;
  const settings = sty ? { look: sty.look.look || { letterbox: '', vignette: 0, grain: 0 }, kenburns: sty.look.kenburns } : null;
  return { tracks: { V1, V2, A1, A2, A3 }, trackState, subtitles, captions, settings, report, duration: r3(fullLen), language: voSegs ? 'detected' : null, skippedIds, aspect: opts.aspect };
}

// ---------------- A/V script -> sections ----------------
// scenes: [{ visual, vo, super, dur }] (engine/script.mjs). voSegs: the recorded VO's sentences ({ start, end, text, en }) or null.
// With a recording, every recorded sentence is given to one script scene, in order, picking the scene whose words it shares most
// (a monotonic alignment, so a missed or changed line cannot scramble the order). Scenes without VO (visual-only rows) use
// the pauses between lines, the intro before the first line or the tail after the last.
const LATIN = /^[\x00-\x7F‘-”–—…]*$/;
const toks = (s) => String(s || '').toLowerCase().replace(/[।॥,.!?;:"'“”‘’()\-–—…]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
export function planScript(scenes, voSegs, { voDur, hasVo }) {
  const warnings = [], estDur = (s) => s.dur ?? (s.vo ? clamp(toks(s.vo).length / 2.4 + 0.8, 2, 30) : 3);
  const clipText = (s, en) => (s.visual && LATIN.test(s.visual) ? s.visual : en || (s.vo && LATIN.test(s.vo) ? s.vo : null));
  const mk = (s, k, start, end, en) => ({ start, end, textId: clipText(s, en) ? `c${k}` : null, text: clipText(s, en)?.slice(0, 300) || null, orig: s.vo || null, visual: s.visual || null, super: s.super || null });
  if (!hasVo || !voSegs?.length) {
    if (hasVo) warnings.push('No speech found in the voice-over - the script\'s timings were used');
    let t = 0;
    const sections = scenes.map((s, k) => { const d = estDur(s); const x = mk(s, k, t, t + d); t += d; return x; });
    if (scenes.some((s) => s.visual && !LATIN.test(s.visual))) warnings.push('Visual descriptions in Hindi cannot be matched to footage without a voice-over recording - those shots were chosen by quality');
    return { sections, lead: 0, total: t, warnings, cues: [] };
  }
  // 1. align recorded sentences to scenes that have VO text
  const voIdx = scenes.map((s, k) => (s.vo ? k : -1)).filter((k) => k >= 0);
  // speech recognition spells Hindi loosely (मन्सिल / मंज़िल, प्रक्रिती / प्रकृति) and a script may be written in Roman
  // Hinglish while the recording is heard in Devanagari ("jungle" / "जंगल"), so both become one Roman sound-key
  // (engine/translit.mjs) and are compared as consonant skeletons (vowels inside words are spelt too freely)
  const fold = (s) => soundKey(s).replace(/\B[aeiouy]/g, '').replace(/\s+/g, '');
  const grams = (s) => { const f = [...fold(s)], g = new Set(); for (let i = 0; i + 2 < f.length; i++) g.add(f.slice(i, i + 3).join('')); return g; };
  const st = voIdx.map((k) => grams(scenes[k].vo)), segG = voSegs.map((g) => grams(g.text));
  const sim = (seg, j) => { const w = segG[voSegs.indexOf(seg)]; if (!w.size || !st[j].size) return 0; let n = 0; for (const x of w) if (st[j].has(x)) n++; return n / w.size; };
  const S = voSegs.length, K = voIdx.length;
  const dp = Array.from({ length: S }, () => new Float64Array(K)), from = Array.from({ length: S }, () => new Int32Array(K));
  for (let i = 0; i < S; i++) {
    let bestPrev = -Infinity, arg = 0;
    for (let k = 0; k < K; k++) {
      if (i > 0 && dp[i - 1][k] > bestPrev) { bestPrev = dp[i - 1][k]; arg = k; }
      // small pull towards the position the sentence would have if the script were spoken evenly
      const prior = -0.15 * Math.abs(i / Math.max(1, S - 1) - k / Math.max(1, K - 1));
      dp[i][k] = sim(voSegs[i], k) + prior + (i > 0 ? bestPrev : 0);
      from[i][k] = arg;
    }
  }
  const owner = new Array(S);
  let k = dp[S - 1].indexOf(Math.max(...dp[S - 1]));
  for (let i = S - 1; i >= 0; i--) { owner[i] = k; k = from[i][k]; }
  const span = voIdx.map(() => null);
  owner.forEach((j, i) => { const g = voSegs[i]; span[j] = span[j] ? { a: span[j].a, b: g.end, segs: [...span[j].segs, g] } : { a: g.start, b: g.end, segs: [g] }; });
  const matched = owner.reduce((n, j, i) => n + (sim(voSegs[i], j) > 0.3 ? 1 : 0), 0);
  if (matched < S * 0.5) warnings.push('The voice-over recording differs a lot from the script text - scenes were spread over the recording in order. Check the timing in the report.');
  const missing = voIdx.filter((_, j) => !span[j]).length;
  if (missing) warnings.push(`${missing} script line${missing > 1 ? 's were' : ' was'} not found in the recording (maybe cut in the final VO) - shown with the next scene`);

  // 2. intro = visual-only scenes before the first VO line, tail = after the last
  const firstVo = voIdx[0], lastVo = voIdx[K - 1];
  const intro = scenes.slice(0, firstVo), tail = scenes.slice(lastVo + 1);
  const lead = Math.max(0.6, intro.reduce((s, x) => s + estDur(x), 0));
  const sections = [], cues = [];
  let t = 0;
  intro.forEach((s, k2) => { const d = (estDur(s) / Math.max(0.01, intro.reduce((a, x) => a + estDur(x), 0))) * lead; sections.push(mk(s, k2, t, t + d)); t += d; });
  // 3. VO scenes (and the visual-only scenes between them share the pause before the next line)
  for (let j = 0; j < K; j++) {
    const k2 = voIdx[j], s = scenes[k2], sp = span[j];
    const nextJ = span.findIndex((x, jj) => jj > j && x);
    const start = sections.length ? t : 0;
    const speechEnd = sp ? lead + sp.b : start + estDur(s);
    const next = nextJ >= 0 ? lead + span[nextJ].a : lead + voDur + 0.6;
    const between = scenes.slice(k2 + 1, nextJ >= 0 ? voIdx[nextJ] : lastVo + 1).filter((x) => !x.vo);
    const gap = Math.max(0, next - speechEnd - 0.3);
    const en = sp ? sp.segs.map((g) => g.en).join(' ') : null;
    if (!sp) { if (sections.length) { const p = sections[sections.length - 1]; p.orig = [p.orig, s.vo].filter(Boolean).join(' '); p.super ||= s.super; } continue; }
    if (between.length && gap > 1) {
      sections.push(mk(s, k2, start, speechEnd + 0.3, en));
      let tb = speechEnd + 0.3;
      between.forEach((b) => { const d = gap / between.length; sections.push(mk(b, scenes.indexOf(b), tb, tb + d)); tb += d; });
      t = next;
    } else {
      const x = mk(s, k2, start, next, en);
      if (between.length) { x.text = x.text || between.map((b) => b.visual).find((v) => v && LATIN.test(v)) || null; x.super = [x.super, ...between.map((b) => b.super)].filter(Boolean).join(' / ') || null; if (x.text && !x.textId) x.textId = `c${k2}`; }
      sections.push(x); t = next;
    }
    cues.push({ text: s.vo, segs: sp.segs.map((g) => ({ a: lead + g.start, b: lead + g.end })) });
  }
  tail.forEach((s, k2) => { const d = estDur(s); sections.push(mk(s, lastVo + 1 + k2, t, t + d)); t += d; });
  return { sections, lead, total: Math.max(t, lead + voDur + 0.6), warnings, cues };
}

// Script captions: each scene's own words, split into lines of n words, spread over the time its sentences are spoken.
function scriptSrt(cues, n) {
  const tc = (s) => { const ms = Math.round(Math.max(0, s) * 1000); const p = (x, w = 2) => String(x).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
  const out = [];
  for (const c of cues) {
    const words = c.text.split(/\s+/).filter(Boolean);
    const lines = [];
    const count = Math.max(1, Math.ceil(words.length / n)), size = Math.ceil(words.length / count); // balanced, no one-word orphan lines
    for (let i = 0; i < words.length; i += size) lines.push(words.slice(i, i + size).join(' '));
    const speech = c.segs.reduce((s, g) => s + (g.b - g.a), 0), total = lines.reduce((s, l) => s + l.length, 0) || 1;
    // walk along the spoken segments, giving each line time in proportion to its length
    let segI = 0, pos = c.segs[0]?.a ?? 0;
    for (const l of lines) {
      let need = (l.length / total) * speech;
      const a = pos;
      while (need > 1e-6 && segI < c.segs.length) {
        const room = c.segs[segI].b - pos;
        if (need <= room) { pos += need; need = 0; } else { need -= room; pos = c.segs[segI].b; segI++; if (segI < c.segs.length) pos = c.segs[segI].a; }
      }
      out.push([a, Math.max(pos, a + 0.4), l]);
    }
  }
  return out.map(([a, b, l], i) => `${i + 1}\n${tc(a)} --> ${tc(b)}\n${l}\n`).join('\n');
}

// ---------------- rhythm: cuts on the music ----------------
// The story in four parts (a teaser's shape): calm opening, build-up, climax on the loudest music, quiet ending.
const ACT_PROMPTS = {
  intro: 'a wide cinematic establishing shot, aerial landscape, calm and beautiful',
  build: 'people and places, a story unfolding, cinematic',
  climax: 'dynamic energetic action, motion, celebration, people moving fast',
  outro: 'a calm beautiful wide shot, sunset, peaceful ending',
};
function actOf(t, total, e = null) {
  const p = t / Math.max(1, total);
  if (p < 0.18) return 'intro';
  if (p > 0.88) return 'outro';
  if (e !== null ? e > 0.68 && p > 0.3 : p > 0.55) return 'climax';
  return 'build';
}
// Cut points on the beat grid. Shot length (in beats) follows the music's energy and the edit style; a new spoken line
// (section start) always gets a cut on the nearest beat so the picture changes with the words.
function beatSlots({ grid, energy, sections, total, shot, style }) {
  let b = grid.period;
  while (b < 0.38) b *= 2; // very fast songs: count in half-time
  while (b > 1.0) b /= 2;
  const first = ((grid.first % b) + b) % b;
  const onBeat = (t) => first + Math.round((t - first) / b) * b;
  const e = (t) => (energy ? energy.at(t) : 0.5);
  const lenBeats = (t) => {
    const x = e(t), act = actOf(t, total, x);
    if (style === 'teaser') return { intro: x > 0.6 ? 4 : 8, build: x > 0.5 ? 2 : 4, climax: x > 0.85 ? 1 : 2, outro: 8 }[act];
    if (style === 'montage') return x > 0.55 ? 1 : 2;
    const base = Math.max(1, Math.round(shot / b));
    return Math.max(1, Math.round(base * (1.3 - 0.6 * x)));
  };
  const must = [...new Set(sections.filter((s) => s.textId && s.start > 0.3).map((s) => +onBeat(s.start).toFixed(3)))].filter((t) => t > 0.3 && t < total - 0.3);
  const cuts = [0];
  let t = 0;
  while (t < total - 0.3) {
    let next = t + lenBeats(t) * b;
    const m = must.find((x) => x > t + 0.3 && x < next + b * 0.5);
    if (m !== undefined) next = m;
    next = Math.min(next, total);
    // climax bursts: a strong hit is cut into two half-beat flashes
    if (style === 'teaser' && next - t <= b * 1.01 && e(t) > 0.9 && Math.round(t / b) % 4 === 0 && next - t > 0.5) cuts.push(+(t + (next - t) / 2).toFixed(3));
    cuts.push(+next.toFixed(3));
    t = next;
  }
  if (total - cuts[cuts.length - 1] > 0.05) cuts.push(total);
  const secAt = (x) => sections.find((s) => x >= s.start && x < s.end) || sections[sections.length - 1];
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], z = cuts[i + 1];
    if (z - a < 0.2) continue;
    const mid = (a + z) / 2;
    out.push({ start: a, end: z, sec: secAt(mid), act: actOf(mid, total, e(mid)), energy: e(mid), beat: b });
  }
  if (out.length) out[out.length - 1].end = total;
  return out;
}

// Teaser / montage finishing: slow push-ins on the opening and ending, punch-in zooms on climax hits,
// dip to black between parts, white flashes into and through the climax, quick whips in montages.
function rhythmFx(V1, slots, style, fx = true) {
  let hits = 0, n = 0;
  V1.forEach((c, i) => {
    const sl = slots[i], L = sl.end - sl.start, prev = slots[i - 1];
    if (c.type === 'video') {
      if (sl.act === 'intro' || sl.act === 'outro') c.keys = { 'transform.zoom': [{ t: 0, v: 1, ease: true }, { t: r3(L), v: 1.08 }] };
      else if (sl.act === 'climax' && sl.energy > 0.72 && hits++ % 2 === 0) c.keys = { 'transform.zoom': [{ t: 0, v: 1.14, ease: true }, { t: r3(Math.min(0.35, L * 0.6)), v: 1.0 }] };
    }
    if (!prev) return;
    if (style === 'teaser') {
      if (prev.act === 'intro' && sl.act !== 'intro') c.transitionIn = { type: 'fadeblack', dur: 0.5 };
      else if (prev.act !== 'climax' && sl.act === 'climax') c.transitionIn = { type: 'fadewhite', dur: 0.2 };
      else if (prev.act === 'climax' && sl.act === 'outro') c.transitionIn = { type: 'fadeblack', dur: 0.7 };
      else if (sl.act === 'climax' && sl.energy - (prev.energy ?? 0) > 0.15) c.transitionIn = { type: 'fadewhite', dur: 0.15 };
    } else if (style === 'montage' && i % 6 === 0) c.transitionIn = { type: i % 12 ? 'hblur' : 'fadewhite', dur: 0.2 };
    // cut effects (public/js/fx.js): they sit on the cut without overlapping, so the beat sync is untouched
    if (!fx || c.type !== 'video') return;
    const tr = c.transitionIn?.type;
    if (style === 'teaser') {
      if (sl.act !== prev.act && (sl.act === 'build' || sl.act === 'outro')) c.cutFx = { type: 'leak', dur: 0.9 };
      else if (sl.act === 'climax' && !tr && n++ % 2 === 0) { const t = ['whip', 'shake', 'flash', c.keys ? 'whip' : 'punch'][(n >> 1) % 4]; c.cutFx = { type: t, dur: CUTFX[t].dur }; }
      else if (sl.act === 'build' && !tr && i % 4 === 0) c.cutFx = { type: 'whip', dur: 0.22 };
    } else if (style === 'montage' && !tr && i % 3 === 0) { const t = ['whip', 'glitch', 'flash', 'rgb', 'shake'][(i / 3) % 5]; c.cutFx = { type: t, dur: CUTFX[t].dur }; }
  });
}

// Reference style: each cut gets what the reference had on its cut (white flash, whip / motion blur, dip to black, dissolve).
function refFx(V1, slots) {
  V1.forEach((c, i) => {
    const t = slots[i]?.refCut; if (!t || i === 0) return;
    if (t === 'flash' || t === 'whip') { if (c.type === 'video' || c.type === 'image') c.cutFx = { type: t, dur: CUTFX[t].dur }; }
    else if (t === 'dip') c.transitionIn = { type: 'fadeblack', dur: 0.4 };
    else if (t === 'fade') c.transitionIn = { type: 'fade', dur: 0.4 };
  });
}

// A transition overlaps two shots, which would pull everything after it earlier (off the beat and off the voice-over).
// Lengthen the shot before by the overlap so every cut stays exactly where it was planned.
function keepCutsInPlace(V1, media) {
  for (let i = 1; i < V1.length; i++) {
    const t = V1[i].transitionIn; if (!t?.dur) continue;
    const p = V1[i - 1];
    if (p.type === 'video') {
      const m = media[p.mediaId], sp = (p.speed || 1) * (rampPts(p) ? rampAvg(rampPts(p)) : 1), room = ((m?.duration ?? p.out) - p.out) / sp;
      const d = Math.min(t.dur, Math.max(0, room - 0.02));
      if (d < 0.08) { delete V1[i].transitionIn; continue; }
      t.dur = r3(d); p.out = r3(p.out + d * sp); t.hA = t.dur; t.hB = 0; // (what the shot before lent - model.js setTransition)
    } else { p.dur = r3((p.dur || 3) + t.dur); t.hA = t.dur; t.hB = 0; }
  }
}
