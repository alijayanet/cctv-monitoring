/**
 * Activity Logger Service
 * Mencatat semua aktivitas penting di sistem.
 * Premium professional audit trail
 */

const db = require('../database');

/**
 * Initialize activity_logs table
 */
function initTable() {
    return new Promise((resolve) => {
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
                console.error('[ActivityLogger] Table init error:', err.message);
            } else {
                db.run(`CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON activity_logs(timestamp DESC)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_activity_logs_category ON activity_logs(category)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs(action)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_activity_logs_actor ON activity_logs(actor_name)`);
                console.log('[ActivityLogger] Table & indexes initialized');
            }
            resolve();
        });
    });
}

/**
 * Log an activity
 */
function logActivity(params) {
    return new Promise((resolve) => {
        const {
            action, category = 'general', description = '',
            actor = null, target = null, details = null,
            req = null, status = 'success'
        } = params;
        if (!action) { console.warn('[ActivityLogger] Missing action parameter'); return resolve(null); }

        const actorType = actor?.type || 'system';
        const actorId = actor?.id || null;
        const actorName = actor?.name || 'System';
        const targetType = target?.type || null;
        const targetId = target?.id || null;
        const targetName = target?.name || null;
        const ipAddress = req ? (req.ip || req.connection?.remoteAddress || null) : null;
        const userAgent = req ? (req.headers['user-agent'] || null) : null;
        const detailsJson = details ? JSON.stringify(details) : null;

        db.run(
            `INSERT INTO activity_logs 
            (actor_type, actor_id, actor_name, action, category, target_type, target_id, target_name, description, details, ip_address, user_agent, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [actorType, actorId, actorName, action, category, targetType, targetId, targetName, description, detailsJson, ipAddress, userAgent, status],
            function(err) {
                if (err) { console.error('[ActivityLogger] Insert error:', err.message); return resolve(null); }
                resolve({ id: this.lastID });
            }
        );
    });
}

function getActorFromSession(session) {
    if (session?.user) return { type: 'admin', id: null, name: 'Admin' };
    if (session?.customer) return { type: 'customer', id: session.customer.id, name: session.customer.full_name || session.customer.username };
    return { type: 'system', id: null, name: 'System' };
}

function getActorFromSessionWithName(session, customName) {
    const actor = getActorFromSession(session);
    if (customName) actor.name = customName;
    return actor;
}

/**
 * Get activity logs with pagination and filtering
 */
function getActivityLogs(options = {}) {
    return new Promise((resolve, reject) => {
        const { limit = 50, offset = 0, category = null, action = null, actor_name = null,
                target_type = null, status = null, start_date = null, end_date = null, search = null } = options;
        let where = []; let params = [];
        if (category) { where.push('category = ?'); params.push(category); }
        if (action) { where.push('action LIKE ?'); params.push('%' + action + '%'); }
        if (actor_name) { where.push('actor_name LIKE ?'); params.push('%' + actor_name + '%'); }
        if (target_type) { where.push('target_type = ?'); params.push(target_type); }
        if (status) { where.push('status = ?'); params.push(status); }
        if (start_date) { where.push('timestamp >= ?'); params.push(start_date); }
        if (end_date) { where.push('timestamp <= ?'); params.push(end_date + ' 23:59:59'); }
        if (search) {
            where.push('(description LIKE ? OR actor_name LIKE ? OR target_name LIKE ? OR details LIKE ?)');
            const s = '%' + search + '%'; params.push(s, s, s, s);
        }
        const whereSQL = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

        db.get(`SELECT COUNT(*) as total FROM activity_logs ${whereSQL}`, params, (err, countResult) => {
            if (err) return reject(err);
            db.all(`SELECT * FROM activity_logs ${whereSQL} ORDER BY timestamp DESC LIMIT ? OFFSET ?`, [...params, limit, offset], (err2, rows) => {
                if (err2) return reject(err2);
                resolve({ logs: (rows || []).map(r => ({ ...r, details: r.details ? tryParseJSON(r.details) : null })), total: countResult?.total || 0, limit, offset });
            });
        });
    });
}

/**
 * Get activity statistics
 */
function getActivityStats() {
    return new Promise((resolve, reject) => {
        const stats = {};
        db.get("SELECT COUNT(*) as total FROM activity_logs", [], (err, row) => {
            stats.totalLogs = row?.total || 0;
            db.get("SELECT COUNT(*) as today FROM activity_logs WHERE DATE(timestamp) = DATE('now')", [], (err2, row2) => {
                stats.todayLogs = row2?.today || 0;
                db.get("SELECT COUNT(*) as week FROM activity_logs WHERE timestamp >= datetime('now', '-7 days')", [], (err3, row3) => {
                    stats.weekLogs = row3?.week || 0;
                    db.all("SELECT category, COUNT(*) as count FROM activity_logs GROUP BY category ORDER BY count DESC", [], (err4, rows4) => {
                        stats.byCategory = rows4 || [];
                        db.all("SELECT action, COUNT(*) as count FROM activity_logs GROUP BY action ORDER BY count DESC LIMIT 10", [], (err5, rows5) => {
                            stats.topActions = rows5 || [];
                            db.all("SELECT actor_name, COUNT(*) as count FROM activity_logs GROUP BY actor_name ORDER BY count DESC LIMIT 5", [], (err6, rows6) => {
                                stats.topActors = rows6 || [];
                                db.all("SELECT DATE(timestamp) as date, COUNT(*) as count FROM activity_logs WHERE timestamp >= datetime('now', '-30 days') GROUP BY DATE(timestamp) ORDER BY date", [], (err7, rows7) => {
                                    stats.daily30 = rows7 || [];
                                    resolve(stats);
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

/**
 * Clean old logs (keep last N days)
 */
function cleanOldLogs(retentionDays = 90) {
    return new Promise((resolve) => {
        db.run("DELETE FROM activity_logs WHERE timestamp < datetime('now', ?)", [`-${retentionDays} days`], function(err) {
            if (err) { console.error('[ActivityLogger] Clean error:', err.message); return resolve({ deleted: 0 }); }
            resolve({ deleted: this.changes || 0 });
        });
    });
}

/**
 * Reset ALL activity logs - HARD RESET with journal mode switching
 * This uses a serialized approach with PRAGMA to force WAL flush
 */
function resetAllLogs() {
    return new Promise((resolve) => {
        console.log('[ActivityLogger] Starting hard reset...');
        
        // Use db.serialize to ensure sequential execution
        db.serialize(() => {
            // Step 1: Force checkpoint to flush WAL
            db.run("PRAGMA wal_checkpoint(TRUNCATE)", (err) => {
                if (err) console.error('[ActivityLogger] checkpoint error:', err?.message);
            });

            // Step 2: Temporarily switch to DELETE journal mode for immediate effect
            db.run("PRAGMA journal_mode=DELETE", (err) => {
                if (err) console.error('[ActivityLogger] journal mode switch error:', err?.message);
            });

            // Step 3: DELETE all rows
            db.run("DELETE FROM activity_logs", (err) => {
                if (err) {
                    console.error('[ActivityLogger] Delete failed:', err.message);
                    // Switch back to WAL before resolving
                    db.run("PRAGMA journal_mode=WAL");
                    return resolve({ deleted: 0, success: false, error: err.message });
                }
            });

            // Step 4: Verify
            db.get("SELECT COUNT(*) as total FROM activity_logs", (err, row) => {
                const remaining = row?.total || 0;
                console.log(`[ActivityLogger] After DELETE, remaining: ${remaining}`);
                
                // Step 5: Switch back to WAL mode
                db.run("PRAGMA journal_mode=WAL", (err) => {
                    if (err) console.error('[ActivityLogger] WAL revert error:', err?.message);
                });

                // Step 6: Vacuum
                db.run("VACUUM", (err) => {
                    if (err) console.error('[ActivityLogger] Vacuum error:', err?.message);
                });

                // Step 7: Verify one more time after vacuum
                db.get("SELECT COUNT(*) as total FROM activity_logs", (err2, row2) => {
                    const final = row2?.total || 0;
                    console.log(`[ActivityLogger] Reset complete. Final count: ${final}`);
                    resolve({ deleted: true, success: true, remaining: final, method: 'hard_reset' });
                });
            });
        });
    });
}

function tryParseJSON(str) {
    try { return JSON.parse(str); } catch (e) { return str; }
}

module.exports = {
    initTable, logActivity, getActorFromSession, getActorFromSessionWithName,
    getActivityLogs, getActivityStats, cleanOldLogs, resetAllLogs
};