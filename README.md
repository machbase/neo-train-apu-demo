# Machbase Neo · MetroPT-3 Railway APU Condition Intelligence

An English/Korean, 90-second guided demo that lets a mixed sales and technical audience explore a metro train compressor Air Production Unit (APU) before an officially reported air-leak interval. It uses the complete MetroPT-3 dataset, a transparent derived condition-health formula, Machbase Neo automatic whole-JSON rollups, and a locally bundled Three.js visualization.

The demo makes no ML accuracy or ROI claim. Its derived alerts are explainable condition-health heuristics; official failure intervals remain visibly distinguished from derived events.

## Why MetroPT-3

- 1,516,948 telemetry timestamps from a metro train compressor Air Production Unit (APU), February through August 2020
- 15 pressure, temperature, current, valve, switch, and impulse signals—about 22.75 million sensor values
- four failure intervals published by the dataset authors
- a visually understandable asset: compressor, three-phase motor, cyclonic separator filter, dryer towers, reservoirs, valves, pneumatic panel, and air flow
- a permissive [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/)

Source: [MetroPT-3 at the UCI Machine Learning Repository](https://archive.ics.uci.edu/dataset/791/metropt%2B3%2Bdataset).

The public source identifies the monitored asset as a metro train compressor APU. It does not disclose a manufacturer, exact compressor model, vehicle number, or fleet asset identifier, so this demo does not invent them.

> The CSV contains roughly 9–10 second intervals (about 0.1 Hz), despite a conflicting 1 Hz statement in the bundled dataset description. This project reports the observed 1,516,948 timestamps, not a fabricated sample frequency. The source timezone is unspecified; the app preserves source clock values and labels them “Dataset local time — timezone unspecified.”

## Prerequisites

- Machbase Neo 8.5.x with JSH, database, and service ports available
- `curl`, `sha256sum`, and `unzip` for the one-time dataset download
- a modern browser with WebGL

Commands below assume the confirmed executable path is `../machbase-neo` from this directory.

## 1. Download and verify the real dataset

JSH prints safe shell commands rather than buffering a 218 MB download in memory:

```sh
../machbase-neo jsh scripts/download-data.js
```

Run the commands it prints. They download the official UCI ZIP, verify SHA-256
`aab991a970e58210de853bb8078ce0e63abb4d9412fdc5c79792dae3d8e1721a`, and extract:

```text
data/raw/metropt-3/MetroPT3(AirCompressor).csv
```

Raw ZIP and CSV files are intentionally gitignored and are preserved by schema reset operations.

## 2. Ingest into Machbase Neo

The importer creates the schema and streams the complete CSV without loading it into memory:

```sh
../machbase-neo jsh scripts/ingest.js
```

The default database connection is `127.0.0.1:5656`, user `sys`, password `manager`. Override it with `IIOT_METRO_DB_HOST`, `IIOT_METRO_DB_PORT`, `IIOT_METRO_DB_USER`, and `IIOT_METRO_DB_PASSWORD`, or matching `--db-host`, `--db-port`, `--db-user`, and `--db-password` options.

The importer refuses to overwrite existing telemetry. To intentionally replace only this project's table, rollups, and indexes:

```sh
../machbase-neo jsh scripts/ingest.js --reset
```

An interrupted initial import should also be restarted explicitly with `--reset`. Raw source files are not deleted.

## 3. Run the standalone demo server

```sh
../machbase-neo jsh app/server.js
```

Open [http://127.0.0.1:56804](http://127.0.0.1:56804). Use `--host` or `--port` to override the listener. The root `index.html`, `main.html`, `side.html`, and `cgi-bin/api/*.js` files also support Machbase Neo package-style deployment.

If data is absent, the UI shows setup instructions. It never presents synthetic or stale values as real telemetry.

## Condition-health formula

The first calendar month, February 2020, supplies hourly feature percentiles (p05, p50, p95). The rolling window uses actual timestamp duration, requires at least 45 minutes of coverage, and resets across gaps longer than 120 seconds.

Four normalized risks form the score:

```text
high risk = clamp((x - p95) / max(3 × (p95 - p50), ε), 0, 1)
low risk  = clamp((p05 - x) / max(3 × (p50 - p05), ε), 0, 1)

health = 100 × (1
  - 0.40 × pressure-decay risk
  - 0.25 × pressure-recovery risk
  - 0.20 × starts-per-hour risk
  - 0.15 × compressor-load-duty risk)
```

Oil temperature remains visible as operational context but is excluded from scoring to reduce seasonal confounding. A derived early warning requires health below 60, at least two abnormal contributors, and three continuous hours of persistence. Critical condition requires health below 30, three contributors, and one hour. Recovery requires health at least 70 for three hours.

These thresholds are intentionally auditable demo policy, not a trained failure classifier.

## Storage and APIs

`IIOT_METRO_TIMELINE` is a Machbase tag table with `value JSON SUMMARIZED WITH ROLLUP`. It stores `telemetry`, `baseline`, and `event` JSON row kinds under dataset `metropt-3-uci-791` and asset `apu-01`. Machbase automatically maintains the whole-JSON SEC, MIN, and HOUR hierarchy; one `AVG(value)` query aggregates every numeric leaf, after which the API extracts the selected signals. JSON-path indexes cover row kind, event type, event origin, and health level.

Read-only endpoints:

- `GET /api/health`
- `GET /api/manifest`
- `GET /api/frame?time=...` (`seek=next|prev` explicitly advances in either direction across a telemetry gap)
- `GET /api/window?from=...&to=...&limit=...`
- `GET /api/signals?from=...&to=...&signals=reservoirs,health_score&limit=...`
- `GET /api/events?from=...&to=...&limit=...`

Every data response includes evidence with the SQL text, parameters, table, sample result rows, measured query latency, and rollup interval. Signal names are allowlisted; API inputs never become arbitrary SQL expressions.

## Validation

Run the JSH-compatible deterministic tests:

```sh
../machbase-neo jsh scripts/selftest.js
```

After full ingest, the summary should report exactly 1,516,948 telemetry rows with source-clock range `2020-02-01 00:00:00` through `2020-09-01 03:59:50`, a February baseline, four official intervals, and any events derived by the documented persistence rules.

## Project layout

```text
app/server.js          JSH HTTP server, port 56804
cgi-bin/api/           package-compatible API entry points
lib/api.js             read-only database query layer and evidence envelopes
lib/metro.js           timestamps, rolling features, scoring, event persistence
lib/schema.js          tag table, JSON rollups, and JSON indexes
scripts/               download guidance, schema, streaming ingest, self-test
public/                 English/Korean UI, Three.js APU scene, charts, timeline
```

Three.js and OrbitControls are bundled locally so the running demo needs no internet connection. MetroPT-3 itself is not redistributed by this repository; retain the UCI attribution when demonstrating or republishing derived materials.
