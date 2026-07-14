'use strict';
const process = require('process');
function parseQuery() {
  let text = ''; try { text = process.env.get('QUERY_STRING') || ''; } catch (_) {}
  const out = {}; const pairs = text.split('&');
  for (let i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue; const eq = pairs[i].indexOf('=');
    const key = eq < 0 ? pairs[i] : pairs[i].slice(0, eq); const value = eq < 0 ? '' : pairs[i].slice(eq + 1);
    out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
  }
  return out;
}
function reply(status, data) {
  if (arguments.length === 1) { data = status; status = 200; }
  if (status !== 200) process.stdout.write('Status: ' + status + '\r\n');
  process.stdout.write('Content-Type: application/json\r\n\r\n' + JSON.stringify(data));
}
module.exports = { parseQuery, reply };

