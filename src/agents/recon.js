'use strict';

const BaseAgent = require('./base');
const path = require('path');
const fs = require('fs');

class ReconAgent extends BaseAgent {
  constructor(orchestrator) {
    super('recon', orchestrator);
  }

  async execute(task) {
    const { goal, buildsDir } = task;
    this.log(`Starting reconnaissance for: "${goal}"`);
    await this.sleep(400);

    // Scan existing builds directory
    this.log('Scanning workspace for existing artifacts...');
    const existingBuilds = this._scanDir(buildsDir);
    await this.sleep(300);

    if (existingBuilds.length > 0) {
      this.log(`Found ${existingBuilds.length} existing build(s): ${existingBuilds.join(', ')}`);
    } else {
      this.log('No existing builds found. Starting fresh.');
    }

    // Decompose the goal into components
    this.log('Analyzing goal for component requirements...');
    const components = await this._analyzeGoal(goal);
    await this.sleep(500);

    this.log(`Identified ${components.length} components to build`);
    components.forEach((c) => this.log(`  → ${c.name}: ${c.description}`, 'detail'));

    // Identify tech stack
    this.log('Determining optimal tech stack...');
    await this.sleep(400);
    const stack = this._inferStack(goal);
    this.log(`Tech stack: ${stack.join(', ')}`);

    return { components, stack, existingBuilds };
  }

