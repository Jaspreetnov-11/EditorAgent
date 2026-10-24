@echo off
rem Builds Limelight Editor.exe (engine/browser) into tools\browser - copy that folder to the NAS to hand it out.
cd /d "%~dp0"
dotnet publish LimelightEditor.csproj -c Release -o "..\..\tools\browser" --nologo
