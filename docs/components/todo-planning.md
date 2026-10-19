# Read-only execution planning

`kb/ops/todo-plan.mjs` adds deterministic planning to the existing KB and
daily brief. It is not a second task database, reminder sender, or background
worker. `memory/topics/todo.md` remains the sole execution state. Calendar events
are appointments or reminder receipts, never evidence that preparation was done.

## Commands

From the personal workspace (or pass `--file`):

```sh
node "$KA_HOME/kb/ops/todo-plan.mjs" plan --date YYYY-MM-DD
node "$KA_HOME/kb/ops/todo-plan.mjs" plan --date YYYY-MM-DD --calendar /private/events.json
```

The CLI reads only the first `## 当前执行看板` (or `## Current execution board`)
section, ending at the next level-two heading. Historical todo entries never
become active tasks. Legacy table rows and bold bullet items remain
`review_candidates`; they are not verified execution state. Dates in prose are
not guessed. Missing/conflicting facts require main's source verification.

### Incremental adoption, no duplicated state

Main may replace a reviewed current item with a `todo-task` JSON fence in the
same board. Do not keep two independently maintained copies of that item. Never
bulk migrate the historical section or automatically infer completion. All
fields and evidence remain private. Synthetic example:

````markdown
```todo-task
{
  "id": "review-packet",
  "title": "Review preparation packet",
  "priority": "P1",
  "priority_reason": "Missing material could prevent attendance",
  "status": "active",
  "next_action": "Check the latest materials list",
  "owner": "assistant",
  "waiting_for": null,
  "next_check": "2031-04-03",
  "hard_deadline": null,
  "prepare_by": "2031-04-04",
  "dependencies": [],
  "source": "Current board and verified source note",
  "last_verified": "2031-04-03",
  "reminder_ids": [],
  "appointment_ids": []
}
```
````

- `priority`: P0 through P3, with a reason; this is explicitly maintained, not an
  opaque automated score. Tasks sort by priority, deadline/preparation date, ID.
- `status`: active / waiting / deferred / completed. Completion requires
  `completion: {"confirmed": true, "evidence": "explicit confirmation source"}`.
  No calendar attendance assumption or old agreement establishes completion or
  current obligation. Completed records can later be archived through existing KB
  workflow; this CLI does not delete source material.
- `hard_deadline` requires `deadline_source`; uncertain dates stay null. Keep
  internal `prepare_by` separate. Date fields are ISO calendar dates, not reminder
  timestamps. Exact appointment times belong to Calendar/source documents.
  For read compatibility only, an otherwise valid existing block missing a
  nonempty `deadline_source` remains in its task group with the original date,
  `deadline_verified:false`, and a `deadline_source_missing` issue. Its date is
  not used as a confirmed-deadline sort key. Never infer a deadline source from
  generic `source`. New updates remain strict and require verified provenance.
  Malformed JSON and other invalid fields still reject the block, with safe
  validation reasons in `issues` (never the original JSON parse error text).
- `owner`: user / assistant. `waiting_for` names the external dependency;
  `next_check` controls when a waiting task can become an action. New evidence is
  incorporated explicitly by main, not inferred by this program.
- `dependencies`: stable IDs. Missing IDs, duplicates and cycles are review
  issues; unresolved dependencies block actions. Preserve minimal completed
  dependency records or update links when main archives them.
- `source` and `last_verified`: provenance, not a claim that this program checked
  the source. Source conflicts in unstructured records are candidates for human/
  agent review, not semantic conflict resolution by regex.

## Calendar input and reminder proposals

Use the existing calendar skill to read gogcli events and normalize a private
snapshot: `{as_of: "YYYY-MM-DD", timezone: "Asia/Hong_Kong", events: [...]}`.
Preserve original event IDs, summary, status, transparency and offset-bearing
`start.dateTime`/`end.dateTime`. Mark only verified action reminders with
`kind: "reminder"`; appointments must never receive that classification.
All-day/floating times are reported for review, not silently timezone-converted.
Set `protected: true` on course reminder series and other protected events.
Never overwrite existing seven-stage course reminders.

Busy timed overlaps and upcoming seven-day materials/travel/conflict checks are
reported, not resolved. `executed:false` is deliberate. A current snapshot is
required for reminder proposals. Existing task reminder IDs, matching
`task_id`/`checkpoint` receipts or dated `Google Calendar ID` entries suppress new
creation proposals. Main must record a creation receipt in todo before retrying;
the CLI does not persist a competing reminder ledger. Repeated plans are
deterministic and have no external effect.

Completion produces only `review_remove` proposals for known, unprotected,
unshared action reminders; actual appointments remain. Every proposal requires
confirmation through the calendar workflow. Ordinary create proposals are
suppressed outside 08:00–20:00 and propose 10:00 local time. `--hour` is a test/
review override, not permission to send. A new urgent situation still requires
main's judgment rather than automatic nighttime escalation.

## Controlled local update

```sh
node "$KA_HOME/kb/ops/todo-plan.mjs" update --file /private/work/memory/topics/todo.md \
  --task /private/reviewed-task.json --expected-hash <plan-source-hash>
# Only after reviewing the preview, repeat with --apply.
```

Only one existing structured task can be replaced; adding/converting legacy
items remains an explicit reviewed Markdown edit. Hash checks, a sibling lock
and atomic rename protect cooperating writers; arbitrary editors that ignore the
lock are not coordinated. Main must serialize updates with other agents. History
and unrelated text are preserved. No credentials, calendar API, email, payment,
visa submission, court contact or booking operation exists in this CLI.

## Deployment and scheduling boundary

Code deploys with the existing `--only ka` ops installer; the daily-brief skill
is a separate skill deployment. A plan reports `automatic_checks:false` because
this CLI never schedules or executes checks. An existing daily-brief cron does
not prove the new planning integration is installed or that every external source
was checked. Report installation, actual cron configuration, last invocation and
delivery separately. Production configuration/schedule changes need explicit
scope confirmation. No new timer or daemon is required for this enhancement.
