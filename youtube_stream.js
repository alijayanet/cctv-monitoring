const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const db = require('./database');
const config = require('./config.json');

const activeStreams = {};
const logDir = path.join(__dirname, 'stream_logs');

// Ensure log directory exists
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

let ffmpegStaticPath = null;
try {
    ffmpegStaticPath = require('ffmpeg-static');
} catch (e) {
    // ffmpeg-static not installed, fallback to system ffmpeg
}

let workingFfmpegPath = null;

async function checkFfmpeg() {
    const pathsToTest = [];
    if (process.env.FFMPEG_PATH) pathsToTest.push(process.env.FFMPEG_PATH);
    pathsToTest.push('ffmpeg');
    pathsToTest.push('/usr/bin/ffmpeg'); // Common Ubuntu path
    if (ffmpegStaticPath) pathsToTest.push(ffmpegStaticPath);

    for (const binPath of pathsToTest) {
        try {
            const isWorking = await new Promise((resolve) => {
                const ffmpeg = spawn(binPath, ['-version']);
                let output = '';
                ffmpeg.stdout.on('data', (data) => output += data.toString());
                ffmpeg.on('close', (code) => {
                    if (code === 0) {
                        const match = output.match(/ffmpeg version (.*?)\s/);
                        resolve({ available: true, version: match ? match[1] : 'unknown', path: binPath });
                    } else {
                        resolve(false);
                    }
                });
                ffmpeg.on('error', () => resolve(false));
            });

            if (isWorking) {
                workingFfmpegPath = isWorking.path;
                return isWorking; // Return the success object
            }
        } catch (err) {
            continue;
        }
    }
    
    return { available: false };
}

function getFfmpegPath() {
    return workingFfmpegPath || 'ffmpeg';
}

function getLogPath(cameraId) {
    return path.join(logDir, `camera_${cameraId}.log`);
}

function writeLog(cameraId, message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(getLogPath(cameraId), logMessage);
}

function getLogs(cameraId) {
    const logPath = getLogPath(cameraId);
    if (!fs.existsSync(logPath)) return [];
    try {
        const content = fs.readFileSync(logPath, 'utf8');
        return content.split('\n').filter(line => line.trim() !== '').slice(-100);
    } catch (e) {
        return [`Error reading log: ${e.message}`];
    }
}

async function startStream(cameraId, streamKey, quality = 'medium') {
    // Sanitize streamKey: remove RTMP URL if user accidentally pasted it
    if (streamKey && streamKey.includes('/live2/')) {
        streamKey = streamKey.split('/live2/').pop();
    }
    // Remove any trailing slashes or spaces
    streamKey = streamKey.trim().replace(/\/$/, '');

    if (activeStreams[cameraId]) {
        if (activeStreams[cameraId].status === 'running') {
            throw new Error('Stream is already running for this camera');
        } else {
            stopStream(cameraId);
        }
    }

    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM cameras WHERE id = ?', [cameraId], async (err, camera) => {
            if (err) return reject(new Error('Database error'));
            if (!camera) return reject(new Error('Camera not found'));

            // Clear old log
            if (fs.existsSync(getLogPath(cameraId))) {
                fs.writeFileSync(getLogPath(cameraId), '');
            }

            writeLog(cameraId, `[SYSTEM] Starting YouTube stream for ${camera.nama}`);
            
            // Generate RTSP URL (assuming MediaMTX format)
            const rtspPort = config.mediamtx?.rtsp_port || 8555;

            let videoBitrate = '2500k';
            let bufSize = '5000k';
            let resolution = '1280x720';

            if (quality === 'low') {
                videoBitrate = '1000k';
                bufSize = '2000k';
                resolution = '854x480';
            } else if (quality === 'high') {
                videoBitrate = '4000k';
                bufSize = '8000k';
                resolution = '1920x1080';
            }

            const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;

            // Determine if we need to transcode based on codec
            let needsTranscode = quality !== 'source';
            
            // Function to spawn FFmpeg
            const spawnFfmpeg = (mustTranscode) => {
                let args = [
                    '-rtsp_transport', 'tcp',
                    '-re',
                    '-i', camera.url_rtsp
                ];

                if (mustTranscode) {
                    args.push(
                        '-c:v', 'libx264',
                        '-preset', 'veryfast',
                        '-tune', 'zerolatency',
                        '-pix_fmt', 'yuv420p',
                        '-g', '60',
                        '-r', '30'
                    );

                    if (quality !== 'source') {
                        args.push('-s', resolution);
                        args.push('-b:v', videoBitrate);
                        args.push('-maxrate', videoBitrate);
                        args.push('-bufsize', bufSize);
                    } else {
                        args.push('-b:v', '3500k', '-maxrate', '4000k', '-bufsize', '7000k');
                    }
                } else {
                    args.push('-c:v', 'copy');
                }

                args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'flv', rtmpUrl);

                writeLog(cameraId, `[SYSTEM] FFmpeg command: ${getFfmpegPath()} ${args.join(' ')}`);

                const process = spawn(getFfmpegPath(), args);

                activeStreams[cameraId] = {
                    status: 'starting',
                    process: process,
                    startedAt: new Date(),
                    restarts: 0
                };

                process.stderr.on('data', (data) => {
                    const msg = data.toString();
                    writeLog(cameraId, msg);
                    if (msg.includes('frame=')) {
                        if (activeStreams[cameraId] && activeStreams[cameraId].status !== 'running') {
                            activeStreams[cameraId].status = 'running';
                            writeLog(cameraId, `[SYSTEM] Stream is now LIVE`);
                        }
                    }
                });

                process.on('close', (code) => {
                    writeLog(cameraId, `[SYSTEM] FFmpeg exited with code ${code}`);
                    if (activeStreams[cameraId]) {
                        const stream = activeStreams[cameraId];
                        if (stream.status === 'running' && stream.restarts < 5) {
                            const delay = 5000;
                            stream.status = 'restarting';
                            stream.restarts++;
                            writeLog(cameraId, `[SYSTEM] Stream dropped unexpectedly. Restarting in ${delay/1000}s... (Attempt ${stream.restarts}/5)`);
                            setTimeout(() => {
                                if (activeStreams[cameraId]) {
                                    startStream(cameraId, streamKey, quality).catch(e => {
                                        writeLog(cameraId, `[ERR] Auto-restart failed: ${e.message}`);
                                    });
                                }
                            }, delay);
                        } else {
                            stream.status = 'error';
                        }
                    }
                });

                process.on('error', (err) => {
                    writeLog(cameraId, `[ERR] Failed to start FFmpeg: ${err.message}`);
                    if (activeStreams[cameraId]) {
                        activeStreams[cameraId].status = 'error';
                    }
                });
            };

            // Detect codec if needed
            if (quality === 'source') {
                // Short timeout for probe to keep UI responsive
                const ffprobe = spawn(getFfmpegPath().replace('ffmpeg', 'ffprobe'), [
                    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1', camera.url_rtsp
                ]);
                
                let out = '';
                let resolved = false;

                ffprobe.stdout.on('data', (d) => out += d.toString().trim());
                
                ffprobe.on('close', () => {
                    if (resolved) return;
                    resolved = true;
                    const codec = out.trim();
                    const mustTranscode = codec !== 'h264';
                    if (mustTranscode) writeLog(cameraId, `[SYSTEM] Codec ${codec || 'unknown'} detected. Transcoding...`);
                    else writeLog(cameraId, `[SYSTEM] H.264 detected. Using copy mode.`);
                    spawnFfmpeg(mustTranscode);
                });

                ffprobe.on('error', () => {
                    if (resolved) return;
                    resolved = true;
                    writeLog(cameraId, `[SYSTEM] Codec probe failed. Defaulting to transcode.`);
                    spawnFfmpeg(true);
                });

                // Resolve promise immediately to avoid proxy timeout
                setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        ffprobe.kill();
                        writeLog(cameraId, `[SYSTEM] Codec probe timeout. Defaulting to transcode.`);
                        spawnFfmpeg(true);
                    }
                }, 3000);

                resolve({ success: true, message: 'Stream starting (probing codec...)' });
            } else {
                spawnFfmpeg(true);
                resolve({ success: true, message: 'Stream starting' });
            }
        });
    });
}

