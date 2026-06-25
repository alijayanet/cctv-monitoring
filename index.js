const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const http = require('http');
const https = require('https');
const session = require('express-session');
const config = require('./config.json');
const telegramBot = require('./telegram_bot');
const webPush = require('web-push');
const bcrypt = require('./services/bcryptCompat');
const youtubeStream = require('./youtube_stream');
const whatsappBot = require('./whatsapp_bot');
const AlertSystem = require('./utils/alerts');
const activityLogger = require('./services/activityLogger');

// Utility imports
const {
    normalizeHostValue,
    getEffectiveMediaMtxHost,
    getHlsBaseUrl,
    getHlsHealthCheckBases,
    checkHlsUrl,
    formatDateJakarta,
    getClientIp,
    isRunningUnderSystemd,
    restartLinuxServices
} = require('./utils/helpers');
const {
    mediaMtxRequest: mediaMtxRequestUtil,
    ensureMediaMtxAvailable: ensureMediaMtxAvailableUtil,
    getMediaMtxState
} = require('./utils/mediamtx');
const {
    setupSessionMiddleware,
    setupGlobalMiddleware,
    requireAuth: requireAuthUtil,
    requireApiAuth: requireApiAuthUtil,
    requireAnyAuth
} = require('./utils/middleware');
const {
    detectEmbedType,
    generateEmbedHtml,
    validateEmbedUrl
} = require('./utils/embed_camera');
const app = express();
const PORT = config.server.port || 3003;

// ============================================================================
// SECURITY CHECKS - CONFIGURATION VALIDATION
// ============================================================================
function validateConfiguration() {
    const warnings = [];
    const errors = [];

    // Check default credentials
    if (config.authentication.password === 'admin123' || config.authentication.password === 'ChangeMe@Secure123456') {
        warnings.push('⚠️  WARNING: Default admin password detected! Please change it immediately in config.json');
    }

    if (config.authentication.username === 'admin') {
        warnings.push('⚠️  WARNING: Default username "admin" is being used. Consider changing it for better security.');
    }

    // Check session secret
    if (config.server.session_secret === 'cctv-monitoring-secret-key' || 
        config.server.session_secret === 'cctv-secret-key-change-me' ||
        config.server.session_secret === 'cctv-secret-key-please-change-this-to-random-32-chars-min') {
        warnings.push('⚠️  WARNING: Default session_secret detected! Generate a strong random secret for production.');
    }

    // Check if behind proxy is properly configured
    if (config.server.behind_https_proxy && !config.server.public_base_url) {
        warnings.push('⚠️  WARNING: behind_https_proxy is true but public_base_url is empty.');
    }

    // Display warnings
    if (warnings.length > 0) {
        console.log('\n' + '='.repeat(70));
        console.log('SECURITY CONFIGURATION WARNINGS:');
        warnings.forEach(w => console.log(w));
        console.log('='.repeat(70) + '\n');
    }

    // Display errors
    if (errors.length > 0) {
        console.error('\n' + '='.repeat(70));
        console.error('CONFIGURATION ERRORS:');
        errors.forEach(e => console.error('❌ ' + e));
        console.error('='.repeat(70) + '\n');
        process.exit(1);
    }

    return { warnings, errors };
}

// Validate config at startup
validateConfiguration();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// RTSP URL Validation Function
function isValidRtspUrl(url) {
    if (!url || typeof url !== 'string') return false;
    
    // Remove whitespace
    url = url.trim();
    
    // Check basic format
    if (!url.match(/^rtsp:\/\//i)) return false;
    
    // Check for minimum URL structure: rtsp://[host]:[port]/[path]
    // Allow rtsp://host/path (default port 554)
    // Allow rtsp://user:pass@host:port/path
    const rtspRegex = /^rtsp:\/\/([a-z0-9@:._\-]+)\/\S+$/i;
    if (!rtspRegex.test(url)) return false;
    
    // Check URL length (reasonable limit)
    if (url.length > 2000) return false;
    
    // Check for common injection patterns
    if (url.includes(';') || url.includes('`') || url.includes('$')) return false;
    
    return true;
}

// Di belakang Cloudflare/reverse proxy HTTPS: Express harus percaya header X-Forwarded-*
// agar req.secure dan req.protocol benar, dan cookie session bisa dipakai di HTTPS.
// Trust proxy - required for secure cookies behind reverse proxy
if (config.server.behind_https_proxy) {
    app.set('trust proxy', 1);
    console.log('[Config] Trust proxy enabled for HTTPS');
}

// Helper to get effective MediaMTX Host
// normalizeHostValue() - Now imported from utils/helpers.js
// getEffectiveMediaMtxHost(config) - Now imported from utils/helpers.js
// getHlsBaseUrl() - Now imported from utils/helpers.js
// getHlsHealthCheckBases(config) - Now imported from utils/helpers.js
// checkHlsUrl() - Now imported from utils/helpers.js

function getPathReady(item) {
    if (!item) return false;
    // MediaMTX v3 primary check
    if (typeof item.ready === 'boolean') return item.ready;
    // Fallbacks for specific source states
    if (item.source && typeof item.source.ready === 'boolean') return item.source.ready;
    if (typeof item.sourceReady === 'boolean') return item.sourceReady;
    
    // State string check
    if (typeof item.state === 'string') return item.state.toLowerCase() === 'ready';
    if (item.source && typeof item.source.state === 'string') return item.source.state.toLowerCase() === 'ready';
    
    return false;
}

async function checkHlsStatus(cameraId) {
    const bases = getHlsHealthCheckBases(config);
    for (const baseUrl of bases) {
        const transcodedUrl = `${baseUrl}/cam_${cameraId}/index.m3u8`;
        const inputUrl = `${baseUrl}/cam_${cameraId}_input/index.m3u8`;
        const [transcodedReady, inputReady] = await Promise.all([
            checkHlsUrl(transcodedUrl),
            checkHlsUrl(inputUrl)
        ]);
        const ready = transcodedReady || inputReady;
        if (ready) {
            return { ready, transcoded: transcodedReady };
        }
    }
    return { ready: false, transcoded: false };
}

app.locals.site = config.site;
app.locals.recording = config.recording;
app.locals.telegram = config.telegram;
app.locals.mediamtx = config.mediamtx;
app.locals.hls_port = config.mediamtx?.hls_port || 8856;
app.locals.base_path = config.server.base_path || '';
app.locals.generateEmbedHtml = generateEmbedHtml;

let cameraStatus = {};
let diskUsage = { total: 0, used: 0, percent: 0 };
let alertSystem = null;
let recordingUsageCache = { totalBytes: 0, totalFiles: 0, lastUpdate: 0 };
let hlsStatusCache = { lastUpdate: 0, data: {} };
let weatherCache = new Map();
let incidentReportRate = new Map();
let diskCriticalAlerted = false;
let mediaMtxErrorNotified = false;
let loginAttempts = {};
let mediaMtxState = {
    isAvailable: null,
    lastAvailabilityCheckAt: 0,
    unreachableUntil: 0,
    lastErrorLogAt: 0,
    lastErrorMessage: ''
};
let lastCameraSyncAttemptAt = 0;

// formatDateJakarta() - Now imported from utils/helpers.js
function parseRecordingTimestampFromFilename(filename) {
    const base = path.basename(filename);
    const m = base.match(/(\d{4})-(\d{2})-(\d{2})[_T](\d{2})[-:](\d{2})[-:](\d{2})/);
    if (!m) return null;

    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6]);

    if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
    const dt = new Date(year, month - 1, day, hour, minute, second);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
}

function getRecordingsFromFilesystem(selectedDate) {
    const fs = require('fs');
    const recordingsDir = path.join(__dirname, 'recordings');
    if (!fs.existsSync(recordingsDir)) return [];

    let cameraFolders = [];
    try {
        cameraFolders = fs.readdirSync(recordingsDir).filter(f => {
            const fullPath = path.join(recordingsDir, f);
            return fs.statSync(fullPath).isDirectory() && /^cam_\d+$/.test(f);
        });
    } catch (e) {
        return [];
    }

    const items = [];
    cameraFolders.forEach(folder => {
        const folderPath = path.join(recordingsDir, folder);
        let files = [];
        try {
            files = fs.readdirSync(folderPath);
        } catch (e) {
            return;
        }

        const match = folder.match(/^cam_(\d+)/);
        const cameraId = match ? Number(match[1]) : null;
        files.forEach(file => {
            const fullPath = path.join(folderPath, file);
            let stats;
            try {
                stats = fs.statSync(fullPath);
            } catch (e) {
                return;
            }
            if (!stats.isFile()) return;

            // Only include video files
            const videoExtensions = ['.mp4', '.fmp4', '.ts', '.mkv'];
            const ext = path.extname(file).toLowerCase();
            if (!videoExtensions.includes(ext)) return;

            const createdDate = parseRecordingTimestampFromFilename(file) || stats.mtime;
            const createdAt = formatDateJakarta(createdDate);
            const dayStr = createdAt.slice(0, 10);

            if (selectedDate && dayStr !== selectedDate) return;

            const createdAtIso = createdDate.toISOString();
            const relativePath = path.join('recordings', folder, file).replace(/\\/g, '/');
            items.push({
                camera_id: cameraId,
                camera_folder: folder,
                filename: file,
                file_path: relativePath,
                size: stats.size,
                duration: null,
                created_at: createdAt,
                created_at_iso: createdAtIso
            });
        });
    });

    items.sort((a, b) => Date.parse(b.created_at_iso) - Date.parse(a.created_at_iso));
    return items;
}

// RTSP URL Templates for various camera brands
const RTSP_TEMPLATES = {
    hikvision: {
        name: 'Hikvision',
        template: 'rtsp://{username}:{password}@{ip}:{port}/Streaming/Channels/{channel}01',
        defaults: { port: 554, channel: 1 },
        description: 'Channel 1=Main Stream, Channel 2=Sub Stream'
    },
    dahua: {
        name: 'Dahua',
        template: 'rtsp://{username}:{password}@{ip}:{port}/cam/realmonitor?channel={channel}&subtype={subtype}',
        defaults: { port: 554, channel: 1, subtype: 0 },
        description: 'Subtype 0=Main Stream, 1=Sub Stream'
    },
    axis: {
        name: 'Axis',
        template: 'rtsp://{username}:{password}@{ip}:{port}/axis-media/media.amp',
        defaults: { port: 554 },
        description: 'Standard Axis RTSP stream'
    },
    foscam: {
        name: 'Foscam',
        template: 'rtsp://{username}:{password}@{ip}:{port}/videoMain',
        defaults: { port: 88 },
        description: 'videoMain=HD, videoSub=SD'
    },
    reolink: {
        name: 'Reolink',
        template: 'rtsp://{username}:{password}@{ip}:{port}/h264Preview_01_{stream}',
        defaults: { port: 554, stream: 'main' },
        description: 'main=Main Stream, sub=Sub Stream'
    },
    uniview: {
        name: 'Uniview (UNV)',
        template: 'rtsp://{username}:{password}@{ip}:{port}/unicast/c{channel}/s{stream}/live',
        defaults: { port: 554, channel: 1, stream: 0 },
        description: 's0=Main Stream, s1=Sub Stream'
    },
    tp_link: {
        name: 'TP-Link Tapo',
        template: 'rtsp://{username}:{password}@{ip}:{port}/stream{channel}',
        defaults: { port: 554, channel: 1 },
        description: 'stream1=HD, stream2=SD'
    },
    xiaomi: {
        name: 'Xiaomi/Yi',
        template: 'rtsp://{username}:{password}@{ip}:{port}/ch0_{stream}.264',
        defaults: { port: 554, stream: 0 },
        description: 'ch0_0=HD, ch0_1=SD'
    },
    sony: {
        name: 'Sony',
        template: 'rtsp://{username}:{password}@{ip}:{port}/media/video{channel}',
        defaults: { port: 554, channel: 1 },
        description: 'video1=Main Stream, video2=Sub Stream'
    },
    panasonic: {
        name: 'Panasonic',
        template: 'rtsp://{username}:{password}@{ip}:{port}/MediaInput/stream{channel}',
        defaults: { port: 554, channel: 1 },
        description: 'stream1=Main Stream, stream2=Sub Stream'
    },
    avtech: {
        name: 'AVTech',
        template: 'rtsp://{username}:{password}@{ip}:{port}/live/ch00_{channel}',
        defaults: { port: 554, channel: 0 },
        description: 'ch00_0=Main Stream, ch00_1=Sub Stream'
    },
    bardi: {
        name: 'Bardi',
        template: 'rtsp://{username}:{password}@{ip}:{port}/V_ENC_000',
        defaults: { port: 554 },
        description: 'Bardi IP Camera - V_ENC_000 stream'
    },
    spc: {
        name: 'SPC',
        template: 'rtsp://{username}:{password}@{ip}:{port}/onvif1',
        defaults: { port: 554 },
        description: 'SPC IP Camera via ONVIF'
    },
    tiandy: {
        name: 'Tiandy',
        template: 'rtsp://{username}:{password}@{ip}:{port}/live/ch0',
        defaults: { port: 554 },
        description: 'Tiandy IP Camera via RTSP'
    },
    glenz: {
        name: 'Glenz',
        template: 'rtsp://{username}:{password}@{ip}:{port}/live/ch0',
        defaults: { port: 554 },
        description: 'Glenz/HDW WiFi Camera via RTSP'
    },
    generic: {
        name: 'Generic/Other',
        template: 'rtsp://{username}:{password}@{ip}:{port}/',
        defaults: { port: 554 },
        description: 'Generic RTSP URL - customize as needed'
    }
};

// Generate RTSP URL from template
function generateRtspUrl(brand, params) {
    const template = RTSP_TEMPLATES[brand];
    if (!template) return null;

    let url = template.template;
    const mergedParams = { ...template.defaults, ...params };

    // Replace placeholders
    Object.keys(mergedParams).forEach(key => {
        url = url.replace(`{${key}}`, mergedParams[key] || '');
    });

    return url;
}

// --- Authentication Config ---
// In production, use environment variables. Hardcoded for simplicity as per request.
const DEBUG_AUTH = process.env.DEBUG_AUTH === '1';
const ADMIN_USER = process.env.CCTV_ADMIN_USER || config.authentication.username || 'admin';
const ADMIN_PASS = process.env.CCTV_ADMIN_PASS || config.authentication.password || 'admin123';
const ADMIN_PASS_HASH = process.env.CCTV_ADMIN_PASS_HASH || (config.authentication && config.authentication.password_hash) || null;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Handle base_path prefix for incoming requests
const basePath = config.server.base_path || '';
if (basePath) {
    app.use((req, res, next) => {
        if (req.url.startsWith(basePath)) {
            req.url = req.url.slice(basePath.length) || '/';
        }
        next();
    });
    // Also serve static files under the prefix
    app.use(basePath, express.static(path.join(__dirname, 'public')));
    app.use(basePath + '/recordings', express.static(path.join(__dirname, 'recordings')));
    app.use(basePath + '/bukti_tf', express.static(path.join(__dirname, 'bukti_tf')));

}

