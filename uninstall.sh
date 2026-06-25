#!/bin/bash
# CCTV Monitoring System - Enhanced Uninstaller
echo "╔══════════════════════════════════════════╗"
echo "║  CCTV Monitoring System - Uninstaller    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

echo "[1/4] Stopping services..."
for svc in cctv-web mediamtx ai-engine; do
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        echo "  → Stopping $svc..."
        sudo systemctl stop "$svc"
    fi
    if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
        echo "  → Disabling $svc..."
        sudo systemctl disable "$svc"
    fi
done
echo "  ✅ All services stopped/disabled"

echo ""
echo "[2/4] Removing service files..."
for svf in /etc/systemd/system/cctv-web.service /etc/systemd/system/mediamtx.service /etc/systemd/system/ai-engine.service; do
    if [ -f "$svf" ]; then
        sudo rm -f "$svf"
        echo "  → Removed $(basename $svf)"
    fi
done
echo "  ✅ Service files removed"

echo ""
echo "[3/4] Removing sudoers configuration..."
if [ -f /etc/sudoers.d/cctv-monitoring ]; then
    sudo rm -f /etc/sudoers.d/cctv-monitoring
    echo "  ✅ Sudoers config removed"
fi

echo ""
echo "[4/4] Reloading systemd..."
sudo systemctl daemon-reload
echo "  ✅ systemd reloaded"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ✅ UNINSTALLATION COMPLETE              ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Services removed:"
echo "  • cctv-web   (Node.js Web Dashboard)"
echo "  • mediamtx   (RTSP/HLS Streaming)"
echo "  • ai-engine  (Python AI Detection)"
echo ""
echo "⚠️  To completely remove all project files:"
echo "   rm -rf $(pwd)"
echo ""
echo "💾 To keep recordings, backup the 'recordings' directory first."
echo "   cp -r recordings /path/to/backup/"
echo ""
