// Authentication and middleware utilities
const session = require('express-session');

function setupSessionMiddleware(app, config) {
    const behindProxy = config.server.behind_https_proxy === true;
    console.log(`[Config] behind_https_proxy: ${behindProxy}`);

    const sessionStore = new session.MemoryStore();
    const sessionMiddleware = session({
        secret: config.server.session_secret || 'cctv-monitoring-secret-key',
        resave: false,
        saveUninitialized: false,
        store: sessionStore,
        proxy: behindProxy,
        cookie: {
            secure: false,
            maxAge: 24 * 60 * 60 * 1000,
            sameSite: 'lax'
        }
    });

    app.use((req, res, next) => {
        sessionMiddleware(req, res, next);
    });

    // Debug middleware for session issues
    app.use((req, res, next) => {
        if (req.path === '/login' && req.method === 'POST') {
            console.log(`[Debug] Login attempt - Host: ${req.headers.host}, Protocol: ${req.protocol}, Secure: ${req.secure}`);
            console.log(`[Debug] Headers:`, {
                'x-forwarded-proto': req.headers['x-forwarded-proto'],
                'x-forwarded-for': req.headers['x-forwarded-for']
            });
        }
        next();
    });
}

function setupGlobalMiddleware(app, config, getHlsBaseUrl) {
    app.use((req, res, next) => {
        res.locals.base_path = app.locals.base_path || '';
        res.locals.site = config.site || {};
        res.locals.hlsBaseUrl = getHlsBaseUrl(req, config);
        res.locals.months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
        res.locals.isAdmin = !!req.session.user;
        res.locals.isCustomer = !!req.session.customer;
        res.locals.session = req.session;
        res.locals.user = req.session.customer || req.session.user || {};
        res.locals.userStatus = JSON.stringify({
            isAdmin: res.locals.isAdmin,
            isCustomer: res.locals.isCustomer,
            customerId: req.session.customer ? req.session.customer.id : null,
            customerLevel: req.session.customer ? req.session.customer.level : (req.session.user ? 'admin' : 'umum')
        });
        next();
    });
}

function requireAuth(ADMIN_USER) {
    return (req, res, next) => {
        console.log(`[Auth] Checking auth for ${req.path} - Session: ${req.sessionID}, User: ${req.session?.user}`);
        if (req.session && req.session.user === ADMIN_USER) {
            return next();
        }
        console.log(`[Auth] Redirecting to login - No valid session`);
        const basePath = req.app.locals.base_path || '';
        res.redirect(basePath + '/login');
    };
}

function requireApiAuth(ADMIN_USER) {
    return (req, res, next) => {
        console.log(`[API Auth] Path: ${req.path}, SessionUser: ${req.session?.user}, SessionCustomer: ${req.session?.customer?.username}`);
        if (req.session && req.session.user === ADMIN_USER) {
            return next();
        }
        console.error('[API Auth] Unauthorized access attempt');
        res.status(401).json({ error: 'Unauthorized', message: 'Anda harus login sebagai admin' });
    };
}

function requireAnyAuth(req, res, next) {
    if (req.session && (req.session.user || req.session.customer)) {
        return next();
    }
    const basePath = req.app.locals.base_path || '';
    res.redirect(basePath + '/user/login');
}

module.exports = {
    setupSessionMiddleware,
    setupGlobalMiddleware,
    requireAuth,
    requireApiAuth,
    requireAnyAuth
};

// Made with Bob
