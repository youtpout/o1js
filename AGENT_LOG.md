# AGENT_LOG.md — o1js

> **Append-only context log.** This file is institutional memory for the o1js
> codebase. Every entry records something an agent or human learned the hard
> way. New agents: read this before you start. It will save you from repeating
> mistakes. After your session: append what you learned. Future agents depend on
> it.

---

## Protocol: How to Use This File

### Reading

- **Before starting any task**, scan entries relevant to your work area.
- Filter by `category` — YAML frontmatter is structured for this.
- Pay special attention to entries with `severity: critical` or
  `severity: high`.
- Entries are chronological (newest at bottom). For recurring themes, search by
  category rather than reading linearly.

### Writing

**When to append an entry:**

You MUST append an entry when any of the following occur during your session:

- **Bug discovered**: You find a bug, surprising behavior, or silent failure
  mode
- **Footgun encountered**: Something that looks correct but isn't, or an
  easy-to-make mistake
- **Failed approach**: You tried something reasonable that didn't work —
  document WHY it failed
- **Dead end investigated**: You went down a path that turned out to be
  unproductive — save the next agent the trip
- **Architecture insight**: You learned something non-obvious about how the
  system fits together
- **Resolution pattern**: You found a fix or workaround for a known class of
  problems
- **Environment/tooling issue**: Build system, dependency, or platform-specific
  gotcha
- **Regression pattern**: A change in one area broke something in another —
  document the coupling

**How to append:**

1. Add a new entry at the **bottom** of this file (before the `<!-- END LOG -->`
   marker)
2. Use the exact template below
3. Never modify or delete existing entries (append-only)
4. Keep entries self-contained — a reader should understand the entry without
   reading others
5. Be specific: include file paths, error messages, and code snippets where
   relevant
6. Commit the updated log alongside your code changes

### Entry Template

```markdown
---
date: YYYY-MM-DD
agent: <agent-name-or-model>
session: <brief-task-description>
category: <see categories below>
severity: <critical|high|medium|low|info>
tags: [<free-form>, <tags>, <for-search>]
---

### <concise-title>

**Context:** What were you trying to do?

**What happened:** What went wrong, or what did you discover?

**Root cause:** Why did this happen? (If known)

**Resolution/Workaround:** How did you fix it, or how should it be handled?

**Key takeaway:** One-sentence lesson for future agents.

**Relevant files:** `path/to/file.ts`, `path/to/other.rs`
```

### Categories

| Category             | Use when...                                                |
| -------------------- | ---------------------------------------------------------- |
| `rust-wasm-boundary` | Issues crossing the Rust↔WASM↔TypeScript boundary          |
| `native-ffi`         | Neon/napi-rs native binding issues                         |
| `circuit-model`      | Compile-time vs prove-time behavior, constraint generation |
| `provable-types`     | Type system surprises, serialization, Struct issues        |
| `proof-system`       | Kimchi, Pickles, recursion, proving/verification           |
| `build-system`       | Build, compilation, bundling, dependency issues            |
| `testing`            | Test infrastructure, flaky tests, test patterns            |
| `performance`        | Proving time, compilation time, memory usage               |
| `api-design`         | Public API footguns, naming, developer experience          |
| `concurrency`        | Threading, Rayon, async, worker issues                     |
| `cryptography`       | Curve operations, hashing, signature edge cases            |
| `state-management`   | zkApp on-chain state, preconditions, transactions          |
| `architecture`       | System design insights, coupling, module boundaries        |
| `dead-end`           | Approaches that were tried and abandoned                   |
| `environment`        | Node version, OS-specific, browser compat issues           |
| `documentation`      | Misleading docs, undocumented behavior                     |

### Severity Guide

| Severity   | Meaning                                                                               |
| ---------- | ------------------------------------------------------------------------------------- |
| `critical` | Will cause incorrect proofs, data loss, or silent failures. Must be addressed.        |
| `high`     | Significant time wasted or subtle bugs. Important to know before working in the area. |
| `medium`   | Good to know. Will save 30+ minutes of investigation.                                 |
| `low`      | Minor quality-of-life insight.                                                        |
| `info`     | Architectural context. Not a problem, but useful for understanding.                   |

