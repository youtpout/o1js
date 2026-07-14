# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

**o1js v2.14.0** | Last updated: 2026-03-24

o1js is the TypeScript SDK for writing zero-knowledge applications on Mina
Protocol.

Read `AGENT.md` for build commands, architecture, circuit model, common
pitfalls, and file organization. Read `AGENT_LOG.md` for hard-won lessons from
previous agent sessions.

**Rust migration (branch `pickle-rust`):** read `RUST_MIGRATION.md` for the plan
and status of replacing the `src/mina` submodule with direct proof-systems
bindings (snarky-rs / pickles-rs).

Current Pickles VK parity handoff:

- local proof-systems source is expected at `~/Projects/proof-systems` on branch
  `pickle-rs`;
- o1js' OCaml Pickles binding prepends `dummy_constraints()` to every rule; Rust
  now ports that preamble (`proof-systems` commit `9aba71a8f5`);
- step gate histograms now match jsoo exactly for the minimal ZkProgram (512
  rows, same selector counts);
- VK commitments still do not match (`0/28`) because 10 internal
  wiring/coefficient differences remain inside the dummy preamble;
- use `src/tests/rust-pickles-step-gates-diff.ts` and
  `src/tests/rust-pickles-vk-parity.ts` to continue from this point.

## Migration plan: remove jsoo from o1js

The high-level Rust boundary is named **`mina-runtime`**. Do not reintroduce the
provisional `o1js-backend` name: the runtime is consumer-independent and owns
Pickles, Ledger, signed-command, and Mina serialization operations. The
production direction is `o1js -> mina-runtime -> proof-systems`.

### Current boundary

The Rust Pickles Step and Wrap circuits now have full gate parity with OCaml
Pickles in `~/Projects/proof-systems` on branch `pickle-rs`: row counts, gate
types, coefficients, and wiring all match. The experimental o1js API can record
a TypeScript circuit and produce base, N1, stable-N1, and N2 proofs via the
native Rust backend.

This does **not** mean o1js is jsoo-free yet. There are two independent OCaml
dependencies in the proof path:

1. OCaml Pickles implements the regular `ZkProgram.compile/prove/verify` API.
2. The experimental recorder still intercepts `Snarky.field.*` and
   `Snarky.gates.*`, so circuit execution and constraint emission still load
   Snarky jsoo before the recorded IR is sent to Rust.

Both layers must be replaced. Removing Pickles jsoo alone is only an
intermediate milestone.

### Phase 1 — stabilize the Rust program API

Replace witness-specific `compileRecorded()` with a reusable, versioned
compile/prove/verify API. Compilation must not require concrete private-input
values and must produce reusable proving indexes and a verification key.

Required native concepts:

- `CompiledProgramHandle` with explicit lifetime/disposal;
- one reusable proving index per method/branch;
- a serializable verification key;
- `prove(method, publicInput, privateInputs, previousProofs)`;
- `verify(statement, proof, verificationKey)`;
- deterministic cache serialization for Step/Wrap indexes.

Exit criterion: two different witnesses can use the same compiled program
without recompiling either circuit.

### Phase 2 — introduce a backend-neutral constraint IR

Stop monkey-patching `Snarky.field` and `Snarky.gates`. Add a `ConstraintSink`
abstraction used by `Field`, `Bool`, `Provable`, and the gadget layer. The
target shape is a TypeScript-owned, serializable IR containing witnesses, linear
combinations, basic constraints, and Kimchi custom gates.

During migration there may be two sinks:

- `JsooConstraintSink`, preserving the current implementation;
- `RustConstraintSink`, producing the IR consumed by proof-systems.

The final Rust path must execute witness functions and emit constraints without
importing Snarky jsoo. Prefer batching the complete IR over issuing a JS-to-Rust
callback for every constraint.

Exit criterion: a Field/Poseidon o1js program records, proves, and verifies with
the jsoo binding modules unavailable.

### Phase 3 — complete gate coverage

The Rust recorder currently rejects these gates:

- `ecScale`, `ecEndoscale`, `ecEndoscalar`;
- `xor`, `rotate`;
- `foreignFieldAdd`, `foreignFieldMul`;
- `raw`.

