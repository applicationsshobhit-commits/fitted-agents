// Budget keeper. Plain code, not an agent: counting tokens with a model would
// spend the tokens it is meant to save.
//
// It records what every agent used and warns when one goes past its limit. It
// never stops a run; limits get set from real numbers once there are some.
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './paths.js';

const LEDGER = join(DATA, 'ledger.jsonl');
const CONFIG = join(DATA, 'budget.json');

/** Warn levels in fresh tokens (input + output + cache writes) per agent, per run. */
export const DEFAULT_LIMITS = {
  researcher: 300_000,
  designer: 1_500_000,
  supervisor: 300_000,
  extractor: 50_000,
};

export function limits() {
  try { return { ...DEFAULT_LIMITS, ...JSON.parse(readFileSync(CONFIG, 'utf8')) }; }
  catch { return DEFAULT_LIMITS; }
}

/** Collapse the SDK's per-model usage into one row. */
export function summarizeUsage(modelUsage = {}, costUsd = 0) {
  const row = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, models: Object.keys(modelUsage), costUsd };
  for (const u of Object.values(modelUsage)) {
    row.input += u.inputTokens || 0;
    row.output += u.outputTokens || 0;
    row.cacheRead += u.cacheReadInputTokens || 0;
    row.cacheWrite += u.cacheCreationInputTokens || 0;
  }
  row.fresh = row.input + row.output + row.cacheWrite;
  return row;
}

/**
 * Record one agent call. Returns a warning string when the agent's total for
 * this run has passed its limit, otherwise null.
 */
export function record({ runId, agent, stage, usage, durationMs }) {
  mkdirSync(DATA, { recursive: true });
  const row = { t: Date.now(), runId, agent, stage, durationMs, ...usage };
  appendFileSync(LEDGER, JSON.stringify(row) + '\n');
  const total = forRun(runId).filter(r => r.agent === agent).reduce((s, r) => s + r.fresh, 0);
  const limit = limits()[agent];
  return limit && total > limit
    ? `${agent} used ${total.toLocaleString()} tokens on this run, past its ${limit.toLocaleString()} warning level.`
    : null;
}

export function readLedger() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export const forRun = runId => readLedger().filter(r => r.runId === runId);

/** Totals per agent, for one run or across all of them. */
export function totals(rows = readLedger()) {
  const out = {};
  for (const r of rows) {
    const t = (out[r.agent] ||= { calls: 0, fresh: 0, cacheRead: 0, costUsd: 0, durationMs: 0 });
    t.calls++; t.fresh += r.fresh; t.cacheRead += r.cacheRead; t.costUsd += r.costUsd || 0; t.durationMs += r.durationMs || 0;
  }
  return out;
}