function stopStream(cameraId) {
    const stream = activeStreams[cameraId];
    if (stream && stream.process) {
        writeLog(cameraId, `[SYSTEM] Stopping stream...`);
        stream.process.kill('SIGKILL');
        delete activeStreams[cameraId];
        return { success: true };
    }
    return { success: false, message: 'Stream not running' };
}

function stopAllStreams() {
    for (const id in activeStreams) {
        stopStream(id);
    }
    stopMasterSwitcher();
}

function getStatus() {
    const status = {};
    for (const id in activeStreams) {
        status[id] = {
            status: activeStreams[id].status,
            startedAt: activeStreams[id].startedAt
        };
    }
    return status;
}

// ==================== VIDEO OVERLAY ENGINE (RUNNING TEXT & LOGO) ====================
let overlayState = {
    enableText: true,
    runningText: "CCTV MONITORING LIVE STREAM - SEMUA AREA DALAM KONDISI AMAN DAN KONDUSIF",
    enableLogo: true,
    logoPosition: "top-right"
};

const runningTextFilePath = path.join(logDir, 'running_text.txt');
if (!fs.existsSync(runningTextFilePath)) {
    fs.writeFileSync(runningTextFilePath, overlayState.runningText, 'utf8');
} else {
    try {
        const textInFile = fs.readFileSync(runningTextFilePath, 'utf8').trim();
        if (textInFile) overlayState.runningText = textInFile;
    } catch (e) {}
}

function updateRunningText(newText) {
    overlayState.runningText = (newText || "CCTV MONITORING LIVE STREAM").trim();
    fs.writeFileSync(runningTextFilePath, overlayState.runningText, 'utf8');
    writeMasterLog(`[OVERLAY] Running text updated: "${overlayState.runningText}"`);
    return { success: true, runningText: overlayState.runningText };
}

function saveStreamLogo(base64Data) {
    try {
        const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(cleanBase64, 'base64');
        const logoDir = path.join(__dirname, 'public');
        if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });
        const logoPath = path.join(logoDir, 'stream_logo.png');
        fs.writeFileSync(logoPath, buffer);
        overlayState.enableLogo = true;
        writeMasterLog(`[OVERLAY] Logo stream berhasil di-upload.`);
        return { success: true, logoUrl: '/stream_logo.png' };
    } catch (e) {
        throw new Error('Gagal menyimpan logo: ' + e.message);
    }
}

