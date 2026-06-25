const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

let botStatus = {
    connected: false,
    qr: null,
    user: null
};

let _config = null;
let _db = null;

const lidMapPath = path.join(__dirname, 'whatsapp_lid_map.json');
let lidStore = new Map();
let currentSock = null;
let authLidReverse = new Map();

function normalizePhoneId(input) {
    if (!input) return null;
    let s = String(input);
    if (s.includes('@')) s = s.split('@')[0];
    let digits = s.replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length > 15) return null;
    if (digits.startsWith('0')) digits = '62' + digits.slice(1);
    else if (digits.startsWith('8')) digits = '62' + digits;
    return digits;
}

function normalizePnJidToDigits(jid) {
    if (!jid || typeof jid !== 'string') return null;
    const [user, host] = jid.split('@');
    if (!user || !host) return null;
    if (host !== 's.whatsapp.net') return null;
    return normalizePhoneId(user);
}

function getJakartaHourIndex() {
    try {
        const hourPart = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', hour: 'numeric', hour12: false }).format(new Date());
        const h = parseInt(hourPart, 10);
        if (Number.isFinite(h) && h >= 0 && h <= 23) return h;
    } catch (e) { }
    return new Date().getHours();
}

function degToCompass(deg) {
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
}

function pickMarineAtHour(weather, key, hourIdx) {
    const arr = weather?.marine_hourly?.[key];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const v = arr[hourIdx];
    if (v !== null && v !== undefined) return v;
    const v0 = arr[0];
    if (v0 !== null && v0 !== undefined) return v0;
    return null;
}

function getWaveAtHour(weather, hourIdx) {
    const mh = weather?.marine_hourly;
    const arr = mh?.wave_height;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const v = arr[hourIdx];
    if (v !== null && v !== undefined) return v;
    const v0 = arr[0];
    if (v0 !== null && v0 !== undefined) return v0;
    return null;
}

function getHlsBase() {
    const publicUrl = String(_config?.mediamtx?.public_hls_url || '').trim();
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    const port = _config?.mediamtx?.hls_port || 8856;
    return `http://127.0.0.1:${port}`;
}

function getPublicBaseUrl() {
    const cfgBase = String(_config?.server?.public_base_url || '').trim();
    const basePath = String(_config?.server?.base_path || '').trim();
    const basePathNormalized = basePath ? ('/' + basePath.replace(/^\/+/, '').replace(/\/+$/, '')) : '';
    if (cfgBase) return `${cfgBase.replace(/\/+$/, '')}${basePathNormalized}`.replace(/\/+$/, '');
    if (global.lastPublicBaseUrl) return String(global.lastPublicBaseUrl).trim().replace(/\/+$/, '');
    const hls = String(_config?.mediamtx?.public_hls_url || '').trim();
    if (hls) {
        try {
            const u = new URL(hls);
            const portPart = u.port ? `:${u.port}` : '';
            return `${u.protocol}//${u.hostname}${portPart}${basePathNormalized}`.replace(/\/+$/, '');
        } catch (e) { }
    }
    return '';
}