---

## Log Entries

<!-- Entries below. Newest at bottom. Do not modify existing entries. -->

---

date: 2025-01-01 agent: human session: initial-log-creation category:
documentation severity: info tags: [meta, seed-entry]

---

### Seed entry — Why this file exists

**Context:** Establishing the AGENT_LOG.md pattern for the o1js repository.

**What happened:** Across multiple debugging sessions (both human and
AI-assisted), we repeatedly re-investigated the same classes of problems —
particularly around the Rust/WASM boundary, Rayon thread panics, and circuit
model subtleties. Each session started from zero context.

**Root cause:** No persistent, structured record of past investigations. Git
commit messages capture _what_ changed but not _why an approach was tried and
failed_, or _what was learned about the system's behavior_.

**Resolution/Workaround:** This file. Agents and humans should append entries
whenever they learn something non-obvious. The log is append-only to preserve
the full reasoning history, including dead ends and failed approaches.

**Key takeaway:** The most valuable context is often "we tried X and it didn't
work because Y" — commit messages never capture this.

**Relevant files:** `AGENT.md`, `AGENT_LOG.md`

---

date: 2025-01-01 agent: human session: initial-log-creation category:
rust-wasm-boundary severity: critical tags: [rayon, wasm, thread-panic,
recurring]

---

### Rayon worker thread panics in WASM are unrecoverable

**Context:** The Rust proof system backend (Kimchi) uses Rayon for parallel
computation. When compiled to WASM, threading behaves fundamentally differently
than in native environments.

**What happened:** Panics inside Rayon worker threads in WASM environments
produce cryptic, unrecoverable errors. The panic cannot be caught at the WASM↔JS
boundary, and the entire WASM instance becomes corrupted. This has been hit
multiple times across different debugging sessions.

**Root cause:** WASM's threading model (SharedArrayBuffer + Web Workers) doesn't
support the panic unwinding that Rayon expects. When a Rayon worker panics, the
thread is terminated but the thread pool's shared state becomes inconsistent.
Subsequent calls into the WASM module may hang or produce garbage.

**Resolution/Workaround:** Multiple remediation paths have been analyzed:

1. Catch panics at the FFI boundary using `std::panic::catch_unwind` before they
   reach Rayon workers
2. Use `panic = "abort"` in WASM builds (prevents unwinding but kills the
   instance)
3. Validate inputs on the Rust side before they reach parallel code paths
4. The native prover (Neon FFI) does not have this issue — panics can be caught
   at the napi-rs boundary

**Key takeaway:** Any Rust change that could introduce a new panic path in
parallelized code MUST be tested in WASM, not just native. A passing native test
does not guarantee WASM safety.

**Relevant files:** `src/bindings/compiled/`, `src/bindings/native/`

---

date: 2026-07-13 agent: codex session: mina-runtime-regular-zkprogram category:
architecture severity: high tags: [mina-runtime, napi, serde, zkprogram,
proof-serialization]

---

### The mina-runtime wire and regular ZkProgram need explicit boundary rules

**Context:** Routing the regular o1js N0 ZkProgram API through mina-runtime
instead of calling proof-systems directly.

**What happened:** Three boundary details were easy to get subtly wrong. Serde
fields in named request structs use camelCase, while fields embedded directly in
enum variants (such as `DropCircuit { circuit_id }`) retain snake_case. A
compile-time synthesized value can violate user assertions, so recorder
compilation must capture assertions without validating the dummy witness.
Finally, public inputs must be witnessed and included with public outputs in the
recorded application state or the proof does not bind them.

**Root cause:** The original experimental recorder was witness-specific and its
proof envelope was separate from regular `Proof` / `JsonProof`; neither was a
reusable, versioned SDK boundary.

**Resolution/Workaround:** `MinaRuntimeClient` centralizes the v1 wire format.
Regular compilation records symbolic witnessed inputs with dummy-witness
validation disabled, proving re-records and validates the real witness, and the
proof payload uses a tagged `mina-runtime-pickles-v1` serialization handled by
`Proof.toJSON()` / `Proof.fromJSON()`. Verification compares the complete public
input/output statement before calling mina-runtime.

