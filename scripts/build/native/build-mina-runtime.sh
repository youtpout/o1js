#!/usr/bin/env bash
set -Eeuo pipefail

source ./scripts/lib/ux.sh

setup_script "mina-runtime-build" "mina-runtime build"

# Builds the mina-rust N-API proving adapter (the Rust Pickles backend that
# `setProofSystemBackend('rust')` uses) and installs it as the
# `@o1js/mina-runtime-<platform>-<arch>` package so o1js loads it by default,
# with no `O1JS_MINA_RUNTIME_PATH` needed.
#
# Source: the `src/mina-rust` submodule (branch `pickle-rs`). Override the
# checkout with MINA_RUST_ROOT=/absolute/path when iterating on a local clone.

NODE_PLATFORM=$(node -e 'console.log(process.platform)')
NODE_ARCH=$(node -e 'console.log(process.arch)')
TARGET_SLUG=$NODE_PLATFORM-$NODE_ARCH

MINA_RUST_ROOT=${MINA_RUST_ROOT:-./src/mina-rust}

if [ ! -f "$MINA_RUST_ROOT/Cargo.toml" ]; then
  echo "mina-rust checkout not found at '$MINA_RUST_ROOT'."
  echo "Run 'git submodule update --init src/mina-rust' or set MINA_RUST_ROOT."
  exit 1
fi

info "building mina-runtime N-API adapter for $TARGET_SLUG from $MINA_RUST_ROOT..."

BUILT_PATH=./native/.build/mina-runtime-$TARGET_SLUG
mkdir -p $BUILT_PATH

napi build \
    --manifest-path $MINA_RUST_ROOT/Cargo.toml \
    --package mina-runtime-napi \
    --output-dir $BUILT_PATH \
    --release

# napi names the addon index.node when built without a package.json binaryName;
# normalize to the name our generated package expects.
if [ -f $BUILT_PATH/index.node ]; then
  mv $BUILT_PATH/index.node $BUILT_PATH/mina_runtime.node
fi

info "creating @o1js/mina-runtime-$TARGET_SLUG package..."

PKG_PATH=./native/mina-runtime-$TARGET_SLUG
mkdir -p $PKG_PATH

cat > $PKG_PATH/package.json <<EOF
{
  "name": "@o1js/mina-runtime-$TARGET_SLUG",
  "version": "0.0.0",
  "author": "O(1) Labs",
  "os": [
    "$NODE_PLATFORM"
  ],
  "cpu": [
    "$NODE_ARCH"
  ],
  "type": "commonjs",
  "main": "index.js",
  "files": [
    "mina_runtime.node",
    "index.js",
    "index.d.ts"
  ],
  "repository": {
    "url": "git+https://github.com/o1-labs/o1js.git"
  }
}
EOF

echo "module.exports = require('./mina_runtime.node')" > $PKG_PATH/index.js

cp $BUILT_PATH/mina_runtime.node $PKG_PATH/mina_runtime.node
chmod 660 $PKG_PATH/mina_runtime.node
if [ -f $BUILT_PATH/index.d.ts ]; then
  cp $BUILT_PATH/index.d.ts $PKG_PATH/index.d.ts
  chmod 660 $PKG_PATH/index.d.ts
fi

# Install into node_modules so `require('@o1js/mina-runtime-<slug>')` resolves.
INSTALLED_PATH=./node_modules/@o1js/mina-runtime-$TARGET_SLUG
mkdir -p ./node_modules/@o1js
rm -rf "$INSTALLED_PATH"
cp -r "$PKG_PATH" "$INSTALLED_PATH"

success "mina-runtime build success! (@o1js/mina-runtime-$TARGET_SLUG installed)"
