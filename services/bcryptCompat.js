/**
 * bcrypt Compatibility Wrapper - Multi-Strategy untuk ARM & Legacy Node.js
 * 
 * Masalah: Di Arsitektur ARM (Amlogic S905x), native bcrypt & scrypt 
 * sering gagal. Solusi: mencoba beberapa strategi hashing secara berurutan.
 * 
 * Strategi:
 * 1. Native bcrypt (paling cepat)
 * 2. crypto.scryptSync (Node.js built-in)
 * 3. crypto.pbkdf2Sync (OpenSSL, hampir pasti ada)
 * 4. SHA256 HMAC (fallback ultimate, selalu tersedia)
 */

const crypto = require('crypto');

// --- Introspeksi: cek fungsi crypto apa saja yang tersedia ---
const hasScrypt = typeof crypto.scryptSync === 'function';
const hasPbkdf2 = typeof crypto.pbkdf2Sync === 'function';

console.log(`[bcryptCompat] crypto support: scrypt=${hasScrypt}, pbkdf2=${hasPbkdf2}`);

// --- Native bcrypt detection ---
let nativeBcrypt = null;
try {
    nativeBcrypt = require('bcrypt');
    const testHash = nativeBcrypt.hashSync('test', 4);
    const testCompare = nativeBcrypt.compareSync('test', testHash);
    if (testCompare) {
        console.log('[bcryptCompat] Native bcrypt OK - using native');
    } else {
        console.warn('[bcryptCompat] Native bcrypt compare failed test, disabled');
        nativeBcrypt = null;
    }
} catch (e) {
    console.warn('[bcryptCompat] Native bcrypt unavailable:', e.message);
    nativeBcrypt = null;
}

// --- Algorithm identifier constants ---
const ALGO = {
    BCRYPT: '$2b$',
    FALLBACK_SCRYPT: '$fb_scrypt$',
    FALLBACK_PBKDF2: '$fb_pbkdf2$',
    FALLBACK_SHA256: '$fb_sha256$'
};

/**
 * Generate hash - tries fastest available algorithm
 */
function hashSync(password, saltRounds = 10) {
    if (!password) throw new Error('Password required');
    
    // Strategy 1: Native bcrypt
    if (nativeBcrypt) {
        try {
            const h = nativeBcrypt.hashSync(password, saltRounds);
            if (h && h.length > 10) return h;
        } catch (e) {
            console.warn('[bcryptCompat] Native hash failed:', e.message);
        }
    }

    // Strategy 2: scrypt (Node.js native crypto)
    if (hasScrypt) {
        try {
            const salt = crypto.randomBytes(16).toString('hex');
            const hash = crypto.scryptSync(password, salt, 32).toString('hex');
            return `${ALGO.FALLBACK_SCRYPT}${salt}$${hash}`;
        } catch (e) {
            console.warn('[bcryptCompat] scrypt failed:', e.message);
        }
    }

    // Strategy 3: pbkdf2 (OpenSSL, legacy support)
    if (hasPbkdf2) {
        try {
            const salt = crypto.randomBytes(16).toString('hex');
            const hash = crypto.pbkdf2Sync(password, salt, 10000, 32, 'sha512').toString('hex');
            return `${ALGO.FALLBACK_PBKDF2}${salt}$${hash}`;
        } catch (e) {
            console.warn('[bcryptCompat] pbkdf2 failed:', e.message);
        }
    }

    // Strategy 4: SHA256 HMAC (ultimate fallback, always available)
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
    return `${ALGO.FALLBACK_SHA256}${salt}$${hash}`;
}

/**
 * Compare password with stored hash (auto-detect algorithm)
 */
function compareSync(password, hash) {
    if (!password || !hash) {
        console.warn('[bcryptCompat] compareSync: missing password or hash');
        return false;
    }

    // --- Strategy 1: Native bcrypt hash ---
    if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
        if (nativeBcrypt) {
            try {
                const result = nativeBcrypt.compareSync(password, hash);
                if (result) return true;
                // If failed, might be ARM silent fail — try alternative comparison
            } catch (e) {
                console.warn('[bcryptCompat] Native bcrypt compare error:', e.message);
            }
        }
        // Fallback: try to verify using Node.js re-hash technique
        // We can't verify bcrypt without native module, log warning
        console.warn('[bcryptCompat] Cannot verify bcrypt hash without native module');
        return false;
    }

    // --- Strategy 2: scrypt fallback ---
    if (hash.startsWith(ALGO.FALLBACK_SCRYPT)) {
        try {
            const body = hash.slice(ALGO.FALLBACK_SCRYPT.length);
            const parts = body.split('$');
            const salt = parts[0] || '';
            const storedHash = parts[1] || '';
            if (hasScrypt) {
                const computed = crypto.scryptSync(password, salt, 32).toString('hex');
                return computed === storedHash;
            }
            return false;
        } catch (e) {
            console.error('[bcryptCompat] scrypt verify error:', e.message);
            return false;
        }
    }

    // --- Strategy 3: pbkdf2 fallback ---
    if (hash.startsWith(ALGO.FALLBACK_PBKDF2)) {
        try {
            const body = hash.slice(ALGO.FALLBACK_PBKDF2.length);
            const parts = body.split('$');
            const salt = parts[0] || '';
            const storedHash = parts[1] || '';
            if (hasPbkdf2) {
                const computed = crypto.pbkdf2Sync(password, salt, 10000, 32, 'sha512').toString('hex');
                return computed === storedHash;
            }
            return false;
        } catch (e) {
            console.error('[bcryptCompat] pbkdf2 verify error:', e.message);
            return false;
        }
    }

    // --- Strategy 4: SHA256 HMAC fallback ---
    if (hash.startsWith(ALGO.FALLBACK_SHA256)) {
        try {
            const body = hash.slice(ALGO.FALLBACK_SHA256.length);
            const parts = body.split('$');
            const salt = parts[0] || '';
            const storedHash = parts[1] || '';
            const computed = crypto.createHmac('sha256', salt).update(password).digest('hex');
            return computed === storedHash;
        } catch (e) {
            console.error('[bcryptCompat] sha256 verify error:', e.message);
            return false;
        }
    }

    // Unknown format
    console.warn('[bcryptCompat] Unknown hash format:', (hash || '').substring(0, 25) + '...');
    return false;
}

/**
 * Async hash
 */
async function hash(password, saltRounds = 10) {
    return hashSync(password, saltRounds);
}

module.exports = {
    hashSync,
    compareSync,
    hash,
    isNativeAvailable: !!nativeBcrypt
};