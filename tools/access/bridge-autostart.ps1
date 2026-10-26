# bridge-autostart.ps1 - on PC B (bridge + standby), as Administrator (or over SSH from JASPREET): the standby editor,
# Limelight Flow and the office watch start at sign-in WITHOUT windows (nothing to close by mistake) and start again
# if they stop. Each runs from this PC's own copy (%LOCALAPPDATA%), so a slow NAS at sign-in does not stop them;
# the standby still copies fresh code from the NAS each time it starts. Replaces their Startup-folder entries.
$ErrorActionPreference = 'Stop'
$user = (Get-CimInstance Win32_ComputerSystem).UserName  # (the person signed in on this PC, e.g. NAYA-B\ADMIN)
if (-not $user) { $user = "$env:COMPUTERNAME\$env:USERNAME" }
$la = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData\Local'
$dir = Join-Path $la 'LimelightBridge'; New-Item -ItemType Directory -Force $dir | Out-Null

# one small loop per program: run it, and if it stops, wait 10 s and run it again
function Loop($name, $body) {
  $cmd = Join-Path $dir "$name.cmd"
  Set-Content -Path $cmd -Encoding ascii -Value "@echo off`r`n:again`r`n$body`r`ntimeout /t 10 /nobreak >nul`r`ngoto again`r`n"
  $vbs = Join-Path $dir "$name.vbs"
  Set-Content -Path $vbs -Encoding ascii -Value "CreateObject(""WScript.Shell"").Run """"""$cmd"""""", 0, False"
  return $vbs
}
$jobs = [ordered]@{}
# the standby: its own launcher already loops (code from the NAS, then standby.mjs) - just started hidden
if (Test-Path "$la\LimelightStandby\standby.bat") { $jobs['Limelight Standby'] = Loop 'standby' "call ""$la\LimelightStandby\standby.bat""" }
if (Test-Path "$la\LimelightFlow\server.mjs") { $jobs['Limelight Flow'] = Loop 'flow' "cd /d ""$la\LimelightFlow"" && node server.mjs --data ""$la\LimelightFlow\data"" >> ""$dir\flow.log"" 2>&1" }
if (Test-Path "$la\LimelightWatch\uptime.mjs") { $jobs['Limelight Office Watch'] = Loop 'watch' "node ""$la\LimelightWatch\uptime.mjs"" --config ""$la\LimelightWatch\uptime.json"" >> ""$dir\watch.log"" 2>&1" }
# 🚪 the office gateway (engine/gateway.mjs): https://editor.limelightcorp.in answers here and goes to the main editor, or to
# this PC's standby editor while it has taken over. Its certificate is a copy of PC A's ssl\ (copied again after each renewal).
$gw = "$la\LimelightGateway"
if (Test-Path "$gw\gateway.mjs") { $jobs['Limelight Gateway'] = Loop 'gateway' "node ""$gw\gateway.mjs"" --main http://192.168.0.200:3100 --standby http://127.0.0.1:3100 --cert ""$gw\editor.limelightcorp.in.crt"" --key ""$gw\editor.limelightcorp.in.key"" >> ""$dir\gateway.log"" 2>&1" }

foreach ($k in $jobs.Keys) {
  $act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$($jobs[$k])`""
  $trg = New-ScheduledTaskTrigger -AtLogOn -User $user
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $pr = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $k -Action $act -Trigger $trg -Settings $set -Principal $pr -Force | Out-Null
  "task: $k"
}
# (the old Startup entries would start second copies)
$su = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
foreach ($f in 'Start Limelight Flow - Shortcut.lnk') { $p = Join-Path $su $f; if (Test-Path $p) { Move-Item -Force $p (Join-Path $dir "$f.old"); "moved out of Startup: $f" } }
# (standby.bat puts its Startup entry back when it is missing - so it stays, doing nothing: the task starts the standby)
$sb = Join-Path $su 'Limelight Standby Editor.cmd'
if ($jobs.Contains('Limelight Standby')) { Set-Content -Path $sb -Encoding ascii -Value '@rem The standby editor is started by the task "Limelight Standby" (Task Scheduler), hidden.'; 'Startup entry of the standby: now does nothing' }
# start them now (each only if it is not already running)
$running = (Get-CimInstance Win32_Process -Filter "name='node.exe' or name='cmd.exe'").CommandLine -join "`n"
foreach ($k in $jobs.Keys) {
  $what = @{ 'Limelight Standby' = 'standby'; 'Limelight Flow' = 'LimelightFlow'; 'Limelight Office Watch' = 'uptime.mjs'; 'Limelight Gateway' = 'gateway.mjs' }[$k]
  if ($running -match [regex]::Escape($what)) { "$k already running" } else { Start-ScheduledTask -TaskName $k; "$k started" }
}
