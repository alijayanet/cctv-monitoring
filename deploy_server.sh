#!/bin/bash
# =====================================================
# Deploy Script - Upload optimized files to CCTV Server
# Usage: bash deploy_server.sh [server-ip] [user] [remote-dir]
# Example: bash deploy_server.sh 192.168.1.75 admin /home/admin/cctv-monitoring
# =====================================================

# Validate arguments
if [ $# -lt 1 ]; then
    echo "Usage: bash deploy_server.sh <server-ip> [user] [remote-dir]"
    echo ""
    echo "Examples:"
    echo "  bash deploy_server.sh 192.168.1.75"
    echo "  bash deploy_server.sh 192.168.1.75 root /opt/cctv-monitoring"
    echo ""
    exit 1
fi

SERVER_IP="$1"
SSH_USER="${2:-root}"
REMOTE_DIR="${3:-/opt/cctv-monitoring}"

echo "============================================"
echo "  Deploy CCTV Monitoring System"
echo "  Server: $SSH_USER@$SERVER_IP:$REMOTE_DIR"
echo "============================================"
echo ""

# Check if ssh is available
if ! command -v ssh &>/dev/null; then
    echo "❌ ERROR: SSH client not found. Please install openssh-client"
    exit 1
fi

# Try to connect first
echo "[0/4] Testing SSH connection..."
if ! ssh -o ConnectTimeout=5 "$SSH_USER@$SERVER_IP" "echo OK" 2>/dev/null; then
    echo "❌ ERROR: Cannot connect to $SSH_USER@$SERVER_IP"
    echo "   Please verify:"
    echo "   - Server IP is correct: $SERVER_IP"
    echo "   - User is correct: $SSH_USER"
    echo "   - SSH access is enabled"
    exit 1
fi
echo "✓ SSH connection successful"
echo ""

# 1. Create directories on server
echo "[1/4] Creating directories on server..."
ssh "$SSH_USER@$SERVER_IP" "mkdir -p $REMOTE_DIR/services $REMOTE_DIR/middleware $REMOTE_DIR/migrations $REMOTE_DIR/utils" 2>/dev/null || {
    echo "❌ Failed to create directories"
    exit 1
}
echo "✓ Directories created"

# 2. Upload core files
echo "[2/4] Uploading core files..."
FILES_TO_UPLOAD=(
    "database.js"
    "config.json"
    "services/permission.js"
    "middleware/permission.js"
    "utils/middleware.js"
)

FAILED=0
for file in "${FILES_TO_UPLOAD[@]}"; do
    if [ -f "$file" ]; then
        echo "  → Uploading $file..."
        if ! scp "$file" "$SSH_USER@$SERVER_IP:$REMOTE_DIR/$file" 2>/dev/null; then
            echo "    ⚠️  Failed to upload $file"
            FAILED=$((FAILED + 1))
        fi
    else
        echo "  ⚠️  File not found: $file"
    fi
done

if [ $FAILED -gt 0 ]; then
    echo "⚠️  $FAILED file(s) failed to upload"
fi

# 3. Verify files
echo "[3/4] Verifying uploaded files..."
ssh "$SSH_USER@$SERVER_IP" "
if [ -d '$REMOTE_DIR' ]; then
    echo '✓ Remote directory exists'
    echo ''
    echo 'Uploaded files:'
    ls -lh $REMOTE_DIR/database.js 2>/dev/null || echo '  ✗ database.js not found'
    ls -lh $REMOTE_DIR/config.json 2>/dev/null || echo '  ✗ config.json not found'
    ls -lh $REMOTE_DIR/services/permission.js 2>/dev/null || echo '  ✗ services/permission.js not found'
else
    echo '✗ Remote directory does not exist: $REMOTE_DIR'
fi
" 2>/dev/null || echo "⚠️  Could not verify files on remote"

# 4. Restart services
echo "[4/4] Restarting services..."
ssh "$SSH_USER@$SERVER_IP" "
if command -v systemctl &>/dev/null; then
    echo '  Checking systemd services...'
    for svc in cctv-web mediamtx; do
        if systemctl list-unit-files | grep -q \"^$svc.service\"; then
            echo \"  → Restarting $svc...\"
            sudo systemctl restart $svc 2>/dev/null || systemctl restart $svc 2>/dev/null
            sleep 1
            if systemctl is-active --quiet $svc; then
                echo \"    ✓ $svc is running\"
            else
                echo \"    ✗ $svc failed to start (check: journalctl -u $svc -n 20)\"
            fi
        fi
    done
else
    echo '  ⚠️  systemd not found, services not restarted'
fi
echo ''
echo '=== Service Status ==='
systemctl status cctv-web mediamtx --no-pager 2>/dev/null || echo 'Could not get service status'
" 2>/dev/null || echo "⚠️  Could not restart services"

echo ""
echo "============================================"
echo "  ✅ Deployment Process Complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Verify services are running:"
echo "     ssh $SSH_USER@$SERVER_IP 'systemctl status cctv-web'"
echo "  2. Check logs for errors:"
echo "     ssh $SSH_USER@$SERVER_IP 'journalctl -u cctv-web -n 50'"
echo "  3. Test web interface:"
echo "     http://$SERVER_IP:3003"
echo ""
