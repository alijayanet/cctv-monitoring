@echo off
chcp 65001 >nul
title Deploy CCTV Monitoring - Upload ke Server
cls

echo ============================================
echo   Deploy CCTV Monitoring Optimizations
echo   Target: root@192.168.1.75:3000
echo ============================================
echo.

set SERVER_IP=192.168.1.75
set REMOTE_DIR=/home/goo/cctv-monitoring

:: Butuh plink.exe (dari PuTTY) dan pscp.exe untuk SCP
:: Download: https://www.chiark.greenend.org.uk/~sgtatham/putty/latest.html

echo [1/4] Creating directories on server...
plink -ssh root@%SERVER_IP% -pw p0s#Kaml1ng "mkdir -p %REMOTE_DIR%/services %REMOTE_DIR%/middleware %REMOTE_DIR%/migrations"

echo [2/4] Uploading files...
echo   -> Uploading database.js
pscp -scp -pw p0s#Kaml1ng database.js root@%SERVER_IP%:%REMOTE_DIR%/

echo   -> Uploading services/permission.js
pscp -scp -pw p0s#Kaml1ng services/permission.js root@%SERVER_IP%:%REMOTE_DIR%/services/

echo   -> Uploading services/configManager.js
pscp -scp -pw p0s#Kaml1ng services/configManager.js root@%SERVER_IP%:%REMOTE_DIR%/services/

echo   -> Uploading middleware/permission.js
pscp -scp -pw p0s#Kaml1ng middleware/permission.js root@%SERVER_IP%:%REMOTE_DIR%/middleware/

echo   -> Uploading migrations/migrate.js
pscp -scp -pw p0s#Kaml1ng migrations/migrate.js root@%SERVER_IP%:%REMOTE_DIR%/migrations/

echo   -> Uploading ai-engine/database.py
pscp -scp -pw p0s#Kaml1ng ai-engine/database.py root@%SERVER_IP%:%REMOTE_DIR%/ai-engine/

echo [3/4] Verifying files on server...
plink -ssh root@%SERVER_IP% -pw p0s#Kaml1ng "ls -la %REMOTE_DIR%/database.js %REMOTE_DIR%/services/ %REMOTE_DIR%/middleware/ %REMOTE_DIR%/migrations/migrate.js %REMOTE_DIR%/ai-engine/database.py"

echo [4/4] Restarting services...
echo   -> Restarting cctv-web...
plink -ssh root@%SERVER_IP% -pw p0s#Kaml1ng "systemctl restart cctv-web"
echo   -> Restarting ai-engine...
plink -ssh root@%SERVER_IP% -pw p0s#Kaml1ng "systemctl restart ai-engine"

echo.
echo ============================================
echo   ✅ Deploy Selesai!
echo.
echo   File yang diupload:
echo     - database.js          (WAL mode + optimasi SQLite)
echo     - services/permission.js (Service permission reusable)
echo     - services/configManager.js (Config atomic write)
echo     - middleware/permission.js  (Middleware permission)
echo     - migrations/migrate.js     (Migration system)
echo     - ai-engine/database.py     (Connection pool AI)
echo.
echo   Services restarted: cctv-web, ai-engine
echo ============================================
pause