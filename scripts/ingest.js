'use strict';

const fs = require('fs');
const parser = require('parser');
const path = require('path');
const process = require('process');
const { Client } = require('machcli');
const ROOT = path.dirname(path.dirname(path.resolve(process.argv[1])));
const { boolArg, dbConfig, parseArgs } = require(path.join(ROOT, 'lib', 'env.js'));
const { dropSchema, ensureSchema, TABLES } = require(path.join(ROOT, 'lib', 'schema.js'));
const metro = require(path.join(ROOT, 'lib', 'metro.js'));

function close(obj) { try { obj && obj.close && obj.close(); } catch (_) {} }
function value(row, key) { const n = Number(row[key]); return Number.isFinite(n) ? n : null; }
function append(appender, name, time, payload) {
  appender.append(name, time, JSON.stringify(payload), metro.DATASET, metro.ASSET_ID, metro.SOURCE);
}
function existingRows(conn) {
  const rows = conn.query(`SELECT row_count FROM V$${TABLES.timeline}_STAT WHERE name = ?`, metro.DATASET + '.' + metro.ASSET_ID + '.telemetry');
  try { for (const row of rows) return Number(row.ROW_COUNT != null ? row.ROW_COUNT : row.row_count) || 0; }
  finally { close(rows); }
  return 0;
}

function main() {
  const args = parseArgs(process.argv);
  const reset = boolArg(args.reset, false);
  const dataRoot = path.resolve(args.dataRoot || args['data-root'] || path.join(ROOT, 'data', 'raw', 'metropt-3'));
  const csvFile = path.resolve(args.csv || path.join(dataRoot, 'MetroPT3(AirCompressor).csv'));
  if (!fs.existsSync(csvFile)) throw new Error('MetroPT CSV not found: ' + csvFile + '. Run scripts/download-data.js for verified download commands.');

  const db = new Client(dbConfig(args));
  let conn;
  let appender;
  let decoder;
  let input;
  let failed = null;
  const rolling = new metro.RollingFeatures();
  const detector = new metro.EventDetector();
  const baselineSamples = [];
  const febEnd = metro.parseDatasetTime('2020-03-01 00:00:00').getTime();
  let baseline = null;
  let nextBaselineHour = metro.parseDatasetTime('2020-02-01 01:00:00').getTime();
  let count = 0;
  let derivedCount = 0;
  let minTime = null;
  let maxTime = null;

  try {
    conn = db.connect();
    if (reset) dropSchema(conn);
    ensureSchema(conn);
    const current = existingRows(conn);
    if (current > 0) throw new Error('Dataset already contains ' + current + ' telemetry rows. Re-run with --reset only when replacement is intentional.');
    appender = conn.append(TABLES.timeline);
    decoder = parser.csv({ headers: true, strict: true });
    input = fs.createReadStream(csvFile);

    decoder.on('data', function (row) {
      if (failed) return;
      try {
        const time = metro.parseDatasetTime(row.timestamp);
        const timeMs = time.getTime();
        const sensors = {
          tp2: value(row, 'TP2'), tp3: value(row, 'TP3'), h1: value(row, 'H1'),
          dv_pressure: value(row, 'DV_pressure'), reservoirs: value(row, 'Reservoirs'),
          oil_temperature: value(row, 'Oil_temperature'), motor_current: value(row, 'Motor_current'),
          comp: value(row, 'COMP'), dv_electric: value(row, 'DV_eletric'), towers: value(row, 'Towers'),
          mpg: value(row, 'MPG'), lps: value(row, 'LPS'), pressure_switch: value(row, 'Pressure_switch'),
          oil_level: value(row, 'Oil_level'), flow_impulse: value(row, 'Caudal_impulses')
        };
        const features = rolling.push(timeMs, sensors);
        if (timeMs < febEnd && features.ready && timeMs >= nextBaselineHour) {
          baselineSamples.push(features);
          nextBaselineHour += 3600000;
        }
        if (!baseline && timeMs >= febEnd) baseline = metro.baselineFromSamples(baselineSamples);
        const health = timeMs < febEnd
          ? { score: 100, level: 'baseline', abnormal: 0, risks: {} }
          : metro.scoreHealth(features, baseline);
        append(appender, metro.DATASET + '.' + metro.ASSET_ID + '.telemetry', time, {
          kind: 'telemetry', sensors: sensors, features: features,
          health: health, formula_version: metro.FORMULA_VERSION
        });

        const events = timeMs < febEnd ? [] : detector.push(timeMs, health);
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          append(appender, metro.DATASET + '.' + metro.ASSET_ID + '.event.derived.' + event.type, time, {
            kind: 'event', event: {
              type: event.type, origin: 'derived', severity: event.severity,
              label: event.type === 'early_warning' ? 'Explainable early warning' : event.type === 'critical_condition' ? 'Critical operating condition' : 'Condition recovered',
              persistence_started: metro.formatDatasetTime(event.started), health: health
            }, formula_version: metro.FORMULA_VERSION
          });
          derivedCount++;
        }
        count++;
        if (minTime == null) minTime = time;
        maxTime = time;
        if (count % 20000 === 0) {
          appender.flush();
          console.println('ingested', count, 'rows ·', metro.formatDatasetTime(time), '· derived events', derivedCount);
        }
      } catch (err) {
        failed = err;
        try { input.destroy(); } catch (_) {}
      }
    });

    decoder.on('error', function (err) { failed = failed || err; });
    decoder.on('end', function () {
      try {
        if (failed) throw failed;
        baseline = baseline || metro.baselineFromSamples(baselineSamples);
        append(appender, metro.DATASET + '.' + metro.ASSET_ID + '.baseline', metro.parseDatasetTime('2020-02-01 00:00:00'), {
          kind: 'baseline', period: { from: '2020-02-01 00:00:00', to: '2020-02-29 23:59:59' },
          percentiles: baseline, formula_version: metro.FORMULA_VERSION,
          scoring: { pressure_decay: 0.40, pressure_recovery: 0.25, starts: 0.20, load_duty: 0.15, degraded_below: 60, critical_below: 30 }
        });
        append(appender, metro.DATASET + '.' + metro.ASSET_ID + '.manifest', minTime, {
          kind: 'manifest', telemetry_rows: count, sensor_values: count * metro.SENSOR_KEYS.length,
          min_time: metro.formatDatasetTime(minTime), max_time: metro.formatDatasetTime(maxTime),
          sensor_count: metro.SENSOR_KEYS.length, formula_version: metro.FORMULA_VERSION
        });
        for (let i = 0; i < metro.OFFICIAL_EVENTS.length; i++) {
          const spec = metro.OFFICIAL_EVENTS[i];
          append(appender, metro.DATASET + '.' + metro.ASSET_ID + '.event.official.air_leak', metro.parseDatasetTime(spec.start), {
            kind: 'event', event: { type: 'air_leak', origin: 'official', severity: 'critical', label: spec.label, end: spec.end }
          });
        }
        appender.flush();
        console.println(JSON.stringify({
          ok: true, table: TABLES.timeline, telemetryRows: count, expectedRows: 1516948,
          minTime: metro.formatDatasetTime(minTime), maxTime: metro.formatDatasetTime(maxTime),
          baselineHours: baselineSamples.length, officialEvents: metro.OFFICIAL_EVENTS.length, derivedEvents: derivedCount
        }, null, 2));
      } catch (err) {
        console.println(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
      } finally {
        close(appender); close(conn); close(db);
      }
    });
    input.pipe(decoder);
  } catch (err) {
    close(appender); close(conn); close(db);
    throw err;
  }
}

main();
