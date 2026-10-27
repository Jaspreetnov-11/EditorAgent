# receive-release.ps1 - runs ON the server PC / standby PC (sent by deploy.ps1 over SSH): unpacks a release archive into
# this PC's release folder. The lock is up while it copies, and release.json is written last, so the tray (PC A) or the
# standby (PC B, JASPREET) only ever take a complete release. Nothing here touches the running editor itself.
#   powershell -File receive-release.ps1 -Archive <release.tgz> -Dest <release folder>   (Dest gets \editor inside)
param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Dest)
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
  & robocopy $in $ed /MIR /XF release.json deploying.lock /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /MT:8 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copy failed (robocopy $LASTEXITCODE)" }
  Copy-Item -Force (Join-Path $in 'release.json') (Join-Path $ed 'release.json')
  "OK " + (Get-Content -Raw (Join-Path $ed 'release.json') | ConvertFrom-Json).id
} finally {
  Remove-Item -Force $lock -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $in -ErrorAction SilentlyContinue
  Remove-Item -Force $Archive -ErrorAction SilentlyContinue
}
