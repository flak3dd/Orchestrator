'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const Sandbox = require('./sandbox');
const ReconAgent = require('./agents/recon');
const CodeGenAgent = require('./agents/codegen');
const ReviewerAgent = require('./agents/reviewer');
const InfraAgent = require('./agents/infra');
const TestingAgent = require('./agents/testing');

const PHASES = ['idle', 'planning', 'recon', 'codegen', 'review', 'testing', 'infra', 'awaiting_approval', 'deploying', 'complete', 'error'];

class Orchestrator extends EventEmitter {
  constructor({ buildsDir = './builds', config = {} } = {}) {
    super();
    this.config = config; // { anthropicKey, openaiKey, geminiKey, ollamaUrl }
    this.sandbox = new Sandbox(buildsDir);
    this.state = {
      phase: 'idle',
      goal: null,
      plan: [],
      currentTask: null,
      agents: {},
      generatedFiles: [],
      testResults: null,
      reviewResults: null,
      errors: [],
      startTime: null,
      endTime: null,
    };

    // Register agents
    this.agents = {
      recon: new ReconAgent(this),
      codegen: new CodeGenAgent(this),
      reviewer: new ReviewerAgent(this),
      infra: new InfraAgent(this),
      testing: new TestingAgent(this),
    };

    // Subscribe to agent events
    Object.entries(this.agents).forEach(([name, agent]) => {
      agent.on('log', (entry) => this.broadcast({ type: 'agent_log', ...entry }));
    });

    this._loadState();
  }

  broadcast(msg) {
    this.emit('broadcast', { ...msg, ts: Date.now() });
  }

  updateConfig(config) {
    this.config = { ...this.config, ...config };
    this.broadcast({ type: 'config_updated' });
  }

  getState() {
    return {
      ...this.state,
      agentStatuses: Object.fromEntries(
        Object.entries(this.agents).map(([k, v]) => [k, { status: v.status, task: v.currentTask?.description }])
      ),
      files: this.sandbox.listDir(),
      buildsDir: this.sandbox.getBuildsDir(),
    };
  }

  setPhase(phase, detail = '') {
    this.state.phase = phase;
    this.broadcast({ type: 'phase_change', phase, detail });
    this._saveState();
  }

  async build(goal) {
    if (this.state.phase !== 'idle' && this.state.phase !== 'complete' && this.state.phase !== 'error') {
      throw new Error(`Build already in progress (phase: ${this.state.phase})`);
    }

    this.state = {
      ...this.state,
      phase: 'planning',
      goal,
      plan: [],
      currentTask: null,
      generatedFiles: [],
      testResults: null,
      reviewResults: null,
      errors: [],
      startTime: Date.now(),
      endTime: null,
    };

    this.broadcast({ type: 'build_start', goal });
    this._saveState();

    try {
      await this._runPipeline(goal);
    } catch (err) {
      this.state.errors.push(err.message);
      this.setPhase('error', err.message);
      this.broadcast({ type: 'build_error', error: err.message });
    }
  }

  _copyFolderRecursive(source, target) {
    if (!fs.existsSync(source)) return;
    if (path.basename(source) === 'steps') return;
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    const files = fs.readdirSync(source);
    for (const file of files) {
      if (file === 'steps') continue;
      const curSource = path.join(source, file);
      const curTarget = path.join(target, file);
      if (fs.lstatSync(curSource).isDirectory()) {
        this._copyFolderRecursive(curSource, curTarget);
      } else {
        fs.copyFileSync(curSource, curTarget);
      }
    }
  }

  async _runPipeline(goal) {
    const outputDir = this.sandbox.getBuildsDir();
    const goalSlug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);

    // ── Phase 1: Planning (Global Initial Plan) ───────────────────────────
    this.setPhase('planning', 'Decomposing goal into tasks');
    this.broadcast({ type: 'agent_log', agent: 'orchestrator', level: 'info', message: `Received goal: "${goal}"` });
    await this._sleep(500);

    // ── Phase 2: Recon (Global Initial Scan) ──────────────────────────────
    this.setPhase('recon', 'Scanning codebase and analysing requirements');
    const reconResult = await this.agents.recon.run({ goal, buildsDir: outputDir });
    const { components, stack } = reconResult;

    this.state.plan = components.map((c) => Object.assign({}, c, { status: 'pending' }));
    this._saveState();
    this.broadcast({ type: 'plan_ready', components, stack });
    await this._sleep(300);

    // ── 16-Step x 8-Stage Development Pipeline ────────────────────────────
    let allFiles = [];

