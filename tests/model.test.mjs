import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as model from '../src/model.js';

const {
  MODEL_VERSION, ORBIT_CONSTANTS_SI, DEFAULT_CONFIG, CONFIG_LIMITS_SI,
  DEFAULT_MEAN_ANOMALY_RAD, MAX_ADVANCE_TIME_S, normalizeConfig, assertConfig,
  wrapMeanAnomalyRad, createExperiment, assertExperiment, solveEccentricAnomaly,
  getSnapshot, advanceExperiment, sampleOrbit, getSweptSector,
} = model;
const AU = 149597870700;
const MU = 1.32712440041279419e20;
const DAY = 86400;
const TAU = 2 * Math.PI;
const config = (e = 0.6, aAU = 1) => ({ semiMajorAxisM: aAU * AU, eccentricity: e });
const experiment = (M = 0, e = 0.6, aAU = 1) => ({ config: config(e, aAU), meanAnomalyRad: M });
const near = (actual, expected, abs = 1e-12) => {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= abs,
    `${actual} differs from ${expected} by more than ${abs}`);
};
const relative = (actual, expected, tolerance = 2e-13) => near(actual / expected, 1, tolerance);
const circularDistance = (a, b) => Math.min(Math.abs(a - b), TAU - Math.abs(a - b));
function bisect(M, e) {
  let low = 0;
  let high = TAU;
  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    if (mid - e * Math.sin(mid) < M) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
function polygonAreaAU2(samples) {
  let sum = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1].positionM;
    const b = samples[i].positionM;
    sum += (a.x / AU * b.y / AU - a.y / AU * b.x / AU) / 2;
  }
  return sum;
}