// --- HLS Reverse Proxy (same-origin streaming) ---
// Proxy /cam_* requests to MediaMTX HLS server so the browser can
// fetch streams from the same origin without CORS or mixed-content issues.
app.use((req, res, next) => {
    // Only intercept GET requests for cam_ paths (playlists & segments)
    if (req.method !== 'GET' || !req.url.match(/^\/cam_[^\/]+\//)) {
        return next();
    }
    const hlsPort = config.mediamtx?.hls_port || 8856;
    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: hlsPort,
        path: req.url,
        method: 'GET',
        headers: { 'Accept': req.headers.accept || '*/*' }
    }, (proxyRes) => {
        // Forward status and relevant headers
        res.writeHead(proxyRes.statusCode, {
            'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
            'Cache-Control': proxyRes.headers['cache-control'] || 'no-cache',
            'Access-Control-Allow-Origin': '*'
        });
        proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
        console.error(`[HLS Proxy] Error proxying ${req.url}:`, err.message);
        if (!res.headersSent) {
            res.status(502).json({ error: 'HLS stream unavailable' });
        }
    });
    proxyReq.setTimeout(10000, () => {
        proxyReq.destroy();
        if (!res.headersSent) {
            res.status(504).json({ error: 'HLS stream timeout' });
        }
    });
    proxyReq.end();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
    // Ensure /api routes always return JSON even on error/404
    if (req.url.startsWith('/api')) {
        res.setHeader('Content-Type', 'application/json');
    }
    try {
        const basePath = String(app.locals.base_path || '');
        const basePathNormalized = basePath ? ('/' + basePath.replace(/^\/+/, '').replace(/\/+$/, '')) : '';
        const host = req.headers.host ? String(req.headers.host) : '';
        if (host && req.protocol) {
            global.lastPublicBaseUrl = `${req.protocol}://${host}${basePathNormalized}`.replace(/\/+$/, '');
        }
    } catch (e) { }
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    next();
});
app.use('/recordings', express.static(path.join(__dirname, 'recordings')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/bukti_tf', express.static(path.join(__dirname, 'bukti_tf')));


// Session Middleware
// Jika akses publik lewat Cloudflare (HTTPS), set behind_https_proxy: true di config.json
// agar cookie session pakai Secure dan SameSite, sehingga login admin tidak hilang.
const behindProxy = config.server.behind_https_proxy === true;

console.log(`[Config] behind_https_proxy: ${behindProxy}`);

// Shared session store to maintain data across dynamic middleware instances
const sessionStore = new session.MemoryStore();

// Initialize session middleware ONCE
const sessionMiddleware = session({
    secret: config.server.session_secret || 'cctv-monitoring-secret-key',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    proxy: behindProxy,
    cookie: {
        // Apply 'secure' flag ONLY if the request is actually secure
        // This allows local IP (HTTP) to work while keeping HTTPS secure
        secure: behindProxy ? 'auto' : false,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    }
});

app.use((req, res, next) => {
    // Detect if the current request is secure (HTTPS or Cloudflare HTTPS)
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

    // Update cookie secure flag dynamically based on request if needed, 
    // but usually setting it in config is enough. 
    // Here we use the pre-initialized middleware.
    sessionMiddleware(req, res, next);
});

// Debug middleware for session issues
app.use((req, res, next) => {
    if (DEBUG_AUTH && req.path === '/login' && req.method === 'POST') {
        console.log(`[Debug] Login attempt - Host: ${req.headers.host}, Protocol: ${req.protocol}, Secure: ${req.secure}`);
        console.log(`[Debug] Headers:`, {
            'x-forwarded-proto': req.headers['x-forwarded-proto'],
            'x-forwarded-for': req.headers['x-forwarded-for']
        });
    }
    next();
});

// Manual Migration for transactions table
db.run("ALTER TABLE transactions ADD COLUMN bank_info TEXT", (err) => {});
db.run("ALTER TABLE transactions ADD COLUMN proof_image TEXT", (err) => {});


// Global Template Variables Middleware
app.use((req, res, next) => {
    res.locals.base_path = app.locals.base_path || '';
    res.locals.site = config.site || {};
    res.locals.hlsBaseUrl = getHlsBaseUrl(req, config);
    res.locals.months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    res.locals.isAdmin = !!req.session.user;
    res.locals.isCustomer = !!req.session.customer;
    res.locals.session = req.session;
    res.locals.user = req.session.customer || req.session.user || {};
    res.locals.userStatus = JSON.stringify({
        isAdmin: res.locals.isAdmin,
        isCustomer: res.locals.isCustomer,
        customerId: req.session.customer ? req.session.customer.id : null,
        customerLevel: req.session.customer ? req.session.customer.level : (req.session.user ? 'admin' : 'umum')
    });
    next();
});


// Authentication Middleware
const requireAuth = requireAuthUtil(ADMIN_USER);

const requireApiAuth = requireApiAuthUtil(ADMIN_USER);

// --- MediaMTX Helper Functions ---

function sendTelegramMessage(text) {
    try {
        telegramBot.sendMessage(text);
    } catch (e) {
        console.error('Telegram Error:', e.message);
    }
}

// isRunningUnderSystemd() - Now imported from utils/helpers.js
// restartLinuxServices() - Now imported from utils/helpers.js

// getClientIp() - Now imported from utils/helpers.js
function mediaMtxRequestInternal(hostname, port, method, path, body = null) {
    return new Promise((resolve) => {
        const options = {
            hostname,
            port,
            path: path.startsWith('/v3/') ? path : '/v3/config/paths' + path,
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                mediaMtxState.isAvailable = true;
                mediaMtxState.lastAvailabilityCheckAt = Date.now();
                mediaMtxState.unreachableUntil = 0;
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(data ? JSON.parse(data) : {});
                    } catch (parseErr) {
                        console.error('JSON Parse Error:', parseErr.message, 'Data:', data);
                        resolve({ error: true, message: 'Invalid JSON response', raw: data });
                    }
                } else {
                    resolve({ error: true, status: res.statusCode, message: data });
                }
            });
        });

        req.setTimeout(3500, () => {
            req.destroy(new Error('timeout'));
        });

        req.on('error', (e) => {
            const msg = e?.message || String(e);
            const now = Date.now();
            mediaMtxState.isAvailable = false;
            mediaMtxState.lastAvailabilityCheckAt = now;
            mediaMtxState.unreachableUntil = now + 5000;
            if (mediaMtxState.lastErrorMessage !== msg || (now - mediaMtxState.lastErrorLogAt) > 15000) {
                console.error(`MediaMTX API Error: ${msg}`);
                mediaMtxState.lastErrorLogAt = now;
                mediaMtxState.lastErrorMessage = msg;
            }
            resolve({ error: true, message: msg });
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function ensureMediaMtxAvailable() {
    const now = Date.now();
    if (mediaMtxState.unreachableUntil && now < mediaMtxState.unreachableUntil) return false;
    if (mediaMtxState.isAvailable === true && (now - mediaMtxState.lastAvailabilityCheckAt) < 5000) return true;
    if (mediaMtxState.isAvailable === false && (now - mediaMtxState.lastAvailabilityCheckAt) < 5000) return false;

    const primaryHost = getEffectiveMediaMtxHost(config);
    const apiPort = config.mediamtx?.api_port || 9123;
    const result = await mediaMtxRequestInternal(primaryHost, apiPort, 'GET', '/v3/paths/list');
    if (!result?.error) return true;
    if (primaryHost !== '127.0.0.1') {
        const fallback = await mediaMtxRequestInternal('127.0.0.1', apiPort, 'GET', '/v3/paths/list');
        return !fallback?.error;
    }
    return false;
}

async function mediaMtxRequest(method, path, body = null) {
    const now = Date.now();
    if (mediaMtxState.unreachableUntil && now < mediaMtxState.unreachableUntil) {
        return { error: true, message: 'MediaMTX unreachable (cooldown)' };
    }
    const primaryHost = getEffectiveMediaMtxHost(config);
    const apiPort = config.mediamtx?.api_port || 9123;
    const primaryResult = await mediaMtxRequestInternal(primaryHost, apiPort, method, path, body);
    if (!primaryResult?.error || primaryHost === '127.0.0.1') {
        return primaryResult;
    }
    return mediaMtxRequestInternal('127.0.0.1', apiPort, method, path, body);
}

async function setupMediaMtxGlobalConfig() {
    const ok = await ensureMediaMtxAvailable();
    if (!ok) {
        console.log('MediaMTX tidak terdeteksi. Lewati setup konfigurasi global.');
        return false;
    }
    const isWin = process.platform === 'win32';
    const transcodeScript = isWin ? path.join(__dirname, 'smart_transcode.bat').replace(/\\/g, '/') : './smart_transcode.sh';
    const notifyScript = isWin ? path.join(__dirname, 'record_notify.bat').replace(/\\/g, '/') : './record_notify.sh';

    console.log(`Detecting OS: ${isWin ? 'Windows' : 'Linux/Ubuntu'}. Setting up MediaMTX scripts...`);

    // Apply global path defaults
    const result = await mediaMtxRequest('PATCH', '/v3/config/pathdefaults/patch', {
        runOnReady: transcodeScript,
        runOnReadyRestart: true,
        runOnRecordSegmentComplete: notifyScript,
        rtspTransport: 'tcp'
    });
    return !result?.error;
}

async function updateMediaMtxRecording() {
    const ok = await ensureMediaMtxAvailable();
    if (!ok) {
        console.log('MediaMTX API tidak bisa diakses. Recording config tidak bisa di-apply; MediaMTX bisa pakai default recordDeleteAfter=1d.');
        return;
    }
    console.log('Applying recording settings to MediaMTX...');
    const rec = config.recording || {};
    const isInsideWindow = checkTimeWindow(rec.start_time, rec.end_time);
    const shouldRecord = (rec.enabled && isInsideWindow);

    console.log(`Recording Window: ${rec.start_time} - ${rec.end_time}. Status: ${shouldRecord ? 'RECORDING' : 'IDLE'}`);

    // CONFIGURATION STRATEGY: 
    // 1. Path cam_X_input (raw) -> record: OFF
    // 2. Path cam_X (transcoded H.264) -> record: ON (if enabled)

    const isWin = process.platform === 'win32';
    const fs = require('fs');
    const storagePath = (config.recording && config.recording.storage_path) ? String(config.recording.storage_path).trim() : '';
    const recordingsDir = storagePath
        ? (path.isAbsolute(storagePath) ? storagePath : path.resolve(__dirname, storagePath))
        : path.resolve(__dirname, 'recordings');
    try {
        if (!fs.existsSync(recordingsDir)) {
            fs.mkdirSync(recordingsDir, { recursive: true });
        }
    } catch (e) { }
    const recordSegmentDuration = normalizeMediaMtxDuration(rec.segment_duration, '60m');
    const recordDeleteAfter = normalizeMediaMtxDuration(rec.delete_after, '168h');
    const recordPath = path.join(recordingsDir, '%path', '%Y-%m-%d_%H-%M-%S.mp4').replace(/\\/g, '/');
    console.log(`[Recording] recordPath=${recordPath} recordSegmentDuration=${recordSegmentDuration} recordDeleteAfter=${recordDeleteAfter}`);

    // Disable recording on all paths first (global defaults)
    const defaultsResult = await mediaMtxRequest('PATCH', '/v3/config/pathdefaults/patch', {
        record: false,
        runOnReady: isWin ? path.join(__dirname, 'smart_transcode.bat').replace(/\\/g, '/') : './smart_transcode.sh',
        runOnRecordSegmentComplete: isWin ? path.join(__dirname, 'record_notify.bat').replace(/\\/g, '/') : './record_notify.sh',
        recordPath,
        recordFormat: 'fmp4',
        recordSegmentDuration,
        recordDeleteAfter
    });
    if (defaultsResult?.error) return;

    // Enable recording ONLY for transcoded paths (cam_1, cam_2, ...). Path cam_X_input stays record: false.
    db.all("SELECT id FROM cameras", [], async (err, rows) => {
        if (err) return;
        for (const cam of rows) {
            const outputPath = `cam_${cam.id}`;
            const body = {
                source: 'publisher',
                record: shouldRecord,
                recordPath,
                recordFormat: 'fmp4',
                recordSegmentDuration,
                recordDeleteAfter
            };
            const addRes = await mediaMtxRequest('POST', '/add/' + outputPath, body);
            if (addRes?.status === 409 || addRes?.error) {
                await mediaMtxRequest('PATCH', '/patch/' + outputPath, body);
            }
        }
    });
}

async function updateSystemHealth() {
    const { exec } = require('child_process');
    const isWin = process.platform === 'win32';
    const path = require('path');
    const fs = require('fs');

    if (isWin) {
        exec("wmic logicaldisk get DeviceID,Size,FreeSpace /value", (err, stdout) => {
            if (!err) {
                const blocks = stdout.trim().split(/\n\s*\n/);
                const disks = [];
                const formatBytes = (bytes) => {
                    if (!bytes || bytes === 0) return '0 B';
                    const k = 1024;
                    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
                    const i = Math.floor(Math.log(bytes) / Math.log(k));
                    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
                };
                blocks.forEach(block => {
                    const kv = {};
                    block.split('\n').forEach(line => {
                        const [key, val] = line.split('=');
                        if (key && val) kv[key.trim()] = val.trim();
                    });
                    const size = parseInt(kv.Size) || 0;
                    const freeSpace = parseInt(kv.FreeSpace) || 0;
                    const used = size - freeSpace;
                    const percent = size > 0 ? Math.round((used / size) * 100) : 0;
                    if (kv.DeviceID) {
                        disks.push({
                            mounted: kv.DeviceID,
                            total: formatBytes(size),
                            used: formatBytes(used),
                            free: formatBytes(freeSpace),
                            percent,
                            sizeRaw: size,
                            usedRaw: used
                        });
                    }
                });
                const recordingsDrive = path.parse(path.resolve(__dirname, 'recordings')).root.slice(0, 2).toUpperCase();
                const sysDrive = (process.env.SystemDrive || 'C:').toUpperCase();
                const summary = disks.find(d => String(d.mounted || '').toUpperCase() === recordingsDrive)
                    || disks.find(d => String(d.mounted || '').toUpperCase() === sysDrive)
                    || disks[0]
                    || { total: '0 B', used: '0 B', free: '0 B', percent: 0, mounted: recordingsDrive || sysDrive, sizeRaw: 0, usedRaw: 0 };
                const osmod = require('os');
                const totalMem = osmod.totalmem();
                const freeMem = osmod.freemem();
                const usedMem = totalMem - freeMem;
                const memPercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;
                diskUsage = {
                    total: summary.total,
                    used: summary.used,
                    free: summary.free,
                    percent: summary.percent,
                    usedPercent: summary.percent, // Compatible with dashboard
                    totalGb: (summary.sizeRaw / (1024 * 1024 * 1024)).toFixed(1),
                    usedGb: (summary.usedRaw / (1024 * 1024 * 1024)).toFixed(1),
                    mounted: summary.mounted,
                    disks,
                    memory: {
                        total: formatBytes(totalMem),
                        used: formatBytes(usedMem),
                        free: formatBytes(freeMem),
                        percent: memPercent
                    },
                    cpu: {
                        load1: null,
                        load5: null,
                        load15: null
                    },
                    uptime_sec: osmod.uptime()
                };
                exec('wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature', (terr, tout) => {
                    if (!terr) {
                        const vals = tout.split('\n').map(s => parseInt(s.trim())).filter(v => !isNaN(v) && v > 0);
                        if (vals.length > 0) {
                            const avgKelvinTimes10 = vals.reduce((a, b) => a + b, 0) / vals.length;
                            const celsius = (avgKelvinTimes10 / 10) - 273.15;
                            diskUsage.sensors = diskUsage.sensors || {};
                            diskUsage.sensors.cpu_temp_c = Math.round(celsius * 10) / 10;
                        }
                    }
                });

                const limit = config.recording?.max_storage_percent || 90;
                if (summary.percent > limit) {
                    if (!diskCriticalAlerted) {
                        sendTelegramMessage(`⚠️ <b>CRITICAL STORAGE</b>\nDisk usage is at <b>${summary.percent}%</b> (${summary.used}/${summary.total}). Automatic cleanup started.`);
                        sendPushNotification('⚠️ Critical Storage Alert', `Disk usage is at ${summary.percent}%. Cleanup started!`, '/admin/recordings');
                        diskCriticalAlerted = true;
                    }
                    cleanupRecordingsByDiskUsage(summary.percent);
                } else {
                    diskCriticalAlerted = false;
                }
            }
        });
    } else {
        // Use df -B1 to get bytes instead of human readable, then format manually for consistency
        exec('df -B1 / | tail -n +2', (err, stdout) => {
            if (!err) {
                const lines = stdout.trim().split('\n');
                const disks = [];
                const formatBytes = (bytes) => {
                    if (!bytes || bytes === 0) return '0 B';
                    const k = 1024;
                    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
                    const i = Math.floor(Math.log(bytes) / Math.log(k));
                    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
                };

                lines.forEach(line => {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 6) {
                        const total = parseInt(parts[1]) || 0;
                        const used = parseInt(parts[2]) || 0;
                        const free = parseInt(parts[3]) || 0;
                        const percent = parseInt(parts[4]) || 0;
                        disks.push({
                            filesystem: parts[0],
                            total: formatBytes(total),
                            used: formatBytes(used),
                            free: formatBytes(free),
                            percent,
                            totalRaw: total,
                            usedRaw: used,
                            mounted: parts[5]
                        });
                    }
                });
                
                const summary = disks.find(d => d.mounted === '/') || disks[0] || { total: '0 B', used: '0 B', free: '0 B', percent: 0, mounted: '/', totalRaw: 0, usedRaw: 0 };
                const osmod = require('os');
                const totalMem = osmod.totalmem();
                const freeMem = osmod.freemem();
                const usedMem = totalMem - freeMem;
                const memPercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;
                const load = osmod.loadavg();
                diskUsage = {
                    total: summary.total,
                    used: summary.used,
                    free: summary.free,
                    percent: summary.percent,
                    usedPercent: summary.percent, // Compatible with dashboard
                    totalGb: (summary.totalRaw / (1024 * 1024 * 1024)).toFixed(1),
                    usedGb: (summary.usedRaw / (1024 * 1024 * 1024)).toFixed(1),
                    mounted: summary.mounted,
                    disks,
                    memory: {
                        total: formatBytes(totalMem),
                        used: formatBytes(usedMem),
                        free: formatBytes(freeMem),
                        percent: memPercent
                    },
                    cpu: {
                        load1: load[0],
                        load5: load[1],
                        load15: load[2]
                    },
                    uptime_sec: osmod.uptime()
                };
                try {
                    const zones = fs.readdirSync('/sys/class/thermal').filter(n => /^thermal_zone/.test(n));
                    const temps = [];
                    zones.forEach(z => {
                        const tpath = path.join('/sys/class/thermal', z, 'temp');
                        try {
                            const t = fs.readFileSync(tpath, 'utf8').trim();
                            const val = parseInt(t);
                            if (!isNaN(val) && val > 0) temps.push(val / 1000);
                        } catch (e) { }
                    });
                    if (temps.length > 0) {
                        const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
                        diskUsage.sensors = diskUsage.sensors || {};
                        diskUsage.sensors.cpu_temp_c = Math.round(avg * 10) / 10;
                    }
                } catch (e) { }

                const limit = config.recording?.max_storage_percent || 90;
                if (summary.percent > limit) {
                    if (!diskCriticalAlerted) {
                        sendTelegramMessage(`⚠️ <b>CRITICAL STORAGE</b>\nDisk usage is at <b>${summary.percent}%</b> (${summary.used}/${summary.total}). Automatic cleanup started.`);
                        sendPushNotification('⚠️ Critical Storage Alert', `Disk usage is at ${summary.percent}%. Cleanup started!`, '/admin/recordings');
                        diskCriticalAlerted = true;
                    }
                    cleanupRecordingsByDiskUsage(summary.percent);
                } else {
                    diskCriticalAlerted = false;
                }
            }
        });
    }

    try {
        const nowMs = Date.now();
        if (!recordingUsageCache.lastUpdate || (nowMs - recordingUsageCache.lastUpdate) > 120000) {
            const recordingsDir = path.join(__dirname, 'recordings');
            let totalBytes = 0;
            let totalFiles = 0;
            if (fs.existsSync(recordingsDir)) {
                const camFolders = fs.readdirSync(recordingsDir).filter(f => {
                    try {
                        const p = path.join(recordingsDir, f);
                        return fs.statSync(p).isDirectory();
                    } catch (e) { return false; }
                });
                camFolders.forEach(f => {
                    const fp = path.join(recordingsDir, f);
                    let files = [];
                    try { files = fs.readdirSync(fp); } catch (e) { files = []; }
                    files.forEach(fn => {
                        const full = path.join(fp, fn);
                        try {
                            const st = fs.statSync(full);
                            if (st.isFile()) {
                                totalBytes += st.size;
                                totalFiles += 1;
                            }
                        } catch (e) { }
                    });
                });
            }
            recordingUsageCache = { totalBytes, totalFiles, lastUpdate: nowMs };
        }
        const formatBytesRec = (bytes) => {
            if (!bytes || bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        };
        diskUsage.recordings = {
            total: formatBytesRec(recordingUsageCache.totalBytes),
            files: recordingUsageCache.totalFiles,
            lastUpdate: new Date(recordingUsageCache.lastUpdate).toISOString()
        };
    } catch (e) { }

    // 2. Check Camera Health via MediaMTX Runtime API
    try {
        // Use /v3/paths/list for real-time status (not just config)
        let pathsData = null;
        try {
            pathsData = await mediaMtxRequest('GET', '/v3/paths/list');
        } catch (e) {
            console.warn('[Health] MediaMTX GET /v3/paths/list failed:', e.message);
        }
        
        if (pathsData && !pathsData.error) {
            mediaMtxErrorNotified = false;
        }
        const itemsList = (pathsData && !pathsData.error) ? (pathsData.items || []) : [];

        // Convert list to map for easier lookup if it's an array
        let activePaths = {};
        if (Array.isArray(itemsList)) {
            itemsList.forEach(p => activePaths[p.name] = p);
        } else {
            activePaths = itemsList; // Older versions might return a map
        }

        const rows = await new Promise((resolve) => {
            db.all("SELECT id, nama, lokasi, camera_type, embed_url, embed_type FROM cameras", [], (err, result) => {
                if (err) return resolve([]);
                resolve(result || []);
            });
        });

        const now = new Date();
        const nowMs = Date.now();
        const camKeys = Object.keys(activePaths || {}).filter(k => k.startsWith('cam_'));
        if (rows.length > 0 && camKeys.length === 0) {
            if (!lastCameraSyncAttemptAt || (nowMs - lastCameraSyncAttemptAt) > 60000) {
                lastCameraSyncAttemptAt = nowMs;
                console.log('[Sync] Tidak ada path cam_* di MediaMTX. Menjalankan syncCameras()...');
                syncCameras();
            }
        }
        if (!hlsStatusCache.lastUpdate || (nowMs - hlsStatusCache.lastUpdate) > 10000) {
            const hlsStatuses = await Promise.all(rows.map(async (cam) => {
                if (cam.camera_type === 'embed') {
                    if (cam.embed_url && (cam.embed_type === 'hls' || cam.embed_url.toLowerCase().includes('.m3u8'))) {
                        const ready = await checkHlsUrl(cam.embed_url);
                        return { ready, transcoded: true };
                    }
                    return { ready: !!cam.embed_url, transcoded: true };
                } else {
                    return checkHlsStatus(cam.id);
                }
            }));
            const byId = {};
            rows.forEach((cam, idx) => {
                byId[String(cam.id)] = hlsStatuses[idx] || { ready: false, transcoded: false };
            });
            hlsStatusCache = { lastUpdate: nowMs, data: byId };
        }

        rows.forEach((cam) => {
            let currentlyOnline = false;
            let inputReady = false;
            let outputReady = false;
            let hlsStatus = { ready: false, transcoded: false };

            if (cam.camera_type === 'embed') {
                hlsStatus = (hlsStatusCache && hlsStatusCache.data && hlsStatusCache.data[String(cam.id)]) || { ready: false, transcoded: false };
                currentlyOnline = hlsStatus.ready;
            } else {
                const inputPath = `cam_${cam.id}_input`;
                const outputPath = `cam_${cam.id}`;

                const inputItem = activePaths[inputPath];
                const outputItem = activePaths[outputPath];

                inputReady = getPathReady(inputItem);
                outputReady = getPathReady(outputItem);
                hlsStatus = (hlsStatusCache && hlsStatusCache.data && hlsStatusCache.data[String(cam.id)]) || { ready: false, transcoded: false };
                currentlyOnline = !!(outputReady || inputReady || hlsStatus.ready);
            }

            const prevState = cameraStatus[cam.id] || { online: false };

            if (prevState.hasBeenChecked && currentlyOnline !== prevState.online) {
                const statusText = currentlyOnline ? "✅ ONLINE" : "❌ OFFLINE";
                const statusEmoji = currentlyOnline ? "📶" : "⚠️";
                sendTelegramMessage(`${statusEmoji} <b>Camera ${statusText}</b>\nNama: ${cam.nama}\nLokasi: ${cam.lokasi}`);

                sendPushNotification(
                    `Camera ${statusText}`,
                    `${cam.nama} at ${cam.lokasi} is now ${currentlyOnline ? 'ONLINE' : 'OFFLINE'}`,
                    '/'
                );
            }

            let offlineSince = prevState.offlineSince || null;
            let offlineAlertSent = prevState.offlineAlertSent || false;

            if (!currentlyOnline) {
                if (prevState.online) {
                    offlineSince = now;
                    offlineAlertSent = false;
                } else if (!offlineSince) {
                    offlineSince = now;
                }

                const thresholdMs = 5 * 60 * 1000;
                if (!offlineAlertSent && offlineSince && (now - offlineSince) >= thresholdMs) {
                    sendTelegramMessage(`⚠️ <b>Camera OFFLINE > 5 menit</b>\nNama: ${cam.nama}\nLokasi: ${cam.lokasi}`);
                    offlineAlertSent = true;
                }
            } else {
                offlineSince = null;
                offlineAlertSent = false;
            }

            cameraStatus[cam.id] = {
                online: currentlyOnline,
                lastUpdate: now,
                hasBeenChecked: true,
                offlineSince,
                offlineAlertSent,
                hlsReady: hlsStatus.ready || inputReady || outputReady,
                hlsTranscoded: hlsStatus.transcoded || outputReady
            };
        });
    } catch (e) {
        console.error('[Health] System health update error:', e.message);
        if (!mediaMtxErrorNotified) {
            sendTelegramMessage('❌ <b>MediaMTX tidak merespon</b>\nCek service <b>mediamtx</b> di server.');
            mediaMtxErrorNotified = true;
        }
    }
}

function checkTimeWindow(startStr, endStr) {
    if (!startStr || !endStr) return true;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const [startH, startM] = startStr.split(':').map(Number);
    const startMinutes = startH * 60 + startM;

    const [endH, endM] = endStr.split(':').map(Number);
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
        return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
    } else {
        // Over midnight (e.g., 22:00 to 06:00)
        return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
    }
}

async function registerCamera(cam) {
    const ok = await ensureMediaMtxAvailable();
    if (!ok) {
        return { error: true, message: 'MediaMTX tidak tersedia' };
    }

    if (cam.camera_type === 'embed') {
        const isHls = cam.embed_url && (cam.embed_type === 'hls' || cam.embed_url.toLowerCase().includes('.m3u8'));
        if (!isHls) {
            // Non-HLS embed camera (YouTube, iframe) does not need to be registered in MediaMTX
            return { message: 'Non-HLS embed camera skipped' };
        }

        const pathName = `cam_${cam.id}`;
        console.log(`Registering Embed HLS camera ${cam.id} (${cam.nama}) to MediaMTX...`);

        // Delete old path first to avoid conflict
        await mediaMtxRequest('DELETE', '/delete/' + pathName);

        const addRes = await mediaMtxRequest('POST', '/add/' + pathName, {
            name: pathName,
            source: cam.embed_url,
            sourceOnDemand: false
        });
        if (!addRes?.error) return addRes;
        if (addRes.status === 409) {
            return mediaMtxRequest('PATCH', '/patch/' + pathName, {
                source: cam.embed_url,
                sourceOnDemand: false
            });
        }
        return addRes;
    } else {
        // RTSP Camera
        const pathName = `cam_${cam.id}_input`;
        console.log(`Registering RTSP camera ${cam.id} (${cam.nama}) to MediaMTX...`);

        await mediaMtxRequest('DELETE', '/delete/' + pathName);

        const addRes = await mediaMtxRequest('POST', '/add/' + pathName, {
            name: pathName,
            source: cam.url_rtsp,
            sourceOnDemand: false,
            rtspTransport: 'tcp',
            sourceProtocol: 'tcp'
        });
        if (!addRes?.error) return addRes;
        if (addRes.status === 409) {
            return mediaMtxRequest('PATCH', '/patch/' + pathName, {
                source: cam.url_rtsp,
                sourceOnDemand: false,
                rtspTransport: 'tcp',
                sourceProtocol: 'tcp'
            });
        }
        return addRes;
    }
}

function syncCameras() {
    (async () => {
        const ok = await ensureMediaMtxAvailable();
        if (!ok) {
            console.log('MediaMTX tidak terdeteksi. Lewati sinkronisasi kamera.');
            return;
        }
        console.log('Syncing all cameras with MediaMTX...');
        db.all("SELECT * FROM cameras", async (err, rows) => {
            if (err) return console.error(err);
            for (const cam of rows) {
                await registerCamera(cam);
            }
        });
    })();
}

// --- Routes ---

const RECORDINGS_PAGE_LIMIT = 500;

// requireAnyAuth - Now imported from utils/middleware.js

// Public Dashboard
app.get('/', (req, res) => {
    let playableLevels = ['umum'];
    let visibleLevels = ['umum', 'member']; // Public sees UMUM (playable) and MEMBER (visible)
    let params = [];
    let isVVIP = false;
    let customerId = null;

    if (req.session && req.session.user) {
        // Admin: Sees everything
        playableLevels = null; // null means all
    } else if (req.session && req.session.customer) {
        const c = req.session.customer;
        const level = (c.level || 'umum').toLowerCase();
        customerId = c.id;

        if (level === 'admin') {
            playableLevels = null;
        } else if (level === 'vvip') {
            playableLevels = ['umum', 'member', 'vip', 'vvip'];
            visibleLevels = ['umum', 'member', 'vip', 'vvip'];
            isVVIP = true;
        } else if (level === 'pemerintahan') {
            playableLevels = ['umum', 'member', 'vip', 'pemerintahan'];
            visibleLevels = ['umum', 'member', 'vip', 'pemerintahan'];
        } else if (level === 'vip') {
            playableLevels = ['umum', 'member', 'vip'];
            visibleLevels = ['umum', 'member', 'vip'];
        } else if (level === 'member') {
            playableLevels = ['umum', 'member'];
            visibleLevels = ['umum', 'member', 'vip']; // Member sees MEMBER (playable) and VIP (visible)
        } else {
            // UMUM
            playableLevels = ['umum'];
            visibleLevels = ['umum', 'member'];
        }
    }

    let query = "";
    if (playableLevels === null) {
        query = "SELECT * FROM cameras";
    } else {
        const levels = visibleLevels.map(l => `'${l}'`).join(',');
        if (isVVIP) {
            query = `SELECT * FROM cameras WHERE LOWER(level) IN (${levels}) AND (LOWER(level) != 'vvip' OR owner_id = ?)`;
            params = [customerId];
        } else {
            query = `SELECT * FROM cameras WHERE LOWER(level) IN (${levels}) AND LOWER(level) != 'vvip'`;
        }
    }

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).send(err.message);
        
        // Add isPlayable flag
        const cameras = (rows || []).map(cam => {
            let isPlayable = false;
            if (playableLevels === null) {
                isPlayable = true;
            } else {
                isPlayable = playableLevels.includes(cam.level.toLowerCase());
                // Special check for VVIP ownership
                if (cam.level.toLowerCase() === 'vvip' && cam.owner_id != customerId) {
                    isPlayable = false;
                }
            }
            return { ...cam, isPlayable };
        });
        
        const userStatus = {
            isAdmin: !!req.session.user,
            isCustomer: !!req.session.customer,
            customerId: req.session.customer ? req.session.customer.id : null,
            customerLevel: req.session.customer ? req.session.customer.level : null
        };

        res.render('index', { 
            cameras: cameras, 
            mediamtx: config.mediamtx,
            hlsBaseUrl: getHlsBaseUrl(req, config),
            site: config.site,
            base_path: app.locals.base_path,
            isAdmin: userStatus.isAdmin,
            isCustomer: userStatus.isCustomer,
            customer: req.session.customer || null,
            userStatus: JSON.stringify(userStatus)
        });
    });
});

