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
sudo apt-get install -y curl wget git ffmpeg build-essential sqlite3 ufw

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

# --- 5. Create Supporting Scripts (Clean Bash Format) ---
echo "Generating supporting scripts..."
FULL_PATH=$(pwd)

cat << 'EOF' > smart_transcode.sh
#!/bin/bash

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOG_FILE="$SCRIPT_DIR/smart_transcode.log"
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
FFMPEG_CMD="ffmpeg -hide_banner -loglevel error -fflags +genpts -analyzeduration 10M -probesize 10M -flags +discardcorrupt -fps_mode passthrough -rtsp_transport tcp -i \"$SOURCE_RTSP\""

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
EOF

cat << 'EOF' > record_notify.sh
#!/bin/bash
# Logic to notify web-app about new recording
curl -X POST -H "Content-Type: application/json" -d "{\"path\":\"$MTX_PATH\", \"file\":\"$MTX_SEGMENT_PATH\"}" http://localhost:3003/api/recordings/notify
EOF

chmod +x smart_transcode.sh record_notify.sh

# --- 6. Patching Configuration ---
echo "Patching mediamtx.yml..."
cp mediamtx.yml mediamtx.yml.bak
sed -i 's/rtspAddress: :8554/rtspAddress: :8555/g' mediamtx.yml
sed -i 's/hlsAddress: :8888/hlsAddress: :8856/g' mediamtx.yml
sed -i 's/rtpAddress: :8000/rtpAddress: :8050/g' mediamtx.yml
sed -i 's/rtcpAddress: :8001/rtcpAddress: :8051/g' mediamtx.yml
sed -i 's/rtmpAddress: :1935/rtmpAddress: :1936/g' mediamtx.yml
sed -i 's/webrtcAddress: :8889/webrtcAddress: :8890/g' mediamtx.yml
sed -i 's/webrtcICEUDPMuxAddress: :8189/webrtcICEUDPMuxAddress: ""/g' mediamtx.yml
sed -i 's/apiAddress: :[0-9]\+/apiAddress: :9123/g' mediamtx.yml
sed -i 's/apiAddress: :[0-9]\+/apiAddress: :9123/g' mediamtx.yml
sed -i 's/^api: .*/api: yes/g' mediamtx.yml
# Set HLS to fMP4 for H265 support
sed -i 's/hlsVariant: .*/hlsVariant: fmp4/g' mediamtx.yml
sed -i 's/^[[:space:]]*#\?[[:space:]]*record: .*/record: yes/g' mediamtx.yml
sed -i 's|^[[:space:]]*#\?[[:space:]]*recordPath: .*|recordPath: ./recordings/%path/%Y-%m-%d_%H-%M-%S.mp4|g' mediamtx.yml
sed -i 's/^[[:space:]]*#\?[[:space:]]*recordFormat: .*/recordFormat: fmp4/g' mediamtx.yml
sed -i 's/^[[:space:]]*#\?[[:space:]]*recordSegmentDuration: .*/recordSegmentDuration: 60m/g' mediamtx.yml
# Set recording retention to 30 days (720h)
sed -i 's/^[[:space:]]*#\?[[:space:]]*recordDeleteAfter: .*/recordDeleteAfter: 720h/g' mediamtx.yml
# Linux: use .sh for record notify (Node app will also set runOnReady via API on startup)
sed -i 's/record_notify\.bat/record_notify.sh/g' mediamtx.yml

# --- 7. Setup Services ---
CURRENT_USER=$(whoami)
sudo bash -c "cat > /etc/systemd/system/mediamtx.service <<EOF
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
EOF"

sudo bash -c "cat > /etc/systemd/system/cctv-web.service <<EOF
[Unit]
Description=CCTV Web Monitoring System
After=network.target mediamtx.service

[Service]
ExecStart=$(which node || echo /usr/bin/node) $FULL_PATH/index.js
WorkingDirectory=$FULL_PATH
User=$CURRENT_USER
Environment=NODE_ENV=production
Environment=TZ=Asia/Jakarta
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF"

# --- 8. Finalize ---
echo "Creating recordings directory..."
mkdir -p recordings
sudo chown -R "$CURRENT_USER":"$CURRENT_USER" recordings || true
chmod 775 recordings

echo "Configuring sudoers for service restart..."
SYSTEMCTL_BIN=$(command -v systemctl || echo /bin/systemctl)
sudo bash -c "cat > /etc/sudoers.d/cctv-monitoring <<EOF
$CURRENT_USER ALL=NOPASSWD: $SYSTEMCTL_BIN restart mediamtx, $SYSTEMCTL_BIN restart cctv-web, $SYSTEMCTL_BIN restart mediamtx cctv-web
EOF"
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
sudo ufw allow 8555/tcp || true
sudo ufw allow 8856/tcp || true
sudo ufw allow 9123/tcp || true

echo "Setting up systemd services..."
sudo systemctl daemon-reload
sudo systemctl enable mediamtx cctv-web
sudo systemctl restart mediamtx cctv-web

# Wait for services to start
sleep 3

echo "=== INSTALLATION COMPLETE ==="
IP_ADDR=$(hostname -I | awk '{print $1}')
echo ""
echo "🎉 CCTV Monitoring System is ready!"
echo ""
echo "📺 Dashboard: http://$IP_ADDR:3003"
echo "🔐 Default Login: admin / admin123"
echo ""
echo "📊 Services Status:"
systemctl is-active --quiet cctv-web && echo "   ✅ Web App: Running" || echo "   ❌ Web App: Failed (check: journalctl -u cctv-web -n 50)"
systemctl is-active --quiet mediamtx && echo "   ✅ MediaMTX: Running" || echo "   ❌ MediaMTX: Failed"
echo ""
echo "🔧 Configuration:"
echo "   - HLS Port: 8856 (fMP4 with H265 support)"
echo "   - RTSP Port: 8555"
echo ""
echo "🧪 Quick Check Commands:"
echo "   - systemctl status cctv-web --no-pager"
echo "   - systemctl status mediamtx --no-pager"
echo "   - journalctl -u cctv-web -n 50 --no-pager"
echo "   - journalctl -u mediamtx -n 50 --no-pager"
echo "   - curl -I http://127.0.0.1:8856/healthz || true"
echo "   - Recording: 30 days retention"
echo ""
