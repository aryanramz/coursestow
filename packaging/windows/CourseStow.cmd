@echo off
setlocal

set "COURSESTOW_BUNDLE_ROOT=%~dp0"
set "COURSESTOW_PRIVATE_NODE=%COURSESTOW_BUNDLE_ROOT%runtime\node.exe"
set "COURSESTOW_APPLICATION_ENTRY=%COURSESTOW_BUNDLE_ROOT%app\src\launcher.mjs"
set "COURSESTOW_PLAYWRIGHT_PACKAGE=%COURSESTOW_BUNDLE_ROOT%app\node_modules\playwright\package.json"

if not exist "%COURSESTOW_PRIVATE_NODE%" (
  echo CourseStow's private Node.js runtime is missing.
  echo Rebuild or reinstall CourseStow.
  exit /b 1
)

if not exist "%COURSESTOW_APPLICATION_ENTRY%" (
  echo CourseStow application files are missing.
  echo Rebuild or reinstall CourseStow.
  exit /b 1
)

if not exist "%COURSESTOW_PLAYWRIGHT_PACKAGE%" (
  echo CourseStow production dependencies are missing.
  echo Rebuild or reinstall CourseStow.
  exit /b 1
)

"%COURSESTOW_PRIVATE_NODE%" "%COURSESTOW_APPLICATION_ENTRY%" %*
exit /b %ERRORLEVEL%
