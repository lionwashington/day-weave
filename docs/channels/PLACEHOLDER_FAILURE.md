# Final delivery after placeholder failure

The shared Codex channel manager previously treated failure to create a streaming
placeholder as failure of final delivery, without attempting to send the answer.
The model could finish normally while the channel only retained an undelivered
record. The old failure test incorrectly expected zero body sends in this case.

## Delivery contract

- Resolve and retain the allowed reply target when starting a stream.
- Observe placeholder rejection immediately; suspend preview updates.
- Await any pending placeholder/preview operation before finalization.
- If placeholder creation failed, send the final body once via the platform's
  normal send path. Do not rerun the model or its tools.
- If placeholder creation succeeded, keep existing streaming finalization.
- Do not replay ambiguous final sends, failed final edits, or multipart delivery.
  Existing bounded retries for explicitly safe rate-limit rejection are unchanged.
- A lost placeholder acknowledgement can leave an orphan ellipsis, but must not
  lose or duplicate the answer. A lost body acknowledgement remains ambiguous.
- Retain failed final text with owner-only permissions and automatic replay off.
- Error responses must not issue another send after a failed fallback body send.
- Logs classify transport failures using allowlisted labels, never raw URLs/errors.

This is best-effort delivery, not an exactly-once guarantee across crashes. It does
not introduce an outbox worker, automatic recovery notifications, or model retries.

## Isolated verification

`tests/channel-core/delivery-failure.test.ts` covers delayed rejection, both
platforms, final/error/empty completion, preview failures, persistent transport
failure, answer retention, cleanup and safe classification.

`channels/telegram/tests/codex-e2e.test.ts` exercises the real daemon and App Server
bridge against synthetic services: socket reset before placeholder acceptance,
acceptance followed by lost acknowledgement, and lost body acknowledgement. It
asserts one model turn and one body attempt, retained failures, and subsequent
normal long replies, attachments, approvals and interruption.

Use a temporary `TMPDIR` for tests and a temporary `KA_HOME` for
`./install.sh --only daemon` (never `--switch`). Run the same E2E against each
matching built bundle via `KA_TEST_DAEMON_BUNDLE`. Run platform suites serially on
small hosts: existing tests have short startup/operation timeouts.

The Lark test harness uses a sandbox shell launcher for its fake CLI, excluding
the operator's login profile and nvm initialization. Production CLI startup is
unchanged. This removes a host-dependent source of E2E timeouts.

## Verification record

The corrected placeholder-failure assertion failed against the original code
(expected one body send, observed zero), then passed with the fix.

Final isolated runs:

| Suite | Passed | Failed |
| --- | ---: | ---: |
| Shared channel core (serial) | 66 | 0 |
| Telegram unit/integration/E2E | 98 | 0 |
| Lark unit/integration/E2E | 47 | 0 |
| Installed Telegram bundle E2E | 1 | 0 |
| Installed Lark bundle E2E | 5 | 0 |

Earlier concurrent runs hit existing 500ms synthetic App Server initialization
timeouts and host-dependent Lark CLI timeouts. Final runs used serial suites and
the isolated Lark launcher; production timeout values were not changed.
No production installation, restart, remote messaging, or automatic replay was
performed during verification.
