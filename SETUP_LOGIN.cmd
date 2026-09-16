@echo off
cd /d "%~dp0"
echo CourseMirror - ESTABLISH DEDICATED BROWSER SESSION
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is not installed.
  pause
  exit /b 1
)
if not exist node_modules (
  echo CourseMirror runtime dependencies are missing. Run setup.ps1 or reinstall the application.
  goto :error
)
node "%~dp0src\launcher.mjs" setup-login
if errorlevel 1 goto :error
echo.
echo Dedicated Chromium profile opened.
echo Sign in normally, optionally let the browser save the login, then close that browser window.
pause
exit /b 0
:error
echo.
echo Could not open the dedicated login profile.
pause
exit /b 1
