import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output/browser-integration');
const baseURL = 'http://127.0.0.1:5251/', storageKey = 'orbit-lab-project-v1';
const AU = 149597870700, MU = 1.32712440041279419e20, DAY = 86400, TAU = 2 * Math.PI;
const period = a => TAU * Math.sqrt((a * AU) ** 3 / MU);
const circularSpeed = a => Math.sqrt(MU / (a * AU));
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (tolerance ${tolerance})`);
const relative = (actual, expected, tolerance = 1e-11) => near(actual, expected, Math.max(1, Math.abs(expected)) * tolerance);
const vector = (actual, expected, tolerance = 1e-7) => actual.forEach((value, i) => near(value, expected[i], tolerance));
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5251, strictPort: true, hmr: false } });
await server.listen();
const hardware = process.env.ORBIT_BROWSER_HARDWARE === '1';
let browser, context, page, gpu, failure;
const checks = [], errors = [], externalRequests = [];
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const state = () => page.evaluate(() => window.orbitLab.getState());
const project = () => page.evaluate(() => window.orbitLab.project());
const guide = () => page.evaluate(() => window.orbitLab.guide());
const debug = () => page.evaluate(() => window.orbitLab.sceneDebug());
const chart = () => page.evaluate(() => window.orbitLab.chartDebug());
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const progress = percent => page.locator(`[data-progress="${percent}"]`).click();
const choose = name => page.locator(`[data-lesson="${name}"]`).click();
async function change(id, value) { await page.locator(`#${id}`).fill(String(value)); await page.locator(`#${id}`).press('Tab'); }
async function conditions(a, e) {
  await change('a-number', a); await change('eccentricity-number', e);
  assert.deepEqual((await state()).experiment.config, { semiMajorAxisM: a * AU, eccentricity: e });
}
async function confirm() { assert.equal(await page.locator('#guide-next').isEnabled(), true); await page.locator('#guide-next').click(); }
async function dismissToast() { if (await page.locator('#toast').isVisible()) await page.locator('#toast button').click(); }
async function hidden() {
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden; });
}
function watch(target) {
  target.on('pageerror', error => errors.push(error.message));
  target.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  target.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
}
async function measuredAdvance(a, rate) {
  await conditions(a, 0); await progress(0); await page.locator('#rate').selectOption(String(rate));
  return page.evaluate(() => {
    const before = performance.now(); document.querySelector('#play').click(); const afterStart=performance.now();
    const until = performance.now() + 230; while (performance.now() < until) { /* Deliberately delayed frame. */ }
    const beforeStop=performance.now(); document.querySelector('#play').click();
    return { lowerElapsedS:(beforeStop-afterStart)/1000,upperElapsedS:(beforeStop-before)/1000,state:window.orbitLab.getState() };
  });
}

