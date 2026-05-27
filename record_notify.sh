#!/bin/bash
# Notifikasi ke web-app saat segment rekaman selesai
# Port dibaca dari config.json agar tidak hardcoded

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONFIG_FILE="$SCRIPT_DIR/config.json"

# Baca port dari config.json
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
