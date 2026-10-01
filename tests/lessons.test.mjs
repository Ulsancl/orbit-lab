import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuide, lessonReady, confirmObservation, guideText } from '../src/lessons.js';
const AU = 149597870700;
const experiment = (a, e, progress = 0) => ({ config: { semiMajorAxisM: a * AU, eccentricity: e }, meanAnomalyRad: progress * 2 * Math.PI });
const view = { equalAreas: false };
test('period guide requires two real paused conditions and stores detached observations', () => {
  const guide = createGuide('period'), first = experiment(1, 0);
  assert.equal(lessonReady(guide, first, view, true), false);
  assert.equal(confirmObservation(guide, first, view), true);
  assert.equal(confirmObservation(guide, first, view), false);
  first.config.semiMajorAxisM = 2 * AU;
  assert.equal(guide.evidence[0].experiment.config.semiMajorAxisM, AU);
  assert.equal(confirmObservation(guide, first, view), true);
  assert.equal(guide.status, 'completed');
  assert.ok(Math.abs(guide.evidence[0].periodDays - 365.2568983272364) < 1e-9);
  assert.ok(Math.abs(guide.evidence[1].periodDays / guide.evidence[0].periodDays - Math.sqrt(8)) < 1e-12);
  assert.equal(confirmObservation(guide, first, view), false);
  assert.match(guideText(guide).result, /2.83/);
});
test('speed guide requires the circular baseline, periapsis and apoapsis', () => {
  const guide = createGuide('speed');
  assert.equal(confirmObservation(guide, experiment(1, .6), view), false);
  assert.equal(confirmObservation(guide, experiment(1, 0), view), true);
  assert.equal(confirmObservation(guide, experiment(1, .6), view), true);
  assert.equal(confirmObservation(guide, experiment(1, .6, .25), view), false);
  assert.equal(confirmObservation(guide, experiment(1, .6, .5), view), true);
  assert.ok(Math.abs(guide.evidence[0].speedKmS - 29.784691834309108) < 1e-12);
  assert.ok(Math.abs(guide.evidence[1].speedKmS / guide.evidence[2].speedKmS - 4) < 1e-12);
  assert.equal(new Set(guide.evidence.map(item => item.periodDays)).size, 1);
});
test('area guide records equal analytic curved areas only with the layer visible', () => {
  const guide = createGuide('area'), visible = { equalAreas: true };
  assert.equal(confirmObservation(guide, experiment(1, .6), view), false);
  assert.equal(confirmObservation(guide, experiment(1, .6), visible), true);
  assert.equal(confirmObservation(guide, experiment(1, .6, .5), view), false);
  assert.equal(confirmObservation(guide, experiment(1, .6, .5), visible, true), false);
  assert.equal(confirmObservation(guide, experiment(1, .6, .5), visible), true);
  for (const evidence of guide.evidence) for (const area of evidence.areas) {
    assert.ok(Math.abs(area.areaAU2 - Math.PI * .8 / 12) < 1e-14);
    assert.ok(Math.abs(area.durationDays - 365.2568983272364 / 12) < 1e-10);
  }
  assert.equal(guide.evidence.length, 2);
});
test('invalid and inactive guides cannot silently complete', () => {
  assert.throws(() => createGuide('constructor'), RangeError);
  assert.throws(() => createGuide('unknown'), RangeError);
  assert.equal(lessonReady(null, experiment(1, 0), view), false);
  assert.equal(lessonReady({ id: 'unknown', status: 'active', stage: 0 }, experiment(1, 0), view), false);
});
