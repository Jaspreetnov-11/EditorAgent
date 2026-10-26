# install.ps1 - 🧰 the Limelight Kit: makes this PC a full Limelight PC from the NAS, WITHOUT the internet - the same
# engines as JASPREET: Node.js, FFmpeg, Python 3.12 + every AI library (Whisper, PyTorch on the card, OpenCV, CLIP,
# Demucs, OCR...), all AI models, the Limelight Editor app, JASPREET's access (SSH / Remote Desktop) and the helper.
# Double-click "Install Limelight.bat" (kit-start.ps1 copies the kit to C:\LimelightKit and opens this as administrator),
# or over SSH from JASPREET (from a local copy - the SSH side does not see the NAS):
#   powershell -ExecutionPolicy Bypass -File "\\192.168.0.99\Team Editing\Limelight Kit\install.ps1" -Role helper -Token <farm token>
# -Role  helper (default: every engine + helps the editor) | bridge (helper + standby, Limelight Flow, office watch)
#        | server (engines, models, app, access - the editor server itself, no helper) | app (only the Limelight Editor app)
# Safe to run again: whatever is there already is kept (only what is missing or older is copied).
# -UserLocal / -UserRoaming: the signed-in user's folders (an administrator window may be another account); -Pause: wait
# for Enter at the end (kit-start.ps1 opens this in its own window).
param([ValidateSet('helper', 'bridge', 'server', 'app')][string]$Role = 'helper', [string]$Token = '',
  [string]$UserLocal = $env:LOCALAPPDATA, [string]$UserRoaming = $env:APPDATA, [switch]$Pause)
