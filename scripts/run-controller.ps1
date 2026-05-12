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

if (-not (Test-Path -LiteralPath $controllerEntry)) {
    throw "Controller entry file was not found at $controllerEntry"
}

if (-not (Test-Path -LiteralPath $electronCmd)) {
    throw "electron.cmd was not found at $electronCmd. Run the installer first."
}

Push-Location $ProjectRoot
try {
    & $electronCmd $controllerEntry
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
