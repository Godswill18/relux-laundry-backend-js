class AppError extends Error {
  constructor(message, statusCode, errorCode) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;
    if (errorCode) this.errorCode = errorCode;

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