function setOverlaySettings(enableText, enableLogo, logoPosition) {
    if (typeof enableText === 'boolean') overlayState.enableText = enableText;
    if (typeof enableLogo === 'boolean') overlayState.enableLogo = enableLogo;
    if (logoPosition) overlayState.logoPosition = logoPosition;
    writeMasterLog(`[OVERLAY] Settings updated: Text=${overlayState.enableText}, Logo=${overlayState.enableLogo}`);
    return { success: true, overlayState };
}

function getOverlaySettings() {
    const hasLogoFile = fs.existsSync(path.join(__dirname, 'public', 'stream_logo.png'));
    return {
        ...overlayState,
        hasLogoFile,
        logoUrl: hasLogoFile ? '/stream_logo.png' : null
    };
}

// ==================== MASTER SWITCHER ENGINE ====================
let masterState = {
    isRunning: false,
    status: 'stopped', // 'stopped', 'starting', 'running', 'error'
    platform: 'youtube', // 'youtube' | 'facebook' | 'tiktok' | 'dual' | 'dual_yt_tt' | 'dual_fb_tt' | 'multi_all'
    streamKey: '',
    facebookStreamKey: '',
    tiktokServerUrl: 'rtmp://push-rtmp-l1-sea.tiktokcdn.com/game/',
    tiktokStreamKey: '',
    quality: 'medium',
    mode: 'auto', // 'manual' | 'auto' | 'grid'
    gridLayout: 'auto', // 'auto' | '2x2' | '3x2' | '3x3'
    gridLabels: true,
    intervalSeconds: 15,
    currentCameraId: null,
    currentCameraName: '',
    startedAt: null,
    lastSwitchTime: null,
    masterProcess: null,
    feederProcess: null,
    tickerInterval: null,
    restarts: 0
};

function getMasterLogPath() {
    return path.join(logDir, 'youtube_master_switcher.log');
}

function writeMasterLog(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(getMasterLogPath(), logMessage);
}

function getMasterLogs() {
    const logPath = getMasterLogPath();
    if (!fs.existsSync(logPath)) return [];
    try {
        const content = fs.readFileSync(logPath, 'utf8');
        return content.split('\n').filter(line => line.trim() !== '').slice(-100);
    } catch (e) {
        return [`Error reading log: ${e.message}`];
    }
}

let relayServer = null;
let activeMasterClientSocket = null;

function setupMasterRelayServer() {
    if (relayServer) return;
    relayServer = net.createServer((socket) => {
        writeMasterLog('[MASTER RELAY] Master FFmpeg output process connected to local MPEG-TS relay.');
        activeMasterClientSocket = socket;
        socket.on('close', () => {
            writeMasterLog('[MASTER RELAY] Relay socket closed.');
            if (activeMasterClientSocket === socket) activeMasterClientSocket = null;
        });
        socket.on('error', (err) => {
            writeMasterLog(`[MASTER RELAY ERR] Socket error: ${err.message}`);
        });
    });

    relayServer.listen(1939, '127.0.0.1', () => {
        writeMasterLog('[MASTER RELAY] Local MPEG-TS Relay server listening on 127.0.0.1:1939');
    });
}

