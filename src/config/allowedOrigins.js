const allowedOrigins = [
    // local dev
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:8080',
    'http://localhost:8081',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:4173',
    // production frontends only — never add the API's own domain here
    'https://relux.ng',
    'https://www.relux.ng',
    'https://staff.relux.ng',
    'https://admin.relux.ng',
];

module.exports = allowedOrigins;