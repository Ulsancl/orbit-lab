import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output/consumer-acceptance');
const hardware = process.env.ORBIT_BROWSER_HARDWARE === '1';
const checks = [], errors = [], externalRequests = [], captures = [];
const sizes = [[1600,1000],[1280,900],[390,844]];
await fs.mkdir(output, { recursive:true });
const server = await createServer({root,server:{host:'127.0.0.1',port:5253,strictPort:true,hmr:false}});
await server.listen();
let browser, context, page, gpu, failure;
const state = () => page.evaluate(() => window.orbitLab.getState());
const project = () => page.evaluate(() => window.orbitLab.project());
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
async function openFresh(width,height) {
  await context?.close(); context = await browser.newContext({viewport:{width,height}}); page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message)); page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('request',request=>{if(/^https?:/.test(request.url()) && new URL(request.url()).hostname!=='127.0.0.1')externalRequests.push(request.url());});
  await page.goto('http://127.0.0.1:5253/'); await page.waitForFunction(()=>window.orbitLab?.sceneDebug()?.ready); await paint();
}
async function fullyVisible(id) {
  const box = await page.locator(`#${id}`).boundingBox(), viewport = page.viewportSize();
  assert.ok(box && box.width>0 && box.height>0, `${id} has no visible area`);
  assert.ok(box.x>=0 && box.y>=0 && box.x+box.width<=viewport.width+1 && box.y+box.height<=viewport.height+1,`${id} outside initial viewport: ${JSON.stringify(box)}`);
  assert.ok(await page.locator(`#${id}`).evaluate(element=>{const r=element.getBoundingClientRect(),target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return target===element||element.contains(target);}),`${id} is obscured`);
  return box;
}
async function playbackVisible() {
  const boxes = await Promise.all(['play','reset-phase','play-state','rate'].map(fullyVisible));
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];assert.ok(a.x+a.width<=b.x+1 || b.x+b.width<=a.x+1 || a.y+a.height<=b.y+1 || b.y+b.height<=a.y+1,'Playback controls overlap');}
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);
}
async function screenshot(name) {await paint();await page.screenshot({path:path.join(output,`${name}.png`)});captures.push(`${name}.png`);}
async function dismiss() {if(await page.locator('#toast').isVisible())await page.locator('#toast button').click();}
async function change(id,value) {await page.locator(`#${id}`).fill(String(value));await page.locator(`#${id}`).press('Tab');}
async function waitMoving(before) {await page.waitForFunction(angle=>window.orbitLab.getState().experiment.meanAnomalyRad!==angle,before);}
async function assertPaused(before) {
  assert.equal((await state()).running,false);assert.equal(await page.locator('#play').textContent(),'재생');assert.equal(await page.locator('#play-state').textContent(),'정지');
  await page.waitForTimeout(110);assert.deepEqual((await state()).experiment,before);
}

