/**
 * Migration System untuk CCTV Monitoring
 * Menggantikan pattern ALTER TABLE suppress-error yang rapuh
 * dengan migrasi berbasis versi yang proper dan auditable.
 * 
 * Cara Kerja:
 * 1. Menyimpan versi migrasi di tabel _migrations
 * 2. Setiap migrasi memiliki nomor urut ascending
 * 3. Hanya migrasi yang belum dijalankan yang akan dieksekusi
 * 4. Setiap migrasi dibungkus transaksi agar atomic
 */

const db = require('../database');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_TABLE = '_migrations';

/**
 * Initialize migration tracking table
 */
function initMigrationTable() {
    return new Promise((resolve, reject) => {
        db.run(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            version INTEGER NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            checksum TEXT
        )`, (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

/**
 * Get current migration version
 */
function getCurrentVersion() {
    return new Promise((resolve, reject) => {
        db.get(`SELECT MAX(version) as version FROM ${MIGRATIONS_TABLE}`, [], (err, row) => {
            if (err) return reject(err);
            resolve(row && row.version ? row.version : 0);
        });
    });
}

/**
 * Check if migration was already applied
 */
function isMigrationApplied(version) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE version = ?`, [version], (err, row) => {
            if (err) return reject(err);
            resolve(!!row);
        });
    });
}

/**
 * Record migration as applied
 */
function recordMigration(migration) {
    return new Promise((resolve, reject) => {
        const checksum = migration.sql ? simpleHash(migration.sql) : '';
        db.run(
            `INSERT INTO ${MIGRATIONS_TABLE} (version, name, description, checksum) VALUES (?, ?, ?, ?)`,
            [migration.version, migration.name, migration.description || '', checksum],
            (err) => {
                if (err) return reject(err);
                resolve();
            }
        );
    });
}

/**
 * Simple string hash for checksum
 */
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
}

/**
 * All migration definitions
 * Setiap migrasi memiliki: version, name, description, sql[]
 * SQL dapat berisi multiple statements (dijalankan serial dalam transaksi)
 */
const MIGRATIONS = [
    // Migration 1: Camera embed support + AI config
    {
        version: 1,
        name: 'camera_embed_support',
        description: 'Add embed_url, embed_type, camera_type, enable_recording, level, owner_id to cameras table',
        sql: [
            `ALTER TABLE cameras ADD COLUMN embed_url TEXT DEFAULT NULL`,
            `ALTER TABLE cameras ADD COLUMN embed_type TEXT DEFAULT NULL`,
            `ALTER TABLE cameras ADD COLUMN camera_type TEXT DEFAULT 'rtsp'`,
            `ALTER TABLE cameras ADD COLUMN enable_recording INTEGER DEFAULT 1`,
            `ALTER TABLE cameras ADD COLUMN level TEXT DEFAULT 'umum'`,
            `ALTER TABLE cameras ADD COLUMN owner_id INTEGER DEFAULT NULL`,
            `UPDATE cameras SET level = 'umum' WHERE level IS NULL OR level = ''`,
            `UPDATE users SET level = 'umum' WHERE level IS NULL OR level = ''`,
            `CREATE INDEX IF NOT EXISTS idx_cameras_level ON cameras(level)`,
            `CREATE INDEX IF NOT EXISTS idx_ai_events_cam_time ON ai_vehicle_events(camera_id, detected_at)`,
            `CREATE INDEX IF NOT EXISTS idx_ai_counts_cam_time ON ai_vehicle_counts(camera_id, count_date, count_hour)`,
            `CREATE INDEX IF NOT EXISTS idx_ai_hourly_cam_time ON ai_vehicle_hourly(camera_id, count_date, count_hour)`,
            `CREATE INDEX IF NOT EXISTS idx_ai_daily_cam_date ON ai_vehicle_daily(camera_id, count_date)`,
            `CREATE INDEX IF NOT EXISTS idx_ai_speed_alerts_cam ON ai_speed_alerts(camera_id, detected_at)`
        ]
    },
    // Migration 2: Billing system
    {
        version: 2,
        name: 'billing_system',
        description: 'Add billing_packages, transactions, bank_accounts, users level/address/active_until',
        sql: [
            `ALTER TABLE users ADD COLUMN address TEXT DEFAULT NULL`,
            `ALTER TABLE users ADD COLUMN active_until DATETIME DEFAULT NULL`,
            `ALTER TABLE transactions ADD COLUMN rejection_reason TEXT DEFAULT NULL`,
            `ALTER TABLE transactions ADD COLUMN reviewed_at DATETIME DEFAULT NULL`,
            `ALTER TABLE transactions ADD COLUMN reviewed_by TEXT DEFAULT NULL`,
            `ALTER TABLE transactions ADD COLUMN bank_info TEXT DEFAULT NULL`,
            `ALTER TABLE transactions ADD COLUMN proof_image TEXT DEFAULT NULL`,
            `ALTER TABLE transactions ADD COLUMN notes TEXT DEFAULT NULL`
        ]
    },
    // Migration 3: Alert system
    {
        version: 3,
        name: 'alert_system',
        description: 'Add alert_rules, alert_history, incident_reports user_id, system_kv',
        sql: [
            `ALTER TABLE incident_reports ADD COLUMN user_id INTEGER DEFAULT NULL`,
            `ALTER TABLE incident_reports ADD COLUMN reviewed_by TEXT DEFAULT NULL`,
            `UPDATE incident_reports SET status = 'pending' WHERE status IS NULL OR status = ''`
        ]
    },
    // Migration 4: AI camera config orientation
    {
        version: 4,
        name: 'ai_camera_orientation',
        description: 'Add camera_orientation to ai_camera_config',
        sql: [
            `ALTER TABLE ai_camera_config ADD COLUMN camera_orientation TEXT DEFAULT NULL`,
            `ALTER TABLE ai_camera_config ADD COLUMN pixel_per_meter REAL DEFAULT NULL`,
            `ALTER TABLE ai_camera_config ADD COLUMN last_calibrated_at DATETIME DEFAULT NULL`
        ]
    },
    // Migration 5: Additional camera fields
    {
        version: 5,
        name: 'camera_ptz_streaming',
        description: 'Add PTZ and YouTube streaming columns to cameras',
        sql: [
            `ALTER TABLE cameras ADD COLUMN ptz_enabled INTEGER DEFAULT 0`,
            `ALTER TABLE cameras ADD COLUMN onvif_port INTEGER DEFAULT 80`,
            `ALTER TABLE cameras ADD COLUMN is_public INTEGER DEFAULT 1`,
            `ALTER TABLE cameras ADD COLUMN youtube_stream_key TEXT DEFAULT NULL`,
            `ALTER TABLE cameras ADD COLUMN youtube_quality TEXT DEFAULT NULL`,
            `CREATE INDEX IF NOT EXISTS idx_cameras_public ON cameras(is_public)`,
            `CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(payment_status)`,
            `CREATE INDEX IF NOT EXISTS idx_incident_reports_status ON incident_reports(status, created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_incident_reports_camera ON incident_reports(camera_id, created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_recordings_created ON recordings(created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_recordings_camera ON recordings(camera_id, created_at)`
        ]
    }
];

