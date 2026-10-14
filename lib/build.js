import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.js';

/** Build a run's designs in a child process, with a time limit. */
export function buildRun(runDir, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'lib', 'build-worker.js'), runDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`building took longer than ${timeoutMs / 1000}s`)); }, timeoutMs);
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`build worker exited ${code}: ${err.slice(-500)}`));
      resolve(JSON.parse(readFileSync(join(runDir, 'built.json'), 'utf8')));
    });
  });
}
