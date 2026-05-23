$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $env:CMS_ALLOW_INSECURE_DEFAULT_TOKENS) {
    $env:CMS_ALLOW_INSECURE_DEFAULT_TOKENS = '1'
}

Push-Location $projectRoot
try {
    & node apps/server/index.js
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
