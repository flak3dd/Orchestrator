'use strict';
// WebSocket Connection Manager
// Generated at 2026-06-09T16:18:18.497Z
const { WebSocketServer } = require('ws');
class WebSocketManager {
  constructor(server) {
    this.wss = new WebSocketServer({ noServer: true });
    this.setupServer(server);
  }
  setupServer(server) {
    server.on('upgrade', (request, socket, head) => {
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });
    this.wss.on('connection', (ws) => {
      console.log('[WS] Client connected');
      ws.send(JSON.stringify({ type: 'init', state: { ready: true } }));
      ws.on('message', (message) => {
        ws.send(JSON.stringify({ type: 'ack', received: message.toString() }));
      });
      ws.on('close', () => console.log('[WS] Client disconnected'));
    });
  }
}
module.exports = WebSocketManager;