#!/usr/bin/env node
// edtool.mjs - the editor's hands for Claude (🧠 Claude mode of the Assistant). Claude runs it with Bash:
//   node engine/edtool.mjs <command> [args]          (project: $VEDIT_PROJECT, editor: http://127.0.0.1:$VEDIT_PORT)
// Every change goes through the running editor, so it shows up live in every open editor tab and can be undone there.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { placed, totalDuration, seqOf, SEQ_FIELDS, placeRefLooks, setTransition, arrangeLayers } from '../public/js/model.js';
import { CUTFX } from '../public/js/fx.js';
import { viewOf, toShared } from '../public/js/myseq.js';
import { analyzeReference, describeRef, describeLooks, refAdjustLayers } from './refstyle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --name value pairs are taken out first; what is left are the command and its words
const argv = [], flags = {};
for (let i = 0, a = process.argv.slice(2); i < a.length; i++) { if (/^--[a-z]/.test(a[i]) && i + 1 < a.length) flags[a[i].slice(2)] = a[++i]; else argv.push(a[i]); }
const flag = (k, d = null) => (k in flags ? flags[k] : d);
const PROJ = flag('p') || process.env.VEDIT_PROJECT;
const BASE = `http://127.0.0.1:${process.env.VEDIT_PORT || 3000}`;
// 🎞 the sequence to work on: the one the person who asked has open (the Assistant sends it); none = the team's main one
const SEQ = flag('seq') || process.env.VEDIT_SEQ || null;
const DEBUG = !!process.env.EDTOOL_DEBUG;
const enc = encodeURIComponent;
const r2 = (x) => Math.round(x * 100) / 100;
const die = (m) => { console.error(`edtool: ${m}`); process.exit(1); };
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 1));
// plain http (no keep-alive): fetch's pooled sockets made Node print a libuv assertion on exit on Windows
function api(method, url, body) {
  return new Promise((ok) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(BASE + url, { method, agent: false, headers: { Connection: 'close', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        let j; try { j = JSON.parse(t); } catch { j = t; }
        if (res.statusCode >= 400) die(`${method} ${url.split('?')[0]}: ${j?.error || t}`.slice(0, 400));
        ok(j);
      });
    });
    req.on('error', (e) => die(`the editor is not answering (${e.code || e.message}) - is it running? (Desktop shortcut "Video Editor Agent")`));
    if (data) req.write(data);
    req.end();
  });
}
// (VEDIT_DATA: a test editor's own folder - edtool then never writes into the real projects)
const P = (...x) => path.join(process.env.VEDIT_DATA ? path.resolve(process.env.VEDIT_DATA) : ROOT, 'Projects', PROJ, ...x);
const workDir = () => { const d = P('cache', 'claude'); fs.mkdirSync(d, { recursive: true }); return d; };
async function waitJob(id, label = 'job') {
  for (let i = 0; ; i++) {
    const j = await api('GET', `/api/job?id=${id}`);
    if (j.status !== 'running') { if (j.status !== 'done') die(`${label} failed: ${j.log.slice(-3).join(' | ')}`); return j.result; }
    if (i % 15 === 0) console.error(`  ${label}: ${j.progress || 0}% ${j.stage || ''}`);
    await new Promise((ok) => setTimeout(ok, 2000));
  }
}
// the project as the person sees it: their sequence at the top level (myseq.js viewOf), map says how to send changes back
let seqMap = null;
async function project() {
  const shared = await api('GET', `/api/project?p=${enc(PROJ)}`);
  if (SEQ && SEQ !== seqOf(shared).id && !shared.sequences?.[SEQ]) die('the sequence you were asked to work on no longer exists - ask the user to open one');
  const v = SEQ ? viewOf(shared, SEQ) : null;
  seqMap = v ? { mine: SEQ, shared: seqOf(shared).id, noSeq: !shared.seq } : null;
  return v || shared;
}
// changes go as live ops (only the fields that changed), so someone else's edits on other sequences are never overwritten
async function sendOps(ops, label = 'Claude') {
  const s = toShared(ops, seqMap);
  if (!s) die('that change cannot be made on this sequence');
  return s.length ? api('POST', `/api/live/ops?p=${enc(PROJ)}&client=claude`, { ops: s, label }) : { rev: null };
}
async function saveView(before, after, label) {
  const keys = [...new Set([...SEQ_FIELDS, 'logo', 'agentReport', 'agentOpts'])];
  const ops = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => ({ o: 'set', p: [k], v: after[k] }));
  await sendOps(ops, label);
  await api('POST', `/api/live/save?p=${enc(PROJ)}&backup=1`).catch(() => {});
}
const seqArg = () => (seqMap ? { seq: seqMap.mine } : {});
// ↶ AI undo: a copy of the edit before this change (the editor's Claude chat makes one per message instead)
const snap = (label) => (process.env.VEDIT_NO_SNAP ? null : api('POST', `/api/aiundo/snap?p=${enc(PROJ)}`, { label: `Claude (edtool ${label})` }).catch(() => null));
const mediaList = async () => (await api('GET', `/api/media?p=${enc(PROJ)}`)).items;
const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
const playFile = (m) => (m.kind === 'video' && m.proxy === 'ready' ? P('cache', 'proxies', `${m.id}.mp4`) : m.path);

