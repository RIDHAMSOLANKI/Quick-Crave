// Throw an HttpError inside db.withTransaction() to roll back AND choose the
// HTTP response in one go. sendError() turns it into a JSON reply.

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendError(res, err, fallbackMessage = 'Internal server error') {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
  }
  console.error('[error]', err);
  return res.status(500).json({ success: false, message: fallbackMessage });
}

module.exports = { HttpError, sendError };
