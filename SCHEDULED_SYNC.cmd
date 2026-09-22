@echo off
cd /d "%~dp0"
echo CourseStow - SCHEDULED DAILY RUN
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 20+ is not installed.
  echo Install Node.js LTS from https://nodejs.org/ and run SCHEDULED_SYNC.cmd again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo CourseStow runtime dependencies are missing. Run setup.ps1 or reinstall the application.
  goto :error
)
echo.
echo Choosing QUICK or FULL based on when the last Full Sync succeeded...
node "%~dp0src\launcher.mjs" scheduled
if errorlevel 1 goto :error
echo.
echo Scheduled sync finished.
pause
exit /b 0
:error
echo.
echo The scheduled sync stopped with an error. Leave this window open and review the error output or open a GitHub issue.
pause
exit /b 1
