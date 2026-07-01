#!/bin/bash
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
WRITE_ROOT=${CODEX_FLATPAK_WRITE_ROOT:-$REPO_DIR/packaging/flatpak}
SKIP_CHECK=${CODEX_FLATPAK_SKIP_CHECK:-0}

refresh_source_group() {
    local group="$1"
    local allow_os="${2:-}"
    local args=(
        "$REPO_DIR/scripts/flatpak/refresh-npm-source-group.mjs"
        --package-json "$WRITE_ROOT/$group/package.json"
        --lock-output "$WRITE_ROOT/$group/package-lock.json"
        --sources-output "$WRITE_ROOT/$group-sources.json"
    )
    if [ -n "$allow_os" ]; then
        args+=("--allow-os=$allow_os")
    fi
    node "${args[@]}"
}

refresh_source_group asar
refresh_source_group codex-cli linux
refresh_source_group native-modules
refresh_source_group tools linux

CODEX_FLATPAK_RESOLVED_UPSTREAM_JSON="$WRITE_ROOT/upstream.json" \
    node "$REPO_DIR/packaging/flatpak/render-manifest.mjs" --output "$WRITE_ROOT/io.github.ilysenko.codex_desktop_linux.json"
if [ "$SKIP_CHECK" != 1 ]; then
    node "$REPO_DIR/scripts/flatpak/check-flatpak-deps.mjs"
fi
