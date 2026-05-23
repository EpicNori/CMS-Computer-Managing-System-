param(
    [ValidateSet('Visible', 'Background')]
    [string]$Mode = 'Visible',
    [string]$ServerUrl = 'ws://localhost:4377/ws',
    [string]$EnrollmentToken = 'change-this-cms-token',
    [string]$DeviceName = $env:COMPUTERNAME,
    [string]$ProjectRoot,
    [string]$InstallDir,
    [string]$LogDir,
    [switch]$InstallGlobal,
    [switch]$DisplayMode,
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host "[CMS] $Message"
}

function Refresh-Path {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"
}

function Ensure-Node {
    if ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-Command npm -ErrorAction SilentlyContinue)) {
        return
    }

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw 'Node.js/npm were not found, and winget is not available. Install Node.js LTS manually and run this again.'
    }

    $scope = if ($InstallGlobal) { 'machine' } else { 'user' }
    Write-Step "Installing Node.js LTS with winget ($scope scope)..."
    & $winget.Source install --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements --scope $scope
    if ($LASTEXITCODE -ne 0) {
        throw 'winget failed to install Node.js LTS.'
    }

    Refresh-Path

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js was installed, but node.exe is still not available in PATH.'
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'Node.js was installed, but npm is still not available in PATH.'
    }
}

function Resolve-ProjectRoot {
    if ($ProjectRoot) {
        return [System.IO.Path]::GetFullPath($ProjectRoot)
    }

    $scriptProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    if (Test-Path -LiteralPath (Join-Path $scriptProjectRoot 'apps\agent\index.js')) {
        return $scriptProjectRoot
    }

    if ($InstallDir) {
        return [System.IO.Path]::GetFullPath($InstallDir)
    }

    if ($InstallGlobal) {
        return Join-Path $env:ProgramData 'CMS-Computer-Managing-System'
    }

    return Join-Path $env:LOCALAPPDATA 'CMS-Computer-Managing-System'
}

function Resolve-StableInstallRoot {
    if ($InstallDir) {
        return [System.IO.Path]::GetFullPath($InstallDir)
    }

    if ($InstallGlobal) {
        return Join-Path $env:ProgramData 'CMS-Computer-Managing-System'
    }

    return Join-Path $env:LOCALAPPDATA 'CMS-Computer-Managing-System'
}

function Copy-ProjectTree {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Target
    )

    $resolvedSource = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\')
    $resolvedTarget = [System.IO.Path]::GetFullPath($Target).TrimEnd('\')
    if ($resolvedSource -ieq $resolvedTarget) {
        return $resolvedSource
    }

    Write-Step "Copying CMS files to stable install path '$resolvedTarget'..."
    New-Item -ItemType Directory -Path $resolvedTarget -Force | Out-Null

    $exclude = @('.git', 'node_modules', '.env', 'logs')
    Get-ChildItem -LiteralPath $resolvedSource -Force |
        Where-Object { $exclude -notcontains $_.Name } |
        ForEach-Object {
            $destination = Join-Path $resolvedTarget $_.Name
            if (Test-Path -LiteralPath $destination) {
                Remove-Item -LiteralPath $destination -Recurse -Force
            }
            Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
        }

    return $resolvedTarget
}

function Ensure-StableInstall {
    param([string]$Root)

    if (-not $InstallGlobal) {
        return $Root
    }

    $stableRoot = Resolve-StableInstallRoot
    return Copy-ProjectTree -Source $Root -Target $stableRoot
}

function Ensure-Dependencies {
    param([string]$Root)

    if ($SkipDependencyInstall -or (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) {
        return
    }

    Write-Step 'Installing npm dependencies...'
    Push-Location $Root
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) {
            throw 'npm install failed.'
        }
    } finally {
        Pop-Location
    }
}

function New-QuotedArgument {
    param([string]$Value)
    return '"' + ($Value -replace '"', '`"') + '"'
}

