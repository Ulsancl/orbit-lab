import './style.css';
import './condition-controls.css';
import { CONFIG_LIMITS_SI, DEFAULT_CONFIG, ORBIT_CONSTANTS_SI, normalizeConfig, createExperiment, getSnapshot, advanceExperiment, wrapMeanAnomalyRad } from './model.js';
import { createProject, parseProject, serializeProject, normalizeView, DEFAULT_VIEW, MAX_PROJECT_BYTES } from './project.js';
import { createBrowserAutosave, supportsAutosaveLock, withAutosaveLock, writeIfUnchanged, readTabDraft, writeTabDraft, clearTabDraft } from './browser-autosave.js';
import { COMPONENTS } from './geometry.js';
import { OrbitScene } from './scene.js';
import { OrbitChart } from './chart.js';
import { orbitDetail } from './detail-model.js';
import { OrbitDetailPanel } from './detail-panel.js';
import './detail-panel.css';
import { LESSONS, createGuide, lessonReady, confirmObservation, guideText } from './lessons.js';

const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
const text = (selector, value) => { const element = $(selector); if (element.textContent !== value) element.textContent = value; };
const copy = value => structuredClone(value), fmt = (value, digits = 1) => (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const { astronomicalUnitM: AU, dayS: DAY } = ORBIT_CONSTANTS_SI, TAU = 2 * Math.PI;
const phasePercent = experiment => experiment.meanAnomalyRad / TAU * 100;
const centralMass = config => config.centralMassSolar ?? 1;
const conditionPrecision = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 });
const conditionName = exp => `a ${fmt(exp.config.semiMajorAxisM / AU, 2)} AU · e ${fmt(exp.config.eccentricity, 2)} · ${conditionPrecision.format(centralMass(exp.config))} M☉ · ${conditionPrecision.format(phasePercent(exp))}%`;
const conditions = [
  { id: 'a', key: 'semiMajorAxisM', multiplier: AU, unit: 'AU', keyboardStep: .01 },
  { id: 'eccentricity', key: 'eccentricity', multiplier: 1, unit: '', keyboardStep: .01 },
  { id: 'central-mass', key: 'centralMassSolar', multiplier: 1, unit: '태양질량', keyboardStep: .05 },
];
const conditionValue = (config, key) => key === 'centralMassSolar' ? centralMass(config) : config[key];
const progressRange = $('#progress'), progressNumber = $('#progress-number');
const STORAGE_KEY = 'orbit-lab-project-v1', desktop = window.orbitDesktop;
let experiment = createExperiment(), view = normalizeView(DEFAULT_VIEW), comparison = null, snapshot, daysPerSecond = 15;
let scene = null, initialCamera = null, guide = null, previous = null, busy = false, restoring = false, chartDisplay = 'both';
let running = false, frameId = null, anchor = null, lastPaint = 0, lastSave = 0;
let saveTimer, toastTimer, recoveredRaw = null, storageBlocked = false;
let savedSnapshot = null, savedSnapshotInput = null;
const chart = new OrbitChart($('#speed-chart'), $('#period-chart'));
const inspectionParts = new Set(['velocity-vector','radius-line','orbiter','orbit-path','ellipse-center','second-focus','semimajor-axis']);
const detailPanel = new OrbitDetailPanel($('#orbit-details'), $('#part-facts'), $('#part-detail-note'), { onInspect: beginInspection });
const mobileLayout = matchMedia('(max-width: 740px)');
for (const details of $$('[data-mobile-disclosure]')) {
  let openOnMobile = false;
  if (mobileLayout.matches) details.open = openOnMobile;
  mobileLayout.addEventListener('change', ({ matches }) => {
    if (matches) {
      const focusInside = details.contains(document.activeElement) && document.activeElement !== details.firstElementChild;
      details.open = openOnMobile || focusInside;
    } else {
      openOnMobile = details.open;
      details.open = true;
    }
  });
}

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
function capture() { return createProject({ experiment, comparison, view, camera: scene?.getProjectCameraState?.() ?? scene?.getCameraState() ?? initialCamera, daysPerSecond }); }
function selectPart(id) {
  if (busy) { syncControls(); return; }
  if (!COMPONENTS.some(part => part.id === id)) throw new RangeError('Unknown orbit component');
  view.selectedPart = id;
  if (scene?.getInspection?.()) { if (inspectionParts.has(id)) scene.beginInspection(id); else scene.endInspection(); }
  syncControls(); refresh(); scheduleSave();
}
function beginInspection(id = view.selectedPart) {
  if (busy || !inspectionParts.has(id) || !scene?.beginInspection?.(id)) return false;
  view.selectedPart = id; syncControls(); refresh(); $('#toast').hidden = true;
  requestAnimationFrame(() => $('.observation').scrollIntoView({ block: 'start' })); scheduleSave(); return true;
}
function endInspection() { scene?.endInspection?.(); refresh(); scheduleSave(); }
let lastStoredRaw = null, browserAutosave = null, guardArmed = false;
let resumedTabDraft = false, interruptedTabDraft = null, tabDraftProtected = false;
const draftStorage = () => sessionStorage;
const getBrowserLocks = () => { try { return navigator.locks; } catch { return undefined; } };
const currentProjectText = () => serializeProject(capture());
const autosaveIssues = {
  conflict: ['다른 탭에서 저장한 실험을 보호했어요.', '이 탭의 변경은 자동 저장하지 않습니다. 아래에서 이 탭의 실험을 내려받고, 최신에 저장된 실험을 보려면 새로고침하세요.', '다른 탭에서 자동 저장이 변경됨 · 이 탭의 실험은 파일로 보관하세요'],
  unavailable: ['이 환경에서는 안전한 자동 저장을 사용할 수 없어요.', '기존 자동 저장 기록을 덮어쓰지 않습니다. 변경한 실험은 아래에서 파일로 내려받으세요.', '안전한 자동 저장을 사용할 수 없음 · 파일로 보관하세요'],
  failed: ['자동 저장을 완료하지 못했어요.', '현재 실험을 잃지 않으려면 아래에서 파일로 내려받으세요.', '자동 저장을 완료하지 못했습니다 · 파일로 보관하세요'],
};
function rememberBrowserDraft() {
  try {
    const draft = browserAutosave.unsavedDraft();
    // This is private to the current tab and survives a reload, not a safe
    // replacement for a project file if the tab/browser is closed.
    if (draft && !restoring && !tabDraftProtected) writeTabDraft(draftStorage, STORAGE_KEY, draft);
    return Boolean(draft);
  } catch { return true; }
}
function warnOnUnsavedExit(event) {
  const dirty = rememberBrowserDraft();
  if (!running && !dirty) return;
  event.preventDefault();
  event.returnValue = true;
}
function armUnloadGuard() {
  if (desktop || !browserAutosave || guardArmed) return;
  guardArmed = true;
  window.addEventListener('beforeunload', warnOnUnsavedExit);
}
function disarmUnloadGuard() {
  guardArmed = false;
  window.removeEventListener('beforeunload', warnOnUnsavedExit);
}
function reportAutosave(status, contents) {
  if (status === 'saved' || status === 'unchanged') {
    if (!desktop && !tabDraftProtected) clearTabDraft(draftStorage, STORAGE_KEY, contents);
    if (!running) disarmUnloadGuard();
    $('#autosave-recovery').hidden = true;
    text('#save-status', status === 'saved' ? '이 기기에 자동 저장됨' : '자동 저장할 변경 없음');
    return;
  }
  const [title, hint, footer] = autosaveIssues[status];
  text('#autosave-title', title); text('#autosave-hint', hint); text('#save-status', footer);
  $('#autosave-recovery').hidden = false;
}
function saveLocal() {
  clearTimeout(saveTimer);
  if (restoring) return;
  if (!desktop) {
    armUnloadGuard();
    if (!storageBlocked && browserAutosave?.canSave()) {
      text('#save-status', '자동 저장 확인 중');
      void browserAutosave.flush();
    }
    return;
  }
  if (storageBlocked) return;
  try {
    const contents = currentProjectText();
    // The installed app uses its existing single-instance, synchronous path.
    if (!writeIfUnchanged(localStorage, STORAGE_KEY, lastStoredRaw, contents)) {
      storageBlocked = true;
      reportAutosave('conflict');
      return;
    }
    lastStoredRaw = contents;
    reportAutosave('saved');
  } catch { reportAutosave('failed'); }
}
function scheduleSave() {
  if (restoring) return;
  armUnloadGuard();
  if (storageBlocked || (!desktop && !browserAutosave?.canSave())) return;
  if (!desktop) text('#save-status', '자동 저장 확인 중');
  clearTimeout(saveTimer); saveTimer = setTimeout(saveLocal, 230);
}
function flushBrowserOnHide() {
  if (!guardArmed || restoring || !browserAutosave) return;
  rememberBrowserDraft();
  if (!storageBlocked && browserAutosave.canSave()) {
    clearTimeout(saveTimer);
    void browserAutosave.flush();
  }
}
function protectOriginal(raw, future) {
  storageBlocked = true; recoveredRaw = raw;
  const backup = () => {
    const prefix = `${STORAGE_KEY}-original-`;
    const backedUp = Object.keys(localStorage).some(k => k.startsWith(prefix) && localStorage.getItem(k) === raw);
    if (!backedUp) localStorage.setItem(`${prefix}${Date.now()}`, raw);
  };
  // Recovery remains available from the primary record and in memory, even
  // when backup storage is full or browser coordination is unavailable.
  if (desktop) { try { backup(); } catch { /* Keep the original. */ } }
  else {
    const locks = getBrowserLocks();
    if (supportsAutosaveLock(locks)) void withAutosaveLock(locks, STORAGE_KEY, backup).catch(() => {});
  }
  $('#storage-recovery').hidden = false;
  if (future) text('#storage-recovery strong', '더 새로운 버전의 실험입니다. 원문을 보존합니다.');
  text('#save-status', '자동 저장 원문 보호 중 · 현재 실험은 파일로 보관하세요');
}
function applyRestoredProject(saved) {
  ({ experiment, comparison } = saved);
  ({ view, camera: initialCamera, daysPerSecond } = saved.observation);
}
try {
  const raw = localStorage.getItem(STORAGE_KEY); lastStoredRaw = raw;
  if (raw !== null) try { applyRestoredProject(parseProject(raw)); }
  catch (error) { protectOriginal(raw, error.futureVersion); }
} catch { storageBlocked = true; reportAutosave('unavailable'); }
function restoreTabDraft() {
  if (desktop) return;
  // Even if a new tab inherited sessionStorage from an opener, it must not
  // silently reapply that draft to the shared experiment.
  const reloading = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload';
  const draft = readTabDraft(draftStorage, STORAGE_KEY);
  if (!draft) return;
  if (draft.contents === lastStoredRaw) {
    clearTabDraft(draftStorage, STORAGE_KEY, draft.contents);
    return;
  }
  try {
    const saved = parseProject(draft.contents);
    if (reloading && !draft.interrupted && !storageBlocked && draft.expected === lastStoredRaw
        && supportsAutosaveLock(getBrowserLocks())) {
      applyRestoredProject(saved);
      resumedTabDraft = true;
    } else {
      // The latest shared version remains the active experiment. Hold the old
      // tab draft apart, even if the primary value later returns to old bytes.
      interruptedTabDraft = draft.contents;
      tabDraftProtected = true;
      writeTabDraft(draftStorage, STORAGE_KEY, { ...draft, interrupted: true });
      $('#tab-draft-recovery').hidden = false;
    }
  } catch { clearTabDraft(draftStorage, STORAGE_KEY, draft.contents); }
}
restoreTabDraft();
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
  running = true; armUnloadGuard(); resetAnchor(); lastSave = anchor.at; refresh(); frameId = requestAnimationFrame(frame);
}
function setProgress(percent) {
  if (busy || !Number.isFinite(percent)) return;
  pause(); experiment.meanAnomalyRad = wrapMeanAnomalyRad(Math.max(0, Math.min(100, percent)) / 100 * TAU);
  updateSnapshot(); refresh(); scheduleSave();
}
function changeConfig(patch) {
  if (busy) return;
  const config = normalizeConfig({ ...experiment.config, ...patch });
  if (conditions.every(({ key }) => conditionValue(config, key) === conditionValue(experiment.config, key))) { syncControls(); return; }
  pause(); scene?.endInspection?.(); experiment.config = config; updateSnapshot(); syncControls(); refresh(); scheduleSave();
}
function remember() { syncTime(); previous = { project: capture(), guide: copy(guide) }; $('#undo-new').hidden = false; }
function readProject(project, restoredGuide = null) {
  const saved = parseProject(serializeProject(project));
  pause(); scene?.endInspection?.(); restoring = true;
  try { ({ experiment, comparison } = saved); ({ view, camera: initialCamera, daysPerSecond } = saved.observation); guide = restoredGuide; chartDisplay = 'both'; updateSnapshot(); syncControls(); refresh(); if (initialCamera) scene?.setCameraState(initialCamera); else scene?.resetCamera(); }
  finally { restoring = false; }
  saveLocal();
}
function newExperiment() {
  if (busy) return; pause(); remember(); scene?.endInspection?.(); experiment = createExperiment(DEFAULT_CONFIG); comparison = null; guide = null; daysPerSecond = 15;
  view = normalizeView(DEFAULT_VIEW); chartDisplay = 'both'; updateSnapshot(); syncControls(); refresh(); scene?.resetCamera(); saveLocal(); toast('새 실험을 시작했습니다. 직전 실험은 되돌릴 수 있습니다.');
}
function setBusy(value) {
  if (value) pause();
  busy = value; $('#save-project').disabled = value; $('#open-project').disabled = value;
  if (desktop?.setBusy) Promise.resolve(desktop.setBusy(value)).catch(() => {});
}
const conditionDisplays = new WeakMap();
function syncControls() {
  for (const { id, key, multiplier, unit } of conditions) {
    const applied = conditionValue(experiment.config, key), value = String(applied / multiplier);
    for (const selector of [`#${id}`, `#${id}-number`]) {
      const input = $(selector); input.step = 'any'; input.value = value;
      input.setAttribute('aria-valuetext', unit ? `${value} ${unit}` : value);
      // Native range inputs may canonicalize their last decimal even with
      // step=any. Remember that display without replacing the applied SI value.
      conditionDisplays.set(input, { value: Number(input.value), applied });
    }
  }
  $('#rate').value = daysPerSecond; $('#part-select').value = view.selectedPart;
  for (const input of $$('[data-view]')) input.checked = view[input.dataset.view];
  for (const button of $$('[data-lesson]')) button.setAttribute('aria-pressed', String(button.dataset.lesson === guide?.id));
}
function drawChart() { chart.update(snapshot, comparisonSnapshot(), chartDisplay); }
function renderGuide() {
  $('#lesson-guide').hidden = !guide; if (!guide) return;
  const info = guideText(guide), ready = lessonReady(guide, experiment, view, running);
  text('#guide-title', LESSONS[guide.id].title); text('#guide-progress', guide.status === 'completed' ? '관찰 완료' : `관찰 ${guide.stage + 1} / ${info.total}`);
  const massHint = guide.status === 'active' && centralMass(experiment.config) !== 1 ? ' 중심체 질량을 1 M☉로 맞추세요.' : '';
  text('#guide-action', info.action + massHint); text('#guide-result', info.result); $('#guide-next').hidden = guide.status !== 'active'; $('#guide-next').disabled = !ready;
  text('#guide-next', ready ? '관찰 확인 · 다음으로' : '조건을 맞춘 뒤 관찰 확인');
  $('#guide-evidence').replaceChildren(...guide.evidence.map((evidence, index) => Object.assign(document.createElement('li'), { textContent: `${index + 1}차 · ${fmt(evidence.periodDays, 2)}일 · ${fmt(evidence.radiusAU, 2)} AU · ${fmt(evidence.speedKmS, 2)} km/s${evidence.areas ? ` · 각 ${fmt(evidence.areas[0].areaAU2, 5)} AU²` : ''}` })));
}
let displayedProgress;
function syncProgressNumber(progress = phasePercent(experiment)) {
  const rounded = Number(progress.toPrecision(12));
  displayedProgress = rounded === 100 ? progress : rounded;
  const value = String(displayedProgress);
  if (progressNumber.value !== value) progressNumber.value = value;
}
function refresh(paint = true) {
  const periodText = `${fmt(snapshot.periodS / DAY, 2)}일`, progress = phasePercent(experiment);
  text('#period', periodText); text('#radius', `${fmt(snapshot.radiusM / AU, 3)} AU`); text('#speed', `${fmt(snapshot.speedMps / 1000, 2)} km/s`); text('#cycle', `${fmt(progress, 1)}%`);
  text('#condition-period', periodText); text('#condition-shape', `a ${fmt(experiment.config.semiMajorAxisM / AU, 2)} AU · ${experiment.config.eccentricity === 0 ? '원 궤도' : `타원 e ${fmt(experiment.config.eccentricity, 2)}`}`);
  text('#play', running ? '일시정지' : '재생'); text('#play-state', running ? `1초에 ${daysPerSecond}일 진행` : '정지');
  progressRange.value = progress;
  progressRange.setAttribute('aria-valuetext', `${conditionPrecision.format(progress)}%`);
  if (!running || document.activeElement !== progressNumber) syncProgressNumber(progress);
  text('#cycle-days', `이번 한 바퀴 ${fmt(snapshot.timeSinceReferenceS / DAY, 2)} / ${fmt(snapshot.periodS / DAY, 2)}일`);
  const circle = experiment.config.eccentricity === 0;
  text('#periapsis-button', circle ? '기준 위치' : '가장 가까운 곳'); text('#apoapsis-button', circle ? '반대 위치' : '가장 먼 곳');
  text('[data-camera="periapsis"]', circle ? '기준 위치 확대' : '가까운 곳 확대');
  text('#apsis-reading', circle ? `원에서는 어느 곳이나 ${fmt(snapshot.radiusM / AU, 2)} AU로 같습니다.` : `가까운 곳 ${fmt(snapshot.periapsisM / AU, 2)} AU · 먼 곳 ${fmt(snapshot.apoapsisM / AU, 2)} AU`);
  $('#area-readout').hidden = !view.equalAreas; text('#area-duration', `각 ${fmt(snapshot.periodS / DAY / 12, 2)}일`); text('#area-value', `면적 A = B = ${fmt(snapshot.orbitAreaM2 / AU ** 2 / 12, 5)} AU²`);
  const part = COMPONENTS.find(item => item.id === view.selectedPart); text('#part-description', part?.description ?? '요소를 선택하세요.');
  detailPanel.render(snapshot, view.selectedPart);
  const inspection = scene?.getInspection?.();
  $('#inspection-strip').hidden = !inspection; text('#inspection-note', inspection?.note ?? '');
  $('#inspect-part').disabled = !inspectionParts.has(view.selectedPart) || !scene?.beginInspection;
  $('#inspect-part').setAttribute('aria-pressed', String(Boolean(inspection)));
  text('#inspect-part', inspection ? '상세 관찰 마치기' : '구성 자세히');
  $('#comparison-panel').hidden = !comparison;
  if (comparison) text('#comparison-summary', `현재 ${conditionName(experiment)} / 보관 ${conditionName(comparison.experiment)}`);
  for (const button of $$('[data-chart-mode]')) button.setAttribute('aria-pressed', String(button.dataset.chartMode === chartDisplay));
  drawChart(); renderGuide(); if (paint) scene?.update(snapshot, view, comparisonSnapshot());
}
function startLesson(id) {
  if (busy || !Object.hasOwn(LESSONS, id)) return; pause(); remember(); scene?.endInspection?.();
  experiment = createExperiment(LESSONS[id].config); guide = createGuide(id); comparison = null; daysPerSecond = 15; chartDisplay = 'both'; view = normalizeView(DEFAULT_VIEW);
  updateSnapshot(); syncControls(); refresh(); scene?.resetCamera(); saveLocal(); $('#lesson-guide').scrollIntoView({ block: 'nearest' });
}
function pinComparison() { if (busy) return; syncTime(); comparison = { label: conditionName(experiment), experiment: copy(experiment) }; chartDisplay = 'both'; refresh(); scheduleSave(); }
function browserDownload(contents, name, mime = 'application/json;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([contents], { type: mime })); Object.assign(document.createElement('a'), { href: url, download: name }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function projectFilename(suffix = '') {
  return `orbit-lab-${new Date().toISOString().slice(0,10)}${suffix}.orbit.json`;
}
function downloadBrowserProject(contents, filename) {
  browserDownload(contents, filename);
  // The browser owns the download prompt; this records the snapshot offered
  // to it, not a guarantee that the user kept the file.
  browserAutosave.markExported(contents);
  if (!tabDraftProtected) clearTabDraft(draftStorage, STORAGE_KEY);
  if (!running) disarmUnloadGuard();
}
function exportInterruptedTabDraft() {
  if (busy || interruptedTabDraft === null) return;
  try {
    browserDownload(interruptedTabDraft, projectFilename('-interrupted'));
    toast('내려받은 복구 사본을 확인하세요.');
  } catch (error) { toast(`내려받지 못했습니다. ${error.message}`); }
}
function discardInterruptedTabDraft() {
  if (busy || interruptedTabDraft === null || !window.confirm('이 탭에 남은 이전 실험의 복구 사본을 지울까요?')) return;
  clearTabDraft(draftStorage, STORAGE_KEY, interruptedTabDraft);
  interruptedTabDraft = null;
  tabDraftProtected = false;
  $('#tab-draft-recovery').hidden = true;
}
function exportUnsavedProject() {
  if (busy) return;
  if (desktop) { void saveFile(); return; }
  try {
    syncTime();
    downloadBrowserProject(currentProjectText(), projectFilename('-recovered'));
    toast('내려받은 실험 파일을 확인한 뒤 새로고침하세요.');
  } catch (error) { toast(`내려받지 못했습니다. ${error.message}`); }
}
async function saveFile() {
  if (busy) return; setBusy(true);
  try { const contents = currentProjectText(), name = projectFilename();
    if (desktop) { const result = await desktop.saveProject({ contents, name }); if (result.canceled) { toast('저장을 취소했습니다. 현재 실험은 유지합니다.'); return; } }
    else downloadBrowserProject(contents, name);
    saveLocal(); toast('궤도 조건·진행 위치·비교·관찰 시점·시간 속도를 저장했습니다.');
  } catch (error) { toast(`저장하지 못했습니다. ${error.message}`); } finally { setBusy(false); }
}
async function openFile() {
  if (busy) return; pause(); if (!desktop) { $('#project-file').click(); return; } setBusy(true);
  try { const result = await desktop.openProject(); if (result.canceled) { toast('열기를 취소했습니다. 현재 실험은 유지합니다.'); return; } remember(); readProject(result.project); toast('저장한 궤도 실험을 복원했습니다.'); }
  catch (error) { toast(`열지 못했습니다. ${error.message}`); } finally { setBusy(false); }
}
async function exportOriginal() {
  if (busy || recoveredRaw === null) return;
  if (!desktop) { browserDownload(recoveredRaw, 'orbit-lab-original.txt', 'text/plain;charset=utf-8'); return; }
  setBusy(true);
  try {
    const result = await desktop.exportOriginal(recoveredRaw);
    toast(result.canceled ? '원문 저장을 취소했습니다.' : '자동 저장 원문을 보관했습니다.');
  } catch (error) { toast(`원문을 저장하지 못했습니다. ${error.message}`); } finally { setBusy(false); }
}
function toggleFocus() { document.body.classList.toggle('focus-mode'); text('#focus', document.body.classList.contains('focus-mode') ? '실험 화면으로' : '3D 크게 보기'); $('.observation').scrollIntoView({ block: 'start' }); }
function help() { pause(); $('#help-dialog').showModal(); }

