@echo off
rem Limelight NAS Care: health, duplicates / unused report, safe clean-up and folder organising for the office NAS.
rem Double-click to start; it opens http://localhost:3390 in the browser. It copies itself to this PC first, so it keeps
rem working (and keeps raising alarms) even when the NAS share is slow or gone. Reports stay in %LOCALAPPDATA%\LimelightNASCare.
setlocal
set "HERE=%~dp0"
set "LOCAL=%LOCALAPPDATA%\LimelightNASCare\app"
if not exist "%LOCAL%" mkdir "%LOCAL%"
for %%f in (nascare.mjs core.mjs snmp.mjs ui.html) do if exist "%HERE%%%f" copy /Y "%HERE%%%f" "%LOCAL%\%%f" >nul
if not exist "%LOCAL%\nascare.mjs" (echo nascare.mjs not found next to this file & pause & exit /b 1)
if exist "%HERE%..\..\Projects" set "NASCARE_PROJECTS=%HERE%..\..\Projects"
where node >nul 2>nul || (echo Node.js is needed: https://nodejs.org & pause & exit /b 1)
title Limelight NAS Care
start "" http://localhost:3390
node "%LOCAL%\nascare.mjs"
pause
