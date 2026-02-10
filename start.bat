@echo off

echo Starting CCTV Monitoring System...

REM Check if mediamtx exists
if not exist mediamtx.exe (
    echo Error: mediamtx.exe not found!
    echo Please download it from https://github.com/bluenviron/mediamtx/releases
    pause
    exit /b
)

echo Starting MediaMTX...
start "MediaMTX Server" mediamtx.exe

echo Starting Node.js Server...
npm start

pause
