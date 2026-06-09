# ⚡ Aether — Multi-Agent Software Factory

Aether is a multi-agent orchestrator that plans, researches, generates, reviews, tests, and packages complex applications from a single natural-language goal. It ships with a real-time cyberpunk web dashboard and a developer CLI.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. (Optional) Configure an LLM provider
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY (or OpenAI / Gemini / Ollama)

# 3. Start the server
node server.js

# 4. Open the dashboard
open http://localhost:3000
```

Enter a goal and click **▶ Build System**. If no API key is configured, Aether runs in rich **Simulation Mode** — you'll see the full agent pipeline execute with realistic file generation.

---

## Architecture

```
aether/
├── server.js              Express + WebSocket server
├── bin/cli.js             Developer CLI
├── src/
│   ├── orchestrator.js    State machine + pipeline coordinator
│   ├── sandbox.js         File-safe build output manager
│   └── agents/
│       ├── base.js        Base agent (LLM dispatch, logging)
│       ├── recon.js       Goal analysis + codebase scanning
│       ├── codegen.js     Code & file generation
│       ├── reviewer.js    Static analysis + LLM-as-judge
│       ├── infra.js       Dockerfile, docker-compose, CI workflow
│       └── testing.js     Unit tests + self-correction trigger
├── public/                Cyberpunk dashboard
│   ├── index.html
│   ├── style.css
│   └── app.js
└── builds/                All generated output (sandboxed here)
```

---

## Pipeline

```
Goal → Recon → [CodeGen → Review]×N → Testing → Infra → Deploy Gate → Done
                     ↑_______↓ (self-correction loop, up to 3 attempts)
```

1. **Recon** — scans workspace, decomposes goal into components, infers tech stack
2. **CodeGen** — generates source files per component using LLM or simulation templates
3. **Reviewer** — static analysis (AST-level checks, security scan, LLM-as-judge)
4. **Self-correction loop** — if review fails, errors are fed back to CodeGen (max 3 attempts)
5. **Testing** — runs structural/syntactic test suite, reports failures
6. **Infra** — generates Dockerfile, docker-compose, deploy.sh, GitHub Actions workflow
7. **Human-in-the-Loop Gate** — pauses and waits for user approval before deploying
8. **Deploy** — dry-run finalizes deployment artifacts in `./builds/`

---

## CLI

```bash
# Build from command line
node bin/cli.js build --goal "REST API with auth and PostgreSQL"

# Auto-approve deployment gate
node bin/cli.js build --goal "SynaptiQ platform" --no-approve

# Custom output directory
node bin/cli.js build --goal "..." --builds ./output
```

---

## LLM Providers

Configure in `.env` or via the dashboard ⚙ Config panel:

| Provider  | Variable           | Model used         |
|-----------|--------------------|--------------------|
| Anthropic | `ANTHROPIC_API_KEY` | claude-opus-4-5    |
| OpenAI    | `OPENAI_API_KEY`   | gpt-4o             |
| Gemini    | `GEMINI_API_KEY`   | gemini-1.5-pro     |
| Ollama    | `OLLAMA_URL`       | llama3 (local)     |

Without any key, **Simulation Mode** generates realistic code templates.

---

## Safety

- All file writes are sandboxed to `./builds/` — Aether cannot overwrite its own source
- Path traversal is blocked at the Sandbox layer
- The deploy gate prevents any `docker-compose up` without explicit human approval
- Shell commands run as dry-runs by default

---

## Example Goal

```
SynaptiQ Platform with Offensive (threat analysis dashboard)
and Defensive (firewall log monitor) wings
```

Generated output in `./builds/synaptiq-platform-with-offe/`:
- `frontend/` — React dashboard
- `backend/` — Node.js API + WebSocket server
- `offensive/` — ThreatAnalyzer with signature matching
- `defensive/` — FirewallMonitor with real-time alerting
- `Dockerfile`, `docker-compose.yml`, `deploy.sh`
- `.github/workflows/ci.yml`
- `README.md`

---

## Requirements

- Node.js ≥ 18
- npm ≥ 9
# Orchestrator
