@echo off
cd /d "%~dp0"
echo CourseMirror - FULL (START_HERE compatibility launcher)
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 20+ is not installed.
  echo Install Node.js LTS from https://nodejs.org/ and run START_HERE.cmd again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo CourseMirror runtime dependencies are missing. Run setup.ps1 or reinstall the application.
  goto :error
)
echo.
echo Running full Brightspace mirror...
node "%~dp0src\launcher.mjs" full
if errorlevel 1 goto :error
echo.
echo Full sync finished.
pause
exit /b 0
:error
echo.
echo The sync stopped with an error. Leave this window open and review the error output or open a GitHub issue.
pause
exit /b 1
