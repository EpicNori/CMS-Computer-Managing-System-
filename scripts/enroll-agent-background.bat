@echo off
setlocal

set "CMS_INSTALL_GLOBAL=0"
set "CMS_DISPLAY_MODE=0"
set "CMS_HIDDEN_RUN=0"
set "CMS_PAUSE_ON_ERROR=1"
set "CMS_INSTALLER_URL=https://raw.githubusercontent.com/EpicNori/CMS-Computer-Managing-System-/main/scripts/install-cms.ps1"

if /i "%~1"=="--hidden-run" (
  set "CMS_HIDDEN_RUN=1"
  set "CMS_PAUSE_ON_ERROR=0"
  shift
)
if /i "%~1"=="--install-global" (
  set "CMS_INSTALL_GLOBAL=1"
  shift
)
if /i "%~1"=="--install-display" (
  set "CMS_INSTALL_GLOBAL=1"
  set "CMS_DISPLAY_MODE=1"
  shift
)
if /i "%~1"=="--display-run" (
  set "CMS_DISPLAY_MODE=1"
  shift
)

set "CMS_PS=%~dp0run-agent.ps1"
if not exist "%CMS_PS%" (
  set "CMS_SERVER_URL=%~1"
  if "%CMS_SERVER_URL%"=="" set "CMS_SERVER_URL=ws://localhost:4377/ws"
  set "CMS_ENROLLMENT_TOKEN=%~2"
  if "%CMS_ENROLLMENT_TOKEN%"=="" set "CMS_ENROLLMENT_TOKEN=change-this-cms-token"
  set "CMS_DEVICE_NAME=%~3"
  if "%CMS_DEVICE_NAME%"=="" set "CMS_DEVICE_NAME=%COMPUTERNAME%"
  set "CMS_INSTALLER=%TEMP%\cms-install-cms.ps1"
  echo CMS agent runner was not found next to this BAT. Downloading standalone installer...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%CMS_INSTALLER_URL%' -OutFile '%CMS_INSTALLER%' -UseBasicParsing"
  if not "%ERRORLEVEL%"=="0" call :fail %ERRORLEVEL%
  set "CMS_BOOTSTRAP_ARGS=-NoProfile -ExecutionPolicy Bypass -File ""%CMS_INSTALLER%"" -Mode AgentBackground -ServerUrl ""%CMS_SERVER_URL%"" -EnrollmentToken ""%CMS_ENROLLMENT_TOKEN%"" -DeviceName ""%CMS_DEVICE_NAME%"""
  if "%CMS_INSTALL_GLOBAL%"=="1" set "CMS_BOOTSTRAP_ARGS=%CMS_BOOTSTRAP_ARGS% -InstallGlobal"
  if "%CMS_DISPLAY_MODE%"=="1" set "CMS_BOOTSTRAP_ARGS=%CMS_BOOTSTRAP_ARGS% -DisplayMode"
  if "%CMS_ENROLLMENT_TOKEN%"=="change-this-cms-token" set "CMS_BOOTSTRAP_ARGS=%CMS_BOOTSTRAP_ARGS% -AllowInsecureDefaultTokens"
  powershell.exe %CMS_BOOTSTRAP_ARGS%
  set "CMS_EXIT=%ERRORLEVEL%"
  if not "%CMS_EXIT%"=="0" call :fail %CMS_EXIT%
  exit /b 0
)

set "CMS_SERVER_URL=%~1"
if "%CMS_SERVER_URL%"=="" set "CMS_SERVER_URL=ws://localhost:4377/ws"
set "CMS_ENROLLMENT_TOKEN=%~2"
if "%CMS_ENROLLMENT_TOKEN%"=="" set "CMS_ENROLLMENT_TOKEN=change-this-cms-token"
set "CMS_DEVICE_NAME=%~3"
if "%CMS_DEVICE_NAME%"=="" set "CMS_DEVICE_NAME=%COMPUTERNAME%"

set "CMS_ARGS=-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""%CMS_PS%"" -Mode Background -ServerUrl ""%CMS_SERVER_URL%"" -EnrollmentToken ""%CMS_ENROLLMENT_TOKEN%"" -DeviceName ""%CMS_DEVICE_NAME%"""
if "%CMS_INSTALL_GLOBAL%"=="1" set "CMS_ARGS=%CMS_ARGS% -InstallGlobal"
if "%CMS_DISPLAY_MODE%"=="1" set "CMS_ARGS=%CMS_ARGS% -DisplayMode"

if "%CMS_HIDDEN_RUN%"=="1" (
  powershell.exe %CMS_ARGS%
  set "CMS_EXIT=%ERRORLEVEL%"
  if not "%CMS_EXIT%"=="0" call :fail %CMS_EXIT%
  exit /b 0
)

set "CMS_WORK=%~dp0.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -WindowStyle Hidden -WorkingDirectory '%CMS_WORK%' -FilePath powershell.exe -ArgumentList '%CMS_ARGS%'"
set "CMS_EXIT=%ERRORLEVEL%"
if not "%CMS_EXIT%"=="0" call :fail %CMS_EXIT%
exit /b 0

:fail
set "CMS_FAIL_CODE=%~1"
if "%CMS_FAIL_CODE%"=="" set "CMS_FAIL_CODE=1"
if not "%CMS_PAUSE_ON_ERROR%"=="0" pause
exit /b %CMS_FAIL_CODE%
