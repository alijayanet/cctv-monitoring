const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const http = require('http');
const https = require('https');
const session = require('express-session');
const config = require('./config.json');
const telegramBot = require('./telegram_bot');
const webPush = require('web-push');
const bcrypt = require('bcrypt');
const youtubeStream = require('./youtube_stream');
const app = express();
const PORT = config.server.port || 3003;

// Di belakang Cloudflare/reverse proxy HTTPS: Express harus percaya header X-Forwarded-*
// agar req.secure dan req.protocol benar, dan cookie session bisa dipakai di HTTPS.
// Trust proxy - required for secure cookies behind reverse proxy
if (config.server.behind_https_proxy) {
    app.set('trust proxy', 1);
    console.log('[Config] Trust proxy enabled for HTTPS');
}

// Helper to get effective MediaMTX Host
function normalizeHostValue(value) {
    if (!value) return '';
    let host = String(value).trim();
    if (!host) return '';
    try {
        if (host.startsWith('http://') || host.startsWith('https://')) {
            const url = new URL(host);
            return url.hostname || '';
        }
    } catch (e) { }
    host = host.split('/')[0];
    if (host.includes(':')) {
        host = host.split(':')[0];
    }
    return host;
}

function getEffectiveMediaMtxHost() {
    const rawHost = config.mediamtx?.host || '127.0.0.1';
    if (rawHost === 'auto') {
        return '127.0.0.1';
    }
    return normalizeHostValue(rawHost) || '127.0.0.1';
}

function getHlsBaseUrl() {
    const publicUrl = (config.mediamtx?.public_hls_url || '').trim();
    if (publicUrl) {
        return publicUrl.replace(/\/+$/, '');
    }
    const hlsPort = config.mediamtx?.hls_port || 8856;
    return `http://127.0.0.1:${hlsPort}`;
}

function getHlsHealthCheckBases() {
    const hlsPort = config.mediamtx?.hls_port || 8856;
    const internalBases = [`http://127.0.0.1:${hlsPort}`, `http://localhost:${hlsPort}`];
    const publicUrl = (config.mediamtx?.public_hls_url || '').trim();
    const publicBase = publicUrl ? publicUrl.replace(/\/+$/, '') : '';

    const bases = [...internalBases];
    if (publicBase) bases.push(publicBase);

    const uniq = [];
    bases.forEach((b) => {
        const v = String(b || '').trim();
        if (!v) return;
        if (!uniq.includes(v)) uniq.push(v);
    });
    return uniq;
}

function checkHlsUrl(url) {
    return new Promise((resolve) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (e) {
            resolve(false);
            return;
        }
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.request(
            {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'GET',
                timeout: 6000
            },
            (res) => {
                res.resume();
                resolve(res.statusCode >= 200 && res.statusCode < 400);
            }
        );
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

function getPathReady(item) {
    if (!item) return false;
    if (typeof item.ready === 'boolean') return item.ready;
    if (typeof item.sourceReady === 'boolean') return item.sourceReady;
    if (item.source && typeof item.source.ready === 'boolean') return item.source.ready;
    if (typeof item.state === 'string') return item.state.toLowerCase() === 'ready';
    if (item.source && typeof item.source.state === 'string') return item.source.state.toLowerCase() === 'ready';
    if (Array.isArray(item.readers)) return item.readers.length > 0;
    return false;
}

async function checkHlsStatus(cameraId) {
    const bases = getHlsHealthCheckBases();
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

let cameraStatus = {};
let diskUsage = { total: 0, used: 0, percent: 0 };
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

function formatDateJakarta(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(date);
    const get = (t) => parts.find(p => p.type === t)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

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
            return fs.statSync(fullPath).isDirectory() && f.startsWith('cam_');
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
const ADMIN_USER = config.authentication.username || 'admin';
const ADMIN_PASS = config.authentication.password || 'admin123';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
    // Ensure /api routes always return JSON even on error/404
    if (req.url.startsWith('/api')) {
        res.setHeader('Content-Type', 'application/json');
    }
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    next();
});
app.use('/recordings', express.static(path.join(__dirname, 'recordings')));

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
        secure: false, // Changed to false to allow login via HTTP/IP
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
    if (req.path === '/login' && req.method === 'POST') {
        console.log(`[Debug] Login attempt - Host: ${req.headers.host}, Protocol: ${req.protocol}, Secure: ${req.secure}`);
        console.log(`[Debug] Headers:`, {
            'x-forwarded-proto': req.headers['x-forwarded-proto'],
            'x-forwarded-for': req.headers['x-forwarded-for']
        });
    }
    next();
});

