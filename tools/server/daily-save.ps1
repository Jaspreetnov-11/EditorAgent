# daily-save.ps1 - 💾 every night on the coding PC (Task Scheduler "Limelight Daily Save", 23:30): the whole working
# folder as it is - committed or not, new files too (not what .gitignore keeps out) - saved as a snapshot commit under
# refs/daily/<date>, so no day's work is lost if the PC fails. It does not touch the branch, the files or the index.
#   see them:   git log --oneline refs/daily/2026-10-28        bring one back:  git checkout refs/daily/2026-10-28 -- <file>
# The newest 60 days are kept.
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $ROOT
$log = Join-Path $ROOT 'logs\daily-save.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Say($m) { Add-Content -Path $log -Value "$(Get-Date -Format s)  $m"; Write-Host $m }
try {
  $day = Get-Date -Format 'yyyy-MM-dd'
  $idx = Join-Path $env:TEMP "limelight-daily-index-$PID"
  Remove-Item -Force $idx -ErrorAction SilentlyContinue
  $env:GIT_INDEX_FILE = $idx
  & git read-tree HEAD; if ($LASTEXITCODE) { throw 'git read-tree failed' }
  & git add -A; if ($LASTEXITCODE) { throw 'git add failed' }
  $tree = (& git write-tree).Trim()
  Remove-Item Env:\GIT_INDEX_FILE; Remove-Item -Force $idx -ErrorAction SilentlyContinue
  $head = (& git rev-parse HEAD).Trim()
  if ($tree -eq (& git rev-parse 'HEAD^{tree}').Trim()) { Say "$day nothing new since the last commit ($((& git rev-parse --short HEAD).Trim()))"; exit 0 }
  $n = @(& git diff --name-only $head $tree).Count
  $snap = (& git commit-tree $tree -p $head -m "Daily save $day $(Get-Date -Format 'HH:mm') - $n file(s) not yet committed").Trim()
  & git update-ref "refs/daily/$day" $snap
  Say "$day saved $n file(s) as refs/daily/$day ($($snap.Substring(0, 8)))"
  # (older than 60 days: let go)
  foreach ($r in (& git for-each-ref --format='%(refname)' refs/daily/)) { $d = $r -replace '^refs/daily/', ''; try { if ([datetime]::ParseExact($d, 'yyyy-MM-dd', $null) -lt (Get-Date).AddDays(-60)) { & git update-ref -d $r } } catch {} }
} catch { Say "FAILED: $($_.Exception.Message)"; exit 1 }
