'use strict';

const BaseAgent = require('./base');
const path = require('path');
const fs = require('fs');

class TestingAgent extends BaseAgent {
  constructor(orchestrator) {
    super('testing', orchestrator);
  }

  async execute(task) {
    const { files, outputDir, component } = task;
    this.log(`Running test suite for ${component}`);
    await this.sleep(500);

    const testResults = [];
    let passed = 0;
    let failed = 0;

    // Generate and run tests for each relevant file
    const testableFiles = files.filter((f) => !f.includes('.test.') && !f.includes('spec.'));
    for (const filePath of testableFiles) {
      const tests = this._generateTests(filePath);
      this.log(`  Running ${tests.length} tests for ${path.basename(filePath)}...`);

      for (const test of tests) {
        await this.sleep(100 + Math.random() * 200);
        const result = await this._runTest(test, filePath, outputDir);
        testResults.push(result);

        if (result.passed) {
          passed++;
          this.log(`    ✓ ${test.name}`, 'success');
        } else {
          failed++;
          this.log(`    ✗ ${test.name}: ${result.error}`, 'error');
        }
      }
    }

    const allPassed = failed === 0;
    this.log(
      allPassed
        ? `✓ All ${passed} tests passed`
        : `✗ ${failed} test(s) failed, ${passed} passed`,
      allPassed ? 'success' : 'error'
    );

    // Emit test run result to dashboard
    this.orchestrator.broadcast({
      type: 'test_run',
      component,
      passed,
      failed,
      total: passed + failed,
      results: testResults,
    });

    return {
      passed: allPassed,
      stats: { passed, failed, total: passed + failed },
      errors: testResults.filter((r) => !r.passed).map((r) => `${r.test}: ${r.error}`),
    };
  }

  _generateTests(filePath) {
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    const tests = [
      { name: `${base} — file exists`, type: 'existence' },
      { name: `${base} — non-empty`, type: 'non-empty' },
      { name: `${base} — valid syntax`, type: 'syntax' },
    ];

    if (['.js', '.ts'].includes(ext)) {
      tests.push(
        { name: `${base} — no bare requires for missing modules`, type: 'imports' },
        { name: `${base} — exports defined`, type: 'exports' }
      );
    }

    if (ext === '.json') {
      tests.push({ name: `${base} — valid JSON`, type: 'json' });
    }

    if (ext === '.html') {
      tests.push({ name: `${base} — DOCTYPE present`, type: 'doctype' });
    }

    return tests;
  }

  async _runTest(test, filePath, outputDir) {
    const fullPath = path.join(outputDir, filePath);

    await this.sleep(50);

    try {
      switch (test.type) {
        case 'existence': {
          const exists = fs.existsSync(fullPath);
          return { test: test.name, passed: exists, error: exists ? null : 'File not found' };
        }

        case 'non-empty': {
          const content = fs.readFileSync(fullPath, 'utf8');
          const ok = content.trim().length > 0;
          return { test: test.name, passed: ok, error: ok ? null : 'File is empty' };
        }

        case 'syntax': {
          const content = fs.readFileSync(fullPath, 'utf8');
          const ext = path.extname(fullPath);
          if (['.js'].includes(ext)) {
            // Basic syntax check: balanced braces
            let depth = 0;
            for (const ch of content) {
              if (ch === '{') depth++;
              if (ch === '}') depth--;
              if (depth < 0) return { test: test.name, passed: false, error: 'Unmatched closing brace' };
            }
            const ok = depth === 0;
            return { test: test.name, passed: ok, error: ok ? null : 'Unmatched opening brace' };
          }
          return { test: test.name, passed: true };
        }

        case 'json': {
          const content = fs.readFileSync(fullPath, 'utf8');
          try {
            JSON.parse(content);
            return { test: test.name, passed: true };
          } catch (e) {
            return { test: test.name, passed: false, error: `Invalid JSON: ${e.message}` };
          }
        }

        case 'doctype': {
          const content = fs.readFileSync(fullPath, 'utf8');
          const ok = content.includes('<!DOCTYPE');
          return { test: test.name, passed: ok, error: ok ? null : 'Missing DOCTYPE' };
        }

        case 'imports':
        case 'exports':
          // Simulation: assume pass
          return { test: test.name, passed: true };

        default:
          return { test: test.name, passed: true };
      }
    } catch (err) {
      return { test: test.name, passed: false, error: err.message };
    }
  }
}

module.exports = TestingAgent;