**Key takeaway:** Keep transport naming, serde spelling, compile-time witness
policy, and proof serialization centralized; never reconstruct them ad hoc in
individual o1js APIs.

**Relevant files:** `src/lib/mina-runtime/backend.ts`,
`src/lib/proof-system/rust-pickles-recorded.ts`,
`src/lib/proof-system/proof.ts`, `src/lib/proof-system/zkprogram.ts`

---

date: 2026-07-14 agent: codex session: mina-runtime-parity-gate category:
architecture severity: critical tags: [mina, jsoo, kimchi, parity, submodules]

---

### Keep the jsoo reference and experimental Rust dependency graphs separate

**Context:** Building a release gate that executes the same regular N0
`ZkProgram` through jsoo and mina-runtime.

**What happened:** jsoo compiled circuits but every proof failed with
`rest of division by vanishing polynomial`. Rebuilding native bindings did not
help. The Mina submodule had been moved to an experimental commit that
redirected its internal `proof-systems` dependency, and Dune regenerated Pickles
`.ml` files against that revision. A second trap in the probe hard-coded
`setBackend('native')` and silently ignored attempts to select the matching jsoo
WASM transport.

**Root cause:** The OCaml circuit frontend and the Kimchi prover came from
different proof-system revisions. The constraint system compiled successfully,
but its quotient polynomial did not match the prover implementation.

**Resolution/Workaround:** Pin `src/mina` to the official parent before the
experimental proof-systems redirection. Build jsoo and its WASM from that same
Mina revision. Run the jsoo reference with this WASM, while mina-runtime uses
the native N-API module built from `proof-systems/pickle-rs`. The parity probe
must respect `O1JS_BACKEND` instead of hard-coding a transport.

**Key takeaway:** Never patch generated Pickles `.ml` files or point Mina's
internal proof-systems submodule at the experimental Rust branch. Integrate Rust
through `mina-rust`/`mina-runtime`; preserve Mina as an immutable jsoo reference
until feature parity is complete.

**Relevant files:** `src/mina`, `src/tests/mina-runtime-parity-probe.ts`,
`scripts/tests/mina-runtime-release-gate.mjs`,
`.github/workflows/mina-runtime.yml`

---

date: 2026-07-14 agent: codex session: mina-runtime-regular-n1 category:
architecture severity: high tags: [mina-runtime, pickles, recursion, resources,
zkprogram]

---

### Recursive proving needs both serialized proof data and a live base resource

**Context:** Extending the regular Rust-backed `ZkProgram` API from N0 to one
`SelfProof` input without routing through jsoo.

**What happened:** A base proof serialized enough data for standalone
verification, but Pickles N1 proving needs the full `RecordedBaseHandle`. The
first regular call also lost that live handle because `Provable.fromValue()`
reconstructed the `SelfProof`; its public fields survived while its
process-local WeakMap resource did not. The first N1 verification attempt also
treated nested recursion metadata as a base proof.

**Resolution/Workaround:** mina-runtime now owns retained base proofs behind
opaque IDs and exposes keep, N1-over, recursive verify, and drop operations.
o1js attaches the ID-backed resource to the proof supplied to the caller, reads
resources from the original prover arguments before `fromValue()` cloning, and
flattens tagged N1 metadata for both `Program.verify()` and global `verify()`.
`Program.dispose()` releases retained proofs. JSON proofs remain verifiable, but
cannot extend a chain after the live resource is gone.

**Key takeaway:** A recursive proof has two lifetimes: its portable verification
envelope and its prover-only native continuation state. Do not infer the latter
from public fields or silently fall back after serialization; expose and release
it explicitly until a canonical import/export format exists.

**Relevant files:** `src/lib/mina-runtime/backend.ts`,
`src/lib/proof-system/rust-pickles.ts`,
`src/lib/proof-system/rust-pickles-recorded.ts`,
`src/lib/proof-system/zkprogram.ts`, `src/tests/mina-runtime-zkprogram-n1.ts`

---

date: 2026-07-14 agent: codex session: mina-runtime-chained-n1 category:
architecture severity: high tags: [mina-runtime, pickles, recursion, handles]

