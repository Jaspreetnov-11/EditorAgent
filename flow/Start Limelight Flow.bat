@echo off
rem Limelight Flow - the office's own automation app (n8n-like). Run it on the bridge PC (always on).
rem It copies itself to this PC first (%LOCALAPPDATA%\LimelightFlow) and keeps its data there - the password, the tokens
rem and the runs stay on this PC (not on the NAS), and it keeps working when the NAS is away.
rem Opens on http://localhost:5678 (other office PCs: http://<this PC>:5678). Make the password on this PC the first time.
rem   Start Limelight Flow.bat            start it
rem   Start Limelight Flow.bat whatsapp   also install the WhatsApp library (only for WhatsApp; Telegram needs nothing)
setlocal
set "HERE=%~dp0"
set "APP=%LOCALAPPDATA%\LimelightFlow"
where node >nul 2>nul || (echo Node.js is needed: https://nodejs.org & pause & exit /b 1)
robocopy "%HERE%." "%APP%" /E /XD data node_modules /NFL /NDL /NJH /NJS /NP >nul
cd /d "%APP%"
if /i "%~1"=="whatsapp" (call npm install --omit=dev || (echo npm install failed & pause & exit /b 1))
title Limelight Flow
start "" http://localhost:5678
node server.mjs --data "%APP%\data"
pause
