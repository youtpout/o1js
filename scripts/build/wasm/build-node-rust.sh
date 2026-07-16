#!/usr/bin/env bash
set -Eeuo pipefail

# Description:
#   Builds the Rust Kimchi WebAssembly bindings for Node.js — the wasm sibling
#   of the NAPI rust backend. Unlike `build:wasm:node` (which builds the jsoo
#   bindings via dune), this builds `kimchi-wasm` straight from
#   proof-systems/pickle-rs, so the generated `kimchi_wasm.cjs` carries the
#   Rust Pickles exports (`rust_pickles_*`) used by setProofSystemBackend('rust')
#   over the wasm transport.
#
#   The proof-systems checkout is resolved automatically from the
#   `src/mina-rust` submodule's Cargo graph (it pins the same pickle-rs rev), so
#   no PROOF_SYSTEMS_ROOT / URL needs to be passed. Set PROOF_SYSTEMS_ROOT to
#   override the source checkout.
#
# Usage:
#   npm run build:wasm:node:rust

source ./scripts/lib/ux.sh

setup_script "wasm-node-rust-build" "wasm node rust build"

BINDINGS_PATH=./src/bindings/compiled/node_bindings/
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

info "building rust Kimchi WASM bindings from $PROOF_SYSTEMS_ROOT (nodejs)..."
NIGHTLY=${NIGHTLY_RUST_VERSION:-nightly}
BUILT_PATH=$PROOF_SYSTEMS_ROOT/target/nodejs
make -C "$PROOF_SYSTEMS_ROOT" build-nodejs \
  NIGHTLY_RUST_VERSION="$NIGHTLY" \
  KIMCHI_WASM_NODEJS_OUTDIR="$BUILT_PATH"

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

info "moving some files to CommonJS format..."
mv $BINDINGS_PATH/kimchi_wasm.js $BINDINGS_PATH/kimchi_wasm.cjs
mv $BINDINGS_PATH/kimchi_wasm.d.ts $BINDINGS_PATH/kimchi_wasm.d.cts

info "autofixing wasm bindings for Node.JS..."
run_cmd node src/build/fix-wasm-bindings-node.js $BINDINGS_PATH/kimchi_wasm.cjs

success "Rust WASM node build success!"
