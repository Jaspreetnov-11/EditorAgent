// voices.mjs - AI voice-over. Two providers:
//   edge   Microsoft Edge neural voices via engine/tts.py (free; the text goes to Microsoft's speech service)
//   eleven ElevenLabs (your API key from config.json; paid per character; your own / cloned voices)
// speak() writes an mp3 and, if asked, subtitles (.srt) timed from the voice's own word timings.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const TTS_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts.py');

const tc = (t) => { const ms = Math.round(Math.max(0, t) * 1000), p = (x, w = 2) => String(x).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
function runPy(python, args) {
  return new Promise((ok) => {
    const p = spawn(python, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => ok({ code, out, err })); p.on('error', (e) => ok({ code: -1, out, err: String(e) }));
  });
}

let edgeVoices = null;
export async function listVoices(provider, { python, key }) {
  if (provider === 'eleven') {
    if (!key) throw new Error('Add your ElevenLabs API key first');
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
    if (!r.ok) throw new Error(`ElevenLabs: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name, locale: v.labels?.accent || v.labels?.language || '', gender: v.labels?.gender || '', own: v.category === 'cloned' || v.category === 'generated' }))
      .sort((a, b) => Number(b.own) - Number(a.own));
  }
  if (!edgeVoices) {
    const r = await runPy(python, [TTS_PY, 'voices']);
    if (r.code !== 0) throw new Error(`Voice list failed (is the internet on? is edge-tts installed?): ${r.err.slice(-300)}`);
    edgeVoices = JSON.parse(r.out);
  }
  return edgeVoices;
}

// words [[start, end, text]] -> .srt (up to 7 words a line, broken where the voice pauses; no overlaps)
function wordsSrt(words) {
  const lines = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const nx = words[i + 1];
    if (cur.length >= 7 || !nx || nx[0] - w[1] > 0.3 || /[।.?!|]$/.test(w[2])) { lines.push(cur); cur = []; }
  });
  return lines.map((l, i) => `${i + 1}\n${tc(l[0][0])} --> ${tc(Math.min(l[l.length - 1][1] + 0.15, lines[i + 1] ? lines[i + 1][0][0] - 0.02 : Infinity))}\n${l.map((w) => w[2]).join(' ')}\n`).join('\n');
}

// rate: -50..+50 (% slower / faster). Returns { out, srt, duration }.
export async function speak({ provider, voice, text, rate = 0, out, srt = null, python, key }) {
  text = String(text || '').replace(/\*+/g, '').trim();
  if (!text) throw new Error('Nothing to say - the text is empty');
  if (provider === 'eleven') {
    if (!key) throw new Error('Add your ElevenLabs API key first');
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: Math.min(1.2, Math.max(0.7, 1 + rate / 100)) } }),
    });
    if (!r.ok) throw new Error(`ElevenLabs: ${r.status} ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    fs.writeFileSync(out, Buffer.from(j.audio_base64, 'base64'));
    // characters with times -> words
    const al = j.alignment || j.normalized_alignment, words = [];
    if (al?.characters) {
      let w = null;
      al.characters.forEach((ch, i) => {
        if (/\s/.test(ch)) { if (w) { words.push(w); w = null; } return; }
        if (!w) w = [al.character_start_times_seconds[i], al.character_end_times_seconds[i], ch];
        else { w[1] = al.character_end_times_seconds[i]; w[2] += ch; }
      });
      if (w) words.push(w);
    }
    if (srt && words.length) fs.writeFileSync(srt, wordsSrt(words), 'utf8');
    return { out, srt: srt && words.length ? srt : null, duration: words.length ? words[words.length - 1][1] : null };
  }
  const tmp = path.join(os.tmpdir(), `tts-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`);
  fs.writeFileSync(tmp, text, 'utf8');
  const r = await runPy(python, [TTS_PY, 'say', tmp, voice, out, '--rate', `${rate >= 0 ? '+' : ''}${Math.round(rate)}%`, ...(srt ? ['--srt', srt] : [])]);
  fs.rmSync(tmp, { force: true });
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`Voice failed (internet needed for Edge voices): ${r.err.slice(-300)}`);
  const res = JSON.parse(r.out.trim().split(/\r?\n/).pop());
  return { out, srt: srt && fs.existsSync(srt) ? srt : null, duration: res.duration };
}
