@echo off
title Limelight Standby Editor
rem The standby editor on a PC of the editor's line: JASPREET (1st), PC B (2nd), any helper (3rd - by the PC's name, see
rem engine/standby.mjs). It watches the main editor (the server PC, 192.168.0.200); if that stays down for 30 s (60 s for
rem the 2nd, 90 s for a helper, when no one before it took over) this PC runs the editor from the live copy on the NAS and
rem Limelight Editor.exe goes there by itself. When the main one is back, the edits made here go back to it.
rem 🔒 Its code comes from %LOCALAPPDATA%\LimelightStandby\release\editor - tools\server\deploy.ps1 on the coding PC sends
rem every release there over SSH. The NAS holds only the live data mirror, never the editor's code.
rem Kept at %LOCALAPPDATA%\LimelightStandby\standby.bat and started at sign-in (Task Scheduler "Limelight Standby" on
rem PC B, the Startup folder on the others).
set "DIR=%LOCALAPPDATA%\LimelightStandby"
set "REL=%DIR%\release\editor"
if not exist "%DIR%" mkdir "%DIR%"
rem a PC short of disk (JASPREET's C:) keeps no StandbyLive copy of the ~36 GB mirror: an empty file named no-local-copy here
set "LOCALOPT="
if exist "%DIR%\no-local-copy" set "LOCALOPT=--local off"

where node >nul 2>nul || (
  echo Node.js nahi mila - install kar raha hoon...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  echo Install ho gaya. Is window ko band karke file dobara double-click karo.
  pause & exit /b
)
where ffmpeg >nul 2>nul || (
  echo FFmpeg nahi mila - install kar raha hoon...
  winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
  echo Install ho gaya. Is window ko band karke file dobara double-click karo.
  pause & exit /b
)

:start
if not exist "Z:\" (
  echo Z: ^(NAS^) drive nahi mili - 30 sec mein phir koshish...
  timeout /t 30 >nul & goto start
)
rem the editor's code: from this PC's release folder each start (only what changed is copied). StandbyLive (this PC's copy
rem of the live mirror) and the logs are left alone
if exist "%REL%\release.json" if not exist "%REL%\deploying.lock" robocopy "%REL%" "%DIR%\editor" /MIR /XD logs StandbyLive /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >nul
if not exist "%DIR%\editor\engine\standby.mjs" (
  echo Editor ka code abhi is PC par nahi hai - coding PC se "Deploy to server.bat" chalao. 60 sec mein phir dekhunga...
  timeout /t 60 >nul & goto start
)
rem (the main editor by its fixed address, not its PC name - the server PC can be replaced and keep 192.168.0.200)
node "%DIR%\editor\engine\standby.mjs" --main http://192.168.0.200:3100 --mirror "Z:\Limelight Backups\live" --release "%REL%" %LOCALOPT%
echo Standby ruk gaya - 10 sec mein phir chalu...
timeout /t 10 >nul
goto start
