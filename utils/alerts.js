/**
 * Alert System Utility Module
 * Handles alert rule evaluation, notification sending, and alert history
 */

const db = require('../database');

class AlertSystem {
    constructor(config, whatsappBot, telegramBot) {
        this.config = config;
        this.whatsappBot = whatsappBot;
        this.telegramBot = telegramBot;
        this.checkIntervals = new Map();
        this.alertCounters = new Map(); // Track daily alert counts
    }

    /**
     * Initialize alert system and start monitoring
     */
    async initialize() {
        console.log('[Alert System] Initializing...');
        
        // Check if system is enabled
        const enabled = await this.getSetting('system_enabled');
        if (enabled !== '1') {
            console.log('[Alert System] Disabled in settings');
            return;
        }

        // Load and start all enabled rules
        const rules = await this.getEnabledRules();
        console.log(`[Alert System] Found ${rules.length} enabled rules`);

        for (const rule of rules) {
            this.startRuleMonitoring(rule);
        }

        // Start cleanup job (runs daily)
        this.startCleanupJob();
        
        console.log('[Alert System] Initialized successfully');
    }

    /**
     * Load all rules from database (for dynamic reload)
     */
    async loadRules() {
        console.log('[Alert System] Reloading rules...');
        
        // Stop all existing intervals
        for (const [ruleId, interval] of this.checkIntervals.entries()) {
            clearInterval(interval);
            this.checkIntervals.delete(ruleId);
        }
        
        // Load and start all enabled rules
        const rules = await this.getEnabledRules();
        console.log(`[Alert System] Loaded ${rules.length} enabled rules`);
        
        for (const rule of rules) {
            this.startRuleMonitoring(rule);
        }
    }

    /**
     * Load settings from database (for dynamic reload)
     */
    async loadSettings() {
        console.log('[Alert System] Reloading settings...');
        // Settings are loaded on-demand, so just log
        const enabled = await this.getSetting('system_enabled');
        console.log(`[Alert System] System enabled: ${enabled === '1'}`);
    }

