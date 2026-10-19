# Agent Runtime Adapter Interface

Contract every runtime adapter (`workshop/ops/runtimes/<name>/`) must implement so
that the `ka` CLI can target it without any runtime-specific code in the top-level
commands.

> **Status**: implemented for **cc** and **codex**. The CC-specific logic lives behind sourced
> adapter files in `workshop/ops/runtimes/cc/` (`launch.sh`, `ready-signals.sh`,
> `send-prompt.sh`, `post-launch.sh`) plus `cc/bin/start-pane.sh`;
> `workshop/ops/runtimes/dispatch.sh` loads them. Codex uses a Workshop-owned App
> Server sidecar, selects the most recent thread whose cwd exactly matches the
> mate cwd, and connects both its TUI and Channel to that canonical thread;
> `args: [resume, <thread-id>]` is the validated override. If no matching session
> exists, the TUI creates a fresh canonical thread and Workshop adopts it instead
> of creating a separate Channel-only thread. `gemini` remains reserved. This doc is the contract
> the cc adapter satisfies and any new runtime must implement.

## Naming convention

Functions live in `workshop/ops/runtimes/<runtime>/<topic>.sh` and are named
`runtime::<verb>`. The dispatcher (`workshop/ops/runtimes/dispatch.sh`) chooses the
runtime from `workshop.yaml`'s `runtime:` field (top-level default, per-pane or
per-mate override) and `source`s the matching files before calling.

```
workshop/ops/runtimes/
├── dispatch.sh                      (the adapter loader)
├── cc/                              (the implemented CC adapter)
│   ├── launch.sh · ready-signals.sh · send-prompt.sh · post-launch.sh
│   ├── bin/start-pane.sh
│   └── (doc: docs/components/workshop-runtime-cc.md)
├── codex/                          (interactive TUI adapter)
└── gemini/  (reserved, not implemented)
```

## Required functions

### `runtime::ready_match <captured_text>`
Given the text captured from `tmux capture-pane -p -J`, return exit 0 if the
text indicates the runtime's TUI has finished booting and is accepting input,
exit 1 otherwise. No I/O — pure predicate. Must be fast.

**CC**: `workshop/ops/runtimes/cc/ready-signals.sh` (used by `workshop/ops/wait-ready.sh`) — matches `❯` /
`│ >` / bottom status-line hints.

### `runtime::inject_prompt <tmux_target> <text>`
Paste `text` into the runtime's input area at `tmux_target` and submit it.
Must handle runtime-specific quirks (CC needs `send-keys -l` + 0.5s sleep +
`C-m`, because `send-keys Enter` is eaten by the TUI under some locales).

**CC**: `workshop/ops/runtimes/cc/send-prompt.sh`.

### `runtime::launch_binary`
Echo the runtime's executable name (CC: `claude`). **CC**: `workshop/ops/runtimes/cc/launch.sh`.

### `runtime::launch_pane_script`
Echo the path to the per-pane launch script (guarantees cwd, sets the channel
via `KA_CHANNEL`, resolves `--resume`). The top-level `start-pane.sh` is only a
dispatcher. **CC**: `workshop/ops/runtimes/cc/bin/start-pane.sh`.

The Codex implementation also owns the App Server sidecar lifecycle. While the
pane is alive it registers the socket with Channel's loopback API and retries
registration after Channel restarts. Pane exit unregisters the target and stops
the sidecar.

For an existing session, the selector resumes either the explicit validated
thread ID or the latest exact-cwd thread (`resume --last` and `resume latest` are
accepted compatibility aliases). For a fresh cwd, Workshop launches the TUI
without `resume` in the pane foreground, while a background registrar waits for
its `thread/started`/`thread/list` result and registers that ID immediately.
Foreground ownership is required for reliable terminal input initialization.
Because the rollout may not yet be resumable, the first registration carries
`allow_unpersisted_thread`; after persistence the registrar
reposts the same runtime identity without that flag. Channel promotes the existing
client with `thread/resume`, preserving the active WebSocket and enabling delta
notifications used by platform streaming.

