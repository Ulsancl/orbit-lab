import { sampleOrbit, ORBIT_CONSTANTS_SI } from './model.js';
import './chart.css';

const SVG = 'http://www.w3.org/2000/svg';
const TAU = 2 * Math.PI;
const { astronomicalUnitM: AU, dayS: DAY } = ORBIT_CONSTANTS_SI;
const colors = { current: '#87d9ff', saved: '#ffc783', grid: '#2a3b55', text: '#99afcb' };
const labels = { current: '현재', saved: '보관' };
const formats = new Map([0, 1, 2, 3].map(digits => [digits, new Intl.NumberFormat('ko-KR', {
  maximumFractionDigits: digits, minimumFractionDigits: digits,
})]));
const fixed = (number, digits) => formats.get(digits).format(number);

const plots = {
  speed: { key: 'speedKmS', value: point => point.speedMps / 1000, unit: 'km/s', label: '속력' },
  radius: { key: 'radiusAU', value: point => point.radiusM / AU, unit: 'AU', label: '중심체까지 거리' },
};

function el(name, attrs = {}, content) {
  const node = document.createElementNS(SVG, name);
  setAttributes(node, attrs);
  if (content !== undefined) node.textContent = content;
  return node;
}

function setAttributes(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function configKey({ semiMajorAxisM, eccentricity, centralMassSolar = 1 }) {
  return `${semiMajorAxisM}/${eccentricity}/${centralMassSolar}`;
}

function progressOf(snapshot) {
  return snapshot.meanAnomalyRad / TAU;
}

function apsisCross({ x, y }) {
  return `M${x - 6},${y}H${x + 6}M${x},${y - 6}V${y + 6}`;
}

class PhasePlot {
  constructor(container, plot) {
    this.container = container;
    this.plot = plot;
    this.viewKey = '';
  }

  update(entries, max, ticks, getSamples) {
    const w = Math.max(240, this.container.clientWidth), h = Math.max(170, this.container.clientHeight);
    const viewKey = JSON.stringify([w, h, max, entries.map(({ kind, key }) => [kind, key])]);
    if (this.viewKey !== viewKey) {
      this.build(entries, w, h, max, ticks, getSamples);
      this.viewKey = viewKey;
    }

    return entries.map(({ snapshot }, index) => {
      const { node, data } = this.series[index];
      const progress = progressOf(snapshot), value = this.plot.value(snapshot);
      const x = this.x(progress), y = this.y(value);
      if (data.marker?.progress !== progress) {
        setAttributes(node, data.kind === 'current' ? { cx: x, cy: y }
          : { d: `M${x},${y - 8} l8,8 l-8,8 l-8,-8 Z` });
        data.marker = { progress, [this.plot.key]: value, x, y };
      }
      return data;
    });
  }

  build(entries, w, h, max, ticks, getSamples) {
    const { key, unit, value, label } = this.plot;
    const left = 40, right = 18, top = 23, bottom = 37;
    const x = progress => left + progress * (w - left - right);
    const y = reading => h - bottom - reading / max * (h - top - bottom);
    this.x = x;
    this.y = y;
    this.container.setAttribute('aria-label', `시간 진행률에 따른 ${label}, 세로 축 0에서 ${max} ${unit}`);
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' });
    for (const reading of ticks) {
      svg.append(
        el('line', { x1: left, x2: w - right, y1: y(reading), y2: y(reading), stroke: colors.grid }),
        el('text', { x: left - 8, y: y(reading) + 3, fill: colors.text, 'font-size': 10, 'text-anchor': 'end' }, reading),
      );
    }
    for (const fraction of [0, .25, .5, .75, 1]) {
      svg.append(el('text', { x: x(fraction), y: h - 19, fill: colors.text, 'font-size': 10, 'text-anchor': 'middle' }, `${fraction * 100}%`));
    }
    svg.append(
      el('text', { x: left, y: 11, fill: colors.text, 'font-size': 10 }, unit),
      el('text', { x: w - right, y: h - 3, fill: colors.text, 'font-size': 10, 'text-anchor': 'end' }, '한 바퀴의 시간 진행률 t/T'),
    );

    if (entries.some(({ snapshot }) => snapshot.config.eccentricity !== 0)) {
      for (const fraction of [0, .5, 1]) {
        svg.append(el('line', { x1: x(fraction), x2: x(fraction), y1: top, y2: h - bottom,
          stroke: '#627d9f', 'stroke-dasharray': '2 4' }));
      }
    }

    const crosses = [];
    this.series = entries.map(({ kind, snapshot }) => {
      const samples = getSamples(snapshot.config);
      const points = samples.map(point => {
        const reading = value(point);
        return { progress: point.progress, [key]: reading, x: x(point.progress), y: y(reading) };
      });
      const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' ');
      const stroke = colors[kind];
      svg.append(el('path', { d: path, fill: 'none', stroke, 'stroke-width': 2,
        ...(kind === 'saved' ? { 'stroke-dasharray': '6 5' } : {}), 'data-series': kind }));

      const apsides = [];
      if (snapshot.config.eccentricity !== 0) {
        for (const [index, name] of [[0, 'periapsis'], [(samples.length - 1) / 2, 'apoapsis'], [samples.length - 1, 'periapsis']]) {
          const point = { ...points[index], name, days: samples[index].offsetTimeS / DAY };
          apsides.push(point);
          crosses.push(el('path', { d: apsisCross(point), fill: 'none', stroke, 'stroke-width': 1.4,
            'data-apsis': name, 'data-orbit': kind }));
        }
      }
      const node = kind === 'current'
        ? el('circle', { r: 4.5, fill: stroke, stroke: '#101a2f', 'stroke-width': 1.5, 'data-marker': kind })
        : el('path', { fill: 'none', stroke, 'stroke-width': 1.8, 'data-marker': kind });
      return { node, data: { kind, path, points, apsides } };
    });
    // The saved dashes leave the solid line visible where their curves coincide.
    svg.append(...crosses, ...this.series.map(({ node }) => node));
    this.container.replaceChildren(svg);
  }
}

