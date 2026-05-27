const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);

    logger.info(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    logger.error({ message: 'MongoDB connection failed', error: error.message, cause: error.cause?.message });
    process.exit(1);
  }
};

module.exports = connectDB;