$('#part-select').replaceChildren(...COMPONENTS.map(part => Object.assign(document.createElement('option'), { value: part.id, textContent: part.label })));
try { scene = new OrbitScene($('#scene'), { onSelect: selectPart, onCameraChange: scheduleSave }); if (initialCamera) scene.setCameraState(initialCamera); }
catch (error) { $('#scene-error').hidden = false; text('#scene-error', `3D 화면을 시작하지 못했습니다. ${error.message}`); }
syncControls(); refresh(); if (!initialCamera) scene?.resetCamera();
if (!desktop) {
  browserAutosave = createBrowserAutosave({
    key: STORAGE_KEY, storage: () => localStorage, locks: getBrowserLocks(), expected: lastStoredRaw,
    baseline: resumedTabDraft ? null : currentProjectText(), capture: currentProjectText, onStatus: reportAutosave,
  });
  if (!storageBlocked && !browserAutosave.canSave()) reportAutosave('unavailable');
  else if (resumedTabDraft) saveLocal();
}
for (const { id, key, multiplier, keyboardStep } of conditions) {
  const applyValue = event => {
    const input = event.target, value = Number(input.value), displayed = conditionDisplays.get(input);
    const current = conditionValue(experiment.config, key);
    // An unchanged AU display must not round-trip the saved SI value, pause
    // playback or end inspection. Division followed by multiplication can
    // differ by an ULP even when the user has not edited the input.
    if (busy || !input.value.trim() || !Number.isFinite(value) || value === current / multiplier
      || (displayed?.applied === current && value === displayed.value)) { syncControls(); return; }
    changeConfig({ [key]: value * multiplier });
  };
  for (const selector of [`#${id}`, `#${id}-number`]) {
    const input = $(selector), range = input.type === 'range';
    for (const event of range ? ['input'] : ['change', 'blur']) input.addEventListener(event, applyValue);
    input.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (!range && event.key === 'Enter') { event.preventDefault(); applyValue(event); return; }
      const directions = range ? { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 }
        : { ArrowDown: -1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
      if (!(event.key in directions) && !(range && ['Home', 'End'].includes(event.key))) return;
      event.preventDefault(); if (busy) { syncControls(); return; }
      const value = Number(input.value), current = conditionValue(experiment.config, key), displayed = conditionDisplays.get(input);
      const unchanged = value === current / multiplier || (displayed?.applied === current && value === displayed.value);
      const base = input.value.trim() && Number.isFinite(value) && !unchanged ? value * multiplier : current;
      const { min, max } = CONFIG_LIMITS_SI[key];
      const next = event.key === 'Home' ? min : event.key === 'End' ? max
        : Math.max(min, Math.min(max, base + directions[event.key] * keyboardStep * (event.shiftKey ? .1 : 1) * multiplier));
      changeConfig({ [key]: next });
    });
  }
}
$('#play').addEventListener('click', togglePlay); $('#reset-phase').addEventListener('click', () => setProgress(0));
progressRange.addEventListener('input', () => setProgress(progressRange.valueAsNumber));
function applyProgressNumber() {
  const value = progressNumber.valueAsNumber;
  if (Number.isFinite(value) && value !== displayedProgress) {
    setProgress(value);
  }
  syncProgressNumber();
}
progressNumber.addEventListener('change', applyProgressNumber);
progressNumber.addEventListener('blur', applyProgressNumber);
for (const input of [progressRange, progressNumber]) {
  input.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (input === progressNumber && event.key === 'Enter') {
      event.preventDefault();
      applyProgressNumber();
      return;
    }
    const directions = input === progressRange
      ? { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 }
      : { ArrowDown: -1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
    if (!Object.hasOwn(directions, event.key)) return;
    event.preventDefault();
    const current = phasePercent(experiment);
    const pending = progressNumber.valueAsNumber;
    const base = input === progressNumber && Number.isFinite(pending) && pending !== displayedProgress ? pending : current;
    setProgress(base + directions[event.key] * (event.shiftKey ? .01 : .1));
  });
}
for (const button of $$('[data-progress]')) button.addEventListener('click', () => setProgress(Number(button.dataset.progress)));
$('#periapsis-button').addEventListener('click', () => setProgress(0)); $('#apoapsis-button').addEventListener('click', () => setProgress(50));
$('#rate').addEventListener('change', event => { const value = Number(event.target.value); if (busy || ![5, 15, 30].includes(value)) { syncControls(); return; } syncTime(); daysPerSecond = value; if (running) resetAnchor(); refresh(); scheduleSave(); });
for (const input of $$('[data-view]')) input.addEventListener('change', () => { if (busy) { syncControls(); return; } syncTime(); view[input.dataset.view] = input.checked; refresh(); scheduleSave(); });
for (const button of $$('[data-camera]')) button.addEventListener('click', () => { scene?.endInspection?.(); scene?.resetCamera(button.dataset.camera); refresh(false); });
$('#part-select').addEventListener('change', event => selectPart(event.target.value));
$('#focus-part').addEventListener('click', () => { scene?.focusPart(view.selectedPart); refresh(false); $('#toast').hidden = true; $('.observation').scrollIntoView({ block: 'start' }); }); $('#focus').addEventListener('click', toggleFocus);
$('#inspect-part').addEventListener('click', () => { if (scene?.getInspection?.()) endInspection(); else beginInspection(); });
$('#end-inspection').addEventListener('click', endInspection);
for (const button of $$('[data-lesson]')) button.addEventListener('click', () => startLesson(button.dataset.lesson));
$('#guide-next').addEventListener('click', () => { if (busy) return; syncTime(); if (confirmObservation(guide, experiment, view, running)) { pause(); refresh(false); } });
$('#guide-restart').addEventListener('click', () => { if (guide) startLesson(guide.id); }); $('#guide-exit').addEventListener('click', () => { guide = null; syncControls(); refresh(false); });
$('#pin-comparison').addEventListener('click', pinComparison); $('#clear-comparison').addEventListener('click', () => { if (busy) return; comparison = null; chartDisplay = 'both'; refresh(); scheduleSave(); });
for (const button of $$('[data-chart-mode]')) button.addEventListener('click', () => { chartDisplay = button.dataset.chartMode; refresh(false); });
$('#new-project').addEventListener('click', newExperiment);
$('#undo-new').addEventListener('click', () => { if (!previous || busy) return; const saved = previous; previous = null; readProject(saved.project, saved.guide); $('#undo-new').hidden = true; toast('직전 실험을 복원했습니다.'); });
$('#export-unsaved-project').addEventListener('click', exportUnsavedProject);
$('#export-interrupted-draft').addEventListener('click', exportInterruptedTabDraft);
$('#discard-interrupted-draft').addEventListener('click', discardInterruptedTabDraft);
$('#save-project').addEventListener('click', saveFile); $('#open-project').addEventListener('click', openFile);
$('#project-file').addEventListener('change', async event => { const file = event.target.files?.[0]; if (!file || busy) return; setBusy(true);
  try { if (file.size > MAX_PROJECT_BYTES) throw new Error('실험 파일은 10 MiB 이하여야 합니다.'); const saved = parseProject(await file.text()); remember(); readProject(saved); toast('저장한 궤도 실험을 복원했습니다.'); }
  catch (error) { toast(`열지 못했습니다. ${error.message}`); } finally { event.target.value = ''; setBusy(false); }
});
$('#recover-original').addEventListener('click', exportOriginal);
$('#help').addEventListener('click', help); $('#close-help').addEventListener('click', () => $('#help-dialog').close());
desktop?.onCommand(command => { if (busy) return; const commands = { 'new-project': newExperiment, 'open-project': openFile, 'save-project': saveFile, 'toggle-play': togglePlay, focus: toggleFocus, help }; commands[command]?.(); });
if (desktop) window.addEventListener('beforeunload', () => { syncTime(); saveLocal(); });
else window.addEventListener('pagehide', () => { if (running) pause(); flushBrowserOnHide(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (desktop || running) pause();
  if (!desktop) flushBrowserOnHide();
});
const chartResize = new ResizeObserver(drawChart);
chartResize.observe($('#speed-chart'));
chartResize.observe($('#radius-chart'));
if (__ORBIT_TEST_BUILD__) {
  window.orbitLab = { getState: () => copy({ experiment, snapshot, view, daysPerSecond, comparison, running }), project: () => { syncTime(); return copy(capture()); },
    loadProject: raw => { const saved = parseProject(raw); remember(); readProject(saved); return copy(capture()); }, sceneDebug: () => scene?.getDebug() ?? null,
    guide: () => copy(guide), chartDebug: () => copy(chart.debug), setProgress, getDetail: () => orbitDetail(snapshot),
    getInspection: () => scene?.getInspection?.() ?? null, beginInspection, endInspection };
  window.render_game_to_text = () => JSON.stringify({ mode: running ? 'running' : 'paused', coordinateSystem: 'SI physics x,y maps to world x,0,-y in AU; velocity arrows 0.01 AU per km/s; acceleration marker direction only', snapshot, daysPerSecond, selectedPart: view.selectedPart, inspection: scene?.getInspection?.() ?? null, comparison: Boolean(comparison) });
  window.advanceTime = milliseconds => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('Expected nonnegative milliseconds');
    pause(); experiment = advanceExperiment(experiment, (milliseconds / 1000 * daysPerSecond * DAY) % snapshot.periodS);
    updateSnapshot(); refresh(); scheduleSave(); return copy(snapshot);
  };
}
