import test from 'node:test';
import assert from 'node:assert/strict';
import { getSnapshot, advanceExperiment, ORBIT_CONSTANTS_SI as C } from '../src/model.js';
import { orbitDetail, describeOrbitDetail } from '../src/detail-model.js';
import { COMPONENTS } from '../src/geometry.js';
import { createProject, serializeProject, parseProject } from '../src/project.js';

const AU = C.astronomicalUnitM, MU = C.solarMuM3PerS2, DAY = C.dayS, TAU = 2 * Math.PI;
const experiment = (M = 0, e = .6, a = 1) => ({ config: { semiMajorAxisM: a * AU, eccentricity: e }, meanAnomalyRad: M });
const snapshot = (M = 0, e = .6, a = 1) => getSnapshot(experiment(M, e, a));
const close = (actual, expected, relative = 3e-13, absolute = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= absolute + relative * Math.abs(expected), `${actual} != ${expected}`);
const circularDifference = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function visitNumbers(value, fn) {
  if (typeof value === 'number') fn(value);
  else if (value && typeof value === 'object') Object.values(value).forEach(item => visitNumbers(item, fn));
}

test('closed-form circle and e=.6 auxiliary-circle quadrature give signed components and energy', () => {
  const circle = orbitDetail(snapshot(.732, 0));
  const v0 = 29784.691834309108;
  close(circle.velocity.speedMps, v0);
  assert.equal(circle.velocity.radialMps, 0);
  assert.equal(circle.velocity.flightPathAngleRad, 0);
  close(circle.velocity.transverseMps, v0);
  close(circle.acceleration.magnitudeMps2, v0 * v0 / AU);
  close(circle.energy.kineticJPerKg, v0 * v0 / 2);
  close(circle.energy.potentialJPerKg, -v0 * v0);
  close(circle.energy.totalJPerKg, -v0 * v0 / 2);
  // E=pi/2: position=(-.6,.8) AU, velocity=(-v0,0), r=1 AU.
  const d = orbitDetail(snapshot(Math.PI / 2 - .6));
  close(d.velocity.radialMps, .6 * v0);
  close(d.velocity.transverseMps, .8 * v0);
  close(d.velocity.flightPathAngleRad, Math.atan(3 / 4));
  close(d.velocity.radialVectorMps.x, -.36 * v0);
  close(d.velocity.radialVectorMps.y, .48 * v0);
  close(d.velocity.transverseVectorMps.x, -.64 * v0);
  close(d.velocity.transverseVectorMps.y, -.48 * v0);
  close(d.acceleration.vectorMps2.x, .6 * v0 * v0 / AU);
  close(d.acceleration.vectorMps2.y, -.8 * v0 * v0 / AU);
});

test('apsis closed forms, speed comparisons and their angular-rate ratio hold at range extremes', () => {
  for (const a of [.5, 1, 2]) for (const e of [.01, .35, .8]) {
    const p = orbitDetail(snapshot(0, e, a)), q = orbitDetail(snapshot(Math.PI, e, a));
    const circular = Math.sqrt(MU / (a * AU));
    close(p.velocity.speedMps, circular * Math.sqrt((1 + e) / (1 - e)));
    close(q.velocity.speedMps, circular * Math.sqrt((1 - e) / (1 + e)));
    assert.equal(p.velocity.radialMps, 0); assert.equal(q.velocity.radialMps, 0);
    assert.ok(p.velocity.speedMps > p.velocity.circularMps);
    assert.ok(q.velocity.speedMps < q.velocity.circularMps);
    for (const d of [p, q]) {
      close(d.velocity.escapeMps / d.velocity.circularMps, Math.SQRT2);
      assert.ok(d.velocity.speedMps < d.velocity.escapeMps);
    }
    close(p.phase.trueRateRadPerS / q.phase.trueRateRadPerS, ((1 + e) / (1 - e)) ** 2);
  }
});

