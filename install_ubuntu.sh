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
sudo apt-get install -y curl wget git ffmpeg build-essential sqlite3 ufw jq openssl ntfs-3g exfat-fuse

# --- 3. Install Node.js LTS (v20) ---
# Check existing version; install/upgrade if missing or < v20
NEED_NODE=0
if ! command -v node &>/dev/null; then
    NEED_NODE=1
    echo "Node.js not found. Installing Node.js v20 LTS..."
else
    NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v//' | cut -d'.' -f1)
    if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
        NEED_NODE=1
        echo "Node.js $(node -v) ditemukan, versi kurang dari v20. Mengupgrade ke v20 LTS..."
    else
        echo "Node.js $(node -v) sudah memenuhi syarat (>= v20). Skip install."
    fi
fi

if [ "$NEED_NODE" = "1" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo "Node.js $(node -v) berhasil diinstall."
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
    echo "Downloading MediaMTX $VERSION for $ARCH ($MEDIAMTX_ARCH)..."
    DOWNLOAD_URL="https://github.com/bluenviron/mediamtx/releases/download/${VERSION}/mediamtx_${VERSION}_${MEDIAMTX_ARCH}.tar.gz"
    if ! wget -O mediamtx.tar.gz "$DOWNLOAD_URL"; then
        echo "❌ Download MediaMTX gagal. Cek koneksi internet dan versi: $VERSION"
        exit 1
    fi
    tar -xvzf mediamtx.tar.gz mediamtx mediamtx.yml
    rm mediamtx.tar.gz
    chmod +x mediamtx
    echo "MediaMTX $VERSION berhasil didownload."
else
    echo "MediaMTX sudah ada, skip download."
fi

# --- 5. Create Supporting Scripts ---
echo "Generating supporting scripts..."
FULL_PATH=$(pwd)

# Validasi path tidak ada spasi (bisa bikin masalah di systemd/script)
if echo "$FULL_PATH" | grep -q ' '; then
    echo "⚠️  WARNING: Path instalasi '$FULL_PATH' mengandung spasi."
    echo "   Ini bisa menyebabkan masalah pada systemd service dan script."
    echo "   Sangat disarankan install di path tanpa spasi, contoh: /opt/cctv-monitoring"
    echo ""
    read -r -p "Lanjutkan tetap di path ini? (y/N): " CONFIRM_PATH
    if [ "$CONFIRM_PATH" != "y" ] && [ "$CONFIRM_PATH" != "Y" ]; then
        echo "Instalasi dibatalkan. Pindahkan folder ke path tanpa spasi."
        exit 1
    fi
fi

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
        if command -v jq &>/dev/null; then
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

# Sanitasi FPS agar tidak error saat aritmatika
VIDEO_FPS_CLEAN=$(echo "$VIDEO_FPS_CONFIG" | tr -dc '0-9')
[ -z "$VIDEO_FPS_CLEAN" ] || [ "$VIDEO_FPS_CLEAN" -le 0 ] 2>/dev/null && VIDEO_FPS_CLEAN=10

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
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Detected codec: '$VIDEO_CODEC' | config: $VIDEO_CODEC_CONFIG res=$RESOLUTION fps=$VIDEO_FPS_CLEAN bitrate=$VIDEO_BITRATE_CONFIG" >> "$LOG_FILE"

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
        -r "$VIDEO_FPS_CLEAN" -g $(($VIDEO_FPS_CLEAN * 2))
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
    if command -v jq &>/dev/null; then
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

# --- 7. Auto-Generate Session Secret (jika masih default) ---
echo "Checking session secret..."
CURRENT_SECRET=$(jq -r '.server.session_secret // ""' config.json 2>/dev/null)
DEFAULT_SECRETS=("cctv-secret-key-change-me" "cctv-monitoring-secret-key" "")

NEED_NEW_SECRET=0
for ds in "${DEFAULT_SECRETS[@]}"; do
    if [ "$CURRENT_SECRET" = "$ds" ]; then
        NEED_NEW_SECRET=1
        break
    fi
done

if [ "$NEED_NEW_SECRET" = "1" ]; then
    echo "Session secret masih default. Men-generate secret baru yang kuat..."
    NEW_SECRET=$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 64)
    jq --arg s "$NEW_SECRET" '.server.session_secret = $s' config.json > config.json.tmp && mv config.json.tmp config.json
    echo "✅ Session secret baru berhasil di-generate."
else
    echo "Session secret sudah di-kustomisasi, skip generate."
fi

# --- 8. Reset public_base_url jika masih domain default developer ---
echo "Checking public_base_url..."
CURRENT_BASE_URL=$(jq -r '.server.public_base_url // ""' config.json 2>/dev/null)
if [ "$CURRENT_BASE_URL" = "https://cctv.alijaya.com" ]; then
    echo "⚠️  public_base_url masih domain default developer. Mereset ke kosong..."
    jq '.server.public_base_url = ""' config.json > config.json.tmp && mv config.json.tmp config.json
    echo "✅ public_base_url direset. Isi manual di config.json jika Anda punya domain sendiri."
