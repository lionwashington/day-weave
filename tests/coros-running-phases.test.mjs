import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRunningPhases as detect, phaseMetrics, compareRunningPhases } from '../kb/skills/coros-health/scripts/running-phases.mjs';

function laps(n, m, distance = 1000) {
  return Array.from({ length: n + m }, (_, i) => ({ lap_index: i + 1, distance_m: distance,
    timer_time_s: (i < n ? 600 : 450) * distance / 1000,
    elapsed_time_s: (i < n ? 600 : 450) * distance / 1000,
    avg_hr: i < n ? 120 : 140, avg_cadence_spm: i < n ? 160 : 180,
    total_descent_m: 0 }));
}
for (const [n, m] of [[5, 1], [6, 1], [7, 1], [8, 1], [6, 2], [5, 3]]) {
  test(`automatic ${n}+${m} uses all distance, not fixed lap numbers`, () => {
    const rows = laps(n, m); rows.push({ ...rows.at(-1), lap_index: n + m + 1, distance_m: 12, timer_time_s: 6 });
    const r = detect(rows);
    assert.equal(r.status, 'cruise_acceleration');
    assert.equal(r.cruise.distance_m, n * 1000); assert.equal(r.acceleration.distance_m, m * 1000);
    assert.equal(r.remainder.distance_m, 12); assert.equal(r.classification, 'inferred');
    assert.equal(r.cruise.ef, 100 / 120);
    assert.deepEqual(detect(rows), r);
  });
}
test('subkilometre laps retain actual boundary resolution', () => {
  const r = detect(laps(11, 5, 500));
  assert.equal(r.cruise.distance_m, 5500); assert.equal(r.acceleration.distance_m, 2500);
});
test('metrics weight HR by timer, use measured distance, never incomplete HR as complete', () => {
  const rows = laps(2, 0); rows[0].distance_m = 980; rows[1].distance_m = 1020;
  rows[0].timer_time_s = 400; rows[1].timer_time_s = 600; rows[1].avg_hr = 140;
  const r = phaseMetrics(rows); assert.equal(r.avg_hr, 132); assert.equal(r.pace_s_per_km, 500);
  assert.equal(r.ef, 120 / 132);
  rows[1].avg_hr = null; assert.equal(phaseMetrics(rows).ef, null);
  rows[1].timer_time_s = null; assert.equal(phaseMetrics(rows).time_basis, 'elapsed_fallback');
});
test('unknowns, downhill, pauses and pace-only changes cannot become confirmed phases', () => {
  for (const mode of ['downhill', 'pause', 'missing_effort', 'invalid', 'gap']) {
    const rows = laps(6, 2);
    if (mode === 'downhill') rows.slice(6).forEach(x => x.total_descent_m = 40);
    if (mode === 'pause') rows[6].elapsed_time_s += 100;
    if (mode === 'missing_effort') rows.forEach(x => { x.avg_hr = null; x.avg_cadence_spm = null; });
    if (mode === 'invalid') rows[2].distance_m = 0;
    if (mode === 'gap') rows[3].lap_index = 9;
    assert.equal(detect(rows).status, 'unknown', mode);
  }
});
test('intervals, gradual progression and a short mid-run burst are not a finishing phase', () => {
  const interval = laps(8, 0); interval.forEach((x, i) => { if (i % 2) x.timer_time_s = 350; });
  const gradual = laps(8, 0); gradual.forEach((x, i) => { x.timer_time_s -= i * 20; x.avg_hr += i * 3; });
  const burst = laps(8, 0); burst[4].timer_time_s = 350;
  for (const rows of [interval, gradual, burst]) assert.equal(detect(rows).status, 'unknown');
  assert.equal(detect(laps(8, 0)).status, 'steady_only');
});
test('explicit boundaries override evidence but invalid and legacy labels never silently migrate', () => {
  const rows = laps(6, 2);
  assert.equal(detect(rows, { cruise_end_lap: 5 }).cruise.distance_m, 5000);
  assert.equal(detect(rows, { cruise_end_lap: 5 }).classification, 'user');
  assert.equal(detect(rows, { cruise_end_lap: 99 }).status, 'unknown');
  assert.equal(detect(rows, { finish_1k: 'synthetic legacy label' }).classification, 'inferred');
});
test('different lengths compare whole phases with per-metric counts, exclude unknowns', () => {
  const r = compareRunningPhases(detect(laps(6, 2)), [detect(laps(5, 1)), detect([])]);
  assert.equal(r.cruise.count, 1); assert.equal(r.cruise.metrics.distance_m.delta_pct, 20);
  assert.equal(r.acceleration.metrics.distance_m.delta_pct, 100);
  assert.equal(r.cruise.metrics.pace_s_per_km.delta_pct, 0);
});

test('100 seeded noisy structures conserve distance and recover the boundary', () => {
  let seed = 1729;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 100; i++) {
    const n = 3 + Math.floor(random() * 7), m = 1 + Math.floor(random() * 3);
    const rows = laps(n, m);
    for (const row of rows) {
      row.timer_time_s *= 0.98 + random() * 0.04;
      row.elapsed_time_s = row.timer_time_s;
      row.avg_hr += random() * 4 - 2;
    }
    const r = detect(rows);
    assert.equal(r.status, 'cruise_acceleration');
    assert.equal(r.cruise.lap_indices.at(-1), n);
    assert.equal(r.cruise.distance_m + r.acceleration.distance_m, (n + m) * 1000);
  }
});
