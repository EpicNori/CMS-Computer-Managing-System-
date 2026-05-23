param(
    [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'

if (-not $ProjectRoot) {
    $scriptProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    if (Test-Path -LiteralPath (Join-Path $scriptProjectRoot 'apps\controller\main.js')) {
        $ProjectRoot = $scriptProjectRoot
    } else {
        $ProjectRoot = Join-Path $env:LOCALAPPDATA 'CMS-Computer-Managing-System'
    }
}

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$electronCmd = Join-Path $ProjectRoot 'node_modules\.bin\electron.cmd'
$controllerEntry = Join-Path $ProjectRoot 'apps\controller\main.js'
$serverEntry = Join-Path $ProjectRoot 'apps\server\index.js'
if (-not $env:CMS_ALLOW_INSECURE_DEFAULT_TOKENS) {
    $env:CMS_ALLOW_INSECURE_DEFAULT_TOKENS = '1'
}

function Test-TcpPort {
    param(
        [string]$HostName,
        [int]$Port
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connect = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(1000, $false)) {
            return $false
        }
        $client.EndConnect($connect)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Start-LocalCoordinatorIfNeeded {
    $serverUrl = if ($env:CMS_SERVER_URL) { $env:CMS_SERVER_URL } else { 'ws://localhost:4377/ws' }
    try {
        $uri = [Uri]$serverUrl
    } catch {
        return
    }

    if ($uri.Host -notin @('localhost', '127.0.0.1', '::1')) {
        return
    }

    $port = if ($uri.Port -gt 0) { $uri.Port } elseif ($uri.Scheme -eq 'wss') { 443 } else { 80 }
    if (Test-TcpPort -HostName $uri.Host -Port $port) {
        return
    }

    if (-not (Test-Path -LiteralPath $serverEntry)) {
        throw "Coordinator server entry file was not found at $serverEntry"
    }

    Write-Host "[CMS] Local coordinator is not reachable at $serverUrl. Starting it in the background..."
    Start-Process -WindowStyle Hidden -FilePath node -ArgumentList @($serverEntry) -WorkingDirectory $ProjectRoot | Out-Null

    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline) {
        if (Test-TcpPort -HostName $uri.Host -Port $port) {
            return
        }
        Start-Sleep -Milliseconds 250
    }

    Write-Warning "[CMS] Controller will keep reconnecting, but the local coordinator did not become reachable within 8 seconds."
}

if (-not (Test-Path -LiteralPath $controllerEntry)) {
    throw "Controller entry file was not found at $controllerEntry"
}

if (-not (Test-Path -LiteralPath $electronCmd)) {
    throw "electron.cmd was not found at $electronCmd. Run the installer first."
}

Push-Location $ProjectRoot
try {
    Start-LocalCoordinatorIfNeeded
    & $electronCmd $controllerEntry
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