// Public Archive (Recordings)
app.get('/archive', requireAnyAuth, (req, res) => {
    const selectedDate = (req.query && req.query.date) ? String(req.query.date) : new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).slice(0, 10);
    const selectedCamId = (req.query && req.query.camera_id) ? String(req.query.camera_id) : '';

    // Get authorized cameras based on user level (matching new rules)
    let playableLevels = ['umum'];
    let params = [];
    let isVVIP = false;
    let customerId = null;

    if (req.session && req.session.user) {
        playableLevels = null;
    } else if (req.session && req.session.customer) {
        const c = req.session.customer;
        const level = (c.level || 'umum').toLowerCase();
        customerId = c.id;

        if (level === 'admin') {
            playableLevels = null;
        } else if (level === 'vvip') {
            playableLevels = ['umum', 'member', 'vip', 'vvip'];
            isVVIP = true;
        } else if (level === 'pemerintahan') {
            playableLevels = ['umum', 'member', 'vip', 'pemerintahan'];
        } else if (level === 'vip') {
            playableLevels = ['umum', 'member', 'vip'];
        } else if (level === 'member') {
            playableLevels = ['umum', 'member'];
        } else {
            playableLevels = ['umum'];
        }
    }

    let query = "";
    if (playableLevels === null) {
        query = "SELECT * FROM cameras";
    } else {
        const levels = playableLevels.map(l => `'${l}'`).join(',');
        if (isVVIP) {
            query = `SELECT * FROM cameras WHERE LOWER(level) IN (${levels}) AND (LOWER(level) != 'vvip' OR owner_id = ?)`;
            params = [customerId];
        } else {
            query = `SELECT * FROM cameras WHERE LOWER(level) IN (${levels}) AND LOWER(level) != 'vvip'`;
        }
    }

    db.all(query, params, (errCam, cams) => {
        if (errCam) return res.status(500).send(errCam.message);
        
        if (!cams || cams.length === 0) {
            return res.render('public_recordings', {
                recordings: [],
                cameras: [],
                site: config.site,
                filterDate: selectedDate,
                filterCameraId: selectedCamId,
                isAdmin: !!req.session.user,
                isCustomer: !!req.session.customer,
                customer: req.session.customer || null,
                userStatus: JSON.stringify({ isAdmin: !!req.session.user, isCustomer: !!req.session.customer }),
                base_path: app.locals.base_path || '',
                hlsBaseUrl: getHlsBaseUrl(req, config)
            });
        }

        const allowedCamIds = (cams || []).map(c => c.id);
        const cameraNameById = new Map((cams || []).map(cam => [String(cam.id), cam.nama]));
        const inPlaceholders = allowedCamIds.map(() => '?').join(',');
        const whereDate = selectedDate ? ' AND r.created_at LIKE ?' : '';
        const params = [...allowedCamIds];
        if (selectedDate) params.push(`${selectedDate}%`);
        const queryCam = selectedCamId ? ' AND r.camera_id = ?' : '';
        if (selectedCamId) params.push(selectedCamId);
        params.push(RECORDINGS_PAGE_LIMIT);

        const sql = `
            SELECT r.id, r.camera_id, r.filename, r.file_path, r.size, r.duration, r.created_at, r.title, r.notes
            FROM recordings r
            WHERE r.camera_id IN (${inPlaceholders})
            ${whereDate}
            ${queryCam}
            ORDER BY r.created_at DESC
            LIMIT ?
        `;

        db.all(sql, params, (errRec, dbRows) => {
            const rows = (!errRec && dbRows && dbRows.length > 0) ? dbRows : null;
            const sourceItems = rows ? rows : getRecordingsFromFilesystem(selectedDate).filter(r => allowedCamIds.includes(parseInt(r.camera_id)));
            const normalized = sourceItems.map(rec => {
                const name = cameraNameById.get(String(rec.camera_id)) || 'Unknown';
                return { ...rec, camera_name: name };
            });

            res.render('public_recordings', {
                recordings: normalized,
            cameras: cams || [],
            site: config.site,
            filterDate: selectedDate,
            filterCameraId: selectedCamId,
            isAdmin: !!req.session.user,
            isCustomer: !!req.session.customer,
            customer: req.session.customer || null,
            userStatus: JSON.stringify({
                isAdmin: !!req.session.user,
                isCustomer: !!req.session.customer,
                customerId: req.session.customer ? req.session.customer.id : null,
                customerLevel: req.session.customer ? req.session.customer.level : null
            }),
            base_path: app.locals.base_path || '',
            hlsBaseUrl: getHlsBaseUrl(req, config)
            });
        });
    });
});

// API to get recordings (for dynamic filtering in frontend)
app.get('/api/recordings', requireAnyAuth, (req, res) => {
    const selectedDate = req.query.date || '';
    const cameraId = req.query.camera_id || '';

    // Get authorized cameras based on user level (matching new unified rules)
    let playableLevels = ['umum'];
    let camParams = [];
    let isVVIP = false;
    let customerId = null;

    if (req.session && req.session.user) {
        playableLevels = null; // Admin
    } else if (req.session && req.session.customer) {
        const c = req.session.customer;
        const level = (c.level || 'umum').toLowerCase();
        customerId = c.id;

        if (level === 'admin') {
            playableLevels = null;
        } else if (level === 'vvip') {
            playableLevels = ['umum', 'member', 'vip', 'vvip'];
            isVVIP = true;
        } else if (level === 'pemerintahan') {
            playableLevels = ['umum', 'member', 'vip', 'pemerintahan'];
        } else if (level === 'vip') {
            playableLevels = ['umum', 'member', 'vip'];
        } else if (level === 'member') {
            playableLevels = ['umum', 'member'];
        } else {
            playableLevels = ['umum'];
        }
    }

    let camQuery = "";
    if (playableLevels === null) {
        camQuery = "SELECT id FROM cameras";
    } else {
        const levels = playableLevels.map(l => `'${l}'`).join(',');
        if (isVVIP) {
            camQuery = `SELECT id FROM cameras WHERE LOWER(level) IN (${levels}) AND (LOWER(level) != 'vvip' OR owner_id = ?)`;
            camParams = [customerId];
        } else {
            camQuery = `SELECT id FROM cameras WHERE LOWER(level) IN (${levels}) AND LOWER(level) != 'vvip'`;
        }
    }

    db.all(camQuery, camParams, (errCam, cams) => {
        if (errCam) return res.status(500).json({ error: errCam.message });
        const allowedCamIds = (cams || []).map(c => c.id);
        
        if (allowedCamIds.length === 0) return res.json({ recordings: [], totalCount: 0 });
        const inPlaceholders = allowedCamIds.map(() => '?').join(',');
        const whereDate = selectedDate ? ' AND r.created_at LIKE ?' : '';
        const params = [...allowedCamIds];
        if (selectedDate) params.push(`${selectedDate}%`);
        if (cameraId) params.push(cameraId);
        params.push(RECORDINGS_PAGE_LIMIT);

        const sql = `
            SELECT r.id, r.camera_id, r.filename, r.file_path, r.size, r.duration, r.created_at, r.title, r.notes
            FROM recordings r
            WHERE r.camera_id IN (${inPlaceholders})
            ${whereDate}
            ${cameraId ? ' AND r.camera_id = ?' : ''}
            ORDER BY r.created_at DESC
            LIMIT ?
        `;

        db.all(sql, params, (errRec, rows) => {
            if (!errRec && rows && rows.length > 0) {
                return res.json({ recordings: rows, totalCount: rows.length, source: 'db' });
            }
            const recordings = getRecordingsFromFilesystem(selectedDate);
            let filtered = recordings.filter(r => allowedCamIds.includes(parseInt(r.camera_id)));
            if (cameraId) filtered = filtered.filter(r => String(r.camera_id) === String(cameraId));
            res.json({ recordings: filtered, totalCount: filtered.length, source: 'fs' });
        });
    });
});

// API to sync recordings from filesystem
app.get('/api/recordings/sync', requireApiAuth, (req, res) => {
    const items = getRecordingsFromFilesystem();
    if (items.length === 0) return res.json({ message: "No files found", count: 0 });

    let added = 0;
    let processed = 0;

    const finalize = () => {
        processed++;
        if (processed === items.length) {
            res.json({ message: "Sync complete", totalFound: items.length, added });
        }
    };

    items.forEach(item => {
        db.get("SELECT id FROM recordings WHERE file_path = ?", [item.file_path], (err, row) => {
            if (!row && !err) {
                db.run(`INSERT INTO recordings (camera_id, filename, file_path, size, created_at) VALUES (?, ?, ?, ?, ?)`,
                    [item.camera_id, item.filename, item.file_path, item.size, item.created_at],
                    (insErr) => {
                        if (!insErr) added++;
                        finalize();
                    }
                );
            } else {
                finalize();
            }
        });
    });
});

app.get('/weather', (req, res) => {
    db.all("SELECT id, nama, lokasi, lat, lng FROM cameras WHERE is_public = 1 AND lat IS NOT NULL AND lng IS NOT NULL", [], (err, rows) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Database Error");
        }
        res.render('weather', {
            cameras: rows || [],
            site: config.site,
            isAdmin: !!req.session.user,
            isCustomer: !!req.session.customer,
            customer: req.session.customer || null
        });
    });
});

// Login Routes
app.get('/login', (req, res) => {
    if (req.session && req.session.user === ADMIN_USER) {
        return res.redirect(app.locals.base_path + '/admin');
    }
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    console.log(`[Login] Attempt for user: ${username}`);

    const userOk = username === ADMIN_USER;
    const passOk = ADMIN_PASS_HASH ? bcrypt.compareSync(password, ADMIN_PASS_HASH) : (password === ADMIN_PASS);

    if (userOk && passOk) {
        req.session.user = username;
        console.log(`[Login] Success - Session ID: ${req.sessionID}`);
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        if (loginAttempts[ip]) {
            delete loginAttempts[ip];
        }
        // Log activity
        activityLogger.logActivity({
            action: 'admin_login',
            category: 'auth',
            description: 'Admin login berhasil',
            actor: { type: 'admin', name: 'Admin' },
            details: { username },
            req,
            status: 'success'
        });
        res.redirect(app.locals.base_path + '/admin');
    } else {
        console.log(`[Login] Failed - Invalid credentials`);
        // Log failed login
        activityLogger.logActivity({
            action: 'admin_login_failed',
            category: 'auth',
            description: 'Percobaan login admin gagal',
            actor: { type: 'system', name: username || 'Unknown' },
            details: { username },
            req,
            status: 'failed'
        });

        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();
        const windowMs = 5 * 60 * 1000;
        const threshold = 5;

        if (!loginAttempts[ip]) {
            loginAttempts[ip] = { count: 1, firstAttempt: now, alerted: false };
        } else {
            const entry = loginAttempts[ip];
            if (now - entry.firstAttempt > windowMs) {
                loginAttempts[ip] = { count: 1, firstAttempt: now, alerted: false };
            } else {
                entry.count += 1;
            }
        }

        const entry = loginAttempts[ip];
        if (!entry.alerted && entry.count >= threshold) {
            sendTelegramMessage(`⚠️ <b>Banyak login admin gagal</b>\nIP: ${ip}\nPercobaan gagal: ${entry.count} dalam 5 menit`);
            entry.alerted = true;
        }

        res.render('login', { error: 'Username atau Password salah!' });
    }
});

app.get('/logout', (req, res) => {
    // Log activity before destroying session
    const actor = req.session?.user 
        ? { type: 'admin', id: null, name: 'Admin' }
        : (req.session?.customer 
            ? { type: 'customer', id: req.session.customer.id, name: req.session.customer.full_name || req.session.customer.username }
            : { type: 'system', id: null, name: 'System' });
    
    activityLogger.logActivity({
        action: 'admin_logout',
        category: 'auth',
        description: 'Admin logout',
        actor,
        details: { session_id: req.sessionID },
        req,
        status: 'success'
    });

    req.session.destroy();
    res.redirect(app.locals.base_path + '/login');
});

// --- Customer Auth Routes ---

app.get('/user/register', (req, res) => {
    res.render('register', { base_path: app.locals.base_path, site: config.site, error: null });
});

app.post('/user/register', async (req, res) => {
    const { username, password, full_name, email, phone } = req.body;
    if (!username || !password) {
        return res.render('register', { base_path: app.locals.base_path, site: config.site, error: 'Username dan password wajib diisi' });
    }

    try {
        const basePath = String(app.locals.base_path || '');
        const basePathNormalized = basePath ? ('/' + basePath.replace(/^\/+/, '').replace(/\/+$/, '')) : '';
        const cfgPublic = (config.server && config.server.public_base_url) ? String(config.server.public_base_url).trim() : '';
        const host = req.headers.host ? String(req.headers.host) : '';
        const derived = host ? `${req.protocol}://${host}` : '';
        const appBaseUrl = ((cfgPublic || derived) ? `${(cfgPublic || derived).replace(/\/+$/, '')}${basePathNormalized}` : '').replace(/\/+$/, '');

        const hashedPassword = await bcrypt.hash(password, 10);
        db.run("INSERT INTO users (username, password, level, full_name, email, phone) VALUES (?, ?, 'umum', ?, ?, ?)", 
            [username, hashedPassword, full_name, email, phone], 
            function(err) {
                if (err) {
                    console.error('[Register] Error:', err.message);
                    return res.render('register', { base_path: app.locals.base_path, site: config.site, error: 'Username sudah digunakan atau terjadi kesalahan' });
                }
                // Auto login
                req.session.customer = { id: this.lastID, username, level: 'umum', full_name };
                
                // Notifikasi WA ke admin (baca dari config admin_numbers)
                let adminNumbers = [];
                if (config.whatsapp && config.whatsapp.admin_numbers) {
                    adminNumbers = config.whatsapp.admin_numbers.split(',').map(n => n.trim()).filter(n => n);
                }
                
                const adminLink = appBaseUrl ? `\n\n🔗 Admin: ${appBaseUrl}/admin` : '';
                const adminMsg = `🔔 *PENDAFTARAN BARU* 🔔\n\nPelanggan baru telah mendaftar:\n👤 Nama: ${full_name}\n📞 No HP: ${phone}\n📧 Email: ${email || '-'}\n\nSilakan cek di dashboard admin.${adminLink}`;
                
                if (adminNumbers.length > 0) {
                    adminNumbers.forEach(num => {
                        whatsappBot.sendWA(num, adminMsg);
                    });
                } else {
                    // Fallback ke tabel users jika config kosong
                    db.all("SELECT phone FROM users WHERE level = 'admin' AND phone IS NOT NULL", [], (err, admins) => {
                        if (!err && admins) {
                            admins.forEach(admin => {
                                if (admin.phone) whatsappBot.sendWA(admin.phone, adminMsg);
                            });
                        }
                    });
                }

                // Notifikasi WA ke pelanggan
                if (phone) {
                    const loginLink = appBaseUrl ? `\n\n🔗 Login: ${appBaseUrl}/user/login\n🔗 Dashboard: ${appBaseUrl}/` : '';
                    const custMsg = `Halo *${full_name}*, terima kasih telah mendaftar di *${config.site.title || 'CCTV TPNET CENTER'}*.\n\nAkun Anda telah aktif. Jika butuh bantuan, silakan hubungi admin kami.${loginLink}`;
                    whatsappBot.sendWA(phone, custMsg);
                }

                res.redirect(app.locals.base_path + '/');
            }
        );
    } catch (e) {
        res.status(500).send('Registration error');
    }
});

app.get('/user/login', (req, res) => {
    res.render('user-login', { base_path: app.locals.base_path, site: config.site, error: null });
});

app.post('/user/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (err || !user) {
            if (DEBUG_AUTH) {
                console.log(`[Login Debug] User ${username} not found, err:`, err?.message);
            }
            return res.render('user-login', { error: 'Username tidak ditemukan!' });
        }

        let passOk = false;
        try {
            passOk = bcrypt.compareSync(password, user.password);
            if (DEBUG_AUTH) {
                console.log(`[Login Debug] bcrypt.compareSync result: ${passOk}`);
            }
        } catch (e) {
            if (DEBUG_AUTH) {
                console.error(`[Login Debug] bcrypt.compareSync ERROR:`, e.message);
            }
        }

        // Ultimate fallback: if everything fails, try direct SHA256 HMAC comparison
        // as a last resort for systems where even crypto.scryptSync might return different results
        if (!passOk && user.password && user.password.startsWith('$fb_')) {
            try {
                const crypto = require('crypto');
                const algo = user.password.startsWith('$fb_sha256$') ? 'sha256' : 
                             user.password.startsWith('$fb_pbkdf2$') ? 'pbkdf2' : 
                             user.password.startsWith('$fb_scrypt$') ? 'scrypt' : null;
                if (DEBUG_AUTH) {
                    console.log(`[Login Debug] Trying ultimate fallback for algo: ${algo}`);
                }
                
                if (algo === 'sha256') {
                    const body = user.password.slice('$fb_sha256$'.length);
                    const parts = body.split('$');
                    const salt = parts[0] || '';
                    const storedHash = parts[1] || '';
                    const computed = crypto.createHmac('sha256', salt).update(password).digest('hex');
                    passOk = computed === storedHash;
                    if (DEBUG_AUTH) {
                        console.log(`[Login Debug] SHA256 fallback result: ${passOk}`);
                    }
                }
            } catch (e) {
                if (DEBUG_AUTH) {
                    console.error(`[Login Debug] Ultimate fallback error:`, e.message);
                }
            }
        }

        if (passOk) {
            req.session.customer = {
                id: user.id,
                username: user.username,
                level: user.level,
                full_name: user.full_name
            };
            res.redirect(app.locals.base_path + '/');
        } else {
            res.render('user-login', { error: 'Password salah!' });
        }
    });
});

app.get('/user/logout', (req, res) => {
    // Log activity before clearing session
    const actor = req.session?.customer
        ? { type: 'customer', id: req.session.customer.id, name: req.session.customer.full_name || req.session.customer.username }
        : { type: 'system', id: null, name: 'System' };

    activityLogger.logActivity({
        action: 'customer_logout',
        category: 'auth',
        description: 'Customer logout',
        actor,
        details: { 
            username: req.session?.customer?.username || 'unknown',
            level: req.session?.customer?.level || 'unknown'
        },
        req,
        status: 'success'
    });

    delete req.session.customer;
    res.redirect(app.locals.base_path + '/user/login');
});

// --- ADMIN ROUTES (NEW MULTI-PAGE) ---

// Dashboard Overview
app.get('/admin', requireAuth, (req, res) => {
    db.all("SELECT id FROM cameras", [], (err, cameraRows) => {
        db.all("SELECT id FROM users", [], (err2, userRows) => {
            res.render('admin_dashboard', {
                page: 'dashboard',
                cameras: cameraRows || [],
                users: userRows || [],
                user: req.session.user,
                base_path: app.locals.base_path || '',
                site: config.site || {}
            });
        });
    });
});

// Camera Management
app.get('/admin/cameras', requireAuth, (req, res) => {
    db.all("SELECT * FROM cameras ORDER BY id DESC", [], (err, cameraRows) => {
        db.all("SELECT id, username, full_name FROM users", [], (err2, userRows) => {
            res.render('admin_cameras', {
                page: 'cameras',
                cameras: cameraRows || [],
                users: userRows || [],
                user: req.session.user,
                base_path: app.locals.base_path || '',
                site: config.site || {},
                map: config.map || { default_lat: -6.2517, default_lng: 107.9207, default_zoom: 13 },
                mapConfig: config.map || { default_lat: -6.2517, default_lng: 107.9207, default_zoom: 13 }
            });
        });
    });
});

// DVR/APK Camera Addition Page
app.get('/admin/dvr-apk', requireAuth, (req, res) => {
    res.render('admin_dvr_apk', {
        page: 'dvr_apk',
        user: req.session.user,
        base_path: app.locals.base_path || '',
        site: config.site || {}
    });
});

// APK CCTV - Cloud/P2P Camera Addition (Seperti Aplikasi Android)
app.get('/admin/apk-cctv', requireAuth, (req, res) => {
    db.all("SELECT id, nama, camera_type FROM cameras", [], (err, cameraRows) => {
        res.render('admin_apk_cctv', {
            page: 'apk_cctv',
            user: req.session.user,
            cameras: cameraRows || [],
            base_path: app.locals.base_path || '',
            site: config.site || {}
        });
    });
});

// P2P Stream Manager - Professional P2P Stream Relay Management
app.get('/admin/p2p-stream', requireAuth, (req, res) => {
    res.render('admin_p2p_stream', {
        page: 'p2p_stream',
        user: req.session.user,
        base_path: app.locals.base_path || '',
        site: config.site || {}
    });
});

// API: Check P2P Stream Status (for P2P relay via RTMP/HLS)
app.get('/api/p2p/stream-status', requireApiAuth, (req, res) => {
    const streamKey = req.query.key || '';
    if (!streamKey) {
        return res.json({ active: false, error: 'No stream key' });
    }
    
    // Check if stream is active in MediaMTX
    (async () => {
        try {
            const pathsData = await mediaMtxRequest('GET', '/v3/paths/list');
            if (pathsData?.error) {
                // Fallback: check if RTMP is running on port 1935
                return res.json({ active: false, error: 'MediaMTX not available' });
            }
            
            const items = pathsData.items || [];
            const streamActive = items.some(p => p.name === streamKey && p.ready === true);
            
            if (streamActive) {
                const hlsUrl = `${getHlsBaseUrl(req, config)}/${streamKey}/index.m3u8`;
                res.json({ 
                    active: true, 
                    streamKey,
                    hlsUrl,
                    message: `Stream ${streamKey} is active`
                });
            } else {
                res.json({ 
                    active: false, 
                    streamKey,
                    message: `Stream ${streamKey} is not active. Use OBS/FFmpeg to relay.`
                });
            }
        } catch (e) {
            res.json({ active: false, error: e.message });
        }
    })();
});

// API: Test RTSP Connection for DVR/APK
app.post('/api/dvr/test-rtsp', requireApiAuth, async (req, res) => {
    const { url, brand } = req.body;
    if (!url || !url.startsWith('rtsp://')) {
        return res.json({ success: false, message: 'URL RTSP tidak valid. Gunakan format rtsp://...' });
    }
    try {
        // Extract host and port from URL
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;
        const port = urlObj.port || 554;
        
        // Test TCP connection to RTSP port
        const net = require('net');
        const startTime = Date.now();
        
        const result = await new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(5000);
            
            socket.on('connect', () => {
                const latency = Date.now() - startTime;
                socket.destroy();
                resolve({ 
                    success: true, 
                    latency, 
                    message: `Port ${port} terbuka. Kamera ${brand || ''} dapat dijangkau. Latency: ${latency}ms` 
                });
            });
            
            socket.on('error', (err) => {
                socket.destroy();
                resolve({ 
                    success: false, 
                    message: `Tidak dapat terhubung ke ${hostname}:${port} - ${err.message}` 
                });
            });
            
            socket.on('timeout', () => {
                socket.destroy();
                resolve({ 
                    success: false, 
                    message: `Timeout: ${hostname}:${port} tidak merespon dalam 5 detik` 
                });
            });
            
            socket.connect(port, hostname);
        });
        
        res.json(result);
    } catch (e) {
        res.json({ success: false, message: `Error: ${e.message}` });
    }
});

// PTZ Control
app.get('/admin/ptz', requireAuth, (req, res) => {
    db.all("SELECT id, nama, lokasi, url_rtsp FROM cameras", [], (err, cameraRows) => {
        res.render('admin_ptz', {
            page: 'ptz',
            cameras: cameraRows || [],
            user: req.session.user,
            base_path: app.locals.base_path || '',
            site: config.site || {},
            hlsBaseUrl: getHlsBaseUrl(req, config)
        });
    });
});

// Customer Management
app.get('/admin/customers', requireAuth, (req, res) => {
    db.all("SELECT id, username, level, full_name, phone, email, address, active_until, created_at FROM users ORDER BY created_at DESC", [], (err, userRows) => {
        res.render('admin_customers', {
            page: 'customers',
            users: userRows || [],
            user: req.session.user,
            base_path: app.locals.base_path || '',
            site: config.site || {}
        });
    });
});

// YouTube & Streaming Configuration
app.get('/admin/streaming', requireAuth, (req, res) => {
    db.all("SELECT id, nama, lokasi, url_rtsp FROM cameras", [], (err, cameraRows) => {
        res.render('admin_streaming', {
            page: 'streaming',
            cameras: cameraRows || [],
            user: req.session.user,
            mediamtx: config.mediamtx || {},
            base_path: app.locals.base_path || '',
            site: config.site || {}
        });
    });
});

// Recording Schedule & Settings
app.get('/admin/recordings', requireAuth, (req, res) => {
    res.render('admin_recordings', {
        page: 'recordings',
        user: req.session.user,
        recording: config.recording || {},
        base_path: app.locals.base_path || '',
        site: config.site || {}
    });
});

// ============================================
// PERMISSION MANAGER API
// ============================================
const levelPermissions = require('./services/levelPermissions');

// Initialize permission table on startup
levelPermissions.initTable();

