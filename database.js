const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'cameras.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');

        // Enable WAL mode for better concurrent read/write performance
        db.run('PRAGMA journal_mode=WAL');
        db.run('PRAGMA synchronous=NORMAL');
        db.run('PRAGMA cache_size=-8000');  // 8MB cache
        db.run('PRAGMA busy_timeout=5000');
        db.run('PRAGMA temp_store=MEMORY');
        db.run('PRAGMA mmap_size=30000000');
        db.run('PRAGMA page_size=4096');

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
                // Add PTZ and YouTube columns if missing
                const ptzColumns = [
                    { name: 'ptz_enabled', type: 'INTEGER DEFAULT 0' },
                    { name: 'onvif_port', type: 'INTEGER DEFAULT 80' },
                    { name: 'is_public', type: 'INTEGER DEFAULT 1' },
                    { name: 'youtube_stream_key', type: 'TEXT DEFAULT NULL' },
                    { name: 'youtube_quality', type: 'TEXT DEFAULT NULL' },
                    { name: 'level', type: "TEXT DEFAULT 'umum'" },
                    { name: 'owner_id', type: 'INTEGER DEFAULT NULL' }
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
                db.run(`CREATE INDEX IF NOT EXISTS idx_recordings_file_path ON recordings(file_path)`);
                db.run(`ALTER TABLE recordings ADD COLUMN title TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                        console.error('Migration error adding title to recordings:', err.message);
                    }
                });
                db.run(`ALTER TABLE recordings ADD COLUMN notes TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                        console.error('Migration error adding notes to recordings:', err.message);
                    }
                });
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

        db.run(`CREATE TABLE IF NOT EXISTS system_kv (
            key TEXT PRIMARY KEY,
            value TEXT
        )`);

        // Create activity_logs table
        db.run(`CREATE TABLE IF NOT EXISTS activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            actor_type TEXT NOT NULL DEFAULT 'admin',
            actor_id INTEGER,
            actor_name TEXT,
            action TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'general',
            target_type TEXT,
            target_id INTEGER,
            target_name TEXT,
            description TEXT,
            details TEXT,
            ip_address TEXT,
            user_agent TEXT,
            status TEXT DEFAULT 'success'
        )`, (err) => {
            if (err) {
                console.error('[DB] activity_logs table error:', err.message);
            } else {
                db.run(`CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON activity_logs(timestamp DESC)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_activity_logs_category ON activity_logs(category)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs(action)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_activity_logs_actor ON activity_logs(actor_name)`);
            }
        });

        // Create Alert System Tables
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
            if (err && !err.message.includes('already exists')) {
                console.error('[DB] alert_rules table error:', err.message);
            }
        });

        db.run(`CREATE TABLE IF NOT EXISTS alert_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id INTEGER,
            alert_message TEXT,
            severity TEXT DEFAULT 'info',
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            sent_via TEXT,
            recipient TEXT,
            status TEXT DEFAULT 'sent',
            FOREIGN KEY (rule_id) REFERENCES alert_rules (id)
        )`, (err) => {
            if (err && !err.message.includes('already exists')) {
                console.error('[DB] alert_history table error:', err.message);
            }
        });

        db.run(`CREATE TABLE IF NOT EXISTS alert_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )`, (err) => {
            if (err && !err.message.includes('already exists')) {
                console.error('[DB] alert_settings table error:', err.message);
            }
        });

        // Create Migration tracking table
        db.run(`CREATE TABLE IF NOT EXISTS _migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            version INTEGER NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            checksum TEXT
        )`, (err) => {
            if (err && !err.message.includes('already exists')) {
                console.error('[DB] _migrations table error:', err.message);
            }
        });
    }
});

module.exports = db;
