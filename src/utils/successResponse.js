// ============================================================================
// SUCCESS RESPONSE UTILITY - Standardized Success Response Format
// ============================================================================

/**
 * Sends a standardized success response
 * @param {Object} res - Express response object
 * @param {*} data - Response data
 * @param {string} message - Success message
 * @param {number} statusCode - HTTP status code (default: 200)
 */
const successResponse = (res, data, message = 'Success', statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    data,
    message,
    error: null
  });
};

module.exports = successResponse;
