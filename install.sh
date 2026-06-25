#!/usr/bin/env bash
# ============================================================================
#  CCTV Monitoring System - Professional Multi-Architecture Installer
#  Version 2.0.0
#  Author: POSKAMLING RW.04
#  License: MIT
#
#  Supports:
#    - Ubuntu 20.04+ / Debian 11+
#    - Armbian (Orange Pi, Rockchip, Allwinner)
#    - Raspberry Pi OS (armv7/armv6/arm64)
#    - x86_64 generic Linux
#
#  Services installed (auto-start via systemd):
#    - cctv-web     : Node.js web dashboard (port 3003)
#    - mediamtx     : RTSP/HLS streaming server
# ============================================================================

set -e
SCRIPT_VERSION="2.0.0"
START_TIME=$(date +%s)

# ──────────────────────────────────────────────────────────────
# ANSI Colors
# ──────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color
CHECK="${GREEN}✓${NC}"
CROSS="${RED}✗${NC}"
ARROW="${CYAN}➜${NC}"

# ──────────────────────────────────────────────────────────────
# Logging helpers
# ──────────────────────────────────────────────────────────────
INSTALL_LOG="/tmp/cctv-install-$(date +%Y%m%d-%H%M%S).log"
touch "$INSTALL_LOG"

log_info()  { echo -e "  ${ARROW} $1"; echo "[INFO]  $1" >> "$INSTALL_LOG"; }
log_ok()    { echo -e "  ${CHECK} ${GREEN}$1${NC}"; echo "[OK]    $1" >> "$INSTALL_LOG"; }
log_warn()  { echo -e "  ${YELLOW}⚠ $1${NC}"; echo "[WARN]  $1" >> "$INSTALL_LOG"; }
log_error() { echo -e "  ${CROSS} ${RED}$1${NC}"; echo "[ERROR] $1" >> "$INSTALL_LOG"; }
log_step()  { echo; echo -e " ${BOLD}${BLUE}[$1/${TOTAL_STEPS}]${NC} ${BOLD}$2${NC}"; echo "[STEP $1/$TOTAL_STEPS] $2" >> "$INSTALL_LOG"; }
log_separator() { echo -e "  ${MAGENTA}─────────────────────────────────────────────${NC}"; }

# ──────────────────────────────────────────────────────────────
# Banner
# ──────────────────────────────────────────────────────────────
banner() {
    echo
    echo -e "  ${BOLD}${CYAN}╔════════════════════════════════════════════════════╗${NC}"
    echo -e "  ${BOLD}${CYAN}║       CCTV MONITORING SYSTEM INSTALLER            ║${NC}"
    echo -e "  ${BOLD}${CYAN}║                ALIJAYA-NET                        ║${NC}"
    echo -e "  ${BOLD}${CYAN}║               Version ${SCRIPT_VERSION}                   ║${NC}"
    echo -e "  ${BOLD}${CYAN}╚════════════════════════════════════════════════════╝${NC}"
    echo
    echo -e "  ${BOLD}Repository:${NC} https://github.com/alijayanet/cctv-monitoring"
    echo -e "  ${BOLD}Dashboard:${NC}  http://<server-ip>:3003"
    echo -e "  ${BOLD}Log file:${NC}   $INSTALL_LOG"
    echo
}

# ──────────────────────────────────────────────────────────────
# Architecture Detection
# ──────────────────────────────────────────────────────────────
detect_architecture() {
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64|amd64)
            ARCH_LABEL="x86_64"
            MEDIAMTX_ARCH="linux_amd64"
            ARCH_FULL="x86_64 (Intel/AMD 64-bit)"
            ;;
        aarch64|arm64)
            ARCH_LABEL="arm64"
            MEDIAMTX_ARCH="linux_arm64"
            ARCH_FULL="ARM 64-bit (aarch64)"
            ;;
        armv7l|armv7)
            ARCH_LABEL="armv7"
            MEDIAMTX_ARCH="linux_armv7"
            ARCH_FULL="ARM 32-bit (armv7l)"
            ;;
        armv6l|armv6)
            ARCH_LABEL="armv6"
            MEDIAMTX_ARCH="linux_armv6"
            ARCH_FULL="ARM 32-bit (armv6l)"
            ;;
        i686|i386)
            ARCH_LABEL="x86"
            MEDIAMTX_ARCH="linux_386"
            ARCH_FULL="Intel 32-bit (i386)"
            ;;
        *)
            ARCH_LABEL="unknown"
            MEDIAMTX_ARCH=""
            ARCH_FULL="Unknown architecture ($ARCH)"
            return 1
            ;;
    esac
    return 0
}

