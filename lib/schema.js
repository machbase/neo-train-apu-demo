'use strict';

const TABLES = { timeline: 'IIOT_METRO_TIMELINE' };
// JSON SUMMARIZED WITH ROLLUP creates and maintains the SEC/MIN/HOUR hierarchy.
const LEGACY_ROLLUPS = [
  '_IIOT_METRO_TP2_SEC', '_IIOT_METRO_TP3_SEC', '_IIOT_METRO_H1_SEC', '_IIOT_METRO_DVP_SEC',
  '_IIOT_METRO_RES_SEC', '_IIOT_METRO_OILT_SEC', '_IIOT_METRO_MOTOR_SEC', '_IIOT_METRO_COMP_SEC',
  '_IIOT_METRO_DVE_SEC', '_IIOT_METRO_TOWERS_SEC', '_IIOT_METRO_MPG_SEC', '_IIOT_METRO_LPS_SEC',
  '_IIOT_METRO_PSW_SEC', '_IIOT_METRO_OILL_SEC', '_IIOT_METRO_FLOW_SEC', '_IIOT_METRO_HEALTH_SEC',
  '_IIOT_METRO_DUTY_SEC', '_IIOT_METRO_STARTS_SEC', '_IIOT_METRO_DECAY_SEC', '_IIOT_METRO_RECOVERY_SEC'
];
const INDEXES = [
  { name: 'IDX_IIOT_METRO_KIND', path: '$.kind' },
  { name: 'IDX_IIOT_METRO_EVENT_TYPE', path: '$.event.type' },
  { name: 'IDX_IIOT_METRO_EVENT_ORIGIN', path: '$.event.origin' },
  { name: 'IDX_IIOT_METRO_HEALTH_LEVEL', path: '$.health.level' }
];
const DDL = `CREATE TAG TABLE ${TABLES.timeline} (
  name varchar(160) primary key,
  time datetime basetime,
  value json summarized
) METADATA (
  dataset varchar(64),
  asset_id varchar(64),
  source varchar(32)
) WITH ROLLUP TAG_PARTITION_COUNT=1`;

function tableExists(conn, name) {
  try {
    const rows = conn.query('SELECT NAME FROM M$SYS_TABLES WHERE NAME = ?', String(name).toUpperCase());
    try { for (const row of rows) return !!row; }
    finally { rows && rows.close && rows.close(); }
  } catch (_) {}
  return false;
}

function duplicate(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return msg.indexOf('exist') >= 0 || msg.indexOf('duplicate') >= 0 || msg.indexOf('already') >= 0;
}

function ensureSchema(conn) {
  const result = { tables: [], rollups: 'automatic-sec-min-hour', indexes: [] };
  if (!tableExists(conn, TABLES.timeline)) { conn.exec(DDL); result.tables.push(TABLES.timeline); }
  for (let i = 0; i < INDEXES.length; i++) {
    const spec = INDEXES[i];
    try { conn.exec(`CREATE INDEX ${spec.name} ON ${TABLES.timeline} (value->'${spec.path}')`); result.indexes.push(spec.name); }
    catch (err) { if (!duplicate(err)) throw err; }
  }
  return result;
}

function dropSchema(conn) {
  // Remove the previous path-per-signal layout during the one-time migration.
  for (let i = 0; i < LEGACY_ROLLUPS.length; i++) { try { conn.exec('DROP ROLLUP ' + LEGACY_ROLLUPS[i]); } catch (_) {} }
  for (let i = 0; i < INDEXES.length; i++) { try { conn.exec('DROP INDEX ' + INDEXES[i].name); } catch (_) {} }
  try { conn.exec('DROP TABLE ' + TABLES.timeline + ' CASCADE'); }
  catch (_) { try { conn.exec('DROP TABLE ' + TABLES.timeline); } catch (_) {} }
}

module.exports = { DDL, INDEXES, TABLES, dropSchema, ensureSchema, tableExists };
