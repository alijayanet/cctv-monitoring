/**
 * utils/storage.js
 * External Storage Manager — list, mount, unmount, dan set rekaman path
 * Mendukung ext4, exFAT, NTFS, FAT32
 * Ubuntu/Debian & Armbian (Orange Pi, Raspberry Pi)
 */

'use strict';

const { execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const MOUNT_BASE = '/mnt/cctv-storage';

// Partisi sistem yang tidak boleh di-unmount
const SYSTEM_MOUNTPOINTS = ['/', '/boot', '/boot/efi', '/home', '/usr', '/var', '/tmp', '/run'];
const SYSTEM_DEVICES_PREFIX = ['loop', 'zram'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runCmd(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr || err.message));
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

function runSudo(cmd, args, opts = {}) {
    return runCmd('sudo', ['-n', cmd, ...args], opts);
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function isSystemDevice(name) {
    return SYSTEM_DEVICES_PREFIX.some(p => name.startsWith(p));
}

function isSystemPartition(mountpoint) {
    if (!mountpoint) return false;
    return SYSTEM_MOUNTPOINTS.includes(mountpoint) ||
        mountpoint.startsWith('/boot') ||
        mountpoint.startsWith('/sys') ||
        mountpoint.startsWith('/proc') ||
        mountpoint.startsWith('/dev');
}

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Daftar semua disk & partisi yang ada di sistem.
 * Return array of disk objects.
 */
async function listDisks() {
    let rawOutput;
    try {
        rawOutput = await runCmd('lsblk', [
            '-J', '-b',
            '-o', 'NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINT,UUID,VENDOR,MODEL,HOTPLUG,RM,RO,PATH'
        ]);
    } catch (e) {
        throw new Error('lsblk tidak tersedia atau gagal: ' + e.message);
    }

    let parsed;
    try {
        parsed = JSON.parse(rawOutput);
    } catch (e) {
        throw new Error('Gagal parse output lsblk: ' + e.message);
    }

    const disks = [];

    function processDevice(dev, parentName) {
        const name = dev.name || '';
        const type = dev.type || '';
        const mountpoint = dev.mountpoint || dev.mountpoints?.[0] || null;
        const fstype = dev.fstype || null;
        const size = parseInt(dev.size) || 0;
        const isRemovable = dev.rm === true || dev.rm === '1' || dev.hotplug === true || dev.hotplug === '1';
        const isReadOnly = dev.ro === true || dev.ro === '1';
        const label = dev.label || null;
        const uuid = dev.uuid || null;
        const vendor = (dev.vendor || '').trim();
        const model = (dev.model || '').trim();
        const devicePath = dev.path || `/dev/${name}`;

        // Skip loop, zram, system block devices
        if (isSystemDevice(name)) return;
        if (type === 'rom') return;
        if (isSystemPartition(mountpoint)) return;
        if (isReadOnly) return;

        // Hitung disk usage jika sudah ter-mount
        let usage = null;
        if (mountpoint && !isSystemPartition(mountpoint)) {
            try {
                const dfOut = require('child_process').execSync(
                    `df -B1 "${mountpoint}" 2>/dev/null | tail -n +2`,
                    { timeout: 5000, encoding: 'utf8' }
                ).trim();
                if (dfOut) {
                    const parts = dfOut.split(/\s+/);
                    if (parts.length >= 5) {
                        const total = parseInt(parts[1]) || 0;
                        const used = parseInt(parts[2]) || 0;
                        const free = parseInt(parts[3]) || 0;
                        const percent = parseInt(parts[4]) || 0;
                        usage = {
                            total: formatBytes(total),
                            used: formatBytes(used),
                            free: formatBytes(free),
                            percent,
                            totalRaw: total,
                            usedRaw: used,
                            freeRaw: free
                        };
                    }
                }
            } catch (e) { }
        }

        const diskObj = {
            name,
            devicePath,
            type,
            fstype,
            label,
            uuid,
            size: formatBytes(size),
            sizeRaw: size,
            mountpoint,
            isMounted: !!mountpoint,
            isSystem: isSystemPartition(mountpoint),
            isRemovable,
            vendor,
            model,
            displayName: label || model || vendor || name,
            usage
        };

        if (type === 'disk' || type === 'part' || type === 'lvm') {
            disks.push(diskObj);
        }

        // Proses children (partisi)
        if (dev.children && Array.isArray(dev.children)) {
            dev.children.forEach(child => processDevice(child, name));
        }
    }

    (parsed.blockdevices || []).forEach(dev => processDevice(dev, null));

    // Sort: removable/external dulu, baru internal
    disks.sort((a, b) => {
        if (a.isRemovable && !b.isRemovable) return -1;
        if (!a.isRemovable && b.isRemovable) return 1;
        return a.name.localeCompare(b.name);
    });

    return disks;
}

/**
 * Mount sebuah partisi ke /mnt/cctv-storage/<mountName>
 * @param {string} devicePath - contoh /dev/sda1
 * @param {string} mountName  - nama folder mount, contoh "usb_samsung"
 * @param {string} fstype     - ext4 | vfat | ntfs | exfat (auto-detect jika kosong)
 * @param {string} currentUser - user yang harus jadi owner
 */
async function mountDisk(devicePath, mountName, fstype, currentUser) {
    // Validasi device path
    if (!devicePath || !devicePath.startsWith('/dev/')) {
        throw new Error('Device path tidak valid: ' + devicePath);
    }

    // Sanitasi mount name — hanya alfanumerik dan underscore/dash
    const safeName = (mountName || 'storage').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 32);
    const mountPoint = path.join(MOUNT_BASE, safeName);

    // Buat direktori mount point
    if (!fs.existsSync(mountPoint)) {
        await runSudo('mkdir', ['-p', mountPoint]);
    }

    // Tentukan opsi mount berdasarkan fstype
    let mountArgs = [devicePath, mountPoint];
    if (fstype) {
        mountArgs = ['-t', fstype, ...mountArgs];

        // Tambahkan opsi khusus per filesystem
        if (fstype === 'ntfs' || fstype === 'ntfs-3g') {
            mountArgs = ['-t', 'ntfs-3g', devicePath, mountPoint,
                '-o', `uid=${currentUser || 1000},gid=${currentUser || 1000},umask=002,rw`];
        } else if (fstype === 'vfat' || fstype === 'fat32') {
            mountArgs = ['-t', 'vfat', devicePath, mountPoint,
                '-o', `uid=1000,gid=1000,umask=002,rw,utf8`];
        } else if (fstype === 'exfat') {
            mountArgs = ['-t', 'exfat', devicePath, mountPoint,
                '-o', `uid=1000,gid=1000,umask=002,rw`];
        } else if (fstype === 'ext4' || fstype === 'ext3' || fstype === 'ext2') {
            mountArgs = [devicePath, mountPoint];
        }
    }

    await runSudo('mount', mountArgs);

    // Fix permissions agar service bisa nulis
    try {
        await runSudo('chown', ['-R', `${currentUser || ''}:${currentUser || ''}`, mountPoint]);
        await runSudo('chmod', ['775', mountPoint]);
    } catch (e) {
        // Tidak fatal jika gagal (NTFS tidak support chown)
        console.warn('[Storage] chown gagal (mungkin NTFS):', e.message);
    }

    return { success: true, mountPoint };
}

/**
 * Unmount sebuah mount point
 * @param {string} mountPoint - path yang mau di-unmount
 */
async function unmountDisk(mountPoint) {
    // Keamanan: hanya boleh unmount dari /mnt/cctv-storage/
    if (!mountPoint.startsWith(MOUNT_BASE)) {
        throw new Error('Hanya bisa unmount dari ' + MOUNT_BASE);
    }

    await runSudo('umount', ['-l', mountPoint]);
    return { success: true };
}

/**
 * Set path rekaman ke direktori baru.
 * Update config.json dan mediamtx.yml jika ada.
 * @param {string} newRecordingsPath - path absolut folder rekaman
 * @param {string} appDir            - directory root aplikasi
 */
async function setRecordingsPath(newRecordingsPath, appDir) {
    const configPath = path.join(appDir, 'config.json');
    const mediamtxPath = path.join(appDir, 'mediamtx.yml');

    // Buat subfolder recordings di path baru
    const targetPath = path.join(newRecordingsPath, 'recordings');
    if (!fs.existsSync(targetPath)) {
        // Coba dengan sudo (untuk external storage / mount point)
        try {
            await runSudo('mkdir', ['-p', targetPath]);
        } catch (e) {
            // Fallback ke fs biasa (untuk path lokal)
            try {
                fs.mkdirSync(targetPath, { recursive: true });
            } catch (e2) {
                throw new Error('Gagal membuat folder recordings: ' + e2.message);
            }
        }
    }

    // Set permission agar MediaMTX bisa menulis rekaman
    try {
        await runSudo('chmod', ['777', targetPath]);
    } catch (e) {
        // Abaikan jika chmod gagal (mungkin path lokal)
    }

    // Update config.json — simpan path baru sebagai custom_recordings_path
    let cfg = {};
    try {
        cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        throw new Error('Gagal membaca config.json: ' + e.message);
    }

    cfg.recording = cfg.recording || {};
    cfg.recording.custom_recordings_path = targetPath;

    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 4), 'utf8');

    // Update mediamtx.yml — patch recordPath
    if (fs.existsSync(mediamtxPath)) {
        let yml = fs.readFileSync(mediamtxPath, 'utf8');
        const recordPathLine = `  recordPath: ${targetPath}/%path/%Y-%m-%d_%H-%M-%S.mp4`;
        yml = yml.replace(/^\s*recordPath:.+$/m, recordPathLine);
        fs.writeFileSync(mediamtxPath, yml, 'utf8');
    }

    return { success: true, path: targetPath };
}

