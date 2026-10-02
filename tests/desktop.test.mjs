import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { createProject } from '../src/project.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const packaged = !!process.env.ORBIT_DESKTOP_EXE;
const executablePath = packaged ? process.env.ORBIT_DESKTOP_EXE : require('electron');
assert.ok(path.isAbsolute(executablePath), 'The tested executable must be an absolute path');
const output = path.join(root, 'output', `${packaged ? 'desktop-packaged' : 'desktop'}-v${expectedVersion}`);
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(output, 'profile-'));
const evidence = path.join(profile, 'test-artifacts');
await fs.mkdir(evidence);
const env = { ...process.env, ORBIT_LAB_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const projectPath = path.join(evidence, '궤도 관찰.orbit.json');
const checks = [], errors = [], remoteRequests = [], processes = [];
const defaultProfilePath = process.platform === 'win32' && process.env.APPDATA ? path.join(process.env.APPDATA, 'Orbit Lab') : null;
let app, page, saved, windowRestoration, gpu, failure, defaultProfile;
const state = () => page.evaluate(() => window.orbitLab.getState());
const project = () => page.evaluate(() => window.orbitLab.project());
async function profileManifest(directory) {
  if (directory === null) return null;
  const entries = [];
  async function visit(target, relative) {
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) { if (relative === '' && error.code === 'ENOENT') return false; throw error; }
    if (stat.isSymbolicLink()) entries.push({ path: relative, type: 'link', target: await fs.readlink(target) });
    else if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory' });
      for (const name of (await fs.readdir(target)).sort()) await visit(path.join(target, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) entries.push({ path: relative, bytes: stat.size, sha256: createHash('sha256').update(await fs.readFile(target)).digest('hex') });
    else throw new Error(`Unsupported default profile entry: ${relative}`);
    return true;
  }
  return { exists: await visit(directory, ''), entries };
}
function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
function sameProject(actual, expected) {
  assert.equal(actual.type, expected.type); assert.equal(actual.schemaVersion, expected.schemaVersion);
  assert.equal(actual.modelVersion, expected.modelVersion); assert.deepEqual(actual.experiment, expected.experiment);
  assert.deepEqual(actual.comparison, expected.comparison);
  assert.deepEqual(actual.observation.view, expected.observation.view);
  assert.equal(actual.observation.daysPerSecond, expected.observation.daysPerSecond);
  const a = actual.observation.camera, b = expected.observation.camera;
  if (b === null) assert.equal(a, null);
  else {
    assert.ok(a);
    for (const key of ['position', 'target']) for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(a[key][i] - b[key][i]) < 1e-9, `Camera ${key}[${i}] changed`);
    }
    assert.equal(a.zoom ?? 1, b.zoom ?? 1);
  }
}
async function launch() {
  app = await electron.launch({ executablePath, args: packaged ? [] : [root], env, timeout: 45000 });
  const child = app.process(), processRecord = { pid: child.pid, exited: false };
  processes.push(processRecord);
  child.once('exit', (code, signal) => Object.assign(processRecord, { exited: true, code, signal }));
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await page.waitForFunction(() => window.orbitLab?.project && document.querySelector('#scene canvas'));
  assert.equal((await state()).running, false, 'Each launch restores a paused experiment');
 
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
  if (defaultProfilePath) assert.equal(await app.evaluate(({ app }) => app.getPath('appData')), process.env.APPDATA);
  processRecord.processIds = await app.evaluate(({ app }) => app.getAppMetrics().map(value => value.pid));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setTitle('Orbit Lab · 자동 검사'); window.focus(); });
}
async function closeNormally() {
  const record = processes.at(-1);
  const pids = await app.evaluate(({ app }) => app.getAppMetrics().map(value => value.pid));
  record.processIds = [...new Set([record.pid, ...(record.processIds ?? []), ...pids])];
  await app.close(); app = null; page = null;
  await waitFor(() => record.exited, 'normal native process exit');
  assert.equal(record.code, 0); assert.equal(record.signal, null);
  await waitFor(() => { record.residualPids = record.processIds.filter(processExists); return record.residualPids.length === 0; }, 'owned native processes exit');
}
async function menu(group, label) {
  await app.evaluate(({ Menu }, names) => {
    const item = Menu.getApplicationMenu().items.find(value => value.label === names[0])?.submenu?.items.find(value => value.label === names[1]);
    if (!item || typeof item.click !== 'function') throw new Error(`Missing native menu: ${names.join(' > ')}`);
    item.click();
  }, [group, label]);
}
async function saveDialog(filePath, canceled = false) {
  await app.evaluate(({ dialog }, payload) => {
    globalThis.orbitSaveCalls = 0;
    dialog.showSaveDialog = async () => { globalThis.orbitSaveCalls++; return { canceled: payload.canceled, filePath: payload.filePath }; };
  }, { filePath, canceled });
}
async function openDialog(filePath, canceled = false) {
  await app.evaluate(({ dialog }, payload) => {
    globalThis.orbitOpenCalls = 0;
    dialog.showOpenDialog = async () => { globalThis.orbitOpenCalls++; return { canceled: payload.canceled, filePaths: payload.canceled ? [] : [payload.filePath] }; };
  }, { filePath, canceled });
}
async function freshToast(action, pattern) {
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#toast').textContent = ''; });
  await action();
  await page.waitForFunction(pattern => {
    const node = document.querySelector('#toast'); return !node.hidden && new RegExp(pattern).test(node.textContent);
  }, pattern);
}
async function stableBounds(label) {
  let actual, previous, stable = 0;
  await waitFor(async () => {
    actual = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
    stable = JSON.stringify(actual) === JSON.stringify(previous) ? stable + 1 : 0; previous = actual;
    return stable >= 2;
  }, label);
  return actual;
}

