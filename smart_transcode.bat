@echo off
setlocal enabledelayedexpansion

:: Log file mapping
set LOG_FILE=%~dp0smart_transcode.log
echo [%DATE% %TIME%] --- Processing: %MTX_PATH% --- >> "%LOG_FILE%"

:: Only process streams ending in _input
echo %MTX_PATH% | findstr "_input" >nul
if errorlevel 1 (
    exit /b 0
)

:: Internal URLs
set SOURCE_RTSP=rtsp://127.0.0.1:8555/%MTX_PATH%
set TARGET_NAME=%MTX_PATH:_input=%
set TARGET_RTSP=rtsp://127.0.0.1:8555/%TARGET_NAME%

:: Wait for MediaMTX to stabilize the source
timeout /t 2 /nobreak >nul

:: Detect Codec
echo [%DATE% %TIME%] Probing codec for %MTX_PATH%... >> "%LOG_FILE%"
ffprobe -v error -rtsp_transport tcp -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 -timeout 3000000 "%SOURCE_RTSP%" > "%TEMP%\codec_probe.txt" 2>nul
set /p VIDEO_CODEC=<"%TEMP%\codec_probe.txt"
del "%TEMP%\codec_probe.txt" 2>nul

echo [%DATE% %TIME%] Detected Codec: '%VIDEO_CODEC%' >> "%LOG_FILE%"

:: Only transcode if it's NOT h264 (usually h265/hevc)
:: Force transcode to H.264 (libx264) + yuv420p for maximum compatibility on Mobile Browsers
echo [%DATE% %TIME%] Forcing transcode to H.264/yuv420p for %MTX_PATH%... >> "%LOG_FILE%"
ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "%SOURCE_RTSP%" -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -level 4.0 -pix_fmt yuv420p -b:v 1024k -maxrate 1024k -bufsize 2048k -r 15 -g 30 -an -f rtsp -rtsp_transport tcp "%TARGET_RTSP%" >> "%LOG_FILE%" 2>&1
