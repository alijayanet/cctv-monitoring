#!/bin/bash

# Pastikan folder transcode ada
mkdir -p logs

echo "=== CCTV H.265 to H.264 Transcoder ==="
echo "Gunakan script ini untuk kamera yang videonya blank/hitam di browser."
echo ""

read -p "Masukkan ID Kamera (lihat di Admin, misal 1): " CAMERA_ID
read -p "Masukkan URL RTSP Asli: " RTSP_URL

echo ""
echo "Memulai Transcoding untuk Kamera $CAMERA_ID..."
echo "Video akan tersedia di Dashboard."
echo "Tekan Ctrl+C untuk berhenti."

# Jalankan FFmpeg untuk convert H.265 -> H.264 dan kirim ke MediaMTX
ffmpeg -i "$RTSP_URL" \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -b:v 600k -s 854x480 \
  -an \
  -f rtsp rtsp://127.0.0.1:8554/cam_${CAMERA_ID}
