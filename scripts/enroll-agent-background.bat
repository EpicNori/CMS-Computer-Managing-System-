@echo off
setlocal

if /i "%~1"=="--hidden-run" (
  set "CMS_PAUSE_ON_ERROR=0"
  shift
  goto begin
)

set "CMS_PAUSE_ON_ERROR=1"
set "CMS_SELF=%~f0"
set "CMS_SELF_ARGS=%*"
for %%I in ("%~dp0..") do set "CMS_LAUNCH_WORK=%%~fI"
set "CMS_LAUNCH_CMD=call ""%CMS_SELF%"" --hidden-run %CMS_SELF_ARGS%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -WorkingDirectory $env:CMS_LAUNCH_WORK -FilePath $env:ComSpec -ArgumentList @('/d','/c',$env:CMS_LAUNCH_CMD)"
if errorlevel 1 (
  echo Failed to start the hidden CMS background agent.
  call :fail 1
)
exit /b 0

:begin
REM Hidden enrollment script for authorized devices only.
REM ---------------------- CONFIG ----------------------
REM Edit these defaults, or pass URL/token/name as arguments.
set "CMS_DEFAULT_SERVER_URL=ws://localhost:4377/ws"
set "CMS_DEFAULT_ENROLLMENT_TOKEN=change-this-enrollment-token"
set "CMS_DEFAULT_DEVICE_NAME=%COMPUTERNAME%"
set "CMS_DEFAULT_CONNECTION_TIMEOUT_MS=15000"
set "CMS_DEFAULT_ALLOW_SCREEN_VIEW=1"
set "CMS_DEFAULT_ALLOW_REMOTE_CONTROL=1"
set "CMS_DEFAULT_ALLOW_SHELL=1"
set "CMS_DEFAULT_REPO_ZIP_URL=https://github.com/EpicNori/CMS-Computer-Managing-System-/archive/refs/heads/main.zip"
set "CMS_DEFAULT_USER_INSTALL_DIR=%LOCALAPPDATA%\CMS-Computer-Managing-System"
set "CMS_DEFAULT_MACHINE_INSTALL_DIR=%ProgramData%\CMS-Computer-Managing-System"
REM -------------------- END CONFIG --------------------

REM Usage:
REM   enroll-agent-background.bat ws://SERVER-IP:4377/ws enrollment-token "Device Name"
REM   enroll-agent-background.bat wss://your-domain.example/ws enrollment-token "Device Name"
REM   enroll-agent-background.bat --install-global wss://your-domain.example/ws enrollment-token "Device Name"
REM   enroll-agent-background.bat --install-display wss://your-domain.example/ws enrollment-token "Display 01"
REM Defaults are used when arguments are omitted.
set "CMS_INSTALL_GLOBAL=0"
set "CMS_DISPLAY_MODE=0"
set "CMS_DISPLAY_RUN=0"
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
  set "CMS_DISPLAY_RUN=1"
  shift
)

set "CMS_SERVER_URL=%~1"
if "%CMS_SERVER_URL%"=="" set "CMS_SERVER_URL=%CMS_DEFAULT_SERVER_URL%"
set "CMS_ENROLLMENT_TOKEN=%~2"
if "%CMS_ENROLLMENT_TOKEN%"=="" set "CMS_ENROLLMENT_TOKEN=%CMS_DEFAULT_ENROLLMENT_TOKEN%"
set "CMS_DEVICE_NAME=%~3"
if "%CMS_DEVICE_NAME%"=="" set "CMS_DEVICE_NAME=%CMS_DEFAULT_DEVICE_NAME%"
set "CMS_CONNECTION_TIMEOUT_MS=%CMS_DEFAULT_CONNECTION_TIMEOUT_MS%"
set "CMS_ALLOW_SCREEN_VIEW=%CMS_DEFAULT_ALLOW_SCREEN_VIEW%"
set "CMS_ALLOW_REMOTE_CONTROL=%CMS_DEFAULT_ALLOW_REMOTE_CONTROL%"
set "CMS_ALLOW_SHELL=%CMS_DEFAULT_ALLOW_SHELL%"
set "CMS_REPO_ZIP_URL=%CMS_REPO_ZIP_URL%"
if "%CMS_REPO_ZIP_URL%"=="" set "CMS_REPO_ZIP_URL=%CMS_DEFAULT_REPO_ZIP_URL%"
set "CMS_INSTALL_DIR=%CMS_INSTALL_DIR%"
if "%CMS_INSTALL_DIR%"=="" if "%CMS_INSTALL_GLOBAL%"=="1" set "CMS_INSTALL_DIR=%CMS_DEFAULT_MACHINE_INSTALL_DIR%"
if "%CMS_INSTALL_DIR%"=="" set "CMS_INSTALL_DIR=%CMS_DEFAULT_USER_INSTALL_DIR%"
set "CMS_LOG_DIR=%CMS_LOG_DIR%"
if "%CMS_LOG_DIR%"=="" set "CMS_LOG_DIR=%CMS_INSTALL_DIR%\logs"

pushd "%~dp0.." >nul
set "CMS_ROOT=%CD%"
popd >nul
if exist "%CMS_ROOT%\apps\agent\index.js" goto run_agent

set "CMS_ROOT=%CMS_INSTALL_DIR%"
if exist "%CMS_ROOT%\apps\agent\index.js" goto run_agent

call :ensure_node
if errorlevel 1 call :fail 1

