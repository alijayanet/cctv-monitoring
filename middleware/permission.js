/**
 * Permission Middleware
 * Middleware untuk menangani access control kamera secara reusable
 * Menghilangkan duplikasi kode permission di setiap route handler
 */

const permission = require('../services/permission');

/**
 * Middleware: Resolve user access and attach to request
 * req.userAccess akan tersedia di semua route setelah middleware ini
 */
function attachUserAccess(req, res, next) {
    req.userAccess = permission.resolveUserAccess(req.session);
    next();
}

/**
 * Middleware: Get authorized cameras and attach to request
 * req.authorizedCameras akan berisi array kamera dengan flag isPlayable
 */
function resolveAuthorizedCameras(req, res, next) {
    if (!req.userAccess) {
        req.userAccess = permission.resolveUserAccess(req.session);
    }
    
    permission.getAuthorizedCameras(req.userAccess, (err, cameras) => {
        if (err) {
            return res.status(500).send(err.message);
        }
        req.authorizedCameras = cameras || [];
        next();
    });
}

/**
 * Middleware: Get authorized camera IDs and attach to request
 * req.authorizedCameraIds akan berisi array ID kamera yang diizinkan
 */
function resolveAuthorizedCameraIds(req, res, next) {
    if (!req.userAccess) {
        req.userAccess = permission.resolveUserAccess(req.session);
    }
    
    permission.getAuthorizedCameraIds(req.userAccess, (err, ids) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        req.authorizedCameraIds = ids || [];
        next();
    });
}

/**
 * Middleware: Filter recordings to authorized cameras only
 * Harus digunakan setelah resolveAuthorizedCameraIds
 */
function filterRecordingsByAccess(req, res, next) {
    if (!req.authorizedRecordings) {
        return next();
    }
    
    if (!req.authorizedCameraIds || req.authorizedCameraIds.length === 0) {
        req.authorizedRecordings = [];
        return next();
    }
    
    req.authorizedRecordings = (req.authorizedRecordings || []).filter(r => {
        return req.authorizedCameraIds.includes(parseInt(r.camera_id));
    });
    
    next();
}

module.exports = {
    attachUserAccess,
    resolveAuthorizedCameras,
    resolveAuthorizedCameraIds,
    filterRecordingsByAccess
};