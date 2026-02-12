# Cara Agar Playback Rekaman Tidak Blank/Hitam (H.264)

Video hitam di browser biasanya karena **rekaman H.265/HEVC** yang tidak didukung browser. Supaya **tidak blank hitam**, rekaman harus **H.264**. Ada dua cara:

---

## 1. Ubah Kamera ke H.264 (Paling Mudah)

Ini cara paling sederhana dan tidak butuh transcode di server.

1. Buka **web UI kamera** (browser → `http://IP-kamera`).
2. Masuk ke menu **Video / Encode / Stream** (nama menu tergantung merek).
3. Cari pengaturan **Video Codec / Encoding**.
4. Pilih **H.264** (bukan H.265/HEVC).
5. Simpan. Biarkan sistem merekam lagi beberapa menit.

**Hasil:** Rekaman baru akan H.264 dan **bisa diputar di browser** (Arsip Rekaman / Admin Recordings). Rekaman lama yang H.265 tetap hitam di browser (bisa diputar di VLC).

---

## 2. Pakai Smart Transcode di Server (Ubuntu)

Jika kamera **tidak bisa** diubah ke H.264, pakai **Smart Transcode** di Ubuntu:

- Stream dari kamera (H.265) → **ditranscode ke H.264** oleh server.
- **Live view** dan **rekaman** pakai stream H.264 → **tidak blank hitam**.

Aplikasi ini sudah mengatur:

- **Default path:** `record: false` → path `cam_X_input` (raw) **tidak direkam**.
- **Path transcoded:** `cam_X` (H.264) **direkam** jika jadwal rekaman ON.
- Saat **start**, Node memanggil API MediaMTX untuk set:
  - `runOnReady`: skrip smart transcode (Linux: `./smart_transcode.sh`).
  - `runOnRecordSegmentComplete`: skrip notifikasi (Linux: `./record_notify.sh`).

### Langkah di Ubuntu

1. **Pasang FFmpeg** (jika belum):
   ```bash
   sudo apt update
   sudo apt install ffmpeg -y
   ```

2. **Pastikan skrip bisa dijalankan** (biasanya sudah setelah `install_ubuntu.sh`):
   ```bash
   chmod +x smart_transcode.sh record_notify.sh
   ```

3. **Restart layanan** agar Node mengirim konfigurasi ke MediaMTX:
   ```bash
   sudo systemctl restart mediamtx cctv-web
   ```

4. **Aktifkan rekaman** di Admin → Jadwal Rekaman → Status **Master ON**, lalu simpan.

5. **Tunggu beberapa menit** sampai ada segmen rekaman baru. Rekaman baru akan dari path **H.264** (`cam_X`) dan **bisa diputar di browser**.

### Catatan Smart Transcode

- **runOnReady** di-set oleh **aplikasi Node** saat start (bukan dari isi `mediamtx.yml`).
- Rekaman disimpan di folder `recordings/cam_1/` (bukan `cam_1_input/`).
- Notifikasi rekaman tetap ke `/api/recordings/notify`; camera_id diambil dari nama path (`cam_1` → id 1).

---

## Ringkasan

| Cara | Kelebihan | Kekurangan |
|------|-----------|------------|
| **Kamera H.264** | Tidak butuh CPU server, kualitas asli | Harus bisa ubah setting kamera |
| **Smart Transcode** | Kamera tetap H.265, playback H.264 | Butuh FFmpeg, CPU untuk transcode |

**Rekaman yang sudah ada (H.265)** tetap hitam di browser; bisa diputar di **VLC** atau hapus lalu biarkan sistem merekam ulang dengan H.264.
