import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORBIT_CONSTANTS_SI, advanceExperiment, createExperiment, getSnapshot,
  getSweptSector, sampleOrbit,
} from '../src/model.js';
import { createProject, parseProject, serializeProject } from '../src/project.js';
import { createGuide, lessonReady } from '../src/lessons.js';

const { astronomicalUnitM: AU, dayS: DAY, solarMuM3PerS2: SOLAR_MU } = ORBIT_CONSTANTS_SI;
const TAU = 2 * Math.PI;
const config = { semiMajorAxisM: 1.23456789 * AU, eccentricity: .63 };
const phase = .37123456789 * TAU;
const near = (actual, expected) => {
  assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
    `${actual} differs from ${expected}`);
};

test('mass changes Kepler timing and dynamics at the same position and orbit shape', () => {
  const solar = getSnapshot(createExperiment(config, { meanAnomalyRad: phase }));
  for (const centralMassSolar of [.25, 2.75, 4]) {
    const experiment = createExperiment({ ...config, centralMassSolar }, { meanAnomalyRad: phase });
    const state = getSnapshot(experiment);
    const speedRatio = Math.sqrt(centralMassSolar);

    assert.deepEqual(state.positionM, solar.positionM);
    assert.equal(state.radiusM, solar.radiusM);
    assert.equal(state.eccentricAnomalyRad, solar.eccentricAnomalyRad);
    assert.equal(state.orbitAreaM2, solar.orbitAreaM2);
    near(state.periodS, solar.periodS / speedRatio);
    near(state.timeSinceReferenceS, solar.timeSinceReferenceS / speedRatio);
    near(state.velocityMps.x, solar.velocityMps.x * speedRatio);
    near(state.velocityMps.y, solar.velocityMps.y * speedRatio);
    near(state.periapsisSpeedMps, solar.periapsisSpeedMps * speedRatio);
    near(state.apoapsisSpeedMps, solar.apoapsisSpeedMps * speedRatio);
    near(state.specificAngularMomentumM2PerS, solar.specificAngularMomentumM2PerS * speedRatio);
    near(state.arealVelocityM2PerS, solar.arealVelocityM2PerS * speedRatio);
    near(state.specificEnergyJPerKg, -SOLAR_MU * centralMassSolar / (2 * config.semiMajorAxisM));

    const advanced = advanceExperiment(experiment, DAY);
    assert.deepEqual(advanced.config, experiment.config);
    near(advanced.meanAnomalyRad, phase + DAY * solar.meanMotionRadPerS * speedRatio);

    const samples = sampleOrbit(experiment.config);
    near(samples.at(-1).offsetTimeS, state.periodS);
    near(samples[0].speedMps, solar.periapsisSpeedMps * speedRatio);
    const sector = getSweptSector(experiment.config, phase, state.periodS / 12);
    near(sector.areaM2, solar.orbitAreaM2 / 12);
    near(sector.samples.at(-1).meanAnomalyRad, phase + TAU / 12);
  }
});

test('legacy files retain their constants, phase and exact comparison coordinates', () => {
  const experiment = { config, meanAnomalyRad: TAU - 1e-12 };
  const comparisonExperiment = { config: { semiMajorAxisM: AU, eccentricity: .45 }, meanAnomalyRad: phase };
  const comparison = { label: '기존 보관 궤도', experiment: comparisonExperiment };
  const original = createProject({ experiment, comparison });
  const raw = JSON.stringify(original, null, 2);
  const restored = parseProject(raw);

  assert.equal(serializeProject(restored), raw);
  assert.deepEqual(restored, original);
  assert.equal(ORBIT_CONSTANTS_SI.solarMuM3PerS2, 1.32712440041279419e20);
  for (const saved of [restored.experiment, restored.comparison.experiment]) {
    const state = getSnapshot(saved);
    const explicitSolar = getSnapshot({ ...saved, config: { ...saved.config, centralMassSolar: 1 } });
    assert.deepEqual(state, { ...explicitSolar, config: saved.config });
  }
  assert.deepEqual(getSnapshot(restored.comparison.experiment), getSnapshot(comparisonExperiment));
});

test('current and comparison mass and phase are saved independently with strict boundaries', () => {
  const experiment = createExperiment({ ...config, centralMassSolar: 4 }, { meanAnomalyRad: phase });
  const comparisonExperiment = createExperiment({ ...config, centralMassSolar: .25 }, { meanAnomalyRad: 1.123456789012345 });
  const project = createProject({ experiment, comparison: { label: '가벼운 중심체', experiment: comparisonExperiment } });
  const restored = parseProject(serializeProject(project));
  assert.deepEqual(restored, project);
  assert.deepEqual(getSnapshot(restored.experiment), getSnapshot(experiment));
  assert.deepEqual(getSnapshot(restored.comparison.experiment), getSnapshot(comparisonExperiment));

  for (const value of [.249999, 4.00001, -0, '1', null, {}, NaN, Infinity]) {
    for (const kind of ['current', 'comparison']) {
      const invalid = structuredClone(project);
      const target = kind === 'current' ? invalid.experiment : invalid.comparison.experiment;
      target.config.centralMassSolar = value;
      assert.throws(() => serializeProject(invalid), { code: 'INVALID_EXPERIMENT', preserveOriginal: true });
      assert.throws(() => parseProject(JSON.stringify(invalid)), { code: 'INVALID_EXPERIMENT', preserveOriginal: true });
    }
  }
  assert.equal(createExperiment({ ...config, centralMassSolar: 9 }).config.centralMassSolar, 4);
  assert.equal(createExperiment({ ...config, centralMassSolar: -.5 }).config.centralMassSolar, .25);
  assert.deepEqual(createExperiment({ ...config, centralMassSolar: 1 }).config, config);
});

test('existing guided experiments require the solar mass used by their results', () => {
  const guide = createGuide('period');
  const circle = { semiMajorAxisM: AU, eccentricity: 0 };
  assert.equal(lessonReady(guide, createExperiment(circle)), true);
  assert.equal(lessonReady(guide, createExperiment({ ...circle, centralMassSolar: 4 })), false);
});
