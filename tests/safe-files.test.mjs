import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { readInput, writeArtifact, copyInput, publishDirectory, stagingDirectory } from '../scripts/safe-files.mjs';
import { buildWeb } from '../scripts/build-web.mjs';

test('packaging reads reject file and directory symlinks before exposing outside bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-input-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-input-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(outside, 'private.txt'), 'private fixture');
  try { fs.symlinkSync(outside, path.join(root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('OS requires symlink privilege'); throw error; }
  assert.throws(() => readInput(root, path.join(root, 'docs', 'private.txt')), /Symlinks|canonical/);
  assert.throws(() => copyInput(root, path.join(root, 'docs'), path.join(root, 'copy')), /Symlinks|canonical/);
  assert.throws(() => writeArtifact(root, path.join(root, 'docs', 'private.txt'), 'changed'), /Symlinks|canonical/);
  assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'private fixture');
});

test('artifacts replace regular files atomically and directory publication keeps complete results', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'release', 'checksum');
  writeArtifact(root, target, 'first'); writeArtifact(root, target, 'second');
  assert.equal(readInput(root, target).toString(), 'second');
  const stage = stagingDirectory(root), source = path.join(stage, 'output');
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'app'), 'new');
  const destination = path.join(root, 'release', 'windows');
  fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'app'), 'old');
  publishDirectory(root, source, destination);
  assert.equal(readInput(root, path.join(destination, 'app')).toString(), 'new');
});

test('web build checks public inputs and the destination before publishing an isolated bundle', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-build-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publicDir = path.join(root, 'public'), dist = path.join(root, 'dist');
  const fixture = path.join(root, 'outside-bundle');
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'fixture.txt'), 'outside the bundle');
  fs.writeFileSync(path.join(root, 'index.html'), '<html><head></head><body><main>test</main></body></html>');
  fs.mkdirSync(path.join(root, 'src'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(fixture, publicDir, linkType);
  await assert.rejects(buildWeb(root, dist), /Symlinks|canonical/);
  assert.equal(fs.existsSync(dist), false);
  fs.unlinkSync(publicDir);
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'fixture.txt'), 'included in the bundle');
  fs.symlinkSync(fixture, dist, linkType);
  await assert.rejects(buildWeb(root, dist), /Symlinks|canonical/);
  assert.equal(fs.readFileSync(path.join(fixture, 'fixture.txt'), 'utf8'), 'outside the bundle');
  fs.unlinkSync(dist);
  await buildWeb(root, dist);
  assert.equal(fs.readFileSync(path.join(dist, 'fixture.txt'), 'utf8'), 'included in the bundle');
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8').replaceAll('&#39;', "'");
  assert.match(html, /Content-Security-Policy.*script-src 'self'/);
});

test('loopback development server serves source files but denies generated diagnostics', async t => {
  // Exercise a regular checkout path. Windows runners put TEMP on a
  // separate drive under an abbreviated user directory.
  const stage = stagingDirectory(path.resolve(import.meta.dirname, '..'));
  const root = path.join(stage, 'orbit [fixture]');
  fs.mkdirSync(root);
  const server = await createServer({
    configFile: path.resolve(import.meta.dirname, '../vite.config.js'),
    root,
    logLevel: 'silent',
    server: { port: 0, hmr: false },
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(stage, { recursive: true, force: true });
  });
  const artifacts = ['output/desktop/report.json', 'release/windows/fixture.txt', 'dist/fixture.txt', '.security-stage-test/fixture.txt'];
  for (const name of ['source.txt', ...artifacts]) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'test fixture');
  }
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  assert.equal(await (await fetch(url + '/source.txt')).text(), 'test fixture');
  assert.equal((await fetch(url + '/@vite/client')).status, 200);
  assert.equal((await fetch(url + '/@vite/env')).status, 200);
  for (const name of artifacts) {
    const absolute = path.join(root, name).split(path.sep).join('/');
    assert.equal((await fetch(url + '/' + name)).status, 403);
    assert.equal((await fetch(url + '/@fs/' + encodeURI(absolute))).status, 403);
  }
});