function makeReadout(kind) {
  const item = document.createElement('div');
  item.className = `chart-readout ${kind}-key`;
  item.dataset.chartReadout = kind;
  const term = document.createElement('dt');
  term.textContent = kind === 'current' ? '현재 재생 위치' : '보관한 위치';
  const phase = document.createElement('dd'), motion = document.createElement('dd'), apsides = document.createElement('dd');
  phase.className = 'chart-readout-phase';
  apsides.className = 'chart-visually-hidden';
  item.append(term, phase, motion, apsides);
  return { item, phase, motion, apsides };
}

function describeApsides(snapshot) {
  const format = (radius, speed) => `${fixed(radius / AU, 3)} AU · ${fixed(speed / 1000, 2)} km/s`;
  if (snapshot.config.eccentricity === 0) return '원 궤도에서는 거리와 속력이 일정합니다.';
  return `근일점 ${format(snapshot.periapsisM, snapshot.periapsisSpeedMps)}, 원일점 ${format(snapshot.apoapsisM, snapshot.apoapsisSpeedMps)}`;
}

export class OrbitChart {
  constructor(speedContainer, periodContainer) {
    this.cache = new Map();
    this.debug = null;
    this.periodContainer = periodContainer;
    this.periodKey = '';
    this.speed = new PhasePlot(speedContainer, plots.speed);

    const radius = document.createElement('div');
    radius.className = 'kinematics-radius';
    const title = document.createElement('h3');
    title.textContent = '한 바퀴 동안 중심체까지 거리';
    const radiusContainer = document.createElement('div');
    radiusContainer.id = 'radius-chart';
    radiusContainer.className = 'chart';
    radiusContainer.setAttribute('role', 'img');
    radius.append(title, radiusContainer);
    this.radius = new PhasePlot(radiusContainer, plots.radius);

    this.markerKey = document.createElement('p');
    this.markerKey.className = 'chart-apsis-key';
    this.markerKey.textContent = '십자 표식 · 타원 궤도의 근일점 0%·100%, 원일점 50%';
    const readouts = document.createElement('dl');
    readouts.className = 'chart-readouts';
    this.readouts = { current: makeReadout('current'), saved: makeReadout('saved') };
    readouts.append(this.readouts.current.item, this.readouts.saved.item);
    const distanceDetails = document.createElement('details');
    distanceDetails.className = 'distance-disclosure';
    distanceDetails.dataset.mobileDisclosure = '';
    distanceDetails.open = true;
    const summary = document.createElement('summary');
    summary.className = 'mobile-summary';
    summary.textContent = '거리 그래프와 관찰 수치';
    distanceDetails.append(summary, radius, this.markerKey, readouts);
    speedContainer.after(distanceDetails);

    this.periodSummary = document.createElement('span');
    this.periodSummary.id = 'chart-period-summary';
    this.periodSummary.className = 'chart-visually-hidden';
    periodContainer.after(this.periodSummary);
    periodContainer.setAttribute('aria-describedby', this.periodSummary.id);
  }

