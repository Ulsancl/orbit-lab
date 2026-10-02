import { getSnapshot, ORBIT_CONSTANTS_SI } from './model.js';

const TAU = 2 * Math.PI;
const { astronomicalUnitM: AU, dayS: DAY, solarMuM3PerS2: MU } = ORBIT_CONSTANTS_SI;
const clean = value => value === 0 ? 0 : value;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// The API observes a solved snapshot, never normalizes or repairs an experiment.
// Recheck the small solved record; no geometry, renderer or saved schema imports.
function checkedSnapshot(snapshot) {
  if (!record(snapshot)) throw new TypeError('snapshot must be a plain object');
  const reference = getSnapshot({ config: snapshot.config, meanAnomalyRad: snapshot.meanAnomalyRad });
  for (const [key, value] of Object.entries(reference)) {
    if (key === 'config') continue;
    if (record(value)) {
      if (!record(snapshot[key])) throw new TypeError(`snapshot.${key} must be a plain object`);
      for (const axis of ['x', 'y']) if (!finite(snapshot[key][axis]) || snapshot[key][axis] !== value[axis])
        throw new RangeError(`snapshot.${key}.${axis} does not match its experiment`);
    } else if (!finite(snapshot[key]) || snapshot[key] !== value) {
      throw new RangeError(`snapshot.${key} does not match its experiment`);
    }
  }
  return snapshot;
}

/** SI observations of orbit-kepler-1. Time values locate the current orbit
 * cycle, not elapsed history. Energies and angular momenta are per unit mass. */
export function orbitDetail(input) {
  const s = checkedSnapshot(input);
  const { semiMajorAxisM: a, eccentricity: e } = s.config;
  const { x, y } = s.positionM, { x: vx, y: vy } = s.velocityMps;
  const r = s.radiusM, M = s.meanAnomalyRad, E = s.eccentricAnomalyRad;
  const n = s.meanMotionRadPerS;
  const h = x * vy - y * vx;
  // Algebraically (r dot v)/r. Factoring avoids catastrophic cancellation of
  // the two Cartesian products for near-circular orbits. No epsilon clamping.
  const radialMps = e === 0 || M === 0 || M === Math.PI ? 0 : n * a * a * e * Math.sin(E) / r;
  const transverseMps = h / r;
  const magnitudeMps2 = MU / (r * r);
  const kineticJPerKg = (vx * vx + vy * vy) / 2;
  const potentialJPerKg = -MU / r;
  const totalJPerKg = kineticJPerKg + potentialJPerKg;
  const energyResidual = totalJPerKg - s.specificEnergyJPerKg;
  const momentumResidual = h - s.specificAngularMomentumM2PerS;
  const vector = (v, dx, dy) => ({ x: clean(v * dx), y: clean(v * dy) });
  return {
    velocity: {
      radialMps: clean(radialMps), transverseMps,
      radialVectorMps: vector(radialMps, x / r, y / r),
      transverseVectorMps: vector(transverseMps, -y / r, x / r),
      speedMps: s.speedMps, flightPathAngleRad: clean(Math.atan2(radialMps, transverseMps)),
      circularMps: Math.sqrt(MU / r), escapeMps: Math.sqrt(2 * MU / r),
    },
    acceleration: {
      vectorMps2: vector(-magnitudeMps2, x / r, y / r),
      magnitudeMps2, radialMps2: -magnitudeMps2, transverseMps2: 0,
    },
    energy: {
      kineticJPerKg, potentialJPerKg, totalJPerKg, referenceJPerKg: s.specificEnergyJPerKg,
      residualJPerKg: clean(energyResidual), relativeResidual: clean(energyResidual / Math.abs(s.specificEnergyJPerKg)),
    },
    momentum: {
      specificM2PerS: h, referenceM2PerS: s.specificAngularMomentumM2PerS,
      residualM2PerS: clean(momentumResidual), relativeResidual: clean(momentumResidual / s.specificAngularMomentumM2PerS),
      arealVelocityM2PerS: h / 2,
    },
    phase: {
      meanAnomalyRad: M, eccentricAnomalyRad: E, trueAnomalyRad: s.trueAnomalyRad,
      meanRateRadPerS: n, eccentricRateRadPerS: n * a / r, trueRateRadPerS: h / (r * r),
      periodS: s.periodS, cycleElapsedS: s.timeSinceReferenceS,
    },
    apsides: {
      unique: e !== 0, atPeriapsis: e !== 0 && M === 0, atApoapsis: e !== 0 && M === Math.PI,
      timeToPeriapsisS: e === 0 ? null : M === 0 ? 0 : (TAU - M) / n,
      timeToApoapsisS: e === 0 ? null : (M <= Math.PI ? Math.PI - M : (TAU - M) + Math.PI) / n,
      periapsisM: s.periapsisM, apoapsisM: s.apoapsisM,
    },
    geometry: {
      semiMajorAxisM: a, semiMinorAxisM: s.semiMinorAxisM, linearEccentricityM: a * e,
      focusSeparationM: 2 * a * e,
      ellipseCenterM: { x: clean(-a * e), y: 0 }, secondFocusM: { x: clean(-2 * a * e), y: 0 },
    },
  };
}