if not exist "%CMS_INSTALL_DIR%" mkdir "%CMS_INSTALL_DIR%"
set "CMS_BOOTSTRAP_ZIP=%TEMP%\cms-agent-bg-%RANDOM%-%RANDOM%.zip"
set "CMS_BOOTSTRAP_EXTRACT=%TEMP%\cms-agent-bg-%RANDOM%-%RANDOM%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri $env:CMS_REPO_ZIP_URL -OutFile $env:CMS_BOOTSTRAP_ZIP"
if errorlevel 1 call :fail 1

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath $env:CMS_BOOTSTRAP_ZIP -DestinationPath $env:CMS_BOOTSTRAP_EXTRACT -Force"
if errorlevel 1 call :fail 1

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$source=Get-ChildItem -LiteralPath $env:CMS_BOOTSTRAP_EXTRACT -Directory | Select-Object -First 1; if (-not $source) { exit 1 }; if (Test-Path -LiteralPath $env:CMS_INSTALL_DIR) { Remove-Item -LiteralPath $env:CMS_INSTALL_DIR -Recurse -Force }; Move-Item -LiteralPath $source.FullName -Destination $env:CMS_INSTALL_DIR"
if errorlevel 1 call :fail 1

del "%CMS_BOOTSTRAP_ZIP%" >nul 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -LiteralPath $env:CMS_BOOTSTRAP_EXTRACT -Recurse -Force" >nul 2>nul

:run_agent
if "%CMS_INSTALL_GLOBAL%"=="1" call :ensure_stable_install
if errorlevel 1 call :fail 1

cd /d "%CMS_ROOT%"
call :ensure_node
if errorlevel 1 call :fail 1

if not exist "node_modules" (
  npm install
  if errorlevel 1 call :fail 1
)

if not exist "%CMS_LOG_DIR%" mkdir "%CMS_LOG_DIR%"

if "%CMS_INSTALL_GLOBAL%"=="1" (
  call :install_global_task
  if errorlevel 1 call :fail 1
)

set "CMS_HIDE_WINDOWS=1"
node apps\agent\index.js >> "%CMS_LOG_DIR%\agent.log" 2>>&1

endlocal
exit /b 0

:ensure_node
where node >nul 2>nul
if not errorlevel 1 (
  where npm >nul 2>nul
  if not errorlevel 1 exit /b 0
)

where winget >nul 2>nul
if errorlevel 1 call :fail 1

set "CMS_WINGET_SCOPE=user"
if "%CMS_INSTALL_GLOBAL%"=="1" set "CMS_WINGET_SCOPE=machine"

winget install --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements --scope %CMS_WINGET_SCOPE%
if errorlevel 1 call :fail 1

call :refresh_path

where node >nul 2>nul
if errorlevel 1 call :fail 1

where npm >nul 2>nul
if errorlevel 1 call :fail 1

exit /b 0

:refresh_path
for /f "usebackq tokens=* delims=" %%A in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%A"
exit /b 0

:ensure_stable_install
if /i "%CMS_ROOT%"=="%CMS_INSTALL_DIR%" exit /b 0

if not exist "%CMS_INSTALL_DIR%" mkdir "%CMS_INSTALL_DIR%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$source=(Resolve-Path -LiteralPath $env:CMS_ROOT).Path; $target=$env:CMS_INSTALL_DIR; if ($source.TrimEnd('\') -ieq $target.TrimEnd('\')) { exit 0 }; $exclude=@('.git','node_modules','.env'); Get-ChildItem -LiteralPath $source -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object { $dest=Join-Path $target $_.Name; if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }; Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse -Force }"
if errorlevel 1 call :fail 1

set "CMS_ROOT=%CMS_INSTALL_DIR%"
exit /b 0

:install_global_task
net session >nul 2>nul
if errorlevel 1 call :fail 1

set "CMS_TASK_BAT=%CMS_ROOT%\scripts\enroll-agent-background.bat"
if not exist "%CMS_TASK_BAT%" call :fail 1

if "%CMS_DISPLAY_MODE%"=="1" (
  set "CMS_TASK_NAME=CMS Display Agent"
  set "CMS_TASK_DESC=Starts the hidden CMS agent for 24/7 authorized display PCs when any user logs on."
) else (
  set "CMS_TASK_NAME=CMS Background Agent"
  set "CMS_TASK_DESC=Starts the hidden CMS agent when any user logs on."
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$taskName=$env:CMS_TASK_NAME; $agentArgs='--hidden-run \"{0}\" \"{1}\" \"{2}\"' -f $env:CMS_SERVER_URL,$env:CMS_ENROLLMENT_TOKEN,$env:CMS_DEVICE_NAME; if ($env:CMS_DISPLAY_MODE -eq '1') { $agentArgs='--hidden-run --display-run \"{0}\" \"{1}\" \"{2}\"' -f $env:CMS_SERVER_URL,$env:CMS_ENROLLMENT_TOKEN,$env:CMS_DEVICE_NAME }; $command='Set-Location -LiteralPath ''{0}''; & ''{1}'' {2}' -f $env:CMS_ROOT,$env:CMS_TASK_BAT,$agentArgs; $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ' + $command); $trigger=New-ScheduledTaskTrigger -AtLogOn; $principal=New-ScheduledTaskPrincipal -GroupId 'BUILTIN\Users' -RunLevel LeastPrivilege; $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0); Register-ScheduledTask -TaskPath '\CMS\' -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $env:CMS_TASK_DESC -Force | Out-Null"
if errorlevel 1 call :fail 1

exit /b 0

:fail
set "CMS_FAIL_CODE=%~1"
if "%CMS_FAIL_CODE%"=="" set "CMS_FAIL_CODE=1"
if not "%CMS_PAUSE_ON_ERROR%"=="0" pause
exit /b %CMS_FAIL_CODE%
