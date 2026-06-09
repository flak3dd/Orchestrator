'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { WebSocketServer } = require('ws');
const path       = require('path');
const { exec, execFile } = require('child_process');
const { promisify }      = require('util');
const net        = require('net');
const fs         = require('fs');

const execAsync  = promisify(exec);
const Orchestrator = require('./src/orchestrator');

// ── Structured logger ──────────────────────────────────────────────────────
const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info',  msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn',  msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg, ...ctx })),
};

// ── Setup ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const orchestrator = new Orchestrator({
  buildsDir: path.join(__dirname, 'builds'),
  config: {
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    openaiKey:    process.env.OPENAI_API_KEY,
    geminiKey:    process.env.GEMINI_API_KEY,
    ollamaUrl:    process.env.OLLAMA_URL,
  },
});

// ── Auth middleware ────────────────────────────────────────────────────────
// Aether is a local-only dev tool. Set AETHER_TOKEN in .env to enable
// simple bearer-token protection when exposing it on a network.
function requireAuth(req, res, next) {
  const token = process.env.AETHER_TOKEN;
  if (!token) return next(); // no token configured → open (local use)

  const auth = req.headers['authorization'] ?? '';
  if (auth === `Bearer ${token}`) return next();

  res.status(401).json({ error: 'Unauthorised — set Authorization: Bearer <AETHER_TOKEN>' });
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── CSRF note ──────────────────────────────────────────────────────────────
// Aether is a localhost-only dev tool consumed by its own dashboard (same
// origin) and has no session cookies, so traditional CSRF attacks are not
// applicable. If you expose it to a network, add a CSRF middleware here.

// ── REST API ───────────────────────────────────────────────────────────────
app.get('/api/state', requireAuth, (req, res) => {
  res.json(orchestrator.getState());
});

app.post('/api/build', requireAuth, (req, res) => {
  const { goal } = req.body ?? {};
  if (!goal || typeof goal !== 'string' || goal.trim().length < 5) {
    return res.status(400).json({ error: 'goal must be a string of at least 5 characters' });
  }
  // Intentionally fire-and-forget — progress is streamed via WebSocket
  orchestrator.build(goal.trim()).catch(err => {
    log.error('Build pipeline error', { error: err.message });
  });
  res.json({ started: true, goal: goal.trim() });
});

app.post('/api/approve', requireAuth, (req, res) => {
  orchestrator.approve();
  res.json({ approved: true });
});

app.post('/api/reset', requireAuth, (req, res) => {
  orchestrator.reset();
  res.json({ reset: true });
});

app.post('/api/config', requireAuth, (req, res) => {
  const { anthropicKey, openaiKey, geminiKey, ollamaUrl } = req.body ?? {};
  orchestrator.updateConfig({ anthropicKey, openaiKey, geminiKey, ollamaUrl });
  res.json({ updated: true });
});

// File tree
app.get('/api/files', requireAuth, (req, res) => {
  const state = orchestrator.getState();
  res.json({ files: state.files ?? [] });
});

// File content — sandbox-safe, path validated inside sandbox.readFile
app.get('/api/file', requireAuth, (req, res) => {
  const relPath = req.query.path;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({ error: 'path query parameter is required' });
  }
  try {
    const content = orchestrator.sandbox.readFile(relPath);
    res.json({ path: relPath, content });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ── Launch endpoint ────────────────────────────────────────────────────────
// Finds the generated server.js in builds/, picks a free port, and spawns
// it as a detached child process so it outlives Aether itself.
app.post('/api/launch', requireAuth, async (req, res) => {
  const buildsDir = path.join(__dirname, 'builds');

  let activeBuildDir = buildsDir;
  if (orchestrator.state.goal) {
    const goalSlug = orchestrator.state.goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
    activeBuildDir = path.join(buildsDir, goalSlug);
  }

  // Find entry point file
  let serverFile = null;
  // 1. Try to resolve via package.json main property
  try {
    const { stdout: pkgFindOut } = await execAsync(
      `find "${activeBuildDir}" -name "package.json" -not -path "*/node_modules/*" | head -5`,
      { timeout: 5000 }
    );
    const pkgPath = pkgFindOut.trim().split('\n')[0];
    if (pkgPath && fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.main) {
        const resolvedMain = path.join(path.dirname(pkgPath), pkg.main);
        if (fs.existsSync(resolvedMain)) {
          serverFile = resolvedMain;
        }
      }
    }
  } catch (err) {
    log.warn('Failed to parse package.json for entry point', { error: err.message });
  }

  // 2. Fallback: Search for server.js
  if (!serverFile) {
    try {
      const { stdout: serverFindOut } = await execAsync(
        `find "${activeBuildDir}" -name "server.js" -not -path "*/node_modules/*" | head -5`,
        { timeout: 5000 }
      );
      const first = serverFindOut.trim().split('\n')[0];
      if (first) serverFile = first;
    } catch (err) {
      log.warn('find server.js failed in /api/launch', { error: err.message });
    }
  }

  // 3. Fallback: Search for index.js
  if (!serverFile) {
    try {
      const { stdout: indexFindOut } = await execAsync(
        `find "${activeBuildDir}" -name "index.js" -not -path "*/node_modules/*" | head -5`,
        { timeout: 5000 }
      );
      const first = indexFindOut.trim().split('\n')[0];
      if (first) serverFile = first;
    } catch (err) {
      log.warn('find index.js failed in /api/launch', { error: err.message });
    }
  }

  if (!serverFile) {
    return res.json({ url: null, error: 'No server.js or index.js found in builds/' });
  }

  let attempts = 0;
  const maxAttempts = 3;
  let lastError = null;

  while (attempts < maxAttempts) {
    attempts++;
    log.info(`Launch attempt ${attempts}/${maxAttempts}...`);

    // Find a free port starting at 3001
    const findFreePort = (start) => new Promise((resolve) => {
      const srv = net.createServer();
      srv.listen(start, () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
      srv.on('error', () => resolve(findFreePort(start + 1)));
    });

    const port = await findFreePort(3001);

    const proc = execFile('node', [serverFile], {
      cwd: path.dirname(serverFile),
      env: { ...process.env, PORT: String(port) },
      detached: true,
    });
    proc.unref();

    let stderrOutput = '';
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        stderrOutput += chunk;
        log.error(`[Launched App Error] ${chunk.toString().trim()}`);
      });
    }
    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => {
        log.info(`[Launched App Output] ${chunk.toString().trim()}`);
      });
    }
    proc.on('error', (err) => {
      stderrOutput += `\nFailed to start process: ${err.message}`;
      log.error('Failed to start launched app process', { error: err.message });
    });

    // Give the child process time to bind its port and run health check
    await new Promise(r => setTimeout(r, 1500));

    const isRunning = (proc.exitCode === null);
    let healthCheckPassed = false;

    if (isRunning) {
      try {
        const response = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          const body = await response.json();
          if (body.status === 'ok') {
            healthCheckPassed = true;
          } else {
            stderrOutput += `\nHealth check returned status: ${body.status}`;
          }
        } else {
          stderrOutput += `\nHealth check returned status code: ${response.status}`;
        }
      } catch (err) {
        stderrOutput += `\nHealth check failed to respond: ${err.message}`;
      }
    } else {
      stderrOutput += `\nProcess exited with code ${proc.exitCode}`;
    }

    if (isRunning && healthCheckPassed) {
      const url = `http://localhost:${port}`;
      log.info('Launched built app successfully', { serverFile, url, pid: proc.pid });
      return res.json({ url, port, file: serverFile, pid: proc.pid });
    }

    // App failed to launch or pass health check
    log.error(`Launch attempt ${attempts} failed. Error: ${stderrOutput.trim()}`);
    lastError = stderrOutput.trim();

    // Clean up current process if it's somehow still running
    if (isRunning && proc.pid) {
      try {
        process.kill(-proc.pid); // kill process group
      } catch {
        try { proc.kill(); } catch {}
      }
    }

    if (attempts < maxAttempts) {
      log.info(`Triggering self-correction to fix launch error...`);
      try {
        await orchestrator.fixLaunchError(lastError);
      } catch (err) {
        log.error(`Self-correction failed during launch fix: ${err.message}`);
        return res.json({ url: null, error: `Self-correction failed: ${err.message}` });
      }
    }
  }

  // If we reach here, we exceeded max attempts
  log.error(`App failed to function after ${maxAttempts} launch attempts.`);
  return res.json({ url: null, error: `App failed to function after ${maxAttempts} attempts: ${lastError}` });
});

