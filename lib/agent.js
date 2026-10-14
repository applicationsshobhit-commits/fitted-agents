// Runs one agent: a single Claude Agent SDK query with its own prompt file,
// tool allowance, and file boundaries. Every call goes through here so billing,
// usage and the stuck-agent watchdog are handled once.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { join, resolve, sep, isAbsolute } from 'node:path';
import { ROOT } from './paths.js';
import { billingStatus, scrubbedEnv } from './billing.js';
import { summarizeUsage, record } from './budget.js';

/** Agent definitions are markdown files: flat frontmatter, then the system prompt. */
export function loadAgent(name) {
  const raw = readFileSync(join(ROOT, 'agents', `${name}.md`), 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const meta = {};
  for (const line of (m?.[1] || '').split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return {
    name,
    prompt: (m?.[2] || raw).trim(),
    model: meta.model || 'sonnet',
    effort: meta.effort || 'medium',
    tools: meta.tools ? meta.tools.split(',').map(s => s.trim()).filter(Boolean) : [],
    maxTurns: Number(meta.maxTurns || 30),
    timeoutMs: Number(meta.timeoutMinutes || 10) * 60_000,
  };
}

const inside = (file, roots) => {
  const p = resolve(file);
  return roots.some(r => p === r || p.startsWith(r + sep));
};

export class AgentError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

/**
 * @param {object} o
 * @param {string} o.name        agent file in agents/
 * @param {string} o.runId       for the usage ledger
 * @param {string} o.cwd         working directory; always readable and writable
 * @param {string} o.task        the user message
 * @param {string[]} [o.readRoots]  extra directories the agent may read
 * @param {RegExp[]} [o.bashAllow]  the only Bash commands it may run
 * @param {object} [o.schema]    JSON schema for structured output
 * @param {(ev: object) => void} [o.onEvent]
 * @param {number} [o.idleMs]    abort if the agent produces nothing for this long
 */
export async function runAgent({ name, runId, cwd, task, readRoots = [], bashAllow = [], schema, onEvent = () => {}, idleMs = 4 * 60_000 }) {
  const billing = billingStatus();
  if (!billing.safe) throw new AgentError(`Refusing to run ${name}: ${billing.warnings.join(' ') || 'billing is not subscription-backed.'}`, 'billing');

  const def = loadAgent(name);
  const writeRoots = [resolve(cwd)];
  const readable = [...writeRoots, ...readRoots.map(r => resolve(r))];
  const abort = new AbortController();
  const started = Date.now();
  let lastActivity = Date.now();
  let why = null;

  // Watchdog: a hard ceiling on the whole call, and a shorter one on silence.
  const watchdog = setInterval(() => {
    if (Date.now() - started > def.timeoutMs) { why = `took longer than ${def.timeoutMs / 60_000} minutes`; abort.abort(); }
    else if (Date.now() - lastActivity > idleMs) { why = `produced nothing for ${Math.round(idleMs / 60_000)} minutes`; abort.abort(); }
  }, 5000);

  /** Why this tool call is not allowed, or null if it is. */
  const guard = (tool, input) => {
    const path = input.file_path || input.path || input.notebook_path;
    const abs = path && (isAbsolute(path) ? path : join(cwd, path));
    if (['Write', 'Edit', 'NotebookEdit'].includes(tool)) {
      if (!abs || !inside(abs, writeRoots)) return `${name} may only write inside ${cwd}`;
    } else if (['Read', 'Glob', 'Grep'].includes(tool)) {
      if (abs && !inside(abs, readable)) return `${name} may not read ${path}`;
    } else if (tool === 'Bash') {
      const cmd = String(input.command || '').trim();
      if (!bashAllow.some(re => re.test(cmd)) || /[;&|`$<>]|\n/.test(cmd)) return `${name} may not run: ${cmd.slice(0, 80)}. Use the Read tool to read files.`;
    }
    return null;
  };

  const q = query({
    prompt: task,
    options: {
      cwd,
      env: scrubbedEnv(),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: def.prompt },
      model: def.model,
      effort: def.effort,
      tools: def.tools,
      maxTurns: def.maxTurns,
      // Isolation: no user settings, hooks, or CLAUDE.md files leak into the agent.
      settingSources: [],
      persistSession: false,
      permissionMode: 'default',
      abortController: abort,
      ...(schema ? { outputFormat: { type: 'json_schema', schema } } : {}),
      // The boundary check runs as a PreToolUse hook because hooks see every call,
      // including ones the CLI would otherwise auto-approve (read-only shell commands).
      hooks: { PreToolUse: [{ hooks: [async input => {
        const reason = guard(input.tool_name, input.tool_input || {});
        if (!reason) return {};
        onEvent({ type: 'denied', agent: name, tool: input.tool_name, message: reason });
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
      }] }] },
      canUseTool: async (tool, input) => {
        const reason = guard(tool, input);
        return reason ? { behavior: 'deny', message: reason } : { behavior: 'allow', updatedInput: input };
      },
    },
  });

  let result = null;
  try {
    for await (const msg of q) {
      lastActivity = Date.now();
      if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
        for (const b of msg.message?.content || []) {
          if (b.type === 'text' && b.text.trim()) onEvent({ type: 'text', agent: name, text: b.text });
          else if (b.type === 'tool_use') onEvent({ type: 'tool', agent: name, name: b.name, input: clip(b.input) });
        }
      } else if (msg.type === 'result') {
        result = msg;
      }
    }
  } catch (err) {
    if (!why) throw new AgentError(`${name} crashed: ${err.message || err}`, 'crash');
  } finally {
    clearInterval(watchdog);
  }

  const durationMs = Date.now() - started;
  const usage = summarizeUsage(result?.modelUsage, result?.total_cost_usd);
  const warning = record({ runId, agent: name, stage: name, usage, durationMs });
  if (warning) onEvent({ type: 'budget', agent: name, warning });

  if (why) throw new AgentError(`${name} was stopped: it ${why}.`, 'stuck');
  if (!result) throw new AgentError(`${name} ended without a result.`, 'crash');
  if (result.subtype !== 'success') throw new AgentError(`${name} failed: ${result.subtype.replace(/_/g, ' ')}.`, result.subtype);

  return { output: schema ? result.structured_output : result.result, text: result.result, usage, durationMs };
}

function clip(input = {}) {
  const s = input.command || input.file_path || input.pattern || input.path || JSON.stringify(input);
  return String(s).length > 140 ? String(s).slice(0, 140) + '…' : String(s);
}
