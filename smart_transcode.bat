@echo off
setlocal enabledelayedexpansion

:: Log file mapping - use per-camera log to avoid file lock conflicts
set LOG_DIR=%~dp0stream_logs
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set LOG_FILE=%LOG_DIR%\transcode_%MTX_PATH%.log
echo [%DATE% %TIME%] --- Processing: %MTX_PATH% --- >> "%LOG_FILE%"

:: Only process streams ending in _input
echo %MTX_PATH% | findstr "_input" >nul
if errorlevel 1 (
    exit /b 0
)

:: Read config values - defaults
set CONFIG_FILE=%~dp0config.json
set RTSP_PORT=8555
set VIDEO_BITRATE=800k
set MAX_VIDEO_BITRATE=900k
set VIDEO_FPS=12
set AUDIO_ENABLED=true
set AUDIO_BITRATE=64k
set RESOLUTION=1280:720
set VIDEO_CODEC_CONFIG=h264
set RESOLUTION_CONFIG=720p

:: Read RTSP port from config
for /f "tokens=2 delims=:" %%a in ('findstr "rtsp_port" "%CONFIG_FILE%" 2^>nul') do (
    set "val=%%a"
    set "val=!val: =!"
    set "val=!val:,=!"
    set "val=!val:"=!"
    if not "!val!"=="" set RTSP_PORT=!val!
)

:: Read bitrate from config
for /f "tokens=2 delims=:" %%a in ('findstr "\"bitrate\"" "%CONFIG_FILE%" 2^>nul') do (
    set "val=%%a"
    set "val=!val: =!"
    set "val=!val:,=!"
    set "val=!val:"=!"
    if not "!val!"=="" set VIDEO_BITRATE=!val!
)

:: Read max_bitrate from config
for /f "tokens=2 delims=:" %%a in ('findstr "max_bitrate" "%CONFIG_FILE%" 2^>nul') do (
    set "val=%%a"
    set "val=!val: =!"
    set "val=!val:,=!"
    set "val=!val:"=!"
    if not "!val!"=="" set MAX_VIDEO_BITRATE=!val!
)

:: Read frame_rate from config
for /f "tokens=2 delims=:" %%a in ('findstr "frame_rate" "%CONFIG_FILE%" 2^>nul') do (
    set "val=%%a"
    set "val=!val: =!"
    set "val=!val:,=!"
    set "val=!val:"=!"
    if not "!val!"=="" set VIDEO_FPS=!val!
)

:: Read audio_bitrate from config
for /f "tokens=2 delims=:" %%a in ('findstr "audio_bitrate" "%CONFIG_FILE%" 2^>nul') do (
    set "val=%%a"
    set "val=!val: =!"
    set "val=!val:,=!"
    set "val=!val:"=!"
    if not "!val!"=="" set AUDIO_BITRATE=!val!
)

:: Read audio_enabled from config
for /f "tokens=2 delims=:" %%a in ('findstr "audio_enabled" "%CONFIG_FILE%" 2^>nul') do (
    set "val=%%a"
    set "val=!val: =!"
    set "val=!val:,=!"
    set "val=!val:"=!"
    if not "!val!"=="" set AUDIO_ENABLED=!val!
)

:: Read resolution from config and map to WxH
for /f "tokens=2 delims=:" %%a in ('findstr "\"resolution\"" "%CONFIG_FILE%" 2^>nul') do (
    set "val=%%a"
    set "val=!val: =!"
    set "val=!val:,=!"
    set "val=!val:"=!"
    if not "!val!"=="" set RESOLUTION_CONFIG=!val!
)

:: Map resolution string to width:height
if /i "!RESOLUTION_CONFIG!"=="720p"  set RESOLUTION=1280:720
if /i "!RESOLUTION_CONFIG!"=="1080p" set RESOLUTION=1920:1080
if /i "!RESOLUTION_CONFIG!"=="480p"  set RESOLUTION=854:480

:: Read video_codec from config
for /f "tokens=2 delims=:" %%a in ('findstr "\"video_codec\"" "%CONFIG_FILE%" 2^>nul') do (
    set "val=%%a"
    set "val=!val: =!"
    set "val=!val:,=!"
    set "val=!val:"=!"
    if not "!val!"=="" set VIDEO_CODEC_CONFIG=!val!
)

:: Internal URLs
set SOURCE_RTSP=rtsp://127.0.0.1:%RTSP_PORT%/%MTX_PATH%
set TARGET_NAME=%MTX_PATH:_input=%
set TARGET_RTSP=rtsp://127.0.0.1:%RTSP_PORT%/%TARGET_NAME%

:: Wait for MediaMTX to stabilize the source
ping 127.0.0.1 -n 3 >nul

:: Detect Codec
echo [%DATE% %TIME%] Probing codec for %MTX_PATH%... >> "%LOG_FILE%"
ffprobe -v error -rtsp_transport tcp -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 -timeout 3000000 "%SOURCE_RTSP%" > "%TEMP%\codec_probe_%MTX_PATH%.txt" 2>nul
set /p VIDEO_CODEC=<"%TEMP%\codec_probe_%MTX_PATH%.txt"
del "%TEMP%\codec_probe_%MTX_PATH%.txt" 2>nul

echo [%DATE% %TIME%] Detected Codec: '%VIDEO_CODEC%', Config: codec=%VIDEO_CODEC_CONFIG% res=%RESOLUTION% bitrate=%VIDEO_BITRATE% fps=%VIDEO_FPS% >> "%LOG_FILE%"

:: Smart codec selection: copy H.264 if not forced to transcode, else transcode
if /i "%VIDEO_CODEC%"=="h264" if /i NOT "%VIDEO_CODEC_CONFIG%"=="libx264" (
    echo [%DATE% %TIME%] H.264 detected, using COPY mode ^(no transcoding^) >> "%LOG_FILE%"
    if /i "%AUDIO_ENABLED%"=="true" (
        ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "%SOURCE_RTSP%" -c:v copy -c:a copy -f rtsp -rtsp_transport tcp "%TARGET_RTSP%" >> "%LOG_FILE%" 2>&1
    ) else (
        ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "%SOURCE_RTSP%" -c:v copy -an -f rtsp -rtsp_transport tcp "%TARGET_RTSP%" >> "%LOG_FILE%" 2>&1
    )
) else (
    echo [%DATE% %TIME%] Non-H.264 detected ^(%VIDEO_CODEC%^), transcoding to H.264 >> "%LOG_FILE%"
    if /i "%AUDIO_ENABLED%"=="true" (
        ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "%SOURCE_RTSP%" -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -level 4.0 -pix_fmt yuv420p -b:v %VIDEO_BITRATE% -maxrate %MAX_VIDEO_BITRATE% -bufsize 1600k -r %VIDEO_FPS% -g 24 -c:a aac -ac 1 -ar 44100 -b:a %AUDIO_BITRATE% -f rtsp -rtsp_transport tcp "%TARGET_RTSP%" >> "%LOG_FILE%" 2>&1
    ) else (
        ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "%SOURCE_RTSP%" -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -level 4.0 -pix_fmt yuv420p -b:v %VIDEO_BITRATE% -maxrate %MAX_VIDEO_BITRATE% -bufsize 1600k -r %VIDEO_FPS% -g 24 -an -f rtsp -rtsp_transport tcp "%TARGET_RTSP%" >> "%LOG_FILE%" 2>&1
    )
)
