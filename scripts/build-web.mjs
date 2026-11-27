import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import policy from '../desktop/content-policy.cjs';
import { checkTree, copyInput, publishDirectory, secureDirectory, stagingDirectory } from './safe-files.mjs';

const script = fileURLToPath(import.meta.url);
export const root = path.resolve(path.dirname(script), '..');

export async function buildWeb(workspace, destination, { testHooks = false } = {}) {
  secureDirectory(workspace, path.dirname(destination));
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) checkTree(workspace, destination);
  const stage = stagingDirectory(workspace);
  const source = path.join(stage, 'input'), output = path.join(stage, 'bundle');
  try {
    for (const name of ['index.html', 'src', 'public']) {
      copyInput(workspace, path.join(workspace, name), path.join(source, name));
    }
    await build({
      configFile: false,
      envFile: false,
      root: source,
      base: './',
      mode: 'production',
      define: { __ORBIT_TEST_BUILD__: testHooks },
      plugins: [{
        name: 'orbit-content-policy',
        transformIndexHtml: () => [{
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy.contentPolicy },
          injectTo: 'head-prepend',
        }],
      }],
      build: { outDir: output, emptyOutDir: false },
    });
    publishDirectory(workspace, output, destination);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) await buildWeb(root, path.join(root, 'dist'));
