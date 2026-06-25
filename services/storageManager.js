/**
 * Storage Manager Service
 * Mengelola penyimpanan rekaman - internal & eksternal (USB HDD/SSD)
 * Fitur: auto-detect, mount/unmount, explore directory
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');

const isWin = process.platform === 'win32';
const RECORDINGS_DIR = path.resolve(__dirname, '..', 'recordings');
const STORAGE_CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');

/**
 * Scan available storage devices
 * @returns {Promise<Array>} List of storage devices
 */
async function scanStorageDevices() {
    const devices = [];
    
    // Add internal storage as default
    devices.push({
        id: 'internal',
        name: 'Internal Storage',
        path: RECORDINGS_DIR,
        type: 'internal',
        isActive: true,
        ...await getDiskInfo(RECORDINGS_DIR)
    });
    
    if (isWin) {
        // Windows: scan drive letters D:, E:, F:, etc
        const drives = await getWindowsDrives();
        drives.forEach(d => {
            if (d.toUpperCase() !== process.env.SystemDrive?.toUpperCase()) {
                devices.push({
                    id: `usb_${d[0].toLowerCase()}`,
                    name: `Drive ${d}`,
                    path: `${d}recordings`,
                    type: 'external',
                    isMounted: true,
                    isActive: false
                });
            }
        });
    } else {
        // Linux: check /media, /mnt, /run/media
        const mountPoints = ['/media', '/mnt', `/run/media/${os.hostname()}`];
        mountPoints.forEach(mp => {
            try {
                if (fs.existsSync(mp)) {
                    const items = fs.readdirSync(mp);
                    items.forEach(item => {
                        const fullPath = path.join(mp, item);
                        try {
                            if (fs.statSync(fullPath).isDirectory()) {
                                devices.push({
                                    id: `usb_${item}`,
                                    name: item,
                                    path: fullPath,
                                    type: 'external',
                                    isMounted: true,
                                    isActive: false
                                });
                            }
                        } catch (e) {}
                    });
                }
            } catch (e) {}
        });

        // Also check lsblk for detailed info
        try {
            const lsblk = await execPromise('lsblk -o NAME,SIZE,TYPE,MOUNTPOINT,LABEL,FSTYPE -J');
            const data = JSON.parse(lsblk);
            if (data.blockdevices) {
                data.blockdevices.forEach(dev => {
                    if (dev.children) {
                        dev.children.forEach(part => {
                            if (part.mountpoint && 
                                (part.fstype === 'vfat' || part.fstype === 'ntfs' || 
                                 part.fstype === 'ext4' || part.fstype === 'exfat') &&
                                part.mountpoint !== '/' &&
                                !part.mountpoint.startsWith('/boot')) {
                                
                                const existing = devices.find(d => d.path === part.mountpoint);
                                if (existing) {
                                    existing.size = part.size || 'Unknown';
                                    existing.fstype = part.fstype || '';
                                    existing.label = part.label || part.name || 'USB Drive';
                                    existing.name = part.label || `${part.name} (${part.size})`;
                                }
                            }
                        });
                    }
                });
            }
        } catch (e) {}
    }
    
    return devices;
}

/**
 * Get disk usage info for a path
 */
function getDiskInfo(targetPath) {
    return new Promise((resolve) => {
        try {
            if (!fs.existsSync(targetPath)) {
                fs.mkdirSync(targetPath, { recursive: true });
            }
            
            if (isWin) {
                const drive = path.parse(targetPath).root;
                exec(`wmic logicaldisk where DeviceID="${drive.replace('\\', '\\\\')}" get Size,FreeSpace /value`, (err, stdout) => {
                    if (err) return resolve({ total: 'Unknown', used: 'Unknown', free: 'Unknown', percent: 0 });
                    const kv = {};
                    stdout.split('\n').forEach(line => {
                        const [k, v] = line.split('=');
                        if (k && v) kv[k.trim()] = v.trim();
                    });
                    const total = parseInt(kv.Size) || 0;
                    const free = parseInt(kv.FreeSpace) || 0;
                    const used = total - free;
                    resolve({
                        total: formatBytes(total),
                        used: formatBytes(used),
                        free: formatBytes(free),
                        totalBytes: total,
                        usedBytes: used,
                        freeBytes: free,
                        percent: total > 0 ? Math.round((used / total) * 100) : 0
                    });
                });
            } else {
                exec(`df -B1 "${targetPath}" | tail -n +2`, (err, stdout) => {
                    if (err) return resolve({ total: 'Unknown', used: 'Unknown', free: 'Unknown', percent: 0 });
                    const parts = stdout.trim().split(/\s+/);
                    if (parts.length >= 4) {
                        const total = parseInt(parts[1]) || 0;
                        const used = parseInt(parts[2]) || 0;
                        const free = parseInt(parts[3]) || 0;
                        resolve({
                            total: formatBytes(total),
                            used: formatBytes(used),
                            free: formatBytes(free),
                            totalBytes: total,
                            usedBytes: used,
                            freeBytes: free,
                            percent: total > 0 ? Math.round((used / total) * 100) : 0
                        });
                    } else {
                        resolve({ total: 'Unknown', used: 'Unknown', free: 'Unknown', percent: 0 });
                    }
                });
            }
        } catch (e) {
            resolve({ total: 'Unknown', used: 'Unknown', free: 'Unknown', percent: 0 });
        }
    });
}

