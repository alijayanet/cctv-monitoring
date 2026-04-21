const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'cameras.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');

        // Create Cameras Table
        db.run(`CREATE TABLE IF NOT EXISTS cameras (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nama TEXT NOT NULL,
            lokasi TEXT,
            url_rtsp TEXT NOT NULL
        )`, (err) => {
            if (err) {
                console.error('Error creating table:', err.message);
            } else {
                // Check and Add lat/lng columns if missing (Migration)
                const columns = ['lat', 'lng'];
                columns.forEach(col => {
                    db.run(`ALTER TABLE cameras ADD COLUMN ${col} REAL`, (err) => {
                        // Ignore duplicate column error
                        if (err && !err.message.includes('duplicate column name')) {
                            console.error(`Migration error adding ${col}:`, err.message);
                        }
                    });
                });
                
                // Add PTZ columns if missing
                const ptzColumns = [
                    { name: 'ptz_enabled', type: 'INTEGER DEFAULT 0' },
                    { name: 'onvif_port', type: 'INTEGER DEFAULT 80' },
                    { name: 'is_public', type: 'INTEGER DEFAULT 1' }
                ];
                ptzColumns.forEach(col => {
                    db.run(`ALTER TABLE cameras ADD COLUMN ${col.name} ${col.type}`, (err) => {
                        if (err && !err.message.includes('duplicate column name')) {
                            console.error(`Migration error adding ${col.name}:`, err.message);
                        }
                    });
                });
            }
        });

        // Create Recordings Table
        db.run(`CREATE TABLE IF NOT EXISTS recordings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            camera_id INTEGER,
            filename TEXT NOT NULL,
            file_path TEXT NOT NULL,
            size INTEGER,
            duration REAL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (camera_id) REFERENCES cameras (id)
        )`, (err) => {
            if (err) {
                console.error('Error creating recordings table:', err.message);
            } else {
                db.run(`CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_recordings_camera_time ON recordings(camera_id, created_at)`);
            }
        });
    }
});

module.exports = db;
