# receive-release.ps1 - runs ON the server PC / standby PC (sent by deploy.ps1 over SSH): unpacks a release archive into
# this PC's release folder. The lock is up while it copies, and release.json is written last, so the tray (PC A) or the
# standby (PC B, JASPREET) only ever take a complete release. Nothing here touches the running editor itself.
#   powershell -File receive-release.ps1 -Archive <release.tgz> -Dest <release folder> [-Smoke]   (Dest gets \editor)
# -Smoke (the standby PC, before PC A gets it): the new release is first started as a throwaway editor on spare ports
# with an empty data folder - it must answer, serve its pages and its (scrambled) code - and only then put in place.
param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Dest, [switch]$Smoke)
$ErrorActionPreference = 'Stop'
$Dest = $ExecutionContext.InvokeCommand.ExpandString($Dest)
$Archive = (Resolve-Path $ExecutionContext.InvokeCommand.ExpandString($Archive)).Path
$ed = Join-Path $Dest 'editor'
$in = Join-Path $Dest 'incoming'
New-Item -ItemType Directory -Force $ed | Out-Null
$lock = Join-Path $ed 'deploying.lock'
Set-Content -Path $lock -Value "$env:COMPUTERNAME $(Get-Date -Format s)"
try {
  if (Test-Path $in) { Remove-Item -Recurse -Force $in }
  New-Item -ItemType Directory -Force $in | Out-Null
  & "$env:WINDIR\System32\tar.exe" -x -f $Archive -C $in
  if ($LASTEXITCODE -ne 0) { throw "unpacking failed (tar $LASTEXITCODE)" }
  if (-not (Test-Path (Join-Path $in 'release.json'))) { throw 'the archive has no release.json' }
  if ($Smoke) {
    $data = Join-Path $env:TEMP "limelight-smoke-$PID"
    New-Item -ItemType Directory -Force $data | Out-Null
    $envs = @{ PORT = '3989'; TEAM_PORT = '3988'; TEAM_WEB_PORT = '3987'; TEAM_TLS_PORT = '3986'; SHARE_PORT = '3985'; FARM_PORT = '3984'; VEDIT_DATA = $data; VEDIT_NO_RESUME = '1'; VEDIT_CLUSTER = '0' }
    foreach ($k in $envs.Keys) { [Environment]::SetEnvironmentVariable($k, $envs[$k], 'Process') }
    $p = Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $in -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $data 'out.log') -RedirectStandardError (Join-Path $data 'err.log')
    try {
      $okv = $false
      for ($i = 0; $i -lt 60 -and -not $okv; $i++) { Start-Sleep -Milliseconds 500; try { $okv = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:3989/api/version').StatusCode -eq 200 } catch {} }
      if (-not $okv) { throw "the new release did not start: $((Get-Content (Join-Path $data 'err.log') -Raw -ErrorAction SilentlyContinue) -replace '\s+', ' ' | Select-Object -First 1)" }
      $page = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 'http://127.0.0.1:3989/').Content
      if ($page -notmatch '<html') { throw 'the new release does not serve its page' }
      $js = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 'http://127.0.0.1:3989/js/main.js').Content
      if ($js.Length -lt 1000) { throw 'the new release does not serve its code' }
      $proj = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Method Post -ContentType 'application/json' -Body '{"name":"Smoke"}' 'http://127.0.0.1:3989/api/projects'
      if ($proj.StatusCode -ne 200) { throw 'the new release cannot make a project' }
    } finally {
      # (a helper process of the trial editor that has already ended makes taskkill complain - not a failed release)
      try { & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null } catch {}
      Start-Sleep 1
      Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
    }
  }
  & robocopy $in $ed /MIR /XF release.json deploying.lock /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /MT:8 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copy failed (robocopy $LASTEXITCODE)" }
  Copy-Item -Force (Join-Path $in 'release.json') (Join-Path $ed 'release.json')
  "OK " + (Get-Content -Raw (Join-Path $ed 'release.json') | ConvertFrom-Json).id + $(if ($Smoke) { ' (tried: starts, serves, makes a project)' } else { '' })
} catch {
  "FAILED " + $_.Exception.Message
} finally {
  Remove-Item -Force $lock -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $in -ErrorAction SilentlyContinue
  Remove-Item -Force $Archive -ErrorAction SilentlyContinue
}
