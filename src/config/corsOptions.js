const allowedOrigins = require("./allowedOrigins.js");

const corsOptions = {
    origin: (origin, callback) => {
        const normalizedOrigin = origin ? origin.replace(/\/$/, '') : origin; // Remove trailing slash
        if (allowedOrigins.indexOf(normalizedOrigin) !== -1 || !origin) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS: ' + origin));
        }
    },
    credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200,
};

module.exports = corsOptions;