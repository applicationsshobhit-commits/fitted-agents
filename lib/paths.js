// Every location the pipeline reads or writes, in one place.
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The capture app and the built-in designs live in the fitted repo. */
export const FITTED = process.env.FITTED_DIR || join(homedir(), 'fitted');
export const DATA = process.env.FITTED_DATA || join(ROOT, 'data');
export const RUNS = join(DATA, 'runs');
export const CORPUS = join(DATA, 'corpus');
export const DEVICES = join(ROOT, 'devices');
// Outside ~/Documents on purpose: macOS blocks background processes from
// protected folders without an error, and the server may run as a LaunchAgent.
export const VAULT = process.env.FITTED_VAULT || join(homedir(), 'Fitted Vault');
export const PORT = Number(process.env.FITTED_AGENTS_PORT || 7790);
