#!/usr/bin/env bash
set -Eeuo pipefail

# Description:
#   Builds the Rust Kimchi WebAssembly bindings for the browser — the web
#   sibling of build:wasm:node:rust. Builds `kimchi-wasm` straight from
#   proof-systems/pickle-rs with wasm-pack's `web` target, so the generated
#   `kimchi_wasm.js` carries the Rust Pickles exports (`rust_pickles_*`)
#   used by setProofSystemBackend('rust') alongside the caml_* API the jsoo
#   web backend consumes.
#
#   The proof-systems checkout is resolved automatically from the
#   `src/mina-rust` submodule's Cargo graph (it pins the same pickle-rs
#   rev). Set PROOF_SYSTEMS_ROOT to override the source checkout.
#
# Usage:
#   npm run build:wasm:web:rust

source ./scripts/lib/ux.sh

setup_script "wasm-web-rust-build" "wasm web rust build"

BINDINGS_PATH=./src/bindings/compiled/web_bindings/
mkdir -p $BINDINGS_PATH

TARGETS=(\
  kimchi_wasm_bg.wasm \
  kimchi_wasm_bg.wasm.d.ts \
  kimchi_wasm.js \
  kimchi_wasm.d.ts \
)

# Resolve proof-systems from the mina-rust submodule unless overridden.
if [ -z "${PROOF_SYSTEMS_ROOT:-}" ] && [ -f ./src/mina-rust/Cargo.toml ]; then
  info "resolving proof-systems from the src/mina-rust submodule..."
  PROOF_SYSTEMS_ROOT=$(
    cd ./src/mina-rust && cargo metadata --format-version=1 2>/dev/null | python3 -c "
import json,sys,os
m=json.load(sys.stdin)
for p in m['packages']:
    if p['name']=='kimchi' and 'proof-systems' in (p.get('source') or ''):
        print(os.path.dirname(os.path.dirname(p['manifest_path']))); break
" || true
  )
fi

if [ -z "${PROOF_SYSTEMS_ROOT:-}" ]; then
  echo "Could not resolve proof-systems. Run 'git submodule update --init src/mina-rust'"
  echo "or set PROOF_SYSTEMS_ROOT=/absolute/path."
  exit 1
fi

info "building rust Kimchi WASM bindings from $PROOF_SYSTEMS_ROOT (web)..."
NIGHTLY=${NIGHTLY_RUST_VERSION:-nightly}
BUILT_PATH=$PROOF_SYSTEMS_ROOT/target/web
make -C "$PROOF_SYSTEMS_ROOT" build-web \
  NIGHTLY_RUST_VERSION="$NIGHTLY" \
  KIMCHI_WASM_WEB_OUTDIR="$BUILT_PATH"

# Compile-time detection of std APIs that PANIC at runtime on
# wasm32-unknown-unknown (std::time::Instant/SystemTime): their panic
# message is baked into the binary, so a build-time scan catches them
# before they hang the wasm pool at runtime.
info "scanning wasm for unsupported-std panic strings..."
if strings "$BUILT_PATH/kimchi_wasm_bg.wasm" | grep -q "time not implemented on this platform"; then
  echo "ERROR: the wasm binary contains std::time::Instant/SystemTime calls."
  echo "These panic at runtime on wasm32 (silent thread-pool deadlock)."
  echo "Route them through snarky::wasm_instant instead."
  exit 1
fi
UNSUPPORTED_COUNT=$(strings "$BUILT_PATH/kimchi_wasm_bg.wasm" | grep -c "operation not supported on this platform" || true)
if [ "$UNSUPPORTED_COUNT" -gt 0 ]; then
  info "note: $UNSUPPORTED_COUNT 'operation not supported' strings (fs/env fallbacks — fine if handled as Err, fatal if unwrapped)"
fi

info "copying artifacts into the right place..."
for target in "${TARGETS[@]}"; do
  cp $BUILT_PATH/$target $BINDINGS_PATH/$target
  chmod 660 $BINDINGS_PATH/$target
done

success "Rust WASM web build success!"
