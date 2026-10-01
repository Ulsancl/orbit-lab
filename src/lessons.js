import { ORBIT_CONSTANTS_SI, getSnapshot, getSweptSector } from './model.js';
const AU = ORBIT_CONSTANTS_SI.astronomicalUnitM, DAY = ORBIT_CONSTANTS_SI.dayS;
const step = (action, a, e, progress, equalAreas = null) => ({ action, a, e, progress, equalAreas });
export const LESSONS = {
  period: { title: '두 배 멀어지면 두 배 오래 걸릴까?', config: { semiMajorAxisM: AU, eccentricity: 0 },
    steps: [step('정지 상태에서 a = 1.00 AU, e = 0의 공전 주기를 확인하세요. 비교 보관 버튼으로 남길 수도 있습니다.', 1, 0, 0),
      step('긴반지름 a를 2.00 AU로 바꾸세요. 원 궤도(e = 0)와 시간 진행 0%를 유지하고 한 바퀴의 시간을 읽어보세요.', 2, 0, 0)],
    result: '긴반지름이 두 배가 되면 주기는 약 365.26일 → 1,033.10일, 약 2.83배입니다. T²는 a³에 비례합니다. 같은 일/초로 재생하면 큰 궤도는 화면에서도 더 오래 걸립니다.' },
  speed: { title: '어디에서 가장 빨리 움직일까?', config: { semiMajorAxisM: AU, eccentricity: 0 },
    steps: [step('a = 1.00 AU, e = 0, 시간 진행 0%에서 원 궤도의 속력을 확인하세요.', 1, 0, 0),
      step('이심률 e를 0.60으로 바꾸고 가장 가까운 곳(0%)의 속력을 확인하세요. 긴반지름은 1.00 AU로 유지합니다.', 1, .6, 0),
      step('가장 먼 곳 버튼 또는 50% 버튼을 눌러 속력을 확인하세요. 주기는 같은데 속력은 어떻게 달라졌나요?', 1, .6, .5)],
    result: '원에서는 약 29.78 km/s로 일정합니다. e = 0.60인 타원에서는 가까운 곳 약 59.57 km/s, 먼 곳 약 14.89 km/s로 4배 차이가 납니다. 긴반지름이 같아 공전 주기는 같습니다.' },
  area: { title: '모양은 달라도 면적은 같을까?', config: { semiMajorAxisM: AU, eccentricity: .6 },
    steps: [step('같은 시간, 같은 면적을 켜세요. a = 1.00 AU, e = 0.60, 시간 진행 0%에서 두 구간의 면적과 시간 길이를 확인하세요.', 1, .6, 0, true),
      step('50% 또는 가장 먼 곳으로 이동하세요. 두 색 구간은 같은 궤도의 고정 구간입니다. 입자 위치가 바뀌어도 표시된 두 면적은 같나요?', 1, .6, .5, true)],
    result: '두 구간 모두 약 30.44일(T/12) 동안 약 0.20944 AU²를 쓸고 갑니다. 가까운 곳에서는 더 긴 호를 빠르게 지나고, 먼 곳에서는 더 짧은 호를 천천히 지납니다. 직선 삼각형이 아닌 곡선까지의 면적입니다.' }
};
export function createGuide(id) {
  if (!Object.hasOwn(LESSONS, id)) throw new RangeError('알 수 없는 안내 실험입니다.');
  return { id, stage: 0, status: 'active', evidence: [] };
}
export function lessonReady(guide, experiment, view, running = false) {
  if (!guide || guide.status !== 'active' || running) return false;
  const rule = LESSONS[guide.id]?.steps[guide.stage]; if (!rule) return false;
  const near = (a, b) => Math.abs(a - b) < 1e-8;
  return near(experiment.config.semiMajorAxisM / AU, rule.a) && near(experiment.config.eccentricity, rule.e)
    && near(experiment.meanAnomalyRad / (2 * Math.PI), rule.progress)
    && (rule.equalAreas === null || view?.equalAreas === rule.equalAreas);
}
export function confirmObservation(guide, experiment, view, running = false) {
  if (!lessonReady(guide, experiment, view, running)) return false;
  const snapshot = getSnapshot(experiment);
  const areas = guide.id === 'area' ? [0, Math.PI].map(M => {
    const sector = getSweptSector(experiment.config, M, snapshot.periodS / 12);
    return { startMeanAnomalyRad: M, durationDays: sector.durationS / DAY, areaAU2: sector.areaM2 / AU ** 2 };
  }) : null;
  guide.evidence.push({ experiment: structuredClone(experiment), periodDays: snapshot.periodS / DAY,
    radiusAU: snapshot.radiusM / AU, speedKmS: snapshot.speedMps / 1000, equalAreasVisible: Boolean(view?.equalAreas), areas });
  guide.stage += 1; if (guide.stage === LESSONS[guide.id].steps.length) guide.status = 'completed'; return true;
}
export function guideText(guide) {
  const lesson = LESSONS[guide.id];
  return { action: guide.status === 'completed' ? '관찰을 마쳤습니다. 조건을 더 바꿔 자유롭게 실험해 보세요.' : lesson.steps[guide.stage].action,
    result: guide.status === 'completed' ? lesson.result : '', total: lesson.steps.length };
}
