const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
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
