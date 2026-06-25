# 📹 CCTV Monitoring System 🚀
![cctv monitoring Hero](/public/cctv7.png)

**Sistem monitoring CCTV profesional berbasis Node.js + Express + MediaMTX** dengan fitur streaming live, rekaman otomatis, YouTube livestreaming, notifikasi Telegram, dan dashboard responsif.

**Status**: ✅ Production Ready | **Version**: 2.1.0 | **Last Updated**: June 25, 2026

---

## ⚡ QUICK START (Mulai dalam 5 menit!)

### Untuk Linux/Ubuntu/Raspberry Pi:

```bash
# Copy-paste 3 command ini:
git clone https://github.com/alijayanet/cctv-monitoring.git
cd cctv-monitoring
sudo bash install.sh
```

**Selesai! Dashboard siap di:** `http://<server-ip>:3003`

**Login:** `admin / ChangeMe@Secure123456` (ubah password ini!)

---

## 🎯 Fitur Apa Saja? Lihat Daftar Lengkap:

| Fitur | Deskripsi | Status |
|-------|-----------|--------|
| 🖥️ **Dashboard** | Grid view semua camera real-time | ✅ |
| 📡 **HLS Streaming** | Video streaming H.264/H.265 low-latency | ✅ |
| 🎥 **Recording Otomatis** | Simpan video dengan auto-cleanup 30 hari | ✅ |
| 🎬 **YouTube Live** | Stream langsung ke YouTube dengan 1 klik | ✅ |
| 🤖 **Telegram Bot** | Alert kamera offline, disk penuh, status sistem | ✅ |
| ⚙️ **Real-time Settings** | Ubah recording config tanpa restart | ✅ |
| 🔐 **Security** | Input validation, RTSP URL protection, encrypted config | ✅ |
| 📱 **Mobile Responsive** | Desktop, tablet, mobile compatible | ✅ |
| 🔧 **Easy Install** | Automated multi-architecture installer | ✅ |
| 📊 **Activity Log** | Audit trail semua admin actions | ✅ |

---

**Community Support**: Bergabunglah dengan group Telegram kami untuk diskusi, tips, dan shared learning.
👉 https://t.me/alijayaNetAcs