async function startFeederForCamera(cameraId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM cameras WHERE id = ?', [cameraId], (err, camera) => {
            if (err || !camera) {
                writeMasterLog(`[ERR] Camera ID ${cameraId} not found`);
                return reject(new Error('Camera not found'));
            }

            if (masterState.feederProcess) {
                try {
                    masterState.feederProcess.stdout.removeAllListeners('data');
                    masterState.feederProcess.kill('SIGKILL');
                } catch (e) {}
                masterState.feederProcess = null;
            }

            const cameraRtsp = camera.url_rtsp || `rtsp://127.0.0.1:${config.mediamtx?.rtsp_port || 8555}/cam_${cameraId}`;

            let videoBitrate = '2500k';
            let bufSize = '5000k';
            let resolution = '1280x720';
            let logoWidth = 180;

            if (masterState.quality === 'low') {
                videoBitrate = '1000k'; bufSize = '2000k'; resolution = '854x480'; logoWidth = 130;
            } else if (masterState.quality === 'high') {
                videoBitrate = '4000k'; bufSize = '8000k'; resolution = '1920x1080'; logoWidth = 240;
            }

            const logoFile = path.join(__dirname, 'public', 'stream_logo.png');
            const hasLogo = overlayState.enableLogo && fs.existsSync(logoFile);

            const args = [
                '-rtsp_transport', 'tcp',
                '-re',
                '-i', cameraRtsp
            ];

            if (hasLogo) {
                args.push('-i', logoFile);
            }

            args.push(
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-tune', 'zerolatency',
                '-pix_fmt', 'yuv420p',
                '-g', '60',
                '-keyint_min', '60',
                '-sc_threshold', '0',
                '-r', '30',
                '-s', resolution,
                '-b:v', videoBitrate,
                '-maxrate', videoBitrate,
                '-bufsize', bufSize
            );

            // Construct Filter Complex for Logo & Running Text
            let fontPathArg = '';
            if (process.platform === 'win32' && fs.existsSync('C:/Windows/Fonts/arial.ttf')) {
                fontPathArg = "fontfile='C\\:/Windows/Fonts/arial.ttf':";
            } else if (fs.existsSync('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')) {
                fontPathArg = "fontfile='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf':";
            }

            const drawTextFilter = `drawtext=${fontPathArg}textfile='stream_logs/running_text.txt':reload=1:fontcolor=white:fontsize=22:box=1:boxcolor=black@0.65:boxborderw=8:x=w-mod(t*90\\,w+tw):y=h-th-15`;

            let logoPos = 'W-w-20:20';
            if (overlayState.logoPosition === 'top-left') {
                logoPos = '20:20';
            } else if (overlayState.logoPosition === 'bottom-right') {
                logoPos = 'W-w-20:H-h-60';
            } else if (overlayState.logoPosition === 'bottom-left') {
                logoPos = '20:H-h-60';
            }

            if (hasLogo && overlayState.enableText) {
                args.push('-filter_complex', `[1:v]scale=${logoWidth}:-1[logoscaled];[0:v][logoscaled]overlay=${logoPos}[vlogo];[vlogo]${drawTextFilter}[outv]`, '-map', '[outv]', '-map', '0:a?');
            } else if (hasLogo) {
                args.push('-filter_complex', `[1:v]scale=${logoWidth}:-1[logoscaled];[0:v][logoscaled]overlay=${logoPos}[outv]`, '-map', '[outv]', '-map', '0:a?');
            } else if (overlayState.enableText) {
                args.push('-vf', drawTextFilter);
            }

            args.push(
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '44100',
                '-f', 'mpegts',
                'pipe:1'
            );

            writeMasterLog(`[SYSTEM] Starting feeder process for ${camera.nama} (#${camera.id})`);
            const feeder = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

            masterState.feederProcess = feeder;
            masterState.currentCameraId = camera.id;
            masterState.currentCameraName = camera.nama;
            masterState.lastSwitchTime = Date.now();

            feeder.stdout.on('data', (chunk) => {
                if (activeMasterClientSocket && !activeMasterClientSocket.destroyed) {
                    try { activeMasterClientSocket.write(chunk); } catch (e) {}
                }
            });

            feeder.stderr.on('data', (d) => {
                const msg = d.toString();
                if (msg.includes('Error') || msg.includes('Server returned') || msg.includes('Connection refused')) {
                    writeMasterLog(`[FEEDER ERR] ${msg.trim()}`);
                }
            });

            feeder.on('close', (code) => {
                writeMasterLog(`[FEEDER] Process exited with code ${code}`);
                if (masterState.isRunning && masterState.mode === 'auto' && masterState.feederProcess === feeder) {
                    setTimeout(() => {
                        if (masterState.isRunning && masterState.mode === 'auto') {
                            rotateToNextCamera();
                        }
                    }, 3000);
                }
            });

            feeder.on('error', (err) => {
                writeMasterLog(`[FEEDER ERR] Failed to spawn feeder: ${err.message}`);
            });

            resolve({ success: true, cameraId: camera.id, cameraName: camera.nama });
        });
    });
}

