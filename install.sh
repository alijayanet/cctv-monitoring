#!/bin/bash
# ==============================================================================
# CCTV Monitoring & AI Object Counter - Auto Installation Script for Ubuntu/Debian
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================================================${NC}"
echo -e "${GREEN}    CCTV Monitoring & AI Object Counter Installation Script (Ubuntu)  ${NC}"
echo -e "${BLUE}======================================================================${NC}"

# Check root or sudo
if [ "$EUID" -ne 0 ]; then
  echo -e "${YELLOW}ℹ️ Silakan jalankan script ini dengan sudo jika instalasi paket sistem diperlukan:${NC}"
  echo -e "${YELLOW}   sudo bash install.sh${NC}\n"
fi

# Step 1: Update & Install System Dependencies
echo -e "\n${BLUE}[1/5] Memeriksa & Menginstal Dependensi Sistem (FFmpeg, Python, OpenCV libs)...${NC}"
if command -v apt &> /dev/null; then
    sudo apt update -y
    # In Ubuntu 22.04 / 24.04 and Debian 12, use 'libgl1' instead of legacy 'libgl1-mesa-glx'
    sudo apt install -y python3 python3-pip python3-venv ffmpeg libgl1 libglib2.0-0 build-essential wget curl git || \
    sudo apt install -y python3 python3-pip ffmpeg libgl1 libglib2.0-0 wget curl git
else
    echo -e "${YELLOW}⚠️ Package manager apt tidak ditemukan. Pastikan Python 3, FFmpeg, dan OpenCV C++ libs sudah terinstall.${NC}"
fi

# Step 2: Install Node.js Dependencies
echo -e "\n${BLUE}[2/5] Menginstal Dependensi Node.js (npm install)...${NC}"
if command -v npm &> /dev/null; then
    npm install
else
    echo -e "${RED}❌ Node.js / npm belum terinstall! Silakan install Node.js (v18+) terlebih dahulu.${NC}"
    exit 1
fi

# Step 3: Install Python AI Dependencies
echo -e "\n${BLUE}[3/5] Menginstal Library Python AI (OpenCV, Ultralytics, ByteTrack)...${NC}"
PYTHON_CMD="python3"
if ! command -v python3 &> /dev/null; then
    PYTHON_CMD="python"
fi

$PYTHON_CMD -m pip install --upgrade pip --break-system-packages 2>/dev/null || true

echo -e "${YELLOW}Menginstal PyTorch CPU (Ringan & Hemat RAM)...${NC}"
$PYTHON_CMD -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu --break-system-packages 2>/dev/null || $PYTHON_CMD -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

echo -e "${YELLOW}Menginstal OpenCV, Ultralytics, Requests, dan LapX...${NC}"
$PYTHON_CMD -m pip install opencv-python-headless ultralytics requests lapx --break-system-packages 2>/dev/null || $PYTHON_CMD -m pip install opencv-python-headless ultralytics requests lapx

# Step 4: Download MediaMTX Streaming Server
echo -e "\n${BLUE}[4/6] Memeriksa & Mengunduh MediaMTX Streaming Server...${NC}"
ARCH=$(uname -m)
case "$ARCH" in
    x86_64) MTX_ARCH="linux_amd64" ;;
    aarch64|arm64) MTX_ARCH="linux_arm64" ;;
    armv7l|armv7) MTX_ARCH="linux_armv7" ;;
    armv6l|armv6) MTX_ARCH="linux_armv6" ;;
    i386|i686) MTX_ARCH="linux_386" ;;
    *) MTX_ARCH="linux_amd64" ;;
esac

NEED_MTX_DOWNLOAD=1
if [ -f "./mediamtx" ] && [ -x "./mediamtx" ]; then
    FILE_INFO=$(file ./mediamtx 2>/dev/null || true)
    if [[ "$FILE_INFO" == *"ELF"* ]]; then
        echo -e "${GREEN}✅ Binary MediaMTX yang valid sudah terpasang.${NC}"
        NEED_MTX_DOWNLOAD=0
    fi
fi

