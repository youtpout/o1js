# Grant Proposal: Pure Rust Backend for o1js

**Project:** Migration of o1js from OCaml/JSOO to a pure Rust/WASM backend  
**Applicant:** [Your name / org]  
**Contact:** eddyboughioul@gmail.com  
**Requested amount:** [TBD — see budget below]  
**Duration:** 6 months  
**Repository:** https://github.com/o1-labs/o1js (target upstream)

---

## Summary

o1js currently relies on two compiled backends: a 22 MB OCaml-to-JavaScript blob
(via `js_of_ocaml`) and a Rust/WASM module for low-level field arithmetic.
This proposal funds the complete replacement of the OCaml layer with a pure
Rust implementation, eliminating the OCaml toolchain dependency entirely.

The core deliverable is **`pickles-rs`** — a Rust implementation of the Pickles
recursive proof system. This single component unlocks five distinct capabilities
that are currently impossible on Mina: smart contracts in Rust, a full Rust Mina
node, native server-side proving, mobile proving, and a path to GPU acceleration.

The Rust cryptographic foundations already exist in `proof-systems` and
`zeko-rust`. This work closes the only remaining gap.

---

## Motivation

### Current architecture

```
TypeScript (o1js)
    │
    ▼
OCaml/JSOO (Pickles + Snarky)   ← 22 MB JS blob (node) / 7.6 MB (web)
    │
    ▼
Kimchi WASM (Rust)              ← 5–15 MB WASM, already Rust
```

Two runtimes, two build pipelines, one blocking on the other.

### Problems

| Issue | Impact |
|-------|--------|
| OCaml toolchain (opam, dune, jsoo) required to build o1js | Blocks contributors; slow CI; hard to cross-compile |
| JSOO blob is 22 MB (node) / 7.6 MB (web) | Large bundles; slow load for zkApp frontends |
| Two separate build pipelines (dune + wasm-pack) | Complex, fragile, hard to maintain |
| OCaml runtime errors surface as opaque JS exceptions | Poor developer experience |
| Pickles in OCaml only → no Rust node, no mobile, no GPU | Hard ceiling on Mina's ecosystem |

---

## Why `pickles-rs` matters — five unlocked capabilities

### 1. Smart contracts in Rust

Today zkApps can only be written in TypeScript. With `pickles-rs` + `snarky-rs`,
developers can write circuits directly in Rust:

```rust
#[zkprogram]
fn transfer(pub_input: Field, amount: Field, recipient: Field) -> Field {
    amount.assert_less_than(Field::from(1_000_000));
    pub_input.add(amount)
}
```

This opens Mina to the entire Rust ZK ecosystem — developers who already use
arkworks, halo2, or SP1 can build zkApps without learning TypeScript.

### 2. Full Rust Mina node

`zeko-rust` already implements a Mina node in Rust but **cannot produce blocks**
because block production requires Pickles proofs. With `pickles-rs`:

```
zeko-rust + pickles-rs = complete Mina node in Rust
    ├── block production (block proof via Pickles)
    ├── transaction verification (scan state)
    └── zkApp validation
```

This is likely the primary motivation behind `zeko-rust` — everything is ready
except Pickles.

### 3. Native server-side proving (3.5x perf gain)

The `@o1js/native` package (plonk-neon, Rust via Node.js N-API) already exists
and is **3.5x faster** than WASM across all circuits:

| Circuit | WASM prove | Native prove | Ratio |
|---------|-----------|--------------|-------|
| sha256 | 20.9s | 6.0s | 3.5x |
| ecdsa | 64.0s | 18.4s | 3.5x |
| big-program | 68.5s | 23.3s | 2.9x |

Today this native backend only works with TypeScript zkApps. With `pickles-rs`,
Rust smart contracts benefit from the same native backend — no WASM overhead
on the critical proving path.

### 4. Mobile proving

No ZK proof system currently runs well on mobile. The blockers today:

- WASM in mobile browsers: no SharedArrayBuffer, no threads, too slow
- OCaml JSOO: even worse
- Node.js native: unavailable on mobile

Rust compiles to Android (JNI) and iOS (FFI) natively:

```
iPhone/Android → Rust via JNI/FFI → pickles-rs native → proof
```

- Full access to device threads (8–12 cores on modern phones)
- Path to GPU acceleration via Metal (iOS) and Vulkan (Android)
- First ZK proving system on Mina usable in native mobile apps