# ──────────────────────────────────────────────────────────────
# OS Detection
# ──────────────────────────────────────────────────────────────
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_NAME="$ID"
        OS_VERSION="$VERSION_ID"
        OS_PRETTY="$PRETTY_NAME"
    elif [ -f /etc/armbian-release ]; then
        . /etc/armbian-release
        OS_NAME="armbian"
        OS_VERSION="$VERSION"
        OS_PRETTY="Armbian $VERSION"
    elif command -v lsb_release &>/dev/null; then
        OS_NAME=$(lsb_release -si | tr '[:upper:]' '[:lower:]')
        OS_VERSION=$(lsb_release -sr)
        OS_PRETTY="$(lsb_release -sd)"
    else
        OS_NAME="linux"
        OS_VERSION="unknown"
        OS_PRETTY="Generic Linux"
    fi

    case "$OS_NAME" in
        ubuntu|debian|raspbian|armbian|pop|linuxmint|elementary)
            PKG_MANAGER="apt"
            PKG_INSTALL="apt-get install -y"
            PKG_UPDATE="apt-get update"
            ;;
        centos|rhel|fedora|rocky|almalinux)
            PKG_MANAGER="dnf"
            PKG_INSTALL="dnf install -y"
            PKG_UPDATE="dnf check-update || true"
            if command -v yum &>/dev/null && ! command -v dnf &>/dev/null; then
                PKG_MANAGER="yum"
                PKG_INSTALL="yum install -y"
                PKG_UPDATE="yum check-update || true"
            fi
            ;;
        arch|manjaro)
            PKG_MANAGER="pacman"
            PKG_INSTALL="pacman -S --noconfirm"
            PKG_UPDATE="pacman -Sy"
            ;;
        alpine)
            PKG_MANAGER="apk"
            PKG_INSTALL="apk add"
            PKG_UPDATE="apk update"
            ;;
        opensuse*|suse)
            PKG_MANAGER="zypper"
            PKG_INSTALL="zypper install -y"
            PKG_UPDATE="zypper refresh"
            ;;
        *)
            PKG_MANAGER="apt"
            PKG_INSTALL="apt-get install -y"
            PKG_UPDATE="apt-get update"
            log_warn "Unknown OS '$OS_NAME', falling back to apt"
            ;;
    esac
}

# ──────────────────────────────────────────────────────────────
# System Checks
# ──────────────────────────────────────────────────────────────
preflight_checks() {
    log_info "Running preflight checks..."

    # Must be root or have sudo
    if [ "$(id -u)" -eq 0 ]; then
        SUDO=""
        log_ok "Running as root"
    elif command -v sudo &>/dev/null; then
        SUDO="sudo"
        log_ok "sudo available, will use sudo"
    else
        log_error "This script must be run as root or with sudo"
        echo "  Please run: sudo bash install.sh"
        exit 1
    fi

    # Check OS
    detect_os
    log_ok "Detected OS: $OS_PRETTY (package manager: $PKG_MANAGER)"

    # Check architecture
    if ! detect_architecture; then
        log_error "Unsupported architecture: $ARCH"
        echo "  Supported: x86_64, aarch64/arm64, armv7/armv7l, armv6l"
        exit 1
    fi
    log_ok "Detected architecture: $ARCH_FULL"

    # Check internet connectivity
    if command -v curl &>/dev/null; then
        if curl -s --max-time 5 https://github.com >/dev/null 2>&1; then
            log_ok "Internet connection: OK"
        else
            log_warn "Internet connection may be limited (cannot reach GitHub)"
        fi
    elif command -v wget &>/dev/null; then
        if wget -q --timeout=5 --spider https://github.com 2>/dev/null; then
            log_ok "Internet connection: OK"
        else
            log_warn "Internet connection may be limited (cannot reach GitHub)"
        fi
    fi

    # Check available disk space
    INSTALL_DIR=$(pwd)
    FREE_KB=$(df "$INSTALL_DIR" | tail -1 | awk '{print $4}')
    FREE_MB=$((FREE_KB / 1024))
    log_info "Available disk space: ${FREE_MB}MB in $INSTALL_DIR"
    if [ "$FREE_MB" -lt 500 ]; then
        log_warn "Low disk space (${FREE_MB}MB). At least 500MB recommended."
    fi

    # Check RAM
    if [ -f /proc/meminfo ]; then
        TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
        TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
        log_info "Total RAM: ${TOTAL_RAM_MB}MB"
        if [ "$TOTAL_RAM_MB" -lt 512 ]; then
            log_warn "Low RAM (${TOTAL_RAM_MB}MB). AI Engine may be slow or fail."
        fi
    fi

    # Check for systemd
    if command -v systemctl &>/dev/null; then
        log_ok "systemd detected"
    else
        log_warn "systemd not detected. Services will use alternatives."
    fi

    echo
}

