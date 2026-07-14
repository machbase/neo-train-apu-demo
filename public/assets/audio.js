const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function computeApuAudioState(frame, enabled, playing, motionMs) {
  const sensors = frame && frame.sensors || {};
  const health = frame && frame.health || {};
  const hasTelemetry = Boolean(frame && frame.time && frame.sensors);
  const active = Boolean(enabled && playing && hasTelemetry);
  const motorCurrent = Math.max(0, Number(sensors.motor_current) || 0);
  const load = clamp(Math.max((motorCurrent - 1.5) / 8, Number(sensors.dv_electric) || 0), 0, 1);
  const airflow = clamp(Math.max(Number(sensors.flow_impulse) || 0, load * .7), 0, 1);
  const score = health.score == null ? NaN : Number(health.score);
  const warning = Number.isFinite(score) && score <= 60;
  const severity = warning ? .55 + .45 * clamp((60 - score) / 60, 0, 1) : 0;
  const phase = (((Number(motionMs) || 0) % 1250) + 1250) % 1250 / 1250;
  const firstBeep = phase < .14;
  const secondBeep = phase >= .26 && phase < .40;
  const alarmGate = firstBeep || secondBeep ? 1 : 0;

  return {
    active: active,
    warning: warning,
    motorHz: 44 + load * 13,
    machineLevel: active ? .025 + load * .025 : 0,
    airflowLevel: active ? .003 + airflow * .009 : 0,
    alarmHz: firstBeep ? 760 : 940,
    alarmLevel: active && warning ? alarmGate * (.045 + severity * .045) : 0
  };
}

export function createApuAudio() {
  let context = null;
  let nodes = null;
  let enabled = false;

  function build() {
    if (nodes) return;
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) throw new Error('Web Audio is not supported');
    context = new AudioContext();

    const master = context.createGain(); master.gain.value = .62; master.connect(context.destination);
    const machineGain = context.createGain(); machineGain.gain.value = 0;
    const machineFilter = context.createBiquadFilter(); machineFilter.type = 'lowpass'; machineFilter.frequency.value = 260; machineFilter.Q.value = .8;
    machineGain.connect(machineFilter); machineFilter.connect(master);

    const motor = context.createOscillator(); motor.type = 'triangle'; motor.frequency.value = 44; motor.connect(machineGain); motor.start();
    const harmonicGain = context.createGain(); harmonicGain.gain.value = .22;
    const harmonic = context.createOscillator(); harmonic.type = 'sine'; harmonic.frequency.value = 88; harmonic.connect(harmonicGain); harmonicGain.connect(machineGain); harmonic.start();

    const airflowGain = context.createGain(); airflowGain.gain.value = 0;
    const airflowFilter = context.createBiquadFilter(); airflowFilter.type = 'bandpass'; airflowFilter.frequency.value = 720; airflowFilter.Q.value = .65;
    const noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const noise = noiseBuffer.getChannelData(0);
    for (let index = 0; index < noise.length; index++) noise[index] = Math.random() * 2 - 1;
    const airflow = context.createBufferSource(); airflow.buffer = noiseBuffer; airflow.loop = true;
    airflow.connect(airflowFilter); airflowFilter.connect(airflowGain); airflowGain.connect(master); airflow.start();

    const alarmGain = context.createGain(); alarmGain.gain.value = 0;
    const alarmFilter = context.createBiquadFilter(); alarmFilter.type = 'bandpass'; alarmFilter.frequency.value = 900; alarmFilter.Q.value = 1.4;
    const alarm = context.createOscillator(); alarm.type = 'square'; alarm.frequency.value = 760;
    alarm.connect(alarmFilter); alarmFilter.connect(alarmGain); alarmGain.connect(master); alarm.start();

    nodes = { master, machineGain, motor, harmonic, airflowGain, airflowFilter, alarmGain, alarm };
  }

  function target(parameter, value, seconds) {
    const now = context.currentTime;
    parameter.cancelScheduledValues(now);
    parameter.setTargetAtTime(value, now, seconds == null ? .04 : seconds);
  }

  async function setEnabled(next) {
    enabled = Boolean(next);
    if (enabled) {
      try {
        build();
        if (context.state === 'suspended') await context.resume();
      } catch (_) {
        enabled = false;
      }
    }
    if (!enabled && nodes) {
      target(nodes.machineGain.gain, 0, .025);
      target(nodes.airflowGain.gain, 0, .025);
      target(nodes.alarmGain.gain, 0, .015);
    }
    return enabled;
  }

  function sync(frame, playing, motionMs) {
    const state = computeApuAudioState(frame, enabled, playing, motionMs);
    if (!nodes) return state;
    target(nodes.motor.frequency, state.motorHz, .06);
    target(nodes.harmonic.frequency, state.motorHz * 2, .06);
    target(nodes.machineGain.gain, state.machineLevel, .05);
    target(nodes.airflowGain.gain, state.airflowLevel, .08);
    target(nodes.airflowFilter.frequency, 620 + state.airflowLevel * 12000, .08);
    target(nodes.alarm.frequency, state.alarmHz, .012);
    target(nodes.alarmGain.gain, state.alarmLevel, state.alarmLevel > 0 ? .008 : .025);
    return state;
  }

  function destroy() {
    if (context) context.close().catch(() => {});
    context = null; nodes = null; enabled = false;
  }

  return { destroy, isEnabled: () => enabled, setEnabled, sync };
}
