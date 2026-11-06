// Deterministic, offline running-phase detector. Never equate inference with intent.
export const PHASE_VERSION = '1';
const valid = x => Number.isFinite(x) && x > 0;
const sum = xs => xs.reduce((a, b) => a + b, 0);
const median = xs => { const a = [...xs].sort((a, b) => a - b); return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
const time = x => valid(x.timer_time_s) ? x.timer_time_s : x.elapsed_time_s;

export function phaseMetrics(laps) {
  if (!laps.length || laps.some(x => !valid(x.distance_m) || !valid(time(x)))) return null;
  const seconds = sum(laps.map(time)), distance = sum(laps.map(x => x.distance_m));
  const weighted = key => laps.every(x => valid(x[key])) ? sum(laps.map(x => x[key] * time(x))) / seconds : null;
  const hr = weighted('avg_hr');
  return {
    lap_indices: laps.map(x => x.lap_index), distance_m: distance, effective_time_s: seconds,
    time_basis: laps.every(x => valid(x.timer_time_s)) ? 'timer' : 'elapsed_fallback',
    pace_s_per_km: seconds * 1000 / distance, avg_hr: hr,
    ef: hr ? distance * 60 / seconds / hr : null,
    avg_cadence_spm: weighted('avg_cadence_spm'), avg_power_w: weighted('avg_power_w'),
    max_hr: laps.every(x => valid(x.max_hr)) ? Math.max(...laps.map(x => x.max_hr)) : null,
    max_speed_mps: laps.every(x => valid(x.max_speed_mps)) ? Math.max(...laps.map(x => x.max_speed_mps)) : null,
    avg_temperature_c: laps.every(x => Number.isFinite(x.avg_temperature_c)) ? sum(laps.map(x => x.avg_temperature_c * time(x))) / seconds : null,
    hr_coverage: sum(laps.filter(x => valid(x.avg_hr)).map(time)) / seconds,
  };
}

export function detectRunningPhases(laps, annotation = null) {
  const result = { version: PHASE_VERSION, status: 'unknown', classification: null,
    confidence: 'low', resolution: 'lap_boundary', cruise: null, acceleration: null,
    remainder: null, candidates: [], reasons: [], warnings: [] };
  if (!Array.isArray(laps) || !laps.length || !phaseMetrics(laps)
      || laps.some((x, i) => !Number.isInteger(x.lap_index) || (i > 0 && x.lap_index !== laps[i - 1].lap_index + 1))) {
    result.reasons.push('invalid_or_noncontiguous_laps'); return result;
  }
  let body = [...laps];
  // Only a clearly short final remainder is separated; never discard interior laps.
  if (body.length > 1 && body.at(-1).distance_m < Math.min(500, median(body.slice(0, -1).map(x => x.distance_m)) / 2)) {
    result.remainder = phaseMetrics(body.splice(-1));
  }
  const total = phaseMetrics(body);
  if (!total) { result.reasons.push('no_analyzable_body'); return result; }
  if (annotation?.status === 'unknown') return { ...result, classification: 'user', reasons: ['user_excluded'] };
  if (annotation?.status === 'steady_only') return { ...result, status: 'steady_only', classification: 'user', confidence: 'confirmed', cruise: total, reasons: ['user_confirmed_steady'] };
  if (annotation?.cruise_end_lap !== undefined) {
    const k = body.findIndex(x => x.lap_index === annotation.cruise_end_lap) + 1;
    if (k < 1 || k >= body.length) { result.reasons.push('invalid_annotation'); return result; }
    return { ...result, status: 'cruise_acceleration', classification: 'user', confidence: 'confirmed',
      cruise: phaseMetrics(body.slice(0, k)), acceleration: phaseMetrics(body.slice(k)), reasons: ['explicit_boundary'] };
  }
  const paces = body.map(x => time(x) * 1000 / x.distance_m);
  const error = xs => { const p = phaseMetrics(xs).pace_s_per_km; return sum(xs.map(x => x.distance_m * (time(x) * 1000 / x.distance_m - p) ** 2)); };
  const baseError = error(body);
  for (let k = 1; k < body.length; k++) {
    const a = body.slice(0, k), b = body.slice(k), cruise = phaseMetrics(a), acceleration = phaseMetrics(b);
    if (cruise.distance_m < 2000 || acceleration.distance_m < 700 || acceleration.effective_time_s < 120) continue;
    const gain = 1 - acceleration.pace_s_per_km / cruise.pace_s_per_km;
    const steadySpread = Math.sqrt(error(a) / cruise.distance_m) / cruise.pace_s_per_km;
    const sustained = b.every(x => time(x) * 1000 / x.distance_m <= cruise.pace_s_per_km * 0.9);
    const boundaryJump = 1 - paces[k] / paces[k - 1];
    const improvement = baseError ? 1 - (error(a) + error(b)) / baseError : 0;
    if (gain < 0.1 || boundaryJump < 0.08 || steadySpread > 0.12 || !sustained || improvement < 0.65) continue;
    const hr = cruise.avg_hr && acceleration.avg_hr && acceleration.avg_hr >= cruise.avg_hr + 5;
    const cadence = cruise.avg_cadence_spm && acceleration.avg_cadence_spm && acceleration.avg_cadence_spm >= cruise.avg_cadence_spm * 1.04;
    const power = cruise.avg_power_w && acceleration.avg_power_w && acceleration.avg_power_w >= cruise.avg_power_w * 1.08;
    const terrainKnown = b.every(x => Number.isFinite(x.total_descent_m));
    const downhill = terrainKnown && sum(b.map(x => x.total_descent_m)) / acceleration.distance_m > 0.02;
    const pause = [...a, ...b].some(x => valid(x.timer_time_s) && valid(x.elapsed_time_s) && x.elapsed_time_s - x.timer_time_s > Math.max(30, x.timer_time_s * 0.1));
    result.candidates.push({ cruise_end_lap: a.at(-1).lap_index, cruise, acceleration,
      pace_gain: gain, fit_improvement: improvement, effort_support: Boolean(hr || cadence || power),
      downhill, pause, terrain_known: terrainKnown });
  }
  result.candidates.sort((a, b) => b.fit_improvement - a.fit_improvement);
  const best = result.candidates[0];
  if (best) {
    if (!best.effort_support) result.reasons.push('pace_change_without_effort_support');
    if (best.downhill) result.reasons.push('downhill_confounded');
    if (best.pause) result.reasons.push('pause_confounded');
    if (result.candidates[1] && best.fit_improvement - result.candidates[1].fit_improvement < 0.08) result.reasons.push('ambiguous_boundary');
    if (result.reasons.length) return result;
    if (!best.terrain_known) result.warnings.push('terrain_unavailable');
    return { ...result, status: 'cruise_acceleration', classification: 'inferred', confidence: 'medium',
      cruise: best.cruise, acceleration: best.acceleration, reasons: ['sustained_pace_change_with_effort_support'] };
  }
  const spread = (Math.max(...paces) - Math.min(...paces)) / median(paces);
  if (spread <= 0.1) return { ...result, status: 'steady_only', classification: 'inferred', confidence: 'medium', cruise: total, reasons: ['no_detectable_acceleration'] };
  result.reasons.push('variable_or_multiphase_run');
  return result;
}

export function compareRunningPhases(target, history) {
  const out = {};
  for (const phase of ['cruise', 'acceleration']) {
    const current = target[phase];
    const rows = history.filter(x => x[phase]).map(x => x[phase]);
    out[phase] = { count: rows.length, target: current, metrics: {} };
    for (const key of ['distance_m', 'effective_time_s', 'pace_s_per_km', 'avg_hr', 'ef']) {
      const values = rows.map(x => x[key]).filter(Number.isFinite);
      const mean = values.length ? sum(values) / values.length : null;
      out[phase].metrics[key] = { count: values.length, mean, median: values.length ? median(values) : null,
        delta_pct: current && Number.isFinite(current[key]) && mean ? (current[key] - mean) / mean * 100 : null };
    }
  }
  return out;
}

// Record fallback for boundaries hidden by auto-lap averages. Do not bridge
// pauses, missing timestamps or distance jumps; those require review instead.
export function recordPhaseBins(records, session = {}) {
  if (!Array.isArray(records) || records.length < 2) return null;
  if (!valid(session.totalTimerTime) || !valid(session.totalDistance) || !valid(session.totalElapsedTime)
      || Math.abs(session.totalElapsedTime - session.totalTimerTime) > 10) return null;
  const bins = []; let intervals = [], start = 0, distance = 0;
  const flush = () => {
    if (!intervals.length) return;
    const m = phaseMetrics(intervals);
    bins.push({ ...m, lap_index: bins.length + 1, timer_time_s: m.effective_time_s,
      elapsed_time_s: m.effective_time_s, total_descent_m: intervals.every(x => Number.isFinite(x.total_descent_m)) ? sum(intervals.map(x => x.total_descent_m)) : null,
      start_distance_m: start, end_distance_m: start + m.distance_m });
    start += m.distance_m; distance = 0; intervals = [];
  };
  for (let i = 1; i < records.length; i++) {
    const a = records[i - 1], b = records[i];
    if (!Number.isFinite(a.distance) || !Number.isFinite(b.distance)) return null;
    const dt = (new Date(b.timestamp) - new Date(a.timestamp)) / 1000;
    const dd = b.distance - a.distance;
    if (!valid(dt) || dt > 15 || !valid(dd) || dd > 100 || dd / dt > 10) return null;
    const altA = a.enhancedAltitude ?? a.altitude, altB = b.enhancedAltitude ?? b.altitude;
    const cadence = b.cadence;
    intervals.push({ distance_m: dd, timer_time_s: dt, avg_hr: b.heartRate,
      avg_cadence_spm: valid(cadence) ? cadence < 130 ? cadence * 2 : cadence : null,
      avg_power_w: b.power, max_hr: b.heartRate, max_speed_mps: dd / dt,
      avg_temperature_c: b.temperature,
      total_descent_m: Number.isFinite(altA) && Number.isFinite(altB) ? Math.max(0, altA - altB) : null });
    distance += dd;
    if (distance >= 500) flush();
  }
  flush();
  const total = phaseMetrics(bins);
  if (!total || Math.abs(total.distance_m / session.totalDistance - 1) > 0.02
      || Math.abs(total.effective_time_s / session.totalTimerTime - 1) > 0.02) return null;
  return bins;
}

export function detectActivityPhases(laps, records, session, annotation) {
  const result = detectRunningPhases(laps, annotation);
  if (annotation || result.reasons.some(x => ['pause_confounded', 'downhill_confounded', 'invalid_or_noncontiguous_laps'].includes(x))) return result;
  const bins = recordPhaseBins(records, session);
  if (!bins) return { ...result, warnings: [...result.warnings, 'record_refinement_unavailable'] };
  const refined = detectRunningPhases(bins);
  if (refined.status !== 'cruise_acceleration') return result;
  for (const phase of [refined.cruise, refined.acceleration, refined.remainder, ...refined.candidates.flatMap(x => [x.cruise, x.acceleration])]) {
    if (phase?.lap_indices) { phase.bin_indices = phase.lap_indices; delete phase.lap_indices; }
  }
  for (const c of refined.candidates) { c.cruise_end_bin = c.cruise_end_lap; delete c.cruise_end_lap; }
  return { ...refined, resolution: 'record_bins_approximately_500m', boundary_distance_m: refined.cruise.distance_m,
    warnings: [...refined.warnings, 'record_boundary_is_approximate'] };
}