function Install-GlobalTask {
    param(
        [string]$Root,
        [string]$ResolvedLogDir
    )

    $isElevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isElevated) {
        throw 'Global install requires an elevated Administrator PowerShell or Command Prompt.'
    }

    $runner = Join-Path $Root 'scripts\run-agent.ps1'
    if (-not (Test-Path -LiteralPath $runner)) {
        throw "Agent runner was not found at $runner"
    }

    New-Item -ItemType Directory -Path $ResolvedLogDir -Force | Out-Null

    if ($DisplayMode) {
        $taskName = 'CMS Display Agent'
        $taskDescription = 'Starts the hidden CMS agent for 24/7 authorized display PCs when any user logs on.'
    } elseif ($Mode -eq 'Background') {
        $taskName = 'CMS Background Agent'
        $taskDescription = 'Starts the hidden CMS background agent when any user logs on.'
    } else {
        $taskName = 'CMS Visible Agent'
        $taskDescription = 'Starts the visible CMS agent when any user logs on.'
    }

    $runnerArgs = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass'
    )
    if ($Mode -eq 'Background') {
        $runnerArgs += @('-WindowStyle', 'Hidden')
    }
    $runnerArgs += @(
        '-File', (New-QuotedArgument $runner),
        '-Mode', $Mode,
        '-ProjectRoot', (New-QuotedArgument $Root),
        '-ServerUrl', (New-QuotedArgument $ServerUrl),
        '-EnrollmentToken', (New-QuotedArgument $EnrollmentToken),
        '-DeviceName', (New-QuotedArgument $DeviceName),
        '-LogDir', (New-QuotedArgument $ResolvedLogDir)
    )
    if ($DisplayMode) {
        $runnerArgs += '-DisplayMode'
    }

    Write-Step "Installing global logon task '$taskName'..."
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($runnerArgs -join ' ') -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -GroupId 'BUILTIN\Users' -RunLevel LeastPrivilege
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
    Register-ScheduledTask -TaskPath '\CMS\' -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $taskDescription -Force | Out-Null
}

$resolvedProjectRoot = Ensure-StableInstall -Root (Resolve-ProjectRoot)
$agentEntry = Join-Path $resolvedProjectRoot 'apps\agent\index.js'
if (-not (Test-Path -LiteralPath $agentEntry)) {
    throw "Agent entry file was not found at $agentEntry. Run install-cms.ps1 first or place this script inside the full project."
}

$resolvedLogDir = if ($LogDir) {
    [System.IO.Path]::GetFullPath($LogDir)
} else {
    Join-Path $resolvedProjectRoot 'logs'
}

Ensure-Node
Ensure-Dependencies -Root $resolvedProjectRoot

if ($InstallGlobal) {
    Install-GlobalTask -Root $resolvedProjectRoot -ResolvedLogDir $resolvedLogDir
}

$env:CMS_SERVER_URL = $ServerUrl
$env:CMS_ENROLLMENT_TOKEN = $EnrollmentToken
$env:CMS_DEVICE_NAME = $DeviceName
if (-not $env:CMS_CONNECTION_TIMEOUT_MS) {
    $env:CMS_CONNECTION_TIMEOUT_MS = '15000'
}
if (-not $env:CMS_ALLOW_SCREEN_VIEW) {
    $env:CMS_ALLOW_SCREEN_VIEW = '1'
}
if (-not $env:CMS_ALLOW_REMOTE_CONTROL) {
    $env:CMS_ALLOW_REMOTE_CONTROL = '1'
}
if (-not $env:CMS_ALLOW_SHELL) {
    $env:CMS_ALLOW_SHELL = '1'
}

Push-Location $resolvedProjectRoot
try {
    if ($Mode -eq 'Background') {
        New-Item -ItemType Directory -Path $resolvedLogDir -Force | Out-Null
        $env:CMS_HIDE_WINDOWS = '1'
        Write-Step "Starting hidden CMS agent for '$DeviceName'. Logs: $resolvedLogDir\agent.log"
        & node $agentEntry *>> (Join-Path $resolvedLogDir 'agent.log')
    } else {
        Write-Step "Starting visible CMS agent for '$DeviceName' connected to '$ServerUrl'..."
        & node $agentEntry
    }

    exit $LASTEXITCODE
} finally {
    Pop-Location
}
