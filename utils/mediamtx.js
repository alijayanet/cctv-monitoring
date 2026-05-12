// MediaMTX API interaction utilities
const http = require('http');

const mediaMtxState = {
    isAvailable: true,
    lastAvailabilityCheckAt: 0,
    unreachableUntil: 0
};

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
            mediaMtxState.unreachableUntil = now + 10000;
            resolve({ error: true, message: msg });
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function mediaMtxRequest(method, path, body = null, config) {
    const now = Date.now();
    if (!mediaMtxState.isAvailable && now < mediaMtxState.unreachableUntil) {
        return { error: true, message: 'MediaMTX temporarily unavailable' };
    }
    const hostname = config.mediamtx?.host || '127.0.0.1';
    const port = config.mediamtx?.api_port || 9123;
    return mediaMtxRequestInternal(hostname, port, method, path, body);
}

async function ensureMediaMtxAvailable(config) {
    const result = await mediaMtxRequest('GET', '/list', null, config);
    return !result.error;
}

function getMediaMtxState() {
    return mediaMtxState;
}

module.exports = {
    mediaMtxRequest,
    ensureMediaMtxAvailable,
    getMediaMtxState,
    mediaMtxRequestInternal
};

// Made with Bob