Default selection queries App Server `thread/list` with the mate's exact cwd,
ordered by `recency_at` descending. The runtime `state/codex-app-servers/<mate>.thread`
file is output-only: it records the selected ID for consumers such as distillation,
but never pins the next startup. An old or missing record cannot override latest.
Keep each mate's persistent sessions in its own cwd. Creating and persisting a
new session in that cwd makes it eligible on the next startup without editing
Workshop configuration. Explicit `resume <id>` remains an intentional override;
lookup errors or cwd mismatches fail closed rather than silently switching sessions.
The TUI and Channel registrar use the same selected ID for each startup. Switching
threads inside an already-running TUI is not a live Channel rebind mechanism.

### Codex cold startup and launch confirmation

An App Server can return `thread not loaded: <id>` when the selector reads a
saved thread before resuming it. Only that exact `-32600` response permits the
selector to continue with `thread/resume` for the same ID. The resumed cwd must
still match. An unloaded thread is not a missing thread. Default selection uses
the latest exact-cwd thread and does not read a saved implicit owner.
Explicit missing IDs, transport failures, timeouts and workspace mismatches
remain errors.

The Codex `runtime::post_launch` hook waits for stable TUI readiness using
`wait-ready.sh` before `start` reports success. This also validates an existing
pane without restarting it. A missing/dead pane, failed creation, hook failure
or readiness timeout returns nonzero instead of `launched`. A retained dead
pane's ready-looking screen does not count as readiness. Set
`KA_WORKSHOP_START_TIMEOUT` to a positive integer to override the default
60-second timeout. `--dry-run` does not wait. Channel registration and KB
availability are not prerequisites for TUI readiness.

The wrapper records `starting`, `running`, or `exited` in the pane option
`@ka_codex_tui_state`. An exited TUI is not ready even if its App Server and
fallback shell remain alive. Upgrade confirmation dialogs and legacy wrapper
exit messages cannot satisfy readiness through residual prompt text. This adds
no daemon or background process; panes launched before this marker was added
remain compatible through the existing screen signals.
Hook review/trust/skip dialogs also defeat readiness even if an ordinary
composer or status remains visible behind them. They fail promptly with an
actionable `/hooks` diagnosis rather than waiting for a generic startup timeout.
They are never auto-confirmed through synthetic keystrokes.

Launch confirmation also performs a bounded WebSocket `initialize` handshake
with the selected App Server. A listening TCP socket or a live process alone
is not proof that it can respond to the Codex protocol. Each probe has a one-second
budget, including connection shutdown; it sends only `initialize`/`initialized`,
never creates/resumes a thread or starts a model turn. It does not inspect
credentials, depend on Channel/KB, or add a persistent process.

The wrapper resolves the installed executable once before launch, checks
`--version`, and uses that path for both App Server and TUI, even if the public
installation symlink changes during startup. It records the selected version
in its local startup log and `@ka_codex_version`. Failure to open a listener stops before thread lookup.
The pane option `@ka_codex_app_server_endpoint` identifies new instances;
already-running wrappers can supply their endpoint through the last 40 log
lines. Missing metadata fails explicitly instead of trusting a screen alone.

The returned server version must match the currently installed CLI. A mismatch
fails immediately and recommends restarting only that mate; transport failures
and temporarily unresponsive servers are retried within the readiness timeout.
The probe reports only bounded reason codes and versions, never raw RPC errors,
user-agent metadata, credential values or remote messages. Claude's adapter
does not run this Codex-specific probe or version check.

`ready` confirms the foreground TUI and local App Server/version, not a successful
model response. Model authorization, quota and external-network failures can
still occur on a subsequent turn and must be reported separately. The readiness
probe itself never upgrades, reauthorizes, confirms modals or restarts.

### Restart-time Codex updates

