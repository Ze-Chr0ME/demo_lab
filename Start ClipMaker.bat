@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, first launch only...
  call npm install || (pause & exit /b 1)
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
