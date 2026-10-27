// sysstats.mjs - 📊 the owner's Performance view: how hard each PC of the editor works right now - CPU, memory, and each
// NVIDIA card's load, video memory, temperature and power (nvidia-smi). The server samples itself every 10 s; each
// helper PC sends the same from engine/worker.mjs with its hello (worker.mjs keeps its own copy: it imports nothing).
// One sample: { t, cpu (%), ramUsed, ramTotal (MB), gpus: [{ name, util, enc, dec (%), memUsed, memTotal (MB), temp (°C), power, powerMax (W) }] }
import os from 'node:os';
import { execFile } from 'node:child_process';

export const SMI_FIELDS = ['name', 'utilization.gpu', 'utilization.encoder', 'utilization.decoder', 'memory.used', 'memory.total', 'temperature.gpu', 'power.draw', 'power.limit'];
const KEYS = ['name', 'util', 'enc', 'dec', 'memUsed', 'memTotal', 'temp', 'power', 'powerMax'];

// nvidia-smi --format=csv,noheader,nounits -> one object per card ("[N/A]" / "[Not Supported]" -> null)
export function parseSmi(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const v = l.split(',').map((x) => x.trim()), g = {};
    KEYS.forEach((k, i) => {
      if (k === 'name') { g.name = v[i] || 'GPU'; return; }
      const n = parseFloat(v[i]);
      g[k] = Number.isFinite(n) ? Math.round(n) : null;
    });
    return g;
  });
}

// the cards right now ([] without an NVIDIA card / driver)
export function gpuStats() {
  return new Promise((ok) => {
    execFile('nvidia-smi', [`--query-gpu=${SMI_FIELDS.join(',')}`, '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 8000 }, (e, out) => ok(e ? [] : parseSmi(out)));
  });
}

// CPU % of the whole computer since the last call (the first call: since the computer started)
const cpuTimes = () => { let idle = 0, total = 0; for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; } return { idle, total }; };
let prev = cpuTimes();
export function cpuNow() {
  const n = cpuTimes(), d = n.total - prev.total, r = d > 0 ? Math.round(100 * (1 - (n.idle - prev.idle) / d)) : 0;
  prev = n;
  return Math.max(0, Math.min(100, r));
}
// each core's % since the last call (how many of the cores are really at work)
const coreTimes = () => os.cpus().map((c) => { let t = 0; for (const v of Object.values(c.times)) t += v; return { idle: c.times.idle, total: t }; });
let prevCores = coreTimes();
export function coresNow() {
  const n = coreTimes(), r = n.map((c, i) => { const p = prevCores[i], d = p ? c.total - p.total : 0; return d > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - (c.idle - p.idle) / d)))) : 0; });
  prevCores = n;
  return r;
}
export const BUSY_CORE = 50; // (a core above this % counts as busy)

// the drives: this PC's own disks, and (net) the NAS shares it has as drive letters. Win32_LogicalDisk as JSON ->
// [{ root: 'D:', total, free (GB), net }]. Read every 5 minutes (disks fill slowly; PowerShell takes a second).
export const DISK_PS = "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 3,4 -and $_.Size } | Select-Object DeviceID,DriveType,Size,FreeSpace | ConvertTo-Json -Compress";
export function parseDisks(json) {
  let a; try { a = JSON.parse(String(json || '').trim() || '[]'); } catch { return []; }
  return (Array.isArray(a) ? a : [a]).filter((d) => d && d.Size > 0).map((d) => ({ root: String(d.DeviceID || '?').slice(0, 4), total: Math.round(d.Size / 1073741824), free: Math.round(d.FreeSpace / 1073741824), net: d.DriveType === 4 }));
}
let disks = [], disksAt = 0;
export function diskStats() {
  if (process.platform !== 'win32' || Date.now() - disksAt < 300e3) return Promise.resolve(disks);
  disksAt = Date.now();
  return new Promise((ok) => execFile('powershell.exe', ['-NoProfile', '-Command', DISK_PS], { windowsHide: true, timeout: 20000 }, (e, out) => { if (!e) disks = parseDisks(out); ok(disks); }));
}