test('exact public exports, sourced SI constants and deeply immutable defaults', () => {
  assert.equal(MODEL_VERSION, 'orbit-kepler-1');
  assert.deepEqual(ORBIT_CONSTANTS_SI, { astronomicalUnitM: AU, dayS: DAY, solarMuM3PerS2: MU });
  assert.deepEqual(DEFAULT_CONFIG, { semiMajorAxisM: AU, eccentricity: 0.35 });
  assert.equal(DEFAULT_MEAN_ANOMALY_RAD, 0);
  assert.equal(MAX_ADVANCE_TIME_S, 3155760000);
  assert.deepEqual(Object.keys(model).sort(), [
    'MODEL_VERSION', 'ORBIT_CONSTANTS_SI', 'DEFAULT_CONFIG', 'CONFIG_LIMITS_SI',
    'DEFAULT_MEAN_ANOMALY_RAD', 'MAX_ADVANCE_TIME_S', 'normalizeConfig', 'assertConfig',
    'wrapMeanAnomalyRad', 'createExperiment', 'assertExperiment', 'solveEccentricAnomaly',
    'getSnapshot', 'advanceExperiment', 'sampleOrbit', 'getSweptSector',
  ].sort());
  for (const value of [ORBIT_CONSTANTS_SI, DEFAULT_CONFIG, CONFIG_LIMITS_SI, ...Object.values(CONFIG_LIMITS_SI)]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.throws(() => { CONFIG_LIMITS_SI.eccentricity.max = 0.99; }, TypeError);
});

test('live normalization is detached, finite, noncoercing and explicitly bounded', () => {
  for (const input of [undefined, null, false, 5, [], 'config']) assert.deepEqual(normalizeConfig(input), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({ semiMajorAxisM: '10', eccentricity: NaN }), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({ semiMajorAxisM: Infinity, eccentricity: undefined }), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({ semiMajorAxisM: 0, eccentricity: 2 }), config(0.8, 0.5));
  assert.deepEqual(normalizeConfig({ semiMajorAxisM: 100 * AU, eccentricity: -1 }), config(0, 2));
  assert.equal(Object.is(normalizeConfig({ eccentricity: -0 }).eccentricity, -0), false);
  const original = config();
  const normalized = normalizeConfig(original);
  normalized.eccentricity = 0;
  assert.equal(original.eccentricity, 0.6);
});

test('strict configs reject wrong shapes, unknown keys, coercion, negative zero and nonfinite values', () => {
  const valid = config();
  assert.equal(assertConfig(valid), valid);
  for (const value of [null, [], new Date(), {}, { semiMajorAxisM: AU }, { ...valid, extra: 1 },
    { ...valid, [Symbol('extra')]: 1 }, ...['0.6', NaN, Infinity, -Infinity, -0, -0.01, 0.8000001].map(eccentricity => ({ ...valid, eccentricity })),
    ...[0, AU * 0.499999, AU * 2.000001, '1', Infinity, -0].map(semiMajorAxisM => ({ ...valid, semiMajorAxisM }))]) {
    assert.throws(() => assertConfig(value), /config|eccentricity|semiMajorAxisM/);
  }
  assert.deepEqual(valid, config());
});

test('factory repairs live phase only while strict experiments preserve exact canonical inputs', () => {
  assert.deepEqual(createExperiment(), { config: { ...DEFAULT_CONFIG }, meanAnomalyRad: 0 });
  assert.equal(createExperiment(config(), { meanAnomalyRad: -Math.PI / 2 }).meanAnomalyRad, 3 * Math.PI / 2);
  assert.equal(createExperiment(config(), { meanAnomalyRad: TAU }).meanAnomalyRad, 0);
  for (const value of [NaN, Infinity, '1']) assert.equal(createExperiment(config(), { meanAnomalyRad: value }).meanAnomalyRad, 0);
  const original = experiment(1.23456789);
  assert.equal(assertExperiment(original), original);
  assert.deepEqual(JSON.parse(JSON.stringify(original)), original);
  for (const value of [null, [], {}, { ...original, timeS: 1 }, { meanAnomalyRad: 0 },
    ...[-0, -1, TAU, Infinity, NaN, '1'].map(meanAnomalyRad => ({ ...original, meanAnomalyRad }))]) {
    assert.throws(() => assertExperiment(value));
  }
});

test('phase wrapping is half-open, positive-zero and rejects nonfinite/coerced numbers', () => {
  for (const value of [-4 * Math.PI, -0, 0, TAU, 8 * Math.PI]) assert.ok(Object.is(wrapMeanAnomalyRad(value), 0));
  near(wrapMeanAnomalyRad(-0.25), TAU - 0.25);
  near(wrapMeanAnomalyRad(TAU + 0.25), 0.25);
  assert.equal(wrapMeanAnomalyRad(1e-20), 1e-20);
  for (const value of [null, undefined, NaN, Infinity, -Infinity, '1']) assert.throws(() => wrapMeanAnomalyRad(value), TypeError);
});

test('circular cardinal points have exact axes, positive orientation and independently known speed/period', () => {
  const expectedPositions = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const expectedDirections = [[0, 1], [-1, 0], [0, -1], [1, 0]];
  for (let i = 0; i < 4; i += 1) {
    const s = getSnapshot(experiment(i * Math.PI / 2, 0));
    assert.deepEqual(s.positionM, { x: expectedPositions[i][0] * AU, y: expectedPositions[i][1] * AU });
    near(s.velocityMps.x / 29784.691834309108, expectedDirections[i][0]);
    near(s.velocityMps.y / 29784.691834309108, expectedDirections[i][1]);
    assert.equal(s.radiusM, AU);
    assert.equal(s.eccentricAnomalyRad, i * Math.PI / 2);
    assert.equal(s.trueAnomalyRad, i * Math.PI / 2);
    near(s.periodS / DAY, 365.2568983272364, 2e-10);
    near(s.speedMps / 1000, 29.784691834309108);
    relative(s.periapsisSpeedMps, s.apoapsisSpeedMps);
  }
});

test('e=.6 apsides use the independent 0.4/1.6 AU and speed ratio four reference', () => {
  const peri = getSnapshot(experiment());
  const apo = getSnapshot(experiment(Math.PI));
  assert.equal(peri.positionM.x, 59839148280);
  assert.equal(apo.positionM.x, -239356593120);
  assert.equal(peri.positionM.y, 0);
  assert.equal(apo.positionM.y, 0);
  near(peri.speedMps / 1000, 59.569383668618215);
  near(apo.speedMps / 1000, 14.892345917154554);
  relative(peri.speedMps / apo.speedMps, 4);
  near(apo.timeSinceReferenceS / apo.periodS, 0.5);
  relative(peri.specificEnergyJPerKg, -MU / (2 * AU));
});

test('known eccentric anomaly pi/2 distinguishes mean anomaly from geometric angle', () => {
  const s = getSnapshot(experiment(Math.PI / 2 - 0.6));
  near(s.eccentricAnomalyRad, Math.PI / 2, 2e-15);
  near(s.positionM.x / AU, -0.6);
  near(s.positionM.y / AU, 0.8);
  near(s.velocityMps.x / 1000, -29.7846918343091);
  near(s.velocityMps.y / 1000, 0, 2e-12);
  near(s.timeSinceReferenceS / DAY, 56.434760061493, 2e-10);
  near(s.trueAnomalyRad, Math.atan2(0.8, -0.6));
  assert.ok(s.trueAnomalyRad > s.eccentricAnomalyRad && s.eccentricAnomalyRad > s.meanAnomalyRad);
});

test('non-cardinal M=pi/2 agrees with an independently bisected reference', () => {
  const s = getSnapshot(experiment(Math.PI / 2));
  near(s.eccentricAnomalyRad, 2.091328966032915, 2e-14);
  near(s.positionM.x / AU, -1.0973423018849031);
  near(s.positionM.y / AU, 0.6940435189840249);
  near(s.speedMps / 1000, 21.894300898075972, 2e-12);
});

test('bounded solver agrees with bisection over endpoints, tiny phases and high-eccentricity grid', () => {
  for (const e of [0, 1e-12, 0.1, 0.35, 0.6, 0.799999999, 0.8]) {
    const phases = [0, 1e-20, 1e-12, Math.PI, TAU - 1e-12, TAU - Number.EPSILON * 4];
    for (let i = 1; i < 257; i += 1) phases.push(TAU * i / 257);
    for (const M of phases) {
      const E = solveEccentricAnomaly(M, e);
      assert.ok(E >= 0 && E < TAU);
      near(E - e * Math.sin(E), M, 2e-14);
      near(E, bisect(M, e), 2e-13);
    }
  }
  relative(solveEccentricAnomaly(1e-20, 0.8), 5e-20, 2e-14);
  for (const [M, e] of [[-0, 0.5], [TAU, 0], [NaN, 0], [0, -0], [0, 0.81], ['1', 0]]) {
    assert.throws(() => solveEccentricAnomaly(M, e));
  }
});

test('period depends on a cubed but not e, including both domain boundaries', () => {
  const small = getSnapshot(experiment(1, 0.8, 0.5));
  const large = getSnapshot(experiment(1, 0.8, 2));
  near(small.periodS / DAY, 129.1378148411771, 2e-10);
  near(large.periodS / DAY, 1033.1025187294167, 2e-10);
  relative(large.periodS / small.periodS, 8);
  for (const aAU of [0.5, 1, 2]) {
    const circular = getSnapshot(experiment(0, 0, aAU));
    for (const e of [0.35, 0.6, 0.8]) {
      const s = getSnapshot(experiment(2.345, e, aAU));
      assert.equal(s.periodS, circular.periodS);
      relative(s.periapsisM + s.apoapsisM, 2 * aAU * AU);
    }
  }
});

test('returned vectors independently conserve energy and angular momentum and satisfy vis-viva', () => {
  for (const aAU of [0.5, 1, 2]) for (const e of [0, 0.35, 0.8]) for (let i = 0; i < 61; i += 1) {
    const s = getSnapshot(experiment(TAU * i / 61, e, aAU));
    const { x, y } = s.positionM;
    const { x: vx, y: vy } = s.velocityMps;
    const radius = Math.hypot(x, y);
    const speed2 = vx * vx + vy * vy;
    relative(radius, s.radiusM);
    relative(speed2, MU * (2 / radius - 1 / (aAU * AU)));
    relative(speed2 / 2 - MU / radius, -MU / (2 * aAU * AU));
    relative(x * vy - y * vx, Math.sqrt(MU * aAU * AU * (1 - e * e)));
    relative(s.arealVelocityM2PerS, (x * vy - y * vx) / 2);
  }
});

test('central differences of position and velocity agree with velocity and inverse-square acceleration', () => {
  for (const M of [0, 0.31, 1.47, Math.PI, 5.91]) {
    const s = getSnapshot(experiment(M, 0.8));
    const dt = 5;
    const before = getSnapshot(experiment(wrapMeanAnomalyRad(M - dt * s.meanMotionRadPerS), 0.8));
    const after = getSnapshot(experiment(wrapMeanAnomalyRad(M + dt * s.meanMotionRadPerS), 0.8));
    for (const axis of ['x', 'y']) {
      near((after.positionM[axis] - before.positionM[axis]) / (2 * dt) - s.velocityMps[axis], 0, 0.00008);
      const acceleration = -MU * s.positionM[axis] / s.radiusM ** 3;
      near((after.velocityMps[axis] - before.velocityMps[axis]) / (2 * dt), acceleration, 2e-10);
    }
  }
});

test('advance reduces whole periods, crosses reference cleanly and rejects invalid times', () => {
  const original = experiment(TAU - 0.01);
  const s = getSnapshot(original);
  assert.deepEqual(advanceExperiment(original, 0), original);
  assert.deepEqual(advanceExperiment(original, s.periodS), original);
  const advanced = advanceExperiment(original, 0.02 / s.meanMotionRadPerS);
  near(advanced.meanAnomalyRad, 0.01);
  const long = advanceExperiment(original, MAX_ADVANCE_TIME_S);
  assertExperiment(long);
  const reduced = advanceExperiment(original, MAX_ADVANCE_TIME_S % s.periodS);
  assert.deepEqual(long, reduced);
  for (const delta of [-0, -1, Infinity, NaN, '1', MAX_ADVANCE_TIME_S + 1]) assert.throws(() => advanceExperiment(original, delta));
  assert.deepEqual(original, experiment(TAU - 0.01));
});

test('30/60/144/240 Hz and irregular frames retain the same total model time and state phase', () => {
  const initial = experiment(6.1, 0.8, 0.5);
  const durationS = 7 * 15 * DAY;
  const target = advanceExperiment(initial, durationS);
  for (const hz of [30, 60, 144, 240]) {
    let current = initial;
    for (let i = 0; i < hz * 7; i += 1) current = advanceExperiment(current, durationS / (hz * 7));
    near(circularDistance(current.meanAnomalyRad, target.meanAnomalyRad), 0, 2e-11);
  }
  let current = initial;
  let remaining = durationS;
  for (const fraction of [0.001, 0.09, 0.25, 0.4, 0.003]) {
    const dt = durationS * fraction;
    current = advanceExperiment(current, dt);
    remaining -= dt;
  }
  current = advanceExperiment(current, remaining);
  near(circularDistance(current.meanAnomalyRad, target.meanAnomalyRad), 0, 2e-13);
  assert.deepEqual(initial, experiment(6.1, 0.8, 0.5));
});

test('orbit samples have exact fields, uniform time, canonical phase and detached exact closure', () => {
  const samples = sampleOrbit(config());
  assert.equal(samples.length, 257);
  const T = getSnapshot(experiment()).periodS;
  for (const [i, point] of samples.entries()) {
    assert.deepEqual(Object.keys(point), ['progress', 'offsetTimeS', 'meanAnomalyRad', 'positionM', 'velocityMps', 'radiusM', 'speedMps']);
    assert.equal(point.progress, i / 256);
    assert.equal(point.offsetTimeS, i / 256 * T);
    assert.equal(point.meanAnomalyRad, i === 256 ? 0 : TAU * i / 256);
    const reference = getSnapshot(experiment(point.meanAnomalyRad));
    assert.deepEqual(point.positionM, reference.positionM);
    assert.deepEqual(point.velocityMps, reference.velocityMps);
  }
  assert.deepEqual(samples.at(-1).positionM, samples[0].positionM);
  assert.deepEqual(samples.at(-1).velocityMps, samples[0].velocityMps);
  assert.notEqual(samples.at(-1).positionM, samples[0].positionM);
  assert.notEqual(samples.at(-1).velocityMps, samples[0].velocityMps);
  samples[0].positionM.x = 0;
  assert.notEqual(samples.at(-1).positionM.x, 0);
  for (const sampleCount of [15, 2049, 32.5, -0, '32', NaN]) assert.throws(() => sampleOrbit(config(), { sampleCount }));
  for (const options of [null, [], { extra: true }, { sampleCount: undefined }]) assert.throws(() => sampleOrbit(config(), options));
});

test('swept sectors cross phase wrap, support zero duration and close one full period exactly', () => {
  const T = getSnapshot(experiment()).periodS;
  const start = 11 * Math.PI / 6;
  const sector = getSweptSector(config(), start, T / 6, { sampleCount: 32 });
  assert.deepEqual(Object.keys(sector), ['startMeanAnomalyRad', 'durationS', 'areaM2', 'samples']);
  assert.equal(sector.samples.length, 33);
  near(sector.samples.at(-1).meanAnomalyRad, Math.PI / 6);
  assert.equal(sector.samples.at(-1).offsetTimeS, T / 6);
  for (const point of sector.samples) {
    assert.deepEqual(Object.keys(point), ['offsetTimeS', 'meanAnomalyRad', 'positionM']);
    assert.deepEqual(point.positionM, getSnapshot(experiment(point.meanAnomalyRad)).positionM);
  }
  const zero = getSweptSector(config(), start, 0, { sampleCount: 16 });
  assert.equal(zero.areaM2, 0);
  for (const point of zero.samples) assert.deepEqual(point, zero.samples[0]);
  assert.notEqual(zero.samples[0].positionM, zero.samples[1].positionM);
  const full = getSweptSector(config(), start, T);
  assert.equal(full.areaM2, getSnapshot(experiment()).orbitAreaM2);
  assert.equal(full.samples.at(-1).meanAnomalyRad, start);
  assert.deepEqual(full.samples.at(-1).positionM, full.samples[0].positionM);
  assert.notEqual(full.samples.at(-1).positionM, full.samples[0].positionM);
  for (const duration of [-0, -1, T + 1, Infinity, NaN, '1']) assert.throws(() => getSweptSector(config(), start, duration));
  assert.throws(() => getSweptSector(config(), TAU, T / 12));
});

test('equal-time curved polygon areas independently converge, while single endpoint triangles differ', () => {
  const T = getSnapshot(experiment()).periodS;
  const expected = 0.20943951023931953;
  const errors = [];
  for (const count of [64, 256, 1024, 2048]) {
    const first = getSweptSector(config(), 0, T / 12, { sampleCount: count });
    const second = getSweptSector(config(), Math.PI, T / 12, { sampleCount: count });
    near(first.areaM2 / AU ** 2, expected);
    near(second.areaM2 / AU ** 2, expected);
    const area1 = polygonAreaAU2(first.samples);
    const area2 = polygonAreaAU2(second.samples);
    assert.ok(area1 < expected && area2 < expected);
    errors.push(expected - area1);
    if (count === 2048) {
      near(area1, expected, 2e-8);
      near(area2, expected, 1e-9);
      const triangle1 = polygonAreaAU2([first.samples[0], first.samples.at(-1)]);
      const triangle2 = polygonAreaAU2([second.samples[0], second.samples.at(-1)]);
      near(triangle1, 0.1381055883373174);
      near(triangle2, 0.20706808990121317);
      assert.ok(Math.abs(triangle1 - triangle2) > 0.06);
    }
  }
  for (let i = 1; i < errors.length; i += 1) assert.ok(errors[i] < errors[i - 1] / 3.9);
});

test('snapshots have only the contracted fields and all outputs are detached from saved inputs', () => {
  const original = experiment(2.123);
  const backup = structuredClone(original);
  const snapshot = getSnapshot(original);
  assert.deepEqual(Object.keys(snapshot), [
    'config', 'meanAnomalyRad', 'eccentricAnomalyRad', 'trueAnomalyRad', 'positionM', 'velocityMps',
    'radiusM', 'speedMps', 'semiMinorAxisM', 'periodS', 'meanMotionRadPerS', 'timeSinceReferenceS',
    'periapsisM', 'apoapsisM', 'periapsisSpeedMps', 'apoapsisSpeedMps', 'specificEnergyJPerKg',
    'specificAngularMomentumM2PerS', 'arealVelocityM2PerS', 'orbitAreaM2',
  ]);
  snapshot.config.eccentricity = 0;
  snapshot.positionM.x = 0;
  const next = advanceExperiment(original, 0);
  next.config.semiMajorAxisM = AU * 2;
  const factory = createExperiment(original.config, { meanAnomalyRad: original.meanAnomalyRad });
  factory.config.eccentricity = 0.1;
  assert.deepEqual(original, backup);
  assert.deepEqual(getSnapshot(JSON.parse(JSON.stringify(original))), getSnapshot(backup));
  assert.throws(() => getSnapshot({ ...original, elapsedS: 100 }));
});

test('CPU timing records snapshot and 257-point sweep costs without a machine-specific pass threshold', (t) => {
  const values = [experiment(0.01, 0.8), experiment(2.345, 0.35), experiment(6.1, 0, 2)];
  for (let i = 0; i < 300; i += 1) getSnapshot(values[i % values.length]);
  let checksum = 0;
  let start = performance.now();
  for (let i = 0; i < 3000; i += 1) checksum += getSnapshot(values[i % values.length]).speedMps;
  const snapshotUs = (performance.now() - start) * 1000 / 3000;
  start = performance.now();
  for (let i = 0; i < 100; i += 1) checksum += sampleOrbit(config(0.8))[127].speedMps;
  const sweepMs = (performance.now() - start) / 100;
  assert.ok(Number.isFinite(checksum) && checksum > 0);
  t.diagnostic(JSON.stringify({ snapshotMeanMicroseconds: snapshotUs, orbit257MeanMilliseconds: sweepMs }));
});
