import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { chromium } from 'playwright';
import { artifactDirectory } from '../scripts/safe-files.mjs';

const root = path.resolve(import.meta.dirname, '..');
const executable = path.join(root, 'release', 'windows', 'win-unpacked', 'Orbit Lab.exe');
const wire = await getCurrentFuseWire(executable);
for (const [name, enabled] of Object.entries({
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
})) {
  assert.equal(wire[FuseV1Options[name]], (enabled ? '1' : '0').charCodeAt(0), name);
}

// Playwright's Electron driver needs the Node inspector. Check the actual
// release with the Chromium debugger, and reserve main-process instrumentation
// for the separately packaged native integration tests.
const output = artifactDirectory(root, 'output/desktop-release');
const profile = path.join(output, 'profile');
const env = { ...process.env, ORBIT_LAB_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], {
  env, cwd: path.dirname(executable), stdio: ['ignore', 'ignore', 'pipe'],
});
const diagnostics = [];
const stderr = readline.createInterface({ input: app.stderr });
const exited = new Promise(resolve => {
  app.once('error', error => resolve({ error }));
  app.once('exit', (code, signal) => resolve({ code, signal }));
});
let browser, timer;
try {
  const endpoint = await Promise.race([
    new Promise(resolve => stderr.on('line', line => {
      const address = /^DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)$/.exec(line);
      if (address) resolve(address[1]);
      diagnostics.push(line);
      if (diagnostics.length > 20) diagnostics.shift();
    })),
    exited.then(result => { throw result.error ?? new Error(`Release process exited before startup: ${result.code}\n${diagnostics.join('\n')}`); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Release launch timed out\n${diagnostics.join('\n')}`)), 30_000); }),
  ]);
  clearTimeout(timer);
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 15_000 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForURL('app://orbit/', { timeout: 15_000 });
  await page.locator('#scene canvas').waitFor({ timeout: 15_000 });
  assert.deepEqual(await page.evaluate(() => ({
    hooks: [typeof window.orbitLab, typeof window.render_game_to_text, typeof window.advanceTime],
    isDesktop: window.orbitDesktop.isDesktop,
  })), { hooks: ['undefined', 'undefined', 'undefined'], isDesktop: true });
  const response = await page.evaluate(async () => (await fetch('app://orbit/index.html')).headers.get('Content-Security-Policy'));
  assert.match(response, /frame-ancestors 'none'/);
  assert.match(response, /style-src 'self';/);
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#play').textContent === '일시정지');
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#play-state').textContent === '정지');
  await page.locator('#help').click();
  assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), true);
  await page.locator('#close-help').click();
  assert.deepEqual(errors, []);
  // Closing the Chromium target is distinct from closing the native window.
  // Send the normal Windows close request so the app records window.json.
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot && path.isAbsolute(systemRoot) && Number.isInteger(app.pid));
  const powershell = path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `if (-not (Get-Process -Id ${app.pid} -ErrorAction Stop).CloseMainWindow()) { exit 1 }`], { timeout: 10_000, windowsHide: true });
  const normalExit = await Promise.race([
    exited,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Release window did not exit after closing')), 10_000); }),
  ]);
  assert.deepEqual(normalExit, { code: 0, signal: null });
  assert.ok((await fs.stat(path.join(profile, 'window.json'))).isFile());
  console.log('Release executable verified with production renderer, hardened fuses and normal profile save.');
} finally {
  clearTimeout(timer);
  await browser?.close().catch(() => {});
  if (app.exitCode === null && app.signalCode === null) {
    app.kill();
    await exited;
  }
  stderr.close();
}
