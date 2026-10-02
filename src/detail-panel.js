import { orbitDetail, describeOrbitDetail } from './detail-model.js';
import { ORBIT_CONSTANTS_SI } from './model.js';

const { dayS: DAY } = ORBIT_CONSTANTS_SI;
const number = (value, digits = 3) => typeof value !== 'number' ? String(value)
  : value !== 0 && Math.abs(value) < .5 * 10 ** -digits ? value.toExponential(2)
    : value.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const degrees = value => value * 180 / Math.PI;
const arrow = (x, y, dx, dy) => {
  const length = Math.hypot(dx, dy); if (length === 0) return `M${x} ${y}`;
  const ex = x + dx, ey = y + dy, h = Math.min(7, length * .3), ux = dx / length, uy = dy / length;
  return `M${x} ${y}L${ex} ${ey}M${ex - h * ux + h * .5 * uy} ${ey - h * uy - h * .5 * ux}L${ex} ${ey}L${ex - h * ux - h * .5 * uy} ${ey - h * uy + h * .5 * ux}`;
};
export class OrbitDetailPanel {
  constructor(root, facts, note, { onInspect }) {
    this.root = root; this.facts = facts; this.note = note;
    root.innerHTML = `<div class="panel-heading"><div><p class="eyebrow">READ THE COMPONENTS</p><h2 id="orbit-detail-title">얼마나 멀어지고, 얼마나 돌아갈까요?</h2></div></div>
      <div class="orbit-detail-grid"><section class="velocity-detail"><h3>속도 하나를 두 방향으로 나누기</h3><div class="velocity-detail-body"><figure><svg viewBox="0 0 300 220" role="img" aria-label="속도의 방사 성분을 가로축, 횡방향 성분을 세로축에 표시. 표시된 축 눈금의 단위는 km/s이며 관찰 범위에 맞춰 바뀝니다."><path d="M18 170H270M90 193V25M40 166V174M140 166V174M86 120H94M86 70H94" stroke="#435877" fill="none"/><text x="193" y="190">바깥 +r</text><text x="100" y="24">회전 +θ</text><text id="velocity-tick-x" x="131" y="186"></text><text id="velocity-tick-y" x="61" y="123"></text><text id="velocity-tick-top" x="55" y="73"></text><path id="velocity-completion" stroke="#546680" fill="none" stroke-dasharray="3 4"/><path id="radial-vector" stroke="#f0a58e" fill="none" stroke-width="2.5"/><path id="transverse-vector" stroke="#a7deb1" fill="none" stroke-width="2.5"/><path id="total-vector" stroke="#87d9ff" fill="none" stroke-width="3"/><circle cx="90" cy="170" r="3" fill="#e4edf9"/></svg><figcaption id="velocity-plot-scale"></figcaption></figure><dl class="detail-values"><div><dt>방사 속도 vᵣ</dt><dd data-detail-value="velocity.radialMps" data-factor="0.001" data-unit="km/s"></dd></div><div><dt>횡방향 속도 vθ</dt><dd data-detail-value="velocity.transverseMps" data-factor="0.001" data-unit="km/s"></dd></div><div><dt>전체 속력 |v|</dt><dd data-detail-value="velocity.speedMps" data-factor="0.001" data-unit="km/s"></dd></div><div><dt>횡방향에서 기운 각 γ</dt><dd data-detail-value="velocity.flightPathAngleRad" data-factor="57.29577951308232" data-unit="°"></dd></div></dl></div><p id="radial-motion-note"></p><p class="hint">횡방향은 반지름에 수직인 방향입니다. 타원 궤도의 접선 방향은 두 성분을 합친 전체 속도입니다. 가속도는 항상 태양을 향하지만 속도 방향과는 다를 수 있습니다.</p><button type="button" data-detail-inspect="velocity-vector">3D에서 속도 성분 보기</button></section>
      <section class="phase-detail"><h3>같은 위치를 나타내는 세 각도</h3><div class="anomaly-rows">${[['meanAnomalyRad','M · 시간의 각','균일하게 늘어나는 시간 기준'],['eccentricAnomalyRad','E · 보조원의 각','타원 중심에서 보조원으로'],['trueAnomalyRad','ν · 실제 위치각','태양 초점에서 입자로']].map(([key,label,note])=>`<div class="anomaly-row" data-anomaly="${key}"><div><strong>${label}</strong><b data-detail-value="phase.${key}" data-factor="57.29577951308232" data-unit="°"></b></div><div class="anomaly-track" aria-hidden="true"><i></i></div><small>${note}</small></div>`).join('')}</div><p id="anomaly-note" class="hint"></p><p class="hint">각도 막대는 같은 0–360° 척도입니다. M은 태양에서 바라본 입자 각도가 아닙니다. 모두 한 주기 안의 위치이며 누적 공전 횟수를 뜻하지 않습니다.</p><button type="button" data-detail-inspect="orbit-path">3D에서 각도 구성 보기</button></section></div>
      <details class="orbit-balance"><summary>중력·에너지·각운동량 함께 읽기</summary><div class="detail-values balance-values">${[
        ['태양 방향 가속도','acceleration.magnitudeMps2',1000,'mm/s²'],['특정 운동에너지','energy.kineticJPerKg',.000001,'MJ/kg'],['특정 퍼텐셜에너지','energy.potentialJPerKg',.000001,'MJ/kg'],['특정 총에너지','energy.totalJPerKg',.000001,'MJ/kg'],['특정 각운동량','momentum.specificM2PerS',.000001,'km²/s'],['현재 위치각 속도','phase.trueRateRadPerS',180/Math.PI*DAY,'°/일'],
      ].map(([label,key,factor,unit])=>`<div><dt>${label}</dt><dd data-detail-value="${key}" data-factor="${factor}" data-unit="${unit}"></dd></div>`).join('')}</div><p class="hint">입자 질량을 입력하지 않으므로 에너지는 단위 질량당 값입니다. 퍼텐셜의 0은 무한대이며 결합 궤도의 총에너지는 음수입니다. 3D의 보라색 가속도 화살표는 방향 표식이며 길이가 크기를 뜻하지 않습니다.</p><p id="conservation-note" class="hint"></p></details>
      <details class="orbit-apsides"><summary>가까운 곳·먼 곳과 속력 기준</summary><div class="detail-values balance-values"><div><dt>근일점까지 이번 주기 시간</dt><dd id="time-to-periapsis"></dd></div><div><dt>원일점까지 이번 주기 시간</dt><dd id="time-to-apoapsis"></dd></div><div><dt>현재 반지름의 원궤도 속력</dt><dd data-detail-value="velocity.circularMps" data-factor="0.001" data-unit="km/s"></dd></div><div><dt>현재 반지름의 탈출 속력</dt><dd data-detail-value="velocity.escapeMps" data-factor="0.001" data-unit="km/s"></dd></div></div><p class="hint">해당 위치에 정확히 있으면 남은 시간은 0입니다. 원에는 유일한 근일점·원일점이 없습니다. 속력 기준은 현재 위치의 진단값이며 궤도 변경에 필요한 추력·연료나 실제 탈출 경로를 계산하지 않습니다.</p></details>`;
    root.querySelectorAll('[data-detail-inspect]').forEach(button=>button.addEventListener('click',()=>onInspect(button.dataset.detailInspect)));
  }
  render(snapshot, partId) {
    const d = orbitDetail(snapshot);
    this.root.querySelectorAll('[data-detail-value]').forEach(element=>{
      const [group,key]=element.dataset.detailValue.split('.'), value=d[group][key];
      element.dataset.raw=String(value); element.textContent=`${number(value*Number(element.dataset.factor||1))} ${element.dataset.unit||''}`;
    });
    const radial=d.velocity.radialMps/1000, transverse=d.velocity.transverseMps/1000;
    const axisMax=Math.max(25,Math.ceil(Math.max(Math.abs(radial)*2,transverse)/25)*25), scale=100/axisMax;
    this.root.querySelector('#velocity-tick-x').textContent=number(axisMax/2,1);
    this.root.querySelector('#velocity-tick-y').textContent=number(axisMax/2,1);
    this.root.querySelector('#velocity-tick-top').textContent=number(axisMax,1);
    const caption=this.root.querySelector('#velocity-plot-scale');caption.textContent=`성분 좌표 · 한 눈금 ${number(axisMax/2,1)} km/s · 범위에 맞춰 확대`;caption.dataset.scale=String(scale);
    for(const [id,x,y] of [['radial-vector',radial,0],['transverse-vector',0,-transverse],['total-vector',radial,-transverse]]) {
      const path=this.root.querySelector(`#${id}`);path.setAttribute('d',arrow(90,170,x*scale,y*scale));path.dataset.x=String(x);path.dataset.y=String(y);
    }
    this.root.querySelector('#velocity-completion').setAttribute('d',`M${90+radial*scale} 170V${170-transverse*scale}H90`);
    this.root.querySelector('#radial-motion-note').textContent=radial===0?'방사 속도는 0입니다. 이 순간에는 태양까지 거리가 늘거나 줄지 않습니다.':radial>0?'방사 속도가 양수이므로 태양에서 멀어지고 있습니다.':'방사 속도가 음수이므로 태양에 가까워지고 있습니다.';
    this.root.querySelectorAll('[data-anomaly]').forEach(row=>{const angle=d.phase[row.dataset.anomaly];row.querySelector('i').style.width=`${angle/(2*Math.PI)*100}%`;row.dataset.raw=String(angle);});
    this.root.querySelector('#anomaly-note').textContent=`${snapshot.config.eccentricity===0?'원에서는 세 각도가 같습니다.':'타원에서는 시간 진행률과 실제 위치각의 진행이 다릅니다.'} 현재 M=${number(degrees(d.phase.meanAnomalyRad),2)}°는 한 바퀴 ${number(d.phase.cycleElapsedS/DAY,2)} / ${number(d.phase.periodS/DAY,2)}일에 해당합니다.`;
    this.root.querySelector('#conservation-note').textContent=`같은 궤도에서 총에너지와 각운동량은 일정합니다. 해석 기준과의 상대 잔차: 에너지 ${number(d.energy.relativeResidual,6)}, 각운동량 ${number(d.momentum.relativeResidual,6)}. 반올림 오차를 실제 에너지 손실로 해석하지 않습니다.`;
    for(const [id,key] of [['periapsis','timeToPeriapsisS'],['apoapsis','timeToApoapsisS']]) {
      const value=d.apsides[key],element=this.root.querySelector(`#time-to-${id}`);element.dataset.raw=value===null?'null':String(value);element.textContent=value===null?'원 · 구별 없음':`${number(value/DAY,3)} 일`;
    }
    const description=describeOrbitDetail(partId,snapshot,d);
    this.facts.replaceChildren(...description.facts.map(fact=>{
      const row=document.createElement('div'),term=document.createElement('dt'),value=document.createElement('dd');
      term.textContent=fact.label;value.textContent=`${number(fact.value,fact.digits)}${fact.unit?` ${fact.unit}`:''}`;value.dataset.raw=String(fact.value);row.append(term,value);return row;
    }));this.note.textContent=description.note;return d;
  }
}