const fact = (label, value, unit = '', digits = 3) => ({ label, value, unit, digits });
const radiansToDegrees = radians => radians * 180 / Math.PI;
const timeFact = (label, value) => fact(label, value === null ? '구별 없음' : value / DAY, value === null ? '' : 'day', 4);

/** Component names are explicit to keep the pure diagnostics independent of
 * geometry.js, which can use these values for its explanatory construction. */
export function describeOrbitDetail(partId, snapshot, detail = orbitDetail(snapshot)) {
  const s = snapshot, d = detail, v = d.velocity, g = d.geometry;
  switch (partId) {
    case 'central-body': return {
      facts: [fact('중력계수 μ', MU, 'm³/s²'), fact('현재 중심 거리', s.radiusM / AU, 'AU'),
        fact('중력 가속도 크기', d.acceleration.magnitudeMps2 * 1000, 'mm/s²'),
        fact('현재 거리의 원궤도 속력', v.circularMps / 1000, 'km/s'), fact('현재 거리의 탈출 속력', v.escapeMps / 1000, 'km/s')],
      note: '원점의 고정 중력원입니다. 표식 구의 반지름은 실제 태양 표면·충돌 경계가 아닙니다. 원궤도·탈출 속력은 현재 거리의 비교값이며 기동이나 탈출 경로를 계산하지 않습니다.',
    };
    case 'orbiter': return {
      facts: [fact('전체 속력', v.speedMps / 1000, 'km/s'), fact('방사 속도', v.radialMps / 1000, 'km/s'),
        fact('횡방향 속도', v.transverseMps / 1000, 'km/s'), fact('비행 경로각', radiansToDegrees(v.flightPathAngleRad), '°'),
        fact('단위 질량당 총에너지', d.energy.totalJPerKg / 1e6, 'MJ/kg'),
        fact('중력 가속도 크기', d.acceleration.magnitudeMps2 * 1000, 'mm/s²')],
      note: '방사는 중심에서 바깥쪽이 양수, 횡방향은 반지름에 수직인 진행 방향입니다. 전체 속도 벡터가 궤도 접선입니다. 질량·표면 온도·충돌은 계산하지 않습니다.',
    };
    case 'orbit-path': return {
      facts: [fact('장반경 a', g.semiMajorAxisM / AU, 'AU'), fact('단반경 b', g.semiMinorAxisM / AU, 'AU'),
        fact('이심률 e', s.config.eccentricity, '', 4), fact('공전 주기', s.periodS / DAY, 'day'),
        fact('단위 질량당 총에너지', d.energy.totalJPerKg / 1e6, 'MJ/kg'),
        fact('단위 질량당 각운동량', d.momentum.specificM2PerS * DAY / AU ** 2, 'AU²/day', 6)],
      note: '같은 궤도의 모든 위치에서 에너지와 각운동량이 보존됩니다. a·e 변경은 새 이상 궤도를 선택하며 연속적인 추력 기동이 아닙니다.',
    };
    case 'ellipse-center': return {
      facts: [fact('타원 중심 x', g.ellipseCenterM.x / AU, 'AU'), fact('중심에서 초점까지 ae', g.linearEccentricityM / AU, 'AU'),
        fact('두 초점 사이', g.focusSeparationM / AU, 'AU'), fact('편심근점이각 E', radiansToDegrees(d.phase.eccentricAnomalyRad), '°'),
        fact('평균근점이각 M', radiansToDegrees(d.phase.meanAnomalyRad), '°')],
      note: 'E는 타원 중심의 반지름 a 보조 원에서 재는 각도입니다. M은 시간에 비례하는 기준각이며 실제 입자 방향이 아닙니다. 원에서는 중심·두 초점이 겹칩니다.',
    };
    case 'second-focus': return {
      facts: [fact('다른 초점 x', g.secondFocusM.x / AU, 'AU'), fact('두 초점 사이', g.focusSeparationM / AU, 'AU'),
        fact('입자에서 중력 초점까지', s.radiusM / AU, 'AU'),
        fact('입자에서 다른 초점까지', Math.hypot(s.positionM.x - g.secondFocusM.x, s.positionM.y) / AU, 'AU'),
        fact('두 초점까지 거리의 합', 2 * g.semiMajorAxisM / AU, 'AU')],
      note: '두 초점까지 거리의 합은 장축 2a입니다. 다른 초점은 기하학적 보조점이며 중력원이나 별이 없습니다.',
    };
    case 'semimajor-axis': return {
      facts: [fact('장반경 a', g.semiMajorAxisM / AU, 'AU'), fact('장축 2a', 2 * g.semiMajorAxisM / AU, 'AU'),
        fact('단반경 b', g.semiMinorAxisM / AU, 'AU'), fact('현재 중심 거리 r', s.radiusM / AU, 'AU'),
        fact('공전 주기', s.periodS / DAY, 'day'), fact('에너지 기준 −μ/(2a)', d.energy.referenceJPerKg / 1e6, 'MJ/kg')],
      note: 'a는 타원 중심에서 장축 끝까지의 고정 길이입니다. 초점에서 입자까지의 현재 거리 r와 구분합니다. 같은 a에서 이심률이 달라도 주기와 총에너지 기준은 같습니다.',
    };
    case 'radius-line': return {
      facts: [fact('현재 중심 거리 r', s.radiusM / AU, 'AU'), fact('거리 변화율 dr/dt', v.radialMps / 1000, 'km/s'),
        fact('진근점이각 ν', radiansToDegrees(d.phase.trueAnomalyRad), '°'),
        fact('실제 방향 각속도 dν/dt', radiansToDegrees(d.phase.trueRateRadPerS) * DAY, '°/day'),
        fact('방사 가속도', d.acceleration.radialMps2 * 1000, 'mm/s²')],
      note: '가속도는 항상 중력 초점을 향합니다. 방사 가속도 −μ/r²는 거리의 두 번째 미분 d²r/dt²와 다릅니다. 후자는 횡방향 운동의 vθ²/r 항도 포함합니다.',
    };
    case 'apsides': return {
      facts: [fact('최소 중심 거리', s.periapsisM / AU, 'AU'), fact('최대 중심 거리', s.apoapsisM / AU, 'AU'),
        fact('최소 거리에서 속력', s.periapsisSpeedMps / 1000, 'km/s'), fact('최대 거리에서 속력', s.apoapsisSpeedMps / 1000, 'km/s'),
        timeFact('근일점까지 남은 시간', d.apsides.timeToPeriapsisS), timeFact('원일점까지 남은 시간', d.apsides.timeToApoapsisS)],
      note: d.apsides.unique
        ? '현재 한 주기 안에서 해당 위치까지 전진하는 시간입니다. 바로 그 위치이면 0이며 누적 경과시간·다음 회전 시각이 아닙니다. 반올림으로 작은 이심률이나 근처 위치를 원·근일점으로 판정하지 않습니다.'
        : '정확히 e=0인 원은 모든 위치의 거리·속력이 같습니다. 유일한 근일점·원일점이 없으며 +X와 반대쪽은 기준 표식입니다.',
    };
    case 'velocity-vector': return {
      facts: [fact('전체 속력', v.speedMps / 1000, 'km/s'), fact('방사 속도', v.radialMps / 1000, 'km/s'),
        fact('횡방향 속도', v.transverseMps / 1000, 'km/s'), fact('비행 경로각', radiansToDegrees(v.flightPathAngleRad), '°'),
        fact('현재 거리의 원궤도 속력', v.circularMps / 1000, 'km/s'), fact('현재 거리의 탈출 속력', v.escapeMps / 1000, 'km/s')],
      note: '횡방향은 반지름에 수직이며, 전체 속도가 궤도 접선입니다. 비행 경로각은 횡방향에서 바깥쪽으로 기운 각도입니다. 속력 비교값의 차이는 필요한 기동 Δv를 뜻하지 않습니다.',
    };
    case 'equal-areas': return {
      facts: [fact('단위 질량당 각운동량', d.momentum.specificM2PerS * DAY / AU ** 2, 'AU²/day', 6),
        fact('면적속도 h/2', d.momentum.arealVelocityM2PerS * DAY / AU ** 2, 'AU²/day', 6),
        fact('각 표시 구간의 시간 T/12', s.periodS / (12 * DAY), 'day'),
        fact('각 곡선 부채꼴의 면적', s.orbitAreaM2 / (12 * AU ** 2), 'AU²', 6),
        fact('전체 타원 면적', s.orbitAreaM2 / AU ** 2, 'AU²')],
      note: '같은 궤도 안에서 같은 시간의 곡선 부채꼴 면적이 같습니다. 끝점을 직선으로 연결한 삼각형 면적이나 서로 다른 궤도 사이의 면적이 같다는 뜻은 아닙니다.',
    };
    default: throw new RangeError(`Unknown orbit component: ${partId}`);
  }
}