function waEscape(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function getCustomerPlayableLevels(levelRaw) {
    const level = String(levelRaw || 'umum').toLowerCase();
    if (level === 'admin') return null;
    if (level === 'vvip') return ['umum', 'member', 'vip', 'vvip'];
    if (level === 'pemerintahan') return ['umum', 'member', 'vip', 'pemerintahan'];
    if (level === 'vip') return ['umum', 'member', 'vip'];
    if (level === 'member') return ['umum', 'member'];
    return ['umum'];
}

function buildAdminSet(config) {
    const raw = config?.whatsapp?.admin_numbers;
    if (!raw) return new Set();
    const list = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    const normalized = list.map(normalizePhoneId).filter(Boolean);
    return new Set(normalized);
}

function loadAuthLidReverseMap(authFolder) {
    try {
        const files = fs.readdirSync(authFolder);
        const next = new Map();
        for (const f of files) {
            const forward = /^lid-mapping-(\d+)\.json$/i.exec(f);
            const reverse = /^lid-mapping-(\d+)_reverse\.json$/i.exec(f);
            if (!forward && !reverse) continue;

            const raw = fs.readFileSync(path.join(authFolder, f), 'utf8');
            let value = null;
            try {
                value = JSON.parse(raw);
            } catch (e) {
                value = String(raw || '').trim().replace(/^"|"$/g, '');
            }

            if (forward) {
                const phoneDigits = normalizePhoneId(forward[1]);
                const lidDigits = String(value || '').replace(/\D/g, '');
                if (!phoneDigits || !lidDigits) continue;
                next.set(lidDigits + '@lid', phoneDigits);
                continue;
            }

            if (reverse) {
                const lidDigits = String(reverse[1] || '').replace(/\D/g, '');
                const phoneDigits = normalizePhoneId(value);
                if (!phoneDigits || !lidDigits) continue;
                next.set(lidDigits + '@lid', phoneDigits);
                continue;
            }
        }
        authLidReverse = next;
    } catch (e) {
        authLidReverse = new Map();
    }
}

function resolveSenderDigits(sock, key) {
    const remoteJid = key?.remoteJid || null;
    if (!remoteJid) return { senderDigits: null, senderJid: null };
    if (remoteJid === 'status@broadcast') return { senderDigits: null, senderJid: remoteJid };

    const isGroup = remoteJid.endsWith('@g.us');
    const senderPn = key?.senderPn || null;
    const senderLid = key?.senderLid || null;
    const senderJid = senderPn || (isGroup ? (key?.participant || null) : remoteJid) || senderLid || remoteJid;

    const normalizedFromPn = normalizePnJidToDigits(senderPn);
    if (normalizedFromPn) return { senderDigits: normalizedFromPn, senderJid };

    const normalizedFromRemote = normalizePnJidToDigits(remoteJid);
    if (normalizedFromRemote) return { senderDigits: normalizedFromRemote, senderJid };

    if (senderJid && senderJid.endsWith('@lid')) {
        const fromAuthReverse = authLidReverse.get(senderJid);
        const normalizedFromAuthReverse = normalizePhoneId(fromAuthReverse);
        if (normalizedFromAuthReverse) return { senderDigits: normalizedFromAuthReverse, senderJid };

        const cached = lidStore.get(senderJid);
        const normalizedCached = normalizePhoneId(cached);
        if (normalizedCached) return { senderDigits: normalizedCached, senderJid };

        const contact = sock?.contacts ? sock.contacts[senderJid] : null;
        const normalizedFromContact = normalizePhoneId(contact?.phoneNumber);
        if (normalizedFromContact) return { senderDigits: normalizedFromContact, senderJid };

        return { senderDigits: null, senderJid };
    }

    return { senderDigits: normalizePhoneId(senderJid), senderJid };
}

// Load pemetaan LID dari file jika ada
try {
    if (fs.existsSync(lidMapPath)) {
        const data = JSON.parse(fs.readFileSync(lidMapPath, 'utf8'));
        lidStore = new Map(Object.entries(data));
    }
} catch (e) {
    console.error('[WhatsApp] Gagal membaca lid_map.json', e);
}

function saveLidMap() {
    try {
        const data = Object.fromEntries(lidStore);
        fs.writeFileSync(lidMapPath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[WhatsApp] Gagal menyimpan lid_map.json', e);
    }
}

async function startBot() {
    const authFolder = path.join(__dirname, 'auth_info_baileys');
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();
    loadAuthLidReverseMap(authFolder);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        browser: ['Ubuntu', _config?.site?.title || 'CCTV ALIJAYA-NET', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        logger: pino({ level: 'silent' })
    });

    currentSock = sock;

    sock.ev.on('creds.update', saveCreds);

    // Merekam pemetaan nomor HP dari kontak (LID Mapping)
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const contact of contacts) {
            if (contact.id && contact.id.endsWith('@lid') && contact.phoneNumber) {
                lidStore.set(contact.id, contact.phoneNumber);
                saveLidMap();
            }
        }
    });

    sock.ev.on('messaging-history.set', ({ contacts }) => {
        if (contacts) {
            let changed = false;
            for (const contact of contacts) {
                if (contact.id && contact.id.endsWith('@lid') && contact.phoneNumber) {
                    lidStore.set(contact.id, contact.phoneNumber);
                    changed = true;
                }
            }
            if (changed) saveLidMap();
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('[WhatsApp] Silakan scan QR code berikut untuk login WhatsApp Bot:');
            try {
                botStatus.qr = await global.qrcodeLib.toDataURL(qr);
            } catch (err) {
                console.error('Failed to generate QR data URL', err);
            }
            botStatus.connected = false;
            botStatus.user = null;
        }

        if (connection === 'close') {
            botStatus.connected = false;
            botStatus.user = null;
            welcomeMessageSent = false; // Reset flag on disconnect
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.log(`[WhatsApp] Koneksi terputus (kode ${code}). ` +
                (shouldReconnect ? 'Mencoba reconnect...' : 'Sesi logout, silakan hapus folder auth dan scan ulang.'));

            if (shouldReconnect) {
                setTimeout(startBot, 3000);
            } else {
                botStatus.qr = null;
                try {
                    fs.rmSync(authFolder, { recursive: true, force: true });
                } catch (e) { }
                startBot();
            }
        } else if (connection === 'open') {
            console.log('[WhatsApp] Bot terhubung dan siap digunakan!');
            botStatus.connected = true;
            botStatus.qr = null;
            botStatus.user = sock.user;
            
            // Send welcome message to admin number (only once on first connection)
            if (!welcomeMessageSent) {
                setTimeout(async () => {
                    try {
                        const adminNumber = '081947215703';
                        const timestamp = new Date().toLocaleString('id-ID', { 
                            weekday: 'long', 
                            year: 'numeric', 
                            month: 'long', 
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                        });
                        
                        const welcomeMessage = `╔═══════════════════════════════════════╗
║   🎉 CCTV Monitoring System Aktif   ║
║        WhatsApp Bot Connected        ║
╚═══════════════════════════════════════╝

Assalamu'alaikum! 👋

Sistem CCTV Monitoring telah berhasil diaktifkan dan siap beroperasi dengan sempurna.

📊 *Status Sistem:*
✅ WhatsApp Bot: Terhubung
✅ Server: Online & Responsif
✅ Database: Siap Digunakan
✅ Streaming: Aktif
✅ Recording: Berjalan Normal

🎥 *Fitur Utama yang Tersedia:*
• Live streaming multi-kamera real-time
• Recording otomatis dengan penjadwalan
• Notifikasi real-time untuk setiap event
• Kontrol PTZ (Pan-Tilt-Zoom) kamera
• Analitik cuaca maritim 24 jam
• Dashboard admin modern & responsif
• Manajemen pengguna & akses level
• Laporan kejadian terstruktur

📱 *Akses Dashboard:*
Buka browser dan kunjungi dashboard admin untuk monitoring lengkap dan kontrol sistem.

💡 *Perintah WhatsApp Bot:*
Ketik "menu" untuk melihat daftar lengkap perintah yang tersedia.

═══════════════════════════════════════

🙏 *Dukungan Pengembangan:*

Jika Anda merasa aplikasi CCTV Monitoring System ini bermanfaat dan ingin mendukung pengembangan lebih lanjut, kami sangat menghargai kontribusi Anda:

💳 *Transfer Bank (Indonesia):*
• BRI: 420601003953531

📱 *E-Wallet (Indonesia):*
• DANA: 081947215703
• OVO: 081947215703
• GOPAY: 081947215703

Setiap donasi akan membantu kami:
✨ Mengembangkan fitur baru
🔧 Meningkatkan performa sistem
📚 Membuat dokumentasi lebih lengkap
🎓 Memberikan support lebih baik

═══════════════════════════════════════

📅 *Waktu Aktivasi:* ${timestamp}
🤖 *Bot Version:* 2.0.0
📍 *Status:* Fully Operational

Terima kasih telah menggunakan CCTV Monitoring System! 🙏
Semoga sistem ini bermanfaat untuk keamanan dan monitoring Anda.

Wassalamu'alaikum! 🌙`;

                        await sock.sendMessage(adminNumber + '@s.whatsapp.net', { 
                            text: welcomeMessage 
                        });
                        welcomeMessageSent = true;
                        console.log('[WhatsApp] ✅ Pesan selamat datang terkirim ke admin');
                    } catch (err) {
                        console.error('[WhatsApp] ❌ Gagal mengirim pesan selamat datang:', err.message);
                    }
                }, 2000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue;

            const from = m.key.remoteJid;
            const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim().toLowerCase();
            if (!text) continue;

            const { senderDigits, senderJid } = resolveSenderDigits(sock, m.key);
            if (!senderDigits) continue;
            
            const parts = String(text).trim().split(/\s+/).filter(Boolean);
            const cmd = (parts[0] || '').toLowerCase();
            if (!cmd) continue;

            const adminCommands = new Set(['menu', 'help', 'halo', 'status', 'kamera', 'cuaca', 'disk', 'stream', 'rekaman', 'bersih', 'rtsp', 'info', 'restart']);
            const customerCommands = new Set(['menu', 'help', 'halo', 'cek', 'kamera', 'stream', 'rekaman', 'cuaca', 'lokasi', 'web']);

            // Check if sender is Admin
            const adminSet = buildAdminSet(_config);
            const isAdmin = adminSet.has(senderDigits);

            if (isAdmin) {
                if (!adminCommands.has(cmd)) continue;
                await handleAdminMessage(sock, from, text);
            } else {
                // Check if sender is Customer in DB
                if (_db) {
                    const matchNum = senderDigits.length >= 8 ? senderDigits.slice(-8) : senderDigits;
                    _db.get("SELECT * FROM users WHERE phone LIKE ?", [`%${matchNum}%`], async (err, user) => {
                        if (user) {
                            if (!customerCommands.has(cmd)) return;
                            await handleCustomerMessage(sock, from, text, user);
                        } else if (cmd === 'cuaca') {
                            await handleAdminMessage(sock, from, 'cuaca');
                        }
                    });
                } else if (cmd === 'cuaca') {
                    await handleAdminMessage(sock, from, 'cuaca');
                }
            }
        }
    });
}

let _callbacks = {};

async function handleAdminMessage(sock, from, text) {
    const sep = '══════════════════════';
    const title = _config?.site?.title || 'CCTV TPNET CENTER';
    const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
    const cmd = (parts[0] || '').toLowerCase();
    const args = parts.slice(1);

    if (cmd === 'menu' || cmd === 'help' || cmd === 'halo') {
        const menu = `🛠️ *MENU ADMIN BOT*
${sep}
🏢 *${title}*
${sep}

📋 *Perintah Tersedia:*

🟢 *status* : Cek status server & DB
🎥 *kamera* : Daftar status kamera
🌊 *cuaca* : Laporan cuaca laut & angin
💾 *disk* : Status penyimpanan server
🔗 *stream <id>* : Link stream HLS kamera
📼 *rekaman* : 5 rekaman terbaru
🧹 *bersih orphans* : Hapus data rekaman yang filenya hilang
🗑️ *bersih <hari>* : Hapus rekaman lebih dari N hari
🔧 *rtsp* : Bantuan template RTSP
📊 *info* : Informasi teknis bot
🔄 *restart* : Restart layanan media

${sep}
💡 _Ketik perintah tanpa tanda bintang._`;
        await sock.sendMessage(from, { text: menu });
    } else if (cmd === 'status') {
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);

        const status = `✅ *STATUS SISTEM*
${sep}
⏱️ *Uptime:* ${hours} jam ${minutes} menit
🗄️ *Database:* Connected
🌐 *Server:* Online (Port: ${_config?.server?.port || '?'})
🤖 *WhatsApp:* Connected

Semua sistem berjalan normal.`;
        await sock.sendMessage(from, { text: status });
    } else if (cmd === 'kamera') {
        if (_db) {
            _db.all("SELECT id, nama, lokasi, lat, lng FROM cameras ORDER BY id ASC", async (err, rows) => {
                if (err) return sock.sendMessage(from, { text: 'Gagal mengambil data kamera.' });

                let list = `🎥 *STATUS KAMERA*
${sep}\n`;
                const statusMap = _callbacks.getCameraStatus ? _callbacks.getCameraStatus() : {};

                for (const cam of (rows || [])) {
                    const st = statusMap[cam.id] || {};
                    const isOnline = !!st.online;
                    const camName = cam.nama || `Kamera ${cam.id}`;
                    const loc = cam.lokasi ? ` — ${cam.lokasi}` : '';
                    list += `${isOnline ? '🟢' : '🔴'} *${camName}*${loc}\n`;
                }

                if (rows.length === 0) list += '_Tidak ada kamera terdaftar._';
                list += `\n${sep}\nTotal: ${rows.length} Kamera`;
                await sock.sendMessage(from, { text: list });
            });
        }
    } else if (cmd === 'cuaca') {
        await sock.sendMessage(from, { text: '🔄 _Sedang mengambil data cuaca laut terbaru..._' });

        if (_db && _callbacks.getWeatherBundle) {
            const refLat = (typeof _config?.map?.default_lat === 'number') ? _config.map.default_lat : -6.251973319579064;
            const refLng = (typeof _config?.map?.default_lng === 'number') ? _config.map.default_lng : 107.92050843016914;
            _db.get(
                "SELECT id, lat, lng, nama, lokasi FROM cameras WHERE lat IS NOT NULL AND lng IS NOT NULL ORDER BY (ABS(CAST(lat AS REAL) - ?) + ABS(CAST(lng AS REAL) - ?)) ASC, id ASC LIMIT 1",
                [refLat, refLng],
                async (err, cam) => {
                if (err || !cam) {
                    try {
                        const weather = await _callbacks.getWeatherBundle(refLat, refLng);
                        const hourIdx = getJakartaHourIndex();
                        const wind = weather?.current?.wind_speed_10m;
                        const windDir = weather?.current?.wind_direction_10m;
                        const wave = pickMarineAtHour(weather, 'wave_height', hourIdx);
                        const waveDir = pickMarineAtHour(weather, 'wave_direction', hourIdx);
                        const wavePeriod = pickMarineAtHour(weather, 'wave_period', hourIdx);
                        const wavePeak = pickMarineAtHour(weather, 'wave_peak_period', hourIdx);
                        const sst = pickMarineAtHour(weather, 'sea_surface_temperature', hourIdx);
                        const curVel = pickMarineAtHour(weather, 'ocean_current_velocity', hourIdx);
                        const curDir = pickMarineAtHour(weather, 'ocean_current_direction', hourIdx);
                        const sea = pickMarineAtHour(weather, 'sea_level_height_msl', hourIdx);
                        const isDangerous = (wave || 0) > 1.5 || (wind || 0) > 30;
                        const report = `🌊 *LAPORAN CUACA LAUT*
${sep}
📍 *Lokasi:* Titik Default Peta
📌 *Sumber:* (${Number(refLat).toFixed(6)}, ${Number(refLng).toFixed(6)})
🌡️ *Suhu:* ${weather?.current?.temperature_2m ?? '--'}°C
💨 *Angin:* ${wind !== null && wind !== undefined ? Math.round(wind) : '--'} km/h${(windDir !== null && windDir !== undefined) ? ` • ${Math.round(Number(windDir))}°${degToCompass(windDir) ? ' ' + degToCompass(windDir) : ''}` : ''}
🌊 *Ombak:* ${wave !== null && wave !== undefined ? Number(wave).toFixed(1) : '--'} m${(waveDir !== null && waveDir !== undefined) ? ` • ${Math.round(Number(waveDir))}°${degToCompass(waveDir) ? ' ' + degToCompass(waveDir) : ''}` : ''}${(wavePeriod !== null && wavePeriod !== undefined) ? ` • ${Number(wavePeriod).toFixed(1)}s` : ''}${(wavePeak !== null && wavePeak !== undefined) ? ` • peak ${Number(wavePeak).toFixed(1)}s` : ''}
🌡️ *SST:* ${sst !== null && sst !== undefined ? Number(sst).toFixed(1) : '--'}°C
🌀 *Arus:* ${curVel !== null && curVel !== undefined ? Number(curVel).toFixed(1) : '--'} km/h${(curDir !== null && curDir !== undefined) ? ` • ${Math.round(Number(curDir))}°${degToCompass(curDir) ? ' ' + degToCompass(curDir) : ''}` : ''}
🌊 *Pasang:* ${sea !== null && sea !== undefined ? Number(sea).toFixed(2) : '--'} m

⚠️ *Kondisi:* ${isDangerous ? '🛑 MEMBAHAYAKAN' : '✅ AMAN'}
${sep}
_Update: ${new Date().toLocaleString('id-ID')}_`;
                        return sock.sendMessage(from, { text: report });
                    } catch (e) {
                        return sock.sendMessage(from, { text: '⚠️ Data lokasi tidak tersedia untuk pengecekan cuaca.' });
                    }
                }

                try {
                    const weather = await _callbacks.getWeatherBundle(cam.lat, cam.lng);
                    const hourIdx = getJakartaHourIndex();
                    const wind = weather?.current?.wind_speed_10m;
                    const windDir = weather?.current?.wind_direction_10m;
                    const wave = pickMarineAtHour(weather, 'wave_height', hourIdx);
                    const waveDir = pickMarineAtHour(weather, 'wave_direction', hourIdx);
                    const wavePeriod = pickMarineAtHour(weather, 'wave_period', hourIdx);
                    const wavePeak = pickMarineAtHour(weather, 'wave_peak_period', hourIdx);
                    const sst = pickMarineAtHour(weather, 'sea_surface_temperature', hourIdx);
                    const curVel = pickMarineAtHour(weather, 'ocean_current_velocity', hourIdx);
                    const curDir = pickMarineAtHour(weather, 'ocean_current_direction', hourIdx);
                    const sea = pickMarineAtHour(weather, 'sea_level_height_msl', hourIdx);
                    const isDangerous = (wave || 0) > 1.5 || (wind || 0) > 30;

                    const report = `🌊 *LAPORAN CUACA LAUT*
${sep}
📍 *Lokasi:* ${cam.nama || cam.lokasi || 'Kuala Tungkal'}
📌 *Sumber:* Kamera #${cam.id}
🌡️ *Suhu:* ${weather?.current?.temperature_2m ?? '--'}°C
💨 *Angin:* ${wind !== null && wind !== undefined ? Math.round(wind) : '--'} km/h${(windDir !== null && windDir !== undefined) ? ` • ${Math.round(Number(windDir))}°${degToCompass(windDir) ? ' ' + degToCompass(windDir) : ''}` : ''}
🌊 *Ombak:* ${wave !== null && wave !== undefined ? Number(wave).toFixed(1) : '--'} m${(waveDir !== null && waveDir !== undefined) ? ` • ${Math.round(Number(waveDir))}°${degToCompass(waveDir) ? ' ' + degToCompass(waveDir) : ''}` : ''}${(wavePeriod !== null && wavePeriod !== undefined) ? ` • ${Number(wavePeriod).toFixed(1)}s` : ''}${(wavePeak !== null && wavePeak !== undefined) ? ` • peak ${Number(wavePeak).toFixed(1)}s` : ''}
🌡️ *SST:* ${sst !== null && sst !== undefined ? Number(sst).toFixed(1) : '--'}°C
🌀 *Arus:* ${curVel !== null && curVel !== undefined ? Number(curVel).toFixed(1) : '--'} km/h${(curDir !== null && curDir !== undefined) ? ` • ${Math.round(Number(curDir))}°${degToCompass(curDir) ? ' ' + degToCompass(curDir) : ''}` : ''}
🌊 *Pasang:* ${sea !== null && sea !== undefined ? Number(sea).toFixed(2) : '--'} m

⚠️ *Kondisi:* ${isDangerous ? '🛑 MEMBAHAYAKAN' : '✅ AMAN'}
${sep}
_Update: ${new Date().toLocaleString('id-ID')}_`;
                    await sock.sendMessage(from, { text: report });
                } catch (e) {
                    await sock.sendMessage(from, { text: '⚠️ Gagal mengambil data cuaca dari satelit.' });
                }
                }
            );
        } else {
            await sock.sendMessage(from, { text: '⚠️ Fitur cuaca sedang dalam pemeliharaan.' });
        }
    } else if (cmd === 'disk') {
        const disk = _callbacks.getDiskUsage ? _callbacks.getDiskUsage() : null;
        if (!disk || !disk.total) {
            await sock.sendMessage(from, { text: `💾 *STATUS PENYIMPANAN*\n${sep}\nData tidak tersedia.` });
            return;
        }
        const mount = disk.mounted ? ` (${disk.mounted})` : '';
        let level = '';
        if (typeof disk.percent === 'number') {
            if (disk.percent > 90) level = '🟥 Kritis';
            else if (disk.percent > 70) level = '🟧 Tinggi';
            else level = '🟩 Normal';
        }
        let report = `💾 *STATUS PENYIMPANAN*\n${sep}\nKapasitas Disk${mount}\n${disk.used || '-'} / ${disk.total || '-'} (${disk.percent ?? '-'}%)\nTersedia: ${disk.free || '-'}\n`;
        if (level) report += `Level: ${level}\n`;
        if (Array.isArray(disk.disks) && disk.disks.length > 0) {
            report += `\nPer-Volume:\n`;
            disk.disks.forEach(d => {
                report += `- ${d.mounted}: ${d.used}/${d.total} (${d.percent}%)\n`;
            });
        }
        await sock.sendMessage(from, { text: report.trim() });
    } else if (cmd === 'stream') {
        const camId = args[0] ? parseInt(args[0], 10) : NaN;
        if (!Number.isFinite(camId)) {
            await sock.sendMessage(from, { text: `🔗 Format: *stream <id_kamera>*\nContoh: stream 1` });
            return;
        }
        const hlsBase = getHlsBase();
        const transcoded = `${hlsBase}/cam_${camId}/index.m3u8`;
        const direct = `${hlsBase}/cam_${camId}_input/index.m3u8`;
        await sock.sendMessage(from, { text: `🔗 *LINK STREAM KAMERA ${camId}*\n${sep}\n• Transcoded: ${transcoded}\n• Direct: ${direct}` });
    } else if (cmd === 'rekaman') {
        try {
            const recordingsDir = path.join(__dirname, 'recordings');
            let cameraFolders = [];
            try {
                cameraFolders = fs.readdirSync(recordingsDir).filter(f => {
                    const fullPath = path.join(recordingsDir, f);
                    return fs.statSync(fullPath).isDirectory() && f.startsWith('cam_');
                });
            } catch (e) {
                cameraFolders = [];
            }

            let camNameById = {};
            try {
                const rows = await new Promise((resolve) => {
                    _db.all("SELECT id, nama FROM cameras", [], (err, r) => resolve(err ? [] : (r || [])));
                });
                rows.forEach(r => camNameById[String(r.id)] = r.nama);
            } catch (e) { }

            const items = [];
            cameraFolders.forEach(folder => {
                const folderPath = path.join(recordingsDir, folder);
                let files = [];
                try { files = fs.readdirSync(folderPath); } catch (e) { files = []; }
                const cameraId = Number(folder.replace('cam_', '')) || null;
                files.forEach(file => {
                    const fullPath = path.join(folderPath, file);
                    let stats;
                    try { stats = fs.statSync(fullPath); } catch (e) { return; }
                    if (!stats.isFile()) return;
                    const ext = path.extname(file).toLowerCase();
                    if (!['.mp4', '.fmp4', '.ts', '.mkv'].includes(ext)) return;
                    const relPath = path.relative(__dirname, fullPath).replace(/\\/g, '/');
                    items.push({
                        cameraId,
                        cameraName: camNameById[String(cameraId)] || folder,
                        filename: file,
                        relPath,
                        sizeText: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
                        createdAt: stats.mtime
                    });
                });
            });

            items.sort((a, b) => b.createdAt - a.createdAt);
            const latest = items.slice(0, 5);
            if (latest.length === 0) {
                await sock.sendMessage(from, { text: `📼 *REKAMAN TERBARU*\n${sep}\nBelum ada file rekaman.` });
                return;
            }

            const base = getPublicBaseUrl();
            let out = `📼 *5 REKAMAN TERAKHIR*\n${sep}\n`;
            latest.forEach((it, idx) => {
                const date = new Date(it.createdAt).toLocaleString('id-ID');
                const url = base ? `${base}/${it.relPath}` : it.relPath;
                out += `${idx + 1}. *${waEscape(it.cameraName)}*\n🕒 ${date}\n💾 ${it.sizeText}\n🔗 ${url}\n\n`;
            });
            if (!base) out += `Catatan: agar link jadi domain publik, set config server.public_base_url`;
            await sock.sendMessage(from, { text: out.trim() });
        } catch (e) {
            await sock.sendMessage(from, { text: `📼 *REKAMAN TERBARU*\n${sep}\nGagal membaca folder rekaman.` });
        }
    } else if (cmd === 'bersih') {
        const mode = (args[0] || '').toLowerCase();
        const svc = _callbacks.cleanupRecordings;
        if (!svc) {
            await sock.sendMessage(from, { text: `🧹 *BERSIH*\n${sep}\nFitur pembersihan belum tersedia.` });
            return;
        }

        if (mode === 'orphans' || mode === 'orphan') {
            await sock.sendMessage(from, { text: `🧹 Sedang membersihkan data rekaman orphan...` });
            svc('orphans', null, (result) => {
                const deleted = result?.deleted ?? 0;
                sock.sendMessage(from, { text: `🧹 *BERSIH ORPHANS*\n${sep}\nTerhapus: ${deleted}` });
            });
            return;
        }

        const days = mode ? parseInt(mode, 10) : NaN;
        if (!Number.isFinite(days) || days < 1) {
            await sock.sendMessage(from, { text: `🗑️ Format: *bersih <hari>* atau *bersih orphans*\nContoh: bersih 7` });
            return;
        }
        await sock.sendMessage(from, { text: `🗑️ Sedang menghapus rekaman lebih dari ${days} hari...` });
        svc('old', days, (result) => {
            const deleted = result?.deleted ?? 0;
            const freed = result?.freedSpace || '-';
            sock.sendMessage(from, { text: `🗑️ *BERSIH REKAMAN*\n${sep}\nTerhapus: ${deleted}\nBebas: ${freed}` });
        });
    } else if (cmd === 'rtsp') {
        const templates = _callbacks.getRtspTemplates ? _callbacks.getRtspTemplates() : null;
        if (!templates || typeof templates !== 'object') {
            await sock.sendMessage(from, { text: `🔧 *RTSP*\n${sep}\nTemplate tidak tersedia.` });
            return;
        }
        const keys = Object.keys(templates);
        const lines = keys.map(k => `- ${k}: ${templates[k]?.name || k}`);
        const usage = `🔧 *TEMPLATE RTSP*\n${sep}\n${lines.join('\n')}\n\nContoh generate:\nrtsp hikvision ip=192.168.1.10 user=admin pass=12345 port=554 channel=1\n\nCatatan: format\nrtsp <brand> key=value ...`;
        if (args.length === 0) {
            await sock.sendMessage(from, { text: usage });
            return;
        }
        const brand = String(args[0] || '').toLowerCase();
        if (!templates[brand]) {
            await sock.sendMessage(from, { text: `Brand tidak dikenal: ${brand}\n\n${usage}` });
            return;
        }
        const kv = {};
        args.slice(1).forEach(p => {
            const idx = p.indexOf('=');
            if (idx <= 0) return;
            const k = p.slice(0, idx).trim();
            const v = p.slice(idx + 1).trim();
            if (!k) return;
            kv[k] = v;
        });
        if (!kv.ip || !kv.username || !kv.password) {
            await sock.sendMessage(from, { text: `Format kurang lengkap.\nWajib: ip, username, password\n\n${usage}` });
            return;
        }
        const params = { ...kv };
        if (params.user && !params.username) params.username = params.user;
        if (params.pass && !params.password) params.password = params.pass;
        if (params.port) params.port = String(params.port);
        const url = _callbacks.generateRtspUrl ? _callbacks.generateRtspUrl(brand, params) : null;
        if (!url) {
            await sock.sendMessage(from, { text: `Gagal generate RTSP untuk brand ${brand}.` });
            return;
        }
        await sock.sendMessage(from, { text: `🔗 *RTSP ${templates[brand]?.name || brand}*\n${sep}\n${url}` });
    } else if (cmd === 'info') {
        const status = botStatus.connected ? 'Connected' : 'Disconnected';
        const me = botStatus.user?.id || botStatus.user?.jid || '-';
        const port = _config?.server?.port || '?';
        const info = `ℹ️ *INFO BOT*
${sep}
🤖 *WhatsApp:* ${status}
👤 *Akun:* ${me}
🌐 *Server Port:* ${port}
🗄️ *Database:* ${_db ? 'Ready' : 'Not Ready'}
🌦️ *Cuaca:* ${_callbacks.getWeatherBundle ? 'Ready' : 'Not Ready'}
💾 *Disk:* ${_callbacks.getDiskUsage ? 'Ready' : 'Not Ready'}
🧹 *Cleanup:* ${_callbacks.cleanupRecordings ? 'Ready' : 'Not Ready'}
${sep}
_Ketik menu untuk daftar perintah._`;
        await sock.sendMessage(from, { text: info });
    } else if (cmd === 'restart') {
        const svc = _callbacks.restartSystem;
        if (!svc) {
            await sock.sendMessage(from, { text: `🔄 Permintaan restart diterima.\n\nRestart belum tersedia di sistem ini.` });
            return;
        }
        await sock.sendMessage(from, { text: `🔄 Permintaan restart diterima. Sistem akan me-restart...` });
        setTimeout(() => {
            try { svc(); } catch (e) { }
        }, 1000);
    } else {
        return;
    }
}

