import './style.css';
import { DEFAULT_CONFIG, ORBIT_CONSTANTS_SI, normalizeConfig, createExperiment, getSnapshot, advanceExperiment, wrapMeanAnomalyRad } from './model.js';
import { createProject, parseProject, serializeProject, normalizeView, DEFAULT_VIEW } from './project.js';
import { COMPONENTS } from './geometry.js';
import { OrbitScene } from './scene.js';
import { OrbitChart } from './chart.js';
import { LESSONS, createGuide, lessonReady, confirmObservation, guideText } from './lessons.js';

const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
const text = (selector, value) => { const element = $(selector); if (element.textContent !== value) element.textContent = value; };
const copy = value => structuredClone(value), fmt = (value, digits = 1) => (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const { astronomicalUnitM: AU, dayS: DAY } = ORBIT_CONSTANTS_SI, TAU = 2 * Math.PI;
const conditionName = exp => `a ${fmt(exp.config.semiMajorAxisM / AU, 2)} AU · e ${fmt(exp.config.eccentricity, 2)} · ${fmt(exp.meanAnomalyRad / TAU * 100, 1)}%`;
const STORAGE_KEY = 'orbit-lab-project-v1', desktop = window.orbitDesktop;
let experiment = createExperiment(), view = normalizeView(DEFAULT_VIEW), comparison = null, snapshot, daysPerSecond = 15;
let scene = null, initialCamera = null, guide = null, previous = null, busy = false, restoring = false, chartDisplay = 'both';
let running = false, frameId = null, anchor = null, lastPaint = 0, lastSave = 0;
let saveTimer, toastTimer, recoveredRaw = null, storageBlocked = false;
let savedSnapshot = null, savedSnapshotInput = null;
const chart = new OrbitChart($('#speed-chart'), $('#period-chart'));

function toast(message) {
  clearTimeout(toastTimer); const close = Object.assign(document.createElement('button'), { textContent: '닫기', type: 'button' });
  close.addEventListener('click', () => { $('#toast').hidden = true; });
  $('#toast').replaceChildren(Object.assign(document.createElement('span'), { textContent: message }), close); $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}
function updateSnapshot() { snapshot = getSnapshot(experiment); }
function comparisonSnapshot() {
  if (savedSnapshotInput !== comparison) { savedSnapshotInput = comparison; savedSnapshot = comparison ? getSnapshot(comparison.experiment) : null; }
  return savedSnapshot;
}
function capture() { return createProject({ experiment, comparison, view, camera: scene?.getCameraState() ?? initialCamera, daysPerSecond }); }
function saveLocal() {
  clearTimeout(saveTimer); if (storageBlocked || restoring) return;
  try { localStorage.setItem(STORAGE_KEY, serializeProject(capture())); text('#save-status', '이 기기에 자동 저장됨'); }
  catch { text('#save-status', '자동 저장을 완료하지 못했습니다 · 파일로 보관하세요'); }
}
function scheduleSave() { if (!restoring && !storageBlocked) { clearTimeout(saveTimer); saveTimer = setTimeout(saveLocal, 230); } }
function protectOriginal(raw, future) {
  storageBlocked = true; recoveredRaw = raw;
  try { localStorage.setItem(`${STORAGE_KEY}-original-${Date.now()}`, raw); } catch { /* Export remains available from memory. */ }
  $('#storage-recovery').hidden = false;
  if (future) text('#storage-recovery strong', '더 새로운 버전의 실험입니다. 원문을 보존합니다.');
  text('#save-status', '자동 저장 원문 보호 중 · 현재 실험은 파일로 보관하세요');
}
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== null) try { const saved = parseProject(raw); ({ experiment, comparison } = saved); ({ view, camera: initialCamera, daysPerSecond } = saved.observation); }
  catch (error) { protectOriginal(raw, error.futureVersion); }
} catch { storageBlocked = true; text('#save-status', '자동 저장을 사용할 수 없습니다 · 파일로 보관하세요'); }
updateSnapshot();

