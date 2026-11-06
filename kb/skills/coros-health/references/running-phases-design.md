# Adaptive running phases — sandbox design

Status: experimental pure module `scripts/running-phases.mjs`; NOT connected to
`sync`, `rebuild`, `analyze-latest`, or `compare`. Existing caches and CLI behavior
are deliberately unchanged pending review. This is not a production fix claim.

## Contract

Replace fixed kilometre positions with actual cruise/acceleration phases. Neither
total distance nor the final kilometre alone establishes a finishing effort.
Output status is `cruise_acceleration`, `steady_only`, or `unknown`; inference is
never user confirmation. Unknowns retain candidate boundaries and reasons, not
authoritative phase metrics. A verified annotation overrides automatic evidence.

Prototype resolution is the input lap boundary, including sub-kilometre laps.
It cannot locate a transition inside a kilometre from kilometre averages. A later
record-level adapter must decode timestamp/distance/HR/cadence/power/altitude,
respect timer start/stop events, reject gaps, and create distance bins before
claiming finer resolution. Do not interpolate a pause or invent HR coverage.

## Deterministic candidate scoring

For each candidate split, evaluate the entire prefix and suffix, without a fixed
finish length. Prototype defaults (engineering heuristics, not physiological
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

## Production integration plan (not yet executed)

1. Normalize descent and sensor coverage from FIT. Add the record-level adapter
   and evaluate boundary accuracy with independent labeled cases.
2. Add versioned `running_phases` to activities; retain old fixed metrics under
   explicitly legacy names rather than silently changing their meaning.
3. Update Skill interpretation, CSV, baseline cache, `compare` and latest output
   together. Read commands must report stale versions rather than silently using
   old fixed-segment caches or triggering writes.
4. Add explicit boundary annotation editing, validation, provenance and incremental
   invalidation keyed by FIT hash, annotation hash, detector version/config.
   Old `finish_1k` labels do not specify a general phase boundary: queue for review.
5. Offline rebuild from existing FIT into a sandbox, verify idempotency and raw
   hashes, then release only after approval. No FIT downloads or OAuth access.
6. Production migration should atomically publish coherent derived datasets and
   preserve a rollback copy; retain raw observations/FIT and user overrides.

## Validation scope

Synthetic tests cover variable phase lengths, sub-kilometre lap boundaries,
remainder isolation, timer-weighted metrics, actual-distance EF, missing HR,
downhill/pause abstention, intervals, gradual progression, mid-run bursts,
annotations, invalid records, comparison counts and deterministic repeats.
Private cache evaluation is read-only on a separate permission-restricted copy;
no real records, IDs, GPS or personal metrics belong in public test fixtures.
