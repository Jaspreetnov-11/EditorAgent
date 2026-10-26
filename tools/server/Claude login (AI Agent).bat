@echo off
rem Limelight: logs in the Claude Code that the editor's AI agent uses. Signing in to the Claude app is NOT enough -
rem the agent runs Claude Code on its own and needs its own sign-in (saved in %USERPROFILE%\.claude\.credentials.json).
rem In the window: type /login, press Enter, pick "Claude account with subscription", sign in in the browser, then /exit.
setlocal
set "EXE="
for /f "delims=" %%F in ('dir /b /s /o-d "%LOCALAPPDATA%\Claude-Data\claude.exe" 2^>nul') do if not defined EXE set "EXE=%%F"
if not defined EXE if exist "%USERPROFILE%\.local\bin\claude.exe" set "EXE=%USERPROFILE%\.local\bin\claude.exe"
if not defined EXE (echo Claude Code was not found on this PC - open the Claude app once, then run this again. & pause & exit /b 1)
echo.
echo  Type  /login  and press Enter. Sign in in the browser. When it says "Login successful", type  /exit
echo.
cd /d "%USERPROFILE%"
"%EXE%"
echo.
"%EXE%" -p "Reply with OK" --max-turns 1 --model haiku && echo. && echo  AI agent login OK. || echo  Still not logged in - run this again.
pause
