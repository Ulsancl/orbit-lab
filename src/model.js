const TAU = 2 * Math.PI;

export const MODEL_VERSION = 'orbit-kepler-1';
export const ORBIT_CONSTANTS_SI = Object.freeze({
  astronomicalUnitM: 149597870700,
  dayS: 86400,
  solarMuM3PerS2: 1.32712440041279419e20,
});
const { astronomicalUnitM: AU, dayS: DAY, solarMuM3PerS2: MU } = ORBIT_CONSTANTS_SI;

export const DEFAULT_CONFIG = Object.freeze({ semiMajorAxisM: AU, eccentricity: 0.35 });
export const CONFIG_LIMITS_SI = Object.freeze({
  semiMajorAxisM: Object.freeze({ min: 0.5 * AU, max: 2 * AU }),
  eccentricity: Object.freeze({ min: 0, max: 0.8 }),
});
export const DEFAULT_MEAN_ANOMALY_RAD = 0;
export const MAX_ADVANCE_TIME_S = 36525 * DAY;

function record(value, keys, name, optional = false) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => !keys.includes(key))
      || (!optional && (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))))) {
    throw new TypeError(`${name} has unexpected or missing fields`);
  }
}

function bounded(value, min, max, name, exclusiveMax = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new TypeError(`${name} must be a finite number without negative zero`);
  }
  if (value < min || (exclusiveMax ? value >= max : value > max)) {
    throw new RangeError(`${name} is outside its supported range`);
  }
  return value;
}

function phase(value) {
  return bounded(value, 0, TAU, 'meanAnomalyRad', true);
}

function cloneConfig(config) {
  return { semiMajorAxisM: config.semiMajorAxisM, eccentricity: config.eccentricity };
}

export function normalizeConfig(value) {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [key, { min, max }] of Object.entries(CONFIG_LIMITS_SI)) {
    const supplied = input[key];
    const number = typeof supplied === 'number' && Number.isFinite(supplied) ? supplied : DEFAULT_CONFIG[key];
    result[key] = Math.max(min, Math.min(max, number)) || 0;
  }
  return result;
}

export function assertConfig(value) {
  record(value, ['semiMajorAxisM', 'eccentricity'], 'config');
  for (const [key, { min, max }] of Object.entries(CONFIG_LIMITS_SI)) bounded(value[key], min, max, key);
  return value;
}

export function wrapMeanAnomalyRad(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('angle must be a finite number');
  let wrapped = value % TAU;
  if (wrapped < 0) wrapped += TAU;
  return wrapped === 0 || wrapped === TAU ? 0 : wrapped;
}

export function createExperiment(config = DEFAULT_CONFIG, options = {}) {
  const supplied = options !== null && typeof options === 'object' ? options.meanAnomalyRad : undefined;
  return {
    config: normalizeConfig(config),
    meanAnomalyRad: typeof supplied === 'number' && Number.isFinite(supplied)
      ? wrapMeanAnomalyRad(supplied) : DEFAULT_MEAN_ANOMALY_RAD,
  };
}

export function assertExperiment(value) {
  record(value, ['config', 'meanAnomalyRad'], 'experiment');
  assertConfig(value.config);
  phase(value.meanAnomalyRad);
  return value;
}

function solve(M, e) {
  if (e === 0 || M === 0 || M === Math.PI) return M;
  const reflected = M > Math.PI;
  const m = reflected ? TAU - M : M;
  let lo = 0;
  let hi = Math.PI;
  let E = m + e * Math.sin(m);
  let converged = false;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const residual = E - e * Math.sin(E) - m;
    if (residual === 0) { converged = true; break; }
    if (residual > 0) hi = E;
    else lo = E;
    const correction = residual / (1 - e * Math.cos(E));
    if (Math.abs(correction) <= 4 * Number.EPSILON * Math.max(Math.abs(E), Number.MIN_VALUE)) {
      converged = true;
      break;
    }
    const candidate = E - correction;
    // Restrict Newton to the live root bracket; the final iterations always bisect.
    const next = iteration < 12 && Number.isFinite(candidate) && candidate > lo && candidate < hi
      ? candidate : lo + (hi - lo) / 2;
    if (next === E || hi - lo <= 4 * Number.EPSILON * Math.max(Math.abs(E), Number.MIN_VALUE)) {
      converged = true;
      break;
    }
    E = next;
  }
  if (!converged || !Number.isFinite(E) || Math.abs(E - e * Math.sin(E) - m) > 2e-14) {
    throw new RangeError('Kepler solution did not converge in the supported domain');
  }
  return reflected ? wrapMeanAnomalyRad(TAU - E) : E;
}

export function solveEccentricAnomaly(meanAnomalyRad, eccentricity) {
  phase(meanAnomalyRad);
  bounded(eccentricity, 0, 0.8, 'eccentricity');
  return solve(meanAnomalyRad, eccentricity);
}