test('Cartesian vectors reconstruct signed velocity, perpendicular components and inward acceleration', () => {
  for (const a of [.5, 1, 2]) for (const e of [0, .05, .35, .8]) for (let j = 0; j < 47; j++) {
    const s = snapshot(TAU * j / 47, e, a), d = orbitDetail(s);
    const { x, y } = s.positionM, { x: vx, y: vy } = s.velocityMps;
    const vr = d.velocity.radialVectorMps, vt = d.velocity.transverseVectorMps, g = d.acceleration.vectorMps2;
    close(vr.x + vt.x, vx, 3e-13, 2e-10); close(vr.y + vt.y, vy, 3e-13, 2e-10);
    close(d.velocity.radialMps, (x * vx + y * vy) / Math.hypot(x, y), 3e-12, 3e-11);
    close(Math.hypot(d.velocity.radialMps, d.velocity.transverseMps), s.speedMps);
    close((vr.x * vt.x + vr.y * vt.y) / s.speedMps ** 2, 0);
    close((x * vt.x + y * vt.y) / (s.radiusM * s.speedMps), 0);
    assert.ok(x * g.x + y * g.y < 0);
    close((x * g.y - y * g.x) / (s.radiusM * d.acceleration.magnitudeMps2), 0);
  }
});

test('tiny nonzero eccentricity and phases remain elliptical without numerical node snapping', () => {
  for (const e of [1e-16, 1e-12, 1e-8]) {
    const d = orbitDetail(snapshot(Math.PI / 2 - e, e));
    assert.equal(d.apsides.unique, true);
    assert.ok(d.velocity.radialMps > 0);
    close(d.velocity.radialMps / e, Math.sqrt(MU / AU), 3e-13);
    assert.ok(d.velocity.flightPathAngleRad > 0);
    assert.equal(d.apsides.atPeriapsis, false);
  }
  for (const M of [1e-12, Math.PI - 1e-12, Math.PI + 1e-12, TAU - 1e-12]) {
    const d = orbitDetail(snapshot(M));
    assert.equal(d.apsides.atPeriapsis, false); assert.equal(d.apsides.atApoapsis, false);
    assert.notEqual(d.velocity.radialMps, 0);
    assert.equal(Math.sign(d.velocity.radialMps), M < Math.PI ? 1 : -1);
  }
});

test('outbound/inbound symmetry preserves energies while flipping flight-path and radial signs', () => {
  for (const M of [.01, .7, 1.9, 3.1]) {
    const p = orbitDetail(snapshot(M, .8)), q = orbitDetail(snapshot(TAU - M, .8));
    close(p.velocity.radialMps, -q.velocity.radialMps, 1e-12);
    close(p.velocity.transverseMps, q.velocity.transverseMps);
    close(p.velocity.flightPathAngleRad, -q.velocity.flightPathAngleRad, 1e-12);
    close(p.energy.kineticJPerKg, q.energy.kineticJPerKg);
    close(p.acceleration.vectorMps2.x, q.acceleration.vectorMps2.x);
    close(p.acceleration.vectorMps2.y, -q.acceleration.vectorMps2.y, 1e-12);
  }
});

test('independent time differences recover distance/phase rates, Cartesian acceleration and kinetic-power exchange', () => {
  for (const e of [0, .35, .8]) for (const M of [.21, 1.7, 3.8, 6.1]) {
    const s = snapshot(M, e), d = orbitDetail(s);
    const dt = s.periodS * 1e-6, dM = s.meanMotionRadPerS * dt;
    const before = snapshot(M - dM, e), after = snapshot(M + dM, e);
    close((after.radiusM - before.radiusM) / (2 * dt), d.velocity.radialMps, 1e-7, 1e-6);
    close(circularDifference(after.eccentricAnomalyRad, before.eccentricAnomalyRad) / (2 * dt), d.phase.eccentricRateRadPerS, 2e-8, 1e-16);
    close(circularDifference(after.trueAnomalyRad, before.trueAnomalyRad) / (2 * dt), d.phase.trueRateRadPerS, 2e-8, 1e-16);
    for (const axis of ['x', 'y']) close((after.velocityMps[axis] - before.velocityMps[axis]) / (2 * dt), d.acceleration.vectorMps2[axis], 2e-8, 1e-11);
    const specificPower = s.velocityMps.x * d.acceleration.vectorMps2.x + s.velocityMps.y * d.acceleration.vectorMps2.y;
    close((after.speedMps ** 2 - before.speedMps ** 2) / (4 * dt), specificPower, 3e-8, 1e-8);
    close((-MU / after.radiusM + MU / before.radiusM) / (2 * dt), -specificPower, 3e-8, 1e-8);
  }
});

