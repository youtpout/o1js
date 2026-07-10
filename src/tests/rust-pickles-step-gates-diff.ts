/**
 * Gate-level parity diff between the OCaml (jsoo) Pickles *step* circuit and
 * the Rust Pickles step circuit hosting the same recorded o1js method.
 *
 * The OCaml circuit is captured by compiling with a cache that intercepts the
 * step proving key, decoding it back into a wasm prover index and dumping its
 * gates via `prover_to_json`. The Rust circuit is dumped by
 * `rust_pickles_recorded_step_circuit_json` in the same JSON schema.
 *
 * Run: ./run src/tests/rust-pickles-step-gates-diff.ts
 */
import { Field, Provable, ZkProgram, type CacheHeader } from '../index.js';
import { Pickles, wasm } from '../bindings.js';
import { recordCircuit } from '../lib/proof-system/rust-pickles-recorded.js';
import { writeFileSync } from 'node:fs';

function circuitMain() {
  let x = Provable.witness(Field, () => Field(3));
  let out = x.mul(x);
  out.assertEquals(x.square());
  return [out];
}

const Program = ZkProgram({
  name: 'RustPicklesStepGates',
  publicOutput: Field,
  methods: {
    compute: {
      privateInputs: [],
      async method() {
        let [out] = circuitMain();
        return { publicOutput: out };
      },
    },
  },
});

type CircuitJson = {
  public_input_size: number;
  gates: { typ: string; wires: unknown; coeffs: string[] }[];
};

// -- capture the OCaml step circuit through the compile cache ------------

let stepPkBytes: Uint8Array | undefined;
let interceptCache = {
  canWrite: true,
  read(_header: CacheHeader): Uint8Array | undefined {
    return undefined; // force generation
  },
  write(header: CacheHeader, value: Uint8Array): void {
    if (header.kind === 'step-pk') stepPkBytes = value.slice();
  },
};

console.log('compiling via jsoo Pickles (capturing the step proving key)...');
await Program.compile({ cache: interceptCache as any, forceRecompile: true });
if (!stepPkBytes) throw Error('step proving key was not written to the cache');
let stepIndex = wasm.caml_pasta_fp_plonk_index_decode(stepPkBytes, Pickles.loadSrsFp());
let jsooCircuit: CircuitJson = JSON.parse(wasm.prover_to_json(stepIndex));

// -- dump the Rust step circuit for the same recorded method -------------

console.log('recording the method and dumping the Rust step circuit...');
let { circuit } = await recordCircuit(async () => circuitMain());
let { default: native } = await import('../native/native.js');
let dump = (native as any)?.rust_pickles_recorded_step_circuit_json as
  | ((circuit: string) => string)
  | undefined;
if (!dump) throw Error('@o1js/native does not expose rust_pickles_recorded_step_circuit_json');
let rustCircuit: CircuitJson = JSON.parse(dump(JSON.stringify(circuit)));

// -- report ---------------------------------------------------------------

writeFileSync('/tmp/claude-1000/step-circuit-jsoo.json', JSON.stringify(jsooCircuit, null, 1));
writeFileSync('/tmp/claude-1000/step-circuit-rust.json', JSON.stringify(rustCircuit, null, 1));
console.log('\n=== step circuit parity (jsoo vs rust) ===');
console.log(`  public_input_size: jsoo=${jsooCircuit.public_input_size} rust=${rustCircuit.public_input_size}`);
console.log(`  gates: jsoo=${jsooCircuit.gates.length} rust=${rustCircuit.gates.length}`);

function gateHistogram(gates: CircuitJson['gates']) {
  let hist: Record<string, number> = {};
  for (let g of gates) hist[g.typ] = (hist[g.typ] ?? 0) + 1;
  return hist;
}
console.log('  gate histogram jsoo:', gateHistogram(jsooCircuit.gates));
console.log('  gate histogram rust:', gateHistogram(rustCircuit.gates));

let n = Math.min(jsooCircuit.gates.length, rustCircuit.gates.length);
let firstDiff = -1;
for (let i = 0; i < n; i++) {
  if (JSON.stringify(jsooCircuit.gates[i]) !== JSON.stringify(rustCircuit.gates[i])) {
    firstDiff = i;
    break;
  }
}
if (firstDiff === -1 && jsooCircuit.gates.length === rustCircuit.gates.length) {
  console.log('\nSTEP GATES: FULL MATCH');
} else {
  console.log(`\n  first divergent row: ${firstDiff}`);
  if (firstDiff >= 0) {
    console.log('  jsoo:', JSON.stringify(jsooCircuit.gates[firstDiff]));
    console.log('  rust:', JSON.stringify(rustCircuit.gates[firstDiff]));
  }
  console.log('\nfull dumps: /tmp/claude-1000/step-circuit-{jsoo,rust}.json');
}
