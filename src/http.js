// Small helpers shared by the route modules.
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Express 4 does not catch rejected promises; route async handlers through next().
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function today() {
  return new Date().toLocaleDateString('en-CA');
}

module.exports = { HttpError, wrap, EMAIL_RE, today };