async function handleCustomerMessage(sock, from, text, user) {
    const sep = '══════════════════════';
    const title = _config?.site?.title || 'CCTV TPNET CENTER';
    const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
    const cmd = (parts[0] || '').toLowerCase();
    const args = parts.slice(1);

    if (cmd === 'menu' || cmd === 'help' || cmd === 'halo') {
        const menu = `📱 *MENU PELANGGAN*
${sep}
🏢 *${title}*
${sep}

Halo, *${user.full_name || user.username}* 👋
Selamat datang di layanan bot otomatis kami.

📋 *Perintah Tersedia:*

👤 *cek* : Status langganan Anda
� *kamera* : Daftar kamera yang bisa Anda akses
🔗 *stream <id>* : Link stream kamera
📼 *rekaman* : 5 rekaman terbaru (sesuai akses)
�🌊 *cuaca* : Cek kondisi laut & angin
📍 *lokasi* : Alamat & kontak kami
🌐 *web* : Link akses dashboard

${sep}
💡 _Gunakan layanan ini dengan bijak._`;
        await sock.sendMessage(from, { text: menu });
    } else if (cmd === 'cek') {
        const expiry = user.active_until || 'Selamanya';
        const status = `👤 *INFO AKUN*
${sep}
👤 *Nama:* ${user.full_name}
🏷️ *Username:* ${user.username}
🌟 *Level:* ${user.level}
📅 *Masa Aktif:* ${expiry}
✅ *Status:* Aktif

Terima kasih telah berlangganan!`;
        await sock.sendMessage(from, { text: status });
    } else if (cmd === 'kamera') {
        if (!_db) {
            await sock.sendMessage(from, { text: `🎥 *KAMERA*\n${sep}\nDatabase tidak tersedia.` });
            return;
        }

        const playable = getCustomerPlayableLevels(user.level);
        const customerId = user.id;
        const statusMap = _callbacks.getCameraStatus ? _callbacks.getCameraStatus() : {};

        _db.all("SELECT id, nama, lokasi, level, owner_id FROM cameras ORDER BY id ASC", [], async (err, rows) => {
            if (err) {
                await sock.sendMessage(from, { text: `🎥 *KAMERA*\n${sep}\nGagal mengambil data kamera.` });
                return;
            }

            const allowed = [];
            (rows || []).forEach((cam) => {
                const camLevel = String(cam.level || '').toLowerCase();
                if (playable === null) {
                    allowed.push(cam);
                    return;
                }
                if (!playable.includes(camLevel)) return;
                if (camLevel === 'vvip' && String(cam.owner_id) !== String(customerId)) return;
                allowed.push(cam);
            });

            let out = `🎥 *KAMERA ANDA*\n${sep}\n`;
            if (allowed.length === 0) {
                out += `Belum ada kamera yang bisa Anda akses.\n`;
            } else {
                allowed.forEach((cam) => {
                    const st = statusMap[cam.id] || {};
                    const icon = st.online ? '🟢' : '🔴';
                    const name = cam.nama || `Kamera ${cam.id}`;
                    const loc = cam.lokasi ? ` — ${cam.lokasi}` : '';
                    out += `${icon} *${name}* (ID: ${cam.id})${loc}\n`;
                });
                out += `\nKetik: *stream <id>* untuk link stream.\nContoh: stream 1`;
            }
            await sock.sendMessage(from, { text: out.trim() });
        });
    } else if (cmd === 'stream') {
        const camId = args[0] ? parseInt(args[0], 10) : NaN;
        if (!Number.isFinite(camId)) {
            await sock.sendMessage(from, { text: `🔗 Format: *stream <id_kamera>*\nContoh: stream 1` });
            return;
        }
        if (!_db) {
            await sock.sendMessage(from, { text: `🔗 *STREAM*\n${sep}\nDatabase tidak tersedia.` });
            return;
        }

        const playable = getCustomerPlayableLevels(user.level);
        const customerId = user.id;
        _db.get("SELECT id, level, owner_id FROM cameras WHERE id = ?", [camId], async (err, cam) => {
            if (err || !cam) {
                await sock.sendMessage(from, { text: `🔗 *STREAM*\n${sep}\nKamera tidak ditemukan.` });
                return;
            }
            const camLevel = String(cam.level || '').toLowerCase();
            let allowed = false;
            if (playable === null) allowed = true;
            else if (playable.includes(camLevel)) {
                if (camLevel === 'vvip') allowed = String(cam.owner_id) === String(customerId);
                else allowed = true;
            }
            if (!allowed) {
                await sock.sendMessage(from, { text: `⛔ *AKSES DITOLAK*\n${sep}\nAnda tidak memiliki akses untuk kamera ID ${camId}.` });
                return;
            }

            const hlsBase = getHlsBase();
            const transcoded = `${hlsBase}/cam_${camId}/index.m3u8`;
            const direct = `${hlsBase}/cam_${camId}_input/index.m3u8`;
            await sock.sendMessage(from, { text: `🔗 *LINK STREAM KAMERA ${camId}*\n${sep}\n• Transcoded: ${transcoded}\n• Direct: ${direct}` });
        });
    } else if (cmd === 'rekaman') {
        if (!_db) {
            await sock.sendMessage(from, { text: `📼 *REKAMAN*\n${sep}\nDatabase tidak tersedia.` });
            return;
        }

        const playable = getCustomerPlayableLevels(user.level);
        const customerId = user.id;
        const allowedIds = new Set();
        await new Promise((resolve) => {
            _db.all("SELECT id, level, owner_id FROM cameras", [], (err, rows) => {
                if (!err && rows) {
                    rows.forEach((cam) => {
                        const camLevel = String(cam.level || '').toLowerCase();
                        if (playable === null) {
                            allowedIds.add(Number(cam.id));
                            return;
                        }
                        if (!playable.includes(camLevel)) return;
                        if (camLevel === 'vvip' && String(cam.owner_id) !== String(customerId)) return;
                        allowedIds.add(Number(cam.id));
                    });
                }
                resolve();
            });
        });

        if (allowedIds.size === 0) {
            await sock.sendMessage(from, { text: `📼 *REKAMAN*\n${sep}\nAnda belum memiliki akses kamera.` });
            return;
        }

        try {
            const recordingsDir = path.join(__dirname, 'recordings');
            let cameraFolders = [];
            try {
                cameraFolders = fs.readdirSync(recordingsDir).filter(f => {
                    const fullPath = path.join(recordingsDir, f);
                    return fs.statSync(fullPath).isDirectory() && f.startsWith('cam_');
                });
            } catch (e) {
                cameraFolders = [];
            }

            let camNameById = {};
            try {
                const rows = await new Promise((resolve) => {
                    _db.all("SELECT id, nama FROM cameras", [], (err, r) => resolve(err ? [] : (r || [])));
                });
                rows.forEach(r => camNameById[String(r.id)] = r.nama);
            } catch (e) { }

            const items = [];
            cameraFolders.forEach(folder => {
                const m = folder.match(/^cam_(\d+)/);
                const cameraId = m ? Number(m[1]) : null;
                if (!cameraId || !allowedIds.has(cameraId)) return;
                const folderPath = path.join(recordingsDir, folder);
                let files = [];
                try { files = fs.readdirSync(folderPath); } catch (e) { files = []; }
                files.forEach(file => {
                    const fullPath = path.join(folderPath, file);
                    let stats;
                    try { stats = fs.statSync(fullPath); } catch (e) { return; }
                    if (!stats.isFile()) return;
                    const ext = path.extname(file).toLowerCase();
                    if (!['.mp4', '.fmp4', '.ts', '.mkv'].includes(ext)) return;
                    const relPath = path.relative(__dirname, fullPath).replace(/\\/g, '/');
                    items.push({
                        cameraId,
                        cameraName: camNameById[String(cameraId)] || folder,
                        filename: file,
                        relPath,
                        sizeText: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
                        createdAt: stats.mtime
                    });
                });
            });

            items.sort((a, b) => b.createdAt - a.createdAt);
            const latest = items.slice(0, 5);
            if (latest.length === 0) {
                await sock.sendMessage(from, { text: `📼 *REKAMAN TERBARU*\n${sep}\nBelum ada file rekaman untuk kamera Anda.` });
                return;
            }

            const base = getPublicBaseUrl();
            let out = `📼 *5 REKAMAN TERAKHIR*\n${sep}\n`;
            latest.forEach((it, idx) => {
                const date = new Date(it.createdAt).toLocaleString('id-ID');
                const url = base ? `${base}/${it.relPath}` : it.relPath;
                out += `${idx + 1}. *${waEscape(it.cameraName)}*\n🕒 ${date}\n💾 ${it.sizeText}\n🔗 ${url}\n\n`;
            });
            if (!base) out += `Catatan: agar link jadi domain publik, set config server.public_base_url`;
            await sock.sendMessage(from, { text: out.trim() });
        } catch (e) {
            await sock.sendMessage(from, { text: `📼 *REKAMAN TERBARU*\n${sep}\nGagal membaca folder rekaman.` });
        }
    } else if (cmd === 'cuaca') {
        await sock.sendMessage(from, { text: '🔄 _Sedang mengambil data cuaca laut terbaru..._' });

        if (_db && _callbacks.getWeatherBundle) {
            const refLat = (typeof _config?.map?.default_lat === 'number') ? _config.map.default_lat : -6.251973319579064;
            const refLng = (typeof _config?.map?.default_lng === 'number') ? _config.map.default_lng : 107.92050843016914;
            _db.get(
                "SELECT id, lat, lng, nama, lokasi FROM cameras WHERE lat IS NOT NULL AND lng IS NOT NULL ORDER BY (ABS(CAST(lat AS REAL) - ?) + ABS(CAST(lng AS REAL) - ?)) ASC, id ASC LIMIT 1",
                [refLat, refLng],
                async (err, cam) => {
                if (err || !cam) {
                    try {
                        const weather = await _callbacks.getWeatherBundle(refLat, refLng);
                        const hourIdx = getJakartaHourIndex();
                        const wind = weather?.current?.wind_speed_10m;
                        const windDir = weather?.current?.wind_direction_10m;
                        const wave = pickMarineAtHour(weather, 'wave_height', hourIdx);
                        const waveDir = pickMarineAtHour(weather, 'wave_direction', hourIdx);
                        const wavePeriod = pickMarineAtHour(weather, 'wave_period', hourIdx);
                        const wavePeak = pickMarineAtHour(weather, 'wave_peak_period', hourIdx);
                        const sst = pickMarineAtHour(weather, 'sea_surface_temperature', hourIdx);
                        const curVel = pickMarineAtHour(weather, 'ocean_current_velocity', hourIdx);
                        const curDir = pickMarineAtHour(weather, 'ocean_current_direction', hourIdx);
                        const sea = pickMarineAtHour(weather, 'sea_level_height_msl', hourIdx);
                        const isDangerous = (wave || 0) > 1.5 || (wind || 0) > 30;

                        const report = `🌊 *LAPORAN CUACA LAUT*
${sep}
📍 *Lokasi:* Titik Default Peta
📌 *Sumber:* (${Number(refLat).toFixed(6)}, ${Number(refLng).toFixed(6)})
🌡️ *Suhu:* ${weather?.current?.temperature_2m ?? '--'}°C
💨 *Angin:* ${wind !== null && wind !== undefined ? Math.round(wind) : '--'} km/h${(windDir !== null && windDir !== undefined) ? ` • ${Math.round(Number(windDir))}°${degToCompass(windDir) ? ' ' + degToCompass(windDir) : ''}` : ''}
🌊 *Ombak:* ${wave !== null && wave !== undefined ? Number(wave).toFixed(1) : '--'} m${(waveDir !== null && waveDir !== undefined) ? ` • ${Math.round(Number(waveDir))}°${degToCompass(waveDir) ? ' ' + degToCompass(waveDir) : ''}` : ''}${(wavePeriod !== null && wavePeriod !== undefined) ? ` • ${Number(wavePeriod).toFixed(1)}s` : ''}${(wavePeak !== null && wavePeak !== undefined) ? ` • peak ${Number(wavePeak).toFixed(1)}s` : ''}
🌡️ *SST:* ${sst !== null && sst !== undefined ? Number(sst).toFixed(1) : '--'}°C
🌀 *Arus:* ${curVel !== null && curVel !== undefined ? Number(curVel).toFixed(1) : '--'} km/h${(curDir !== null && curDir !== undefined) ? ` • ${Math.round(Number(curDir))}°${degToCompass(curDir) ? ' ' + degToCompass(curDir) : ''}` : ''}
🌊 *Pasang:* ${sea !== null && sea !== undefined ? Number(sea).toFixed(2) : '--'} m

⚠️ *Kondisi:* ${isDangerous ? '🛑 MEMBAHAYAKAN' : '✅ AMAN'}
${sep}
_Update: ${new Date().toLocaleString('id-ID')}_`;
                        return sock.sendMessage(from, { text: report });
                    } catch (e) {
                        return sock.sendMessage(from, { text: '⚠️ Data lokasi tidak tersedia untuk pengecekan cuaca.' });
                    }
                }

                try {
                    const weather = await _callbacks.getWeatherBundle(cam.lat, cam.lng);
                    const hourIdx = getJakartaHourIndex();
                    const wind = weather?.current?.wind_speed_10m;
                    const windDir = weather?.current?.wind_direction_10m;
                    const wave = pickMarineAtHour(weather, 'wave_height', hourIdx);
                    const waveDir = pickMarineAtHour(weather, 'wave_direction', hourIdx);
                    const wavePeriod = pickMarineAtHour(weather, 'wave_period', hourIdx);
                    const wavePeak = pickMarineAtHour(weather, 'wave_peak_period', hourIdx);
                    const sst = pickMarineAtHour(weather, 'sea_surface_temperature', hourIdx);
                    const curVel = pickMarineAtHour(weather, 'ocean_current_velocity', hourIdx);
                    const curDir = pickMarineAtHour(weather, 'ocean_current_direction', hourIdx);
                    const sea = pickMarineAtHour(weather, 'sea_level_height_msl', hourIdx);
                    const isDangerous = (wave || 0) > 1.5 || (wind || 0) > 30;

                    const report = `🌊 *LAPORAN CUACA LAUT*
${sep}
📍 *Lokasi:* ${cam.nama || cam.lokasi || 'Kuala Tungkal'}
📌 *Sumber:* Kamera #${cam.id}
🌡️ *Suhu:* ${weather?.current?.temperature_2m ?? '--'}°C
💨 *Angin:* ${wind !== null && wind !== undefined ? Math.round(wind) : '--'} km/h${(windDir !== null && windDir !== undefined) ? ` • ${Math.round(Number(windDir))}°${degToCompass(windDir) ? ' ' + degToCompass(windDir) : ''}` : ''}
🌊 *Ombak:* ${wave !== null && wave !== undefined ? Number(wave).toFixed(1) : '--'} m${(waveDir !== null && waveDir !== undefined) ? ` • ${Math.round(Number(waveDir))}°${degToCompass(waveDir) ? ' ' + degToCompass(waveDir) : ''}` : ''}${(wavePeriod !== null && wavePeriod !== undefined) ? ` • ${Number(wavePeriod).toFixed(1)}s` : ''}${(wavePeak !== null && wavePeak !== undefined) ? ` • peak ${Number(wavePeak).toFixed(1)}s` : ''}
🌡️ *SST:* ${sst !== null && sst !== undefined ? Number(sst).toFixed(1) : '--'}°C
🌀 *Arus:* ${curVel !== null && curVel !== undefined ? Number(curVel).toFixed(1) : '--'} km/h${(curDir !== null && curDir !== undefined) ? ` • ${Math.round(Number(curDir))}°${degToCompass(curDir) ? ' ' + degToCompass(curDir) : ''}` : ''}
🌊 *Pasang:* ${sea !== null && sea !== undefined ? Number(sea).toFixed(2) : '--'} m

⚠️ *Kondisi:* ${isDangerous ? '🛑 MEMBAHAYAKAN' : '✅ AMAN'}
${sep}
_Update: ${new Date().toLocaleString('id-ID')}_`;
                    await sock.sendMessage(from, { text: report });
                } catch (e) {
                    await sock.sendMessage(from, { text: '⚠️ Gagal mengambil data cuaca dari satelit.' });
                }
                }
            );
        } else {
            await sock.sendMessage(from, { text: '⚠️ Fitur cuaca sedang dalam pemeliharaan.' });
        }
    } else if (cmd === 'lokasi') {
        await sock.sendMessage(from, { text: `📍 *LOKASI KAMI*\n${sep}\n*TPNET CENTER*\nJl. Pelabuhan No. 1, Kuala Tungkal\n\n📞 CS: 0812-xxxx-xxxx` });
    } else if (cmd === 'web') {
        const base = getPublicBaseUrl();
        const url = base ? base : 'https://tungkalpunye.net';
        await sock.sendMessage(from, { text: `🌐 *AKSES DASHBOARD*\n${sep}\nSilakan login di:\n${url}` });
    } else {
        return;
    }
}

