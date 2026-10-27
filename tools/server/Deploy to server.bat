@echo off
rem Limelight: on the CODING PC - makes the new release and sends it over SSH: first to the standby PC (tried there),
rem then to the server PC, which brings it in by itself when no agent job or render is running. Never through the NAS.
rem The auto-tests run first. -SkipTests: an urgent fix only. -Force: PC A even when the standby PC cannot be reached.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
pause