Port them in that order: EC first, bitwise second, foreign-field third, and a
stable typed representation for `raw` last. Add positive, tamper, gate-shape,
and prove/verify tests for every new IR variant.

Exit criterion: the normal o1js gadget test suite has no unsupported-gate
failure under the Rust sink.

### Phase 4 — route the regular ZkProgram API to Rust

Add a proof-system selector distinct from the low-level bindings selector, for
example:

```ts
setBackend('native');
setProofSystemBackend('rust');
```

Route the real `compileProgram()` implementation in
`src/lib/proof-system/zkprogram.ts` to Rust instead of exposing a parallel
experimental API. The Rust compiler must return the existing facade:

- `verificationKey`;
- one regular prover per method;
- `verify`;
- a compiled tag used for recursive-proof compatibility.

User code must remain unchanged: `Program.compile()`, `Program.method(...)`, and
`Program.verify(proof)` must work on either backend.

Exit criterion: `experimentalRustPickles` is only a compatibility alias and the
regular API passes its unit tests with `O1JS_PROOF_SYSTEM=rust`.

### Phase 5 — unify proofs and recursion

Remove the special Rust envelopes and native-only kept-proof handles from the
public API. Adapt Rust proofs to the existing o1js types and formats:

- `Proof`, `SelfProof`, and `DynamicProof`;
- `JsonProof` and Base64/bin_prot serialization;
- `VerificationKey`;
- `maxProofsVerified` N0/N1/N2 metadata;
- multi-method recursion and side-loaded verification keys.

The recursive statement must bind the previous proof's public input/output, not
merely its accumulator. Kept native handles may remain an internal cache, but a
serialized proof must always be sufficient to continue or verify a chain.

Exit criterion: existing recursive ZkPrograms and SmartContract proof arguments
run unchanged on Rust, including serialization between processes.

### Phase 6 — make Rust the Node default

Roll out in stages:

1. dedicated Rust CI jobs;
2. a jsoo/Rust matrix for the complete proof-system suite;
3. optional dual compilation with VK/gate comparison;
4. Rust as the default Node proof system;
5. removal of Pickles/Snarky jsoo from the Node package.

Before switching the default, require:

- all o1js proof-system and SmartContract tests green;
- N0/N1/N2 and multi-method recursion;
- proving-key cache round trips;
- proof/VK serialization parity;
- bounded native-handle memory usage;
- benchmarks using reused indexes rather than recompiling per proof.

### Implemented mina-runtime switch

The first regular API slice is implemented behind `O1JS_PROOF_SYSTEM=rust` or
`setProofSystemBackend('rust')`, independently from `setBackend()`:

- mina-runtime API/wire version negotiation and structured errors;
- the platform N-API loader (`O1JS_MINA_RUNTIME_PATH` for local builds);
- regular N0 `ZkProgram.compile()`, method proving, `Program.verify()` and
  global `verify()`;
- regular N1 `SelfProof` proving with arbitrarily chained retained proofs,
  including `Program.verify()`, global `verify()`, JSON round trips, and tamper
  rejection;
- regular N2 proving over two compatible retained base proofs, with the new
  method's constraints executed inside the width-2 step;
- public-input and public-output binding in the Rust application statement;
- `Proof.toJSON()` / `Proof.fromJSON()` round trips with tamper rejection;
- explicit circuit-resource disposal and reusable runtime circuit handles;
- a generic runtime operation entry point for Ledger, signed command, and
  encoding operations.

The switch supports one recursive proof input (N1) at any chain depth when the
previous proof was retained in the same process. Serialized N1 proofs are
independently verifiable, but a serialized proof cannot yet resume a recursive
chain because the full native continuation has no stable import/export format.
Chaining from an N2 result, heterogeneous previous wrap VKs, cross-process
recursive continuation, and SmartContract prover adaptation remain release
blockers and must stay visible in the parity gate.

### Backend parity gate