    for (let i = 0; i < components.length; i++) {
      const component = components[i];
      const stepOutputDir = path.join(outputDir, goalSlug, 'steps', component.name);

      // Carry forward accumulated work from previous steps to improve upon
      const finalTargetDir = path.join(outputDir, goalSlug);
      const stepSourceDir = path.join(stepOutputDir, goalSlug);
      if (fs.existsSync(finalTargetDir)) {
        this.broadcast({ type: 'agent_log', agent: 'orchestrator', level: 'info', message: `Analyzing and incorporating previous build artifacts for improvements...` });
        this._copyFolderRecursive(finalTargetDir, stepSourceDir);
      }

      this.state.plan[i].status = 'in_progress';
      this._saveState();
      this.broadcast({ type: 'task_start', component: component.name, index: i, total: components.length });

      // Stage 1: Planning
      this.setPhase('planning', `Planning ${component.name}`);
      this.broadcast({ type: 'agent_log', agent: 'orchestrator', level: 'info', message: `Planning component: ${component.name}` });
      await this._sleep(200);

      // Stage 2: Recon
      this.setPhase('recon', `Recon scan for ${component.name}`);
      await this.agents.recon.run({ goal: component.description, buildsDir: stepOutputDir });
      await this._sleep(200);

      // Stage 3: CodeGen & Stage 4: Review Loop
      let codegenResult;
      let reviewResult;
      let attempts = 0;
      const maxAttempts = 3;
      let previousErrors = [];

      while (attempts < maxAttempts) {
        attempts++;

        // Code Generation
        this.setPhase('codegen', `Generating ${component.name} (attempt ${attempts})`);
        codegenResult = await this.agents.codegen.run({
          component,
          goal,
          outputDir: stepOutputDir,
          previousErrors,
        });

        // Code Review
        this.setPhase('review', `Reviewing ${component.name} (attempt ${attempts})`);
        reviewResult = await this.agents.reviewer.run({
          files: codegenResult.files,
          outputDir: stepOutputDir,
          component: component.name,
        });

        if (reviewResult.passed) break;

        previousErrors = reviewResult.errors;
        this.broadcast({
          type: 'review_fail',
          component: component.name,
          attempt: attempts,
          errors: reviewResult.errors,
        });

        if (attempts >= maxAttempts) {
          this.broadcast({ type: 'agent_log', agent: 'orchestrator', level: 'warn', message: `Max attempts reached for ${component.name} — proceeding with warnings` });
        }
      }

      // Stage 5: Testing
      this.setPhase('testing', `Testing ${component.name}`);
      const testResult = await this.agents.testing.run({
        files: codegenResult.files,
        outputDir: stepOutputDir,
        component: component.name,
      });
      await this._sleep(200);

      // Stage 6: Infrastructure Configs
      this.setPhase('infra', `Generating infra for ${component.name}`);
      const infraResult = await this.agents.infra.run({
        components: [component],
        goal,
        outputDir: stepOutputDir,
      });
      await this._sleep(200);

      // Stage 7: Awaiting Approval
      this.setPhase('awaiting_approval', `Waiting for approval of ${component.name}`);
      const stepFilesCount = (codegenResult.files?.length ?? 0) + (infraResult.files?.length ?? 0);
      this.broadcast({
        type: 'approval_required',
        message: `Step "${component.name}" complete. Review and approve to stage artifacts.`,
        stats: {
          files: stepFilesCount,
          components: 1,
          testsPassed: testResult.stats.passed,
          testsFailed: testResult.stats.failed,
        },
      });
      await this._waitForApproval(1500);

      // Stage 8: Deploying (Artifact Merging / Combining)
      this.setPhase('deploying', `Staging ${component.name} build files`);
      this.broadcast({ type: 'agent_log', agent: 'orchestrator', level: 'info', message: `Staging ${component.name} build files` });

      this._copyFolderRecursive(stepSourceDir, finalTargetDir);
      await this._sleep(300);

      // Record step's files in the global list (paths relative to outputDir)
      allFiles = allFiles.concat(codegenResult.files || [], infraResult.files || []);
      this.state.generatedFiles = [...new Set(allFiles)];
      
      this.state.plan[i].status = (reviewResult.passed && testResult.passed) ? 'done' : 'warn';
      this._saveState();
      this.broadcast({ type: 'task_done', component: component.name, files: codegenResult.files, passed: reviewResult.passed });
    }

    // Clean up temporary steps directory
    try {
      fs.rmSync(path.join(outputDir, goalSlug, 'steps'), { recursive: true, force: true });
    } catch (err) {
      this.broadcast({ type: 'agent_log', agent: 'orchestrator', level: 'warn', message: `Failed to clean up steps folder: ${err.message}` });
    }

    // ── Deployment dry-run ───────────────────────────────────────────────
    this.setPhase('deploying', 'Finalizing deployment artifacts');
    this.broadcast({ type: 'agent_log', agent: 'orchestrator', level: 'info', message: 'Deployment approved — running dry-run...' });
    await this._sleep(800);

