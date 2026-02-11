const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const corsOptions = require('./config/corsOptions.js')

// Route imports
const authRoutes = require('./routes/authRoutes.js');
const userRoutes = require('./routes/userRoutes.js');
const orderRoutes = require('./routes/orderRoutes.js');
const adminRoutes = require('./routes/adminRoutes.js');
const webhookRoutes = require('./routes/webhookRoutes.js');
const customerRoutes = require('./routes/customerRoutes.js');
const roleRoutes = require('./routes/roleRoutes.js');
const serviceRoutes = require('./routes/serviceRoutes.js');
const paymentRoutes = require('./routes/paymentRoutes.js');
const walletRoutes = require('./routes/walletRoutes.js');
const promoRoutes = require('./routes/promoRoutes.js');
const chatRoutes = require('./routes/chatRoutes.js');
const notificationRoutes = require('./routes/notificationRoutes.js');
const subscriptionRoutes = require('./routes/subscriptionRoutes.js');
const loyaltyRoutes = require('./routes/loyaltyRoutes.js');
const referralRoutes = require('./routes/referralRoutes.js');
const staffRoutes = require('./routes/staffRoutes.js');
const attendanceRoutes = require('./routes/attendanceRoutes.js');
const payrollRoutes = require('./routes/payrollRoutes.js');
const settingsRoutes = require('./routes/settingsRoutes.js');
const auditRoutes = require('./routes/auditRoutes.js');

// Middleware imports
const errorHandler = require('./middleware/errorHandler.js');
const { apiLimiter } = require('./middleware/rateLimiter.js');
const app = express();

// Webhook routes (must be before body parsers - needs raw body for Svix signature verification)
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cookie parser
app.use(cookieParser());

// CORS
app.use(cors(corsOptions));

// Security headers
app.use(helmet());

// Data sanitization against NoSQL injection
app.use(mongoSanitize());

// Prevent parameter pollution
app.use(hpp());

// Compression
app.use(compression());

// Dev logging middleware
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// API rate limiting
// app.use('/api', apiLimiter);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Relux Laundry API is running.....',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API Routes
const API_VERSION = process.env.API_VERSION || 'v1';
app.use(`/api/${API_VERSION}/auth`, authRoutes);
app.use(`/api/${API_VERSION}/users`, userRoutes);
app.use(`/api/${API_VERSION}/orders`, orderRoutes);
app.use(`/api/${API_VERSION}/admin`, adminRoutes);
app.use(`/api/${API_VERSION}/customers`, customerRoutes);
app.use(`/api/${API_VERSION}/roles`, roleRoutes);
app.use(`/api/${API_VERSION}/services`, serviceRoutes);
app.use(`/api/${API_VERSION}/payments`, paymentRoutes);
app.use(`/api/${API_VERSION}/wallets`, walletRoutes);
app.use(`/api/${API_VERSION}/promos`, promoRoutes);
app.use(`/api/${API_VERSION}/chats`, chatRoutes);
app.use(`/api/${API_VERSION}/notifications`, notificationRoutes);
app.use(`/api/${API_VERSION}/subscriptions`, subscriptionRoutes);
app.use(`/api/${API_VERSION}/loyalty`, loyaltyRoutes);
app.use(`/api/${API_VERSION}/referrals`, referralRoutes);
app.use(`/api/${API_VERSION}/staff`, staffRoutes);
app.use(`/api/${API_VERSION}/attendance`, attendanceRoutes);
app.use(`/api/${API_VERSION}/payroll`, payrollRoutes);
app.use(`/api/${API_VERSION}/settings`, settingsRoutes);
app.use(`/api/${API_VERSION}/audit-logs`, auditRoutes);

// 404 handler
app.all('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

// Error handler (must be last)
app.use(errorHandler);

module.exports = app;