/**
 * Scan directory contents (for explorer)
 */
function scanDirectory(dirPath) {
    const result = { path: dirPath, parent: null, items: [] };
    
    try {
        result.parent = path.dirname(dirPath);
        const items = fs.readdirSync(dirPath);
        items.forEach(item => {
            const fullPath = path.join(dirPath, item);
            try {
                const stat = fs.statSync(fullPath);
                result.items.push({
                    name: item,
                    path: fullPath,
                    isDirectory: stat.isDirectory(),
                    size: stat.isFile() ? stat.size : 0,
                    sizeFormatted: stat.isFile() ? formatBytes(stat.size) : '',
                    mtime: stat.mtime
                });
            } catch (e) {}
        });
        result.items.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
    } catch (e) {
        result.error = e.message;
    }
    
    return result;
}

/**
 * Set active storage for recordings
 */
function setActiveStorage(storagePath, config) {
    const recording = config.recording || {};
    
    // Update config runtime
    recording.storage_path = storagePath;
    config.recording = recording;
    
    // Create directory if not exists
    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }
    
    // Save to config.json
    try {
        const cfgPath = STORAGE_CONFIG_PATH;
        const current = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (!current.recording) current.recording = {};
        current.recording.storage_path = storagePath;
        fs.writeFileSync(cfgPath, JSON.stringify(current, null, 4), 'utf8');
    } catch (e) {
        console.error('[Storage] Config save error:', e.message);
    }
    
    return { success: true, path: storagePath };
}

/**
 * Get current recordings storage path
 */
function getRecordingsPath(config) {
    return config.recording?.storage_path || RECORDINGS_DIR;
}

/**
 * Mount external drive (Linux)
 */
function mountDrive(device, mountPoint) {
    return new Promise((resolve) => {
        if (isWin) return resolve({ success: false, error: 'Not supported on Windows' });
        
        if (!fs.existsSync(mountPoint)) {
            fs.mkdirSync(mountPoint, { recursive: true });
        }
        
        exec(`mount "${device}" "${mountPoint}" 2>&1`, (err, stdout, stderr) => {
            if (err) return resolve({ success: false, error: stderr || err.message });
            resolve({ success: true });
        });
    });
}

/**
 * Unmount external drive
 */
function unmountDrive(mountPoint) {
    return new Promise((resolve) => {
        if (isWin) return resolve({ success: false, error: 'Not supported on Windows' });
        exec(`umount "${mountPoint}" 2>&1`, (err, stdout, stderr) => {
            if (err) return resolve({ success: false, error: stderr || err.message });
            resolve({ success: true });
        });
    });
}

// ===== HELPER FUNCTIONS =====

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function execPromise(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 5000 }, (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout);
        });
    });
}

function getWindowsDrives() {
    return new Promise((resolve) => {
        exec('wmic logicaldisk get DeviceID', (err, stdout) => {
            if (err) return resolve([]);
            const drives = stdout.split('\n')
                .map(l => l.trim())
                .filter(l => /^[A-Z]:$/.test(l));
            resolve(drives);
        });
    });
}

module.exports = {
    scanStorageDevices,
    getDiskInfo,
    scanDirectory,
    setActiveStorage,
    getRecordingsPath,
    mountDrive,
    unmountDrive,
    RECORDINGS_DIR,
    formatBytes
};