// agent.mjs - the auto-edit agent. Turns footage + (optional) voice-over, music and an outline into a finished,
// editable multi-track timeline:
//   0. what the editor wrote (opts.intent / notes) -> settings + constraints  intent.mjs (when there)
//   1. analyse every clip (shots, motion, sound, brightness, blur)          analyze.mjs
//   2. transcribe the voice-over (and translate it to English for matching) transcribe.py
//      the music's beats, bars and parts (any music, not only a song edit)   song.py (music.mjs if it fails)
//   3. understand the pictures: CLIP similarity of frames to each VO line   clipmatch.py
//      + a CLIP "is this a good shot" score; shot size / beauty / rejects    vision2.mjs (when there)
//   4. plan: VO lines (or outline sections / beats) -> slots; cuts on the beats, longer shots on bar lines, the story's
//      parts (acts) from the music's energy and parts
//   5. choose the moment for every slot - all slots together (planner.mjs: beam search, constraints, re-edit keeps)
//      and look the plan over (selfcheck.mjs: dark / blurry / repeats / tiny shots fixed, the rest as warnings)
//   6. finish: auto colour (LOG -> LUT), voice clean-up on the VO, ducked music (best part), subtitles,
//      title and end card - all as normal clips the user can change.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { analyzeClip, extractFrames, run } from './analyze.mjs';
import { beats, bestSection, energyCurve } from './music.mjs';
import { measure, autoGrade, looksLog, matchGrade } from './colorstats.mjs';
import { describeRef, describeLooks, refAdjustLayers } from './refstyle.mjs';
import { guessLogLut } from './lutgen.mjs';
import { FX_PRESETS } from '../public/js/audiofx.js';
import { uid, RAMPS, rampAvg, rampPts, layoutV1 } from '../public/js/model.js';
import { soundKey } from './translit.mjs';
import { CUTFX, autoSfx } from '../public/js/fx.js';
import { fixLyrics, planSong, songFx } from './songplan.mjs';
import { styleMotion, lyricTitles } from './editstyle.mjs';
import { cuesFromSegments, defaultCaptions } from '../public/js/captions.js';
import { loadPeople } from './people.mjs';

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
// the agent's own modules are loaded fresh when they change (the server re-imports agent.mjs the same way), and the
// parts other people build (vision2.mjs, intent.mjs) are optional: everything works while they are missing
const here = (f) => new URL(`./${f}`, import.meta.url);
async function fresh(f) { return import(`${here(f).href}?v=${Math.round(fs.statSync(here(f)).mtimeMs)}`); }
async function optional(f) { try { if (!fs.existsSync(here(f))) return null; return await fresh(f); } catch { return null; } }

// 🗣 What the editor wrote ("pehle CM ka shot, end mein logo, thoda tez", or the notes) -> settings and constraints.
// Settings the text asked for are applied (opts.intentApplied: only where the request left them open);
// constraints are merged (what the request says wins, must / avoid lists are joined). Done once per opts.
export async function applyIntent(opts, { media = {}, cacheDir = null, llm = true } = {}) {
  if (opts._intent) return opts._intent;
  const text = String(opts.intent || opts.notes || '').trim();
  let parsed = null;
  if (text) {
    const mod = await optional('intent.mjs');
    if (mod?.parseIntent) {
      try {
        const people = cacheDir ? loadPeople(cacheDir).people.filter((p) => p.name).map((p) => ({ name: p.name, key: p.key })) : [];
        // (the edit on the timeline: its length for "last 10 sec", its shots for "shot 3" / "the last shot")
        const pv = opts.prev, duration = pv?.slots?.length ? Math.max(...pv.slots.map((x) => x.end)) : 0;
        parsed = await mod.parseIntent(text, { mode: opts.mode === 'reedit' || opts.reedit ? 'reedit' : 'new', opts, media: Object.values(media), people, duration, fps: opts.fps || 25, slots: pv?.report?.length || 0, llm, timeoutMs: 20000 });
      } catch (e) { parsed = { notes: [text], understood: [], error: String(e?.message || e) }; }
    } else parsed = { notes: [text], understood: [], via: null };
  }
  // (the text is the newest word: it wins over the settings sent with it - a re-edit sends the last edit's settings -
  // unless the window says it already applied it and the user changed a setting after: opts.intentApplied)
  for (const [k, v] of Object.entries(parsed?.opts || {})) if (!opts.intentApplied || opts[k] === undefined || opts[k] === null || opts[k] === '') opts[k] = v;
  const pc = parsed?.constraints || {}, oc = opts.constraints || {};
  const uniq = (...l) => [...new Set(l.flat().filter(Boolean))];
  const C = { ...pc, ...oc, first: oc.first || pc.first || null, last: oc.last || pc.last || null, must: uniq(pc.must || [], oc.must || []), avoid: uniq(pc.avoid || [], oc.avoid || []) };
  opts.constraints = C;
  return (opts._intent = { understood: parsed?.understood || [], notes: parsed?.notes || [], changes: parsed?.changes || [], via: parsed?.via || null });
}

// ---------------- caches of the voice-over and the music (shared by the edit and the quick Plan preview) ----------------
const voFiles = (cacheDir, vo, opts) => {
  const model = opts.whisperModel || 'large-v3-turbo', lang = opts.voLang || 'hi';
  // a voice-over already heard (same file, model, language and names) is reused: re-edits start right away
  const key = crypto.createHash('sha1').update(JSON.stringify([vo.path, vo.size, vo.mtime, model, lang, opts.names || ''])).digest('hex').slice(0, 12);
  return { model, lang, key, tjson: path.join(cacheDir, 'agent', `vo-${key}.json`), ejson: path.join(cacheDir, 'agent', `vo-${key}.en.json`) };
};
// align English segments to the original ones by time (translation can merge/split sentences): each English segment
// goes to the one line it overlaps most - a mere touch at the edges used to add the line before's English to the next,
// so from the middle of a long VO the pictures were chosen for the previous sentence. A line left without any takes
// the English nearest in time.
function alignVo(orig, eng) {
  const lines = orig.segments.filter((s) => s.text.trim());
  const ov = (e, s) => Math.max(0, Math.min(e.end, s.end) - Math.max(e.start, s.start));
  const got = lines.map(() => []);
  for (const e of eng === orig ? [] : eng.segments) {
    if (!e.text?.trim()) continue;
    let best = -1, bo = 0;
    lines.forEach((s, k) => { const o = ov(e, s); if (o > bo) { bo = o; best = k; } });
    if (best >= 0) got[best].push(e.text.trim());
  }
  const mid = (x) => (x.start + x.end) / 2;
  return lines.map((s, i) => {
    let en = got[i].join(' ').trim();
    if (!en && eng !== orig && eng.segments.length) en = eng.segments.reduce((a, b) => (Math.abs(mid(b) - mid(s)) < Math.abs(mid(a) - mid(s)) ? b : a)).text.trim();
    return { id: `s${i}`, start: s.start, end: s.end, text: s.text, en: en || s.text };
  });
}
// a heard voice-over from the cache only (null: not heard yet)
export function readVoCache(cacheDir, vo, opts) {
  const f = voFiles(cacheDir, vo, opts);
  if (!fs.existsSync(f.tjson)) return null;
  const orig = JSON.parse(fs.readFileSync(f.tjson, 'utf8'));
  const eng = orig.language !== 'en' && fs.existsSync(f.ejson) ? JSON.parse(fs.readFileSync(f.ejson, 'utf8')) : orig;
  return { voSegs: alignVo(orig, eng), voDur: vo.duration || orig.duration };
}
const songDir = (cacheDir, music) => path.join(cacheDir, 'song', crypto.createHash('sha1').update(JSON.stringify([music.path, music.size, music.mtime])).digest('hex').slice(0, 12));
const lyricFiles = (dir, opts) => {
  const lang = opts.voLang && opts.voLang !== 'auto' ? opts.voLang : 'hi', model = opts.whisperModel || 'large-v3-turbo';
  // (v3: the song heard in ~30 s pieces, each line on its own - see transcribe.py --song)
  return { lang, model, lj: path.join(dir, `lyrics3-${model}-${lang}.json`), le: path.join(dir, `lyrics3-${model}-${lang}.en.json`) };
};
// the music as song.py heard it (+ the lyrics of a song edit) from the cache only; null: not studied yet
export function readSongCache(cacheDir, music, opts, songMode = false) {
  const dir = songDir(cacheDir, music), sj = path.join(dir, 'song.json');
  if (!fs.existsSync(sj)) return null;
  const song = JSON.parse(fs.readFileSync(sj, 'utf8'));
  let segs = [], en = [];
  if (songMode) {
    const { lj, le } = lyricFiles(dir, opts);
    if (fs.existsSync(lj)) segs = JSON.parse(fs.readFileSync(lj, 'utf8')).segments || [];
    en = fs.existsSync(le) ? JSON.parse(fs.readFileSync(le, 'utf8')).segments || [] : segs;
  }
  return { song, segs, en, dir };
}

