param(
    [ValidateSet('Controller', 'AgentVisible', 'AgentBackground')]
    [string]$Mode = 'Controller',
    [string]$ServerUrl = 'ws://localhost:4377/ws',
    [string]$AdminToken = $(if ($env:CMS_ADMIN_TOKEN) { $env:CMS_ADMIN_TOKEN } else { 'change-this-cms-token' }),
    [string]$EnrollmentToken = 'change-this-cms-token',
    [string]$DeviceName = $env:COMPUTERNAME,
    [switch]$InstallGlobal,
    [switch]$DisplayMode,
    [string]$InstallDir,
    [string]$RepoZipUrl = 'https://github.com/EpicNori/CMS-Computer-Managing-System-/archive/refs/heads/main.zip',
    [string]$RepoZipFallbackUrl = 'https://codeload.github.com/EpicNori/CMS-Computer-Managing-System-/zip/refs/heads/main',
    [string]$RawBaseUrl = 'https://raw.githubusercontent.com/EpicNori/CMS-Computer-Managing-System-/main',
    [switch]$AllowInsecureDefaultTokens,
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

    New-Item -ItemType Directory -Path $resolvedTarget -Force | Out-Null

    $exclude = @('.git', 'node_modules', '.env', 'logs')
    Get-ChildItem -LiteralPath $resolvedSource -Force |
        Where-Object { $exclude -notcontains $_.Name } |
        ForEach-Object {
            $destination = Join-Path $resolvedTarget $_.Name
            if (Test-Path -LiteralPath $destination) {
                try {
                    Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction Stop
                } catch {
                    Write-Step "Could not remove existing '$destination'. It may be in use; overwriting available files."
                }
            }
            Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
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

function Download-PublicFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [Parameter(Mandatory = $true)]
        [string]$Target
    )

    $targetDir = Split-Path -Parent $Target
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    Write-Step "Downloading $Url ..."
    Invoke-WebRequest -Uri $Url -OutFile $Target -UseBasicParsing
}

function Write-AgentLitePackage {
    param([string]$ProjectRoot)

    $packagePath = Join-Path $ProjectRoot 'package.json'
    @'
{
  "name": "cms-agent-lite",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "dotenv": "^16.4.7",
    "ws": "^8.18.0"
  }
}
'@ | Set-Content -LiteralPath $packagePath -Encoding ASCII
}

function Remove-AgentLiteExtras {
    param([string]$ProjectRoot)

    $relativePaths = @(
        'apps\controller',
        'apps\server',
        'scripts\dev-agent.ps1',
        'scripts\dev-server.ps1',
        'scripts\install-controller.bat',
        'scripts\run-controller.bat',
        'scripts\run-controller.ps1',
        'tests',
        'package-lock.json'
    )

    foreach ($relativePath in $relativePaths) {
        $path = Join-Path $ProjectRoot $relativePath
        if (-not (Test-Path -LiteralPath $path)) {
            continue
        }

        try {
            Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
        } catch {
            Write-Step "Could not remove unused agent-lite path '$path'. It may be in use."
        }
    }
}

function Stage-AgentLite {
    param([string]$TargetRoot)

    Write-Step "Installing lightweight agent files into $TargetRoot ..."
    New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
    Download-PublicFile -Url "$RawBaseUrl/apps/agent/index.js" -Target (Join-Path $TargetRoot 'apps\agent\index.js')
    Download-PublicFile -Url "$RawBaseUrl/scripts/run-agent.ps1" -Target (Join-Path $TargetRoot 'scripts\run-agent.ps1')
    Download-PublicFile -Url "$RawBaseUrl/scripts/enroll-agent-background.bat" -Target (Join-Path $TargetRoot 'scripts\enroll-agent-background.bat')
    Write-AgentLitePackage -ProjectRoot $TargetRoot
    Remove-AgentLiteExtras -ProjectRoot $TargetRoot
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
    $isAgentMode = $Mode -eq 'AgentVisible' -or $Mode -eq 'AgentBackground'

    if ($hasLocalProject) {
        Write-Step "Copying local project files into $TargetRoot ..."
        Copy-ProjectTree -Source $localRepoRoot -Target $TargetRoot
        return
    }

    if ($isAgentMode) {
        Stage-AgentLite -TargetRoot $TargetRoot
        return
    }

    Download-ProjectTree -Target $TargetRoot -Urls @($RepoZipUrl, $RepoZipFallbackUrl)
}