Only an explicit `workshop restart` opts newly created panes into update
recovery. Ordinary `start`, existing-pane checks and Claude remain unchanged.
`wait-ready` returns 4 for an update menu (not readiness). The short-lived
`upgrade-on-restart.mjs` requires an exact versioned menu, three known choices,
and a stable highlighted choice across two observations. If Skip is selected,
it moves Up to the built-in **Update now** choice and verifies that rendered
selection before sending one Enter. It never executes the displayed installation
command, and requires both the success marker and installed version advancement.
It leaves the installer/pane untouched on error or timeout (default 300 seconds,
bounded by `KA_CODEX_UPGRADE_TIMEOUT`). Unknown UI requires manual review.

On success, the post-launch hook temporarily retains the pane, invokes the
existing verified `stop-runtime.py` process-group shutdown, and respawns that
exact pane's original command. This reloads both pinned TUI and App Server,
preserving cwd/model/thread-selection arguments without rewriting config.
The temporary pane retention override is restored, and readiness/version checks
run again. Only one respawn is allowed; a second update prompt is a failure.
If a previous mate in the same restart already updated the shared installation,
the remaining old pinned process reloads once without reinstalling. This does
not add a resident process or restart other live mates. Failed recovery never
reports launch success.

Passive release-notice banners are not modals: observing one sends no keys and
does not block a live composer. The real-binary E2E checks this distinction using
only a synthetic version cache in an isolated Codex home; it never runs the real
host installer. Installation/restart E2E instead uses synthetic executables.

Regression checks:

```sh
node --test tests/workshop-thread-selection.test.mjs tests/workshop-start.test.mjs tests/workshop-health.test.mjs
bash tests/cases/16-runtime-cc-contract.sh
bash tests/cases/17-runtime-codex-contract.sh
```

### Slow Codex registration and retries

The registrar's short HTTP timeout does not cancel the daemon's background
`thread/resume`. Runtime registration is therefore serialized **per mate** across
the whole connect/resume operation, including retries from disconnected callers.
After success, same-instance retries reuse the existing connection; changed
instances are replaced in request order. Different mates remain independent.
Failed operations release the queue. Unregister/stop invalidate queued requests
and close an in-flight client so a late resume cannot resurrect a stopped mate.

This avoids duplicate history loading; it does not accelerate a single Codex
resume or shrink a rollout after `/compact`. No extra process, production port,
or increased timeout is required. The isolated regression uses real HTTP and
JSON-RPC sockets with synthetic responses and a held resume, including a caller
disconnect followed by multiple retries:

```bash
node --experimental-strip-types --test tests/channel-core/codex-registration-race.test.ts
```

### Codex registrar terminal isolation

The background registrar must redirect **all three** standard descriptors before
starting its Node children: stdin from `/dev/null`, stdout and stderr to the
existing private App Server log. This applies to both resumed and fresh threads.
Node may restore a saved terminal mode through inherited stderr on exit, even
without reading stdin; that can overwrite the foreground TUI's raw keyboard mode.

The registrar fix itself adds no process or terminal-mode watchdog. The sidecar
also drops its controlling terminal before exec: redirecting stdio alone leaves
`/dev/tty` accessible. `exec-without-tty.py` uses `TIOCNOTTY` only in the background
non-session-leader child, then replaces itself with the selected Codex executable.
It refuses to detach a terminal session leader, which could signal the pane.
PID, process group and session remain unchanged; no Python supervisor stays
resident and existing verified group stopping still reaches every child. The
TUI's terminal/raw keyboard mode is untouched.

### Invocation-only hook trust for remote resume

