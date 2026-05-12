@echo off
setlocal
set "CMS_PS=%~dp0install-cms.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CMS_PS%" -Mode Controller %*
set "CMS_EXIT=%ERRORLEVEL%"
if not "%CMS_EXIT%"=="0" pause
exit /b %CMS_EXIT%
