import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { COMPONENTS } from '../src/geometry.js';
import { getSnapshot } from '../src/model.js';
import { createProject, serializeProject } from '../src/project.js';
import { describeOrbitDetail } from '../src/detail-model.js';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output/detail-browser');
const AU = 149597870700, MU = 1.32712440041279419e20, DAY = 86400, TAU = 2 * Math.PI;
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5332, strictPort: true, hmr: false } });
await server.listen();
const hardware = process.env.ORBIT_BROWSER_HARDWARE === '1';
let browser, page, gpu, failure;
const checks = [], errors = [], externalRequests = [];
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const near = (a, b, relative = 2e-11, absolute = 1e-10) => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= absolute + relative * Math.abs(b), `${a} != ${b}`);
const vector = (a, b, tolerance = 2e-6) => a.forEach((value, i) => near(value, b[i], 0, tolerance));
const state = () => page.evaluate(() => window.orbitLab.getState());
const project = () => page.evaluate(() => window.orbitLab.project());
const detail = () => page.evaluate(() => window.orbitLab.getDetail());
const debug = () => page.evaluate(() => window.orbitLab.sceneDebug());
const inspection = () => page.evaluate(() => window.orbitLab.getInspection());
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const load = value => page.evaluate(raw => window.orbitLab.loadProject(raw), serializeProject(value));
const progress = value => page.locator(`[data-progress="${value}"]`).click();
const selectPart = id => page.locator('#part-select').selectOption(id);
function sameCamera(actual, expected) {
  for (const key of ['position', 'target']) vector(actual[key], expected[key], 1e-9);
  near(actual.zoom ?? 1, expected.zoom ?? 1, 0, 1e-12);
}
function sameProject(actual, expected) {
  const a = structuredClone(actual), b = structuredClone(expected);
  sameCamera(a.observation.camera, b.observation.camera);
  delete a.observation.camera; delete b.observation.camera; assert.deepEqual(a, b);
}
function fixture(patch = {}) {
  return createProject({ experiment: { config: { semiMajorAxisM: AU, eccentricity: .6 }, meanAnomalyRad: Math.PI / 2 },
    comparison: { label: '2 AU 원 기준', experiment: { config: { semiMajorAxisM: 2 * AU, eccentricity: 0 }, meanAnomalyRad: 1.234 } },
    view: { orbit: false, geometry: false, velocity: false, equalAreas: true, labels: false, selectedPart: 'orbiter' }, daysPerSecond: 15,
    camera: { position: [3.7, 2.9, 4.8], target: [-.1, 0, .2], zoom: 1.4 }, ...patch });
}
async function conditions(a, e) {
  for (const [id, value] of [['a-number', a], ['eccentricity-number', e]]) {
    await page.locator(`#${id}`).fill(String(value)); await page.locator(`#${id}`).press('Tab');
  }
}
async function capture(name, selector) {
  if (selector) { await page.locator(selector).scrollIntoViewIfNeeded(); await paint(); await page.locator(selector).screenshot({ path: path.join(output, name), timeout: 15000 }); }
  else await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 15000 });
}
async function orbit() {
  const canvas = page.locator('#scene canvas'); await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox();
  assert.ok(box); const x = box.x + box.width * .8, y = box.y + box.height * .27;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 46, y + 29, { steps: 5 }); await page.mouse.up(); await paint();
}
function reference(experiment) {
  const { semiMajorAxisM: a, eccentricity: e } = experiment.config, M = experiment.meanAnomalyRad;
  // Independent monotonic bisection, not the application's hybrid solver.
  let low = 0, high = TAU;
  for (let i = 0; i < 90; i++) { const mid = (low + high) / 2; if (mid - e * Math.sin(mid) < M) low = mid; else high = mid; }
  const E = e === 0 || M === 0 || M === Math.PI ? M : (low + high) / 2;
  const sin = E === 0 || E === Math.PI ? 0 : Math.sin(E), cos = Math.cos(E), b = a * Math.sqrt(1 - e * e);
  const x = a * (cos - e), y = b * sin, r = Math.hypot(x, y), n = Math.sqrt(MU / a ** 3);
  const vx = -a * sin * n / (1 - e * cos), vy = b * cos * n / (1 - e * cos);
  const h = Math.sqrt(MU * a * (1 - e * e)), vr = e === 0 || M === 0 || M === Math.PI ? 0 : n * a * e * sin / (1 - e * cos), vt = h / r;
  const nu = ((Math.atan2(y, x) % TAU) + TAU) % TAU;
  return { a, e, M, E, nu, n, x, y, r, vx, vy, vr, vt, h, period: TAU / n, expected: {
    'velocity.radialMps': vr, 'velocity.transverseMps': vt, 'velocity.speedMps': Math.sqrt(MU * (2 / r - 1 / a)),
    'velocity.flightPathAngleRad': Math.atan2(vr, vt), 'velocity.circularMps': Math.sqrt(MU / r), 'velocity.escapeMps': Math.sqrt(2 * MU / r),
    'phase.meanAnomalyRad': M, 'phase.eccentricAnomalyRad': E, 'phase.trueAnomalyRad': nu, 'phase.trueRateRadPerS': h / r ** 2,
    'acceleration.magnitudeMps2': MU / r ** 2, 'energy.kineticJPerKg': MU * (1 / r - 1 / (2 * a)),
    'energy.potentialJPerKg': -MU / r, 'energy.totalJPerKg': -MU / (2 * a), 'momentum.specificM2PerS': h,
  } };
}
function displayed(value) {
  return value !== 0 && Math.abs(value) < .0005 ? value.toExponential(2)
    : value.toLocaleString('ko-KR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}
async function parity() {
  const s = await state(), d = await detail(), ref = reference(s.experiment);
  const rows = await page.locator('#orbit-details [data-detail-value]').evaluateAll(elements => elements.map(el => ({
    key: el.dataset.detailValue, raw: Number(el.dataset.raw), factor: Number(el.dataset.factor || 1), unit: el.dataset.unit, text: el.textContent,
  })));
  assert.equal(rows.length, Object.keys(ref.expected).length);
  for (const row of rows) {
    const expected = ref.expected[row.key], [group, key] = row.key.split('.');
    near(row.raw, expected, 2e-11, row.key.includes('Rate') ? 1e-17 : 1e-10); near(d[group][key], expected);
    // Unit text and scale are also checked, rather than validating raw SI only.
    const factors = { 'velocity.radialMps': [.001, 'km/s'], 'velocity.transverseMps': [.001, 'km/s'], 'velocity.speedMps': [.001, 'km/s'],
      'velocity.circularMps': [.001, 'km/s'], 'velocity.escapeMps': [.001, 'km/s'], 'velocity.flightPathAngleRad': [180 / Math.PI, '°'],
      'phase.meanAnomalyRad': [180 / Math.PI, '°'], 'phase.eccentricAnomalyRad': [180 / Math.PI, '°'], 'phase.trueAnomalyRad': [180 / Math.PI, '°'],
      'phase.trueRateRadPerS': [180 / Math.PI * DAY, '°/일'], 'acceleration.magnitudeMps2': [1000, 'mm/s²'],
      'energy.kineticJPerKg': [1e-6, 'MJ/kg'], 'energy.potentialJPerKg': [1e-6, 'MJ/kg'], 'energy.totalJPerKg': [1e-6, 'MJ/kg'],
      'momentum.specificM2PerS': [1e-6, 'km²/s'] };
    near(row.factor, factors[row.key][0]); assert.equal(row.unit, factors[row.key][1]);
    assert.equal(row.text, `${displayed(row.raw * factors[row.key][0])} ${factors[row.key][1]}`);
  }
  for (const [id, key] of [['periapsis', 'timeToPeriapsisS'], ['apoapsis', 'timeToApoapsisS']]) {
    const value = await page.locator(`#time-to-${id}`).getAttribute('data-raw');
    if (ref.e === 0) { assert.equal(value, 'null'); assert.equal(d.apsides[key], null); }
    else { const angle = id === 'periapsis' ? ref.M === 0 ? 0 : TAU - ref.M : ref.M <= Math.PI ? Math.PI - ref.M : TAU - ref.M + Math.PI;
      near(Number(value), angle / ref.n); }
  }
  const scale = Number(await page.locator('#velocity-plot-scale').getAttribute('data-scale'));
  const axisMax = Math.max(25, Math.ceil(Math.max(Math.abs(ref.vr / 1000) * 2, ref.vt / 1000) / 25) * 25);
  near(scale, 100 / axisMax);
  for (const [id, x, y] of [['radial-vector', ref.vr / 1000, 0], ['transverse-vector', 0, -ref.vt / 1000], ['total-vector', ref.vr / 1000, -ref.vt / 1000]]) {
    const el = page.locator(`#${id}`); near(Number(await el.getAttribute('data-x')), x); near(Number(await el.getAttribute('data-y')), y);
    const points = (await el.getAttribute('d')).match(/^M([^ ]+) ([^L]+)(?:L([^ ]+) ([^M]+))?/);
    assert.ok(points); near(Number(points[1]), 90); near(Number(points[2]), 170);
    if (Math.hypot(x, y) > 0) { near(Number(points[3]), 90 + x * scale); near(Number(points[4]), 170 + y * scale); }
  }
  return { s, d, ref };
}
async function factParity(id) {
  const s = await state();
  // Reconstruct locally from portable inputs, avoiding cross-engine trig ULPs
  // in a deliberately strict solved snapshot API.
  const expected = describeOrbitDetail(id, getSnapshot(s.experiment));
  const actual = await page.locator('#part-facts > div').evaluateAll(rows => rows.map(row => ({ label: row.querySelector('dt').textContent,
    raw: row.querySelector('dd').dataset.raw, text: row.querySelector('dd').textContent })));
  assert.equal(actual.length, expected.facts.length); assert.ok(actual.length <= 6);
  actual.forEach((row, i) => { const f = expected.facts[i]; assert.equal(row.label, f.label);
    if (typeof f.value === 'number') near(Number(row.raw), f.value); else assert.equal(row.raw, f.value);
    if (f.unit) assert.ok(row.text.endsWith(` ${f.unit}`), row.text);
    assert.doesNotMatch(row.text, /NaN|Infinity|undefined/);
  });
  assert.equal(await page.locator('#part-detail-note').textContent(), expected.note);
}
const groups = [
  ['velocity-vector', 'motion'], ['radius-line', 'motion'], ['orbiter', 'motion'],
  ['orbit-path', 'anomalies'], ['ellipse-center', 'anomalies'], ['second-focus', 'anomalies'], ['semimajor-axis', 'anomalies'],
];
async function constructionParity() {
  const s = await state(), scene = await debug(), c = scene.constructions, r = reference(s.experiment);
  assert.ok(c); assert.equal(scene.gridVisible, false); assert.equal(scene.savedVisible, false);
  if (c.kind === 'motion') {
    assert.deepEqual(scene.visibleParts, ['orbiter', 'velocity-vector']);
    const p = [r.x / AU, 0, -r.y / AU], k = .01 / 1000;
    vector(c.origin, p); vector(c.totalEnd, [p[0] + r.vx * k, 0, p[2] - r.vy * k]);
    if (c.radialVisible) vector(c.radialEnd, [p[0] + r.vr * r.x / r.r * k, 0, p[2] - r.vr * r.y / r.r * k]);
    vector(c.transverseEnd, [p[0] - r.vt * r.y / r.r * k, 0, p[2] - r.vt * r.x / r.r * k]);
    assert.equal(c.accelerationIsDirectionOnly, true); near(c.velocityWorldPerKmS, .01);
    const acceleration = c.accelerationDirectionEnd.map((v, i) => v - p[i]), mag = Math.hypot(...acceleration);
    near(mag, c.accelerationDirectionLengthWorld, 0, 2e-6);
    vector(acceleration.map(v => v / mag), [-r.x / r.r, 0, r.y / r.r]);
    assert.equal(c.localOrbitPoints.length, 17); assert.equal(c.localOrbitSampleIndices.length, 17);
    const middle = Math.floor(r.M / TAU * 512);
    for (let i = 0; i < 17; i++) {
      const index = (middle + i - 8 + 512) % 512;
      assert.equal(c.localOrbitSampleIndices[i], index);
      const point = reference({ config: s.experiment.config, meanAnomalyRad: TAU * index / 512 });
      vector(c.localOrbitPoints[i], [point.x / AU, 0, -point.y / AU]);
    }
  } else {
    assert.equal(c.kind, 'anomalies');
    assert.deepEqual(scene.visibleParts, ['central-body', 'orbiter', 'orbit-path', 'ellipse-center', 'second-focus', 'semimajor-axis', 'radius-line']);
    const a = r.a / AU, center = -a * r.e;
    vector(c.center, [center, 0, 0]); near(c.auxiliaryRadiusWorld, a); assert.equal(c.meanPointIsTimeReference, true);
    vector(c.eccentricPoint, [center + a * Math.cos(r.E), 0, -a * Math.sin(r.E)]);
    vector(c.meanTimePoint, [center + a * Math.cos(r.M), 0, -a * Math.sin(r.M)]);
    const projection = c.projectionPoints; vector(projection[0], c.eccentricPoint); vector(projection.at(-1), [r.x / AU, 0, -r.y / AU]);
    for (const point of c.auxiliaryCirclePoints) near(Math.hypot(point[0] - center, point[2]), a, 0, 2e-6);
  }
}

try {
  browser = await chromium.launch({ headless: true, ...(hardware ? { args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] } : {}) });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
  await page.goto('http://127.0.0.1:5332/'); await page.waitForFunction(() => window.orbitLab?.sceneDebug()?.ready);
  await check('paused startup exposes signed SI observations and has no idle redraw loop', async () => {
    gpu = await page.evaluate(() => { const gl = document.querySelector('#scene canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info'); return { webgl2: Boolean(gl), renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) }; });
    assert.equal(gpu.webgl2, true); if (hardware) assert.match(gpu.renderer, /RTX 5080.*D3D11|D3D11.*RTX 5080/);
    const { s, d } = await parity(); assert.equal(s.running, false); assert.equal(d.velocity.radialMps, 0);
    assert.equal(d.apsides.atPeriapsis, true); assert.equal(d.apsides.timeToPeriapsisS, 0);
    assert.ok(d.energy.kineticJPerKg > 0 && d.energy.potentialJPerKg < 0 && d.energy.totalJPerKg < 0);
    await paint(); await page.waitForTimeout(160); const before = await debug(); await page.waitForTimeout(180);
    assert.equal((await debug()).renderFrame, before.renderFrame); assert.deepEqual((await state()).snapshot, s.snapshot);
  });
  await check('native condition and progress controls distinguish M, E and true angle with outbound/inbound signs', async () => {
    await conditions(1, .6); await progress(25); let { d } = await parity();
    near(d.phase.meanAnomalyRad * 180 / Math.PI, 90);
    near(d.phase.eccentricAnomalyRad * 180 / Math.PI, 119.82432332714457, 0, 1e-9);
    near(d.phase.trueAnomalyRad * 180 / Math.PI, 147.6875974348218, 0, 1e-9);
    assert.ok(d.velocity.radialMps > 11000 && d.velocity.radialMps < 13000);
    assert.ok(d.velocity.transverseMps > 18000 && d.velocity.transverseMps < 19000);
    assert.match(await page.locator('#radial-motion-note').textContent(), /멀어지고/);
    await page.locator('.orbit-balance summary').click(); await page.locator('.orbit-apsides summary').click();
    await capture('orbit-detail-overview.png');
    await progress(75); ({ d } = await parity()); assert.ok(d.velocity.radialMps < 0); assert.ok(d.velocity.flightPathAngleRad < 0);
    assert.match(await page.locator('#radial-motion-note').textContent(), /가까워지고/);
  });
  await check('supported size/eccentricity extremes keep scaled velocity plots and physical units honest', async () => {
    for (const a of [.5, 1, 2]) for (const e of [0, .35, .8]) {
      await conditions(a, e); await page.locator('#periapsis-button').click(); await parity();
      await page.locator('#apoapsis-button').click(); await parity();
    }
    await conditions(.5, .8); await page.locator('#periapsis-button').click();
    const scale = Number(await page.locator('#velocity-plot-scale').getAttribute('data-scale'));
    assert.ok(scale < 1); assert.match(await page.locator('#velocity-plot-scale').textContent(), /km\/s.*범위/);
    assert.equal((await debug()).velocityScaleWorldPerKmS, .01);
  });
  await check('exact circle has no unique apsis while tiny positive eccentricity and near-apsis phase remain distinct', async () => {
    await conditions(1, 0); await progress(25); await parity();
    assert.equal(await page.locator('#time-to-periapsis').getAttribute('data-raw'), 'null');
    assert.match(await page.locator('#time-to-apoapsis').textContent(), /구별 없음/);
    assert.match(await page.locator('#anomaly-note').textContent(), /세 각도가 같습니다/);
    const tiny = fixture({ experiment: { config: { semiMajorAxisM: AU, eccentricity: 1e-12 }, meanAnomalyRad: Math.PI / 2 - 1e-12 } });
    await load(tiny); const d = await detail(); assert.equal(d.apsides.unique, true); assert.ok(d.velocity.radialMps > 0);
    near(d.velocity.radialMps / 1e-12, 29784.691834309108); assert.match(await page.locator('[data-detail-value="velocity.radialMps"]').textContent(), /e-11/);
    assert.match(await page.locator('#radial-motion-note').textContent(), /멀어지고/);
    await load(fixture({ experiment: { config: { semiMajorAxisM: AU, eccentricity: .6 }, meanAnomalyRad: 1e-10 } }));
    assert.equal((await detail()).apsides.atPeriapsis, false); assert.ok((await detail()).velocity.radialMps > 0);
    assert.ok((await detail()).apsides.timeToPeriapsisS > (await state()).snapshot.periodS * .9999);
  });
  await check('fractional SI imports and tiny eccentricity survive no-op controls, running inspection and explicit keyboard increments', async () => {
    // This value demonstrably loses an ULP when converted SI -> AU -> SI.
    const semiMajorAxisM = 74798935350.12344;
    assert.notEqual(semiMajorAxisM / AU * AU, semiMajorAxisM);
    const inputs = [['a', 'semiMajorAxisM', AU], ['eccentricity', 'eccentricity', 1]];
    let saved;
    for (const eccentricity of [1e-16, .456789012345678]) {
      await load(fixture({ experiment: { config: { semiMajorAxisM, eccentricity }, meanAnomalyRad: .123456789012345 } }));
      await selectPart('velocity-vector'); await page.locator('#inspect-part').click(); saved = await project();
      const snapshot = (await state()).snapshot;
      for (const [id, key, factor] of inputs) {
        for (const selector of [`#${id}`, `#${id}-number`]) {
          const display = saved.experiment.config[key] / factor, actual = Number(await page.locator(selector).inputValue());
          if (selector.endsWith('-number')) assert.equal(actual, display);
          // Chromium canonicalizes native range decimals; the exact number
          // control/ARIA value and no-op SI preservation remain mandatory.
          else near(actual, display, 2 * Number.EPSILON, 0);
          assert.equal(await page.locator(selector).getAttribute('aria-valuetext'), `${display}${factor === AU ? ' AU' : ''}`);
          assert.equal(await page.locator(selector).evaluate(input => input.validity.stepMismatch), false);
        }
        await page.locator(`#${id}-number`).focus(); await page.keyboard.press('Tab');
      }
      await page.evaluate(() => {
        for (const id of ['a', 'eccentricity']) {
          const number = document.querySelector(`#${id}-number`), range = document.querySelector(`#${id}`);
          number.dispatchEvent(new Event('change', { bubbles: true })); number.dispatchEvent(new Event('blur'));
          range.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      assert.deepEqual(await project(), saved); assert.deepEqual((await state()).snapshot, snapshot);
      assert.equal((await inspection()).id, 'velocity-vector'); assert.equal((await state()).running, false);
      assert.equal((await detail()).apsides.unique, true);
    }
    await page.locator('#play').click(); assert.equal((await state()).running, true);
    const noOp = await page.evaluate(() => {
      const before = window.orbitLab.getState(), beforeInspection = window.orbitLab.getInspection();
      for (const id of ['a', 'eccentricity']) {
        document.querySelector(`#${id}`).dispatchEvent(new Event('input', { bubbles: true }));
        const number = document.querySelector(`#${id}-number`);
        number.dispatchEvent(new Event('change', { bubbles: true })); number.dispatchEvent(new Event('blur'));
      }
      return { before, after: window.orbitLab.getState(), beforeInspection, afterInspection: window.orbitLab.getInspection() };
    });
    assert.deepEqual(noOp.after, noOp.before); assert.deepEqual(noOp.afterInspection, noOp.beforeInspection);
    await page.locator('#a-number').focus(); await page.keyboard.press('Tab');
    assert.equal((await state()).running, true); assert.equal((await inspection()).id, 'velocity-vector');
    assert.deepEqual((await state()).experiment.config, saved.experiment.config);
    await page.locator('#play').click();
    for (const [id, key, factor] of inputs) {
      await load(saved); let expected = saved.experiment.config[key];
      const range = page.locator(`#${id}`), otherKey = key === 'eccentricity' ? 'semiMajorAxisM' : 'eccentricity';
      for (const [pressed, delta] of [['ArrowRight', .01], ['Shift+ArrowLeft', -.001], ['PageUp', .1]]) {
        await range.press(pressed); expected += delta * factor;
        near((await state()).experiment.config[key], expected, 1e-15, 1e-16);
        assert.equal((await state()).experiment.config[otherKey], saved.experiment.config[otherKey]);
      }
      await range.press('Home'); assert.equal((await state()).experiment.config[key], (id === 'a' ? .5 : 0) * factor);
      await range.press('End'); assert.equal((await state()).experiment.config[key], (id === 'a' ? 2 : .8) * factor);
      await load(saved); expected = saved.experiment.config[key];
      for (const [pressed, delta] of [['ArrowUp', .01], ['Shift+ArrowDown', -.001], ['PageUp', .1]]) {
        await page.locator(`#${id}-number`).press(pressed); expected += delta * factor;
        near((await state()).experiment.config[key], expected, 1e-15, 1e-16);
      }
      assert.deepEqual((await state()).comparison, saved.comparison); sameCamera((await project()).observation.camera, saved.observation.camera);
    }
    await load(saved); const pending = page.waitForEvent('download'); await page.locator('#save-project').click();
    const filename = path.join(output, 'precision.orbit.json'); await (await pending).saveAs(filename);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), saved);
    await page.reload(); await page.waitForFunction(() => window.orbitLab?.sceneDebug()?.ready);
    assert.deepEqual(await project(), saved);
  });
  await check('native spinner baseline increments one unit while hidden right-edge controls preserve precision and explicit keyboard steps', async () => {
    const saved = fixture({ experiment: { config: { semiMajorAxisM: .765432109876543 * AU, eccentricity: .345678901234567 }, meanAnomalyRad: .23456789012345 } });
    const rightEdge = async id => {
      const input = page.locator(`#${id}-number`); await input.scrollIntoViewIfNeeded(); await input.focus();
      const bounds = await input.boundingBox(); assert.ok(bounds);
      await page.mouse.move(bounds.x + bounds.width - 7, bounds.y + bounds.height * .25);
      await page.mouse.click(bounds.x + bounds.width - 7, bounds.y + bounds.height * .25);
      await input.press('Tab');
    };
    // Re-enable the legacy native UI only for this test's before/after probe.
    // This must exercise a real pointer, not dispatchEvent or CSS-only evidence.
    const native = await page.addStyleTag({ content: '.number-unit input[type=number]{appearance:auto!important;-moz-appearance:auto!important}.number-unit input[type=number]::-webkit-inner-spin-button,.number-unit input[type=number]::-webkit-outer-spin-button{-webkit-appearance:auto!important;display:inline-block!important;margin:0!important;opacity:1!important}' });
    try {
      await load(saved); const displayedAu = Number(await page.locator('#a-number').inputValue()); await rightEdge('a');
      // Native stepping starts from the formatted DOM value, not the full SI value.
      near((await state()).experiment.config.semiMajorAxisM, (displayedAu + 1) * AU, 1e-14, 1e-5);
      await capture('native-spinner-before.png', '.controls');
    } finally { await native.evaluate(element => element.remove()); }
    for (const [id, key, factor] of [['a', 'semiMajorAxisM', AU], ['eccentricity', 'eccentricity', 1]]) {
      await load(saved); await selectPart('velocity-vector'); await page.locator('#inspect-part').click(); const before = await project();
      await rightEdge(id); assert.deepEqual(await project(), before); assert.equal((await inspection()).id, 'velocity-vector');
      let expected = before.experiment.config[key];
      for (const [pressed, delta] of [['ArrowUp', .01], ['Shift+ArrowDown', -.001], ['PageUp', .1]]) {
        await page.locator(`#${id}-number`).press(pressed); expected += delta * factor;
        near((await state()).experiment.config[key], expected, 1e-15, 1e-16);
      }
      const unchanged = await project(); await page.locator(`#${id}-number`).focus(); await page.keyboard.press('Tab'); assert.deepEqual(await project(), unchanged);
      await page.locator(`#${id}`).press('ArrowRight'); expected += .01 * factor;
      near((await state()).experiment.config[key], expected, 1e-15, 1e-16);
    }
    await load(saved); await capture('native-spinner-after.png', '.controls');
  });
  await check('ten component fact tables preserve the original orbit, comparison and manual camera', async () => {
    await load(fixture()); const before = await project();
    for (const { id } of COMPONENTS) {
      await selectPart(id); await factParity(id); const current = await project();
      assert.deepEqual(current.experiment, before.experiment); assert.deepEqual(current.comparison, before.comparison);
      sameCamera(current.observation.camera, before.observation.camera);
    }
    await parity();
  });
  await check('seven inspection targets construct actual vector sums and anomaly geometry and restore the original camera', async () => {
    await load(fixture());
    for (const [id, kind] of groups) {
      await selectPart(id); const before = await project(); await page.locator('#inspect-part').click(); await paint();
      assert.equal((await inspection()).id, id); assert.equal((await inspection()).kind, kind); await constructionParity();
      const scene = await debug(); sameCamera(scene.projectCamera, before.observation.camera); assert.notDeepEqual(scene.camera, before.observation.camera);
      if (id === 'velocity-vector') {
        await capture('velocity-components.png', '.observation');
        await page.locator('#progress').fill('99.9'); await constructionParity();
        await progress(25);
      }
      if (id === 'orbit-path') { await page.locator('[data-view="labels"]').check(); await capture('anomaly-construction.png', '.observation'); await page.locator('[data-view="labels"]').uncheck(); }
      if (id === 'orbiter') { const original = scene.camera; await orbit(); assert.notDeepEqual((await debug()).camera, original); }
      sameProject(await project(), before); assert.equal(await page.locator('#inspect-part').getAttribute('aria-pressed'), 'true');
      await page.locator('#inspect-part').click(); assert.equal(await inspection(), null);
      assert.equal(await page.locator('#inspection-strip').isVisible(), false); sameCamera((await debug()).camera, before.observation.camera);
      assert.deepEqual((await debug()).view, before.observation.view);
    }
  });
  await check('inspection tracking and current layer choices survive progress, selection, temporary orbit and every exit path', async () => {
    await load(fixture()); const before = await project();
    await page.locator('[data-detail-inspect="velocity-vector"]').click(); const first = await debug();
    await progress(75); await constructionParity(); const moved = await debug();
    const translation = moved.orbiterWorld.map((v, i) => v - first.orbiterWorld[i]);
    vector(moved.camera.target.map((v, i) => v - first.camera.target[i]), translation, 1e-9);
    sameCamera(moved.projectCamera, before.observation.camera); await orbit();
    for (const layer of ['orbit', 'geometry', 'velocity']) await page.locator(`[data-view="${layer}"]`).check();
    await page.locator('[data-view="equalAreas"]').uncheck();
    await selectPart('ellipse-center'); assert.equal((await inspection()).kind, 'anomalies'); await constructionParity();
    sameCamera((await project()).observation.camera, before.observation.camera);
    await page.locator('#end-inspection').click(); const restored = await debug();
    sameCamera(restored.camera, before.observation.camera); assert.equal(restored.orbitVisible, true); assert.equal(restored.velocityVisible, true);
    assert.equal(restored.view.geometry, true); assert.equal(restored.view.equalAreas, false); assert.equal(restored.view.labels, false);
    await page.locator('#inspect-part').click(); await page.locator('#focus-part').click(); assert.equal(await inspection(), null);
    await page.locator('#inspect-part').click(); await page.locator('[data-camera="plane"]').click(); assert.equal(await inspection(), null);
    await page.locator('#inspect-part').click(); await selectPart('apsides'); assert.equal(await inspection(), null); assert.equal(await page.locator('#inspect-part').isEnabled(), false);
    await selectPart('orbit-path'); await page.locator('#inspect-part').click(); await conditions(1, .7); assert.equal(await inspection(), null);
    assert.deepEqual((await state()).comparison, before.comparison);
  });
  await check('inspection download, reload, file import, new and undo retain original camera and portable experiment only', async () => {
    await load(fixture()); await selectPart('velocity-vector'); const before = await project(); await page.locator('#inspect-part').click(); await orbit();
    const pending = page.waitForEvent('download'); await page.locator('#save-project').click(); const download = await pending;
    const filename = path.join(output, 'inspection-original.orbit.json'); await download.saveAs(filename);
    sameProject(JSON.parse(await fs.readFile(filename, 'utf8')), before); assert.equal((await inspection()).id, 'velocity-vector');
    await page.reload(); await page.waitForFunction(() => window.orbitLab?.sceneDebug()?.ready);
    assert.equal(await inspection(), null); sameProject(await project(), before);
    await page.locator('#inspect-part').click(); await page.locator('#project-file').setInputFiles(filename);
    await page.waitForFunction(() => window.orbitLab.getInspection() === null && !document.querySelector('#save-project').disabled);
    sameProject(await project(), before); assert.equal((await state()).running, false);
    await page.locator('#inspect-part').click(); await page.locator('#new-project').click(); assert.equal(await inspection(), null);
    await page.locator('#undo-new').click(); sameProject(await project(), before); assert.equal(await inspection(), null);
    assert.deepEqual(Object.keys((await project()).experiment), ['config', 'meanAnomalyRad']); await parity();
  });
  await check('common model-time rate changes no instantaneous physics and deterministic advance uses days rather than a normalized cycle', async () => {
    await load(fixture()); const before = await project(), d0 = await detail();
    for (const rate of [5, 15, 30]) { await page.locator('#rate').selectOption(String(rate)); assert.deepEqual(await detail(), d0); }
    await page.evaluate(() => window.advanceTime(1000)); const { s, d, ref } = await parity();
    near(s.experiment.meanAnomalyRad, (before.experiment.meanAnomalyRad + 30 * DAY * ref.n) % TAU);
    assert.equal(s.running, false); assert.deepEqual(s.comparison, before.comparison); assert.deepEqual(s.experiment.config, before.experiment.config);
    near(d.energy.totalJPerKg, d0.energy.totalJPerKg); near(d.momentum.specificM2PerS, d0.momentum.specificM2PerS);
    await page.waitForTimeout(160); assert.deepEqual((await state()).snapshot, s.snapshot);
    const text = await page.evaluate(() => JSON.parse(window.render_game_to_text())); assert.equal(text.mode, 'paused');
    assert.match(text.coordinateSystem, /SI physics.*AU.*acceleration marker direction only/);
    await page.locator('#progress').fill('100'); assert.equal((await state()).experiment.meanAnomalyRad, 0); assert.equal((await detail()).phase.cycleElapsedS, 0);
  });
  await check('inspection remains temporary through a lesson and returning to the prior experiment', async () => {
    await load(fixture()); await selectPart('orbit-path'); const before = await project(); await page.locator('#inspect-part').click();
    await page.locator('[data-lesson="period"]').click(); assert.equal(await inspection(), null); assert.equal((await state()).comparison, null);
    await page.locator('#undo-new').click(); sameProject(await project(), before); assert.equal(await inspection(), null);
  });
  await check('390-pixel layout and focus mode keep readable component units and an accessible inspection exit without overflow', async () => {
    await load(fixture()); await page.setViewportSize({ width: 390, height: 844 }); await paint(); await parity();
    await selectPart('velocity-vector'); await factParity('velocity-vector'); await page.locator('#inspect-part').click();
    await page.locator('#focus').click(); assert.equal(await page.locator('#orbit-details').isVisible(), false);
    assert.equal(await page.locator('#end-inspection').isVisible(), true); await page.locator('#end-inspection').click(); assert.equal(await inspection(), null);
    await page.locator('#focus').click(); assert.equal(await page.locator('#orbit-details').isVisible(), true);
    for (const section of ['.orbit-balance', '.orbit-apsides']) {
      if (!(await page.locator(section).evaluate(element => element.open))) await page.locator(`${section} summary`).click();
    }
    const overflow = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
      clipped: [...document.querySelectorAll('#orbit-details dd,#part-facts dd,#inspection-strip button')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map(e => e.textContent) }));
    assert.ok(overflow.document <= overflow.width + 1, JSON.stringify(overflow)); assert.deepEqual(overflow.clipped, []);
    await capture('orbit-detail-mobile.png'); sameCamera((await project()).observation.camera, fixture().observation.camera);
  });
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
} catch (error) {
  failure = error; process.exitCode = 1; console.error(error.stack);
  const diagnostic = page ? await page.evaluate(() => ({ state: window.orbitLab?.getState(), inspection: window.orbitLab?.getInspection(), scene: window.orbitLab?.sceneDebug(), toast: document.querySelector('#toast')?.textContent })).catch(() => null) : null;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 3000 }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: error.message, stack: error.stack, checks, errors, externalRequests, diagnostic }, null, 2));
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'FAILED' : 'PASSED', checks, errors, externalRequests, hardware, gpu, ...(failure ? { failure: failure.message } : {}) }, null, 2));
  await browser?.close(); await server.close(); console.log(`Detail browser: ${checks.length} checks ${failure ? 'completed before failure' : 'passed'}.`);
}
