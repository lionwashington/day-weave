#!/bin/bash

codex::hook_review_match() {
    # Recognize active modal titles/options, not ordinary conversation that
    # quotes those phrases while discussing a startup problem.
    printf '%s' "$1" | grep -qiE '^[[:space:]]*[│┃]?[[:space:]]*(Hooks need review|[›❯>]?[[:space:]]*([0-9]+[.)][[:space:]]*)?(Trust all and continue|Continue without trusting))[[:space:]]*[│┃]?[[:space:]]*$'
}

codex::update_prompt_match() {
    # A release banner alone is not an interactive update choice. Keep this
    # conservative; the updater additionally validates versions/selected option.
    printf '%s' "$1" | grep -qE '^[[:space:]│┃✨]*Update available.*(→|->)' &&
    printf '%s' "$1" | grep -qE '^[[:space:]│┃›❯>]*1[.)][[:space:]]+Update now' &&
    printf '%s' "$1" | grep -qE '^[[:space:]│┃›❯>]*3[.)][[:space:]]+Skip until next version'
}

runtime::ready_match() {
    local content="$1"
    # A hook-review modal can leave the ordinary composer/status visible below
    # it. Those background markers are not proof of unattended readiness.
    if codex::hook_review_match "$content"; then
        return 1
    fi
    # A passive boxed release notice can coexist with a fully usable composer
    # (real Codex standalone installs do this). Block update *interactions*, not
    # that notice alone. Unknown menus require manual review rather than keys.
    if codex::update_prompt_match "$content" || {
        printf '%s' "$content" | grep -qE '^[[:space:]│┃✨]*Update available.*(→|->)' &&
        printf '%s' "$content" | grep -qiE '(^|[[:space:]])Update now|press enter to continue|enter.*continue.*esc.*skip';
    }; then
        return 1
    fi
    # The wrapper's fallback shell can retain a stale composer too.
    if printf '%s' "$content" | grep -qE '^\[start-pane:[^]]+\].*(Codex TUI exited|TUI exited, opening a shell)'; then
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
