@echo off
rem Limelight: opens this PC's ports in Windows Firewall, by port number (not "whatever node.exe is" - that rule breaks
rem when Node.js is updated). Run as Administrator, once, on each PC:
rem   Open ports.bat server    the editor server PC (192.168.0.200): 80, 443 (domain), 3100 (team), 3200 (render farm),
rem                            8080 + UDP 3478/41641 (MeshLink, work from home)
rem   Open ports.bat bridge    the bridge + standby PC: 80, 443 (gateway), 3100 (standby editor), 5678 (Limelight Flow)
rem Port 3000 is never opened: the owner's door answers this PC only.
setlocal
net session >nul 2>nul || (echo Run this as Administrator: right-click ^> Run as administrator. & pause & exit /b 1)
set "ROLE=%~1"
if /i "%ROLE%"=="server" (
  set "TCP=80,443,3100,3200,8080"
  set "UDP=3478,41641"
) else if /i "%ROLE%"=="bridge" (
  set "TCP=80,443,3100,5678"
  set "UDP="
) else (
  echo Usage: "Open ports.bat" server    or    "Open ports.bat" bridge
  pause & exit /b 1
)
rem (only this file's own rules are replaced - never "Limelight access ..." = JASPREET's SSH / Remote Desktop)
powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName 'Limelight %ROLE% (*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; New-NetFirewallRule -DisplayName 'Limelight %ROLE% (TCP)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort %TCP% -Profile Any | Out-Null; if ('%UDP%') { New-NetFirewallRule -DisplayName 'Limelight %ROLE% (UDP)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort %UDP% -Profile Any | Out-Null }; Get-NetFirewallRule -DisplayName 'Limelight *' | ForEach-Object { $_.DisplayName + ': ' + ($_ | Get-NetFirewallPortFilter).LocalPort -join ',' }"
echo.
echo Done.
pause
