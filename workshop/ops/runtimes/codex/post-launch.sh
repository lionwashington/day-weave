#!/bin/bash
# Confirm the TUI before reporting a successful Codex launch. Channel and KB
# services are optional; readiness depends only on the pane's runtime signals.

runtime::post_launch() {
    local pane="$1" name="$2"
    if ! "$KA_WORKSHOP_DIR/wait-ready.sh" --target "$pane" \
        --timeout "${KA_WORKSHOP_START_TIMEOUT:-60}" --stable 1; then
        log_err "Codex runtime '$name' did not become ready; inspect its pane and App Server log under $KA_STATE_DIR/codex-app-servers"
        return 1
    fi
}
