#!/usr/bin/env bash
set -Eeuo pipefail

source ./scripts/lib/ux.sh

setup_script "mina-runtime-web-build" "mina-runtime web build"

# Builds the mina-rust WebAssembly proving adapter (mina-runtime-wasm) from the
# `src/mina-rust` submodule and runs wasm-bindgen to emit a package.
#
# TARGET selects the wasm-bindgen output:
#   TARGET=web     (default) -> browser ESM        -> native/mina-runtime-web
#   TARGET=nodejs            -> Node CommonJS wasm  -> native/mina-runtime-node-wasm
# Override the output dir with OUT_DIR=... if needed.
#
# NOTE: o1js does not yet load this artifact — the runtime loader
# (`createMinaRuntime` in src/native/native.ts) currently loads the Node NAPI
# addon. This script produces the wasm module for a future loader; on its own it
# does not enable `setProofSystemBackend('rust')` over wasm.
#
# Requires the nightly wasm toolchain (nightly + wasm32-unknown-unknown +
# rust-src) and wasm-bindgen-cli. In the submodule, `make setup-wasm` installs
# them. Override the checkout with MINA_RUST_ROOT=/absolute/path.

MINA_RUST_ROOT=${MINA_RUST_ROOT:-./src/mina-rust}
NIGHTLY=${NIGHTLY_RUST_VERSION:-nightly}
TARGET=${TARGET:-web}

case "$TARGET" in
  web)    DEFAULT_OUT=./native/mina-runtime-web ;;
  nodejs) DEFAULT_OUT=./native/mina-runtime-node-wasm ;;
  *) echo "TARGET must be 'web' or 'nodejs' (got '$TARGET')"; exit 1 ;;
esac
OUT_DIR=${OUT_DIR:-$DEFAULT_OUT}

if [ ! -f "$MINA_RUST_ROOT/Cargo.toml" ]; then
  echo "mina-rust checkout not found at '$MINA_RUST_ROOT'."
  echo "Run 'git submodule update --init src/mina-rust' or set MINA_RUST_ROOT."
  exit 1
fi

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "wasm-bindgen CLI not found."
  echo "Install the wasm toolchain first, e.g. from the submodule:"
  echo "  (cd $MINA_RUST_ROOT && make setup-wasm)"
  exit 1
fi

info "building mina-runtime-wasm ($NIGHTLY, build-std, target=$TARGET) from $MINA_RUST_ROOT..."

WASM=$MINA_RUST_ROOT/target/wasm32-unknown-unknown/release/mina_runtime_wasm.wasm

# Threads/atomics config mirrors the Mina web node (see the crate README).
RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+atomics,+bulk-memory,+mutable-globals" \
  cargo +"$NIGHTLY" build \
  --manifest-path "$MINA_RUST_ROOT/Cargo.toml" \
  --package mina-runtime-wasm \
  --release \
  --target wasm32-unknown-unknown \
  -Z build-std=std,panic_abort

info "running wasm-bindgen (target=$TARGET) -> $OUT_DIR ..."
mkdir -p "$OUT_DIR"
wasm-bindgen --target "$TARGET" --out-dir "$OUT_DIR" "$WASM"

success "mina-runtime wasm build success! (target=$TARGET, artifact in $OUT_DIR — loader still TODO)"
