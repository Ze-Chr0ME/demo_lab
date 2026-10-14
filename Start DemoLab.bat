@echo off
cd /d "%~dp0"
where npm >nul 2>nul || (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org, then run this again.
  pause & exit /b 1
)
if not exist node_modules (
  echo Installing dependencies, first launch only...
  call npm install || (pause & exit /b 1)
)
rem Electron downloads its own binary the first time, not during npm install.
if not exist node_modules\electron\dist\electron.exe (
  echo Downloading Electron, first launch only...
  node node_modules\electron\install.js || (pause & exit /b 1)
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
