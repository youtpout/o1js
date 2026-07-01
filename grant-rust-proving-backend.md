# Rust Proving Backend Grant Summary

## Project Name

Rust Proving Backend

## Project Details

Rust Proving Backend will replace the OCaml/JSOO Snarky and Pickles proving layer with a Rust-native backend for o1js. The project will reuse the existing Rust Kimchi/proof-systems foundation and the Mina Rust verifier work to provide WASM and native proving paths, enabling smaller o1js builds and opening the path to Rust-based Mina block proving.

## Mina-Specific Features

The project will use Mina's core proof system: Kimchi, Pickles, Pasta curves, and Poseidon hashing. It will also use Mina's existing proof and verification key formats so the new Rust backend stays compatible with o1js and Mina nodes.

## Why Mina?

Mina is the right platform because o1js and Pickles are core parts of its zkApp ecosystem, and this project directly improves that stack. A Rust proving backend can make Mina development easier, reduce build complexity, and help enable future Rust-based proving for o1js and Mina nodes.

## Intended Users

This project is for o1js developers, Mina zkApp builders, and Rust developers who want a native proving stack. It is also useful for Mina node developers, since the same Rust backend can help enable future block proving in a Rust Mina node.

## Problem and Impact

It removes o1js's dependence on the OCaml/JSOO proving layer by moving Snarky and Pickles toward a Rust-native backend. This reduces build complexity, improves portability, extends the existing native server proving path, and opens the door to Rust zkApps, Rust Mina block proving, and eventually mobile proving through Rust FFI on iOS and Android.

## Sustainability

The project is intended to be integrated into O1 Labs' open-source `proof-systems` repository. This means it can be maintained and improved by O1 Labs, myself, and the wider open-source community over time.

## Expected Timeline

The expected duration is 6 months. In this first phase, I plan to build the Rust Snarky/Pickles backend, reuse the existing Mina Rust verifier work, and integrate an initial WASM-compatible backend with o1js/proof-systems. Further work may be needed after this phase for full production parity and complete OCaml removal.

## Milestones and KPIs

### 1. Snarky Rust Backend

Implement the core Snarky layer in Rust: circuit variables, witnesses, constraints, and core gates. Add tests and documentation as the implementation progresses.

KPI: simple o1js-style circuits can generate valid Kimchi-compatible constraint data.

### 2. Pickles Rust Backend

Reuse and extend existing Rust Pickles verification work from Mina Rust. Implement the core Pickles proving flow needed for recursive proofs. Add tests and documentation throughout development.

KPI: Rust-generated proofs can verify against Mina/o1js-compatible proof and verification key formats.

### 3. o1js Integration

Expose the Rust backend through WASM and integrate it as an experimental o1js backend. Continue adding compatibility tests and developer documentation during integration.

KPI: at least one o1js `ZkProgram` can compile, prove, and verify using the Rust backend.

## Additional Context

This project is not starting from zero: Kimchi already exists in Rust, and Mina Rust already includes useful Pickles verification work. The goal is to connect and extend these existing pieces into a Rust-native Snarky/Pickles backend that can benefit o1js, Mina Rust, and the wider open-source Mina ecosystem.

After working extensively with o1js and trying to compile the library with my own modifications, I saw how complex the current proving stack is. The high-level proving layer still depends on OCaml/JSOO, while the lower-level Kimchi proof system is already implemented in Rust. This creates unnecessary complexity: developers have to deal with both the OCaml and Rust toolchains, even though the core proof system is already Rust-based.

Moving the Snarky/Pickles layer to Rust would simplify development, testing, debugging, and compilation. I have also worked on the verification side by integrating the Mina Rust Pickles verifier into SP1 and making some optimizations there. Extending this work to the proving side would make it easier to optimize both proving performance and circuit compilation across different architectures.

## Technical Notes

Useful code already exists in `mina-rust`:

- `crates/ledger/src/proofs/verification.rs`: Pickles/Mina proof verification, deferred values, and `verify_with`.
- `crates/ledger/src/proofs/step.rs`: step verifier logic, recursion challenges, feature flags, and next-step messages.
- `crates/ledger/src/proofs/wrap.rs`: wrap verifier logic, oracles, domains, and combined inner product.
- `crates/ledger/src/proofs/prover.rs`: conversion from Mina Pickles proof format to Kimchi `ProverProof`.
- `crates/ledger/src/proofs/verifiers.rs`: verifier index construction, including zkApp verifier indexes.
- `crates/ledger/src/proofs/witness.rs`: partial Snarky-like witness generation.
- `crates/ledger/src/proofs/field.rs`: partial Snarky-like `Field`, `Boolean`, and `CircuitVar` logic.

The main missing parts are a dynamic o1js-compatible Snarky circuit builder, generic Pickles compile/prove support for o1js `ZkProgram`, and WASM integration into o1js.