async function startFeederForGrid(gridLayout = 'auto', showLabels = true) {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM cameras ORDER BY id ASC', (err, cameras) => {
            if (err || !cameras || cameras.length === 0) {
                writeMasterLog('[ERR] Tidak ada kamera tersimpan untuk mode Grid');
                return reject(new Error('Tidak ada kamera tersimpan untuk mode Grid'));
            }

            if (masterState.feederProcess) {
                try {
                    masterState.feederProcess.stdout.removeAllListeners('data');
                    masterState.feederProcess.kill('SIGKILL');
                } catch (e) {}
                masterState.feederProcess = null;
            }

            const camCount = cameras.length;
            let targetCount = 4;
            let layout = '0_0|w0_0|0_h0|w0_h0';
            let cellW = 640;
            let cellH = 360;
            let videoBitrate = '3000k';
            let bufSize = '6000k';
            let logoWidth = 180;

            if (gridLayout === '3x3' || (gridLayout === 'auto' && camCount > 6)) {
                targetCount = 9;
                layout = '0_0|w0_0|w0+w1_0|0_h0|w0_h0|w0+w1_h0|0_h0+h3|w0_h0+h3|w0+w1_h0+h3';
                cellW = 640;
                cellH = 360;
                videoBitrate = '5000k';
                bufSize = '10000k';
                logoWidth = 240;
            } else if (gridLayout === '3x2' || (gridLayout === 'auto' && camCount > 4)) {
                targetCount = 6;
                layout = '0_0|w0_0|w0+w1_0|0_h0|w0_h0|w0+w1_h0';
                cellW = 640;
                cellH = 360;
                videoBitrate = '4000k';
                bufSize = '8000k';
                logoWidth = 220;
            } else {
                targetCount = 4;
                layout = '0_0|w0_0|0_h0|w0_h0';
                cellW = 640;
                cellH = 360;
                videoBitrate = '3000k';
                bufSize = '6000k';
                logoWidth = 180;
            }

            const logoFile = path.join(__dirname, 'public', 'stream_logo.png');
            const hasLogo = overlayState.enableLogo && fs.existsSync(logoFile);

            const args = [];
            const activeCamLimit = Math.min(camCount, targetCount);

            // Add camera inputs
            for (let i = 0; i < activeCamLimit; i++) {
                const c = cameras[i];
                const rtspUrl = c.url_rtsp || `rtsp://127.0.0.1:${config.mediamtx?.rtsp_port || 8555}/cam_${c.id}`;
                args.push('-rtsp_transport', 'tcp', '-re', '-i', rtspUrl);
            }

            // Add synthetic placeholders for remaining slots
            for (let i = activeCamLimit; i < targetCount; i++) {
                args.push('-f', 'lavfi', '-re', '-i', `color=c=0x0f172a:s=${cellW}x${cellH}:r=30`);
            }

            // Silent Audio input
            args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
            const audioInputIdx = targetCount;

            // Logo input (if present)
            let logoInputIdx = null;
            if (hasLogo) {
                args.push('-i', logoFile);
                logoInputIdx = targetCount + 1;
            }

            // Build filter complex
            let fontPathArg = '';
            if (process.platform === 'win32' && fs.existsSync('C:/Windows/Fonts/arial.ttf')) {
                fontPathArg = "fontfile='C\\:/Windows/Fonts/arial.ttf':";
            } else if (fs.existsSync('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')) {
                fontPathArg = "fontfile='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf':";
            }

            const filterParts = [];
            const xstackInputs = [];

            for (let i = 0; i < targetCount; i++) {
                xstackInputs.push(`[v${i}]`);
                if (i < activeCamLimit) {
                    const c = cameras[i];
                    const cleanName = (c.nama || `Cam #${c.id}`).replace(/[':\\]/g, ' ');
                    if (showLabels) {
                        filterParts.push(`[${i}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:black,drawtext=${fontPathArg}text='${cleanName}':fontcolor=white:fontsize=16:box=1:boxcolor=black@0.6:boxborderw=6:x=12:y=12[v${i}]`);
                    } else {
                        filterParts.push(`[${i}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:black[v${i}]`);
                    }
                } else {
                    filterParts.push(`[${i}:v]drawtext=${fontPathArg}text='CCTV MONITORING':fontcolor=gray:fontsize=16:x=(w-text_w)/2:y=(h-text_h)/2[v${i}]`);
                }
            }

            // Combine into xstack
            filterParts.push(`${xstackInputs.join('')}xstack=inputs=${targetCount}:layout=${layout}[vgridraw]`);

            let lastVideoTag = '[vgridraw]';
            if (targetCount === 6) {
                filterParts.push(`[vgridraw]pad=1920:1080:0:(1080-720)/2:black[vgrid]`);
                lastVideoTag = '[vgrid]';
            }

            let logoPos = 'W-w-20:20';
            if (overlayState.logoPosition === 'top-left') {
                logoPos = '20:20';
            } else if (overlayState.logoPosition === 'bottom-right') {
                logoPos = 'W-w-20:H-h-60';
            } else if (overlayState.logoPosition === 'bottom-left') {
                logoPos = '20:H-h-60';
            }

            if (hasLogo) {
                filterParts.push(`[${logoInputIdx}:v]scale=${logoWidth}:-1[logoscaled]`);
                filterParts.push(`${lastVideoTag}[logoscaled]overlay=${logoPos}[vlogo]`);
                lastVideoTag = '[vlogo]';
            }

            const drawTextFilter = `drawtext=${fontPathArg}textfile='stream_logs/running_text.txt':reload=1:fontcolor=white:fontsize=22:box=1:boxcolor=black@0.65:boxborderw=8:x=w-mod(t*90\\,w+tw):y=h-th-15`;

            if (overlayState.enableText) {
                filterParts.push(`${lastVideoTag}${drawTextFilter}[outv]`);
            } else {
                filterParts.push(`${lastVideoTag}null[outv]`);
            }

            args.push(
                '-filter_complex', filterParts.join(';'),
                '-map', '[outv]',
                '-map', `${audioInputIdx}:a`,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-tune', 'zerolatency',
                '-pix_fmt', 'yuv420p',
                '-g', '60',
                '-keyint_min', '60',
                '-sc_threshold', '0',
                '-r', '30',
                '-b:v', videoBitrate,
                '-maxrate', videoBitrate,
                '-bufsize', bufSize,
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '44100',
                '-f', 'mpegts',
                'pipe:1'
            );

            writeMasterLog(`[SYSTEM] Starting Multi-Camera Grid feeder (${activeCamLimit} cameras, Layout: ${gridLayout || 'auto'})`);
            const feeder = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

            masterState.feederProcess = feeder;
            masterState.currentCameraId = null;
            masterState.currentCameraName = `Multi-Camera Grid (${activeCamLimit} Kamera)`;
            masterState.lastSwitchTime = Date.now();

            feeder.stdout.on('data', (chunk) => {
                if (activeMasterClientSocket && !activeMasterClientSocket.destroyed) {
                    try { activeMasterClientSocket.write(chunk); } catch (e) {}
                }
            });

            feeder.stderr.on('data', (d) => {
                const msg = d.toString();
                if (msg.includes('Error') || msg.includes('Server returned') || msg.includes('Connection refused')) {
                    writeMasterLog(`[GRID FEEDER ERR] ${msg.trim()}`);
                }
            });

            feeder.on('close', (code) => {
                writeMasterLog(`[GRID FEEDER] Process exited with code ${code}`);
            });

            feeder.on('error', (err) => {
                writeMasterLog(`[GRID FEEDER ERR] Failed to spawn grid feeder: ${err.message}`);
            });

            resolve({ success: true, mode: 'grid', count: activeCamLimit });
        });
    });
}

function buildTargetUrl(serverUrl, streamKey) {
    const cleanKey = (streamKey || '').trim();
    if (!cleanKey) return '';
    if (cleanKey.startsWith('rtmp://') || cleanKey.startsWith('rtmps://')) return cleanKey;
    const cleanServer = (serverUrl || '').trim();
    if (!cleanServer) return cleanKey;
    return cleanServer.endsWith('/') ? `${cleanServer}${cleanKey}` : `${cleanServer}/${cleanKey}`;
}

