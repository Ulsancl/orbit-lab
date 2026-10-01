import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, parseProject, serializeProject, normalizeView, DEFAULT_VIEW, ProjectError } from '../src/project.js';
import { DEFAULT_CONFIG, MODEL_VERSION, getSnapshot, ORBIT_CONSTANTS_SI } from '../src/model.js';
import { COMPONENTS } from '../src/geometry.js';
const AU = ORBIT_CONSTANTS_SI.astronomicalUnitM, TAU = Math.PI * 2;
const roundtrip = value => parseProject(serializeProject(value));
const experiment = () => ({ config: { semiMajorAxisM: 1.23456789 * AU, eccentricity: .6123456789 }, meanAnomalyRad: 1.23456789 });
const rejects = edit => { const value = createProject(); edit(value); const raw = JSON.stringify(value); assert.throws(() => parseProject(raw), e => e instanceof ProjectError && e.preserveOriginal); assert.equal(JSON.stringify(value), raw); };

test('default envelope saves one physical phase and a separate common model-time rate', () => {
  const value = createProject();
  assert.deepEqual(value, { type: 'orbit-lab-project', schemaVersion: 1, modelVersion: MODEL_VERSION,
    experiment: { config: { ...DEFAULT_CONFIG }, meanAnomalyRad: 0 }, comparison: null,
    observation: { view: { ...DEFAULT_VIEW }, camera: null, daysPerSecond: 15 } });
  assert.deepEqual(roundtrip(value), value);
});

test('circle and extreme ellipse at allowed sizes preserve reference and near-wrap phases exactly', () => {
  for (const semiMajorAxisM of [.5 * AU, 2 * AU]) for (const eccentricity of [0, .8]) for (const meanAnomalyRad of [0, Math.PI, TAU - 1e-12]) {
    const value = { config: { semiMajorAxisM, eccentricity }, meanAnomalyRad };
    assert.deepEqual(roundtrip(createProject({ experiment: value })).experiment, value);
  }
});

test('fractional observations and an independent frozen comparison reconstruct identical physical snapshots', () => {
  const current = experiment(), comparison = { label: '2 AU 원궤도', experiment: { config: { semiMajorAxisM: 2 * AU, eccentricity: 0 }, meanAnomalyRad: Math.PI } };
  const value = createProject({ experiment: current, comparison }), restored = roundtrip(value);
  assert.deepEqual(restored, value);
  assert.deepEqual(getSnapshot(restored.experiment), getSnapshot(current));
  assert.deepEqual(getSnapshot(restored.comparison.experiment), getSnapshot(comparison.experiment));
  assert.equal(getSnapshot(restored.comparison.experiment).radiusM, 2 * AU);
});

test('strict imports reject metres/AU confusion, unsupported eccentricity and unknown conditions', () => {
  for (const semiMajorAxisM of [.49 * AU, 2.01 * AU, 1, '149597870700', null]) rejects(p => { p.experiment.config.semiMajorAxisM = semiMajorAxisM; });
  for (const eccentricity of [-.01, .801, 1, '0', null]) rejects(p => { p.experiment.config.eccentricity = eccentricity; });
  rejects(p => { p.experiment.config.solarMass = 1; }); rejects(p => { delete p.experiment.config.eccentricity; });
});

test('saved phase requires canonical radians and all strict numbers reject nonfinite or signed zero', () => {
  for (const meanAnomalyRad of [-1, TAU, TAU + .1, '0', null]) rejects(p => { p.experiment.meanAnomalyRad = meanAnomalyRad; });
  for (const number of [NaN, Infinity, -Infinity, -0]) {
    const value = createProject(); value.experiment.meanAnomalyRad = number; assert.throws(() => serializeProject(value), ProjectError);
    value.experiment.meanAnomalyRad = 0; value.experiment.config.eccentricity = number; assert.throws(() => serializeProject(value), ProjectError);
  }
  assert.throws(() => parseProject(serializeProject(createProject()).replace('"meanAnomalyRad": 0', '"meanAnomalyRad": -0')), ProjectError);
});

test('live construction repairs only live defaults and leaves a valid experiment unchanged', () => {
  const value = createProject({ experiment: { config: { semiMajorAxisM: 99 * AU, eccentricity: -1 }, meanAnomalyRad: TAU } });
  assert.deepEqual(value.experiment, { config: { semiMajorAxisM: 2 * AU, eccentricity: 0 }, meanAnomalyRad: 0 });
  assert.deepEqual(createProject({ experiment: experiment() }).experiment, experiment());
  assert.deepEqual(createProject(null), createProject());
  assert.deepEqual(createProject({ experiment: { config: null, meanAnomalyRad: Infinity } }).experiment, createProject().experiment);
});