# ──────────────────────────────────────────────────────────────
# Fix broken repositories (especially Armbian)
# ──────────────────────────────────────────────────────────────
fix_repositories() {
    log_info "Checking for broken repository sources..."

    # Armbian often has broken backports
    if [ -f /etc/apt/sources.list.d/armbian.list ] || [ "$OS_NAME" = "armbian" ]; then
        $SUDO sed -i 's/.*bullseye-backports.*/# &/' /etc/apt/sources.list 2>/dev/null || true
        $SUDO sed -i 's/.*bullseye-backports.*/# &/' /etc/apt/sources.list.d/*.list 2>/dev/null || true
        log_info "Disabled bullseye-backports if present (Armbian fix)"
    fi

    # Fix Debian/Ubuntu sources if needed
    if [ -f /etc/apt/sources.list ]; then
        # Remove duplicate entries
        $SUDO cp /etc/apt/sources.list /etc/apt/sources.list.bak 2>/dev/null || true
    fi

    # Update package lists
    log_info "Updating package lists..."
    if [ "$PKG_MANAGER" = "apt" ]; then
        $SUDO apt-get update -y 2>&1 | tail -3 >> "$INSTALL_LOG" || log_warn "apt update had errors (non-fatal)"
    elif [ "$PKG_MANAGER" = "dnf" ] || [ "$PKG_MANAGER" = "yum" ]; then
        $SUDO $PKG_UPDATE 2>&1 | tail -3 >> "$INSTALL_LOG" || true
    fi
    log_ok "Package lists updated"
}

# ──────────────────────────────────────────────────────────────
# Install System Dependencies
# ──────────────────────────────────────────────────────────────
install_system_deps() {
    log_info "Installing system dependencies..."

    local BASE_PKGS=""
    local EXTRA_PKGS=""

    case "$PKG_MANAGER" in
        apt)
            BASE_PKGS="curl wget git ffmpeg build-essential sqlite3 ufw ca-certificates gnupg"
            EXTRA_PKGS="python3 python3-venv python3-pip python3-full cmake"
            ;;
        dnf|yum)
            BASE_PKGS="curl wget git ffmpeg sqlite gcc-c++ make ufw ca-certificates"
            EXTRA_PKGS="python3 python3-pip cmake"
            if ! command -v ffmpeg &>/dev/null; then
                $SUDO $PKG_MANAGER install -y https://download1.rpmfusion.org/free/el/rpmfusion-free-release-7.noarch.rpm 2>/dev/null || true
                $SUDO $PKG_MANAGER install -y ffmpeg ffmpeg-devel 2>/dev/null || true
            fi
            ;;
        pacman)
            BASE_PKGS="curl wget git ffmpeg base-devel sqlite ufw ca-certificates"
            EXTRA_PKGS="python python-pip cmake"
            ;;
        apk)
            BASE_PKGS="curl wget git ffmpeg build-base sqlite ca-certificates"
            EXTRA_PKGS="python3 py3-pip cmake"
            ;;
        zypper)
            BASE_PKGS="curl wget git ffmpeg sqlite3 gcc gcc-c++ make ufw ca-certificates"
            EXTRA_PKGS="python3 python3-pip cmake"
            ;;
        *)
            BASE_PKGS="curl wget git ffmpeg build-essential sqlite3"
            EXTRA_PKGS="python3 python3-pip"
            ;;
    esac

    # Check and install ufw separately (may not exist on all distros)
    if ! command -v ufw &>/dev/null && [ "$PKG_MANAGER" = "apt" ]; then
        $SUDO apt-get install -y ufw 2>&1 | tail -1 >> "$INSTALL_LOG" || true
    fi

    # Install packages
    if [ "$PKG_MANAGER" = "apt" ]; then
        $SUDO apt-get install -y $BASE_PKGS $EXTRA_PKGS 2>&1 | tail -5 >> "$INSTALL_LOG" || {
            log_warn "Some packages failed to install (non-fatal)"
        }
    elif [ "$PKG_MANAGER" = "dnf" ] || [ "$PKG_MANAGER" = "yum" ]; then
        $SUDO $PKG_INSTALL $BASE_PKGS 2>&1 | tail -3 >> "$INSTALL_LOG" || true
        $SUDO $PKG_INSTALL $EXTRA_PKGS 2>&1 | tail -3 >> "$INSTALL_LOG" || true
    elif [ "$PKG_MANAGER" = "pacman" ]; then
        $SUDO $PKG_INSTALL $BASE_PKGS 2>&1 | tail -3 >> "$INSTALL_LOG" || true
        $SUDO $PKG_INSTALL $EXTRA_PKGS 2>&1 | tail -3 >> "$INSTALL_LOG" || true
    elif [ "$PKG_MANAGER" = "apk" ]; then
        $SUDO $PKG_INSTALL $BASE_PKGS 2>&1 | tail -3 >> "$INSTALL_LOG" || true
        $SUDO $PKG_INSTALL $EXTRA_PKGS 2>&1 | tail -3 >> "$INSTALL_LOG" || true
    else
        $SUDO $PKG_INSTALL $BASE_PKGS 2>&1 | tail -3 >> "$INSTALL_LOG" || true
        $SUDO $PKG_INSTALL $EXTRA_PKGS 2>&1 | tail -3 >> "$INSTALL_LOG" || true
    fi

    log_ok "System dependencies installed"
}

# ──────────────────────────────────────────────────────────────
# Install Node.js
# ──────────────────────────────────────────────────────────────
install_nodejs() {
    if command -v node &>/dev/null; then
        NODE_VER=$(node --version | sed 's/v//')
        NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
        if [ "$NODE_MAJOR" -ge 18 ]; then
            log_ok "Node.js v$NODE_VER already installed"
            return 0
        fi
        log_info "Node.js v$NODE_VER found, but v18+ required. Upgrading..."
    else
        log_info "Installing Node.js LTS v20..."
    fi

    case "$PKG_MANAGER" in
        apt)
            curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - 2>&1 | tail -3 >> "$INSTALL_LOG"
            $SUDO apt-get install -y nodejs 2>&1 | tail -3 >> "$INSTALL_LOG"
            ;;
        dnf|yum)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO -E bash - 2>&1 | tail -3 >> "$INSTALL_LOG"
            $SUDO $PKG_INSTALL nodejs 2>&1 | tail -3 >> "$INSTALL_LOG"
            ;;
        pacman)
            $SUDO pacman -S --noconfirm nodejs npm 2>&1 | tail -3 >> "$INSTALL_LOG"
            ;;
        apk)
            $SUDO apk add nodejs npm 2>&1 | tail -3 >> "$INSTALL_LOG"
            ;;
        *)
            # Generic: try NodeSource
            curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash - 2>&1 | tail -3 >> "$INSTALL_LOG" || {
                log_warn "NodeSource failed, trying package manager..."
                $SUDO $PKG_INSTALL nodejs npm 2>&1 | tail -3 >> "$INSTALL_LOG" || true
            }
            ;;
    esac

    if command -v node &>/dev/null; then
        NODE_VER=$(node --version)
        log_ok "Node.js $NODE_VER installed"
    else
        log_error "Node.js installation failed"
        exit 1
    fi
}

# ──────────────────────────────────────────────────────────────
# Install MediaMTX
# ──────────────────────────────────────────────────────────────
install_mediamtx() {
    if [ -f "mediamtx" ] && [ -x "mediamtx" ]; then
        log_ok "MediaMTX binary already exists"
        return 0
    fi

    local MEDIAMTX_VERSION="1.16.1"
    local MEDIAMTX_FILE="mediamtx_${MEDIAMTX_VERSION}_${MEDIAMTX_ARCH}.tar.gz"
    local MEDIAMTX_URL="https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/${MEDIAMTX_FILE}"

    log_info "Downloading MediaMTX v${MEDIAMTX_VERSION} for ${ARCH_LABEL}..."
    
    if command -v wget &>/dev/null; then
        wget -q --show-progress -O mediamtx.tar.gz "$MEDIAMTX_URL" 2>&1 || {
            log_error "Failed to download MediaMTX"
            log_info "Try downloading manually from: $MEDIAMTX_URL"
            exit 1
        }
    elif command -v curl &>/dev/null; then
        curl -L --progress-bar -o mediamtx.tar.gz "$MEDIAMTX_URL" 2>&1 || {
            log_error "Failed to download MediaMTX"
            log_info "Try downloading manually from: $MEDIAMTX_URL"
            exit 1
        }
    else
        log_error "Neither curl nor wget found"
        exit 1
    fi

    tar -xzf mediamtx.tar.gz mediamtx mediamtx.yml 2>/dev/null || {
        tar -xzf mediamtx.tar.gz 2>/dev/null || {
            log_error "Failed to extract MediaMTX archive"
            exit 1
        }
    }
    rm -f mediamtx.tar.gz
    chmod +x mediamtx

    if [ -f "mediamtx" ]; then
        log_ok "MediaMTX v${MEDIAMTX_VERSION} installed ($(du -h mediamtx | cut -f1))"
    else
        log_error "MediaMTX binary not found after extraction"
        exit 1
    fi
}

# ──────────────────────────────────────────────────────────────
# Configure MediaMTX
# ──────────────────────────────────────────────────────────────
configure_mediamtx() {
    log_info "Configuring MediaMTX..."

    # Backup existing config
    if [ -f "mediamtx.yml" ]; then
        cp mediamtx.yml mediamtx.yml.bak 2>/dev/null || true
        log_info "Backed up existing mediamtx.yml → mediamtx.yml.bak"
    fi

    cat > mediamtx.yml << 'MEDIAMTX_CFG'
# MediaMTX Configuration - CCTV Monitoring System
# Auto-generated by installer

# Logging
logLevel: info
logDestinations: [stdout, file]
logFile: ./mediamtx.log

# RTSP
rtspAddress: :8555
rtpAddress: :8050
rtcpAddress: :8051

# RTMP
rtmpAddress: :1936

# HLS
hlsAddress: :8856
hlsVariant: fmp4
hlsSegmentCount: 7
hlsSegmentDuration: 1s
hlsPartDuration: 200ms
hlsSegmentMaxSize: 50M

# WebRTC
webrtcAddress: :8890
webrtcLocalUDPAddress: :8190

# Recording
record: yes
recordPath: ./recordings/%path/%Y-%m-%d_%H-%M-%S.mp4
recordFormat: fmp4
recordSegmentDuration: 60m
recordDeleteAfter: 720h

# API
api: yes
apiAddress: :9123

# Path defaults
paths:
  all:
    source: publisher
MEDIAMTX_CFG

    log_ok "MediaMTX configured (RTSP:8555, HLS:8856, API:9123)"
}

# ──────────────────────────────────────────────────────────────
# Generate Helper Scripts
# ──────────────────────────────────────────────────────────────
generate_scripts() {
    log_info "Generating support scripts..."

    # smart_transcode.sh
    if [ ! -f "smart_transcode.sh" ]; then
        cat > smart_transcode.sh << 'TRANSCODE'
#!/bin/bash
# Smart transcoding script called by MediaMTX on publish
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOG_FILE="$SCRIPT_DIR/transcode.log"
echo "[$(date)] --- Processing: $MTX_PATH ---" >> "$LOG_FILE"

if [[ "$MTX_PATH" != *"_input"* ]]; then
    exit 0
fi

CONFIG_FILE="$SCRIPT_DIR/config.json"

get_config_value() {
    local key="$1"
    local default="$2"
    if [ -f "$CONFIG_FILE" ]; then
        local value=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$CONFIG_FILE" | cut -d'"' -f4)
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

RTSP_PORT=$(get_config_value "rtsp_port" "8555")
[ -z "$RTSP_PORT" ] && RTSP_PORT="8555"

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

case "$RESOLUTION_CONFIG" in
    "720p") RESOLUTION="1280:720" ;;
    "1080p") RESOLUTION="1920:1080" ;;
    "D1") RESOLUTION="720:480" ;;
    *) RESOLUTION="1280:720" ;;
esac

sleep 2

VIDEO_CODEC=$(ffprobe -v error -rtsp_transport tcp -select_streams v:0 \
    -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 \
    "$SOURCE_RTSP" 2>/dev/null | head -n1 | tr -d '\r\n')

echo "[$(date)] Detected codec: '$VIDEO_CODEC'" >> "$LOG_FILE"
echo "[$(date)] Config: $VIDEO_CODEC_CONFIG, Resolution: $RESOLUTION, FPS: $VIDEO_FPS_CONFIG" >> "$LOG_FILE"

FFMPEG_CMD="ffmpeg -hide_banner -loglevel error -fflags +genpts -analyzeduration 10M -probesize 10M -flags +discardcorrupt -fps_mode passthrough -rtsp_transport tcp -i \"$SOURCE_RTSP\""

if [ "$VIDEO_CODEC" = "h264" ]; then
    echo "[$(date)] H.264 detected → COPY mode" >> "$LOG_FILE"
    FFMPEG_CMD="$FFMPEG_CMD -c:v copy"
    if [ "$AUDIO_ENABLED_CONFIG" = "true" ]; then
        FFMPEG_CMD="$FFMPEG_CMD -c:a copy"
    fi
else
    echo "[$(date)] $VIDEO_CODEC detected → transcoding to H.264" >> "$LOG_FILE"
    FFMPEG_CMD="$FFMPEG_CMD -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -level 4.0 -pix_fmt yuv420p"
    FFMPEG_CMD="$FFMPEG_CMD -s \"$RESOLUTION\" -b:v \"$VIDEO_BITRATE_CONFIG\" -maxrate \"$MAX_VIDEO_BITRATE_CONFIG\" -bufsize \"1600k\""
    FFMPEG_CMD="$FFMPEG_CMD -r \"$VIDEO_FPS_CONFIG\" -g $((VIDEO_FPS_CONFIG * 2)) -threads 1"
    if [ "$AUDIO_ENABLED_CONFIG" = "true" ]; then
        FFMPEG_CMD="$FFMPEG_CMD -c:a aac -ac 1 -ar 44100 -b:a \"$AUDIO_BITRATE_CONFIG\""
    fi
fi

FFMPEG_CMD="$FFMPEG_CMD -f rtsp -rtsp_transport tcp \"$TARGET_RTSP\""

echo "[$(date)] Starting transcode: $SOURCE_RTSP → $TARGET_RTSP" >> "$LOG_FILE"
eval $FFMPEG_CMD >> "$LOG_FILE" 2>&1
TRANSCODE
        chmod +x smart_transcode.sh
        log_ok "smart_transcode.sh created"
    else
        log_ok "smart_transcode.sh already exists"
    fi

    # record_notify.sh
    if [ ! -f "record_notify.sh" ]; then
        cat > record_notify.sh << 'RECNOTIFY'
#!/bin/bash
# Notify web app about new recording
curl -X POST -H "Content-Type: application/json" \
  -d "{\"path\":\"$MTX_PATH\", \"file\":\"$MTX_SEGMENT_PATH\"}" \
  http://localhost:3003/api/recordings/notify 2>/dev/null || true
RECNOTIFY
        chmod +x record_notify.sh
        log_ok "record_notify.sh created"
    else
        log_ok "record_notify.sh already exists"
    fi

    # uninstall.sh (enhanced)
    if [ ! -f "uninstall.sh" ]; then
        cat > uninstall.sh << 'UNINSTALL'
#!/bin/bash
# CCTV Monitoring System - Uninstaller
echo "╔══════════════════════════════════════════╗"
echo "║  CCTV Monitoring System - Uninstall      ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Stop and disable services
for svc in cctv-web mediamtx; do
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        echo "Stopping $svc..."
        sudo systemctl stop "$svc"
    fi
    if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
        echo "Disabling $svc..."
        sudo systemctl disable "$svc"
    fi
    echo "  ✓ $svc stopped/disabled"
done

# Remove service files
echo ""
echo "Removing systemd service files..."
for svf in /etc/systemd/system/cctv-web.service /etc/systemd/system/mediamtx.service; do
    if [ -f "$svf" ]; then
        sudo rm -f "$svf"
        echo "  ✓ Removed $(basename $svf)"
    fi
done

# Remove sudoers config
if [ -f /etc/sudoers.d/cctv-monitoring ]; then
    sudo rm -f /etc/sudoers.d/cctv-monitoring
    echo "  ✓ Removed sudoers config"
fi

sudo systemctl daemon-reload

echo ""
echo "✅ Services removed successfully."
echo ""
echo "To completely remove all files, run:"
echo "  cd .. && sudo rm -rf $(pwd)"
echo ""
echo "To keep recordings, backup the 'recordings' directory first."
UNINSTALL
        chmod +x uninstall.sh
        log_ok "uninstall.sh created/updated"
    fi

    log_ok "All support scripts generated"
}

# ──────────────────────────────────────────────────────────────
# Install Node.js Dependencies
# ──────────────────────────────────────────────────────────────
install_npm_deps() {
    log_info "Installing Node.js dependencies (npm install)..."

    # Set npm to production mode
    export NODE_ENV=production

    if [ ! -f "package.json" ]; then
        log_error "package.json not found in current directory!"
        exit 1
    fi

    npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5 >> "$INSTALL_LOG"
    
    if [ -d "node_modules" ]; then
        local MOD_COUNT=$(ls node_modules | wc -l)
        log_ok "npm packages installed ($MOD_COUNT modules)"
    else
        log_error "npm install failed!"
        exit 1
    fi
}

# ──────────────────────────────────────────────────────────────
# Create systemd Services
# ──────────────────────────────────────────────────────────────
setup_systemd_services() {
    local FULL_PATH=$(pwd)
    local CURRENT_USER=$(whoami)
    local NODE_BIN=$(which node || echo /usr/bin/node)
    local SYSTEMCTL_BIN=$(command -v systemctl || echo /bin/systemctl)

    log_info "Creating systemd services..."

    # ── MediaMTX Service ──
    $SUDO bash -c "cat > /etc/systemd/system/mediamtx.service << 'EOF'
[Unit]
Description=MediaMTX Streaming Server
Documentation=https://github.com/bluenviron/mediamtx
After=network.target

[Service]
Type=simple
ExecStart=${FULL_PATH}/mediamtx ${FULL_PATH}/mediamtx.yml
WorkingDirectory=${FULL_PATH}
User=${CURRENT_USER}
Environment=TZ=Asia/Jakarta
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF"
    log_ok "mediamtx.service created"

    # ── CCTV Web Service ──
    $SUDO bash -c "cat > /etc/systemd/system/cctv-web.service << 'EOF'
[Unit]
Description=CCTV Web Monitoring System
Documentation=https://github.com/goondez/cctv-monitoring
After=network.target mediamtx.service
Wants=mediamtx.service

[Service]
Type=simple
ExecStart=${NODE_BIN} ${FULL_PATH}/index.js
WorkingDirectory=${FULL_PATH}
User=${CURRENT_USER}
Environment=NODE_ENV=production
Environment=TZ=Asia/Jakarta
Restart=always
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF"
    log_ok "cctv-web.service created"

    # ── Sudoers config for web UI service control ──
    $SUDO bash -c "cat > /etc/sudoers.d/cctv-monitoring << EOF
${CURRENT_USER} ALL=NOPASSWD: ${SYSTEMCTL_BIN} restart mediamtx, ${SYSTEMCTL_BIN} restart cctv-web
EOF"
    $SUDO chmod 440 /etc/sudoers.d/cctv-monitoring
    if $SUDO visudo -cf /etc/sudoers.d/cctv-monitoring 2>/dev/null; then
        log_ok "Sudoers configuration OK"
    else
        log_warn "Invalid sudoers config, removing..."
        $SUDO rm -f /etc/sudoers.d/cctv-monitoring
    fi

    # ── Reload and enable ──
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable mediamtx cctv-web

    log_ok "systemd services configured and enabled for auto-start"
}

# ──────────────────────────────────────────────────────────────
# Configure Firewall
# ──────────────────────────────────────────────────────────────
setup_firewall() {
    if ! command -v ufw &>/dev/null; then
        log_info "ufw not available, skipping firewall configuration"
        return 0
    fi

    log_info "Configuring firewall (ufw)..."

    # Check if ufw is active
    if $SUDO ufw status | grep -q "Status: active" 2>/dev/null; then
        # Add rules only if not already present
        for port in 3003 8555 8856 9123 1936 8890; do
            if ! $SUDO ufw status | grep -q "$port" 2>/dev/null; then
                $SUDO ufw allow "$port/tcp" 2>/dev/null || true
            fi
        done
        log_ok "Firewall rules added (ports: 3003,8555,8856,9123,1936,8890)"
    else
        log_info "ufw is not active, skipping"
    fi
}

# ──────────────────────────────────────────────────────────────
# Create Directories
# ──────────────────────────────────────────────────────────────
create_directories() {
    log_info "Creating required directories..."
    
    mkdir -p recordings stream_logs public/css public/js 2>/dev/null
    
    # Set permissions
    $SUDO chown -R "$(whoami):$(whoami)" recordings stream_logs 2>/dev/null || true
    chmod -R 775 recordings stream_logs 2>/dev/null || true
    
    log_ok "Directories created: recordings, stream_logs"
}

# ──────────────────────────────────────────────────────────────
# Configure Database (Migrate if needed)
# ──────────────────────────────────────────────────────────────
setup_database() {
    log_info "Setting up database..."

    # Run Node.js migrations if available
    if [ -f "migrations/migrate.js" ]; then
        log_info "Running database migrations..."
        node migrations/migrate.js 2>&1 | tail -3 >> "$INSTALL_LOG" || log_warn "Migrations had issues (non-fatal)"
    fi
    
    # Verify database created
    if [ -f "cameras.db" ]; then
        log_ok "Database file created: cameras.db"
    else
        log_warn "Database may be created on first app start"
    fi

    log_ok "Database setup complete"
}

# ──────────────────────────────────────────────────────────────
# Start Services
# ──────────────────────────────────────────────────────────────
start_services() {
    log_info "Starting services..."

    $SUDO systemctl daemon-reload 2>/dev/null || true

    # Start mediamtx first
    log_info "Starting MediaMTX..."
    $SUDO systemctl restart mediamtx 2>&1 | tail -2 >> "$INSTALL_LOG" || true
    sleep 2

    # Start cctv-web
    log_info "Starting CCTV Web..."
    $SUDO systemctl restart cctv-web 2>&1 | tail -2 >> "$INSTALL_LOG" || true
    sleep 2

    # Verify services
    log_separator
    echo -e "  ${BOLD}Service Status:${NC}"
    
    for svc in mediamtx cctv-web; do
        if systemctl list-units --type=service 2>/dev/null | grep -q "$svc"; then
            if $SUDO systemctl is-active --quiet "$svc" 2>/dev/null; then
                echo -e "    ${CHECK} ${GREEN}$svc: Running${NC}"
            else
                echo -e "    ${CROSS} ${RED}$svc: Failed${NC} (check: journalctl -u $svc -n 30)"
            fi
        fi
    done
    log_separator
}

# ──────────────────────────────────────────────────────────────
# Show Summary
# ──────────────────────────────────────────────────────────────
show_summary() {
    local IP_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
    local END_TIME=$(date +%s)
    local DURATION=$((END_TIME - START_TIME))
    local MIN=$((DURATION / 60))
    local SEC=$((DURATION % 60))

    echo
    echo -e "  ${BOLD}${GREEN}╔════════════════════════════════════════════════════╗${NC}"
    echo -e "  ${BOLD}${GREEN}║           INSTALLATION COMPLETE!                  ║${NC}"
    echo -e "  ${BOLD}${GREEN}╚════════════════════════════════════════════════════╝${NC}"
    echo
    echo -e "  ${BOLD}Installation took:${NC} ${MIN}m ${SEC}s"
    echo -e "  ${BOLD}Install log:${NC}     $INSTALL_LOG"
    echo
    echo -e "  ${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${BOLD}  SYSTEM INFORMATION${NC}"
    echo -e "  ${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${ARROW} OS:          ${OS_PRETTY}"
    echo -e "  ${ARROW} Architecture: ${ARCH_FULL}"
    echo -e "  ${ARROW} Node.js:     $(node --version 2>/dev/null || echo 'N/A')"
    echo -e "  ${ARROW} Python:      $(python3 --version 2>/dev/null || echo 'N/A')"
    echo -e "  ${ARROW} Working Dir: $(pwd)"
    echo
    echo -e "  ${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${BOLD}  ACCESS INFORMATION${NC}"
    echo -e "  ${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    if [ -n "$IP_ADDR" ]; then
        echo -e "  ${ARROW} Dashboard:   ${BOLD}http://${IP_ADDR}:3003${NC}"
    else
        echo -e "  ${ARROW} Dashboard:   ${BOLD}http://<server-ip>:3003${NC}"
    fi
    echo -e "  ${YELLOW}⚠  Default Login:${NC} admin / ChangeMe@Secure123456 (CHANGE THIS!)"
    echo
    echo -e "  ${ARROW} HLS Stream:  http://${IP_ADDR}:8856"
    echo -e "  ${ARROW} RTSP Port:   8555"
    echo -e "  ${ARROW} MediaMTX API: http://127.0.0.1:9123"
    echo -e "  ${ARROW} AI Engine:    (disabled)"
    echo
    echo -e "  ${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${BOLD}  SERVICE MANAGEMENT${NC}"
    echo -e "  ${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${ARROW} Status:  ${BOLD}systemctl status mediamtx${NC} or ${BOLD}cctv-web${NC}"
    echo -e "  ${ARROW} Restart: ${BOLD}sudo systemctl restart mediamtx${NC} or ${BOLD}cctv-web${NC}"
    echo -e "  ${ARROW} Logs:    ${BOLD}journalctl -u cctv-web -n 50${NC}"
    echo -e "  ${ARROW} Uninstall: ${BOLD}bash uninstall.sh${NC}"
    echo
    echo -e "  ${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${BOLD}  QUICK CHECKS${NC}"
    echo -e "  ${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${ARROW} curl -I http://127.0.0.1:3003/"
    echo -e "  ${ARROW} curl -s http://127.0.0.1:9123/healthz"
    echo -e "  ${ARROW} curl -s http://127.0.0.1:3003/api/status"
    echo
    echo -e "  ${ARROW} All services will ${BOLD}auto-start${NC} on system boot"
    echo
    echo -e "  ${YELLOW}⚠  IMPORTANT: Change the default password!${NC}"
    echo -e "     Edit config.json and set a strong password."
    echo
}

# ──────────────────────────────────────────────────────────────
# Verify Configuration
# ──────────────────────────────────────────────────────────────
verify_config() {
    log_info "Verifying configuration files..."

    local CONFIG_ISSUES=0

    # Check config.json exists
    if [ ! -f "config.json" ]; then
        log_error "config.json not found!"
        CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
    else
        log_ok "config.json found"
        
        # Check for security issues
        if grep -q '"password": "admin123"' config.json; then
            log_warn "⚠️  WARNING: Default password 'admin123' still in config.json - CHANGE IT!"
            CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
        elif grep -q '"password": "ChangeMe@' config.json; then
            log_warn "⚠️  WARNING: Template password still in config.json - CHANGE IT!"
            CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
        else
            log_ok "Password appears to be customized"
        fi
        
        # Check session_secret
        if grep -q '"session_secret": "cctv-monitoring-secret-key"' config.json || \
           grep -q '"session_secret": "cctv-secret-key-change-me"' config.json; then
            log_warn "⚠️  WARNING: Default session_secret - should be random 32+ chars"
            CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
        else
            log_ok "Session secret appears to be customized"
        fi
    fi

    # Check mediamtx.yml
    if [ ! -f "mediamtx.yml" ]; then
        log_error "mediamtx.yml not found!"
        CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
    else
        log_ok "mediamtx.yml found"
        
        # Verify key settings
        if grep -q "hlsAddress.*8856" mediamtx.yml; then
            log_ok "HLS port 8856 configured"
        else
            log_warn "HLS port may not be correct"
        fi
        
        if grep -q "apiAddress.*9123" mediamtx.yml; then
            log_ok "API port 9123 configured"
        else
            log_warn "API port may not be correct"
        fi
    fi

    # Check for package.json
    if [ ! -f "package.json" ]; then
        log_error "package.json not found!"
        CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
    else
        log_ok "package.json found"
    fi

    # Summary
    if [ "$CONFIG_ISSUES" -gt 0 ]; then
        log_warn "⚠️  Found $CONFIG_ISSUES configuration issue(s) - review above"
    else
        log_ok "All configuration checks passed"
    fi
}

# ──────────────────────────────────────────────────────────────
# Main Installation Flow
# ──────────────────────────────────────────────────────────────
main() {
    TOTAL_STEPS=13

    # Clear screen
    clear

    # Show banner
    banner

    # Step 1: Preflight checks
    log_step 1 "System Checks"
    preflight_checks

    # Step 2: Fix repositories
    log_step 2 "Repository Fixes"
    fix_repositories

    # Step 3: Install system dependencies
    log_step 3 "System Dependencies"
    install_system_deps

    # Step 4: Install Node.js
    log_step 4 "Node.js Installation"
    install_nodejs

    # Step 5: Download MediaMTX
    log_step 5 "MediaMTX Installation"
    install_mediamtx

    # Step 6: Configure MediaMTX
    log_step 6 "MediaMTX Configuration"
    configure_mediamtx

    # Step 7: Generate support scripts
    log_step 7 "Support Scripts"
    generate_scripts

    # Step 8: Install Node.js dependencies
    log_step 8 "Node.js Dependencies"
    install_npm_deps

    # Step 9: Create directories
    log_step 9 "Directories Setup"
    create_directories

    # Step 10: Setup database
    log_step 10 "Database Setup"
    setup_database

    # Step 10.5: Verify Configuration
    log_step 11 "Configuration Verification"
    verify_config

    # Step 11: Create systemd services
    log_step 12 "Systemd Services (Auto-Start)"
    setup_systemd_services
    setup_firewall

    # Step 12: Start services and show summary
    log_step 13 "Starting Services & Summary"
    start_services
    show_summary

    # Save install marker
    date > .install-date
    echo "$SCRIPT_VERSION" > .installer-version

    echo -e "  ${GREEN}${BOLD}✅ Installation log saved to:${NC} $INSTALL_LOG"
    echo
}

# ──────────────────────────────────────────────────────────────
# Entry Point
# ──────────────────────────────────────────────────────────────
main "$@"
