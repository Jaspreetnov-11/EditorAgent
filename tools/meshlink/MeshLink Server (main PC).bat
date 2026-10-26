@echo off
rem MeshLink coordination server (D:\Claude Projects\MeshLink) for working from home - run on the main editor PC.
rem It only hands out addresses and keys; the editors' traffic goes straight between the PCs inside WireGuard.
rem The office router must forward to this PC (192.168.0.200): TCP 8080 (this server), UDP 3478 (address discovery),
rem UDP 41641 (WireGuard of this PC) - so a laptop at home can always reach the office.
rem Dashboard (machines, auth keys): http://localhost:8080  (user: admin)
setlocal
set "BIN=%~dp0bin"
set "DATA=%~dp0data"
if not exist "%BIN%\meshlink-server.exe" (echo %BIN%\meshlink-server.exe is missing - copy it from D:\Claude Projects\MeshLink\dist\windows-amd64 & pause & exit /b 1)
if not exist "%DATA%" mkdir "%DATA%"
if exist "%DATA%\admin-pass.txt" goto run
echo First start: choose a password for the MeshLink dashboard (user admin). It is kept in %DATA%\admin-pass.txt on this PC only.
set /p "PASS=Password: "
if "%PASS%"=="" (echo No password given. & pause & exit /b 1)
> "%DATA%\admin-pass.txt" echo %PASS%
set "PASS="
:run
set /p MESHLINK_ADMIN_PASS=<"%DATA%\admin-pass.txt"
title MeshLink server
"%BIN%\meshlink-server.exe" -listen :8080 -stun-port 3478 -data "%DATA%"
pause
