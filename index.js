const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const http = require('http');
const session = require('express-session');
const config = require('./config.json');

const app = express();
const PORT = config.server.port || 3000;

// Helper to get effective MediaMTX Host
function getEffectiveMediaMtxHost() {
    const host = config.mediamtx?.host || '127.0.0.1';
    if (host === 'auto') {
        return '127.0.0.1'; // Default auto to localhost
    }
    return host;
}

app.locals.site = config.site;
app.locals.recording = config.recording;
app.locals.telegram = config.telegram;
app.locals.mediamtx = config.mediamtx;
app.locals.hls_port = config.mediamtx?.hls_port || 8856;

// Monitoring State
let cameraStatus = {}; // { id: { online: true, lastUpdate: Date } }
let diskUsage = { total: 0, used: 0, percent: 0 };

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
app.use('/recordings', express.static(path.join(__dirname, 'recordings')));

// Session Middleware
app.use(session({
    secret: config.server.session_secret || 'cctv-monitoring-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        maxAge: 24 * 60 * 60 * 1000 // Session expires after 24 hours
    }
}));

// Authentication Middleware
const requireAuth = (req, res, next) => {
    if (req.session && req.session.user === ADMIN_USER) {
        return next();
    }
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
    if (!config.telegram || !config.telegram.enabled || !config.telegram.bot_token || !config.telegram.chat_id) {
        return;
    }

    const https = require('https');
    const data = JSON.stringify({
        chat_id: config.telegram.chat_id,
        text: text,
        parse_mode: 'HTML'
    });

    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${config.telegram.bot_token}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    };

    const req = https.request(options, (res) => {
        res.on('data', () => { });
    });

    req.on('error', (e) => {
        console.error('Telegram Error:', e.message);
    });

    req.write(data);
    req.end();
}



function mediaMtxRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: getEffectiveMediaMtxHost(),
            port: config.mediamtx?.api_port || 9123,
            path: path.startsWith('/v3/') ? path : '/v3/config/paths' + path,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(data ? JSON.parse(data) : {});
                    } catch (parseErr) {
                        console.error('JSON Parse Error:', parseErr.message, 'Data:', data);
                        resolve({ error: true, message: 'Invalid JSON response', raw: data });
                    }
                } else {
                    // Ignore 404 on delete, or specific errors
                    resolve({ error: true, status: res.statusCode, message: data });
                }
            });
        });

        req.on('error', (e) => {
            console.error(`MediaMTX API Error: ${e.message}`);
            // Don't reject, just resolve with error so app keeps running
            resolve({ error: true, message: e.message });
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function setupMediaMtxGlobalConfig() {
    const isWin = process.platform === 'win32';
    const transcodeScript = isWin ? 'smart_transcode.bat' : './smart_transcode.sh';
    const notifyScript = isWin ? 'record_notify.bat' : './record_notify.sh';

    console.log(`Detecting OS: ${isWin ? 'Windows' : 'Linux/Ubuntu'}. Setting up MediaMTX scripts...`);

    // Apply global path defaults
    await mediaMtxRequest('PATCH', '/defaults/update', {
        runOnReady: transcodeScript,
        runOnReadyRestart: true,
        runOnRecordSegmentComplete: notifyScript
    });
}

async function updateMediaMtxRecording() {
    console.log('Applying recording settings to MediaMTX...');
    const rec = config.recording || {};
    const isInsideWindow = checkTimeWindow(rec.start_time, rec.end_time);
    const shouldRecord = (rec.enabled && isInsideWindow);

    console.log(`Recording Window: ${rec.start_time} - ${rec.end_time}. Status: ${shouldRecord ? 'RECORDING' : 'IDLE'}`);

    // CONFIGURATION STRATEGY: 
    // 1. Path cam_X_input (raw) -> record: OFF
    // 2. Path cam_X (transcoded H.264) -> record: ON (if enabled)

    const isWin = process.platform === 'win32';

    // Disable recording on all paths first (global defaults)
    await mediaMtxRequest('PATCH', '/defaults/update', {
        record: false,
        runOnReady: isWin ? 'smart_transcode.bat' : './smart_transcode.sh',
        runOnRecordSegmentComplete: isWin ? 'record_notify.bat' : './record_notify.sh'
    });

    // Enable recording ONLY for transcoded paths (matches cam_1, cam_2, etc. NOT cam_1_input)
    // We use a regex path 'all_others' for defaults, but we can target specific paths
    db.all("SELECT id FROM cameras", [], async (err, rows) => {
        if (err) return;
        for (const cam of rows) {
            const outputPath = `cam_${cam.id}`;
            await mediaMtxRequest('PATCH', `/config/paths/update/${outputPath}`, {
                record: shouldRecord,
                recordSegmentDuration: rec.segment_duration || '60m',
                recordDeleteAfter: rec.delete_after || '7d'
            });
        }
    });
}

async function updateSystemHealth() {
    // 1. Check Disk Usage
    const { exec } = require('child_process');
    const isWin = process.platform === 'win32';

    if (isWin) {
        // Check Disk Usage (Windows)
        exec("wmic logicaldisk where \"DeviceID='C:'\" get Size,FreeSpace /value", (err, stdout) => {
            if (!err) {
                const lines = stdout.trim().split('\n');
                let size = 0, freeSpace = 0;
                lines.forEach(line => {
                    if (line.startsWith('Size=')) size = parseInt(line.split('=')[1]) || 0;
                    if (line.startsWith('FreeSpace=')) freeSpace = parseInt(line.split('=')[1]) || 0;
                });
                const used = size - freeSpace;
                const percent = size > 0 ? Math.round((used / size) * 100) : 0;

                const formatBytes = (bytes) => {
                    if (bytes === 0) return '0 B';
                    const k = 1024;
                    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
                    const i = Math.floor(Math.log(bytes) / Math.log(k));
                    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
                };

                diskUsage = {
                    total: formatBytes(size),
                    used: formatBytes(used),
                    free: formatBytes(freeSpace),
                    percent: percent,
                    mounted: 'C:'
                };

                if (diskUsage.percent > 90) {
                    sendTelegramMessage(`⚠️ <b>CRITICAL STORAGE</b>\nDisk usage is at <b>${diskUsage.percent}%</b> (${diskUsage.used}/${diskUsage.total}). Segment cleanup might be needed.`);
                }
            }
        });
    } else {
        // Check Disk Usage (Linux)
        exec('df -h / | tail -1', (err, stdout) => {
            if (!err) {
                const parts = stdout.trim().split(/\s+/);
                // Filesystem Size Used Avail Use% Mounted
                diskUsage = {
                    total: parts[1],
                    used: parts[2],
                    free: parts[3],
                    percent: parseInt(parts[4]),
                    mounted: parts[5]
                };

                if (diskUsage.percent > 90) {
                    sendTelegramMessage(`⚠️ <b>CRITICAL STORAGE</b>\nDisk usage is at <b>${diskUsage.percent}%</b> (${diskUsage.used}/${diskUsage.total}). Segment cleanup might be needed.`);
                }
            }
        });
    }

    // 2. Check Camera Health via MediaMTX Runtime API
    try {
        // Use /v3/paths/list for real-time status (not just config)
        const pathsData = await mediaMtxRequest('GET', '/v3/paths/list');
        const itemsList = pathsData.items || [];

        // Convert list to map for easier lookup if it's an array
        let activePaths = {};
        if (Array.isArray(itemsList)) {
            itemsList.forEach(p => activePaths[p.name] = p);
        } else {
            activePaths = itemsList; // Older versions might return a map
        }

        db.all("SELECT id, nama, lokasi FROM cameras", [], (err, rows) => {
            if (err) return;

            rows.forEach(cam => {
                const inputPath = `cam_${cam.id}_input`;
                const outputPath = `cam_${cam.id}`;

                // Camera is online if either the input path (pulling) or output path (transcoded) is active
                // and has a source ready/connected.
                const inputItem = activePaths[inputPath];
                const outputItem = activePaths[outputPath];

                const currentlyOnline = !!((inputItem && inputItem.source) || (outputItem && outputItem.source));

                const prevState = cameraStatus[cam.id] || { online: false };

                // Alert on state change
                if (prevState.hasBeenChecked && currentlyOnline !== prevState.online) {
                    const statusText = currentlyOnline ? "✅ ONLINE" : "❌ OFFLINE";
                    const statusEmoji = currentlyOnline ? "📶" : "⚠️";
                    sendTelegramMessage(`${statusEmoji} <b>Camera ${statusText}</b>\nNama: ${cam.nama}\nLokasi: ${cam.lokasi}`);
                }

                cameraStatus[cam.id] = {
                    online: currentlyOnline,
                    lastUpdate: new Date(),
                    hasBeenChecked: true
                };
            });
        });
    } catch (e) {
        // Silent fail
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
    const pathName = `cam_${cam.id}_input`;

    console.log(`Registering camera ${cam.id} (${cam.nama}) to MediaMTX...`);

    // Always delete first to ensure a fresh registration if URL changed
    await mediaMtxRequest('DELETE', '/delete/' + pathName);

    // Since we use HLS fMP4 variant, H265/HEVC is natively supported
    // No transcoding needed - better quality and performance
    return mediaMtxRequest('POST', '/add/' + pathName, {
        name: pathName,
        source: cam.url_rtsp
    });
}

function syncCameras() {
    console.log('Syncing all cameras with MediaMTX...');
    db.all("SELECT * FROM cameras", async (err, rows) => {
        if (err) return console.error(err);
        for (const cam of rows) {
            await registerCamera(cam);
        }
    });
}

// --- Routes ---

// Public Dashboard
app.get('/', (req, res) => {
    db.all("SELECT * FROM cameras", [], (err, rows) => {
        if (err) {
            return console.error(err.message);
        }
        res.render('index', { cameras: rows });
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
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.user = username;
        res.redirect('/admin');
    } else {
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
        res.render('admin', { cameras: rows || [], user: req.session.user });
    });
});

app.get('/admin/recordings', requireAuth, (req, res) => {
    const query = `
        SELECT r.*, c.nama as camera_name 
        FROM recordings r 
        JOIN cameras c ON r.camera_id = c.id 
        ORDER BY r.created_at DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return console.error(err.message);
        res.render('recordings', { recordings: rows, user: req.session.user });
    });
});

// API Routes
app.get('/api/cameras', (req, res) => {
    // Optional: Public read access for cameras JSON? Or strictly admin?
    // Let's keep read public for now as dashboard might use it or external tools.
    // If strict admin needed, add requireApiAuth.
    db.all("SELECT * FROM cameras", [], (err, rows) => {
        res.json({ data: rows });
    });
});

app.post('/api/cameras', requireApiAuth, (req, res) => {
    const { nama, lokasi, url_rtsp } = req.body;

    // Validate RTSP URL
    if (!url_rtsp || !url_rtsp.match(/^rtsp:\/\/[^\s]+$/)) {
        return res.status(400).json({ error: 'Invalid RTSP URL format. Must start with rtsp://' });
    }
    if (!nama || nama.trim().length === 0) {
        return res.status(400).json({ error: 'Camera name is required' });
    }

    db.run(`INSERT INTO cameras (nama, lokasi, url_rtsp) VALUES (?, ?, ?)`, [nama.trim(), lokasi?.trim() || '', url_rtsp.trim()], async function (err) {
        if (err) {
            res.status(400).json({ error: err.message });
            return;
        }
        const newCam = { id: this.lastID, nama, lokasi, url_rtsp };
        await registerCamera(newCam);
        res.json({ message: "success", data: newCam });
    });
});

app.delete('/api/cameras/:id', requireApiAuth, (req, res) => {
    db.run(`DELETE FROM cameras WHERE id = ?`, req.params.id, async function (err) {
        if (err) {
            res.status(400).json({ error: err.message });
            return;
        }
        // Remove from MediaMTX
        await mediaMtxRequest('DELETE', '/delete/' + `cam_${req.params.id}_input`);
        await mediaMtxRequest('DELETE', '/delete/' + `cam_${req.params.id}`);
        res.json({ message: "deleted" });
    });
});

// Update camera
app.put('/api/cameras/:id', requireApiAuth, (req, res) => {
    const { nama, lokasi, url_rtsp } = req.body;
    const id = req.params.id;

    // Validate RTSP URL
    if (!url_rtsp || !url_rtsp.match(/^rtsp:\/\/[^\s]+$/)) {
        return res.status(400).json({ error: 'Invalid RTSP URL format. Must start with rtsp://' });
    }
    if (!nama || nama.trim().length === 0) {
        return res.status(400).json({ error: 'Camera name is required' });
    }

    db.run(`UPDATE cameras SET nama = ?, lokasi = ?, url_rtsp = ? WHERE id = ?`,
        [nama.trim(), lokasi?.trim() || '', url_rtsp.trim(), id],
        async function (err) {
            if (err) {
                res.status(400).json({ error: err.message });
                return;
            }
            // Update MediaMTX
            await registerCamera({ id, nama, lokasi, url_rtsp });
            res.json({
                message: "success",
                data: { id, nama, lokasi, url_rtsp }
            });
        });
});

// Update Settings
app.post('/api/settings', requireApiAuth, (req, res) => {
    const { title, footer } = req.body;
    if (!config.site) config.site = {};
    config.site.title = title;
    config.site.footer = footer;

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
    const { enabled, start_time, end_time, segment_duration, delete_after } = req.body;

    config.recording = {
        enabled: enabled === 'true' || enabled === true,
        start_time,
        end_time,
        segment_duration,
        delete_after
    };

    const fs = require('fs');
    fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 4), (err) => {
        if (err) return res.status(500).json({ error: 'Failed save' });
        app.locals.recording = config.recording;
        updateMediaMtxRecording(); // Apply immediately
        res.json({ message: "Recording settings updated" });
    });
});

// System Status API
app.get('/api/status', async (req, res) => {
    // Check transcode status for each camera
    let transcodeStatus = {};
    try {
        const pathsData = await mediaMtxRequest('GET', '/v3/paths/list');
        const items = pathsData.items || [];
        const activePathNames = Array.isArray(items) ? items.map(p => p.name) : Object.keys(items);

        // Check which cameras have transcoded output streams
        Object.keys(cameraStatus).forEach(id => {
            const hasInput = activePathNames.includes(`cam_${id}_input`);
            const hasTranscoded = activePathNames.includes(`cam_${id}`);
            transcodeStatus[id] = {
                input: hasInput,
                transcoded: hasTranscoded,
                mode: hasTranscoded ? 'transcoded' : (hasInput ? 'direct' : 'offline')
            };
        });
    } catch (e) {
        // Ignore errors
    }

    res.json({
        cameras: cameraStatus,
        transcode: transcodeStatus,
        disk: diskUsage,
        serverTime: new Date()
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

// Update MediaMTX Settings
app.post('/api/settings/mediamtx', requireApiAuth, (req, res) => {
    const { host, api_port, hls_port } = req.body;

    config.mediamtx = {
        host: host || "127.0.0.1",
        api_port: parseInt(api_port) || 9123,
        hls_port: parseInt(hls_port) || 8856
    };

    const fs = require('fs');
    fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 4), (err) => {
        if (err) return res.status(500).json({ error: 'Failed save' });
        app.locals.mediamtx = config.mediamtx;
        app.locals.hls_port = config.mediamtx.hls_port;
        res.json({ message: "MediaMTX settings updated" });
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

// Recording Notification from MediaMTX
app.post('/api/recordings/notify', (req, res) => {
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

    db.run(`INSERT INTO recordings (camera_id, filename, file_path, size) VALUES (?, ?, ?, ?)`,
        [cameraId, filename, relativePath, size],
        (err) => {
            if (err) console.error("Database error saving recording:", err.message);
            res.json({ status: "ok" });
        }
    );
});

app.delete('/api/recordings/:id', requireApiAuth, (req, res) => {
    db.get("SELECT file_path FROM recordings WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Not found" });

        const fullPath = path.join(__dirname, row.file_path);
        const fs = require('fs');
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }

        db.run("DELETE FROM recordings WHERE id = ?", [req.params.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "deleted" });
        });
    });
});



// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Global Error:', err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

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

    // Get all camera folders
    const cameraFolders = fs.readdirSync(recordingsDir).filter(f => {
        const fullPath = path.join(recordingsDir, f);
        return fs.statSync(fullPath).isDirectory() && f.startsWith('cam_');
    });

    let importedCount = 0;

    cameraFolders.forEach(folder => {
        // Extract camera ID from folder name (cam_1_input or cam_1)
        const match = folder.match(/^cam_(\d+)(?:_input)?$/);
        if (!match) return;

        const cameraId = match[1];
        const folderPath = path.join(recordingsDir, folder);

        // Get all recording files in this folder
        const files = fs.readdirSync(folderPath).filter(f => {
            return f.endsWith('.mp4') || f.endsWith('.ts');
        });

        files.forEach(filename => {
            const filePath = path.join(folderPath, filename);
            const relativePath = path.relative(__dirname, filePath).replace(/\\/g, '/');

            // Check if already in database
            db.get('SELECT id FROM recordings WHERE file_path = ?', [relativePath], (err, row) => {
                if (err) {
                    console.error('Database error:', err.message);
                    return;
                }

                if (!row) {
                    // Not in database, import it
                    const stats = fs.statSync(filePath);
                    const size = stats.size;

                    db.run(`INSERT INTO recordings (camera_id, filename, file_path, size) VALUES (?, ?, ?, ?)`,
                        [cameraId, filename, relativePath, size],
                        (err) => {
                            if (err) {
                                console.error(`Failed to import ${filename}:`, err.message);
                            } else {
                                importedCount++;
                                console.log(`Imported: ${filename} (Camera ${cameraId})`);
                            }
                        }
                    );
                }
            });
        });
    });

    setTimeout(() => {
        if (importedCount > 0) {
            console.log(`✅ Imported ${importedCount} existing recording(s) to database`);
        } else {
            console.log('✅ All recordings already in database');
        }
    }, 2000);
}

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);

    // Delay sync slightly to ensure MediaMTX is up if started simultaneously
    setTimeout(async () => {
        // Dynamic OS Setup for MediaMTX
        await setupMediaMtxGlobalConfig();

        syncCameras();
        updateMediaMtxRecording();
        sendTelegramMessage("<b>🚀 CCTV System Started</b>\nSistem monitoring telah aktif.");

        // Scan and import existing recordings
        scanExistingRecordings();
    }, 2000);

    // Periodically check recording schedule every minute
    setInterval(updateMediaMtxRecording, 60000);

    // Periodically check system health every 10 seconds
    setInterval(updateSystemHealth, 10000);
    updateSystemHealth();
});