$ErrorActionPreference = 'Continue'
$K = $PSScriptRoot
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Bye($code) { if ($Pause) { Read-Host "`nPress Enter to close" | Out-Null }; exit $code }
function Path-Refresh { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Has($cmd, $arg = '--version') { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { return $false }; try { $o = (& $cmd $arg 2>&1 | Out-String); return [bool]$o.Trim() } catch { return $false } }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Say 'Double-click "Install Limelight.bat" in the kit folder (it asks Windows for administrator itself).' Yellow; Bye 1
}
# (/MT:2, not 8: five PCs installing at once with 8 copies each choked the NAS for the whole office)
$rc = @('/E', '/XO', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MT:2')
$isJaspreet = $env:COMPUTERNAME -eq 'JASPREET'
Say "`n=== Limelight Kit on $env:COMPUTERNAME ($Role) ===" Cyan

if ($Role -ne 'app') {
  # ---- 1. programs ----
  Say "`n1/6  Programs" Cyan
  Path-Refresh
  if (-not (Has node)) { Say '      Node.js...'; Start-Process msiexec.exe -ArgumentList "/i `"$(Get-ChildItem "$K\programs\node-*.msi" | Select-Object -First 1 -ExpandProperty FullName)`" /qn /norestart" -Wait; Path-Refresh }
  Say ("      Node.js: " + $(if (Has node) { (& node --version) } else { 'MISSING' }))
  if (-not (Has ffmpeg -version)) {
    Say '      FFmpeg...'
    $fd = "$env:ProgramFiles\Limelight\ffmpeg\bin"; New-Item -ItemType Directory -Force $fd | Out-Null
    Copy-Item "$K\programs\ffmpeg\bin\*" $fd -Force
    $mp = [Environment]::GetEnvironmentVariable('Path', 'Machine'); if ($mp -notlike "*$fd*") { [Environment]::SetEnvironmentVariable('Path', "$mp;$fd", 'Machine') }
    Path-Refresh
  }
  Say ("      FFmpeg: " + $(if (Has ffmpeg -version) { ((& ffmpeg -version | Select-Object -First 1) -replace 'Copyright.*') } else { 'MISSING' }))
  # (a real Python 3.12 - not Windows' Store shortcut, which only opens the Store)
  $py = (& python --version 2>$null) -match '3\.12'
  if (-not $py) { Say '      Python 3.12...'; Start-Process "$K\programs\python-3.12.10-amd64.exe" -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0 Include_launcher=1' -Wait; Path-Refresh }
  Say ("      Python: " + $(if ((& python --version 2>$null) -match '3\.12') { (& python --version) } else { 'MISSING' }))

  # ---- 2. AI libraries, from the kit's own wheels (no internet) ----
  Say "`n2/6  AI libraries (from the kit, a few minutes the first time)" Cyan
  & python -m pip install --no-index --find-links "$K\wheels" -r "$K\requirements.txt" --quiet --disable-pip-version-check 2>&1 | Select-Object -Last 3 | ForEach-Object { Say "      $_" DarkGray }
  & python -c "import faster_whisper, ctranslate2, torch, cv2, transformers, easyocr; print('      Whisper on card:', ctranslate2.get_cuda_device_count() > 0, '| PyTorch on card:', torch.cuda.is_available())" 2>$null

  # ---- 3. AI models ----
  # (kit-start.ps1 already copied them as the user - its local copy has no models\ folder)
  Say "`n3/6  AI models (copied once, then only what is new)" Cyan
  if (-not (Test-Path "$K\models")) { Say '      already copied by the starter' } else {
    robocopy "$K\models\hf-cache" "$env:USERPROFILE\.cache\huggingface\hub" @rc | Out-Null; Say '      Whisper, CLIP, Demucs, voice: copied'
    robocopy "$K\models\ai" "$env:LOCALAPPDATA\Limelight\AI" @rc | Out-Null; Say '      Agent vision model + local AI: copied'
    if ($Role -eq 'server' -and (Test-Path 'D:\Video Editor Agent')) { robocopy "$K\models\editor" 'D:\Video Editor Agent\Models' @rc | Out-Null; Say '      editor models (faces, cut-outs): copied' }
  }
}

# ---- 4. the Limelight Editor app (opens the editor in its own window, Desktop + Start menu) ----
Say "`n4/6  Limelight Editor app" Cyan
$app = "$env:ProgramFiles\Limelight\Editor App"
robocopy "$K\browser" $app /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
$ws = New-Object -ComObject WScript.Shell
foreach ($lnk in @("$env:PUBLIC\Desktop\Limelight Editor.lnk", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Limelight Editor.lnk")) {
  $s = $ws.CreateShortcut($lnk); $s.TargetPath = "$app\Limelight Editor.exe"; $s.WorkingDirectory = $app; $s.IconLocation = "$app\Limelight Editor.exe"; $s.Save()
}
Say "      $app - icon on every user's Desktop and Start menu"
if ($Role -eq 'app') { Say "`nDone." Green; Bye 0 }

# ---- 5. JASPREET's access (SSH with its key, Remote Desktop) ----
Say "`n5/6  JASPREET's access" Cyan
if ($isJaspreet) { Say '      (this is JASPREET - nothing to do)' }
else { & powershell -NoProfile -ExecutionPolicy Bypass -File "$K\access\allow-jaspreet.ps1" | Select-Object -Last 4 | ForEach-Object { Say "      $_" } }

# ---- 6. helping the editor (and the bridge's own programs) ----
Say "`n6/6  Helper" Cyan
$user = (Get-CimInstance Win32_ComputerSystem).UserName; if (-not $user) { $user = "$env:COMPUTERNAME\$env:USERNAME" }
if ($Role -in 'helper', 'bridge') {
  $wd = "$UserLocal\LimelightWorker"; New-Item -ItemType Directory -Force $wd | Out-Null
  if ($Token) { $m = [regex]::Matches($Token, '\b[0-9a-f]{24}\b'); if ($m.Count) { Set-Content "$wd\token.txt" $m[$m.Count - 1].Value -NoNewline -Encoding ascii } }
  if (-not (Test-Path "$wd\token.txt")) { $t = Read-Host '      Farm token (editor > Team > Helper PCs - the 24 letters at the end)'; $m = [regex]::Matches($t, '\b[0-9a-f]{24}\b'); if ($m.Count) { Set-Content "$wd\token.txt" $m[$m.Count - 1].Value -NoNewline -Encoding ascii } }
  if (Test-Path "$wd\token.txt") {
    # (one helper per PC: older ones - maybe with a wrong token - stop first)
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'LimelightWorker\\worker\.(bat|mjs)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Copy-Item "$K\helper\Start Render Worker.bat" "$wd\worker.bat" -Force
    Set-Content "$wd\hidden.vbs" "CreateObject(""WScript.Shell"").Run """"""$wd\worker.bat"""" hidden"", 0, False" -Encoding ascii
    $su = "$UserRoaming\Microsoft\Windows\Start Menu\Programs\Startup\Limelight Render Worker.vbs"; if (Test-Path $su) { Remove-Item $su -Force } # (the task below starts it now)
    $act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$wd\hidden.vbs`""
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName 'Limelight Helper' -Action $act -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) -Settings $set -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited) -Force | Out-Null
    Start-ScheduledTask -TaskName 'Limelight Helper'
    Say '      helper on - starts hidden at every sign-in (task "Limelight Helper"); log: %LOCALAPPDATA%\LimelightWorker\worker.log' Green
  } else { Say '      no farm token given - helper not set up (run this again with the token)' Yellow }
}
if ($Role -eq 'bridge') { & powershell -NoProfile -ExecutionPolicy Bypass -File "$K\access\bridge-autostart.ps1" | ForEach-Object { Say "      $_" } }
if ($Role -eq 'server') { Say '      (the editor server itself - no helper)' }
Say "`nDone on $env:COMPUTERNAME. Check: powershell -File `"$K\engine-check.ps1`"" Green
Bye 0
