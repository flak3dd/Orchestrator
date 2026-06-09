'use strict';

const { EventEmitter } = require('events');

class BaseAgent extends EventEmitter {
  constructor(name, orchestrator) {
    super();
    this.name = name;
    this.orchestrator = orchestrator;
    this.status = 'idle'; // idle | running | success | error
    this.currentTask = null;
  }

  // ── Shared system prompt injected into every LLM call ─────────────────
  get _systemPrompt() {
    return `You are a senior software architect and principal engineer with 20+ years of production experience. You produce code that is complete, secure, and ready to ship.

ARCHITECTURE PRINCIPLES:
- SOLID: Single responsibility, Open/closed, Liskov substitution, Interface segregation, Dependency inversion
- Clean architecture: controllers handle HTTP only, services own business logic, repositories own data access
- Dependency injection over module-level singletons — makes code testable without mocking globals
- Event-driven where appropriate; avoid tight coupling between subsystems
- Design patterns used explicitly and named in comments (Factory, Strategy, Observer, Repository, Circuit Breaker, etc.)

SECURITY (non-negotiable):
- Every route handler checks authentication BEFORE touching business logic
- CSRF tokens verified on all state-mutating endpoints (POST/PUT/PATCH/DELETE)
- All user input validated and sanitized before use — never trust req.body, req.params, req.query
- Secrets only from environment variables — never hardcoded, never in logs
- SQL/NoSQL injection prevented via parameterised queries or ORMs; no string concatenation in queries
- Rate limiting on auth endpoints; exponential backoff hints in error responses
- Principle of least privilege: functions request only the permissions they need

ERROR HANDLING:
- Every async operation wrapped in try/catch with meaningful error context
- Errors propagated upward — never silently swallowed. Use: throw, next(err), or return Result<T, E>
- User-facing errors strip internal details; developer-facing logs include full stack + context
- Circuit breaker pattern for external service calls (LLMs, APIs, DBs)
- Graceful degradation: if a non-critical subsystem fails, the core keeps running

OBSERVABILITY:
- Structured JSON logging with: timestamp, level, requestId, userId, duration, error
- Performance: log slow operations (>500ms), DB query times, external API latencies
- Health check endpoint at GET /health returning { status, uptime, version, dependencies }
- Metrics hooks at key operations (builds started, files generated, test pass/fail rates)

CODE STYLE:
- Explicit over clever — if someone needs to think twice to understand it, rewrite it
- Every exported class and function has JSDoc with @param types and @returns
- Constants in SCREAMING_SNAKE_CASE at the top of the file, not magic values inline
- No dead code, no commented-out blocks, no TODO/FIXME in generated output
- Prefer composition over inheritance; prefer pure functions over methods with side effects

OUTPUT FORMAT — YOU MUST FOLLOW THIS EXACTLY:
For each file you generate, use this delimiter format:
  --- path/to/filename.ext ---
  [complete file content — never truncate, never use ellipsis]
  --- END ---

After all files, include:
## Implementation Notes
- Explain the key architectural decisions and why you made them
- List any assumptions about the environment or dependencies
- Describe the data flow through the system
- Note any security considerations the developer should be aware of
- Suggest the next implementation steps

COMPLETENESS REQUIREMENT:
Never write "// ... rest of implementation" or "// TODO: implement this".
Every function body must be complete. Every error path must be handled.
If a file would be very long, split it into logical modules and generate each one.`;
  }

  log(message, level = 'info') {
    const entry = {
      agent: this.name,
      message,
      level,
      timestamp: new Date().toISOString(),
    };
    this.orchestrator.broadcast({ type: 'agent_log', ...entry });
    return entry;
  }

  setStatus(status, detail = '') {
    this.status = status;
    this.orchestrator.broadcast({
      type: 'agent_status',
      agent: this.name,
      status,
      detail,
    });
  }

  async run(task) {
    this.currentTask = task;
    this.setStatus('running', task.description || '');
    try {
      const result = await this.execute(task);
      this.setStatus('success');
      this.currentTask = null;
      return result;
    } catch (err) {
      this.setStatus('error', err.message);
      this.currentTask = null;
      throw err;
    }
  }

  // Override in subclasses
  async execute(task) {
    throw new Error(`${this.name}.execute() not implemented`);
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── LLM dispatch ────────────────────────────────────────────────────────
  async callLLM(prompt, context = {}) {
    const cfg = this.orchestrator.config;
    if (cfg.anthropicKey) return this._callAnthropic(prompt, cfg.anthropicKey);
    if (cfg.openaiKey)    return this._callOpenAI(prompt, cfg.openaiKey);
    if (cfg.geminiKey)    return this._callGemini(prompt, cfg.geminiKey);
    if (cfg.ollamaUrl)    return this._callOllama(prompt, cfg.ollamaUrl);
    return this._simulate(prompt, context);
  }

  async _callAnthropic(prompt, key) {
    this.log(`→ Claude (claude-sonnet-4-6) · ${prompt.length.toLocaleString()} chars`);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: this._systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      let body = '';
      try { body = await response.text(); } catch {}
      throw new Error(`Anthropic API error: ${response.status} — ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const text = data.content.map(b => b.text || '').join('');

    this.log(`← ${text.length.toLocaleString()} chars · ${data.usage?.output_tokens ?? '?'} tokens`, 'success');
    await this._streamToTerminal(text);
    return text;
  }

  async _callOpenAI(prompt, key) {
    this.log(`→ OpenAI (gpt-4o) · ${prompt.length.toLocaleString()} chars`);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: this._systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: 8192,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      let body = '';
      try { body = await response.text(); } catch {}
      throw new Error(`OpenAI API error: ${response.status} — ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const text = data.choices[0].message.content;
    this.log(`← ${text.length.toLocaleString()} chars`, 'success');
    await this._streamToTerminal(text);
    return text;
  }

  async _callGemini(prompt, key) {
    this.log(`→ Gemini (gemini-1.5-pro) · ${prompt.length.toLocaleString()} chars`);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${key}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: this._systemPrompt }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 8192, temperature: 0.2 },
      }),
    });

    if (!response.ok) {
      let body = '';
      try { body = await response.text(); } catch {}
      throw new Error(`Gemini API error: ${response.status} — ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const text = data.candidates[0].content.parts[0].text;
    this.log(`← ${text.length.toLocaleString()} chars`, 'success');
    await this._streamToTerminal(text);
    return text;
  }

  async _callOllama(prompt, baseUrl) {
    this.log(`→ Ollama @ ${baseUrl}`);

    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3',
        system: this._systemPrompt,
        prompt,
        stream: false,
        options: { num_predict: 8192, temperature: 0.2 },
      }),
    });

    if (!response.ok) throw new Error(`Ollama error: ${response.status}`);
    const data = await response.json();
    await this._streamToTerminal(data.response);
    return data.response;
  }

  // Stream LLM output line-by-line to the dashboard terminal
  async _streamToTerminal(text) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        this.orchestrator.broadcast({
          type: 'llm_stream',
          agent: this.name,
          chunk: line,
        });
        await this.sleep(6);
      }
    }
  }

  async _simulate(prompt, context) {
    await this.sleep(350 + Math.random() * 350);
    return `[SIMULATION] ${this.name} processed: "${prompt.slice(0, 60)}..."`;
  }
}

module.exports = BaseAgent;
