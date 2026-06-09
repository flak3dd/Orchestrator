'use strict';
// REST API Controller Routes
// Generated at 2026-06-09T16:18:08.499Z
const express = require('express');
const router = express.Router();
const coreService = require('../services/coreService');
router.get('/api/status', (req, res) => {
  res.json({ running: true, uptime: process.uptime() });
});
router.post('/api/action', async (req, res) => {
  try {
    const result = await coreService.processData(req.body);
    res.json(result);
  } catch (err) { 
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;