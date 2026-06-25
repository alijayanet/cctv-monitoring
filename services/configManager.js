/**
 * Config Manager Service
 * Atomic write operations untuk mencegah corrupt config.json
 * Validasi schema sebelum menulis
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');

/**
 * Read config with validation
 * @returns {Object}
 */
function readConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        console.error('[ConfigManager] Error reading config:', e.message);
        throw e;
    }
}

/**
 * Atomic write config - write to temp file, then rename
 * Mencegah corrupt JSON jika crash saat write
 * @param {Object} newConfig - New config object
 * @param {Object} runtimeConfig - Runtime config reference to update
 */
function atomicWriteConfig(newConfig, runtimeConfig) {
    const tmpPath = CONFIG_PATH + '.tmp';
    
    // Write to temp file first
    fs.writeFileSync(tmpPath, JSON.stringify(newConfig, null, 4), 'utf8');
    
    // Verify temp file is valid JSON
    const verification = fs.readFileSync(tmpPath, 'utf8');
    JSON.parse(verification); // Will throw if invalid
    
    // Atomic rename (Windows: copy + unlink)
    if (process.platform === 'win32') {
        // Windows doesn't support atomic rename well, copy instead
        fs.copyFileSync(tmpPath, CONFIG_PATH);
        fs.unlinkSync(tmpPath);
    } else {
        fs.renameSync(tmpPath, CONFIG_PATH);
    }
    
    // Update runtime config
    Object.assign(runtimeConfig, newConfig);
}

/**
 * Validate and sanitize a section of config
 * @param {Object} section - The section object
 * @param {Object} schema - Validation schema { field: { type: string, required: boolean, default: any } }
 */
function validateConfigSection(section, schema) {
    const result = {};
    
    for (const [key, rules] of Object.entries(schema)) {
        if (section[key] === undefined || section[key] === null) {
            if (rules.required && rules.default === undefined) {
                throw new Error(`[ConfigManager] Required field '${key}' is missing`);
            }
            result[key] = rules.default;
            continue;
        }
        
        let value = section[key];
        
        // Type coercion
        if (rules.type === 'number') {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) {
                throw new Error(`[ConfigManager] Field '${key}' must be a number`);
            }
            value = parsed;
        } else if (rules.type === 'boolean') {
            if (typeof value === 'string') {
                value = (value === 'true' || value === true);
            }
        } else if (rules.type === 'string') {
            value = String(value).trim();
        }
        
        // Range validation
        if (rules.min !== undefined && value < rules.min) value = rules.min;
        if (rules.max !== undefined && value > rules.max) value = rules.max;
        
        result[key] = value;
    }
    
    return result;
}

/**
 * Update config section atomically
 * @param {string} sectionName - e.g., 'site', 'recording', 'telegram'
 * @param {Object} updates - Fields to update
 * @param {Object} runtimeConfig - Runtime config reference
 * @param {Object} schema - Optional validation schema
 */
function updateConfigSection(sectionName, updates, runtimeConfig, schema = null) {
    const config = readConfig();
    
    if (!config[sectionName]) {
        config[sectionName] = {};
    }
    
    if (schema) {
        const validated = validateConfigSection(updates, schema);
        Object.assign(config[sectionName], validated);
    } else {
        Object.assign(config[sectionName], updates);
    }
    
    atomicWriteConfig(config, runtimeConfig);
    return config;
}

/**
 * Config validation schemas
 */
const SCHEMAS = {
    site: {
        title: { type: 'string', default: 'CCTV ONLINE' },
        footer: { type: 'string', default: '' },
        running_text: { type: 'string', default: '' }
    },
    recording: {
        enabled: { type: 'boolean', default: true },
        start_time: { type: 'string', default: '00:00' },
        end_time: { type: 'string', default: '23:59' },
        segment_duration: { type: 'string', default: '60m' },
        delete_after: { type: 'string', default: '1d' },
        video_codec: { type: 'string', default: 'h264' },
        resolution: { type: 'string', default: '720p' },
        frame_rate: { type: 'number', min: 1, max: 60, default: 12 },
        bitrate: { type: 'string', default: '800k' },
        max_bitrate: { type: 'string', default: '900k' },
        audio_enabled: { type: 'boolean', default: true },
        audio_bitrate: { type: 'string', default: '64k' },
        max_storage_percent: { type: 'number', min: 10, max: 99, default: 90 }
    },
    telegram: {
        enabled: { type: 'boolean', default: false },
        bot_token: { type: 'string', default: '' },
        chat_id: { type: 'string', default: '' }
    },
    whatsapp: {
        admin_numbers: { type: 'string', default: '' }
    },
    map: {
        default_lat: { type: 'number', min: -90, max: 90, default: -6.2517 },
        default_lng: { type: 'number', min: -180, max: 180, default: 107.9207 },
        default_zoom: { type: 'number', min: 1, max: 18, default: 13 }
    },
    mediamtx: {
        host: { type: 'string', default: '127.0.0.1' },
        api_port: { type: 'number', min: 1, max: 65535, default: 9123 },
        rtsp_port: { type: 'number', min: 1, max: 65535, default: 8555 },
        hls_port: { type: 'number', min: 1, max: 65535, default: 8856 },
        public_hls_url: { type: 'string', default: '' }
    }
};

module.exports = {
    readConfig,
    atomicWriteConfig,
    validateConfigSection,
    updateConfigSection,
    SCHEMAS,
    CONFIG_PATH
};