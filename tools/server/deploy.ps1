# deploy.ps1 - run on the CODING PC (JASPREET): makes the new release of this editor's code and sends it straight to the
# PCs that run it, over SSH (JASPREET's key - tools/access) - never through the NAS:
#   PC A (editor server)   D:\Limelight Release\editor           its tray brings it in once no agent job or render runs
#   PC B (standby)         %LOCALAPPDATA%\LimelightStandby\release\editor   the standby takes it while it only watches
#   this PC's standby      the same folder here, when this PC runs one
# Projects, config.json, ssl and logs are never touched - only code. Helper PCs take the code from the server, as before.
#   Deploy to server.bat            syntax check, then release
#   Deploy to server.bat -Tests     run the auto-tests first (stops if one fails)
#   Deploy to server.bat -NoWait    do not wait to see it arrive on PC A / PC B
param([switch]$Tests, [switch]$NoWait, [string]$Stage = (Join-Path $env:LOCALAPPDATA 'LimelightRelease\editor'))
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $ROOT
# where each PC keeps its release (expanded on that PC)
$TARGETS = [ordered]@{
  'PC A  editor server' = @{ host = 'limelight-a'; dest = 'D:\Limelight Release'; running = 'D:\Video Editor Agent\release.json' }
  'PC B  standby'       = @{ host = 'limelight-b'; dest = '$env:LOCALAPPDATA\LimelightStandby\release'; running = '$env:LOCALAPPDATA\LimelightStandby\editor\release.json' }
}

if (Test-Path (Join-Path $ROOT 'release.json')) { Write-Host "This folder is a deployed copy (it has release.json) - deploy from the coding PC." -ForegroundColor Red; exit 1 }

# 1. the code must at least load
Write-Host 'Checking the code...'
$bad = @()
foreach ($f in @(Get-Item server.mjs) + @(Get-ChildItem engine -Filter *.mjs) + @(Get-ChildItem public\js -Filter *.js)) {
  & node --check $f.FullName 2>$null
  if ($LASTEXITCODE -ne 0) { $bad += $f.Name }
}
if ($bad.Count) { Write-Host "Syntax errors in: $($bad -join ', ') - nothing was released." -ForegroundColor Red; exit 1 }
if ($Tests) {
  Write-Host 'Running the auto-tests...'
  & node tests/run.mjs
  if ($LASTEXITCODE -ne 0) { Write-Host 'A test failed - nothing was released.' -ForegroundColor Red; exit 1 }
}