test('radial acceleration is not second derivative of radius; the centrifugal coordinate term is required', () => {
  for (const M of [.3, 1.7, 3.7, 5.2]) {
    const s = snapshot(M, .7), d = orbitDetail(s), dt = s.periodS * 1e-6, dM = s.meanMotionRadPerS * dt;
    const before = orbitDetail(snapshot(M - dM, .7)), after = orbitDetail(snapshot(M + dM, .7));
    const radialSecondDerivative = (after.velocity.radialMps - before.velocity.radialMps) / (2 * dt);
    const expected = d.acceleration.radialMps2 + d.velocity.transverseMps ** 2 / s.radiusM;
    close(radialSecondDerivative, expected, 4e-8, 1e-11);
    assert.ok(Math.abs(radialSecondDerivative - d.acceleration.radialMps2) > 1e-4);
  }
});

test('time quadrature recovers virial averages and one full true-angle revolution independently', () => {
  for (const e of [0, .35, .8]) {
    const N = 2048, sums = { kinetic: 0, potential: 0, angle: 0 };
    for (let i = 0; i <= N; i++) {
      const d = orbitDetail(snapshot(i === N ? 0 : TAU * i / N, e));
      const weight = i === 0 || i === N ? 1 : i % 2 ? 4 : 2;
      sums.kinetic += weight * d.energy.kineticJPerKg;
      sums.potential += weight * d.energy.potentialJPerKg;
      sums.angle += weight * d.phase.trueRateRadPerS;
    }
    close(sums.kinetic / (3 * N), MU / (2 * AU), 2e-12);
    close(sums.potential / (3 * N), -MU / AU, 2e-12);
    close(sums.angle / (3 * N) * snapshot(0, e).periodS, TAU, 2e-12);
  }
});

test('vector angular momentum, eccentricity vector and signed energy residuals conserve across the full domain', () => {
  for (const a of [.5, 2]) for (const e of [0, 1e-12, .35, .8]) for (let j = 0; j < 91; j++) {
    const s = snapshot(TAU * j / 91, e, a), d = orbitDetail(s);
    const { x, y } = s.positionM, { x: vx, y: vy } = s.velocityMps;
    const dot = x * vx + y * vy, speed2 = vx * vx + vy * vy;
    const ex = ((speed2 - MU / s.radiusM) * x - dot * vx) / MU;
    const ey = ((speed2 - MU / s.radiusM) * y - dot * vy) / MU;
    close(ex, e, 3e-13, 3e-15); close(ey, 0, 0, 3e-15);
    assert.equal(d.momentum.specificM2PerS, x * vy - y * vx);
    assert.equal(d.energy.residualJPerKg, d.energy.totalJPerKg - s.specificEnergyJPerKg);
    assert.equal(d.momentum.residualM2PerS, d.momentum.specificM2PerS - s.specificAngularMomentumM2PerS);
    assert.ok(Math.abs(d.energy.relativeResidual) < 1e-14);
    assert.ok(Math.abs(d.momentum.relativeResidual) < 2e-15);
    assert.ok(d.energy.totalJPerKg < 0);
  }
});

