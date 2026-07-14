import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { UI, SENSOR_COPY } from './i18n.js?v=20260714-10';
import { createApuAudio } from './assets/audio.js?v=20260714-1';

const $ = (id) => document.getElementById(id);
const colors = [
  '#54e6df', '#ffbd59', '#68a5ff', '#ff5d66', '#b8f56a', '#b18cff', '#ff78c8', '#ff8c42', '#47c6a3', '#d7f3ff',
  '#ef6cff', '#77dd77', '#4d8dff', '#ffd166', '#ff7f6e', '#c4a7ff', '#2dd4bf', '#fb7185', '#a3e635', '#38bdf8'
];
const SOURCE_SIGNALS = [
  'tp2', 'tp3', 'h1', 'dv_pressure', 'reservoirs', 'oil_temperature', 'motor_current',
  'comp', 'dv_electric', 'towers', 'mpg', 'lps', 'pressure_switch', 'oil_level', 'flow_impulse'
];
const EVENT_TRACKS = [
  { type: 'early_warning', tag: 'metropt-3-uci-791.apu-01.event.derived.early_warning', label: 'eventEarlyWarning', description: 'eventEarlyWarningDescription' },
  { type: 'critical_condition', tag: 'metropt-3-uci-791.apu-01.event.derived.critical_condition', label: 'eventCriticalCondition', description: 'eventCriticalConditionDescription' },
  { type: 'recovery', tag: 'metropt-3-uci-791.apu-01.event.derived.recovery', label: 'eventRecovery', description: 'eventRecoveryDescription' },
  { type: 'air_leak', tag: 'metropt-3-uci-791.apu-01.event.official.air_leak', label: 'eventOfficialLeak', description: 'eventOfficialLeakDescription' }
];
const selected = ['reservoirs', 'motor_current', 'oil_temperature', 'dv_electric'];
const PLAYBACK_INTERVAL_MS = 100;
const PLAYBACK_STEP_MS = 60000;
const CHART_REFRESH_MS = 2000;
const EVIDENCE_REFRESH_MS = 1000;
let manifest, currentFrame, signalData = [], playing = true, tourStart = 0, tourFrame = 0, userExploring = false;
let language = 'en', modeKey = 'guidedTour', timelineKey = 'fullTimeline', windowKey = 'liveCursor';
let tourAnchorTime = 0, tourAnchorIndex = -1;
let lastExplorerAdvance = 0;
let lastTourAdvance = 0;
let playbackLoading = false;
let loadSequence = 0;
let chartLoading = false;
let lastChartRefresh = 0;
let lastPlaybackEvidence = 0;
let chartSeries = [], chartStart = 0, chartEnd = 1;
let chartRequestSequence = 0;
let scrubbing = false, scrubRequest = null;
let transportLoading = false;
let sensorRefreshTimer = null;
let sceneMarkerApi = null;
let warningChartPulse = 0;
let lastWarningChartDraw = 0;
const apuAudio = createApuAudio();

async function api(path) {
  const response = await fetch('/api/' + path);
  const data = await response.json().catch(() => ({ ok: false, error: response.statusText }));
  if (!response.ok || !data.ok) { const error = new Error(data.error || 'Request failed'); error.status = response.status; throw error; }
  return data;
}

function compact(n) {
  if (!Number.isFinite(Number(n))) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 3) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function localClock(value) { return String(value || '').replace('T', ' ').replace('.000Z', '').replace('Z', ''); }
