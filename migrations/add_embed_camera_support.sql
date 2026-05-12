-- Migration: Add Embed Camera Support
-- Menambahkan field untuk kamera embed (streaming only, no recording)

-- Add new columns to cameras table
ALTER TABLE cameras ADD COLUMN camera_type TEXT DEFAULT 'rtsp';
-- camera_type: 'rtsp' (normal RTSP camera) atau 'embed' (embed URL/iframe)

ALTER TABLE cameras ADD COLUMN embed_url TEXT DEFAULT NULL;
-- embed_url: URL embed untuk kamera publik (YouTube Live, iframe, dll)

ALTER TABLE cameras ADD COLUMN enable_recording INTEGER DEFAULT 1;
-- enable_recording: 1 = recording enabled, 0 = streaming only

ALTER TABLE cameras ADD COLUMN embed_type TEXT DEFAULT NULL;
-- embed_type: 'youtube', 'iframe', 'hls', 'dash', 'custom'

-- Update existing cameras to have default values
UPDATE cameras SET camera_type = 'rtsp' WHERE camera_type IS NULL;
UPDATE cameras SET enable_recording = 1 WHERE enable_recording IS NULL;

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_cameras_type ON cameras(camera_type);
CREATE INDEX IF NOT EXISTS idx_cameras_recording ON cameras(enable_recording);

-- Made with Bob
