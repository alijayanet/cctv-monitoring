# Akses Publik via Cloudflare (HTTPS)

Jika aplikasi diakses publik lewat **Cloudflare** (atau reverse proxy HTTPS lain), dashboard publik bisa normal tetapi **login Admin tidak jalan** (session hilang, selalu redirect ke login). Penyebab umum: cookie session tidak dikirim/diterima dengan benar di HTTPS.

## Perbaikan yang sudah diterapkan

1. **Trust proxy**  
   Aplikasi memakai `app.set('trust proxy', 1)` sehingga Express mempercayai header `X-Forwarded-Proto` dan `X-Forwarded-For` dari Cloudflare.

2. **Cookie session untuk HTTPS**  
   Jika `config.json` → `server.behind_https_proxy` = `true`:
   - Cookie session memakai flag **Secure** (hanya dikirim lewat HTTPS).
   - **SameSite: lax** agar cookie ikut pada navigasi same-site (mis. redirect dari `/login` ke `/admin`).

## Yang perlu Anda lakukan

1. **Aktifkan opsi proxy HTTPS di config**  
   Di `config.json`, pastikan:

   ```json
   "server": {
       "port": 3003,
       "session_secret": "cctv-secret-key-change-me",
       "behind_https_proxy": true
   }
   ```

2. **Restart aplikasi**  
   Setelah mengubah config, restart Node (atau service `cctv-web`).

3. **Akses lewat HTTPS**  
   Buka situs lewat domain yang diproteksi Cloudflare (mis. `https://cctv.domain.com`), lalu coba login Admin lagi.

## Jika masih bermasalah

- Pastikan di Cloudflare **SSL/TLS** set ke “Full” atau “Full (strict)” (bukan “Flexible” saja di sisi Anda jika backend juga HTTPS).
- Pastikan tidak ada rule di Cloudflare yang mengubah atau menghapus cookie.
- Coba buka `/admin` dan `/login` di tab **Incognito/Private** (tanpa ekstensi) untuk memastikan bukan cache atau ekstensi yang menghapus cookie.
