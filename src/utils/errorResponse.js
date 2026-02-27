// ============================================================================
// ERROR RESPONSE UTILITY - Standardized Error Response Format
// ============================================================================

class ErrorResponse extends Error {
  constructor(message, statusCode, code = 'ERROR') {
    super(message);
    this.success = false;
    this.data = null;
    this.message = message;
    this.error = {
      code,
      message
    };
    this.statusCode = statusCode;
  }
}

module.exports = ErrorResponse;
