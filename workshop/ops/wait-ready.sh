#!/bin/bash
# ka wait-ready — poll a tmux pane until its agent runtime is ready to accept
# injected prompts (resume + hooks + MCP init settled, prompt box idle).
#
# Intended callers:
#   * ka start --spawn-mates (before dispatching mate spawn prompt)
#   * ka spawn-mates         (sanity check pre-injection)
#   * humans after ka start, when scripting follow-up prompts
#
# Detection heuristic — pane is considered ready when BOTH:
#   1. tmux capture-pane content contains a recognizable CC input-prompt marker.
#      Two shapes seen in the wild (CC TUI has changed its frame glyphs):
#        * `│ >`  — older bordered prompt (still used by unit-test fixtures)
#        * `❯`    — current prompt glyph, rendered on its own line between
#                   horizontal rules
#      Additionally, a status-line hint fragment (`ctrl+t`, `shift+` expand
#      hint, or `permissions o`/`accept edits`) is a strong "fully booted"
#      signal — CC only renders the bottom hint strip when past init.
#   2. Those signals remain present for STABLE_SEC seconds of consecutive
#      polls. We do NOT require the whole pane to be byte-identical — a live
#      CC pane has an animating spinner and a rotating status strip even
#      while idle, so cksum-based stability produces false negatives against
#      a real ready pane. Signal-presence stability is enough.
#
# Exit codes:
#   0  pane is ready
#   1  timeout waiting for ready state
#   3  config/session/pane not found (hard misconfig, not just "not ready yet")
#   4  Codex update modal (caller may explicitly opt into restart-time recovery)
#
# Flags:
#   --session NAME      override session from workshop.yaml
#   --target  PANE      target tmux pane (default: <session>:0.0 = main)
#   --timeout SEC       seconds before giving up (default: 60)
#   --stable  SEC       idle-stability window (default: 2)
#   --verbose | -v      log each poll iteration
set -euo pipefail

: "${KA_HOME:=$HOME/.knowledge-assistant}"
source "$KA_HOME/shared/ops/common.sh"
# shellcheck source=../lib/tmux-helpers.sh
source "$KA_WORKSHOP_DIR/tmux-helpers.sh"
# shellcheck source=../lib/runtimes/dispatch.sh
source "$KA_RUNTIMES_DIR/dispatch.sh"

SESSION=""
TARGET_OVERRIDE=""
TIMEOUT=60
STABLE_SEC=2
VERBOSE=0
APP_SERVER_ENDPOINT=""
APP_SERVER_NAME=""
EXPECTED_VERSION=""
prev_arg=""
for arg in "$@"; do
    case "$arg" in
        --timeout=*) TIMEOUT="${arg#--timeout=}" ;;
        --timeout)   : ;;
        --session=*) SESSION="${arg#--session=}" ;;
        --session)   : ;;
        --target=*)  TARGET_OVERRIDE="${arg#--target=}" ;;
        --target)    : ;;
        --stable=*)  STABLE_SEC="${arg#--stable=}" ;;
        --stable)    : ;;
        --app-server-endpoint) : ;;
        --app-server-name) : ;;
        --expected-version) : ;;
        --verbose|-v) VERBOSE=1 ;;
        *)
            case "$prev_arg" in
                --timeout) TIMEOUT="$arg" ;;
                --session) SESSION="$arg" ;;
                --target)  TARGET_OVERRIDE="$arg" ;;
                --stable)  STABLE_SEC="$arg" ;;
                --app-server-endpoint) APP_SERVER_ENDPOINT="$arg" ;;
                --app-server-name) APP_SERVER_NAME="$arg" ;;
                --expected-version) EXPECTED_VERSION="$arg" ;;
            esac
            ;;
    esac
    prev_arg="$arg"
done

for value in "$TIMEOUT" "$STABLE_SEC"; do
    case "$value" in
        ''|*[!0-9]*) log_err "timeout and stable must be non-negative integers"; exit 2 ;;
    esac
done
[ "$TIMEOUT" -gt 0 ] || { log_err "timeout must be positive"; exit 2; }

CONFIG="$(resolve_workshop_config)"
if [ -z "$SESSION" ]; then
    if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
        log_err "no workshop config found (set OPS_CONFIG or pass --session NAME)"
        exit 3
    fi
    SESSION="$(workshop_session_name "$CONFIG")"
fi

tmux_require

if ! tmux_has_session "$SESSION"; then
    log_err "session '$SESSION' not running"
    exit 3
fi

TARGET="${TARGET_OVERRIDE:-$SESSION:0.0}"
if ! "$TMUX_BIN" display-message -p -t "$TARGET" "#{pane_id}" >/dev/null 2>&1; then
    log_err "pane $TARGET not found in session $SESSION"
    exit 3
fi

RUNTIME="$("$TMUX_BIN" show-options -p -v -t "$TARGET" @ka_runtime 2>/dev/null || true)"
[ -n "$RUNTIME" ] || RUNTIME="$(runtime_default_from_config "$CONFIG")"
if ! runtime_load "$RUNTIME"; then
    log_err "runtime '$RUNTIME' not supported"
    exit 3
