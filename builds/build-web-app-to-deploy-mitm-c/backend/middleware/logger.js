'use strict';
// Structured Logging Middleware
// Generated at 2026-06-09T16:25:13.824Z
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      method: req.method,
      url: req.url,
      status: res.statusCode,
      durationMs: duration
    }));
  });
  next();
}
module.exports = { requestLogger };