'use strict';

const DATASET = 'metropt-3-uci-791';
const ASSET_ID = 'apu-01';
const SOURCE = 'uci';
const FORMULA_VERSION = 'metro-health-v1';
const SENSOR_KEYS = [
  'tp2', 'tp3', 'h1', 'dv_pressure', 'reservoirs', 'oil_temperature', 'motor_current',
  'comp', 'dv_electric', 'towers', 'mpg', 'lps', 'pressure_switch', 'oil_level', 'flow_impulse'
];
const SENSOR_INFO = {
  tp2: ['TP2', 'bar'], tp3: ['TP3', 'bar'], h1: ['H1', 'bar'], dv_pressure: ['DV pressure', 'bar'],
  reservoirs: ['Reservoirs', 'bar'], oil_temperature: ['Oil temperature', '°C'], motor_current: ['Motor current', 'A'],
  comp: ['Compressor load', 'state'], dv_electric: ['Drain valve', 'state'], towers: ['Dryer towers', 'state'],
  mpg: ['Motor pressure', 'state'], lps: ['Low pressure', 'state'], pressure_switch: ['Pressure switch', 'state'],
  oil_level: ['Oil level', 'state'], flow_impulse: ['Flow impulse', 'state'], health_score: ['Health score', '%'],
  load_duty_1h: ['Load duty · 1h', '%'], starts_1h: ['Starts · 1h', 'count'],
  pressure_decay_bar_min: ['Pressure decay', 'bar/min'], pressure_recovery_bar_min: ['Pressure recovery', 'bar/min']
};

const OFFICIAL_EVENTS = [
  { start: '2020-04-18 00:00:00', end: '2020-04-18 23:59:59', label: 'Air leak · high stress' },
  { start: '2020-05-29 23:30:00', end: '2020-05-30 06:00:00', label: 'Air leak' },
  { start: '2020-06-05 10:00:00', end: '2020-06-07 14:30:00', label: 'Air leak' },
  { start: '2020-07-15 14:30:00', end: '2020-07-15 19:00:00', label: 'Air leak' }
];
const EVENT_TAGS = [
  DATASET + '.' + ASSET_ID + '.event.official.air_leak',
  DATASET + '.' + ASSET_ID + '.event.derived.early_warning',
  DATASET + '.' + ASSET_ID + '.event.derived.critical_condition',
  DATASET + '.' + ASSET_ID + '.event.derived.recovery'
];

function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function pad2(n) { return n < 10 ? '0' + n : String(n); }

