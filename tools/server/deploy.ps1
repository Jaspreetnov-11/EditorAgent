# deploy.ps1 - run on the CODING PC (JASPREET): puts this editor's code on the NAS as the new release
# (Z:\Limelight Standby\editor). From there the server PC's tray brings it in by itself once no agent job or render
# is running, and the standby PC picks it up while it is only watching. Projects, config.json, ssl and logs are never
# touched - only code. Helper PCs take the code from the server, as before.
#   Deploy to server.bat            syntax check, then release
#   Deploy to server.bat -Tests     run the auto-tests first (stops if one fails)
#   Deploy to server.bat -NoWait    do not wait to see it arrive on PC A / PC B (over SSH)
param([switch]$Tests, [switch]$NoWait, [string]$Release = 'Z:\Limelight Standby\editor')
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $ROOT

if (Test-Path (Join-Path $ROOT 'release.json')) { Write-Host "This folder is a deployed copy (it has release.json) - deploy from the coding PC." -ForegroundColor Red; exit 1 }
if (-not (Test-Path (Split-Path -Parent $Release))) { Write-Host "$(Split-Path -Parent $Release) not found - is the NAS (Z:) there?" -ForegroundColor Red; exit 1 }

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

# 2. copy, with a lock so the server and the standby never take a half-copied release
New-Item -ItemType Directory -Force $Release | Out-Null
$lock = Join-Path $Release 'deploying.lock'
Set-Content -Path $lock -Value "$env:COMPUTERNAME $(Get-Date -Format s)"
try {
  Write-Host "Copying the code to $Release ..."
  $rc = @('/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MT:8')
  # (tools\bench: the speed test, run on the server straight from the release - "Run speed test.bat")
  foreach ($d in 'public', 'engine', 'node_modules', 'tools\farm', 'tools\bench') {
    robocopy (Join-Path $ROOT $d) (Join-Path $Release $d) /MIR /XD __pycache__ @rc | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copy of $d failed (robocopy $LASTEXITCODE)" }
  }
  # 🔒 browsers get a scrambled copy of the editor's code (public\.dist\js - server.mjs serves it; the readable public\js
  # stays for the server's own imports). The scrambler lives only on this PC (tools\scramble, npm install there once).
  Write-Host 'Scrambling the browser code...'
  & node (Join-Path $ROOT 'tools\scramble\scramble.mjs') (Join-Path $ROOT 'public\js') (Join-Path $Release 'public\.dist\js')
  if ($LASTEXITCODE -ne 0) { throw 'scrambling the browser code failed (tools\scramble: run "npm install" there)' }
  # (LUTs: added and updated, never deleted - the server may have LUTs of its own)
  robocopy (Join-Path $ROOT 'LUTs') (Join-Path $Release 'LUTs') /E @rc | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copy of LUTs failed (robocopy $LASTEXITCODE)" }
  robocopy $ROOT $Release server.mjs package.json package-lock.json 'Limelight Editor (tray).vbs' @rc | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copy of server.mjs failed (robocopy $LASTEXITCODE)" }

  # 3. the release marker - written last; a new id is what the server and the standby look for
  $commit = (& git rev-parse --short HEAD 2>$null); $dirty = @(& git status --porcelain 2>$null).Count
  $rel = [ordered]@{ id = (Get-Date -Format 'yyyyMMdd-HHmmss'); at = (Get-Date -Format s); from = $env:COMPUTERNAME; commit = "$commit"; uncommitted = $dirty }
  # (no BOM: the standby reads it with JSON.parse)
  [IO.File]::WriteAllText((Join-Path $Release 'release.json'), ($rel | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
} catch {
  Write-Host "Release failed: $($_.Exception.Message)" -ForegroundColor Red
  Remove-Item -Force $lock -ErrorAction SilentlyContinue
  exit 1
}
Remove-Item -Force $lock -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "Released $($rel.id) (commit $commit$(if ($dirty) { ", $dirty uncommitted file(s)" }))." -ForegroundColor Green
if ($NoWait) { Write-Host 'The server PC takes it within ~15 s once no agent job or render is running (tray: "Update from NAS" does it now).'; exit 0 }

# 4. 🔑 see it arrive on every PC (JASPREET's SSH key - tools/access): the server, the standby, the helpers
Write-Host "`nWaiting for the PCs to take $($rel.id) (up to 3 minutes)..."
$ErrorActionPreference = 'Continue' # (a PC busy writing its release.json, or away, is just "not yet")
$pcs = [ordered]@{
  'PC A  editor server' = @{ host = 'limelight-a'; file = 'D:\Video Editor Agent\release.json' }
  'PC B  standby'       = @{ host = 'limelight-b'; file = '$env:LOCALAPPDATA\LimelightStandby\editor\release.json' }
}
$got = @{}; $t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt 180 -and $got.Count -lt $pcs.Count) {
  foreach ($k in $pcs.Keys) {
    if ($got[$k]) { continue }
    $f = $pcs[$k].file -replace "'", "''"
    $id = try { (& ssh -o BatchMode=yes -o ConnectTimeout=5 $pcs[$k].host "`$f = '$f'; `$f = `$ExecutionContext.InvokeCommand.ExpandString(`$f); try { (Get-Content -Raw `$f -ErrorAction Stop | ConvertFrom-Json).id } catch { '-' }" 2>$null | Select-Object -Last 1) } catch { '-' }
    if ("$id".Trim() -eq $rel.id) { $got[$k] = [int]((Get-Date) - $t0).TotalSeconds }
  }
  if ($got.Count -lt $pcs.Count) { Start-Sleep 5 }
}
foreach ($k in $pcs.Keys) {
  if ($got[$k] -ne $null) { Write-Host ("  [OK] {0,-22} new code in {1} s" -f $k, $got[$k]) -ForegroundColor Green; continue }
  # (SSH does not answer: say so - the PC may well have the new code; then JASPREET's access needs "Allow JASPREET" again)
  $ip = @{ 'limelight-a' = '192.168.0.200'; 'limelight-b' = '192.168.0.205' }[$pcs[$k].host]
  $c = New-Object Net.Sockets.TcpClient; $ssh = $c.ConnectAsync($ip, 22).Wait(3000); $c.Close()
  if (-not $ssh) { Write-Host ("  [??] {0,-22} SSH does not answer - cannot check (run Z:\Limelight Access\allow-jaspreet.ps1 there again)" -f $k) -ForegroundColor Yellow }
  else { Write-Host ("  [..] {0,-22} not yet - busy with an agent job / render (it updates when that ends)" -f $k) -ForegroundColor Yellow }
}
Write-Host '  [OK] helper PCs            take the new code from the server by themselves before their next task' -ForegroundColor Green
