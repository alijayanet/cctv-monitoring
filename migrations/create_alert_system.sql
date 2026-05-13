-- Migration: Create Alert System Tables
-- Created: 2026-05-13
-- Description: Tables for comprehensive alert system with rules, history, and configurations

-- Table: alert_rules
-- Stores alert rule configurations
CREATE TABLE IF NOT EXISTS alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL, -- 'weather', 'motion', 'camera_offline', 'storage', 'custom'
    enabled INTEGER DEFAULT 1, -- 0 = disabled, 1 = enabled
    priority TEXT DEFAULT 'medium', -- 'low', 'medium', 'high', 'critical'
    
    -- Conditions (JSON string)
    conditions TEXT, -- e.g., {"wave_height": {"operator": ">=", "value": 1.5}}
    
    -- Notification settings
    notify_whatsapp INTEGER DEFAULT 1,
    notify_telegram INTEGER DEFAULT 0,
    notify_email INTEGER DEFAULT 0,
    notify_push INTEGER DEFAULT 0,
    
    -- Recipients (comma-separated)
    whatsapp_numbers TEXT,
    telegram_chat_ids TEXT,
    email_addresses TEXT,
    
    -- Throttling (prevent spam)
    cooldown_minutes INTEGER DEFAULT 60, -- Minimum time between same alerts
    max_alerts_per_day INTEGER DEFAULT 10,
    
    -- Schedule (when to check)
    check_interval_minutes INTEGER DEFAULT 60,
    active_hours_start TEXT DEFAULT '00:00',
    active_hours_end TEXT DEFAULT '23:59',
    active_days TEXT DEFAULT '1,2,3,4,5,6,7', -- 1=Monday, 7=Sunday
    
    -- Metadata
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    last_triggered_at DATETIME,
    trigger_count INTEGER DEFAULT 0
);

-- Table: alert_history
-- Stores all triggered alerts
CREATE TABLE IF NOT EXISTS alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER,
    rule_name TEXT,
    alert_type TEXT NOT NULL,
    priority TEXT DEFAULT 'medium',
    
    -- Alert details
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT, -- JSON string with additional data
    
    -- Source information
    camera_id INTEGER,
    camera_name TEXT,
    location TEXT,
    
    -- Notification status
    whatsapp_sent INTEGER DEFAULT 0,
    telegram_sent INTEGER DEFAULT 0,
    email_sent INTEGER DEFAULT 0,
    push_sent INTEGER DEFAULT 0,
    
    -- Delivery details
    whatsapp_status TEXT,
    telegram_status TEXT,
    email_status TEXT,
    push_status TEXT,
    
    -- Metadata
    triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    acknowledged INTEGER DEFAULT 0,
    acknowledged_by TEXT,
    acknowledged_at DATETIME,
    notes TEXT,
    
    FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE SET NULL,
    FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE SET NULL
);

-- Table: alert_settings
-- Global alert system settings
CREATE TABLE IF NOT EXISTS alert_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value TEXT,
    description TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert default alert settings
INSERT OR IGNORE INTO alert_settings (key, value, description) VALUES
('system_enabled', '1', 'Enable/disable entire alert system'),
('default_cooldown', '60', 'Default cooldown in minutes'),
('max_daily_alerts', '50', 'Maximum alerts per day (system-wide)'),
('weather_check_interval', '60', 'Weather check interval in minutes'),
('camera_check_interval', '5', 'Camera status check interval in minutes'),
('storage_check_interval', '30', 'Storage check interval in minutes'),
('motion_sensitivity', 'medium', 'Motion detection sensitivity: low, medium, high'),
('alert_retention_days', '90', 'Days to keep alert history');

-- Insert default weather alert rule
INSERT OR IGNORE INTO alert_rules (
    name, type, enabled, priority,
    conditions,
    notify_whatsapp, notify_telegram,
    whatsapp_numbers,
    cooldown_minutes, max_alerts_per_day,
    check_interval_minutes,
    created_by
) VALUES (
    'Cuaca Buruk - Ombak Tinggi',
    'weather',
    1,
    'high',
    '{"wave_height":{"operator":">=","value":1.5},"wind_speed":{"operator":">=","value":30}}',
    1,
    0,
    NULL, -- Will use config.json whatsapp.admin_numbers
    360, -- 6 hours cooldown
    4,
    60,
    'system'
);

-- Insert default camera offline alert rule
INSERT OR IGNORE INTO alert_rules (
    name, type, enabled, priority,
    conditions,
    notify_whatsapp, notify_telegram,
    cooldown_minutes, max_alerts_per_day,
    check_interval_minutes,
    created_by
) VALUES (
    'Kamera Offline',
    'camera_offline',
    1,
    'medium',
    '{"offline_duration_minutes":{"operator":">=","value":5}}',
    1,
    0,
    30, -- 30 minutes cooldown
    10,
    5,
    'system'
);

-- Insert default storage alert rule
INSERT OR IGNORE INTO alert_rules (
    name, type, enabled, priority,
    conditions,
    notify_whatsapp, notify_telegram,
    cooldown_minutes, max_alerts_per_day,
    check_interval_minutes,
    created_by
) VALUES (
    'Storage Hampir Penuh',
    'storage',
    1,
    'medium',
    '{"storage_percent":{"operator":">=","value":80}}',
    1,
    0,
    720, -- 12 hours cooldown
    2,
    30,
    'system'
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_alert_rules_type ON alert_rules(type);
CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
CREATE INDEX IF NOT EXISTS idx_alert_history_rule_id ON alert_history(rule_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_type ON alert_history(alert_type);
CREATE INDEX IF NOT EXISTS idx_alert_history_triggered_at ON alert_history(triggered_at);
CREATE INDEX IF NOT EXISTS idx_alert_history_camera_id ON alert_history(camera_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_acknowledged ON alert_history(acknowledged);

-- Create view for recent alerts
CREATE VIEW IF NOT EXISTS v_recent_alerts AS
SELECT 
    ah.*,
    ar.name as rule_name,
    ar.type as rule_type,
    c.nama as camera_name,
    c.lokasi as camera_location
FROM alert_history ah
LEFT JOIN alert_rules ar ON ah.rule_id = ar.id
LEFT JOIN cameras c ON ah.camera_id = c.id
ORDER BY ah.triggered_at DESC
LIMIT 100;

-- Create view for alert statistics
CREATE VIEW IF NOT EXISTS v_alert_stats AS
SELECT 
    alert_type,
    priority,
    COUNT(*) as total_count,
    SUM(CASE WHEN DATE(triggered_at) = DATE('now') THEN 1 ELSE 0 END) as today_count,
    SUM(CASE WHEN DATE(triggered_at) >= DATE('now', '-7 days') THEN 1 ELSE 0 END) as week_count,
    SUM(CASE WHEN acknowledged = 1 THEN 1 ELSE 0 END) as acknowledged_count,
    MAX(triggered_at) as last_triggered
FROM alert_history
GROUP BY alert_type, priority;

-- Made with Bob
