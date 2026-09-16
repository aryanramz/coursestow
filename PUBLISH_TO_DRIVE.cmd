@echo off
cd /d "%~dp0"
echo CourseMirror - PUBLISH TO GOOGLE DRIVE
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 20+ is not installed.
  pause
  exit /b 1
)
if not exist node_modules (
  echo CourseMirror runtime dependencies are missing. Run setup.ps1 or reinstall the application.
  goto :error
)
echo.
echo Publishing the current mirror to Google Drive for desktop...
node "%~dp0src\launcher.mjs" publish
if errorlevel 2 goto :warning
if errorlevel 1 goto :error
echo.
echo Drive publish finished.
pause
exit /b 0
:warning
echo.
echo The publish completed with one or more file errors. The next publish will retry them.
pause
exit /b 0
:error
echo.
echo The Drive publish stopped with an error.
pause
exit /b 1
