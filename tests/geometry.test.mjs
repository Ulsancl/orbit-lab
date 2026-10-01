import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, getSnapshot, sampleOrbit, getSweptSector, ORBIT_CONSTANTS_SI } from '../src/model.js';
import { COMPONENTS, DEFAULT_VIEW, GEOMETRY, physicalToWorld, velocityVectorEnd, orbitLandmarks, makeSectorFan, triangleAreaSum } from '../src/geometry.js';

const AU = 149597870700, TAU = 2 * Math.PI;
const near = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual-expected) <= tolerance, `${actual} != ${expected} ±${tolerance}`);
const config = (a,e) => ({ semiMajorAxisM: a*AU, eccentricity: e });
const snapshot = (a,e,phase=0) => getSnapshot(createExperiment(config(a,e), { meanAnomalyRad: phase }));

test('ten stable inspectable IDs and exact default observation remain pure and immutable', () => {
  assert.deepEqual(COMPONENTS.map(part=>part.id), ['central-body','orbiter','orbit-path','ellipse-center','second-focus','semimajor-axis','radius-line','apsides','velocity-vector','equal-areas']);
  assert.deepEqual(DEFAULT_VIEW,{orbit:true,geometry:true,velocity:true,equalAreas:false,labels:true,selectedPart:'orbiter'});
  assert.ok(Object.isFrozen(DEFAULT_VIEW) && Object.isFrozen(COMPONENTS));
  for(const part of COMPONENTS){assert.ok(Object.isFrozen(part));for(const key of ['id','label','description','material'])assert.ok(typeof part[key]==='string'&&part[key].length>0);}
  assert.equal(GEOMETRY.astronomicalUnitM, AU); assert.equal(ORBIT_CONSTANTS_SI.astronomicalUnitM,AU);
});

test('SI positions use one isotropic AU scale and positive physical rotation has +Y normal', () => {
  assert.deepEqual(physicalToWorld({x:AU,y:2*AU}),[1,0,-2]);
  assert.deepEqual(physicalToWorld({x:0,y:0}),[0,0,0]);
  const a=physicalToWorld({x:3*AU,y:4*AU});near(Math.hypot(...a),5);
  const first=physicalToWorld({x:AU,y:0}),second=physicalToWorld({x:0,y:AU});
  near(first[2]*second[0]-first[0]*second[2],1);
});

test('velocity arrow adds actual vector components at a fixed 0.01 AU display per km/s', () => {
  const position={x:.4*AU,y:.3*AU};
  const end=velocityVectorEnd(position,{x:-30000,y:40000});
  near(end[0],.1);near(end[1],0);near(end[2],-.7);
  near(Math.hypot(end[0]-.4,end[2]+.3),.5);
  assert.deepEqual(velocityVectorEnd(position,{x:0,y:0}),physicalToWorld(position));
});

test('ellipse landmarks distinguish center, focus and semimajor axis from instantaneous radius', () => {
  const points=orbitLandmarks(snapshot(1,.6));
  assert.deepEqual(points.focus,[0,0,0]);near(points.center[0],-.6);near(points.secondFocus[0],-1.2);
  near(points.periapsis[0],.4);near(points.apoapsis[0],-1.6);near(points.minorPositive[2],-.8);
  near(points.periapsis[0]-points.center[0],1);assert.equal(points.circular,false);
  const circle=orbitLandmarks(snapshot(1,0));assert.equal(circle.circular,true);
  assert.deepEqual(circle.focus,circle.center);assert.deepEqual(circle.focus,circle.secondFocus);
});