---

### A retained recursive proof must distinguish its old and new app states

**Context:** Generalizing the process-local proof handle from base → N1 to an
arbitrary N1 chain.

**What happened:** The first stable cycle failed even though the new app and VK
were included in both two-pass builds. The next-step preparation was passing the
new application state where Pickles needed the previous proof's public state to
finalize its accumulator digest.

**Resolution/Workaround:** proof-systems now retains either a base proof or the
complete latest recursive step/wrap cycle. The next-cycle API takes the previous
and new states separately and shares the embedded application closure across
both VK-stabilization passes. mina-runtime returns a fresh opaque proof ID for
every N1 result; o1js attaches that resource to the returned `SelfProof` so it
can be consumed again and releases all retained IDs on `Program.dispose()`.

**Key takeaway:** Recursive continuation state is not just the latest envelope:
the previous public state finalizes the consumed proof, while the new public
state is bound by the statement being produced. Keep both roles explicit.

**Relevant files:** `src/lib/proof-system/zkprogram.ts`,
`src/lib/proof-system/rust-pickles-recorded.ts`,
`src/lib/mina-runtime/backend.ts`, `src/tests/mina-runtime-zkprogram-n1.ts`

---

date: 2026-07-14 agent: codex session: mina-runtime-regular-n2 category:
architecture severity: high tags: [mina-runtime, pickles, n2, zkprogram]

---

### Width-2 proving must execute the new application, not trust its app state

**Context:** Routing regular methods with two `SelfProof` inputs through the
Rust backend.

**What happened:** The existing low-level recorded N2 helper generated and
verified a width-2 proof, but accepted the new public application state from the
host. That was sufficient for structural recursion tests and insufficient for a
regular `ZkProgram` method because its new constraints were not in the step.

**Resolution/Workaround:** The width-2 recursive circuit now accepts the same
embedded application closure as N1 and proves that its output matches the state
hashed into the statement. mina-runtime atomically borrows two retained base
handles, returns plural recursion metadata, and uses the existing recursive
verifier. o1js routes two supplied proofs to this operation and serializes the
result with an explicit `n2` tag.

**Key takeaway:** Binding host-provided public fields is not a substitute for
executing the method circuit. Every regular recursive branch must embed the new
application constraints in the step that consumes the prior proofs.

**Relevant files:** `src/lib/proof-system/zkprogram.ts`,
`src/lib/proof-system/rust-pickles-recorded.ts`,
`src/lib/mina-runtime/backend.ts`, `src/tests/mina-runtime-zkprogram-n2.ts`

---

date: 2026-07-14 agent: codex session: pickles-rust-wasm-benchmark category:
rust-wasm-boundary severity: high tags: [pickles, wasm, napi, benchmark,
transport]

---

### The experimental Pickles recorder silently selected N-API under a WASM backend

**Context:** Benchmarking the same recursive ZkProgram through jsoo WASM and
Pickles Rust WASM.

**What happened:** `setBackend('wasm')` selected Kimchi WASM for ordinary o1js
operations, but `rust-pickles-recorded.ts` still imported `native/native.js`
unconditionally. A benchmark labelled Rust WASM therefore measured N-API. The
WASM standalone-verifier exports also accept recursion vectors as JSON strings,
while N-API accepts JavaScript arrays.

**Root cause:** The experimental recorder predated the backend selector and its
local binding type described only the N-API calling convention.

**Resolution/Workaround:** Select the live `wasm` binding after
`initializeBindings()` when `getBackendPreference()` is `wasm`, keep N-API for
`native`, and normalize the two WASM verifier calls at the TypeScript boundary.
The installed o1js WASM artifacts must be built from `proof-systems/pickle-rs`;
the official Mina artifacts do not contain the experimental Pickles exports.

**Key takeaway:** A WASM benchmark must assert that the Pickles exports exist in
the selected module; `setBackend('wasm')` alone did not previously prove that
the recursive prover was running in WASM.

**Relevant files:** `src/lib/proof-system/rust-pickles-recorded.ts`,
`src/bindings/compiled/node_bindings/kimchi_wasm.cjs`,
`~/Projects/zkapp-rust/contracts/src/AddZkProgram.bench.ts`