test('apsis countdowns advance to their target, are zero at the target, and do not invent circular apsides', () => {
  for (const M of [0, .01, 1, Math.PI, 4, TAU - 1e-10]) {
    const exp = experiment(M, .8), d = orbitDetail(getSnapshot(exp));
    for (const [key, target] of [['timeToPeriapsisS', 0], ['timeToApoapsisS', Math.PI]]) {
      const dt = d.apsides[key];
      assert.ok(dt >= 0 && dt <= d.phase.periodS);
      close(circularDifference(advanceExperiment(exp, dt).meanAnomalyRad, target), 0, 0, 3e-15);
    }
    assert.equal(d.apsides.atPeriapsis, M === 0); assert.equal(d.apsides.atApoapsis, M === Math.PI);
    const c = orbitDetail(snapshot(M, 0));
    assert.equal(c.apsides.unique, false); assert.equal(c.apsides.timeToPeriapsisS, null);
    assert.equal(c.apsides.timeToApoapsisS, null); assert.equal(c.apsides.atPeriapsis, false); assert.equal(c.apsides.atApoapsis, false);
  }
  assert.equal(orbitDetail(snapshot()).apsides.timeToPeriapsisS, 0);
  assert.equal(orbitDetail(snapshot(Math.PI)).apsides.timeToApoapsisS, 0);
});

test('periodic seam keeps vectors and invariants continuous while cycle time and countdown have deliberate wrap', () => {
  const eps = 1e-9, before = orbitDetail(snapshot(TAU - eps, .8)), at = orbitDetail(snapshot(0, .8)), after = orbitDetail(snapshot(eps, .8));
  assert.ok(before.phase.cycleElapsedS > .999999 * before.phase.periodS);
  assert.equal(at.phase.cycleElapsedS, 0);
  assert.ok(after.phase.cycleElapsedS > 0 && after.phase.cycleElapsedS < 1);
  assert.ok(before.apsides.timeToPeriapsisS < 1);
  assert.equal(at.apsides.timeToPeriapsisS, 0);
  assert.ok(after.apsides.timeToPeriapsisS > .999999 * after.phase.periodS);
  close(before.velocity.radialMps, -after.velocity.radialMps, 1e-6, 1e-10);
  close(before.velocity.transverseMps, after.velocity.transverseMps);
  close(before.energy.totalJPerKg, after.energy.totalJPerKg);
  close(before.acceleration.vectorMps2.x, after.acceleration.vectorMps2.x);
  close(before.acceleration.vectorMps2.y, -after.acceleration.vectorMps2.y, 1e-6, 1e-15);
});

test('semimajor-axis scaling separates geometry, velocity, acceleration, energy and time', () => {
  const small = orbitDetail(snapshot(1.23, .6, .5)), large = orbitDetail(snapshot(1.23, .6, 2));
  close(large.geometry.semiMajorAxisM / small.geometry.semiMajorAxisM, 4);
  close(large.velocity.radialMps / small.velocity.radialMps, .5);
  close(large.velocity.transverseMps / small.velocity.transverseMps, .5);
  close(large.acceleration.magnitudeMps2 / small.acceleration.magnitudeMps2, 1 / 16);
  close(large.energy.totalJPerKg / small.energy.totalJPerKg, 1 / 4);
  close(large.momentum.specificM2PerS / small.momentum.specificM2PerS, 2);
  close(large.phase.periodS / small.phase.periodS, 8);
  close(large.phase.trueRateRadPerS / small.phase.trueRateRadPerS, 1 / 8);
  close(large.apsides.timeToApoapsisS / small.apsides.timeToApoapsisS, 8);
  close(large.velocity.flightPathAngleRad, small.velocity.flightPathAngleRad);
});

