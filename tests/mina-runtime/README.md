# mina-runtime parity and release gate

The release gate runs the same deterministic N0 ZkProgram in isolated Node
processes with the jsoo and mina-runtime proof-system implementations. The jsoo
reference uses the WASM transport built from the unmodified Mina submodule;
mina-runtime uses its native N-API transport and the local Rust proof system.
Keeping those dependency graphs separate prevents an experimental Kimchi build
from being loaded underneath the reference OCaml circuit.

The report records correctness, public-input/output tamper rejection,
serialization round trips, circuit shape, verification-key metadata, timing, and
process memory. Performance numbers are diagnostic only while the transports
differ; functional and circuit-shape checks are release criteria.

Generate a report without failing on known migration blockers:

```text
O1JS_MINA_RUNTIME_PATH=/absolute/path/to/mina_runtime_napi.node \
  npm run mina-runtime:parity
```

Enforce every release criterion (non-zero until all blockers are resolved):

```text
O1JS_MINA_RUNTIME_PATH=/absolute/path/to/mina_runtime_napi.node \
  npm run mina-runtime:release-gate
```

Reports are written to `tests/mina-runtime/reports/` and ignored by Git. CI
uploads them as artifacts. A repository variable named
`MINA_RUNTIME_ENFORCE=true` activates the blocking CI job once the matrix is
fully green.
