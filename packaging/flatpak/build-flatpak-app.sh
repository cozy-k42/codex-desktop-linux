#!/bin/bash
set -eu

SOURCE_ROOT=$(pwd)
UPSTREAM_JSON="$SOURCE_ROOT/packaging/flatpak/upstream.json"
ARCHIVE_SOURCES="$SOURCE_ROOT/.flatpak-sources"
STAGE_ROOT="$SOURCE_ROOT/.flatpak-stage"
TOOLS_ROOT="$SOURCE_ROOT/.flatpak-tools"
NPM_CACHE="$SOURCE_ROOT/npm-cache"
BUILD_HOME="$SOURCE_ROOT/.flatpak-home"
BUILD_CACHE="$SOURCE_ROOT/.flatpak-cache"
APP_STAGE="$STAGE_ROOT/opt/codex-desktop"
FLATPAK_LIB_STAGE="$STAGE_ROOT/lib/codex-flatpak"
FLATPAK_TOOLS_STAGE="$STAGE_ROOT/lib/codex-flatpak-tools"
PYTHON_STAGE="$FLATPAK_TOOLS_STAGE/python"
TOOLING_STAGE="$FLATPAK_TOOLS_STAGE/tooling"
GIT_STAGE="$FLATPAK_TOOLS_STAGE/git"
FLATPAK_APP_PREFIX=${FLATPAK_APP_PREFIX:-/app}
FLATPAK_APP_OPT_DIR="$FLATPAK_APP_PREFIX/opt/codex-desktop"
FLATPAK_APP_LIB_DIR="$FLATPAK_APP_PREFIX/lib/codex-flatpak"
FLATPAK_APP_TOOLS_DIR="$FLATPAK_APP_PREFIX/lib/codex-flatpak-tools"
BUILD_NODE_BIN=${FLATPAK_BUILD_NODE_BIN:-}
BUILD_NPM_BIN=${FLATPAK_BUILD_NPM_BIN:-}
BUILD_7Z_BIN=${FLATPAK_BUILD_7Z_BIN:-}
CODEX_FLATPAK_FINAL_RUNTIME_PYTHON_STRATEGY=${CODEX_FLATPAK_FINAL_RUNTIME_PYTHON_STRATEGY:-bundled}
CODEX_FLATPAK_BUILD_SEVEN_ZIP_STRATEGY=${CODEX_FLATPAK_BUILD_SEVEN_ZIP_STRATEGY:-bundled}
CODEX_FLATPAK_ELECTRON_STRATEGY=${CODEX_FLATPAK_ELECTRON_STRATEGY:-bundled}
CODEX_FLATPAK_BUILD_NODE_STRATEGY=${CODEX_FLATPAK_BUILD_NODE_STRATEGY:-bundled-managed-node}
CODEX_FLATPAK_RUNTIME_NODE_STRATEGY=${CODEX_FLATPAK_RUNTIME_NODE_STRATEGY:-bundled-managed-node}
ASAR_BUILD_ROOT="$TOOLS_ROOT/asar"
NATIVE_BUILD_ROOT="$TOOLS_ROOT/native-modules"
RUNTIME_TOOLS_BUILD_ROOT="$TOOLS_ROOT/runtime-tools"
NODE_RUNTIME_ROOT="$TOOLS_ROOT/node-runtime"
SEVEN_ZIP_ROOT="$TOOLS_ROOT/7zip"
ASAR_BIN="$TOOLS_ROOT/bin/asar"

APP_ID=$(python3 - "$UPSTREAM_JSON" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["appId"])
PY
)
ELECTRON_VERSION=$(python3 - "$UPSTREAM_JSON" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["electronVersion"])
PY
)

prepare_dirs() {
    rm -rf "$STAGE_ROOT" "$TOOLS_ROOT"
    mkdir -p "$ARCHIVE_SOURCES" "$STAGE_ROOT" "$TOOLS_ROOT/bin" "$NPM_CACHE" "$BUILD_HOME" "$BUILD_CACHE"
}