/**
 * Tambahkan disk ke /etc/fstab untuk auto-mount saat boot.
 * @param {string} uuid       - UUID partisi
 * @param {string} mountPoint - target mount point
 * @param {string} fstype     - filesystem type
 */
async function addToFstab(uuid, mountPoint, fstype) {
    if (!uuid || !mountPoint) throw new Error('UUID dan mountPoint wajib diisi');
    if (!mountPoint.startsWith(MOUNT_BASE)) throw new Error('Mount point tidak aman');

    // Cek apakah sudah ada di fstab
    const fstab = fs.readFileSync('/etc/fstab', 'utf8');
    if (fstab.includes(uuid)) {
        return { success: true, alreadyExists: true };
    }

    // Tentukan opsi mount
    let options = 'defaults,nofail,x-systemd.automount';
    if (fstype === 'ntfs' || fstype === 'ntfs-3g') {
        options = 'uid=1000,gid=1000,umask=002,nofail';
    } else if (fstype === 'vfat' || fstype === 'exfat') {
        options = 'uid=1000,gid=1000,umask=002,nofail,utf8';
    }

    const fstabEntry = `\nUUID=${uuid} ${mountPoint} ${fstype} ${options} 0 0\n`;

    // Tulis ke fstab menggunakan tee (agar bisa sudo)
    await runSudo('bash', ['-c', `echo '${fstabEntry.trim()}' >> /etc/fstab`]);

    return { success: true };
}