async function startMasterOutputProcess(streamKey = '', facebookStreamKey = '', tiktokServerUrl = '', tiktokStreamKey = '', platform = 'youtube') {
    setupMasterRelayServer();

    if (masterState.masterProcess) {
        try { masterState.masterProcess.kill('SIGKILL'); } catch (e) {}
        masterState.masterProcess = null;
    }

    const cleanYtKey = (streamKey || '').trim();
    const cleanFbKey = (facebookStreamKey || '').trim();

    const targetYtUrl = cleanYtKey ? `rtmp://a.rtmp.youtube.com/live2/${cleanYtKey}` : '';
    const targetFbUrl = cleanFbKey ? `rtmps://live-api-s.facebook.com:443/rtmp/${cleanFbKey}` : '';
    const targetTiktokUrl = buildTargetUrl(tiktokServerUrl || 'rtmp://push-rtmp-l1-sea.tiktokcdn.com/game/', tiktokStreamKey);

    const activeTargets = [];

    if (platform === 'youtube' && targetYtUrl) {
        activeTargets.push({ name: 'YouTube Live', url: targetYtUrl });
    } else if (platform === 'facebook' && targetFbUrl) {
        activeTargets.push({ name: 'Facebook Live', url: targetFbUrl });
    } else if (platform === 'tiktok' && targetTiktokUrl) {
        activeTargets.push({ name: 'TikTok Live', url: targetTiktokUrl });
    } else if (platform === 'dual' || platform === 'dual_yt_fb') {
        if (targetYtUrl) activeTargets.push({ name: 'YouTube Live', url: targetYtUrl });
        if (targetFbUrl) activeTargets.push({ name: 'Facebook Live', url: targetFbUrl });
    } else if (platform === 'dual_yt_tt') {
        if (targetYtUrl) activeTargets.push({ name: 'YouTube Live', url: targetYtUrl });
        if (targetTiktokUrl) activeTargets.push({ name: 'TikTok Live', url: targetTiktokUrl });
    } else if (platform === 'dual_fb_tt') {
        if (targetFbUrl) activeTargets.push({ name: 'Facebook Live', url: targetFbUrl });
        if (targetTiktokUrl) activeTargets.push({ name: 'TikTok Live', url: targetTiktokUrl });
    } else if (platform === 'multi_all') {
        if (targetYtUrl) activeTargets.push({ name: 'YouTube Live', url: targetYtUrl });
        if (targetFbUrl) activeTargets.push({ name: 'Facebook Live', url: targetFbUrl });
        if (targetTiktokUrl) activeTargets.push({ name: 'TikTok Live', url: targetTiktokUrl });
    } else {
        if (targetYtUrl) activeTargets.push({ name: 'YouTube Live', url: targetYtUrl });
        if (targetFbUrl) activeTargets.push({ name: 'Facebook Live', url: targetFbUrl });
        if (targetTiktokUrl) activeTargets.push({ name: 'TikTok Live', url: targetTiktokUrl });
    }

    if (activeTargets.length === 0) {
        writeMasterLog('[MASTER ERR] Tidak ada target streaming yang aktif atau Stream Key kosong');
        masterState.status = 'error';
        return;
    }

    let destinationLog = '';
    let outputArgs = [];

    if (activeTargets.length === 1) {
        destinationLog = activeTargets[0].name;
        outputArgs = [
            '-c:v', 'copy',
            '-c:a', 'copy',
            '-f', 'flv',
            activeTargets[0].url
        ];
    } else {
        destinationLog = activeTargets.map(t => t.name).join(' & ');
        const teeOutputs = activeTargets.map(t => `[f=flv:onfail=ignore]${t.url}`).join('|');
        outputArgs = [
            '-c:v', 'copy',
            '-c:a', 'copy',
            '-flags', '+global_header',
            '-f', 'tee',
            '-map', '0:v',
            '-map', '0:a?',
            teeOutputs
        ];
    }

    writeMasterLog(`[SYSTEM] Starting Master Output process to ${destinationLog} (Seamless TCP Relay)`);

    const args = [
        '-re',
        '-f', 'mpegts',
        '-i', 'tcp://127.0.0.1:1939',
        ...outputArgs
    ];

    const proc = spawn(getFfmpegPath(), args);
    masterState.masterProcess = proc;
    masterState.status = 'starting';

    proc.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('frame=')) {
            if (masterState.status !== 'running') {
                masterState.status = 'running';
                writeMasterLog(`[SYSTEM] Master Switcher is LIVE on ${destinationLog}!`);
            }
        } else if (msg.includes('Error') || msg.includes('Connection refused')) {
            writeMasterLog(`[MASTER ERR] ${msg.trim()}`);
        }
    });

    proc.on('close', (code) => {
        writeMasterLog(`[SYSTEM] Master Output process exited with code ${code}`);
        if (masterState.isRunning && masterState.restarts < 5) {
            masterState.restarts++;
            writeMasterLog(`[SYSTEM] Master output dropped. Restarting output process... (Attempt ${masterState.restarts}/5)`);
            setTimeout(() => {
                if (masterState.isRunning) {
                    startMasterOutputProcess(masterState.streamKey, masterState.facebookStreamKey, masterState.tiktokServerUrl, masterState.tiktokStreamKey, masterState.platform);
                }
            }, 3000);
        } else if (!masterState.isRunning) {
            masterState.status = 'stopped';
        } else {
            masterState.status = 'error';
        }
    });

    proc.on('error', (err) => {
        writeMasterLog(`[MASTER ERR] Failed to start master output: ${err.message}`);
        masterState.status = 'error';
    });
}

