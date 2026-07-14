'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
const ROOT = path.dirname(path.dirname(path.resolve(process.argv[1])));
const { parseArgs } = require(path.join(ROOT, 'lib', 'env.js'));

const args = parseArgs(process.argv);
const displayOut = args.out || args['data-root'] || 'data/raw/metropt-3';
const out = path.resolve(displayOut);
const csv = path.join(out, 'MetroPT3(AirCompressor).csv');
const zip = path.join(out, 'metropt-3-dataset.zip');
const shellCsv = path.join(displayOut, 'MetroPT3(AirCompressor).csv');
const shellZip = path.join(displayOut, 'metropt-3-dataset.zip');
if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(csv)) {
  const stat = fs.statSync(csv);
  console.println(JSON.stringify({ ok: true, ready: true, csv: csv, bytes: stat.size, expectedBytes: 218300507 }, null, 2));
} else {
  console.println('MetroPT-3 is CC BY 4.0 and is downloaded from the official UCI repository.');
  console.println('Run these commands in a normal shell:');
  console.println('');
  console.println(`curl -L --fail --output '${shellZip}' 'https://archive.ics.uci.edu/static/public/791/metropt%2B3%2Bdataset.zip'`);
  console.println(`printf '%s  %s\\n' 'aab991a970e58210de853bb8078ce0e63abb4d9412fdc5c79792dae3d8e1721a' '${shellZip}' | sha256sum --check`);
  console.println(`unzip -j -o '${shellZip}' 'MetroPT3(AirCompressor).csv' -d '${displayOut}'`);
  console.println('');
  console.println(JSON.stringify({ ok: false, ready: false, csv: shellCsv, expectedBytes: 218300507 }, null, 2));
}
