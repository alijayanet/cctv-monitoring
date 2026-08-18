#!/bin/bash

echo "=== DIAGNOSING MEDIAMTX ISSUE ==="

# 1. Check if binary exists
if [ ! -f "mediamtx" ]; then
    echo "❌ Error: mediamtx binary not found!"
    exit 1
fi

# 2. Check if binary is executable
if [ ! -x "mediamtx" ]; then
    echo "⚠️  mediamtx is not executable. Fixing permissions..."
    chmod +x mediamtx
fi

# 3. Check if binary is actually a binary (not an HTML error page)
FILE_TYPE=$(file mediamtx)
echo "ℹ️  File type: $FILE_TYPE"
    echo "   Attempting to download latest MediaMTX (v1.20.0)..."
    
    # Architecture detection
    ARCH=$(uname -m)
    if [ "$ARCH" = "x86_64" ]; then
        MTX_ARCH="linux_amd64"
    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
        MTX_ARCH="linux_arm64"
    elif [ "$ARCH" = "armv7l" ] || [ "$ARCH" = "armv7" ]; then
        MTX_ARCH="linux_armv7"
    else
        MTX_ARCH="linux_amd64"
    fi
    
    rm -f mediamtx mediamtx.yml mediamtx.tar.gz
    MTX_VERSION="v1.20.0"
    MTX_URL="https://github.com/bluenviron/mediamtx/releases/download/${MTX_VERSION}/mediamtx_${MTX_VERSION}_${MTX_ARCH}.tar.gz"
    
    if ! (wget -q --show-progress -O mediamtx.tar.gz "$MTX_URL" || curl -L -o mediamtx.tar.gz "$MTX_URL"); then
        echo "   Fallback to stable v1.16.1..."
        FALLBACK_URL="https://github.com/bluenviron/mediamtx/releases/download/v1.16.1/mediamtx_v1.16.1_${MTX_ARCH}.tar.gz"
        wget -q --show-progress -O mediamtx.tar.gz "$FALLBACK_URL" || curl -L -o mediamtx.tar.gz "$FALLBACK_URL"
    fi
    
    tar -xvzf mediamtx.tar.gz mediamtx
    rm -f mediamtx.tar.gz
    chmod +x mediamtx
    
    # Re-patch config
    echo "   Re-patching configuration..."
    sed -i 's/rtspAddress: :8554/rtspAddress: :8555/g' mediamtx.yml
    sed -i 's/hlsAddress: :8888/hlsAddress: :8856/g' mediamtx.yml
    sed -i 's/rtpAddress: :8000/rtpAddress: :8050/g' mediamtx.yml
    sed -i 's/rtcpAddress: :8001/rtcpAddress: :8051/g' mediamtx.yml
    sed -i 's/rtmpAddress: :1935/rtmpAddress: :1936/g' mediamtx.yml
    sed -i 's/webrtcAddress: :8889/webrtcAddress: :8890/g' mediamtx.yml
    sed -i 's/webrtcICEUDPMuxAddress: :8189/webrtcICEUDPMuxAddress: ""/g' mediamtx.yml
    sed -i 's/apiAddress: :[0-9]\+/apiAddress: :9123/g' mediamtx.yml
    sed -i 's/^api: .*/api: yes/g' mediamtx.yml
    sed -i 's/hlsVariant: .*/hlsVariant: fmp4/g' mediamtx.yml
    sed -i 's/recordFormat: .*/recordFormat: fmp4/g' mediamtx.yml
    sed -i 's/^record: .*/record: false/g' mediamtx.yml
    sed -i 's|recordPath: .*|recordPath: ./recordings/%path/%Y-%m-%d_%H-%M-%S-%f|g' mediamtx.yml
    sed -i 's/recordDeleteAfter: .*/recordDeleteAfter: 7d/g' mediamtx.yml
    sed -i 's/record_notify\.bat/record_notify.sh/g' mediamtx.yml
fi

# 4. Test run manually
echo "🔄 Testing manual run..."
./mediamtx > mediamtx_debug.log 2>&1 &
PID=$!
sleep 2

if ps -p $PID > /dev/null; then
    echo "✅ MediaMTX started successfully manually!"
    kill $PID
    
    # 5. Restart Service
    echo "🔄 Restarting systemd service..."
    
    # Apply port fix if config exists
    if [ -f "mediamtx.yml" ]; then
        echo "🔧 Patching UDP ports (8000->8050), RTMP (1935->1936), WebRTC (8889->8890), disabling UDP Mux..."
        sed -i 's/rtpAddress: :8000/rtpAddress: :8050/g' mediamtx.yml
        sed -i 's/rtcpAddress: :8001/rtcpAddress: :8051/g' mediamtx.yml
        sed -i 's/rtmpAddress: :1935/rtmpAddress: :1936/g' mediamtx.yml
        sed -i 's/webrtcAddress: :8889/webrtcAddress: :8890/g' mediamtx.yml
        sed -i 's/webrtcICEUDPMuxAddress: :8189/webrtcICEUDPMuxAddress: ""/g' mediamtx.yml
        sed -i 's/recordFormat: .*/recordFormat: fmp4/g' mediamtx.yml
        sed -i 's/^record: .*/record: false/g' mediamtx.yml
        sed -i 's|recordPath: .*|recordPath: ./recordings/%path/%Y-%m-%d_%H-%M-%S-%f|g' mediamtx.yml
        sed -i 's/recordDeleteAfter: .*/recordDeleteAfter: 7d/g' mediamtx.yml
    fi

    sudo systemctl restart mediamtx
    sleep 2
    
    if systemctl is-active --quiet mediamtx; then
        echo "✅ Service is now RUNNING!"
    else
        echo "❌ Service failed to start via systemctl. Check logs:"
        sudo journalctl -u mediamtx -n 20 --no-pager
    fi
else
    echo "❌ MediaMTX failed to run manually. Output:"
    cat mediamtx_debug.log
fi

rm -f mediamtx_debug.log