function Ensure-NpmDependencies {
    param([string]$ProjectRoot)

    if ($SkipDependencyInstall) {
        return
    }

    Write-Step 'Installing npm dependencies...'
    Push-Location $ProjectRoot
    try {
        & npm install --omit=dev
        if ($LASTEXITCODE -ne 0) {
            Fail 'npm install failed.'
        }
    } finally {
        Pop-Location
    }
}

function Assert-NonDefaultSecret {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [string]$Value,
        [Parameter(Mandatory = $true)]
        [string]$DefaultValue
    )

    if ($Value -and ($Value -ne $DefaultValue)) {
        return
    }

    if ($AllowInsecureDefaultTokens) {
        return
    }

    Fail "$Name must be set to a non-default value. Pass -$Name or set $Name in the environment. Use -AllowInsecureDefaultTokens only for local demos."
}

function Save-ProjectEnvironment {
    param([string]$ProjectRoot)

    $envPath = Join-Path $ProjectRoot '.env'
    $values = [ordered]@{
        CMS_SERVER_URL = $ServerUrl
        CMS_ALLOW_INSECURE_DEFAULT_TOKENS = $(if ($AllowInsecureDefaultTokens) { '1' } else { '0' })
    }

    if ($Mode -eq 'Controller') {
        Assert-NonDefaultSecret -Name 'AdminToken' -Value $AdminToken -DefaultValue 'change-this-cms-token'
        $values.CMS_ADMIN_TOKEN = $AdminToken
    } else {
        Assert-NonDefaultSecret -Name 'EnrollmentToken' -Value $EnrollmentToken -DefaultValue 'change-this-cms-token'
        $values.CMS_ENROLLMENT_TOKEN = $EnrollmentToken
        $values.CMS_DEVICE_NAME = $DeviceName
    }

    $lines = foreach ($entry in $values.GetEnumerator()) {
        "$($entry.Key)=$($entry.Value)"
    }

    Set-Content -LiteralPath $envPath -Value $lines -Encoding ASCII
    Write-Step "Wrote runtime configuration to $envPath"
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

    $runnerPath = Join-Path $ProjectRoot 'scripts\run-agent.ps1'
    if (-not (Test-Path -LiteralPath $runnerPath)) {
        Fail "Agent runner was not found at $runnerPath"
    }

    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $runnerPath,
        '-Mode', $(if ($Mode -eq 'AgentBackground') { 'Background' } else { 'Visible' }),
        '-ProjectRoot', $ProjectRoot,
        '-ServerUrl', $ServerUrl,
        '-EnrollmentToken', $EnrollmentToken,
        '-DeviceName', $DeviceName
    )
    if ($InstallGlobal) {
        $arguments += '-InstallGlobal'
    }
    if ($DisplayMode) {
        $arguments += '-DisplayMode'
    }
    if ($SkipDependencyInstall) {
        $arguments += '-SkipDependencyInstall'
    }

    Write-Step 'Starting agent runner...'
    Push-Location $ProjectRoot
    try {
        & powershell.exe @arguments
    } finally {
        Pop-Location
    }

    if ($LASTEXITCODE -ne 0) {
        Fail "Agent runner exited with code $LASTEXITCODE."
    }
}

$targetRoot = Resolve-InstallRoot -RequestedPath $InstallDir

Write-Step "Mode: $Mode"
Write-Step "Install directory: $targetRoot"

Ensure-Node
Stage-Project -TargetRoot $targetRoot
Save-ProjectEnvironment -ProjectRoot $targetRoot
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