function rotateToNextCamera() {
    db.all('SELECT * FROM cameras ORDER BY id ASC', async (err, cameras) => {
        if (err || !cameras || cameras.length === 0) return;

        let nextCam = cameras[0];
        if (masterState.currentCameraId) {
            const currentIndex = cameras.findIndex(c => c.id === masterState.currentCameraId);
            if (currentIndex !== -1 && currentIndex < cameras.length - 1) {
                nextCam = cameras[currentIndex + 1];
            } else {
                nextCam = cameras[0];
            }
        }

        try {
            await startFeederForCamera(nextCam.id);
            writeMasterLog(`[AUTO-ROTATE] Rotated to Camera #${nextCam.id} (${nextCam.nama})`);
        } catch (e) {
            writeMasterLog(`[AUTO-ROTATE ERR] Failed to rotate: ${e.message}`);
        }
    });
}

function startMasterTicker() {
    if (masterState.tickerInterval) clearInterval(masterState.tickerInterval);
    masterState.tickerInterval = setInterval(() => {
        if (!masterState.isRunning || masterState.mode !== 'auto') return;

        const elapsed = (Date.now() - (masterState.lastSwitchTime || Date.now())) / 1000;
        if (elapsed >= masterState.intervalSeconds) {
            rotateToNextCamera();
        }
    }, 1000);
}

async function startMasterSwitcher(streamKey = '', facebookStreamKey = '', tiktokServerUrl = '', tiktokStreamKey = '', platform = 'youtube', quality = 'medium', mode = 'auto', intervalSeconds = 15, initialCameraId = null, gridLayout = 'auto', gridLabels = true) {
    if (streamKey && streamKey.includes('/live2/')) {
        streamKey = streamKey.split('/live2/').pop();
    }
    if (streamKey) streamKey = streamKey.trim().replace(/\/$/, '');

    if (facebookStreamKey && facebookStreamKey.includes('/rtmp/')) {
        facebookStreamKey = facebookStreamKey.split('/rtmp/').pop();
    }
    if (facebookStreamKey) facebookStreamKey = facebookStreamKey.trim().replace(/\/$/, '');

    if (tiktokStreamKey) tiktokStreamKey = tiktokStreamKey.trim();
    if (tiktokServerUrl) tiktokServerUrl = tiktokServerUrl.trim();

    if (platform === 'youtube' && !streamKey) {
        throw new Error('Stream Key YouTube wajib diisi untuk siaran YouTube Live');
    }
    if (platform === 'facebook' && !facebookStreamKey) {
        throw new Error('Stream Key Facebook wajib diisi untuk siaran Facebook Live');
    }
    if (platform === 'tiktok' && !tiktokStreamKey) {
        throw new Error('Stream Key TikTok wajib diisi untuk siaran TikTok Live');
    }
    if ((platform === 'dual' || platform === 'dual_yt_fb') && (!streamKey || !facebookStreamKey)) {
        throw new Error('Stream Key YouTube dan Facebook keduanya wajib diisi untuk mode Dual Stream (YT + FB)');
    }
    if (platform === 'dual_yt_tt' && (!streamKey || !tiktokStreamKey)) {
        throw new Error('Stream Key YouTube dan TikTok keduanya wajib diisi untuk mode Dual Stream (YT + TikTok)');
    }
    if (platform === 'dual_fb_tt' && (!facebookStreamKey || !tiktokStreamKey)) {
        throw new Error('Stream Key Facebook dan TikTok keduanya wajib diisi untuk mode Dual Stream (FB + TikTok)');
    }
    if (platform === 'multi_all' && (!streamKey || !facebookStreamKey || !tiktokStreamKey)) {
        throw new Error('Stream Key YouTube, Facebook, dan TikTok ketiganya wajib diisi untuk mode Multi-Stream All');
    }

    if (fs.existsSync(getMasterLogPath())) {
        fs.writeFileSync(getMasterLogPath(), '');
    }

    writeMasterLog(`[SYSTEM] Starting Master CCTV Switcher (Platform: ${platform.toUpperCase()}, Mode: ${mode}, Quality: ${quality}, Interval: ${intervalSeconds}s)`);

    masterState.isRunning = true;
    masterState.platform = platform || 'youtube';
    masterState.streamKey = streamKey;
    masterState.facebookStreamKey = facebookStreamKey;
    masterState.tiktokServerUrl = tiktokServerUrl || 'rtmp://push-rtmp-l1-sea.tiktokcdn.com/game/';
    masterState.tiktokStreamKey = tiktokStreamKey;
    masterState.quality = quality;
    masterState.mode = mode;
    masterState.gridLayout = gridLayout || 'auto';
    masterState.gridLabels = typeof gridLabels === 'boolean' ? gridLabels : true;
    masterState.intervalSeconds = parseInt(intervalSeconds, 10) || 15;
    masterState.startedAt = new Date();
    masterState.restarts = 0;

    const cameras = await new Promise((res) => db.all('SELECT * FROM cameras ORDER BY id ASC', (err, rows) => res(rows || [])));
    if (cameras.length === 0) {
        throw new Error('Tidak ada kamera tersimpan di sistem');
    }

    if (masterState.mode === 'grid') {
        await startFeederForGrid(masterState.gridLayout, masterState.gridLabels);
    } else {
        let targetCamId = initialCameraId ? parseInt(initialCameraId, 10) : cameras[0].id;
        await startFeederForCamera(targetCamId);
        if (masterState.mode === 'auto') {
            startMasterTicker();
        }
    }

    startMasterOutputProcess(streamKey, facebookStreamKey, masterState.tiktokServerUrl, tiktokStreamKey, masterState.platform);

    return {
        success: true,
        message: `Master CCTV Switcher (${masterState.platform.toUpperCase()} - ${masterState.mode.toUpperCase()}) berhasil dijalankan!`,
        platform: masterState.platform,
        currentCameraId: masterState.currentCameraId,
        currentCameraName: masterState.currentCameraName,
        mode: masterState.mode
    };
}

