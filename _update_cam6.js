const sqlite3 = require('sqlite3');
const http = require('http');

const newUrl = 'rtsp://alijaya:060111@192.168.8.8:554/V_ENC_001';
const db = new sqlite3.Database('./cameras.db');

db.run("UPDATE cameras SET url_rtsp = ? WHERE id = 6", [newUrl], function(err) {
    if (err) {
        console.error("DB Update Error:", err);
        db.close();
        return;
    }
    console.log("Camera 6 RTSP URL updated to:", newUrl);
    console.log("Rows changed:", this.changes);
    db.close();

    function mediamtxReq(method, urlPath, body) {
        return new Promise((resolve) => {
            const data = body ? JSON.stringify(body) : '';
            const opts = {
                hostname: '127.0.0.1',
                port: 9123,
                path: urlPath,
                method: method,
                headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
            };
            const req = http.request(opts, (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    console.log(`  ${method} ${urlPath} => ${res.statusCode}`);
                    resolve(res.statusCode);
                });
            });
            req.on('error', e => { console.error(`  Error: ${e.message}`); resolve(0); });
            if (data) req.write(data);
            req.end();
        });
    }

    (async () => {
        console.log("\nRe-registering camera 6 with MediaMTX...");
        await mediamtxReq('DELETE', '/v3/config/paths/delete/cam_6_input');
        await mediamtxReq('DELETE', '/v3/config/paths/delete/cam_6');
        await mediamtxReq('POST', '/v3/config/paths/add/cam_6_input', {
            source: newUrl
        });
        console.log("\nDone! Waiting 8s for MediaMTX to connect...");

        setTimeout(async () => {
            http.get('http://127.0.0.1:9123/v3/paths/list', (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    const parsed = JSON.parse(d);
                    console.log("\n=== Path Status ===");
                    (parsed.items || []).forEach(item => {
                        console.log(`${item.name}: ready=${item.ready}, tracks=${JSON.stringify(item.tracks || [])}`);
                    });
                });
            }).on('error', e => console.error(e.message));
        }, 8000);
    })();
});
