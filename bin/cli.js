#!/usr/bin/env node
'use strict';

require('dotenv').config();

const path = require('path');
const Orchestrator = require('../src/orchestrator');

// ── CLI Arg Parsing ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const cmd = args[0];

function printHelp() {
  console.log(`
  ⚡ Aether CLI — Multi-Agent Software Factory

  USAGE
    aether build --goal "<description>"  Build a project from a goal
    aether status                         Show current build state
    aether reset                          Reset the orchestrator
    aether help                           Show this help

  OPTIONS
    --goal <text>       Natural language description of what to build
    --builds <dir>      Output directory (default: ./builds)
    --no-approve        Auto-approve deployment gate (no prompt)

  EXAMPLES
    aether build --goal "Build a REST API with auth and PostgreSQL"
    aether build --goal "SynaptiQ platform with threat analysis dashboard"
  `);
}

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printHelp();
  process.exit(0);
}

// ── Parse flags ───────────────────────────────────────────────────────────
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const hasFlag = (f) => args.includes(f);

const goal = flag('--goal');
const buildsDir = flag('--builds') || path.join(process.cwd(), 'builds');
const autoApprove = hasFlag('--no-approve');

// ── Commands ──────────────────────────────────────────────────────────────
if (cmd === 'build') {
  if (!goal) {
    console.error('Error: --goal is required\n  Example: aether build --goal "Build a REST API"');
    process.exit(1);
  }

  const orchestrator = new Orchestrator({
    buildsDir,
    config: {
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      openaiKey: process.env.OPENAI_API_KEY,
      geminiKey: process.env.GEMINI_API_KEY,
      ollamaUrl: process.env.OLLAMA_URL,
    },
  });

  // ── Terminal output ────────────────────────────────────────────────
  const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    info: '\x1b[36m',    // cyan
    success: '\x1b[32m', // green
    warn: '\x1b[33m',    // yellow
    error: '\x1b[31m',   // red
    detail: '\x1b[35m',  // magenta
    phase: '\x1b[34m',   // blue
  };

  const c = (color, text) => `${COLORS[color] || ''}${text}${COLORS.reset}`;

  orchestrator.on('broadcast', (msg) => {
    const ts = new Date(msg.ts).toLocaleTimeString();
    const prefix = `${c('dim', ts)} `;

    switch (msg.type) {
      case 'phase_change':
        console.log(`\n${prefix}${c('phase', '●')} ${c('bright', `[${msg.phase.toUpperCase()}]`)} ${msg.detail || ''}`);
        break;

      case 'agent_log': {
        const lvlColor = { info: 'info', success: 'success', warn: 'warn', error: 'error', detail: 'detail' }[msg.level] || 'info';
        const agentTag = c('dim', `[${msg.agent}]`);
        console.log(`${prefix}${agentTag} ${c(lvlColor, msg.message)}`);
        break;
      }

      case 'file_created':
        console.log(`${prefix}${c('success', '✓')} ${c('dim', 'file')} ${msg.path} ${c('dim', `(${msg.size}b)`)}`);
        break;

      case 'approval_required':
        console.log(`\n${prefix}${c('warn', '⏸  APPROVAL REQUIRED')}`);
        console.log(`${prefix}${msg.message}`);
        console.log(`${prefix}Files: ${msg.stats.files}, Tests: ${msg.stats.testsPassed}✓ ${msg.stats.testsFailed}✗`);
        if (autoApprove) {
          console.log(`${prefix}${c('info', '--no-approve flag set — auto-approving in 2s...')}`);
          setTimeout(() => orchestrator.approve(), 2000);
        } else {
          console.log(`${prefix}${c('info', 'Press ENTER to approve deployment...')}`);
          process.stdin.once('data', () => orchestrator.approve());
        }
        break;

      case 'build_complete':
        console.log(`\n${prefix}${c('success', '✅ BUILD COMPLETE')}`);
        console.log(`${prefix}Goal: ${msg.goal}`);
        console.log(`${prefix}Components: ${msg.stats.components}, Files: ${msg.stats.files}`);
        console.log(`${prefix}Duration: ${(msg.duration / 1000).toFixed(1)}s`);
        console.log(`${prefix}Output: ${buildsDir}\n`);
        process.exit(0);
        break;

      case 'build_error':
        console.error(`\n${prefix}${c('error', '✗ BUILD FAILED')}: ${msg.error}\n`);
        process.exit(1);
        break;
    }
  });

  console.log(c('bright', `\n  ⚡ Aether — Building: "${goal}"\n`));
  orchestrator.build(goal).catch((err) => {
    console.error(c('error', `Build error: ${err.message}`));
    process.exit(1);
  });

} else if (cmd === 'status') {
  console.log('Status command requires a running server. Use: curl http://localhost:3000/api/state');

} else if (cmd === 'reset') {
  console.log('Reset command requires a running server. Use: curl -X POST http://localhost:3000/api/reset');

} else {
  console.error(`Unknown command: ${cmd}\nRun "aether help" for usage.`);
  process.exit(1);
}
