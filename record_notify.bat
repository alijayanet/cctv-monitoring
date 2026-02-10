@echo off
curl -X POST -H "Content-Type: application/json" -d "{\"path\":\"%MTX_PATH%\", \"file\":\"%MTX_SEGMENT_PATH%\"}" http://localhost:3003/api/recordings/notify
