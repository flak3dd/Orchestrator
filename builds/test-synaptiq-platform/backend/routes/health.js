'use strict';
// Health Check Routing
// Generated at 2026-06-09T16:17:45.700Z
const express = require('express');
const router = express.Router();
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    system: { platform: process.platform, arch: process.arch }
  });
});
module.exports = router;