test('actual Float32 triangle fans approximate both equal-time areas even at extreme eccentricity', () => {
  for(const a of [.5,1,2])for(const e of [0,.35,.6,.8]){
    const current=snapshot(a,e), expected=Math.PI*a*a*Math.sqrt(1-e*e)/12;
    const areas=[];
    for(const start of [0,Math.PI]){
      const sector=getSweptSector(current.config,start,current.periodS/12,{sampleCount:GEOMETRY.sectorSamples});
      const fan=makeSectorFan(sector), actual=new Float32Array(fan.positions), area=triangleAreaSum(actual);
      near(fan.analyticAreaAU2,expected,1e-13);
      assert.ok(Math.abs(area-expected)/expected<2e-5,`a=${a} e=${e} start=${start} relative area error=${Math.abs(area-expected)/expected}`);
      assert.equal(actual.length,GEOMETRY.sectorSamples*9);assert.ok(actual.every(Number.isFinite));
      for(let i=0;i<actual.length;i+=9){assert.deepEqual(Array.from(actual.slice(i,i+3)),[0,0,0]);assert.ok(actual[i+5]*actual[i+6]-actual[i+3]*actual[i+8]>=-1e-14,'fan winding must face +Y');}
      areas.push(area);
    }
    assert.ok(Math.abs(areas[0]-areas[1])/expected<2e-5);
  }
});

test('curved sector geometry is measurably better than an endpoint chord triangle', () => {
  const current=snapshot(1,.6),sector=getSweptSector(current.config,0,current.periodS/12,{sampleCount:GEOMETRY.sectorSamples}),fan=makeSectorFan(sector);
  const exact=Math.PI*.8/12, first=fan.boundary[0],last=fan.boundary.at(-1);
  const chordArea=triangleAreaSum([0,0,0,...first,...last]);
  assert.ok(Math.abs(chordArea-exact)/exact>.05);
  assert.ok(Math.abs(triangleAreaSum(new Float32Array(fan.positions))-exact)/exact<2e-5);
});

test('wrapped, zero-duration and full-period sectors remain finite and preserve input records', () => {
  const current=snapshot(1,.8),before=structuredClone(current);
  for(const [start,duration,count]of [[TAU-.1,current.periodS/12,1024],[1,0,16],[0,current.periodS,2048]]){
    const sector=getSweptSector(current.config,start,duration,{sampleCount:count}),original=structuredClone(sector),fan=makeSectorFan(sector);
    assert.ok(fan.positions.every(Number.isFinite));assert.deepEqual(sector,original);
    if(duration===0)near(triangleAreaSum(fan.positions),0,1e-14);
    else near(triangleAreaSum(new Float32Array(fan.positions)),sector.areaM2/AU**2,Math.max(1e-8,fan.analyticAreaAU2*2e-5));
    if(duration===current.periodS)assert.deepEqual(fan.boundary[0],fan.boundary.at(-1));
  }
  assert.deepEqual(current,before);
});

test('all rendered orbit samples lie on the analytic ellipse and close exactly', () => {
  for(const a of [.5,2])for(const e of [0,.8]){
    const points=sampleOrbit(config(a,e),{sampleCount:GEOMETRY.orbitSamples}).map(p=>physicalToWorld(p.positionM));
    assert.deepEqual(points[0],points.at(-1));
    for(const [x,y,z]of points){assert.equal(y,0);near((x+a*e)**2/a**2+z**2/(a*a*(1-e*e)),1,3e-14);}
  }
});

test('enlarged body symbols still leave a visible gap at the closest supported periapsis', () => {
  const minimumPeriapsis=.5*(1-.8);
  assert.ok(GEOMETRY.centralSymbolRadiusWorld+GEOMETRY.particleSymbolRadiusWorld<minimumPeriapsis);
  assert.ok(.08+GEOMETRY.particleSymbolRadiusWorld<minimumPeriapsis,'soft halo radius must not cover the closest marker');
});

test('nonfinite geometry inputs and malformed triangle buffers are rejected', () => {
  for(const bad of [NaN,Infinity,'1',undefined]){assert.throws(()=>physicalToWorld({x:bad,y:0}));assert.throws(()=>velocityVectorEnd({x:0,y:0},{x:bad,y:0}));}
  assert.throws(()=>orbitLandmarks({}));assert.throws(()=>makeSectorFan({samples:[],areaM2:0}));
  assert.throws(()=>triangleAreaSum([0,0]));assert.throws(()=>triangleAreaSum([0,0,0,1,NaN,0,1,0,0]));
});