function init(config, db, callbacks = {}) {
    _config = config;
    _db = db;
    _callbacks = callbacks;
    if (!global.qrcodeLib) {
        global.qrcodeLib = require('qrcode');
    }
    startBot().catch(err => console.error('[WhatsApp] Gagal start bot:', err));
}

async function sendWA(to, text) {
    if (!currentSock || !botStatus.connected) {
        console.log('[WhatsApp] Gagal kirim pesan, bot belum terhubung.');
        return false;
    }
    try {
        let digits = String(to).replace(/\D/g, '');
        if (!digits) return false;
        if (digits.startsWith('0')) {
            digits = '62' + digits.slice(1);
        }
        const jid = digits + '@s.whatsapp.net';
        await currentSock.sendMessage(jid, { text });
        return true;
    } catch (e) {
        console.error('[WhatsApp] Gagal kirim WA:', e.message);
        return false;
    }
}

function getStatus() {
    return botStatus;
}

async function logout() {
    botStatus.connected = false;
    botStatus.user = null;
    botStatus.qr = null;

    if (currentSock) {
        try {
            await currentSock.logout();
        } catch (e) {
            console.error('Error logging out socket:', e);
        }
    }

    // Paksa hapus folder auth
    const authFolder = path.join(__dirname, 'auth_info_baileys');
    try {
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true, force: true });
            console.log('[WhatsApp] Folder auth berhasil dihapus.');
        }
    } catch (e) {
        console.error('[WhatsApp] Gagal menghapus folder auth:', e);
    }

    // Restart bot agar generate QR baru
    setTimeout(() => {
        startBot().catch(err => console.error('[WhatsApp] Gagal start bot setelah logout:', err));
    }, 2000);

    return { success: true };
}