try {
  defaultProfile = { path: defaultProfilePath, before: await profileManifest(defaultProfilePath) };
  await launch();
  await check('isolated Orbit Lab identity, offline bundle, sandbox and native bridge', async () => {
    assert.equal(page.url(), 'app://orbit/');
    const identity = await app.evaluate(({ app, BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { name: app.name, version: app.getVersion(), userData: app.getPath('userData'), sandbox: p.sandbox,
        contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
    });
    assert.deepEqual(identity, { name: 'Orbit Lab', version: expectedVersion, userData: profile,
      sandbox: true, contextIsolation: true, nodeIntegration: false });
    const bridge = await page.evaluate(() => ({ keys: Object.keys(window.orbitDesktop).sort(), native: window.orbitDesktop.isDesktop,
      node: typeof window.require, process: typeof window.process, others: [typeof window.soundDesktop, typeof window.thermalDesktop, typeof window.lensDesktop, typeof window.motorDesktop, typeof window.hydraulicDesktop, typeof window.engineDesktop, typeof window.brakeDesktop] }));
    assert.deepEqual(bridge, { keys: ['isDesktop', 'onCommand', 'openProject', 'saveProject', 'setBusy'],
      native: true, node: 'undefined', process: 'undefined', others: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'] });
    assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
    const access = await page.evaluate(async () => ({
      local: await fetch('app://orbit/index.html').then(response => response.ok),
      remote: await fetch('https://example.com/').then(() => true).catch(() => false),
      popup: window.open('https://example.com/') === null,
    }));
    assert.equal(access.local, true); assert.equal(access.remote, false);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    // Ignore the intentionally denied fetch's CSP message, not application errors.
    assert.ok(errors.every(message => /Content Security Policy|Refused to connect|fetch/i.test(message)), errors.join('\n'));
    errors.length = 0; remoteRequests.length = 0;
    gpu = await app.evaluate(async ({ app }) => ({ info: await app.getGPUInfo('basic'), features: app.getGPUFeatureStatus() }));
    gpu.sceneContext = await page.evaluate(() => {
      const gl = document.querySelector('#scene canvas').getContext('webgl2');
      if (!gl) return { webgl2: false, unmaskedRenderer: null };
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return { webgl2: true, renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION),
        unmaskedRenderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
        unmaskedVendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null };
    });
  });
  await check('native import restores a paused elliptic orbit, frozen comparison, model-time rate and manual camera', async () => {
    saved = createProject({ experiment: { config: { semiMajorAxisM: 149597870700, eccentricity: .6 }, meanAnomalyRad: Math.PI / 2 - .6 },
      comparison: { label: '2 AU 원 궤도', experiment: { config: { semiMajorAxisM: 299195741400, eccentricity: 0 }, meanAnomalyRad: Math.PI / 2 } },
      view: { orbit: true, geometry: false, velocity: true, equalAreas: true, labels: false, selectedPart: 'equal-areas' },
      daysPerSecond: 5,
      camera: { position: [3.7, 2.9, 4.8], target: [-.1, 0, .2], zoom: 1.4 } });
    await fs.writeFile(projectPath, JSON.stringify(saved));
    await openDialog(projectPath); await page.locator('#open-project').click();
    await waitFor(async () => (await state()).experiment.config.eccentricity === .6, 'native orbit import');
    sameProject(await project(), saved);
    const imported = await state();
    // Independent E=pi/2 reference: M=pi/2-e, x=-ae, y=a*sqrt(1-e²).
    assert.ok(Math.abs(imported.snapshot.eccentricAnomalyRad - Math.PI / 2) < 2e-14);
    assert.ok(Math.abs(imported.snapshot.positionM.x / 149597870700 + .6) < 1e-12);
    assert.ok(Math.abs(imported.snapshot.positionM.y / 149597870700 - .8) < 1e-12);
    assert.ok(Math.abs(imported.snapshot.speedMps / 1000 - 29.784691834309108) < 1e-9);
    assert.ok(Math.abs(imported.snapshot.periodS / 86400 - 365.2568983272364) < 1e-8);
    assert.ok(Math.abs(imported.snapshot.timeSinceReferenceS / 86400 - 56.434760061493) < 1e-8);
    assert.deepEqual(imported.comparison, saved.comparison);
    assert.equal(imported.daysPerSecond, 5); assert.equal(imported.running, false);
    const chart = await page.evaluate(() => window.orbitLab.chartDebug());
    assert.deepEqual(chart.speedAxisKmS, [0, 150]); assert.deepEqual(chart.progressAxis, [0, 1]);
    assert.deepEqual(chart.periodAxisDays, [0, 1100]);
    assert.ok(Math.abs(chart.bars.find(bar => bar.kind === 'saved').days - 1033.1025187294167) < 1e-8);
    assert.equal(chart.series.find(series => series.kind === 'saved').marker.progress, .25);
  });
  await check('native detail panel preserves the imported orbit and reports independently known component units while paused', async () => {
    const before = await project(), initial = await state(), v0 = 29784.691834309108, AU = 149597870700;
    const reference = {
      'velocity.radialMps': .6 * v0, 'velocity.transverseMps': .8 * v0, 'velocity.speedMps': v0,
      'velocity.flightPathAngleRad': Math.atan(3 / 4), 'phase.meanAnomalyRad': Math.PI / 2 - .6,
      'phase.eccentricAnomalyRad': Math.PI / 2, 'phase.trueAnomalyRad': Math.atan2(.8, -.6),
      'acceleration.magnitudeMps2': v0 * v0 / AU, 'energy.kineticJPerKg': v0 * v0 / 2,
      'energy.potentialJPerKg': -v0 * v0, 'energy.totalJPerKg': -v0 * v0 / 2,
      'momentum.specificM2PerS': .8 * AU * v0, 'phase.trueRateRadPerS': .8 * v0 / AU,
    };
    for (const [key, expected] of Object.entries(reference)) {
      const actual = Number(await page.locator(`[data-detail-value="${key}"]`).getAttribute('data-raw'));
      assert.ok(Math.abs(actual - expected) < 1e-11 * Math.abs(expected) + 1e-12, `${key}: ${actual} != ${expected}`);
    }
    assert.match(await page.locator('[data-detail-value="energy.totalJPerKg"]').textContent(), /^-.*MJ\/kg$/);
    assert.match(await page.locator('[data-detail-value="momentum.specificM2PerS"]').textContent(), /km²\/s$/);
    assert.match(await page.locator('[data-detail-value="acceleration.magnitudeMps2"]').textContent(), /mm\/s²$/);
    assert.match(await page.locator('[data-detail-value="phase.trueRateRadPerS"]').textContent(), /°\/일$/);
    await page.locator('#part-select').selectOption('orbiter');
    assert.equal(await page.locator('#part-facts dd').count(), 6);
    const totalEnergy = await page.locator('#part-facts > div').filter({ has: page.locator('dt', { hasText: '단위 질량당 총에너지' }) }).locator('dd').getAttribute('data-raw');
    assert.ok(Math.abs(Number(totalEnergy) + v0 * v0 / 2e6) < 1e-9);
    await page.locator('#part-select').selectOption(before.observation.view.selectedPart);
    await delay(120); assert.deepEqual((await state()).snapshot, initial.snapshot); assert.equal((await state()).running, false);
    sameProject(await project(), before);
  });
  await check('native inspection save uses the original camera and restores current layers without persisting temporary construction', async () => {
    await page.locator('#part-select').selectOption('velocity-vector');
    const before = await project(); await page.locator('#inspect-part').click();
    assert.equal((await page.evaluate(() => window.orbitLab.getInspection())).kind, 'motion');
    const scene = await page.evaluate(() => window.orbitLab.sceneDebug());
    assert.deepEqual(scene.projectCamera, before.observation.camera); assert.notDeepEqual(scene.camera, before.observation.camera);
    assert.equal(scene.constructions.accelerationIsDirectionOnly, true);
    await page.locator('[data-view="geometry"]').check(); await page.locator('[data-view="orbit"]').uncheck();
    const expected = await project(); assert.deepEqual(expected.experiment, before.experiment); assert.deepEqual(expected.comparison, before.comparison);
    assert.deepEqual(expected.observation.camera, before.observation.camera);
    const inspectionPath = path.join(evidence, '상세 관찰 원래 시점.orbit.json');
    await saveDialog(inspectionPath); await freshToast(() => page.locator('#save-project').click(), '저장');
    sameProject(JSON.parse(await fs.readFile(inspectionPath, 'utf8')), expected);
    assert.equal((await page.evaluate(() => window.orbitLab.getInspection())).id, 'velocity-vector');
    await openDialog(projectPath, true); await freshToast(() => page.locator('#open-project').click(), '취소');
    assert.equal((await page.evaluate(() => window.orbitLab.getInspection())).id, 'velocity-vector'); sameProject(await project(), expected);
    await page.screenshot({ path: path.join(evidence, 'native-inspection.png') });
    await openDialog(inspectionPath); await freshToast(() => page.locator('#open-project').click(), '복원');
    assert.equal(await page.evaluate(() => window.orbitLab.getInspection()), null); sameProject(await project(), expected);
    const restored = await page.evaluate(() => window.orbitLab.sceneDebug());
    assert.equal(restored.orbitVisible, false); assert.equal(restored.view.geometry, true);
    assert.equal(restored.constructions, null); assert.deepEqual(restored.camera, expected.observation.camera);
    // Keep the original desktop integration fixture for the remaining baseline flows.
    await openDialog(projectPath); await freshToast(() => page.locator('#open-project').click(), '복원');
    sameProject(await project(), saved);
  });
  await check('native play/pause and explicit orbital progress retain the frozen comparison and observation camera', async () => {
    const before = await project();
    await menu('실험', '궤도 재생 / 일시정지');
    await waitFor(async () => { const value = await state(); return value.running && Math.abs(value.experiment.meanAnomalyRad - before.experiment.meanAnomalyRad) > .05; }, 'native orbital playback');
    await menu('실험', '궤도 재생 / 일시정지'); await waitFor(async () => !(await state()).running, 'native pause');
    const paused = await state(); await delay(120); assert.deepEqual(await state(), paused);
    assert.deepEqual(paused.experiment.config, before.experiment.config); assert.deepEqual(paused.comparison, before.comparison);
    sameProject(await project(), { ...before, experiment: paused.experiment });
    await page.locator('[data-progress="50"]').click();
    assert.equal((await state()).experiment.meanAnomalyRad, Math.PI); assert.equal((await state()).running, false);
    assert.ok(Math.abs((await state()).snapshot.speedMps / 1000 - 14.892345917154554) < 1e-9);
    await page.locator('#rate').selectOption('30');
    assert.equal((await state()).daysPerSecond, 30);
    assert.equal((await state()).experiment.meanAnomalyRad, Math.PI);
    assert.deepEqual((await state()).comparison, before.comparison);
    await page.locator('#a').fill('2');
    assert.ok(Math.abs((await state()).snapshot.periodS / 86400 - 1033.1025187294167) < 1e-8);
    assert.equal((await state()).experiment.meanAnomalyRad, Math.PI);
    await page.locator('#a').fill('1');
    await page.locator('#eccentricity').fill('0.8');
    assert.ok(Math.abs((await state()).snapshot.periodS / 86400 - 365.2568983272364) < 1e-8);
    await page.locator('#eccentricity').fill('0.6');
    const expected = { ...before, experiment: { ...before.experiment, meanAnomalyRad: Math.PI },
      observation: { ...before.observation, daysPerSecond: 30 } };
    const savedMarker = await page.evaluate(() => window.orbitLab.chartDebug().series.find(series => series.kind === 'saved').marker);
    assert.equal(savedMarker.progress, .25);
    assert.ok(Math.abs(savedMarker.speedKmS - 21.06095757159156) < 1e-9);
    sameProject(await project(), expected); saved = await project();
  });
  await check('native save replaces only a complete file; BOM import retains every state field and original bytes', async () => {
    await fs.writeFile(projectPath, 'previous destination remains until complete replacement');
    await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#toast').textContent = ''; });
    await saveDialog(projectPath); await page.locator('#save-project').click();
    // Wait for the resolved native IPC result before opening its destination.
    // Repeated reads while Windows replaces that file can disturb the operation
    // being tested, and would hide a rejected save behind a generic timeout.
    await waitFor(async () => {
      const completion = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent,
        busy: document.querySelector('#save-project').disabled }));
      if (/저장하지 못했습니다|저장을 취소했습니다/.test(completion.toast)) throw new Error(completion.toast);
      return !completion.busy && /저장했습니다/.test(completion.toast);
    }, 'native atomic file save completion');
    assert.equal(await app.evaluate(() => globalThis.orbitSaveCalls), 1);
    const raw = await fs.readFile(projectPath, 'utf8'); sameProject(JSON.parse(raw), saved);
    assert.equal((await fs.readdir(evidence)).some(name => name.endsWith('.tmp')), false);
    await menu('파일', '새 실험'); await waitFor(async () => (await state()).experiment.config.eccentricity === .35, 'new experiment');
    await openDialog(projectPath); await page.locator('#open-project').click();
    await waitFor(async () => (await state()).experiment.config.eccentricity === saved.experiment.config.eccentricity, 'native saved experiment restore');
    assert.equal((await state()).running, false);
    sameProject(await project(), saved); assert.equal(await fs.readFile(projectPath, 'utf8'), raw);
    const bomPath = path.join(evidence, 'Windows-UTF8.orbit.json'), bomRaw = '\ufeff' + raw;
    await fs.writeFile(bomPath, bomRaw);
    await menu('파일', '새 실험'); await waitFor(async () => (await state()).experiment.config.eccentricity === .35, 'new before BOM import');
    await openDialog(bomPath); await page.locator('#open-project').click();
    await waitFor(async () => (await state()).experiment.config.eccentricity === saved.experiment.config.eccentricity, 'native BOM restore');
    assert.equal((await state()).running, false);
    sameProject(await project(), saved); assert.equal(await fs.readFile(bomPath, 'utf8'), bomRaw);
  });
  await check('cancel, malformed/future/oversized files and directory/link targets preserve current and original records', async () => {
    const before = await project(), original = await fs.readFile(projectPath, 'utf8');
    await saveDialog(projectPath, true); await freshToast(() => page.locator('#save-project').click(), '저장을 취소');
    assert.equal(await app.evaluate(() => globalThis.orbitSaveCalls), 1);
    await openDialog(projectPath, true); await freshToast(() => page.locator('#open-project').click(), '열기를 취소');
    assert.equal(await app.evaluate(() => globalThis.orbitOpenCalls), 1);
    sameProject(await project(), before); assert.equal(await fs.readFile(projectPath, 'utf8'), original);
    for (const [name, raw] of [
      ['broken.json', '{synthetic invalid JSON\r\n원문'],
      ['future.json', JSON.stringify({ ...saved, schemaVersion: 2 })],
      ['future-model.json', JSON.stringify({ ...saved, modelVersion: 'orbit-kepler-2' })],
      ['too-large.json', ' '.repeat(10 * 1024 * 1024 + 1)],
    ]) {
      const file = path.join(evidence, name); await fs.writeFile(file, raw);
      await openDialog(file); await freshToast(() => page.locator('#open-project').click(), '못|실패|지원|파일');
      sameProject(await project(), before); assert.equal(await fs.readFile(file, 'utf8'), raw);
    }
    const linked = path.join(evidence, 'linked-directory'), originalDirectory = path.join(evidence, 'real-directory');
    await fs.mkdir(originalDirectory); await fs.writeFile(path.join(originalDirectory, 'observation.json'), original);
    await fs.symlink(originalDirectory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    for (const file of [originalDirectory, path.join(linked, 'observation.json')]) {
      await openDialog(file); await freshToast(() => page.locator('#open-project').click(), '못|실패|지원|파일');
      sameProject(await project(), before);
      await saveDialog(file); await freshToast(() => page.locator('#save-project').click(), '못|실패|지원|파일');
      sameProject(await project(), before);
    }
    assert.equal(await fs.readFile(path.join(originalDirectory, 'observation.json'), 'utf8'), original);
    assert.equal(await fs.readFile(projectPath, 'utf8'), original);
  });
  await check('About version and model scope are accurate and help/view menus are reversible', async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.orbitAbout = null;
      dialog.showMessageBox = async (_window, options) => { globalThis.orbitAbout = options; return { response: 0 }; };
    });
    await menu('도움말', '프로그램 정보');
    const about = await app.evaluate(() => globalThis.orbitAbout);
    assert.equal(about.message, 'Orbit Lab ' + expectedVersion);
    assert.match(about.detail, /태양/); assert.match(about.detail, /타원/); assert.match(about.detail, /기동/); assert.match(about.detail, /계산하지 않습니다/);
    await menu('도움말', '사용 안내'); await waitFor(() => page.locator('#help-dialog').evaluate(node => node.open), 'help dialog');
    assert.match(await page.locator('#help-dialog').textContent(), /궤도|태양|면적/); await page.locator('#close-help').click();
    await menu('보기', '3D 크게 보기'); await waitFor(() => page.locator('body').evaluate(node => node.classList.contains('focus-mode')), 'large view');
    await menu('보기', '3D 크게 보기'); await waitFor(() => page.locator('body').evaluate(node => !node.classList.contains('focus-mode')), 'normal view');
    sameProject(await project(), saved);
  });
  await check('an outstanding native file dialog prevents close and cancel leaves the original file intact', async () => {
    const before = await project(), original = await fs.readFile(projectPath, 'utf8');
    await app.evaluate(({ dialog }) => {
      globalThis.orbitPendingSave = false; globalThis.orbitClosePrompts = 0;
      dialog.showSaveDialog = () => new Promise(resolve => { globalThis.orbitResolveSave = resolve; globalThis.orbitPendingSave = true; });
      dialog.showMessageBox = async () => { globalThis.orbitClosePrompts++; return { response: 0 }; };
    });
    await page.locator('#save-project').click();
    await waitFor(() => app.evaluate(() => globalThis.orbitPendingSave), 'pending native save dialog');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await waitFor(() => app.evaluate(() => globalThis.orbitClosePrompts === 1), 'busy close prompt');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    sameProject(await project(), before);
    await app.evaluate(() => { globalThis.orbitResolveSave({ canceled: true }); globalThis.orbitPendingSave = false; });
    await waitFor(() => page.locator('#save-project').isEnabled(), 'native cancellation has finished');
    assert.equal(await fs.readFile(projectPath, 'utf8'), original); sameProject(await project(), before);
  });
  await check('reload and repeated full relaunch preserve observations and arbitrary-position window dimensions', async () => {
    saved = await project();
    const display = await app.evaluate(({ screen, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; if (window.isMaximized()) window.unmaximize();
      const current = window.getNormalBounds(), display = screen.getDisplayMatching(current);
      return { bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor, minimumSize: window.getMinimumSize() };
    });
    const area = display.workArea, [minWidth, minHeight] = display.minimumSize;
    const gridStep = Array.from({ length: 100 }, (_, index) => index + 1)
      .find(step => Math.abs(step * display.scaleFactor - Math.round(step * display.scaleFactor)) < 1e-7);
    assert.ok(gridStep);
    const sizeOnGrid = (desired, minimum, available) => Math.max(Math.ceil(minimum / gridStep), Math.floor(Math.min(desired, available - 32) / gridStep)) * gridStep;
    const requested = { width: sizeOnGrid(1050, minWidth, area.width), height: sizeOnGrid(780, minHeight, area.height) };
    const centered = (origin, start, available, size) => origin + Math.floor((start + (available - size) / 2 - origin) / gridStep) * gridStep;
    requested.x = centered(display.bounds.x, area.x, area.width, requested.width);
    requested.y = centered(display.bounds.y, area.y, area.height, requested.height);
    windowRestoration = { display, gridStep, requested };
    await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setBounds(target), requested);
    const aligned = await stableBounds('aligned native rectangle'); windowRestoration.aligned = aligned;
    assert.deepEqual(aligned, requested);
    await page.reload(); await page.waitForFunction(() => window.orbitLab?.project && document.querySelector('#scene canvas'));
    sameProject(await project(), saved); assert.equal((await state()).running, false);
    assert.deepEqual(await stableBounds('reloaded native rectangle'), aligned);
    await closeNormally();
    const savedWindow = JSON.parse(await fs.readFile(path.join(profile, 'window.json'), 'utf8'));
    assert.deepEqual(savedWindow, { ...aligned, maximized: false });
    await launch(); sameProject(await project(), saved);
    assert.deepEqual(await stableBounds('restarted aligned rectangle'), aligned);
    const offset = (coordinate, start, available, size) => coordinate + size + 2 <= start + available ? coordinate + 1 : coordinate - 1 >= start ? coordinate - 1 : coordinate;
    const arbitrary = { ...requested, x: offset(requested.x, area.x, area.width, requested.width), y: offset(requested.y, area.y, area.height, requested.height) };
    await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setBounds(target), arbitrary);
    const initialActual = await stableBounds('arbitrary native rectangle');
    assert.ok(Math.abs(initialActual.width - arbitrary.width) <= 1 && Math.abs(initialActual.height - arbitrary.height) <= 1);
    windowRestoration.arbitraryPosition = { requested: arbitrary, initialActual, cycles: [] };
    for (let restart = 1; restart <= 2; restart++) {
      await closeNormally();
      const recorded = JSON.parse(await fs.readFile(path.join(profile, 'window.json'), 'utf8'));
      assert.deepEqual(recorded, { ...initialActual, maximized: false });
      await launch(); sameProject(await project(), saved);
      const restored = await stableBounds(`arbitrary rectangle after restart ${restart}`);
      assert.deepEqual(restored, initialActual);
      windowRestoration.arbitraryPosition.cycles.push({ restart, saved: recorded, restored });
    }
    await page.screenshot({ path: path.join(evidence, 'native-app-restarted.png') });
  });
  await check('corrupt automatic-save original can be exported verbatim from its native recovery control', async () => {
    const raw = '{synthetic Orbit Lab original\r\n원문 보존';
    // Seed the synthetic original before the new renderer reads storage. The
    // existing renderer legitimately saves its current observation on unload.
    await page.addInitScript(value => {
      if (location.protocol === 'app:' && location.hostname === 'orbit') localStorage.setItem('orbit-lab-project-v1', value);
    }, raw);
    await page.reload();
    await page.waitForFunction(() => window.orbitLab?.project && !document.querySelector('#storage-recovery').hidden);
    const target = path.join(evidence, 'recovered-original.txt');
    await app.evaluate(({ session }, filename) => {
      globalThis.orbitDownload = null;
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(filename); item.once('done', (_event, status) => { globalThis.orbitDownload = status; });
      });
    }, target);
    await page.locator('#recover-original').click();
    await waitFor(() => app.evaluate(() => globalThis.orbitDownload === 'completed'), 'native original download');
    assert.equal(await fs.readFile(target, 'utf8'), raw);
    assert.ok(await page.evaluate(value => Object.keys(localStorage).some(key => key.startsWith('orbit-lab-project-v1-original-') && localStorage.getItem(key) === value), raw));
    await page.locator('#eccentricity').fill('0.61'); await delay(280);
    assert.equal((await state()).experiment.config.eccentricity, .61);
    assert.equal(await page.evaluate(() => localStorage.getItem('orbit-lab-project-v1')), raw);
   
  });
  assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
} catch (error) {
  failure = error; process.exitCode = 1;
  const diagnostic = page ? await page.evaluate(() => ({ toast: document.querySelector('#toast')?.textContent, state: window.orbitLab?.getState() })).catch(() => null) : null;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 3000 }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors, remoteRequests, windowRestoration, diagnostic }, null, 2));
  console.error(error.stack);
} finally {
  if (app) {
    await app.evaluate(() => { globalThis.orbitResolveSave?.({ canceled: true }); }).catch(() => {});
    await page?.evaluate(() => window.orbitDesktop?.setBusy(false)).catch(() => {});
    await closeNormally().catch(error => { failure ??= error; process.exitCode = 1; });
  }
  if (defaultProfile) {
    try {
      defaultProfile.after = await profileManifest(defaultProfilePath);
      assert.deepEqual(defaultProfile.after, defaultProfile.before, 'The real default profile must remain untouched');
      defaultProfile.unchanged = true;
    } catch (error) { defaultProfile.unchanged = false; failure ??= error; process.exitCode = 1; }
  }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: failure ? 'FAILED' : 'PASSED', version: expectedVersion,
    packaged, executablePath, profile, evidence, checks, errors, remoteRequests, processes, defaultProfile, windowRestoration, gpu,
    ...(failure ? { failure: failure.message } : {}) }, null, 2));
  console.log(`Desktop validation: ${checks.length} checks ${failure ? 'completed before failure' : 'passed'}.`);
}