    /**
     * Get setting value from database
     */
    async getSetting(key) {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM alert_settings WHERE id = 1', [], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row[key] : null);
            });
        });
    }

    /**
     * Get all enabled alert rules
     */
    async getEnabledRules() {
        return new Promise((resolve, reject) => {
            db.all('SELECT * FROM alert_rules WHERE enabled = 1', (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    /**
     * Start monitoring for a specific rule
     */
    startRuleMonitoring(rule) {
        // Clear existing interval if any
        if (this.checkIntervals.has(rule.id)) {
            clearInterval(this.checkIntervals.get(rule.id));
        }

        const intervalMs = (rule.check_interval_minutes || 60) * 60 * 1000;
        
        // Run immediately
        this.checkRule(rule);

        // Then run on interval
        const intervalId = setInterval(() => {
            this.checkRule(rule);
        }, intervalMs);

        this.checkIntervals.set(rule.id, intervalId);
        console.log(`[Alert System] Started monitoring rule: ${rule.name} (every ${rule.check_interval_minutes}min)`);
    }

    /**
     * Stop monitoring for a specific rule
     */
    stopRuleMonitoring(ruleId) {
        if (this.checkIntervals.has(ruleId)) {
            clearInterval(this.checkIntervals.get(ruleId));
            this.checkIntervals.delete(ruleId);
            console.log(`[Alert System] Stopped monitoring rule ID: ${ruleId}`);
        }
    }

    /**
     * Check if rule should trigger
     */
    async checkRule(rule) {
        try {
            // Check if within active hours
            if (!this.isWithinActiveHours(rule)) {
                return;
            }

            // Check if within active days
            if (!this.isWithinActiveDays(rule)) {
                return;
            }

            // Check cooldown
            if (!await this.canTrigger(rule)) {
                return;
            }

            // Evaluate rule based on type
            let shouldTrigger = false;
            let alertData = {};

            switch (rule.type) {
                case 'weather':
                    ({ shouldTrigger, data: alertData } = await this.checkWeatherRule(rule));
                    break;
                case 'camera_offline':
                    ({ shouldTrigger, data: alertData } = await this.checkCameraOfflineRule(rule));
                    break;
                case 'storage':
                    ({ shouldTrigger, data: alertData } = await this.checkStorageRule(rule));
                    break;
                case 'motion':
                    ({ shouldTrigger, data: alertData } = await this.checkMotionRule(rule));
                    break;
                default:
                    console.log(`[Alert System] Unknown rule type: ${rule.type}`);
                    return;
            }

            if (shouldTrigger) {
                await this.triggerAlert(rule, alertData);
            }
        } catch (error) {
            console.error(`[Alert System] Error checking rule ${rule.name}:`, error.message);
        }
    }

    /**
     * Check if current time is within active hours
     */
    isWithinActiveHours(rule) {
        const now = new Date();
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        
        const start = rule.active_hours_start || '00:00';
        const end = rule.active_hours_end || '23:59';

        return currentTime >= start && currentTime <= end;
    }

    /**
     * Check if current day is within active days
     */
    isWithinActiveDays(rule) {
        const now = new Date();
        const dayOfWeek = now.getDay() || 7; // Convert Sunday from 0 to 7
        const activeDays = (rule.active_days || '1,2,3,4,5,6,7').split(',').map(d => parseInt(d));
        
        return activeDays.includes(dayOfWeek);
    }

    /**
     * Check if rule can trigger (cooldown and daily limit)
     */
    async canTrigger(rule) {
        // Check cooldown
        if (rule.last_triggered_at) {
            const lastTrigger = new Date(rule.last_triggered_at);
            const cooldownMs = (rule.cooldown_minutes || 60) * 60 * 1000;
            const timeSinceLastTrigger = Date.now() - lastTrigger.getTime();
            
            if (timeSinceLastTrigger < cooldownMs) {
                return false;
            }
        }

        // Check daily limit
        const today = new Date().toISOString().split('T')[0];
        const countKey = `${rule.id}_${today}`;
        const currentCount = this.alertCounters.get(countKey) || 0;
        
        if (currentCount >= (rule.max_alerts_per_day || 10)) {
            return false;
        }

        return true;
    }

    /**
     * Check weather rule conditions
     */
    async checkWeatherRule(rule) {
        try {
            const conditions = JSON.parse(rule.conditions || '{}');
            
            // Get weather data using fetch to /api/weather endpoint
            const refLat = this.config.map?.default_lat || -0.8173;
            const refLng = this.config.map?.default_lng || 103.4616;
            
            const response = await fetch(`http://localhost:${this.config.server?.port || 3003}/api/weather?lat=${refLat}&lng=${refLng}`);
            const result = await response.json();
            
            if (!result.success) {
                console.error('[Alert System] Weather API failed:', result.message);
                return { shouldTrigger: false };
            }
            
            const weather = result.data;
            if (!weather) return { shouldTrigger: false };

            let triggered = false;
            const issues = [];
            const data = {
                location: 'Default Location',
                latitude: refLat,
                longitude: refLng
            };

            // Check wave height
            if (conditions.wave_height && weather.marine_hourly?.wave_height) {
                const waveHeight = weather.marine_hourly.wave_height[0];
                if (this.evaluateCondition(waveHeight, conditions.wave_height)) {
                    triggered = true;
                    issues.push(`🌊 Ombak: ${waveHeight.toFixed(1)} m`);
                    data.wave_height = waveHeight;
                }
            }

            // Check wind speed
            if (conditions.wind_speed && weather.current?.wind_speed_10m) {
                const windSpeed = weather.current.wind_speed_10m;
                if (this.evaluateCondition(windSpeed, conditions.wind_speed)) {
                    triggered = true;
                    issues.push(`💨 Angin: ${Math.round(windSpeed)} km/h`);
                    data.wind_speed = windSpeed;
                }
            }

            // Check ocean current
            if (conditions.ocean_current && weather.marine_hourly?.ocean_current_velocity) {
                const current = weather.marine_hourly.ocean_current_velocity[0];
                if (this.evaluateCondition(current, conditions.ocean_current)) {
                    triggered = true;
                    issues.push(`🌀 Arus: ${current.toFixed(1)} m/s`);
                    data.ocean_current = current;
                }
            }

            data.issues = issues;
            return { shouldTrigger: triggered, data };
        } catch (error) {
            console.error('[Alert System] Error checking weather rule:', error.message);
            return { shouldTrigger: false };
        }
    }

    /**
     * Check camera offline rule
     */
    async checkCameraOfflineRule(rule) {
        return new Promise((resolve) => {
            // Camera offline detection disabled for now
            // TODO: Integrate with cameraStatus from index.js
            // The cameras table doesn't have last_check_at column
            resolve({ shouldTrigger: false });
        });
    }

    /**
     * Check storage rule
     */
    async checkStorageRule(rule) {
        try {
            const conditions = JSON.parse(rule.conditions || '{}');
            const threshold = conditions.storage_percent?.value || 80;

            // Get disk usage
            const diskUsage = await this.getDiskUsage();
            
            if (diskUsage.percent >= threshold) {
                return {
                    shouldTrigger: true,
                    data: {
                        used_percent: diskUsage.percent,
                        used_gb: diskUsage.used,
                        total_gb: diskUsage.total,
                        available_gb: diskUsage.available
                    }
                };
            }

            return { shouldTrigger: false };
        } catch (error) {
            console.error('[Alert System] Error checking storage:', error.message);
            return { shouldTrigger: false };
        }
    }

    /**
     * Check motion detection rule
     */
    async checkMotionRule(rule) {
        // Placeholder for motion detection
        // This would integrate with MediaMTX or external motion detection system
        return { shouldTrigger: false };
    }

    /**
     * Evaluate a condition
     */
    evaluateCondition(value, condition) {
        const operator = condition.operator || '>=';
        const threshold = condition.value;

        switch (operator) {
            case '>=': return value >= threshold;
            case '>': return value > threshold;
            case '<=': return value <= threshold;
            case '<': return value < threshold;
            case '==': return value == threshold;
            case '!=': return value != threshold;
            default: return false;
        }
    }

    /**
     * Trigger an alert
     */
    async triggerAlert(rule, alertData) {
        console.log(`[Alert System] Triggering alert: ${rule.name}`);

        // Generate alert message
        const message = this.generateAlertMessage(rule, alertData);
        
        // Save to history
        const historyId = await this.saveAlertHistory(rule, alertData, message);

        // Send notifications
        const notifications = {
            whatsapp: false,
            telegram: false
        };

        if (rule.notify_whatsapp) {
            notifications.whatsapp = await this.sendWhatsAppNotification(rule, message);
        }

        if (rule.notify_telegram) {
            notifications.telegram = await this.sendTelegramNotification(rule, message);
        }

        // Update notification status in history
        await this.updateNotificationStatus(historyId, notifications);

        // Update rule trigger info
        await this.updateRuleTriggerInfo(rule.id);

        // Update daily counter
        const today = new Date().toISOString().split('T')[0];
        const countKey = `${rule.id}_${today}`;
        this.alertCounters.set(countKey, (this.alertCounters.get(countKey) || 0) + 1);
    }

    /**
     * Generate alert message
     */
    generateAlertMessage(rule, data) {
        let message = `⚠️ *${rule.name.toUpperCase()}* ⚠️\n\n`;

        switch (rule.type) {
            case 'weather':
                message += `📍 Lokasi: ${data.location}\n`;
                message += `🗓️ Waktu: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB\n\n`;
                if (data.issues && data.issues.length > 0) {
                    message += data.issues.join('\n') + '\n\n';
                }
                message += `⚠️ Saran: Tunda aktivitas laut jika memungkinkan.\n`;
                break;

            case 'camera_offline':
                message += `📹 Kamera Offline: ${data.count} kamera\n\n`;
                data.offline_cameras.slice(0, 5).forEach(cam => {
                    message += `• ${cam.name} (${cam.offline_minutes} menit)\n`;
                });
                if (data.count > 5) {
                    message += `\n... dan ${data.count - 5} kamera lainnya\n`;
                }
                break;

            case 'storage':
                message += `💾 Storage: ${data.used_percent.toFixed(1)}% terpakai\n`;
                message += `📊 Digunakan: ${data.used_gb.toFixed(1)} GB / ${data.total_gb.toFixed(1)} GB\n`;
                message += `📉 Tersedia: ${data.available_gb.toFixed(1)} GB\n\n`;
                message += `⚠️ Segera hapus rekaman lama atau tambah storage.\n`;
                break;
        }

        message += `\n- ${this.config.site?.title || 'CCTV Monitoring System'}`;
        return message;
    }

    /**
     * Save alert to history
     */
    async saveAlertHistory(rule, data, message) {
        return new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO alert_history (
                    rule_id, rule_name, alert_type, priority,
                    title, message, data,
                    camera_id, camera_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                rule.id,
                rule.name,
                rule.type,
                rule.priority,
                rule.name,
                message,
                JSON.stringify(data),
                data.camera_id || null,
                data.camera_name || null
            ], function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            });
        });
    }

    /**

    /**
     * Get active customer phone numbers
     */
    async getCustomerPhones() {
        return new Promise((resolve, reject) => {
            db.all(`
                SELECT phone FROM users 
                WHERE level = 'customer' 
                AND phone IS NOT NULL 
                AND phone != ''
                AND (active_until IS NULL OR active_until >= date('now'))
            `, [], (err, rows) => {
                if (err) {
                    console.error('[Alert System] Error fetching customer phones:', err.message);
                    resolve([]);
                } else {
                    resolve(rows.map(r => r.phone).filter(p => p));
                }
            });
        });
    }
    /**
     * Send WhatsApp notification
     */
    async sendWhatsAppNotification(rule, message) {
        try {
            if (!this.whatsappBot) return false;

            // Get admin numbers
            const adminNumbers = rule.whatsapp_numbers
                ? rule.whatsapp_numbers.split(',').map(n => n.trim())
                : (this.config.whatsapp?.admin_numbers || []);

            let numbers = Array.isArray(adminNumbers) ? adminNumbers : adminNumbers.split(',').map(n => n.trim());

            // Add customer numbers if enabled
            if (rule.notify_customers) {
                const customerPhones = await this.getCustomerPhones();
                numbers = [...numbers, ...customerPhones];
                console.log(`[Alert System] Sending to ${numbers.length} recipients (${adminNumbers.length} admin + ${customerPhones.length} customers)`);
            } else {
                console.log(`[Alert System] Sending to ${numbers.length} admin recipients only`);
            }

            // Send to all recipients
            for (const number of numbers) {
                if (number) {
                    await this.whatsappBot.sendWA(number, message);
                }
            }

            return true;
        } catch (error) {
            console.error('[Alert System] WhatsApp notification failed:', error.message);
            return false;
        }
    }

    /**
     * Send Telegram notification
     */
    async sendTelegramNotification(rule, message) {
        try {
            if (!this.telegramBot) return false;

            const chatIds = rule.telegram_chat_ids
                ? rule.telegram_chat_ids.split(',').map(id => id.trim())
                : [this.config.telegram?.chat_id];

            for (const chatId of chatIds) {
                if (chatId) {
                    await this.telegramBot.sendMessage(chatId, message);
                }
            }

            return true;
        } catch (error) {
            console.error('[Alert System] Telegram notification failed:', error.message);
            return false;
        }
    }

    /**
     * Update notification status in history
     */
    async updateNotificationStatus(historyId, notifications) {
        return new Promise((resolve) => {
            db.run(`
                UPDATE alert_history 
                SET whatsapp_sent = ?, telegram_sent = ?
                WHERE id = ?
            `, [
                notifications.whatsapp ? 1 : 0,
                notifications.telegram ? 1 : 0,
                historyId
            ], () => resolve());
        });
    }

    /**
     * Update rule trigger information
     */
    async updateRuleTriggerInfo(ruleId) {
        return new Promise((resolve) => {
            db.run(`
                UPDATE alert_rules 
                SET last_triggered_at = CURRENT_TIMESTAMP,
                    trigger_count = trigger_count + 1
                WHERE id = ?
            `, [ruleId], () => resolve());
        });
    }

    /**
     * Get disk usage
     */
    async getDiskUsage() {
        const { execSync } = require('child_process');
        const os = require('os');

        try {
            if (os.platform() === 'win32') {
                // Windows
                const output = execSync('wmic logicaldisk get size,freespace,caption').toString();
                const lines = output.trim().split('\n').slice(1);
                const drives = lines.map(line => {
                    const parts = line.trim().split(/\s+/);
                    return {
                        drive: parts[0],
                        free: parseInt(parts[1]) || 0,
                        total: parseInt(parts[2]) || 0
                    };
                }).filter(d => d.total > 0);

                const mainDrive = drives[0];
                const used = mainDrive.total - mainDrive.free;
                const percent = (used / mainDrive.total) * 100;

                return {
                    total: mainDrive.total / (1024 ** 3),
                    used: used / (1024 ** 3),
                    available: mainDrive.free / (1024 ** 3),
                    percent: percent
                };
            } else {
                // Linux/Unix
                const output = execSync('df -k /').toString();
                const lines = output.trim().split('\n');
                const data = lines[1].trim().split(/\s+/);
                
                const total = parseInt(data[1]) * 1024;
                const used = parseInt(data[2]) * 1024;
                const available = parseInt(data[3]) * 1024;
                const percent = parseFloat(data[4]);

                return {
                    total: total / (1024 ** 3),
                    used: used / (1024 ** 3),
                    available: available / (1024 ** 3),
                    percent: percent
                };
            }
        } catch (error) {
            console.error('[Alert System] Error getting disk usage:', error.message);
            return { total: 0, used: 0, available: 0, percent: 0 };
        }
    }

    /**
     * Start cleanup job to remove old alerts
     */
    startCleanupJob() {
        // Run cleanup daily at 3 AM
        const runCleanup = async () => {
            try {
                const retentionDays = await this.getSetting('alert_retention_days') || 90;
                
                db.run(`
                    DELETE FROM alert_history 
                    WHERE triggered_at < datetime('now', '-${retentionDays} days')
                `, (err) => {
                    if (err) {
                        console.error('[Alert System] Cleanup failed:', err.message);
                    } else {
                        console.log(`[Alert System] Cleaned up alerts older than ${retentionDays} days`);
                    }
                });
            } catch (error) {
                console.error('[Alert System] Cleanup error:', error.message);
            }
        };

        // Calculate time until next 3 AM
        const now = new Date();
        const next3AM = new Date(now);
        next3AM.setHours(3, 0, 0, 0);
        if (next3AM <= now) {
            next3AM.setDate(next3AM.getDate() + 1);
        }
        const msUntil3AM = next3AM.getTime() - now.getTime();

        // Schedule first cleanup
        setTimeout(() => {
            runCleanup();
            // Then run daily
            setInterval(runCleanup, 24 * 60 * 60 * 1000);
        }, msUntil3AM);

        console.log('[Alert System] Cleanup job scheduled for 3 AM daily');
    }

    /**
     * Shutdown alert system
     */
    shutdown() {
        console.log('[Alert System] Shutting down...');
        for (const [ruleId, intervalId] of this.checkIntervals) {
            clearInterval(intervalId);
        }
        this.checkIntervals.clear();
        console.log('[Alert System] Shutdown complete');
    }
}

module.exports = AlertSystem;

// Made with Bob
