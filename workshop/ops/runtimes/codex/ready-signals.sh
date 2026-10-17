#!/bin/bash

runtime::ready_match() {
    local content="$1"
    # Upgrade dialogs and the wrapper's fallback shell can retain old prompt
    # text. Neither means the foreground TUI is accepting agent input.
    if printf '%s' "$content" | grep -qE '^[[:space:]]*Update available.*→|^\[start-pane:[^]]+\].*(Codex TUI exited|TUI exited, opening a shell)'; then
        return 1
    fi
    if printf '%s' "$content" | grep -qE '(^|\n)[[:space:]]*›[[:space:]]*($|\n)'; then
        printf 'prompt-chevron'
        return 0
    fi
    if printf '%s' "$content" | grep -qiE '\? for shortcuts|context left|ask codex'; then
        printf 'status'
        return 0
    fi
    return 1
}
