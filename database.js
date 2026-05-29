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

                // Add PTZ, YouTube, and Embed/Recording columns if missing
                const ptzColumns = [
                    { name: 'ptz_enabled', type: 'INTEGER DEFAULT 0' },
                    { name: 'onvif_port', type: 'INTEGER DEFAULT 80' },
                    { name: 'is_public', type: 'INTEGER DEFAULT 1' },
                    { name: 'youtube_stream_key', type: 'TEXT DEFAULT NULL' },
                    { name: 'youtube_quality', type: 'TEXT DEFAULT NULL' },
                    { name: 'level', type: "TEXT DEFAULT 'umum'" },
                    { name: 'owner_id', type: 'INTEGER DEFAULT NULL' },
                    { name: 'camera_type', type: "TEXT DEFAULT 'rtsp'" },
                    { name: 'embed_url', type: 'TEXT DEFAULT NULL' },
                    { name: 'enable_recording', type: 'INTEGER DEFAULT 1' },
                    { name: 'embed_type', type: 'TEXT DEFAULT NULL' }
                ];
                ptzColumns.forEach(col => {
                    db.run(`ALTER TABLE cameras ADD COLUMN ${col.name} ${col.type}`, (err) => {
                        if (err && !err.message.includes('duplicate column name')) {
                            console.error(`Migration error adding ${col.name}:`, err.message);
                        }
                    });
                });

                // Backfill default values for existing cameras
                db.run(`UPDATE cameras SET camera_type = 'rtsp' WHERE camera_type IS NULL`);
                db.run(`UPDATE cameras SET enable_recording = 1 WHERE enable_recording IS NULL`);
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

        // Create Incident Reports Table (Public Reports)
        db.run(`CREATE TABLE IF NOT EXISTS incident_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            camera_id INTEGER,
            category TEXT NOT NULL,
            description TEXT NOT NULL,
            reporter_name TEXT,
            reporter_contact TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            reviewed_at DATETIME,
            reviewed_by TEXT,
            FOREIGN KEY (camera_id) REFERENCES cameras (id)
        )`, (err) => {
            if (err) {
                console.error('Error creating incident_reports table:', err.message);
            } else {
                db.run(`CREATE INDEX IF NOT EXISTS idx_incident_reports_status_created ON incident_reports(status, created_at)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_incident_reports_camera_created ON incident_reports(camera_id, created_at)`);
                // Migration: Add user_id column if missing
                db.run(`ALTER TABLE incident_reports ADD COLUMN user_id INTEGER DEFAULT NULL`, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                        console.error('Migration error adding user_id to incident_reports:', err.message);
                    }
                });
                // Fix: Ensure all status are 'pending' if they are NULL
                db.run(`UPDATE incident_reports SET status = 'pending' WHERE status IS NULL OR status = ''`);
            }
        });

        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            level TEXT NOT NULL DEFAULT 'umum',
            full_name TEXT,
            phone TEXT,
            email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error('Error creating users table:', err.message);
            } else {
                // Migration: Add level column if missing
                db.run(`ALTER TABLE users ADD COLUMN level TEXT NOT NULL DEFAULT 'umum'`, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                        console.error('Migration error adding level to users:', err.message);
                    }
                });
                // Migration: Add email column if missing
                db.run(`ALTER TABLE users ADD COLUMN email TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                        console.error('Migration error adding email to users:', err.message);
                    }
                });
                // Migration: Add full_name column if missing
                db.run(`ALTER TABLE users ADD COLUMN full_name TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                        console.error('Migration error adding full_name to users:', err.message);
                    }
                });
                // Migration: Add phone column if missing
                db.run(`ALTER TABLE users ADD COLUMN phone TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                        console.error('Migration error adding phone to users:', err.message);
                    }
                });
                // Migration: Add address column if missing
                db.run(`ALTER TABLE users ADD COLUMN address TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                        console.error('Migration error adding address to users:', err.message);
                    }
                });
                // Migration: Add active_until column if missing
                db.run(`ALTER TABLE users ADD COLUMN active_until DATETIME`, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                        console.error('Migration error adding active_until to users:', err.message);
                    }
                });

                // Create Billing Packages Table
                db.run(`CREATE TABLE IF NOT EXISTS billing_packages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    level TEXT NOT NULL,
                    price REAL NOT NULL,
                    duration_days INTEGER NOT NULL,
                    description TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`);

                // Create Transactions Table
                db.run(`CREATE TABLE IF NOT EXISTS transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    package_id INTEGER,
                    amount REAL NOT NULL,
                    payment_status TEXT DEFAULT 'pending',
                    payment_method TEXT,
                    proof_image TEXT,
                    bank_info TEXT,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users (id),
                    FOREIGN KEY (package_id) REFERENCES billing_packages (id)
                )`);

                // Migration: Add rejection and review columns if missing
                const transCols = [
                    { name: 'rejection_reason', type: 'TEXT' },
                    { name: 'reviewed_at', type: 'DATETIME' },
                    { name: 'reviewed_by', type: 'TEXT' },
                    { name: 'bank_info', type: 'TEXT' },
                    { name: 'proof_image', type: 'TEXT' }
                ];

                transCols.forEach(col => {
                    db.run(`ALTER TABLE transactions ADD COLUMN ${col.name} ${col.type}`, (err) => {
                        if (err && !err.message.includes('duplicate column name')) {
                            console.error(`Migration error adding ${col.name} to transactions:`, err.message);
                        }
                    });
                });

                // Create Bank Accounts Table
                db.run(`CREATE TABLE IF NOT EXISTS bank_accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    bank_name TEXT NOT NULL,
                    account_number TEXT NOT NULL,
                    account_name TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`);

                // Migration: Standardize existing data levels
                db.run(`UPDATE cameras SET level = 'umum' WHERE level = 'gratis'`);
                db.run(`UPDATE cameras SET level = 'member' WHERE level = 'public'`);
                db.run(`UPDATE users SET level = 'umum' WHERE level = 'gratis'`);
                db.run(`UPDATE users SET level = 'member' WHERE level = 'public'`);
            }
        });

        // Basic Key-Value System Table
        db.run(`CREATE TABLE IF NOT EXISTS system_kv (
            key TEXT PRIMARY KEY,
            value TEXT
        )`);

        // ==========================================
        // CREATE ALERT SYSTEM TABLES (IF NOT EXISTS)
        // ==========================================

        // 1. Alert Rules Table
        db.run(`CREATE TABLE IF NOT EXISTS alert_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            enabled INTEGER DEFAULT 1,
            priority TEXT DEFAULT 'medium',
            conditions TEXT,
            notify_whatsapp INTEGER DEFAULT 1,
            notify_telegram INTEGER DEFAULT 0,
            notify_email INTEGER DEFAULT 0,
            notify_push INTEGER DEFAULT 0,
            notify_customers INTEGER DEFAULT 0,
            whatsapp_numbers TEXT,
            telegram_chat_ids TEXT,
            email_addresses TEXT,
            cooldown_minutes INTEGER DEFAULT 60,
            max_alerts_per_day INTEGER DEFAULT 10,
            check_interval_minutes INTEGER DEFAULT 60,
            active_hours_start TEXT DEFAULT '00:00',
            active_hours_end TEXT DEFAULT '23:59',
            active_days TEXT DEFAULT '1,2,3,4,5,6,7',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by TEXT,
            last_triggered_at DATETIME,
            trigger_count INTEGER DEFAULT 0
        )`, (err) => {
            if (!err) {
                // Ensure notify_customers column exists (Migration if table existed without it)
                db.run(`ALTER TABLE alert_rules ADD COLUMN notify_customers INTEGER DEFAULT 0`, (err) => {
                    // Ignore duplicate column error
                });
            }
        });

        // 2. Alert History Table
        db.run(`CREATE TABLE IF NOT EXISTS alert_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id INTEGER,
            rule_name TEXT,
            alert_type TEXT NOT NULL,
            priority TEXT DEFAULT 'medium',
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            data TEXT,
            camera_id INTEGER,
            camera_name TEXT,
            location TEXT,
            whatsapp_sent INTEGER DEFAULT 0,
            telegram_sent INTEGER DEFAULT 0,
            email_sent INTEGER DEFAULT 0,
            push_sent INTEGER DEFAULT 0,
            whatsapp_status TEXT,
            telegram_status TEXT,
            email_status TEXT,
            push_status TEXT,
            triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            acknowledged INTEGER DEFAULT 0,
            acknowledged_by TEXT,
            acknowledged_at DATETIME,
            notes TEXT,
            FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE SET NULL,
            FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE SET NULL
        )`);

        // 3. Alert Settings Table (Key-Value Schema)
        db.run(`CREATE TABLE IF NOT EXISTS alert_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT UNIQUE NOT NULL,
            value TEXT,
            description TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (!err) {
                // Check if 'key' column exists (Key-Value Schema)
                db.all("PRAGMA table_info(alert_settings)", [], (err, columns) => {
                    if (!err && columns && columns.some(c => c.name === 'key')) {
                        // Insert default settings
                        const defaultSettings = [
                            ['system_enabled', '1', 'Enable/disable entire alert system'],
                            ['default_cooldown', '60', 'Default cooldown in minutes'],
                            ['max_daily_alerts', '50', 'Maximum alerts per day (system-wide)'],
                            ['weather_check_interval', '60', 'Weather check interval in minutes'],
                            ['camera_check_interval', '5', 'Camera status check interval in minutes'],
                            ['storage_check_interval', '30', 'Storage check interval in minutes'],
                            ['motion_sensitivity', 'medium', 'Motion detection sensitivity: low, medium, high'],
                            ['alert_retention_days', '90', 'Days to keep alert history']
                        ];
                        
                        defaultSettings.forEach(set => {
                            db.run(`INSERT OR IGNORE INTO alert_settings (key, value, description) VALUES (?, ?, ?)`, set);
                        });
                    }
                });
            }
        });
    }
});

module.exports = db;
