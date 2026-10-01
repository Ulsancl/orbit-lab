import { ORBIT_CONSTANTS_SI } from './model.js';

export const COMPONENTS = Object.freeze([
  ['central-body', '중심체 · 중력 초점', '태양의 중력상수를 가진 고정 중심점입니다. 빛나는 구는 크게 그린 관찰 기호이며 구의 표면은 충돌 경계가 아닙니다.', '원본 절차 생성 발광 기호'],
  ['orbiter', '시험입자', '중심체에 영향을 주지 않는 가벼운 시험입자입니다. 이 구의 중심이 계산 위치이고, 구의 크기와 표면 무늬는 실제 행성 자료가 아닙니다.', '확대된 원본 관찰 기호'],
  ['orbit-path', '궤도', '중심체를 한 초점으로 지나는 원 또는 타원입니다. 현재와 보관 궤도 모두 같은 AU 축척을 사용합니다.', '물리 좌표의 궤도선'],
  ['ellipse-center', '타원의 중심', '장축과 단축이 만나는 기하학적 중심입니다. 타원에서는 중력 중심과 다릅니다. 원에서는 중심체와 두 초점이 이곳에 겹칩니다.', '기하 보조 표식'],
  ['second-focus', '다른 초점', '타원의 모양을 설명하는 두 번째 기하학적 초점입니다. 여기에 별이나 추가 중력원이 있는 것은 아닙니다.', '빈 고리 형태의 보조 표식'],
  ['semimajor-axis', '장반경 a', '타원 중심에서 장축 끝까지의 거리입니다. 중심체에서 시험입자까지의 현재 거리 r와 구분합니다.', '길이 보조선'],
  ['radius-line', '현재 거리 r', '고정 중심점과 현재 시험입자 중심을 잇는 선입니다. 타원에서는 이동에 따라 길이가 달라집니다.', '현재 위치의 반지름선'],
  ['apsides', '근일점 · 원일점', '중심체에 가장 가까운 위치와 가장 먼 위치입니다. 원궤도는 모든 곳의 거리가 같으므로 두 표식은 기준 +X와 반대 위치일 뿐입니다.', '궤도 위 위치 표식'],
  ['velocity-vector', '속도 벡터', '입자 위치에서 출발하는 궤도 접선 방향의 화살표입니다. 길이는 1 km/s당 화면 좌표 0.01 AU로 표시하며 이동 거리가 아닙니다.', '고정 선형 배율의 벡터'],
  ['equal-areas', '같은 시간의 면적', '이 궤도의 평균근점이각 0°와 180°에서 각각 주기의 1/12만큼 쓸린 두 곡선 부채꼴입니다. 같은 시간·같은 면적이며 서로 다른 궤도끼리의 면적 동일성은 뜻하지 않습니다.', '곡선 경계를 분할한 면적 표시'],
].map(([id, name, description, material]) => Object.freeze({ id, name, label: name, description, material })));

export const DEFAULT_VIEW = Object.freeze({ orbit: true, geometry: true, velocity: true, equalAreas: false, labels: true, selectedPart: 'orbiter' });
export const GEOMETRY = Object.freeze({
  astronomicalUnitM: ORBIT_CONSTANTS_SI.astronomicalUnitM,
  velocityWorldPerKmS: .01,
  centralSymbolRadiusWorld: .045,
  particleSymbolRadiusWorld: .018,
  orbitSamples: 512,
  sectorSamples: 1024,
});
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clean = value => Object.is(value, -0) ? 0 : value;
function assertPoint(point, name) {
  if (!point || !finite(point.x) || !finite(point.y)) throw new TypeError(`${name} requires finite x and y`);
}

export function physicalToWorld(positionM) {
  assertPoint(positionM, 'positionM');
  return [clean(positionM.x / GEOMETRY.astronomicalUnitM), 0, clean(-positionM.y / GEOMETRY.astronomicalUnitM)];
}
export function velocityVectorEnd(positionM, velocityMps) {
  assertPoint(velocityMps, 'velocityMps');
  const start = physicalToWorld(positionM), k = GEOMETRY.velocityWorldPerKmS / 1000;
  return [clean(start[0] + velocityMps.x * k), 0, clean(start[2] - velocityMps.y * k)];
}
export function orbitLandmarks(snapshot) {
  const { config, semiMinorAxisM, periapsisM, apoapsisM } = snapshot ?? {};
  if (!config || !finite(config.semiMajorAxisM) || config.semiMajorAxisM <= 0 || !finite(config.eccentricity) || config.eccentricity < 0 || config.eccentricity >= 1 || !finite(semiMinorAxisM) || semiMinorAxisM <= 0 || !finite(periapsisM) || !finite(apoapsisM)) throw new TypeError('Finite bound-orbit dimensions required');
  const centerM = -config.semiMajorAxisM * config.eccentricity;
  return {
    focus: [0, 0, 0], center: physicalToWorld({ x: centerM, y: 0 }), secondFocus: physicalToWorld({ x: 2 * centerM, y: 0 }),
    periapsis: physicalToWorld({ x: periapsisM, y: 0 }), apoapsis: physicalToWorld({ x: -apoapsisM, y: 0 }),
    minorPositive: physicalToWorld({ x: centerM, y: semiMinorAxisM }), minorNegative: physicalToWorld({ x: centerM, y: -semiMinorAxisM }),
    circular: config.eccentricity === 0,
  };
}

// Fan vertices are at the focus and actual curved boundary samples. Geometry
// never substitutes a single endpoint chord for a finite swept sector.
export function makeSectorFan(sector) {
  if (!sector || !Array.isArray(sector.samples) || sector.samples.length < 2 || !finite(sector.areaM2) || sector.areaM2 < 0) throw new TypeError('A sampled sector with finite area is required');
  const boundary = sector.samples.map(sample => physicalToWorld(sample.positionM));
  const positions = [];
  for (let i = 0; i < boundary.length - 1; i++) positions.push(0, 0, 0, ...boundary[i], ...boundary[i + 1]);
  return { positions, boundary, analyticAreaAU2: sector.areaM2 / GEOMETRY.astronomicalUnitM ** 2 };
}
export function triangleAreaSum(positions) {
  if (!(Array.isArray(positions) || ArrayBuffer.isView(positions)) || positions.length % 9 !== 0) throw new TypeError('Triangle positions must contain triples of 3D vertices');
  let area = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const values = Array.from(positions.slice(i, i + 9));
    if (!values.every(finite)) throw new TypeError('Triangle vertices must be finite');
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = values;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return area;
}