/**
 * Hapus disk dari /etc/fstab berdasarkan UUID.
 */
async function removeFromFstab(uuid) {
    if (!uuid) throw new Error('UUID wajib diisi');
    await runSudo('sed', ['-i', `/UUID=${uuid}/d`, '/etc/fstab']);
    return { success: true };
}

/**
 * Cek apakah filesystem yang dibutuhkan sudah terinstall.
 * Return daftar paket yang perlu diinstall.
 */
async function checkFsSupport() {
    // Di Windows tidak relevan, kembalikan supported langsung
    if (process.platform !== 'linux') {
        return { supported: true, missing: [] };
    }

    const checks = {
        ntfs: { binary: 'ntfs-3g', package: 'ntfs-3g' },
        exfat: { binary: 'mount.exfat', package: 'exfat-fuse' },
    };

    const missing = [];
    for (const [fs, info] of Object.entries(checks)) {
        try {
            await runCmd('which', [info.binary]);
        } catch (e) {
            missing.push({ fs, package: info.package });
        }
    }

    return { supported: missing.length === 0, missing };
}

/**
 * Install paket filesystem yang dibutuhkan.
 */
async function installFsPackages(packages) {
    if (process.platform !== 'linux') {
        throw new Error('Install paket hanya bisa di Linux');
    }
    const pkgList = packages.join(' ');
    return new Promise((resolve, reject) => {
        exec(`sudo apt-get install -y ${pkgList}`, { timeout: 120000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve({ success: true });
        });
    });
}

module.exports = {
    listDisks,
    mountDisk,
    unmountDisk,
    setRecordingsPath,
    addToFstab,
    removeFromFstab,
    checkFsSupport,
    installFsPackages,
    MOUNT_BASE,
    formatBytes
};