`npm run mina-runtime:parity` now executes the same regular N0 `ZkProgram` in
isolated jsoo and Rust processes. It covers public input/output binding,
compile/prove/verify, `Proof` JSON round trips, global `verify()`, tamper
rejection, method digest, row count, and gate histogram. The first measured run
passes all of those checks on both implementations; the method digest, rows, and
gate histogram are identical.

The gate deliberately keeps the two dependency graphs separate:

- jsoo uses the WASM Kimchi build from the unmodified official Mina submodule;
- Rust uses `mina-runtime` and the `proof-systems/pickle-rs` N-API build.

Do not point Mina's internal `proof-systems` submodule at `pickle-rs` and do not
patch generated Pickles `.ml` files. Doing so couples the reference frontend to
an incompatible prover and manifests as
`rest of division by vanishing polynomial` during jsoo proving. o1js now pins
Mina to the official parent of the old experimental `d53310c` submodule commit;
Rust integration belongs in `mina-rust`/`mina-runtime` instead.

The release report remains red only for real feature/format gaps: canonical
proof and VK formats, cross-backend verification, recursive continuation from N2
results, heterogeneous N2 branches, cross-process continuation, SmartContract
proofs, proving-index cache round trips, and browser runtime integration. jsoo
remains available as the reference and fallback until these capabilities are
implemented 1:1.

### Phase 7 — provide the same backend through Rust WASM

Expose the same compile/prove/verify and IR API from `kimchi-wasm`. Native and
browser transports must share proof formats and program semantics. Add worker
support, optional WASM threads, and IndexedDB index caching.

The low-level experimental recorded-circuit path now honors `setBackend('wasm')`
and uses the Pickles exports from `kimchi-wasm` for base, kept-base, N1, N2, and
standalone verification. Node base→N1 proving and verification are validated in
`~/Projects/zkapp-rust`. This is not yet the high-level mina-runtime transport:
regular `O1JS_PROOF_SYSTEM=rust` programs still require the N-API adapter.

The Rust WASM exports must execute inside `withThreadPool()`, and the exported
Rust functions must in turn enter `rayon::ThreadPool::install`; initializing
workers alone does not route Rayon work into that pool. Reusable compiled
handles now retain the base and N1 Step/Wrap indexes in WASM or N-API memory;
the circuit witness is a proving input and no longer captured by the compiled
Wrap/recursive-Step circuit. `compileN1Over()` compiles an N1 transition against
a retained base proof, and both compiled handles support repeated proving.

The 2026-07-14 AddZkProgram benchmark disables the o1js key cache and covers
JSOO/Rust on WASM/native. Once compiled, Rust proving is faster than JSOO:
2.818 + 5.543 s versus 3.559 + 5.215 s on WASM, and 1.440 + 2.969 s versus
2.222 + 3.820 s natively. Rust verification is also faster. Cold totals remain
slower (33.359 s versus 18.540 s WASM; 18.020 s versus 10.663 s native) because
Rust N1 compilation still generates a temporary recursive Step proof to derive
the Wrap compilation witness. Removing that temporary proof is now the main
performance milestone; proving-index reuse itself is complete for N0/N1.

Exit criterion: the browser bundle can compile, prove, verify, serialize, and
resume recursive chains without loading OCaml-generated JavaScript.

### Phase 8 — remove Mina and jsoo from the build graph

Once Node and browser both use Rust:

- remove `Pickles` and Snarky jsoo imports;
- remove OCaml Pickles binding generation;
- build native and WASM packages directly from `~/Projects/proof-systems`;
- remove the Mina submodule from the o1js proof-system build;
- retain only the Mina-compatible formats implemented in Rust.

Audit the remaining jsoo consumers separately. Ledger, transaction, and Mina
bindings are outside the Pickles migration and may require their own Rust or
TypeScript replacements before the complete o1js package is jsoo-free.

### Immediate implementation order

The next three large changes should be:

1. introduce `ConstraintSink` and run a Field/Poseidon program without
   `Snarky.field.*`;
2. add the eight missing gate families to the IR and Rust backend;
3. implement reusable `RustCompiledProgram` indexes and route the regular
   `ZkProgram.compile()` API behind a feature flag.

Do not remove the jsoo fallback before these three milestones and the full
cross-backend CI matrix are complete.
