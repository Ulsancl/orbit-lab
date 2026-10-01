import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { PerspectiveCamera, Vector3 } from 'three';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output/consumer');
const AU = 149597870700, MU = 1.32712440041279419e20;
const checks = [], errors = [], externalRequests = [];
const hardware = process.env.ORBIT_BROWSER_HARDWARE === '1';
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5253, strictPort: true, hmr: false } });
await server.listen();
let browser, context, page, gpu, failure;
const state = () => page.evaluate(() => window.orbitLab.getState());
const project = () => page.evaluate(() => window.orbitLab.project());
const debug = () => page.evaluate(() => window.orbitLab.sceneDebug());
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const vector = (actual, expected, tolerance = 1e-6) => actual.forEach((x, i) => near(x, expected[i], tolerance));
async function change(id, value) { await page.locator(`#${id}`).fill(String(value)); await page.locator(`#${id}`).press('Tab'); }
async function conditions(a, e) { await change('a-number', a); await change('eccentricity-number', e); }
async function shot(name, fullPage = false) { await paint(); await page.screenshot({ path: path.join(output, `${name}.png`), fullPage }); }
async function sceneShot(name) { await page.locator('#scene').scrollIntoViewIfNeeded(); await paint(); await page.locator('#scene').screenshot({ path: path.join(output, `${name}.png`) }); }
async function dismiss() { if (await page.locator('#toast').isVisible()) await page.locator('#toast button').click(); }
async function labelsInside() {
  const box = await page.locator('#scene').boundingBox(), data = await debug();
  assert.ok(data.labels.length >= 1, 'At least one useful upright label remains visible');
  for (const label of data.labels) { assert.ok(label.left >= 0 && label.top >= 0 && label.left + label.width <= box.width + 1 && label.top + label.height <= box.height + 1, `Label clipped: ${label.id}`); }
}
async function fits(points) {
  const mesh = await debug(), box = await page.locator('#scene').boundingBox();
  const camera = new PerspectiveCamera(38, box.width / box.height, .008, 150);
  camera.up.set(0,0,-1); camera.position.fromArray(mesh.camera.position); camera.zoom = mesh.camera.zoom;
  camera.lookAt(new Vector3(...mesh.camera.target)); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  for (const position of points) { const p = new Vector3(...position).project(camera); assert.ok(Math.abs(p.x) < .92 && Math.abs(p.y) < .92 && p.z > -1 && p.z < 1, `Explicit fit clips ${position}: ${p.toArray()}`); }
}