function resetAnchor(now = performance.now()) { anchor = { experiment: copy(experiment), at: now, daysPerSecond }; }
function syncTime(now = performance.now()) {
  if (!running || !anchor || now <= anchor.at) return;
  const seconds = (now - anchor.at) / 1000 * anchor.daysPerSecond * DAY;
  // Reduce a very long sleep by complete periods before the bounded pure API.
  const period = getSnapshot(anchor.experiment).periodS;
  experiment = advanceExperiment(anchor.experiment, seconds % period); updateSnapshot();
}
function frame(now) {
  frameId = null; syncTime(now); scene?.update(snapshot, view, comparisonSnapshot());
  if (now - lastPaint >= 100) { refresh(false); lastPaint = now; }
  if (now - lastSave >= 1000) { saveLocal(); lastSave = now; }
  if (running) frameId = requestAnimationFrame(frame);
}
function pause() {
  syncTime(); running = false; anchor = null; if (frameId !== null) cancelAnimationFrame(frameId); frameId = null;
  refresh(); saveLocal();
}
function togglePlay() {
  if (busy) return;
  if (running) { pause(); return; }
  running = true; resetAnchor(); lastSave = anchor.at; refresh(); frameId = requestAnimationFrame(frame);
}
function setProgress(percent) {
  if (busy || !Number.isFinite(percent)) return;
  pause(); experiment.meanAnomalyRad = wrapMeanAnomalyRad(Math.max(0, Math.min(100, percent)) / 100 * TAU);
  updateSnapshot(); refresh(); scheduleSave();
}
function changeConfig(patch) {
  if (busy) return;
  const config = normalizeConfig({ ...experiment.config, ...patch });
  if (Object.keys(config).every(key => config[key] === experiment.config[key])) { syncControls(); return; }
  pause(); experiment.config = config; updateSnapshot(); syncControls(); refresh(); scheduleSave();
}
function remember() { syncTime(); previous = { project: capture(), guide: copy(guide) }; $('#undo-new').hidden = false; }
function readProject(project, restoredGuide = null) {
  const saved = parseProject(serializeProject(project));
  pause(); restoring = true;
  try { ({ experiment, comparison } = saved); ({ view, camera: initialCamera, daysPerSecond } = saved.observation); guide = restoredGuide; chartDisplay = 'both'; updateSnapshot(); syncControls(); refresh(); if (initialCamera) scene?.setCameraState(initialCamera); else scene?.resetCamera(); }
  finally { restoring = false; }
  saveLocal();
}
function newExperiment() {
  if (busy) return; pause(); remember(); experiment = createExperiment(DEFAULT_CONFIG); comparison = null; guide = null; daysPerSecond = 15;
  view = normalizeView(DEFAULT_VIEW); chartDisplay = 'both'; updateSnapshot(); syncControls(); refresh(); scene?.resetCamera(); saveLocal(); toast('새 실험을 시작했습니다. 직전 실험은 되돌릴 수 있습니다.');
}
function setBusy(value) {
  if (value) pause();
  busy = value; $('#save-project').disabled = value; $('#open-project').disabled = value;
  if (desktop?.setBusy) Promise.resolve(desktop.setBusy(value)).catch(() => {});
}
function syncControls() {
  $('#a').value = experiment.config.semiMajorAxisM / AU; $('#a-number').value = Number((experiment.config.semiMajorAxisM / AU).toFixed(8));
  $('#eccentricity').value = experiment.config.eccentricity; $('#eccentricity-number').value = experiment.config.eccentricity;
  $('#rate').value = daysPerSecond; $('#part-select').value = view.selectedPart;
  for (const input of $$('[data-view]')) input.checked = view[input.dataset.view];
  for (const button of $$('[data-lesson]')) button.setAttribute('aria-pressed', String(button.dataset.lesson === guide?.id));
}
function drawChart() { chart.update(snapshot, comparisonSnapshot(), chartDisplay); }
function renderGuide() {
  $('#lesson-guide').hidden = !guide; if (!guide) return;
  const info = guideText(guide), ready = lessonReady(guide, experiment, view, running);
  text('#guide-title', LESSONS[guide.id].title); text('#guide-progress', guide.status === 'completed' ? '관찰 완료' : `관찰 ${guide.stage + 1} / ${info.total}`);
  text('#guide-action', info.action); text('#guide-result', info.result); $('#guide-next').hidden = guide.status !== 'active'; $('#guide-next').disabled = !ready;
  text('#guide-next', ready ? '관찰 확인 · 다음으로' : '조건을 맞춘 뒤 관찰 확인');
  $('#guide-evidence').replaceChildren(...guide.evidence.map((evidence, index) => Object.assign(document.createElement('li'), { textContent: `${index + 1}차 · ${fmt(evidence.periodDays, 2)}일 · ${fmt(evidence.radiusAU, 2)} AU · ${fmt(evidence.speedKmS, 2)} km/s${evidence.areas ? ` · 각 ${fmt(evidence.areas[0].areaAU2, 5)} AU²` : ''}` })));
}
function refresh(paint = true) {
  const periodText = `${fmt(snapshot.periodS / DAY, 2)}일`, progress = experiment.meanAnomalyRad / TAU * 100;
  text('#period', periodText); text('#radius', `${fmt(snapshot.radiusM / AU, 3)} AU`); text('#speed', `${fmt(snapshot.speedMps / 1000, 2)} km/s`); text('#cycle', `${fmt(progress, 1)}%`);
  text('#condition-period', periodText); text('#condition-shape', `a ${fmt(experiment.config.semiMajorAxisM / AU, 2)} AU · ${experiment.config.eccentricity === 0 ? '원 궤도' : `타원 e ${fmt(experiment.config.eccentricity, 2)}`}`);
  text('#play', running ? '일시정지' : '재생'); text('#play-state', running ? `1초에 ${daysPerSecond}일 진행` : '정지');
  text('#progress-reading', `${fmt(progress, 1)}%`); $('#progress').value = progress; text('#cycle-days', `이번 한 바퀴 ${fmt(snapshot.timeSinceReferenceS / DAY, 2)} / ${fmt(snapshot.periodS / DAY, 2)}일`);
  const circle = experiment.config.eccentricity === 0;
  text('#periapsis-button', circle ? '기준 위치' : '가장 가까운 곳'); text('#apoapsis-button', circle ? '반대 위치' : '가장 먼 곳');
  text('[data-camera="periapsis"]', circle ? '기준 위치 확대' : '가까운 곳 확대');
  text('#apsis-reading', circle ? `원에서는 어느 곳이나 ${fmt(snapshot.radiusM / AU, 2)} AU로 같습니다.` : `가까운 곳 ${fmt(snapshot.periapsisM / AU, 2)} AU · 먼 곳 ${fmt(snapshot.apoapsisM / AU, 2)} AU`);
  $('#area-readout').hidden = !view.equalAreas; text('#area-duration', `각 ${fmt(snapshot.periodS / DAY / 12, 2)}일`); text('#area-value', `면적 A = B = ${fmt(snapshot.orbitAreaM2 / AU ** 2 / 12, 5)} AU²`);
  const part = COMPONENTS.find(item => item.id === view.selectedPart); text('#part-description', part?.description ?? '요소를 선택하세요.');
  $('#comparison-panel').hidden = !comparison;
  if (comparison) text('#comparison-summary', `현재 ${conditionName(experiment)} / 보관 ${conditionName(comparison.experiment)}`);
  for (const button of $$('[data-chart-mode]')) button.setAttribute('aria-pressed', String(button.dataset.chartMode === chartDisplay));
  drawChart(); renderGuide(); if (paint) scene?.update(snapshot, view, comparisonSnapshot());
}
function startLesson(id) {
  if (busy || !Object.hasOwn(LESSONS, id)) return; pause(); remember();
  experiment = createExperiment(LESSONS[id].config); guide = createGuide(id); comparison = null; daysPerSecond = 15; chartDisplay = 'both'; view = normalizeView(DEFAULT_VIEW);
  updateSnapshot(); syncControls(); refresh(); scene?.resetCamera(); saveLocal(); $('#lesson-guide').scrollIntoView({ block: 'nearest' });
}
function pinComparison() { if (busy) return; syncTime(); comparison = { label: conditionName(experiment), experiment: copy(experiment) }; chartDisplay = 'both'; refresh(); scheduleSave(); }
function browserDownload(contents, name, mime = 'application/json;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([contents], { type: mime })); Object.assign(document.createElement('a'), { href: url, download: name }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function saveFile() {
  if (busy) return; setBusy(true);
  try { const contents = serializeProject(capture()), name = `orbit-lab-${new Date().toISOString().slice(0, 10)}.orbit.json`;
    if (desktop) { const result = await desktop.saveProject({ contents, name }); if (result.canceled) { toast('저장을 취소했습니다. 현재 실험은 유지합니다.'); return; } }
    else browserDownload(contents, name);
    saveLocal(); toast('궤도 조건·진행 위치·비교·관찰 시점·시간 속도를 저장했습니다.');
  } catch (error) { toast(`저장하지 못했습니다. ${error.message}`); } finally { setBusy(false); }
}
async function openFile() {
  if (busy) return; pause(); if (!desktop) { $('#project-file').click(); return; } setBusy(true);
  try { const result = await desktop.openProject(); if (result.canceled) { toast('열기를 취소했습니다. 현재 실험은 유지합니다.'); return; } const saved = parseProject(result.content); remember(); readProject(saved); toast('저장한 궤도 실험을 복원했습니다.'); }
  catch (error) { toast(`열지 못했습니다. ${error.message}`); } finally { setBusy(false); }
}
function toggleFocus() { document.body.classList.toggle('focus-mode'); text('#focus', document.body.classList.contains('focus-mode') ? '실험 화면으로' : '3D 크게 보기'); $('.observation').scrollIntoView({ block: 'start' }); }
function help() { pause(); $('#help-dialog').showModal(); }

