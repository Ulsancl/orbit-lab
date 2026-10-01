import { MODEL_VERSION, createExperiment, assertExperiment } from './model.js';
import { DEFAULT_VIEW, COMPONENTS } from './geometry.js';

export { DEFAULT_VIEW };
export const projectType = 'orbit-lab-project', projectVersion = 1, projectModelVersion = MODEL_VERSION;
export const DEFAULT_DAYS_PER_SECOND = 15;
const speeds = [5, 15, 30], MAX_BYTES = 10 * 1024 * 1024;
const flags = ['orbit', 'geometry', 'velocity', 'equalAreas', 'labels'];
const parts = new Set(COMPONENTS.map(part => part.id));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const copy = value => structuredClone(value);
export class ProjectError extends Error {
  constructor(message, code = 'INVALID_PROJECT') {
    super(`${message} 원본 파일은 변경하지 않습니다.`); this.name = 'ProjectError'; this.code = code;
    this.preserveOriginal = true; this.futureVersion = ['FUTURE_SCHEMA', 'FUTURE_MODEL'].includes(code);
  }
}
const fail = (message, code) => { throw new ProjectError(message, code); };
function shape(value, required, label, optional = []) {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => !required.includes(key) && !optional.includes(key))) fail(`${label}에 누락되거나 지원하지 않는 항목이 있습니다.`);
}
function number(value, label, low, high) {
  if (!finite(value) || Object.is(value, -0) || value < low || value > high) fail(`${label} 수치가 올바르지 않습니다.`);
}
function modelVersion(value) {
  if (value === MODEL_VERSION) return;
  const version = typeof value === 'string' ? /^orbit-kepler-(\d+)$/.exec(value) : null;
  fail('이 궤도 모형 버전의 원래 기록을 보호합니다.', version && Number(version[1]) > 1 ? 'FUTURE_MODEL' : 'UNSUPPORTED_MODEL');
}
export function normalizeView(input) {
  const value = record(input) ? input : {};
  return { ...Object.fromEntries(flags.map(key => [key, typeof value[key] === 'boolean' ? value[key] : DEFAULT_VIEW[key]])),
    selectedPart: parts.has(value.selectedPart) ? value.selectedPart : DEFAULT_VIEW.selectedPart };
}
function savedView(value) {
  shape(value, [...flags, 'selectedPart'], '관찰 화면');
  if (!parts.has(value.selectedPart) || flags.some(key => typeof value[key] !== 'boolean')) fail('관찰 대상 또는 표시 상태가 올바르지 않습니다.');
  return normalizeView(value);
}
function savedCamera(value) {
  if (value === null) return null;
  shape(value, ['position', 'target'], '카메라', ['zoom']);
  for (const key of ['position', 'target']) {
    if (!Array.isArray(value[key]) || value[key].length !== 3) fail('카메라 좌표는 세 개의 수치여야 합니다.');
    for (const coordinate of value[key]) number(coordinate, '카메라 좌표', -30, 30);
  }
  // Native controls can place a mathematical boundary one ULP outside it.
  number(Math.hypot(...value.position.map((coordinate, index) => coordinate - value.target[index])), '카메라 거리', .2 - 1e-10, 40 + 1e-10);
  if (Object.hasOwn(value, 'zoom')) number(value.zoom, '카메라 확대', .25, 4);
  return copy(value);
}
function savedExperiment(value) {
  try { assertExperiment(value); }
  catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error;
    fail(`궤도 조건과 공전 위치가 올바르지 않습니다. ${error.message}`, 'INVALID_EXPERIMENT');
  }
  return copy(value);
}
function savedComparison(value) {
  if (value === null) return null;
  shape(value, ['label', 'experiment'], '비교 기록');
  if (typeof value.label !== 'string' || value.label.length < 1 || value.label.length > 80 || !value.label.trim() || /[\u0000-\u001f\u007f]/.test(value.label)) fail('비교 이름은 제어 문자 없는 1~80자여야 합니다.');
  return { label: value.label, experiment: savedExperiment(value.experiment) };
}
function validateProject(value) {
  if (!record(value) || value.type !== projectType) fail('지원하지 않는 궤도 실험 파일입니다.', 'UNSUPPORTED_FORMAT');
  if (Number.isInteger(value.schemaVersion) && value.schemaVersion > projectVersion) fail('새로운 저장 형식을 보호합니다.', 'FUTURE_SCHEMA');
  if (value.schemaVersion !== projectVersion) fail('지원하지 않는 저장 형식 버전입니다.', 'UNSUPPORTED_SCHEMA');
  modelVersion(value.modelVersion);
  shape(value, ['type', 'schemaVersion', 'modelVersion', 'experiment', 'comparison', 'observation'], '궤도 실험 파일');
  shape(value.observation, ['view', 'camera', 'daysPerSecond'], '관찰 기록');
  if (!speeds.includes(value.observation.daysPerSecond)) fail('관찰 배율은 화면 1초당 모형 5·15·30일 중 하나여야 합니다.');
  return { type: projectType, schemaVersion: projectVersion, modelVersion: MODEL_VERSION,
    experiment: savedExperiment(value.experiment), comparison: savedComparison(value.comparison),
    observation: { view: savedView(value.observation.view), camera: savedCamera(value.observation.camera), daysPerSecond: value.observation.daysPerSecond } };
}
/** Live defaults only. Imported files always take the strict path without repair. */
export function createProject(input = {}) {
  const value = record(input) ? input : {};
  let experiment;
  try { experiment = savedExperiment(value.experiment); }
  catch (error) {
    if (!(error instanceof ProjectError)) throw error;
    const supplied = record(value.experiment) ? value.experiment : {};
    experiment = createExperiment(supplied.config, { meanAnomalyRad: supplied.meanAnomalyRad });
  }
  let comparison = null, camera = null;
  if (value.comparison !== undefined) try { comparison = savedComparison(value.comparison); } catch (error) { if (!(error instanceof ProjectError)) throw error; }
  if (value.camera !== undefined) try { camera = savedCamera(value.camera); } catch (error) { if (!(error instanceof ProjectError)) throw error; }
  return { type: projectType, schemaVersion: projectVersion, modelVersion: MODEL_VERSION, experiment, comparison,
    observation: { view: normalizeView(value.view), camera, daysPerSecond: speeds.includes(value.daysPerSecond) ? value.daysPerSecond : DEFAULT_DAYS_PER_SECOND } };
}
export function parseProject(text) {
  if (typeof text !== 'string') fail('실험 파일은 JSON 텍스트여야 합니다.', 'INVALID_JSON');
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) fail('실험 파일은 10 MiB 이하여야 합니다.', 'PROJECT_TOO_LARGE');
  let value; try { value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { fail('JSON 실험 파일을 읽을 수 없습니다.', 'INVALID_JSON'); }
  return validateProject(value);
}
export function serializeProject(project) { return JSON.stringify(validateProject(project), null, 2); }
