@echo off
rem Limelight office watch (engine\uptime.mjs): WhatsApp alerts when the editor, the NAS, the farm or the certificate has a problem.
rem Run it on the bridge PC (always on, on the UPS). It copies itself to this PC first, so it keeps watching when the NAS is gone.
rem   Start Office Watch.bat          watch (leave the window open, or put a shortcut to it in shell:startup)
rem   Start Office Watch.bat --test   send one test WhatsApp message
rem   Start Office Watch.bat --once   one round of checks, nothing sent
setlocal
set "HERE=%~dp0"
set "LOCAL=%LOCALAPPDATA%\LimelightWatch"
if not exist "%LOCAL%" mkdir "%LOCAL%"
set "SRC="
if exist "%HERE%uptime.mjs" set "SRC=%HERE%uptime.mjs"
if exist "%HERE%..\..\engine\uptime.mjs" set "SRC=%HERE%..\..\engine\uptime.mjs"
if defined SRC copy /Y "%SRC%" "%LOCAL%\uptime.mjs" >nul
if not exist "%LOCAL%\uptime.mjs" (echo uptime.mjs not found next to this file or in ..\..\engine & pause & exit /b 1)
where node >nul 2>nul || (echo Node.js is needed: https://nodejs.org & pause & exit /b 1)
title Limelight office watch
node "%LOCAL%\uptime.mjs" --config "%LOCAL%\uptime.json" %*
if not "%~1"=="" pause
