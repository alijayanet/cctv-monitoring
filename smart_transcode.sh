#!/bin/bash

# Log file for debugging - dynamic path based on script location
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOG_FILE="$SCRIPT_DIR/smart_transcode.log"
echo "[$(date)] --- Processing: $MTX_PATH ---" >> "$LOG_FILE"

# Only process streams ending in _input
if [[ "$MTX_PATH" != *"_input"* ]]; then
    exit 0
fi

# Internal URLs
SOURCE_RTSP="rtsp://127.0.0.1:8555/$MTX_PATH"
TARGET_NAME="${MTX_PATH/_input/}"
TARGET_RTSP="rtsp://127.0.0.1:8555/$TARGET_NAME"

# Wait a moment for MediaMTX to stabilize the source stream
sleep 2

# Detect Codec
echo "[$(date)] Probing codec for $MTX_PATH..." >> "$LOG_FILE"
VIDEO_CODEC=$(ffprobe -v error -rtsp_transport tcp -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 -timeout 5000000 "$SOURCE_RTSP")

echo "[$(date)] Detected Codec: '$VIDEO_CODEC'" >> "$LOG_FILE"

# Only transcode if it's NOT h264 (usually h265/hevc)
# Force transcode to H.264 (libx264) + yuv420p for maximum compatibility on Mobile Browsers
echo "[$(date)] Forcing transcode to H.264/yuv420p for $MTX_PATH..." >> "$LOG_FILE"
ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "$SOURCE_RTSP" -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -level 4.0 -pix_fmt yuv420p -b:v 1024k -maxrate 1024k -bufsize 2048k -r 15 -g 30 -threads 2 -an -f rtsp -rtsp_transport tcp "$TARGET_RTSP" >> "$LOG_FILE" 2>&1

