# 📹 CCTV Monitoring System 🚀
![cctv monitoring Hero](/public/cctv7.png)

A powerful, lightweight, and modern web application for real-time CCTV monitoring. Designed specifically for single-board computers like **Orange Pi**, **Raspberry Pi**, or any Ubuntu/Debian server.

[![Repo](https://img.shields.io/badge/Repository-alijayanet/cctv--monitoring-green?style=for-the-badge&logo=github)](https://github.com/alijayanet/cctv-monitoring)
[![NodeJS](https://img.shields.io/badge/Node.js-20.x-blue?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![MediaMTX](https://img.shields.io/badge/Streaming-MediaMTX-orange?style=for-the-badge&logo=ffmpeg)](https://github.com/bluenviron/mediamtx)

---
https://cctv.alijaya.com
## ✨ Fitur Unggulan

*   🖥️ **Modern Dashboard**: Tampilan grid yang responsif dan elegan untuk melihat semua kamera sekaligus.
*   ⚡ **HLS Streaming**: Streaming rendah latensi menggunakan standar HLS yang kompatibel dengan semua browser modern.
*   ⚙️ **Panel Admin Terpusat**: Kelola data kamera (CRUD), pengaturan situs, dan jadwal rekaman melalui antarmuka web.
*   🎥 **Fitur Rekaman Otomatis**: Simpan rekaman CCTV berdasarkan jadwal waktu yang dapat dikonfigurasi.
*   🤖 **Bot Notifikasi Telegram**: Dapatkan laporan status kamera (Online/Offline) dan peringatan penyimpanan langsung ke HP Anda.
*   🔄 **Smart Transcoding**: Otomatis mendeteksi codec (H.264/H.265) dan melakukan konversi jika diperlukan agar bisa tampil di browser.
*   📊 **Monitoring Disk**: Pantau sisa kapasitas penyimpanan secara real-time.

---

## 🛠️ Persyaratan Sistem

-   **OS**: Ubuntu 20.04+ / Debian 11+
-   **Hardware**: Min. RAM 1GB (Orange Pi 3 LTS / Raspberry Pi 4 direkomendasikan)
-   **Environment**: Node.js v20.x, FFmpeg, SQLite3

---

## 🚀 Cara Install (One-Step Installer)

Kami telah menyediakan skrip instalasi otomatis untuk memudahkan Anda.

```bash
# 1. Clone Repositori
git clone https://github.com/alijayanet/cctv-monitoring.git
cd cctv-monitoring

# 2. Beri Izin Eksekusi
chmod +x install_ubuntu.sh

# 3. Jalankan Installer
./install_ubuntu.sh
```

Skrip ini akan otomatis menginstal **Node.js, FFmpeg, MediaMTX**, serta mengkonfigurasi **Systemd Service** agar aplikasi berjalan otomatis saat booting.

---

## ⚙️ Konfigurasi Manual

Jika Anda ingin melakukan penyesuaian manual, edit file `config.json`:

| Key | Deskripsi | Default |
| :--- | :--- | :--- |
| `server.port` | Port aplikasi web | `3003` |
| `authentication` | Username & Password Admin | `admin` / `admin123` |
| `mediamtx.host` | Alamat MediaMTX API | `127.0.0.1` |
| `mediamtx.public_hls_url` | URL Publik untuk HLS (Opsional) | `""` |
| `recording` | Pengaturan jadwal simpan video | `00:00 - 23:59` |

---

## ☁️ Konfigurasi Cloudflare Tunnel (Akses Luar Jaringan)

Karena aplikasi ini menggunakan dua port (Web UI di 3003 dan HLS di 8856), Anda perlu mengonfigurasi dua Public Hostname di Cloudflare Zero Trust:

1.  **Dashboard Utama**: Buat Hostname (misal: `cctv.domain.com`) arahkan ke `http://localhost:3003`.
2.  **Streaming HLS**: Buat Hostname (misal: `stream.domain.com`) arahkan ke `http://localhost:8856`.
3.  **Koneksi Aplikasi**:
    *   Buka **Admin Panel** > **Konfigurasi MediaMTX**.
    *   Isi kolom **Public HLS URL** dengan `https://stream.domain.com`.
    *   Simpan pengaturan.

Sekarang dashboard Anda dapat diakses dari mana saja tanpa perlu membuka port forwarding di router.

---

## 📖 Cara Penggunaan

1.  **Akses Dashboard**: Buka browser dan ketik `http://ip-server:3003`.
2.  **Masuk ke Admin**: Klik menu **Login** (User: `admin`, Pass: `admin123`).
3.  **Tambah Kamera**: Masukkan Nama, Lokasi, dan URL RTSP kamera Anda (contoh: `rtsp://user:pass@192.168.1.10:554/stream1`).
4.  **Tunggu Sinkronisasi**: Sistem akan mendaftarkan kamera ke MediaMTX secara otomatis dalam hitungan detik.

---

## ⚠️ Troubleshooting: Video Hitam/Loading?

Jika video tidak muncul namun status kamera **ONLINE**, biasanya disebabkan oleh Codec **H.265 (HEVC)** yang tidak didukug browser.

**Solusi:**
1.  **Ganti ke H.264**: Masuk ke setting IP Cam Anda dan ubah encoding video ke **H.264**. Ini adalah cara termudah dan paling efisien.
2.  **Gunakan Smart Transcode**: Jika tidak bisa ganti codec, project ini sudah dilengkapi skrip `smart_transcode.sh` yang akan mengonversi stream secara otomatis (membutuhkan CPU lebih stabil).

---

## 📞 Hubungi Kami

Butuh bantuan instalasi, custom fitur, atau dukungan teknis? Silakan hubungi:

🛡️ **Admin Support & Info**
-   **WhatsApp**: [081947215703](https://wa.me/6281947215703)
-   **Website**: [alijaya.net](https://alijaya.net)

---

## ⚖️ Lisensi

Distributed under the **MIT License**. Lihat `LICENSE` untuk informasi lebih lanjut.

---
Built with ❤️ by **ALIJAYA-NET** 🇮🇩
![Image](https://github.com/user-attachments/assets/724e5ac2-626e-4f2d-bd1f-1265b70b544f)

