# kit-start.ps1 - what "Install Limelight.bat" runs, as the signed-in user (NOT as administrator).
# Why: an administrator window does not see the NAS drive (Z: is mapped only for the normal user, and the NAS asks
# for a password the admin side does not have), so "Run as administrator" on the NAS .bat just flashed and closed.
# So this part, as the user: asks the PC's role, copies the AI models straight to where they live (they are per-user),
# copies programs + AI libraries + app to C:\LimelightKit, and only then opens install.ps1 from C:\LimelightKit
# as administrator (Windows asks Yes / No once).
# -Role skips the question; -NoElevate only copies (for checks over SSH, where nobody can press Yes).
param([ValidateSet('', 'helper', 'bridge', 'server', 'app')][string]$Role = '', [switch]$NoElevate)
$ErrorActionPreference = 'Continue'
$K = $PSScriptRoot
$L = 'C:\LimelightKit'
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
# (/MT:8 again: the queue below lets only one PC copy at a time - five at once with 8 copies each had choked the NAS)
$rc = @('/E', '/XO', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MT:8')

Say "`n=== Limelight Kit on $env:COMPUTERNAME ===" Cyan
if (-not $Role) {
  Say ' 1  Helper PC        (every engine; helps the editor with renders, previews, AI)'
  Say ' 2  Bridge PC        (helper + standby editor, Limelight Flow, office watch)'
  Say ' 3  Editor server    (engines, models, app, access - no helper)'
  Say ' 4  Only the app     (Limelight Editor window on this PC)'
  do { $n = (Read-Host 'What is this PC? [1-4]').Trim() } until ($n -in '1', '2', '3', '4')
  $Role = @{ '1' = 'helper'; '2' = 'bridge'; '3' = 'server'; '4' = 'app' }[$n]
}

if ($K.TrimEnd('\') -ne $L) {
  # 🚦 one PC copies from the NAS at a time (five at once took the NAS down to 14 MB/s for the whole office): the others
  # wait here and go on by themselves. The turn is a folder on the NAS (made or not, in one step); one older than
  # 90 min, or this PC's own from a closed window, is taken over.
  $turn = "$K\queue\copying"
  New-Item -ItemType Directory -Force "$K\queue" | Out-Null
  $said = $false
  while ($true) {
    try { New-Item -ItemType Directory $turn -ErrorAction Stop | Out-Null; Set-Content "$turn\pc.txt" $env:COMPUTERNAME; break } catch {}
    $who = (Get-Content "$turn\pc.txt" -ErrorAction SilentlyContinue) -join ''
    $age = try { ((Get-Date) - (Get-Item $turn).CreationTime).TotalMinutes } catch { 0 }
    if ($who -eq $env:COMPUTERNAME -or $age -gt 90) { Remove-Item $turn -Recurse -Force -ErrorAction SilentlyContinue; continue }
    if (-not $said) { Say "`n$who is copying the kit now - this PC waits for its turn and then goes on by itself (keep this window open)." Yellow; $said = $true }
    Start-Sleep 20
  }
  Say "`nThis PC's turn to copy." Green
  try {
  if ($Role -ne 'app') {
    $need = 30GB; $free = (Get-PSDrive C).Free
    if ($free -lt $need -and -not (Test-Path "$env:USERPROFILE\.cache\huggingface\hub")) { Say ("`nC: has only {0:N0} GB free - the kit needs about 30 GB. Free some space and run this again." -f ($free / 1GB)) Yellow; exit 1 }
    Say "`nAI models (copied once, then only what is new - 20 GB the first time, ~5 min)" Cyan
    robocopy "$K\models\hf-cache" "$env:USERPROFILE\.cache\huggingface\hub" @rc | Out-Null; Say '      Whisper, CLIP, Demucs, voice: copied'
    robocopy "$K\models\ai" "$env:LOCALAPPDATA\Limelight\AI" @rc | Out-Null; Say '      Agent vision model + local AI: copied'
    if ($Role -eq 'server' -and (Test-Path 'D:\Video Editor Agent')) { robocopy "$K\models\editor" 'D:\Video Editor Agent\Models' @rc | Out-Null; Say '      editor models (faces, cut-outs): copied' }
  }
  Say "`nCopying the kit to $L (programs, AI libraries, app)..." Cyan
  New-Item -ItemType Directory -Force $L | Out-Null
  robocopy $K $L /XO /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null   # (the top files only)
  $dirs = @('browser', 'access', 'helper'); if ($Role -ne 'app') { $dirs += 'programs', 'wheels' }
  foreach ($d in $dirs) { robocopy "$K\$d" "$L\$d" @rc | Out-Null }
  } finally { Remove-Item $turn -Recurse -Force -ErrorAction SilentlyContinue } # (the next PC's turn - the install itself reads only C:)
  if (-not (Test-Path "$L\install.ps1")) { Say "Could not copy the kit to $L." Red; exit 1 }
}

if ($NoElevate) { Say "`nCopied. As administrator run: powershell -ExecutionPolicy Bypass -File $L\install.ps1 -Role $Role" Green; exit 0 }
Say "`nNow the installer opens as administrator - press Yes when Windows asks." Cyan
$a = "-NoProfile -ExecutionPolicy Bypass -File `"$L\install.ps1`" -Role $Role -Pause -UserLocal `"$env:LOCALAPPDATA`" -UserRoaming `"$env:APPDATA`""
try { Start-Process powershell.exe -Verb RunAs -ArgumentList $a -ErrorAction Stop }
catch { Say 'Windows did not allow administrator (No was pressed?). Run "Install Limelight.bat" again and press Yes.' Yellow; exit 1 }
Say 'The installer runs in the new blue window. This window can be closed.' Green
