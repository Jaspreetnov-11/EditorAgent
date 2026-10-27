@echo off
rem Limelight: the week-long test run (tools/soak/soak.mjs) - checks the live editor every minute, and every hour runs the
rem auto-tests and a real render on a throwaway editor. Summary: logs\soak-<start>.html. Close the window to stop it.
cd /d "%~dp0..\.."
node tools\soak\soak.mjs %*
pause
