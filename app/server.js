'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const process = require('process');
const ROOT = path.dirname(path.dirname(path.resolve(process.argv[1])));
const api = require(path.join(ROOT, 'lib', 'api.js'));
const { intArg, parseArgs } = require(path.join(ROOT, 'lib', 'env.js'));

function query(ctx, names) {
  const out = {};
  for (let i = 0; i < names.length; i++) {
    let value = '';
    try { value = ctx.query ? ctx.query(names[i]) : ''; } catch (_) {}
    if ((value == null || value === '') && ctx.request && ctx.request.query) value = ctx.request.query[names[i]];
    if (value != null && value !== '') out[names[i]] = value;
  }
  return out;
}
function route(ctx, fn) {
  try { ctx.json(http.status.OK, fn()); }
  catch (err) { const result = api.responseError(err); ctx.json(result.status, result.body); }
}

const args = parseArgs(process.argv);
const host = args.host || '127.0.0.1';
const port = intArg(args.port, 56802);
const publicDir = path.join(ROOT, 'public');
const indexFile = path.join(publicDir, 'index.html');
const server = new http.Server({ network: 'tcp', address: host + ':' + port, env: process.env });
server.static('/vendor', path.join(publicDir, 'vendor'));
server.static('/assets', path.join(publicDir, 'assets'));
server.staticFile('/app.js', path.join(publicDir, 'app.js'));
server.staticFile('/i18n.js', path.join(publicDir, 'i18n.js'));
server.staticFile('/styles.css', path.join(publicDir, 'styles.css'));
server.staticFile('/controls.css', path.join(publicDir, 'controls.css'));
server.staticFile('/index.html', indexFile);
server.get('/', function (ctx) { ctx.setHeader('content-type', 'text/html; charset=utf-8'); ctx.text(http.status.OK, fs.readFileSync(indexFile, 'utf8')); });
server.get('/api/health', function (ctx) { route(ctx, function () { return api.health(args); }); });
server.get('/api/manifest', function (ctx) { route(ctx, function () { return api.manifest(args); }); });
server.get('/api/frame', function (ctx) { route(ctx, function () { return api.frame(args, query(ctx, ['time', 'seek'])); }); });
server.get('/api/window', function (ctx) { route(ctx, function () { return api.windowFrames(args, query(ctx, ['from', 'to', 'limit'])); }); });
server.get('/api/signals', function (ctx) { route(ctx, function () { return api.signals(args, query(ctx, ['from', 'to', 'limit', 'signals'])); }); });
server.get('/api/events', function (ctx) { route(ctx, function () { return api.events(args, query(ctx, ['from', 'to', 'limit'])); }); });
server.serve(function (result) { console.println('MetroPT demo server started', result.network, result.address); });
