const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);

    logger.info(`MongoDB Connected: ${conn.connection.host}`);
    console.log("✅ MongoDB Connected Successfully");
  } catch (error) {
    logger.error(`MongoDB Connection Error: ${error.message}`);
     console.error("❌ MongoDB Connection Failed:", err);
        console.error("⚠️ Connection Cause:", err.cause);  // This will give more details
        process.exit(1);
  }
};

module.exports = connectDB;
