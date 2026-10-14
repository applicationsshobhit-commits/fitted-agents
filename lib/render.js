// Renders STL files to PNG with headless Chrome, using the same viewer the
// dashboard shows. No AI and no extra dependencies: Chrome is already installed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PORT } from './paths.js';

const CHROME = process.env.FITTED_CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(existsSync);

export const canRender = () => Boolean(CHROME);

/** Screenshot render.html for one STL served by this server. */
export function renderStl(stlUrlPath, pngFile, timeoutMs = 45_000) {
  if (!CHROME) return Promise.reject(new Error('Google Chrome is not installed, so renders are skipped'));
  const url = `http://127.0.0.1:${PORT}/ui/render.html?stl=${encodeURIComponent(stlUrlPath)}`;
  const args = [
    '--headless=new', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    `--user-data-dir=${process.env.TMPDIR || '/tmp'}/fitted-render-profile`,
    '--window-size=900,640', '--virtual-time-budget=15000', `--screenshot=${pngFile}`, url,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, args, { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('render timed out')); }, timeoutMs);
    child.on('exit', code => {
      clearTimeout(timer);
      code === 0 && existsSync(pngFile) ? resolve(pngFile) : reject(new Error(`Chrome exited ${code}`));
    });
  });
}