// 🎬 what the editor ITSELF takes on this PC - its process and everything it started (project workers, FFmpeg, the AI's
// Python...), not the PC's other programs: CPU (% of the whole PC), RAM / VRAM (MB), GPU (% of the busiest engine), and
// the biggest by name. Windows' own counters (Process, GPU Engine, GPU Process Memory - also what Task Manager reads), one
// PowerShell every 30 s (it takes ~3 s). engine/worker.mjs has the same for a helper (it imports nothing).
export const APP_PS = (root) => `$root = ${Math.trunc(root) || 0}; $ErrorActionPreference = 'SilentlyContinue'; $n = [Environment]::ProcessorCount
$c = Get-Counter -Counter '\\Process(*)\\ID Process', '\\Process(*)\\Creating Process ID', '\\Process(*)\\% Processor Time', '\\Process(*)\\Working Set - Private', '\\GPU Engine(*)\\Utilization Percentage', '\\GPU Process Memory(*)\\Dedicated Usage'
$P = @{}; $G = @{}; $M = @{}
foreach ($s in $c.CounterSamples) {
  $k = $s.Path.Split('\\')[-1]
  if ($s.Path -match '\\\\gpu engine\\(pid_(\\d+)_.*engtype_([^)]+)\\)') { $key = "$($matches[1])|$($matches[2])"; $G[$key] = [double]$G[$key] + $s.CookedValue; continue }
  if ($s.Path -match '\\\\gpu process memory\\(pid_(\\d+)_') { $M[[int]$matches[1]] = [double]$M[[int]$matches[1]] + $s.CookedValue; continue }
  if ($s.Path -notmatch '\\\\process\\(([^)]+)\\)\\\\') { continue }; $i = $matches[1]
  if (-not $P[$i]) { $P[$i] = @{ name = ($i -replace '#\\d+$', '') } }; $P[$i][$k] = $s.CookedValue
}
$kids = @{}; $byId = @{}
foreach ($x in $P.Values) { $id = [int]$x['id process']; if ($id -le 0) { continue }; $byId[$id] = $x; $pp = [int]$x['creating process id']; if (-not $kids[$pp]) { $kids[$pp] = New-Object System.Collections.ArrayList }; [void]$kids[$pp].Add($id) }
$seen = @{}; $q = New-Object System.Collections.Queue; $q.Enqueue($root)
while ($q.Count) { $id = $q.Dequeue(); if ($seen[$id]) { continue }; $seen[$id] = 1; foreach ($k in @($kids[$id])) { if ($k) { $q.Enqueue($k) } } }
foreach ($k in @($kids[$PID])) { if ($k) { $seen.Remove($k) } }; $seen.Remove($PID) # (not this measuring PowerShell itself)
$cpu = 0; $ram = 0; $vram = 0; $eng = @{}; $by = @{}
foreach ($id in $seen.Keys) {
  $x = $byId[$id]; if (-not $x) { continue }
  $pc = [double]$x['% processor time'] / $n; $mb = [double]$x['working set - private'] / 1MB
  $cpu += $pc; $ram += $mb; $vram += [double]$M[$id] / 1MB
  $nm = $x.name; if (-not $by[$nm]) { $by[$nm] = @{ name = $nm; cpu = 0; ram = 0; n = 0 } }; $by[$nm].cpu += $pc; $by[$nm].ram += $mb; $by[$nm].n++
}
foreach ($key in $G.Keys) { $p2, $t = $key.Split('|'); if ($seen[[int]$p2]) { $eng[$t] = [double]$eng[$t] + $G[$key] } }
$gpu = 0; foreach ($v in $eng.Values) { if ($v -gt $gpu) { $gpu = $v } }
@{ cpu = [math]::Round($cpu); ram = [math]::Round($ram); gpu = [math]::Round([math]::Min(100, $gpu)); vram = [math]::Round($vram); procs = $seen.Count
  top = @($by.Values | Sort-Object { $_.ram } -Descending | Select-Object -First 5 | ForEach-Object { @{ name = $_.name; n = $_.n; cpu = [math]::Round($_.cpu); ram = [math]::Round($_.ram) } }) } | ConvertTo-Json -Compress -Depth 4`;
