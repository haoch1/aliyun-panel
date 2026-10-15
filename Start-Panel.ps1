param([int]$Port = 4182)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) { pnpm install; if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' } }
pnpm build
if ($LASTEXITCODE -ne 0) { throw '构建失败' }
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'data') -Force | Out-Null
$env:PORT = [string]$Port
$taskNode = (Get-Command node).Source
$taskEntry = Join-Path $PSScriptRoot 'bin\aliyun-panel.mjs'
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('"' + $taskEntry + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'data\server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'data\server-error.log') -PassThru
Write-Host "Aliyun Panel：http://127.0.0.1:$Port （进程 $($taskProcess.Id)）"
