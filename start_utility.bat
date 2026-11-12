@echo off
title CCD Voice Automation - Utility Service
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not on PATH. Install it from https://nodejs.org
    pause
    exit /b 1
)

if not exist ".env" (
    echo [ERROR] .env file not found in %CD%
    pause
    exit /b 1
)

rem Install when node_modules is missing or any dependency in package.json is not installed.
call npm ls --depth=0 >nul 2>&1
if errorlevel 1 (
    echo Installing dependencies...
    call npm install --no-fund --no-audit
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

rem Read PORT from .env (default 8001) and check whether something is already listening on it.
set "PORT=8001"
for /f "tokens=1,* delims==" %%A in ('findstr /b /c:"PORT=" .env') do set "PORT=%%B"
set "PORT=%PORT: =%"
set "PID="
for /f %%P in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"') do set "PID=%%P"

if defined PID (
    echo.
    echo [WARNING] Port %PORT% is already in use by process %PID%:
    powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=%PID%'; '   ' + $p.CommandLine; '   started ' + $p.CreationDate"
    echo.
    echo This is usually an older copy of the utility still running in another window.
    choice /c YN /m "Stop process %PID% and start the utility"
    if errorlevel 2 (
        echo Not started. Close the other window, or change PORT in .env.
        pause
        exit /b 1
    )
    taskkill /PID %PID% /F >nul
    if errorlevel 1 (
        echo [ERROR] Could not stop process %PID%. Close it manually and try again.
        pause
        exit /b 1
    )
    echo Stopped process %PID%.
    timeout /t 1 /nobreak >nul
)

echo Starting CCD Voice Automation utility on port %PORT%... press Ctrl+C to stop.
echo.
call npm start

echo.
echo Server stopped.
pause