test('all ten component facts are finite, unit-converted and disclose circular and direction limits', () => {
  for (const e of [0, 1e-12, .8]) for (const M of [0, 1.234, Math.PI, TAU - 1e-12]) {
    const s = snapshot(M, e, 2), d = orbitDetail(s);
    for (const part of COMPONENTS) {
      const result = describeOrbitDetail(part.id, s, d);
      assert.ok(result.facts.length >= 4 && result.facts.length <= 6);
      assert.ok(result.note.length > 20);
      assert.equal(new Set(result.facts.map(f => f.label)).size, result.facts.length);
      for (const f of result.facts) {
        assert.equal(typeof f.label, 'string'); assert.equal(typeof f.unit, 'string');
        assert.ok(Number.isInteger(f.digits));
        assert.ok(typeof f.value === 'string' || Number.isFinite(f.value));
      }
    }
    const facts = Object.fromEntries(describeOrbitDetail('orbiter', s).facts.map(f => [f.label, f]));
    close(facts['방사 속도'].value * 1000, d.velocity.radialMps);
    close(facts['단위 질량당 총에너지'].value * 1e6, d.energy.totalJPerKg);
    close(facts['중력 가속도 크기'].value / 1000, d.acceleration.magnitudeMps2);
    const area = Object.fromEntries(describeOrbitDetail('equal-areas', s).facts.map(f => [f.label, f.value]));
    close(area['면적속도 h/2'] * area['각 표시 구간의 시간 T/12'], area['각 곡선 부채꼴의 면적']);
  }
  assert.match(describeOrbitDetail('apsides', snapshot(0, 0)).note, /유일한 근일점/);
  assert.match(describeOrbitDetail('radius-line', snapshot()).note, /두 번째 미분/);
  assert.match(describeOrbitDetail('velocity-vector', snapshot()).note, /전체 속도가 궤도 접선/);
  assert.throws(() => describeOrbitDetail('unknown', snapshot()), RangeError);
});

test('strict snapshots reject missing, nonfinite, out-of-domain and contradictory solved inputs without repair', () => {
  for (const input of [null, [], {}, { ...snapshot(), config: { semiMajorAxisM: AU, eccentricity: .9 } },
    { ...snapshot(), meanAnomalyRad: TAU }, { ...snapshot(), meanAnomalyRad: -0 },
    { ...snapshot(), config: { ...snapshot().config, extra: true } }]) assert.throws(() => orbitDetail(input));
  for (const key of ['radiusM', 'speedMps', 'specificEnergyJPerKg', 'specificAngularMomentumM2PerS', 'periodS', 'eccentricAnomalyRad']) {
    for (const value of [undefined, NaN, Infinity, '1', snapshot()[key] + 1]) assert.throws(() => orbitDetail({ ...snapshot(), [key]: value }));
  }
  assert.throws(() => orbitDetail({ ...snapshot(), velocityMps: { x: 1, y: 2 } }));
});

test('diagnostics cannot mutate experiment, comparison or serialized project and return detached vectors', () => {
  const input = freeze(experiment(2.345, .35)), s = freeze(getSnapshot(input));
  const project = freeze(createProject({ experiment: input, comparison: { label: 'reference', experiment: experiment(0, 0, 2) },
    daysPerSecond: 30, camera: { position: [1, 2, 3], target: [0, 0, 0] } }));
  const before = serializeProject(project), originalSnapshot = JSON.stringify(s);
  const d = orbitDetail(s);
  for (const part of COMPONENTS) describeOrbitDetail(part.id, s, d);
  d.velocity.radialVectorMps.x = 123; d.geometry.ellipseCenterM.x = 456;
  assert.equal(JSON.stringify(s), originalSnapshot); assert.equal(serializeProject(project), before);
  assert.deepEqual(parseProject(before), project);
  assert.notEqual(orbitDetail(s).velocity.radialVectorMps.x, 123);
  assert.notEqual(orbitDetail(s).geometry.ellipseCenterM.x, 456);
  assert.deepEqual(Object.keys(project.experiment), ['config', 'meanAnomalyRad']);
});

test('exact axes and circular cases have positive zero and all supported diagnostics remain finite', () => {
  for (const e of [0, .8]) for (const a of [.5, 2]) for (const M of [0, Math.PI, .2, TAU - Number.EPSILON * 4]) {
    const d = orbitDetail(snapshot(M, e, a));
    visitNumbers(d, number => { assert.ok(Number.isFinite(number)); assert.equal(Object.is(number, -0), false); });
    if (e === 0) assert.deepEqual(d.geometry.ellipseCenterM, { x: 0, y: 0 });
  }
});