// ctx: { opts, media: {id: item}, cacheDir, subsDir, python, root, luts, log(msg), progress(pct), remote, lanes, project }
// (remote / lanes: 🖥 helper PCs - analyze.mjs runs a clip's FFmpeg on whichever helper is free; lanes() = how many at once)
export async function runAgent(ctx) {
  const { opts, media, cacheDir, python, root, log, progress } = ctx;
  const t0 = Date.now();
  // ⏱ how long each step took (report.plan.timing, seconds) - a re-edit from the caches should take seconds
  const timing = {}; let tLap = t0;
  const lap = (k) => { const n = Date.now(); timing[k] = Math.round((n - tLap) / 100) / 10; tLap = n; };
  let clips = (opts.clips || []).map((id) => media[id]).filter((m) => m && (m.kind === 'video' || m.kind === 'image'));
  if (!clips.length) throw new Error('Choose at least one video or photo for the agent');
  const vo = opts.vo && media[opts.vo], music = opts.music && media[opts.music];
  // ❗ a voice-over / music that cannot be heard: said plainly, before minutes of work
  for (const [m, what] of [[vo, 'voice-over'], [music, 'music']]) {
    if (!m) continue;
    if (m.status === 'error') throw new Error(`The ${what} "${m.name}" cannot be read: ${m.error || 'damaged or unsupported file'}`);
    if (m.kind === 'image' || (m.hasAudio === false)) throw new Error(`The ${what} "${m.name}" has no sound in it - pick a file with audio (MP3, WAV, M4A, or a video with sound)`);
    if (!fs.existsSync(m.path)) throw new Error(`The ${what} "${m.name}" is offline (not found at ${m.path}) - relink it in Media`);
  }
  const src = (m) => (m.proxyPath && fs.existsSync(m.proxyPath) ? m.proxyPath : m.path);
  const keyOnly = (m) => src(m) === m.path && m.kind === 'video'; // no proxy yet: read only the keyframes of the camera file
  const report = { warnings: [], slots: [] };
  // 🗣 the editor's words -> settings + constraints (first / last shot, must / avoid, keep, music volume)
  const said = await applyIntent(opts, { media, cacheDir });
  const C = opts.constraints || {};
  if (said.understood.length) report.understood = said.understood;
  if (said.notes.length) report.notes = said.notes;
  // ♻ a re-edit keeps the last edit's shots where nothing asks for a change (opts.prev: the server reads the last report)
  const reedit = opts.mode === 'reedit' || !!opts.reedit;
  // (the parser's keep counts for a re-edit only: a new edit asked for in words starts fresh unless opts.keep says otherwise)
  let keep = opts.keep || (reedit ? C.keep || 'shots' : 'none');
  const prior = keep !== 'none' && opts.prev?.slots?.length ? { keep, slots: opts.prev.slots } : null;
  if (!prior) keep = 'none';
  // 🎨 a learnt edit style (engine/editstyle.mjs): shot length, footage, moves, grade, cuts and lyric titles like that edit
  const sty = opts.styleProfile || null;
  const fxOn = opts.fx !== false && !(sty && sty.cuts.fx < 0.05);
  const transStyle = sty ? (sty.cuts.transitions > 0.3 ? 'cinematic' : 'cuts') : opts.style;
  if (sty) report.style = sty.name;

  // ---- 2. voice-over (started first: it is heard while the clips are analysed) ----
  const voJob = vo ? hearVo() : Promise.resolve(null);
  voJob.catch(() => {}); // awaited below; this only stops an early failure from being reported as unhandled
  // 🎵 the music is studied meanwhile too (engine/song.py: beats, bars, parts) - for every edit with music, not only a
  // song edit; a song edit also hears the sung lyrics. (After the voice-over: both use the GPU.)
  const songMode = opts.editStyle === 'song' && !!music;
  const songJob = music ? (async () => { if (vo) await voJob.catch(() => {}); return hearSong(); })() : null;
  songJob?.catch(() => {});
  async function hearSong() {
    const dir = songDir(cacheDir, music), sj = path.join(dir, 'song.json');
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(sj)) {
      log(songMode ? 'Listening to the song: beat, bars, verses and chorus, the singing voice on its own…' : 'Listening to the music: beat, bars and parts…');
      const r = await run(python, [path.join(root, 'engine', 'song.py'), music.path, dir, sj], {});
      if (r.code !== 0 || !fs.existsSync(sj)) throw new Error(`Could not read the song: ${r.stderr.slice(-300)}`);
    }
    const song = JSON.parse(fs.readFileSync(sj, 'utf8'));
    let segs = [], en = [];
    if (songMode && song.vocals && fs.existsSync(song.vocals) && opts.songLyrics !== false) {
      const { lang, model, lj, le } = lyricFiles(dir, opts);
      if (!fs.existsSync(lj)) {
        log(`Hearing the lyrics (${model} model)…`);
        const r = await run(python, [path.join(root, 'engine', 'transcribe.py'), song.vocals, '--lang', lang, '--task', 'transcribe', '--model', model, '--words', '4', '--song',
          '--out', path.join(dir, 'lyrics.srt'), '--json', lj, ...(lang !== 'en' ? ['--translate-json', le] : [])], {});
        if (r.code !== 0) report.warnings.push('Could not hear the lyrics - the cuts follow the beat and the parts of the song only');
      }
      if (fs.existsSync(lj)) segs = JSON.parse(fs.readFileSync(lj, 'utf8')).segments || [];
      en = fs.existsSync(le) ? JSON.parse(fs.readFileSync(le, 'utf8')).segments || [] : segs;
    }
    return { song, segs, en, dir };
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
  // (🖥 with helper PCs on, as many clips at once as they have slots - each reads the NAS itself, and the editor keeps
  // the NAS from being overrun: farm nasMax)
  const remote = ctx.remote || null, lanes = Math.max(6, Math.min(48, +ctx.lanes?.() || 0));
  const camLane = limiter(remote && lanes > 6 ? lanes : +opts.camReads || 2);
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (pool.length && !skipped()) {
      const m = pool.shift();
      const go = () => analyzeClip(src(m), path.join(cacheDir, 'analysis', `${m.id}.json`), { hasAudio: m.hasAudio, duration: m.duration, keyOnly: keyOnly(m), framesDir: path.join(cacheDir, 'agent', 'frames', m.id), remote });
      facts[m.id] = await (cost(m) === 2 ? camLane(go) : go());
      progress(2 + (23 * ++done) / clips.length);
      if (pool.length && done % 10 === 0) log(`Analysing clips… ${done}/${clips.length} (press Skip to edit with these)`);
    }
  }));
  lap('analyse');
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
    const { model, lang, key, tjson, ejson } = voFiles(cacheDir, vo, opts);
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
    voSegs = alignVo(orig, eng);
    if (!voSegs.length) report.warnings.push('No speech found in the voice-over file');
    if (wantSubs && !heard && fs.existsSync(srtFile)) fs.copyFileSync(srtFile, srtCache);
    if (!wantSubs) { fs.rmSync(srtFile, { force: true }); srtFile = null; }
    return { voSegs, voDur, srtFile };
  }
  progress(45);
  lap('voiceover');

  // ---- 3. plan sections and slots ----
  let sg = null;
  if (songJob) {
    if (songMode) sg = await songJob; // (a song edit cannot be made without it)
    else sg = await songJob.catch((e) => { report.warnings.push(`Could not study the music (${String(e.message).slice(0, 120)}) - its beat was found the simple way`); return null; });
  }
  // ✂ a re-edit of only part of the edit (constraints.scope): the rest of the last edit stays exactly as it is
  // (a part only in a re-edit: an old "0:10 se 0:25" left in the settings must not cut a new edit down to a stretch)
  const scope = reedit ? scopeOf(C.scope, opts.prev, media) : null;
  if (reedit && C.scope && C.scope.kind && C.scope.kind !== 'all' && !scope) report.warnings.push('The part to re-edit could not be found on the timeline - the whole edit was re-edited');
  lap('music');
  const T = planTimeline({ opts, vo, music, voSegs, voDur, sg, sty, report, log, prior: scope ? null : prior, media });
  const { sections, total, lead, script, songPlan, musicIn, style, ref, mb } = T;
  const endCard = scope ? 0 : T.endCard;
  const slots = scope ? scopeSlots(T.slots, scope, sections) : T.slots;
  if (scope) log(`Re-editing only ${scope.label} (${slots.length} new shot${slots.length > 1 ? 's' : ''}); the rest stays as it is`);

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
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (fpool.length && !skipped()) {
      const m = fpool.shift();
      const go = () => extractFrames(src(m), path.join(cacheDir, 'agent', 'frames', m.id), { duration: m.duration, image: m.kind === 'image', keyOnly: keyOnly(m), remote });
      frames[m.id] = await (keyOnly(m) ? camLane(go) : go());
      progress(48 + (8 * ++done) / clips.length);
    }
  }));
  lap('frames');
  if (fpool.length) { const n = clips.length; clips = clips.filter((m) => frames[m.id]?.length); report.warnings.push(`Skipped looking at ${n - clips.length} clips - the edit uses ${clips.length}`); }
  const texts = sections.filter((s) => s.text).map((s) => ({ id: s.textId, text: s.text.slice(0, 300), orig: s.orig || s.text }));
  if (style !== 'standard') texts.push(...Object.entries(ACT_PROMPTS).map(([k, t]) => ({ id: `act_${k}`, text: t, orig: t })));
  // the first / last shot asked for in words ("pehle khet ka shot") is matched like a line
  if (C.first?.text) texts.push({ id: '_first', text: String(C.first.text).slice(0, 300), orig: String(C.first.text) });
  if (C.last?.text) texts.push({ id: '_last', text: String(C.last.text).slice(0, 300), orig: String(C.last.text) });
  // (what kind of shot: an aerial / drone view - so the edit does not run on drone shots alone)
  texts.push({ id: '_aerial', text: 'an aerial drone shot looking straight down from high above the ground', orig: 'an aerial drone shot looking straight down from high above the ground' });
  const reqFile = path.join(cacheDir, 'agent', 'clip-req.json'), outFile = path.join(cacheDir, 'agent', 'clip-out.json');
  // 🎯 a reference: a frame from the middle of each of its shots goes to CLIP with the footage, so each slot can prefer
  // the moment that LOOKS like its reference shot (subject, framing, colour) - it used to copy only the shot lengths and
  // cut effects and pick pictures by the voice-over's words alone, so the edit hardly looked like the reference
  const refMedia = ref && opts.reference ? media[opts.reference] : null, refId = refMedia ? `ref-${refMedia.id}` : null;
  let refFrames = [];
  if (refMedia && ref.shots.some((s) => Number.isFinite(s.at))) {
    const dir = path.join(cacheDir, 'agent', refId);
    fs.mkdirSync(dir, { recursive: true });
    for (const [k, s] of ref.shots.entries()) {
      if (!Number.isFinite(s.at)) continue;
      const f = path.join(dir, `${String(k).padStart(3, '0')}.jpg`);
      if (!fs.existsSync(f)) await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(s.at), '-i', refMedia.path, '-frames:v', '1', '-vf', 'scale=-2:224', f]);
      if (fs.existsSync(f)) refFrames.push({ t: k, path: f });
    }
  }
  fs.writeFileSync(reqFile, JSON.stringify({ cacheDir: path.join(cacheDir, 'agent', 'emb'), embeddings: true, texts: texts.map(({ id, text }) => ({ id, text })),
    media: [...clips.map((m) => ({ id: m.id, frames: frames[m.id] })), ...(refFrames.length ? [{ id: refId, frames: refFrames }] : [])] }));
  let vis = null;
  // (the same lines and the same frames as a run before - a re-edit: its answer is reused, the model is not loaded again)
  const reqKey = crypto.createHash('sha1').update(fs.readFileSync(reqFile)).digest('hex').slice(0, 16), keptOut = path.join(cacheDir, 'agent', `clip-out-${reqKey}.json`);
  const c = fs.existsSync(keptOut) ? { code: 0 } : await run(python, [path.join(root, 'engine', 'clipmatch.py'), reqFile, outFile], { onErr: (l) => { const m = /^PROGRESS (\d+)/.exec(l); if (m) progress(56 + 12 * (+m[1] / 100)); } });
  if (c.code === 0 && fs.existsSync(keptOut)) vis = JSON.parse(fs.readFileSync(keptOut, 'utf8')).media;
  else if (c.code === 0) {
    vis = JSON.parse(fs.readFileSync(outFile, 'utf8')).media;
    // only the newest answer is kept (one per project)
    for (const f of fs.readdirSync(path.join(cacheDir, 'agent'))) if (/^clip-out-[0-9a-f]{16}\.json$/.test(f)) fs.rmSync(path.join(cacheDir, 'agent', f), { force: true });
    try { fs.copyFileSync(outFile, keptOut); } catch {}
  } else report.warnings.push('Visual matching (CLIP) failed - shots were chosen by quality and motion only');
  progress(68);
  lap('clip');

  // 👁 vision2 (when installed): shot size, beauty, sharpness, faces, unusable clips, and the lines matched to the
  // pictures straight from Hindi / English. Without it the CLIP numbers above are used alone.
  const { v2, v2sims } = await lookCloser({ opts, clips, texts, cacheDir, project: ctx.project, log, progress, report, lookPeople: ctx.lookPeople, remote: ctx.visionRemote || null,
    // (a re-edit uses what was looked at before, even by an older vision2: only clips never looked at are analysed)
    cacheOnly: reedit });
  optional('vision2.mjs').then((m) => m?.stopVision?.()).catch(() => {}); // (the GPU is free for the colour step and the next job)
  progress(76);
  lap('vision2');

  // ---- 5. choose the shots: all slots together ----
  // (inside a re-edited part: a new pace keeps its shots where they still fit, any other change looks for other shots)
  const paceChanged = said.changes.some((x) => x.key === 'pace') || (!!opts.prev?.opts?.pace && opts.prev.opts.pace !== opts.pace);
  const scopePrior = scope && opts.prev?.slots?.length ? { keep: paceChanged ? 'shots' : 'avoid', slots: opts.prev.slots } : null;
  log(prior ? `Choosing the best moments (keeping ${keep === 'all' ? 'every shot' : 'the shots nothing asks to change'})…` : 'Choosing the best moments…');
  const { planShots, holdStrong } = await fresh('planner.mjs');
  const plan = planShots({ slots, clips, facts, vis, texts, v2, v2sims, opts, style, sty, ref, refId, cacheDir, root, constraints: scope ? { ...C, first: null, last: null } : C, report, songMode: !!songPlan,
    prior: scope ? scopePrior : prior, fixed: scope ? scope.fixed : null });
  // a beautiful shot is held one beat longer (the next shot of the same idea gives up that beat; cuts stay on the beat)
  const held = keep !== 'all' && opts.hold !== false && !ref ? holdStrong(slots, facts) : 0;
  // 🔍 look the plan over: dark / blurry / repeated / tiny shots fixed, the rest as plain warnings
  const { selfCheck } = await fresh('selfcheck.mjs');
  const check = selfCheck({ slots, facts, v2, voSegs, lead, total, fullLen: total + endCard, music, musicIn, song: sg?.song || null, songMode: !!songPlan });
  if (check.fixes.length) log(`Self-check fixed ${check.fixes.length}: ${check.fixes.slice(0, 3).join(', ')}`);
  report.plan = { beam: plan.beam, candidates: plan.candidates, ms: plan.ms, held, kept: plan.kept, keep, fixed: check.fixes, beats: mb?.src || null, bpm: mb?.bpm || null };
  report.warnings.push(...check.warnings);
  // 🎯 how close to the reference: shots whose picture clearly looks like their reference shot (z > 0.5 among the footage)
  if (ref && refId && vis?.[refId]?.emb?.length) {
    const n = slots.filter((x) => x.refK !== undefined).length, close = slots.filter((x) => (x.pick?.rl ?? 0) > 0.5).length;
    report.refMatch = { shots: n, close };
    report.warnings.unshift(`Looks like the reference: ${close} of ${n} shots show what its shot shows (framing, subject, colour)${close < n * 0.6 ? ' - for the rest your footage has nothing close; shoot / add clips like those reference shots for a closer copy' : ''}`);
  }
  progress(78);
  lap('plan');

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
    if (transStyle === 'cinematic' && i > 0 && (s.sec.textId !== slots[i - 1].sec.textId || s.sec.start !== slots[i - 1].sec.start)) clip.transitionIn = { type: 'fade', dur: 0.4 };
    report.slots.push({ clipId: clip.id, start: r3(s.start), end: r3(s.end), media: m.name, mediaId: m.id, in: clip.in ?? 0, text: s.sec.orig || null, en: s.sec.text || null,
      match: s.sec.textId ? r3(p.sim) : null, quality: r3(p.q), ...(s.who?.length ? { who: s.who } : {}), weak: !!s.sec.textId && !s.sec.actOnly && p.sim < 0.4,
      act: s.act, ...(s.run !== undefined ? { run: s.run } : {}), ...(p.size ? { size: p.size } : {}), ...(p.kind ? { kind: p.kind } : {}), ...(p.beauty !== undefined ? { beauty: r3(p.beauty) } : {}), ...(p.prior ? { kept: true } : {}),
      alts: (s.alts || []).map((x) => ({ mediaId: x.m.id, in: r3(x.in), match: s.sec.textId ? r3(x.sim) : null })) });
    return clip;
  });
  if (songPlan) songFx(V1, slots, fxOn);
  else if (ref) refFx(V1, slots); else if (style !== 'standard') rhythmFx(V1, slots, style, fxOn);
  if (scope) V1.forEach((c, i) => { if (i === 0 || slots[i].run !== slots[i - 1].run) delete c.transitionIn; }); // (the cut into a re-edited part stays a cut)
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
  if (V1.length && !songPlan && !scope) { V1[0].fadeIn = style === 'teaser' ? 0.8 : 0.4; if (style === 'teaser' && !opts.endText && !endCard) V1[V1.length - 1].fadeOut = 1.2; }
  if (endCard) V1.push({ id: uid(), type: 'title', text: opts.endText || '', dur: endCard, bg: '#0b2545', fadeOut: 1 });
  // teaser / montage title: kinetic, one word at a time on the opening
  const V2 = opts.title ? [{ id: uid(), type: 'title', text: opts.title, start: 0.3, dur: 3, textStyle: 'center', ...(style !== 'standard' && opts.fx !== false ? { anim: 'words', dur: 3.5 } : {}) }] : [];
  // script SUPERs: on-screen text over their scene (lower third; a super-only scene is a centred title)
  for (const s of sections) {
    if (!s.super) continue;
    const len = s.end - s.start, alone = !s.orig && !s.visual;
    V2.push({ id: uid(), type: 'title', text: s.super, start: r3(s.start + (alone ? 0.2 : 0.4)), dur: r3(clamp(len - 0.6, 1.5, 5)), textStyle: alone ? 'center' : 'lower' });
  }
  // "end mein logo": the logo (a photo in the project) on the end card
  if (T.logo && !scope) V2.push({ id: uid(), type: 'image', mediaId: T.logo.id, start: r3(total + 0.2), dur: r3(Math.max(1, endCard - 0.4)), fadeOut: 0.6 });
  const A1 = vo ? [{ id: uid(), type: 'audio', mediaId: vo.id, start: lead, in: 0, volume: 1 }] : [];
  const fullLen = total + endCard;
  const mv = Number.isFinite(+C.musicVolume) && C.musicVolume !== null && C.musicVolume !== '' ? clamp(+C.musicVolume, 0, 1) : null;
  const A2 = music ? [{ id: uid(), type: 'audio', mediaId: music.id, start: 0, in: r3(musicIn), loop: true, dur: r3(fullLen), volume: mv ?? (vo ? 0.35 : style === 'standard' ? 0.85 : 1), duck: !!vo, fadeOut: 2.5 }] : [];
  const trackState = {
    V1: { volume: opts.keepSound ? (vo || music ? 0.35 : 1) : vo || music ? (style === 'standard' ? 0.12 : 0) : 1 },
    A1: vo ? { volume: 1, fx: { ...FX_PRESETS.voice.fx } } : {},
    A2: music ? { volume: 1, duckDepth: 14, fx: { ...FX_PRESETS.music.fx } } : {},
  };

  lap('tracks');
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
        // (a damaged file can keep FFmpeg decoding for ever: a shot that is not measured in 45 s keeps its own colour)
        const timed = (p) => Promise.race([p, new Promise((ok) => setTimeout(() => ok(null), 45000))]);
        const raw = await timed(measure(src(m), span));
        let lut = null;
        if (raw && opts.detectLog !== false && looksLog(raw, m)) { const g = guessLogLut(m); if (ctx.luts[g]) lut = g; }
        const stats = lut ? await timed(measure(src(m), { ...span, color: { lut }, luts: ctx.luts })) : raw;
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
  const A3 = !scope && opts.sfxLib && Object.keys(opts.sfxLib).length ? autoSfx({ tracks: { V1, V2, A1, A2, A3: [] } }, media, opts.sfxLib) : [];
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
  // 🎚 the reference's effects (black & white, vignette, grain, bars, blur, a warmer / cooler part) as adjustment layers
  // over the matching shots - the editor puts them on a free video track above the story
  const refLooks = ref ? refAdjustLayers(ref, slots) : [];
  if (ref) report.warnings.unshift(`Reference ${describeLooks(ref)}${refLooks.length ? ` - ${refLooks.length} adjustment layer${refLooks.length > 1 ? 's' : ''} copy them` : ''}`);
  report.acts = actsOf(slots, total);
  report.plan.secs = Math.round((Date.now() - t0) / 1000);
  lap('finish'); report.plan.timing = timing;
  if (scope) return mergeScope({ scope, V1, report, opts, media, prevSlots: opts.prev.report || [], fullLen });
  return { refLooks, tracks: { V1, V2, A1, A2, A3 }, trackState, subtitles, captions, settings, report, duration: r3(fullLen), language: voSegs ? 'detected' : null, skippedIds, aspect: opts.aspect };
}