const HELP = `edtool - edit the open project "${PROJ}" (every change appears live in the editor; the user can Ctrl+Z it there)

LOOK
  state                       the timeline: settings, every clip with its place, source in/out, effects
  media [--kind video|image|audio] [--bin x] [--q name] [--limit 80]   the footage (id, name, length, size, folder, tags)
  find "<what to see>" [--top 20]   smart search over the footage by meaning (Hindi/English), by a named person ("CM sahab")
                              or by words written on it (banners, supers: "lok seva guarantee"); needs "scan" once
  scan                        let the editor look at all footage once (tags, search, faces, text on it; can take minutes)
  people                      who is in the footage (from "scan"): named people and "Person N", the clips and seconds they
                              are seen in. A VO line naming someone gets their shot from "agent" by itself
  quotes [--n 12] [--brief "what the edit is about"] [--again]   the best lines of the transcribed interviews / speeches
                              (clip, in-out seconds, text) - put them on the timeline with apply
  look <mediaId|file> [--n 12] [--from s] [--to s]   a contact sheet JPG (n frames) - then Read the printed path to SEE it
  ref <file>                  a REFERENCE edit taken apart: frame shape, every shot (start, length, how it cuts in: cut /
                              flash / dip / whip / dissolve, how lively), beat sync, colour + a sheet with one frame per shot
                              (Read it). Rebuild the same edit with the project's own footage - never use the reference's shots
  frames <t1> <t2> ...        what the edit shows at those timeline seconds (one JPG sheet) - Read it
  sheet [--every 4] [--from s] [--to s]   the edit as a contact sheet (a frame every N seconds) - Read it
  song <audioMediaId>         a song: BPM, beats, bars, parts (verse/chorus), sung lyric lines with times (first run: minutes)
  styles                      the saved edit styles (learnt from edits the user liked)

CHANGE
  apply <file.json>           replace parts of the project: { "tracks": { "V1": [...], "V2": [...] }, "settings": {...},
                              "captions": {...}, "trackState": {...}, "markers": [...] } - only the keys you give change
  ops <file.json>             small live changes (see public/js/livepatch.js): [{ "o":"set","p":["tracks","V1","#<clipId>","in"],"v":2.5 }]
  reflook <ref-file> [--cuts no]   after building an edit like a reference: puts the reference's EFFECTS on it - its
                              looks (black & white, vignette, grain, bars, blur, warmer / cooler) as adjustment layers on
                              a free V track over the matching V1 shots, and what happens on each of its cuts (flash, whip,
                              dip to black, dissolve). Shot k of V1 gets reference shot k. Run it again after changing the cut
  agent <opts.json>           run the built-in agent (song / montage / VO edit) and put its edit on the timeline
                              opts like { "clips":[ids], "music":id, "editStyle":"song", "songPart":"full", "lyrics":"...", "styleName":"GenZ lyric video" }

FINISH
  preview                     a quick low-res render of the edit -> prints the file (then "look <file>" to check it)
  render [--preset youtube|reel|shorts|insta-feed|whatsapp|master] [--res 1080] [--name x]   the real export -> prints the file
`;

