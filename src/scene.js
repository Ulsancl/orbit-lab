import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { sampleOrbit, getSweptSector } from './model.js';
import { COMPONENTS, DEFAULT_VIEW, GEOMETRY as G, physicalToWorld, velocityVectorEnd, orbitLandmarks, makeSectorFan, triangleAreaSum } from './geometry.js';
import './scene.css';

const V = values => new THREE.Vector3(...values);
const clean = value => Object.is(value, -0) ? 0 : value;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const color = { current: '#87d9ff', saved: '#ffc783', geometry: '#90a7c2', velocity: '#f5c476', areaA: '#4baacf', areaB: '#b690e4' };

export class OrbitScene {
  constructor(container, { onSelect = () => {}, onCameraChange = () => {} } = {}) {
    this.container = container; this.onSelect = onSelect; this.onCameraChange = onCameraChange;
    this.view = { ...DEFAULT_VIEW }; this.parts = new Map(); this.geometries = new Set(); this.materials = new Set(); this.textures = new Set();
    this.wideMaterials = new Set(); this.updating = true; this.focusContext = null; this.disposed = false;
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
      if (!this.updating && !this.disposed) { this.boundCamera(); this.render(); this.onCameraChange(this.getCameraState()); }
    };
    this.controls.addEventListener('change', this.controlChange);
    this.scene.add(new THREE.AmbientLight('#a6bed7', .8));
    const sunLight = new THREE.PointLight('#ffe3ac', 8, 0, 1); sunLight.position.set(0, .025, 0); this.scene.add(sunLight);
    const fill = new THREE.DirectionalLight('#89baff', .8); fill.position.set(2, 4, -3); this.scene.add(fill);
    this.root = new THREE.Group(); this.scene.add(this.root);
    for (const part of COMPONENTS) { const node = new THREE.Group(); node.name = part.id; node.userData.partId = part.id; this.root.add(node); this.parts.set(part.id, { ...part, node, anchor: new THREE.Vector3() }); }
    this.buildSpace(); this.buildBodies(); this.buildGeometry(); this.buildOverlay(); this.buildPointer();
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
    const line = new Line2(geometry, material); line.computeLineDistances(); parent.add(line); return line;
  }
  setLine(line, points) { const geometry = new LineGeometry(); geometry.setPositions(points.flat()); this.replaceGeometry(line, geometry); line.computeLineDistances(); }
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
    this.velocity = new THREE.ArrowHelper(new THREE.Vector3(1,0,0), new THREE.Vector3(), .3, color.velocity, .05, .025);
    this.velocity.line.material.toneMapped = false; this.velocity.cone.material.toneMapped = false;
    this.node('velocity-vector').add(this.velocity); this.materials.add(this.velocity.line.material); this.materials.add(this.velocity.cone.material);
    // ArrowHelper owns shared geometry; track it only at final disposal, never
    // replace it during updates.
    this.geometries.add(this.velocity.line.geometry); this.geometries.add(this.velocity.cone.geometry);
    this.sectors = [color.areaA, color.areaB].map(sectorColor => {
      const material = this.material({ color: sectorColor, transparent: true, opacity: .23, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, toneMapped: false }, true);
      const mesh = this.mesh(new THREE.BufferGeometry(), material, this.node('equal-areas'));
      const outline = this.wideLine(this.node('equal-areas'), [[0,0,0],[1,0,0]], { lineColor: sectorColor, width: 1.8 });
      return { mesh, outline, analyticAreaAU2: 0, durationS: 0 };
    });
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
      const delta = V(end).sub(V(position)), length = delta.length();
      this.velocity.position.set(...position); this.velocity.setDirection(delta.clone().normalize()); this.velocity.setLength(length, Math.min(.055, length * .22), Math.min(.026, length * .12));
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
        if (object.isLine2) object.material.linewidth = (object === this.orbitPath ? 2.1 : 1.4) + (id === this.view.selectedPart ? .9 : 0);
      });
      // Controls already update on pointer input. With damping/auto-rotation
      // disabled, data refresh must not re-project imported polar camera poses.
      this.scene.updateMatrixWorld(true); this.render();
    } finally { this.updating = false; }
  }
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
    this.overlay.append(this.scaleNote, this.vectorNote); this.container.append(this.overlay);
  }
  buildPointer() {
    this.raycaster = new THREE.Raycaster(); this.raycaster.params.Line.threshold = .025;
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
    this.labelEvidence=[]; this.vectorNote.hidden=!this.view.velocity;
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
      const offsets=[[15,-42],[-labelWidth-15,-42],[15,14],[-labelWidth-15,14],[-labelWidth/2,-74],[-labelWidth/2,48]];
      let best=null;
      for(const [dx,dy]of offsets){const x=clamp(anchorX+dx,10,width-labelWidth-10),y=clamp(anchorY+dy,48,bottom-labelHeight);const rect={x,y,w:labelWidth,h:labelHeight};
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
    this.render();this.onCameraChange(this.getCameraState());return true;
  }
  resetCamera(preset='iso') {
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
      sectors,labels:structuredClone(this.labelEvidence??[]),view:{...this.view},camera:this.getCameraState(),drawCalls:this.renderer.info.render.calls,triangles:this.renderer.info.render.triangles,renderFrame:this.renderer.info.render.frame};
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
