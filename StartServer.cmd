@echo off
title Minecraft Java Server
setlocal
cd /d "%~dp0"

set "SERVER_DIR=%~dp0minecraft-java-server"
set "PID_FILE=%SERVER_DIR%\server.pid"
set "MANAGER_PID_FILE=%SERVER_DIR%\server-manager.pid"
set "LOG_DIR=%~dp0Logs\minecraft-server"
set "OUT_LOG=%LOG_DIR%\server.out.log"
set "ERR_LOG=%LOG_DIR%\server.err.log"
set "MANAGER_OUT_LOG=%LOG_DIR%\manager.out.log"
set "MANAGER_ERR_LOG=%LOG_DIR%\manager.err.log"
if exist "%~dp0Node\node.exe" (
  set "NODE_EXE=%~dp0Node\node.exe"
) else (
  set "NODE_EXE=node"
)

if not exist "%SERVER_DIR%\server.jar" (
  echo server.jar was not found in:
  echo %SERVER_DIR%
  pause
  exit /b 1
)

if not exist "%SERVER_DIR%\server-manager.js" (
  echo server-manager.js was not found in:
  echo %SERVER_DIR%
  pause
  exit /b 1
)

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$pidFile='%MANAGER_PID_FILE%';" ^
  "$running=$false;" ^
  "if (Test-Path -LiteralPath $pidFile) { $old=[int](Get-Content -LiteralPath $pidFile -Raw); if (Get-Process -Id $old -ErrorAction SilentlyContinue) { $running=$true; Write-Host 'Minecraft server manager is already running. PID:' $old } }" ^
  "if (-not $running) {" ^
  "  $p=Start-Process -WindowStyle Hidden -FilePath '%NODE_EXE%' -ArgumentList 'server-manager.js' -WorkingDirectory '%SERVER_DIR%' -RedirectStandardOutput '%MANAGER_OUT_LOG%' -RedirectStandardError '%MANAGER_ERR_LOG%' -PassThru;" ^
  "  Write-Host 'Minecraft server manager started. PID:' $p.Id;" ^
  "}"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$url='http://127.0.0.1:3101/api/state';" ^
  "$ready=$false;" ^
  "for ($i=0; $i -lt 30; $i++) { try { Invoke-RestMethod -Uri $url -TimeoutSec 2 | Out-Null; $ready=$true; break } catch { Start-Sleep -Milliseconds 500 } }" ^
  "if (-not $ready) { Write-Host 'Minecraft server manager did not become ready.'; exit 1 }" ^
  "$result=Invoke-RestMethod -Uri 'http://127.0.0.1:3101/api/start' -Method Post -Body '{}' -ContentType 'application/json' -TimeoutSec 10;" ^
  "Write-Host 'Minecraft server started through manager. PID:' $result.pid;"

if errorlevel 1 (
  echo.
  echo Server start failed.
  pause
  exit /b 1
)

echo.
echo Server is starting in the background.
echo Server manager: http://localhost:3101
echo Console logs: %OUT_LOG%
echo Error logs:   %ERR_LOG%
start "" "http://127.0.0.1:3101/"
endlocal

