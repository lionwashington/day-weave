# Workshop session switching

`ka workshop new-session <mate>` rotates one running, idle **Codex** mate to
a new conversation, or creates the first independent session for a configured
but unregistered mate. Run it from another terminal/mate, not the target pane.
`--dry-run` previews the operation; `--recover` explicitly rolls an interrupted
transaction back to its previous thread. Claude's adapter is unchanged.

The command does not edit workshop.yaml, delete history, compact a transcript,
or launch a new model turn. It restarts only the selected pane/App Server.
The Channel daemon must have the session-switch API installed first.

## Contract

- Existing mates retain directory-latest selection until a session binding is
  created. After new-session, `<channel>.session.json` under the private runtime
  state selects the mate's exact thread, taking precedence over legacy resume
  arguments. Changing a bound workspace is rejected rather than silently reused.
- A Channel idle check includes pending inbound work and the server's thread
  status. Busy mates are refused, not interrupted. An offline mate that already
  has a managed binding must first be started, preserving the rollback anchor.
- A bound, still-empty session may not yet have a Codex rollout. On restart only
  an explicitly recorded unpersisted binding and a precise missing-rollout error
  permit creating an empty replacement. Once a turn is saved, its ID is stable.
  Rotating again before the first turn is saved is refused (no rollback anchor).
- Inbound messages during the switch enter a private, atomically written hold
  queue (including attachment references). Registration retries do not bypass it.
- The TUI, registrar and Channel must agree on the new thread before release.
  A failed startup restores the old binding and attempts to restart it. If
  recovery fails, the queue remains held and the command reports failure.
  For a failed first launch there is no previous thread: `--recover` retries
  that fresh launch without falling back to shared directory-latest.
- A dead controller leaves a journal. `--recover` accepts only a dead controller
  lock; it never terminates a live controller or guesses another same-cwd thread.
- A daemon restart restores held queues. A delivery already marked in-flight
  is **not automatically replayed**: it may already have reached the model.
  Such entries remain available for manual review. Delivered entries are audit
  records, not candidates for replay.
- Switching success means the new runtime and routing are ready, not that all
  queued model replies have completed. No new background process is introduced.

Native TUI `/new` is not this transaction and is not a supported replacement.
Telegram `/new` is not introduced by this change. Use the CLI consistently.
Shared cwd means shared files, not a filesystem/security boundary.
Every mate sharing that cwd (including an existing main) needs its own binding;
leaving one on directory-latest can still select a sibling's newer thread.
Rotating one mate does not silently change the policies of its siblings.

## State and testing

Private runtime state contains `<channel>.session.json`, the switch journal and
controller lock. The Channel's `session-switches/` directory contains private
message queues, mode 0600; do not commit or print their contents.

Tests use synthetic identities, isolated temporary roots and loopback endpoints:

```sh
node --test tests/workshop-new-session.test.mjs tests/workshop-thread-selection.test.mjs
node --experimental-strip-types --test tests/channel-core/session-switch.test.ts tests/channel-core/codex-registration-race.test.ts
# Opt-in real Codex/TUI + Channel with a local mock model, isolated from production:
pnpm test:workshop:sessions:e2e
```
