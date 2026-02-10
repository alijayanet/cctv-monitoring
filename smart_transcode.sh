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
if [ "$VIDEO_CODEC" == "h264" ]; then
    echo "[$(date)] Codec is H264, copying stream for $MTX_PATH..." >> "$LOG_FILE"
    ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "$SOURCE_RTSP" -c copy -map 0:v:0 -an -f rtsp -rtsp_transport tcp "$TARGET_RTSP" >> "$LOG_FILE" 2>&1
else
    echo "[$(date)] Codec is $VIDEO_CODEC (or unknown), transcoding to H.264..." >> "$LOG_FILE"
    # Optimized for ARM/Low power/Ubuntu
    ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "$SOURCE_RTSP" -c:v libx264 -preset ultrafast -tune zerolatency -b:v 1000k -maxrate 1000k -bufsize 2000k -threads 2 -s 1280x720 -pix_fmt yuv420p -map 0:v:0 -an -f rtsp -rtsp_transport tcp "$TARGET_RTSP" >> "$LOG_FILE" 2>&1
fi

