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
})

Start-Server
$timer.Start()
[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
