// Localhost origins are for development only. In production they are excluded
// unless ALLOW_LOCALHOST_ORIGINS=true is set explicitly.
const includeLocal =
    process.env.NODE_ENV !== 'production' || process.env.ALLOW_LOCALHOST_ORIGINS === 'true';

const localOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:8080',
    'http://localhost:8081',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:4173',
];

const allowedOrigins = [
    ...(includeLocal ? localOrigins : []),
    // production frontends only — never add the API's own domain here
    'https://relux.ng',
    'https://www.relux.ng',
    'https://staff.relux.ng',
    'https://media.relux.ng',
];

module.exports = allowedOrigins;