install_node_runtime() {
    local extracted_root

    rm -rf "$NODE_RUNTIME_ROOT"

    if [ "$CODEX_FLATPAK_RUNTIME_NODE_STRATEGY" = bundled-managed-node ]; then
        [ -f "$ARCHIVE_SOURCES/node.tar.xz" ] || { echo "Flatpak runtime Node strategy 'bundled-managed-node' requires .flatpak-sources/node.tar.xz" >&2; exit 1; }
        mkdir -p "$TOOLS_ROOT"
        tar -xJf "$ARCHIVE_SOURCES/node.tar.xz" -C "$TOOLS_ROOT"
        extracted_root=$(find "$TOOLS_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'node-v*-linux-*' | head -n 1)
        [ -n "$extracted_root" ] || {
            echo "Unable to locate extracted Node runtime" >&2
            exit 1
        }
        mv "$extracted_root" "$NODE_RUNTIME_ROOT"
    elif [ "$CODEX_FLATPAK_RUNTIME_NODE_STRATEGY" = runtime-node-contract ]; then
        [ -x /usr/bin/node ] || { echo "Flatpak runtime Node strategy 'runtime-node-contract' requires /usr/bin/node in the final runtime; keep bundled-managed-node until that contract is available" >&2; exit 1; }
        mkdir -p "$NODE_RUNTIME_ROOT/bin"
        cat > "$NODE_RUNTIME_ROOT/bin/node" <<'EOF2'
#!/bin/sh
exec /usr/bin/node "$@"
EOF2
        chmod 0755 "$NODE_RUNTIME_ROOT/bin/node"
    else
        echo "Unsupported Flatpak runtime Node strategy: $CODEX_FLATPAK_RUNTIME_NODE_STRATEGY" >&2
        exit 1
    fi

    if [ "$CODEX_FLATPAK_BUILD_NODE_STRATEGY" = bundled-managed-node ]; then
        [ -x "$NODE_RUNTIME_ROOT/bin/node" ] || { echo "Flatpak build Node strategy 'bundled-managed-node' requires the bundled runtime source" >&2; exit 1; }
        BUILD_NODE_BIN=${BUILD_NODE_BIN:-$NODE_RUNTIME_ROOT/bin/node}
        BUILD_NPM_BIN=${BUILD_NPM_BIN:-$NODE_RUNTIME_ROOT/bin/npm}
    elif [ "$CODEX_FLATPAK_BUILD_NODE_STRATEGY" = sdk ]; then
        BUILD_NODE_BIN=${BUILD_NODE_BIN:-$(command -v node || true)}
        BUILD_NPM_BIN=${BUILD_NPM_BIN:-$(command -v npm || true)}
        [ -n "$BUILD_NODE_BIN" ] && [ -x "$BUILD_NODE_BIN" ] || { echo "Flatpak build Node strategy 'sdk' requires node in the SDK or FLATPAK_BUILD_NODE_BIN" >&2; exit 1; }
        [ -n "$BUILD_NPM_BIN" ] && [ -x "$BUILD_NPM_BIN" ] || { echo "Flatpak build Node strategy 'sdk' requires npm in the SDK or FLATPAK_BUILD_NPM_BIN" >&2; exit 1; }
    else
        echo "Unsupported Flatpak build Node strategy: $CODEX_FLATPAK_BUILD_NODE_STRATEGY" >&2
        exit 1
    fi
    export PATH="$(dirname "$BUILD_NODE_BIN"):$(dirname "$BUILD_NPM_BIN"):$PATH"
}

install_seven_zip() {
    if [ "$CODEX_FLATPAK_BUILD_SEVEN_ZIP_STRATEGY" = sdk ]; then
        if [ -n "$BUILD_7Z_BIN" ]; then
            [ -x "$BUILD_7Z_BIN" ] || { echo "Flatpak 7-Zip strategy 'sdk' requires executable FLATPAK_BUILD_7Z_BIN=$BUILD_7Z_BIN because bundled 7zip sources are omitted" >&2; exit 1; }
            export PATH="$(dirname "$BUILD_7Z_BIN"):$PATH"
            return
        fi
        command -v 7z >/dev/null 2>&1 || { echo "Flatpak 7-Zip strategy 'sdk' omits bundled 7zip sources, but 7z is not available in the SDK build environment" >&2; exit 1; }
        return
    fi

    if [ -n "$BUILD_7Z_BIN" ]; then
        export PATH="$(dirname "$BUILD_7Z_BIN"):$PATH"
        return
    fi

    rm -rf "$SEVEN_ZIP_ROOT"
    [ -f "$ARCHIVE_SOURCES/7zip.tar.xz" ] || { echo "Flatpak 7-Zip strategy 'bundled' requires .flatpak-sources/7zip.tar.xz; use strategy 'sdk' only when 7z is available in the build SDK" >&2; exit 1; }
    mkdir -p "$SEVEN_ZIP_ROOT"
    tar -xJf "$ARCHIVE_SOURCES/7zip.tar.xz" -C "$SEVEN_ZIP_ROOT"
    export PATH="$SEVEN_ZIP_ROOT:$PATH"
}

install_offline_npm_tree() {
    local source_dir="$1"
    local destination_dir="$2"

    rm -rf "$destination_dir"
    mkdir -p "$destination_dir"
    cp "$source_dir/package.json" "$source_dir/package-lock.json" "$destination_dir/"
    (
        cd "$destination_dir"
        "$BUILD_NPM_BIN" ci --offline --cache "$NPM_CACHE" --ignore-scripts --no-audit --fund=false
    )
}

install_asar_cli() {
    install_offline_npm_tree "$SOURCE_ROOT/packaging/flatpak/asar" "$ASAR_BUILD_ROOT"
    cat > "$ASAR_BIN" <<EOF2
#!/bin/sh
exec "$BUILD_NODE_BIN" "$ASAR_BUILD_ROOT/node_modules/asar/bin/asar.js" "\$@"
EOF2
    chmod 0755 "$ASAR_BIN"
}

build_native_modules_source() {
    install_offline_npm_tree "$SOURCE_ROOT/packaging/flatpak/native-modules" "$NATIVE_BUILD_ROOT"
    MAX_BUILD_THREADS="${MAX_BUILD_THREADS:-0}" \
        "$SOURCE_ROOT/packaging/flatpak/build-native-modules.sh" \
        "$NATIVE_BUILD_ROOT" \
        "$ELECTRON_VERSION" \
        "$ARCHIVE_SOURCES/electron-headers.tar.gz"
}

install_codex_cli() {
    install_offline_npm_tree "$SOURCE_ROOT/packaging/flatpak/codex-cli" "$FLATPAK_LIB_STAGE/codex-cli"
    mkdir -p "$FLATPAK_LIB_STAGE/bin"
    install -m 0755 "$SOURCE_ROOT/packaging/flatpak/codex-cli-wrapper.sh" "$FLATPAK_LIB_STAGE/bin/codex"
}

install_runtime_tools() {
    local rg_binary
    local runtime_rg_path
    local runtime_git_path
    local runtime_git_exec_path
    local runtime_git_template_path
    local git_template_dir

    rm -rf "$TOOLING_STAGE" "$GIT_STAGE"
    mkdir -p "$FLATPAK_TOOLS_STAGE" "$FLATPAK_LIB_STAGE/bin"

    if [ "$CODEX_FLATPAK_RIPGREP_STRATEGY" = runtime ]; then
        command -v rg >/dev/null 2>&1 || { echo "Flatpak ripgrep strategy 'runtime' requires rg in the final runtime" >&2; exit 1; }
        cat > "$FLATPAK_LIB_STAGE/bin/rg" <<'EOF2'
#!/bin/sh
exec /usr/bin/rg "$@"
EOF2
        chmod 0755 "$FLATPAK_LIB_STAGE/bin/rg"
    else
        install_offline_npm_tree "$SOURCE_ROOT/packaging/flatpak/tools" "$RUNTIME_TOOLS_BUILD_ROOT"
        cp -a "$RUNTIME_TOOLS_BUILD_ROOT" "$TOOLING_STAGE"
        rg_binary=$(find "$TOOLING_STAGE/node_modules" -type f -path '*/bin/rg' | head -n 1)
        [ -n "$rg_binary" ] || {
            echo "Unable to locate bundled ripgrep binary" >&2
            exit 1
        }
        runtime_rg_path="$FLATPAK_APP_PREFIX${rg_binary#$STAGE_ROOT}"
        cat > "$FLATPAK_LIB_STAGE/bin/rg" <<EOF2
#!/bin/sh
exec "$runtime_rg_path" "\$@"
EOF2
        chmod 0755 "$FLATPAK_LIB_STAGE/bin/rg"
    fi

    if [ "$CODEX_FLATPAK_GIT_STRATEGY" = runtime ]; then
        command -v git >/dev/null 2>&1 || { echo "Flatpak Git strategy 'runtime' requires git in the final runtime" >&2; exit 1; }
        cat > "$FLATPAK_LIB_STAGE/bin/git" <<'EOF2'
#!/bin/sh
exec /usr/bin/git "$@"
EOF2
        chmod 0755 "$FLATPAK_LIB_STAGE/bin/git"
        return
    fi

    mkdir -p "$GIT_STAGE"
    tar -xzf "$ARCHIVE_SOURCES/dugite-native.tar.gz" -C "$GIT_STAGE"
    runtime_git_path="$FLATPAK_APP_PREFIX${GIT_STAGE#$STAGE_ROOT}/bin/git"
    runtime_git_exec_path="$FLATPAK_APP_PREFIX${GIT_STAGE#$STAGE_ROOT}/libexec/git-core"
    git_template_dir=$(find "$GIT_STAGE" -type d -path '*/share/git-core/templates' | head -n 1 || true)
    runtime_git_template_path=""
    if [ -n "$git_template_dir" ]; then
        runtime_git_template_path="$FLATPAK_APP_PREFIX${git_template_dir#$STAGE_ROOT}"
    fi

    cat > "$FLATPAK_LIB_STAGE/bin/git" <<EOF2
#!/bin/sh
export GIT_EXEC_PATH="$runtime_git_exec_path"
EOF2
    if [ -n "$runtime_git_template_path" ]; then
        cat >> "$FLATPAK_LIB_STAGE/bin/git" <<EOF2
export GIT_TEMPLATE_DIR="$runtime_git_template_path"
EOF2
    fi
    cat >> "$FLATPAK_LIB_STAGE/bin/git" <<EOF2
exec "$runtime_git_path" "\$@"
EOF2
    chmod 0755 "$FLATPAK_LIB_STAGE/bin/git"
}
install_runtime_python() {
    local extract_root

    rm -rf "$PYTHON_STAGE"
    if [ "$CODEX_FLATPAK_FINAL_RUNTIME_PYTHON_STRATEGY" = sdk ]; then
        echo "Flatpak runtime Python strategy 'sdk' is invalid: SDK Python is only available during flatpak-builder and must not be used for the final app runtime" >&2
        exit 1
    fi
    if [ "$CODEX_FLATPAK_FINAL_RUNTIME_PYTHON_STRATEGY" = runtime ]; then
        [ -x /usr/bin/python3 ] || { echo "Flatpak runtime Python strategy 'runtime' omits bundled Python sources, but /usr/bin/python3 is not available in the final runtime environment" >&2; exit 1; }
        mkdir -p "$PYTHON_STAGE/bin"
        cat > "$PYTHON_STAGE/bin/python3" <<'EOF2'
#!/bin/sh
exec /usr/bin/python3 "$@"
EOF2
        chmod 0755 "$PYTHON_STAGE/bin/python3"
        ln -sfn python3 "$PYTHON_STAGE/bin/python"
        return
    fi

    [ -f "$ARCHIVE_SOURCES/python.tar.gz" ] || { echo "Flatpak runtime Python strategy 'bundled' requires .flatpak-sources/python.tar.gz; use strategy 'runtime' only when /usr/bin/python3 is available in the final runtime" >&2; exit 1; }
    mkdir -p "$PYTHON_STAGE/runtime" "$PYTHON_STAGE/bin"
    tar -xzf "$ARCHIVE_SOURCES/python.tar.gz" -C "$PYTHON_STAGE/runtime"
    extract_root="$PYTHON_STAGE/runtime/python"
    [ -x "$extract_root/bin/python3" ] || {
        echo "Unable to locate bundled Python runtime" >&2
        exit 1
    }

    cat > "$PYTHON_STAGE/bin/python3" <<'EOF2'
#!/bin/sh
export PYTHONHOME=/app/lib/codex-flatpak-tools/python/runtime/python
export LD_LIBRARY_PATH=/app/lib/codex-flatpak-tools/python/runtime/python/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
exec /app/lib/codex-flatpak-tools/python/runtime/python/bin/python3 "$@"
EOF2
    chmod 0755 "$PYTHON_STAGE/bin/python3"
    ln -sfn python3 "$PYTHON_STAGE/bin/python"
}

run_installer() {
    local electron_zip_source=""

    mkdir -p "$SOURCE_ROOT/.flatpak-build/electron-gyp"
    if [ "$CODEX_FLATPAK_ELECTRON_STRATEGY" = bundled ]; then
        [ -f "$ARCHIVE_SOURCES/electron.zip" ] || { echo "Flatpak Electron strategy 'bundled' requires .flatpak-sources/electron.zip; use strategy 'baseapp' only when /app/bin/electron is provided by the base app" >&2; exit 1; }
        electron_zip_source="$ARCHIVE_SOURCES/electron.zip"
    elif [ "$CODEX_FLATPAK_ELECTRON_STRATEGY" = baseapp ]; then
        [ -x /app/bin/electron ] || { echo "Flatpak Electron strategy 'baseapp' omits Electron runtime zip sources, but /app/bin/electron is not available from the base app" >&2; exit 1; }
    else
        echo "Unsupported Flatpak Electron strategy: $CODEX_FLATPAK_ELECTRON_STRATEGY" >&2
        exit 1
    fi

    env \
        HOME="$BUILD_HOME" \
        XDG_CACHE_HOME="$BUILD_CACHE" \
        XDG_CONFIG_HOME="$BUILD_HOME/.config" \
        XDG_STATE_HOME="$BUILD_HOME/.local/state" \
        CODEX_INSTALL_DIR="$APP_STAGE" \
        CODEX_ASAR_CLI="$ASAR_BIN" \
        CODEX_MANAGED_NODE_SOURCE="$NODE_RUNTIME_ROOT" \
        CODEX_MANAGED_NODE_SKIP_COMPATIBILITY_CHECK=1 \
        CODEX_MANAGED_NODE_SKIP_PATH_EXPORT=1 \
        CODEX_ELECTRON_RUNTIME_STRATEGY="$CODEX_FLATPAK_ELECTRON_STRATEGY" \
        CODEX_ELECTRON_BASEAPP_BIN=/app/bin/electron \
        CODEX_ELECTRON_ZIP_SOURCE="$electron_zip_source" \
        CODEX_NATIVE_MODULES_SOURCE="$NATIVE_BUILD_ROOT/node_modules" \
        CODEX_DISABLE_BUNDLED_PLUGINS=1 \
        CODEX_LINUX_FEATURES_CONFIG="${CODEX_LINUX_FEATURES_CONFIG:-}" \
        ./install.sh ./Codex.dmg
}

install_payload() {
    rm -rf "$FLATPAK_APP_OPT_DIR" "$FLATPAK_APP_LIB_DIR" "$FLATPAK_APP_TOOLS_DIR"
    mkdir -p \
        "$FLATPAK_APP_PREFIX/bin" \
        "$FLATPAK_APP_PREFIX/opt" \
        "$FLATPAK_APP_PREFIX/lib" \
        "$FLATPAK_APP_PREFIX/share/applications" \
        "$FLATPAK_APP_PREFIX/share/icons/hicolor/scalable/apps" \
        "$FLATPAK_APP_PREFIX/share/metainfo"

    cp -a "$APP_STAGE" "$FLATPAK_APP_OPT_DIR"
    cp -a "$FLATPAK_LIB_STAGE" "$FLATPAK_APP_LIB_DIR"
    cp -a "$FLATPAK_TOOLS_STAGE" "$FLATPAK_APP_TOOLS_DIR"

    install -m 0755 "$SOURCE_ROOT/packaging/flatpak/codex-desktop-flatpak.sh" "$FLATPAK_APP_PREFIX/bin/codex-desktop-flatpak"
    ln -sfn codex-desktop-flatpak "$FLATPAK_APP_PREFIX/bin/codex-desktop"
    install -m 0644 "$SOURCE_ROOT/packaging/flatpak/${APP_ID}.desktop" "$FLATPAK_APP_PREFIX/share/applications/${APP_ID}.desktop"
    install -m 0644 "$SOURCE_ROOT/packaging/flatpak/${APP_ID}.metainfo.xml" "$FLATPAK_APP_PREFIX/share/metainfo/${APP_ID}.metainfo.xml"
    install -m 0644 "$SOURCE_ROOT/packaging/flatpak/${APP_ID}.svg" "$FLATPAK_APP_PREFIX/share/icons/hicolor/scalable/apps/${APP_ID}.svg"
}

main() {
    prepare_dirs
    install_node_runtime
    install_seven_zip
    install_asar_cli
    build_native_modules_source
    install_codex_cli
    install_runtime_tools
    install_runtime_python
    run_installer
    install_payload
}

main "$@"
