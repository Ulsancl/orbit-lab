import { sampleOrbit, ORBIT_CONSTANTS_SI } from './model.js';
const SVG = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, content) => { const node = document.createElementNS(SVG, name); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); if (content !== undefined) node.textContent = content; return node; };
const fixed = (n, digits = 1) => n.toLocaleString('ko-KR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const colors = { current: '#87d9ff', saved: '#ffc783', grid: '#2a3b55', text: '#99afcb' };
export class OrbitChart {
  constructor(speedContainer, periodContainer) { this.speedContainer = speedContainer; this.periodContainer = periodContainer; this.cache = new Map(); this.debug = null; }
  samples(config) {
    const key = `${config.semiMajorAxisM}/${config.eccentricity}`;
    if (!this.cache.has(key)) { if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value); this.cache.set(key, sampleOrbit(config)); }
    return this.cache.get(key);
  }
  update(current, saved = null, mode = 'both') {
    const w = Math.max(290, this.speedContainer.clientWidth), h = Math.max(200, this.speedContainer.clientHeight), left = 45, right = 14, top = 22, bottom = 38;
    const x = value => left + value * (w - left - right), y = value => h - bottom - value / 150 * (h - top - bottom);
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' });
    for (const value of [0, 50, 100, 150]) { svg.append(el('line', { x1: left, x2: w - right, y1: y(value), y2: y(value), stroke: colors.grid }), el('text', { x: left - 8, y: y(value) + 3, fill: colors.text, 'font-size': 10, 'text-anchor': 'end' }, value)); }
    for (const value of [0, .25, .5, .75, 1]) svg.append(el('text', { x: x(value), y: h - 18, fill: colors.text, 'font-size': 10, 'text-anchor': 'middle' }, `${value * 100}%`));
    svg.append(el('text', { x: left, y: 11, fill: colors.text, 'font-size': 10 }, 'km/s'), el('text', { x: w - right, y: h - 1, fill: colors.text, 'font-size': 9, 'text-anchor': 'end' }, '한 바퀴의 시간 진행률 t/T'));
    const series = [];
    const draw = (snapshot, kind) => {
      if (!snapshot || (mode !== 'both' && mode !== kind)) return;
      const samples = this.samples(snapshot.config);
      const points = samples.map(point => ({ progress: point.progress, speedKmS: point.speedMps / 1000, x: x(point.progress), y: y(point.speedMps / 1000) }));
      const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' ');
      svg.append(el('path', { d: path, fill: 'none', stroke: colors[kind], 'stroke-width': 2, ...(kind === 'saved' ? { 'stroke-dasharray': '6 5' } : {}), 'data-series': kind }));
      const progress = snapshot.meanAnomalyRad / (2 * Math.PI), speedKmS = snapshot.speedMps / 1000, px = x(progress), py = y(speedKmS);
      const marker = kind === 'saved' ? el('path', { d: `M${px},${py - 5} l5,5 l-5,5 l-5,-5 Z`, fill: colors[kind], stroke: '#101a2f', 'stroke-width': 1.5, 'data-marker': kind }) : el('circle', { cx: px, cy: py, r: 4.5, fill: colors[kind], stroke: '#101a2f', 'stroke-width': 1.5, 'data-marker': kind });
      svg.append(marker); series.push({ kind, path, points, marker: { progress, speedKmS, x: px, y: py } });
    };
    draw(saved, 'saved'); draw(current, 'current'); this.speedContainer.replaceChildren(svg);
    const pw = Math.max(290, this.periodContainer.clientWidth), ph = 90, barLeft = 44, barRight = 65, axisWidth = pw - barLeft - barRight;
    const psvg = el('svg', { viewBox: `0 0 ${pw} ${ph}`, 'aria-hidden': 'true' }), bars = [];
    for (const value of [0, 550, 1100]) { const xx = barLeft + axisWidth * value / 1100; psvg.append(el('line', { x1: xx, x2: xx, y1: 8, y2: 64, stroke: colors.grid }), el('text', { x: xx, y: 82, fill: colors.text, 'font-size': 10, 'text-anchor': 'middle' }, `${value}일`)); }
    for (const [kind, snapshot, yy, label] of [['current', current, 13, '현재'], ['saved', saved, 42, '보관']]) {
      if (!snapshot || (mode !== 'both' && mode !== kind)) continue;
      const days = snapshot.periodS / ORBIT_CONSTANTS_SI.dayS, width = axisWidth * days / 1100;
      psvg.append(el('text', { x: barLeft - 8, y: yy + 12, fill: colors[kind], 'font-size': 10, 'text-anchor': 'end' }, label), el('rect', { x: barLeft, y: yy, width, height: 16, rx: 3, fill: colors[kind], opacity: .8, 'data-period': kind }), el('text', { x: barLeft + width + 6, y: yy + 12, fill: colors[kind], 'font-size': 10 }, fixed(days)));
      bars.push({ kind, days, width, axisWidth });
    }
    this.periodContainer.replaceChildren(psvg);
    this.debug = { mode, speedAxisKmS: [0, 150], progressAxis: [0, 1], periodAxisDays: [0, 1100], series, bars };
  }
}
