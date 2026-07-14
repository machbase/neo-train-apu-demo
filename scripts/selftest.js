'use strict';

const path = require('path');
const process = require('process');
const ROOT = path.dirname(path.dirname(path.resolve(process.argv[1])));
const metro = require(path.join(ROOT, 'lib', 'metro.js'));

function assert(ok, message) { if (!ok) throw new Error('selftest: ' + message); }
function near(actual, expected, tolerance, message) { assert(Math.abs(actual - expected) <= tolerance, message + ' (' + actual + ')'); }

const parsed = metro.parseDatasetTime('2020-07-15 14:30:00');
assert(parsed.getTime() === Date.UTC(2020, 6, 15, 14, 30, 0), 'deterministic timestamp');
assert(metro.formatDatasetTime(parsed) === '2020-07-15 14:30:00', 'timestamp round trip');
near(metro.quantile([0, 10, 20, 30, 40], 0.5), 20, 0.0001, 'median');

const rolling = new metro.RollingFeatures();
let features;
for (let i = 0; i <= 360; i++) {
  features = rolling.push(i * 10000, { comp: i % 20 < 10 ? 1 : 0, reservoirs: 8 + (i % 20 < 10 ? i % 10 : 20 - i % 20) * 0.01 });
}
assert(features.ready, 'rolling window readiness');
assert(features.load_duty_1h > 45 && features.load_duty_1h < 55, 'actual-time duty');
features = rolling.push(4000000, { comp: 0, reservoirs: 8 });
assert(!features.ready, 'gap resets rolling state');

const baseline = {
  load_duty_1h: { p05: 4, p50: 6, p95: 8 }, starts_1h: { p05: 3, p50: 5, p95: 7 },
  pressure_decay_bar_min: { p05: 0.03, p50: 0.06, p95: 0.09 },
  pressure_recovery_bar_min: { p05: 0.3, p50: 0.5, p95: 0.7 }
};
const health = metro.scoreHealth({ ready: true, load_duty_1h: 40, starts_1h: 20, pressure_decay_bar_min: 0.5, pressure_recovery_bar_min: 0.05 }, baseline);
assert(health.score < 30 && health.abnormal === 4, 'transparent critical score');

const detector = new metro.EventDetector();
let events = [];
for (let h = 0; h <= 4; h++) events = events.concat(detector.push(h * 3600000, { score: 45, abnormal: 2 }));
assert(events.length === 1 && events[0].type === 'early_warning', 'three-hour persistence');

console.println(JSON.stringify({ ok: true, tests: 8, formula: metro.FORMULA_VERSION }, null, 2));

