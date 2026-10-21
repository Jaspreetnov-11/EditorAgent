// 🛸 Gyroflow (tools/gyroflow, gyroflow.xyz): stabilises a shot with the camera's own gyro data instead of guessing from
// the picture - GoPro, DJI, Insta360, Sony, Blackmagic… carry it inside the file; an FPV drone's flight controller
// writes it to a Betaflight / Blackbox log (.bbl / .bfl / .csv / .gcsv) next to the video. The result is a new,
// stabilised copy of the file (the editor puts it in Media and on the clip in place of the shaky one).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const gyroflowExe = (root) => { const f = path.join(root, 'tools', 'gyroflow', process.platform === 'win32' ? 'Gyroflow.exe' : 'gyroflow'); return fs.existsSync(f) ? f : null; };
export const LOG_EXT = /\.(bbl|bfl|bin|csv|gcsv|txt|log)$/i;

// a flight log lying next to the video with the same name (FPV: DJI O3 / Walksnail / Runcam + Betaflight blackbox)
export function findLog(video) {
  const dir = path.dirname(video), base = path.parse(video).name.toLowerCase();
  try { return fs.readdirSync(dir).filter((f) => LOG_EXT.test(f) && path.parse(f).name.toLowerCase() === base).map((f) => path.join(dir, f))[0] || null; } catch { return null; }
}

function run(exe, args, onLine, job) {
  return new Promise((ok, bad) => {
    const p = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true });
    if (job) Object.defineProperty(job, 'proc', { value: p, writable: true, configurable: true, enumerable: false }); // (not sent with the job's status)
    let part = '', tail = [];
    const data = (b) => {
      const lines = (part + b.toString('utf8')).replace(/\x1b\[[0-9;]*m/g, '').split(/\r\n|\r|\n/); part = lines.pop();
      for (const l of lines) { if (!l.trim()) continue; tail.push(l); if (tail.length > 40) tail.shift(); onLine?.(l); }
    };
    p.stdout.on('data', data); p.stderr.on('data', data);
    p.on('error', bad);
    p.on('close', (code) => (code === 0 ? ok(tail) : bad(new Error(tail.filter((l) => /error|fail|panic/i.test(l)).pop() || `Gyroflow stopped (code ${code})`))));
  });
}

// does Gyroflow find motion data for this video (in the file, or in the log given)? -> number of moving samples
export async function gyroSamples(exe, video, gyroFile, workDir, job) {
  const out = path.join(workDir, `meta_${Date.now()}.json`);
  await run(exe, [video, ...(gyroFile ? ['-g', gyroFile] : []), '--export-metadata', `3:${out}`], null, job);
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
  fs.rmSync(out, { force: true });
  return rows.filter((r) => (r.org_gyro || []).some((v) => Math.abs(v) > 1e-6) || (r.org_quat && Math.abs(r.org_quat[0] - 1) > 1e-6)).length;
}

// opts: { smoothness 0..1, zoom (1 = Gyroflow's own, >1 crops in more), horizon 0..100 (FPV: keep the horizon level) }
export async function stabilise({ exe, video, gyroFile, outDir, opts = {}, onProgress, job }) {
  fs.mkdirSync(outDir, { recursive: true });
  const preset = { version: 2, stabilization: {
    smoothing_params: [{ name: 'smoothness', value: Math.min(1, Math.max(0.01, opts.smoothness ?? 0.5)) }],
    ...(opts.zoom && opts.zoom !== 1 ? { fov: Math.max(0.5, Math.min(3, 1 / opts.zoom)) } : {}),
    horizon_lock_amount: Math.min(100, Math.max(0, opts.horizon || 0)), horizon_lock_roll: 0 } };
  const outParams = { output_folder: `${outDir.replace(/\\/g, '/')}/`, codec: 'H.264/AVC', bitrate: Math.max(20, Math.min(300, opts.bitrate || 80)), use_gpu: true, audio: true };
  const q = (o) => JSON.stringify(o).replace(/"/g, "'");
  let outName = null;
  await run(exe, [video, ...(gyroFile ? ['-g', gyroFile] : []), '-f', '--stdout-progress', '-t', '_gyroflow', '--preset', q(preset), '-p', q(outParams)], (l) => {
    const m = /Rendering progress: (\d+)\/(\d+)/.exec(l); if (m) onProgress?.(+m[1] / Math.max(1, +m[2]));
    const d = /Rendering completed: (.+)$/.exec(l); if (d) outName = d[1].trim();
  }, job);
  const out = path.join(outDir, outName || `${path.parse(video).name}_gyroflow.mp4`);
  if (!fs.existsSync(out)) throw new Error('Gyroflow finished but its file is missing');
  return out;
}
