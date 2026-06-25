const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'cameras.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
        return;
    }
    
    console.log('Connected to database. Checking cameras...\n');
    
    db.all("SELECT id, nama, lokasi, url_rtsp, lat, lng, ptz_enabled, onvif_port FROM cameras ORDER BY id", (err, rows) => {
        if (err) {
            console.error('Error querying cameras:', err.message);
            return;
        }
        
        if (rows.length === 0) {
            console.log('Tidak ada kamera yang terdaftar di database.');
            return;
        }
        
        console.log(`Ditemukan ${rows.length} kamera:\n`);
        
        rows.forEach((camera, index) => {
            console.log(`=== Kamera ${index + 1} ===`);
            console.log(`ID: ${camera.id}`);
            console.log(`Nama: ${camera.nama}`);
            console.log(`Lokasi: ${camera.lokasi || 'Tidak ada lokasi'}`);
            console.log(`URL RTSP: ${camera.url_rtsp}`);
            console.log(`Koordinat: ${camera.lat || 'N/A'}, ${camera.lng || 'N/A'}`);
            console.log(`PTZ Enabled: ${camera.ptz_enabled ? 'Ya' : 'Tidak'}`);
            console.log(`ONVIF Port: ${camera.onvif_port || 'N/A'}`);
            
            // Validasi format URL RTSP
            const rtspPattern = /^rtsp:\/\/.+/;
            if (!rtspPattern.test(camera.url_rtsp)) {
                console.log(`⚠️  PERINGATAN: Format URL RTSP tidak valid!`);
            }
            
            console.log('');
        });
        
        db.close();
    });
});