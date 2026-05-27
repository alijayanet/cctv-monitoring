#!/bin/bash

# CCTV Monitoring System - Auto Installer
# Optimized for Ubuntu/Debian and Orange Pi/Raspberry Pi (Armbian)

echo "=== INITIALIZING INSTALLATION ==="
set -e # Stop on error

# --- 1. Fix Broken Repositories ---
echo "Checking for broken repositories..."
if [ -f /etc/apt/sources.list.d/armbian.list ] || [ -f /etc/apt/sources.list ]; then
    sudo sed -i 's/.*bullseye-backports.*/# &/' /etc/apt/sources.list 2>/dev/null || true
    sudo sed -i 's/.*bullseye-backports.*/# &/' /etc/apt/sources.list.d/*.list 2>/dev/null || true
fi

# --- 2. Install Dependencies ---
echo "Updating system and installing dependencies..."
sudo apt-get update -y || echo "Warning: apt update had some errors, continuing..."
sudo apt-get install -y curl wget git ffmpeg build-essential sqlite3 ufw jq

# --- 3. Install Node.js LTS (v20) ---
if ! command -v node &> /dev/null; then
    echo "Installing Node.js LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# --- 4. Install MediaMTX ---
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
    MEDIAMTX_ARCH="linux_amd64"
elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    MEDIAMTX_ARCH="linux_arm64"
else
    MEDIAMTX_ARCH="linux_armv7"
fi

VERSION="v1.16.1"
if [ ! -f "mediamtx" ]; then
    echo "Downloading MediaMTX $VERSION for $ARCH..."
    DOWNLOAD_URL="https://github.com/bluenviron/mediamtx/releases/download/${VERSION}/mediamtx_${VERSION}_${MEDIAMTX_ARCH}.tar.gz"
    wget -O mediamtx.tar.gz "$DOWNLOAD_URL"
    tar -xvzf mediamtx.tar.gz mediamtx mediamtx.yml
    rm mediamtx.tar.gz
    chmod +x mediamtx
fi

# --- 5. Create Supporting Scripts ---
echo "Generating supporting scripts..."
FULL_PATH=$(pwd)

# smart_transcode.sh — dipanggil MediaMTX via runOnReady
# Menggunakan 'TRANSCODE_EOF' agar variabel di dalam tidak di-expand saat generate
cat << 'TRANSCODE_EOF' > smart_transcode.sh
#!/bin/bash
# smart_transcode.sh - dipanggil MediaMTX via runOnReady saat stream _input masuk
# H.264 -> copy (hemat CPU), H.265/lain -> transcode ke H.264

SCRIPT_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
LOG_FILE="$SCRIPT_DIR/smart_transcode.log"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] --- Processing: $MTX_PATH ---" >> "$LOG_FILE"

# Hanya proses stream yang berakhiran _input
if [[ "$MTX_PATH" != *"_input"* ]]; then
    exit 0
fi

CONFIG_FILE="$SCRIPT_DIR/config.json"

get_config_value() {
    local key="$1"
    local default="$2"
    local value=""
    if [ -f "$CONFIG_FILE" ]; then
        if command -v jq &> /dev/null; then
            value=$(jq -r ".. | objects | .\"$key\"? | select(type == \"string\" or type == \"number\") | tostring" "$CONFIG_FILE" 2>/dev/null | head -n1)
        fi
        if [ -z "$value" ] || [ "$value" = "null" ]; then
            value=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$CONFIG_FILE" | cut -d'"' -f4 | head -n1)
        fi
        if [ -z "$value" ] || [ "$value" = "null" ]; then
            value=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*[0-9][^,}]*" "$CONFIG_FILE" | cut -d':' -f2 | tr -d ' "' | head -n1)
        fi
    fi
    [ -n "$value" ] && [ "$value" != "null" ] && echo "$value" || echo "$default"
}

RTSP_PORT=$(get_config_value "rtsp_port" "8555")
[ -z "$RTSP_PORT" ] && RTSP_PORT="8555"

VIDEO_CODEC_CONFIG=$(get_config_value "video_codec" "h264")
RESOLUTION_CONFIG=$(get_config_value "resolution" "1080p")
VIDEO_BITRATE_CONFIG=$(get_config_value "bitrate" "1200k")
MAX_VIDEO_BITRATE_CONFIG=$(get_config_value "max_bitrate" "1500k")
VIDEO_FPS_CONFIG=$(get_config_value "frame_rate" "10")
AUDIO_ENABLED_CONFIG=$(get_config_value "audio_enabled" "true")
AUDIO_BITRATE_CONFIG=$(get_config_value "audio_bitrate" "64k")

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

sleep 2

VIDEO_CODEC=$(
    ffprobe -v error -rtsp_transport tcp -select_streams v:0 \
        -show_entries stream=codec_name \
        -of default=noprint_wrappers=1:nokey=1 \
        "$SOURCE_RTSP" 2>/dev/null | head -n1 | tr -d '\r\n'
)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Detected codec: '$VIDEO_CODEC' | config: $VIDEO_CODEC_CONFIG res=$RESOLUTION fps=$VIDEO_FPS_CONFIG bitrate=$VIDEO_BITRATE_CONFIG" >> "$LOG_FILE"

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
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] H.264 -> COPY mode (zero transcode)" >> "$LOG_FILE"
    FFMPEG_ARGS+=(-c:v copy)
    [ "$AUDIO_ENABLED_CONFIG" = "true" ] && FFMPEG_ARGS+=(-c:a copy) || FFMPEG_ARGS+=(-an)
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Non-H.264 ($VIDEO_CODEC) -> transcoding to H.264" >> "$LOG_FILE"
    FFMPEG_ARGS+=(
        -c:v libx264 -preset superfast -tune zerolatency
        -profile:v main -pix_fmt yuv420p
        -s "$RESOLUTION"
        -b:v "$VIDEO_BITRATE_CONFIG" -maxrate "$MAX_VIDEO_BITRATE_CONFIG" -bufsize 3000k
        -r "$VIDEO_FPS_CONFIG" -g $(($VIDEO_FPS_CONFIG * 2))
    )
    [ "$AUDIO_ENABLED_CONFIG" = "true" ] && FFMPEG_ARGS+=(-c:a aac -ac 1 -ar 44100 -b:a "$AUDIO_BITRATE_CONFIG") || FFMPEG_ARGS+=(-an)
fi

FFMPEG_ARGS+=(-f rtsp -rtsp_transport tcp "$TARGET_RTSP")

ffmpeg "${FFMPEG_ARGS[@]}" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S')] FFmpeg exited with code $EXIT_CODE for $MTX_PATH" >> "$LOG_FILE"
TRANSCODE_EOF

# record_notify.sh — notifikasi ke web-app saat segment rekaman selesai
cat << 'NOTIFY_EOF' > record_notify.sh
#!/bin/bash
# Notifikasi ke web-app saat segment rekaman selesai

SCRIPT_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
CONFIG_FILE="$SCRIPT_DIR/config.json"

APP_PORT="3003"
if [ -f "$CONFIG_FILE" ]; then
    if command -v jq &> /dev/null; then
        PORT_VAL=$(jq -r '.server.port // empty' "$CONFIG_FILE" 2>/dev/null)
    else
        PORT_VAL=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG_FILE" | grep -v '"api_port"' | head -n1 | grep -o '[0-9]*$')
    fi
    if [ -n "$PORT_VAL" ] && [ "$PORT_VAL" -gt 0 ] 2>/dev/null; then
        APP_PORT="$PORT_VAL"
    fi
fi

curl -s -X POST \
    -H "Content-Type: application/json" \
    -d "{\"path\":\"$MTX_PATH\", \"file\":\"$MTX_SEGMENT_PATH\"}" \
    "http://127.0.0.1:$APP_PORT/api/recordings/notify" \
    --max-time 5 || true
NOTIFY_EOF

chmod +x smart_transcode.sh record_notify.sh

# --- 6. Patching Configuration ---
echo "Patching mediamtx.yml..."
cp mediamtx.yml mediamtx.yml.bak

# Gunakan path absolut agar MediaMTX bisa menemukan script dari mana saja
cat > mediamtx.yml << EOF
###############################################
# Global settings

# RTSP
rtspAddress: :8555
rtpAddress: :8050
rtcpAddress: :8051

# RTMP
rtmpAddress: :1936

# HLS
hlsAddress: :8856
hlsVariant: fmp4

# WebRTC
webrtcAddress: :8890
webrtcLocalUDPAddress: :8190

# SRT
srtAddress: :8891

# API
api: yes
apiAddress: :9123

###############################################
# Default path settings

pathDefaults:
  record: yes
  recordPath: $FULL_PATH/recordings/%path/%Y-%m-%d_%H-%M-%S.mp4
  recordFormat: fmp4
  recordSegmentDuration: 60m
  recordDeleteAfter: 720h

  runOnReady: $FULL_PATH/smart_transcode.sh
  runOnReadyRestart: yes

  runOnRecordSegmentComplete: $FULL_PATH/record_notify.sh

paths:
  all_others:
    source: publisher
EOF

# --- 7. Setup Services ---
CURRENT_USER=$(whoami)
NODE_BIN=$(which node || echo /usr/bin/node)

sudo bash -c "cat > /etc/systemd/system/mediamtx.service << SVCEOF
[Unit]
Description=MediaMTX Streaming Server
After=network.target

[Service]
ExecStart=$FULL_PATH/mediamtx $FULL_PATH/mediamtx.yml
WorkingDirectory=$FULL_PATH
User=$CURRENT_USER
Environment=TZ=Asia/Jakarta
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF"

sudo bash -c "cat > /etc/systemd/system/cctv-web.service << SVCEOF
[Unit]
Description=CCTV Web Monitoring System
After=network.target mediamtx.service

[Service]
ExecStart=$NODE_BIN $FULL_PATH/index.js
WorkingDirectory=$FULL_PATH
User=$CURRENT_USER
Environment=NODE_ENV=production
Environment=TZ=Asia/Jakarta
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF"

# --- 8. Finalize ---
echo "Creating necessary directories..."
mkdir -p recordings stream_logs
sudo chown -R "$CURRENT_USER":"$CURRENT_USER" recordings stream_logs || true
chmod 775 recordings stream_logs

echo "Configuring sudoers for service restart..."
SYSTEMCTL_BIN=$(command -v systemctl || echo /bin/systemctl)
sudo bash -c "cat > /etc/sudoers.d/cctv-monitoring << SUDOEOF
$CURRENT_USER ALL=NOPASSWD: $SYSTEMCTL_BIN restart mediamtx, $SYSTEMCTL_BIN restart cctv-web, $SYSTEMCTL_BIN restart mediamtx cctv-web
SUDOEOF"
sudo chmod 440 /etc/sudoers.d/cctv-monitoring
if sudo visudo -cf /etc/sudoers.d/cctv-monitoring; then
    echo "Sudoers OK."
else
    echo "Invalid sudoers file. Removing /etc/sudoers.d/cctv-monitoring"
    sudo rm -f /etc/sudoers.d/cctv-monitoring
fi

npm install --omit=dev --no-audit --no-fund

echo "Configuring firewall..."
sudo ufw allow 3003/tcp || true

echo "Setting up systemd services..."
sudo systemctl daemon-reload
sudo systemctl enable mediamtx cctv-web
sudo systemctl restart mediamtx cctv-web

# Wait for services to start
sleep 3

if ! systemctl is-active --quiet mediamtx; then
    echo ""
    echo "MediaMTX gagal start. Ambil log terakhir:"
    journalctl -u mediamtx -n 120 --no-pager || true
    echo ""
    echo "Cek port yang sedang dipakai (jika ada bentrok):"
    ss -lntup 2>/dev/null | grep -E ':(8555|8856|9123|8890|8050|8051|8190)\b' || true
    echo ""
    if command -v timeout >/dev/null 2>&1; then
        echo "Coba jalankan mediamtx sebentar untuk lihat error parsing:"
        timeout 3s "$FULL_PATH/mediamtx" "$FULL_PATH/mediamtx.yml" || true
        echo ""
    fi
fi

echo "=== INSTALLATION COMPLETE ==="
IP_ADDR=$(hostname -I | awk '{print $1}')
echo ""
echo "CCTV Monitoring System is ready!"
echo ""
echo "Dashboard  : http://$IP_ADDR:3003"
echo "Login      : admin / admin123"
echo ""
echo "Services Status:"
systemctl is-active --quiet cctv-web   && echo "  [OK] Web App  : Running" || echo "  [!!] Web App  : Failed  -> journalctl -u cctv-web -n 50"
systemctl is-active --quiet mediamtx   && echo "  [OK] MediaMTX : Running" || echo "  [!!] MediaMTX : Failed  -> journalctl -u mediamtx -n 50"
echo ""
echo "Quick Check Commands:"
echo "  systemctl status cctv-web --no-pager"
echo "  systemctl status mediamtx --no-pager"
echo "  journalctl -u cctv-web -f"
echo "  journalctl -u mediamtx -f"
echo "  tail -f $FULL_PATH/smart_transcode.log"
echo ""
echo "Ports:"
echo "  Web App  : 3003"
echo "  RTSP     : 8555"
echo "  HLS      : 8856"
echo "  API      : 9123"
echo ""
