'use strict';
const path = require('path'); const process = require('process');
const ROOT = path.dirname(path.dirname(path.dirname(path.resolve(process.argv[1]))));
const api = require(path.join(ROOT, 'lib', 'api.js')); const util = require(path.join(ROOT, 'cgi-bin', 'cgi-util.js'));
try { util.reply(api.health({})); } catch (err) { const r = api.responseError(err); util.reply(r.status, r.body); }

