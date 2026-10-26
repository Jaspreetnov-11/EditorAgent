@echo off
rem Limelight: on the CODING PC - puts this editor's code on the NAS as the new release. The server PC brings it in by
rem itself (when no agent job or render is running); the standby PC too. Add -Tests to run the auto-tests first.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
pause