// ── Central error handler ──────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log.error('Unhandled Express error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── WebSocket ──────────────────────────────────────────────────────────────
const clients = new Set();

orchestrator.on('broadcast', (msg) => {
  const payload = JSON.stringify(msg);
  clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(payload);
  });
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', state: orchestrator.getState() }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      log.warn('WS message parse error', { error: err.message });
      return; // malformed JSON — discard and continue
    }

    switch (msg.type) {
      case 'build':
        orchestrator.build(msg.goal).catch(err => {
          log.error('WS-triggered build error', { error: err.message });
        });
        break;
      case 'approve':
        orchestrator.approve();
        break;
      case 'reset':
        orchestrator.reset();
        break;
      case 'config':
        orchestrator.updateConfig(msg.config ?? {});
        break;
      default:
        log.warn('Unknown WS message type', { type: msg.type });
        break; // explicit break on default — no fallthrough
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', (err) => {
    log.warn('WS client error', { error: err.message });
    clients.delete(ws);
  });
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  log.info('SIGTERM received — shutting down');
  server.close(() => process.exit(0));
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const hasKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   ⚡ AETHER — Software Factory v1.0   ║`);
  console.log(`  ╠═══════════════════════════════════════╣`);
  console.log(`  ║  Dashboard  →  http://localhost:${PORT}   ║`);
  console.log(`  ║  Builds     →  ./builds/              ║`);
  console.log(`  ║  LLM Mode   →  ${hasKey ? 'Real (API key found)  ' : 'Simulation            '} ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
});

module.exports = { app, server };