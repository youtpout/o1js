#!/usr/bin/env bash
set -Eeuo pipefail

# Description:
#   Builds the Kimchi WebAssembly (WASM) bindings for Node.js. This script:
#     - Compiles the Kimchi proof system’s Node bindings using Dune, generating
#       the WebAssembly and JavaScript interface files:
#         - `plonk_wasm_bg.wasm` and its TypeScript definitions.
#         - `plonk_wasm.js` (the JS interface) and its type declarations.
#     - Copies all generated artifacts into `src/bindings/compiled/node_bindings/`.
#     - Converts the output files to CommonJS format (`.cjs` / `.d.cts`) for
#       compatibility with Node.js environments.
#     - Applies automatic fixes to the generated bindings via
#       `src/build/fix-wasm-bindings-node.js` to ensure correct runtime behavior.
#
# Usage:
#   npm run build:wasm:node

source ./scripts/lib/ux.sh

setup_script "wasm-node-build" "wasm node build"

BINDINGS_PATH=./src/bindings/compiled/node_bindings/

mkdir -p $BINDINGS_PATH

info "building Kimchi bindings for node..."

TARGETS=(\
  kimchi_wasm_bg.wasm \
  kimchi_wasm_bg.wasm.d.ts \
  kimchi_wasm.js \
  kimchi_wasm.d.ts \
)

# Rust migration path: build kimchi-wasm (which carries the Rust Pickles
# exports rust_pickles_*) straight from proof-systems/pickle-rs, bypassing the
# src/mina dune build. The proof-systems checkout is resolved automatically
# from the `src/mina-rust` submodule's Cargo graph (it depends on the same
# pickle-rs revision), so no PROOF_SYSTEMS_ROOT / URL needs to be passed. Set
# PROOF_SYSTEMS_ROOT explicitly to override, or USE_DUNE_WASM=1 to force the
# legacy OCaml path.
if [ -z "${PROOF_SYSTEMS_ROOT:-}" ] && [ -z "${USE_DUNE_WASM:-}" ] && [ -f ./src/mina-rust/Cargo.toml ]; then
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
  if [ -n "${PROOF_SYSTEMS_ROOT:-}" ]; then
    info "resolved proof-systems at $PROOF_SYSTEMS_ROOT"
  fi
fi

if [ -n "${PROOF_SYSTEMS_ROOT:-}" ]; then
  info "building native Kimchi WASM bindings from $PROOF_SYSTEMS_ROOT (nodejs)..."
  NIGHTLY=${NIGHTLY_RUST_VERSION:-nightly}
  BUILT_PATH=$PROOF_SYSTEMS_ROOT/target/nodejs
  make -C "$PROOF_SYSTEMS_ROOT" build-nodejs \
    NIGHTLY_RUST_VERSION="$NIGHTLY" \
    KIMCHI_WASM_NODEJS_OUTDIR="$BUILT_PATH"
else
  MINA_PATH=./src/mina
  KIMCHI_PATH=$MINA_PATH/src/lib/crypto/kimchi_bindings/js/node_js/
  BUILT_PATH=./_build/default/$KIMCHI_PATH
  dune build ${TARGETS[@]/#/$KIMCHI_PATH/}
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

success "WASM node build success!"