### 5. GPU proving (long-term)

The prove time bottleneck is in Kimchi: MSM (~50–60%) and FFT (~20–30%).
These are embarrassingly parallel operations — exactly what GPUs excel at.

WASM has **no GPU access**. A native Rust prover can integrate directly with:
- **Icicle** (Ingonyama) — CUDA MSM, already supports Pasta curves and arkworks
- Metal/Vulkan for mobile GPUs

Projected gains on native + GPU:

```
WASM today        : ecdsa prove 64s
Native (3.5x)     : ecdsa prove 18s   ← available now via @o1js/native
Native + GPU (est): ecdsa prove 3–5s  ← unlocked by pickles-rs
```

---

## Web proving — honest assessment

Replacing OCaml/JSOO with WASM in the browser gives **marginal performance gains**:

- The Pickles step→wrap proving chain is **strictly sequential** by protocol
  (the wrap circuit embeds the step verification key as constants — no
  parallelism is possible between step and wrap)
- Kimchi already runs in WASM with Rayon threading — it dominates prove time
- The OCaml overhead represents ~7% of compile time and ~30% of prove time

| Metric | WASM today | WASM after migration | Gain |
|--------|-----------|----------------------|------|
| Web bundle (web) | 7.6 MB JSOO + 5.3 MB WASM | ~5 MB WASM only | **-56%** |
| Node bundle | 22 MB JSOO + 15 MB WASM | ~15 MB WASM only | **-57%** |
| Compile time (ecdsa) | 160s | ~149s | **-7%** |
| Prove time (ecdsa) | 64s | ~44s | **-30%** |

The bundle reduction is significant for zkApp frontends. The prove time gain
comes from eliminating the OCaml runtime overhead (~30s fixed cost per proof),
not from algorithmic improvements.

---

## Technical Scope

### What already exists (no work needed)

| Component | Location | Status |
|-----------|----------|--------|
| Field arithmetic (Fp/Fq) | `proof-systems/crates/arkworks` | ✅ WASM + native |
| Pasta curves | `proof-systems/mina-curves` | ✅ |
| Poseidon hash | `proof-systems/mina-poseidon` | ✅ |
| PLONK prover/verifier | `proof-systems/kimchi` | ✅ Rayon-threaded |
| Polynomial commitments IPA/KZG | `proof-systems/poly-commitment` | ✅ |
| Merkle ledger | `zeko-rust/crates/ledger` | ✅ cdylib |
| SNARK verification | `zeko-rust/crates/snark` | ✅ |
| Native Node.js addon | `proof-systems/plonk-neon` | ✅ 3.5x vs WASM |

### What this grant funds (new work)

#### Milestone 1 — `o1js-constants-gen` (2–3 weeks)
Rust binary replacing `o1js_constants.ml`.  
Reads Poseidon MDS/round constants, hash prefixes, field primes from
`mina-poseidon` and `mina-curves`, outputs `constants.ts` identical to today's
generated file.  
**Deliverable:** `proof-systems/o1js-constants-gen/` crate + updated build script.

#### Milestone 2 — `snarky-rs` (6–8 weeks)
Circuit construction API collocated with `pickles-rs` (internal crate, not
exposed directly to TypeScript). Implements the accumulator that collects
gates during compile and witness values during prove, replacing
`snarky_backendless` + `snarky_bindings.ml`.

Implements:
- Variable allocation (`exists`, `existsOne`)
- All gate types: generic, Poseidon, EC add/scale, range check, XOR,
  foreign field add/mul, rotate, lookup
- Witness generation and constraint system collection
- Run-state management (`asProver`, `inProver`)
- Poseidon sponge

Spec: `src/bindings/ocaml/lib/snarky_bindings.mli`.  
**Deliverable:** `proof-systems/snarky-rs/` internal crate used by `pickles-rs`.

#### Milestone 3 — `pickles-rs` (12–16 weeks)
Recursive proof composition using Kimchi over the Pasta 2-cycle, replacing
OCaml `pickles`. Implements the full Pickles protocol:

- `compile(rules)` — build step + wrap proving keys from circuit rules
- `prove(public_input, witness_fn, prev_proofs)` — step proof then wrap proof
- `verify(statement, proof, vk)` — verify a Pickles proof
- Verification key encode/decode
- Dummy proof generation (for padding)
- Side-loaded verification keys