$('#part-select').replaceChildren(...COMPONENTS.map(part => Object.assign(document.createElement('option'), { value: part.id, textContent: part.label })));
try { scene = new OrbitScene($('#scene'), { onSelect: id => { view.selectedPart = id; syncControls(); refresh(); scheduleSave(); }, onCameraChange: scheduleSave }); if (initialCamera) scene.setCameraState(initialCamera); }
catch (error) { $('#scene-error').hidden = false; text('#scene-error', `3D 화면을 시작하지 못했습니다. ${error.message}`); }
syncControls(); refresh(); if (!initialCamera) scene?.resetCamera();
$('#a').addEventListener('input', event => changeConfig({ semiMajorAxisM: Number(event.target.value) * AU }));
$('#eccentricity').addEventListener('input', event => changeConfig({ eccentricity: Number(event.target.value) }));
for (const [selector, key, multiplier] of [['#a-number', 'semiMajorAxisM', AU], ['#eccentricity-number', 'eccentricity', 1]]) {
  const applyNumber = event => { const value = Number(event.target.value); if (event.target.value.trim() && Number.isFinite(value)) changeConfig({ [key]: value * multiplier }); else syncControls(); };
  $(selector).addEventListener('change', applyNumber); $(selector).addEventListener('blur', applyNumber);
}
$('#play').addEventListener('click', togglePlay); $('#reset-phase').addEventListener('click', () => setProgress(0));
$('#progress').addEventListener('input', event => setProgress(Number(event.target.value)));
for (const button of $$('[data-progress]')) button.addEventListener('click', () => setProgress(Number(button.dataset.progress)));
$('#periapsis-button').addEventListener('click', () => setProgress(0)); $('#apoapsis-button').addEventListener('click', () => setProgress(50));
$('#rate').addEventListener('change', event => { const value = Number(event.target.value); if (busy || ![5, 15, 30].includes(value)) { syncControls(); return; } syncTime(); daysPerSecond = value; if (running) resetAnchor(); refresh(); scheduleSave(); });
for (const input of $$('[data-view]')) input.addEventListener('change', () => { if (busy) { syncControls(); return; } syncTime(); view[input.dataset.view] = input.checked; refresh(); scheduleSave(); });
for (const button of $$('[data-camera]')) button.addEventListener('click', () => scene?.resetCamera(button.dataset.camera));
$('#part-select').addEventListener('change', event => { if (busy) { syncControls(); return; } view.selectedPart = event.target.value; refresh(); scheduleSave(); });
$('#focus-part').addEventListener('click', () => { scene?.focusPart(view.selectedPart); $('#toast').hidden = true; $('.observation').scrollIntoView({ block: 'start' }); }); $('#focus').addEventListener('click', toggleFocus);
for (const button of $$('[data-lesson]')) button.addEventListener('click', () => startLesson(button.dataset.lesson));
$('#guide-next').addEventListener('click', () => { if (busy) return; syncTime(); if (confirmObservation(guide, experiment, view, running)) { pause(); refresh(false); } });
$('#guide-restart').addEventListener('click', () => { if (guide) startLesson(guide.id); }); $('#guide-exit').addEventListener('click', () => { guide = null; syncControls(); refresh(false); });
$('#pin-comparison').addEventListener('click', pinComparison); $('#clear-comparison').addEventListener('click', () => { if (busy) return; comparison = null; chartDisplay = 'both'; refresh(); scheduleSave(); });
for (const button of $$('[data-chart-mode]')) button.addEventListener('click', () => { chartDisplay = button.dataset.chartMode; refresh(false); });
$('#new-project').addEventListener('click', newExperiment);
$('#undo-new').addEventListener('click', () => { if (!previous || busy) return; const saved = previous; previous = null; readProject(saved.project, saved.guide); $('#undo-new').hidden = true; toast('직전 실험을 복원했습니다.'); });
$('#save-project').addEventListener('click', saveFile); $('#open-project').addEventListener('click', openFile);
$('#project-file').addEventListener('change', async event => { const file = event.target.files?.[0]; if (!file || busy) return; setBusy(true);
  try { if (file.size > 10 * 1024 * 1024) throw new Error('실험 파일은 10 MiB 이하여야 합니다.'); const saved = parseProject(await file.text()); remember(); readProject(saved); toast('저장한 궤도 실험을 복원했습니다.'); }
  catch (error) { toast(`열지 못했습니다. ${error.message}`); } finally { event.target.value = ''; setBusy(false); }
});
$('#recover-original').addEventListener('click', () => { if (recoveredRaw !== null) browserDownload(recoveredRaw, 'orbit-lab-original.txt', 'text/plain;charset=utf-8'); });
$('#help').addEventListener('click', help); $('#close-help').addEventListener('click', () => $('#help-dialog').close());
desktop?.onCommand(command => { if (busy) return; const commands = { 'new-project': newExperiment, 'open-project': openFile, 'save-project': saveFile, 'toggle-play': togglePlay, focus: toggleFocus, help }; commands[command]?.(); });
window.addEventListener('beforeunload', () => { syncTime(); saveLocal(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
new ResizeObserver(drawChart).observe($('#speed-chart'));
window.orbitLab = { getState: () => copy({ experiment, snapshot, view, daysPerSecond, comparison, running }), project: () => { syncTime(); return copy(capture()); },
  loadProject: raw => { const saved = parseProject(raw); remember(); readProject(saved); return copy(capture()); }, sceneDebug: () => scene?.getDebug() ?? null,
  guide: () => copy(guide), chartDebug: () => copy(chart.debug), setProgress };