export function parseApp(json) {
  let a; try { a = JSON.parse(String(json || '').trim()); } catch { return null; }
  return cleanApp(a);
}
let app = null, appAt = 0;
// disk: the drive the editor keeps its things on (the server: its data folder's), for its health
export function appStats(root = process.pid, disk = '') {
  if (process.platform !== 'win32' || Date.now() - appAt < 30e3) return Promise.resolve(app);
  appAt = Date.now();
  return new Promise((ok) => execFile('powershell.exe', ['-NoProfile', '-Command', APP_PS(root)], { windowsHide: true, timeout: 25000 }, (e, out) => { if (!e) { const a = parseApp(out); if (a) app = { ...a, disk: String(disk).slice(0, 2).toUpperCase() }; } ok(app); }));
}

export async function liveStats({ disk = '' } = {}) {
  const [gpus, dk, ap] = await Promise.all([gpuStats(), diskStats(), appStats(process.pid, disk)]);
  return { t: Date.now(), cpu: cpuNow(), cores: coresNow(), ramUsed: Math.round((os.totalmem() - os.freemem()) / 1048576), ramTotal: Math.round(os.totalmem() / 1048576), gpus, disks: dk, app: ap };
}

// a sample a helper sent, made safe (numbers in range, short names, at most 8 cards)
const num = (v, max) => (v == null || !Number.isFinite(+v) ? null : Math.max(0, Math.min(max, Math.round(+v))));
export function cleanLive(s) {
  if (!s || typeof s !== 'object') return null;
  return { t: Date.now(), cpu: num(s.cpu, 100), cores: (Array.isArray(s.cores) ? s.cores : []).slice(0, 512).map((v) => num(v, 100) || 0), ramUsed: num(s.ramUsed, 1 << 22), ramTotal: num(s.ramTotal, 1 << 22),
    gpus: (Array.isArray(s.gpus) ? s.gpus : []).slice(0, 8).map((g) => ({ name: String(g?.name || 'GPU').slice(0, 60), util: num(g?.util, 100), enc: num(g?.enc, 100), dec: num(g?.dec, 100),
      memUsed: num(g?.memUsed, 1 << 20), memTotal: num(g?.memTotal, 1 << 20), temp: num(g?.temp, 150), power: num(g?.power, 5000), powerMax: num(g?.powerMax, 5000) })),
    disks: (Array.isArray(s.disks) ? s.disks : []).slice(0, 26).map((d) => ({ root: String(d?.root || '?').slice(0, 4), total: num(d?.total, 1 << 20) || 0, free: num(d?.free, 1 << 20) || 0, net: !!d?.net })),
    app: cleanApp(s.app) };
}
// the editor's own share of a PC (appStats), made safe - null when the PC did not measure it
export function cleanApp(a) {
  if (!a || typeof a !== 'object') return null;
  return { cpu: num(a.cpu, 100) || 0, ram: num(a.ram, 1 << 22) || 0, gpu: num(a.gpu, 100) || 0, vram: num(a.vram, 1 << 20) || 0, procs: num(a.procs, 10000) || 0, disk: /^[A-Za-z]:$/.test(a.disk || '') ? a.disk.toUpperCase() : '',
    top: (Array.isArray(a.top) ? a.top : []).slice(0, 5).map((x) => ({ name: String(x?.name || '?').slice(0, 40), n: num(x?.n, 10000) || 1, cpu: num(x?.cpu, 100) || 0, ram: num(x?.ram, 1 << 22) || 0 })) };
}

