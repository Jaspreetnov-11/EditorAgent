@echo off
rem Limelight speed test - run this ON THE EDITOR SERVER (PC A), at night when nobody is working.
rem It copies 8 projects to Z:\Limelight Bench and tests the copies (the real projects are not touched),
rem then writes the report to Z:\Limelight Bench Reports. Takes about 1-3 hours.
title Limelight speed test
cd /d "%~dp0"
node bench.mjs %*
echo.
echo Done. The report is in Z:\Limelight Bench Reports
pause
