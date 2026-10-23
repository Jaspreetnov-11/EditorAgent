@echo off
rem Limelight: the editor's name (editor.limelightcorp.in) found on this PC even when the office internet is down.
rem The name is normally looked up on the internet (GoDaddy DNS); with no internet a new browser tab cannot find it.
rem This puts it into this PC's hosts file. Better, once for every PC: the same entry in the router's own DNS.
rem Run it as administrator (right-click > Run as administrator). Give the address of the gateway box (or, before it is
rem there, of the main editor PC), e.g.:   "Editor name on this PC (hosts).bat" 192.168.0.200
setlocal
set "NAME=editor.limelightcorp.in"
set "HOSTS=%SystemRoot%\System32\drivers\etc\hosts"
net session >nul 2>&1
if errorlevel 1 (
  echo Administrator chahiye: is file pe right-click karke "Run as administrator" chuno.
  pause
  exit /b 1
)
set "IP=%~1"
if "%IP%"=="" set /p "IP=Gateway / editor PC ka address (jaise 192.168.0.200): "
if "%IP%"=="" ( echo Address nahi diya - kuch nahi badla. & pause & exit /b 1 )
rem (an older line for the name goes; then the new one)
findstr /v /i /c:"%NAME%" "%HOSTS%" > "%TEMP%\hosts.limelight" 2>nul
copy /y "%TEMP%\hosts.limelight" "%HOSTS%" >nul
echo %IP%	%NAME%	# Limelight editor (works without internet)>> "%HOSTS%"
del "%TEMP%\hosts.limelight" >nul 2>&1
ipconfig /flushdns >nul
echo.
echo Ho gaya: %NAME% ab is PC pe %IP% pe khulega, internet ho ya na ho.
echo Hatana ho to hosts file se "%NAME%" wali line hata do.
pause