date: 2026-07-14 agent: codex session: pickles-rust-wasm-performance category:
performance severity: high tags: [pickles, wasm, rayon, srs, benchmark]

---

### WASM workers only help when Pickles enters the Rayon pool

**Context:** The no-cache AddZkProgram base→N1 benchmark initially measured
about 194 seconds for Rust WASM versus 18 seconds for JSOO WASM.

**What happened:** o1js initialized a WASM worker pool, but the experimental
Pickles exports ran outside `rayon::ThreadPool::install`. Every Rayon operation
therefore stayed on the calling thread. Standalone verification also rebuilt a
full 2^15 Pallas SRS for every proof, while circuit compilation repeatedly
regenerated the protocol-fixed Tick and Tock SRSes.

**Resolution/Workaround:** Wrap every Rust Pickles WASM operation in
`withThreadPool()` on the TypeScript side and `run_in_pool()` at the Rust export
boundary. Share curve-specific 2^16 Vesta and 2^15 Pallas SRSes across Snarky
compilation, proving, and standalone verification. Base proving also skips the
unused bootstrap wrap proof and reuses the exact Step index in its final pass.
Sixteen workers performed best on the benchmark machine. Rust dropped from about
194 seconds to 29.110 seconds; verification dropped to 92/93 ms and is faster
than JSOO's 233/235 ms. `wasm-opt -O4`, SIMD128, generic SRS caches, parallel
SRS construction, and removing local self-verification were neutral or
regressive and were reverted.

**Key takeaway:** Worker initialization is not execution context. Enter the
custom Rayon pool at every long-running WASM export, and cache protocol-fixed
cryptographic setup by curve. The remaining proving gap needs reusable compiled
program indexes, not more blind compiler flags.

**Relevant files:** `src/lib/proof-system/rust-pickles-recorded.ts`,
`~/Projects/proof-systems/kimchi-wasm/src/pickles.rs`,
`~/Projects/proof-systems/snarky/src/api.rs`,
`~/Projects/proof-systems/pickles/src/common.rs`,
`~/Projects/zkapp-rust/contracts/src/AddZkProgram.bench.ts`

date: 2026-07-14 agent: codex session: pickles-compiled-indexes category:
performance severity: high tags: [pickles, compiled-index, wasm, napi,
benchmark]

---

### Compiled Pickles handles must keep indexes while taking witnesses at prove time

**Context:** Rust base and N1 proving recompiled every Step and Wrap index for
every proof, unlike JSOO's `ZkProgram.compile()` / prover split.

**What happened:** `WrapCircuit` and `RecursiveStepCircuit` captured their
witness data in the circuit object. That made the Snarky prover index appear
single-use even though the constraint system is stable across witnesses.
`experimentalRustPickles.compile()` also recorded a circuit but retained no
direct Rust indexes.

**Resolution/Workaround:** Move Wrap and recursive-Step witness data into their
`PrivateInput`, retain typed Step/Wrap prover and verifier indexes behind opaque
WASM/N-API handles, and expose `compileN1Over()` for the first recursive
transition. Tests prove multiple base witnesses from one index set and prove N1
through retained indexes. Wrap gate parity remains a full 8192-row match.

On the no-cache four-backend benchmark, compiled Rust proving is at parity or
better: base+N1 proving is 8.361 s Rust versus 8.774 s JSOO in WASM and 4.409 s
versus 6.042 s native. Cold totals are 33.359/18.540 s (Rust/JSOO WASM) and
18.020/10.663 s (Rust/JSOO native) because N1 compilation still creates one
temporary recursive Step proof before it can compile the Wrap index.

**Key takeaway:** A reusable index requires witness data to enter through the
prover, not live in the circuit value captured during compilation. The next
optimization target is construction of the recursive Wrap compilation witness
without producing a temporary cryptographic Step proof.

**Relevant files:** `src/lib/proof-system/rust-pickles-recorded.ts`,
`src/lib/proof-system/zkprogram.ts`,
`~/Projects/proof-systems/pickles/src/api.rs`,
`~/Projects/proof-systems/pickles/src/recursive_step.rs`,
`~/Projects/zkapp-rust/contracts/src/AddZkProgram.bench.ts`