// 👁 vision2.mjs (Phase B, optional): shot size / beauty / sharpness / faces / rejects per clip (cache/vision2/<id>.json)
// and multilingual line-to-picture scores. Returns { v2: { mediaId: data }, v2sims: { textId: { mediaId: [ { t, sim } ] } } }.
async function lookCloser({ opts, clips, texts, cacheDir, project, log, progress, report, lookPeople, remote, cacheOnly = false }) {
  const v2 = {}, out = { v2, v2sims: null };
  const read = () => { for (const m of clips) { const f = path.join(cacheDir, 'vision2', `${m.id}.json`); if (v2[m.id] || !fs.existsSync(f)) continue; try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (d?.samples) v2[m.id] = d; } catch {} } };
  const mod = opts.vision2 === false ? null : await optional('vision2.mjs');
  if (!mod?.analyzeVision) { read(); return out; } // (a cache made earlier still helps)
  const fresh = cacheOnly ? clips.filter((m) => !fs.existsSync(path.join(cacheDir, 'vision2', `${m.id}.json`))) : clips;
  if (!fresh.length) { read(); if (mod.textScores && texts.length && Object.keys(v2).length) await scores(); return out; }
  // (the local LLM - the parser's - holds ~3 GB of the GPU; vision2 needs ~1.8 GB of what is left)
  await optional('llm.mjs').then((l) => l?.status?.().running && l.stop()).catch(() => {});
  log(`Looking closer at the footage: shot sizes, beauty, faces, unusable clips${fresh.length < clips.length ? ` (${fresh.length} new clip${fresh.length > 1 ? 's' : ''})` : ''}…`);
  const pr = (p) => progress(68 + 7 * clamp(+p > 1 ? +p / 100 : +p || 0, 0, 1));
  try {
    // (faces: the server's people scan runs for clips it has not seen - lookPeople; the GPU is freed when the run ends)
    const r = await mod.analyzeVision(project, fresh, { onProgress: pr, cacheDir, log, ...(lookPeople ? { lookPeople } : {}), ...(remote ? { remote } : {}) });
    if (r && typeof r === 'object') for (const [id, d] of Object.entries(r)) if (d?.samples) v2[id] = d;
    const nErr = r?.errors ? Object.keys(r.errors).length : 0;
    if (nErr) report.warnings.push(`The closer look failed on ${nErr} clip${nErr > 1 ? 's' : ''} - those were chosen with CLIP only`);
  } catch (e) { report.warnings.push(`The closer look at the footage failed (${String(e?.message || e).slice(0, 120)}) - shots were chosen with CLIP only`); }
  read();
  if (mod.textScores && texts.length && Object.keys(v2).length) await scores();
  return out;
  async function scores() {
    try {
      // (one call with every clip: the scores are z-scored over the clips given. Kept per lines + clips + their vision2
      // files, so a re-edit does not load the model again just to get the same numbers)
      const lines = texts.map((t) => t.orig || t.text), ids = clips.map((m) => m.id);
      const stamp = ids.map((id) => { try { return Math.round(fs.statSync(path.join(cacheDir, 'vision2', `${id}.npy`)).mtimeMs); } catch { return 0; } });
      const key = crypto.createHash('sha1').update(JSON.stringify([lines, ids, stamp])).digest('hex').slice(0, 16), kf = path.join(cacheDir, 'agent', `v2text-${key}.json`);
      let ts = null;
      try { ts = JSON.parse(fs.readFileSync(kf, 'utf8')); } catch {}
      if (!ts) { ts = await mod.textScores(project, lines, ids, { cacheDir }); if (ts && Object.keys(ts).length) try { fs.writeFileSync(kf, JSON.stringify(ts)); } catch {} }
      if (ts) { out.v2sims = {}; texts.forEach((t, i) => { if (ts[i]) out.v2sims[t.id] = ts[i]; }); }
    } catch (e) { report.warnings.push(`Matching the lines to the pictures in their own language failed (${String(e?.message || e).slice(0, 100)}) - the English translation was used`); }
  }
}