async function cmdState() {
  const pj = await project(), items = await mediaList(), by = Object.fromEntries(items.map((m) => [m.id, m]));
  const L = placed(pj, by), D = totalDuration(pj, by);
  const lines = [`project "${pj.name}"${pj.seq ? `, sequence "${pj.seq.name}"` : ''} ${pj.settings.aspect} ${pj.settings.fps}fps, ${r2(D)}s; look ${JSON.stringify(pj.settings.look || {})}; kenburns ${!!pj.settings.kenburns}`];
  for (const [t, list] of Object.entries(L)) {
    if (!list.length) continue;
    lines.push(`${t}: ${list.length} clips`);
    for (const [i, x] of list.entries()) {
      const c = x.clip, m = by[c.mediaId];
      const extra = [c.speed && c.speed !== 1 ? `speed ${c.speed}` : '', c.transitionIn ? `trans ${c.transitionIn.type}` : '', c.cutFx ? `fx ${c.cutFx.type}` : '', c.keys ? `keys ${Object.keys(c.keys).join('+')}` : '',
        c.color ? 'graded' : '', c.fit ? `fit ${c.fit}` : '', c.text ? `text ${JSON.stringify(String(c.text).slice(0, 40))}` : '', c.volume !== undefined ? `vol ${c.volume}` : ''].filter(Boolean).join(', ');
      lines.push(`  ${String(i + 1).padStart(3)} ${r2(x.start).toFixed(2).padStart(7)}-${r2(x.end).toFixed(2).padStart(7)}  ${c.type.padEnd(5)} id=${c.id} ${m ? `media=${m.id} "${m.name}"` : ''}${c.type === 'video' || c.type === 'audio' ? ` in=${r2(c.in || 0)} out=${r2(c.out ?? m?.duration ?? 0)}` : ''}${extra ? ` [${extra}]` : ''}`);
    }
  }
  if (pj.captions?.cues?.length) lines.push(`captions: ${pj.captions.cues.length} cues, style ${pj.captions.style?.preset || ''}`);
  for (const t of pj.captions?.tracks || []) lines.push(`caption track "${t.name || t.id}"${t.lang ? ` (${t.lang})` : ''}: ${t.cues?.length || 0} cues${t.on ? '' : ', hidden'}`);
  if (pj.agentReport?.warnings?.length) lines.push(`last agent warnings: ${pj.agentReport.warnings.join(' / ')}`);
  out(lines.join('\n'));
}
async function cmdMedia() {
  const kind = flag('kind'), bin = flag('bin'), q = flag('q'), limit = +flag('limit', 80);
  let items = (await mediaList()).filter((m) => m.status === 'ready');
  if (kind) items = items.filter((m) => m.kind === kind);
  if (bin) items = items.filter((m) => (m.bin || '').toLowerCase().includes(bin.toLowerCase()));
  if (q) items = items.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()));
  out(`${items.length} files${items.length > limit ? ` (first ${limit}; use --kind/--bin/--q/--limit)` : ''}`);
  for (const m of items.slice(0, limit)) out(`${m.id}  ${m.kind.padEnd(5)} ${m.kind !== 'image' ? `${r2(m.duration)}s`.padEnd(8) : ''.padEnd(8)} ${m.width ? `${m.width}x${m.height}` : ''}  "${m.name}"  ${m.bin ? `[${m.bin}]` : ''}${m.tags?.length ? ` tags:${m.tags.join(',')}` : ''}`);
}
async function cmdFind(words) {
  const q = words.join(' '), top = +flag('top', 20);
  if (!q) die('find "what to see"');
  const r = await api('POST', `/api/footage/search?p=${enc(PROJ)}`, { q });
  const by = Object.fromEntries((await mediaList()).map((m) => [m.id, m]));
  out(`search: "${r.q}"`);
  for (const x of r.results.slice(0, top)) out(`${x.id}  at ${r2(x.t)}s  ${x.why ? x.why : `score ${r2(x.score)}`}  "${by[x.id]?.name}" ${by[x.id]?.kind || ''}`);
}
async function cmdPeople() {
  const r = await api('GET', `/api/people?p=${enc(PROJ)}`), by = Object.fromEntries((await mediaList()).map((m) => [m.id, m]));
  if (!r.at) return out('no faces looked for yet - run "scan" first');
  out(`${r.people.length} people (named ones are known in every project; the user names them in 🧠 Smart › People)`);
  for (const p of r.people) {
    out(`${p.label}${p.aliases?.length ? ` (also: ${p.aliases.join(', ')})` : ''} - seen ${p.count}x`);
    for (const [id, ts] of Object.entries(p.media).slice(0, 12)) out(`    ${id} "${by[id]?.name || '?'}" at ${ts.slice(0, 8).map((t) => `${r2(t)}s`).join(' ')}`);
  }
}
async function cmdQuotes() {
  let r = await api('GET', `/api/quotes?p=${enc(PROJ)}`);
  if (!r.quotes?.length || argv.includes('--again') || flag('brief')) {
    const j = await api('POST', `/api/quotes?p=${enc(PROJ)}`, { n: +flag('n', 12), brief: flag('brief', '') });
    r = await waitJob(j.id, 'quotes');
  }
  const by = Object.fromEntries((await mediaList()).map((m) => [m.id, m]));
  out(`${r.quotes.length} quotes (${r.by === 'claude' ? 'picked by Claude' : 'picked by a simple rule'}):`);
  for (const x of r.quotes) out(`${x.mediaId} "${by[x.mediaId]?.name || '?'}" in=${r2(x.start)} out=${r2(x.end)} (${r2(x.end - x.start)}s)${x.why ? ` [${x.why}]` : ''}
    "${x.text}"`);
}
async function cmdScan() {
  const j = await api('POST', `/api/footage/scan?p=${enc(PROJ)}`, {});
  if (j.id) await waitJob(j.id, 'scan');
  out('footage scanned - "find" works now');
}
// srcs: [{ file, t }] (file null = an empty grey frame) -> one JPG of small frames, left to right, top to bottom
function sheetOf(srcs, name, cols = 4) {
  const d = path.join(workDir(), `tmp_${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(d);
  const VF = 'scale=384:216:force_original_aspect_ratio=decrease,pad=384:216:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuvj420p';
  srcs.forEach((s, n) => {
    const f = path.join(d, `f${String(n).padStart(3, '0')}.jpg`);
    const r = s.file ? ff([...(s.t > 0 ? ['-ss', String(s.t)] : []), '-i', s.file, '-frames:v', '1', '-vf', VF, f]) : { status: 1, stderr: 'no picture there' };
    if (r.status !== 0 || !fs.existsSync(f)) {
      if (DEBUG) console.error(`  frame ${n + 1} failed (${s.file} @${s.t}): ${String(r.stderr).trim().slice(-160)}`);
      ff(['-f', 'lavfi', '-i', 'color=gray:s=384x216', '-frames:v', '1', '-vf', 'format=yuvj420p', f]);
    }
  });
  const outFile = path.join(workDir(), `${name}.jpg`), n = srcs.length;
  // (concat of the stills, then tile - an image sequence input stops at the first odd one)
  const list = path.join(d, 'list.txt');
  fs.writeFileSync(list, srcs.map((_, i) => `file 'f${String(i).padStart(3, '0')}.jpg'\nduration 1`).join('\n'));
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-vf', `tile=${Math.min(cols, n)}x${Math.ceil(n / cols)}:padding=4:color=white`, '-frames:v', '1', outFile], { cwd: d, encoding: 'utf8' });
  if (r.status !== 0) die(`contact sheet: ${r.stderr.slice(-200)}`);
  if (!DEBUG) fs.rmSync(d, { recursive: true, force: true });
  return outFile;
}
async function cmdLook(target) {
  if (!target) die('look <mediaId|file>');
  const n = +flag('n', 12), from = flag('from'), to = flag('to');
  let file = target, dur = 0, name = path.basename(target);
  if (!fs.existsSync(target)) {
    const m = (await mediaList()).find((x) => x.id === target); if (!m) die(`no media ${target}`);
    file = playFile(m); dur = m.kind === 'image' ? 0 : m.duration || 0; name = m.name;
  } else {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }); dur = +r.stdout || 0;
  }
  const a = from !== null ? +from : 0, b = to !== null ? +to : dur, k = dur > 0 ? n : 1;
  const times = Array.from({ length: k }, (_, i) => r2(a + ((b - a) * (i + 0.5)) / k));
  const f = sheetOf(times.map((t) => ({ file, t })), `look_${crypto.createHash('md5').update(file + times.join()).digest('hex').slice(0, 8)}`);
  out(`"${name}" ${dur ? `${r2(dur)}s` : '(photo)'} - frames at ${times.join(', ')}s (left to right, top to bottom)\n${f}`);
}
async function timelineFrames(ts) {
  const pj = await project(), items = await mediaList(), by = Object.fromEntries(items.map((m) => [m.id, m]));
  const L = placed(pj, by);
  const tracks = Object.keys(L).filter((k) => k[0] === 'V').sort().reverse(); // the top-most picture wins
  return ts.map((t) => {
    for (const k of tracks) {
      const x = (L[k] || []).find((y) => t >= y.start && t < y.end && (y.clip.type === 'video' || y.clip.type === 'image'));
      if (!x) continue;
      const c = x.clip, m = by[c.mediaId]; if (!m) continue;
      const title = (L.V2 || []).find((y) => y.clip.type === 'title' && t >= y.start && t < y.end);
      return { file: playFile(m), t: c.type === 'video' ? (c.in || 0) + (t - x.start) * (c.speed || 1) : 0, label: `${t}s ${k} "${m.name}"${title ? ` + title ${JSON.stringify(title.clip.text)}` : ''}` };
    }
    return { file: null, t: 0, label: `${t}s (nothing on screen)` };
  });
}
async function cmdFrames(ts) {
  if (!ts.length) die('frames <seconds> ...');
  const fr = await timelineFrames(ts);
  const f = sheetOf(fr, `frames_${Date.now()}`);
  out(`${fr.map((x) => x.label).join('\n')}\n${f}`);
}
async function cmdSheet() {
  const every = +flag('every', 4), pj = await project(), items = await mediaList(), by = Object.fromEntries(items.map((m) => [m.id, m]));
  const D = totalDuration(pj, by), ts = [], a = +flag('from', 0), b = Math.min(D, +flag('to', D));
  for (let t = a + every / 2; t < b; t += every) ts.push(r2(t));
  if (ts.length > 72) die(`${ts.length} frames is too many - use a bigger --every`);
  const fr = await timelineFrames(ts);
  const f = sheetOf(fr, `sheet_${Date.now()}`, 6);
  out(`${ts.length} frames, one every ${every}s (left to right, top to bottom):\n${fr.map((x) => x.label).join('\n')}\n${f}`);
}
async function cmdSong(id) {
  if (!id) die('song <audioMediaId>');
  const m = (await mediaList()).find((x) => x.id === id); if (!m) die(`no media ${id}`);
  const key = crypto.createHash('sha1').update(JSON.stringify([m.path, m.size, m.mtime])).digest('hex').slice(0, 12);
  const dir = P('cache', 'song', key), sj = path.join(dir, 'song.json'), env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(sj)) { console.error('  hearing the song (beats, parts, voice)…'); const r = spawnSync('python', [path.join(ROOT, 'engine', 'song.py'), m.path, dir, sj], { encoding: 'utf8', env }); if (r.status !== 0) die(`song.py: ${r.stderr.slice(-300)}`); }
  const song = JSON.parse(fs.readFileSync(sj, 'utf8'));
  const lj = path.join(dir, 'lyrics3-medium-hi.json'), le = lj.replace('.json', '.en.json');
  if (!fs.existsSync(lj) && song.vocals) { console.error('  hearing the lyrics…'); spawnSync('python', [path.join(ROOT, 'engine', 'transcribe.py'), song.vocals, '--lang', 'hi', '--model', 'large-v3-turbo', '--words', '4', '--song', '--out', path.join(dir, 'lyrics.srt'), '--json', lj, '--translate-json', le], { encoding: 'utf8', env }); }
  const lyr = fs.existsSync(lj) ? JSON.parse(fs.readFileSync(lj, 'utf8')).segments : [];
  const en = fs.existsSync(le) ? JSON.parse(fs.readFileSync(le, 'utf8')).segments : [];
  out(`"${m.name}" ${r2(song.duration)}s, ${song.bpm} BPM, beat every ${r2(60 / song.bpm)}s, ${song.beats.length} beats, ${song.downbeats.length} bars`);
  out(`parts: ${song.sections.map((s) => `${r2(s.start)}-${r2(s.end)} ${s.label} (energy ${s.energy})`).join(' | ')}`);
  out(`first downbeats: ${song.downbeats.slice(0, 16).join(', ')} …`);
  out(`full beat list: ${sj} (Read it for exact cut points: "beats", "downbeats", "energy" per beat)`);
  out('sung lines (heard - spelling may be loose; English is a rough translation):');
  for (const s of lyr) { const e = en.filter((x) => x.end > s.start && x.start < s.end).map((x) => x.text).join(' '); out(`  ${r2(s.start).toFixed(2).padStart(7)}-${r2(s.end).toFixed(2).padStart(7)}  ${s.text}${e ? `   = ${e}` : ''}`); }
}
async function cmdApply(f) {
  if (!f || !fs.existsSync(f)) die('apply <file.json>');
  const patch = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
  await snap('apply');
  const pj = await project(); delete pj._rev; const before = JSON.parse(JSON.stringify(pj));
  if (patch.tracks) for (const [k, v] of Object.entries(patch.tracks)) { if (!Array.isArray(v)) die(`tracks.${k} must be a list`); pj.tracks[k] = v.map((c) => ({ id: c.id || crypto.randomBytes(4).toString('hex'), ...c })); }
  if (patch.settings) pj.settings = { ...pj.settings, ...patch.settings };
  // (captions / trackState / logo / subtitles: what is given goes over what is there - a captions patch without its
  // style used to wipe the style, and the editor's Captions panel then could not open)
  for (const k of ['captions', 'trackState', 'markers', 'logo', 'subtitles']) if (k in patch) pj[k] = k === 'markers' || !patch[k] || typeof patch[k] !== 'object' ? patch[k] : { ...(pj[k] || {}), ...patch[k], ...(k === 'captions' && patch[k].style ? { style: { ...(pj.captions?.style || {}), ...patch[k].style } } : {}) };
  const items = await mediaList(), ids = new Set(items.map((m) => m.id));
  const bad = Object.values(pj.tracks).flat().filter((c) => c.mediaId && !ids.has(c.mediaId));
  if (bad.length) die(`${bad.length} clips point to media that is not in the project (e.g. ${bad[0].mediaId}) - use ids from "media"`);
  await saveView(before, pj, 'Claude');
  const by = Object.fromEntries(items.map((m) => [m.id, m]));
  out(`applied - the edit is now ${r2(totalDuration(pj, by))}s, ${Object.entries(pj.tracks).filter(([, l]) => l.length).map(([k, l]) => `${k} ${l.length}`).join(', ')} (a backup of the version before was kept)`);
}
async function cmdOps(f) {
  if (!f || !fs.existsSync(f)) die('ops <file.json>');
  const ops = JSON.parse(fs.readFileSync(f, 'utf8'));
  await snap('ops');
  await project(); // (works out which sequence the ops' paths mean)
  const r = await sendOps(ops);
  out(`applied ${ops.length} change(s), revision ${r.rev}`);
}
async function cmdAgent(f) {
  if (!f || !fs.existsSync(f)) die('agent <opts.json>');
  const o = JSON.parse(fs.readFileSync(f, 'utf8'));
  await snap('agent');
  const job = await api('POST', `/api/agent?p=${enc(PROJ)}`, o);
  const r = await waitJob(job.id, 'agent');
  await api('POST', `/api/agent/applied?p=${enc(PROJ)}`).catch(() => {});
  const pj = await project(); delete pj._rev; const before = JSON.parse(JSON.stringify(pj));
  for (const k of ['V1', 'V2', 'A1', 'A2']) pj.tracks[k] = r.tracks[k] || [];
  if (r.tracks.A3?.length) pj.tracks.A3 = [...(pj.tracks.A3 || []).filter((c) => !c.sfx), ...r.tracks.A3];
  for (const [k, v] of Object.entries(r.trackState || {})) pj.trackState[k] = { ...pj.trackState[k], ...v };
  if (r.aspect && r.aspect !== 'ref') pj.settings.aspect = r.aspect;
  if (r.captions) pj.captions = r.captions;
  if (r.subtitles) pj.subtitles = { ...pj.subtitles, file: r.subtitles };
  if (r.settings) { if (r.settings.look) pj.settings.look = r.settings.look; if ('kenburns' in r.settings) pj.settings.kenburns = r.settings.kenburns; }
  if (r.refLooks) { const by = Object.fromEntries((await mediaList()).map((m) => [m.id, m])); placeRefLooks(pj, r.refLooks, by); arrangeLayers(pj, by); } // (🧱 V2 looks, V3 comps, V4 text)
  pj.agentReport = { at: Date.now(), ...r.report }; pj.agentOpts = o;
  await saveView(before, pj, 'Claude (agent edit)');
  out(`agent edit applied: ${r.tracks.V1.length} shots, ${r.duration}s. ${r.report.warnings.join(' / ')}`);
  const weak = r.report.slots.filter((s) => s.weak).slice(0, 15);
  if (weak.length) out(`weak matches (clip id - sung/spoken text):\n${weak.map((s) => `  ${s.clipId} at ${s.start}s "${(s.text || '').slice(0, 60)}"`).join('\n')}`);
}
async function cmdRender(preview) {
  const pj = await project();
  if (preview) {
    const j = await api('POST', `/api/render?p=${enc(PROJ)}`, { preview: true, ...seqArg() });
    const r = await waitJob(j.id, 'preview');
    return out(`preview: ${P('renders', r.output)}`);
  }
  const preset = flag('preset', 'youtube'), res = flag('res'), name = flag('name');
  const q = await api('POST', `/api/queue?p=${enc(PROJ)}`, { items: [{ ...seqArg(), preset, aspect: pj.settings.aspect, ...(res ? { quality: { res: +res } } : {}), filename: name || pj.name }] });
  const id = q.added[0].id;
  for (let i = 0; ; i++) {
    const it = (await api('GET', '/api/queue')).items.find((x) => x.id === id);
    if (!it || ['done', 'failed', 'cancelled'].includes(it.state)) { if (it?.state !== 'done') die(`render ${it?.state}: ${it?.error || ''}`); return out(`rendered: ${P('renders', it.out)}`); }
    if (i % 15 === 0) console.error(`  render ${it.progress || 0}% ${it.stage || ''}`);
    await new Promise((ok) => setTimeout(ok, 2000));
  }
}
// 🪞 a reference edit, shot by shot (refstyle.mjs finds the cuts and what happens on them)
async function cmdRef(file) {
  if (!file || !fs.existsSync(file)) die('ref <file> - the reference video (or photo) file');
  const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  let w = 0, h = 0, dur = 0;
  try { const j = JSON.parse(pr.stdout); w = j.streams?.[0]?.width || 0; h = j.streams?.[0]?.height || 0; dur = +j.format?.duration || 0; } catch {}
  const name = path.basename(file);
  if (!dur || dur < 0.5) { // a photo / design reference: just show it
    const sh = sheetOf([{ file, t: 0 }], `ref_${crypto.createHash('md5').update(file).digest('hex').slice(0, 8)}`, 1);
    return out(`reference "${name}" - a still ${w}x${h}. Read the sheet to see it:
${sh}`);
  }
  const r = await analyzeReference(file, { cacheFile: path.join(workDir(), `ref_${crypto.createHash('md5').update(file).digest('hex').slice(0, 8)}.json`), width: w, height: h, duration: dur });
  let t = 0;
  const rows = r.shots.map((x, i) => { const a = t; t += x.len; return `${String(i + 1).padStart(3)}. ${r2(a).toFixed(2).padStart(6)}s  ${x.len.toFixed(2)}s  in: ${x.cutIn || 'start'}  motion ${x.motion}`; });
  // one frame from the middle of each shot (at most 40, spread over the piece)
  let mids = [], acc = 0; for (const x of r.shots) { mids.push(r2(acc + x.len / 2)); acc += x.len; }
  if (mids.length > 40) mids = Array.from({ length: 40 }, (_, i) => mids[Math.floor((i * mids.length) / 40)]);
  const sh = sheetOf(mids.map((tt) => ({ file, t: tt })), `ref_${crypto.createHash('md5').update(file + mids.length).digest('hex').slice(0, 8)}`, 5);
  out([`reference "${name}": ${r2(r.duration)}s, ${w}x${h} (${r.aspect || '?'}), ${describeRef(r)}`,
    r.color ? `colour (0..1): mean RGB ${(r.color.mean || []).map((v) => (+v).toFixed(2)).join(" ")}  saturation ${(+r.color.sat).toFixed(2)}` : '',
    'shots (start, length, how it cuts in, motion 0..1):', ...rows,
    describeLooks(r), ...r.shots.map((x, i) => (x.look ? `  shot ${i + 1} look: ${JSON.stringify(x.look)}` : '')).filter(Boolean),
    `one frame per shot, in order (Read it to see what kind of shot each is, the text on screen, the look):\n${sh}`,
    "Rebuild this with the project's own footage: same order of shot kinds and lengths (on the song's beats if there is a song), the same kinds of cuts, text and look. Never put the reference file itself on the timeline.",
    `When the cut is built, run: node engine/edtool.mjs reflook "${file}" - it adds the reference's effects (adjustment layers + cut effects) shot by shot.`].filter(Boolean).join('\n'));
}
// 🎚 the reference's effects on the edit that was built like it: looks as adjustment layers, cut effects on V1
async function cmdRefLook(file) {
  if (!file || !fs.existsSync(file)) die('reflook <ref-file>');
  const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  let w = 0, h = 0, dur = 0;
  try { const j = JSON.parse(pr.stdout); w = j.streams?.[0]?.width || 0; h = j.streams?.[0]?.height || 0; dur = +j.format?.duration || 0; } catch {}
  const ref = await analyzeReference(file, { cacheFile: path.join(workDir(), `ref_${crypto.createHash('md5').update(file).digest('hex').slice(0, 8)}.json`), width: w, height: h, duration: dur });
  await snap('reflook');
  const pj = await project(); delete pj._rev; const before = JSON.parse(JSON.stringify(pj));
  const items = await mediaList(), by = Object.fromEntries(items.map((m) => [m.id, m]));
  const V1 = placed(pj, by).V1.filter((x) => !x.clip.gap);
  if (!V1.length) die('V1 is empty - build the cut first');
  const layers = refAdjustLayers(ref, V1.map((x) => ({ start: x.start, end: x.end })));
  placeRefLooks(pj, layers, by); arrangeLayers(pj, by); // (🧱 V2 looks, V3 comps, V4 text - nothing covering anything)
  const track = Object.keys(pj.tracks).find((t) => pj.tracks[t].some((c) => c.refLook)) || 'V2';
  let cuts = 0;
  if (flag('cuts') !== 'no') {
    V1.forEach((x, k) => {
      const t = k ? ref.shots[k % ref.shots.length].cutIn : null, c = x.clip, i = pj.tracks.V1.indexOf(c);
      if (!t || i <= 0 || pj.tracks.V1[i - 1]?.gap) return;
      if ((t === 'flash' || t === 'whip') && (c.type === 'video' || c.type === 'image')) { c.cutFx = { type: t, dur: CUTFX[t].dur }; cuts++; }
      else if ((t === 'dip' || t === 'fade') && setTransition(pj, by, i, t === 'dip' ? 'fadeblack' : 'fade', 0.4)) cuts++;
    });
  }
  await saveView(before, pj, 'Claude (reference effects)');
  out(`${describeLooks(ref)}\n${layers.length ? `${layers.length} adjustment layer(s) on ${track}: ${layers.map((l) => `${r2(l.start)}-${r2(l.start + l.dur)}s ${l.name.replace('Ref look: ', '')}`).join(' | ')}` : 'no adjustment layers needed'}\n${cuts} cut effect(s) / transition(s) copied from the reference's cuts`);
}
async function cmdStyles() { const r = await api('GET', '/api/styles'); out(r.styles.map((x) => `${x.name}${x.name === r.default ? ' (default)' : ''}: ${x.summary}`).join('\n') || 'no saved styles'); }

const [cmd, ...rest] = argv;
if (!cmd || cmd === 'help') { out(HELP); process.exit(0); }
if (!PROJ) die('no project: set VEDIT_PROJECT or pass --p "<project name>"');
const run = { state: () => cmdState(), media: () => cmdMedia(), find: () => cmdFind(rest), scan: () => cmdScan(), people: () => cmdPeople(), quotes: () => cmdQuotes(), look: () => cmdLook(rest[0]), frames: () => cmdFrames(rest.map(Number)),
  sheet: () => cmdSheet(), song: () => cmdSong(rest[0]), apply: () => cmdApply(rest[0]), ops: () => cmdOps(rest[0]), agent: () => cmdAgent(rest[0]),
  preview: () => cmdRender(true), render: () => cmdRender(false), styles: () => cmdStyles(), ref: () => cmdRef(rest[0]), reflook: () => cmdRefLook(rest[0]) }[cmd];
if (!run) die(`unknown command "${cmd}" - try: node engine/edtool.mjs help`);
await run();