date: 2026-07-14 agent: codex session: pickles-eager-program-compile category:
architecture severity: high tags: [pickles, zkprogram, napi, wasm, recursion]

---

### Rust ZkProgram compilation is atomic and no longer defers stable N1 indexes

**Context:** Compiled base/N1/N2 handles existed, but regular Rust
`ZkProgram.compile()` registered methods one at a time. A second N1 cycle could
also fall back to a helper that rebuilt Step and Wrap indexes during proving.

**What happened:** Base index discovery additionally tried to prove the
placeholder values synthesized by o1js analysis, so arbitrary assertions could
make compilation fail even though the circuit shape was valid.

**Resolution/Workaround:** Pickles now builds the base Wrap constraint system
from a proof-shaped structural witness and derives the real Lagrange constants
from the Step index, without producing an invalid application proof. The N1
compiled handle eagerly retains separate index pairs for the first transition
and the stable recursive shape; the compile-on-prove fallback was removed.
mina-runtime added an atomic `compileProgram` request, shared unchanged by NAPI
and WASM, and o1js records all methods before sending that single request. N0,
N1, N2, chained stable N1, TypeScript, NAPI, and WASM checks pass.

**Key takeaway:** Compilation witnesses determine circuit structure and fixed
coefficients, not application satisfiability. Every index needed by a supported
branch must be owned before `ZkProgram.compile()` returns.

**Relevant files:** `src/lib/proof-system/zkprogram.ts`,
`src/lib/proof-system/rust-pickles-recorded.ts`,
`src/lib/mina-runtime/backend.ts`,
`~/Projects/mina-rust/crates/mina-runtime/src/backend.rs`,
`~/Projects/proof-systems/pickles/src/recorded.rs`

date: 2026-07-22 agent: codex session: lumina-smartcontract-rust category:
correctness severity: high tags: [pickles, smartcontract, lookup, wasm,
vk-parity]

---

### SmartContract witness callbacks and multi-method N0 programs need canonical Rust shapes

**Context:** Lumina's `Factory.test` compiled with Rust but failed while proving
and sending real zkApp account updates. Large token/pool contracts also retain
several N0 methods and mix lookup with non-lookup Step circuits.

**What happened:** Recorder hooks captured checked operations executed inside
`Provable.witness` callbacks, so prove-time transaction/state reads added
constraints that structure-only compile never saw. Multi-method N0 contracts
were compiled as independent base cases instead of one Pickles program Wrap.
Mixed lookup programs then needed the lookup `Opt.Maybe` payload even while
proving their no-lookup branch. Finally, the Mina transaction statement
serialized feature flags and the joint combiner as always absent, causing the
ledger's jsoo verifier to reject an otherwise valid Rust proof.

**Resolution/Workaround:** Ignore recorder hooks while `inWitnessBlock`,
re-enter the canonical `inProver` context with live prover data, and compare
proof-authorization witness values outside the checked DSL. Compile every
multi-branch N0 program with one shared Wrap; retain dummy masked lookup
payloads on absent branches; serialize real lookup flags/joint-combiner in Sexp
and bin_prot; and embed the canonical maximum Step domain VK in every branch
proof. Drop temporary per-branch Wrap indexes during shared compile to keep Rust
WASM below its memory ceiling.

`Factory.test` passes 8/8 in Rust native and 8/8 in Rust WASM, including every
`tx.prove()` and local-ledger `send()`. VK `{data,hash}` output for all six
Lumina contracts is byte-identical between Rust and jsoo.

**Key takeaway:** A witness callback is a value-generation boundary, not part of
the recorded circuit. For a Pickles program, proof metadata and optional lookup
payload shape belong to the canonical program Wrap, even when the selected
method is a smaller or no-lookup branch.

**Relevant files:** `src/lib/mina/v1/zkapp.ts`,
`src/lib/proof-system/rust-pickles-recorded.ts`,
`~/Projects/proof-systems/pickles/src/{api.rs,recorded.rs,mina_sexp.rs,mina_bin_prot.rs}`

<!-- END LOG -->