// ---------------- the music: beats, bars, parts and energy in edit time ----------------
// song.py's beats follow a drifting tempo (a fixed grid drifts off the beat over a minute); its downbeats are the bars,
// its sections the parts (intro / verse / chorus / instrumental / outro). Returns
// { B: [beat times], downs: [bar times], parts: [ { start, end, label, energy } ], b: beat length, bpm, energyAt(t), src }
function songBeats(song, w0, len) {
  const w1 = w0 + len + 1;
  const idx = song.beats.map((t, i) => i).filter((i) => song.beats[i] >= w0 - 0.01 && song.beats[i] <= w1);
  let B = idx.map((i) => r3(song.beats[i] - w0)), E = idx.map((i) => song.energy?.[i] ?? 0.5);
  if (B.length < 4) return null;
  const iv = B.slice(1).map((x, i) => x - B[i]).sort((x, y) => x - y), b = iv[iv.length >> 1] || 0.5;
  // (the music is shorter than the edit: the beat carries on at the same pace - it loops)
  while (B[B.length - 1] < len) { B.push(r3(B[B.length - 1] + b)); E.push(E[E.length - 1]); }
  // energy: 3-beat mean, re-scaled to this stretch (quiet .. loud of the part used, as the old curve was)
  const sm = E.map((_, i) => mean(E.slice(Math.max(0, i - 1), i + 2)));
  const so = [...sm].sort((x, y) => x - y), lo = so[Math.floor(so.length * 0.1)], hi = so[Math.floor(so.length * 0.95)];
  const en = sm.map((x) => clamp((x - lo) / Math.max(0.05, hi - lo), 0, 1));
  const energyAt = (t) => {
    let lo2 = 0, hi2 = B.length - 1;
    while (hi2 - lo2 > 1) { const m = (lo2 + hi2) >> 1; if (B[m] <= t) lo2 = m; else hi2 = m; }
    if (t <= B[lo2]) return en[lo2];
    if (t >= B[hi2]) return en[hi2];
    const f = (t - B[lo2]) / Math.max(1e-6, B[hi2] - B[lo2]);
    return en[lo2] * (1 - f) + en[hi2] * f;
  };
  const downs = (song.downbeats || []).filter((t) => t >= w0 - 0.01 && t <= w1).map((t) => r3(t - w0));
  const parts = (song.sections || []).filter((p) => p.end > w0 && p.start < w0 + len).map((p) => ({ start: r3(Math.max(0, p.start - w0)), end: r3(Math.min(len, p.end - w0)), label: p.label, energy: p.energy }));
  return { B, downs, parts, b, bpm: song.bpm, energyAt, src: 'song' };
}
// the old way (music.mjs): a fixed tempo grid + the loudness curve - when song.py could not read the music
function gridBeats(grid, first, len, energy) {
  const B = [];
  for (let t = first; t <= len + grid.period; t += grid.period) B.push(r3(t));
  if (B.length < 4) return null;
  return { B, downs: [], parts: [], b: grid.period, bpm: grid.bpm, energyAt: energy ? energy.at : () => 0.5, src: 'grid' };
}
// the best stretch of the music for an edit of len seconds: the most energy, starting on a bar line (better where a part
// begins) and ending near a bar line / the end of a part, so the music does not stop mid-phrase
function bestStart(song, len) {
  if (len >= song.duration - 0.5) return 0;
  const D = song.downbeats?.length ? song.downbeats : song.beats.filter((_, i) => i % 4 === 0);
  const S = song.sections || [];
  let best = { s: -Infinity, t: 0 };
  for (const d of D) {
    if (d + len > song.duration) break;
    if (d < 2 && song.duration > len + 6) continue; // (skip fade-ins unless the song is short)
    const es = song.energy.filter((_, i) => song.beats[i] >= d && song.beats[i] < d + len), e = es.length ? mean(es) : 0;
    const partStart = S.some((p) => Math.abs(p.start - d) < 1.5) ? 0.08 : 0;
    const endOk = S.some((p) => Math.abs(p.end - (d + len)) < 1.5) ? 0.05 : D.some((x) => Math.abs(x - (d + len)) < 0.3) ? 0.02 : 0;
    if (e + partStart + endOk > best.s) best = { s: e + partStart + endOk, t: d };
  }
  return r3(best.t);
}

