$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'extension/manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$outputDir = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$outputPath = Join-Path $outputDir "tab-signature-v$($manifest.version).zip"
Compress-Archive -Path (Join-Path $projectRoot 'extension/*'),(Join-Path $projectRoot 'README.md') -DestinationPath $outputPath -Force
Write-Output $outputPath
