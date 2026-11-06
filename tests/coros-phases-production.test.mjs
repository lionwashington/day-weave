import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Encoder, Profile } from '../kb/skills/coros-health/node_modules/@garmin/fitsdk/src/index.js';
import { normalizeActivity, resolvePaths, rebuild, compareLatest, annotatePhase } from '../kb/skills/coros-health/scripts/coros-health.mjs';
import { detectActivityPhases, recordPhaseBins } from '../kb/skills/coros-health/scripts/running-phases.mjs';

function synthetic(n, m) {
  let offset = 0; const start = new Date('2025-01-01T00:00:00Z');
  const lapMesgs = Array.from({ length: n + m }, (_, i) => {
    const seconds = i < n ? 600 : 450;
    const lap = { startTime: new Date(+start + offset * 1000), totalDistance: 1000,
      totalTimerTime: seconds, totalElapsedTime: seconds, avgHeartRate: i < n ? 120 : 140,
      totalDescent: 0, avgCadence: i < n ? 80 : 90 };
    offset += seconds; return lap;
  });
  return { lapMesgs, sessionMesgs: [{ startTime: start, sport: 'running', totalDistance: (n + m) * 1000, totalTimerTime: offset, totalElapsedTime: offset }] };
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'coros-production-'));
  const paths = resolvePaths({ workspace: root, dataRoot: join(root, 'data') });
  mkdirSync(paths.fitDir, { recursive: true });
  const rows = [];
  for (const [index, n, m] of [[1, 5, 1], [2, 6, 2]]) {
    const id = `synthetic-${index}`, messages = synthetic(n, m), encoder = new Encoder();
    encoder.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1 });
    for (const lap of messages.lapMesgs) encoder.onMesg(Profile.MesgNum.LAP, lap);
    encoder.onMesg(Profile.MesgNum.SESSION, messages.sessionMesgs[0]);
    writeFileSync(join(paths.fitDir, `${id}.fit`), Buffer.from(encoder.close()));
    rows.push({ labelId: id, date: `2025010${index}`, device: index === 1 ? 'PACE 2' : 'PACE 4', sportType: 100 });
  }
  writeFileSync(paths.activities, JSON.stringify(rows)); return { root, paths };
}
test('production normalization and CLI compare use variable-length phases', () => {
  const { root, paths } = setup();
  try {
    const first = rebuild(paths, { strict: true }); assert.equal(first.recomputed, 2);
    const raw = readFileSync(join(paths.fitDir, 'synthetic-2.fit'));
    const comparison = compareLatest(paths);
    assert.equal(comparison.target.running_phases.cruise.distance_m, 6000);
    assert.equal(comparison.target.running_phases.acceleration.distance_m, 2000);
    assert.equal(comparison.target.steady_5k, undefined);
    assert.equal(comparison.comparisons.recent_60d.phases.cruise.metrics.distance_m.delta_pct, 20);
    assert.match(readFileSync(paths.runningCsv, 'utf8'), /cruise_distance_m/);
    const cached = readFileSync(paths.baselines);
    assert.equal(rebuild(paths).skipped, true); assert.deepEqual(readFileSync(paths.baselines), cached);
    for (const discovery of ['codex', 'claude']) {
      const link = join(root, discovery); symlinkSync(resolve('kb/skills/coros-health'), link);
      for (const command of ['analyze-latest', 'compare', 'validate']) {
        const r = spawnSync(process.execPath, [join(link, 'scripts/coros-health.mjs'), command, '--data-root', paths.root], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr); const data = JSON.parse(r.stdout);
        if (command !== 'validate') assert.equal((data.activity || data.target).running_phases.acceleration.distance_m, 2000);
      }
    }
    const annotation = annotatePhase(paths, 'synthetic-2', { cruise_end_lap: 5 });
    assert.equal(annotation.rebuild.recomputed, 1); assert.equal(annotation.rebuild.reused, 1);
    assert.equal(compareLatest(paths).target.running_phases.classification, 'user');
    assert.equal(annotatePhase(paths, 'synthetic-2', { cruise_end_lap: 5 }).unchanged, true);
    assert.throws(() => annotatePhase(paths, 'synthetic-2', { cruise_end_lap: 8 }));
    assert.deepEqual(readFileSync(join(paths.fitDir, 'synthetic-2.fit')), raw);
    // Interrupted publication or old algorithms must fail closed, not compare old 5+1.
    writeFileSync(paths.baselines, '{}'); assert.throws(() => compareLatest(paths), /stale/);
    rebuild(paths);
    const state = JSON.parse(readFileSync(paths.state)); state.annotations_hash = 'stale';
    writeFileSync(paths.state, JSON.stringify(state)); assert.throws(() => compareLatest(paths), /stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('unknown runs have no fallback to whole-run means; invalid strict rebuild preserves cache', () => {
  const { root, paths } = setup();
  try {
    rebuild(paths); annotatePhase(paths, 'synthetic-2', { status: 'unknown' });
    assert.equal(compareLatest(paths).comparisons.recent_60d.steady_pace.value, null);
    const before = readFileSync(paths.activitiesJsonl);
    writeFileSync(join(paths.fitDir, 'synthetic-1.fit'), '{}');
    assert.throws(() => rebuild(paths, { strict: true }), /cache unchanged/);
    assert.deepEqual(readFileSync(paths.activitiesJsonl), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writer lock blocks concurrent CLI writes and corrupt annotations fail closed', () => {
  const { root, paths } = setup();
  try {
    rebuild(paths);
    const lock = join(root, 'data/state/activity-write.lock'); writeFileSync(lock, 'synthetic lock');
    const cli = resolve('kb/skills/coros-health/scripts/coros-health.mjs');
    const r = spawnSync(process.execPath, [cli, 'rebuild', '--fit-only', '--data-root', paths.root], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /lock exists/);
    assert.equal(readFileSync(lock, 'utf8'), 'synthetic lock');
    writeFileSync(paths.annotations, '{broken');
    assert.throws(() => rebuild(paths), /invalid annotations/);
    assert.throws(() => compareLatest(paths), /invalid annotations/);
    assert.equal(readFileSync(paths.annotations, 'utf8'), '{broken');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('record fallback locates a half-kilometre boundary and rejects pause/gaps', () => {
  let t = 0; const records = [{ distance: 0, timestamp: new Date(0), heartRate: 120 }];
  for (let i = 1; i <= 800; i++) {
    t += i <= 550 ? 6 : 4.5;
    records.push({ distance: i * 10, timestamp: new Date(t * 1000), heartRate: i <= 550 ? 120 : 140, altitude: 20 });
  }
  const session = { totalTimerTime: t, totalElapsedTime: t, totalDistance: 8000 };
  const activity = normalizeActivity({ labelId: 'synthetic-record', sportType: 100 }, synthetic(6, 2));
  const r = detectActivityPhases(activity.laps, records, session);
  assert.equal(r.resolution, 'record_bins_approximately_500m');
  assert.equal(r.cruise.distance_m, 5500); assert.equal(r.acceleration.distance_m, 2500);
  assert.equal(r.cruise.lap_indices, undefined); assert.ok(r.cruise.bin_indices);
  assert.equal(recordPhaseBins(records, { ...session, totalElapsedTime: t + 60 }), null);
  records[10].distance = 99999; assert.equal(recordPhaseBins(records, session), null);
});
