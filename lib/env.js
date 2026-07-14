'use strict';

function envGet(name, fallback) {
  try {
    if (process.env && typeof process.env.get === 'function') {
      const value = process.env.get(name);
      return value == null || value === '' ? fallback : value;
    }
    if (process.env && process.env[name] != null && process.env[name] !== '') return process.env[name];
  } catch (_) {}
  return fallback;
}

function parseArgs(argv) {
  const out = { _: [] };
  const list = argv || [];
  for (let i = 2; i < list.length; i++) {
    const item = String(list[i]);
    if (item.indexOf('--') !== 0) { out._.push(item); continue; }
    const eq = item.indexOf('=');
    if (eq > 0) { out[item.slice(2, eq)] = item.slice(eq + 1); continue; }
    const key = item.slice(2);
    const next = list[i + 1];
    if (next != null && String(next).indexOf('--') !== 0) { out[key] = String(next); i++; }
    else out[key] = true;
  }
  return out;
}

function intArg(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolArg(value, fallback) {
  if (value == null) return fallback;
  if (value === true || value === false) return value;
  const text = String(value).toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return fallback;
}

function dbConfig(args) {
  args = args || {};
  return {
    host: args.dbHost || args['db-host'] || envGet('IIOT_METRO_DB_HOST', '127.0.0.1'),
    port: intArg(args.dbPort || args['db-port'] || envGet('IIOT_METRO_DB_PORT', '5656'), 5656),
    user: args.dbUser || args['db-user'] || envGet('IIOT_METRO_DB_USER', 'sys'),
    password: args.dbPassword || args['db-password'] || envGet('IIOT_METRO_DB_PASSWORD', 'manager')
  };
}

module.exports = { boolArg, dbConfig, envGet, intArg, parseArgs };

