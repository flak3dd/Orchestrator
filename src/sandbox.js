'use strict';

const fs = require('fs');
const path = require('path');
// child_process is required lazily inside exec()

class Sandbox {
  constructor(buildsDir) {
    this.buildsDir = path.resolve(buildsDir);
    fs.mkdirSync(this.buildsDir, { recursive: true });
  }

  // Safely resolve a path inside the sandbox — throws on path traversal
  resolveSafe(relativePath) {
    const resolved = path.resolve(this.buildsDir, relativePath);
    if (!resolved.startsWith(this.buildsDir + path.sep) && resolved !== this.buildsDir) {
      throw new Error(`Path traversal denied: ${relativePath}`);
    }
    return resolved;
  }

  writeFile(relativePath, content) {
    const fullPath = this.resolveSafe(relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    return fullPath;
  }

  readFile(relativePath) {
    const fullPath = this.resolveSafe(relativePath);
    return fs.readFileSync(fullPath, 'utf8');
  }

  exists(relativePath) {
    try {
      const fullPath = this.resolveSafe(relativePath);
      return fs.existsSync(fullPath);
    } catch {
      return false;
    }
  }

  listDir(relativePath = '') {
    const fullPath = this.resolveSafe(relativePath);
    if (!fs.existsSync(fullPath)) return [];

    const walk = (dir, base = '') => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        const relPath = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          result.push({ type: 'dir', path: relPath, name: entry.name });
          result.push(...walk(path.join(dir, entry.name), relPath));
        } else {
          const stat = fs.statSync(path.join(dir, entry.name));
          result.push({ type: 'file', path: relPath, name: entry.name, size: stat.size });
        }
      }
      return result;
    };

    return walk(fullPath);
  }

  /**
   * Run a shell command inside the sandbox.
   * Uses async exec — never blocks the Node event loop.
   * @param {string} command
   * @param {string} [cwd]
   * @param {{ dryRun?: boolean }} [opts]
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, dryRun?: boolean }>}
   */
  async exec(command, cwd = '', { dryRun = true } = {}) {
    if (dryRun) {
      return { dryRun: true, exitCode: 0, command, cwd, stdout: `[dry-run] Would execute: ${command}`, stderr: '' };
    }

    const workDir = cwd ? this.resolveSafe(cwd) : this.buildsDir;
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      exec(command, { cwd: workDir, timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ exitCode: err.code ?? 1, stdout: stdout ?? '', stderr: stderr ?? err.message });
        } else {
          resolve({ exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
        }
      });
    });
  }

  getBuildsDir() {
    return this.buildsDir;
  }
}

module.exports = Sandbox;