  _scanDir(dir) {
    try {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => {
        const stat = fs.statSync(path.join(dir, f));
        return stat.isDirectory();
      });
    } catch {
      return [];
    }
  }

  async _analyzeGoal(goal) {
    const goalLower = goal.toLowerCase();

    // Use LLM if available, otherwise smart simulation
    const prompt = `# Software Architecture Analysis

You are doing the reconnaissance phase of a software build. Your job is to decompose a high-level goal into discrete, buildable components.

## Project Goal
"${goal}"

## Your Task
Analyze this goal and produce a structured component breakdown. Think like a tech lead planning a sprint:

1. What are the distinct, independently deployable or independently testable units?
2. What are the natural boundaries (UI, API, data, infra, security, integrations)?
3. What order should they be built in (dependencies first)?
4. What tech stack is most appropriate for each piece?

## Output Format
Respond with ONLY a JSON array. No prose before or after. Each element must have:
- \`name\`: short slug (kebab-case, e.g. "auth-service", "dashboard-ui")  
- \`description\`: 1-2 sentence description of what this component does and its key responsibilities
- \`priority\`: 1 (core/blocking) | 2 (important) | 3 (nice-to-have)
- \`dependsOn\`: array of component names this depends on (empty array if none)
- \`techHints\`: array of technology suggestions (e.g. ["Express", "JWT", "bcrypt"])

Example:
[
  {
    "name": "auth-service",
    "description": "JWT-based authentication with refresh tokens. Handles registration, login, logout, and token refresh. Stores hashed passwords with bcrypt.",
    "priority": 1,
    "dependsOn": [],
    "techHints": ["Express", "JWT", "bcrypt", "Redis for token blacklist"]
  }
]

Only output the JSON array.`;
    const llmResult = await this.callLLM(prompt, { goal });

    // Try to parse LLM result as JSON
    try {
      const match = llmResult.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
    } catch (parseErr) {
      console.warn('[recon] LLM JSON parse failed — falling back to simulation:', parseErr.message);
    }

    // Simulation-based component detection
    return this._simulateComponents(goalLower);
  }

  _simulateComponents(goalLower) {
    return [
      {
        name: 'requirements-spec',
        description: 'Requirement analysis and technical specifications for the application',
        priority: 1,
        dependsOn: [],
        techHints: ['Markdown', 'Tech Spec Template']
      },
      {
        name: 'architecture-design',
        description: 'System architecture design and database schema mapping',
        priority: 1,
        dependsOn: ['requirements-spec'],
        techHints: ['Mermaid.js', 'ERD Diagrams']
      },
      {
        name: 'database-migrations',
        description: 'Database migrations, seeds, and schema creation',
        priority: 1,
        dependsOn: ['architecture-design'],
        techHints: ['SQLite', 'SQL', 'Knex.js']
      },
      {
        name: 'models-and-orm',
        description: 'Data models, ORM definition, and database validation layers',
        priority: 1,
        dependsOn: ['database-migrations'],
        techHints: ['Sequelize', 'Mongoose', 'Plain JS Models']
      },
      {
        name: 'auth-security',
        description: 'User authentication, session, password hashing, and role permissions',
        priority: 1,
        dependsOn: ['models-and-orm'],
        techHints: ['JWT', 'bcrypt', 'Passport.js']
      },
      {
        name: 'logger-middleware',
        description: 'Structured JSON logger, request rate-limiter, and error-handling middleware',
        priority: 2,
        dependsOn: ['auth-security'],
        techHints: ['Winston', 'Morgan', 'Express Rate Limit']
      },
      {
        name: 'health-monitoring',
        description: 'System health check, diagnostics, and uptime monitoring APIs',
        priority: 2,
        dependsOn: ['logger-middleware'],
        techHints: ['Express health check', 'Process stats']
      },
      {
        name: 'core-services',
        description: 'Core business logic services, CRUD managers, and helper services',
        priority: 1,
        dependsOn: ['models-and-orm'],
        techHints: ['Services layer', 'Clean architecture']
      },
      {
        name: 'rest-api-endpoints',
        description: 'REST API controller routes and query parameter validation',
        priority: 1,
        dependsOn: ['core-services', 'auth-security'],
        techHints: ['Express Router', 'Joi/Zod']
      },
      {
        name: 'websocket-realtime',
        description: 'WebSocket server interface for real-time notification events',
        priority: 2,
        dependsOn: ['rest-api-endpoints'],
        techHints: ['ws', 'socket.io']
      },
      {
        name: 'frontend-boilerplate',
        description: 'Frontend framework entry, bundling config, and routing',
        priority: 1,
        dependsOn: [],
        techHints: ['Vite', 'Webpack', 'HTML5 Boilerplate']
      },
      {
        name: 'frontend-ui-components',
        description: 'Reusable visual components (buttons, input fields, layouts, styling)',
        priority: 2,
        dependsOn: ['frontend-boilerplate'],
        techHints: ['CSS Grid', 'Flexbox', 'Google Fonts']
      },
      {
        name: 'frontend-pages',
        description: 'Main application pages (dashboard, login/register, settings views)',
        priority: 1,
        dependsOn: ['frontend-ui-components'],
        techHints: ['Vanilla JS Views', 'Web Components']
      },
      {
        name: 'api-integration',
        description: 'Frontend REST & WebSocket client integration with API backend',
        priority: 1,
        dependsOn: ['frontend-pages', 'rest-api-endpoints', 'websocket-realtime'],
        techHints: ['Fetch API', 'WebSocket client']
      },
      {
        name: 'infra-config',
        description: 'Docker files, docker-compose, and environment configuration templates',
        priority: 2,
        dependsOn: ['api-integration'],
        techHints: ['Dockerfile', 'docker-compose.yml', '.env.example']
      },
      {
        name: 'deploy-pipeline',
        description: 'System bundle build, health checks, and launch verification scripts',
        priority: 2,
        dependsOn: ['infra-config'],
        techHints: ['npm build', 'Health ping script']
      }
    ];
  }

  _inferStack(goal) {
    const goalLower = goal.toLowerCase();
    const stack = ['Node.js', 'Express'];
    if (goalLower.includes('react') || goalLower.includes('dashboard')) stack.push('HTML5/CSS3');
    if (goalLower.includes('python') || goalLower.includes('ml') || goalLower.includes('ai')) stack.push('Python');
    if (goalLower.includes('docker') || goalLower.includes('kubernetes')) stack.push('Docker');
    if (goalLower.includes('postgres') || goalLower.includes('database')) stack.push('PostgreSQL');
    stack.push('WebSockets', 'JSON');
    return [...new Set(stack)];
  }
}

module.exports = ReconAgent;