try {
  browser = await chromium.launch({ headless: true, ...(hardware ? { args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] } : {}) });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).hostname !== '127.0.0.1') externalRequests.push(r.url()); });
  await page.goto('http://127.0.0.1:5253/'); await page.waitForFunction(() => window.orbitLab?.sceneDebug()?.ready);
  gpu = await page.evaluate(() => { const gl = document.querySelector('#scene canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info'); return { webgl2: Boolean(gl), renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) }; });
  if (hardware) assert.match(gpu.renderer, /RTX 5080.*D3D11|D3D11.*RTX 5080/);

  await check('default 1600, 1280 and 390 scenes are visible and preserve camera through resize', async () => {
    const original = await project();
    for (const [width, height] of [[1600,1000],[1280,900],[390,844]]) {
      await page.setViewportSize({ width, height }); await paint();
      assert.deepEqual((await project()).observation.camera, original.observation.camera);
      assert.deepEqual((await state()).experiment, original.experiment);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1);
      const canvas = await page.locator('#scene canvas').boundingBox(); assert.ok(canvas.height >= 350 && canvas.width >= 300);
      await page.evaluate(() => scrollTo(0,0)); await shot(`orbit-${width}`, true);
      await page.locator('[data-camera="iso"]').click(); await labelsInside(); const mesh = await debug(); await fits(mesh.orbitPoints);
      await sceneShot(`scene-${width}`);
      // Continue resize preservation from the intentionally changed preset.
      original.observation.camera = (await project()).observation.camera;
    }
  });

  await check('extreme small and large ellipses fit explicitly with accurate bodies and fixed velocity scale', async () => {
    await page.setViewportSize({ width:1600,height:1000 });
    for (const a of [.5,2]) {
      await conditions(a,.8); await page.locator('[data-progress="0"]').click(); await page.locator('[data-camera="iso"]').click();
      const mesh = await debug(), speed = Math.sqrt(MU/(a*AU))*3;
      vector(mesh.orbiterWorld,[a*.2,0,0]); vector(mesh.velocityEndWorld,[a*.2,0,-speed/100000]);
      await fits([...mesh.orbitPoints, mesh.velocityEndWorld]); await labelsInside(); await sceneShot(`extreme-${a}`);
    }
    await page.locator('[data-camera="periapsis"]').click(); await sceneShot('periapsis-close');
  });

  await check('circle uses a reference position without claiming unique closest or farthest points', async () => {
    await conditions(1,0); await page.locator('[data-camera="plane"]').click();
    assert.match(await page.locator('#periapsis-button').textContent(),/기준/); assert.match(await page.locator('#apoapsis-button').textContent(),/반대/);
    const mesh = await debug(); vector(mesh.ellipseCenterWorld,[0,0,0]); vector(mesh.secondFocusWorld,[0,0,0]);
    assert.equal(mesh.labels.some(label=>['ellipse-center','second-focus'].includes(label.id)),false);
    await sceneShot('circle-plane');
  });

  await check('equal-time sectors have two actual curved meshes with independently expected area', async () => {
    await conditions(1,.8); await page.locator('[data-view="equalAreas"]').check(); await page.locator('[data-camera="plane"]').click();
    await page.locator('#part-select').selectOption('equal-areas');
    const mesh = await debug(), expected = Math.PI*.6/12;
    for (const sector of mesh.sectors) { assert.equal(sector.visible,true); assert.ok(sector.triangleCount>=256); near(sector.analyticAreaAU2,expected,1e-12); near(sector.meshAreaAU2,expected,expected*2e-5); }
    await fits(mesh.orbitPoints); await labelsInside(); await sceneShot('equal-areas-plane');
    await page.locator('[data-camera="iso"]').click(); await sceneShot('equal-areas-iso');
  });

  await check('saved orbit uses the graph gold and remains frozen at the same AU scale', async () => {
    await page.locator('[data-view="equalAreas"]').uncheck(); await conditions(.5,0); await page.locator('[data-progress="25"]').click();
    await page.locator('#pin-comparison').click(); const saved = (await state()).comparison;
    await conditions(2,.8); await page.locator('[data-progress="50"]').click(); await page.locator('[data-camera="plane"]').click();
    let mesh = await debug(); vector(mesh.savedPositionWorld,[0,0,-.5]); vector(mesh.orbiterWorld,[-3.6,0,0]);
    assert.equal(mesh.savedPathColor,'#ffc783'); assert.equal(mesh.savedMarkerColor,'#ffc783');
    assert.equal(await page.locator('#speed-chart [data-series="saved"]').getAttribute('stroke'),'#ffc783');
    await fits([...mesh.orbitPoints,...mesh.savedOrbitPoints]); await sceneShot('saved-shared-scale'); await shot('comparison-workspace',true);
    await page.locator('[data-progress="75"]').click(); assert.deepEqual((await state()).comparison,saved); vector((await debug()).savedPositionWorld,[0,0,-.5]);
  });

  await check('selection preserves physics and camera while explicit focus returns the selected scene into view', async () => {
    await page.setViewportSize({width:390,height:844}); await dismiss();
    for (const part of ['orbiter','velocity-vector','central-body','semimajor-axis']) {
      const before = await project(); await page.locator('#part-select').selectOption(part);
      assert.deepEqual((await project()).observation.camera,before.observation.camera); assert.deepEqual((await state()).experiment,before.experiment);
      await page.locator('#focus-part').click(); await paint(); assert.deepEqual((await state()).experiment,before.experiment);
      const box = await page.locator('#scene').boundingBox(); assert.ok(box.y < 844 && box.y+box.height > 0);
      const mesh = await debug(); assert.ok(mesh.labels.some(label=>label.id===part),`Selected label missing: ${part}`); await labelsInside();
    }
    await sceneShot('mobile-focused');
    const saved = await project(); await page.reload(); await page.waitForFunction(()=>window.orbitLab?.sceneDebug()?.ready);
    assert.deepEqual((await state()).experiment,saved.experiment); assert.deepEqual((await state()).comparison,saved.comparison);
    const restored=(await project()).observation.camera; vector(restored.position,saved.observation.camera.position,1e-9); vector(restored.target,saved.observation.camera.target,1e-9);
  });

  await check('valid imported pole camera survives condition, phase, layer, selection and resize refresh exactly', async () => {
    const saved = await project(), camera = { position:[0,0,2], target:[0,0,0], zoom:1 };
    saved.observation.camera = camera;
    await page.evaluate(saved => window.orbitLab.loadProject(JSON.stringify(saved)), saved);
    assert.deepEqual((await project()).observation.camera,camera);
    await conditions(.75,.4); await page.locator('[data-progress="25"]').click();
    await page.locator('[data-view="equalAreas"]').check(); await page.locator('#part-select').selectOption('radius-line');
    await page.setViewportSize({width:1280,height:900}); await paint();
    assert.deepEqual((await project()).observation.camera,camera);
    await page.locator('[data-camera="iso"]').click(); await sceneShot('pole-restored-to-whole');
  });
  assert.deepEqual(errors,[]); assert.deepEqual(externalRequests,[]);
} catch(error) { failure=error; console.error(error.stack); await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{}); }
finally { await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'FAILED':'PASSED',checks,gpu,errors,externalRequests,failure:failure?.stack},null,2)); await context?.close(); await browser?.close(); await server.close(); }
if(failure)process.exitCode=1;