// Get all permissions
app.get('/api/permissions/all', requireApiAuth, async (req, res) => {
    try {
        const permissions = await levelPermissions.getAllPermissions();
        res.json({ success: true, permissions });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// Save all permissions
app.post('/api/permissions/save-all', requireApiAuth, async (req, res) => {
    try {
        const { permissions } = req.body;
        if (!permissions) {
            return res.json({ success: false, error: 'No permissions data' });
        }
        for (const [level, perms] of Object.entries(permissions)) {
            await levelPermissions.saveLevelPermissions(level, perms);
        }
        res.json({ success: true, message: 'All permissions saved' });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// Reset permissions to defaults
app.post('/api/permissions/reset', requireApiAuth, async (req, res) => {
    try {
        const { DEFAULT_PERMISSIONS } = require('./services/levelPermissions');
        for (const [level, perms] of Object.entries(DEFAULT_PERMISSIONS)) {
            await levelPermissions.saveLevelPermissions(level, perms);
        }
        res.json({ success: true, message: 'Permissions reset to defaults' });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// Get permissions for a specific level
app.get('/api/permissions/:level', requireApiAuth, async (req, res) => {
    try {
        const perms = await levelPermissions.getLevelPermissions(req.params.level);
        res.json({ success: true, level: req.params.level, permissions: perms });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// Permission Manager Page
app.get('/admin/permissions', requireAuth, (req, res) => {
    res.render('admin_permissions', {
        page: 'permissions',
        user: req.session.user,
        base_path: app.locals.base_path || '',
        site: config.site || {}
    });
});

// ============================================
// ACTIVITY LOGGER - Audit Trail Premium
// ============================================

// Initialize activity logger (activityLogger imported at top of file)
activityLogger.initTable().then(() => {
    console.log('[ActivityLogger] Initialized');
});

// Activity Logs Page - with permission check
app.get('/admin/activity', requireAuth, async (req, res) => {
    // Check permission via levelPermissions
    try {
        const adminPerms = levelPermissions.DEFAULT_PERMISSIONS.admin;
        const perms = await levelPermissions.getLevelPermissions('admin');
        if (!levelPermissions.canAccess(perms, 'admin_activity')) {
            return res.status(403).render('admin_activity', {
                page: 'activity',
                user: req.session.user,
                base_path: app.locals.base_path || '',
                site: config.site || {},
                accessDenied: true
            });
        }
    } catch(e) {
        console.error('[Activity] Permission check error:', e.message);
    }
    
    res.render('admin_activity', {
        page: 'activity',
        user: req.session.user,
        base_path: app.locals.base_path || '',
        site: config.site || {},
        accessDenied: false
    });
});

// API: Get activity logs with filtering & pagination
app.get('/api/activity/logs', requireApiAuth, async (req, res) => {
    try {
        const result = await activityLogger.getActivityLogs({
            limit: parseInt(req.query.limit) || 50,
            offset: parseInt(req.query.offset) || 0,
            category: req.query.category || null,
            action: req.query.action || null,
            actor_name: req.query.actor_name || null,
            target_type: req.query.target_type || null,
            status: req.query.status || null,
            start_date: req.query.start_date || null,
            end_date: req.query.end_date || null,
            search: req.query.search || null
        });
        res.json({ success: true, ...result });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// API: Get activity statistics
app.get('/api/activity/stats', requireApiAuth, async (req, res) => {
    try {
        const stats = await activityLogger.getActivityStats();
        res.json({ success: true, stats });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// API: Clean old activity logs (admin only)
app.post('/api/activity/clean', requireApiAuth, async (req, res) => {
    try {
        const days = parseInt(req.body.retention_days) || 90;
        const result = await activityLogger.cleanOldLogs(days);
        
        // Log the clean action
        activityLogger.logActivity({
            action: 'activity_logs_clean',
            category: 'system',
            description: `Membersihkan log aktivitas lebih dari ${days} hari`,
            actor: { type: 'admin', name: 'Admin' },
            details: { retention_days: days, deleted: result.deleted },
            req,
            status: 'success'
        });
        
        res.json({ success: true, ...result });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// API: Reset ALL activity logs (delete everything)
app.post('/api/activity/reset', requireApiAuth, async (req, res) => {
    try {
        console.log('[Activity] Reset requested by admin');
        
        // DIRECT SQL APPROACH - bypass module to avoid WAL issues
        db.serialize(() => {
            // Step 1: Force WAL checkpoint
            db.run("PRAGMA wal_checkpoint(TRUNCATE)");
            
            // Step 2: Switch to DELETE journal mode temporarily
            db.run("PRAGMA journal_mode=DELETE");
            
            // Step 3: Delete all rows
            db.run("DELETE FROM activity_logs", function(err) {
                if (err) {
                    console.error('[Activity] Delete failed:', err.message);
                    db.run("PRAGMA journal_mode=WAL");
                    return res.json({ success: false, error: err.message });
                }
                
                console.log(`[Activity] DELETE executed, changes: ${this.changes || 0}`);
            });
            
            // Step 4: Verify count is 0
            db.get("SELECT COUNT(*) as total FROM activity_logs", (err, row) => {
                const remaining = row?.total || 0;
                console.log(`[Activity] After delete, remaining: ${remaining}`);
                
                // Step 5: Switch back to WAL
                db.run("PRAGMA journal_mode=WAL", () => {
                    // Step 6: Vacuum
                    db.run("VACUUM");
                    
                    // Step 7: Final verification
                    db.get("SELECT COUNT(*) as total FROM activity_logs", (err2, row2) => {
                        const finalCount = row2?.total || 0;
                        console.log(`[Activity] Reset final count: ${finalCount}`);
                        
                        // Send response
                        res.json({ 
                            success: finalCount === 0, 
                            deleted: true, 
                            remaining: finalCount,
                            message: finalCount === 0 ? 'Semua log berhasil dihapus' : `Masih ada ${finalCount} log`
                        });
                    });
                });
            });
        });
    } catch (e) {
        console.error('[Activity] Reset error:', e);
        res.json({ success: false, error: e.message || String(e) });
    }
});

// Middleware: Log admin login
const originalLoginRoute = app.post;
// We'll inject logging into existing routes directly below

// ============================================
// STORAGE MANAGER API
// ============================================
const storageManager = require('./services/storageManager');

// Storage Manager Page
app.get('/admin/storage', requireAuth, (req, res) => {
    res.render('admin_storage', {
        page: 'storage',
        user: req.session.user,
        base_path: app.locals.base_path || '',
        site: config.site || {}
    });
});

// Get all storage devices
app.get('/api/storage/devices', requireApiAuth, async (req, res) => {
    try {
        const devices = await storageManager.scanStorageDevices();
        const activePath = storageManager.getRecordingsPath(config);
        res.json({ success: true, devices, activePath });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// Set active storage
app.post('/api/storage/set', requireApiAuth, async (req, res) => {
    try {
        const { path: storagePath } = req.body;
        if (!storagePath) {
            return res.json({ success: false, error: 'Path is required' });
        }
        const result = storageManager.setActiveStorage(storagePath, config);
        try {
            await updateMediaMtxRecording();
        } catch { }
        res.json(result);
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// Explore directory
app.post('/api/storage/explore', requireApiAuth, (req, res) => {
    try {
        const { path: dirPath } = req.body;
        const safePath = dirPath || storageManager.getRecordingsPath(config);
        const result = storageManager.scanDirectory(safePath);
        res.json({ success: true, ...result });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// Incident Reports
app.get('/admin/reports', requireAuth, (req, res) => {
    res.render('admin_reports', {
        page: 'reports',
        user: req.session.user,
        base_path: app.locals.base_path || '',
        site: config.site || {}
    });
});

// Customer Account Route
app.get('/user/account', (req, res) => {
    if (!req.session.customer && !req.session.user) {
        return res.redirect(app.locals.base_path + '/user/login');
    }

    const user = req.session.customer || req.session.user;
    const userId = user && typeof user === 'object' ? user.id : (user === ADMIN_USER ? 1 : null);

    // Get User Data, Packages, and Transaction History
    db.get("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
        db.all("SELECT * FROM billing_packages ORDER BY price ASC", [], (err, packages) => {
            db.all("SELECT * FROM bank_accounts ORDER BY id ASC", [], (err, bank_accounts) => {
                const transQuery = `
                    SELECT t.*, b.name as package_name 
                    FROM transactions t
                    LEFT JOIN billing_packages b ON t.package_id = b.id
                    WHERE t.user_id = ?
                    ORDER BY t.created_at DESC
                `;
                db.all(transQuery, [userId], (err, transactions) => {
                    const reportsQuery = `
                        SELECT r.*, c.nama as camera_name 
                        FROM incident_reports r
                        LEFT JOIN cameras c ON r.camera_id = c.id
                        WHERE r.user_id = ?
                        ORDER BY r.created_at DESC
                    `;
                    db.all(reportsQuery, [userId], (err, reports) => {
                        res.render('user_account', {
                            user: user || {},
                            packages: packages || [],
                            bank_accounts: bank_accounts || [],
                            transactions: transactions || [],
                            reports: reports || [],
                            base_path: app.locals.base_path || '',
                            site: config.site || {}
                        });
                    });
                });
            });

        });
    });
});

// Profile Update Route
app.post('/api/user/update-profile', (req, res) => {
    const user = req.session.customer || req.session.user;
    if (!user) return res.status(401).json({ success: false, message: 'Silakan login terlebih dahulu' });
    
    const userId = user.id;
    const { full_name, phone, email, address, password } = req.body;
    
    if (password) {
        const hash = bcrypt.hashSync(password, 10);
        db.run("UPDATE users SET full_name = ?, phone = ?, email = ?, address = ?, password = ? WHERE id = ?",
            [full_name, phone, email, address, hash, userId], (err) => {
                if (err) return res.status(500).json({ success: false, message: err.message });
                // Update session
                db.get("SELECT * FROM users WHERE id = ?", [userId], (err, newUser) => {
                    if (req.session.customer) req.session.customer = newUser;
                    if (req.session.user) req.session.user = newUser;
                    res.json({ success: true, message: 'Profil dan password berhasil diperbarui' });
                });
            });
    } else {
        db.run("UPDATE users SET full_name = ?, phone = ?, email = ?, address = ? WHERE id = ?",
            [full_name, phone, email, address, userId], (err) => {
                if (err) return res.status(500).json({ success: false, message: err.message });
                // Update session
                db.get("SELECT * FROM users WHERE id = ?", [userId], (err, newUser) => {
                    if (req.session.customer) req.session.customer = newUser;
                    if (req.session.user) req.session.user = newUser;
                    res.json({ success: true, message: 'Profil berhasil diperbarui' });
                });
            });
    }
});

// Payment & Billing Routes
app.post('/api/billing/buy', (req, res) => {
    const user = req.session.customer || req.session.user;
    if (!user) return res.status(401).json({ success: false, message: 'Silakan login terlebih dahulu' });
    
    const { packageId, bankInfo, proofImage } = req.body;
    const userId = user.id;
    
    if (!userId) return res.status(400).json({ success: false, message: 'Data sesi tidak valid (User ID hilang)' });
    if (!packageId) return res.status(400).json({ success: false, message: 'ID Paket tidak valid' });
    if (!proofImage) return res.status(400).json({ success: false, message: 'Bukti pembayaran wajib diunggah' });

    console.log(`[Billing] User ${userId} attempting to buy package ${packageId}`);

    // Check if user has pending transaction in last 24 hours
    db.get("SELECT id FROM transactions WHERE user_id = ? AND LOWER(payment_status) = 'pending' AND created_at > datetime('now', '-1 day')", [userId], (err, pending) => {
        if (pending) {
            return res.status(400).json({ 
                success: false, 
                message: 'Anda memiliki pembayaran yang masih menunggu verifikasi admin. Mohon tunggu 24 jam atau hubungi admin.' 
            });
        }

        db.get("SELECT * FROM billing_packages WHERE id = ?", [packageId], (err, pkg) => {
            if (err || !pkg) return res.status(404).json({ success: false, message: 'Paket tidak ditemukan' });

            // Handle Image Save
            let fileName = null;
            if (proofImage && proofImage.startsWith('data:image')) {
                const base64Data = proofImage.replace(/^data:image\/\w+;base64,/, "");
                const buffer = Buffer.from(base64Data, 'base64');
                const uploadDir = path.join(__dirname, 'bukti_tf');
                if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                
                const now = new Date();
                const d = now.getDate().toString().padStart(2, '0');
                const m = (now.getMonth() + 1).toString().padStart(2, '0');
                const y = now.getFullYear();
                const hh = now.getHours().toString().padStart(2, '0');
                const mm = now.getMinutes().toString().padStart(2, '0');
                
                fileName = `buktitf_${userId}_${d}${m}${y}_${hh}${mm}.jpg`;
                fs.writeFileSync(path.join(uploadDir, fileName), buffer);
                fileName = `bukti_tf/${fileName}`; // Save relative path
            }


            db.run(
                "INSERT INTO transactions (user_id, package_id, amount, payment_status, payment_method, bank_info, proof_image) VALUES (?, ?, ?, 'pending', 'Transfer Bank', ?, ?)",
                [userId, packageId, pkg.price, bankInfo, fileName],
                function (err) {
                    if (err) {
                        console.error('[Billing] Insert error:', err.message);
                        return res.status(500).json({ success: false, message: 'Gagal membuat transaksi: ' + err.message });
                    }
                    res.json({ success: true, transactionId: this.lastID });
                }
            );
        });
    });
});

app.post('/api/billing/upload-proof', (req, res) => {
    if (!req.session.customer && !req.session.user) return res.status(401).json({ success: false });
    const { transactionId, proofImage } = req.body;

    if (!proofImage || !proofImage.includes('base64,')) {
        return res.status(400).json({ success: false, message: 'Format gambar tidak valid' });
    }

    try {
        const userId = req.session.customer ? req.session.customer.id : (req.session.user ? 'admin' : 'unknown');
        const base64Data = proofImage.split('base64,')[1];
        
        const now = new Date();
        const d = now.getDate().toString().padStart(2, '0');
        const m = (now.getMonth() + 1).toString().padStart(2, '0');
        const y = now.getFullYear();
        const hh = now.getHours().toString().padStart(2, '0');
        const mm = now.getMinutes().toString().padStart(2, '0');
        
        const fileName = `buktitf_${userId}_${d}${m}${y}_${hh}${mm}.jpg`;
        const dirPath = path.join(__dirname, 'bukti_tf');
        const filePath = path.join(dirPath, fileName);

        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

        fs.writeFile(filePath, base64Data, 'base64', (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Gagal menyimpan file' });
            
            const relativePath = `bukti_tf/${fileName}`;
            db.run("UPDATE transactions SET proof_image = ?, payment_status = 'pending' WHERE id = ?", [relativePath, transactionId], (err) => {
                if (err) return res.status(500).json({ success: false, message: 'Gagal update database' });
                res.json({ success: true });
            });
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }

});

// Incident Reporting API
app.post('/api/reports/submit', (req, res) => {
    const { camera_id, category, description } = req.body;
    const user = req.session.customer || req.session.user;
    
    const userId = user ? user.id : null;
    const reporterName = user ? (user.full_name || user.username) : 'Anonim';
    const reporterContact = user ? (user.phone || user.email || 'N/A') : 'N/A';

    db.run("INSERT INTO incident_reports (camera_id, category, description, reporter_name, reporter_contact, user_id, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
        [camera_id, category, description, reporterName, reporterContact, userId], (err) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true });
        });
});

// Global Settings (Web, Telegram, Password)
app.get('/admin/settings', requireAuth, (req, res) => {
    res.render('admin_settings', {
        page: 'settings',
        user: req.session.user,
        site: config.site || {},
        telegram: config.telegram || {},
        whatsapp: config.whatsapp || {},
        map: config.map || { default_lat: 0, default_lng: 0, default_zoom: 13 },
        base_path: app.locals.base_path || ''
    });
});

// ============================================
// ALERT SYSTEM ROUTES & API
// ============================================

// Alert Management Page
app.get('/admin/alerts', requireAuth, (req, res) => {
    res.render('admin_alerts', {
        page: 'alerts',
        user: req.session.user,
        base_path: app.locals.base_path || ''
    });
});

// Alert History Page
app.get('/admin/alerts/history', requireAuth, (req, res) => {
    res.render('admin_alert_history', {
        page: 'alerts',
        user: req.session.user,
        base_path: app.locals.base_path || ''
    });
});

// API: Get Alert Statistics
app.get('/api/alerts/stats', requireAuth, (req, res) => {
    try {
        db.get(`
            SELECT 
                COUNT(*) as total_rules,
                SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as active_rules
            FROM alert_rules
        `, (err, ruleStats) => {
            if (err) {
                return res.json({ success: false, message: err.message });
            }

            db.get(`
                SELECT 
                    COUNT(*) as alerts_today
                FROM alert_history
                WHERE DATE(triggered_at) = DATE('now')
            `, (err2, todayStats) => {
                if (err2) {
                    return res.json({ success: false, message: err2.message });
                }

                db.get(`
                    SELECT 
                        COUNT(*) as alerts_week
                    FROM alert_history
                    WHERE triggered_at >= datetime('now', '-7 days')
                `, (err3, weekStats) => {
                    if (err3) {
                        return res.json({ success: false, message: err3.message });
                    }

                    res.json({
                        success: true,
                        stats: {
                            total_rules: ruleStats.total_rules || 0,
                            active_rules: ruleStats.active_rules || 0,
                            alerts_today: todayStats.alerts_today || 0,
                            alerts_week: weekStats.alerts_week || 0
                        }
                    });
                });
            });
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// API: Get All Alert Rules
app.get('/api/alerts/rules', requireAuth, (req, res) => {
    try {
        db.all(`
            SELECT * FROM alert_rules 
            ORDER BY 
                CASE priority 
                    WHEN 'critical' THEN 1 
                    WHEN 'high' THEN 2 
                    WHEN 'medium' THEN 3 
                    WHEN 'low' THEN 4 
                END,
                name
        `, (err, rules) => {
            if (err) {
                return res.json({ success: false, message: err.message });
            }
            res.json({ success: true, rules: rules || [] });
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// API: Get Single Alert Rule
app.get('/api/alerts/rules/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        db.get('SELECT * FROM alert_rules WHERE id = ?', [id], (err, rule) => {
            if (err) {
                return res.json({ success: false, message: err.message });
            }
            if (!rule) {
                return res.json({ success: false, message: 'Rule not found' });
            }
            res.json({ success: true, rule });
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// API: Create Alert Rule
app.post('/api/alerts/rules', requireAuth, (req, res) => {
    try {
        const {
            name, type, priority, description, conditions,
            enabled, notify_whatsapp, notify_telegram, notify_email, notify_push, notify_customers,
            cooldown_minutes, max_alerts_per_day, active_hours, active_days
        } = req.body;

        // Validate required fields
        if (!name || !type || !priority) {
            return res.json({ success: false, message: 'Name, type, and priority are required' });
        }

        const sql = `
            INSERT INTO alert_rules (
                name, type, priority, description, conditions,
                enabled, notify_whatsapp, notify_telegram, notify_email, notify_push, notify_customers,
                cooldown_minutes, max_alerts_per_day, active_hours, active_days,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `;

        db.run(sql, [
            name, type, priority, description || null, conditions || '{}',
            enabled ? 1 : 0,
            notify_whatsapp ? 1 : 0,
            notify_telegram ? 1 : 0,
            notify_email ? 1 : 0,
            notify_push ? 1 : 0,
            notify_customers ? 1 : 0,
            cooldown_minutes || 60,
            max_alerts_per_day || 10,
            active_hours || '00:00-23:59',
            active_days || '0,1,2,3,4,5,6'
        ], function(err) {
            if (err) {
                return res.json({ success: false, message: err.message });
            }
            
            // Reload alert system rules
            if (alertSystem) {
                alertSystem.loadRules().catch(e => console.error('[Alert] Failed to reload rules:', e));
            }
            
            res.json({ success: true, message: 'Alert rule created', id: this.lastID });
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// API: Update Alert Rule
app.put('/api/alerts/rules/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        // Build dynamic UPDATE query
        const fields = [];
        const values = [];
        
        const allowedFields = [
            'name', 'type', 'priority', 'description', 'conditions',
            'enabled', 'notify_whatsapp', 'notify_telegram', 'notify_email', 'notify_push', 'notify_customers',
            'cooldown_minutes', 'max_alerts_per_day', 'active_hours', 'active_days'
        ];
        
        allowedFields.forEach(field => {
            if (updates.hasOwnProperty(field)) {
                fields.push(`${field} = ?`);
                values.push(updates[field]);
            }
        });
        
        if (fields.length === 0) {
            return res.json({ success: false, message: 'No fields to update' });
        }
        
        fields.push('updated_at = datetime(\'now\')');
        values.push(id);
        
        const sql = `UPDATE alert_rules SET ${fields.join(', ')} WHERE id = ?`;
        
        db.run(sql, values, function(err) {
            if (err) {
                return res.json({ success: false, message: err.message });
            }
            
            if (this.changes === 0) {
                return res.json({ success: false, message: 'Rule not found' });
            }
            
            // Reload alert system rules
            if (alertSystem) {
                alertSystem.loadRules().catch(e => console.error('[Alert] Failed to reload rules:', e));
            }
            
            res.json({ success: true, message: 'Alert rule updated' });
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// API: Delete Alert Rule
app.delete('/api/alerts/rules/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        
        db.run('DELETE FROM alert_rules WHERE id = ?', [id], function(err) {
            if (err) {
                return res.json({ success: false, message: err.message });
            }
            
            if (this.changes === 0) {
                return res.json({ success: false, message: 'Rule not found' });
            }
            
            // Reload alert system rules
            if (alertSystem) {
                alertSystem.loadRules().catch(e => console.error('[Alert] Failed to reload rules:', e));
            }
            
            res.json({ success: true, message: 'Alert rule deleted' });
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// API: Get Alert History
app.get('/api/alerts/history', requireAuth, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const ruleId = req.query.rule_id;
        const priority = req.query.priority;
        const startDate = req.query.start_date;
        const endDate = req.query.end_date;
        
        let sql = `
            SELECT 
                h.*,
                r.name as rule_name,
                r.type as rule_type
            FROM alert_history h
            LEFT JOIN alert_rules r ON h.rule_id = r.id
            WHERE 1=1
        `;
        const params = [];
        
        if (ruleId) {
            sql += ' AND h.rule_id = ?';
            params.push(ruleId);
        }
        
        if (priority) {
            sql += ' AND h.priority = ?';
            params.push(priority);
        }
        
        if (startDate) {
            sql += ' AND DATE(h.triggered_at) >= DATE(?)';
            params.push(startDate);
        }
        
        if (endDate) {
            sql += ' AND DATE(h.triggered_at) <= DATE(?)';
            params.push(endDate);
        }
        
        sql += ' ORDER BY h.triggered_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);
        
        db.all(sql, params, (err, history) => {
            if (err) {
                return res.json({ success: false, message: err.message });
            }
            
            // Get total count
            let countSql = 'SELECT COUNT(*) as total FROM alert_history WHERE 1=1';
            const countParams = [];
            
            if (ruleId) {
                countSql += ' AND rule_id = ?';
                countParams.push(ruleId);
            }
            
            if (priority) {
                countSql += ' AND priority = ?';
                countParams.push(priority);
            }
            
            if (startDate) {
                countSql += ' AND DATE(triggered_at) >= DATE(?)';
                countParams.push(startDate);
            }
            
            if (endDate) {
                countSql += ' AND DATE(triggered_at) <= DATE(?)';
                countParams.push(endDate);
            }
            
            db.get(countSql, countParams, (err2, countResult) => {
                if (err2) {
                    return res.json({ success: false, message: err2.message });
                }
                
                res.json({
                    success: true,
                    history: history || [],
                    total: countResult.total || 0,
                    limit,
                    offset
                });
            });
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// API: Get Alert Settings
app.get('/api/alerts/settings', requireAuth, (req, res) => {
    try {
        db.get('SELECT * FROM alert_settings WHERE id = 1', (err, settings) => {
            if (err) {
                return res.json({ success: false, message: err.message });
            }
            res.json({ success: true, settings: settings || {} });
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// API: Update Alert Settings
app.put('/api/alerts/settings', requireAuth, (req, res) => {
    try {
        const { check_interval_minutes, cleanup_days, max_history_records } = req.body;
        
        const sql = `
            UPDATE alert_settings 
            SET check_interval_minutes = ?,
                cleanup_days = ?,
                max_history_records = ?,
                updated_at = datetime('now')
            WHERE id = 1
        `;
        
        db.run(sql, [
            check_interval_minutes || 5,
            cleanup_days || 30,
            max_history_records || 10000
        ], function(err) {
            if (err) {
                return res.json({ success: false, message: err.message });
            }
            
            // Reload alert system settings
            if (alertSystem) {
                alertSystem.loadSettings().catch(e => console.error('[Alert] Failed to reload settings:', e));
            }
            
            res.json({ success: true, message: 'Alert settings updated' });
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// API: Test Alert Rule
app.post('/api/alerts/test/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!alertSystem) {
            return res.json({ success: false, message: 'Alert system not initialized' });
        }
        
        // Get rule
        db.get('SELECT * FROM alert_rules WHERE id = ?', [id], async (err, rule) => {
            if (err) {
                return res.json({ success: false, message: err.message });
            }
            
            if (!rule) {
                return res.json({ success: false, message: 'Rule not found' });
            }
            
            // Trigger test alert
            try {
                await alertSystem.triggerAlert(rule, 'Test alert dari admin panel', { test: true });
                res.json({ success: true, message: 'Test alert sent successfully' });
            } catch (error) {
                res.json({ success: false, message: 'Failed to send test alert: ' + error.message });
            }
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// API: Acknowledge Alert
app.put('/api/alerts/history/:id/acknowledge', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        const acknowledgedBy = req.session.user?.username || 'admin';
        
        db.run(
            `UPDATE alert_history SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = ? WHERE id = ?`,
            [acknowledgedBy, new Date().toISOString(), id],
            function(err) {
                if (err) {
                    return res.json({ success: false, message: err.message });
                }
                
                if (this.changes === 0) {
                    return res.json({ success: false, message: 'Alert not found' });
                }
                
                res.json({ success: true, message: 'Alert acknowledged' });
            }
        );
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// API: Get Alert Statistics by Type
app.get('/api/alerts/stats/by-type', requireAuth, (req, res) => {
    try {
        db.all(
            `SELECT 
                alert_type,
                priority,
                COUNT(*) as total_count,
                SUM(CASE WHEN DATE(triggered_at) = DATE('now') THEN 1 ELSE 0 END) as today_count,
                SUM(CASE WHEN acknowledged = 1 THEN 1 ELSE 0 END) as acknowledged_count,
                MAX(triggered_at) as last_triggered
            FROM alert_history
            GROUP BY alert_type, priority
            ORDER BY total_count DESC`,
            [],
            (err, stats) => {
                if (err) {
                    return res.json({ success: false, message: err.message });
                }
                res.json({ success: true, stats: stats || [] });
            }
        );
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// User Management Routes
// User Management Routes
app.post('/admin/users/add', requireAuth, (req, res) => {
    const { username, password, level, full_name, phone, email, address, active_until } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    db.run("INSERT INTO users (username, password, level, full_name, phone, email, address, active_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [username, hash, level, full_name, phone || null, email || null, address || null, active_until || null], (err) => {
            if (err) return res.status(500).send(err.message);
            res.redirect(app.locals.base_path + '/admin/customers');
        });
});

app.post('/admin/users/edit', requireAuth, (req, res) => {
    const { id, username, password, level, full_name, phone, email, address, active_until } = req.body;
    
    if (password) {
        const hash = bcrypt.hashSync(password, 10);
        db.run("UPDATE users SET username=?, password=?, level=?, full_name=?, phone=?, email=?, address=?, active_until=? WHERE id=?",
            [username, hash, level, full_name, phone, email, address, active_until || null, id], (err) => {
                if (err) return res.status(500).send(err.message);
                res.redirect(app.locals.base_path + '/admin/customers');
            });
    } else {
        db.run("UPDATE users SET username=?, level=?, full_name=?, phone=?, email=?, address=?, active_until=? WHERE id=?",
            [username, level, full_name, phone, email, address, active_until || null, id], (err) => {
                if (err) return res.status(500).send(err.message);
                res.redirect(app.locals.base_path + '/admin/customers');
            });
    }
});

app.post('/admin/users/delete', requireAuth, (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM users WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).send(err.message);
        res.json({ success: true });
    });
});

// Billing & Finance Routes
app.get('/admin/billing', requireAuth, (req, res) => {
    db.all("SELECT * FROM billing_packages ORDER BY price ASC", [], (err, packages) => {
        db.all("SELECT * FROM bank_accounts ORDER BY id ASC", [], (err, accounts) => {
            res.render('admin_billing', {
                page: 'billing',
                user: req.session.user,
                packages: packages || [],
                bank_accounts: accounts || [],
                base_path: app.locals.base_path || '',
                site: config.site || {}
            });
        });
    });
});

app.post('/admin/billing/packages/add', requireAuth, (req, res) => {
    const { name, level, price, duration_days, description } = req.body;
    db.run("INSERT INTO billing_packages (name, level, price, duration_days, description) VALUES (?, ?, ?, ?, ?)",
        [name, level, price, duration_days, description], (err) => {
            res.redirect(app.locals.base_path + '/admin/billing');
        });
});

app.post('/admin/billing/packages/edit', requireAuth, (req, res) => {
    const { id, name, level, price, duration_days, description } = req.body;
    db.run("UPDATE billing_packages SET name=?, level=?, price=?, duration_days=?, description=? WHERE id=?",
        [name, level, price, duration_days, description, id], (err) => {
            res.redirect(app.locals.base_path + '/admin/billing');
        });
});

app.post('/admin/billing/packages/delete', requireAuth, (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM billing_packages WHERE id = ?", [id], (err) => {
        res.json({ success: true });
    });
});

// Bank Accounts CRUD
app.post('/admin/billing/bank/add', requireAuth, (req, res) => {
    const { bank_name, account_number, account_name } = req.body;
    db.run("INSERT INTO bank_accounts (bank_name, account_number, account_name) VALUES (?, ?, ?)",
        [bank_name, account_number, account_name], (err) => {
            res.redirect(app.locals.base_path + '/admin/billing');
        });
});

app.post('/admin/billing/bank/edit', requireAuth, (req, res) => {
    const { id, bank_name, account_number, account_name } = req.body;
    db.run("UPDATE bank_accounts SET bank_name=?, account_number=?, account_name=? WHERE id=?",
        [bank_name, account_number, account_name, id], (err) => {
            res.redirect(app.locals.base_path + '/admin/billing');
        });
});

app.post('/admin/billing/bank/delete', requireAuth, (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM bank_accounts WHERE id = ?", [id], (err) => {
        res.json({ success: true });
    });
});

app.get('/admin/finance', requireAuth, (req, res) => {
    const query = `
        SELECT t.*, u.username, u.full_name, b.name as package_name, b.level as package_level
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        JOIN billing_packages b ON t.package_id = b.id
        ORDER BY t.created_at DESC
    `;
    db.all(query, [], (err, transactions) => {
        // Calculate Stats
        const stats = {
            totalRevenue: 0,
            successCount: 0,
            pendingCount: 0,
            monthlyRevenue: 0
        };

        const now = new Date();
        const thisMonth = now.getMonth();
        const thisYear = now.getFullYear();

        (transactions || []).forEach(t => {
            if (t.payment_status === 'success') {
                stats.totalRevenue += t.amount;
                stats.successCount++;
                
                const tDate = new Date(t.created_at);
                if (tDate.getMonth() === thisMonth && tDate.getFullYear() === thisYear) {
                    stats.monthlyRevenue += t.amount;
                }
            } else if (t.payment_status === 'pending') {
                stats.pendingCount++;
            }
        });

        res.render('admin_finance', {
            page: 'finance',
            transactions: transactions || [],
            stats,
            user: req.session.user,
            base_path: app.locals.base_path || '',
            site: config.site || {}
        });
    });
});

app.post('/admin/finance/approve', requireAuth, (req, res) => {
    const { id } = req.body;
    // 1. Get Transaction Info
    db.get("SELECT t.*, b.duration_days, b.level as package_level FROM transactions t JOIN billing_packages b ON t.package_id = b.id WHERE t.id = ?", [id], (err, trans) => {
        if (err || !trans) return res.status(500).json({ success: false });

        // 2. Update User Membership
        db.get("SELECT active_until FROM users WHERE id = ?", [trans.user_id], (err, user) => {
            let startFrom = new Date();
            if (user && user.active_until) {
                const currentExpiry = new Date(user.active_until);
                if (currentExpiry > startFrom) startFrom = currentExpiry;
            }
            
            const newExpiry = new Date(startFrom.getTime() + (trans.duration_days * 24 * 60 * 60 * 1000));
            const expiryStr = newExpiry.toISOString().split('T')[0];

            db.run("UPDATE users SET active_until = ?, level = ? WHERE id = ?", [expiryStr, trans.package_level, trans.user_id], (err) => {
                if (err) return res.status(500).json({ success: false });

                // 3. Update Transaction Status
                db.run("UPDATE transactions SET payment_status = 'success', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?", [req.session.user, id], (err) => {
                    res.json({ success: true });
                });
            });
        });
    });
});

app.post('/admin/finance/reject', requireAuth, (req, res) => {
    const { id, reason } = req.body;
    db.run("UPDATE transactions SET payment_status = 'rejected', rejection_reason = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?",
        [reason || 'Bukti pembayaran tidak valid', req.session.user, id], (err) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true });
        });
});

app.post('/admin/finance/delete', requireAuth, (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM transactions WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).send(err.message);
        res.json({ success: true });
    });
});

app.post('/admin/camera/add', requireAuth, (req, res) => {
    const { nama, lokasi, url_rtsp, lat, lng, is_public, level, owner_id, camera_type, embed_url } = req.body;
    
    // Validasi berdasarkan tipe kamera
    if (camera_type === 'embed') {
        if (!embed_url) {
            return res.status(400).send("Embed URL diperlukan untuk kamera embed");
        }
        
        const validation = validateEmbedUrl(embed_url);
        if (!validation.valid) {
            return res.status(400).send(validation.message);
        }
        
        const embed_type = detectEmbedType(embed_url);
        const isHls = embed_url && (embed_type === 'hls' || embed_url.toLowerCase().includes('.m3u8'));
        const enable_recording = isHls ? 1 : 0;
        
        db.run(
            `INSERT INTO cameras (nama, lokasi, lat, lng, is_public, level, owner_id, camera_type, embed_url, embed_type, enable_recording)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [nama, lokasi || '', lat || null, lng || null, is_public || 1, level || 'umum', owner_id || null, 'embed', embed_url, embed_type, enable_recording],
            function (err) {
                if (err) {
                    console.error('Error adding embed camera:', err.message);
                    return res.status(500).send("Database Error");
                }
                const newCamId = this.lastID;
                registerCamera({ id: newCamId, nama, lokasi, camera_type: 'embed', embed_url, embed_type }).catch(() => {});
                res.redirect(app.locals.base_path + '/admin');
            }
        );
    } else {
        // RTSP camera (existing logic)
        if (!url_rtsp) {
            return res.status(400).send("RTSP URL diperlukan untuk kamera RTSP");
        }
        
        // Validate RTSP URL
        if (!isValidRtspUrl(url_rtsp)) {
            return res.status(400).send("Format RTSP URL tidak valid. Contoh: rtsp://user:password@192.168.1.10:554/stream1");
        }
        
        db.run(
            `INSERT INTO cameras (nama, lokasi, url_rtsp, lat, lng, is_public, level, owner_id, camera_type, enable_recording)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [nama, lokasi, url_rtsp, lat, lng, is_public || 1, level || 'umum', owner_id || null, 'rtsp', 1],
            function (err) {
                if (err) {
                    console.error(err.message);
                    return res.status(500).send("Database Error");
                }
                const newCamId = this.lastID;
                registerCamera({ id: newCamId, nama, lokasi, url_rtsp }).catch(() => {});
                res.redirect(app.locals.base_path + '/admin');
            }
        );
    }
});

app.post('/admin/camera/edit', requireAuth, (req, res) => {
    const { id, nama, lokasi, url_rtsp, lat, lng, is_public, level, owner_id, camera_type, embed_url } = req.body;
    console.log(`[Admin] Editing camera ${id}: level=${level}, owner_id=${owner_id}, type=${camera_type}`);
    
    if (camera_type === 'embed') {
        if (!embed_url) {
            return res.status(400).send("Embed URL diperlukan untuk kamera embed");
        }
        
        const validation = validateEmbedUrl(embed_url);
        if (!validation.valid) {
            return res.status(400).send(validation.message);
        }
        
        const embed_type = detectEmbedType(embed_url);
        const isHls = embed_url && (embed_type === 'hls' || embed_url.toLowerCase().includes('.m3u8'));
        const enable_recording = isHls ? 1 : 0;
        
        db.run(
            `UPDATE cameras
             SET nama = ?, lokasi = ?, lat = ?, lng = ?, is_public = ?, level = ?, owner_id = ?,
                 camera_type = ?, embed_url = ?, embed_type = ?, enable_recording = ?, url_rtsp = NULL
             WHERE id = ?`,
            [nama, lokasi || '', lat || null, lng || null, is_public || 1, level || 'umum', owner_id || null,
             'embed', embed_url, embed_type, enable_recording, id],
            function (err) {
                if (err) {
                    console.error('[Admin] Update Error:', err.message);
                    return res.status(500).send("Database Error: " + err.message);
                }
                console.log(`[Admin] Embed camera ${id} updated successfully.`);
                registerCamera({ id, nama, lokasi, camera_type: 'embed', embed_url, embed_type }).catch(() => {});
                res.redirect(app.locals.base_path + '/admin');
            }
        );
    } else {
        // RTSP camera
        if (!url_rtsp) {
            return res.status(400).send("RTSP URL diperlukan untuk kamera RTSP");
        }
        
        db.run(
            `UPDATE cameras
             SET nama = ?, lokasi = ?, url_rtsp = ?, lat = ?, lng = ?, is_public = ?, level = ?, owner_id = ?,
                 camera_type = ?, enable_recording = ?, embed_url = NULL, embed_type = NULL
             WHERE id = ?`,
            [nama, lokasi, url_rtsp, lat, lng, is_public || 1, level || 'umum', owner_id || null, 'rtsp', 1, id],
            function (err) {
                if (err) {
                    console.error('[Admin] Update Error:', err.message);
                    return res.status(500).send("Database Error: " + err.message);
                }
                console.log(`[Admin] RTSP camera ${id} updated successfully.`);
                registerCamera({ id, nama, lokasi, url_rtsp }).catch(() => {});
                res.redirect(app.locals.base_path + '/admin');
            }
        );
    }
});



app.post('/admin/change-password', requireAuth, (req, res) => {
    const { current_password, new_password } = req.body;
    
    // Debug log to check if body is parsed correctly
    console.log(`[ChangePassword] Received body keys: ${Object.keys(req.body || {})}`);

    const fs = require('fs');
    const configPath = path.join(__dirname, 'config.json');

    const trimmedCurrent = String(current_password || '').trim();
    const livePass = String(config.authentication.password || '').trim();

    console.log(`[ChangePassword] Comparing: Received="${trimmedCurrent}" (len:${trimmedCurrent.length}), Stored="${livePass}" (len:${livePass.length})`);

    if (trimmedCurrent !== livePass) {
        console.warn(`[ChangePassword] Mismatch. Password provided does not match stored password.`);
        return res.status(400).json({ success: false, message: 'Password lama salah' });
    }

    if (!new_password || String(new_password).trim().length === 0) {
        return res.status(400).json({ success: false, message: 'Password baru tidak boleh kosong' });
    }

    try {
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        if (!currentConfig.authentication) currentConfig.authentication = {};
        currentConfig.authentication.password = new_password;
        
        // Remove hash to force plain text check on next login
        if (currentConfig.authentication.password_hash) {
            delete currentConfig.authentication.password_hash;
        }
        
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 4), 'utf8');
        
        // Update runtime config object for immediate effect
        config.authentication.password = new_password;
        if (config.authentication.password_hash) delete config.authentication.password_hash;
        
        console.log(`[ChangePassword] Success. Password updated in config.json and memory.`);
        res.json({ success: true, message: 'Password berhasil diperbarui' });
    } catch (err) {
        console.error('[ChangePassword] System Error:', err);
        res.status(500).json({ success: false, message: 'Gagal menyimpan konfigurasi: ' + err.message });
    }
});
// Admin Settings Update Routes
app.post('/admin/settings/web', requireAuth, (req, res) => {
    const { title, footer, running_text } = req.body;
    const fs = require('fs');
    const configPath = path.join(__dirname, 'config.json');
    
    try {
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!currentConfig.site) currentConfig.site = {};
        
        if (title !== undefined) currentConfig.site.title = title;
        if (footer !== undefined) currentConfig.site.footer = footer;
        if (running_text !== undefined) currentConfig.site.running_text = running_text;
        
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 4), 'utf8');
        
        config.site = currentConfig.site;
        app.locals.site = config.site;
        res.json({ success: true });
    } catch (err) {
        console.error('[Settings] Error saving web settings:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/admin/settings/recording', requireAuth, (req, res) => {
    const { start_time, end_time, delete_after } = req.body;
    const fs = require('fs');
    const configPath = path.join(__dirname, 'config.json');
    
    try {
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!currentConfig.recording) currentConfig.recording = {};
        
        if (start_time !== undefined) currentConfig.recording.start_time = start_time;
        if (end_time !== undefined) currentConfig.recording.end_time = end_time;
        if (delete_after !== undefined) currentConfig.recording.delete_after = delete_after;
        
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 4), 'utf8');
        
        config.recording = currentConfig.recording;
        app.locals.recording = config.recording;
        res.json({ success: true });
    } catch (err) {
        console.error('[Settings] Error saving recording settings:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/admin/settings/mediamtx', requireAuth, (req, res) => {
    const { public_hls_url } = req.body;
    const fs = require('fs');
    const configPath = path.join(__dirname, 'config.json');
    
    try {
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!currentConfig.mediamtx) currentConfig.mediamtx = {};
        
        if (public_hls_url !== undefined) currentConfig.mediamtx.public_hls_url = public_hls_url;
        
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 4), 'utf8');
        
        config.mediamtx = currentConfig.mediamtx;
        app.locals.mediamtx = config.mediamtx;
        res.json({ success: true });
    } catch (err) {
        console.error('[Settings] Error saving mediamtx settings:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/admin/settings/telegram', requireAuth, (req, res) => {
    const { bot_token, chat_id, enabled } = req.body;
    const fs = require('fs');
    const configPath = path.join(__dirname, 'config.json');
    
    try {
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!currentConfig.telegram) currentConfig.telegram = {};
        
        if (bot_token !== undefined) currentConfig.telegram.bot_token = bot_token;
        if (chat_id !== undefined) currentConfig.telegram.chat_id = chat_id;
        if (enabled !== undefined) currentConfig.telegram.enabled = (enabled === 'true' || enabled === true);
        
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 4), 'utf8');
        
        config.telegram = currentConfig.telegram;
        app.locals.telegram = config.telegram;
        res.json({ success: true });
    } catch (err) {
        console.error('[Settings] Error saving telegram settings:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/admin/settings/whatsapp', requireAuth, (req, res) => {
    const { admin_numbers } = req.body;
    const fs = require('fs');
    const configPath = path.join(__dirname, 'config.json');
    
    try {
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!currentConfig.whatsapp) currentConfig.whatsapp = {};
        
        if (admin_numbers !== undefined) currentConfig.whatsapp.admin_numbers = admin_numbers;
        
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 4), 'utf8');
        
        config.whatsapp = currentConfig.whatsapp;
        app.locals.whatsapp = config.whatsapp;
        res.json({ success: true });
    } catch (err) {
        console.error('[Settings] Error saving whatsapp settings:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/admin/settings/map', requireAuth, (req, res) => {
    const { default_lat, default_lng, default_zoom } = req.body;
    const fs = require('fs');
    const configPath = path.join(__dirname, 'config.json');
    
    try {
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!currentConfig.map) currentConfig.map = {};
        
        if (default_lat !== undefined) {
            const v = parseFloat(default_lat);
            if (Number.isFinite(v)) currentConfig.map.default_lat = v;
        }
        if (default_lng !== undefined) {
            const v = parseFloat(default_lng);
            if (Number.isFinite(v)) currentConfig.map.default_lng = v;
        }
        if (default_zoom !== undefined) {
            const z = parseInt(default_zoom, 10);
            if (Number.isFinite(z)) {
                currentConfig.map.default_zoom = Math.min(18, Math.max(1, z));
            }
        }
        
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 4), 'utf8');
        
        config.map = currentConfig.map;
        res.json({ success: true });
    } catch (err) {
        console.error('[Settings] Error saving map settings:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// API Routes
app.get('/api/cameras', (req, res) => {
    db.all("SELECT id, nama, lokasi, lat, lng, ptz_enabled, onvif_port FROM cameras", [], (err, rows) => {
        res.json({ data: rows });
    });
});

// API to get camera online/offline status
app.get('/api/cameras/status', (req, res) => {
    db.all("SELECT id, nama FROM cameras", [], (err, rows) => {
        if (err) {
            return res.json({ success: false, message: err.message });
        }
        
        const cameras = {};
        rows.forEach(cam => {
            const status = cameraStatus[cam.id] || { 
                online: false, 
                hasBeenChecked: false,
                lastUpdate: null 
            };
            cameras[cam.id] = {
                id: cam.id,
                nama: cam.nama,
                online: status.online,
                hasBeenChecked: status.hasBeenChecked,
                lastUpdate: status.lastUpdate
            };
        });
        
        res.json({ 
            success: true, 
            cameras,
            timestamp: new Date().toISOString()
        });
    });
});

// --- YouTube Livestreaming API ---
app.get('/api/youtube/check-ffmpeg', async (req, res) => {
    const status = await youtubeStream.checkFfmpeg();
    res.json(status);
});

app.get('/api/youtube/status', requireApiAuth, (req, res) => {
    res.json({ 
        success: true, 
        streams: youtubeStream.getStatus(),
        cameraConnectivity: cameraStatus
    });
});

app.post('/api/youtube/start/:cameraId', requireApiAuth, async (req, res) => {
    const { stream_key, quality } = req.body;
    try {
        const result = await youtubeStream.startStream(req.params.cameraId, stream_key, quality);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/youtube/stop/:cameraId', requireApiAuth, (req, res) => {
    const result = youtubeStream.stopStream(req.params.cameraId);
    res.json(result);
});

app.post('/api/youtube/stop-all', requireApiAuth, (req, res) => {
    youtubeStream.stopAllStreams();
    res.json({ success: true });
});

app.get('/api/youtube/logs/:cameraId', requireApiAuth, (req, res) => {
    const logs = youtubeStream.getLogs(req.params.cameraId);
    res.json({ success: true, logs });
});

app.post('/api/reports', (req, res) => {
    const ip = getClientIp(req);
    const now = Date.now();
    const last = incidentReportRate.get(ip) || 0;
    if (now - last < 30000) {
        return res.status(429).json({ error: 'Terlalu sering mengirim laporan. Coba lagi sebentar.' });
    }

    const cameraIdRaw = req.body?.camera_id;
    const cameraId = cameraIdRaw !== undefined && cameraIdRaw !== null ? parseInt(cameraIdRaw, 10) : null;
    const category = String(req.body?.category || '').trim();
    const description = String(req.body?.description || '').trim();
    const reporterName = String(req.body?.reporter_name || '').trim();
    const reporterContact = String(req.body?.reporter_contact || '').trim();

    const allowed = new Set(['banjir', 'macet', 'kecelakaan', 'kebakaran', 'kriminal', 'lainnya']);
    if (!allowed.has(category)) {
        return res.status(400).json({ error: 'Kategori tidak valid.' });
    }
    if (!description || description.length < 5 || description.length > 800) {
        return res.status(400).json({ error: 'Deskripsi minimal 5 karakter, maksimal 800.' });
    }
    if (reporterName.length > 80 || reporterContact.length > 120) {
        return res.status(400).json({ error: 'Nama/kontak terlalu panjang.' });
    }

    if (!cameraId || !Number.isFinite(cameraId) || cameraId < 1) {
        return res.status(400).json({ error: 'camera_id wajib.' });
    }

    db.get("SELECT id, nama, lokasi, is_public FROM cameras WHERE id = ?", [cameraId], (err, cam) => {
        if (err || !cam) return res.status(404).json({ error: 'Kamera tidak ditemukan.' });
        if (cam.is_public !== 1) return res.status(403).json({ error: 'Kamera ini tidak menerima laporan publik.' });

        db.run(
            `INSERT INTO incident_reports (camera_id, category, description, reporter_name, reporter_contact, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
            [cameraId, category, description, reporterName || null, reporterContact || null],
            function (insErr) {
                if (insErr) return res.status(500).json({ error: insErr.message });
                incidentReportRate.set(ip, now);

                const title = cam.nama || `Kamera #${cameraId}`;
                const lokasi = cam.lokasi || '-';
                const who = reporterName ? `\nPelapor: ${reporterName}` : '';
                const contact = reporterContact ? `\nKontak: ${reporterContact}` : '';
                sendTelegramMessage(`📝 <b>Laporan Kejadian Baru</b>\nKamera: ${title}\nLokasi: ${lokasi}\nKategori: ${category}${who}${contact}\n\n${description}`);

                res.json({ success: true, id: this.lastID });
            }
        );
    });
});

app.get('/api/reports/public', (req, res) => {
    const limit = Math.min(200, Math.max(20, parseInt(req.query.limit, 10) || 50));
    const allowed = new Set(['banjir', 'macet', 'kecelakaan', 'kebakaran', 'kriminal', 'lainnya']);

    const categoryRaw = String(req.query.category || '').trim();
    const categories = categoryRaw
        ? categoryRaw.split(',').map(s => s.trim()).filter(s => allowed.has(s))
        : [];

    const sinceHours = Math.max(0, parseInt(req.query.since_hours, 10) || 0);
    const safeSinceHours = Math.min(24 * 365, sinceHours);

    const where = [
        "r.status = 'verified'",
        "c.is_public = 1",
        "c.lat IS NOT NULL",
        "c.lng IS NOT NULL"
    ];
    const params = [];

    if (categories.length > 0) {
        where.push(`r.category IN (${categories.map(() => '?').join(',')})`);
        params.push(...categories);
    }
    if (safeSinceHours > 0) {
        where.push(`r.created_at >= datetime('now', ?)`);
        params.push(`-${safeSinceHours} hours`);
    }

    params.push(limit);

    db.all(
        `SELECT r.id, r.camera_id, r.category, r.description, r.created_at, r.reviewed_at,
                c.nama as camera_name, c.lokasi as camera_location, c.lat as lat, c.lng as lng
         FROM incident_reports r
         LEFT JOIN cameras c ON c.id = r.camera_id
         WHERE ${where.join(' AND ')}
         ORDER BY r.created_at DESC
         LIMIT ?`,
        params,
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, data: rows || [] });
        }
    );
});

app.get('/api/admin/reports', requireApiAuth, (req, res) => {
    const status = String(req.query.status || 'pending').trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));

    console.log(`[Admin] Fetching reports with status: ${status}`);

    db.all(
        `SELECT r.*, c.nama as camera_name, c.lokasi as camera_location, u.phone as user_phone, u.full_name as user_full_name
         FROM incident_reports r
         LEFT JOIN cameras c ON c.id = r.camera_id
         LEFT JOIN users u ON u.id = r.user_id
         WHERE LOWER(r.status) = ?
         ORDER BY r.created_at DESC
         LIMIT ?`,
        [status, limit],
        (err, rows) => {
            if (err) {
                console.error('[Admin] Fetch reports error:', err.message);
                return res.status(500).json({ error: err.message });
            }
            console.log(`[Admin] Found ${rows ? rows.length : 0} reports for status ${status}`);
            res.json({ success: true, reports: rows || [] });
        }
    );
});

app.patch('/api/admin/reports/:id', requireApiAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const status = String(req.body?.status || '').trim();
    const allowed = new Set(['verified', 'rejected']);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'ID tidak valid.' });
    if (!allowed.has(status)) return res.status(400).json({ error: 'Status tidak valid.' });

    const user = req.session?.user || 'admin';
    db.run(
        `UPDATE incident_reports
         SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?
         WHERE id = ?`,
        [status, user, id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes < 1) return res.status(404).json({ error: 'Laporan tidak ditemukan.' });
            res.json({ success: true });
        }
    );
});

app.delete('/api/admin/reports/:id', requireApiAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'ID tidak valid.' });

    db.run("DELETE FROM incident_reports WHERE id = ?", [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes < 1) return res.status(404).json({ error: 'Laporan tidak ditemukan.' });
        res.json({ success: true });
    });
});

app.post('/api/cameras', requireApiAuth, (req, res) => {
    const { nama, lokasi, url_rtsp, lat, lng, is_public } = req.body;

    // Validate required fields
    if (!nama || nama.trim().length === 0) {
        return res.status(400).json({ error: 'Camera name is required' });
    }

    // Validate RTSP URL
    if (!url_rtsp) {
        return res.status(400).json({ error: 'RTSP URL is required' });
    }
    
    if (!isValidRtspUrl(url_rtsp)) {
        return res.status(400).json({ error: 'Invalid RTSP URL format. Example: rtsp://user:password@192.168.1.10:554/stream1' });
    }

    const isPublicVal = (is_public === true || is_public === 'true' || is_public === 1 || is_public === '1') ? 1 : 0;
    db.run(`INSERT INTO cameras (nama, lokasi, url_rtsp, lat, lng, is_public) VALUES (?, ?, ?, ?, ?, ?)`,
        [nama.trim(), lokasi?.trim() || '', url_rtsp.trim(), lat || null, lng || null, isPublicVal],
        async function (err) {
            if (err) {
                res.status(400).json({ error: err.message });
                return;
            }
            const newCam = { id: this.lastID, nama, lokasi, url_rtsp, lat, lng, is_public: isPublicVal };
            await registerCamera(newCam);
            sendTelegramMessage(`📷 <b>Kamera baru ditambahkan</b>\nNama: ${nama}\nLokasi: ${lokasi || '-'}`);
            res.json({ message: "success", data: newCam });
        });
});

app.delete('/api/cameras/:id', requireApiAuth, (req, res) => {
    const id = req.params.id;
    db.get(`SELECT nama, lokasi FROM cameras WHERE id = ?`, [id], (selectErr, cam) => {
        db.run(`DELETE FROM cameras WHERE id = ?`, id, async function (err) {
            if (err) {
                res.status(400).json({ error: err.message });
                return;
            }
            await mediaMtxRequest('DELETE', '/delete/' + `cam_${id}_input`);
            await mediaMtxRequest('DELETE', '/delete/' + `cam_${id}`);
            if (cam) {
                sendTelegramMessage(`🗑️ <b>Kamera dihapus</b>\nNama: ${cam.nama}\nLokasi: ${cam.lokasi || '-'}`);
            }
            res.json({ message: "deleted" });
        });
    });
});
// POST route for delete camera (for admin panel compatibility)
app.post('/admin/camera/delete', requireAuth, (req, res) => {
    const { id } = req.body;
    if (!id) {
        return res.status(400).json({ error: 'ID required' });
    }
    db.get(`SELECT nama, lokasi FROM cameras WHERE id = ?`, [id], (selectErr, cam) => {
        db.run(`DELETE FROM cameras WHERE id = ?`, [id], async function (err) {
            if (err) {
                res.status(400).json({ error: err.message });
                return;
            }
            await mediaMtxRequest('DELETE', '/delete/' + `cam_${id}_input`);
            await mediaMtxRequest('DELETE', '/delete/' + `cam_${id}`);
            if (cam) {
                sendTelegramMessage(`🗑️ <b>Kamera dihapus</b>\nNama: ${cam.nama}\nLokasi: ${cam.lokasi || '-'}`);
            }
            res.json({ message: "deleted" });
        });
    });
});


// Update camera
app.put('/api/cameras/:id', requireApiAuth, (req, res) => {
    const { nama, lokasi, url_rtsp, lat, lng, is_public } = req.body;
    const id = req.params.id;

    // Validate RTSP URL
    if (!url_rtsp || !url_rtsp.match(/^rtsp:\/\/[^\s]+$/)) {
        return res.status(400).json({ error: 'Invalid RTSP URL format. Must start with rtsp://' });
    }
    if (!nama || nama.trim().length === 0) {
        return res.status(400).json({ error: 'Camera name is required' });
    }

    const isPublicVal = (is_public === true || is_public === 'true' || is_public === 1 || is_public === '1') ? 1 : 0;
    db.get(`SELECT url_rtsp FROM cameras WHERE id = ?`, [id], (selectErr, existing) => {
        db.run(`UPDATE cameras SET nama = ?, lokasi = ?, url_rtsp = ?, lat = ?, lng = ?, is_public = ? WHERE id = ?`,
            [nama.trim(), lokasi?.trim() || '', url_rtsp.trim(), lat || null, lng || null, isPublicVal, id],
            async function (err) {
                if (err) {
                    res.status(400).json({ error: err.message });
                    return;
                }
                await registerCamera({ id, nama, lokasi, url_rtsp });

                if (existing && existing.url_rtsp !== url_rtsp.trim()) {
                    sendTelegramMessage(`🔁 <b>RTSP URL kamera diubah</b>\nNama: ${nama}\nLokasi: ${lokasi || '-'}\nURL lama: ${existing.url_rtsp}\nURL baru: ${url_rtsp.trim()}`);
                } else {
                    sendTelegramMessage(`🛠️ <b>Kamera diperbarui</b>\nNama: ${nama}\nLokasi: ${lokasi || '-'}`);
                }

                res.json({
                    message: "success",
                    data: { id, nama, lokasi, url_rtsp, lat, lng, is_public: isPublicVal }
                });
            });
    });
});

// Quick toggle camera public visibility
app.patch('/api/cameras/:id/visibility', requireApiAuth, (req, res) => {
    const id = req.params.id;
    const { is_public } = req.body;
    const isPublicVal = (is_public === true || is_public === 'true' || is_public === 1 || is_public === '1') ? 1 : 0;
    db.run("UPDATE cameras SET is_public = ? WHERE id = ?", [isPublicVal, id], function (err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ message: 'visibility updated', is_public: isPublicVal });
    });
});
// Update Settings
app.post('/api/settings', requireApiAuth, (req, res) => {
    const { title, footer, running_text } = req.body;
    if (!config.site) config.site = {};
    config.site.title = title;
    config.site.footer = footer;
    config.site.running_text = running_text;

    const fs = require('fs');
    const configPath = path.join(__dirname, 'config.json');
    fs.writeFile(configPath, JSON.stringify(config, null, 4), (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to save config' });
        }
        delete require.cache[require.resolve('./config.json')];
        app.locals.site = config.site; // Update in-memory
        res.json({ message: "Settings updated" });
    });
});

// Update Recording Settings - Real-time tanpa restart
app.post('/api/settings/recording', requireApiAuth, async (req, res) => {
    const { enabled, start_time, end_time, segment_duration, delete_after,
        video_codec, resolution, frame_rate, bitrate, max_bitrate,
        audio_enabled, audio_bitrate, max_storage_percent } = req.body;

    try {
        // Update in-memory config
        const oldRecording = JSON.parse(JSON.stringify(config.recording || {}));
        config.recording = {
            enabled: enabled === 'true' || enabled === true,
            start_time: start_time || config.recording.start_time,
            end_time: end_time || config.recording.end_time,
            segment_duration: segment_duration || config.recording.segment_duration,
            delete_after: delete_after || config.recording.delete_after,
            video_codec: video_codec || config.recording.video_codec || 'h264',
            resolution: resolution || config.recording.resolution || '720p',
            frame_rate: frame_rate || config.recording.frame_rate || 12,
            bitrate: bitrate || config.recording.bitrate || '800k',
            max_bitrate: max_bitrate || config.recording.max_bitrate || '900k',
            audio_enabled: audio_enabled !== undefined ? audio_enabled : (config.recording.audio_enabled !== undefined ? config.recording.audio_enabled : true),
            audio_bitrate: audio_bitrate || config.recording.audio_bitrate || '64k',
            max_storage_percent: parseInt(max_storage_percent) || 90,
            storage_path: config.recording.storage_path || './recordings'
        };

        // Save to config.json untuk persistence
        const fs = require('fs');
        fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 4));
        
        // Update app.locals untuk views
        app.locals.recording = config.recording;

        // Apply recording settings ke MediaMTX immediately tanpa restart
        console.log('[Recording Config] Applying new settings to MediaMTX...');
        await updateMediaMtxRecording();

        // Log the change
        activityLogger.logActivity({
            action: 'UPDATE_RECORDING_SETTINGS',
            category: 'recording',
            description: 'Pengaturan rekaman diubah',
            actor: {
                type: 'admin',
                name: req.session.user || 'admin'
            },
            details: {
                changes: {
                    enabled: { old: oldRecording.enabled, new: config.recording.enabled },
                    start_time: { old: oldRecording.start_time, new: config.recording.start_time },
                    end_time: { old: oldRecording.end_time, new: config.recording.end_time },
                    segment_duration: { old: oldRecording.segment_duration, new: config.recording.segment_duration },
                    delete_after: { old: oldRecording.delete_after, new: config.recording.delete_after },
                    resolution: { old: oldRecording.resolution, new: config.recording.resolution },
                    bitrate: { old: oldRecording.bitrate, new: config.recording.bitrate }
                }
            },
            req: req
        });

        console.log('[Recording Config] ✅ Settings applied successfully (no restart needed)');

        res.json({ 
            success: true,
            message: "✅ Pengaturan rekaman berhasil diterapkan secara real-time (tanpa perlu restart sistem)",
            recording: config.recording,
            info: {
                enabled: config.recording.enabled ? '🟢 ON' : '🔴 OFF',
                schedule: `${config.recording.start_time} - ${config.recording.end_time}`,
                resolution: config.recording.resolution,
                bitrate: config.recording.bitrate,
                retention: config.recording.delete_after
            }
        });

    } catch (err) {
        console.error('[Recording Config] Error:', err.message);
        res.status(500).json({ 
            error: 'Gagal menerapkan pengaturan: ' + err.message
        });
    }
});

app.get('/admin/whatsapp/status', requireAuth, (req, res) => {
    try {
        const status = whatsappBot.getStatus();
        res.json(status);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/admin/whatsapp/logout', requireAuth, async (req, res) => {
    try {
        await whatsappBot.logout();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// System Status API
app.get('/api/status', (req, res) => {
    // Get all cameras to ensure we return status for everyone
    db.all("SELECT id FROM cameras", [], async (err, rows) => {
        let currentStatus = {};

        // If DB fails, fallback to what we have in memory
        if (err || !rows) {
            currentStatus = { ...cameraStatus };
        } else {
            // Build status for all known cameras
            rows.forEach(cam => {
                currentStatus[cam.id] = cameraStatus[cam.id] || {
                    online: false,
                    lastUpdate: null,
                    hasBeenChecked: false
                };
            });
        }

        // Check transcode status for each camera
        let transcodeStatus = {};
        try {
            const pathsData = await mediaMtxRequest('GET', '/v3/paths/list');
            if (pathsData?.error) {
                throw new Error(pathsData.message || 'MediaMTX API error');
            }
            const items = pathsData.items || [];
            // Handle both array (v1.9+) and object (older) formats
            const activePathNames = Array.isArray(items) ? items.map(p => p.name) : Object.keys(items);

            // Check which cameras have transcoded output streams
            Object.keys(currentStatus).forEach(id => {
                const hasInput = activePathNames.includes(`cam_${id}_input`);
                const hasTranscoded = activePathNames.includes(`cam_${id}`);
                transcodeStatus[id] = {
                    input: hasInput,
                    transcoded: hasTranscoded,
                    mode: hasTranscoded ? 'transcoded' : (hasInput ? 'direct' : 'offline')
                };
            });
        } catch (e) {
            // Ignore errors from MediaMTX check, use empty transcode status
            console.error('Status API MediaMTX check error:', e?.message || String(e));
        }

        res.json({
            cameras: currentStatus,
            transcode: transcodeStatus,
            recording: config.recording || { enabled: false },
            disk: diskUsage,
            serverTime: new Date()
        });
    });
});


// Update Telegram Settings
app.post('/api/settings/telegram', requireApiAuth, (req, res) => {
    const { enabled, bot_token, chat_id } = req.body;

    config.telegram = {
        enabled: enabled === 'true' || enabled === true,
        bot_token: bot_token || "",
        chat_id: chat_id || ""
    };

    const fs = require('fs');
    fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 4), (err) => {
        if (err) return res.status(500).json({ error: 'Failed save' });
        app.locals.telegram = config.telegram;
        res.json({ message: "Telegram settings updated" });
        if (config.telegram.enabled) {
            sendTelegramMessage("<b>✅ CCTV System</b>\nNotifikasi Telegram telah diaktifkan.");
        }
    });
});

// Restart Telegram Bot (apply latest token/chat_id without server restart)
app.post('/api/telegram/restart', requireApiAuth, (req, res) => {
    try {
        telegramBot.restart(config, db, {
            getCameraStatus: () => cameraStatus,
            getDiskUsage: () => diskUsage,
            restartSystem: telegramRestartSystem,
            cleanupRecordings: telegramCleanupWrapper,
            getRtspTemplates: () => RTSP_TEMPLATES,
            generateRtspUrl: generateRtspUrl,
            updateAdminCredentials: telegramUpdateAdminCredentials
        });
        res.json({ message: 'Telegram bot restarted' });
        if (config.telegram?.enabled) {
            sendTelegramMessage('<b>🔄 Bot Telegram</b>\nBot berhasil direstart dengan pengaturan terbaru.');
        }
    } catch (e) {
        console.error('Telegram restart error:', e.message);
        res.status(500).json({ error: 'Failed to restart bot' });
    }
});

// Update MediaMTX Settings
app.post('/api/settings/mediamtx', requireApiAuth, (req, res) => {
    const { host, api_port, rtsp_port, hls_port, public_hls_url } = req.body;

    config.mediamtx = {
        host: host || "127.0.0.1",
        api_port: parseInt(api_port) || 9123,
        rtsp_port: parseInt(rtsp_port) || 8555,
        hls_port: parseInt(hls_port) || 8856,
        public_hls_url: public_hls_url || ""
    };

    const fs = require('fs');
    fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 4), (err) => {
        if (err) return res.status(500).json({ error: 'Failed save' });
        app.locals.mediamtx = config.mediamtx;
        app.locals.hls_port = config.mediamtx.hls_port;
        res.json({ message: "MediaMTX settings updated", data: config.mediamtx });
    });
});

// ONVIF Discovery API - find cameras on the local network
app.post('/api/onvif/discover', requireApiAuth, (req, res) => {
    const defaultTimeout = config.onvif?.discovery_timeout || 8000;
    const { timeout = defaultTimeout, username = '', password = '' } = req.body || {};
    const onvif = require('onvif');

    const results = [];
    const errors = [];

    onvif.Discovery.on('error', (err) => {
        errors.push(err.message || String(err));
    });

    onvif.Discovery.probe({ timeout: Math.min(Math.max(Number(timeout) || 8000, 3000), 30000) }, (err, cams) => {
        onvif.Discovery.removeAllListeners('error');
        if (err) {
            return res.status(500).json({ error: 'Discovery failed', message: err.message, devices: [] });
        }
        if (!cams || !cams.length) {
            return res.json({ devices: [], message: 'Tidak ada perangkat ONVIF ditemukan. Pastikan kamera satu jaringan dan mendukung ONVIF.' });
        }

        const tryFetchStreamUri = (cam, deviceInfo) => {
            return new Promise((resolve) => {
                if (!username || !password) return resolve(deviceInfo);
                cam.username = username;
                cam.password = password;
                cam.connect((connectErr) => {
                    if (connectErr) {
                        deviceInfo.streamUri = null;
                        deviceInfo.authError = connectErr.message || 'Connect failed';
                        return resolve(deviceInfo);
                    }
                    cam.getDeviceInformation((infoErr, info) => {
                        if (!infoErr && info) {
                            deviceInfo.manufacturer = info.manufacturer || '';
                            deviceInfo.model = info.model || '';
                            deviceInfo.name = [info.manufacturer, info.model].filter(Boolean).join(' ') || deviceInfo.name;
                        }
                        cam.getStreamUri({ protocol: 'RTSP' }, (uriErr, uriResult) => {
                            if (uriResult && uriResult.uri) {
                                const u = uriResult.uri;
                                deviceInfo.streamUri = u.replace(/^(\w+:\/\/)/, `$1${encodeURIComponent(username)}:${encodeURIComponent(password)}@`);
                            }
                            resolve(deviceInfo);
                        });
                    });
                });
            });
        };

        let pending = cams.length;
        cams.forEach((cam) => {
            const deviceInfo = {
                name: cam.hostname || 'Unknown',
                address: cam.hostname || '',
                port: cam.port || 80,
                manufacturer: '',
                model: '',
                streamUri: null
            };
            tryFetchStreamUri(cam, deviceInfo).then((info) => {
                results.push(info);
                if (--pending === 0) {
                    res.json({ devices: results, message: `Ditemukan ${results.length} perangkat.` });
                }
            });
        });
    });
});

// PTZ Control API - Pan, Tilt, Zoom control for ONVIF cameras
app.post('/api/cameras/:id/ptz', requireApiAuth, async (req, res) => {
    const cameraId = req.params.id;
    const { action, x, y, zoom } = req.body;

    // Validasi action
    const validActions = ['move', 'stop', 'zoom', 'preset', 'getPresets'];
    if (!validActions.includes(action)) {
        return res.status(400).json({ error: 'Invalid action. Valid: move, stop, zoom, preset, getPresets' });
    }

    // Ambil data kamera dari database
    db.get("SELECT * FROM cameras WHERE id = ?", [cameraId], async (err, camera) => {
        if (err || !camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }

        try {
            // Parse RTSP URL untuk mendapatkan IP, username, password
            const rtspUrl = camera.url_rtsp;
            const parsed = new URL(rtspUrl);
            const ip = parsed.hostname;
            const port = parsed.port || 80;
            const username = decodeURIComponent(parsed.username) || 'admin';
            const password = decodeURIComponent(parsed.password) || '';

            const onvif = require('onvif');

            // Buat koneksi ONVIF
            const cam = new onvif.Cam({
                hostname: ip,
                username: username,
                password: password,
                port: port,
                timeout: 5000
            });

            cam.connect((err) => {
                if (err) {
                    return res.status(500).json({ error: 'Failed to connect to camera', message: err.message });
                }

                // Cek apakah kamera support PTZ
                cam.getCapabilities((err, capabilities) => {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to get capabilities', message: err.message });
                    }

                    const hasPTZ = capabilities.PTZ && capabilities.PTZ.XAddr;
                    if (!hasPTZ) {
                        return res.status(400).json({ error: 'Camera does not support PTZ' });
                    }

                    switch (action) {
                        case 'move':
                            // Continuous move
                            cam.ptz.continuousMove({
                                x: parseFloat(x) || 0,     // -1.0 to 1.0 (left to right)
                                y: parseFloat(y) || 0,     // -1.0 to 1.0 (down to up)
                                zoom: parseFloat(zoom) || 0 // -1.0 to 1.0 (zoom out to in)
                            }, (err) => {
                                if (err) {
                                    return res.status(500).json({ error: 'Move failed', message: err.message });
                                }
                                res.json({ success: true, message: 'Moving camera' });
                            });
                            break;

                        case 'stop':
                            // Stop movement
                            cam.ptz.stop({
                                panTilt: true,
                                zoom: true
                            }, (err) => {
                                if (err) {
                                    return res.status(500).json({ error: 'Stop failed', message: err.message });
                                }
                                res.json({ success: true, message: 'Stopped' });
                            });
                            break;

                        case 'zoom':
                            // Zoom only
                            cam.ptz.continuousMove({
                                x: 0,
                                y: 0,
                                zoom: parseFloat(zoom) || 0
                            }, (err) => {
                                if (err) {
                                    return res.status(500).json({ error: 'Zoom failed', message: err.message });
                                }
                                res.json({ success: true, message: 'Zooming' });
                            });
                            break;

                        case 'getPresets':
                            // Get list of presets
                            cam.ptz.getPresets({}, (err, presets) => {
                                if (err) {
                                    return res.status(500).json({ error: 'Failed to get presets', message: err.message });
                                }
                                res.json({ success: true, presets: presets || [] });
                            });
                            break;

                        case 'preset':
                            // Go to preset
                            const presetToken = req.body.presetToken;
                            if (!presetToken) {
                                return res.status(400).json({ error: 'presetToken required' });
                            }
                            cam.ptz.gotoPreset({
                                preset: presetToken
                            }, (err) => {
                                if (err) {
                                    return res.status(500).json({ error: 'Goto preset failed', message: err.message });
                                }
                                res.json({ success: true, message: 'Moving to preset' });
                            });
                            break;

                        default:
                            res.status(400).json({ error: 'Unknown action' });
                    }
                });
            });
        } catch (error) {
            res.status(500).json({ error: 'PTZ error', message: error.message });
        }
    });
});

// RTSP URL Generator API
app.get('/api/rtsp-templates', (req, res) => {
    // Return template names and defaults (without sensitive info)
    const templates = {};
    Object.keys(RTSP_TEMPLATES).forEach(key => {
        templates[key] = {
            name: RTSP_TEMPLATES[key].name,
            defaults: RTSP_TEMPLATES[key].defaults,
            description: RTSP_TEMPLATES[key].description
        };
    });
    res.json({ templates });
});

app.post('/api/rtsp-generate', (req, res) => {
    const { brand, ip, username, password, port, channel, subtype, stream } = req.body;

    if (!brand || !ip || !username || !password) {
        return res.status(400).json({ error: 'Brand, IP, username, and password are required' });
    }

    const params = { ip, username, password };
    if (port) params.port = port;
    if (channel) params.channel = channel;
    if (subtype !== undefined) params.subtype = subtype;
    if (stream) params.stream = stream;

    const url = generateRtspUrl(brand, params);

    if (!url) {
        return res.status(400).json({ error: 'Invalid brand or parameters' });
    }

    res.json({
        url,
        brand: RTSP_TEMPLATES[brand]?.name || brand,
        description: RTSP_TEMPLATES[brand]?.description || ''
    });
});

// Recording Notification from MediaMTX (localhost only)
app.post('/api/recordings/notify', (req, res) => {
    // Security: only accept from localhost (record_notify.sh runs locally)
    const clientIp = req.ip || req.connection.remoteAddress || '';
    const allowedIps = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
    if (!allowedIps.includes(clientIp)) {
        console.warn(`[Security] Blocked recording notify from unauthorized IP: ${clientIp}`);
        return res.status(403).json({ error: 'Forbidden' });
    }

    const { path: mtxPath, file } = req.body;
    console.log(`New recording segment: ${file} for path ${mtxPath}`);

    // MTX_PATH is cam_ID_input (since we disabled transcoding)
    // Extract camera ID from cam_1_input or cam_1
    const match = mtxPath.match(/^cam_(\d+)(?:_input)?$/);
    if (!match) return res.json({ status: "ignored" });

    const cameraId = parseInt(match[1], 10);
    const filename = path.basename(file || '');
    const baseDir = path.resolve(__dirname);
    const absFile = path.resolve(path.isAbsolute(file) ? file : path.join(__dirname, file));
    if (!absFile.startsWith(baseDir + path.sep)) {
        console.warn(`[Security] Ignored recording notify with unsafe path: ${absFile}`);
        return res.status(400).json({ error: 'Invalid file path' });
    }
    const relativePath = path.relative(__dirname, absFile).replace(/\\/g, '/');

    // Get file size
    const fs = require('fs');
    let size = 0;
    let createdDate = null;
    try {
        const stats = fs.statSync(absFile);
        size = stats.size;
        createdDate = stats.mtime;
    } catch (e) {
        console.error("Could not get file stats for " + file);
    }

    const parsedFromName = filename ? parseRecordingTimestampFromFilename(filename) : null;
    const createdAt = formatDateJakarta(parsedFromName || createdDate || new Date());

    db.get("SELECT id FROM recordings WHERE file_path = ?", [relativePath], (selErr, row) => {
        if (!selErr && row) {
            return res.json({ status: "ok", duplicate: true });
        }
        db.run(
            `INSERT INTO recordings (camera_id, filename, file_path, size, created_at) VALUES (?, ?, ?, ?, ?)`,
            [cameraId, filename, relativePath, size, createdAt],
            (err) => {
                if (err) console.error("Database error saving recording:", err.message);
                res.json({ status: "ok" });
            }
        );
    });
});

app.put('/api/recordings/:id', requireApiAuth, (req, res) => {
    const id = req.params.id;
    const title = (req.body && req.body.title !== undefined) ? String(req.body.title).trim() : null;
    const notes = (req.body && req.body.notes !== undefined) ? String(req.body.notes).trim() : null;

    const safeTitle = (title !== null && title.length > 0) ? title.slice(0, 120) : null;
    const safeNotes = (notes !== null && notes.length > 0) ? notes.slice(0, 800) : null;

    db.run(
        "UPDATE recordings SET title = ?, notes = ? WHERE id = ?",
        [safeTitle, safeNotes, id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
            res.json({ message: 'updated', id, title: safeTitle, notes: safeNotes });
        }
    );
});

app.delete('/api/recordings/:id', requireApiAuth, (req, res) => {
    db.get("SELECT file_path FROM recordings WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Not found" });

        const fs = require('fs');
        const baseDir = path.resolve(__dirname);
        const fullPath = path.resolve(baseDir, row.file_path);
        if (!fullPath.startsWith(baseDir + path.sep)) {
            return res.status(400).json({ error: 'Invalid path' });
        }

        let fileDeleted = false;
        let fileError = null;
        try {
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
                fileDeleted = true;
            }
        } catch (e) {
            fileError = e?.message || String(e);
        }

        db.run("DELETE FROM recordings WHERE id = ?", [req.params.id], (delErr) => {
            if (delErr) return res.status(500).json({ error: delErr.message });
            res.json({ message: "deleted", fileDeleted, fileError });
        });
    });
});

// Push Notification API - Get VAPID public key
app.get('/api/push-key', (req, res) => {
    const publicKey = getVapidPublicKey();
    if (publicKey) {
        res.json({ publicKey });
    } else {
        res.status(500).json({ error: 'Push notifications not initialized' });
    }
});

// Push Notification Subscription API
app.post('/api/push-subscribe', (req, res) => {
    const subscription = req.body;

    // Simpan subscription ke database atau file
    const fs = require('fs');
    const subscriptionsPath = path.join(__dirname, 'subscriptions.json');

    let subscriptions = [];
    if (fs.existsSync(subscriptionsPath)) {
        subscriptions = JSON.parse(fs.readFileSync(subscriptionsPath, 'utf8'));
    }

    // Cek apakah sudah ada
    const exists = subscriptions.some(sub =>
        sub.endpoint === subscription.endpoint
    );

    if (!exists) {
        subscriptions.push({
            ...subscription,
            createdAt: new Date().toISOString()
        });
        fs.writeFileSync(subscriptionsPath, JSON.stringify(subscriptions, null, 2));
    }

    res.json({ success: true, message: 'Subscribed to push notifications' });
});

// Initialize Web Push with VAPID keys
function initializeWebPush() {
    const fs = require('fs');
    const vapidPath = path.join(__dirname, 'vapid-keys.json');

    let vapidKeys;

    // Generate or load VAPID keys
    if (fs.existsSync(vapidPath)) {
        vapidKeys = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
    } else {
        // Generate new VAPID keys automatically
        vapidKeys = webPush.generateVAPIDKeys();
        fs.writeFileSync(vapidPath, JSON.stringify(vapidKeys, null, 2));
        console.log('✅ Generated new VAPID keys for push notifications');
    }

    // Set VAPID details
    webPush.setVapidDetails(
        'mailto:cctv-monitor@localhost',
        vapidKeys.publicKey,
        vapidKeys.privateKey
    );

    return vapidKeys.publicKey;
}

// Get VAPID public key for client
function getVapidPublicKey() {
    const fs = require('fs');
    const vapidPath = path.join(__dirname, 'vapid-keys.json');
    if (fs.existsSync(vapidPath)) {
        const keys = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
        return keys.publicKey;
    }
    return null;
}

// Send push notification helper function
async function sendPushNotification(title, body, url = '/') {
    const fs = require('fs');
    const subscriptionsPath = path.join(__dirname, 'subscriptions.json');

    if (!fs.existsSync(subscriptionsPath)) return;

    const subscriptions = JSON.parse(fs.readFileSync(subscriptionsPath, 'utf8'));

    const payload = JSON.stringify({
        title: title || 'CCTV Monitor',
        body: body || 'New notification',
        url: url,
        icon: '/icon-192x192.png',
        badge: '/icon-72x72.png'
    });

    // Send to all subscriptions
    const sendPromises = subscriptions.map(async (subscription) => {
        try {
            await webPush.sendNotification(subscription, payload);
            console.log('✅ Push sent to:', subscription.endpoint.substring(0, 50) + '...');
        } catch (err) {
            console.error('❌ Push failed:', err.statusCode, err.message);
            // Remove invalid subscription
            if (err.statusCode === 410 || err.statusCode === 404) {
                const index = subscriptions.indexOf(subscription);
                if (index > -1) {
                    subscriptions.splice(index, 1);
                    fs.writeFileSync(subscriptionsPath, JSON.stringify(subscriptions, null, 2));
                    console.log('🗑️ Removed invalid subscription');
                }
            }
        }
    });

    await Promise.all(sendPromises);
}

// Cleanup orphan recordings whose files were deleted by MediaMTX retention
function cleanupOrphanRecordings() {
    const fs = require('fs');
    const baseDir = __dirname;

    db.all('SELECT id, file_path FROM recordings', [], (err, rows) => {
        if (err || !rows || rows.length === 0) return;

        let deleted = 0;

        rows.forEach((row) => {
            const fullPath = path.join(baseDir, row.file_path);
            if (!fs.existsSync(fullPath)) {
                db.run('DELETE FROM recordings WHERE id = ?', [row.id], (delErr) => {
                    if (!delErr) {
                        deleted += 1;
                    }
                });
            }
        });

        if (deleted > 0) {
            console.log(`[Cleanup] Removed ${deleted} orphan recordings without files`);
        }
    });
}

function parseDurationToMs(value) {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const m = raw.match(/^(\d+)\s*([smhdw])?$/i);
    if (!m) return null;
    const amount = parseInt(m[1], 10);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = (m[2] || 'd').toLowerCase();
    const multipliers = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000
    };
    return amount * (multipliers[unit] || multipliers.d);
}

function normalizeMediaMtxDuration(value, fallback) {
    const raw = value === null || value === undefined ? '' : String(value).trim();
    if (!raw) return fallback;
    const m = raw.match(/^(\d+)\s*([smhdw])?$/i);
    if (!m) return fallback;
    const amount = parseInt(m[1], 10);
    if (!Number.isFinite(amount) || amount <= 0) return fallback;
    const unit = (m[2] || 'd').toLowerCase();
    if (unit === 'd') return `${amount * 24}h`;
    if (unit === 'w') return `${amount * 7 * 24}h`;
    return `${amount}${unit}`;
}

async function cleanupRecordingsByDiskUsage(currentPercent) {
    const limit = config.recording?.max_storage_percent || 90;
    if (currentPercent <= limit) return;

    console.log(`[Storage Cleanup] Disk usage ${currentPercent}% exceeds limit ${limit}%. Deleting oldest recordings...`);

    const batchSize = 30; // Delete 30 files at a time
    const fs = require('fs');
    const baseDir = path.resolve(__dirname);

    return new Promise((resolve) => {
        db.all("SELECT id, file_path, size FROM recordings ORDER BY created_at ASC LIMIT ?", [batchSize], (err, rows) => {
            let deletedCount = 0;
            let freedBytes = 0;
            const idsToDelete = [];

            rows.forEach((row) => {
                const fullPath = path.resolve(baseDir, row.file_path);
                if (fullPath.startsWith(baseDir + path.sep)) {
                    try {
                        if (fs.existsSync(fullPath)) {
                            fs.unlinkSync(fullPath);
                            deletedCount++;
                            freedBytes += row.size || 0;
                        }
                        idsToDelete.push(row.id);
                    } catch (e) {
                        console.error(`[Storage Cleanup] Failed to delete ${row.file_path}:`, e.message);
                        idsToDelete.push(row.id);
                    }
                }
            });

            if (idsToDelete.length > 0) {
                const placeholders = idsToDelete.map(() => '?').join(',');
                db.run(`DELETE FROM recordings WHERE id IN (${placeholders})`, idsToDelete, (delErr) => {
                    if (deletedCount > 0) {
                        const freedMB = (freedBytes / 1024 / 1024).toFixed(2);
                        console.log(`[Storage Cleanup] Deleted ${deletedCount} oldest recordings, freed ~${freedMB} MB`);
                    }
                    resolve();
                });
            } else {
                resolve();
            }
        });
    });
}

function cleanupOldRecordingsByRetention() {
    const retentionMs = parseDurationToMs(config.recording?.delete_after);
    if (!retentionMs) return;

    const cutoff = new Date(Date.now() - retentionMs);
    const cutoffStr = formatDateJakarta(cutoff);
    const fs = require('fs');
    const baseDir = path.resolve(__dirname);

    db.all("SELECT id, file_path, size FROM recordings WHERE created_at < ?", [cutoffStr], (err, rows) => {
        if (err || !rows || rows.length === 0) return;

        let deletedCount = 0;
        let freedBytes = 0;
        rows.forEach((row) => {
            const fullPath = path.resolve(baseDir, row.file_path);
            if (!fullPath.startsWith(baseDir + path.sep)) return;
            try {
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                }
            } catch (e) { }
            deletedCount += 1;
            freedBytes += row.size || 0;
        });

        db.run("DELETE FROM recordings WHERE created_at < ?", [cutoffStr], () => {
            if (deletedCount > 0) {
                const freedMB = (freedBytes / 1024 / 1024).toFixed(2);
                console.log(`[Cleanup] Deleted ${deletedCount} old recording(s) (< ${cutoffStr}), freed ~${freedMB} MB`);
            }
        });
    });
}

// Global Error Handler
app.use((err, req, res, next) => {
    const errorDetail = {
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
    };
    
    console.error('Global Error:', errorDetail);
    
    // Log to a specific error file
    try {
        const fs = require('fs');
        fs.appendFileSync(path.join(__dirname, 'error.log'), JSON.stringify(errorDetail) + '\n');
    } catch (e) {
        console.error('Failed to write to error.log:', e.message);
    }

    res.status(500).json({ 
        error: 'Internal Server Error',
        message: err.message,
        path: req.path
    });
});

// --- System Update API ---
async function fetchJson(url) {
    const txt = await fetchText(url);
    return JSON.parse(txt);
}

function roundCoord(val, digits) {
    const n = Number(val);
    if (!Number.isFinite(n)) return null;
    const p = Math.pow(10, digits);
    return Math.round(n * p) / p;
}

async function getWeatherBundle(lat, lng) {
    const latR = roundCoord(lat, 4);
    const lngR = roundCoord(lng, 4);
    if (latR === null || lngR === null) throw new Error('Koordinat tidak valid');
    if (latR < -90 || latR > 90 || lngR < -180 || lngR > 180) throw new Error('Koordinat di luar batas');

    const key = `${latR},${lngR}`;
    const now = Date.now();
    const cached = weatherCache.get(key);
    if (cached && (now - cached.at) < 10 * 60 * 1000) {
        return cached.data;
    }

    const tz = 'Asia%2FJakarta';
    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latR}&longitude=${lngR}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=${tz}&windspeed_unit=kmh`;
    const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${latR}&longitude=${lngR}&hourly=wave_height,wave_direction,wave_period,wave_peak_period,sea_surface_temperature,ocean_current_velocity,ocean_current_direction,sea_level_height_msl&timezone=${tz}`;


    const forecast = await fetchJson(forecastUrl).catch(() => null);
    let marine = await fetchJson(marineUrl).catch(() => null);

    const isMarineEmpty = (
        !marine ||
        !marine.hourly ||
        !marine.hourly.wave_height ||
        marine.hourly.wave_height.length === 0 ||
        marine.hourly.wave_height.every(v => v === null)
    );

    // Fallback logic if marine API failed or returned all nulls (likely coordinates are on land)
    if (isMarineEmpty) {
        // Try shifting north first (for South hemisphere/Java Sea)
        const fallbackLatNorth = roundCoord(latR + 0.15, 4);
        const marineUrlFallbackNorth = `https://marine-api.open-meteo.com/v1/marine?latitude=${fallbackLatNorth}&longitude=${lngR}&hourly=wave_height,wave_direction,wave_period,wave_peak_period,sea_surface_temperature,ocean_current_velocity,ocean_current_direction,sea_level_height_msl&timezone=${tz}`;
        let marineFallback = await fetchJson(marineUrlFallbackNorth).catch(() => null);

        // Check if fallback north succeeded and has data
        let isFallbackNorthValid = (
            marineFallback &&
            marineFallback.hourly &&
            marineFallback.hourly.wave_height &&
            marineFallback.hourly.wave_height.length > 0 &&
            !marineFallback.hourly.wave_height.every(v => v === null)
        );

        if (isFallbackNorthValid) {
            marine = marineFallback;
        } else {
            // Try shifting south (for North hemisphere/Indian Ocean)
            const fallbackLatSouth = roundCoord(latR - 0.15, 4);
            const marineUrlFallbackSouth = `https://marine-api.open-meteo.com/v1/marine?latitude=${fallbackLatSouth}&longitude=${lngR}&hourly=wave_height,wave_direction,wave_period,wave_peak_period,sea_surface_temperature,ocean_current_velocity,ocean_current_direction,sea_level_height_msl&timezone=${tz}`;
            marineFallback = await fetchJson(marineUrlFallbackSouth).catch(() => null);
            
            let isFallbackSouthValid = (
                marineFallback &&
                marineFallback.hourly &&
                marineFallback.hourly.wave_height &&
                marineFallback.hourly.wave_height.length > 0 &&
                !marineFallback.hourly.wave_height.every(v => v === null)
            );
            if (isFallbackSouthValid) {
                marine = marineFallback;
            }
        }
        
        if (marine && !marine.hourly.wave_height.every(v => v === null)) {
            console.log(`[Weather] Marine API loaded from fallback coordinates for (${latR}, ${lngR})`);
        }
    }

    const data = {
        latitude: latR,
        longitude: lngR,
        current: forecast?.current || null,
        hourly: forecast?.hourly || null,
        daily: forecast?.daily || null,
        marine_hourly: marine?.hourly || null
    };

    weatherCache.set(key, { at: now, data });
    return data;
}

async function checkMarineWeather() {
    const adminNumbersRaw = String(config?.whatsapp?.admin_numbers || '').trim();
    if (!adminNumbersRaw) return;

    const adminNumbers = adminNumbersRaw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    if (adminNumbers.length === 0) return;

    const nowJakartaStr = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false });
    const datePart = nowJakartaStr.split(', ')[0].split('/').reverse().join('-');
    const hourPart = nowJakartaStr.split(', ')[1]?.split(':')?.[0] || '00';
    const todayKey = datePart;

    const lastRow = await new Promise((resolve) => {
        db.get("SELECT value FROM system_kv WHERE key = ?", ['lastDailyWeatherAlertDate'], (err, row) => {
            if (err) return resolve(null);
            resolve(row || null);
        });
    });
    const lastSent = lastRow?.value || null;
    if (lastSent === todayKey) return;

    const degToCompassId = (deg) => {
        const d = Number(deg);
        if (!Number.isFinite(d)) return null;
        const dirs = [
            'Utara',
            'Utara-Timur Laut',
            'Timur Laut',
            'Timur-Timur Laut',
            'Timur',
            'Timur-Tenggara',
            'Tenggara',
            'Selatan-Tenggara',
            'Selatan',
            'Selatan-Barat Daya',
            'Barat Daya',
            'Barat-Barat Daya',
            'Barat',
            'Barat-Barat Laut',
            'Barat Laut',
            'Utara-Barat Laut'
        ];
        const idx = Math.round(((d % 360) / 22.5)) % 16;
        return dirs[idx];
    };

    const pickMarineAtHour = (weather, key, hourIdx) => {
        const arr = weather?.marine_hourly?.[key];
        if (!Array.isArray(arr) || arr.length === 0) return null;
        const v = arr[hourIdx];
        if (v !== null && v !== undefined) return v;
        const v0 = arr[0];
        if (v0 !== null && v0 !== undefined) return v0;
        return null;
    };

    const refLat = (config.map && typeof config.map.default_lat === 'number') ? config.map.default_lat : -0.8173;
    const refLng = (config.map && typeof config.map.default_lng === 'number') ? config.map.default_lng : 103.4616;

    const cam = await new Promise((resolve) => {
        db.get(
            "SELECT id, lat, lng, nama, lokasi FROM cameras WHERE lat IS NOT NULL AND lng IS NOT NULL ORDER BY (ABS(CAST(lat AS REAL) - ?) + ABS(CAST(lng AS REAL) - ?)) ASC, id ASC LIMIT 1",
            [refLat, refLng],
            (err, row) => {
                if (err) return resolve(null);
                resolve(row || null);
            }
        );
    });

    const srcLat = (cam && cam.lat !== null && cam.lat !== undefined) ? cam.lat : refLat;
    const srcLng = (cam && cam.lng !== null && cam.lng !== undefined) ? cam.lng : refLng;
    const srcName = cam ? (cam.nama || cam.lokasi || `Kamera #${cam.id}`) : 'Titik Default Peta';

    try {
        const weather = await getWeatherBundle(srcLat, srcLng);
        if (!weather) return;

        const hourIdx = Math.max(0, Math.min(23, parseInt(hourPart, 10) || 0));
        const currentWind = weather.current?.wind_speed_10m;
        const currentWindDir = weather.current?.wind_direction_10m;

        const wave = pickMarineAtHour(weather, 'wave_height', hourIdx);
        const waveDir = pickMarineAtHour(weather, 'wave_direction', hourIdx);
        const wavePeriod = pickMarineAtHour(weather, 'wave_period', hourIdx);
        const curVel = pickMarineAtHour(weather, 'ocean_current_velocity', hourIdx);
        const curDir = pickMarineAtHour(weather, 'ocean_current_direction', hourIdx);

        const waveDangerous = (wave || 0) >= 1.5;
        const windDangerous = (currentWind || 0) >= 30;
        const currentDangerous = (curVel || 0) >= 1.5;

        if (!(waveDangerous || windDangerous || currentDangerous)) return;

        await new Promise((resolve) => {
            db.run(
                "INSERT OR REPLACE INTO system_kv(key, value) VALUES(?, ?)",
                ['lastDailyWeatherAlertDate', todayKey],
                () => resolve()
            );
        });

        const parts = [];
        if (waveDangerous) parts.push(`🌊 Ombak: ${Number(wave).toFixed(1)} m${(waveDir !== null && waveDir !== undefined) ? ` • ${Math.round(Number(waveDir))}° ${degToCompassId(waveDir) || ''}` : ''}${(wavePeriod !== null && wavePeriod !== undefined) ? ` • ${Number(wavePeriod).toFixed(1)}s` : ''}`.trim());
        if (windDangerous) parts.push(`💨 Angin: ${Math.round(Number(currentWind))} km/h${(currentWindDir !== null && currentWindDir !== undefined) ? ` • ${Math.round(Number(currentWindDir))}° ${degToCompassId(currentWindDir) || ''}` : ''}`.trim());
        if (currentDangerous) parts.push(`🌀 Arus: ${Number(curVel).toFixed(1)} km/h${(curDir !== null && curDir !== undefined) ? ` • ${Math.round(Number(curDir))}° ${degToCompassId(curDir) || ''}` : ''}`.trim());

        const msg =
            `⚠️ *PERINGATAN CUACA BURUK (HARI INI)* ⚠️\n\n` +
            `📍 Lokasi: ${srcName}\n` +
            `🗓️ Waktu: ${todayKey} ${hourPart}:00 WIB\n\n` +
            `${parts.join('\n')}\n\n` +
            `Saran: tunda aktivitas laut jika memungkinkan.\n` +
            `- ${config?.site?.title || 'CCTV TPNET CENTER'}`;

        for (const phone of adminNumbers) {
            whatsappBot.sendWA(phone, msg);
        }
    } catch (e) {
        console.error('Error checking marine weather:', e.message);
    }
}

function readLocalVersion() {
    try {
        const versionPath = path.join(__dirname, 'version.txt');
        const fs = require('fs');
        if (fs.existsSync(versionPath)) {
            return fs.readFileSync(versionPath, 'utf8').trim();
        }
    } catch { }
    return '1.0.0 (default)';
}

function fetchText(url) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (e) {
            reject(e);
            return;
        }

        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.request(
            {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'GET',
                timeout: 12000,
                headers: { 'User-Agent': 'cctv-monitoring-server' }
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(body);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode || 0} for ${url}`));
                    }
                });
            }
        );

        req.on('timeout', () => {
            req.destroy(new Error('Request timeout'));
        });
        req.on('error', reject);
        req.end();
    });
}

async function fetchRemoteVersionFromGithub(repo) {
    const branches = ['main', 'master'];
    let lastErr = null;
    for (const branch of branches) {
        const url = `https://raw.githubusercontent.com/${repo}/${branch}/version.txt?t=${Date.now()}`;
        try {
            const txt = await fetchText(url);
            const version = String(txt || '').trim();
            if (version) return { version, branch, url };
        } catch (e) {
            lastErr = e;
        }
    }
    if (lastErr) throw lastErr;
    throw new Error('Gagal mengambil versi remote');
}

function execCmd(file, args, options = {}) {
    return new Promise((resolve) => {
        const { execFile } = require('child_process');
        execFile(
            file,
            args,
            {
                cwd: options.cwd || __dirname,
                timeout: options.timeout || 20000,
                windowsHide: true,
                maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
                env: { ...process.env, ...(options.env || {}) }
            },
            (err, stdout, stderr) => {
                resolve({
                    ok: !err,
                    code: typeof err?.code === 'number' ? err.code : null,
                    error: err ? (err.message || String(err)) : null,
                    stdout: (stdout || '').toString(),
                    stderr: (stderr || '').toString()
                });
            }
        );
    });
}

function inferGitHelpMessage(stderr, repoPath) {
    const s = String(stderr || '');
    if (/dubious ownership/i.test(s) && /safe\.directory/i.test(s)) {
        return `Git menolak akses repo (safe.directory). Jalankan:\n` +
            `sudo git config --global --add safe.directory "${repoPath}"\n` +
            `lalu coba update lagi.`;
    }
    if (/index\.lock/i.test(s) || /Unable to create .*index\.lock/i.test(s)) {
        return `Ada file lock git yang nyangkut. Jalankan:\nrm -f "${repoPath}/.git/index.lock"\nLalu coba update lagi.`;
    }
    if (/You have not concluded your merge/i.test(s) || /MERGE_HEAD/i.test(s)) {
        return 'Repo sedang dalam status merge. Jalankan `git status` lalu selesaikan merge atau `git merge --abort`, kemudian coba update lagi.';
    }
    if (/needs merge|unmerged/i.test(s)) {
        return 'Ada konflik/merge yang belum selesai. Jalankan `git status` lalu selesaikan konflik atau reset repo, lalu coba update lagi.';
    }
    if (/could not resolve host|temporary failure in name resolution/i.test(s)) {
        return 'DNS/Internet bermasalah (tidak bisa resolve host Git). Cek koneksi jaringan/DNS lalu coba lagi.';
    }
    if (/could not read username|authentication failed|permission denied|repository not found/i.test(s)) {
        return 'Akses ke repository membutuhkan autentikasi atau URL remote salah. Cek `git remote -v` dan pastikan aksesnya valid.';
    }
    if (/not a git repository/i.test(s)) {
        return 'Folder aplikasi bukan repository git. Pastikan install dilakukan via `git clone`, bukan copy manual.';
    }
    return '';
}

// System Info API - Detailed server information for admin dashboard
app.get('/api/system/info', requireApiAuth, async (req, res) => {
    const os = require('os');
    const { exec } = require('child_process');
    const isWin = process.platform === 'win32';
    
    const result = {
        success: true,
        data: {
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            release: os.release(),
            cpu_model: '',
            cpu_cores: os.cpus().length,
            cpu_load: os.loadavg ? os.loadavg()[0] : 0,
            cpu_load_5: os.loadavg ? os.loadavg()[1] : 0,
            cpu_load_15: os.loadavg ? os.loadavg()[2] : 0,
            cpu_temp: '',
            memory_total: '',
            memory_used: '',
            memory_free: '',
            memory_percent: 0,
            disk_total: '',
            disk_used: '',
            disk_free: '',
            disk_percent: 0,
            disk_total_gb: '',
            disk_used_gb: '',
            disk_free_gb: '',
            disks: [],
            uptime_sec: os.uptime(),
            node_version: process.version,
            app_version: readLocalVersion(),
            ai_engine: null
        }
    };
    
    const d = result.data;
    const formatBytes = (bytes) => {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };
    
    // Memory
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    d.memory_total = formatBytes(totalMem);
    d.memory_used = formatBytes(usedMem);
    d.memory_free = formatBytes(freeMem);
    d.memory_percent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;
    
    // Copy diskUsage from global
    if (diskUsage) {
        d.disk_total = diskUsage.total || '';
        d.disk_used = diskUsage.used || '';
        d.disk_free = diskUsage.free || '';
        d.disk_percent = diskUsage.percent || 0;
        d.disk_total_gb = diskUsage.totalGb || '';
        d.disk_used_gb = diskUsage.usedGb || '';
        d.disk_free_gb = diskUsage.free || '';
        d.disks = diskUsage.disks || [];
    }
    
    // CPU model (Linux)
    if (!isWin) {
        try {
            const cpuModel = require('fs').readFileSync('/proc/cpuinfo', 'utf8');
            const lines = cpuModel.split('\n').filter(l => l.startsWith('model name') || l.startsWith('Hardware') || l.startsWith('Processor'));
            if (lines.length > 0) {
                d.cpu_model = lines[0].split(':')[1]?.trim() || '';
            }
        } catch (e) {}
        
        // CPU Temperature
        try {
            const zones = require('fs').readdirSync('/sys/class/thermal').filter(n => /^thermal_zone/.test(n));
            const temps = [];
            zones.forEach(z => {
                try {
                    const t = require('fs').readFileSync(`/sys/class/thermal/${z}/temp`, 'utf8').trim();
                    const val = parseInt(t);
                    if (!isNaN(val) && val > 0) temps.push(val / 1000);
                } catch (e) {}
            });
            if (temps.length > 0) {
                const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
                d.cpu_temp = avg.toFixed(1) + '°C';
            }
        } catch (e) {}
    }
    
    // AI Engine health
    try {
        const aiHealth = await new Promise((resolve) => {
            const http = require('http');
            const req = http.get('http://127.0.0.1:9090/api/ai/health', (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(3000, () => { req.destroy(); resolve(null); });
        });
        d.ai_engine = aiHealth;
    } catch (e) {}
    
    res.json(result);
});

// System Disk API for Admin Dashboard
app.get('/api/system/disk', requireApiAuth, (req, res) => {
    res.json({
        success: true,
        ...diskUsage
    });
});

app.get('/api/system/version', (req, res) => {
    res.json({ version: readLocalVersion() });
});

// Single camera health API
app.get('/api/health/:id', (req, res) => {
    const id = req.params.id;
    const status = cameraStatus[id] || { online: false, hasBeenChecked: false };
    res.json({
        id,
        online: status.online,
        ready: status.online, // Alias for frontend compatibility
        lastUpdate: status.lastUpdate,
        details: status
    });
});

app.post('/api/system/update', requireApiAuth, (req, res) => {
    console.log('[System Update] Update requested from admin panel.');
    const repoUrl = config.server.repository_url || 'alijayanet/cctv-monitoring';
    const localVersion = readLocalVersion();

    fetchRemoteVersionFromGithub(repoUrl).then((remoteInfo) => {
        const remoteVersion = remoteInfo?.version || '';

        if (remoteVersion && remoteVersion === localVersion) {
            return res.json({
                success: true,
                updated: false,
                message: 'Aplikasi sudah versi terbaru. Tidak ada update.',
                localVersion,
                remoteVersion
            });
        }

        (async () => {
            const repoPath = __dirname;
            const gitVersion = await execCmd('git', ['--version'], { env: { GIT_TERMINAL_PROMPT: '0' } });
            if (!gitVersion.ok) {
                return res.status(500).json({
                    success: false,
                    message: 'Git tidak terdeteksi di sistem. Install Git terlebih dahulu.',
                    error: gitVersion.error,
                    stderr: gitVersion.stderr
                });
            }

            const gitCheck = await execCmd('git', ['rev-parse', '--is-inside-work-tree'], { env: { GIT_TERMINAL_PROMPT: '0' } });
            if (!gitCheck.ok || !/true/i.test(gitCheck.stdout)) {
                const help = inferGitHelpMessage(gitCheck.stderr || gitCheck.error, repoPath);
                return res.status(500).json({
                    success: false,
                    message: 'Folder aplikasi bukan repository git. Tidak bisa update via git pull.',
                    error: gitCheck.error,
                    stdout: gitCheck.stdout,
                    stderr: gitCheck.stderr,
                    help
                });
            }

            const origin = await execCmd('git', ['remote', 'get-url', 'origin'], { env: { GIT_TERMINAL_PROMPT: '0' } });
            if (!origin.ok) {
                const remotes = await execCmd('git', ['remote', '-v'], { env: { GIT_TERMINAL_PROMPT: '0' } });
                return res.status(500).json({
                    success: false,
                    message: 'Remote origin tidak ditemukan. Pastikan repo punya remote GitHub (origin).',
                    error: origin.error,
                    stdout: (origin.stdout || '') + (remotes.stdout ? `\n\nRemote -v:\n${remotes.stdout}` : ''),
                    stderr: (origin.stderr || '') + (remotes.stderr ? `\n\nRemote -v (stderr):\n${remotes.stderr}` : '')
                });
            }

            const preserveFiles = ['config.json', 'cameras.db'];
            const status = await execCmd('git', ['status', '--porcelain'], { env: { GIT_TERMINAL_PROMPT: '0' } });
            let stashRef = '';
            let hadLocalChanges = false;
            let backupDir = '';

            if (status.ok && status.stdout.trim()) {
                hadLocalChanges = true;
                const before = await execCmd('git', ['stash', 'list', '-n', '1', '--pretty=%gd'], { env: { GIT_TERMINAL_PROMPT: '0' } });
                const beforeRef = (before.stdout || '').trim();
                const label = `cctv-auto-update ${new Date().toISOString()}`;
                const stash = await execCmd('git', ['stash', 'push', '-u', '-m', label], { env: { GIT_TERMINAL_PROMPT: '0' } });

                const after = await execCmd('git', ['stash', 'list', '-n', '1', '--pretty=%gd'], { env: { GIT_TERMINAL_PROMPT: '0' } });
                const afterRef = (after.stdout || '').trim();
                stashRef = afterRef && afterRef !== beforeRef ? afterRef : '';

                if (!stash.ok) {
                    try {
                        const fs = require('fs');
                        const os = require('os');
                        const ts = Date.now();
                        backupDir = path.join(os.tmpdir(), `cctv-update-backup-${ts}`);
                        fs.mkdirSync(backupDir, { recursive: true });
                        for (const f of preserveFiles) {
                            const src = path.join(repoPath, f);
                            const dst = path.join(backupDir, f);
                            if (fs.existsSync(src)) {
                                fs.copyFileSync(src, dst);
                            }
                        }
                    } catch { }

                    const reset = await execCmd('git', ['reset', '--hard'], { env: { GIT_TERMINAL_PROMPT: '0' } });
                    const clean = await execCmd('git', ['clean', '-fd', '-e', 'node_modules', '-e', 'recordings'], { env: { GIT_TERMINAL_PROMPT: '0' } });
                    if (!reset.ok || !clean.ok) {
                        const help = inferGitHelpMessage((stash.stderr || stash.error || '') + '\n' + (reset.stderr || '') + '\n' + (clean.stderr || ''), repoPath);
                        return res.status(500).json({
                            success: false,
                            message: 'Gagal menyiapkan update (git stash gagal, dan fallback reset/clean gagal).',
                            error: stash.error || reset.error || clean.error,
                            stdout: [stash.stdout, reset.stdout, clean.stdout].filter(Boolean).join('\n'),
                            stderr: [stash.stderr, reset.stderr, clean.stderr].filter(Boolean).join('\n'),
                            help,
                            backupDir: backupDir || null
                        });
                    }
                }
            }

            const pull = await execCmd('git', ['pull', '--ff-only'], { env: { GIT_TERMINAL_PROMPT: '0' } });
            if (!pull.ok) {
                console.error('[Update] Git pull failed:', pull.error);
                const help = inferGitHelpMessage(pull.stderr || pull.error, repoPath);
                sendTelegramMessage(`❌ <b>Update aplikasi gagal</b>\nLangkah: git pull\nError: ${pull.error || 'unknown'}\n${pull.stderr ? `\nDetail:\n${pull.stderr.trim()}` : ''}`);
                return res.status(500).json({
                    success: false,
                    message: 'Gagal melakukan git pull. Lihat detail error (stderr) untuk penyebabnya.',
                    error: pull.error,
                    stdout: pull.stdout,
                    stderr: pull.stderr,
                    help
                });
            }

            if (stashRef) {
                for (const f of preserveFiles) {
                    await execCmd('git', ['checkout', stashRef, '--', f], { env: { GIT_TERMINAL_PROMPT: '0' } });
                }
            }
            if (backupDir) {
                try {
                    const fs = require('fs');
                    for (const f of preserveFiles) {
                        const src = path.join(backupDir, f);
                        const dst = path.join(repoPath, f);
                        if (fs.existsSync(src)) {
                            fs.copyFileSync(src, dst);
                        }
                    }
                } catch { }
            }

            console.log('[Update] Git pull success:', pull.stdout);
            sendTelegramMessage('⬇️ <b>Update aplikasi dimulai</b>\nGit pull berhasil. Melanjutkan npm install dan restart (jika Linux).');

            res.json({
                success: true,
                updated: true,
                message: 'Git pull berhasil. Kode terbaru telah diunduh.',
                output: pull.stdout,
                localVersion,
                remoteVersion,
                origin: origin.stdout.trim(),
                stashed: hadLocalChanges,
                preserved: preserveFiles,
                stashRef: stashRef || null,
                backupDir: backupDir || null
            });

            setTimeout(async () => {
                console.log('[Update] Starting npm install and restart sequence...');

                const npm = await execCmd('npm', ['install', '--omit=dev'], { env: { GIT_TERMINAL_PROMPT: '0' } });
                if (!npm.ok) {
                    console.error('[Update] NPM install failed:', npm.error);
                    sendTelegramMessage(`❌ <b>Update aplikasi gagal</b>\nLangkah: npm install --omit=dev\nError: ${npm.error || 'unknown'}\n${npm.stderr ? `\nDetail:\n${npm.stderr.trim()}` : ''}`);
                    return;
                }

                sendTelegramMessage('✅ <b>Update aplikasi: npm install selesai</b>');

                if (process.platform === 'linux') {
                    console.log('[Update] Linux detected. Triggering systemctl restart...');
                    restartLinuxServices(['cctv-web'], (restarterr, stdout, stderr) => {
                        if (restarterr) {
                            console.error('[Update] Restart command failed:', restarterr);
                            const detail = (stderr || stdout || restarterr.message || '').toString().trim();
                            sendTelegramMessage(`⚠️ <b>Update aplikasi: restart gagal</b>\nPeriksa service cctv-web.\n${detail ? `Detail: ${detail}` : ''}`);
                            if (isRunningUnderSystemd()) {
                                setTimeout(() => process.exit(0), 1000);
                            }
                        } else {
                            sendTelegramMessage('🚀 <b>Update aplikasi selesai</b>\nService cctv-web sudah direstart.');
                        }
                    });
                }
            }, 3000);
        })();
    }).catch((err) => {
        execCmd('git', ['pull', '--ff-only'], { env: { GIT_TERMINAL_PROMPT: '0' } }).then((pull) => {
            if (!pull.ok) {
                const help = inferGitHelpMessage(pull.stderr || pull.error, __dirname);
                return res.status(500).json({
                    success: false,
                    message: 'Gagal cek versi remote dan git pull juga gagal.',
                    error: pull.error,
                    stdout: pull.stdout,
                    stderr: pull.stderr,
                    help
                });
            }

            res.json({
                success: true,
                updated: true,
                message: 'Versi remote tidak bisa dicek. Git pull dijalankan dan berhasil.',
                output: pull.stdout
            });

            setTimeout(async () => {
                await execCmd('npm', ['install', '--omit=dev'], { env: { GIT_TERMINAL_PROMPT: '0' } });
                if (process.platform === 'linux') {
                    restartLinuxServices(['cctv-web'], () => { });
                }
            }, 3000);
        });
    });
});

app.get('/api/weather', async (req, res) => {
    try {
        // Jika ada parameter lat/lng di query, gunakan itu
        const hasLat = req.query && req.query.lat !== undefined && req.query.lat !== null && String(req.query.lat).trim() !== '';
        const hasLng = req.query && req.query.lng !== undefined && req.query.lng !== null && String(req.query.lng).trim() !== '';
        if (hasLat && hasLng) {
            const lat = req.query.lat;
            const lng = req.query.lng;
            const data = await getWeatherBundle(lat, lng);
            return res.json({ success: true, ...data });
        }

        // Gunakan koordinat dari config.json (default map location)
        const refLat = (config.map && typeof config.map.default_lat === 'number') ? config.map.default_lat : -6.251973319579064;
        const refLng = (config.map && typeof config.map.default_lng === 'number') ? config.map.default_lng : 107.92050843016914;
        
        // Langsung gunakan koordinat config untuk cuaca, tidak mencari kamera terdekat
        const data = await getWeatherBundle(refLat, refLng);
        return res.json({ success: true, source: { nama: null, lokasi: 'Lokasi Default (Config)' }, ...data });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message || 'Gagal mengambil data cuaca' });
    }
});



// Scan existing recording files and import to database
function scanExistingRecordings() {
    const fs = require('fs');
    const recordingsDir = path.join(__dirname, 'recordings');

    if (!fs.existsSync(recordingsDir)) {
        console.log('Creating recordings directory...');
        fs.mkdirSync(recordingsDir, { recursive: true });
        return;
    }

    console.log('Scanning existing recordings...');

    // 1. Get all known files from DB to avoid N+1 queries
    db.all('SELECT file_path FROM recordings', [], (err, rows) => {
        if (err) {
            console.error('Database error during scan:', err.message);
            return;
        }

        const existingFiles = new Set(rows.map(r => r.file_path));
        let importedCount = 0;
        let totalFilesFound = 0;

        // 2. Scan filesystem
        try {
            const cameraFolders = fs.readdirSync(recordingsDir).filter(f => {
                const fullPath = path.join(recordingsDir, f);
                return fs.statSync(fullPath).isDirectory() && /^cam_\d+$/.test(f);
            });

            // Prepare statements for batch insertion
            const stmt = db.prepare('INSERT INTO recordings (camera_id, filename, file_path, size, created_at) VALUES (?, ?, ?, ?, ?)');

            db.serialize(() => {
                db.run('BEGIN TRANSACTION');

                cameraFolders.forEach(folder => {
                    const match = folder.match(/^cam_(\d+)$/);
                    if (!match) return;

                    const cameraId = match[1];
                    const folderPath = path.join(recordingsDir, folder);

                    try {
                        const files = fs.readdirSync(folderPath).filter(f => {
                            return f.endsWith('.mp4') || f.endsWith('.fmp4') || f.endsWith('.ts') || f.endsWith('.mkv');
                        });

                        files.forEach(filename => {
                            const filePath = path.join(folderPath, filename);
                            const relativePath = path.relative(__dirname, filePath).replace(/\\/g, '/');

                            totalFilesFound++;

                            if (!existingFiles.has(relativePath)) {
                                try {
                                    const stats = fs.statSync(filePath);
                                    const size = stats.size;
                                    const createdAt = formatDateJakarta(stats.mtime);

                                    stmt.run(cameraId, filename, relativePath, size, createdAt, (err) => {
                                        if (err) console.error(`Failed to import ${filename}:`, err.message);
                                        else importedCount++;
                                    });
                                } catch (e) {
                                    console.error(`Error processing file ${filename}:`, e.message);
                                }
                            }
                        });
                    } catch (e) {
                        console.error(`Error reading folder ${folder}:`, e.message);
                    }
                });

                db.run('COMMIT', (err) => {
                    if (err) console.error('Transaction commit failed:', err.message);
                    stmt.finalize();

                    if (importedCount > 0) {
                        console.log(`✅ Imported ${importedCount} new recording(s) to database (Total found: ${totalFilesFound})`);
                    } else {
                        console.log(`✅ Database is up to date (Scanned ${totalFilesFound} files)`);
                    }
                });
            });

        } catch (e) {
            console.error('Scan error:', e.message);
        }
    });
}

// --- System Update API ---

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
});

// Process error handlers
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(PORT, () => {

    console.log(`Server is running on http://localhost:${PORT}`);

    // Pre-initialize cameraStatus so Telegram /status has data immediately
    db.all("SELECT id FROM cameras", [], (err, rows) => {
        if (!err && rows) {
            rows.forEach((cam) => {
                if (!cameraStatus[cam.id]) {
                    cameraStatus[cam.id] = {
                        online: false,
                        lastUpdate: null,
                        hasBeenChecked: false,
                        offlineSince: null,
                        offlineAlertSent: false,
                        hlsReady: false,
                        hlsTranscoded: false
                    };
                }
            });
        }
    });

    // Initialize Telegram Bot
    telegramBot.init(config, db, {
        getCameraStatus: () => cameraStatus,
        getDiskUsage: () => diskUsage,
        restartSystem: telegramRestartSystem,
        cleanupRecordings: telegramCleanupWrapper,
        getRtspTemplates: () => RTSP_TEMPLATES,
        generateRtspUrl: generateRtspUrl,
        updateAdminCredentials: telegramUpdateAdminCredentials
    });

    // Initialize WhatsApp Bot
    whatsappBot.init(config, db, {
        getWeatherBundle: getWeatherBundle,
        getCameraStatus: () => cameraStatus,
        getDiskUsage: () => diskUsage,
        restartSystem: telegramRestartSystem,
        cleanupRecordings: telegramCleanupWrapper,
        getRtspTemplates: () => RTSP_TEMPLATES,
        generateRtspUrl: generateRtspUrl,
        updateAdminCredentials: telegramUpdateAdminCredentials
    });

    // Initialize Alert System
    alertSystem = new AlertSystem(config, whatsappBot, telegramBot);
    alertSystem.initialize().catch(err => {
        console.error('[Alert System] Initialization failed:', err.message);
    });

    // Initialize push notifications
    const publicKey = initializeWebPush();
    if (publicKey) {
        console.log('✅ Push notifications initialized');
    }

    // Delay sync slightly to ensure MediaMTX is up if started simultaneously
    setTimeout(async () => {
        // Dynamic OS Setup for MediaMTX
        await setupMediaMtxGlobalConfig();

        syncCameras();
        updateMediaMtxRecording();
        sendTelegramMessage("<b>🚀 CCTV System Started</b>\nSistem monitoring telah aktif.");

        // Scan and import existing recordings
        scanExistingRecordings();
        // Cleanup orphan DB rows for recordings whose files are already gone
        cleanupOrphanRecordings();
        setTimeout(cleanupOldRecordingsByRetention, 15000);
    }, 2000);

    // Periodically check recording schedule every minute
    setInterval(updateMediaMtxRecording, 60000);

    // Periodically check system health every 10 seconds
    setInterval(updateSystemHealth, 10000);
    updateSystemHealth();

    // Periodically cleanup orphan recordings every 6 hours
    setInterval(cleanupOrphanRecordings, 6 * 60 * 60 * 1000);
    setInterval(cleanupOldRecordingsByRetention, 6 * 60 * 60 * 1000);
    setInterval(checkMarineWeather, 30 * 60 * 1000);
});

// --- Telegram Bot Helpers ---

function telegramRestartSystem() {
    console.log('[System] Restart requested via Telegram');

    // Notify first
    setTimeout(() => {
        if (process.platform === 'linux') {
            restartLinuxServices(['cctv-web'], (err, stdout, stderr) => {
                if (err) {
                    console.error('Restart failed:', err);
                    const detail = (stderr || stdout || err.message || '').toString().trim();
                    if (detail) console.error('Restart detail:', detail);
                    if (isRunningUnderSystemd()) {
                        process.exit(0);
                    }
                }
            });
        } else {
            process.exit(0);
        }
    }, 1000);
}

function telegramDeleteOldRecordings(days, callback) {
    if (!days || days < 1) return callback({ error: 'Invalid days' });

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const dateStr = formatDateJakarta(cutoffDate);

    db.all("SELECT id, file_path, size FROM recordings WHERE created_at < ?", [dateStr], (err, rows) => {
        if (err) return callback({ error: err.message });

        if (!rows || rows.length === 0) return callback({ deleted: 0, freedSpace: '0 MB' });

        let deletedCount = 0;
        let freedBytes = 0;
        const fs = require('fs');

        rows.forEach(row => {
            const fullPath = path.join(__dirname, row.file_path);
            if (fs.existsSync(fullPath)) {
                try {
                    fs.unlinkSync(fullPath);
                } catch (e) { console.error('Delete file error:', e.message); }
            }
            deletedCount++;
            freedBytes += row.size || 0;
        });

        db.run("DELETE FROM recordings WHERE created_at < ?", [dateStr], (delErr) => {
            const freedMB = (freedBytes / 1024 / 1024).toFixed(2) + ' MB';
            callback({ deleted: deletedCount, freedSpace: freedMB });
        });
    });
}

function telegramCleanupWrapper(type, param, callback) {
    if (type === 'orphans') {
        // Reuse existing logic but return stats
        const fs = require('fs');
        const baseDir = __dirname;

        db.all('SELECT id, file_path FROM recordings', [], (err, rows) => {
            if (err || !rows) return callback({ deleted: 0 });

            let deleted = 0;
            let pending = rows.length;
            if (pending === 0) return callback({ deleted: 0 });

            rows.forEach((row) => {
                const fullPath = path.join(baseDir, row.file_path);
                if (!fs.existsSync(fullPath)) {
                    db.run('DELETE FROM recordings WHERE id = ?', [row.id], (delErr) => {
                        if (!delErr) deleted++;
                        if (--pending === 0) callback({ deleted });
                    });
                } else {
                    if (--pending === 0) callback({ deleted });
                }
            });
        });
    } else if (type === 'old') {
        telegramDeleteOldRecordings(param, callback);
    }
}

function telegramUpdateAdminCredentials(username, password) {
    try {
        const fs = require('fs');
        const path = require('path');
        const configPath = path.join(__dirname, 'config.json');
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const saltRounds = 10;
        const hashedPassword = bcrypt.hashSync(password, saltRounds);
        if (!currentConfig.authentication) {
            currentConfig.authentication = {};
        }
        currentConfig.authentication.username = username;
        currentConfig.authentication.password_hash = hashedPassword;
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 4));
        config.authentication = currentConfig.authentication;
        return { success: true };
    } catch (error) {
        console.error('Failed to update admin credentials:', error);
        return { success: false, error: error.message };
    }
}
