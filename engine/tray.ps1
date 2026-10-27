# Limelight tray: runs the editor server (node server.mjs) with no console window, puts the Limelight icon next to the
# clock, starts it again if it stops by itself, and can start with Windows. Started by "Limelight Editor (tray).vbs".
# Menu: Open editor, Restart server, Show log, Start with Windows, Quit. Restart / Quit ask first while an agent job
# or a render is running (never cut one off without a yes).
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$ROOT = Split-Path -Parent $PSScriptRoot
$LOGS = Join-Path $ROOT 'logs'
$LOG = Join-Path $LOGS 'server.log'
$URL = 'http://localhost:3000/'
$VBS = Join-Path $ROOT 'Limelight Editor (tray).vbs'
$STARTUP = Join-Path ([Environment]::GetFolderPath('Startup')) 'Limelight Editor.lnk'

# one tray at a time
$mutex = New-Object System.Threading.Mutex($false, 'Local\LimelightEditorTray')
if (-not $mutex.WaitOne(0)) { exit }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { [System.Windows.Forms.MessageBox]::Show('Node.js is not installed. Install it from https://nodejs.org and start again.', 'Limelight Editor') | Out-Null; exit 1 }
New-Item -ItemType Directory -Force $LOGS | Out-Null

$script:proc = $null
$script:quitting = $false
$script:restarts = @()

function Start-Server {
  if ((Test-Path $LOG) -and (Get-Item $LOG).Length -gt 20MB) { Move-Item -Force $LOG "$LOG.old" }
  Add-Content -Path $LOG -Value "`r`n===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') starting the editor =====" -Encoding UTF8
  $si = New-Object System.Diagnostics.ProcessStartInfo
  $si.FileName = $env:ComSpec
  $si.Arguments = "/d /c `"`"$node`" server.mjs >> `"$LOG`" 2>&1`""
  $si.WorkingDirectory = $ROOT
  # more file workers for Node: slow NAS reads (scans, proxies) must not hold up the editor's own files
  $si.EnvironmentVariables['UV_THREADPOOL_SIZE'] = '32'
  $si.UseShellExecute = $false
  $si.CreateNoWindow = $true
  $script:proc = [System.Diagnostics.Process]::Start($si)
}

# the editor process and everything it started (FFmpeg, Claude...) - only ours, nothing else on the computer
function Stop-Server {
  if ($script:proc -and -not $script:proc.HasExited) {
    & taskkill.exe /PID $script:proc.Id /T /F | Out-Null
    $script:proc.WaitForExit(10000) | Out-Null
  }
  $script:proc = $null
}

function Save-Projects {
  try {
    foreach ($p in (Get-ChildItem (Join-Path $ROOT 'Projects') -Directory -ErrorAction Stop)) {
      try { Invoke-RestMethod -Method Post -Uri ($URL + 'api/live/save?p=' + [uri]::EscapeDataString($p.Name)) -TimeoutSec 5 | Out-Null } catch {}
    }
  } catch {}
}

# what would be cut off: running agent / Claude / other jobs and renders in the queue
function Get-Busy {
  $busy = @()
  try { $busy += @(Invoke-RestMethod ($URL + 'api/jobs') -TimeoutSec 5) | Where-Object { $_.status -eq 'running' } | ForEach-Object { "$($_.kind) ($($_.project))" } } catch {}
  try { $busy += @((Invoke-RestMethod ($URL + 'api/queue') -TimeoutSec 5).items) | Where-Object { $_.state -in 'rendering', 'waiting' } | ForEach-Object { "render $($_.out) ($($_.state))" } } catch {}
  return $busy
}
function Confirm-Stop([string]$what) {
  $busy = Get-Busy
  if (-not $busy.Count) { return $true }
  $msg = "These are still running and will be stopped:`r`n`r`n" + ($busy -join "`r`n") + "`r`n`r`n$what anyway?"
  return ([System.Windows.Forms.MessageBox]::Show($msg, 'Limelight Editor', 'YesNo', 'Warning') -eq 'Yes')
}