try {
  browser = await chromium.launch({ headless: true, ...(hardware ? { args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] } : {}) });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(20000); watch(page);
  await page.goto(baseURL); await page.waitForFunction(() => window.orbitLab?.sceneDebug()?.ready);

  await check('initial orbit is paused, uses a Sun focus and ten observable targets, and has no idle redraw loop', async () => {
    const initial = await state(); assert.equal(initial.running, false); assert.equal(initial.daysPerSecond, 15);
    assert.deepEqual(initial.experiment, { config: { semiMajorAxisM: AU, eccentricity: .35 }, meanAnomalyRad: 0 });
    assert.equal(initial.comparison, null); assert.equal((await debug()).componentCount, 10);
    near(initial.snapshot.periodS / DAY, 365.256898327, 1e-9); relative(initial.snapshot.radiusM, .65 * AU);
    const mesh = await debug(); vector(mesh.centralWorld, [0,0,0]); vector(mesh.orbiterWorld, [.65,0,0]); vector(mesh.ellipseCenterWorld, [-.35,0,0]); vector(mesh.secondFocusWorld, [-.7,0,0]);
    gpu = await page.evaluate(() => { const gl = document.querySelector('#scene canvas').getContext('webgl2'), extension = gl.getExtension('WEBGL_debug_renderer_info'); return { webgl2: Boolean(gl), renderer: gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER) }; });
    assert.equal(gpu.webgl2, true); if (hardware) assert.match(gpu.renderer, /RTX 5080.*D3D11|D3D11.*RTX 5080/);
    await paint(); await page.waitForTimeout(150); const before = await debug(); await page.waitForTimeout(150); assert.equal((await debug()).renderFrame, before.renderFrame);
  });

  await check('actual condition controls agree with independent period and vis-viva endpoint formulas', async () => {
    for (const a of [.5, 1, 2]) for (const e of [0, .6, .8]) {
      await conditions(a, e); await page.locator('#periapsis-button').click();
      let current = await state(); relative(current.snapshot.periodS, period(a)); relative(current.snapshot.radiusM, a * AU * (1-e));
      relative(current.snapshot.speedMps, circularSpeed(a) * Math.sqrt((1+e)/(1-e)));
      await page.locator('#apoapsis-button').click(); current = await state(); relative(current.snapshot.radiusM, a * AU * (1+e));
      relative(current.snapshot.speedMps, circularSpeed(a) * Math.sqrt((1-e)/(1+e))); near(current.experiment.meanAnomalyRad, Math.PI);
      assert.equal(current.running, false);
    }
    await conditions(1, 0); assert.match(await page.locator('#periapsis-button').textContent(), /기준/); assert.match(await page.locator('#apoapsis-button').textContent(), /반대/);
  });

  await check('time progress differs from geometric angle and actual position, radius and velocity meshes follow the orbit', async () => {
    await conditions(1, .6); await progress(25); const current = await state(); near(current.experiment.meanAnomalyRad, Math.PI / 2);
    // Independent monotonic bisection of Kepler equation rather than product-derived expected values.
    let low = 0, high = TAU; for (let i=0;i<80;i++) { const mid = (low+high)/2; if (mid-.6*Math.sin(mid)<Math.PI/2) low=mid; else high=mid; }
    const E = (low+high)/2, x = Math.cos(E)-.6, y = .8*Math.sin(E), n = TAU/period(1), d = 1-.6*Math.cos(E);
    relative(current.snapshot.positionM.x, x*AU); relative(current.snapshot.positionM.y, y*AU); assert.ok(Math.abs(current.snapshot.trueAnomalyRad-Math.PI/2)>.1);
    const mesh=await debug(); vector(mesh.orbiterWorld,[x,0,-y]); vector(mesh.radiusPoints[0],[0,0,0]); vector(mesh.radiusPoints.at(-1),[x,0,-y]);
    vector(mesh.velocityStartWorld,[x,0,-y]); vector(mesh.velocityEndWorld,[x-AU*Math.sin(E)*n/d/100000,0,-y-AU*.8*Math.cos(E)*n/d/100000],1e-6);
    await page.locator('#progress').fill('100'); assert.equal((await state()).experiment.meanAnomalyRad,0);
  });

  await check('equal-time curved sectors retain their common analytic area with bounded actual mesh discretization', async () => {
    await conditions(1,.6); await page.locator('[data-view="equalAreas"]').check(); const mesh=await debug(), expected=Math.PI*.8/12;
    assert.equal(mesh.sectors.length,2);
    for(const sector of mesh.sectors){ assert.equal(sector.visible,true); assert.ok(sector.triangleCount>=256); near(sector.analyticAreaAU2,expected,1e-12); near(sector.durationS,period(1)/12,1e-7); near(sector.meshAreaAU2,expected,2e-6); }
    vector(mesh.sectors[0].startBoundary,[.4,0,0]); vector(mesh.sectors[1].startBoundary,[-1.6,0,0]);
    assert.equal(await page.locator('#area-readout').isVisible(),true); await page.screenshot({path:path.join(output,'orbit-equal-areas.png'),fullPage:true});
  });

  await check('common model-time rate honors delayed frames, larger orbit periods, pause and hidden state', async () => {
    for(const a of [1,2]) for(const rate of [5,30]){
      const measured=await measuredAdvance(a,rate), n=TAU/period(a)*rate*DAY, actual=measured.state.experiment.meanAnomalyRad;
      assert.ok(actual>=n*(measured.lowerElapsedS-.002)&&actual<=n*(measured.upperElapsedS+.002),`phase ${actual} outside independently timed interval`); assert.ok(actual>n*.2); assert.equal(measured.state.running,false);
    }
    const stopped=(await state()).experiment; await page.waitForTimeout(160); assert.deepEqual((await state()).experiment,stopped);
    await page.locator('#play').click(); await page.waitForTimeout(120); await hidden(); assert.equal((await state()).running,false);
    const held=(await state()).experiment; await page.waitForTimeout(100); assert.deepEqual((await state()).experiment,held);
    await page.locator('#play').click(); await progress(75); near((await state()).experiment.meanAnomalyRad,1.5*Math.PI); assert.equal((await state()).running,false);
    const before=(await state()).experiment; await page.locator('#rate').selectOption('15'); assert.deepEqual((await state()).experiment,before);
  });

  await check('period guide requires two actual paused observations and preserves completed evidence', async () => {
    await choose('period'); assert.deepEqual((await guide()).evidence,[]); await page.waitForTimeout(100); assert.equal((await guide()).stage,0);
    await conditions(.5,0); assert.equal(await page.locator('#guide-next').isEnabled(),false); await conditions(1,0); await confirm();
    assert.equal((await guide()).stage,1); assert.equal(await page.locator('#guide-next').isEnabled(),false); await conditions(2,0); await confirm();
    const completed=await guide(); assert.equal(completed.status,'completed'); assert.equal(completed.evidence.length,2);
    relative(completed.evidence[1].periodDays/completed.evidence[0].periodDays,2*Math.sqrt(2));
    const result=await page.locator('#guide-result').textContent(); await conditions(1.5,.2); assert.deepEqual(await guide(),completed); assert.equal(await page.locator('#guide-result').textContent(),result);
    await page.locator('#guide-restart').click(); assert.equal((await guide()).stage,0); assert.deepEqual((await guide()).evidence,[]);
  });

  await check('speed guide captures circle then ellipse periapsis and apoapsis without inventing a maneuver', async () => {
    await choose('speed'); await conditions(1,0); await progress(0); await page.locator('#play').click(); assert.equal(await page.locator('#guide-next').isEnabled(),false); await progress(0); await confirm();
    await conditions(1,.6); await page.locator('#periapsis-button').click(); await confirm();
    assert.equal(await page.locator('#guide-next').isEnabled(),false); await page.locator('#apoapsis-button').click(); await confirm();
    const completed=await guide(); assert.equal(completed.status,'completed'); assert.equal(completed.evidence.length,3);
    relative(completed.evidence[1].speedKmS/completed.evidence[2].speedKmS,4);
    completed.evidence.forEach(item=>relative(item.periodDays,period(1)/DAY));
    relative(completed.evidence[1].radiusAU,.4); relative(completed.evidence[2].radiusAU,1.6);
  });

  await check('area guide requires visible sectors and explicit positions, and undo restores session-only evidence', async () => {
    await choose('area'); await conditions(1,.6); await progress(0); await page.locator('[data-view="equalAreas"]').uncheck(); assert.equal(await page.locator('#guide-next').isEnabled(),false);
    await page.locator('[data-view="equalAreas"]').check(); await confirm(); assert.equal(await page.locator('#guide-next').isEnabled(),false); await progress(50); await confirm();
    const completed=await guide(); assert.equal(completed.status,'completed'); assert.equal(completed.evidence.length,2);
    for(const item of completed.evidence){assert.equal(item.equalAreasVisible,true);assert.equal(item.areas.length,2);for(const area of item.areas){near(area.areaAU2,Math.PI*.8/12,1e-12);near(area.durationDays,period(1)/DAY/12,1e-9);}}
    const saved=await project(); await page.locator('#new-project').click(); assert.equal(await guide(),null); await dismissToast(); await page.locator('#undo-new').click(); assert.deepEqual(await project(),saved); assert.deepEqual(await guide(),completed);
    await page.locator('#guide-exit').click(); assert.equal(await guide(),null);
  });

  await check('manual camera, selection and layers preserve physics while explicit focus moves the viewpoint', async () => {
    await dismissToast(); await page.locator('#scene').scrollIntoViewIfNeeded(); const box=await page.locator('#scene canvas').boundingBox(), original=(await project()).observation.camera;
    await page.mouse.move(box.x+box.width*.45,box.y+box.height*.65); await page.mouse.down(); await page.mouse.move(box.x+box.width*.57,box.y+box.height*.58,{steps:12}); await page.mouse.up(); await paint(); assert.notDeepEqual((await project()).observation.camera,original);
    const before=await project(); await page.locator('#part-select').selectOption('second-focus'); assert.deepEqual((await project()).observation.camera,before.observation.camera);
    for(const key of ['orbit','geometry','velocity','equalAreas','labels']){const control=page.locator(`[data-view="${key}"]`), previous=await control.isChecked();await control.setChecked(!previous);assert.equal((await state()).view[key],!previous);await control.setChecked(previous);}
    await page.setViewportSize({width:1280,height:720}); await paint(); assert.deepEqual((await project()).observation.camera,before.observation.camera); assert.deepEqual((await state()).experiment,before.experiment);
    await page.locator('#focus-part').click(); assert.notDeepEqual((await project()).observation.camera,before.observation.camera); assert.deepEqual((await state()).experiment,before.experiment);
    await page.locator('#focus').click(); assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('focus-mode')),true); await page.locator('#focus').click();
  });

  await check('frozen comparison keeps its own physical position and graphs retain common fixed axes', async () => {
    await conditions(1,0); await progress(0); await page.locator('#pin-comparison').click(); const saved=(await state()).comparison;
    await conditions(2,0); await progress(50); assert.deepEqual((await state()).comparison,saved);
    const mesh=await debug(); vector(mesh.savedPositionWorld,[1,0,0]); vector(mesh.orbiterWorld,[-2,0,0]);
    const plot=await chart(); assert.deepEqual(plot.progressAxis,[0,1]); assert.deepEqual(plot.speedAxisKmS,[0,150]); assert.deepEqual(plot.periodAxisDays,[0,1100]);
    const barWidth=kind=>page.locator(`#period-chart rect[data-period="${kind}"]`).getAttribute('width');
    near(Number(await barWidth('current'))/Number(await barWidth('saved')),2*Math.sqrt(2),1e-10);
    for(const series of plot.series){const expected=circularSpeed(series.kind==='current'?2:1)/1000;for(const point of series.points)near(point.speedKmS,expected,1e-10);assert.equal(await page.locator(`#speed-chart [data-series="${series.kind}"]`).getAttribute('d'),series.path);}
    for(const display of ['current','saved','both']){await page.locator(`[data-chart-mode="${display}"]`).click();const next=await chart();assert.deepEqual(next.speedAxisKmS,[0,150]);assert.deepEqual(next.periodAxisDays,[0,1100]);assert.deepEqual(next.series.map(item=>item.kind).sort(),display==='both'?['current','saved']:[display]);}
    assert.ok(await page.locator('#speed-chart svg path').count()>=2); await page.screenshot({path:path.join(output,'orbit-comparison.png'),fullPage:true});
  });

  await check('file download, BOM import, reload and failed imports preserve exact phase, comparison, rate and camera', async () => {
    await page.locator('#rate').selectOption('5'); const saved=await project();
    const pending=page.waitForEvent('download'); await page.locator('#save-project').click(); const file=path.join(output,'saved.orbit.json'); await(await pending).saveAs(file); assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),saved);
    await page.locator('#new-project').click(); await page.locator('#project-file').setInputFiles({name:'bom.orbit.json',mimeType:'application/json',buffer:Buffer.from('\ufeff'+JSON.stringify(saved))});
    await page.waitForFunction(expected=>JSON.stringify(window.orbitLab.project())===JSON.stringify(expected),saved); assert.deepEqual(await project(),saved);
    await page.reload(); await page.waitForFunction(()=>window.orbitLab?.sceneDebug()?.ready); assert.deepEqual(await project(),saved); assert.equal((await state()).running,false); assert.equal(await guide(),null);
    for(const raw of ['{invalid JSON',JSON.stringify({...saved,schemaVersion:99}),JSON.stringify({...saved,experiment:{...saved.experiment,meanAnomalyRad:TAU}})]){const before=await project();const message=await page.evaluate(raw=>{try{window.orbitLab.loadProject(raw);return'';}catch(error){return error.message;}},raw);assert.ok(message.length>0);assert.deepEqual(await project(),before);}
  });

  await check('future and corrupt automatic-save originals remain byte-exact and exportable after edits', async () => {
    for(const [name,raw] of [['future','\ufeff{"type":"orbit-lab-project","schemaVersion":99,"original":"한글 원문"}'],['corrupt','{"original":"손상 원문"']]){
      const isolated=await browser.newContext({viewport:{width:1200,height:900},acceptDownloads:true});
      try{const other=await isolated.newPage();watch(other);await other.addInitScript(({key,raw})=>{if(location.hostname==='127.0.0.1')localStorage.setItem(key,raw);},{key:storageKey,raw});await other.goto(baseURL);await other.waitForFunction(()=>window.orbitLab?.sceneDebug()?.ready&&!document.querySelector('#storage-recovery').hidden);
        await other.locator('#eccentricity-number').fill('.5');await other.locator('#eccentricity-number').press('Tab');await other.locator('[data-progress="25"]').click();await other.waitForTimeout(300);assert.equal(await other.evaluate(key=>localStorage.getItem(key),storageKey),raw);
        const pending=other.waitForEvent('download');await other.locator('#recover-original').click();const file=path.join(output,`${name}-original.txt`);await(await pending).saveAs(file);assert.equal(await fs.readFile(file,'utf8'),raw);
      }finally{await isolated.close();}
    }
  });

  await check('loaded offline app continues orbit and comparison observations without remote requests', async () => {
    await context.setOffline(true);try{await conditions(.5,.8);await progress(0);relative((await state()).snapshot.speedMps,3*circularSpeed(.5));await page.locator('#pin-comparison').click();assert.equal((await state()).comparison.experiment.config.eccentricity,.8);await page.locator('#help').click();assert.equal(await page.locator('#help-dialog').isVisible(),true);await page.locator('#close-help').click();}finally{await context.setOffline(false);}
  });

  await check('1600, 1024 and 390 pixel layouts keep observation and file controls reachable', async () => {
    await dismissToast();
    for(const [width,height] of [[1600,1000],[1024,768],[390,844]]){
      await page.setViewportSize({width,height});await paint();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1,`horizontal overflow at ${width}`);
      for(const id of ['a','a-number','eccentricity','eccentricity-number','play','progress','rate','part-select','focus-part','save-project','open-project','help']){const control=page.locator(`#${id}`);await control.scrollIntoViewIfNeeded();assert.equal(await control.isVisible(),true,`${id} at ${width}`);const box=await control.boundingBox();assert.ok(box.width>0&&box.x>=-1&&box.x+box.width<=width+1,`${id} clipped at ${width}`);}
      for(const name of ['period','speed','area'])assert.equal(await page.locator(`[data-lesson="${name}"]`).isVisible(),true);
      await page.screenshot({path:path.join(output,`orbit-${width}.png`),fullPage:true});
    }
    await conditions(.75,.4);await progress(75);relative((await state()).snapshot.periodS,period(.75));near((await state()).experiment.meanAnomalyRad,1.5*Math.PI);await page.locator('#help').click();assert.equal(await page.locator('#help-dialog').isVisible(),true);await page.locator('#close-help').click();
  });
  await page.setViewportSize({width:1600,height:1000});await page.locator('#new-project').click();await dismissToast();await page.locator('[data-camera="iso"]').click();await page.evaluate(()=>scrollTo(0,0));await paint();
  await page.screenshot({path:path.join(output,'orbit-default-viewport.png')});await page.screenshot({path:path.join(output,'orbit-default-full.png'),fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
}catch(error){failure=error;console.error(error.stack);await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
}finally{await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'FAILED':'PASSED',failure:failure?.stack,checks,gpu,errors,externalRequests},null,2));await context?.close();await browser?.close();await server.close();}
if(failure)process.exitCode=1;
