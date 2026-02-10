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
fi

# --- 5. Create Supporting Scripts (Clean Bash Format) ---
echo "Generating supporting scripts..."
FULL_PATH=$(pwd)

cat << 'EOF' > smart_transcode.sh
#!/bin/bash
# CCTV Smart Transcoder for ARM/Ubuntu
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOG_FILE="$SCRIPT_DIR/smart_transcode.log"
if [[ "$MTX_PATH" != *"_input"* ]]; then exit 0; fi

SOURCE_RTSP="rtsp://127.0.0.1:8555/$MTX_PATH"
TARGET_NAME="${MTX_PATH/_input/}"
TARGET_RTSP="rtsp://127.0.0.1:8555/$TARGET_NAME"

sleep 3
VIDEO_CODEC=$(ffprobe -v error -rtsp_transport tcp -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 -timeout 3000000 "$SOURCE_RTSP")

echo "[$(date)] Task: $MTX_PATH | Codec: $VIDEO_CODEC" >> "$LOG_FILE"

if [ "$VIDEO_CODEC" == "h264" ]; then
    ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "$SOURCE_RTSP" -c copy -map 0:v:0 -an -f rtsp -rtsp_transport tcp "$TARGET_RTSP" >> "$LOG_FILE" 2>&1
else
    ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "$SOURCE_RTSP" -c:v libx264 -preset ultrafast -tune zerolatency -b:v 1000k -maxrate 1000k -bufsize 2000k -threads 2 -s 1280x720 -pix_fmt yuv420p -map 0:v:0 -an -f rtsp -rtsp_transport tcp "$TARGET_RTSP" >> "$LOG_FILE" 2>&1
fi
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
sed -i 's/apiAddress: :[0-9]\+/apiAddress: :9123/g' mediamtx.yml
sed -i 's/^api: .*/api: yes/g' mediamtx.yml
# Set HLS to fMP4 for H265 support
sed -i 's/hlsVariant: .*/hlsVariant: fmp4/g' mediamtx.yml
# Set recording retention to 7 days
sed -i 's/recordDeleteAfter: .*/recordDeleteAfter: 7d/g' mediamtx.yml
# Remove any default runOnReady to avoid loops (we disabled transcoding for better performance)
sed -i '/^[[:space:]]*runOnReady:/d' mediamtx.yml

# --- 7. Setup Services ---
CURRENT_USER=$(whoami)
sudo bash -c "cat > /etc/systemd/system/mediamtx.service <<EOF
[Unit]
Description=MediaMTX Streaming Server
After=network.target

[Service]
ExecStart=$FULL_PATH/mediamtx
WorkingDirectory=$FULL_PATH
User=$CURRENT_USER
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
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF"

# --- 8. Finalize ---
echo "Creating recordings directory..."
mkdir -p recordings
chmod 777 recordings

npm install --no-audit --no-fund

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
echo "   - Recording: 7 days retention"
echo ""

