/**
 * Database Schema Migration for AI Vehicle Detection & Speed Measurement
 * Adds tables for vehicle counting, speed records, and AI configuration
 */

const db = require('./database');

function migrateAiTables() {
    console.log('[Database AI] Running AI schema migrations...');

    // AI Speed Records - stores every vehicle speed measurement
    db.run(`CREATE TABLE IF NOT EXISTS ai_speed_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id INTEGER NOT NULL,
        track_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        class_name TEXT NOT NULL,
        speed_kmh REAL NOT NULL,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (camera_id) REFERENCES cameras(id)
    )`, (err) => {
        if (err) {
            console.error('[Database AI] Error creating ai_speed_records:', err.message);
        } else {
            console.log('[Database AI] ai_speed_records table ready');
            
            // Create indexes for fast queries
            db.run(`CREATE INDEX IF NOT EXISTS idx_speed_records_camera_time ON ai_speed_records(camera_id, recorded_at)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_speed_records_time ON ai_speed_records(recorded_at)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_speed_records_class ON ai_speed_records(camera_id, class_name)`);
        }
    });

    // AI Vehicle Counts - aggregated counts per camera per period
    db.run(`CREATE TABLE IF NOT EXISTS ai_vehicle_counts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id INTEGER NOT NULL,
        class_name TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        period_start DATETIME NOT NULL,
        period_end DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (camera_id) REFERENCES cameras(id)
    )`, (err) => {
        if (err) {
            console.error('[Database AI] Error creating ai_vehicle_counts:', err.message);
        } else {
            console.log('[Database AI] ai_vehicle_counts table ready');
            db.run(`CREATE INDEX IF NOT EXISTS idx_vehicle_counts_camera ON ai_vehicle_counts(camera_id, period_start)`);
        }
    });

    // AI Detection Zones Configuration
    db.run(`CREATE TABLE IF NOT EXISTS ai_detection_zones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        x1 REAL NOT NULL,
        y1 REAL NOT NULL,
        x2 REAL NOT NULL,
        y2 REAL NOT NULL,
        direction TEXT DEFAULT 'both',
        is_speed_gate INTEGER DEFAULT 0,
        line1_x1 REAL,
        line1_y1 REAL,
        line1_x2 REAL,
        line1_y2 REAL,
        line2_x1 REAL,
        line2_y1 REAL,
        line2_x2 REAL,
        line2_y2 REAL,
        gate_distance_meters REAL DEFAULT 10,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
    )`, (err) => {
        if (err) {
            console.error('[Database AI] Error creating ai_detection_zones:', err.message);
        } else {
            console.log('[Database AI] ai_detection_zones table ready');
            db.run(`CREATE INDEX IF NOT EXISTS idx_detection_zones_camera ON ai_detection_zones(camera_id)`);
        }
    });

    // AI Engine Configuration per camera
    db.run(`CREATE TABLE IF NOT EXISTS ai_camera_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id INTEGER UNIQUE NOT NULL,
        enabled INTEGER DEFAULT 1,
        detection_interval_ms INTEGER DEFAULT 500,
        confidence_threshold REAL DEFAULT 0.5,
        frame_width INTEGER DEFAULT 640,
        frame_height INTEGER DEFAULT 480,
        max_speed_kmh REAL DEFAULT 200,
        min_hits_to_track INTEGER DEFAULT 3,
        calibration_distance_meters REAL DEFAULT 10,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
    )`, (err) => {
        if (err) {
            console.error('[Database AI] Error creating ai_camera_config:', err.message);
        } else {
            console.log('[Database AI] ai_camera_config table ready');
        }
    });

    // AI Event Log - detailed events for analytics & alerts
    db.run(`CREATE TABLE IF NOT EXISTS ai_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        class_name TEXT,
        speed_kmh REAL,
        track_id INTEGER,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (camera_id) REFERENCES cameras(id)
    )`, (err) => {
        if (err) {
            console.error('[Database AI] Error creating ai_events:', err.message);
        } else {
            console.log('[Database AI] ai_events table ready');
            db.run(`CREATE INDEX IF NOT EXISTS idx_ai_events_camera_time ON ai_events(camera_id, created_at)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_ai_events_type ON ai_events(event_type)`);
        }
    });

    // AI Alert Configuration - speed threshold alerts
    db.run(`CREATE TABLE IF NOT EXISTS ai_alert_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id INTEGER,
        alert_type TEXT NOT NULL,
        class_name TEXT,
        speed_threshold REAL,
        count_threshold INTEGER,
        enabled INTEGER DEFAULT 1,
        notify_telegram INTEGER DEFAULT 0,
        notify_whatsapp INTEGER DEFAULT 0,
        cooldown_minutes INTEGER DEFAULT 5,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
    )`, (err) => {
        if (err) {
            console.error('[Database AI] Error creating ai_alert_config:', err.message);
        } else {
            console.log('[Database AI] ai_alert_config table ready');
        }
    });

    // Add AI columns to cameras table
    db.run(`ALTER TABLE cameras ADD COLUMN ai_enabled INTEGER DEFAULT 1`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('[Database AI] Migration error adding ai_enabled:', err.message);
        }
    });

    db.run(`ALTER TABLE cameras ADD COLUMN ai_calibration_image TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('[Database AI] Migration error adding ai_calibration_image:', err.message);
        }
    });

    console.log('[Database AI] AI schema migration complete');
}

// Run migration
migrateAiTables();

module.exports = { migrateAiTables };