function escapeHtml(text) { return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function t(key) { return UI[language][key] || UI.en[key] || key; }
function setMode(key) { modeKey = key; $('mode').textContent = t(key); }
function setTimeline(key) {
  timelineKey = key;
  const chapterId = key.indexOf('chapter:') === 0 ? key.slice(8) : '';
  $('timeline-title').textContent = chapterId && UI[language].stories[chapterId] ? UI[language].stories[chapterId][0] : t(key);
}
function setWindow(key) { windowKey = key; $('window-label').textContent = t(key); }
function sensorCopy(name) {
  const copy = SENSOR_COPY[name] && (SENSOR_COPY[name][language] || SENSOR_COPY[name].en);
  return copy || [manifest.signals[name][0], name];
}
function localizedLevel(level) {
  const key = { normal: 'levelNormal', degraded: 'levelDegraded', critical: 'levelCritical', baseline: 'levelBaseline' }[String(level || '').toLowerCase()] || 'levelUnknown';
  return t(key);
}
function syncSceneMarkers() { if (sceneMarkerApi) sceneMarkerApi.sync(); }

function updateSoundButton() {
  const button = $('sound-toggle');
  const enabled = apuAudio.isEnabled();
  const key = enabled ? 'soundMute' : 'soundEnable';
  button.textContent = (enabled ? '◉ ' : '♪ ') + t(key);
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', t(key));
  button.title = t(key);
}

function relatedWarningSignals(health) {
  const names = new Set(['health_score']); const risks = health.risks || {};
  const contributors = [
    { risk: Number(risks.pressure_decay) || 0, names: ['pressure_decay_bar_min', 'reservoirs', 'tp3', 'comp'] },
    { risk: Number(risks.pressure_recovery) || 0, names: ['pressure_recovery_bar_min', 'reservoirs', 'tp2', 'tp3', 'dv_pressure', 'dv_electric'] },
    { risk: Number(risks.starts) || 0, names: ['starts_1h', 'motor_current', 'comp', 'dv_electric'] },
    { risk: Number(risks.load_duty) || 0, names: ['load_duty_1h', 'motor_current', 'comp', 'dv_electric'] }
  ];
  const maximum = contributors.reduce((value, contributor) => Math.max(value, contributor.risk), 0);
  contributors.forEach((contributor) => {
    if (contributor.risk >= .35 || (maximum > 0 && contributor.risk === maximum)) contributor.names.forEach((name) => names.add(name));
  });
  return names;
}

function renderEventMarkers() {
  if (!manifest) return;
  const min = Date.parse(manifest.minTime), span = Date.parse(manifest.maxTime) - min;
  $('event-markers').innerHTML = EVENT_TRACKS.map((track) => {
    const markers = manifest.events.filter((item) => item.event.type === track.type).map((item) => {
      const event = item.event || {};
      const position = Math.max(0, Math.min(100, (Date.parse(item.time) - min) / span * 100));
      const edge = position < 14 ? ' tooltip-start' : position > 86 ? ' tooltip-end' : '';
      const details = [
        t(track.description),
        t('eventRecordedAt') + ': ' + localClock(item.time),
        event.persistence_started ? t('eventPersistenceStarted') + ': ' + localClock(event.persistence_started) : '',
        event.end ? t('eventIntervalEnd') + ': ' + localClock(event.end) : '',
        t('eventTag') + ': ' + track.tag
      ].filter(Boolean);
      const tooltip = details.join('\n');
      return `<button type="button" class="event-marker ${track.type}${edge}" style="left:${position}%" aria-label="${escapeHtml(tooltip)}"><span class="event-tooltip"><strong>${escapeHtml(t(track.label))}</strong>${details.map((detail) => `<small>${escapeHtml(detail)}</small>`).join('')}</span></button>`;
    }).join('');
    return `<div class="event-track ${track.type}"><span class="event-track-label">${escapeHtml(t(track.label))}</span><div class="event-track-axis">${markers}</div></div>`;
  }).join('');
}

function renderFreeExplorerCopy() {
  const title = $('chapter-title');
  title.textContent = t('freeTitle');
  title.classList.toggle('compact-korean-title', language === 'ko');
  $('chapter-copy').textContent = t('freeCopy');
}

function applyLanguage() {
  document.documentElement.lang = language;
  document.title = t('documentTitle');
  document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((element) => {
    const copy = t(element.dataset.i18nTitle); element.title = copy; element.setAttribute('aria-label', copy);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((element) => element.setAttribute('aria-label', t(element.dataset.i18nAria)));
  $('language-toggle').textContent = t('language');
  updateSoundButton();
  setMode(modeKey); setTimeline(timelineKey); setWindow(windowKey);
  if (!manifest) return;
  sensorPicker(); prepareChart(); drawChart(); healthView(currentFrame);
  renderEventMarkers(); evidence(currentFrame && currentFrame.evidence ? currentFrame : manifest);
  if (userExploring) {
    renderFreeExplorerCopy();
  } else {
    renderChapterCopy(tourFrame);
  }
}

function evidence(data) {
  const e = data && data.evidence;
  if (!e) return;
  $('latency').textContent = e.queryMs + ' ms';
  $('rollup').textContent = e.rollupIntervalSec ? e.rollupIntervalSec + ' s' : t('raw');
  $('sql').innerHTML = escapeHtml(e.sql) + '\n\n-- ' + t('params') + ': ' + escapeHtml(JSON.stringify(e.params));
  $('result').textContent = JSON.stringify(e.rows, null, 2);
}

function healthView(frame) {
  if (!frame) return;
  const h = frame.health || {};
  const score = h.score == null ? NaN : Number(h.score);
  const warning = Number.isFinite(score) && score <= 60;
  $('sound-toggle').classList.toggle('warning', warning);
  $('health-score').textContent = Number.isFinite(score) ? Math.round(score) : '—';
  $('health-level').textContent = warning && score > 30 ? t('levelWarning') : localizedLevel(h.level);
  const gaugeColor = warning ? '#ff334f' : score <= 75 ? '#ffbd59' : '#54e6df';
  $('gauge').style.background = `conic-gradient(${gaugeColor} ${Math.max(0, score || 0) * 3.6}deg, rgba(255,255,255,.06) 0deg)`;
  const risks = h.risks || {};
  const items = [
    [t('pressureDecay'), risks.pressure_decay], [t('pressureRecovery'), risks.pressure_recovery],
    [t('startsHour'), risks.starts], [t('loadDuty'), risks.load_duty]
  ];
  $('contributors').innerHTML = items.map(([name, risk]) => {
    const pct = Math.round((Number(risk) || 0) * 100);
    return `<div class="contributor"><header><span>${name}</span><b>${pct}% ${t('risk')}</b></header><div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }).join('');
  $('scene-state').textContent = warning ? (score <= 30 ? t('critical') : t('apuWarning')) : h.level === 'degraded' ? t('driftDetected') : t('nominal');
}

function hideSensorTooltip() {
  const tooltip = $('sensor-tooltip'); tooltip.classList.remove('visible'); tooltip.setAttribute('aria-hidden', 'true');
}

function showSensorTooltip(name) {
  const copy = sensorCopy(name); const unit = manifest.signals[name][1] || t('state'); const tooltip = $('sensor-tooltip');
  tooltip.innerHTML = `<strong>${escapeHtml(copy[0])}</strong><span>${escapeHtml(copy[1])}</span><small>${escapeHtml(name)} · ${escapeHtml(unit)}</small>`;
  tooltip.classList.add('visible'); tooltip.setAttribute('aria-hidden', 'false');
}

function sensorPicker() {
  const names = SOURCE_SIGNALS.filter((name) => manifest.signals[name]);
  hideSensorTooltip();
  $('sensor-picker').innerHTML = names.map((name) => `<button type="button" data-signal="${name}" class="${selected.includes(name) ? 'active' : ''}" aria-pressed="${selected.includes(name)}">${escapeHtml(sensorCopy(name)[0])}</button>`).join('');
  $('sensor-picker').querySelectorAll('button').forEach((button) => {
    button.addEventListener('mouseenter', () => showSensorTooltip(button.dataset.signal));
    button.addEventListener('focus', () => showSensorTooltip(button.dataset.signal));
    button.addEventListener('mouseleave', hideSensorTooltip);
    button.addEventListener('blur', hideSensorTooltip);
    button.addEventListener('click', () => {
    const name = button.dataset.signal; const index = selected.indexOf(name);
    if (index >= 0) selected.splice(index, 1);
    else selected.push(name);
    sensorPicker(); invalidateChartRefresh();
    if (sensorRefreshTimer) clearTimeout(sensorRefreshTimer);
    if (selected.length && currentFrame) {
      // Batch rapid multi-select changes so playback is never queued behind obsolete chart queries.
      chartLoading = true;
      sensorRefreshTimer = setTimeout(() => { sensorRefreshTimer = null; chartLoading = false; refreshSignals(Date.parse(currentFrame.time)); }, 150);
    } else {
      chartLoading = false; signalData = []; prepareChart(); drawChart(); setWindow('selectSignals');
    }
    });
  });
  syncSceneMarkers();
}

function prepareChart() {
  const groups = {};
  chartStart = Infinity; chartEnd = -Infinity;
  signalData.forEach((point) => {
    const time = Date.parse(point.time);
    if (!Number.isFinite(time)) return;
    chartStart = Math.min(chartStart, time); chartEnd = Math.max(chartEnd, time);
    (groups[point.signal] ||= []).push({ time: time, value: Number(point.value) });
  });
  chartSeries = selected.map((name, index) => {
    const points = groups[name] || [];
    let min = Infinity, max = -Infinity;
    points.forEach((point) => { min = Math.min(min, point.value); max = Math.max(max, point.value); });
    return { name: name, color: colors[index % colors.length], points: points, min: min, span: Math.max(.000001, max - min) };
  });
  if (!Number.isFinite(chartStart) || !Number.isFinite(chartEnd)) { chartStart = 0; chartEnd = 1; }
  $('legend').innerHTML = selected.map((name, i) => `<b><i style="background:${colors[i % colors.length]}"></i>${escapeHtml(sensorCopy(name)[0])}</b>`).join('');
}

function drawChart() {
  const canvas = $('chart'); const rect = canvas.getBoundingClientRect(); const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.round(rect.width * dpr)); const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h); ctx.strokeStyle = 'rgba(156,222,226,.10)'; ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) { const y = 12 + i * (h - 26) / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  const frameTime = currentFrame && Date.parse(currentFrame.time);
  const centerTime = Number.isFinite(frameTime) ? frameTime : (chartStart + chartEnd) / 2;
  const chartSpan = Math.max(1, chartEnd - chartStart);
  const visibleStart = centerTime - chartSpan / 2;
  const health = currentFrame && currentFrame.health || {};
  const score = health.score == null ? NaN : Number(health.score);
  const alertActive = Number.isFinite(score) && score <= 60;
  const warningSignals = alertActive ? relatedWarningSignals(health) : null;
  const alertStrength = alertActive ? .58 + .42 * Math.max(0, Math.min(1, (60 - score) / 60)) : 0;
  chartSeries.forEach((series) => {
    if (series.points.length < 2) return;
    const related = Boolean(warningSignals && warningSignals.has(series.name));
    ctx.save(); ctx.beginPath(); ctx.strokeStyle = related ? 'rgba(255,93,102,.42)' : series.color; ctx.lineWidth = related ? 1.9 : 1.7;
    series.points.forEach((point, i) => { const x = (point.time - visibleStart) / chartSpan * w; const y = h - 14 - (point.value - series.min) / series.span * (h - 28); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    if (related) {
      const glow = alertStrength * (.32 + warningChartPulse * .68);
      ctx.strokeStyle = `rgba(255,24,56,${.28 + glow * .72})`; ctx.lineWidth = 2 + glow * 2.2;
      ctx.shadowColor = '#ff1838'; ctx.shadowBlur = 5 + glow * 15; ctx.stroke();
      const currentPoint = series.points.reduce((closest, point) => Math.abs(point.time - centerTime) < Math.abs(closest.time - centerTime) ? point : closest, series.points[0]);
      const pointX = (currentPoint.time - visibleStart) / chartSpan * w;
      const pointY = h - 14 - (currentPoint.value - series.min) / series.span * (h - 28);
      if (pointX >= 0 && pointX <= w) {
        ctx.fillStyle = `rgba(255,232,236,${.55 + glow * .45})`; ctx.beginPath(); ctx.arc(pointX, pointY, 2.4 + glow * 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  });
  if (chartSeries.length) {
    const x = w / 2;
    ctx.save(); ctx.strokeStyle = 'rgba(232,247,246,.82)'; ctx.lineWidth = 1; ctx.shadowColor = '#54e6df'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, h - 8); ctx.stroke();
    ctx.fillStyle = '#e8f7f6'; ctx.beginPath(); ctx.arc(x, 8, 2.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
}

function timeFromSlider() {
  const min = Date.parse(manifest.minTime), max = Date.parse(manifest.maxTime);
  return min + (max - min) * Number($('timeline').value) / 10000;
}
function setSlider(time) {
  const min = Date.parse(manifest.minTime), max = Date.parse(manifest.maxTime);
  $('timeline').value = Math.max(0, Math.min(10000, (time - min) / (max - min) * 10000));
  $('timeline-current').textContent = localClock(new Date(time).toISOString());
}

async function loadAt(time, preserveStory = false, options = {}) {
  const requestId = ++loadSequence;
  try {
    const seekMode = options.seek || (options.seekNext ? 'next' : '');
    const seek = seekMode ? '&seek=' + encodeURIComponent(seekMode) : '';
    const frame = await api('frame?time=' + encodeURIComponent(new Date(time).toISOString()) + seek);
    if (requestId !== loadSequence) return { ok: false, superseded: true };
    const frameTime = Date.parse(frame.time);
    currentFrame = frame;
    $('current-time').textContent = localClock(frame.time);
    setSlider(frameTime); healthView(frame);
    if (chartSeries.length) drawChart();
    const renderTime = performance.now();
    if (!options.playback || renderTime - lastPlaybackEvidence >= EVIDENCE_REFRESH_MS) {
      evidence(frame);
      lastPlaybackEvidence = renderTime;
    }
    if (!preserveStory && userExploring) renderFreeExplorerCopy();
    if (frame.skippedGap) setTimeline(seekMode === 'prev' ? 'skippedPrev' : 'skippedNext');
    if (options.playback) {
      const chartDue = options.forceChart || renderTime - lastChartRefresh >= CHART_REFRESH_MS;
      if (selected.length && options.refreshChart !== false && !chartLoading && chartDue) refreshSignals(frameTime);
      return { ok: true, frame: frame };
    }
    const span = 8 * 3600000, from = frameTime - span, to = frameTime + span;
    const signals = await api('signals?from=' + encodeURIComponent(new Date(from).toISOString()) + '&to=' + encodeURIComponent(new Date(to).toISOString()) + '&limit=1400&signals=' + selected.join(','));
    if (requestId !== loadSequence) return { ok: false, superseded: true };
    signalData = signals.signals; prepareChart(); setWindow('liveCursor'); drawChart(); evidence(signals); lastChartRefresh = performance.now();
    return { ok: true, frame: frame };
  } catch (err) {
    if (requestId === loadSequence) $('scene-state').textContent = err.status === 404 ? t('noSample') : t('queryError');
    return { ok: false, status: err.status, error: err };
  }
}

async function refreshSignals(frameTime) {
  if (!selected.length) return;
  const requestId = ++chartRequestSequence;
  chartLoading = true;
  const signature = selected.join(',');
  const span = 8 * 3600000, from = frameTime - span, to = frameTime + span;
  try {
    const signals = await api('signals?from=' + encodeURIComponent(new Date(from).toISOString()) + '&to=' + encodeURIComponent(new Date(to).toISOString()) + '&limit=1400&signals=' + signature);
    if (requestId === chartRequestSequence && signature === selected.join(',')) {
      signalData = signals.signals; prepareChart(); setWindow('liveData'); drawChart(); evidence(signals);
    }
  } catch (_) {
    // Chart refresh failure must not stop the lightweight playback cursor.
  } finally {
    if (requestId === chartRequestSequence) {
      // A failed chart refresh should back off instead of retrying on every playback frame.
      lastChartRefresh = performance.now();
      chartLoading = false;
    }
  }
}

function invalidateChartRefresh() {
  chartRequestSequence++;
  chartLoading = false;
  lastChartRefresh = 0;
}

function renderChapterCopy(index) {
  const item = manifest.chapters[index]; const copy = UI[language].stories[item.id] || UI.en.stories[item.id];
  const title = $('chapter-title');
  title.classList.remove('compact-korean-title');
  $('chapter-index').textContent = String(index + 1).padStart(2, '0') + ' / 05'; title.textContent = copy[0]; $('chapter-copy').textContent = copy[1];
}
function chapter(index) {
  const item = manifest.chapters[index]; renderChapterCopy(index);
  tourAnchorTime = 0; tourAnchorIndex = -1;
  invalidateChartRefresh();
  setTimeline('chapter:' + item.id);
  loadAt(Date.parse(item.time), true, { seekNext: true, playback: true, forceChart: true }).then((result) => {
    if (!result.ok || userExploring || tourFrame !== index) return;
    // A chapter can begin inside a telemetry gap. Anchor playback to the sample
    // actually returned by seek=next so the same boundary row is never replayed.
    tourAnchorTime = Date.parse(result.frame.time); tourAnchorIndex = index; lastTourAdvance = performance.now();
  });
}
function restartTour() { loadSequence++; playbackLoading = false; scrubbing = false; userExploring = false; playing = true; tourAnchorTime = 0; tourAnchorIndex = -1; tourStart = performance.now(); tourFrame = 0; lastTourAdvance = tourStart; setMode('guidedTour'); $('play').textContent = 'Ⅱ'; chapter(0); }
function stopAtEnd() { playing = false; playbackLoading = false; setMode('endOfData'); $('play').textContent = '▶'; $('scene-state').textContent = t('timelineComplete'); }

function resumeExplorerPlayback() {
  userExploring = true; playing = true; playbackLoading = false;
  lastExplorerAdvance = performance.now();
  setMode('freeExplorer'); $('play').textContent = 'Ⅱ';
}

function scrubTimeline() {
  scrubbing = true; userExploring = true; playing = false; playbackLoading = false;
  setMode('scrubbing'); $('play').textContent = '▶';
  const target = timeFromSlider();
  $('timeline-current').textContent = localClock(new Date(target).toISOString());
  scrubRequest = loadAt(target, false, { seekNext: true, playback: true, refreshChart: false });
}

async function finishTimelineScrub() {
  if (!scrubbing) return;
  const pending = scrubRequest;
  if (pending) await pending;
  if (pending !== scrubRequest) return finishTimelineScrub();
  if (!scrubbing) return;
  scrubbing = false; resumeExplorerPlayback(); invalidateChartRefresh();
  if (currentFrame) refreshSignals(Date.parse(currentFrame.time));
}

async function advanceTourPlayback(time) {
  if (playbackLoading) return;
  playbackLoading = true;
  const result = await loadAt(time, true, { seekNext: true, playback: true });
  playbackLoading = false;
  if (!result.ok && !result.superseded) {
    playing = false; setMode('queryError'); $('play').textContent = '▶';
  }
}

async function advancePlayback() {
  if (playbackLoading || !currentFrame) return;
  const current = Date.parse(currentFrame.time); const max = Date.parse(manifest.maxTime);
  if (current >= max) { stopAtEnd(); return; }
  playbackLoading = true;
  // Ten smaller cursor steps preserve the 10-minute/second data rate with a responsive 10 FPS UI.
  const result = await loadAt(Math.min(max, current + PLAYBACK_STEP_MS), false, { seekNext: true, playback: true });
  playbackLoading = false;
  if (!result.ok && !result.superseded) {
    if (result.status === 404) stopAtEnd();
    else { playing = false; setMode('queryError'); $('play').textContent = '▶'; }
  }
}

async function jumpPlayback(offsetMs) {
  if (transportLoading || !manifest) return;
  const direction = Math.sign(offsetMs);
  if (!direction) return;
  transportLoading = true;
  playing = false; playbackLoading = true; scrubbing = false; userExploring = true;
  const min = Date.parse(manifest.minTime), max = Date.parse(manifest.maxTime);
  const current = currentFrame ? Date.parse(currentFrame.time) : timeFromSlider();
  const target = Math.max(min, Math.min(max, current + offsetMs));
  const result = await loadAt(target, false, { seek: direction > 0 ? 'next' : 'prev', playback: true });
  playbackLoading = false; transportLoading = false; resumeExplorerPlayback();
  if (!result.ok && !result.superseded) $('scene-state').textContent = direction > 0 ? t('endOfData') : t('startOfData');
}

function initScene() {
  const host = $('scene'); const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x061015, .025);
  const camera = new THREE.PerspectiveCamera(38, 1, .1, 100); camera.position.set(10.5, 6.2, 12.5);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio)); host.prepend(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.enablePan = false; controls.target.set(0, .2, 0); controls.minDistance = 7; controls.maxDistance = 23;
  scene.add(new THREE.HemisphereLight(0xb5ffff, 0x071015, 1.25));
  const key = new THREE.PointLight(0x54e6df, 2.6, 32); key.position.set(3, 7, 6); scene.add(key);
  const warm = new THREE.PointLight(0xffbd59, 1.2, 22); warm.position.set(-5, 2, -5); scene.add(warm);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(42, 26, 20, 12), new THREE.MeshBasicMaterial({ color: 0x214047, wireframe: true, transparent: true, opacity: .13 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -2.15; scene.add(floor);

  const model = new THREE.Group(); model.rotation.set(-.04, -.18, 0); scene.add(model);
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x20363d, metalness: .86, roughness: .28 });
  const frameMetal = new THREE.MeshStandardMaterial({ color: 0x39565e, metalness: .9, roughness: .25 });
  const motorMat = new THREE.MeshStandardMaterial({ color: 0x24515b, emissive: 0x072427, emissiveIntensity: .2, metalness: .76, roughness: .3 });
  const compressorMat = new THREE.MeshStandardMaterial({ color: 0x257479, emissive: 0x0a3435, emissiveIntensity: .45, metalness: .72, roughness: .24 });
  const oilMat = new THREE.MeshStandardMaterial({ color: 0x78683f, emissive: 0x2a1703, emissiveIntensity: .25, metalness: .62, roughness: .3 });
  const towerMaterials = [0, 1].map(() => new THREE.MeshStandardMaterial({ color: 0x334d55, emissive: 0x082122, emissiveIntensity: .2, metalness: .78, roughness: .27 }));
  const reservoirMat = new THREE.MeshPhysicalMaterial({ color: 0x477a91, emissive: 0x071820, emissiveIntensity: .25, transparent: true, opacity: .72, metalness: .78, roughness: .18 });
  const pipeMat = new THREE.MeshStandardMaterial({ color: 0x4b7f85, emissive: 0x12383a, emissiveIntensity: .55, metalness: .7, roughness: .2 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x263a40, metalness: .65, roughness: .36 });

  function box(w, h, d, material, x, y, z) { const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); mesh.position.set(x, y, z); model.add(mesh); return mesh; }
  function cylinder(radius, length, material, x, y, z, axis) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 28), material); mesh.position.set(x, y, z);
    if (axis === 'x') mesh.rotation.z = Math.PI / 2; else if (axis === 'z') mesh.rotation.x = Math.PI / 2;
    model.add(mesh); return mesh;
  }
  function pipe(points, radius) {
    const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(point[0], point[1], point[2])));
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, radius || .07, 8, false), pipeMat); model.add(mesh); return curve;
  }

  // The visible topology follows the public MetroPT APU schematic: three-phase motor,
  // compressor, cyclonic separator filter, dryer towers, reservoirs, valves and pneumatic panel.
  [-1.45, 1.45].forEach((z) => box(8.8, .18, .2, frameMetal, 0, -1.55, z));
  [-3.8, -1.2, 1.5, 3.8].forEach((x) => box(.18, .18, 3.1, frameMetal, x, -1.55, 0));
  [-3.8, 3.8].forEach((x) => [-1.45, 1.45].forEach((z) => cylinder(.14, .42, darkMetal, x, -1.82, z, 'y')));

  const motorGroup = new THREE.Group(); motorGroup.position.set(-2.65, -.45, -.42); model.add(motorGroup);
  const motorBody = new THREE.Mesh(new THREE.CylinderGeometry(.72, .72, 2.05, 32), motorMat); motorBody.rotation.z = Math.PI / 2; motorGroup.add(motorBody);
  for (let x = -.82; x <= .82; x += .205) { const fin = new THREE.Mesh(new THREE.TorusGeometry(.76, .035, 7, 28), darkMetal); fin.rotation.y = Math.PI / 2; fin.position.x = x; motorGroup.add(fin); }
  const fanGuard = new THREE.Mesh(new THREE.CylinderGeometry(.78, .78, .18, 32, 1, true), frameMetal); fanGuard.rotation.z = Math.PI / 2; fanGuard.position.x = -1.1; motorGroup.add(fanGuard);
  const rotor = new THREE.Mesh(new THREE.TorusGeometry(.48, .07, 8, 24), new THREE.MeshBasicMaterial({ color: 0x54e6df, transparent: true, opacity: .75 })); rotor.rotation.y = Math.PI / 2; rotor.position.x = -1.21; motorGroup.add(rotor);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(.13, .13, .7, 16), frameMetal); shaft.rotation.z = Math.PI / 2; shaft.position.x = 1.18; motorGroup.add(shaft);

  const compressorGroup = new THREE.Group(); compressorGroup.position.set(-.55, -.35, -.38); model.add(compressorGroup);
  const compressor = new THREE.Mesh(new THREE.CylinderGeometry(.82, .66, 1.42, 32), compressorMat); compressor.rotation.z = Math.PI / 2; compressorGroup.add(compressor);
  const endCap = new THREE.Mesh(new THREE.CylinderGeometry(.58, .58, .26, 28), darkMetal); endCap.rotation.z = Math.PI / 2; endCap.position.x = .82; compressorGroup.add(endCap);
  const intake = new THREE.Mesh(new THREE.TorusGeometry(.36, .11, 10, 26), pipeMat); intake.rotation.x = Math.PI / 2; intake.position.set(-.3, .6, -.6); compressorGroup.add(intake);
  box(1.35, 1.12, .13, darkMetal, .25, -.3, -1.22);
  for (let y = -.75; y <= .15; y += .15) box(1.12, .035, .05, frameMetal, .25, y, -1.3);
  const cyclonicSeparator = cylinder(.46, 1.5, oilMat, .65, .05, .72, 'y');
  const separatorCap = new THREE.Mesh(new THREE.SphereGeometry(.46, 22, 12)); separatorCap.material = oilMat; separatorCap.scale.y = .45; separatorCap.position.set(.65, .81, .72); model.add(separatorCap);

  const towers = [];
  [-.72, .72].forEach((z, index) => {
    const group = new THREE.Group(); group.position.set(2.0, -.2, z); model.add(group);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(.45, .45, 2.18, 24), towerMaterials[index]); group.add(body);
    [-1.09, 1.09].forEach((y) => { const cap = new THREE.Mesh(new THREE.SphereGeometry(.45, 20, 12), towerMaterials[index]); cap.scale.y = .46; cap.position.y = y; group.add(cap); });
    const band = new THREE.Mesh(new THREE.TorusGeometry(.47, .035, 7, 24), frameMetal); band.rotation.x = Math.PI / 2; band.position.y = .45; group.add(band);
    towers.push(group);
  });
  box(1.72, .22, .28, frameMetal, 2, 1.08, 0);
  const dryerValve = cylinder(.22, .9, pipeMat, 2, 1.42, 0, 'x');
  const fineFilter = cylinder(.18, .85, oilMat, 2.86, .18, .42, 'y');
  const filterBowl = new THREE.Mesh(new THREE.SphereGeometry(.18, 16, 9), oilMat); filterBowl.scale.y = .55; filterBowl.position.set(2.86, -.25, .42); model.add(filterBowl);

  const reservoir = new THREE.Mesh(new THREE.CapsuleGeometry(.62, 2.5, 10, 22), reservoirMat); reservoir.rotation.z = Math.PI / 2; reservoir.position.set(2.15, -1.0, 0); model.add(reservoir);
  [-.75, .75].forEach((x) => { const foot = box(.15, .4, .8, frameMetal, 2.15 + x, -1.36, 0); foot.rotation.z = x * .05; });
  const panel = box(1.15, 1.65, .75, panelMat, 3.42, -.2, -.92);
  const panelEdge = new THREE.LineSegments(new THREE.EdgesGeometry(panel.geometry), new THREE.LineBasicMaterial({ color: 0x7ac4c6, transparent: true, opacity: .45 })); panelEdge.position.copy(panel.position); model.add(panelEdge);
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0x54e6df, transparent: true, opacity: .8 });
  const beacon = cylinder(.1, .06, beaconMat, 3.42, .18, -.53, 'z');
  [0, 1, 2].forEach((i) => cylinder(.07, .04, new THREE.MeshBasicMaterial({ color: i === 0 ? 0x54e6df : 0x68808a }), 3.13 + i * .25, -.25, -.53, 'z'));

  const warningLight = new THREE.PointLight(0xff1838, 0, 14); warningLight.position.set(1.2, 1.7, 1.2); model.add(warningLight);
  const warningCoreMat = new THREE.MeshBasicMaterial({ color: 0xff1838, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending });
  const warningCore = new THREE.Mesh(new THREE.SphereGeometry(.16, 16, 12), warningCoreMat); warningCore.position.set(3.42, .72, -.92); warningCore.renderOrder = 12; model.add(warningCore);
  const warningRings = [];
  for (let index = 0; index < 3; index++) {
    const material = new THREE.MeshBasicMaterial({ color: 0xff2745, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.28, .025, 8, 48), material); ring.rotation.x = Math.PI / 2; ring.position.copy(warningCore.position); ring.userData.phase = index / 3; ring.renderOrder = 11; model.add(ring); warningRings.push(ring);
  }
  const warningBaseMat = new THREE.MeshBasicMaterial({ color: 0xff1838, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending });
  const warningBase = new THREE.Mesh(new THREE.TorusGeometry(4.2, .035, 8, 96), warningBaseMat); warningBase.rotation.x = Math.PI / 2; warningBase.position.y = -1.5; warningBase.scale.set(1, .4, 1); warningBase.renderOrder = 10; model.add(warningBase);
  const warningCageMat = new THREE.LineBasicMaterial({ color: 0xff2745, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending });
  const warningCage = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(9.25, 3.65, 3.45)), warningCageMat); warningCage.position.y = -.05; warningCage.renderOrder = 9; model.add(warningCage);

  const flowCurve = pipe([[-1.05, .2, -.25], [.25, .95, -.1], [1.2, 1.2, 0], [2.0, 1.25, 0], [2.65, .45, .15], [2.5, -.75, 0]], .075);
  pipe([[.65, .8, .72], [.7, 1.22, .72], [1.5, 1.3, .72], [2, 1.18, .72]], .055);
  pipe([[.65, .8, .72], [.7, 1.35, -.72], [2, 1.18, -.72]], .055);
  pipe([[-3.7, -.42, -.42], [-4.05, -.15, -.42], [-4.05, .25, -.9]], .12);

  const flow = []; const flowMaterial = new THREE.MeshBasicMaterial({ color: 0x72fff5, transparent: true, opacity: .8 });
  for (let i = 0; i < 34; i++) { const particle = new THREE.Mesh(new THREE.SphereGeometry(.045, 6, 6), flowMaterial); particle.userData.offset = i / 34; model.add(particle); flow.push(particle); }
  const leaks = [];
  for (let i = 0; i < 22; i++) { const particle = new THREE.Mesh(new THREE.SphereGeometry(.038, 5, 5), new THREE.MeshBasicMaterial({ color: 0xff5d66, transparent: true, opacity: 0 })); particle.userData.offset = i / 22; model.add(particle); leaks.push(particle); }

  const markerHost = $('sensor-markers');
  const markerParts = {
    motor: { label: 'partMotor', anchor: [-2.65, .42, -.42] },
    intake: { label: 'partIntake', anchor: [-.85, .45, -.95] },
    compressor: { label: 'partCompressor', anchor: [-.55, .55, -.38] },
    separator: { label: 'partSeparator', anchor: [.65, 1.05, .72] },
    dryer: { label: 'partDryer', anchor: [2, 1.5, 0] },
    reservoir: { label: 'partReservoir', anchor: [2.15, -.25, 0] },
    panel: { label: 'partPanel', anchor: [3.42, .72, -.92] },
    pipe: { label: 'partPipe', anchor: [2.65, .58, .15] },
    outlet: { label: 'partOutlet', anchor: [1.2, 1.2, 0] },
    apu: { label: 'partApu', anchor: [0, 1.55, -1.2] }
  };
  const signalPart = {
    tp2: 'compressor', tp3: 'panel', h1: 'separator', dv_pressure: 'dryer', reservoirs: 'reservoir',
    oil_temperature: 'compressor', motor_current: 'motor', comp: 'intake', dv_electric: 'outlet', towers: 'dryer',
    mpg: 'reservoir', lps: 'reservoir', pressure_switch: 'dryer', oil_level: 'separator', flow_impulse: 'pipe',
    health_score: 'apu', load_duty_1h: 'motor', starts_1h: 'motor', pressure_decay_bar_min: 'reservoir', pressure_recovery_bar_min: 'reservoir'
  };
  let markerRecords = [];
  function syncMarkers() {
    const groups = {};
    selected.forEach((name, index) => { const part = signalPart[name] || 'panel'; (groups[part] ||= []).push({ name: name, color: colors[index % colors.length] }); });
    const parts = Object.keys(groups);
    const links = parts.map((part) => `<path data-link="${part}" style="stroke:${groups[part][0].color}"></path>`).join('');
    markerHost.innerHTML = `<svg class="marker-links" aria-hidden="true">${links}</svg>` + parts.map((part) => {
      const rows = groups[part].map((item) => {
        const copy = sensorCopy(item.name);
        return `<small data-signal="${item.name}"><span><i style="background:${item.color}"></i>${escapeHtml(copy[0])}</span><em>${escapeHtml(copy[1])}</em></small>`;
      }).join('');
      return `<div class="equipment-marker" data-part="${part}"><span class="equipment-pin"></span><label><b>${escapeHtml(t(markerParts[part].label))}</b>${rows}</label></div>`;
    }).join('');
    markerRecords = Array.from(markerHost.querySelectorAll('.equipment-marker')).map((element) => {
      const anchor = markerParts[element.dataset.part].anchor;
      return {
        element: element, pin: element.querySelector('.equipment-pin'), label: element.querySelector('label'),
        path: markerHost.querySelector(`[data-link="${element.dataset.part}"]`),
        rows: Array.from(element.querySelectorAll('[data-signal]')), signals: groups[element.dataset.part].map((item) => item.name),
        baseColor: groups[element.dataset.part][0].color, anchor: new THREE.Vector3(anchor[0], anchor[1], anchor[2]), side: ''
      };
    });
  }
  function layoutMarkerColumn(records, side, width, height) {
    if (!records.length) return;
    const topMargin = 48, bottomMargin = 10, gap = 8, available = Math.max(40, height - topMargin - bottomMargin);
    records.sort((a, b) => a.anchorY - b.anchorY);
    const naturalHeight = records.reduce((sum, record) => sum + record.height, 0) + gap * (records.length - 1);
    const widest = records.reduce((maximum, record) => Math.max(maximum, record.width), 1);
    const horizontalScale = Math.max(.35, (width / 2 - 24) / widest);
    const scale = Math.min(1, horizontalScale, available / Math.max(1, naturalHeight));
    const scaledGap = gap * scale;
    let cursor = topMargin;
    records.forEach((record) => {
      record.scale = scale; record.visualWidth = record.width * scale; record.visualHeight = record.height * scale;
      record.targetTop = Math.max(cursor, Math.min(record.anchorY - record.visualHeight / 2, height - bottomMargin - record.visualHeight));
      cursor = record.targetTop + record.visualHeight + scaledGap;
    });
    if (cursor - scaledGap > height - bottomMargin) {
      cursor = height - bottomMargin;
      for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index]; record.targetTop = Math.min(record.targetTop, cursor - record.visualHeight); cursor = record.targetTop - scaledGap;
      }
    }
    if (records[0].targetTop < topMargin) {
      cursor = topMargin;
      records.forEach((record) => { record.targetTop = cursor; cursor += record.visualHeight + scaledGap; });
    }
    records.forEach((record) => {
      const labelLeft = side === 'left' ? 12 : width - 12 - record.visualWidth;
      record.label.style.left = labelLeft + 'px'; record.label.style.top = record.targetTop + 'px';
      record.label.style.transform = `scale(${scale})`; record.label.style.transformOrigin = 'top left';
      const endX = side === 'left' ? labelLeft + record.visualWidth : labelLeft;
      const endY = record.targetTop + record.visualHeight / 2;
      const bendX = record.anchorX + (endX - record.anchorX) * .55;
      record.path.setAttribute('d', `M ${record.anchorX} ${record.anchorY} C ${bendX} ${record.anchorY}, ${bendX} ${endY}, ${endX} ${endY}`);
    });
  }
  function updateMarkers() {
    if (!markerRecords.length) return;
    const rect = host.getBoundingClientRect(); model.updateWorldMatrix(true, true); camera.updateMatrixWorld();
    const visibleRecords = [];
    markerRecords.forEach((record) => {
      const screen = record.anchor.clone(); model.localToWorld(screen); screen.project(camera);
      const visible = screen.z > -1 && screen.z < 1 && screen.x > -1.15 && screen.x < 1.15 && screen.y > -1.15 && screen.y < 1.15;
      record.element.style.opacity = visible ? '1' : '0';
      record.path.style.opacity = visible ? '1' : '0';
      if (!visible) return;
      record.anchorX = (screen.x + 1) * .5 * rect.width; record.anchorY = (1 - screen.y) * .5 * rect.height;
      record.pin.style.left = record.anchorX + 'px'; record.pin.style.top = record.anchorY + 'px';
      record.width = record.label.offsetWidth; record.height = record.label.offsetHeight;
      visibleRecords.push(record);
    });
    const unassigned = visibleRecords.filter((record) => !record.side).sort((a, b) => a.anchorX - b.anchorX);
    unassigned.forEach((record, index) => { record.side = index < Math.ceil(unassigned.length / 2) ? 'left' : 'right'; });
    layoutMarkerColumn(visibleRecords.filter((record) => record.side === 'left'), 'left', rect.width, rect.height);
    layoutMarkerColumn(visibleRecords.filter((record) => record.side === 'right'), 'right', rect.width, rect.height);
  }
  sceneMarkerApi = { sync: syncMarkers }; syncMarkers();

  let visualLoad = 0, visualPressure = 0, visualTemperature = 0, visualHealth = 100, visualFlow = 0;
  let motionTime = 0, lastAnimationFrame = 0;
  const coolColor = new THREE.Color(0x257479), hotColor = new THREE.Color(0xff653f);
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function resize() { const rect = host.getBoundingClientRect(); renderer.setSize(rect.width, rect.height, false); camera.aspect = rect.width / rect.height; camera.updateProjectionMatrix(); }
  new ResizeObserver(resize).observe(host); resize();
  function animate(now) {
    requestAnimationFrame(animate); controls.update();
    const frameDelta = lastAnimationFrame ? Math.min(50, now - lastAnimationFrame) : 0; lastAnimationFrame = now;
    if (playing) motionTime += frameDelta;
    const frame = currentFrame || {}, sensors = frame.sensors || {}, health = frame.health || {};
    const current = Math.max(0, Number(sensors.motor_current) || 0);
    const targetLoad = clamp(Math.max((current - 1.5) / 8, Number(sensors.dv_electric) || 0), 0, 1);
    const targetPressure = clamp((Number(sensors.reservoirs) || 0) / 11, 0, 1.15);
    const targetTemperature = clamp(((Number(sensors.oil_temperature) || 40) - 45) / 55, 0, 1);
    const score = health.score == null ? NaN : Number(health.score), targetHealth = Number.isFinite(score) ? score : 100;
    const alertActive = Number.isFinite(score) && score <= 60;
    const alertStrength = alertActive ? .58 + .42 * clamp((60 - score) / 60, 0, 1) : 0;
    const warningSignals = alertActive ? relatedWarningSignals(health) : null;
    const targetFlow = clamp(Math.max(Number(sensors.flow_impulse) || 0, targetLoad * .7), 0, 1);
    apuAudio.sync(frame, playing && !document.hidden, motionTime);
    if (playing) {
      visualLoad += (targetLoad - visualLoad) * .055; visualPressure += (targetPressure - visualPressure) * .045;
      visualTemperature += (targetTemperature - visualTemperature) * .035; visualHealth += (targetHealth - visualHealth) * .04; visualFlow += (targetFlow - visualFlow) * .05;
    }

    // Constant, slow multi-axis motion keeps the equipment inspectable while OrbitControls remains available.
    model.rotation.y = -.2 + motionTime * .000035;
    model.rotation.x = -.035 + Math.sin(motionTime * .00012) * .075;
    model.rotation.z = Math.sin(motionTime * .000075) * .025;
    motorGroup.position.y = -.45 + Math.sin(motionTime * .035) * visualLoad * .012;
    if (playing) { const step = frameDelta / 16.667; rotor.rotation.x += (.012 + visualLoad * .15) * step; compressor.rotation.x += (.003 + visualLoad * .03) * step; }
    motorMat.emissiveIntensity = .2 + visualLoad * 1.25; motorMat.emissive.set(visualLoad > .25 ? 0x157f7a : 0x072427);
    compressorMat.color.copy(coolColor).lerp(hotColor, visualTemperature); compressorMat.emissive.copy(compressorMat.color); compressorMat.emissiveIntensity = .18 + visualTemperature * .7;
    reservoir.scale.set(1 + visualPressure * .025, 1 + visualPressure * .06, 1 + visualPressure * .06); reservoirMat.opacity = .48 + visualPressure * .34;
    reservoirMat.color.set(alertActive ? 0xff334f : 0x477a91);
    const activeTower = Number(sensors.towers) ? 1 : 0;
    towers.forEach((tower, index) => { const active = index === activeTower ? .85 : .1; tower.scale.setScalar(1 + active * visualLoad * .035); towerMaterials[index].emissive.set(active ? 0x16a69d : 0x082122); towerMaterials[index].emissiveIntensity = .18 + active * (.35 + visualFlow); });
    dryerValve.rotation.x = (Number(sensors.dv_electric) || 0) * Math.PI * .5;
    const warningPulse = .35 + .65 * Math.abs(Math.sin(motionTime * .009));
    const warningStrobe = Math.pow(Math.abs(Math.sin(motionTime * .018)), 6);
    warningChartPulse = warningStrobe;
    if (playing && alertActive && chartSeries.length && now - lastWarningChartDraw >= 80) {
      drawChart(); lastWarningChartDraw = now;
    }
    beaconMat.color.set(alertActive ? 0xff1838 : 0x54e6df); beaconMat.opacity = alertActive ? .62 + .38 * warningStrobe : .45 + .45 * Math.abs(Math.sin(motionTime * .002));
    warningLight.intensity = alertStrength * (2.8 + warningStrobe * 7.5); warningLight.distance = 11 + warningPulse * 6;
    warningCoreMat.opacity = alertStrength * (.45 + warningStrobe * .55); warningCore.scale.setScalar(1 + warningStrobe * 1.8);
    warningCageMat.opacity = alertStrength * (.12 + warningStrobe * .48);
    warningBaseMat.opacity = alertStrength * (.18 + warningPulse * .42);
    const basePulse = 1 + warningPulse * .06; warningBase.scale.set(basePulse, .4 * basePulse, 1); warningBase.rotation.z = motionTime * .00032;
    warningRings.forEach((ring) => {
      const phase = (motionTime * .00042 + ring.userData.phase) % 1;
      ring.scale.setScalar(.65 + phase * 4.1); ring.material.opacity = alertStrength * (1 - phase) * .86; ring.rotation.z = motionTime * .0007;
    });
    markerRecords.forEach((record) => {
      const related = Boolean(warningSignals && record.signals.some((name) => warningSignals.has(name)));
      const modalGlow = related ? alertStrength * (.52 + warningStrobe * .48) : 0;
      record.element.classList.toggle('warning-related', related);
      record.rows.forEach((row) => row.classList.toggle('warning-related-sensor', Boolean(related && warningSignals.has(row.dataset.signal))));
      record.label.style.borderColor = related ? `rgba(255,39,69,${.55 + modalGlow * .45})` : '';
      record.label.style.background = related ? `linear-gradient(145deg,rgba(74,5,17,${.7 + modalGlow * .22}),rgba(12,5,9,.94))` : '';
      record.label.style.boxShadow = related ? `0 0 ${12 + modalGlow * 25}px rgba(255,24,56,${.3 + modalGlow * .48}),0 10px 32px rgba(0,0,0,.48)` : '';
      record.pin.style.background = related ? '#ff1838' : '';
      record.pin.style.boxShadow = related ? `0 0 0 ${4 + modalGlow * 4}px rgba(255,24,56,.18),0 0 ${14 + modalGlow * 24}px #ff1838` : '';
      record.path.style.stroke = related ? '#ff2745' : record.baseColor;
      record.path.style.strokeWidth = related ? String(1.7 + modalGlow * 1.4) : '';
    });
    pipeMat.emissiveIntensity = .25 + visualFlow * 1.2;
    flow.forEach((particle) => { const q = (motionTime * .00007 * (.35 + visualFlow * 2.5) + particle.userData.offset) % 1; particle.position.copy(flowCurve.getPointAt(q)); particle.scale.setScalar(.7 + visualFlow * 1.25); particle.material.opacity = .18 + visualFlow * .78; });
    leaks.forEach((particle) => { const q = (motionTime * .00016 + particle.userData.offset) % 1; particle.material.opacity = alertStrength * (1 - q) * .95; particle.scale.setScalar(.7 + alertStrength * 2.3 * q); particle.position.set(3.08 + q * 1.3, -.92 + q * 1.15, .12 + Math.sin(q * 18 + particle.userData.offset * 6) * q * .7); });
    updateMarkers();
    renderer.render(scene, camera);
  }
  animate(0);
}

async function boot() {
  try {
    manifest = await api('manifest'); $('setup').classList.add('hidden'); $('experience').classList.remove('hidden');
    $('row-count').textContent = compact(manifest.telemetryRows); $('proof-rows').textContent = compact(manifest.telemetryRows); $('proof-values').textContent = compact(manifest.sensorValues);
    $('range-label').textContent = localClock(manifest.minTime) + ' → ' + localClock(manifest.maxTime);
    $('timeline-min').textContent = localClock(manifest.minTime); $('timeline-current').textContent = localClock(manifest.minTime); $('timeline-max').textContent = localClock(manifest.maxTime);
    applyLanguage();
    initScene(); restartTour();
  } catch (err) { $('experience').classList.add('hidden'); $('setup').classList.remove('hidden'); }
}

$('retry').addEventListener('click', boot); $('restart').addEventListener('click', restartTour);
$('language-toggle').addEventListener('click', () => { language = language === 'en' ? 'ko' : 'en'; applyLanguage(); });
$('sound-toggle').addEventListener('click', async () => {
  await apuAudio.setEnabled(!apuAudio.isEnabled());
  apuAudio.sync(currentFrame, playing && !document.hidden, performance.now());
  updateSoundButton();
});
$('timeline').addEventListener('input', scrubTimeline);
$('timeline').addEventListener('change', finishTimelineScrub);
$('transport-controls').addEventListener('click', (event) => {
  const button = event.target.closest('[data-jump-ms]');
  if (button) jumpPlayback(Number(button.dataset.jumpMs));
});
$('play').addEventListener('click', () => {
  scrubbing = false; playing = !playing; userExploring = true;
  if (!playing) { loadSequence++; playbackLoading = false; invalidateChartRefresh(); }
  else lastExplorerAdvance = performance.now() - PLAYBACK_INTERVAL_MS;
  $('play').textContent = playing ? 'Ⅱ' : '▶'; setMode('freeExplorer');
});
window.addEventListener('resize', drawChart);
document.addEventListener('visibilitychange', () => apuAudio.sync(currentFrame, playing && !document.hidden, performance.now()));
window.addEventListener('beforeunload', () => apuAudio.destroy());
function tourPlaybackTime(elapsed, index) {
  const segment = elapsed - index * 18000;
  const dataRate = PLAYBACK_STEP_MS / PLAYBACK_INTERVAL_MS;
  return Math.min(Date.parse(manifest.maxTime), tourAnchorTime + segment * dataRate);
}
function loop(now) {
  requestAnimationFrame(loop);
  if (!manifest || !playing) return;
  if (!userExploring) {
    const elapsed = (now - tourStart) % 90000;
    const index = Math.min(4, Math.floor(elapsed / 18000));
    if (index !== tourFrame) {
      tourFrame = index; lastTourAdvance = now; chapter(index);
    } else if (currentFrame && tourAnchorIndex === index && now - lastTourAdvance >= PLAYBACK_INTERVAL_MS) {
      lastTourAdvance = now; advanceTourPlayback(tourPlaybackTime(elapsed, index));
    }
  } else if (currentFrame && now - lastExplorerAdvance >= PLAYBACK_INTERVAL_MS) {
    lastExplorerAdvance = now; advancePlayback();
  }
}
applyLanguage(); requestAnimationFrame(loop); boot();
