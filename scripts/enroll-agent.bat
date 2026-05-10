@echo off
setlocal

REM Visible enrollment script for authorized devices only.
REM Edit these values before running on a Windows server/device.
set CMS_SERVER_URL=ws://localhost:4377/ws
set CMS_ENROLLMENT_TOKEN=change-this-enrollment-token
set CMS_DEVICE_NAME=%COMPUTERNAME%
set CMS_ALLOW_SCREEN_VIEW=1
set CMS_ALLOW_REMOTE_CONTROL=1
set CMS_ALLOW_SHELL=1

cd /d "%~dp0\.."
node apps\agent\index.js

endlocal
