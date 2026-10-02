import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { readFile } from 'node:fs/promises';
import { createExperiment, getSnapshot, ORBIT_CONSTANTS_SI as C } from '../src/model.js';
import { GEOMETRY as G, orbitVectorConstruction, anomalyConstruction } from '../src/geometry.js';
import { updateLinePoints, arrowConeGeometry } from '../src/geometry-meshes.js';
const near=(a,b,t=1e-11)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
const vector=(a,b,t=1e-11)=>a.forEach((x,i)=>near(x,b[i],t));
const state=(a,e,M)=>getSnapshot(createExperiment({semiMajorAxisM:a*C.astronomicalUnitM,eccentricity:e},{meanAnomalyRad:M}));

test('rendered velocity components are orthogonal, signed and sum to the existing true velocity endpoint',()=>{
  for(const a of [.5,1,2])for(const e of [0,1e-12,.35,.8])for(let i=0;i<128;i++){
    const s=state(a,e,i*Math.PI/64),d=orbitVectorConstruction(s),r=new THREE.Vector3(...d.radialEnd).sub(new THREE.Vector3(...d.origin)),t=new THREE.Vector3(...d.transverseEnd).sub(new THREE.Vector3(...d.origin));
    near(r.dot(t),0);vector(d.sumEnd,d.totalEnd);near(d.radialMps,(s.positionM.x*s.velocityMps.x+s.positionM.y*s.velocityMps.y)/s.radiusM,3e-11);
    near(t.length(),d.transverseMps/1000*G.velocityWorldPerKmS);assert.ok(d.transverseMps>0);
    if(e===0||i===0||i===64){assert.equal(d.radialMps,0);vector(d.radialEnd,d.origin);}else assert.equal(Math.sign(d.radialMps),i<64?1:-1);
    assert.deepEqual(s,getSnapshot({config:s.config,meanAnomalyRad:s.meanAnomalyRad}));
  }
});
test('acceleration glyph has fixed declared length and always points toward the focus, independent of strength',()=>{
  for(const a of [.5,2])for(const e of [0,.8])for(let i=0;i<72;i++){
    const d=orbitVectorConstruction(state(a,e,i*Math.PI/36)),p=new THREE.Vector3(...d.origin),v=new THREE.Vector3(...d.accelerationDirectionEnd).sub(p);
    near(v.length(),.16);near(v.clone().cross(p).length(),0);assert.ok(v.dot(p)<0);assert.equal(d.accelerationIsDirectionOnly,true);
  }
});
test('eccentric point projects to the real ellipse while mean point explicitly represents uniform time',()=>{
  const examples=[0,1e-14,.25*Math.PI,.5*Math.PI,Math.PI,1.5*Math.PI,2*Math.PI-1e-12];
  for(const a of [.5,1,2])for(const e of [0,.6,.8])for(const M of examples){
    const s=state(a,e,M),d=anomalyConstruction(s);near(d.center[0],-a*e);near(d.auxiliaryRadiusWorld,a);
    near(Math.hypot(d.eccentricPoint[0]-d.center[0],d.eccentricPoint[2]),a);near(d.eccentricPoint[0],d.position[0]);near(d.position[2],d.eccentricPoint[2]*Math.sqrt(1-e*e));
    near(d.meanTimePoint[0]-d.center[0],a*Math.cos(M));near(d.meanTimePoint[2],-a*Math.sin(M));assert.equal(d.meanPointIsTimeReference,true);
    assert.deepEqual(d.auxiliaryCircle[0],d.auxiliaryCircle.at(-1));assert.equal(d.auxiliaryCircle.length,G.constructionSamples+1);
    for(const [arc,origin,radius,angle]of[[d.meanArc,d.center,.36*a,M],[d.eccentricArc,d.center,.26*a,s.eccentricAnomalyRad],[d.trueArc,d.focus,.18*a,s.trueAnomalyRad]]){
      vector(arc[0],[origin[0]+radius,0,origin[2]]);vector(arc.at(-1),[origin[0]+radius*Math.cos(angle),0,origin[2]-radius*Math.sin(angle)]);assert.ok(arc.flat().every(Number.isFinite));
    }
    if(e===0){vector(d.meanTimePoint,d.eccentricPoint);vector(d.position,d.eccentricPoint);}
  }
  const d=anomalyConstruction(state(1,.6,Math.PI/2));assert.ok(Math.abs(d.meanTimePoint[0]-d.position[0])>.49);
});
test('fixed-size Line2 buffers and dash distances are updated without replacing GPU attributes',()=>{
  const geometry=new LineGeometry().setPositions([0,0,0,1,0,0,1,1,0]),material=new LineMaterial({linewidth:3}),line=new Line2(geometry,material);line.computeLineDistances();
  const starts=geometry.getAttribute('instanceStart'),end=geometry.getAttribute('instanceEnd'),distance=geometry.getAttribute('instanceDistanceStart'),buffer=starts.data.array;
  for(let i=0;i<100;i++)assert.equal(updateLinePoints(line,[[i,0,0],[i+3,0,0],[i+3,4,0]]),true);
  assert.equal(geometry.getAttribute('instanceStart'),starts);assert.equal(starts.data.array,buffer);assert.equal(geometry.getAttribute('instanceDistanceStart'),distance);
  near(starts.getX(0),99);near(end.getY(1),4);near(geometry.getAttribute('instanceDistanceEnd').getX(1),7);near(geometry.boundingBox.max.x,102);
  assert.equal(updateLinePoints(line,[[0,0,0],[1,0,0]]),false);geometry.dispose();material.dispose();
});
test('wide velocity shaft is independently pickable at its midpoint, away from its head',()=>{
  const geometry=new LineGeometry().setPositions([0,0,0,1,0,0]),material=new LineMaterial({linewidth:3});material.resolution.set(1000,700);
  const line=new Line2(geometry,material);line.computeLineDistances();line.updateMatrixWorld();
  const camera=new THREE.PerspectiveCamera(38,1000/700,.008,150);camera.up.set(0,0,-1);camera.position.set(.5,2,0);camera.lookAt(.5,0,0);camera.updateMatrixWorld();
  const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2(0,0),camera);assert.ok(ray.intersectObject(line).length>0);
  geometry.dispose();material.dispose();
});
test('arrow cone tip remains exactly at the vector endpoint for arbitrary orientations and scales',()=>{
  const g=arrowConeGeometry();g.computeBoundingBox();near(g.boundingBox.max.y,0);near(g.boundingBox.min.y,-1);
  for(const direction of [[1,0,0],[-1,0,0],[0,0,-1],[.3,0,.7]]){
    const mesh=new THREE.Mesh(g),d=new THREE.Vector3(...direction).normalize(),tip=new THREE.Vector3(.8,0,-.4);mesh.position.copy(tip);mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),d);mesh.scale.set(.02,.05,.02);mesh.updateMatrixWorld();vector(mesh.localToWorld(new THREE.Vector3()).toArray(),tip.toArray());
  }g.dispose();
});
test('new display constructions preserve the pure codec dependency boundary and reject invalid solved dimensions',async()=>{
  const source=await readFile(new URL('../src/geometry.js',import.meta.url),'utf8');assert.ok(!/from ['"]three/.test(source));
  const {createProject}=await import('../src/project.js');assert.equal(typeof createProject,'function');
  assert.throws(()=>orbitVectorConstruction({...state(1,.6,0),radiusM:0}));assert.throws(()=>anomalyConstruction({...state(1,.6,0),meanAnomalyRad:Infinity}));
});
