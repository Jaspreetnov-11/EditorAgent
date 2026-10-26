@echo off
rem Limelight Kit: DOUBLE-CLICK this (do NOT use "Run as administrator" - an administrator window cannot see the NAS
rem drive, so it just closes). It asks what this PC is, copies what it needs to C:\LimelightKit, then asks Windows
rem for administrator once (press Yes). Everything comes from this NAS folder - no internet. Safe to run again.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kit-start.ps1"
pause