// the last hour, small: { t, cpu, ram (%), gpu (% of the busiest card), vram (% of all cards' memory), power (W of all cards) }
export function point(s) {
  const g = s.gpus || [], mem = g.reduce((a, x) => a + (x.memTotal || 0), 0), A = s.app;
  if (A) return { t: s.t, cpu: A.cpu, ram: s.ramTotal ? Math.round((100 * A.ram) / s.ramTotal) : 0, gpu: g.length ? A.gpu : null, vram: mem ? Math.round((100 * A.vram) / mem) : null, power: g.length ? g.reduce((a, x) => a + (x.power || 0), 0) : null };
  return { t: s.t, cpu: s.cpu ?? 0, ram: s.ramTotal ? Math.round((100 * s.ramUsed) / s.ramTotal) : 0, gpu: g.length ? Math.max(...g.map((x) => x.util ?? 0)) : null,
    vram: mem ? Math.round((100 * g.reduce((a, x) => a + (x.memUsed || 0), 0)) / mem) : null, power: g.length ? g.reduce((a, x) => a + (x.power || 0), 0) : null };
}
export function addPoint(hist, s, keepMs = 3600e3) {
  hist.push(point(s));
  const cut = Date.now() - keepMs;
  while (hist.length && hist[0].t < cut) hist.shift();
  return hist;
}

// ❤ health 0-100 (100 = nothing to worry about) and ⚡ load 0-100 (how busy) - simple rules, each one named in why[]
const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(v)));
// 🎬 a PC that measures the editor's own share (live.app) is judged on what touches the editor's work only: the card
// while the editor uses it (hot), the editor's own memory, and the drive the editor keeps its things on - not the PC's
// other drives or programs. Older helpers (no app) keep the PC-wide rules below.
export function pcHealth(p) {
  if (p.off) return { score: 50, why: ['not connected'] }; // (a helper PC that is off at night is not an emergency)
  const L = p.live; if (!L) return { score: 100, why: [] };
  let s = 100; const why = [];
  const dock = (n, w) => { s -= n; why.push(w); };
  const A = L.app;
  if (A) {
    if (A.gpu >= 10) for (const g of L.gpus || []) { if (g.temp >= 83) dock(30, `${g.name} ${g.temp} °C`); else if (g.temp >= 76) dock(10, `${g.name} warm (${g.temp} °C)`); }
    const r = L.ramTotal ? A.ram / L.ramTotal : 0;
    if (r >= 0.8) dock(25, `editor uses ${Math.round(r * 100)}% of RAM`); else if (r >= 0.6) dock(10, `editor uses ${Math.round(r * 100)}% of RAM`);
    const d = (L.disks || []).find((x) => !x.net && x.total && x.root.toUpperCase().startsWith(A.disk || '?'));
    if (d) { const f = d.free / d.total; if (f < 0.05) dock(30, `${d.root} almost full (the editor's drive)`); else if (f < 0.1) dock(15, `${d.root} filling up (the editor's drive)`); }
    if (p.work?.paused) why.push('paused - its own user is busy on it');
    return { score: clamp100(s), why };
  }
  for (const g of L.gpus || []) { if (g.temp >= 83) dock(30, `${g.name} ${g.temp} °C`); else if (g.temp >= 76) dock(10, `${g.name} warm (${g.temp} °C)`); }
  const ram = L.ramTotal ? L.ramUsed / L.ramTotal : 0;
  if (ram >= 0.95) dock(25, `RAM ${Math.round(ram * 100)}%`); else if (ram >= 0.9) dock(10, `RAM ${Math.round(ram * 100)}%`);
  for (const d of (L.disks || []).filter((x) => !x.net && x.total)) { const f = d.free / d.total; if (f < 0.05) dock(30, `${d.root} almost full`); else if (f < 0.1) dock(15, `${d.root} filling up`); }
  if (p.work?.paused) why.push('paused - its own user is busy on it');
  return { score: clamp100(s), why };
}
export function pcLoad(L) {
  if (!L) return 0;
  const g = L.gpus || [], A = L.app;
  if (A) { const mem = g.reduce((n, x) => n + (x.memTotal || 0), 0); return clamp100(Math.max(A.cpu, g.length ? A.gpu : 0, mem ? (100 * A.vram) / mem : 0)); } // (🎬 the editor's own)
  return clamp100(Math.max(L.cpu || 0, ...g.map((x) => x.util || 0), ...g.map((x) => (x.memTotal ? (100 * (x.memUsed || 0)) / x.memTotal : 0))));
}
// the NAS: { free, total (GB), ms: [recent probe times, ms], errors (failed probes in a row), busy, max (long runs reading it), pending (saves waiting) }
export function nasHealth(n) {
  if (!n) return { score: 0, why: ['no NAS'] };
  let s = 100; const why = [];
  const dock = (k, w) => { s -= k; why.push(w); };
  if (n.errors >= 2) dock(60, 'does not answer'); else if (n.errors) dock(20, 'missed a check');
  if (n.total) { const f = n.free / n.total; if (f < 0.05) dock(50, `${Math.round(f * 100)}% free - almost full`); else if (f < 0.1) dock(30, `${Math.round(f * 100)}% free`); else if (f < 0.15) dock(15, `${Math.round(f * 100)}% free`); else if (f < 0.2) dock(5, `${Math.round(f * 100)}% free`); }
  const ms = median(n.ms || []);
  if (ms > 1000) dock(30, `slow to answer (${ms} ms)`); else if (ms > 300) dock(15, `slowish (${ms} ms)`); else if (ms > 120) dock(5, `${ms} ms to answer`);
  if (n.pending) dock(30, `${n.pending} saves waiting for it`);
  return { score: clamp100(s), why };
}
export function nasLoad(n) {
  if (!n) return 0;
  const ms = median(n.ms || []);
  return clamp100(Math.max(n.max ? (100 * (n.busy || 0)) / n.max : 0, ((ms - 20) / 480) * 100));
}
export function median(a) { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : 0; }

