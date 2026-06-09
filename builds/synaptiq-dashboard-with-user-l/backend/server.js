'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { requestLogger } = require('./middleware/logger');
const healthRouter = require('./routes/health');
const apiRouter = require('./routes/api');
const WebSocketManager = require('./websocket');

const app = express();
const server = http.createServer(app);
new WebSocketManager(server);

app.use(express.json());
app.use(requestLogger);
app.use(express.static(path.join(__dirname, '../frontend')));
app.use(healthRouter);
app.use(apiRouter);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = { app, server };