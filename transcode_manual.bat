@echo off
set /p CAMERA_ID="Masukkan ID Kamera (lihat di Admin, misal 1): "
set /p CAMERA_URL="Masukkan URL RTSP Kamera: "

echo Starting Transcoding for Camera %CAMERA_ID%...
ffmpeg -i %CAMERA_URL% -c:v libx264 -preset ultrafast -tune zerolatency -b:v 600k -s 854x480 -an -f rtsp rtsp://127.0.0.1:8555/cam_%CAMERA_ID%

pause