function stopMasterSwitcher() {
    masterState.isRunning = false;
    masterState.status = 'stopped';

    if (masterState.tickerInterval) {
        clearInterval(masterState.tickerInterval);
        masterState.tickerInterval = null;
    }

    if (masterState.feederProcess) {
        try { masterState.feederProcess.kill('SIGKILL'); } catch (e) {}
        masterState.feederProcess = null;
    }

    if (masterState.masterProcess) {
        try { masterState.masterProcess.kill('SIGKILL'); } catch (e) {}
        masterState.masterProcess = null;
    }

    writeMasterLog(`[SYSTEM] Master CCTV Switcher dihentikan.`);
    return { success: true, message: 'Master Switcher dihentikan.' };
}

async function switchMasterCamera(cameraId) {
    if (!masterState.isRunning) {
        throw new Error('Master Switcher sedang tidak berjalan');
    }
    masterState.mode = 'manual';
    if (masterState.tickerInterval) {
        clearInterval(masterState.tickerInterval);
        masterState.tickerInterval = null;
    }
    const res = await startFeederForCamera(parseInt(cameraId, 10));
    masterState.lastSwitchTime = Date.now();
    writeMasterLog(`[MANUAL SWITCH] Switched to Camera #${cameraId} (${res.cameraName})`);
    return res;
}

async function setMasterSwitcherMode(mode, intervalSeconds, gridLayout, gridLabels) {
    const oldMode = masterState.mode;
    if (mode) masterState.mode = mode;
    if (intervalSeconds) masterState.intervalSeconds = parseInt(intervalSeconds, 10) || 15;
    if (gridLayout) masterState.gridLayout = gridLayout;
    if (typeof gridLabels === 'boolean') masterState.gridLabels = gridLabels;

    masterState.lastSwitchTime = Date.now();
    writeMasterLog(`[SYSTEM] Mode switcher diubah: Mode=${masterState.mode}, Interval=${masterState.intervalSeconds}s, GridLayout=${masterState.gridLayout}`);

    if (masterState.isRunning) {
        if (masterState.mode === 'grid') {
            if (masterState.tickerInterval) {
                clearInterval(masterState.tickerInterval);
                masterState.tickerInterval = null;
            }
            await startFeederForGrid(masterState.gridLayout, masterState.gridLabels);
        } else if (oldMode === 'grid') {
            const cameras = await new Promise((res) => db.all('SELECT * FROM cameras ORDER BY id ASC', (err, rows) => res(rows || [])));
            if (cameras.length > 0) {
                await startFeederForCamera(cameras[0].id);
            }
            if (masterState.mode === 'auto') startMasterTicker();
        } else if (masterState.mode === 'auto') {
            startMasterTicker();
        } else if (masterState.mode === 'manual' && masterState.tickerInterval) {
            clearInterval(masterState.tickerInterval);
            masterState.tickerInterval = null;
        }
    }

    return {
        success: true,
        mode: masterState.mode,
        intervalSeconds: masterState.intervalSeconds,
        gridLayout: masterState.gridLayout,
        gridLabels: masterState.gridLabels
    };
}

function getMasterSwitcherStatus() {
    let nextSwitchInSeconds = 0;
    if (masterState.isRunning && masterState.mode === 'auto' && masterState.lastSwitchTime) {
        const elapsed = (Date.now() - masterState.lastSwitchTime) / 1000;
        nextSwitchInSeconds = Math.max(0, Math.ceil(masterState.intervalSeconds - elapsed));
    }

    return {
        isRunning: masterState.isRunning,
        status: masterState.status,
        platform: masterState.platform || 'youtube',
        streamKey: masterState.streamKey || '',
        facebookStreamKey: masterState.facebookStreamKey || '',
        tiktokServerUrl: masterState.tiktokServerUrl || 'rtmp://push-rtmp-l1-sea.tiktokcdn.com/game/',
        tiktokStreamKey: masterState.tiktokStreamKey || '',
        mode: masterState.mode,
        gridLayout: masterState.gridLayout || 'auto',
        gridLabels: masterState.gridLabels !== false,
        intervalSeconds: masterState.intervalSeconds,
        currentCameraId: masterState.currentCameraId,
        currentCameraName: masterState.currentCameraName,
        nextSwitchInSeconds,
        startedAt: masterState.startedAt,
        quality: masterState.quality
    };
}

module.exports = {
    checkFfmpeg,
    startStream,
    stopStream,
    stopAllStreams,
    getStatus,
    getLogs,
    startMasterSwitcher,
    stopMasterSwitcher,
    switchMasterCamera,
    setMasterSwitcherMode,
    startFeederForGrid,
    getMasterSwitcherStatus,
    getMasterLogs,
    updateRunningText,
    saveStreamLogo,
    setOverlaySettings,
    getOverlaySettings
};
