'use strict';

const BaseAgent = require('./base');
const path = require('path');
const fs = require('fs');

class CodeGenAgent extends BaseAgent {
  constructor(orchestrator) {
    super('codegen', orchestrator);
  }

  async execute(task) {
    const { component, goal, outputDir, previousErrors = [] } = task;
    const isRetry = previousErrors.length > 0;

    if (isRetry) {
      this.log(`Re-generating ${component.name} to fix ${previousErrors.length} error(s)...`, 'warn');
    } else {
      const existingFiles = this._listAllFiles(outputDir);
      if (existingFiles.length > 0) {
        this.log(`Generating code for component: ${component.name} (building on top of ${existingFiles.length} existing files for improvements)`);
      } else {
        this.log(`Generating code for component: ${component.name}`);
      }
    }

    await this.sleep(600);

    const prompt = this._buildPrompt(component, goal, previousErrors, outputDir);
    this.log(`Calling LLM for ${component.name}...`);

    const llmOutput = await this.callLLM(prompt, { component, goal, previousErrors });
    await this.sleep(300);

    // Parse files from LLM output or generate simulation files
    const files = await this._parseOrSimulate(llmOutput, component, goal, outputDir);

    // Write files to disk
    const written = [];
    for (const file of files) {
      const filePath = path.join(outputDir, file.path);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf8');
      written.push(file.path);
      this.log(`  ✓ wrote ${file.path} (${file.content.length} chars)`);
      this.orchestrator.broadcast({
        type: 'file_created',
        path: file.path,
        size: file.content.length,
        component: component.name,
      });
      await this.sleep(150);
    }

    this.log(`Generated ${written.length} file(s) for ${component.name}`);
    return { files: written, component: component.name };
  }

  _buildPrompt(component, goal, previousErrors, outputDir) {
    const isRetry = previousErrors.length > 0;
    const existingFiles = this._listAllFiles(outputDir);

    let prompt = `# Code Generation Request

## Project Overview
**Goal:** ${goal}

## Component to Build
**Name:** ${component.name}
**Purpose:** ${component.description}

## What I Need From You

Generate a COMPLETE, PRODUCTION-READY implementation of the \`${component.name}\` component.

### Required Files
Based on the component type and goal, generate ALL files needed for this component to work standalone. Think carefully about what a real production deployment would need:

For a **backend/server component**: server file, router files, middleware, service layer, data models, validation schemas, error handler, health check, tests
For a **frontend component**: HTML entry point, component JS files, stylesheet, utility helpers, state management
For an **agent/worker component**: the agent class, its dependencies, a config file, unit tests
For an **infra component**: Dockerfile, docker-compose, CI workflow, deploy script, environment template

### Technical Requirements

1. **Authentication & Authorization**
   - Every route that touches data must verify identity (JWT Bearer token or session)
   - Role-based access where applicable (admin vs user vs readonly)
   - Middleware-based: \`authenticate\` middleware applied at router level, not inline

2. **Input Validation**
   - Validate every field in req.body, req.params, req.query before use
   - Return structured 400 errors: \`{ error: string, field?: string, code: string }\`
   - Sanitize strings that will be rendered or stored

3. **Error Handling**
   - Every async function has try/catch
   - Errors propagated to Express error handler via next(err) — never res.json inside catch
   - Central error handler maps error types to HTTP status codes
   - Never expose stack traces or internal errors to clients

4. **Logging & Observability**
   - Structured JSON logs: \`{ ts, level, reqId, agent, msg, durationMs, ...context }\`
   - Log at entry/exit of every significant operation
   - Performance: warn if operation exceeds 500ms

5. **Data Layer**
   - Use async file/DB operations — no sync I/O on the hot path
   - Connection pooling for databases
   - Graceful shutdown: drain connections before process exit

6. **Testing**
   - Unit tests for all business logic (pure functions)
   - Integration test stubs for HTTP routes
   - Test file co-located: \`foo.test.js\` next to \`foo.js\`

### Context About the Broader System
This component is part of a larger system described as: "${goal}"
Design the component's API and interfaces so they integrate cleanly with sibling components (authentication system, logging infrastructure, database layer).

### File Output Format
Use EXACTLY this format — one block per file, no exceptions:

--- relative/path/to/file.ext ---
[complete file content]
--- END ---

### What NOT to Do
- Do NOT write \`// TODO\`, \`// FIXME\`, or \`// implement this\`
- Do NOT truncate with \`// ... rest of code\`
- Do NOT write placeholder functions with empty bodies
- Do NOT omit imports
- Do NOT omit error handling for any async call`;

    if (isRetry) {
      prompt += `

## Previous Attempt Failed — Fix These Issues

The last generated version had ${previousErrors.length} error(s) that must be resolved:

${previousErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}

### Fix Instructions
- Address EVERY error listed above
- Do not introduce new issues while fixing these
- If the error is a logic bug, explain the fix in a comment
- If the error is a security issue, apply the fix AND explain why it was a vulnerability
- Regenerate the COMPLETE files — do not output diffs or partial replacements`;
    }

    if (existingFiles.length > 0) {
      prompt += `

## Existing Files in Workspace
The following files have been generated by previous steps. You MUST integrate with them, import/require them where necessary, and ensure all changes are fully compatible:
${existingFiles.map(f => `- ${f}`).join('\n')}`;
    }

    return prompt;
  }

