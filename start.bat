@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo [1/3] Building shared package...
call npm run build --workspace=shared
if errorlevel 1 (
  echo Failed to build shared.
  pause
  exit /b 1
)

echo [2/3] Starting Worker...
start "CryptoMonitor-Worker" cmd /k "npm run dev:worker"

echo [3/3] Starting Web...
start "CryptoMonitor-Web" cmd /k "npm run dev:web"

echo Startup command issued.
pause