  samples(config) {
    const key = configKey(config);
    if (!this.cache.has(key)) {
      if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, sampleOrbit(config));
    }
    return this.cache.get(key);
  }

  update(current, saved = null, mode = 'both') {
    const available = [['current', current], ['saved', saved]].filter(([, snapshot]) => snapshot);
    const entries = available.filter(([kind]) => mode === 'both' || mode === kind)
      .map(([kind, snapshot]) => ({ kind, snapshot, key: configKey(snapshot.config) }));
    // Use both orbits for the axis limits even when one series is hidden.
    const peakSpeed = Math.max(...available.map(([, snapshot]) => snapshot.periapsisSpeedMps / 1000));
    const longestPeriod = Math.max(...available.map(([, snapshot]) => snapshot.periodS / DAY));
    const speedMax = Math.max(150, Math.ceil(peakSpeed / 50) * 50);
    const periodMax = longestPeriod <= 1100 ? 1100 : Math.ceil(longestPeriod / 200) * 200;
    const speedStep = speedMax >= 300 ? 100 : 50;
    const speedTicks = Array.from({ length: speedMax / speedStep + 1 }, (_, index) => index * speedStep);
    const getSamples = config => this.samples(config);
    const series = this.speed.update(entries, speedMax, speedTicks, getSamples);
    const radiusSeries = this.radius.update(entries, 4, [0, 1, 2, 3, 4], getSamples);

    this.markerKey.hidden = !entries.some(({ snapshot }) => snapshot.config.eccentricity !== 0);
    for (const [kind, readout] of Object.entries(this.readouts)) {
      const { item, phase, motion, apsides } = readout;
      const entry = entries.find(item => item.kind === kind);
      item.hidden = !entry;
      if (!entry) continue;
      const { snapshot } = entry;
      setText(phase, `${fixed(progressOf(snapshot) * 100, 1)}% · ${fixed(snapshot.timeSinceReferenceS / DAY, 2)}일 경과`);
      setText(motion, `${fixed(plots.radius.value(snapshot), 3)} AU · ${fixed(plots.speed.value(snapshot), 2)} km/s`);
      if (readout.key !== entry.key) {
        apsides.textContent = describeApsides(snapshot);
        readout.key = entry.key;
      }
    }

    const bars = this.updatePeriods(entries, periodMax);
    this.debug = { mode, progressAxis: [0, 1], speedAxisKmS: [0, speedMax], radiusAxisAU: [0, 4],
      periodAxisDays: [0, periodMax], series, radiusSeries, bars };
  }

  updatePeriods(entries, max) {
    const w = Math.max(240, this.periodContainer.clientWidth), h = 90;
    const key = JSON.stringify([w, max, entries.map(({ kind, snapshot }) => [kind, snapshot.periodS])]);
    if (key === this.periodKey) return this.bars;
    const barLeft = 44, barRight = 64, axisWidth = w - barLeft - barRight;
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' }), bars = [];
    for (const value of [0, max / 2, max]) {
      const x = barLeft + axisWidth * value / max;
      svg.append(
        el('line', { x1: x, x2: x, y1: 8, y2: 64, stroke: colors.grid }),
        el('text', { x, y: 82, fill: colors.text, 'font-size': 10, 'text-anchor': 'middle' }, `${fixed(value, 0)}일`),
      );
    }
    for (const { kind, snapshot } of entries) {
      const days = snapshot.periodS / DAY, width = axisWidth * days / max;
      const y = kind === 'current' ? 13 : 42;
      svg.append(
        el('text', { x: barLeft - 8, y: y + 12, fill: colors[kind], 'font-size': 10, 'text-anchor': 'end' }, labels[kind]),
        el('rect', { x: barLeft, y, width, height: 16, rx: 3, fill: colors[kind], opacity: .8, 'data-period': kind }),
        el('text', { x: barLeft + width + 6, y: y + 12, fill: colors[kind], 'font-size': 10 }, `${fixed(days, 2)}일`),
      );
      bars.push({ kind, days, width, axisWidth });
    }
    this.periodContainer.setAttribute('aria-label', `공전 주기 비교, 공통 축 0에서 ${max}일`);
    this.periodSummary.textContent = bars.map(({ kind, days }) => `${labels[kind]} 궤도 ${fixed(days, 2)}일`).join(', ');
    this.periodContainer.replaceChildren(svg);
    this.periodKey = key;
    this.bars = bars;
    return bars;
  }
}
