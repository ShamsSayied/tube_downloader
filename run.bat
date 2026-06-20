@echo off
setlocal enabledelayedexpansion

:: Change directory to the script's root folder (critical when running as Administrator)
cd /d "%~dp0"

:: Title
title Tube Downloader Setup ^& Launcher

echo ===================================================
echo           Tube Downloader Setup ^& Launcher
echo ===================================================
echo.

:: Flags to check if we need to request elevation
set "NEED_ELEVATION=0"

:: Check if Node.js is installed
where node >nul 2>&1
if %errorLevel% neq 0 set "NEED_ELEVATION=1"

:: Check if Python is installed
where python >nul 2>&1
if %errorLevel% neq 0 (
    where py >nul 2>&1
    if !errorLevel! neq 0 set "NEED_ELEVATION=1"
)

:: Check if FFmpeg is installed
where ffmpeg >nul 2>&1
if %errorLevel% neq 0 set "NEED_ELEVATION=1"

:: If any dependency is missing, request admin permissions to allow installer execution
if "%NEED_ELEVATION%"=="1" (
    net session >nul 2>&1
    if !errorLevel! neq 0 (
        echo [!] Missing system dependencies detected.
        echo [*] Requesting Administrator privileges to install them...
        powershell -Command "Start-Process -FilePath '%~fn0' -ArgumentList '%*' -Verb RunAs"
        exit /b
    )
)

:: ─── Helper function to refresh PATH from registry ───
goto :Main

:RefreshPath
for /f "tokens=2*" %%a in ('reg query "HKLM\System\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USR_PATH=%%b"
call set "PATH=%SYS_PATH%;%USR_PATH%"
goto :EOF

:Main
:: 1. Verify / Install Node.js
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo [*] Node.js not detected. Installing via winget...
    winget install --id OpenJS.NodeJS -e --silent --accept-source-agreements --accept-package-agreements
    if !errorLevel! neq 0 (
        echo [x] Failed to install Node.js automatically. Please install it manually from: https://nodejs.org/
        pause
        exit /b
    )
    echo [*] Node.js installed successfully. Refreshing environment variables...
    call :RefreshPath
) else (
    echo [V] Node.js is installed.
)

:: 2. Verify / Install Python
where python >nul 2>&1
if %errorLevel% neq 0 (
    where py >nul 2>&1
    if !errorLevel! neq 0 (
        echo [*] Python not detected. Installing via winget...
        winget install --id Python.Python.3 -e --silent --accept-source-agreements --accept-package-agreements
        if !errorLevel! neq 0 (
            echo [x] Failed to install Python automatically. Please install it manually from: https://www.python.org/
            pause
            exit /b
        )
        echo [*] Python installed successfully. Refreshing environment variables...
        call :RefreshPath
    ) else (
        echo [V] Python [py launcher] is installed.
    )
) else (
    echo [V] Python is installed.
)

:: 3. Verify / Install FFmpeg
where ffmpeg >nul 2>&1
if %errorLevel% neq 0 (
    echo [*] FFmpeg not detected. Installing via winget...
    winget install --id Gyan.FFmpeg -e --silent --accept-source-agreements --accept-package-agreements
    if !errorLevel! neq 0 (
        echo [x] Failed to install FFmpeg automatically. Please install it manually.
        pause
        exit /b
    )
    echo [*] FFmpeg installed successfully. Refreshing environment variables...
    call :RefreshPath
) else (
    echo [V] FFmpeg is installed.
)

:: 4. Install local package dependencies (npm modules)
if not exist "node_modules" (
    echo [*] node_modules directory not found. Installing npm dependencies...
    call npm install
    if !errorLevel! neq 0 (
        echo [x] npm install failed. Please check your internet connection.
        pause
        exit /b
    )
    echo [V] npm dependencies installed successfully.
) else (
    echo [V] npm dependencies are already installed.
)

:: 5. Install / Update Python yt-dlp package
echo [*] Checking yt-dlp package...
python -c "import yt_dlp" >nul 2>&1
if %errorLevel% neq 0 (
    echo [*] yt-dlp package not found. Installing via pip...
    python -m pip install -U yt-dlp
    if !errorLevel! neq 0 (
        echo [x] Failed to install yt-dlp package.
        pause
        exit /b
    )
    echo [V] yt-dlp package installed successfully.
) else (
    echo [V] yt-dlp package is installed.
)

:: 6. Launch the server and open browser
echo.
echo [*] Starting Tube Downloader server...
echo [*] Launching http://localhost:3000 in your browser...
start http://localhost:3000
call npm start

pause
