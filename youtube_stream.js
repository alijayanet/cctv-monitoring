const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const db = require('./database');
const config = require('./config.json');
const { getEffectiveMediaMtxHost } = require('./utils/helpers');

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
    if (ffmpegStaticPath) pathsToTest.push(ffmpegStaticPath);
    pathsToTest.push('ffmpeg');
    pathsToTest.push('/usr/bin/ffmpeg'); // Common Ubuntu path

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

function buildYouTubeTargets(streamKey) {
    const key = String(streamKey || '').trim();
    const live2Path = `/live2/${key}`;
    const targets = [
        `rtmp://a.rtmp.youtube.com${live2Path}`,
        `rtmp://b.rtmp.youtube.com${live2Path}`,
        `rtmp://rtmp.youtube.com${live2Path}`,
        `rtmps://a.rtmps.youtube.com${live2Path}`,
        `rtmps://b.rtmps.youtube.com${live2Path}`
    ];
    return targets.filter((v, i, a) => a.indexOf(v) === i);
}

async function ensureYoutubeDnsResolvable(targets) {
    const hosts = targets
        .map((t) => {
            try {
                return new URL(t).hostname;
            } catch (e) {
                return '';
            }
        })
        .filter((h, i, a) => h && a.indexOf(h) === i);

    if (hosts.length === 0) return;

    let lastError = null;
    for (const host of hosts) {
        try {
            await dns.lookup(host);
            return;
        } catch (e) {
            lastError = e;
        }
    }

    const hint = lastError && lastError.code ? `${lastError.code}` : 'DNS_ERROR';
    throw new Error(`DNS server tidak bisa resolve domain YouTube (${hosts.join(', ')}). (${hint})`);
}

async function startStream(cameraId, streamKey, quality = 'medium') {
    // Sanitize streamKey: remove RTMP URL if user accidentally pasted it
    if (streamKey && streamKey.includes('/live2/')) {
        streamKey = streamKey.split('/live2/').pop();
    }
    // Remove any trailing slashes or spaces
    streamKey = streamKey.trim().replace(/\/$/, '');

    const targets = buildYouTubeTargets(streamKey);
    const existing = activeStreams[cameraId];
    const preserve = {
        restarts: existing?.restarts || 0,
        targetIndex: existing?.targetIndex || 0
    };

    if (existing) {
        if (existing.status === 'running') {
            throw new Error('Stream is already running for this camera');
        }
        if (existing.process && !existing.process.killed) {
            try { existing.process.kill('SIGKILL'); } catch (e) { }
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
            const mediaMtxHost = getEffectiveMediaMtxHost(config);
            const mediaMtxRtspUrl = `rtsp://${mediaMtxHost}:${rtspPort}/cam_${cameraId}_input`;
            const inputUrl = mediaMtxHost ? mediaMtxRtspUrl : camera.url_rtsp;

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

            const startTargetIndex = Math.min(Math.max(0, preserve.targetIndex), Math.max(0, targets.length - 1));
            const outputUrl = targets[startTargetIndex] || `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;

            try {
                await ensureYoutubeDnsResolvable(targets.length ? targets : [outputUrl]);
            } catch (e) {
                writeLog(cameraId, `[ERR] ${e.message}`);
                return reject(e);
            }
            
            // Function to spawn FFmpeg
            const spawnFfmpeg = (mustTranscode, targetUrl, meta) => {
                const nextMeta = meta || { restarts: 0, targetIndex: 0 };
                
                // Fallback ke direct RTSP kamera jika koneksi local MediaMTX gagal/restart
                let currentInputUrl = inputUrl;
                if (nextMeta.restarts > 0 && camera.url_rtsp) {
                    currentInputUrl = camera.url_rtsp;
                }

                let args = [
                    '-rtsp_transport', 'tcp',
                    '-i', currentInputUrl
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

                args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'flv', targetUrl);

                // Sanitize command log for privacy
                const sanitizedInputUrl = currentInputUrl.replace(/:[^:@/]+@/g, ':***@');
                const sanitizedArgs = args.map(arg => arg === currentInputUrl ? sanitizedInputUrl : arg);
                
                writeLog(cameraId, `[SYSTEM] FFmpeg command: ${getFfmpegPath()} ${sanitizedArgs.join(' ')}`);
                writeLog(cameraId, `[SYSTEM] Input RTSP: ${sanitizedInputUrl}`);
                writeLog(cameraId, `[SYSTEM] Output RTMP: ${targetUrl}`);

                const process = spawn(getFfmpegPath(), args);

                activeStreams[cameraId] = {
                    status: 'starting',
                    process: process,
                    startedAt: new Date(),
                    restarts: nextMeta.restarts,
                    targetIndex: nextMeta.targetIndex,
                    targetsCount: targets.length,
                    mustTranscode: !!mustTranscode,
                    streamKey: streamKey,
                    quality: quality,
                    inputUrl: inputUrl,
                    outputUrl: targetUrl
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
                        if (stream.restarts < 5) {
                            const delay = 5000;
                            stream.status = 'restarting';
                            stream.restarts++;
                            const nextIndex = targets.length ? ((stream.targetIndex + 1) % targets.length) : 0;
                            stream.targetIndex = nextIndex;
                            const nextUrl = targets[nextIndex] || stream.outputUrl;
                            writeLog(cameraId, `[SYSTEM] Restarting in ${delay/1000}s... (Attempt ${stream.restarts}/5)`);
                            setTimeout(() => {
                                if (!activeStreams[cameraId]) return;
                                spawnFfmpeg(stream.mustTranscode, nextUrl, { restarts: stream.restarts, targetIndex: nextIndex });
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
                    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1', inputUrl
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
                    spawnFfmpeg(mustTranscode, outputUrl, { restarts: preserve.restarts, targetIndex: startTargetIndex });
                });

                ffprobe.on('error', () => {
                    if (resolved) return;
                    resolved = true;
                    writeLog(cameraId, `[SYSTEM] Codec probe failed. Defaulting to transcode.`);
                    spawnFfmpeg(true, outputUrl, { restarts: preserve.restarts, targetIndex: startTargetIndex });
                });

                // Resolve promise immediately to avoid proxy timeout
                setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        ffprobe.kill();
                        writeLog(cameraId, `[SYSTEM] Codec probe timeout. Defaulting to transcode.`);
                        spawnFfmpeg(true, outputUrl, { restarts: preserve.restarts, targetIndex: startTargetIndex });
                    }
                }, 3000);

                resolve({ success: true, message: 'Stream starting (probing codec...)' });
            } else {
                spawnFfmpeg(true, outputUrl, { restarts: preserve.restarts, targetIndex: startTargetIndex });
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

module.exports = {
    checkFfmpeg,
    startStream,
    stopStream,
    stopAllStreams,
    getStatus,
    getLogs
};
