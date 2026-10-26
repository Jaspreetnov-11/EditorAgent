@echo off
rem Limelight helper PC (render farm worker). Double-click ONCE on any office PC: it asks for the farm token (Team >
rem Render farm in the editor), installs Node.js / FFmpeg if missing, and from then on starts HIDDEN at every Windows
rem sign-in - no window to close by mistake. It pauses by itself while this PC's own user is busy on it.
rem Its log: %LOCALAPPDATA%\LimelightWorker\worker.log . To stop it for good: delete
rem "Limelight Render Worker.vbs" from the Startup folder (Win+R, shell:startup) and restart the PC.
rem The editor writes where it is (name + LAN addresses) to editor.txt next to this file on the NAS; a copy is kept on
rem this PC for sign-ins before the NAS is there.
setlocal
set "DIR=%LOCALAPPDATA%\LimelightWorker"
set "SHARE=Z:\Limelight Render Farm"
if not exist "%DIR%" mkdir "%DIR%"
if /i "%~1"=="hidden" goto run

title Limelight Render Worker - setup
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
if not exist "%DIR%\token.txt" (
  echo Farm token chahiye: editor mein Team ^> Render farm se copy karo.
  set /p "T=Token paste karo aur Enter dabao: "
  call echo %%T%%> "%DIR%\token.txt"
  rem (the whole "node worker.mjs ... <token>" line pasted: keep only the token - 24 letters 0-9 a-f)
  powershell -NoProfile -Command "$t = Get-Content '%DIR%\token.txt' -Raw; $m = [regex]::Matches($t, '\b[0-9a-f]{24}\b'); if ($m.Count) { Set-Content '%DIR%\token.txt' $m[$m.Count - 1].Value -NoNewline -Encoding ascii }"
)

rem this launcher on this PC, a hidden starter, and the starter in Startup (the old visible one is taken out)
rem (helpers started earlier - maybe with a wrong token - are stopped first: one helper per PC)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'LimelightWorker\\worker\.(bat|mjs)' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul
copy /y "%~f0" "%DIR%\worker.bat" >nul
> "%DIR%\hidden.vbs" echo CreateObject("WScript.Shell").Run """%DIR%\worker.bat"" hidden", 0, False
set "SU=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%SU%\Limelight Render Worker.cmd" del "%SU%\Limelight Render Worker.cmd"
copy /y "%DIR%\hidden.vbs" "%SU%\Limelight Render Worker.vbs" >nul
if exist "%SHARE%\editor.txt" copy /y "%SHARE%\editor.txt" "%DIR%\editor.txt" >nul
wscript "%DIR%\hidden.vbs"
echo.
echo Ho gaya: yeh PC ab chupchaap editor ki madad karega, aur har baar Windows chalu hote hi khud jud jayega.
echo Editor mein Team ^> Render farm mein yeh PC ek minute mein dikh jayega.
echo Log: %DIR%\worker.log
timeout /t 15
exit /b

:run
rem (waits use ping: timeout needs a console, and this runs hidden)
:start
rem (the token is read each round: a token changed in token.txt is used from the next start, no old loop keeps a wrong one)
set /p TOKEN=<"%DIR%\token.txt"
rem (the log is kept to about 5 MB: the older half moves to worker.old.log)
for %%A in ("%DIR%\worker.log") do if %%~zA GTR 5000000 move /y "%DIR%\worker.log" "%DIR%\worker.old.log" >nul
if exist "%SHARE%\editor.txt" copy /y "%SHARE%\editor.txt" "%DIR%\editor.txt" >nul
set "BASE="
if exist "%DIR%\editor.txt" for /f "usebackq delims=" %%U in ("%DIR%\editor.txt") do (
  if not defined BASE curl -s -f -m 5 -o "%DIR%\worker.mjs" "%%U/farm/worker.mjs" && set "BASE=%%U"
)
for %%U in (http://Jaspreet:3200 http://192.168.0.200:3200) do (
  if not defined BASE curl -s -f -m 5 -o "%DIR%\worker.mjs" "%%U/farm/worker.mjs" && set "BASE=%%U"
)
if not defined BASE (
  >> "%DIR%\worker.log" echo %DATE% %TIME%  editor not found - trying again in 30 s
  ping -n 31 127.0.0.1 >nul & goto start
)
node "%DIR%\worker.mjs" %BASE% %TOKEN% --name "%COMPUTERNAME%" >> "%DIR%\worker.log" 2>&1
rem 4: another helper already runs on this PC (an old window) - look again in a minute
if errorlevel 4 if not errorlevel 5 (ping -n 61 127.0.0.1 >nul & goto start)
ping -n 11 127.0.0.1 >nul
goto start