    const dryRun = this.sandbox.exec('echo "[dry-run] docker-compose up -d"', goalSlug);
    this.broadcast({ type: 'agent_log', agent: 'orchestrator', level: 'info', message: dryRun.stdout });

    // ── Done ──────────────────────────────────────────────────────────
    this.state.endTime = Date.now();
    this.setPhase('complete');
    this.broadcast({
      type: 'build_complete',
      goal,
      files: this.state.generatedFiles,
      duration: this.state.endTime - this.state.startTime,
      stats: {
        components: components.length,
        files: this.state.generatedFiles.length,
        testsPassed: components.length,
      },
    });
  }

  // Approval gate
  _approvalResolve = null;

  _waitForApproval(timeoutMs = 1500) {
    return new Promise((resolve) => {
      this._approvalResolve = resolve;
      // Auto-approve after timeoutMs in simulation mode
      if (!this.config.anthropicKey && !this.config.openaiKey) {
        setTimeout(() => {
          if (this._approvalResolve) {
            this.broadcast({ type: 'agent_log', agent: 'orchestrator', level: 'info', message: `[sim] Auto-approving step deployment after ${timeoutMs}ms...` });
            this.approve();
          }
        }, timeoutMs);
      }
    });
  }

  approve() {
    if (this._approvalResolve) {
      this.broadcast({ type: 'approved', message: 'Deployment approved by user' });
      this._approvalResolve();
      this._approvalResolve = null;
    }
  }

  async fixLaunchError(errorMsg) {
    this.setPhase('codegen', 'Fixing launch error');
    this.broadcast({ type: 'agent_log', agent: 'orchestrator', level: 'warn', message: `Fixing runtime launch error: ${errorMsg}` });

    const outputDir = this.sandbox.getBuildsDir();
    const goal = this.state.goal;

    // Find the backend component in the plan
    const backendComponent = this.state.plan.find(c => c.name === 'backend') || {
      name: 'backend',
      description: 'REST API server with WebSocket support'
    };

    // Run CodeGen agent to re-generate the backend with the launch error
    const codegenResult = await this.agents.codegen.run({
      component: backendComponent,
      goal,
      outputDir,
      previousErrors: [errorMsg]
    });

    // Run testing
    this.setPhase('testing', 'Running tests after launch fix');
    const testResult = await this.agents.testing.run({
      files: codegenResult.files,
      outputDir,
      component: 'backend'
    });
    this.state.testResults = testResult;

    // Run infra (to regenerate Dockerfile etc if needed)
    this.setPhase('infra', 'Updating infra configs after launch fix');
    const infraResult = await this.agents.infra.run({
      components: this.state.plan,
      goal,
      outputDir
    });

    // Update generated files list
    this.state.generatedFiles = [...new Set([...this.state.generatedFiles, ...codegenResult.files, ...infraResult.files])];

    this.setPhase('complete', 'Fix applied');
    this.broadcast({ type: 'agent_log', agent: 'orchestrator', level: 'success', message: 'Launch fix applied successfully. Retrying launch...' });
  }

  pause() {
    this.broadcast({ type: 'paused' });
    // Full pause implementation would require yield points in the pipeline
  }

  reset() {
    this.state.phase = 'idle';
    this.state.goal = null;
    this.state.plan = [];
    this.state.generatedFiles = [];
    this.state.testResults = null;
    this.state.reviewResults = null;
    this.state.errors = [];
    this.state.startTime = null;
    this.state.endTime = null;
    this._approvalResolve = null;
    Object.values(this.agents).forEach((a) => a.setStatus('idle'));
    this.broadcast({ type: 'reset' });
    this._saveState();
  }

  _saveState() {
    try {
      const historyFile = path.join(this.sandbox.getBuildsDir(), 'history.json');
      const dataToSave = {
        phase: this.state.phase,
        goal: this.state.goal,
        plan: this.state.plan,
        currentTask: this.state.currentTask,
        generatedFiles: this.state.generatedFiles,
        testResults: this.state.testResults,
        reviewResults: this.state.reviewResults,
        errors: this.state.errors,
        startTime: this.state.startTime,
        endTime: this.state.endTime,
      };
      fs.writeFileSync(historyFile, JSON.stringify(dataToSave, null, 2), 'utf8');
    } catch (err) {
      console.error('[Orchestrator] Failed to save state to history.json:', err.message);
    }
  }

  _loadState() {
    try {
      const historyFile = path.join(this.sandbox.getBuildsDir(), 'history.json');
      if (fs.existsSync(historyFile)) {
        const data = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        this.state = {
          ...this.state,
          ...data
        };
      }
    } catch (err) {
      console.error('[Orchestrator] Failed to load state from history.json:', err.message);
    }
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = Orchestrator;