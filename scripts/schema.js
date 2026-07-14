'use strict';

const path = require('path');
const process = require('process');
const { Client } = require('machcli');
const ROOT = path.dirname(path.dirname(path.resolve(process.argv[1])));
const { boolArg, dbConfig, parseArgs } = require(path.join(ROOT, 'lib', 'env.js'));
const { dropSchema, ensureSchema } = require(path.join(ROOT, 'lib', 'schema.js'));

const args = parseArgs(process.argv);
const db = new Client(dbConfig(args));
let conn;
try {
  conn = db.connect();
  if (boolArg(args.reset, false)) dropSchema(conn);
  console.println(JSON.stringify({ ok: true, schema: ensureSchema(conn) }, null, 2));
} finally {
  try { conn && conn.close(); } catch (_) {}
  try { db && db.close(); } catch (_) {}
}