function orbit(config) {
  const a = config.semiMajorAxisM;
  const e = config.eccentricity;
  const b = a * Math.sqrt(1 - e * e);
  const n = Math.sqrt(MU / (a * a * a));
  const h = Math.sqrt(MU * a * (1 - e * e));
  return { a, e, b, n, T: TAU / n, h, area: Math.PI * a * b };
}

function sinCos(E) {
  if (E === 0) return [0, 1];
  if (E === Math.PI / 2) return [1, 0];
  if (E === Math.PI) return [0, -1];
  if (E === 3 * Math.PI / 2) return [-1, 0];
  return [Math.sin(E), Math.cos(E)];
}

function at(o, M) {
  const E = solve(M, o.e);
  const [sin, cos] = sinCos(E);
  const q = 1 - o.e * cos;
  const positionM = { x: o.a * (cos - o.e) || 0, y: o.b * sin || 0 };
  const velocityMps = { x: -o.a * sin * o.n / q || 0, y: o.b * cos * o.n / q || 0 };
  return { E, positionM, velocityMps, radiusM: o.a * q, speedMps: Math.hypot(velocityMps.x, velocityMps.y) };
}

export function getSnapshot(experiment) {
  assertExperiment(experiment);
  const { config, meanAnomalyRad: M } = experiment;
  const o = orbit(config);
  const point = at(o, M);
  return {
    config: cloneConfig(config),
    meanAnomalyRad: M,
    eccentricAnomalyRad: point.E,
    trueAnomalyRad: wrapMeanAnomalyRad(Math.atan2(point.positionM.y, point.positionM.x)),
    positionM: point.positionM,
    velocityMps: point.velocityMps,
    radiusM: point.radiusM,
    speedMps: point.speedMps,
    semiMinorAxisM: o.b,
    periodS: o.T,
    meanMotionRadPerS: o.n,
    timeSinceReferenceS: M / o.n,
    periapsisM: o.a * (1 - o.e),
    apoapsisM: o.a * (1 + o.e),
    periapsisSpeedMps: Math.sqrt(MU / o.a * (1 + o.e) / (1 - o.e)),
    apoapsisSpeedMps: Math.sqrt(MU / o.a * (1 - o.e) / (1 + o.e)),
    specificEnergyJPerKg: -MU / (2 * o.a),
    specificAngularMomentumM2PerS: o.h,
    arealVelocityM2PerS: o.h / 2,
    orbitAreaM2: o.area,
  };
}

export function advanceExperiment(experiment, deltaTimeS) {
  assertExperiment(experiment);
  bounded(deltaTimeS, 0, MAX_ADVANCE_TIME_S, 'deltaTimeS');
  const o = orbit(experiment.config);
  const delta = deltaTimeS % o.T;
  return {
    config: cloneConfig(experiment.config),
    meanAnomalyRad: delta === 0 ? experiment.meanAnomalyRad
      : wrapMeanAnomalyRad(experiment.meanAnomalyRad + o.n * delta),
  };
}

function count(options) {
  record(options, ['sampleCount'], 'sample options', true);
  const n = Object.hasOwn(options, 'sampleCount') ? options.sampleCount : 256;
  bounded(n, 16, 2048, 'sampleCount');
  if (!Number.isInteger(n)) throw new TypeError('sampleCount must be an integer');
  return n;
}

export function sampleOrbit(config, options = {}) {
  assertConfig(config);
  const N = count(options);
  const o = orbit(config);
  const samples = [];
  for (let i = 0; i <= N; i += 1) {
    const progress = i / N;
    const M = i === N ? 0 : TAU * progress;
    const point = i === N ? samples[0] : at(o, M);
    samples.push({
      progress, offsetTimeS: progress * o.T, meanAnomalyRad: M,
      positionM: { ...point.positionM }, velocityMps: { ...point.velocityMps },
      radiusM: point.radiusM, speedMps: point.speedMps,
    });
  }
  return samples;
}

export function getSweptSector(config, startMeanAnomalyRad, durationS, options = {}) {
  assertConfig(config);
  phase(startMeanAnomalyRad);
  const N = count(options);
  const o = orbit(config);
  bounded(durationS, 0, o.T, 'durationS');
  const first = at(o, startMeanAnomalyRad).positionM;
  const samples = [];
  for (let i = 0; i <= N; i += 1) {
    const offsetTimeS = i === N ? durationS : durationS * (i / N);
    const closed = durationS === 0 || i === 0 || (i === N && durationS === o.T);
    const M = closed ? startMeanAnomalyRad : wrapMeanAnomalyRad(startMeanAnomalyRad + o.n * offsetTimeS);
    const positionM = closed ? first : at(o, M).positionM;
    samples.push({ offsetTimeS, meanAnomalyRad: M, positionM: { ...positionM } });
  }
  return {
    startMeanAnomalyRad, durationS,
    areaM2: durationS === o.T ? o.area : o.h / 2 * durationS,
    samples,
  };
}
