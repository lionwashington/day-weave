// Experimental, pure/offline phase detector. Not wired into production caches.
export const PHASE_VERSION = 'prototype-1';
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