  _listAllFiles(dir, baseDir = dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    const list = fs.readdirSync(dir);
    for (const file of list) {
      if (file === 'node_modules' || file === 'steps' || file.startsWith('.')) continue;
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        results = results.concat(this._listAllFiles(fullPath, baseDir));
      } else {
        results.push(path.relative(baseDir, fullPath));
      }
    }
    return results;
  }

  async _parseOrSimulate(llmOutput, component, goal, outputDir) {
    // Try to parse real LLM output (file blocks)
    const fileBlocks = [];
    const fileRegex = /---\s*([^\n]+)\s*---\n([\s\S]*?)---\s*END\s*---/g;
    // Assignment hoisted from condition to satisfy LOGIC006 — loop reads regex exec result
    let match = fileRegex.exec(llmOutput);
    while (match !== null) {
      fileBlocks.push({ path: match[1].trim(), content: match[2].trim() });
      match = fileRegex.exec(llmOutput);
    }

    if (fileBlocks.length > 0) return fileBlocks;

    // Simulation: generate realistic placeholder files
    return this._generateSimFiles(component, goal);
  }

  _generateSimFiles(component, goal) {
    const name = component.name;
    const goalSlug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
    const ts = new Date().toISOString();

    const templates = {
      'requirements-spec': [
        {
          path: `${goalSlug}/docs/requirements.md`,
          content: `# Software Requirements Specification\n## Project: ${goal}\n## Generated: ${ts}\n\n1. Scope: Implementation of ${goal} using standard web stack.\n2. Core Features: REST APIs, live updates via WebSocket, responsive user dashboard, health monitoring.\n3. Quality attributes: Structured logging, authentication, and dockerized deployment.`
        }
      ],
      'architecture-design': [
        {
          path: `${goalSlug}/docs/architecture.md`,
          content: `# System Architecture Design\n## Component: ${goal}\n\n\`\`\`mermaid\ngraph TD\n  Client[Frontend Client] -->|HTTP/WS| Server[Backend Server]\n  Server -->|SQL| Database[SQLite DB]\n  Server -->|Log| Logger[Structured Logger]\n\`\`\``
        }
      ],
      'database-migrations': [
        {
          path: `${goalSlug}/backend/db/migrations/20260610_init.sql`,
          content: `-- Database Migration: Init Schema\n-- Generated at ${ts}\nCREATE TABLE IF NOT EXISTS users (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  username TEXT UNIQUE NOT NULL,\n  password_hash TEXT NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\nCREATE TABLE IF NOT EXISTS system_logs (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  level TEXT,\n  message TEXT,\n  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP\n);`
        }
      ],
      'models-and-orm': [
        {
          path: `${goalSlug}/backend/db/models.js`,
          content: `'use strict';\n// Data Models & Validations\n// Generated at ${ts}\nclass User {\n  constructor(data = {}) {\n    this.username = data.username;\n    this.passwordHash = data.passwordHash;\n  }\n  validate() {\n    if (!this.username || this.username.length < 3) throw new Error('Invalid username');\n    if (!this.passwordHash) throw new Error('Password is required');\n    return true;\n  }\n}\nmodule.exports = { User };`
        }
      ],
      'auth-security': [
        {
          path: `${goalSlug}/backend/middleware/auth.js`,
          content: `'use strict';\n// Authentication & Security Middleware\n// Generated at ${ts}\nfunction authenticate(req, res, next) {\n  const authHeader = req.headers['authorization'];\n  if (!authHeader) {\n    return res.status(401).json({ error: 'Authentication token required' });\n  }\n  // Simulate token decoding\n  req.user = { id: 1, username: 'admin' };\n  next();\n}\nmodule.exports = { authenticate };`
        }
      ],
      'logger-middleware': [
        {
          path: `${goalSlug}/backend/middleware/logger.js`,
          content: `'use strict';\n// Structured Logging Middleware\n// Generated at ${ts}\nfunction requestLogger(req, res, next) {\n  const start = Date.now();\n  res.on('finish', () => {\n    const duration = Date.now() - start;\n    console.log(JSON.stringify({\n      ts: new Date().toISOString(),\n      level: 'info',\n      method: req.method,\n      url: req.url,\n      status: res.statusCode,\n      durationMs: duration\n    }));\n  });\n  next();\n}\nmodule.exports = { requestLogger };`
        }
      ],
      'health-monitoring': [
        {
          path: `${goalSlug}/backend/routes/health.js`,
          content: `'use strict';\n// Health Check Routing\n// Generated at ${ts}\nconst express = require('express');\nconst router = express.Router();\nrouter.get('/health', (req, res) => {\n  res.json({\n    status: 'ok',\n    uptime: process.uptime(),\n    timestamp: Date.now(),\n    system: { platform: process.platform, arch: process.arch }\n  });\n});\nmodule.exports = router;`
        }
      ],
      'core-services': [
        {
          path: `${goalSlug}/backend/services/coreService.js`,
          content: `'use strict';\n// Core Business Services\n// Generated at ${ts}\nclass CoreService {\n  async processData(input) {\n    if (!input) return { success: false, error: 'Empty input' };\n    return {\n      success: true,\n      processedAt: new Date().toISOString(),\n      payload: input\n    };\n  }\n}\nmodule.exports = new CoreService();`
        }
      ],
      'rest-api-endpoints': [
        {
          path: `${goalSlug}/backend/routes/api.js`,
          content: `'use strict';\n// REST API Controller Routes\n// Generated at ${ts}\nconst express = require('express');\nconst router = express.Router();\nconst coreService = require('../services/coreService');\nrouter.get('/api/status', (req, res) => {\n  res.json({ running: true, uptime: process.uptime() });\n});\nrouter.post('/api/action', async (req, res) => {\n  try {\n    const result = await coreService.processData(req.body);\n    res.json(result);\n  } catch (err) { \n    res.status(500).json({ error: err.message });\n  }\n});\nmodule.exports = router;`
        }
      ],
      'websocket-realtime': [
        {
          path: `${goalSlug}/backend/websocket.js`,
          content: `'use strict';\n// WebSocket Connection Manager\n// Generated at ${ts}\nconst { WebSocketServer } = require('ws');\nclass WebSocketManager {\n  constructor(server) {\n    this.wss = new WebSocketServer({ noServer: true });\n    this.setupServer(server);\n  }\n  setupServer(server) {\n    server.on('upgrade', (request, socket, head) => {\n      this.wss.handleUpgrade(request, socket, head, (ws) => {\n        this.wss.emit('connection', ws, request);\n      });\n    });\n    this.wss.on('connection', (ws) => {\n      console.log('[WS] Client connected');\n      ws.send(JSON.stringify({ type: 'init', state: { ready: true } }));\n      ws.on('message', (message) => {\n        ws.send(JSON.stringify({ type: 'ack', received: message.toString() }));\n      });\n      ws.on('close', () => console.log('[WS] Client disconnected'));\n    });\n  }\n}\nmodule.exports = WebSocketManager;`
        }
      ],
      'frontend-boilerplate': [
        {
          path: `${goalSlug}/frontend/index.html`,
          content: `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>${goal}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <div id="app">\n    <!-- Component UI injected here -->\n  </div>\n  <script src="components.js"></script>\n  <script src="pages.js"></script>\n  <script src="app.js"></script>\n</body>\n</html>`
        }
      ],
      'frontend-ui-components': [
        {
          path: `${goalSlug}/frontend/components.js`,
          content: `// Reusable UI Components\n// Generated at ${ts}\nconst UI = {\n  createCard(title, content) {\n    const card = document.createElement('div');\n    card.className = 'card';\n    card.innerHTML = \`<h3>\\\${title}</h3><p>\\\${content}</p>\`;\n    return card;\n  },\n  createBadge(text, statusClass) {\n    const badge = document.createElement('span');\n    badge.className = \`badge \\\${statusClass}\`;\n    badge.textContent = text;\n    return badge;\n  }\n};\nwindow.UI = UI;`
        }
      ],
      'frontend-pages': [
        {
          path: `${goalSlug}/frontend/pages.js`,
          content: `// Page views\n// Generated at ${ts}\nconst Pages = {\n  renderDashboard(container) {\n    container.innerHTML = \\\`\n      <header class="app-header">\n        <h1>Dashboard</h1>\n        <span class="status-badge" id="status">Connecting...</span>\n      </header>\n      <main class="dashboard-grid" id="dashboard">\n        <div id="status-card"></div>\n        <div id="stats-card"></div>\n      </main>\n    \\\`;\n  }\n};\nwindow.Pages = Pages;`
        }
      ],
      'api-integration': [
        {
          path: `${goalSlug}/frontend/app.js`,
          content: `// API Integration Client\n// Generated at ${ts}\nconst ws = new WebSocket(\`ws://\${location.host}\`);\nconst statusEl = document.getElementById('status') || {};\nws.onopen = () => {\n  statusEl.textContent = 'Connected';\n  statusEl.style.color = 'var(--success)';\n};\nws.onclose = () => {\n  statusEl.textContent = 'Disconnected';\n  statusEl.style.color = 'var(--danger)';\n};`
        },
        {
          path: `${goalSlug}/frontend/style.css`,
          content: `/* Styling Theme */\n:root {\n  --bg: #0a0a0f;\n  --surface: #111118;\n  --border: #1e1e2e;\n  --accent: #7c3aed;\n  --text: #e2e2f0;\n  --success: #22c55e;\n  --danger: #ef4444;\n}\nbody { background: var(--bg); color: var(--text); font-family: sans-serif; }\n.app-header { display: flex; justify-content: space-between; padding: 1rem; background: var(--surface); }\n.dashboard-grid { display: grid; gap: 1rem; padding: 1rem; }`
        }
      ],
      'infra-config': [
        {
          path: `${goalSlug}/Dockerfile`,
          content: `FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN cd backend && npm install --only=production\nEXPOSE 3001\nCMD ["node", "backend/server.js"]`
        },
        {
          path: `${goalSlug}/docker-compose.yml`,
          content: `version: '3.9'\nservices:\n  app:\n    build: .\n    ports:\n      - "3001:3001"`
        }
      ],
      'deploy-pipeline': [
        {
          path: `${goalSlug}/deploy.sh`,
          content: `#!/bin/bash\necho "Deploying pipeline..."`
        },
        {
          path: `${goalSlug}/backend/server.js`,
          content: `'use strict';\nconst express = require('express');\nconst http = require('http');\nconst path = require('path');\nconst { requestLogger } = require('./middleware/logger');\nconst healthRouter = require('./routes/health');\nconst apiRouter = require('./routes/api');\nconst WebSocketManager = require('./websocket');\n\nconst app = express();\nconst server = http.createServer(app);\nnew WebSocketManager(server);\n\napp.use(express.json());\napp.use(requestLogger);\napp.use(express.static(path.join(__dirname, '../frontend')));\napp.use(healthRouter);\napp.use(apiRouter);\n\nconst PORT = process.env.PORT || 3001;\nserver.listen(PORT, () => console.log(\`Server running on port \${PORT}\`));\nmodule.exports = { app, server };`
        },
        {
          path: `${goalSlug}/package.json`,
          content: `{\n  "name": "${goalSlug}",\n  "version": "1.0.0",\n  "main": "backend/server.js",\n  "scripts": {\n    "start": "node backend/server.js"\n  },\n  "dependencies": {\n    "express": "^4.19.2",\n    "ws": "^8.17.1"\n  }\n}`
        },
        {
          path: `${goalSlug}/index.js`,
          content: `'use strict';\nrequire('./backend/server');`
        }
      ]
    };

    return Object.prototype.hasOwnProperty.call(templates, name)
      ? templates[name]
      : [
          {
            path: `${goalSlug}/index.js`,
            content: `'use strict';\nconsole.log('Running fallback core');`
          }
        ];
  }
}

module.exports = CodeGenAgent;