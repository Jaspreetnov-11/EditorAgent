@echo off
rem Limelight: on PC A (editor server) and PC B (bridge / standby), ONCE - right-click > Run as administrator.
rem Gives the coding PC JASPREET (192.168.0.210) lasting access: SSH with its key only, and Remote Desktop - both open to
rem JASPREET alone (and MeshLink, for home). Then Claude on JASPREET can check, fix and update this PC at any time.
net session >nul 2>nul || (echo Right-click this file ^> Run as administrator. & pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0allow-jaspreet.ps1" %*
pause