// ---------------- acts: the story's four parts from the music ----------------
// intro (calm opening), build, climax (on the loudest music), outro (quiet ending). With song.py's parts the acts follow
// them (the chorus / drop is the climax); otherwise the energy curve: the climax is the loudest stretch, the intro runs
// until the music first lifts, the outro from where it last falls. Without music: the classic 18 / 55 / 88 %.
export function makeActs(total, energyAt = null, parts = null) {
  const fixed = [['intro', 0, 0.18], ['build', 0.18, 0.55], ['climax', 0.55, 0.88], ['outro', 0.88, 1]].map(([act, a, b]) => ({ act, start: r3(a * total), end: r3(b * total) }));
  const mk = (list) => {
    const l = list.filter((x) => x.end - x.start > 0.05);
    for (let i = 1; i < l.length; i++) l[i].start = l[i - 1].end;
    if (l.length) { l[0].start = 0; l[l.length - 1].end = r3(total); }
    // neighbours of the same act become one
    const out = [];
    for (const x of l) { const p = out[out.length - 1]; if (p && p.act === x.act) p.end = x.end; else out.push({ ...x }); }
    return { list: out, at: (t) => (out.find((x) => t >= x.start && t < x.end) || out[out.length - 1]).act };
  };
  if (!energyAt || total < 8) return { ...mk(fixed), src: 'fixed' };
  const step = 0.25, n = Math.max(2, Math.ceil(total / step)), e = Array.from({ length: n }, (_, i) => energyAt(i * step));
  const w = Math.round(1.5 / step), s = e.map((_, i) => mean(e.slice(Math.max(0, i - w), i + w + 1)));
  const so = [...s].sort((x, y) => x - y), med = so[n >> 1], peak = so[n - 1];
  if (peak - so[Math.floor(n * 0.1)] < 0.15) return { ...mk(fixed), src: 'flat' }; // (flat music: no shape to follow)
  const at = (t) => s[clamp(Math.round(t / step), 0, n - 1)];
  // the parts of the song (or the energy) mark where each act may begin
  const P = (parts || []).filter((p) => p.end - p.start > 1);
  let introEnd, outroStart, cl0, cl1;
  if (P.length >= 3) {
    const meanE = (p) => mean(s.slice(Math.floor(p.start / step), Math.max(Math.floor(p.start / step) + 1, Math.ceil(p.end / step))));
    const E = P.map(meanE), mid = P.map((_, i) => i).filter((i) => i > 0 && i < P.length - 1);
    introEnd = P[0].end; outroStart = P[P.length - 1].start;
    if (P[0].label !== 'intro' && E[0] > med + 0.1) introEnd = Math.min(introEnd, total * 0.1);
    if (P[P.length - 1].label !== 'outro' && E[P.length - 1] > med + 0.1) outroStart = Math.max(outroStart, total * 0.92);
    const top = mid.length ? mid.reduce((a, b) => (E[b] > E[a] ? b : a)) : 0;
    let a = top, z = top;
    while (a - 1 > 0 && E[a - 1] >= E[top] * 0.9) a--;
    while (z + 1 < P.length - 1 && E[z + 1] >= E[top] * 0.9) z++;
    cl0 = P[a].start; cl1 = P[z].end;
  } else {
    // energy only: the climax is the loudest stretch of about a third of the edit
    const L = Math.max(1, Math.round((total * 0.3) / step));
    let bi = 0, bs = -Infinity;
    for (let i = Math.floor(n * 0.2); i + L <= n; i++) { const m = mean(s.slice(i, i + L)); if (m > bs) { bs = m; bi = i; } }
    cl0 = bi * step; cl1 = (bi + L) * step;
    while (cl1 < total && at(cl1) >= bs * 0.92) cl1 += step;
    while (cl0 > 0 && at(cl0 - step) >= bs * 0.92) cl0 -= step;
    introEnd = 0; for (let t = 0; t < cl0; t += step) { if (at(t) >= med) { introEnd = t; break; } introEnd = t; }
    outroStart = total; for (let t = total - step; t > cl1; t -= step) { if (at(t) >= med) { outroStart = t + step; break; } outroStart = t; }
  }
  // sensible sizes: an intro 6-25 %, an outro 5-18 %, a climax of at least 15 %
  introEnd = clamp(introEnd, total * 0.06, total * 0.25);
  outroStart = clamp(outroStart, total * 0.82, total * 0.95);
  cl0 = clamp(cl0, introEnd, outroStart); cl1 = clamp(cl1, cl0, outroStart);
  if (cl1 - cl0 < total * 0.15) { const c = (cl0 + cl1) / 2; cl0 = clamp(c - total * 0.1, introEnd, outroStart); cl1 = clamp(cl0 + total * 0.2, cl0, outroStart); }
  // (after the climax and before the outro: still the climax when short, a second build when long)
  const after = outroStart - cl1 > total * 0.15 ? 'build' : 'climax';
  return { ...mk([{ act: 'intro', start: 0, end: introEnd }, { act: 'build', start: introEnd, end: cl0 }, { act: 'climax', start: cl0, end: cl1 }, { act: after, start: cl1, end: outroStart }, { act: 'outro', start: outroStart, end: total }].map((x) => ({ ...x, start: r3(x.start), end: r3(x.end) }))), src: P.length >= 3 ? 'parts' : 'energy' };
}