// Track if welcome message has been sent
let welcomeMessageSent = false;

// Function to send donation reminder
async function sendDonationReminder(adminNumber = '081947215703') {
    if (!currentSock || !botStatus.connected) {
        console.log('[WhatsApp] Bot belum terhubung, reminder donasi tidak dikirim');
        return false;
    }

    try {
        const donationMessage = `💝 *Reminder Dukungan Pengembangan*

Halo! 👋

Terima kasih telah menggunakan CCTV Monitoring System. Sistem ini terus berkembang berkat dukungan dari pengguna seperti Anda.

🎯 *Jika Anda merasa aplikasi ini bermanfaat, kami sangat menghargai dukungan Anda:*

💳 *Transfer Bank (Indonesia):*
• BRI: 420601003953531
Atas Nama: WARJA YA

📱 *E-Wallet (Indonesia):*
• DANA: 081947215703
• OVO: 081947215703
• GOPAY: 081947215703

✨ *Setiap donasi membantu kami untuk:*
✓ Mengembangkan fitur baru yang lebih canggih
✓ Meningkatkan performa dan stabilitas sistem
✓ Membuat dokumentasi lebih lengkap
✓ Memberikan support dan bantuan lebih baik

═══════════════════════════════════════

Terima kasih atas dukungan Anda! 🙏
Wassalamu'alaikum! 🌙`;

        await currentSock.sendMessage(adminNumber + '@s.whatsapp.net', { 
            text: donationMessage 
        });
        console.log('[WhatsApp] ✅ Reminder donasi terkirim');
        return true;
    } catch (err) {
        console.error('[WhatsApp] ❌ Gagal mengirim reminder donasi:', err.message);
        return false;
    }
}

module.exports = {
    init,
    sendWA,
    getStatus,
    logout,
    sendDonationReminder
};