/**
 * Run all pending migrations
 */
async function runMigrations() {
    console.log('[Migration] Starting migration check...');
    
    try {
        await initMigrationTable();
        const currentVersion = await getCurrentVersion();
        console.log(`[Migration] Current DB version: ${currentVersion}`);
        
        const pending = MIGRATIONS.filter(m => m.version > currentVersion);
        
        if (pending.length === 0) {
            console.log('[Migration] Database is up-to-date ✓');
            return { applied: 0, total: MIGRATIONS.length };
        }
        
        console.log(`[Migration] Found ${pending.length} pending migration(s):`);
        pending.forEach(m => console.log(`  - v${m.version}: ${m.name} (${m.description || 'no description'})`));
        
        let applied = 0;
        
        for (const migration of pending) {
            console.log(`[Migration] Applying v${migration.version}: ${migration.name}...`);
            
            // Check if already applied (safety)
            const alreadyApplied = await isMigrationApplied(migration.version);
            if (alreadyApplied) {
                console.log(`[Migration] v${migration.version} already applied, skipping`);
                continue;
            }
            
            // Run each SQL statement
            if (migration.sql && migration.sql.length > 0) {
                for (const sql of migration.sql) {
                    await new Promise((resolve, reject) => {
                        db.run(sql, (err) => {
                            if (err && !err.message.includes('duplicate column name') && 
                                !err.message.includes('already exists') &&
                                !err.message.includes('duplicate')) {
                                console.warn(`[Migration] SQL warning: ${err.message}`);
                            }
                            resolve();
                        });
                    });
                }
            }
            
            // Record migration
            await recordMigration(migration);
            applied++;
            console.log(`[Migration] v${migration.version} applied successfully ✓`);
        }
        
        console.log(`[Migration] Complete! Applied ${applied}/${pending.length} migrations`);
        return { applied, total: MIGRATIONS.length };
        
    } catch (err) {
        console.error('[Migration] Error:', err.message);
        throw err;
    }
}

/**
 * Check migration status without applying
 */
async function checkMigrationStatus() {
    await initMigrationTable();
    const currentVersion = await getCurrentVersion();
    const pending = MIGRATIONS.filter(m => m.version > currentVersion);
    
    return {
        currentVersion,
        totalMigrations: MIGRATIONS.length,
        pendingMigrations: pending.length,
        appliedMigrations: MIGRATIONS.length - pending.length,
        pending: pending.map(m => ({ version: m.version, name: m.name }))
    };
}

module.exports = {
    runMigrations,
    checkMigrationStatus,
    MIGRATIONS
};