// ---------------- sections, acts and cut points ----------------
// From the song (song edit), the script, the voice-over lines or the outline, and the music's beats. Used by the edit and
// by the quick Plan preview (which passes only what is cached and never waits for an analysis).
export function planTimeline({ opts, vo, music, voSegs, voDur, sg, sty, report, log = () => {}, prior = null, quick = false, media = {} }) {
  let lead = vo ? 0.6 : 0;
  // a montage with no music has no beat to cut on: it gets the fast pace at least, and the user is told
  const beatAsked = opts.editStyle === 'montage' || /\b(beat|beats|bit)\b|बीट/i.test(String(opts.intent || ''));
  const pace = !music && !sty && beatAsked && opts.pace !== 'fast' ? 'fast' : opts.pace;
  if (!music && beatAsked) report.warnings.push('Cuts on the beat were asked for, but no music is chosen - pick one under Music to cut on its beat');
  const shot = sty ? clamp(sty.shots.median * 1.1, 0.6, 6) : PACE[pace] || PACE.medium;
  const C = opts.constraints || {};
  // "end mein logo": a photo called logo (or the one named) shown on an end card
  const logo = C.last?.logo ? (typeof C.last.logo === 'string' && media[C.last.logo]?.kind === 'image' ? media[C.last.logo] : Object.values(media).find((m) => m.kind === 'image' && /logo/i.test(m.name))) || null : null;
  if (C.last?.logo && !logo) report.warnings.push('An end logo was asked for, but there is no logo picture in the project (import one with "logo" in its name)');
  const endCard = opts.endText || logo ? 2.5 : 0;
  let total = vo ? lead + voDur + 1.2 : clamp(+opts.target || 30, 5, 1800);
  let sections, script = null, songPlan = null;
  const songMode = opts.editStyle === 'song' && !!music && !!sg;
  if (songMode) {
    // 🎵 the song decides: one section per sung line (the pictures follow its meaning), parts set the cutting speed
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

  // music: the best part + its beats (song.py; music.mjs when that failed), so cuts land on beats and bars
  let mb = null, musicIn = songPlan ? songPlan.w0 : 0;
  const len = total + endCard;
  if (music && !songPlan) {
    if (sg?.song?.beats?.length > 8) {
      if (opts.musicBest !== false) musicIn = bestStart(sg.song, len);
      mb = songBeats(sg.song, musicIn, len);
    } else if (!quick) {
      log('Finding the beat and the best part of the music…');
      let grid = beats(music.path), first = grid?.first ?? 0;
      if (opts.musicBest !== false) {
        const sec = bestSection(music.path, len);
        if (sec?.in > 0) { musicIn = sec.in; first = 0; }
      }
      if (grid) mb = gridBeats(grid, first, len, energyCurve(music.path, musicIn, len + 1));
    }
  }
  if (songPlan) {
    const s = songBeats(sg.song, musicIn, total);
    if (s) mb = s;
  }
  const acts = makeActs(total, mb?.energyAt || null, mb?.parts?.length ? mb.parts : null);
  const nearestBeat = (t) => { if (!mb) return null; let lo = 0, hi = mb.B.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (mb.B[m] <= t) lo = m; else hi = m; } return Math.abs(mb.B[lo] - t) <= Math.abs(mb.B[hi] - t) ? mb.B[lo] : mb.B[hi]; };
  const snapBeat = (t) => { const b = nearestBeat(t); return b !== null && Math.abs(b - t) < mb.b * 0.5 ? b : t; };
  const style = opts.editStyle || 'standard';
  let slots = [];
  const ref = opts.refStyle?.shots?.length ? opts.refStyle : null;
  const keepAll = prior?.keep === 'all' && Math.abs(Math.max(...prior.slots.map((s) => s.end)) - total) < 0.6;
  const secAt = (x) => sections.find((s) => x >= s.start && x < s.end) || sections[sections.length - 1];
  if (keepAll) {
    // ♻ only the finish changes (look, effects, titles): the last edit's cuts exactly as they were
    slots = prior.slots.map((p) => { const mid = (p.start + p.end) / 2; return { start: p.start, end: p.end, sec: secAt(mid), act: acts.at(mid), energy: mb ? mb.energyAt(mid) : 0.5, ...(mb ? { beat: mb.b } : {}) }; });
    log(`Keeping all ${slots.length} cuts of the last edit`);
  } else if (songPlan) {
    slots = songPlan.slots;
    log(`Cutting to the song: ${slots.length} shots, every cut on a beat, a new picture with every sung line`);
  } else if (ref) {
    // copy a reference video's cutting: its shot lengths in order (repeated if this edit is longer), on the beat when
    // the reference itself cuts on the beat, and what happens on each of its cuts (see refFx). Footage is all yours.
    const snap = ref.onBeat === null || ref.onBeat === undefined || ref.onBeat >= 0.4 ? snapBeat : (x) => x;
    let t = 0, k = 0;
    while (t < total - 0.3) {
      const s = ref.shots[k % ref.shots.length];
      let next = Math.min(total, snap(t + s.len));
      if (next - t < 0.3) next = Math.min(total, t + s.len);
      const mid = (t + next) / 2;
      slots.push({ start: t, end: next, sec: secAt(mid), act: acts.at(mid), energy: mb ? mb.energyAt(mid) : 0.5, refCut: k ? s.cutIn : null, refK: k % ref.shots.length });
      t = next; k++;
    }
    if (slots.length) slots[slots.length - 1].end = total;
    report.reference = describeRef(ref);
    report.warnings.unshift(`Cut like the reference (only your footage used): ${report.reference}`);
    log(`Cutting like the reference: ${report.reference}`);
  } else if (mb) {
    slots = beatSlots({ mb, sections, total, shot, style, acts });
    log(`Cutting on the beat: ${Math.round(mb.bpm)} BPM, ${slots.length} shots${mb.downs.length ? ', longer shots on the bar lines' : ''}`);
  } else {
    for (const s of sections) {
      const len2 = s.end - s.start, n = Math.max(1, Math.round(len2 / shot));
      let a = s.start;
      for (let i = 1; i <= n; i++) {
        let b = i === n ? s.end : snapBeat(s.start + (len2 * i) / n);
        if (b - a < 0.8) continue;
        slots.push({ start: a, end: b, sec: s, act: acts.at(a) });
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
  return { sections, slots, total, lead, script, songPlan, musicIn, endCard, shot, style, ref, mb, acts, logo };
}

// The acts of an edit as the Plan and the report show them: each part with its lines and how many shots it has.
export function actsOf(slots, total) {
  const out = [];
  for (const s of slots) {
    let a = out[out.length - 1];
    if (!a || a.label !== s.act) { a = { label: s.act || 'build', start: r3(s.start), end: r3(s.end), lines: [], shots: 0 }; out.push(a); }
    a.end = r3(s.end); a.shots++;
    const line = !s.sec?.actOnly && (s.sec?.orig || s.sec?.text);
    if (line && a.lines[a.lines.length - 1] !== line && !out.some((x) => x.lines.includes(line))) a.lines.push(line);
  }
  if (out.length) out[out.length - 1].end = r3(Math.max(out[out.length - 1].end, total));
  return out;
}

// ---------------- ✂ re-edit of only part of the edit ----------------
// constraints.scope: { kind: 'range', from, to } (timeline seconds) | { kind: 'clips', ids: [V1 clip ids] } |
// { kind: 'slots', index: [0-based] }; prev: { tracks, report } (the server reads them from the project). The scope's
// edges snap to the edit's existing cuts; returns { runs: [ { i0, i1, a, z } ], fixed, label, ... } or null.
const tc = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
export function scopeOf(sc, prev, media) {
  if (!sc || !sc.kind || sc.kind === 'all' || !prev?.tracks?.V1?.length) return null;
  const V1 = prev.tracks.V1, L = layoutV1({ tracks: { V1 } }, media);
  const usable = (c) => (c.type === 'video' || c.type === 'image') && media[c.mediaId];
  let pick = new Set();
  if (sc.kind === 'range') {
    const D = L.length ? L[L.length - 1].end : 0;
    // ("aakhri 10 second": counted from the end of the edit as it is now)
    const from = sc.fromEnd ? Math.max(0, D - +sc.fromEnd) : Math.max(0, +sc.from || 0), to = sc.fromEnd ? D : Math.max(from, +sc.to || 0);
    const cuts = [0, ...L.map((x) => x.end)];
    const near = (t) => cuts.reduce((b, c) => (Math.abs(c - t) < Math.abs(b - t) ? c : b), cuts[0]);
    let a = near(from), z = near(to);
    if (z <= a + 0.01) z = cuts.find((c) => c > a + 0.01) ?? a;
    L.forEach((x, i) => { if (x.end > a + 0.01 && x.end <= z + 0.01) pick.add(i); });
  } else {
    const rs = prev.report || [];
    const ids = new Set(sc.kind === 'clips' ? sc.ids || [] : (sc.index || []).map((k) => rs[k < 0 ? rs.length + k : k]?.clipId).filter(Boolean));
    V1.forEach((c, i) => { if (ids.has(c.id)) pick.add(i); });
  }
  pick = new Set([...pick].filter((i) => usable(V1[i]))); // (titles / the end card are never re-planned)
  if (!pick.size) return null;
  const runs = [];
  for (const i of [...pick].sort((x, y) => x - y)) {
    const r = runs[runs.length - 1];
    if (r && r.i1 === i - 1) r.i1 = i; else runs.push({ i0: i, i1: i });
  }
  // a run fills from the end of the shot before it (its transition in is not kept) to where the last shot ended
  for (const r of runs) { r.a = r3(r.i0 ? L[r.i0 - 1].end : 0); r.z = r3(L[r.i1].end); }
  const inRun = (i) => runs.some((r) => i >= r.i0 && i <= r.i1);
  const fx = (i) => { const c = V1[i]; return { m: media[c.mediaId], in: c.in || 0, len: c.type === 'video' ? (c.out ?? 0) - (c.in || 0) : 0 }; };
  const before = runs[0].i0 - 1;
  const fixed = V1.map((c, i) => i).filter((i) => !inRun(i) && i !== before && usable(V1[i])).map(fx);
  if (before >= 0 && usable(V1[before])) fixed.push(fx(before));
  const label = runs.map((r) => `${tc(r.a)} - ${tc(r.z)}`).join(', ');
  return { kind: sc.kind, runs, fixed, label, L, V1, from: runs[0].a, to: runs[runs.length - 1].z };
}
// the new plan's slots inside the scope, cut to its edges exactly (bits under half a second join their neighbour)
export function scopeSlots(all, scope, sections) {
  const secAt = (x) => sections.find((s) => x >= s.start && x < s.end) || sections[sections.length - 1];
  const out = [];
  scope.runs.forEach((r, k) => {
    const mine = all.filter((s) => s.end > r.a + 0.01 && s.start < r.z - 0.01).map((s) => ({ ...s, start: r3(Math.max(s.start, r.a)), end: r3(Math.min(s.end, r.z)), run: k }));
    if (!mine.length) { const mid = (r.a + r.z) / 2; mine.push({ start: r.a, end: r.z, sec: secAt(mid), act: all[0]?.act || 'build', sp: all[0]?.sp || 1, run: k }); }
    mine[mine.length - 1].end = r.z; mine[0].start = r.a;
    for (let i = 0; i < mine.length && mine.length > 1; i++) {
      if (mine[i].end - mine[i].start >= 0.5) continue;
      if (i > 0) { mine[i - 1].end = mine[i].end; mine.splice(i, 1); } else { mine[1].start = mine[0].start; mine.splice(0, 1); }
      i--;
    }
    for (const s of mine) { delete s.held; delete s.pick; delete s.alts; }
    out.push(...mine);
  });
  return out;
}
// the new shots put back in place of the scope's old ones; everything else exactly as it was. Checks that nothing outside
// moved on the timeline (report.scope.moved).
function mergeScope({ scope, V1: fresh, report, opts, media, prevSlots }) {
  const prev = opts.prev, byRun = scope.runs.map(() => []);
  fresh.forEach((c, i) => byRun[report.slots[i]?.run ?? 0]?.push(c));
  const V1 = [];
  scope.V1.forEach((c, i) => {
    const k = scope.runs.findIndex((r) => i >= r.i0 && i <= r.i1);
    if (k < 0) { V1.push(c); return; }
    if (i !== scope.runs[k].i0) return;
    const add = byRun[k];
    if (add[0]) { delete add[0].transitionIn; delete add[0].fadeIn; }
    V1.push(...add);
  });
  const L2 = layoutV1({ tracks: { V1 } }, media), keepIds = new Set(scope.V1.filter((_, i) => !scope.runs.some((r) => i >= r.i0 && i <= r.i1)).map((c) => c.id));
  const oldAt = Object.fromEntries(scope.L.map((x) => [x.clip.id, x.start]));
  const moved = L2.filter((x) => keepIds.has(x.clip.id) && Math.abs(x.start - oldAt[x.clip.id]) > 0.02).length;
  if (moved) report.warnings.push(`${moved} shot${moved > 1 ? 's' : ''} after the re-edited part moved slightly - check the cut after ${scope.label}`);
  // the report: the old rows of the shots that stay + the new rows
  const fresh2 = report.slots.map(({ run, ...s }) => s);
  report.slots = [...prevSlots.filter((s) => keepIds.has(s.clipId)), ...fresh2].sort((a, b) => a.start - b.start);
  report.scope = { kind: scope.kind, from: scope.from, to: scope.to, label: scope.label, runs: scope.runs.map(({ a, z }) => ({ from: a, to: z })), shots: fresh2.length, kept: keepIds.size, moved };
  report.warnings.unshift(`Only ${scope.label} was re-edited (${fresh2.length} new shot${fresh2.length > 1 ? 's' : ''}); the rest is as it was`);
  const T = prev.tracks;
  const duration = r3(Math.max(0, ...L2.map((x) => x.end), ...['V2', 'A1', 'A2'].flatMap((k) => (T[k] || []).map((c) => (c.start || 0) + (c.dur ?? 0)))));
  return { refLooks: null, tracks: { V1, V2: T.V2 || [], A1: T.A1 || [], A2: T.A2 || [], A3: (T.A3 || []).filter((c) => c.sfx) }, trackState: {}, subtitles: null, captions: null, settings: null,
    report, duration, language: null, skippedIds: [], aspect: opts.aspect, scope: report.scope };
}

// 🗺 The quick Plan preview (POST /api/agent/plan): sections, acts and cuts from what is cached - in a second or two.
// Whatever is not heard / studied yet is named in `pending` (the edit itself does it when it runs).
export async function planPreview({ opts, media, cacheDir }) {
  const report = { warnings: [] };
  const said = await applyIntent(opts, { media, cacheDir, llm: false }); // (the Plan answers fast: rules only)
  const vo = opts.vo && media[opts.vo], music = opts.music && media[opts.music];
  const pending = [];
  let voSegs = null, voDur = 0, sg = null;
  if (vo) {
    const c = readVoCache(cacheDir, vo, opts);
    if (c) ({ voSegs, voDur } = c);
    else { voDur = vo.duration || 0; pending.push('the voice-over is not heard yet - its lines are found when the edit starts'); }
  }
  const songMode = opts.editStyle === 'song' && !!music;
  if (music) {
    sg = readSongCache(cacheDir, music, opts, songMode);
    if (!sg) pending.push(songMode ? 'the song is not studied yet - its beats, parts and lyrics are found when the edit starts' : 'the music is not studied yet - the cuts follow its beat once the edit starts');
    else if (songMode && !sg.segs.length && opts.songLyrics !== false && !fs.existsSync(lyricFiles(sg.dir, opts).lj)) pending.push('the lyrics are not heard yet');
  }
  if (opts.reference && !opts.refStyle) pending.push('the reference video is not studied yet - its cutting is copied when the edit starts');
  const T = planTimeline({ opts, media, vo, music, voSegs, voDur, sg, sty: opts.styleProfile || null, report, quick: true });
  // ✂ a re-edit of part of the edit: what changes (snapped to the edit's cuts), the rest stays
  const scope = scopeOf(opts.constraints?.scope, opts.prev, media);
  const inScope = (s) => !scope || scope.runs.some((x) => s.end > x.a + 0.01 && s.start < x.z - 0.01);
  const r = (s) => ({ start: r3(s.start), end: r3(s.end), act: s.act, text: s.sec?.actOnly ? null : s.sec?.orig || s.sec?.text || null, ...(scope ? { changes: inScope(s) } : {}) });
  return {
    duration: r3(T.total + T.endCard), acts: actsOf(T.slots, T.total), slots: T.slots.map(r),
    music: music ? { name: music.name, bpm: T.mb?.bpm ? Math.round(T.mb.bpm) : sg?.song?.bpm ?? null, start: r3(T.musicIn) } : null,
    vo: vo ? { lines: (voSegs || []).map((s) => s.text), duration: r3(voDur) } : null,
    warnings: report.warnings, understood: said.understood, notes: said.notes, constraints: opts.constraints || {},
    ...(scope ? { scope: { kind: scope.kind, from: scope.from, to: scope.to, label: `Only ${scope.label} changes`, runs: scope.runs.map(({ a, z }) => ({ from: a, to: z })), shots: scopeSlots(T.slots, scope, T.sections).length, kept: scope.V1.length - scope.runs.reduce((n, x) => n + x.i1 - x.i0 + 1, 0) } } : {}),
    ...(pending.length ? { pending: pending.join('; ') } : {}),
  };
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
// Cut points on the music's beats (song.py's real beats, or the fixed grid). Shot length (in beats) follows the music's
// energy, the act and the edit style; a shot of a bar or more ends on a bar line when one is within a beat; a new spoken
// line, a new part of the music (a phrase) and a new act always get a cut on the nearest beat.
function beatSlots({ mb, sections, total, shot, style, acts }) {
  let B = mb.B.filter((t) => t >= -0.01);
  let b = mb.b;
  // very fast songs: count in half-time; very slow: in double-time (a cut on every beat would be too fast / too slow)
  while (b < 0.38 && B.length > 8) { B = B.filter((_, i) => i % 2 === 0); b *= 2; }
  while (b > 1.0) { const D = []; B.forEach((t, i) => { D.push(t); if (i + 1 < B.length) D.push(r3((t + B[i + 1]) / 2)); }); B = D; b /= 2; }
  const isDown = (t) => mb.downs.some((d) => Math.abs(d - t) < 0.06);
  const idxNear = (t) => { let lo = 0, hi = B.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (B[m] <= t) lo = m; else hi = m; } return Math.abs(B[lo] - t) <= Math.abs(B[hi] - t) ? lo : hi; };
  const e = (t) => mb.energyAt(t);
  const lenBeats = (t) => {
    const x = e(t), act = acts.at(t);
    if (style === 'teaser') return { intro: x > 0.6 ? 4 : 8, build: x > 0.5 ? 2 : 4, climax: x > 0.85 ? 1 : 2, outro: 8 }[act];
    if (style === 'montage') return x > 0.55 ? 1 : 2;
    const base = Math.max(1, Math.round(shot / b));
    return Math.max(1, Math.round(base * (1.3 - 0.6 * x)));
  };
  // cuts that must be: spoken lines, the music's parts (phrase starts), the acts
  const mustT = [
    ...sections.filter((s) => s.textId && s.start > 0.3).map((s) => s.start),
    ...mb.parts.map((p) => p.start), ...acts.list.slice(1).map((a) => a.start),
  ].filter((t) => t > 0.3 && t < total - 0.3).map((t) => B[idxNear(t)]);
  const must = [...new Set(mustT.map((t) => +t.toFixed(3)))].sort((x, y) => x - y);
  const cuts = [0];
  let t = 0;
  while (t < total - 0.3) {
    const n = lenBeats(t);
    let next = t + n * b;
    let k = idxNear(next);
    if (B[k] <= t + 0.2) k = Math.min(B.length - 1, k + 1);
    // a bar or longer: end on the bar line within a beat (the later one first - shots get a little longer, not shorter)
    if (n >= 3 && mb.downs.length && !isDown(B[k])) { const j = [k + 1, k - 1].find((x) => x > 0 && x < B.length && isDown(B[x]) && B[x] > t + 0.5); if (j !== undefined) k = j; }
    next = B[k] > t + 0.2 ? B[k] : t + n * b;
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
    out.push({ start: a, end: z, sec: secAt(mid), act: acts.at(mid), energy: e(mid), beat: b, onBar: isDown(z) });
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
