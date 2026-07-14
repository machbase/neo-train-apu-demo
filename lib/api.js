'use strict';

const { Client } = require('machcli');
const path = require('path');
const process = require('process');
function rootDir() {
  const script = path.resolve(String((process.argv || [])[1] || '.'));
  const markers = ['/cgi-bin/', '/app/', '/scripts/'];
  for (let i = 0; i < markers.length; i++) {
    const at = script.indexOf(markers[i]);
    if (at >= 0) return script.slice(0, at);
  }
  return path.dirname(script);
}
const ROOT = rootDir();
const { dbConfig, intArg } = require(path.join(ROOT, 'lib', 'env.js'));
const { TABLES, tableExists } = require(path.join(ROOT, 'lib', 'schema.js'));
const metro = require(path.join(ROOT, 'lib', 'metro.js'));

const SIGNAL_PATHS = {};
for (let i = 0; i < metro.SENSOR_KEYS.length; i++) SIGNAL_PATHS[metro.SENSOR_KEYS[i]] = '$.sensors.' + metro.SENSOR_KEYS[i];
SIGNAL_PATHS.health_score = '$.health.score';
SIGNAL_PATHS.load_duty_1h = '$.features.load_duty_1h';
SIGNAL_PATHS.starts_1h = '$.features.starts_1h';
SIGNAL_PATHS.pressure_decay_bar_min = '$.features.pressure_decay_bar_min';
SIGNAL_PATHS.pressure_recovery_bar_min = '$.features.pressure_recovery_bar_min';