// everything added up for the top of the page
export function totals(pcs) {
  const on = pcs.filter((p) => p.live), gpus = on.flatMap((p) => p.live.gpus || []);
  const sum = (a, k) => a.reduce((n, x) => n + (x[k] || 0), 0);
  // (own disks of every PC; the NAS once - every PC sees the same shares, so the biggest of each size counts)
  const own = on.flatMap((p) => (p.live.disks || []).filter((d) => !d.net)), nas = new Map();
  for (const d of on.flatMap((p) => (p.live.disks || []).filter((x) => x.net))) nas.set(`${d.total}`, d);
  return { pcs: on.length, cores: sum(on, 'cores'), busyCores: on.reduce((n, p) => n + (p.live.cores || []).filter((v) => v >= BUSY_CORE).length, 0), diskTotal: sum(own, 'total'), diskFree: sum(own, 'free'), nasTotal: sum([...nas.values()], 'total'), nasFree: sum([...nas.values()], 'free'), ramUsed: sum(on.map((p) => p.live), 'ramUsed'), ramTotal: sum(on.map((p) => p.live), 'ramTotal'),
    gpus: gpus.length, vramUsed: sum(gpus, 'memUsed'), vramTotal: sum(gpus, 'memTotal'), power: gpus.some((g) => g.power != null) ? sum(gpus, 'power') : null, hottest: gpus.length ? Math.max(...gpus.map((g) => g.temp || 0)) : null,
    cpu: on.length ? Math.round(sum(on.map((p) => ({ v: (p.live.cpu || 0) * (p.cores || 1) })), 'v') / Math.max(1, sum(on, 'cores'))) : 0,
    // 🎬 the editor's own share, all PCs together (only those that measured it)
    app: (() => { const m = on.filter((p) => p.live.app); if (!m.length) return null; const a = m.map((p) => p.live.app);
      return { pcs: m.length, cpu: Math.round(sum(m.map((p) => ({ v: p.live.app.cpu * (p.cores || 1) })), 'v') / Math.max(1, sum(m, 'cores'))), ram: sum(a, 'ram'), vram: sum(a, 'vram'), gpu: Math.max(...a.map((x) => x.gpu || 0)), procs: sum(a, 'procs') }; })() };
}
