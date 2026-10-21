// Built-in sound-effects library for trailer-style sound design: whooshes, booms, impacts, risers, a reverse swell,
// glitches, ticks and punches. They are synthesised with FFmpeg (no downloads, no licences) into <root>/SFX/ the first
// time the editor starts; your own .wav/.mp3 files dropped into SFX/ are used too (the name decides the kind, e.g.
// "whoosh 2.wav"). Each built-in file is 48 kHz stereo; `peak` = where the sound hits hardest (seconds from its start),
// which is what gets lined up with a cut.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 2; // bump to regenerate the built-in files after changing a recipe below
// a cheap per-sample noise source for aevalsrc: random(n) keeps its own state in variable n
const N = (k) => `(random(${k})*2-1)`;
export const SFX_KINDS = {
  whoosh: { label: 'Whoosh', dur: 0.9, peak: 0.5,
    src: `${N(0)}*pow(sin(PI*pow(t/0.9,0.75)),3)|${N(1)}*pow(sin(PI*pow(max(0,t-0.05)/0.85,0.75)),3)`,
    af: 'highpass=f=180,lowpass=f=2600,highpass=f=180,aecho=0.6:0.4:40:0.25' },
  swish: { label: 'Swish (short)', dur: 0.4, peak: 0.2,
    src: `${N(0)}*pow(sin(PI*t/0.4),4)|${N(1)}*pow(sin(PI*t/0.4),4)`, af: 'highpass=f=900,lowpass=f=7000' },
  boom: { label: 'Boom', dur: 2.2, peak: 0.02,
    src: `(0.9*sin(2*PI*(42*t+130*(1-exp(-t*9))/9))*exp(-t*2.1)+0.5*${N(0)}*exp(-t*38))`,
    af: 'lowpass=f=2200,aecho=0.7:0.5:70|140:0.3|0.18', stereo: true },
  impact: { label: 'Impact (trailer hit)', dur: 2.8, peak: 0.02,
    src: `(0.7*sin(2*PI*(38*t+110*(1-exp(-t*7))/7))*exp(-t*1.8)+0.22*(sin(2*PI*98*t)+sin(2*PI*147.3*t)+0.8*sin(2*PI*233.1*t)+0.6*sin(2*PI*311.7*t)+0.4*sin(2*PI*415.3*t))*exp(-t*2.6)+0.6*${N(0)}*exp(-t*25))`,
    af: 'lowpass=f=5000,aecho=0.8:0.6:60|120|190:0.35|0.25|0.15', stereo: true },
  riser: { label: 'Riser (build-up)', dur: 4, peak: 3.98,
    // a sine gliding 180 -> 1800 Hz with a pulsing tremolo that speeds up, plus rising noise; it stops dead at the end
    src: `(0.45*sin(2*PI*180*4/log(10)*(pow(10,t/4)-1))*(0.6+0.4*sin(2*PI*(2*t+1.6*t*t)))+0.12*${N(0)})*pow(t/4,2)*if(gt(t,3.97),(4-t)/0.03,1)`,
    af: 'highpass=f=120,lowpass=f=9000,aecho=0.6:0.5:35:0.3', stereo: true },
  reverse: { label: 'Reverse swell', dur: 1.6, peak: 1.58, from: 'impact', reverse: true },
  glitch: { label: 'Glitch', dur: 0.45, peak: 0.05,
    src: `0.5*if(gt(sin(2*PI*(160+1600*abs(sin(floor(t*28)*12.9898)))*t),0),1,-1)*gt(abs(sin(floor(t*28)*78.233)),0.35)*if(gt(t,0.4),(0.45-t)/0.05,1)`,
    af: 'acrusher=bits=6:mode=log:aa=1,highpass=f=150', stereo: true },
  tick: { label: 'Tick', dur: 0.15, peak: 0.005,
    src: `(0.6*${N(0)}*exp(-t*110)+0.5*sin(2*PI*2400*t)*exp(-t*70))`, af: 'highpass=f=900', stereo: true },
  punch: { label: 'Punch', dur: 0.7, peak: 0.01,
    src: `(sin(2*PI*(48*t+150*(1-exp(-t*30))/30))*exp(-t*6)+0.45*${N(0)}*exp(-t*60))`, af: 'lowpass=f=4000', stereo: true },
};

// async, so making the library never blocks the editor's server
const exec = (args) => new Promise((ok) => { const p = spawn('ffmpeg', args, { windowsHide: true }); let e = ''; p.stderr.on('data', (d) => (e += d)); p.on('close', () => ok(e)); p.on('error', () => ok(e)); });
const ff = (args) => exec(['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const fileOf = (dir, kind) => path.join(dir, `${kind}.wav`);

// Writes any missing / outdated built-in effects into dir. Safe to call often (fast when they exist).
export async function ensureSfx(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = path.join(dir, '.builtin.json');
  let ver = 0; try { ver = JSON.parse(fs.readFileSync(stamp, 'utf8')).version; } catch {}
  const made = new Set();
  const make = async (kind) => {
    const k = SFX_KINDS[kind], out = fileOf(dir, kind);
    if (made.has(kind) || (ver === VERSION && fs.existsSync(out))) return;
    made.add(kind);
    if (k.from) {
      await make(k.from);
      // the tail of the source turned round: grows from nothing into the hit
      await ff(['-i', fileOf(dir, k.from), '-af', `atrim=0:${k.dur},areverse,afade=t=in:d=${(k.dur * 0.6).toFixed(2)}`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out]);
      return;
    }
    const expr = k.stereo ? `${k.src}|${k.src.replace(/random\(0\)/g, 'random(1)')}` : k.src, raw = `${out}.raw.wav`;
    await ff(['-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=${k.dur}`, '-af', k.af, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', raw]);
    // even loudness across the library (the recipes come out anywhere from -8 to -31 dB), then a peak limiter
    const vd = await exec(['-hide_banner', '-i', raw, '-af', 'volumedetect', '-f', 'null', '-']);
    const mean = +(/mean_volume: (-?[\d.]+) dB/.exec(vd)?.[1] ?? -18);
    await ff(['-i', raw, '-af', `volume=${(-17 - mean).toFixed(1)}dB,alimiter=limit=0.89:level=false`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out]);
    fs.rmSync(raw, { force: true });
  };
  for (const kind of Object.keys(SFX_KINDS)) await make(kind);
  fs.writeFileSync(stamp, JSON.stringify({ version: VERSION }));
}

// Every usable effect in dir: built-ins plus your own files, as [{ kind, file, label, peak }].
// Your own files win over the built-in of the same kind ("whoosh_big.wav" counts as a whoosh).
export function listSfx(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(f)) continue;
    const base = path.parse(f).name.toLowerCase(), builtin = base in SFX_KINDS;
    const kind = builtin ? base : Object.keys(SFX_KINDS).find((k) => base.includes(k)) || (/hit|bass|drop/.test(base) ? 'boom' : /swoosh|swipe|whip/.test(base) ? 'whoosh' : /rise|build/.test(base) ? 'riser' : null);
    if (!kind) continue;
    out.push({ kind, file: path.join(dir, f), label: builtin ? SFX_KINDS[kind].label : path.parse(f).name, peak: builtin ? SFX_KINDS[kind].peak : null, own: !builtin });
  }
  return out.sort((a, b) => Number(b.own) - Number(a.own));
}
