// Helper functions extracted from index.js
const http = require('http');
const https = require('https');

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

function getEffectiveMediaMtxHost(config) {
    const rawHost = config.mediamtx?.host || '127.0.0.1';
    if (rawHost === 'auto') {
        return '127.0.0.1';
    }
    return normalizeHostValue(rawHost) || '127.0.0.1';
}

function getHlsBaseUrl(req, config) {
    // Route HLS through the Express app itself (same-origin proxy).
    // This avoids CORS, mixed-content blocks, and the need for a
    // separate Cloudflare tunnel on the MediaMTX HLS port.
    if (req && req.headers.host) {
        const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
        return `${proto}://${req.headers.host}`;
    }
    const serverPort = config.server?.port || 3003;
    return `http://127.0.0.1:${serverPort}`;
}

function getHlsHealthCheckBases(config) {
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
                timeout: 3000
            },
            (res) => {
                resolve(res.statusCode >= 200 && res.statusCode < 400);
            }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.end();
    });
}

function formatDateJakarta(date) {
    const d = date instanceof Date ? date : new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function getClientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
    if (Array.isArray(xf) && xf.length > 0) return String(xf[0] || '').trim();
    return (req.ip || req.connection?.remoteAddress || '').toString();
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

module.exports = {
    normalizeHostValue,
    getEffectiveMediaMtxHost,
    getHlsBaseUrl,
    getHlsHealthCheckBases,
    checkHlsUrl,
    formatDateJakarta,
    getClientIp,
    isRunningUnderSystemd,
    restartLinuxServices
};

// Made with Bob
