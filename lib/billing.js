// Copied from herd/server/billing.js: refuses to run agents that could bill per token.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Env vars that, if set, make the CLI bill per-token against an API account. */
const PAID_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * What would this machine bill against right now?
 * Subscription OAuth is free at the point of use; an API key is real money.
 */
export function billingStatus() {
  const present = PAID_KEYS.filter(k => process.env[k]);
  let account = null;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
    const o = cfg.oauthAccount || {};
    account = {
      billingType: o.billingType || null,
      plan: o.organizationType || null,
      extraUsageEnabled: o.hasExtraUsageEnabled === true,
    };
  } catch { /* config unreadable — treat as unknown below */ }

  const subscription = account?.billingType === 'stripe_subscription';
  const mode = present.length ? 'api-key' : subscription ? 'subscription' : 'unknown';

  const warnings = [];
  if (present.length) warnings.push(`${present.join(' and ')} set in the environment — runs would bill per token.`);
  if (!account) warnings.push('Could not read account config; billing mode unverified.');
  else if (!subscription) warnings.push(`Account billingType is "${account.billingType}", not a subscription.`);
  if (account?.extraUsageEnabled) warnings.push('Extra usage is ENABLED — hitting your limit spills into paid API usage.');

  return { mode, safe: mode === 'subscription' && !account?.extraUsageEnabled, account, paidKeysPresent: present, warnings };
}

/**
 * Environment for the spawned CLI with every paid-billing credential removed,
 * so an API key in the parent process can never silently route a run to money.
 */
export function scrubbedEnv() {
  const env = { ...process.env };
  for (const k of PAID_KEYS) delete env[k];
  return env;
}
