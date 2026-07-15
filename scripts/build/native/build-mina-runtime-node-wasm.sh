#!/usr/bin/env bash
set -Eeuo pipefail

source ./scripts/lib/ux.sh

setup_script "mina-runtime-node-wasm-build" "mina-runtime node-wasm build"

# One-command build of the mina-rust WebAssembly proving adapter for Node.js
# (the wasm alternative to the NAPI addon). Mirrors build-mina-runtime.sh:
# it compiles + wasm-bindgens + packages + installs the result as the
# `@o1js/mina-runtime-node-wasm` package under node_modules, so a loader can
# `require('@o1js/mina-runtime-node-wasm')` and get { MinaRuntime, backendInfo }.
#
# Requires the nightly wasm toolchain + wasm-bindgen-cli (submodule:
# `make setup-wasm`). Override the checkout with MINA_RUST_ROOT=/absolute/path.

PKG_NAME=@o1js/mina-runtime-node-wasm
BUILD_OUT=./native/.build/mina-runtime-node-wasm
PKG_PATH=./native/mina-runtime-node-wasm

# Build + wasm-bindgen (target nodejs) via the shared wasm build script.
TARGET=nodejs OUT_DIR="$BUILD_OUT" ./scripts/build/native/build-mina-runtime-web.sh

# wasm-bindgen --target nodejs emits <crate>.js (CJS entry), <crate>_bg.wasm,
# and <crate>.d.ts. Package them so `require('@o1js/mina-runtime-node-wasm')`
# resolves to the generated CJS entry.
ENTRY=$(basename "$(ls "$BUILD_OUT"/*.js | grep -v '_bg\.js$' | head -n1)")

info "creating $PKG_NAME package..."
rm -rf "$PKG_PATH"
mkdir -p "$PKG_PATH"
cp "$BUILD_OUT"/* "$PKG_PATH"/

cat > "$PKG_PATH/package.json" <<EOF
{
  "name": "$PKG_NAME",
  "version": "0.0.0",
  "author": "O(1) Labs",
  "type": "commonjs",
  "main": "$ENTRY",
  "repository": {
    "url": "git+https://github.com/o1-labs/o1js.git"
  }
}
EOF

# Install into node_modules so the package name resolves.
INSTALLED_PATH="./node_modules/$PKG_NAME"
mkdir -p "$(dirname "$INSTALLED_PATH")"
rm -rf "$INSTALLED_PATH"
cp -r "$PKG_PATH" "$INSTALLED_PATH"

success "mina-runtime node-wasm build success! ($PKG_NAME installed, entry: $ENTRY)"