// Authentication Middleware
const requireAuth = (req, res, next) => {
    console.log(`[Auth] Checking auth for ${req.path} - Session: ${req.sessionID}, User: ${req.session?.user}`);
    if (req.session && req.session.user === ADMIN_USER) {
        return next();
    }
    console.log(`[Auth] Redirecting to login - No valid session`);
    res.redirect('/login');
};

const requireApiAuth = (req, res, next) => {
    if (req.session && req.session.user === ADMIN_USER) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
};

// --- MediaMTX Helper Functions ---

function sendTelegramMessage(text) {
    try {
        telegramBot.sendMessage(text);
    } catch (e) {
        console.error('Telegram Error:', e.message);
    }
}

function isRunningUnderSystemd() {
    return !!(process.env.INVOCATION_ID || process.env.JOURNAL_STREAM);
}

function restartLinuxServices(serviceNames, callback) {
    const done = typeof callback === 'function' ? callback : () => { };
    if (process.platform !== 'linux') {
        done(new Error('Not running on Linux'));
        return;
    }

    const list = Array.isArray(serviceNames) ? serviceNames : [serviceNames];
    const { execFile } = require('child_process');
    const isRoot = (typeof process.getuid === 'function') && process.getuid() === 0;

    const baseArgs = ['restart', ...list];
    const command = isRoot ? 'systemctl' : 'sudo';
    const args = isRoot ? baseArgs : ['-n', 'systemctl', ...baseArgs];

    execFile(
        command,
        args,
        { timeout: 15000, windowsHide: true },
        (err, stdout, stderr) => done(err, stdout, stderr)
    );
}

function getClientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
    if (Array.isArray(xf) && xf.length > 0) return String(xf[0] || '').trim();
    return (req.ip || req.connection?.remoteAddress || '').toString();
}



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

    const primaryHost = getEffectiveMediaMtxHost();
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
    const primaryHost = getEffectiveMediaMtxHost();
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
    const transcodeScript = isWin ? 'smart_transcode.bat' : './smart_transcode.sh';
    const notifyScript = isWin ? 'record_notify.bat' : './record_notify.sh';

    console.log(`Detecting OS: ${isWin ? 'Windows' : 'Linux/Ubuntu'}. Setting up MediaMTX scripts...`);

    // Apply global path defaults
    const result = await mediaMtxRequest('PATCH', '/defaults/update', {
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
    const recordingsDir = path.resolve(__dirname, 'recordings');
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
    const defaultsResult = await mediaMtxRequest('PATCH', '/defaults/update', {
        record: false,
        runOnReady: isWin ? 'smart_transcode.bat' : './smart_transcode.sh',
        runOnRecordSegmentComplete: isWin ? 'record_notify.bat' : './record_notify.sh',
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
            // Use /update/ instead of /patch/ for MediaMTX API v3
            await mediaMtxRequest('PATCH', '/update/' + outputPath, {
                record: shouldRecord,
                recordPath,
                recordFormat: 'fmp4',
                recordSegmentDuration,
                recordDeleteAfter
            });
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
                            percent
                        });
                    }
                });
                const recordingsDrive = path.parse(path.resolve(__dirname, 'recordings')).root.slice(0, 2).toUpperCase();
                const sysDrive = (process.env.SystemDrive || 'C:').toUpperCase();
                const summary = disks.find(d => String(d.mounted || '').toUpperCase() === recordingsDrive)
                    || disks.find(d => String(d.mounted || '').toUpperCase() === sysDrive)
                    || disks[0]
                    || { total: '0 B', used: '0 B', free: '0 B', percent: 0, mounted: recordingsDrive || sysDrive };
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
        exec('df -hP | tail -n +2', (err, stdout) => {
            if (!err) {
                const lines = stdout.trim().split('\n');
                const disks = [];
                lines.forEach(line => {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 6) {
                        disks.push({
                            filesystem: parts[0],
                            total: parts[1],
                            used: parts[2],
                            free: parts[3],
                            percent: parseInt(parts[4]),
                            mounted: parts[5]
                        });
                    }
                });
                const summary = disks.find(d => d.mounted === '/') || disks[0] || { total: '0', used: '0', free: '0', percent: 0, mounted: '/' };
                const osmod = require('os');
                const totalMem = osmod.totalmem();
                const freeMem = osmod.freemem();
                const usedMem = totalMem - freeMem;
                const formatBytes = (bytes) => {
                    if (!bytes || bytes === 0) return '0 B';
                    const k = 1024;
                    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
                    const i = Math.floor(Math.log(bytes) / Math.log(k));
                    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
                };
                const memPercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;
                const load = osmod.loadavg();
                diskUsage = {
                    total: summary.total,
                    used: summary.used,
                    free: summary.free,
                    percent: summary.percent,
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
        const pathsData = await mediaMtxRequest('GET', '/v3/paths/list');
        if (pathsData?.error) {
            throw new Error(pathsData.message || 'MediaMTX API error');
        }
        mediaMtxErrorNotified = false;
        const itemsList = pathsData.items || [];

        // Convert list to map for easier lookup if it's an array
        let activePaths = {};
        if (Array.isArray(itemsList)) {
            itemsList.forEach(p => activePaths[p.name] = p);
        } else {
            activePaths = itemsList; // Older versions might return a map
        }

        const rows = await new Promise((resolve) => {
            db.all("SELECT id, nama, lokasi FROM cameras", [], (err, result) => {
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
        if (!hlsStatusCache.lastUpdate || (nowMs - hlsStatusCache.lastUpdate) > 60000) {
            const hlsStatuses = await Promise.all(rows.map((cam) => checkHlsStatus(cam.id)));
            const byId = {};
            rows.forEach((cam, idx) => {
                byId[String(cam.id)] = hlsStatuses[idx] || { ready: false, transcoded: false };
            });
            hlsStatusCache = { lastUpdate: nowMs, data: byId };
        }

        rows.forEach((cam) => {
            const inputPath = `cam_${cam.id}_input`;
            const outputPath = `cam_${cam.id}`;

            const inputItem = activePaths[inputPath];
            const outputItem = activePaths[outputPath];

            const inputReady = getPathReady(inputItem);
            const outputReady = getPathReady(outputItem);
            const hlsStatus = hlsStatusCache.data[String(cam.id)] || { ready: false, transcoded: false };
            const currentlyOnline = !!(outputReady || inputReady || hlsStatus.ready);

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
    const pathName = `cam_${cam.id}_input`;

    console.log(`Registering camera ${cam.id} (${cam.nama}) to MediaMTX...`);

    const delRes = await mediaMtxRequest('DELETE', '/delete/' + pathName);
    if (delRes?.error && delRes.status && delRes.status !== 404) {
        console.log(`[MediaMTX] Failed to delete path ${pathName} (status=${delRes.status}). Will try to add/update anyway.`);
    }

    // Since we use HLS fMP4 variant, H265/HEVC is natively supported
    // No transcoding needed - better quality and performance
    const addRes = await mediaMtxRequest('POST', '/add/' + pathName, {
        name: pathName,
        source: cam.url_rtsp,
        sourceOnDemand: false,
        rtspTransport: 'tcp',
        sourceProtocol: 'tcp'
    });
    if (!addRes?.error) return addRes;
    if (addRes.status === 409) {
        return mediaMtxRequest('PATCH', '/update/' + pathName, {
            source: cam.url_rtsp,
            sourceOnDemand: false,
            rtspTransport: 'tcp',
            sourceProtocol: 'tcp'
        });
    }
    return addRes;
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

// Public Dashboard
app.get('/', (req, res) => {
    db.all("SELECT * FROM cameras WHERE is_public = 1", [], (err, rows) => {
        if (err) {
            return console.error(err.message);
        }
        res.render('index', { cameras: rows });
    });
});

// Public Archive (Recordings)
app.get('/archive', (req, res) => {
    console.log('Accessing /archive route');
    const selectedDate = (req.query && req.query.date) ? String(req.query.date) : '';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(500, Math.max(50, parseInt(req.query.size, 10) || 200));
    const allRecordings = getRecordingsFromFilesystem(selectedDate);
    // Only show recordings from public cameras
    db.all("SELECT id, nama FROM cameras WHERE is_public = 1", [], (errCam, cams) => {
        const publicCamIds = new Set((cams || []).map(c => String(c.id)));
        const filteredRecs = allRecordings.filter(r => publicCamIds.has(String(r.camera_id)));
        const totalCount = filteredRecs.length;
        const totalPages = Math.max(1, Math.ceil(totalCount / size));
        const safePage = Math.min(page, totalPages);
        const offset = (safePage - 1) * size;
        const recordings = filteredRecs.slice(offset, offset + size);
        const cameraNameById = new Map((cams || []).map(cam => [String(cam.id), cam.nama]));
        const normalized = recordings.map(rec => {
            const name = cameraNameById.get(String(rec.camera_id)) || rec.camera_folder || 'Unknown';
            return { ...rec, camera_name: name };
        });
        res.render('public_recordings', {
            recordings: normalized,
            cameras: cams || [],
            site: config.site,
            filterDate: selectedDate,
            totalCount,
            currentPage: safePage,
            totalPages,
            pageSize: size
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
            site: config.site
        });
    });
});

// Login Routes
app.get('/login', (req, res) => {
    if (req.session && req.session.user === ADMIN_USER) {
        return res.redirect('/admin');
    }
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    console.log(`[Login] Attempt for user: ${username}`);

    const cfgUser = (config.authentication && config.authentication.username) ? config.authentication.username : ADMIN_USER;
    const cfgPlain = (config.authentication && config.authentication.password) ? config.authentication.password : ADMIN_PASS;
    const cfgHash = (config.authentication && config.authentication.password_hash) ? config.authentication.password_hash : null;
    const userOk = username === cfgUser;
    const passOk = cfgHash ? bcrypt.compareSync(password, cfgHash) : (password === cfgPlain);

    if (userOk && passOk) {
        req.session.user = username;
        console.log(`[Login] Success - Session ID: ${req.sessionID}`);
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        if (loginAttempts[ip]) {
            delete loginAttempts[ip];
        }
        res.redirect('/admin');
    } else {
        console.log(`[Login] Failed - Invalid credentials`);

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
    req.session.destroy();
    res.redirect('/login');
});

// Admin Panel (Protected)
app.get('/admin', requireAuth, (req, res) => {
    db.all("SELECT * FROM cameras", [], (err, rows) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Database Error");
        }
        res.render('admin', {
            cameras: rows || [],
            user: req.session.user,
            mediamtx: config.mediamtx || {},
            repository_url: config.server.repository_url || 'alijayanet/cctv-monitoring'
        });
    });
});

app.get('/admin/live', requireAuth, (req, res) => {
    db.all("SELECT * FROM cameras", [], (err, rows) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Database Error");
        }
        res.render('index', { cameras: rows || [], isAdmin: true, user: req.session.user });
    });
});

app.get('/admin/recordings', requireAuth, (req, res) => {
    const selectedDate = (req.query && req.query.date) ? String(req.query.date) : '';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(500, Math.max(50, parseInt(req.query.size, 10) || 200));
    const allRecordings = getRecordingsFromFilesystem(selectedDate);
    const totalCount = allRecordings.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / size));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * size;
    const recordings = allRecordings.slice(offset, offset + size);

    db.all("SELECT id, nama FROM cameras", [], (errCam, cams) => {
        if (errCam) return console.error(errCam.message);
        const cameraNameById = new Map((cams || []).map(cam => [String(cam.id), cam.nama]));

        const filePaths = recordings.map(r => r.file_path);
        if (filePaths.length === 0) {
            return res.render('recordings', {
                recordings: [],
                user: req.session.user,
                filterDate: selectedDate,
                totalCount,
                currentPage: safePage,
                totalPages,
                pageSize: size
            });
        }

        const placeholders = filePaths.map(() => '?').join(',');
        db.all(`SELECT id, file_path FROM recordings WHERE file_path IN (${placeholders})`, filePaths, (errRec, rows) => {
            if (errRec) return console.error(errRec.message);
            const idByPath = new Map((rows || []).map(r => [r.file_path, r.id]));

            const normalized = recordings.map(rec => {
                const name = cameraNameById.get(String(rec.camera_id)) || rec.camera_folder || 'Unknown';
                return { ...rec, camera_name: name, id: idByPath.get(rec.file_path) || null };
            });

            res.render('recordings', {
                recordings: normalized,
                user: req.session.user,
                filterDate: selectedDate,
                totalCount,
                currentPage: safePage,
                totalPages,
                pageSize: size
            });
        });
    });
});

// API Routes
app.get('/api/cameras', (req, res) => {
    // Optional: Public read access for cameras JSON? Or strictly admin?
    // Let's keep read public for now as dashboard might use it or external tools.
    // If strict admin needed, add requireApiAuth.
    db.all("SELECT id, nama, lokasi, lat, lng, ptz_enabled, onvif_port FROM cameras", [], (err, rows) => {
        res.json({ data: rows });
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
    const status = String(req.query.status || 'pending').trim();
    const allowed = new Set(['pending', 'verified', 'rejected']);
    const safeStatus = allowed.has(status) ? status : 'pending';
    const limit = Math.min(500, Math.max(20, parseInt(req.query.limit, 10) || 100));

    db.all(
        `SELECT r.*, c.nama as camera_name, c.lokasi as camera_location
         FROM incident_reports r
         LEFT JOIN cameras c ON c.id = r.camera_id
         WHERE r.status = ?
         ORDER BY r.created_at DESC
         LIMIT ?`,
        [safeStatus, limit],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, data: rows || [] });
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

app.post('/api/cameras', requireApiAuth, (req, res) => {
    const { nama, lokasi, url_rtsp, lat, lng, is_public } = req.body;

    // Validate RTSP URL
    if (!url_rtsp || !url_rtsp.match(/^rtsp:\/\/[^\s]+$/)) {
        return res.status(400).json({ error: 'Invalid RTSP URL format. Must start with rtsp://' });
    }
    if (!nama || nama.trim().length === 0) {
        return res.status(400).json({ error: 'Camera name is required' });
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

// Update Recording Settings
app.post('/api/settings/recording', requireApiAuth, (req, res) => {
    const { enabled, start_time, end_time, segment_duration, delete_after,
        video_codec, resolution, frame_rate, bitrate, max_bitrate,
        audio_enabled, audio_bitrate, max_storage_percent } = req.body;

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
        max_storage_percent: parseInt(max_storage_percent) || 90
    };

    const fs = require('fs');
    fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 4), (err) => {
        if (err) return res.status(500).json({ error: 'Failed save' });
        app.locals.recording = config.recording;

        // Apply recording path configs (record=true/false)
        updateMediaMtxRecording();

        // Restart all cameras to apply transcoding settings (bitrate/resolution)
        // This forces smart_transcode.sh to restart with new config
        console.log('Reloading all cameras to apply new recording/transcoding settings...');
        syncCameras();

        res.json({ message: "Recording settings updated. Streams are restarting...", recording: config.recording });
    });
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
                            if (!uriErr && uriResult && uriResult.uri) {
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

    const cameraId = match[1];
    const filename = path.basename(file);
    const relativePath = path.relative(__dirname, file).replace(/\\/g, '/');

    // Get file size
    const fs = require('fs');
    let size = 0;
    try {
        const stats = fs.statSync(file);
        size = stats.size;
    } catch (e) {
        console.error("Could not get file stats for " + file);
    }

    const createdAt = formatDateJakarta(new Date());
    db.run(`INSERT INTO recordings (camera_id, filename, file_path, size, created_at) VALUES (?, ?, ?, ?, ?)`,
        [cameraId, filename, relativePath, size, createdAt],
        (err) => {
            if (err) console.error("Database error saving recording:", err.message);
            res.json({ status: "ok" });
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
            if (err || !rows || rows.length === 0) {
                if (err) console.error('[Storage Cleanup] DB Error:', err.message);
                return resolve();
            }

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
    console.error('Global Error:', err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
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
    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latR}&longitude=${lngR}&current=temperature_2m,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,wind_speed_10m,wind_direction_10m&timezone=${tz}&windspeed_unit=kmh`;
    const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${latR}&longitude=${lngR}&hourly=wave_height,wave_direction,wave_period&timezone=${tz}`;

    const [forecast, marine] = await Promise.all([
        fetchJson(forecastUrl),
        fetchJson(marineUrl).catch(() => null)
    ]);

    const data = {
        latitude: latR,
        longitude: lngR,
        current: forecast?.current || null,
        hourly: forecast?.hourly || null,
        marine_hourly: marine?.hourly || null
    };

    weatherCache.set(key, { at: now, data });
    return data;
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

app.get('/api/system/version', (req, res) => {
    res.json({ version: readLocalVersion() });
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
        const lat = req.query?.lat;
        const lng = req.query?.lng;
        const data = await getWeatherBundle(lat, lng);
        res.json({ success: true, data });
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
                return fs.statSync(fullPath).isDirectory() && f.startsWith('cam_');
            });

            // Prepare statements for batch insertion
            const stmt = db.prepare('INSERT INTO recordings (camera_id, filename, file_path, size, created_at) VALUES (?, ?, ?, ?, ?)');

            db.serialize(() => {
                db.run('BEGIN TRANSACTION');

                cameraFolders.forEach(folder => {
                    const match = folder.match(/^cam_(\d+)(?:_input)?$/);
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
        const bcrypt = require('bcrypt');
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
