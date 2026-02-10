#!/bin/bash
echo "Starting CCTV Monitoring System..."

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Check if mediamtx is running
if pgrep -x "mediamtx" > /dev/null
then
    echo "MediaMTX is running."
else
    echo "Warning: MediaMTX is not running. Please start it separately or ensure it is installed."
    # Optional: try to start it if in current dir
    if [ -f "./mediamtx" ]; then
        echo "Starting MediaMTX..."
        ./mediamtx &
        sleep 2
    fi
fi

# Start Node server
echo "Starting Node.js server..."
npm start