# 2. the release, made in a folder on this PC
$pack = Join-Path $env:TEMP 'limelight-release.tgz'
try {
  New-Item -ItemType Directory -Force $Stage | Out-Null
  Write-Host "Making the release in $Stage ..."
  $rc = @('/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MT:8')
  # (tools\bench: the speed test, run on the server straight from the release - "Run speed test.bat")
  foreach ($d in 'public', 'engine', 'node_modules', 'tools\farm', 'tools\bench') {
    robocopy (Join-Path $ROOT $d) (Join-Path $Stage $d) /MIR /XD __pycache__ @rc | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copy of $d failed (robocopy $LASTEXITCODE)" }
  }
  # 🔒 browsers get a scrambled copy of the editor's code (public\.dist\js - server.mjs serves it; the readable public\js
  # stays for the server's own imports). The scrambler lives only on this PC (tools\scramble, npm install there once).
  Write-Host 'Scrambling the browser code...'
  & node (Join-Path $ROOT 'tools\scramble\scramble.mjs') (Join-Path $ROOT 'public\js') (Join-Path $Stage 'public\.dist\js')
  if ($LASTEXITCODE -ne 0) { throw 'scrambling the browser code failed (tools\scramble: run "npm install" there)' }
  # (LUTs: added and updated, never deleted - the server may have LUTs of its own)
  robocopy (Join-Path $ROOT 'LUTs') (Join-Path $Stage 'LUTs') /E @rc | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copy of LUTs failed (robocopy $LASTEXITCODE)" }
  robocopy $ROOT $Stage server.mjs package.json package-lock.json 'Limelight Editor (tray).vbs' @rc | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copy of server.mjs failed (robocopy $LASTEXITCODE)" }
  # the release marker: a new id is what the server and the standby look for (no BOM: the standby reads it with JSON.parse)
  $commit = (& git rev-parse --short HEAD 2>$null); $dirty = @(& git status --porcelain 2>$null).Count
  $rel = [ordered]@{ id = (Get-Date -Format 'yyyyMMdd-HHmmss'); at = (Get-Date -Format s); from = $env:COMPUTERNAME; commit = "$commit"; uncommitted = $dirty }
  [IO.File]::WriteAllText((Join-Path $Stage 'release.json'), ($rel | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
  Remove-Item -Force $pack -ErrorAction SilentlyContinue
  & "$env:WINDIR\System32\tar.exe" -c -z -f $pack -C $Stage .
  if ($LASTEXITCODE -ne 0) { throw "packing the release failed (tar $LASTEXITCODE)" }
} catch {
  Write-Host "Release failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
Write-Host "Release $($rel.id) made ($([math]::Round((Get-Item $pack).Length / 1MB)) MB, commit $commit$(if ($dirty) { ", $dirty uncommitted file(s)" }))." -ForegroundColor Green

# 3. 🔑 sent to each PC over SSH and unpacked there (tools\server\receive-release.ps1: a lock while it copies,
# release.json last - a PC never takes half a release)
$recv = Join-Path $PSScriptRoot 'receive-release.ps1'
$sent = @{}
foreach ($k in $TARGETS.Keys) {
  $t = $TARGETS[$k]
  Write-Host "Sending to $k ..."
  $ErrorActionPreference = 'Continue'
  & scp -O -q -o BatchMode=yes -o ConnectTimeout=8 $pack "$($t.host):limelight-release.tgz" 2>$null
  $ok = $LASTEXITCODE -eq 0
  if ($ok) { & scp -O -q -o BatchMode=yes $recv "$($t.host):receive-release.ps1" 2>$null; $ok = $LASTEXITCODE -eq 0 }
  $out = if ($ok) { & ssh -o BatchMode=yes $t.host "powershell -NoProfile -ExecutionPolicy Bypass -File receive-release.ps1 -Archive `"`$HOME\limelight-release.tgz`" -Dest `"$($t.dest)`"" 2>&1 | Where-Object { "$_".Trim() } | Select-Object -Last 1 } else { 'SSH does not answer' } # (PC A's SSH is PowerShell: blank lines after the answer)
  $ErrorActionPreference = 'Stop'
  if ("$out" -match "^OK $($rel.id)") { $sent[$k] = $true; Write-Host "  [OK] $k has release $($rel.id)" -ForegroundColor Green }
  else { Write-Host "  [!!] $k : $out (if SSH stopped answering: run tools\access\allow-jaspreet.ps1 on that PC as administrator)" -ForegroundColor Red }
}
# this PC's own standby (JASPREET runs one): the same release folder here
$mine = Join-Path $env:LOCALAPPDATA 'LimelightStandby'
if (Test-Path (Join-Path $mine 'standby.bat')) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $recv -Archive $pack -Dest (Join-Path $mine 'release') | Out-Null
  Write-Host "  [OK] this PC's standby has release $($rel.id)" -ForegroundColor Green
}
Remove-Item -Force $pack -ErrorAction SilentlyContinue
if (-not $sent.Count) { Write-Host 'No PC got the release.' -ForegroundColor Red; exit 1 }
if ($NoWait) { Write-Host 'The server PC takes it within ~15 s once no agent job or render is running (tray: "Update now" does it at once).'; exit 0 }

# 4. see it arrive: the server's tray and the standby bring it in by themselves
Write-Host "`nWaiting for the PCs to take $($rel.id) (up to 3 minutes)..."
$ErrorActionPreference = 'Continue' # (a PC busy writing its release.json, or away, is just "not yet")
$got = @{}; $t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt 180 -and $got.Count -lt $sent.Count) {
  foreach ($k in $sent.Keys) {
    if ($got[$k]) { continue }
    $f = $TARGETS[$k].running -replace "'", "''"
    $id = try { (& ssh -o BatchMode=yes -o ConnectTimeout=5 $TARGETS[$k].host "`$f = '$f'; `$f = `$ExecutionContext.InvokeCommand.ExpandString(`$f); try { (Get-Content -Raw `$f -ErrorAction Stop | ConvertFrom-Json).id } catch { '-' }" 2>$null | Select-Object -Last 1) } catch { '-' }
    if ("$id".Trim() -eq $rel.id) { $got[$k] = [int]((Get-Date) - $t0).TotalSeconds }
  }
  if ($got.Count -lt $sent.Count) { Start-Sleep 5 }
}
foreach ($k in $sent.Keys) {
  if ($got[$k] -ne $null) { Write-Host ("  [OK] {0,-22} running the new code ({1} s)" -f $k, $got[$k]) -ForegroundColor Green }
  else { Write-Host ("  [..] {0,-22} not yet - busy with an agent job / render (it updates when that ends)" -f $k) -ForegroundColor Yellow }
}
Write-Host '  [OK] helper PCs            take the new code from the server by themselves before their next task' -ForegroundColor Green