function Set-Startup([bool]$on) {
  if ($on) {
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($STARTUP)
    $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $s.Arguments = "`"$VBS`""
    $s.WorkingDirectory = $ROOT
    $s.IconLocation = Join-Path $ROOT 'public\img\favicon.ico'
    $s.Description = 'Starts the Limelight Video Editor in the tray'
    $s.Save()
  } elseif (Test-Path $STARTUP) { Remove-Item -Force $STARTUP }
}

# ---- new code (tools/server/deploy.ps1 on the coding PC sends a release straight to this PC over SSH) ----
# Only on the server PC: a copy that came from a release has release.json; the coding PC's own folder never does.
# Brought in by itself once no agent job or render is running (projects saved first), or at once from the menu.
# 🔒 The release waits in a folder on this PC (D:\Limelight Release\editor next to the editor) - never on the NAS.
$RELEASE = if ($env:LIMELIGHT_RELEASE) { $env:LIMELIGHT_RELEASE } else { Join-Path (Split-Path -Parent $ROOT) 'Limelight Release\editor' }
$script:deployed = Test-Path (Join-Path $ROOT 'release.json')
$script:failedRel = $null
$script:nextRelCheck = Get-Date
function Get-ReleaseId([string]$dir) { try { return (Get-Content -Raw (Join-Path $dir 'release.json') | ConvertFrom-Json).id } catch { return $null } }
function Get-NewRelease {
  $id = Get-ReleaseId $RELEASE
  if (-not $id -or $id -eq (Get-ReleaseId $ROOT)) { return $null }
  $lock = Join-Path $RELEASE 'deploying.lock'
  if ((Test-Path $lock) -and ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes -lt 30) { return $null } # (still being copied)
  return $id
}
function Update-Code([string]$id) {
  $icon.Text = 'Limelight Editor - updating'
  Save-Projects; $script:quitting = $true; Stop-Server
  $rc = @('/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MT:8')
  $ok = $true
  foreach ($d in 'public', 'engine', 'node_modules', 'tools\farm') {
    robocopy (Join-Path $RELEASE $d) (Join-Path $ROOT $d) /MIR /XD __pycache__ @rc | Out-Null
    if ($LASTEXITCODE -ge 8) { $ok = $false }
  }
  robocopy (Join-Path $RELEASE 'LUTs') (Join-Path $ROOT 'LUTs') /E @rc | Out-Null
  if ($LASTEXITCODE -ge 8) { $ok = $false }
  robocopy $RELEASE $ROOT server.mjs package.json package-lock.json 'Limelight Editor (tray).vbs' @rc | Out-Null
  if ($LASTEXITCODE -ge 8) { $ok = $false }
  # (the marker last: if anything failed, this copy still counts as the old release)
  if ($ok) { Copy-Item -Force (Join-Path $RELEASE 'release.json') (Join-Path $ROOT 'release.json') }
  Add-Content -Path $LOG -Value "`r`n===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') code update $id from $RELEASE : $(if ($ok) { 'done' } else { 'FAILED' }) =====" -Encoding UTF8
  $script:quitting = $false
  Start-Server
  if ($ok) { $script:failedRel = $null; $icon.ShowBalloonTip(5000, 'Limelight Editor', "New code ($id) is in - the editor restarted.", 'Info') }
  else { $script:failedRel = $id; $icon.ShowBalloonTip(8000, 'Limelight Editor', "Code update $id could not be copied completely - see the log. The editor runs again.", 'Error') }
}

# ---- the icon and its menu ----
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = New-Object System.Drawing.Icon (Join-Path $ROOT 'public\img\favicon.ico')
$icon.Text = 'Limelight Editor - starting'
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$mOpen = $menu.Items.Add('Open editor')
$mOpen.Font = New-Object System.Drawing.Font($mOpen.Font, [System.Drawing.FontStyle]::Bold)
$mRestart = $menu.Items.Add('Restart server')
$mLog = $menu.Items.Add('Show log')
$mFolder = $menu.Items.Add('Open editor folder')
# (only on the server PC - a deployed copy has release.json; the coding PC never gets this item)
if ($script:deployed) { $mUpdate = $menu.Items.Add('Update now (new code)') }
$menu.Items.Add('-') | Out-Null
$mStartup = New-Object System.Windows.Forms.ToolStripMenuItem 'Start with Windows'
$mStartup.Checked = Test-Path $STARTUP
$menu.Items.Add($mStartup) | Out-Null
$menu.Items.Add('-') | Out-Null
$mQuit = $menu.Items.Add('Quit (stop the editor)')
$icon.ContextMenuStrip = $menu

$mOpen.add_Click({ Start-Process $URL })
$icon.add_MouseDoubleClick({ Start-Process $URL })
$mLog.add_Click({ Start-Process notepad.exe $LOG })
$mFolder.add_Click({ Start-Process explorer.exe $ROOT })
if ($mUpdate) {
  $mUpdate.add_Click({
    $id = Get-NewRelease
    if (-not $id) { [System.Windows.Forms.MessageBox]::Show("No new release - this editor already runs release $(Get-ReleaseId $ROOT).", 'Limelight Editor') | Out-Null; return }
    if (-not (Confirm-Stop 'Update and restart')) { return }
    Update-Code $id
  })
}
$mStartup.add_Click({ $mStartup.Checked = -not $mStartup.Checked; Set-Startup $mStartup.Checked })
$mRestart.add_Click({
  if (-not (Confirm-Stop 'Restart')) { return }
  $icon.Text = 'Limelight Editor - restarting'
  Save-Projects; $script:quitting = $true; Stop-Server; $script:quitting = $false
  Start-Server
})
$mQuit.add_Click({
  if (-not (Confirm-Stop 'Quit')) { return }
  $script:quitting = $true
  Save-Projects; Stop-Server
  $timer.Stop(); $icon.Visible = $false; $icon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

# ---- keep it running: if the server stops by itself, start it again (not more than 5 times in 5 minutes) ----
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  if ($script:quitting) { return }
  if ($script:proc -and $script:proc.HasExited) {
    $now = Get-Date
    $script:restarts = @($script:restarts | Where-Object { ($now - $_).TotalMinutes -lt 5 }) + $now
    if ($script:restarts.Count -gt 5) {
      $script:proc = $null
      $icon.Text = 'Limelight Editor - stopped (see log)'
      $icon.ShowBalloonTip(8000, 'Limelight Editor stopped', 'The editor keeps stopping. Right-click the icon > Show log, then Restart server.', 'Error')
      return
    }
    $icon.ShowBalloonTip(4000, 'Limelight Editor', 'The editor stopped - starting it again.', 'Warning')
    Start-Server
  }
  if ($script:proc -and -not $script:proc.HasExited) { $icon.Text = 'Limelight Editor - running (localhost:3000)' }
  # new code in the release folder: looked for every 15 s, brought in only while nothing is running
  if ($script:deployed -and (Get-Date) -ge $script:nextRelCheck) {
    $script:nextRelCheck = (Get-Date).AddSeconds(15) # (a release reaches the server within ~15 s of "Deploy to server")
    $id = Get-NewRelease
    if ($id -and $id -ne $script:failedRel -and -not (Get-Busy).Count) { Update-Code $id }
  }
})

Start-Server
$timer.Start()
[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