// MetroPT does not publish a timezone. UTC arithmetic keeps source clock values deterministic.
function parseDatasetTime(text) {
  if (text instanceof Date) return new Date(text.getTime());
  const m = String(text || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error('Invalid MetroPT timestamp: ' + text);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

function formatDatasetTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
    pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}

function quantile(values, q) {
  if (!values || values.length === 0) return null;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function baselineFromSamples(samples) {
  const keys = ['load_duty_1h', 'starts_1h', 'pressure_decay_bar_min', 'pressure_recovery_bar_min'];
  const out = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const values = [];
    for (let j = 0; j < samples.length; j++) {
      const value = Number(samples[j][key]);
      if (Number.isFinite(value)) values.push(value);
    }
    out[key] = { p05: quantile(values, 0.05), p50: quantile(values, 0.50), p95: quantile(values, 0.95), count: values.length };
  }
  return out;
}

function highRisk(value, stats) {
  if (!stats || !Number.isFinite(value) || !Number.isFinite(stats.p95) || !Number.isFinite(stats.p50)) return 0;
  return clamp((value - stats.p95) / Math.max(3 * (stats.p95 - stats.p50), 0.000001), 0, 1);
}

function lowRisk(value, stats) {
  if (!stats || !Number.isFinite(value) || !Number.isFinite(stats.p05) || !Number.isFinite(stats.p50)) return 0;
  return clamp((stats.p05 - value) / Math.max(3 * (stats.p50 - stats.p05), 0.000001), 0, 1);
}

function scoreHealth(features, baseline) {
  if (!features || !features.ready || !baseline) return { score: null, level: 'unknown', abnormal: 0, risks: {} };
  const risks = {
    pressure_decay: highRisk(features.pressure_decay_bar_min, baseline.pressure_decay_bar_min),
    pressure_recovery: lowRisk(features.pressure_recovery_bar_min, baseline.pressure_recovery_bar_min),
    starts: highRisk(features.starts_1h, baseline.starts_1h),
    load_duty: highRisk(features.load_duty_1h, baseline.load_duty_1h)
  };
  const score = 100 * (1 - risks.pressure_decay * 0.40 - risks.pressure_recovery * 0.25 - risks.starts * 0.20 - risks.load_duty * 0.15);
  let abnormal = 0;
  for (const key in risks) if (risks[key] > 0) abnormal++;
  return { score: Math.round(score * 10) / 10, level: score < 30 ? 'critical' : score < 60 ? 'degraded' : 'normal', abnormal: abnormal, risks: risks };
}

function RollingFeatures(windowMs) {
  this.windowMs = windowMs || 3600000;
  this.queue = [];
  this.prev = null;
  this.totals = { duration: 0, load: 0, starts: 0, decayAmount: 0, decayTime: 0, recoveryAmount: 0, recoveryTime: 0 };
}

RollingFeatures.prototype.reset = function () {
  this.queue = [];
  this.prev = null;
  this.totals = { duration: 0, load: 0, starts: 0, decayAmount: 0, decayTime: 0, recoveryAmount: 0, recoveryTime: 0 };
};

RollingFeatures.prototype.push = function (timeMs, sensors) {
  if (this.prev && (timeMs <= this.prev.time || timeMs - this.prev.time > 120000)) this.reset();
  if (this.prev) {
    const dt = (timeMs - this.prev.time) / 1000;
    // MetroPT digital compressor status is active-low: COMP=0 coincides with motor load.
    const loaded = Number(this.prev.sensors.comp) === 0 ? 1 : 0;
    const start = loaded && Number(this.prev.prevComp) !== 0 ? 1 : 0;
    const delta = Number(sensors.reservoirs) - Number(this.prev.sensors.reservoirs);
    const item = { end: timeMs, duration: dt, load: loaded * dt, starts: start, decayAmount: 0, decayTime: 0, recoveryAmount: 0, recoveryTime: 0 };
    if (!loaded && delta < 0) { item.decayAmount = -delta; item.decayTime = dt; }
    if (loaded && delta > 0) { item.recoveryAmount = delta; item.recoveryTime = dt; }
    this.queue.push(item);
    for (const key in this.totals) this.totals[key] += item[key] || 0;
  }
  const previousComp = this.prev ? this.prev.sensors.comp : 0;
  this.prev = { time: timeMs, sensors: sensors, prevComp: previousComp };
  const cutoff = timeMs - this.windowMs;
  while (this.queue.length && this.queue[0].end <= cutoff) {
    const old = this.queue.shift();
    for (const key in this.totals) this.totals[key] -= old[key] || 0;
  }
  const t = this.totals;
  const ready = t.duration >= 2700;
  return {
    ready: ready,
    coverage_sec: Math.round(t.duration),
    load_duty_1h: ready ? t.load / Math.max(t.duration, 1) * 100 : null,
    starts_1h: ready ? t.starts : null,
    pressure_decay_bar_min: ready && t.decayTime > 0 ? t.decayAmount / t.decayTime * 60 : null,
    pressure_recovery_bar_min: ready && t.recoveryTime > 0 ? t.recoveryAmount / t.recoveryTime * 60 : null
  };
};

function EventDetector() { this.reset(); }
EventDetector.prototype.reset = function () { this.warningSince = null; this.criticalSince = null; this.recoverySince = null; this.active = false; };
EventDetector.prototype.push = function (timeMs, health) {
  const events = [];
  const warning = health && health.score != null && health.score < 60 && health.abnormal >= 2;
  const critical = health && health.score != null && health.score < 30 && health.abnormal >= 3;
  if (warning) { if (this.warningSince == null) this.warningSince = timeMs; }
  else this.warningSince = null;
  if (critical) { if (this.criticalSince == null) this.criticalSince = timeMs; }
  else this.criticalSince = null;
  if (!this.active && this.warningSince != null && timeMs - this.warningSince >= 3 * 3600000) {
    events.push({ type: 'early_warning', severity: 'warning', started: this.warningSince }); this.active = true;
  }
  if (this.active && this.criticalSince != null && timeMs - this.criticalSince >= 3600000) {
    events.push({ type: 'critical_condition', severity: 'critical', started: this.criticalSince }); this.criticalSince = null;
  }
  if (this.active && health && health.score >= 70) {
    if (this.recoverySince == null) this.recoverySince = timeMs;
    if (timeMs - this.recoverySince >= 3 * 3600000) {
      events.push({ type: 'recovery', severity: 'info', started: this.recoverySince }); this.reset();
    }
  } else this.recoverySince = null;
  return events;
};

module.exports = {
  ASSET_ID, DATASET, EVENT_TAGS, FORMULA_VERSION, OFFICIAL_EVENTS, SENSOR_INFO, SENSOR_KEYS, SOURCE,
  EventDetector, RollingFeatures, baselineFromSamples, clamp, formatDatasetTime, parseDatasetTime,
  quantile, scoreHealth
};
