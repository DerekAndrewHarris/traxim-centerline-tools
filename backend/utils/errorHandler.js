/**
 * Error Handling Utilities
 * Custom error classes and error handling middleware for Express
 */

/**
 * Custom application error class
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Express error handling middleware
 * @param {Error} err 
 * @param {object} req 
 * @param {object} res 
 * @param {function} next 
 */
export function errorHandler(err, req, res, next) {
  // Default to 500 server error
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';
  let details = err.details || {};

  // Log error
  if (statusCode >= 500) {
    console.error('[Error]', {
      message: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
      details
    });
  } else {
    console.warn('[Warning]', {
      message: err.message,
      path: req.path,
      method: req.method,
      statusCode
    });
  }

  // Don't expose internal errors to client in production
  if (statusCode === 500 && process.env.NODE_ENV === 'production' && !err.isOperational) {
    message = 'An unexpected error occurred';
    details = {};
  }

  // Send error response
  res.status(statusCode).json({
    success: false,
    error: message,
    details,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}

/**
 * Async route wrapper to catch errors
 * @param {function} fn - Async route handler
 * @returns {function} Express middleware
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 Not Found handler
 * @param {object} req 
 * @param {object} res 
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path
  });
}