test('each of the ten inspectable targets and observation flags roundtrip independently', () => {
  assert.equal(COMPONENTS.length, 10); assert.deepEqual(normalizeView(null), DEFAULT_VIEW);
  for (const { id } of COMPONENTS) {
    const view = { orbit: false, geometry: false, velocity: false, equalAreas: true, labels: false, selectedPart: id };
    assert.deepEqual(roundtrip(createProject({ view })).observation.view, view);
  }
  rejects(p => { p.observation.view.selectedPart = 'tube-wall'; }); rejects(p => { p.observation.view.velocity = 1; }); rejects(p => { p.observation.view.exploded = true; });
});

test('world-unit camera boundaries and optional zoom preserve exact saved coordinates', () => {
  for (const camera of [null, { position: [.2, 0, 0], target: [0, 0, 0] }, { position: [30, 0, 0], target: [-10, 0, 0], zoom: .25 },
    { position: [1.7323456789, 2.55, 3.4], target: [.1, .2, -.3], zoom: 4 }]) assert.deepEqual(roundtrip(createProject({ camera })).observation.camera, camera);
  for (const camera of [{ position: [0, 0, 0], target: [0, 0, 0] }, { position: [.199, 0, 0], target: [0, 0, 0] },
    { position: [30, 0, 0], target: [-10.01, 0, 0] }, { position: [AU, 0, 0], target: [0, 0, 0] },
    { position: [1, 0], target: [0, 0, 0] }, { position: [1, 0, 0], target: [0, 0, 0], zoom: 5 }]) rejects(p => { p.observation.camera = camera; });
});

test('only the three common days-per-second values are persisted, never a normalized orbit period', () => {
  for (const daysPerSecond of [5, 15, 30]) assert.equal(roundtrip(createProject({ daysPerSecond })).observation.daysPerSecond, daysPerSecond);
  for (const daysPerSecond of [0, 12, 60, '15', null]) rejects(p => { p.observation.daysPerSecond = daysPerSecond; });
  assert.equal(createProject({ daysPerSecond: 12 }).observation.daysPerSecond, 15);
});

test('comparison validation and detached copies prevent caller-state and camera aliasing', () => {
  const input = { experiment: experiment(), comparison: { label: ' 보관 조건 ', experiment: experiment() }, camera: { position: [1, 1, 1], target: [0, 0, 0] } };
  const before = structuredClone(input), value = createProject(input);
  value.experiment.config.eccentricity = .4; value.comparison.experiment.meanAnomalyRad = 0; value.observation.camera.position[0] = 2;
  assert.deepEqual(input, before); assert.equal(roundtrip(value).comparison.label, input.comparison.label);
  for (const label of ['', ' ', 'a'.repeat(81), 'bad\nname']) rejects(p => { p.comparison = { label, experiment: experiment() }; });
  rejects(p => { p.comparison = { label: 'bad', experiment: { ...experiment(), meanAnomalyRad: TAU } }; });
  assert.equal(createProject({ comparison: { label: 'bad', experiment: null } }).comparison, null);
});

test('derived paths, independent clocks, probe positions and guide progress cannot become saved state', () => {
  for (const key of ['running', 'elapsedS', 'clock', 'guide']) rejects(p => { p[key] = 1; });
  for (const key of ['positionM', 'velocityMps', 'samples', 'energy', 'probeRatio', 'orbitCount']) rejects(p => { p.experiment[key] = []; });
  rejects(p => { p.comparison = { label: 'derived', experiment: experiment(), periodS: 100 }; });
});

test('future format and model versions protect originals while unrelated products are refused', () => {
  for (const [key, value, code] of [['schemaVersion', 2, 'FUTURE_SCHEMA'], ['modelVersion', 'orbit-kepler-2', 'FUTURE_MODEL']]) {
    assert.throws(() => parseProject(JSON.stringify({ ...createProject(), [key]: value })), e => e instanceof ProjectError && e.futureVersion && e.preserveOriginal && e.code === code);
  }
  rejects(p => { p.type = 'sound-lab-project'; }); rejects(p => { p.modelVersion = 'sound-standing-wave-1'; }); rejects(p => { p.schemaVersion = '1'; }); rejects(p => { delete p.comparison; });
});

test('one BOM is accepted and invalid JSON or oversized UTF-8 text is preserved by refusing import', () => {
  const value = createProject(), raw = serializeProject(value); assert.deepEqual(parseProject('\ufeff' + raw), value);
  for (const input of ['\ufeff\ufeff' + raw, '{원본\r\n', null, 4]) assert.throws(() => parseProject(input), e => e.code === 'INVALID_JSON');
  for (const input of [' '.repeat(10 * 1024 * 1024 + 1), '가'.repeat(4 * 1024 * 1024)]) assert.throws(() => parseProject(input), e => e.code === 'PROJECT_TOO_LARGE');
});
