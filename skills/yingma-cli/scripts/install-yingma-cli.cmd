@echo off
setlocal EnableExtensions

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。请先安装 Node.js 18 或更高版本，再运行安装器。 1>&2
  exit /b 1
)

set "SOURCE=%~dp0yingma.js"
set "ROOT=%USERPROFILE%\.yingma"
set "BIN=%ROOT%\bin"
set "TARGET=%BIN%\yingma.js"
set "LAUNCHER=%BIN%\yingma.cmd"

if exist "%TARGET%" (
  if /I not "%~1"=="--force" (
    echo 已存在 "%TARGET%"。确认更新后使用 --force 重新运行。 1>&2
    exit /b 1
  )
)

if not exist "%BIN%" mkdir "%BIN%"
copy /Y "%SOURCE%" "%TARGET%" >nul
(
  echo @echo off
  echo node "%%~dp0yingma.js" %%*
) > "%LAUNCHER%"

echo 已安装 yingma 到 "%LAUNCHER%"
echo 请将 "%BIN%" 添加至 PATH，重新打开终端后运行 yingma doctor。