[![Repo](https://img.shields.io/badge/Repository-alijayanet/cctv--monitoring-green?style=for-the-badge&logo=github)](https://github.com/alijayanet/cctv-monitoring)
[![NodeJS](https://img.shields.io/badge/Node.js-20.x-blue?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![MediaMTX](https://img.shields.io/badge/Streaming-MediaMTX-orange?style=for-the-badge&logo=ffmpeg)](https://github.com/bluenviron/mediamtx)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

---

## ✨ Fitur Unggulan (Penjelasan Detail)

### 🖥️ Dashboard Modern & Responsif
```
Live grid view semua camera dalam 1 halaman
├─ Real-time HLS streaming (auto-play di setiap tile)
├─ Status indicator (🟢 ONLINE / 🔴 OFFLINE / 🟡 LOADING)
├─ Recording status untuk setiap camera
├─ Click untuk full-screen view
├─ Mobile-friendly design (auto-responsive untuk tablet, phone)
└─ System status bar (disk usage, CPU, total cameras, recording status)
```

### 📡 HLS Streaming Low-Latency
```
Browser-based video playback (HTTP Live Streaming)
├─ Format: MP4 video codec
├─ Support: H.264 (semua browser) + H.265 (modern browser)
├─ Latency: 2-5 detik (lebih rendah dari streaming tradisional)
├─ Network: UDP atau TCP over HTTP
├─ Quality: Auto-adjust based on bandwidth
└─ Compatible dengan semua browser modern (Chrome, Firefox, Safari, Edge)
```

### 🎥 Recording Otomatis dengan Auto-Cleanup
```
Rekam video 24/7 dengan auto-delete berdasarkan retention policy
├─ Jadwal: Bisa diatur jam mulai & selesai (contoh: 06:00-22:00)
├─ Kualitas: 720p/1080p, 10-30 fps, 400k-1500k bitrate
├─ File Size: Auto-segment per jam/60min (bisa customize)
├─ Auto-cleanup Layer 1: Delete files older than 30 hari (atau custom)
├─ Auto-cleanup Layer 2: Emergency cleanup jika disk >85% (delete oldest)
├─ Auto-cleanup Layer 3: Remove orphan DB entries saat files hilang
└─ Settings: Real-time apply (NO restart needed)
```

### 🎬 YouTube Livestreaming with Auto-Codec Detection
```
Stream langsung ke YouTube dengan 1 klik
├─ Setup: Copy stream key dari YouTube Creator Studio
├─ Quality: Low (480p/1Mbps) | Medium (720p/2.5Mbps) | High (1080p/4Mbps)
├─ Auto-detect: H.264 codec → copy (efficient), H.265 → transcode (high CPU)
├─ Auto-restart: Retry jika koneksi putus (max 5x attempts)
├─ Monitoring: Real-time logs viewer, FFmpeg output visible
├─ Multiple streams: Bisa stream multiple cameras sekaligus
└─ Status: Live indicator di YouTube setelah 10-15 detik
```

### 🤖 Telegram Notifications
```
Automatic alerts via Telegram bot
├─ Events: Kamera offline, disk usage >threshold, system errors
├─ Frequency: Real-time untuk critical events
├─ Format: Formatted messages dengan info lengkap
├─ Config: Telegram bot token + chat ID (setup 3 menit)
└─ Status: Check saat system startup & setiap monitoring cycle
```

### ⚙️ Real-time Configuration (No Restart!)
```
Ubah recording settings langsung di web UI
├─ Recording on/off
├─ Schedule (jam mulai & selesai)
├─ Resolution, FPS, bitrate
├─ Retention policy (auto-delete setelah berapa hari)
├─ Max disk threshold (emergency cleanup level)
└─ Apply: Instant (2-3 detik), no restart needed!
```

### 🔐 Security Features
```
Production-ready security implementation
├─ RTSP URL Validation: Prevent SQL injection, URL manipulation
├─ Input Sanitization: Regex validation untuk semua user inputs
├─ Password Hashing: Encrypted password storage
├─ Session Management: Secure session tokens + timeout
├─ Audit Trail: Activity log semua admin actions
├─ Default Credential Warning: Alert saat startup
└─ Configuration Verification: Auto-check security settings
```

### 📊 Real-time Monitoring
```
Dashboard indicators yang selalu update
├─ Disk usage %: Green (<80%), Yellow (80-90%), Red (>90%)
├─ CPU usage: System load monitoring
├─ Recording status: Active/paused/off
├─ Camera health: Online/offline count
└─ Auto-refresh: Update setiap 10 detik
```

---

## 🛠️ Persyaratan Sistem

### Hardware
- **OS**: Ubuntu 20.04+ / Debian 11+ / Raspberry Pi OS / Armbian
- **RAM**: Minimum 1GB (2GB+ recommended untuk multiple cameras)
- **Disk**: 500MB untuk instalasi, ditambah storage untuk recordings
- **CPU**: ARMv7/ARMv8 (Orange Pi, Raspberry Pi) atau x86_64

### Software
- Node.js v20.x
- FFmpeg (auto-installed)
- MediaMTX (auto-downloaded)
- SQLite3 (included with Node.js)

---

## 🚀 Instalasi Cepat

### Metode 1: Automated Installer (RECOMMENDED - PALING MUDAH) ⭐

Installer otomatis ini adalah cara **paling simple dan aman** untuk menginstall sistem.

**Hanya 3 command:**

```bash
# 1️⃣ Clone repository
git clone https://github.com/alijayanet/cctv-monitoring.git
cd cctv-monitoring

# 2️⃣ Set permission
chmod +x install.sh

# 3️⃣ Jalankan installer (pilih salah satu)
sudo bash install.sh              # Ubuntu/Debian/Raspberry Pi
# ATAU
sudo bash install.sh              # CentOS/Fedora/Armbian
```

**Installer akan otomatis handle (tanpa perlu manual setup):**

| Task | Status |
|------|--------|
| 🔍 Detect OS dan architecture | ✅ Automatic |
| 📦 Install Node.js v20 | ✅ Auto from NodeSource |
| 🎬 Download & configure MediaMTX | ✅ Auto (correct version per arch) |
| 🎥 Install FFmpeg for transcoding | ✅ Auto |
| ⚙️ Generate helper scripts | ✅ Auto (smart_transcode.sh, record_notify.sh) |
| 🔧 Create systemd services | ✅ Auto (auto-restart on boot) |
| 🔒 Setup firewall rules | ✅ Auto (ports: 3003, 8555, 8856, 9123) |
| ✔️ Verify configuration security | ✅ Auto (warns if default credentials) |
| 📊 Initialize database | ✅ Auto (all tables created) |
| 🚀 Start all services | ✅ Auto (cctv-web, mediamtx running) |

**Setelah installer selesai, sistem langsung ready to use!**

```
✅ Dashboard accessible: http://<server-ip>:3003
✅ HLS streaming: http://<server-ip>:8856
✅ Admin login: admin / ChangeMe@Secure123456 (GANTI PASSWORD INI!)
✅ All services auto-start on reboot
```

**Total waktu instalasi:**
- 🔴 **Slow internet + Raspberry Pi**: 20-30 menit
- 🟡 **Medium internet + Orange Pi**: 10-15 menit
- 🟢 **Fast internet + x86_64 PC**: 5-10 menit

---

### Metode 2: Deploy ke Server Remote

Jika sudah ada server di cloud atau jaringan lain:

```bash
# Dari local machine, copy ke server
scp -r cctv-monitoring user@192.168.1.100:/home/user/

# SSH ke server
ssh user@192.168.1.100

# Di server, jalankan installer
cd cctv-monitoring
sudo bash install.sh

# Akses dari browser
# http://192.168.1.100:3003
```

**ATAU gunakan deploy script (untuk automated deployment):**

```bash
# Dari local machine
bash deploy_server.sh 192.168.1.100 user /home/user/cctv-monitoring

# Script akan otomatis:
# ✅ Copy semua files via SCP
# ✅ Run installer di server
# ✅ Start all services
# ✅ Show access URLs
```

---

### Metode 3: Manual Installation (ADVANCED)

Untuk yang mau full kontrol atau development:

```bash
# 1. Update package manager
sudo apt update
sudo apt upgrade -y

# 2. Install core dependencies
sudo apt install -y git curl wget ffmpeg sqlite3 build-essential python3 python3-pip

# 3. Install Node.js v20 (dari NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 4. Clone repository
git clone https://github.com/alijayanet/cctv-monitoring.git
cd cctv-monitoring

# 5. Install npm dependencies
npm install --production

# 6. Download MediaMTX (sesuaikan dengan architecture)
# Lihat: https://github.com/bluenviron/mediamtx/releases
# Contoh untuk Linux x86_64:
wget https://github.com/bluenviron/mediamtx/releases/download/v1.x.x/mediamtx_v1.x.x_linux_amd64.tar.gz
tar -xzf mediamtx_v1.x.x_linux_amd64.tar.gz

# 7. Copy konfigurasi
cp config.json.example config.json
cp mediamtx.yml.example mediamtx.yml

# 8. Create systemd services (buat file service files)
sudo tee /etc/systemd/system/cctv-web.service > /dev/null <<EOF
[Unit]
Description=CCTV Monitoring Web Service
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 9. Enable services
sudo systemctl daemon-reload
sudo systemctl enable cctv-web
sudo systemctl enable mediamtx

# 10. Start services
sudo systemctl start cctv-web
sudo systemctl start mediamtx

# 11. Verify
sudo systemctl status cctv-web
sudo systemctl status mediamtx
curl http://127.0.0.1:3003
```

**Lihat detail lengkap di: `README-INSTALL.md` untuk multi-architecture support**

---

## ⚙️ Konfigurasi Awal (Setelah Installer Selesai)

### Step 1: Edit Password & Security Keys

```bash
# Edit konfigurasi (gunakan nano atau editor favorit)
sudo nano config.json
```

**PENTING: Ubah 3 setting berikut sebelum production:**

```json
{
    "authentication": {
        "username": "admin",
        "password": "ChangeMe@Secure123456"  // ⚠️ WAJIB UBAH! Min 16 char
    },
    "server": {
        "port": 3003,
        "session_secret": "UBAH-INI-RANDOM-32-CHAR-STRING",  // ⚠️ WAJIB UBAH!
        "behind_https_proxy": true,
        "public_base_url": "https://stream.yourdomain.com"
    }
}
```

**Cara generate random session_secret:**
```bash
# Copy salah satu command di bawah:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Atau:
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Paste output ke `config.json` session_secret field.

---

### Step 2: Recording Configuration

**Via Web UI (RECOMMENDED):**

1. Buka: `http://<server-ip>:3003`
2. Login: `admin / <password-baru>`
3. Menu: **Admin → Recordings**
4. Atur settings (lihat penjelasan di bawah)
5. Klik **SIMPAN** → Settings applied instantly (no restart!)

**Penjelasan setiap setting:**

| Setting | Default | Penjelasan | Contoh |
|---------|---------|-----------|--------|
| **Recording Enabled** | ON | Master switch untuk recording | ON/OFF |
| **Schedule Start** | 00:00 | Jam mulai record | 06:00 (jam 6 pagi) |
| **Schedule End** | 23:59 | Jam stop record | 22:00 (jam 10 malam) |
| **Resolution** | 720p | Video quality | 720p/1080p/D1 (360p) |
| **Frame Rate** | 10 fps | Frame per second | 10/15/24/30 |
| **Bitrate** | 400k | Video size per second | 400k/800k/1500k |
| **Segment Duration** | 60m | File size per video | 60m/120m (30m per file = smaller) |
| **Delete After** | 30d | Auto-delete files | 1d/7d/30d/90d |
| **Max Disk %** | 85 | Emergency cleanup level | 80-90 (lower = more frequent cleanup) |

---

### Step 3: MediaMTX Ports & URLs

**Jika sistem behind proxy (Cloudflare, Nginx):**

```json
{
    "mediamtx": {
        "host": "127.0.0.1",
        "api_port": 9123,
        "rtsp_port": 8555,
        "hls_port": 8856,
        "public_hls_url": "https://stream.yourdomain.com"  // ← External URL
    },
    "server": {
        "behind_https_proxy": true,  // ← Enable proxy mode
        "public_base_url": "https://cctv.yourdomain.com"   // ← External URL
    }
}
```

**Port mapping:**
```
Port 8555  → RTSP streaming (camera input)
Port 8856  → HLS streaming (browser playback)
Port 9123  → MediaMTX API (internal control)
Port 3003  → Web dashboard (browser access)
```

---

### Step 4: Telegram Notifications (Optional)

```json
{
    "telegram": {
        "enabled": true,
        "bot_token": "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh",
        "chat_id": "987654321"
    }
}
```

**Cara setup:**
1. Chat dengan @BotFather di Telegram
2. Create bot → copy token
3. Start bot, send message ke bot
4. Get chat_id dari: `https://api.telegram.org/bot<TOKEN>/getUpdates`

---

### Step 5: Verify Installation

**Jalankan command ini untuk verify semuanya jalan:**

```bash
# 1. Check services status
sudo systemctl status cctv-web
sudo systemctl status mediamtx

# 2. Check if ports listening
netstat -tlnp | grep -E '3003|8555|8856|9123'
# Atau:
ss -tlnp | grep -E '3003|8555|8856|9123'

# 3. Test API endpoints
curl http://127.0.0.1:9123/v3/paths/list      # MediaMTX API
curl http://127.0.0.1:3003/admin/login        # Web UI

# 4. Check logs for errors
sudo journalctl -u cctv-web -n 50
sudo journalctl -u mediamtx -n 50

# 5. Browser test
# Open: http://<server-ip>:3003
# Login: admin / <password>
# Should see empty Dashboard
```

**Expected output setelah semua working:**
```
✅ cctv-web service: active (running)
✅ mediamtx service: active (running)
✅ Port 3003: LISTEN (web)
✅ Port 8555: LISTEN (RTSP)
✅ Port 8856: LISTEN (HLS)
✅ Port 9123: LISTEN (API)
✅ Browser: login page shown
```

---

## 📖 Panduan Penggunaan (Lengkap)

### 🎯 First-Time Setup (5 menit)

**Step 1: Access Dashboard**
```
Buka browser: http://<server-ip>:3003
Contoh: http://192.168.1.100:3003
       atau http://cctv-monitoring.local:3003
```

**Step 2: Login**
```
Username: admin
Password: (dari config.json yang sudah diubah)
```

**Step 3: You will see:**
- ✅ Empty Dashboard (karena belum ada camera)
- ✅ Menu Admin Panel di atas
- ✅ Current time & system status

---

### 🎥 Menambah Camera (5 menit per camera)

**Method 1: RTSP URL (Universal - untuk semua IP camera)**

1. **Admin → Cameras → + Tambah Kamera**
   
2. **Isi form:**
   ```
   Nama             : Front Door Camera (atau custom name)
   Lokasi           : Entrance / Gate / Parking lot (atau lokasi lainnya)
   Tipe             : RTSP (pilih dari dropdown)
   URL RTSP         : rtsp://admin:password@192.168.1.100:554/stream
   Latitude (opsional): -6.2 (untuk map marker)
   Longitude (opsional): 110.4 (untuk map marker)
   Level Akses      : public / member / vip / admin
   ```

3. **Klik SIMPAN**

4. **Tunggu 5-10 detik**, camera akan appear di dashboard dengan status:
   ```
   🟢 ONLINE    = Camera connected, streaming aktif
   🔴 OFFLINE   = Camera tidak accessible, check URL & credentials
   🟡 LOADING   = Connecting...
   ```

**Finding RTSP URL untuk camera Anda:**

| Brand | URL Format | Default Credentials |
|-------|-----------|-------------------|
| **Hikvision** | `rtsp://192.168.1.100:554/h264/ch1/main` | admin / 12345 |
| **Dahua** | `rtsp://192.168.1.100:554/stream1` | admin / admin |
| **Uniview (UNV)** | `rtsp://192.168.1.100:554/stream1` | admin / 123456 |
| **TP-Link/Tapo** | `rtsp://192.168.1.100:554/stream1` | admin / admin |
| **Reolink** | `rtsp://192.168.1.100:554/h264Preview_01_main` | admin / admin |
| **Axis** | `rtsp://192.168.1.100:554/axis-media/media.amp` | root / <blank> |
| **Generic** | `rtsp://192.168.1.100:554/stream` | admin / admin |

**Jika tidak tahu URL camera:**
1. Check camera manual atau box
2. Login ke camera web UI → settings → streaming
3. Atau gunakan network scanner: `nmap -p 554 192.168.1.0/24`

---

**Method 2: ONVIF Discovery (Otomatis - untuk camera yang support ONVIF)**

1. **Admin → Cameras → Discover Cameras**
2. System akan scan network untuk camera
3. Pilih camera yang muncul
4. Klik ADD
5. Done!

---

### 📊 Recording Configuration (Real-time)

**Admin → Recordings → Jadwal & Pengaturan Rekaman**

**Fitur Utama:**

| Fitur | Fungsi | Tips |
|-------|--------|------|
| **Recording ON/OFF** | Master switch | OFF = stop semua recording |
| **Schedule** | Jam mulai-selesai | Contoh: 06:00 - 22:00 |
| **Resolution** | Kualitas video | 720p balance, 1080p = lebih detail tapi besar file |
| **Bitrate** | Ukuran file per detik | 800k recommended, lebih tinggi = lebih detail |
| **Delete After** | Auto-cleanup umur file | 30d = delete files > 30 hari otomatis |
| **Max Disk %** | Emergency cleanup | Jika disk >85%, cleanup oldest files |

**Workflow:**
1. Set parameters (resolution, bitrate, schedule)
2. Klik **SIMPAN**
3. **✅ Settings langsung diterapkan** (NO RESTART needed)
4. Check: **Monitor → Disk Usage** untuk verify
5. Recording files akan mulai generate di `./recordings` folder

**Real-time Monitoring:**
```bash
# Check recordings in progress
ls -lh recordings/

# Monitor disk space
df -h /recordings

# Watch logs
sudo journalctl -u cctv-web -f | grep -i record
```

**Cleanup Verification:**
```bash
# Check cleanup events
sudo journalctl -u cctv-web | grep -i cleanup

# Example output:
# [Cleanup] Deleted 5 old recording(s) (< cutoff_date), freed ~240 MB
```

---

### 🎬 YouTube Livestreaming Setup

**Admin → YouTube & Streaming**

**Step-by-Step:**

**1. Get Stream Key dari YouTube:**
   ```
   1. Login: youtube.com
   2. Go to: Creator Studio → Go Live (left menu)
   3. Select: Stream to YouTube
   4. Get: Stream name/key (copy only the key, not full RTMP URL)
   5. Example key: abcd-efgh-ijkl-mnop
   ```

**2. Start Streaming di Web UI:**
   ```
   1. Admin → YouTube & Streaming
   2. Select: Camera (pilih camera mana yang di-stream)
   3. Paste: Stream Key (paste exactly)
   4. Quality: Medium (720p) recommended untuk upload stabil
   5. Click: START
   6. Wait: 5-10 detik untuk connection establish
   7. Status: LIVE ← Stream aktif ke YouTube!
   ```

**3. Monitor Stream:**
   ```
   - Status Badge: Starting → Live → Stopped
   - LOGS Button: Lihat real-time FFmpeg output
   - YouTube: video.youtube.com akan show LIVE indicator
   - Stop: Klik STOP button untuk terminate stream
   ```

**Quality vs Resource:**

| Quality | Resolution | Bitrate | CPU | Bandwidth | Use Case |
|---------|------------|---------|-----|-----------|----------|
| **Low** | 480p | 1 Mbps | Low | 1-2 Mbps | Poor internet, mobile view |
| **Medium** | 720p | 2.5 Mbps | Medium | 2.5-3 Mbps | ⭐ BEST for most use cases |
| **High** | 1080p | 4 Mbps | High | 4-5 Mbps | Good internet, detail needed |
| **Source** | Auto | Variable | Very High | Depends on camera | Professional use |

**Auto-Features:**
- ✅ **Auto-restart**: Jika koneksi putus, otomatis retry (max 5x)
- ✅ **Codec detection**: H.264 → copy (efficient), H.265 → transcode (high CPU)
- ✅ **Bitrate optimization**: Auto-adjust berdasarkan quality pilihan

**Troubleshooting YouTube:**
```
❌ Status: "Starting..." for 30+ seconds
   → Check internet speed (min 2.5 Mbps for 720p)
   → Check firewall not blocking port 1935 (RTMP)
   → Restart streaming

❌ Status: "Failed"
   → Check stream key valid (paste from YouTube, not full URL)
   → Check camera is ONLINE (green status)
   → Check FFmpeg available: Admin → YouTube → Check FFmpeg button

❌ YouTube shows "No connection"
   → Camera might be offline
   → Internet connection issue
   → Check logs: Admin → YouTube → LOGS
```

---

### 📱 Dashboard Features

**Main Dashboard:**
```
┌─────────────────────────────────────┐
│ CCTV Monitoring System              │
├─────────────────────────────────────┤
│ 🎥 Camera Grid                      │
│ ├─ Each camera card shows:          │
│ │  ├─ Live HLS stream (auto-play)   │
│ │  ├─ Camera name & location        │
│ │  ├─ Status (🟢 ONLINE / 🔴 OFFLINE)|
│ │  ├─ Recording indicator           │
│ │  └─ Click to full-screen          │
│                                     │
│ 📊 Bottom Bar:                      │
│ ├─ Disk usage %                     │
│ ├─ System CPU usage                 │
│ ├─ Total cameras count              │
│ └─ Recording status                 │
└─────────────────────────────────────┘
```

**Admin Panel:**
```
├─ Cameras          : Add/edit/delete cameras
├─ Recordings       : Schedule, quality, retention settings
├─ YouTube Stream   : Setup livestreaming to YouTube
├─ Settings         : Site title, Telegram config, security
├─ Activity Log     : Audit trail of all admin actions
└─ Logout           : Logout & clear session
```

---

### 🔧 Manual Control Commands

**Start/Stop/Restart Services:**
```bash
# Status
sudo systemctl status cctv-web
sudo systemctl status mediamtx

# Restart setelah ubah config.json
sudo systemctl restart cctv-web

# View logs real-time
sudo journalctl -u cctv-web -f

# Stop temporary (untuk maintenance)
sudo systemctl stop cctv-web
sudo systemctl stop mediamtx

# Start again
sudo systemctl start cctv-web
sudo systemctl start mediamtx

# Restart after reboot (auto-enabled)
sudo reboot
# Services akan start otomatis setelah reboot
```

---

## 🔐 Security & Best Practices

### ⚠️ PENTING: Ubah Default Credentials

Setelah instalasi, **WAJIB** ubah:

```json
{
    "authentication": {
        "password": "UBAH INI! Minimum 16 chars dengan uppercase, lowercase, numbers"
    },
    "server": {
        "session_secret": "GENERATE RANDOM 32+ CHAR STRING"
    }
}
```

### Validasi Input

✅ **RTSP URL Validation**
- Hanya format `rtsp://...` yang diterima
- Prevent SQL injection & URL manipulation
- Contoh valid:
  ```
  ✅ rtsp://admin:pass@192.168.1.100:554/stream
  ✅ rtsp://camera.local/main
  ✅ rtsp://10.0.0.1:8554/h264_stream
  
  ❌ http://... (wrong protocol)
  ❌ rtsp://'; DROP TABLE;-- (injection)
  ❌ rtsp://very-long-url-exceeding-2000-chars...
  ```

### Configuration Verification

Saat startup, sistem auto-check:
- ✅ Default password masih aktif? → WARNING
- ✅ Session secret masih default? → WARNING
- ✅ config.json valid? → ERROR jika tidak
- ✅ MediaMTX configured? → WARNING jika tidak

### Monitoring & Logs

```bash
# Real-time logs
journalctl -u cctv-web -f

# Check activity log (database)
sqlite3 cameras.db "SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 10;"

# Check recording cleanups
journalctl -u cctv-web | grep -i "cleanup\|delete"

# Export audit trail
sqlite3 cameras.db "SELECT * FROM activity_logs;" > audit_$(date +%Y%m%d).csv
```

---

## ☁️ Remote Access (Cloudflare Tunnel / Reverse Proxy)

### Setup Cloudflare Tunnel

```bash
# 1. Install cloudflared
curl -L --output cloudflared.tgz \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.tgz
tar -xzf cloudflared.tgz

# 2. Login & create tunnel
./cloudflared tunnel login
./cloudflared tunnel create cctv-monitoring

# 3. Configure routes
./cloudflared tunnel route dns cctv-monitoring cctv.yourdomain.com
./cloudflared tunnel route dns stream-monitoring stream.yourdomain.com

# 4. Update config.json
# Set: behind_https_proxy: true
# Set: public_hls_url: https://stream.yourdomain.com

# 5. Start tunnel (systemd recommended)
sudo ./cloudflared tunnel install
sudo ./cloudflared tunnel run cctv-monitoring
```

### Setup Nginx Reverse Proxy

```nginx
# /etc/nginx/sites-available/cctv.conf

upstream cctv_backend {
    server 127.0.0.1:3003;
}

upstream hls_backend {
    server 127.0.0.1:8856;
}

server {
    listen 443 ssl http2;
    server_name stream.yourdomain.com;
    
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    
    location / {
        proxy_pass http://cctv_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    
    location /hls/ {
        proxy_pass http://hls_backend/;
        proxy_buffering off;
    }
}
```

---

## 🐛 Troubleshooting

### Video Hitam / Tidak Muncul

**Penyebab**: H.265 codec tidak support browser

**Solusi**:
1. **Ganti camera ke H.264** (recommended)
   - Masuk setting camera IP
   - Change encoding: H.265 → H.264
   - Restart camera

2. **Enable Smart Transcoding**
   - Config: `video_codec: "h264"`
   - Gunakan `smart_transcode.sh` (auto-enabled di installer)
   - CPU usage akan meningkat

### Recording Tidak Tersimpan

**Check:**
```bash
# 1. Verify storage path exists
ls -la recordings/

# 2. Check config recording settings
grep "recording" config.json

# 3. Monitor MediaMTX
tail -f mediamtx.log

# 4. Check disk space
df -h

# 5. Verify permissions
ls -la recordings/ | head -3
```

### YouTube Stream Fails

**Check:**
```bash
# 1. FFmpeg available?
ffmpeg -version

# 2. Valid stream key?
# - Paste exact key dari YouTube Creator Studio
# - Not the full RTMP URL

# 3. Camera online?
# - Check Admin → Cameras
# - Status harus 🟢 ONLINE

# 4. Check logs
Admin → YouTube → LOGS button
# Lihat untuk errors seperti:
# - "Connection refused"
# - "Invalid RTMP URL"
# - "H.265 detected, transcoding..."
```

### High CPU Usage

**Cause**: H.265 transcoding atau terlalu banyak camera

**Solution**:
```
├─ Reduce resolution: 1080p → 720p
├─ Reduce bitrate: 2500k → 1500k
├─ Reduce FPS: 30 → 15
├─ Use H.264 cameras (avoid H.265)
├─ Stream fewer cameras
└─ Upgrade hardware (CPU/RAM)
```

### Storage Full

**Automatic Cleanup Check:**
```bash
# 1. Verify delete_after setting
grep "delete_after" config.json

# 2. Check cleanup logs
journalctl -u cctv-web | grep cleanup

# 3. Manual cleanup (force)
# Admin → Recordings → Set delete_after to "1d"
# Klik SIMPAN → will cleanup immediately

# 4. Check database
sqlite3 cameras.db "SELECT COUNT(*) FROM recordings;"
sqlite3 cameras.db "SELECT created_at FROM recordings ORDER BY created_at ASC LIMIT 5;"
```

---

## 📊 Performance Tuning

### Database Optimization (Already Applied)
```sql
PRAGMA journal_mode=WAL;      -- Write-Ahead Logging
PRAGMA synchronous=NORMAL;    -- Balance safety & speed
PRAGMA cache_size=-8000;      -- 8MB cache
PRAGMA busy_timeout=5000;     -- Wait 5s before lock
PRAGMA mmap_size=30000000;    -- Memory-mapped I/O
```

### Recording Settings untuk Different Scenarios

```
Light Usage (1-2 cameras, home):
  resolution: 720p
  bitrate: 400k
  delete_after: 7d
  max_storage_percent: 90

Medium Usage (3-5 cameras, business):
  resolution: 720p
  bitrate: 800k
  delete_after: 30d
  max_storage_percent: 85

Heavy Usage (6+ cameras, critical):
  resolution: 1080p
  bitrate: 1500k
  delete_after: 90d
  max_storage_percent: 80
```

---

## 🔄 Updates & Maintenance

### Check for Updates

```bash
cd cctv-monitoring
git fetch origin
git log --oneline -5

# Update jika ada perubahan
git pull origin main
npm install
systemctl restart cctv-web
```

### Backup Important Data

```bash
# Backup database
cp cameras.db cameras.db.backup

# Backup config
cp config.json config.json.backup

# Backup recordings (if critical)
tar -czf recordings_backup_$(date +%Y%m%d).tar.gz recordings/
```

### Clean Old Logs

```bash
# Activity logs (automated every 6 hours, keeps 90 days)
# Manual cleanup:
sqlite3 cameras.db "DELETE FROM activity_logs WHERE timestamp < datetime('now', '-90 days');"

# Stream logs
rm -f stream_logs/camera_*.log
```

---

## 📞 Support & Community

- **Telegram Group**: https://t.me/alijayaNetAcs
- **GitHub Issues**: https://github.com/alijayanet/cctv-monitoring/issues
- **Website**: https://alijaya.net
- **WhatsApp Support**: +62-819-4721-5703

---

## 📝 Changelog (v2.x)

### Version 2.1.0 (June 2026)
- ✅ Real-time recording settings (no restart needed)
- ✅ RTSP URL validation & SQL injection prevention
- ✅ Configuration security validation at startup
- ✅ Alert system tables & migrations
- ✅ Improved activity logging for audit trail
- ✅ Better error handling & error responses
- ✅ Deploy script security fixes (removed hardcoded credentials)
- ✅ Enhanced installer with config verification

### Version 2.0.0
- 🎬 YouTube livestreaming with auto-codec detection
- 🤖 Telegram bot notifications
- 📊 Real-time disk monitoring & auto-cleanup
- ⚡ HLS streaming support
- 🔄 Smart transcoding (H.264/H.265)

---

## ⚖️ Lisensi

Distributed under the **MIT License**. Lihat [`LICENSE`](LICENSE) untuk informasi lengkap.

---

## 🙏 Credits

Built with ❤️ by **ALIJAYA-NET** 🇮🇩

Terimakasih kepada:
- [MediaMTX](https://github.com/bluenviron/mediamtx) - Streaming server
- [Node.js](https://nodejs.org) - Runtime
- [FFmpeg](https://ffmpeg.org) - Video processing
- Community testers & contributors

---

**Status**: Production Ready ✅
**Last Updated**: June 25, 2026
**Maintained**: Active 🚀