Exposes a dual API:
- **WASM** (`wasm-bindgen`) — for o1js TypeScript integration
- **Native Rust** — for Rust smart contracts, mobile, and server-side proving

**Deliverable:** `proof-systems/pickles-rs/` crate passing all o1js proof tests,
with both WASM and native targets.

#### Milestone 4 — `o1js-wasm` consolidated package (3–4 weeks)
Single WASM crate replacing both `o1js_web.bc.js` (7.6 MB) and
`o1js_node.bc.cjs` (22 MB).

- Bundles `plonk-wasm` + `snarky-rs` + `pickles-rs` + ledger wrapper
- Dual target: web (COOP/COEP headers) and Node.js (Rayon threads)
- npm-publishable, drop-in replacement for current compiled artifacts

**Deliverable:** `proof-systems/o1js-wasm/` npm package.

#### Milestone 5 — o1js integration & OCaml removal (2–3 weeks)
- Delete `src/bindings/ocaml/` and `src/mina/` submodule (~100k lines OCaml)
- Update `src/bindings/crypto/bindings.ts` to import from new WASM package
- Delete `scripts/build/jsoo/`, remove `dune`/`opam` from CI
- Full test suite green (`yarn test`)

**Deliverable:** o1js builds with zero OCaml dependency.

---

## Test Strategy

Golden test vectors generated from the current OCaml implementation via
`src/tests/pickles-dump.ts` before removal:

```
proof-counter-step-1.json   # 1-recursive proof + parent proof
proof-merge-combine.json     # 2-proof merge
constraint-system-*.json     # gate lists + verification keys
```

`pickles-rs` must produce proofs that verify against these same verification
keys. Cross-compatibility with the OCaml Pickles verifier is also tested —
a proof generated by `pickles-rs` must be accepted by the current Mina node.

---

## Success Criteria

1. `yarn build` completes with no OCaml toolchain present
2. All existing o1js tests pass (`yarn test`)
3. Web bundle < 6 MB (down from 12.9 MB today)
4. Golden proofs from `pickles-dump.ts` verify with Rust verifier
5. A proof generated by `pickles-rs` is accepted by the Mina devnet node
6. A simple Rust zkApp compiles and produces a valid proof natively

---

## Timeline

| Month | Milestone | Deliverable |
|-------|-----------|-------------|
| M1 | Milestone 1 — constants-gen | `o1js-constants-gen` crate |
| M1–M2 | Milestone 2 — snarky-rs | Internal circuit API |
| M2–M5 | Milestone 3 — pickles-rs | Recursive prover, WASM + native |
| M5 | Milestone 4 — o1js-wasm | Consolidated npm package |
| M6 | Milestone 5 — integration | OCaml fully removed |

---

## Budget

| Item | Weeks | Cost (est.) |
|------|-------|-------------|
| Milestone 1 — constants-gen | 3 | $3,000 |
| Milestone 2 — snarky-rs | 8 | $24,000 |
| Milestone 3 — pickles-rs | 16 | $64,000 |
| Milestone 4 — o1js-wasm | 4 | $12,000 |
| Milestone 5 — integration | 3 | $9,000 |
| **Total** | **~34 weeks** | **~$112,000** |

*Rates based on senior Rust/ZK engineer at $140/hr.*  
Payment: 20% upfront, 20% per completed milestone.

---

## Team

**[Your name]** — Lead engineer  
- Background: [Rust, ZK, Mina ecosystem experience]
- Prior work: [aztec-dex, zeko-rust contributions, etc.]

---

## Why this is the right time

- `proof-systems` Rust codebase is mature with wasm-pack and Rayon integration
- `zeko-rust` is blocked only on `pickles-rs` for full node functionality
- The OCaml Pickles implementation is stable — a clean, testable spec exists
- GPU proving (Icicle/CUDA) is landing across the ZK industry; native Rust
  is the prerequisite to benefit from it on Mina
- Mobile ZK is an unsolved problem across all chains — Mina can be first

---

## References

- `proof-systems`: https://github.com/o1-labs/proof-systems
- `zeko-rust`: https://github.com/zeko-labs/zeko-rust
- `o1js`: https://github.com/o1-labs/o1js
- Icicle (GPU MSM): https://github.com/ingonyama-zk/icicle
- Kimchi docs: https://o1-labs.github.io/proof-systems/
- Pickles: "Proof-Carrying Data without Succinct Arguments" (Bünz et al.)