Real Codex 0.163.0 testing still reproduces hook review on remote resume despite
the existing launcher `--dangerously-bypass-hook-trust` argument. To honor this
existing one-invocation bypass intent, `hook-trust-overrides.mjs` discovers exact
enabled untrusted/modified hook identities and current hashes with Codex's own
`hooks/list`. It uses the same pinned executable and configuration overrides as
the real sidecar/TUI. The resulting `hooks.state` overlay applies only to their
CLI invocation, never to a user's persisted configuration. Already-trusted,
managed and disabled hooks are not changed, and no disabled hook is enabled.
This retains the existing launcher assumption that its hook sources are vetted
outside Codex; it is not a general policy to trust arbitrary third-party hooks.
See the official [hook trust and one-off automation guidance](https://learn.chatgpt.com/docs/hooks).

Discovery is a short-lived, terminal-detached stdio App Server, not another
resident daemon. It sends only initialize/initialized/hooks-list requests: no
business thread, turn, model call or config-write request. Errors and a bounded
20-second timeout fail launch before allocating the real listener. Cleanup is
bounded and kills its own process group, including TERM-resistant descendants;
the caller's signal listeners are restored. No raw RPC/config/plugin error,
hook command or private hook identity is printed to the pane. Hashes are never
reimplemented locally. If a hook changes after discovery, the old hash cannot
approve it; any resulting review dialog prevents a successful launch report.

For Codex 0.154 remote resume, the launcher removes the historical
`--dangerously-bypass-approvals-and-sandbox` / `--yolo` arguments from the TUI
resume invocation only. Otherwise Codex rejects it with `Permission overrides
are not supported when resuming a remote task`. The resumed TUI inherits the
existing server/thread permissions. Fresh-thread startup, App Server arguments,
model arguments, hook trust and persisted configuration are unchanged. Other
explicit permission options are not silently rewritten.

Regression checks:

```sh
node --test tests/workshop-registrar-stdio.test.mjs tests/workshop-sidecar-tty.test.mjs tests/workshop-codex-hook-trust.test.mjs tests/workshop-codex-ready.test.mjs tests/workshop-stop.test.mjs
bash tests/cases/17-runtime-codex-contract.sh
# Opt-in Linux full-launcher test, real Codex 0.163.0+, isolated mock model:
pnpm test:workshop:e2e
```

The PTY regression first reproduces stale-mode restoration using real Node with
inherited stderr, then verifies both redirected launch branches. The manual test
uses temporary configuration and its own tmux socket, no production credentials
or Channel connection; it checks raw mode, arrow editing, Enter and cleanup.
The installed-runtime E2E also covers fresh sessions, resumed/repeated launches,
untrusted/trusted/modified hooks, real post-launch protocol readiness, execution
of a synthetic Stop hook, unchanged config/hook files and verified runtime stop.
All model traffic stays on loopback. HOME, CODEX_HOME, config/state directories
and tmux sockets are isolated; no production authentication is copied.
After an approved installation, the change applies on subsequent mate launches.
No Channel daemon restart is required; existing mates are unaffected until restart.

### Coverage of the related remote fixes

| Remote fix | Problem addressed by the current implementation | Regression evidence |
| --- | --- | --- |
| `feature/workshop-start-readiness` (`60a6d81`) | Do not report launch success until the live TUI is stable; preserve latest-cwd session behavior | Workshop start/selector tests, isolated tmux/protocol tests |
| `fix/codex-registrar-stdio` (`5dd4f49`) | Registrar stderr must not restore canonical terminal mode; remote resume must not override permissions | Real-Node PTY test, wrapper contract, real-binary installed-runtime E2E |
| `fix/codex-tty-root-cause` (`72dc548`, `428b54a`) | Hook-review compatibility, modal readiness, sidecar controlling-TTY isolation, usable arrow/Enter input and cleanup | Hook metadata/cancellation tests, modal tests, PID/group-preserving TTY test, real-binary E2E |

The last branch is covered by equivalent fixes rather than a wholesale merge:
the controlling-TTY bootstrap execs without adding a resident supervisor or
changing process groups. Commit ancestry alone does not establish bug coverage.
Real-binary evidence targets the installed Codex version, not every older Codex
release. Startup readiness does not guarantee an external provider's quota,
authentication, availability or future model responses.

Local verification record, 2026-10-18 (Linux, Codex 0.163.0, Node 22.23.1):

- `pnpm test:reliability`: 99 passed, zero failures/skips.
- `pnpm test:workshop:e2e`: six scenarios passed: resume, repeated launch,
  untrusted/trusted/modified hooks, and a fresh thread. Every scenario confirmed
  real TUI keyboard editing, Enter `/status`, protocol readiness, a new loopback
  model reply, unchanged configuration and verified runtime stop. Hook scenarios
  also confirmed the current synthetic Stop hook executed.
- Shell cases 14–17 passed with isolated fixtures/tmux sockets.
- The three remote branch heads above were refreshed and remained unchanged.
- No production configuration, credentials, service lifecycle or business thread
  was changed. The fixture installs only into a temporary runtime; model HTTP
  requests stay on loopback with no real API key/authentication.

Follow-up verification, 2026-10-19:

- Reliability set: 116/116 passed (100 non-upgrade cases + 16 upgrade cases),
  zero failures/skips. The final upgrade suite was rerun separately, 16/16.
- `pnpm test:workshop:e2e`: all seven real-Codex scenarios passed: the six above
  plus update-UI observation with an isolated synthetic version cache. The real
  standalone CLI displayed a passive notice, correctly classified without keys
  or running the host installer. Actual upgrade/respawn E2E uses fake releases.
- Upgrade cases include first/second/third menu selections, lost selection,
  installer error/timeout, success without version advancement, broken installed
  executable, old success text, repeated prompts, already-installed release,
  original pane/cwd/model/thread preservation, sibling isolation and one shared
  installation followed by per-mate reload. PTY key streams are asserted without
  assuming read-event packet boundaries.
- Shell cases 14–17 passed again on a separate tmux socket. Syntax/diff checks
  and the changed-file privacy scan passed; production files and unrelated user
  edits remained unchanged. Nothing was merged, pushed or installed to production.
- To avoid synthetic bootstrap contention on small hosts, `test:reliability`
  runs the upgrade suite after the other cases; `test:workshop:upgrade` also runs
  it independently. Production readiness/protocol/installer budgets are unchanged.

Channel completion snapshots are a fallback, not a progress transport. It polls
`thread/read` only after notification inactivity and briefly waits for queued
deltas before accepting a polled completion. Runtime adapters must not introduce
eager polling that can starve or overtake the notification stream.

### `runtime::post_launch <tmux_target> <name> [restart_upgrade]` (optional)

Run runtime-specific convergence after a pane is created. The CC adapter uses
this hook to confirm the development-channel gate after its marker appears.
The optional third argument is 1 only for a newly created pane in an explicit
restart; Codex may perform the bounded update recovery above. It is 0 for
existing panes/ordinary starts, and ignored by Claude. The internal restart
handoff is consumed before spawning tmux, so it cannot leak into future panes.

> **Startup convergence (gen2)**: the old team/plugin verbs were RETIRED together
> with the CC team mechanism — `spawn_mate_prompt_template`,
> `list_registered_mates`, `describe_registered_mates`, `settings_path`,
> `telegram_status`, `flock_patch_status`. Mates are now independent CC
> processes in their own tmux panes (`ka workshop`), not Agent-spawned team
> subagents; Telegram goes through the daemon (not the plugin); there is no
> flock guard.

## Conventions

- **No side effects in predicates** (`ready_match`, `telegram_status`). They
  must be callable from `ka status` without touching tmux state.
- **Fail soft for optional capabilities**: if a runtime does not implement a
  concept (e.g. Gemini has no plugin system, no `telegram_status`), its
  adapter returns "none" / "n/a" or exits 0 quietly — not an error.
- **bash 3.2 compatible**. Target shell is the macOS default; adapters must
  avoid bash 4+ features (`mapfile`, associative arrays unless guarded, `**`
  globstar).
- **Stateless**: adapters read files / tmux state, but do not cache anything
  between invocations. Each `ka` command is a cold start.

## Adding a new runtime

1. `mkdir workshop/ops/runtimes/<name>`
2. Implement each required function in files at conventional paths (`launch.sh`,
   `ready-signals.sh`, `send-prompt.sh`).
3. Add contract tests under `tests/cases/<NN>-runtime-<name>-contract.sh`:
   for each function, assert that calling it against a known fixture produces
   the expected output.
4. Note which runtime / CLI version the adapter was validated against, and any
   gaps (e.g. "Gemini has no mate registry").