try {
  browser = await chromium.launch({headless:true,...(hardware?{args:['--enable-gpu','--use-angle=d3d11','--ignore-gpu-blocklist']}:{})});
  await check('first paused viewport exposes play, state and rate at 1600, 1280 and 390 pixels',async()=>{
    for(const [width,height]of sizes){
      await openFresh(width,height);assert.equal((await state()).running,false);assert.equal((await state()).experiment.meanAnomalyRad,0);assert.equal(await page.evaluate(()=>scrollY),0);
      assert.equal(await page.locator('#play').count(),1);assert.equal(await page.locator('#rate').count(),1);await playbackVisible();
      await screenshot(`initial-${width}`);
      if(!gpu)gpu=await page.evaluate(()=>{const gl=document.querySelector('#scene canvas').getContext('webgl2'),extension=gl.getExtension('WEBGL_debug_renderer_info');return{webgl2:Boolean(gl),renderer:gl.getParameter(extension?extension.UNMASKED_RENDERER_WEBGL:gl.RENDERER)};});
      if(hardware)assert.match(gpu.renderer,/RTX 5080.*D3D11|D3D11.*RTX 5080/);
      const original=await project(), box=await fullyVisible('play');
      // Real pointer input at the already-visible button, without locator auto-scroll.
      await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await waitMoving(0);assert.equal((await state()).running,true);
      assert.equal(await page.locator('#play').textContent(),'일시정지');assert.match(await page.locator('#play-state').textContent(),/15일/);
      await playbackVisible();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);const stopped=(await state()).experiment;await assertPaused(stopped);
      const after=await project();assert.deepEqual(after.experiment.config,original.experiment.config);assert.deepEqual(after.observation.camera,original.observation.camera);assert.deepEqual(after.comparison,original.comparison);assert.equal(await page.evaluate(()=>scrollY),0);
    }
  });

  await check('keyboard play and pause share the same control and preserve the chosen time scale',async()=>{
    await openFresh(390,844);const before=await project();await page.locator('#rate').selectOption('5');assert.deepEqual((await state()).experiment,before.experiment);assert.deepEqual((await project()).observation.camera,before.observation.camera);
    await page.locator('#play').focus();await page.keyboard.press('Space');await waitMoving(0);assert.match(await page.locator('#play-state').textContent(),/5일/);await playbackVisible();
    await page.keyboard.press('Space');const held=(await state()).experiment;await assertPaused(held);assert.equal((await state()).daysPerSecond,5);assert.equal(await page.evaluate(()=>document.activeElement?.id),'play');
    await screenshot('keyboard-paused-390');
  });

  await check('full and focused observation keep playback reachable without changing saved physics or camera',async()=>{
    for(const [width,height]of sizes){
      await openFresh(width,height);await change('a-number',.75);await change('eccentricity-number',.4);await page.locator('[data-progress="25"]').click();await page.locator('#pin-comparison').click();await dismiss();
      const saved=await project();saved.observation.camera={position:[1.4,2.8,2.6],target:[-.2,0,0],zoom:1.15};
      await page.evaluate(saved=>window.orbitLab.loadProject(JSON.stringify(saved)),saved);await dismiss();const before=await project();
      for(const focus of [true,false]){
        await page.locator('#focus').click();await paint();assert.equal(await page.locator('body').evaluate(body=>body.classList.contains('focus-mode')),focus);
        assert.deepEqual(await project(),before);await playbackVisible();await screenshot(`${focus?'focus':'returned'}-${width}`);
      }
      await page.locator('#focus').click();await paint();await playbackVisible();const angle=(await state()).experiment.meanAnomalyRad;
      await page.locator('#play').click();await waitMoving(angle);await playbackVisible();await page.locator('#play').click();await assertPaused((await state()).experiment);
      assert.deepEqual((await state()).comparison,before.comparison);assert.deepEqual((await project()).observation.camera,before.observation.camera);
    }
  });

  await check('resize, rate selection and project restoration retain the existing observation contract',async()=>{
    await openFresh(1600,1000);await change('a-number',1.5);await change('eccentricity-number',.6);await page.locator('[data-progress="50"]').click();await page.locator('#pin-comparison').click();await dismiss();
    const saved=await project();saved.observation.camera={position:[0,0,2],target:[0,0,0],zoom:1};await page.evaluate(saved=>window.orbitLab.loadProject(JSON.stringify(saved)),saved);const before=await project();
    for(const [width,height]of sizes){await page.setViewportSize({width,height});await paint();assert.deepEqual(await project(),before);await page.evaluate(()=>scrollTo(0,0));await playbackVisible();}
    await page.locator('#rate').selectOption('30');const changed=await project();assert.deepEqual(changed.experiment,before.experiment);assert.deepEqual(changed.comparison,before.comparison);assert.deepEqual(changed.observation.camera,before.observation.camera);assert.deepEqual(changed.observation.view,before.observation.view);assert.equal(changed.observation.daysPerSecond,30);
    await page.waitForTimeout(300);await page.reload();await page.waitForFunction(()=>window.orbitLab?.sceneDebug()?.ready);assert.deepEqual(await project(),changed);await assertPaused(changed.experiment);await playbackVisible();
    // Existing below-scene phase controls remain usable after the toolbar move.
    await page.locator('[data-progress="75"]').click();assert.equal((await state()).experiment.meanAnomalyRad,1.5*Math.PI);await page.locator('#reset-phase').click();assert.equal((await state()).experiment.meanAnomalyRad,0);assert.deepEqual((await state()).comparison,changed.comparison);
  });
  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
}catch(error){failure=error;console.error(error.stack);await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await context?.close();await browser?.close();await server.close();await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'FAILED':'PASSED',checks,gpu,errors,externalRequests,captures,failure:failure?.stack},null,2));}
if(failure)process.exitCode=1;
