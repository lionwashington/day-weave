# Adaptive running phases — production contract

Detector version 1 is used by `sync`, `rebuild`, `analyze-latest`, `compare`, CSV
and baseline outputs. Activity schema 2 / algorithm 3 require offline migration.

## Contract

Replace fixed kilometre positions with actual cruise/acceleration phases. Neither
total distance nor the final kilometre alone establishes a finishing effort.
Output status is `cruise_acceleration`, `steady_only`, or `unknown`; inference is
never user confirmation. Unknowns retain candidate boundaries and reasons, not
authoritative phase metrics. A verified annotation overrides automatic evidence.

Lap inference uses actual lap boundaries. If complete timestamp/distance records
are available, a refinement pass builds approximately 500m bins and prefers a
supported record-based boundary. It rejects pauses (>10s elapsed/timer difference),
nonpositive increments, time gaps >15s, distance jumps >100m, implausible speed,
or >2% discrepancy from session distance/timer. It never bridges stop events or
guesses missing timer time. Missing records fall back to lap resolution with a
warning. Bin indices are explicitly distinct from lap indices; boundaries are
approximate, not exact physiological transition times. Known lap-level pause or
downhill confounds cannot be bypassed by record refinement.

## Deterministic candidate scoring

For each candidate split, evaluate the entire prefix and suffix, without a fixed
finish length. Defaults (engineering heuristics, not physiological
thresholds or calibrated probabilities):

- At least 2 km preceding cruise, 700 m and 120 s of sustained acceleration.
- Suffix pace at least 10% faster; every suffix lap at least 10% faster than the
  cruise aggregate; adjacent-boundary pace change at least 8%.
- Cruise distance-weighted pace deviation <=12%; two-phase squared-error
  improvement >=65% over the one-phase fit.
- Effort corroboration: HR +5 bpm, cadence +4%, or power +8%.
- Similar candidate scores (<0.08 improvement difference) remain ambiguous.
- Known descent >2% or significant elapsed/timer discrepancy blocks automatic
  acceptance. Missing terrain is exposed as a warning, not treated as flat ground.
- Only a clearly short final remainder (<500 m and <half the preceding median
  lap distance) is isolated. Interior short laps are not silently removed.

These conservative rules intentionally abstain on gradual progression, intervals,
mixed workouts and weak evidence. They do not recognize every valid finishing
effort. No accuracy percentage can be inferred from unlabeled historical data.
Alternative manual lap structure or long partial tails need record-level evidence
or review, not a forced conversion to full-kilometre laps.

## Metrics and comparison

Use actual summed distance, not lap count times 1000. Timer time is primary;
elapsed fallback is explicitly marked. Pace = time / distance; HR is time-weighted;
EF = (distance metres * 60 / effective seconds) / weighted HR. Incomplete HR
coverage yields null HR/EF, with coverage reported. Preserve phase distance,
duration, cadence, power and classification separately.

Compare cruise against cruise, acceleration against acceleration, including
different phase distances. Report distance and duration beside pace/HR/EF, mean,
median, percentage difference and per-metric sample counts. Exclude unknown
phases; never replace missing cruise metrics with whole-run averages. Keep
confirmed vs inferred cohorts, device/temperature and same-distance cohorts
visible. Duration differences are not proof of improved fitness.

## Migration, overrides and consistency

Run `rebuild --fit-only` offline after upgrade, preserving a private rollback copy
of `derived/` and `state/` first. Raw FIT and wellness are untouched. Normalized
rows reuse unchanged FIT+metadata+annotation+algorithm input hashes. Repeating
rebuild with identical inputs and intact outputs skips all writes. Sync also
detects annotation changes. Explicit boundary edits recompute only the affected
activity, then regenerate aggregate files.

Use `annotate-phase --activity-id ID --cruise-end-lap N`, or `--status steady_only`
/ `--status unknown`. Store under `state/annotations.json` as `running_phases`;
the command preserves previous labels and appends `phase_history`. Identical
corrections are no-ops. Old `finish_1k` labels alone are not a general phase
boundary and emit a review warning; never silently relabel a different kilometre.

Activity CLI writers take `state/activity-write.lock`. Live locks are not removed
automatically. In an interrupted writer, verify its PID is dead before removing
the lock and rebuilding. Strict rebuild validates all FIT before publishing.
Each file is atomically replaced, then a checksum manifest is written to state
last. Read commands reject stale algorithms, changed annotations or inconsistent
files instead of using a partially published cache. This is fail-closed multi-file
publication, not a filesystem-wide transaction. Readers remain offline/read-only.

Legacy fixed-distance metrics exist only under `legacy_fixed_segments`, never in
current comparison calculations. `comparisons.*.phases` includes distances,
durations and metric counts; the old `steady_*`/`finish_*` comparison keys now alias
the actual cruise/acceleration metrics. Device groups also use actual phases.

## Validation scope

Synthetic tests cover variable phase lengths, sub-kilometre lap boundaries,
remainder isolation, timer-weighted metrics, actual-distance EF, missing HR,
downhill/pause abstention, intervals, gradual progression, mid-run bursts,
annotations, invalid records, comparison counts and deterministic repeats.
Private cache evaluation is read-only on a separate permission-restricted copy;
no real records, IDs, GPS or personal metrics belong in public test fixtures.
