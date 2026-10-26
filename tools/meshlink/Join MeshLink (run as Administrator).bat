@echo off
rem Joins this PC / laptop to the office mesh (MeshLink), so the editor opens from home at http://<main PC mesh address>:3100
rem (shown in the editor: Team > From home). Right-click > Run as administrator: it makes the network adapter.
rem Copy this whole folder (with bin\) to the PC first, e.g. to C:\MeshLink - run as administrator, Windows does not
rem show the mapped NAS drive (Z:), and the start-with-Windows task needs it on this PC.
rem   Join MeshLink (run as Administrator).bat              join and stay connected while the window is open
rem   Join MeshLink (run as Administrator).bat autostart    also start it with Windows (a scheduled task, as SYSTEM)
rem   Join MeshLink (run as Administrator).bat remove       stop starting it with Windows
setlocal
net session >nul 2>&1 || (echo Right-click this file and choose "Run as administrator". & pause & exit /b 1)
set "BIN=%~dp0bin"
if not exist "%BIN%\meshlink.exe" (echo %BIN%\meshlink.exe is missing. & pause & exit /b 1)
if not exist "%BIN%\wintun.dll" (echo %BIN%\wintun.dll is missing - get it from https://www.wintun.net ^(amd64 folder^). & pause & exit /b 1)
if /i "%~1"=="remove" (schtasks /Delete /TN "MeshLink" /F & pause & exit /b 0)
if exist "%ProgramData%\MeshLink\state.json" goto known
echo First time on this PC.
set /p "SERVER=MeshLink server (from the office: http://192.168.0.200:8080 - from home: the address the owner gave you): "
set /p "KEY=Auth key from the MeshLink dashboard (mlk-...): "
"%BIN%\meshlink.exe" up --server "%SERVER%" --authkey "%KEY%" --hostname "%COMPUTERNAME%" & goto end
:known
if /i "%~1"=="autostart" (
  schtasks /Create /TN "MeshLink" /TR "\"%BIN%\meshlink.exe\" up" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
  schtasks /Run /TN "MeshLink"
  echo MeshLink now starts with Windows. Status: http://127.0.0.1:41112
  pause & exit /b 0
)
title MeshLink
"%BIN%\meshlink.exe" up
:end
pause
