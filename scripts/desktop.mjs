import { checkedPath, readInput, copyInput, stagingDirectory, publishDirectory, writeArtifact, checkTree } from './safe-files.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildWeb } from './build-web.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['start', 'package', 'package-test', 'release'].includes(mode)) throw new Error('Use start, package, package-test or release');
const testPackage = mode === 'package-test';
const requireSignature = mode === 'release';
const thumbprint = process.env.ORBIT_RELEASE_SIGNER_THUMBPRINT;
if (requireSignature && (process.platform !== 'win32' || !/^[a-f0-9]{40}$/i.test(thumbprint ?? ''))) {
  throw new Error('Signed releases require Windows and ORBIT_RELEASE_SIGNER_THUMBPRINT (40 hexadecimal characters)');
}
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Process exited with code ${code}`)));
  });
}
for (const input of ['src', 'public', 'desktop', 'docs', 'node_modules/electron']) checkTree(root, path.join(root, input));
const electronPackage = path.dirname(require.resolve('electron/package.json'));
await run(process.execPath, [path.join(electronPackage, 'install.js')]);
const webBundle = path.join(root, testPackage ? 'output/desktop-test-bundle' : 'dist');
await buildWeb(root, webBundle, { testHooks: testPackage });
if (mode === 'start') await run(require('electron'), [root]);
else {
  const stage = stagingDirectory(root), app = path.join(stage, 'app'), output = path.join(stage, 'windows');
  const configuration = JSON.parse(readInput(root, path.join(root, 'electron-builder.json')));
  const packageInfo = JSON.parse(readInput(root, path.join(root, 'package.json')));
  try {
    const inputs = [...new Set(['desktop', 'package.json', configuration.directories.buildResources, ...configuration.files.filter(file => !file.includes('*')), ...configuration.extraResources.map(item => item.from)])];
    for (const input of inputs.filter(file => !inputs.some(parent => file !== parent && file.startsWith(parent + '/')))) {
      copyInput(root, path.join(root, input), path.join(app, input));
    }
    copyInput(root, webBundle, path.join(app, 'dist'));
    for (const dependency of Object.keys(packageInfo.dependencies || {})) {
      copyInput(root, path.join(root, 'node_modules', dependency), path.join(app, 'node_modules', dependency));
    }
    const electronDist = checkedPath(root, path.join(root, 'node_modules', 'electron', 'dist'));
    checkTree(root, electronDist);
    const options = testPackage ? ['--dir', '--config.electronFuses.enableNodeCliInspectArguments=true'] : ['nsis'];
    const signing = requireSignature ?
      ['--config.forceCodeSigning=true'] : ['--config.win.signExecutable=false'];
    await run(process.execPath, [path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js'),
      '--win', ...options, '--x64', '--config', path.join(root, 'electron-builder.json'), '--projectDir', app,
      `--config.electronDist=${electronDist}`, `--config.directories.output=${output}`, '--config.npmRebuild=false',
      ...signing, '--publish', 'never']);
    if (testPackage) {
      publishDirectory(root, output, path.join(root, 'output', 'desktop-test'));
    } else {
      const installer = path.join(output, `Orbit-Lab-Setup-${packageInfo.version}.exe`);
      if (requireSignature) {
        const systemRoot = env.SystemRoot;
        if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('An absolute Windows SystemRoot is required');
        const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const verifier = checkedPath(root, path.join(root, 'scripts', 'verify-signatures.ps1'));
        await run(powershell, ['-NoProfile', '-NonInteractive', '-File', verifier, '-ExpectedThumbprint', thumbprint,
          '-Installer', installer, '-Application', path.join(output, 'win-unpacked', 'Orbit Lab.exe')]);
      }
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(checkedPath(root, installer))) hash.update(chunk);
      writeArtifact(root, installer + '.sha256', `${hash.digest('hex')}  ${path.basename(installer)}\n`);
      const destination = path.join(root, 'release', 'windows');
      publishDirectory(root, output, destination);
      console.log(`Installer: ${path.join(destination, path.basename(installer))}`);
    }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