fi

capture() {
    "$TMUX_BIN" capture-pane -t "$TARGET" -p -J 2>/dev/null || true
}

log_info "waiting for $TARGET to be ready (timeout=${TIMEOUT}s, stable=${STABLE_SEC}s)"

start_ts=$(date +%s)
prev_sig=""
stable_since=0
last_probe="not_attempted"

while :; do
    # A detached tmux pane may disappear immediately after creation, or retain
    # a stale ready-looking screen with remain-on-exit enabled. Neither is ready.
    if ! pane_dead="$("$TMUX_BIN" display-message -p -t "$TARGET" '#{pane_dead}' 2>/dev/null)"; then
        log_err "pane $TARGET disappeared before runtime readiness"
        exit 3
    fi
    if [ "$pane_dead" = "1" ]; then
        log_err "pane $TARGET exited before runtime readiness"
        exit 3
    fi
    if [ "$RUNTIME" = "codex" ]; then
        tui_state="$("$TMUX_BIN" show-options -p -v -t "$TARGET" @ka_codex_tui_state 2>/dev/null || true)"
        if [ "$tui_state" = "exited" ]; then
            log_err "Codex TUI in $TARGET exited before runtime readiness (App Server may remain available)"
            exit 3
        fi
    else
        tui_state=""
    fi
    now=$(date +%s)
    elapsed=$(( now - start_ts ))
    if [ "$elapsed" -ge "$TIMEOUT" ]; then
        log_err "timeout after ${TIMEOUT}s — $TARGET never reached ready state (App Server probe: $last_probe)"
        exit 1
    fi

    content="$(capture)"
    if [ "$RUNTIME" = "codex" ] && codex::hook_review_match "$content"; then
        log_err "Codex hook review is required in $TARGET; inspect /hooks and reviewed source changes before restarting this mate"
        exit 3
    fi
    if [ "$RUNTIME" = "codex" ] && codex::update_prompt_match "$content"; then
        log_err "Codex update choice is required in $TARGET (not ready)"
        exit 4
    fi
    sig="$(printf '%s' "$content" | cksum | awk '{print $1 "-" $2}')"

    # Delegate signal detection to the runtime adapter (phase 2). The adapter
    # echoes a tag on match (e.g. "prompt-caret", "status", "prompt-caret+status")
    # and exits 1 when no signal is found.
    matched=""
    ready_sig=0
    if [ "$tui_state" != "starting" ] && matched="$(runtime::ready_match "$content")"; then
        ready_sig=1
    fi
    if [ "$ready_sig" = "1" ] && [ "$RUNTIME" = "codex" ] && { [ -n "$APP_SERVER_ENDPOINT" ] || [ -n "$APP_SERVER_NAME" ]; }; then
        if [ -z "$APP_SERVER_ENDPOINT" ]; then
            APP_SERVER_ENDPOINT="$("$TMUX_BIN" show-options -p -v -t "$TARGET" @ka_codex_app_server_endpoint 2>/dev/null || true)"
            if [ -z "$APP_SERVER_ENDPOINT" ]; then
                channel="$("$TMUX_BIN" show-options -p -v -t "$TARGET" @ka_channel 2>/dev/null || true)"
                channel="$(printf '%s' "${channel:-$APP_SERVER_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')"
                # A newly starting wrapper may not have created its log yet.
                # Missing metadata/log is pending, not a set -e/pipefail exit.
                APP_SERVER_ENDPOINT="$(tail -40 "$KA_STATE_DIR/codex-app-servers/$channel.log" 2>/dev/null | sed -n 's/.*listening on: \(ws:\/\/127\.0\.0\.1:[0-9][0-9]*\).*/\1/p' | tail -1 || true)"
            fi
        fi
        if [ -z "$APP_SERVER_ENDPOINT" ]; then
            last_probe='{"ok":false,"reason":"endpoint_pending"}'
            ready_sig=0
        else
            probe="${KA_CODEX_READY_PROBE:-$KA_RUNTIMES_DIR/codex/probe-ready.mjs}"
            if last_probe="$(node "$probe" "$APP_SERVER_ENDPOINT" "$EXPECTED_VERSION" 1000)"; then
                matched="${matched}+app-server"
            else
                ready_sig=0
                if printf '%s' "$last_probe" | grep -q '"reason":"version_mismatch"'; then
                    log_err "App Server probe: $last_probe — restart this mate to load the installed Codex version"
                    exit 3
                fi
            fi
        fi
    fi

    if [ "$VERBOSE" = "1" ]; then
        log_dim "elapsed=${elapsed}s sig=${sig} ready=${ready_sig} matched=${matched:-none}"
    fi

    if [ "$ready_sig" = "1" ]; then
        if [ "$stable_since" -eq 0 ]; then
            stable_since=$now
        elif [ $(( now - stable_since )) -ge "$STABLE_SEC" ]; then
            log_ok "$TARGET ready (${matched:-signal}, stable ${STABLE_SEC}s)"
            exit 0
        fi
    else
        stable_since=0
    fi
    prev_sig="$sig"
    sleep 0.5
done
