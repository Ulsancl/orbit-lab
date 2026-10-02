import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { sampleOrbit, getSweptSector } from './model.js';
import { COMPONENTS, DEFAULT_VIEW, GEOMETRY as G, physicalToWorld, velocityVectorEnd, orbitLandmarks, makeSectorFan, triangleAreaSum, orbitVectorConstruction, anomalyConstruction } from './geometry.js';
import { updateLinePoints, arrowConeGeometry } from './geometry-meshes.js';
import './scene.css';

const V = values => new THREE.Vector3(...values);
const clean = value => Object.is(value, -0) ? 0 : value;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const color = { current: '#87d9ff', saved: '#ffc783', geometry: '#90a7c2', velocity: '#87d9ff', radial: '#f0a58e', transverse: '#a7deb1', acceleration: '#d8b5ff', mean: '#87d9ff', eccentric: '#ffc783', true: '#a7deb1', areaA: '#4baacf', areaB: '#b690e4' };

export class OrbitScene {
  constructor(container, { onSelect = () => {}, onCameraChange = () => {} } = {}) {
    this.container = container; this.onSelect = onSelect; this.onCameraChange = onCameraChange;
    this.view = { ...DEFAULT_VIEW }; this.parts = new Map(); this.geometries = new Set(); this.materials = new Set(); this.textures = new Set();
    this.wideMaterials = new Set(); this.updating = true; this.focusContext = null; this.disposed = false; this.inspection = null;
    container.classList.add('orbit-scene');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.7)); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute('aria-label', '고정 중심체 주위의 타원 궤도, 속도 벡터와 같은 시간의 면적');
    this.renderer.domElement.tabIndex = 0; container.append(this.renderer.domElement);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#07111f');
    this.camera = new THREE.PerspectiveCamera(38, 1, .008, 150);
    // Constant up vector permits an exact +Y plane-normal preset without an
    // OrbitControls polar singularity. Camera files therefore need no up field.
    this.camera.up.set(0, 0, -1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false; this.controls.minDistance = .2; this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI; this.controls.zoomSpeed = .8; this.controls.panSpeed = .65;
    this.controlChange = () => {
      if (!this.updating && !this.disposed) { this.boundCamera(); this.render(); this.onCameraChange(this.getProjectCameraState()); }
    };
    this.controls.addEventListener('change', this.controlChange);
    this.scene.add(new THREE.AmbientLight('#a6bed7', .8));
    const sunLight = new THREE.PointLight('#ffe3ac', 8, 0, 1); this.scene.add(sunLight);
    const fill = new THREE.DirectionalLight('#89baff', .8); fill.position.set(2, 4, -3); this.scene.add(fill);
    this.root = new THREE.Group(); this.scene.add(this.root);
    for (const part of COMPONENTS) { const node = new THREE.Group(); node.name = part.id; node.userData.partId = part.id; this.root.add(node); this.parts.set(part.id, { ...part, node, anchor: new THREE.Vector3() }); }
    this.buildSpace(); this.buildBodies(); this.buildGeometry(); this.buildConstructions(); this.buildOverlay(); this.buildPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container);
    this.camera.position.set(2.3, 3.2, 3.6); this.controls.target.set(-.35, 0, 0); this.controls.update();
    this.resize(); this.updating = false;
  }
  node(id) { return this.parts.get(id).node; }
  anchor(id, position) { this.parts.get(id).anchor.copy(Array.isArray(position) ? V(position) : position); }
  material(parameters, basic = false) {
    const material = basic ? new THREE.MeshBasicMaterial(parameters) : new THREE.MeshStandardMaterial(parameters);
    this.materials.add(material); return material;
  }
  mesh(geometry, material, parent, position = [0, 0, 0]) {
    this.geometries.add(geometry); const mesh = new THREE.Mesh(geometry, material); mesh.position.set(...position); parent.add(mesh); return mesh;
  }
  replaceGeometry(object, geometry) {
    if (object.geometry) { this.geometries.delete(object.geometry); object.geometry.dispose(); }
    this.geometries.add(geometry); object.geometry = geometry;
  }
  texture(canvas) { const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; this.textures.add(texture); return texture; }
  radialTexture() {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128; const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, '#fff7daff'); gradient.addColorStop(.28, '#ffd38e66'); gradient.addColorStop(.6, '#ffb45a13'); gradient.addColorStop(1, '#ffb45a00');
    context.fillStyle = gradient; context.fillRect(0, 0, 128, 128); return this.texture(canvas);
  }
  bodyTexture(sun) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256; const context = canvas.getContext('2d');
    const image = context.createImageData(512, 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
      const u = x / 512 * Math.PI * 2, v = y / 256 * Math.PI;
      const fine = Math.sin(u * 43 + Math.sin(v * 37) * 2) * Math.sin(v * 61 + Math.cos(u * 19));
      const bands = Math.sin(v * 18 + Math.sin(u * 5) * .8), n = .5 + .16 * bands + .12 * fine;
      const base = sun ? [255, 143 + 65 * n, 42 + 73 * n] : [29 + 24 * n, 83 + 34 * n, 110 + 49 * n];
      const offset = (y * 512 + x) * 4; for (let k = 0; k < 3; k++) image.data[offset + k] = base[k]; image.data[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0); return this.texture(canvas);
  }
  buildSpace() {
    let seed = 982451653; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const positions = [], colors = [];
    for (let i = 0; i < 420; i++) {
      const azimuth = random() * Math.PI * 2, cos = random() * 2 - 1, radius = 18 + random() * 10, sin = Math.sqrt(1 - cos * cos);
      positions.push(radius * sin * Math.cos(azimuth), radius * cos, radius * sin * Math.sin(azimuth));
      const intensity = .16 + random() ** 3 * .6; colors.push(intensity * .78, intensity * .87, intensity);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); this.geometries.add(geometry);
    const material = new THREE.PointsMaterial({ size: 1.3, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: .8, depthWrite: false, toneMapped: false }); this.materials.add(material);
    this.stars = new THREE.Points(geometry, material); this.stars.frustumCulled = false; this.scene.add(this.stars);
    this.grid = new THREE.GridHelper(8, 16, '#203d56', '#14283e'); this.grid.material.transparent = true; this.grid.material.opacity = .38;
    this.grid.material.depthWrite = false; this.grid.position.y = -.008; this.scene.add(this.grid); this.geometries.add(this.grid.geometry); this.materials.add(this.grid.material);
  }
  wideLine(parent, points, { lineColor = color.geometry, width = 1.4, dashed = false, opacity = 1 } = {}) {
    const geometry = new LineGeometry(); geometry.setPositions(points.flat()); this.geometries.add(geometry);
    const material = new LineMaterial({ color: lineColor, linewidth: width, dashed, dashSize: .05, gapSize: .035, transparent: opacity < 1, opacity, depthWrite: false, toneMapped: false });
    this.materials.add(material); this.wideMaterials.add(material);
    const line = new Line2(geometry, material); line.userData.baseLineWidth = width; line.computeLineDistances(); parent.add(line); return line;
  }
  setLine(line, points) { if (updateLinePoints(line, points)) return; const geometry = new LineGeometry(); geometry.setPositions(points.flat()); this.replaceGeometry(line, geometry); line.computeLineDistances(); }
  wideArrow(parent, lineColor, width = 2.2) {
    const arrow = new THREE.Group(); parent.add(arrow);
    arrow.line = this.wideLine(arrow, [[0,0,0],[0,1,0]], { lineColor, width });
    arrow.cone = this.mesh(arrowConeGeometry(), this.material({ color: lineColor, toneMapped: false }, true), arrow);
    return arrow;
  }
  setArrow(arrow, start, end) {
    const delta = V(end).sub(V(start)), length = delta.length(), headLength = Math.min(.055, length * .22), headRadius = Math.min(.013, length * .06);
    arrow.position.set(...start); arrow.visible = length > 0; arrow.cone.position.copy(delta);
    if (length > 0) arrow.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), delta.clone().divideScalar(length));
    arrow.cone.scale.set(headRadius, headLength, headRadius);
    this.setLine(arrow.line, [[0,0,0], length > 0 ? delta.multiplyScalar(1 - headLength / length).toArray() : [0,0,0]]);
  }
  ring(parent, radius, colorValue, position = [0, 0, 0], wire = .0025) {
    const geometry = new THREE.TorusGeometry(radius, wire, 6, 40); geometry.rotateX(Math.PI / 2);
    return this.mesh(geometry, this.material({ color: colorValue, toneMapped: false }, true), parent, position);
  }
  buildBodies() {
    this.sun = this.mesh(new THREE.SphereGeometry(G.centralSymbolRadiusWorld, 48, 32), this.material({ map: this.bodyTexture(true), toneMapped: false }, true), this.node('central-body'));
    const haloMaterial = new THREE.SpriteMaterial({ map: this.radialTexture(), color: '#ffcc83', transparent: true, opacity: .45, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }); this.materials.add(haloMaterial);
    this.halo = new THREE.Sprite(haloMaterial); this.halo.scale.setScalar(.16); this.node('central-body').add(this.halo);
    this.orbiter = this.mesh(new THREE.SphereGeometry(G.particleSymbolRadiusWorld, 32, 24), this.material({ map: this.bodyTexture(false), roughness: .68, metalness: .05, emissive: '#0f3545', emissiveIntensity: .35 }), this.node('orbiter'));
    this.selectionOrbiter = this.ring(this.node('orbiter'), .032, '#99e7ff', [0, 0, 0], .0018);
    this.selectionSun = this.ring(this.node('central-body'), .068, '#ffdda4', [0, 0, 0], .0018);
    this.savedGroup = new THREE.Group(); this.root.add(this.savedGroup);
    this.savedMarker = this.mesh(new THREE.OctahedronGeometry(.023), this.material({ color: color.saved, wireframe: true, toneMapped: false }, true), this.savedGroup);
    this.savedPath = this.wideLine(this.savedGroup, [[0,0,0],[1,0,0]], { lineColor: color.saved, width: 1.6, dashed: true }); this.savedGroup.visible = false;
  }
  buildGeometry() {
    this.orbitPath = this.wideLine(this.node('orbit-path'), [[0,0,0],[1,0,0]], { lineColor: color.current, width: 2.1 });
    this.centerMarker = this.mesh(new THREE.OctahedronGeometry(.018), this.material({ color: '#b5c7da', wireframe: true, toneMapped: false }, true), this.node('ellipse-center'));
    this.secondMarker = this.ring(this.node('second-focus'), .024, '#b0bbd4', [0,0,0], .002);
    this.semiAxis = this.wideLine(this.node('semimajor-axis'), [[0,0,0],[1,0,0]], { lineColor: '#b7c4d5', dashed: true, width: 1.4 });
    this.axisTicks = [0,1].map(() => this.wideLine(this.node('semimajor-axis'), [[0,0,-.025],[0,0,.025]], { lineColor: '#c1cddc', width: 1.5 }));
    this.radiusLine = this.wideLine(this.node('radius-line'), [[0,0,0],[1,0,0]], { lineColor: '#79b4cc', width: 1.2, opacity: .82 });
    this.periMarker = this.ring(this.node('apsides'), .028, '#e5ba87', [0,0,0], .0026);
    this.apoMarker = this.ring(this.node('apsides'), .028, '#8bb7eb', [0,0,0], .0026);
    this.velocity = this.wideArrow(this.node('velocity-vector'), color.velocity);
    this.sectors = [color.areaA, color.areaB].map(sectorColor => {
      const material = this.material({ color: sectorColor, transparent: true, opacity: .23, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, toneMapped: false }, true);
      const mesh = this.mesh(new THREE.BufferGeometry(), material, this.node('equal-areas'));
      const outline = this.wideLine(this.node('equal-areas'), [[0,0,0],[1,0,0]], { lineColor: sectorColor, width: 1.8 });
      return { mesh, outline, analyticAreaAU2: 0, durationS: 0 };
    });
  }
  buildConstructions() {
    this.motionGroup = new THREE.Group(); this.angleGroup = new THREE.Group(); this.root.add(this.motionGroup, this.angleGroup); this.motionGroup.visible = this.angleGroup.visible = false;
    this.radialArrow = this.wideArrow(this.motionGroup, color.radial); this.transverseArrow = this.wideArrow(this.motionGroup, color.transverse);
    this.accelerationArrow = this.wideArrow(this.motionGroup, color.acceleration, 2.4);
    this.sumGuide = this.wideLine(this.motionGroup, [[0,0,0],[1,0,0]], { lineColor: color.transverse, dashed: true, opacity: .65 });
    this.sumGuideOther = this.wideLine(this.motionGroup, [[0,0,0],[1,0,0]], { lineColor: color.radial, dashed: true, opacity: .65 });
    this.localOrbitGuide = this.wideLine(this.motionGroup, [[0,0,0],[1,0,0]], { lineColor: '#718da1', width: 1.6, opacity: .65 });
    this.radialDirectionGuide = this.wideLine(this.motionGroup, [[0,0,0],[1,0,0]], { lineColor: '#718da1', dashed: true, width: 1.2, opacity: .65 });
    // The fixed-length acceleration mark is an annotation. Draw it over the
    // enlarged symbols; its endpoint does not predict a future particle position.
    for (const object of [this.accelerationArrow.line, this.accelerationArrow.cone]) { object.material.depthTest = false; object.renderOrder = 4; }
    this.auxiliaryCircle = this.wideLine(this.angleGroup, [[0,0,0],[1,0,0]], { lineColor: '#657b96', dashed: true, width: 1.2, opacity: .7 });
    this.eccentricRadius = this.wideLine(this.angleGroup, [[0,0,0],[1,0,0]], { lineColor: color.eccentric, width: 1.5, opacity: .7 });
    this.meanRadius = this.wideLine(this.angleGroup, [[0,0,0],[1,0,0]], { lineColor: color.mean, width: 1.5, dashed: true, opacity: .7 });
    this.eccentricProjection = this.wideLine(this.angleGroup, [[0,0,0],[1,0,0]], { lineColor: color.eccentric, dashed: true, width: 1.6 });
    this.meanArc = this.wideLine(this.angleGroup, [[0,0,0],[1,0,0]], { lineColor: color.mean, width: 2.5 });
    this.eccentricArc = this.wideLine(this.angleGroup, [[0,0,0],[1,0,0]], { lineColor: color.eccentric, width: 2.5 });
    this.trueArc = this.wideLine(this.angleGroup, [[0,0,0],[1,0,0]], { lineColor: color.true, width: 2.5 });
    this.eccentricPoint = this.mesh(new THREE.SphereGeometry(.011,16,10), this.material({color:color.eccentric,toneMapped:false},true), this.angleGroup);
    this.meanTimePoint = this.mesh(new THREE.OctahedronGeometry(.014), this.material({color:color.mean,wireframe:true,toneMapped:false},true), this.angleGroup);
    this.positionPoint = this.ring(this.angleGroup, .026, color.true, [0,0,0], .0017);
  }
  updateConstructions() {
    if (!this.inspection) return;
    if (this.inspection.kind === 'motion') {
      const d = orbitVectorConstruction(this.snapshot); this.vectorConstruction = d;
      this.setArrow(this.radialArrow, d.origin, d.radialEnd); this.setArrow(this.transverseArrow, d.origin, d.transverseEnd); this.setArrow(this.accelerationArrow, d.origin, d.accelerationDirectionEnd);
      this.setLine(this.sumGuide, [d.radialEnd, d.totalEnd]); this.setLine(this.sumGuideOther, [d.transverseEnd, d.totalEnd]);
      this.sumGuide.visible = this.sumGuideOther.visible = d.radialMps !== 0;
      const middle = Math.floor(this.snapshot.meanAnomalyRad / (2*Math.PI) * G.orbitSamples);
      this.localOrbitSampleIndices = Array.from({length:17},(_,i)=>(middle+i-8+G.orbitSamples)%G.orbitSamples);
      this.setLine(this.localOrbitGuide,this.localOrbitSampleIndices.map(i=>physicalToWorld(this.samples[i].positionM)));
      const direction=V(d.accelerationDirectionEnd).sub(V(d.origin)).normalize();
      this.setLine(this.radialDirectionGuide,[V(d.origin).addScaledVector(direction,-.11).toArray(),V(d.origin).addScaledVector(direction,.21).toArray()]);
    } else {
      const d = anomalyConstruction(this.snapshot); this.angleConstruction = d;
      this.setLine(this.auxiliaryCircle, d.auxiliaryCircle); this.setLine(this.meanRadius, [d.center, d.meanTimePoint]); this.setLine(this.eccentricRadius, [d.center, d.eccentricPoint]); this.setLine(this.eccentricProjection, [d.eccentricPoint, d.position]);
      this.setLine(this.meanArc, d.meanArc); this.setLine(this.eccentricArc, d.eccentricArc); this.setLine(this.trueArc, d.trueArc);
      this.meanArc.visible = d.meanAnomalyRad > 0; this.eccentricArc.visible = d.eccentricAnomalyRad > 0; this.trueArc.visible = d.trueAnomalyRad > 0;
      this.eccentricProjection.visible = this.snapshot.config.eccentricity > 0;
      this.eccentricPoint.position.set(...d.eccentricPoint); this.meanTimePoint.position.set(...d.meanTimePoint); this.positionPoint.position.set(...d.position);
    }
  }
  applyStatic(snapshot) {
    const key = JSON.stringify(snapshot.config);
    if (key === this.configKey) return;
    this.configKey = key; this.samples = sampleOrbit(snapshot.config, { sampleCount: G.orbitSamples });
    this.setLine(this.orbitPath, this.samples.map(sample => physicalToWorld(sample.positionM)));
    this.landmarks = orbitLandmarks(snapshot); const L = this.landmarks;
    this.centerMarker.position.set(...L.center); this.secondMarker.position.set(...L.secondFocus);
    this.periMarker.position.set(...L.periapsis); this.apoMarker.position.set(...L.apoapsis);
    this.setLine(this.semiAxis, [L.center, L.periapsis]);
    this.axisTicks[0].position.set(...L.center); this.axisTicks[1].position.set(...L.periapsis);
    for (const [index, start] of [0, Math.PI].entries()) {
      const sector = getSweptSector(snapshot.config, start, snapshot.periodS / 12, { sampleCount: G.sectorSamples });
      const fan = makeSectorFan(sector), geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(fan.positions, 3)); geometry.computeVertexNormals(); geometry.computeBoundingBox();
      this.replaceGeometry(this.sectors[index].mesh, geometry); this.setLine(this.sectors[index].outline, [[0,0,0], ...fan.boundary, [0,0,0]]);
      this.sectors[index].analyticAreaAU2 = fan.analyticAreaAU2; this.sectors[index].durationS = sector.durationS;
    }
    this.anchor('central-body', [0,0,0]); this.anchor('ellipse-center', L.center); this.anchor('second-focus', L.secondFocus);
    this.anchor('semimajor-axis', V(L.center).add(V(L.periapsis)).multiplyScalar(.5)); this.anchor('apsides', L.periapsis);
    this.anchor('orbit-path', physicalToWorld(this.samples[Math.floor(this.samples.length * .37)].positionM));
    const areaPositions = this.sectors[0].mesh.geometry.getAttribute('position');
    this.anchor('equal-areas', new THREE.Vector3().fromBufferAttribute(areaPositions, Math.floor(areaPositions.count / 6) * 3 + 1).multiplyScalar(.58));
  }
  update(snapshot, view, comparisonSnapshot = null) {
    if (this.disposed || !snapshot) return;
    this.updating = true;
    try {
      this.snapshot = snapshot; this.view = { ...DEFAULT_VIEW, ...view }; this.comparisonSnapshot = comparisonSnapshot;
      this.applyStatic(snapshot);
      const position = physicalToWorld(snapshot.positionM), end = velocityVectorEnd(snapshot.positionM, snapshot.velocityMps);
      this.orbiter.position.set(...position); this.selectionOrbiter.position.set(...position); this.anchor('orbiter', position);
      this.setLine(this.radiusLine, [[0,0,0], position]); this.anchor('radius-line', V(position).multiplyScalar(.5));
      this.setArrow(this.velocity, position, end);
      this.anchor('velocity-vector', end);
      this.node('orbit-path').visible = this.view.orbit;
      for (const id of ['ellipse-center','second-focus','semimajor-axis','radius-line','apsides']) this.node(id).visible = this.view.geometry;
      this.node('ellipse-center').visible &&= !this.landmarks.circular; this.node('second-focus').visible &&= !this.landmarks.circular;
      this.grid.visible = this.view.geometry; this.node('velocity-vector').visible = this.view.velocity; this.node('equal-areas').visible = this.view.equalAreas;
      this.savedGroup.visible = !!comparisonSnapshot && this.view.orbit;
      if (comparisonSnapshot) {
        const key = JSON.stringify(comparisonSnapshot.config);
        if (key !== this.savedConfigKey) { this.savedConfigKey = key; this.setLine(this.savedPath, sampleOrbit(comparisonSnapshot.config, { sampleCount: G.orbitSamples }).map(sample => physicalToWorld(sample.positionM))); }
        this.savedMarker.position.set(...physicalToWorld(comparisonSnapshot.positionM));
      }
      this.selectionOrbiter.visible = this.view.selectedPart === 'orbiter'; this.selectionSun.visible = this.view.selectedPart === 'central-body';
      for (const [id, item] of this.parts) item.node.traverse(object => {
        if (object.isLine2) object.material.linewidth = (object.userData.baseLineWidth ?? 1.4) + (id === this.view.selectedPart ? .9 : 0);
      });
      this.updateConstructions(); this.applyInspectionVisibility(); this.trackInspection();
      // Controls already update on pointer input. With damping/auto-rotation
      // disabled, data refresh must not re-project imported polar camera poses.
      this.scene.updateMatrixWorld(true); this.render();
    } finally { this.updating = false; }
  }
  inspectionDefinition(id) {
    if (['velocity-vector','radius-line','orbiter'].includes(id)) return { kind: 'motion', parts: ['orbiter','velocity-vector'],
      note: '입자 주변 확대 · 전체 경로 일부 · 속도 성분은 10 km/s당 0.10 AU 표시 길이 · 가속도는 고정 길이 방향 표식이며 크기·이동거리가 아닙니다.' };
    if (['orbit-path','ellipse-center','second-focus','semimajor-axis'].includes(id)) return { kind: 'anomalies', parts: ['central-body','orbiter','orbit-path','ellipse-center','second-focus','semimajor-axis','radius-line'],
      note: 'M은 균일한 시간 기준각, E는 타원 중심 C의 보조원 각, ν는 중력 초점 F의 위치각 · 보조원과 M 표식은 실제 궤도·천체가 아닙니다.' };
    return null;
  }
  applyInspectionVisibility() {
    const definition = this.inspection && this.inspectionDefinition(this.inspection.id);
    this.motionGroup.visible = definition?.kind === 'motion'; this.angleGroup.visible = definition?.kind === 'anomalies';
    if (definition) {
      for (const [id, part] of this.parts) part.node.visible = definition.parts.includes(id);
      this.node('ellipse-center').visible &&= !this.landmarks.circular; this.node('second-focus').visible &&= !this.landmarks.circular;
      this.grid.visible = this.stars.visible = this.savedGroup.visible = this.halo.visible = false;
    } else { this.stars.visible = this.halo.visible = true; }
  }
  currentInspectionCenter() { return this.inspection?.kind === 'motion' ? this.orbiter.position.clone() : V(this.landmarks.center); }
  trackInspection() {
    if (!this.inspection) return; const center = this.currentInspectionCenter();
    if (this.inspection.center) { const delta = center.clone().sub(this.inspection.center); this.camera.position.add(delta); this.controls.target.add(delta); this.boundCamera(); this.camera.lookAt(this.controls.target); }
    this.inspection.center = center;
  }
  beginInspection(id) {
    const definition = this.inspectionDefinition(id); if (!definition || !this.snapshot || this.disposed) return false;
    if (this.inspection?.id === id) return true;
    const original = this.inspection?.original ?? { camera: this.getCameraState(), focusContext: this.focusContext ? [...this.focusContext] : null };
    this.inspection = { id, kind: definition.kind, original, center: null }; this.focusContext = [id]; this.motionGroup.userData.partId = id; this.angleGroup.userData.partId = id;
    this.updateConstructions(); this.applyInspectionVisibility();
    let points;
    if (definition.kind === 'motion') {
      // A fixed envelope for this orbit keeps rotating/growing vectors in frame
      // during playback without changing zoom or the velocity display scale.
      const d = this.vectorConstruction, envelope = Math.max(this.snapshot.periapsisSpeedMps / 1000 * G.velocityWorldPerKmS, G.accelerationDirectionLengthWorld) + .035;
      points = []; for (const x of [-envelope,envelope]) for (const z of [-envelope,envelope]) for (const y of [-.02,.02]) points.push(V(d.origin).add(new THREE.Vector3(x,y,z)));
    } else points = this.fitPoints(['orbit-path','central-body']).concat(this.angleConstruction.auxiliaryCircle.map(V));
    this.fitWorldPoints(points, [0,1,0]); this.inspection.center = this.currentInspectionCenter(); this.render(); return true;
  }
  endInspection() {
    if (!this.inspection) return false; const original = this.inspection.original; this.inspection = null;
    this.update(this.snapshot, this.view, this.comparisonSnapshot); this.setCameraState(original.camera); this.focusContext = original.focusContext; this.render(); return true;
  }
  getInspection() { if (!this.inspection) return null; const definition = this.inspectionDefinition(this.inspection.id); return { id: this.inspection.id, kind: definition.kind, note: definition.note }; }
  getProjectCameraState() { return this.inspection ? structuredClone(this.inspection.original.camera) : this.getCameraState(); }
  buildOverlay() {
    this.overlay = document.createElement('div'); this.overlay.className = 'orbit-overlay';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); this.svg.classList.add('orbit-leaders'); this.overlay.append(this.svg);
    this.labels = new Map();
    for (const part of COMPONENTS) {
      const button = document.createElement('button'); button.className = 'orbit-label'; button.type = 'button'; button.textContent = part.name;
      button.addEventListener('click', () => this.onSelect(part.id)); button.hidden = true;
      const halo = document.createElementNS(this.svg.namespaceURI,'path'), line = document.createElementNS(this.svg.namespaceURI,'path'), dot = document.createElementNS(this.svg.namespaceURI,'circle');
      halo.classList.add('orbit-leader-halo'); line.classList.add('orbit-leader-line'); dot.setAttribute('r','3'); this.svg.append(halo,line,dot); this.overlay.append(button);
      this.labels.set(part.id, { button, halo, line, dot });
    }
    this.scaleNote = document.createElement('div'); this.scaleNote.className = 'orbit-scale-note'; this.scaleNote.textContent = '천체 크기 확대 · 궤도 좌표는 동일 AU 축척';
    this.vectorNote = document.createElement('div'); this.vectorNote.className = 'orbit-vector-note'; this.vectorNote.textContent = '속도 화살표: 10 km/s → 0.10 AU 표시 길이';
    this.detailLegend = document.createElement('div'); this.detailLegend.className = 'orbit-detail-legend'; this.detailLegend.hidden = true;
    this.constructionLabels = new Map(); this.constructionLeaders = new Map();
    for (const [id,title] of [['center','C · 타원 중심'],['focus','F · 중력 초점'],['position','P · 실제 위치'],['eccentric','E · 보조원 점'],['mean','M · 시간 기준'],['radial','vᵣ'],['transverse','vθ'],['total','v'],['acceleration','가속도 방향']]) {
      const label = document.createElement('span'); label.className = 'orbit-construction-label'; label.textContent = title; label.hidden = true; this.overlay.append(label); this.constructionLabels.set(id, label);
      const line = document.createElementNS(this.svg.namespaceURI,'path'); line.classList.add('orbit-construction-leader'); line.style.display = 'none'; this.svg.append(line); this.constructionLeaders.set(id, line);
    }
    this.overlay.append(this.scaleNote, this.vectorNote, this.detailLegend); this.container.append(this.overlay);
  }
  buildPointer() {
    this.raycaster = new THREE.Raycaster(); this.raycaster.params.Line.threshold = .025; this.raycaster.params.Line2 = { threshold: 2 };
    this.pointerStart = null;
    this.pointerDown = event => { if (event.button === 0) this.pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId }; };
    this.pointerCancel = () => { this.pointerStart = null; };
    this.pointerUp = event => {
      const start = this.pointerStart; this.pointerStart = null;
      if (!start || event.pointerId !== start.id || Math.hypot(event.clientX-start.x,event.clientY-start.y)>5) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.raycaster.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),this.camera);
      const targets = []; this.root.traverseVisible(object => { if (object.isMesh || object.isLine2) targets.push(object); });
      for (const hit of this.raycaster.intersectObjects(targets,false)) {
        let node=hit.object; while (node && !node.userData.partId) node=node.parent;
        if (node) { this.onSelect(node.userData.partId); break; }
      }
    };
    this.renderer.domElement.addEventListener('pointerdown',this.pointerDown); this.renderer.domElement.addEventListener('pointerup',this.pointerUp); this.renderer.domElement.addEventListener('pointercancel',this.pointerCancel);
  }
  layoutLabels() {
    if (!this.snapshot) return;
    const width=this.width, height=this.height, narrow=width<620, labelWidth=narrow?142:166, labelHeight=30;
    const bottom=height-(narrow?103:69), occupied=[];
    const selected=this.view.selectedPart;
    const defaults=this.focusContext??['orbiter','central-body','apsides','orbit-path'];
    const candidates=[...new Set([selected,...defaults])].slice(0,narrow?3:4);
    this.labelEvidence=[]; this.vectorNote.hidden=Boolean(this.inspection)||!this.view.velocity; this.scaleNote.hidden=Boolean(this.inspection);
    this.layoutConstructionLabels();
    for (const [id,label] of this.labels) {
      label.button.hidden=true; for(const object of [label.halo,label.line,label.dot])object.style.display='none';
      if (!this.view.labels || !candidates.includes(id)) continue;
      const part=this.parts.get(id);
      if (!part.node.visible) continue;
      const point=part.anchor.clone().project(this.camera);
      if(point.z < -1 || point.z > 1 || Math.abs(point.x)>1 || Math.abs(point.y)>1)continue;
      const anchorX=(point.x*.5+.5)*width,anchorY=(-point.y*.5+.5)*height;
      const title=id==='central-body' && this.landmarks.circular?'중심체 · 원의 중심':id==='apsides' && this.landmarks.circular?'기준 +X 위치':part.name;
      label.button.textContent=title; label.button.style.width=`${labelWidth}px`; label.button.classList.toggle('is-selected',id===selected);
      const offsets=this.inspection ? [[12-anchorX,12-anchorY]] : [[15,-42],[-labelWidth-15,-42],[15,14],[-labelWidth-15,14],[-labelWidth/2,-74],[-labelWidth/2,48]];
      let best=null;
      for(const [dx,dy]of offsets){const x=clamp(anchorX+dx,10,width-labelWidth-10),y=clamp(anchorY+dy,this.inspection?12:48,bottom-labelHeight);const rect={x,y,w:labelWidth,h:labelHeight};
        if(!occupied.some(other=>rect.x<other.x+other.w+6&&rect.x+rect.w+6>other.x&&rect.y<other.y+other.h+7&&rect.y+rect.h+7>other.y)){best=rect;break;}}
      if(!best)continue;occupied.push(best);
      const x=best.x,y=best.y,endX=clamp(anchorX,x+8,x+labelWidth-8),endY=anchorY<y?y:y+labelHeight;
      label.button.style.left=`${x}px`;label.button.style.top=`${y}px`;label.button.hidden=false;
      const d=`M ${anchorX} ${anchorY} L ${endX} ${endY}`;
      for(const object of[label.halo,label.line]){object.setAttribute('d',d);object.style.display='';}
      label.dot.setAttribute('cx',anchorX);label.dot.setAttribute('cy',anchorY);label.dot.style.display='';
      this.labelEvidence.push({id,left:x,top:y,width:labelWidth,height:labelHeight,anchor:[anchorX,anchorY],world:part.anchor.toArray().map(clean)});
    }
  }
  layoutConstructionLabels() {
    for (const label of this.constructionLabels.values()) label.hidden = true;
    for (const line of this.constructionLeaders.values()) line.style.display = 'none';
    this.detailLegend.hidden = !this.inspection;
    if (!this.inspection) return;
    const rows = this.inspection.kind === 'motion' ? [['velocity','v 합'],['radial','vᵣ 방사'],['transverse','vθ 횡방향'],['acceleration','가속도 방향 · 길이 고정']] : [['mean','M 시간 기준각'],['eccentric','E 보조원 각'],['true','ν 초점 위치각']];
    if (this.detailLegend.dataset.kind !== this.inspection.kind) {
      this.detailLegend.dataset.kind = this.inspection.kind; this.detailLegend.replaceChildren(...rows.map(([key, title]) => { const label = document.createElement('span'); label.textContent = title; label.style.setProperty('--key-color', color[key]); return label; }));
    }
    if (!this.view.labels) return;
    if(this.inspection.kind==='motion') {
      const d=this.vectorConstruction, labels=[['total',d.totalEnd,`v ${(this.snapshot.speedMps/1000).toFixed(2)} km/s`],['radial',d.radialEnd,`vᵣ ${d.radialMps>=0?'+':''}${(d.radialMps/1000).toFixed(2)} km/s`],['transverse',d.transverseEnd,`vθ ${(d.transverseMps/1000).toFixed(2)} km/s`],['acceleration',d.accelerationDirectionEnd,'가속도 방향 → 중심']],placed=[];
      const anchors=[d.origin,...labels.map(([,p])=>p)].map(p=>V(p).project(this.camera)).map(p=>({x:(p.x*.5+.5)*this.width,y:(-p.y*.5+.5)*this.height}));
      for(const[id,world,title]of labels){
        const p=V(world).project(this.camera);if(Math.abs(p.x)>1||Math.abs(p.y)>1||p.z<-1||p.z>1)continue;
        const x=(p.x*.5+.5)*this.width,y=(-p.y*.5+.5)*this.height,w=118,h=23;
        for(const[dx,dy]of [[14,-33],[14,10],[-w-14,-33],[-w-14,10],[14,-63],[14,40],[-w-14,40],[-w-14,-63],[14,70],[-w-14,70],[14,-93],[-w-14,-93]]){
          const b={x:clamp(x+dx,10,this.width-w-10),y:clamp(y+dy,52,this.height-90),w,h};if(placed.some(a=>b.x<a.x+a.w+5&&b.x+w+5>a.x&&b.y<a.y+a.h+4&&b.y+h+4>a.y))continue;
          if(anchors.some(p=>p.x>=b.x-9&&p.x<=b.x+w+9&&p.y>=b.y-9&&p.y<=b.y+h+9))continue;
          const label=this.constructionLabels.get(id),tint=color[id==='total'?'velocity':id];label.textContent=title;label.style.color=tint;label.hidden=false;label.style.left=`${b.x}px`;label.style.top=`${b.y}px`;
          const line=this.constructionLeaders.get(id);line.style.display='';line.style.stroke=tint;line.setAttribute('d',`M ${x} ${y} L ${clamp(x,b.x,b.x+label.offsetWidth)} ${clamp(y,b.y,b.y+label.offsetHeight)}`);placed.push(b);break;
        }
      }return;
    }
    const d = this.angleConstruction, placed = [];
    const entries = [['position',d.position],['eccentric',d.eccentricPoint],['mean',d.meanTimePoint],['center',d.center],['focus',d.focus]]
      .filter(([id])=>!this.landmarks.circular||!['center','mean','eccentric'].includes(id))
      .map(([id,world])=>({id,point:V(world).project(this.camera)}))
      .filter(({point:p})=>Math.abs(p.x)<=1&&Math.abs(p.y)<=1&&p.z>=-1&&p.z<=1)
      .map(({id,point:p})=>({id,x:(p.x*.5+.5)*this.width,y:(-p.y*.5+.5)*this.height}));
    for (const {id,x,y} of entries) {
      const label=this.constructionLabels.get(id), w=118,h=23;
      const options = id==='eccentric' ? [[-w-14,-33],[14,-33],[-w-14,10],[14,10]] : [[14,10],[14,-33],[-w-14,10],[-w-14,-33]];
      options.push([14,40],[-w-14,40],[14,-63],[-w-14,-63],[14,70],[-w-14,70]);
      for(const[dx,dy]of options){
        const box={x:clamp(x+dx,10,this.width-w-10),y:clamp(y+dy,52,this.height-84),w,h};
        if(placed.some(b=>box.x<b.x+b.w+5&&box.x+w+5>b.x&&box.y<b.y+b.h+5&&box.y+h+5>b.y))continue;
        if(entries.some(p=>p.x>=box.x-9&&p.x<=box.x+w+9&&p.y>=box.y-9&&p.y<=box.y+h+9))continue;
        const tint=id==='position'?color.true:id==='eccentric'?color.eccentric:id==='mean'?color.mean:color.geometry;
        label.hidden=false;label.style.color=tint;label.style.left=`${box.x}px`;label.style.top=`${box.y}px`;
        label.textContent=this.landmarks.circular&&id==='focus'?'C = F · 원의 중심':id==='center'?'C · 타원 중심':id==='focus'?'F · 중력 초점':id==='position'?'P · 실제 위치':id==='mean'?'M · 시간 기준':'E · 보조원 점';
        const line=this.constructionLeaders.get(id);line.style.display='';line.style.stroke=tint;line.setAttribute('d',`M ${x} ${y} L ${clamp(x,box.x,box.x+label.offsetWidth)} ${clamp(y,box.y,box.y+label.offsetHeight)}`);
        placed.push(box);break;
      }
    }
  }
  boundCamera() {
    for(const axis of ['x','y','z']) {
      const high=Math.max(this.camera.position[axis],this.controls.target[axis]),low=Math.min(this.camera.position[axis],this.controls.target[axis]);
      const shift=high>30?30-high:low< -30?-30-low:0;this.camera.position[axis]+=shift;this.controls.target[axis]+=shift;
    }
  }
  fitPoints(ids, includeSaved=false) {
    this.scene.updateMatrixWorld(true);const points=[];
    for(const root of [...ids.map(id=>this.node(id)),...(includeSaved&&this.savedGroup.visible?[this.savedGroup]:[])])root.traverseVisible(object=>{
      if(!(object.isMesh||object.isLine2||object.isLine)||!object.geometry)return;
      object.geometry.computeBoundingBox();const box=object.geometry.boundingBox;if(!box||box.isEmpty())return;
      for(const x of[box.min.x,box.max.x])for(const y of[box.min.y,box.max.y])for(const z of[box.min.z,box.max.z])points.push(object.localToWorld(new THREE.Vector3(x,y,z)));
    });return points;
  }
  fit(ids,direction,includeSaved=false) {
    return this.fitWorldPoints(this.fitPoints(ids,includeSaved),direction);
  }
  fitWorldPoints(points,direction) {
    if(!points.length)return false;
    const bounds=new THREE.Box3().setFromPoints(points),target=bounds.getCenter(new THREE.Vector3()),forward=V(direction).normalize();
    const right=new THREE.Vector3().crossVectors(this.camera.up,forward).normalize(),up=new THREE.Vector3().crossVectors(forward,right).normalize();
    const tanY=Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2)),tanX=tanY*this.camera.aspect;let distance=.35;
    const verticalMargin=this.width<620?.62:.72,horizontalMargin=.8;
    for(const point of points){const p=point.clone().sub(target),depth=p.dot(forward);distance=Math.max(distance,depth+Math.abs(p.dot(right))/(tanX*horizontalMargin),depth+Math.abs(p.dot(up))/(tanY*verticalMargin));}
    this.updating=true;this.camera.zoom=1;this.camera.position.copy(target).addScaledVector(forward,Math.min(39,distance+.07));this.controls.target.copy(target);this.boundCamera();this.controls.update();this.camera.updateProjectionMatrix();this.updating=false;
    this.render();this.onCameraChange(this.getProjectCameraState());return true;
  }
  resetCamera(preset='iso') {
    if(this.inspection)this.endInspection();
    if(!['iso','plane','periapsis'].includes(preset))return false;
    this.focusContext=null;
    if(preset==='periapsis'&&this.snapshot){
      this.focusContext=['central-body','apsides','orbiter'];
      const points=this.fitPoints(['central-body']), center=V(this.landmarks.periapsis);
      // This preset observes the reference/periapsis region, not both apsides.
      // Include the actual periapsis symbol bounds without the remote apoapsis.
      for(const x of[-.04,.04])for(const y of[-.025,.025])for(const z of[-.04,.04])points.push(center.clone().add(new THREE.Vector3(x,y,z)));
      return this.fitWorldPoints(points,[.28,1,.8]);
    }
    return this.fit(COMPONENTS.map(part=>part.id),preset==='plane'?[0,1,0]:[.7,1.3,1.5],true);
  }
  focusPart(id) {
    if(this.inspection)this.endInspection();
    if(!this.parts.has(id)||!this.snapshot)return false;
    const related={ 'central-body':['central-body','second-focus','ellipse-center'],orbiter:['orbiter','velocity-vector'], 'orbit-path':['orbit-path','central-body'], 'ellipse-center':['ellipse-center','semimajor-axis','second-focus'], 'second-focus':['central-body','ellipse-center','second-focus'], 'semimajor-axis':['semimajor-axis','ellipse-center'], 'radius-line':['radius-line','central-body','orbiter'],apsides:['apsides','central-body'], 'velocity-vector':['orbiter','velocity-vector'], 'equal-areas':['equal-areas','central-body'] };
    const ids=related[id];this.focusContext=[id,...ids];return this.fit(ids,id==='equal-areas'||id==='semimajor-axis'?[0,1,0]:[.45,1.25,1]);
  }
  getCameraState() {return{position:this.camera.position.toArray().map(clean),target:this.controls.target.toArray().map(clean),zoom:clean(this.camera.zoom)};}
  setCameraState(value) {
    if(!value||!['position','target'].every(key=>Array.isArray(value[key])&&value[key].length===3&&value[key].every(x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=30)))return false;
    const position=V(value.position),target=V(value.target),distance=position.distanceTo(target),zoom=value.zoom??1;
    if(distance<.2-1e-10||distance>40+1e-10||!Number.isFinite(zoom)||zoom<.25||zoom>4)return false;
    this.updating=true;this.camera.position.copy(position);this.controls.target.copy(target);this.camera.zoom=zoom;this.controls.update();
    // Preserve exact valid imported coordinates after OrbitControls roundoff.
    this.camera.position.copy(position);this.controls.target.copy(target);this.camera.lookAt(target);this.camera.updateProjectionMatrix();this.updating=false;this.focusContext=null;this.render();return true;
  }
  getComponents() {return COMPONENTS.map(part=>({...part}));}
  linePoints(line) {
    const starts=line.geometry.getAttribute('instanceStart'),ends=line.geometry.getAttribute('instanceEnd');if(!starts||!ends)return[];
    const points=[];for(let i=0;i<starts.count;i++)points.push(line.localToWorld(new THREE.Vector3().fromBufferAttribute(starts,i)).toArray().map(clean));
    points.push(line.localToWorld(new THREE.Vector3().fromBufferAttribute(ends,ends.count-1)).toArray().map(clean));return points;
  }
  getDebug() {
    this.scene.updateMatrixWorld(true);const world=object=>object.getWorldPosition(new THREE.Vector3()).toArray().map(clean);
    const sectors=this.sectors.map(({mesh,analyticAreaAU2,durationS})=>{
      const positions=mesh.geometry.getAttribute('position'),actual=[];
      if(positions)for(let i=0;i<positions.count;i++)actual.push(...mesh.localToWorld(new THREE.Vector3().fromBufferAttribute(positions,i)).toArray());
      return{visible:mesh.parent.visible,triangleCount:actual.length/9,meshAreaAU2:triangleAreaSum(actual),analyticAreaAU2,durationS,startBoundary:actual.slice(3,6),endBoundary:actual.slice(-3)};
    });
    const arrowStart=world(this.velocity),arrowTip=this.velocity.cone.localToWorld(new THREE.Vector3(0,0,0)).toArray().map(clean);
    return{ready:!!this.snapshot,componentCount:this.parts.size,orbiterWorld:world(this.orbiter),centralWorld:world(this.sun),ellipseCenterWorld:world(this.centerMarker),secondFocusWorld:world(this.secondMarker),periapsisWorld:world(this.periMarker),apoapsisWorld:world(this.apoMarker),velocityStartWorld:arrowStart,velocityEndWorld:arrowTip,
      velocityVisible:this.node('velocity-vector').visible,velocityScaleWorldPerKmS:G.velocityWorldPerKmS,
      radiusPoints:this.linePoints(this.radiusLine),semimajorPoints:this.linePoints(this.semiAxis),orbitPoints:this.linePoints(this.orbitPath),orbitVisible:this.node('orbit-path').visible,
      savedVisible:this.savedGroup.visible,savedPositionWorld:this.savedGroup.visible?world(this.savedMarker):null,savedOrbitPoints:this.savedGroup.visible?this.linePoints(this.savedPath):[],savedPathColor:`#${this.savedPath.material.color.getHexString()}`,savedMarkerColor:`#${this.savedMarker.material.color.getHexString()}`,currentPathColor:`#${this.orbitPath.material.color.getHexString()}`,
      sectors,labels:structuredClone(this.labelEvidence??[]),view:{...this.view},camera:this.getCameraState(),projectCamera:this.getProjectCameraState(),inspection:this.getInspection(),constructions:this.constructionDebug(),
      visibleParts:[...this.parts].filter(([,part])=>part.node.visible).map(([id])=>id),gridVisible:this.grid.visible,
      resources:{geometries:this.renderer.info.memory.geometries,textures:this.renderer.info.memory.textures,radiusGeometryId:this.radiusLine.geometry.id,radiusBufferId:this.radiusLine.geometry.getAttribute('instanceStart').data.uuid,velocityGeometryId:this.velocity.line.geometry.id},
      velocityShaftPoints:this.linePoints(this.velocity.line),velocityShaftWidthPx:this.velocity.line.material.linewidth,
      drawCalls:this.renderer.info.render.calls,triangles:this.renderer.info.render.triangles,renderFrame:this.renderer.info.render.frame};
  }
  constructionDebug() {
    if(!this.inspection)return null;
    const point=object=>object.getWorldPosition(new THREE.Vector3()).toArray().map(clean),tip=arrow=>arrow.cone.localToWorld(new THREE.Vector3()).toArray().map(clean);
    if(this.inspection.kind==='motion')return{kind:'motion',origin:point(this.velocity),totalEnd:tip(this.velocity),radialEnd:tip(this.radialArrow),transverseEnd:tip(this.transverseArrow),radialVisible:this.radialArrow.visible,transverseVisible:this.transverseArrow.visible,
      sumGuidePoints:this.linePoints(this.sumGuide),sumGuideOtherPoints:this.linePoints(this.sumGuideOther),accelerationDirectionEnd:tip(this.accelerationArrow),accelerationDirectionLengthWorld:G.accelerationDirectionLengthWorld,accelerationIsDirectionOnly:true,velocityWorldPerKmS:G.velocityWorldPerKmS,
      localOrbitPoints:this.linePoints(this.localOrbitGuide),localOrbitSampleIndices:[...this.localOrbitSampleIndices],radialDirectionPoints:this.linePoints(this.radialDirectionGuide)};
    return{kind:'anomalies',center:[...this.angleConstruction.center],focus:[0,0,0],position:point(this.positionPoint),auxiliaryRadiusWorld:this.angleConstruction.auxiliaryRadiusWorld,auxiliaryCirclePoints:this.linePoints(this.auxiliaryCircle),eccentricPoint:point(this.eccentricPoint),meanTimePoint:point(this.meanTimePoint),meanPointIsTimeReference:true,
      projectionPoints:this.linePoints(this.eccentricProjection),meanRadiusPoints:this.linePoints(this.meanRadius),eccentricRadiusPoints:this.linePoints(this.eccentricRadius),meanArcPoints:this.linePoints(this.meanArc),eccentricArcPoints:this.linePoints(this.eccentricArc),trueArcPoints:this.linePoints(this.trueArc),
      arcVisible:{mean:this.meanArc.visible,eccentric:this.eccentricArc.visible,true:this.trueArc.visible},constructionLabels:[...this.constructionLabels].filter(([,label])=>!label.hidden).map(([id,label])=>({id,text:label.textContent,left:parseFloat(label.style.left),top:parseFloat(label.style.top)}))};
  }
  resize() {
    if(this.disposed)return;this.width=Math.max(1,this.container.clientWidth);this.height=Math.max(1,this.container.clientHeight);
    this.renderer.setSize(this.width,this.height,false);this.camera.aspect=this.width/this.height;this.camera.updateProjectionMatrix();
    for(const material of this.wideMaterials)material.resolution.set(this.width,this.height);this.render();
  }
  render() {if(this.disposed)return;this.camera.updateMatrixWorld();this.layoutLabels();this.renderer.render(this.scene,this.camera);}
  dispose() {
    if(this.disposed)return;this.disposed=true;this.resizeObserver.disconnect();this.controls.removeEventListener('change',this.controlChange);this.controls.dispose();
    this.renderer.domElement.removeEventListener('pointerdown',this.pointerDown);this.renderer.domElement.removeEventListener('pointerup',this.pointerUp);this.renderer.domElement.removeEventListener('pointercancel',this.pointerCancel);
    for(const texture of this.textures)texture.dispose();for(const geometry of this.geometries)geometry.dispose();for(const material of this.materials)material.dispose();
    this.renderer.dispose();this.renderer.domElement.remove();this.overlay.remove();this.container.classList.remove('orbit-scene');
  }
}
