#!/bin/bash
# Confirm the TUI before reporting a successful Codex launch. Channel and KB
# services are optional; readiness depends only on the pane's runtime signals.

codex::installed_version() {
    local version
    version="$(codex --version)" || { log_err "installed Codex executable failed its version check"; return 1; }
    case "$version" in
        'codex-cli '*) version="${version#codex-cli }" ;;
        *) log_err "cannot determine installed Codex version"; return 1 ;;
    esac
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || { log_err "installed Codex returned an invalid version"; return 1; }
    printf '%s' "$version"
}

codex::respawn_updated_mate() {
    local pane="$1" name="$2" channel remain status=0
    channel="$("$TMUX_BIN" show-options -p -v -t "$pane" @ka_channel)" || return 1
    [[ "$channel" =~ ^[a-z0-9_-]+$ ]] || { log_err 'missing/invalid Codex pane channel; refusing upgrade restart'; return 1; }
    # Keep the exact pane and its original start command/cwd/arguments. Verified
    # group shutdown must complete before respawn; never leave an old sidecar.
    remain="$("$TMUX_BIN" show-options -p -v -t "$pane" remain-on-exit 2>/dev/null || true)"
    "$TMUX_BIN" set-option -p -t "$pane" remain-on-exit on || return 1
    if ! python3 "$KA_RUNTIMES_DIR/codex/stop-runtime.py" "$KA_HOME" "$channel" "$name" "$(ka_channel_port)"; then
        status=1
    else
        "$TMUX_BIN" set-option -p -t "$pane" @ka_codex_tui_state starting || status=1
        "$TMUX_BIN" set-option -p -u -t "$pane" @ka_codex_app_server_endpoint || status=1
        if [ "$status" = 0 ]; then
            "$TMUX_BIN" respawn-pane -k -t "$pane" || status=1
        fi
    fi
    if [ -n "$remain" ]; then
        "$TMUX_BIN" set-option -p -t "$pane" remain-on-exit "$remain" || status=1
    else
        "$TMUX_BIN" set-option -p -u -t "$pane" remain-on-exit || status=1
    fi
    return "$status"
}

runtime::post_launch() {
    local pane="$1" name="$2" allow_upgrade="${3:-0}" version pinned status=0 respawn=0
    version="$(codex::installed_version)" || return 1
    pinned="$("$TMUX_BIN" show-options -p -v -t "$pane" @ka_codex_version 2>/dev/null || true)"
    # A previous mate in a whole-workshop restart may have upgraded the shared
    # executable after this pane launched. One scoped reload is sufficient.
    if [ "$allow_upgrade" = 1 ] && [ -n "$pinned" ] && [ "$pinned" != "$version" ]; then
        respawn=1
    elif "$KA_WORKSHOP_DIR/wait-ready.sh" --target "$pane" \
        --timeout "${KA_WORKSHOP_START_TIMEOUT:-60}" --stable 1 \
        --app-server-name "$name" --expected-version "$version"; then
        return 0
    else
        status=$?
        if [ "$allow_upgrade" = 1 ] && [ "$status" = 4 ]; then
            log_info "Codex update requested during restart of '$name'; waiting for its built-in installer"
            if ! node "$KA_RUNTIMES_DIR/codex/upgrade-on-restart.mjs" "$pane" "${KA_CODEX_UPGRADE_TIMEOUT:-300}"; then
                log_err "Codex upgrade not confirmed for '$name'; installer/pane left untouched, no restart attempted — inspect the installer before retrying restart"
                return 1
            fi
            respawn=1
        fi
    fi
    if [ "$respawn" = 1 ]; then
        log_info "restarting only '$name' to load the installed Codex release (one attempt)"
        codex::respawn_updated_mate "$pane" "$name" || { log_err "verified post-upgrade restart failed for '$name'"; return 1; }
        version="$(codex::installed_version)" || return 1
        if "$KA_WORKSHOP_DIR/wait-ready.sh" --target "$pane" \
            --timeout "${KA_WORKSHOP_START_TIMEOUT:-60}" --stable 1 \
            --app-server-name "$name" --expected-version "$version"; then
            return 0
        fi
        # No recursive retry, even if the newly installed TUI offers an update.
    fi
    log_err "Codex runtime '$name' did not become ready; inspect its pane and App Server log under $KA_STATE_DIR/codex-app-servers"
    return 1
}
