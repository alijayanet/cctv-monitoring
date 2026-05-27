#!/bin/bash
# smart_transcode.sh
# Dipanggil oleh MediaMTX via runOnReady saat stream _input masuk.
# Otomatis deteksi codec: H.264 -> copy (hemat CPU), H.265/lain -> transcode ke H.264.

# Resolve SCRIPT_DIR secara absolut agar benar meski dipanggil dari working dir berbeda
SCRIPT_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
LOG_FILE="$SCRIPT_DIR/smart_transcode.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] --- Processing: $MTX_PATH ---" >> "$LOG_FILE"

# Hanya proses stream yang berakhiran _input
if [[ "$MTX_PATH" != *"_input"* ]]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Skipping non-input path: $MTX_PATH" >> "$LOG_FILE"
    exit 0
fi

CONFIG_FILE="$SCRIPT_DIR/config.json"

# Helper: baca nilai dari config.json (pakai jq jika ada, fallback ke grep)
get_config_value() {
    local key="$1"
    local default="$2"
    local value=""

    if [ -f "$CONFIG_FILE" ]; then
        if command -v jq &> /dev/null; then
            value=$(jq -r ".. | objects | .\"$key\"? | select(type == \"string\" or type == \"number\") | tostring" "$CONFIG_FILE" 2>/dev/null | head -n1)
        fi

        # Fallback grep jika jq tidak ada atau hasilnya kosong
        if [ -z "$value" ] || [ "$value" = "null" ]; then
            value=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$CONFIG_FILE" | cut -d'"' -f4 | head -n1)
        fi
        if [ -z "$value" ] || [ "$value" = "null" ]; then
            value=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*[0-9][^,}]*" "$CONFIG_FILE" | cut -d':' -f2 | tr -d ' "' | head -n1)
        fi
    fi

    if [ -n "$value" ] && [ "$value" != "null" ]; then
        echo "$value"
    else
        echo "$default"
    fi
}

# Baca konfigurasi
RTSP_PORT=$(get_config_value "rtsp_port" "8555")
[ -z "$RTSP_PORT" ] && RTSP_PORT="8555"

VIDEO_CODEC_CONFIG=$(get_config_value "video_codec" "h264")
RESOLUTION_CONFIG=$(get_config_value "resolution" "1080p")
VIDEO_BITRATE_CONFIG=$(get_config_value "bitrate" "1200k")
MAX_VIDEO_BITRATE_CONFIG=$(get_config_value "max_bitrate" "1500k")
VIDEO_FPS_CONFIG=$(get_config_value "frame_rate" "10")
AUDIO_ENABLED_CONFIG=$(get_config_value "audio_enabled" "true")
AUDIO_BITRATE_CONFIG=$(get_config_value "audio_bitrate" "64k")

# Map resolusi ke format FFmpeg
case "$RESOLUTION_CONFIG" in
    "1080p") RESOLUTION="1920:1080" ;;
    "720p")  RESOLUTION="1280:720"  ;;
    "480p")  RESOLUTION="854:480"   ;;
    "D1")    RESOLUTION="720:480"   ;;
    *)       RESOLUTION="1920:1080" ;;
esac

SOURCE_RTSP="rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH"
TARGET_NAME="${MTX_PATH/_input/}"
TARGET_RTSP="rtsp://127.0.0.1:$RTSP_PORT/$TARGET_NAME"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Source: $SOURCE_RTSP -> Target: $TARGET_RTSP" >> "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Config: codec=$VIDEO_CODEC_CONFIG res=$RESOLUTION_CONFIG fps=$VIDEO_FPS_CONFIG bitrate=$VIDEO_BITRATE_CONFIG audio=$AUDIO_ENABLED_CONFIG" >> "$LOG_FILE"

# Tunggu stream siap
sleep 2

# Deteksi codec sumber
VIDEO_CODEC=$(
    ffprobe -v error \
        -rtsp_transport tcp \
        -select_streams v:0 \
        -show_entries stream=codec_name \
        -of default=noprint_wrappers=1:nokey=1 \
        "$SOURCE_RTSP" 2>/dev/null | head -n1 | tr -d '\r\n'
)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Detected source codec: '$VIDEO_CODEC'" >> "$LOG_FILE"

# Bangun perintah FFmpeg
FFMPEG_ARGS=(
    -hide_banner -loglevel error
    -fflags +genpts
    -analyzeduration 10M -probesize 10M
    -flags +discardcorrupt
    -fps_mode passthrough
    -rtsp_transport tcp
    -i "$SOURCE_RTSP"
)

if [ "$VIDEO_CODEC" = "h264" ] && [ "$VIDEO_CODEC_CONFIG" != "libx264" ]; then
    # H.264 -> copy langsung (hemat CPU)
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] H.264 detected -> COPY mode (zero transcode)" >> "$LOG_FILE"
    FFMPEG_ARGS+=(-c:v copy)
    if [ "$AUDIO_ENABLED_CONFIG" = "true" ]; then
        FFMPEG_ARGS+=(-c:a copy)
    else
        FFMPEG_ARGS+=(-an)
    fi
else
    # H.265 / HEVC / unknown -> transcode ke H.264
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Non-H.264 ($VIDEO_CODEC) -> transcoding to H.264" >> "$LOG_FILE"
    FFMPEG_ARGS+=(
        -c:v libx264
        -preset superfast
        -tune zerolatency
        -profile:v main
        -pix_fmt yuv420p
        -s "$RESOLUTION"
        -b:v "$VIDEO_BITRATE_CONFIG"
        -maxrate "$MAX_VIDEO_BITRATE_CONFIG"
        -bufsize 3000k
        -r "$VIDEO_FPS_CONFIG"
        -g $(($VIDEO_FPS_CONFIG * 2))
    )
    if [ "$AUDIO_ENABLED_CONFIG" = "true" ]; then
        FFMPEG_ARGS+=(-c:a aac -ac 1 -ar 44100 -b:a "$AUDIO_BITRATE_CONFIG")
    else
        FFMPEG_ARGS+=(-an)
    fi
fi

# Output ke MediaMTX via RTSP
FFMPEG_ARGS+=(-f rtsp -rtsp_transport tcp "$TARGET_RTSP")

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting FFmpeg..." >> "$LOG_FILE"
ffmpeg "${FFMPEG_ARGS[@]}" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S')] FFmpeg exited with code $EXIT_CODE for $MTX_PATH" >> "$LOG_FILE"
