/**
 * Access Control & Permission Service
 * Menangani semua logika permission level user terhadap kamera
 * Menghilangkan duplikasi kode yang tersebar di beberapa route handler
 */

const db = require('../database');

/**
 * Level hierarchy (higher = more access)
 */
const LEVEL_HIERARCHY = {
    admin: 100,
    vvip: 80,
    pemerintahan: 70,
    vip: 60,
    member: 50,
    umum: 10
};

/**
 * Level playability map: what levels a user can play/view
 */
const LEVEL_ACCESS = {
    admin: null, // null = semua
    vvip: ['umum', 'member', 'vip', 'vvip'],
    pemerintahan: ['umum', 'member', 'vip', 'pemerintahan'],
    vip: ['umum', 'member', 'vip'],
    member: { playable: ['umum', 'member'], visible: ['umum', 'member', 'vip'] },
    umum: ['umum']
};

/**
 * Resolve user access info from session
 * @param {Object} session - Express session object
 * @returns {{ isAdmin: boolean, isCustomer: boolean, customerId: number|null, level: string, playableLevels: string[]|null, visibleLevels: string[]|null, isVVIP: boolean }}
 */
function resolveUserAccess(session) {
    const result = {
        isAdmin: false,
        isCustomer: false,
        customerId: null,
        level: 'umum',
        playableLevels: null, // null = all
        visibleLevels: null,  // null = all
        isVVIP: false
    };

    if (session && session.user) {
        result.isAdmin = true;
        result.level = 'admin';
        result.playableLevels = null;
        result.visibleLevels = null;
        return result;
    }

    if (session && session.customer) {
        result.isCustomer = true;
        result.customerId = session.customer.id;
        result.level = (session.customer.level || 'umum').toLowerCase();

        if (result.level === 'admin') {
            result.playableLevels = null;
            result.visibleLevels = null;
        } else if (result.level === 'vvip') {
            result.playableLevels = ['umum', 'member', 'vip', 'vvip'];
            result.visibleLevels = ['umum', 'member', 'vip', 'vvip'];
            result.isVVIP = true;
        } else if (result.level === 'pemerintahan') {
            result.playableLevels = ['umum', 'member', 'vip', 'pemerintahan'];
            result.visibleLevels = ['umum', 'member', 'vip', 'pemerintahan'];
        } else if (result.level === 'vip') {
            result.playableLevels = ['umum', 'member', 'vip'];
            result.visibleLevels = ['umum', 'member', 'vip'];
        } else if (result.level === 'member') {
            result.playableLevels = ['umum', 'member'];
            result.visibleLevels = ['umum', 'member', 'vip'];
        } else {
            result.playableLevels = ['umum'];
            result.visibleLevels = ['umum', 'member'];
        }
    }

    return result;
}

/**
 * Build SQL query and params for authorized cameras based on user access
 * @param {Object} access - Result from resolveUserAccess()
 * @param {boolean} selectAll - If true, SELECT * instead of just id
 * @returns {{ query: string, params: Array }}
 */
function buildAuthorizedCameraQuery(access, selectAll = false) {
    const select = selectAll ? 'SELECT *' : 'SELECT id';
    
    if (access.playableLevels === null) {
        return { query: `${select} FROM cameras`, params: [] };
    }

    const levels = access.visibleLevels || access.playableLevels;
    const levelList = levels.map(l => `'${l}'`).join(',');

    if (access.isVVIP) {
        return {
            query: `${select} FROM cameras WHERE LOWER(level) IN (${levelList}) AND (LOWER(level) != 'vvip' OR owner_id = ?)`,
            params: [access.customerId]
        };
    }

    return {
        query: `${select} FROM cameras WHERE LOWER(level) IN (${levelList}) AND LOWER(level) != 'vvip'`,
        params: []
    };
}

/**
 * Check if a camera is playable by the current user
 * @param {Object} access - Result from resolveUserAccess()
 * @param {Object} camera - Camera object with level and owner_id
 * @param {number|null} customerId - Optional override customerId
 * @returns {boolean}
 */
function isCameraPlayable(access, camera, customerId) {
    if (access.playableLevels === null) return true;
    
    const camLevel = (camera.level || 'umum').toLowerCase();
    if (!access.playableLevels.includes(camLevel)) return false;
    
    // VVIP ownership check
    if (camLevel === 'vvip' && camera.owner_id != (customerId || access.customerId)) {
        return false;
    }
    
    return true;
}

/**
 * Get all authorized cameras with playable flag
 * @param {Object} access - Result from resolveUserAccess()
 * @param {Function} callback - (err, cameras[]) 
 */
function getAuthorizedCameras(access, callback) {
    const { query, params } = buildAuthorizedCameraQuery(access, true);
    const custId = access.customerId;

    db.all(query, params, (err, rows) => {
        if (err) return callback(err, null);
        
        const cameras = (rows || []).map(cam => ({
            ...cam,
            isPlayable: isCameraPlayable(access, cam, custId)
        }));
        
        callback(null, cameras);
    });
}

/**
 * Get authorized camera IDs only (lightweight)
 * @param {Object} access - Result from resolveUserAccess()
 * @param {Function} callback - (err, ids: number[])
 */
function getAuthorizedCameraIds(access, callback) {
    if (access.playableLevels === null) {
        db.all("SELECT id FROM cameras", [], (err, rows) => {
            if (err) return callback(err, null);
            callback(null, (rows || []).map(r => r.id));
        });
        return;
    }

    const { query, params } = buildAuthorizedCameraQuery(access);
    db.all(query, params, (err, rows) => {
        if (err) return callback(err, null);
        callback(null, (rows || []).map(r => r.id));
    });
}

/**
 * Build userStatus JSON object for templates
 * @param {Object} session - Express session
 * @returns {string} JSON string
 */
function buildUserStatusJSON(session) {
    return JSON.stringify({
        isAdmin: !!session.user,
        isCustomer: !!session.customer,
        customerId: session.customer ? session.customer.id : null,
        customerLevel: session.customer ? session.customer.level : (session.user ? 'admin' : 'umum')
    });
}

/**
 * Get base URL for the app (for notifications/links)
 * @param {Object} req - Express request
 * @param {Object} config - Global config
 * @param {string} basePath - App base path
 * @returns {string}
 */
function getAppBaseUrl(req, config, basePath) {
    const basePathNormalized = basePath ? ('/' + basePath.replace(/^\/+/, '').replace(/\/+$/, '')) : '';
    const cfgPublic = (config.server && config.server.public_base_url) ? String(config.server.public_base_url).trim() : '';
    const host = req.headers.host ? String(req.headers.host) : '';
    const derived = host ? `${req.protocol}://${host}` : '';
    return ((cfgPublic || derived) ? `${(cfgPublic || derived).replace(/\/+$/, '')}${basePathNormalized}` : '').replace(/\/+$/, '');
}

module.exports = {
    LEVEL_HIERARCHY,
    resolveUserAccess,
    buildAuthorizedCameraQuery,
    isCameraPlayable,
    getAuthorizedCameras,
    getAuthorizedCameraIds,
    buildUserStatusJSON,
    getAppBaseUrl
};