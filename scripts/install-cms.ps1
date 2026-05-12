param(
    [ValidateSet('Controller', 'AgentVisible', 'AgentBackground')]
    [string]$Mode = 'Controller',
    [string]$ServerUrl = 'ws://localhost:4377/ws',
    [string]$EnrollmentToken = 'change-this-enrollment-token',
    [string]$DeviceName = $env:COMPUTERNAME,
    [switch]$InstallGlobal,
    [switch]$DisplayMode,
    [string]$InstallDir,
    [string]$RepoZipUrl = 'https://github.com/EpicNori/CMS-Computer-Managing-System-/archive/refs/heads/main.zip',
    [string]$RepoZipFallbackUrl = 'https://codeload.github.com/EpicNori/CMS-Computer-Managing-System-/zip/refs/heads/main',
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host "[CMS] $Message"
}

function Fail {
    param([string]$Message)
    throw $Message
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
        Fail 'winget was not found. Install Node.js LTS manually or use a Windows build that includes winget.'
    }

    $scope = if ($InstallGlobal) { 'machine' } else { 'user' }
    Write-Step "Installing Node.js LTS with winget ($scope scope)..."
    & $winget.Source install --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements --scope $scope
    if ($LASTEXITCODE -ne 0) {
        Fail 'winget failed to install Node.js LTS.'
    }

    Refresh-Path

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Fail 'Node.js was installed, but node.exe is still not available in PATH.'
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Fail 'Node.js was installed, but npm is still not available in PATH.'
    }
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
        return
    }

    if (Test-Path -LiteralPath $resolvedTarget) {
        Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
    }
    New-Item -ItemType Directory -Path $resolvedTarget -Force | Out-Null

    $exclude = @('.git', 'node_modules', '.env')
    Get-ChildItem -LiteralPath $resolvedSource -Force |
        Where-Object { $exclude -notcontains $_.Name } |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $resolvedTarget $_.Name) -Recurse -Force
        }
}

function Download-ProjectTree {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Target,
        [Parameter(Mandatory = $true)]
        [string[]]$Urls
    )

    $zipPath = Join-Path $env:TEMP ("cms-bootstrap-{0}.zip" -f ([guid]::NewGuid().ToString('N')))
    $extractPath = Join-Path $env:TEMP ("cms-bootstrap-{0}" -f ([guid]::NewGuid().ToString('N')))

    try {
        $downloaded = $false
        foreach ($url in $Urls | Where-Object { $_ }) {
            Write-Step "Downloading project archive from $url ..."
            try {
                Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
                $downloaded = $true
                break
            } catch {
                Write-Step "Archive download failed for $url"
            }
        }

        if (-not $downloaded) {
            Fail 'Project archive download failed. If the repository is private, use a public release ZIP or place the project next to the installer.'
        }

        Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
        $sourceDir = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
        if (-not $sourceDir) {
            Fail 'Downloaded archive did not contain a project directory.'
        }

        Copy-ProjectTree -Source $sourceDir.FullName -Target $Target
    } finally {
        if (Test-Path -LiteralPath $zipPath) {
            Remove-Item -LiteralPath $zipPath -Force
        }
        if (Test-Path -LiteralPath $extractPath) {
            Remove-Item -LiteralPath $extractPath -Recurse -Force
        }
    }
}

function Resolve-InstallRoot {
    param([string]$RequestedPath)

    if ($RequestedPath) {
        return [System.IO.Path]::GetFullPath($RequestedPath)
    }

    if ($Mode -eq 'Controller') {
        return Join-Path $env:LOCALAPPDATA 'CMS-Computer-Managing-System'
    }

    if ($InstallGlobal) {
        return Join-Path $env:ProgramData 'CMS-Computer-Managing-System'
    }

    return Join-Path $env:LOCALAPPDATA 'CMS-Computer-Managing-System'
}

function Stage-Project {
    param([string]$TargetRoot)

    $localRepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $hasLocalProject = (Test-Path -LiteralPath (Join-Path $localRepoRoot 'package.json')) -and (Test-Path -LiteralPath (Join-Path $localRepoRoot 'apps'))

    if ($hasLocalProject) {
        Write-Step "Copying local project files into $TargetRoot ..."
        Copy-ProjectTree -Source $localRepoRoot -Target $TargetRoot
        return
    }

    Download-ProjectTree -Target $TargetRoot -Urls @($RepoZipUrl, $RepoZipFallbackUrl)
}

function Ensure-NpmDependencies {
    param([string]$ProjectRoot)

    if ($SkipDependencyInstall) {
        return
    }

    if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules')) {
        return
    }

    Write-Step 'Installing npm dependencies...'
    Push-Location $ProjectRoot
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) {
            Fail 'npm install failed.'
        }
    } finally {
        Pop-Location
    }
}

function Install-ControllerShortcut {
    param([string]$ProjectRoot)

    $runnerPath = Join-Path $ProjectRoot 'scripts\run-controller.bat'
    if (-not (Test-Path -LiteralPath $runnerPath)) {
        return
    }

    $shortcutDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\CMS'
    New-Item -ItemType Directory -Path $shortcutDir -Force | Out-Null

    $shortcutPath = Join-Path $shortcutDir 'CMS Controller.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $runnerPath
    $shortcut.WorkingDirectory = $ProjectRoot
    $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
    $shortcut.Save()
}

function Start-Controller {
    param([string]$ProjectRoot)

    $runnerPath = Join-Path $ProjectRoot 'scripts\run-controller.bat'
    if (-not (Test-Path -LiteralPath $runnerPath)) {
        Fail "Controller runner was not found at $runnerPath"
    }

    Write-Step 'Starting CMS Controller...'
    Start-Process -FilePath $runnerPath -WorkingDirectory $ProjectRoot | Out-Null
}

function Invoke-AgentBootstrap {
    param([string]$ProjectRoot)

    $batName = if ($Mode -eq 'AgentBackground') { 'enroll-agent-background.bat' } else { 'enroll-agent.bat' }
    $batPath = Join-Path $ProjectRoot "scripts\$batName"
    if (-not (Test-Path -LiteralPath $batPath)) {
        Fail "Agent bootstrap BAT was not found at $batPath"
    }

    $arguments = New-Object System.Collections.Generic.List[string]
    if ($InstallGlobal) {
        if ($DisplayMode) {
            $arguments.Add('--install-display')
        } else {
            $arguments.Add('--install-global')
        }
    }
    $arguments.Add($ServerUrl)
    $arguments.Add($EnrollmentToken)
    $arguments.Add($DeviceName)

    Write-Step "Starting agent bootstrap via $batName ..."
    $process = Start-Process -FilePath $batPath -ArgumentList $arguments -WorkingDirectory $ProjectRoot -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        Fail "$batName exited with code $($process.ExitCode)."
    }
}

$targetRoot = Resolve-InstallRoot -RequestedPath $InstallDir

Write-Step "Mode: $Mode"
Write-Step "Install directory: $targetRoot"

Ensure-Node
Stage-Project -TargetRoot $targetRoot
Ensure-NpmDependencies -ProjectRoot $targetRoot

switch ($Mode) {
    'Controller' {
        Install-ControllerShortcut -ProjectRoot $targetRoot
        Start-Controller -ProjectRoot $targetRoot
    }
    'AgentVisible' {
        Invoke-AgentBootstrap -ProjectRoot $targetRoot
    }
    'AgentBackground' {
        Invoke-AgentBootstrap -ProjectRoot $targetRoot
    }
}
