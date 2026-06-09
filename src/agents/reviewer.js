'use strict';

const BaseAgent = require('./base');
const fs = require('fs');
const path = require('path');

class ReviewerAgent extends BaseAgent {
  constructor(orchestrator) {
    super('reviewer', orchestrator);
  }

  async execute(task) {
    const { files, outputDir, component } = task;
    this.log(`Starting code review for ${component} (${files.length} file(s))`);
    await this.sleep(400);

    const results = [];
    let passCount = 0;
    let failCount = 0;

    for (const filePath of files) {
      const fullPath = path.join(outputDir, filePath);
      let content = '';
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch {
        this.log(`  ✗ Could not read ${filePath}`, 'warn');
        continue;
      }

      this.log(`  Reviewing ${filePath}...`);
      await this.sleep(200 + Math.random() * 300);

      const issues = await this._reviewFile(filePath, content);
      const passed = issues.filter((i) => i.severity === 'error').length === 0;

      if (passed) {
        passCount++;
        this.log(`  ✓ ${filePath} — passed review`, 'success');
      } else {
        failCount++;
        issues
          .filter((i) => i.severity === 'error')
          .forEach((i) => this.log(`  ✗ ${filePath}: ${i.message}`, 'error'));
      }

      results.push({ file: filePath, issues, passed });
    }

    const allPassed = failCount === 0;
    this.log(
      allPassed
        ? `✓ Review passed: all ${passCount} file(s) clean`
        : `✗ Review failed: ${failCount} file(s) have errors`,
      allPassed ? 'success' : 'error'
    );

    return {
      passed: allPassed,
      results,
      errors: results
        .filter((r) => !r.passed)
        .flatMap((r) => r.issues.filter((i) => i.severity === 'error').map((i) => `${r.file}: ${i.message}`)),
    };
  }

  async _reviewFile(filePath, content) {
    const ext = path.extname(filePath).toLowerCase();
    const issues = [];

    // Structural checks (always run)
    if (content.trim().length === 0) {
      issues.push({ severity: 'error', message: 'File is empty', line: 0 });
      return issues;
    }

    // JS/TS specific checks
    if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
      issues.push(...this._reviewJS(content));
    }

    // HTML checks
    if (ext === '.html') {
      issues.push(...this._reviewHTML(content));
    }

    // CSS checks
    if (ext === '.css') {
      issues.push(...this._reviewCSS(content));
    }

    // General checks
    issues.push(...this._reviewGeneral(content, filePath));

    // Use LLM for deeper review if configured
    const hasRealLLM = this.orchestrator.config.anthropicKey ||
      this.orchestrator.config.openaiKey ||
      this.orchestrator.config.geminiKey;

    if (hasRealLLM && content.length < 8000) {
      const prompt = `Review this ${ext} file for security issues, bugs, and code quality. Respond with JSON array of {severity: 'error'|'warn'|'info', message: string}:\n\n${content}`;
      try {
        const llmResult = await this.callLLM(prompt);
        const match = llmResult.match(/\[[\s\S]*\]/);
        if (match) {
          const llmIssues = JSON.parse(match[0]);
          issues.push(...llmIssues.filter((i) => i.severity && i.message));
        }
      } catch {}
    }

    // Simulation: occasionally introduce a fake lint error to test self-correction loop
    if (!hasRealLLM && Math.random() < 0.15) {
      issues.push({
        severity: 'error',
        message: '[sim] Missing error handling in async function — wrap with try/catch',
        line: Math.floor(Math.random() * 30) + 10,
      });
    }

    return issues;
  }

  _reviewJS(content) {
    const issues = [];
    if (content.includes('eval(')) issues.push({ severity: 'error', message: 'Use of eval() is dangerous', line: 0 });
    if (content.includes('document.write(')) issues.push({ severity: 'warn', message: 'document.write() can cause XSS', line: 0 });
    if (/password\s*=\s*['"][^'"]{4,}/i.test(content)) issues.push({ severity: 'error', message: 'Possible hardcoded password detected', line: 0 });
    if (/api[_-]?key\s*=\s*['"][^'"]{10,}/i.test(content)) issues.push({ severity: 'error', message: 'Possible hardcoded API key detected', line: 0 });
    return issues;
  }

  _reviewHTML(content) {
    const issues = [];
    if (!content.includes('<!DOCTYPE')) issues.push({ severity: 'warn', message: 'Missing DOCTYPE declaration', line: 1 });
    if (!content.includes('<meta charset')) issues.push({ severity: 'warn', message: 'Missing charset meta tag', line: 0 });
    return issues;
  }

  _reviewCSS(content) {
    const issues = [];
    if (content.includes('!important') && content.split('!important').length > 5) {
      issues.push({ severity: 'warn', message: 'Excessive use of !important', line: 0 });
    }
    return issues;
  }

  _reviewGeneral(content, filePath) {
    const issues = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (line.includes('TODO') || line.includes('FIXME')) {
        issues.push({ severity: 'info', message: `Unresolved ${line.includes('TODO') ? 'TODO' : 'FIXME'} comment`, line: i + 1 });
      }
    });
    return issues;
  }
}

module.exports = ReviewerAgent;