fi

# --- 9. Setup Services ---
# Dapatkan user asli meskipun diinstall menggunakan sudo
CURRENT_USER=${SUDO_USER:-$(whoami)}
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

# --- 10. Finalize ---
echo "Creating necessary directories..."
mkdir -p recordings stream_logs
sudo chown -R "$CURRENT_USER":"$CURRENT_USER" recordings stream_logs || true
chmod 775 recordings stream_logs

# Buat direktori base untuk mount external storage
sudo mkdir -p /mnt/cctv-storage
sudo chown -R "$CURRENT_USER":"$CURRENT_USER" /mnt/cctv-storage || true
sudo chmod 775 /mnt/cctv-storage
echo "Mount base directory /mnt/cctv-storage siap."

echo "Configuring sudoers for service restart and storage mount..."
SYSTEMCTL_BIN=$(command -v systemctl || echo /bin/systemctl)
MOUNT_BIN=$(command -v mount || echo /bin/mount)
UMOUNT_BIN=$(command -v umount || echo /bin/umount)
MKDIR_BIN=$(command -v mkdir || echo /bin/mkdir)
CHOWN_BIN=$(command -v chown || echo /bin/chown)
CHMOD_BIN=$(command -v chmod || echo /bin/chmod)
SED_BIN=$(command -v sed || echo /bin/sed)
BASH_BIN=$(command -v bash || echo /bin/bash)
TEE_BIN=$(command -v tee || echo /usr/bin/tee)

sudo bash -c "cat > /etc/sudoers.d/cctv-monitoring << SUDOEOF
$CURRENT_USER ALL=NOPASSWD: $SYSTEMCTL_BIN restart mediamtx, $SYSTEMCTL_BIN restart cctv-web, $SYSTEMCTL_BIN restart mediamtx cctv-web
$CURRENT_USER ALL=NOPASSWD: $MOUNT_BIN
$CURRENT_USER ALL=NOPASSWD: $UMOUNT_BIN
$CURRENT_USER ALL=NOPASSWD: $MKDIR_BIN -p /mnt/cctv-storage/*
$CURRENT_USER ALL=NOPASSWD: $CHOWN_BIN -R * /mnt/cctv-storage/*
$CURRENT_USER ALL=NOPASSWD: $CHMOD_BIN 775 /mnt/cctv-storage/*
$CURRENT_USER ALL=NOPASSWD: $SED_BIN -i * /etc/fstab
$CURRENT_USER ALL=NOPASSWD: $BASH_BIN -c echo * >> /etc/fstab
$CURRENT_USER ALL=NOPASSWD: $TEE_BIN -a /etc/fstab
SUDOEOF"
sudo chmod 440 /etc/sudoers.d/cctv-monitoring
if sudo visudo -cf /etc/sudoers.d/cctv-monitoring; then
    echo "Sudoers OK."
else
    echo "Invalid sudoers file. Removing /etc/sudoers.d/cctv-monitoring"
    sudo rm -f /etc/sudoers.d/cctv-monitoring
fi

npm install --omit=dev --no-audit --no-fund

# --- 11. Firewall Rules ---
echo "Configuring firewall..."
sudo ufw allow 3003/tcp  || true   # Web Dashboard
sudo ufw allow 8555/tcp  || true   # RTSP  - kamera push stream ke server
sudo ufw allow 8856/tcp  || true   # HLS   - browser streaming video
sudo ufw allow 8050/udp  || true   # RTP   - media stream UDP
sudo ufw allow 8051/udp  || true   # RTCP  - kontrol RTP
# Uncomment berikut jika butuh akses RTMP atau WebRTC dari luar:
# sudo ufw allow 1936/tcp || true  # RTMP
# sudo ufw allow 8890/tcp || true  # WebRTC
# sudo ufw allow 9123/tcp || true  # MediaMTX API (hati-hati, expose API publik)

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

echo ""
echo "============================================="
echo "       ✅ INSTALASI SELESAI!"
echo "============================================="
IP_ADDR=$(hostname -I | awk '{print $1}')
echo ""
echo "  Dashboard  : http://$IP_ADDR:3003"
echo "  Login      : admin / admin123"
echo ""
echo "⚠️  PENTING — Langkah setelah install:"
echo "  1. Ganti password admin di: Admin > Konfigurasi"
echo "  2. Sesuaikan config.json jika punya domain sendiri"
echo "  3. Aktifkan UFW jika belum: sudo ufw enable"
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
echo "Ports yang sudah dibuka di UFW:"
echo "  Web App  : 3003/tcp"
echo "  RTSP     : 8555/tcp   <-- kamera push stream ke sini"
echo "  HLS      : 8856/tcp   <-- browser baca stream dari sini"
echo "  RTP/RTCP : 8050/udp, 8051/udp"
echo "  MediaMTX API : 9123   (internal only, tidak dibuka ke publik)"
echo ""