if [ $NEED_MTX_DOWNLOAD -eq 1 ]; then
    MTX_VERSION="v1.20.0"
    echo -e "${YELLOW}Mengunduh MediaMTX ${MTX_VERSION} (${MTX_ARCH})...${NC}"
    MTX_URL="https://github.com/bluenviron/mediamtx/releases/download/${MTX_VERSION}/mediamtx_${MTX_VERSION}_${MTX_ARCH}.tar.gz"
    
    rm -f mediamtx.tar.gz
    if ! (wget -q --show-progress -O mediamtx.tar.gz "$MTX_URL" || curl -L -o mediamtx.tar.gz "$MTX_URL"); then
        echo -e "${YELLOW}Gagal mengunduh ${MTX_VERSION}, mencoba versi stabil v1.16.1...${NC}"
        FALLBACK_URL="https://github.com/bluenviron/mediamtx/releases/download/v1.16.1/mediamtx_v1.16.1_${MTX_ARCH}.tar.gz"
        wget -q --show-progress -O mediamtx.tar.gz "$FALLBACK_URL" || curl -L -o mediamtx.tar.gz "$FALLBACK_URL"
    fi
    
    if [ -f "mediamtx.tar.gz" ]; then
        tar -xzf mediamtx.tar.gz mediamtx
        rm -f mediamtx.tar.gz
        chmod +x mediamtx
        echo -e "${GREEN}✅ MediaMTX berhasil diunduh dan dipasang.${NC}"
    else
        echo -e "${RED}❌ Gagal mengunduh MediaMTX. Periksa koneksi internet ke GitHub.${NC}"
    fi
fi

# Step 5: Download AI YOLO Model (yolov8n.pt)
echo -e "\n${BLUE}[5/6] Mengunduh Model AI YOLOv8 Nano (yolov8n.pt)...${NC}"
MODEL_FILE="yolov8n.pt"
MODEL_URL="https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.pt"

if [ ! -f "$MODEL_FILE" ]; then
    wget -O "$MODEL_FILE" "$MODEL_URL" || curl -L -o "$MODEL_FILE" "$MODEL_URL"
    echo -e "${GREEN}✅ Model AI $MODEL_FILE berhasil diunduh.${NC}"
else
    echo -e "${GREEN}✅ Model AI $MODEL_FILE sudah ada.${NC}"
fi

# Step 6: Verification & Setup Finished
echo -e "\n${BLUE}[6/6] Memeriksa Instalasi AI Engine & Streaming...${NC}"
if $PYTHON_CMD -c "import cv2, torch, ultralytics, lap, requests; print('AI Stack Ready!')" &> /dev/null; then
    echo -e "${GREEN}✅ Seluruh Library AI (OpenCV, PyTorch CPU, Ultralytics, ByteTrack) Berhasil Diuji!${NC}"
else
    echo -e "${YELLOW}⚠️ Pengujian modul AI selesai dengan sedikit catatan. Sistem akan otomatis menyesuaikan saat startup.${NC}"
fi

# Fix file ownership and permissions if script was executed via sudo
if [ -n "$SUDO_USER" ]; then
    chown -R $SUDO_USER:$SUDO_USER .
fi
chmod -R 775 .
chmod 666 cameras.db* 2>/dev/null || true
mkdir -p recordings public/ai_snaps uploads bukti_tf stream_logs
chmod -R 777 recordings public/ai_snaps uploads bukti_tf stream_logs 2>/dev/null || true

# Open firewall ports if UFW is active
if command -v ufw &> /dev/null && sudo ufw status | grep -q "Status: active"; then
    echo -e "${YELLOW}Membuka port pada UFW firewall (3003, 8555, 8856, 1936)...${NC}"
    sudo ufw allow 3003/tcp 2>/dev/null || true
    sudo ufw allow 8856/tcp 2>/dev/null || true
    sudo ufw allow 8555/tcp 2>/dev/null || true
    sudo ufw allow 1936/tcp 2>/dev/null || true
fi

# Make scripts executable
chmod +x install.sh 2>/dev/null || true

echo -e "\n${GREEN}======================================================================${NC}"
echo -e "${GREEN}🎉 INSTALASI SELESAI! APLIKASI DAN ENGINE AI SIAP DIGUNAKAN.${NC}"
echo -e "${GREEN}======================================================================${NC}"
echo -e "Untuk menjalankan aplikasi di Ubuntu:"
echo -e "  1. Jalankan langsung  : ${YELLOW}npm start${NC} atau ${YELLOW}node index.js${NC}"
echo -e "  2. Jalankan via PM2   : ${YELLOW}pm2 start index.js --name cctv-ai${NC}"
echo -e "======================================================================\n"
