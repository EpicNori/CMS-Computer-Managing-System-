@echo off
setlocal
set "CMS_PS=%~dp0run-controller.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CMS_PS%" %*
set "CMS_EXIT=%ERRORLEVEL%"
if not "%CMS_EXIT%"=="0" pause
exit /b %CMS_EXIT%
