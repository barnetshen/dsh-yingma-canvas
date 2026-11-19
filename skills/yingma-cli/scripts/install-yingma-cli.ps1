param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "未检测到 Node.js。请先安装 Node.js 18 或更高版本，再运行安装器。"
}

$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $sourceRoot "yingma.js"
$installRoot = Join-Path $HOME ".yingma"
$installBin = Join-Path $installRoot "bin"
$target = Join-Path $installBin "yingma.js"
$launcher = Join-Path $installBin "yingma.cmd"

if ((Test-Path $target) -and (-not $Force)) {
  throw "已存在 $target。确认更新后使用 -Force 重新运行。"
}

New-Item -ItemType Directory -Force -Path $installBin | Out-Null
Copy-Item -Force $source $target
@'
@echo off
node "%~dp0yingma.js" %*
'@ | Set-Content -Encoding ASCII $launcher

Write-Host "已安装 yingma 到 $launcher"
Write-Host "请将 $installBin 添加至 PATH，重新打开终端后运行 yingma doctor。"
