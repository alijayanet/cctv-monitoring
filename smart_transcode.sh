#!/bin/bash

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOG_DIR="$SCRIPT_DIR/stream_logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/transcode_${MTX_PATH}.log"
echo "[$(date)] --- Processing: $MTX_PATH ---" >> "$LOG_FILE"

# Only process streams ending in _input
if [[ "$MTX_PATH" != *"_input"* ]]; then
    exit 0
fi

# Read recording settings from config.json with fallback values
CONFIG_FILE="$SCRIPT_DIR/config.json"

# Helper function to parse JSON value (supports strings and numbers)
get_config_value() {
    local key="$1"
    local default="$2"
    if [ -f "$CONFIG_FILE" ]; then
        # Try matching string value first: "key": "value"
        local value=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$CONFIG_FILE" | cut -d'"' -f4)
        
        # If empty, try matching number/boolean value: "key": 123 or "key": true
        if [ -z "$value" ]; then
            value=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*[^,}]*" "$CONFIG_FILE" | cut -d':' -f2 | tr -d ' "')
        fi
        
        if [ -n "$value" ]; then
            echo "$value"
        else
            echo "$default"
        fi
    else
        echo "$default"
    fi
}

# Get RTSP port from config or default to 8555
RTSP_PORT=$(get_config_value "rtsp_port" "8555")
if [ -z "$RTSP_PORT" ]; then
    RTSP_PORT="8555"
fi

SOURCE_RTSP="rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH"
TARGET_NAME="${MTX_PATH/_input/}"
TARGET_RTSP="rtsp://127.0.0.1:$RTSP_PORT/$TARGET_NAME"

VIDEO_CODEC_CONFIG=$(get_config_value "video_codec" "h264")
RESOLUTION_CONFIG=$(get_config_value "resolution" "720p")
VIDEO_BITRATE_CONFIG=$(get_config_value "bitrate" "800k")
MAX_VIDEO_BITRATE_CONFIG=$(get_config_value "max_bitrate" "900k")
VIDEO_FPS_CONFIG=$(get_config_value "frame_rate" "12")
AUDIO_ENABLED_CONFIG=$(get_config_value "audio_enabled" "true")
AUDIO_BITRATE_CONFIG=$(get_config_value "audio_bitrate" "64k")

# Map resolution to FFmpeg resolution
case "$RESOLUTION_CONFIG" in
    "720p") RESOLUTION="1280:720" ;;
    "1080p") RESOLUTION="1920:1080" ;;
    "D1") RESOLUTION="720:480" ;;
    *) RESOLUTION="1280:720" ;;
esac

# Global tunable parameters from config
VIDEO_BITRATE="$VIDEO_BITRATE_CONFIG"
MAX_VIDEO_BITRATE="$MAX_VIDEO_BITRATE_CONFIG"
VIDEO_BUF_SIZE="1600k"
VIDEO_FPS="$VIDEO_FPS_CONFIG"
GOP_SIZE=$((VIDEO_FPS * 2))
ENC_THREADS=1

sleep 2

VIDEO_CODEC=$(
  ffprobe -v error -rtsp_transport tcp -select_streams v:0 \
    -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 \
    "$SOURCE_RTSP" 2>/dev/null | head -n1 | tr -d '\r\n'
)
echo "[$(date)] Detected video codec: '$VIDEO_CODEC'" >> "$LOG_FILE"
echo "[$(date)] Config codec: '$VIDEO_CODEC_CONFIG', Resolution: '$RESOLUTION_CONFIG', FPS: $VIDEO_FPS, Bitrate: $VIDEO_BITRATE" >> "$LOG_FILE"

# Build FFmpeg command
FFMPEG_CMD="ffmpeg -hide_banner -loglevel error -fflags +genpts -analyzeduration 10M -probesize 10M -rtsp_transport tcp -i \"$SOURCE_RTSP\""

# Smart codec selection: copy H.264, transcode H.265/others
if [ "$VIDEO_CODEC" = "h264" ]; then
    # Camera already H.264 — copy mode (zero CPU!)
    echo "[$(date)] H.264 detected, using COPY mode (no transcoding)" >> "$LOG_FILE"
    FFMPEG_CMD="$FFMPEG_CMD -c:v copy"

    # Audio: copy if available
    if [ "$AUDIO_ENABLED_CONFIG" = "true" ]; then
        FFMPEG_CMD="$FFMPEG_CMD -c:a copy"
    fi
else
    # H.265/HEVC or unknown — transcode to H.264
    echo "[$(date)] Non-H.264 detected ($VIDEO_CODEC), transcoding to H.264" >> "$LOG_FILE"
    FFMPEG_CMD="$FFMPEG_CMD -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -level 4.0 -pix_fmt yuv420p"

    # Video settings (only when transcoding)
    FFMPEG_CMD="$FFMPEG_CMD -s \"$RESOLUTION\" -b:v \"$VIDEO_BITRATE\" -maxrate \"$MAX_VIDEO_BITRATE\" -bufsize \"$VIDEO_BUF_SIZE\""
    FFMPEG_CMD="$FFMPEG_CMD -r \"$VIDEO_FPS\" -g \"$GOP_SIZE\" -threads \"$ENC_THREADS\""

    # Audio settings
    if [ "$AUDIO_ENABLED_CONFIG" = "true" ]; then
        FFMPEG_CMD="$FFMPEG_CMD -c:a aac -ac 1 -ar 44100 -b:a \"$AUDIO_BITRATE_CONFIG\""
    fi
fi

# Output
FFMPEG_CMD="$FFMPEG_CMD -f rtsp -rtsp_transport tcp \"$TARGET_RTSP\""

echo "[$(date)] Processing $MTX_PATH — detected: $VIDEO_CODEC, config: $VIDEO_CODEC_CONFIG, resolution: $RESOLUTION, fps: $VIDEO_FPS, bitrate: $VIDEO_BITRATE..." >> "$LOG_FILE"
eval $FFMPEG_CMD >> "$LOG_FILE" 2>&1