function ApiError(status, message) { this.status = status; this.message = message; this.name = 'ApiError'; }
ApiError.prototype = Object.create(Error.prototype);
function get(row, key) { return row && row[key] != null ? row[key] : row && row[String(key).toUpperCase()]; }
function json(value, fallback) { if (value && typeof value === 'object') return value; try { return JSON.parse(String(value)); } catch (_) { return fallback; } }
function iso(value) { if (value == null) return null; if (value instanceof Date) return value.toISOString(); const t = Date.parse(String(value)); return Number.isFinite(t) ? new Date(t).toISOString() : String(value); }
function queryAll(conn, sql) {
  const params = [];
  for (let i = 2; i < arguments.length; i++) params.push(arguments[i]);
  const rows = params.length ? conn.query(sql, ...params) : conn.query(sql);
  const out = [];
  try { for (const row of rows) out.push(row); } finally { rows && rows.close && rows.close(); }
  return out;
}
function withDb(args, fn) {
  const db = new Client(dbConfig(args || {})); let conn;
  try { conn = db.connect(); return fn(conn); }
  finally { try { conn && conn.close(); } catch (_) {} try { db.close(); } catch (_) {} }
}
function parseTime(value, name) {
  const numeric = Number(value);
  const ms = value != null && value !== '' && Number.isFinite(numeric) ? numeric : Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) throw new ApiError(400, 'Invalid or missing ' + name);
  return new Date(ms);
}
function list(text, fallback) { return String(text || fallback).split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
function jsonPathValue(obj, pathText) {
  const parts = String(pathText || '').replace(/^\$\./, '').split('.');
  let current = obj;
  for (let i = 0; i < parts.length; i++) {
    if (current == null || typeof current !== 'object') return null;
    current = current[parts[i]];
  }
  const value = Number(current);
  return Number.isFinite(value) ? value : null;
}
function evidence(sql, params, rows, started, intervalSec) {
  return { sql: sql, params: params.map(function (v) { return v instanceof Date ? v.toISOString() : v; }), table: TABLES.timeline, rows: rows, queryMs: Date.now() - started, rollupIntervalSec: intervalSec || null };
}
function responseError(err) {
  if (err instanceof ApiError || err && err.name === 'ApiError') return { status: err.status, body: { ok: false, error: err.message } };
  const message = String((err && err.message) || err);
  if (message.toLowerCase().indexOf('exist') >= 0 || message.toLowerCase().indexOf('table') >= 0) return { status: 404, body: { ok: false, setupRequired: true, error: 'MetroPT dataset is not loaded' } };
  return { status: 500, body: { ok: false, error: message } };
}

function health(args) {
  return withDb(args, function (conn) {
    const ready = tableExists(conn, TABLES.timeline);
    return { ok: true, app: 'machbase-neo-metropt-demo', table: TABLES.timeline, ready: ready };
  });
}

function manifest(args) {
  const started = Date.now();
  return withDb(args, function (conn) {
    if (!tableExists(conn, TABLES.timeline)) throw new ApiError(404, 'MetroPT dataset is not loaded');
    const manifestTag = metro.DATASET + '.' + metro.ASSET_ID + '.manifest';
    let sql = `SELECT value FROM ${TABLES.timeline} WHERE name = ? LIMIT 1`;
    let params = [manifestTag];
    let rows = queryAll(conn, sql, ...params);
    const stored = rows.length ? json(get(rows[0], 'value'), {}) : null;
    if (!stored || !stored.telemetry_rows) {
      sql = `SELECT MIN(time) min_time, MAX(time) max_time, COUNT(*) telemetry_rows FROM ${TABLES.timeline} WHERE name = ?`;
      params = [metro.DATASET + '.' + metro.ASSET_ID + '.telemetry'];
      rows = queryAll(conn, sql, ...params);
    }
    const count = Number(stored ? stored.telemetry_rows : get(rows[0], 'telemetry_rows') || 0);
    if (!count) throw new ApiError(404, 'MetroPT dataset is not loaded');
    const eventPlaceholders = metro.EVENT_TAGS.map(function () { return '?'; }).join(', ');
    const eventRows = queryAll.apply(null, [conn, `SELECT time, value FROM ${TABLES.timeline} WHERE name IN (${eventPlaceholders}) ORDER BY time`].concat(metro.EVENT_TAGS));
    const baselineRows = queryAll(conn, `SELECT value FROM ${TABLES.timeline} WHERE name = ? LIMIT 1`, metro.DATASET + '.' + metro.ASSET_ID + '.baseline');
    const events = eventRows.map(function (row) { const p = json(get(row, 'value'), {}); return { time: iso(get(row, 'time')), event: p.event || {} }; });
    const officialTarget = Date.parse('2020-07-15T14:30:00Z');
    let guidedAlert = null;
    for (let i = 0; i < events.length; i++) {
      if (events[i].event.origin === 'derived' && events[i].event.type === 'early_warning' && Date.parse(events[i].time) < officialTarget) guidedAlert = events[i];
    }
    const minTime = stored ? iso(stored.min_time) : iso(get(rows[0], 'min_time'));
    const maxTime = stored ? iso(stored.max_time) : iso(get(rows[0], 'max_time'));
    return {
      ok: true, dataset: metro.DATASET, assetId: metro.ASSET_ID, source: metro.SOURCE,
      table: TABLES.timeline, minTime: minTime, maxTime: maxTime, telemetryRows: count,
      sensorValues: count * metro.SENSOR_KEYS.length, signals: metro.SENSOR_INFO,
      timezone: 'Dataset local time — timezone unspecified', formulaVersion: metro.FORMULA_VERSION,
      baseline: baselineRows.length ? json(get(baselineRows[0], 'value'), {}) : null,
      events: events, guidedAlert: guidedAlert,
      guidedLeadHours: guidedAlert ? Math.round((officialTarget - Date.parse(guidedAlert.time)) / 36000) / 100 : null,
      chapters: [
        { id: 'fleet', time: minTime, title: '1.5 million real operating timestamps' },
        { id: 'baseline', time: '2020-02-12T12:00:00Z', title: 'Learn normal from February' },
        { id: 'drift', time: '2020-07-14T21:00:00Z', title: 'Load begins to drift' },
        { id: 'warning', time: guidedAlert ? guidedAlert.time : '2020-07-15T03:00:00Z', title: 'Explainable early warning' },
        { id: 'failure', time: '2020-07-15T14:30:00Z', title: 'Official air-leak interval' }
      ],
      evidence: evidence(sql, params, [{ minTime: minTime, maxTime: maxTime, telemetryRows: count }], started, null)
    };
  });
}

function frame(args, query) {
  const started = Date.now(); const at = parseTime(query.time, 'time'); const from = new Date(at.getTime() - 60000);
  const seekNext = query.seek === 'next'; const seekPrev = query.seek === 'prev';
  return withDb(args, function (conn) {
    // TAG scan-direction hints avoid sorting the full suffix or prefix for transport controls.
    const sql = seekNext
      ? `SELECT /*+ SCAN_FORWARD(${TABLES.timeline}) */ time, value FROM ${TABLES.timeline} WHERE name = ? AND time >= ? LIMIT 1`
      : seekPrev
        ? `SELECT /*+ SCAN_BACKWARD(${TABLES.timeline}) */ time, value FROM ${TABLES.timeline} WHERE name = ? AND time <= ? LIMIT 1`
        : `SELECT time, value FROM ${TABLES.timeline} WHERE name = ? AND time BETWEEN ? AND ? ORDER BY time DESC LIMIT 1`;
    const params = seekNext || seekPrev
      ? [metro.DATASET + '.' + metro.ASSET_ID + '.telemetry', at]
      : [metro.DATASET + '.' + metro.ASSET_ID + '.telemetry', from, at];
    const rows = queryAll(conn, sql, ...params);
    if (!rows.length) throw new ApiError(404, seekNext ? 'No later telemetry available' : seekPrev ? 'No earlier telemetry available' : 'No telemetry within 60 seconds of requested time');
    const payload = json(get(rows[0], 'value'), {}); const time = iso(get(rows[0], 'time'));
    return { ok: true, time: time, requestedTime: at.toISOString(), skippedGap: (seekNext || seekPrev) && Math.abs(Date.parse(time) - at.getTime()) > 60000, sensors: payload.sensors || {}, features: payload.features || {}, health: payload.health || {}, evidence: evidence(sql, params, [{ time: time, health: payload.health }], started, null) };
  });
}

function windowFrames(args, query) {
  const started = Date.now(); const from = parseTime(query.from, 'from'); const to = parseTime(query.to, 'to');
  if (to <= from) throw new ApiError(400, 'to must be after from');
  const limit = Math.max(2, Math.min(2000, intArg(query.limit, 400)));
  return withDb(args, function (conn) {
    const sql = `SELECT time, value FROM ${TABLES.timeline} WHERE dataset = ? AND asset_id = ? AND value->'$.kind' = 'telemetry' AND time BETWEEN ? AND ? ORDER BY time LIMIT ${limit}`;
    const params = [metro.DATASET, metro.ASSET_ID, from, to]; const rows = queryAll(conn, sql, ...params);
    if (!rows.length) throw new ApiError(404, 'No telemetry in requested window');
    const out = rows.map(function (row) { const p = json(get(row, 'value'), {}); return { time: iso(get(row, 'time')), sensors: p.sensors, features: p.features, health: p.health }; });
    return { ok: true, frames: out, evidence: evidence(sql, params, out.slice(0, 5), started, null) };
  });
}

function signals(args, query) {
  const started = Date.now(); const from = parseTime(query.from, 'from'); const to = parseTime(query.to, 'to');
  if (to <= from) throw new ApiError(400, 'to must be after from');
  const names = list(query.signals, 'reservoirs,motor_current,oil_temperature,health_score').filter(function (name) { return !!SIGNAL_PATHS[name]; });
  if (!names.length) throw new ApiError(400, 'No supported signals requested');
  const limit = Math.max(40, Math.min(5000, intArg(query.limit, 1200)));
  const perSignal = Math.max(10, Math.floor(limit / names.length));
  const interval = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 1000 / perSignal));
  return withDb(args, function (conn) {
    const sql = `SELECT rollup('sec', ${interval}, time) sample_time, AVG(value) avg_value FROM ${TABLES.timeline} WHERE name = ? AND time BETWEEN ? AND ? GROUP BY sample_time ORDER BY sample_time LIMIT ${perSignal}`;
    const params = [metro.DATASET + '.' + metro.ASSET_ID + '.telemetry', from, to];
    const rows = queryAll(conn, sql, ...params);
    const output = [];
    for (let j = 0; j < rows.length; j++) {
      const average = json(get(rows[j], 'avg_value'), {});
      for (let i = 0; i < names.length; i++) {
        const name = names[i]; const value = jsonPathValue(average, SIGNAL_PATHS[name]);
        if (value != null) output.push({ time: iso(get(rows[j], 'sample_time')), signal: name, value: value });
      }
    }
    if (!output.length) throw new ApiError(404, 'No signal values in requested window');
    return { ok: true, signals: output, intervalSec: interval, evidence: evidence(sql, params, output.slice(0, 8), started, interval) };
  });
}

function events(args, query) {
  const started = Date.now(); const from = parseTime(query.from, 'from'); const to = parseTime(query.to, 'to');
  const limit = Math.max(1, Math.min(1000, intArg(query.limit, 200)));
  return withDb(args, function (conn) {
    // Select the small event tag streams directly; JSON kind filtering scans telemetry blocks too.
    const placeholders = metro.EVENT_TAGS.map(function () { return '?'; }).join(', ');
    const sql = `SELECT time, value FROM ${TABLES.timeline} WHERE name IN (${placeholders}) AND time BETWEEN ? AND ? ORDER BY time LIMIT ${limit}`;
    const params = metro.EVENT_TAGS.concat([from, to]); const rows = queryAll(conn, sql, ...params);
    const out = rows.map(function (row) { const p = json(get(row, 'value'), {}); return { time: iso(get(row, 'time')), event: p.event || {} }; });
    return { ok: true, events: out, evidence: evidence(sql, params, out.slice(0, 8), started, null) };
  });
}

module.exports = { ApiError, events, frame, health, manifest, responseError, signals, windowFrames };
