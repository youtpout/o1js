/**
 * Gate-level parity diff between the OCaml (jsoo) Pickles *wrap* circuit and
 * the Rust Pickles wrap circuit of the same recorded o1js method.
 *
 * The OCaml circuit is captured by intercepting the wrap proving key during
 * compile, decoding it into a wasm Fq prover index and dumping its gates via
 * `fq_prover_to_json`. The Rust circuit comes from
 * `rust_pickles_recorded_wrap_circuit_json` (a full two-pass base-case
 * compile) in the same JSON schema.
 *
 * Run: ./run src/tests/rust-pickles-wrap-gates-diff.ts
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
  name: 'RustPicklesWrapGates',
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

// -- capture the OCaml wrap circuit through the compile cache -------------

let wrapPkBytes: Uint8Array | undefined;
let interceptCache = {
  canWrite: true,
  read(_header: CacheHeader): Uint8Array | undefined {
    return undefined;
  },
  write(header: CacheHeader, value: Uint8Array): void {
    if (header.kind === 'wrap-pk') wrapPkBytes = value.slice();
  },
};

console.log('compiling via jsoo Pickles (capturing the wrap proving key)...');
await Program.compile({ cache: interceptCache as any, forceRecompile: true });
if (!wrapPkBytes) throw Error('wrap proving key was not written to the cache');
let fqDump = (wasm as any).fq_prover_to_json as
  | ((index: unknown) => string)
  | undefined;
if (!fqDump) throw Error('bundled kimchi wasm does not expose fq_prover_to_json — rebuild it');
let wrapIndex = wasm.caml_pasta_fq_plonk_index_decode(wrapPkBytes, Pickles.loadSrsFq());
let jsooCircuit: CircuitJson = JSON.parse(fqDump(wrapIndex));

// -- dump the Rust wrap circuit for the same recorded method --------------

console.log('recording the method and dumping the Rust wrap circuit (two-pass)...');
let { circuit, witness } = await recordCircuit(async () => circuitMain());
let { default: native } = await import('../native/native.js');
let dump = (native as any)?.rust_pickles_recorded_wrap_circuit_json as
  | ((circuit: string, witness: string[]) => string)
  | undefined;
if (!dump) throw Error('@o1js/native does not expose rust_pickles_recorded_wrap_circuit_json');
let rustCircuit: CircuitJson = JSON.parse(dump(JSON.stringify(circuit), witness));

// -- report ---------------------------------------------------------------

writeFileSync('/tmp/claude-1000/wrap-circuit-jsoo.json', JSON.stringify(jsooCircuit, null, 1));
writeFileSync('/tmp/claude-1000/wrap-circuit-rust.json', JSON.stringify(rustCircuit, null, 1));
console.log('\n=== wrap circuit parity (jsoo vs rust) ===');
console.log(`  public_input_size: jsoo=${jsooCircuit.public_input_size} rust=${rustCircuit.public_input_size}`);
console.log(`  gates: jsoo=${jsooCircuit.gates.length} rust=${rustCircuit.gates.length}`);

function gateHistogram(gates: CircuitJson['gates']) {
  let hist: Record<string, number> = {};
  for (let g of gates) hist[g.typ] = (hist[g.typ] ?? 0) + 1;
  return hist;
}
console.log('  histogram jsoo:', JSON.stringify(gateHistogram(jsooCircuit.gates)));
console.log('  histogram rust:', JSON.stringify(gateHistogram(rustCircuit.gates)));

let n = Math.min(jsooCircuit.gates.length, rustCircuit.gates.length);
let diffs: number[] = [];
let typeDiffs: number[] = [];
let wiringDiffs: number[] = [];
let coeffDiffs: number[] = [];
for (let i = 0; i < n; i++) {
  let j = jsooCircuit.gates[i];
  let r = rustCircuit.gates[i];
  if (JSON.stringify(j) !== JSON.stringify(r)) {
    diffs.push(i);
    if (j.typ !== r.typ) typeDiffs.push(i);
    else if (JSON.stringify(j.coeffs) !== JSON.stringify(r.coeffs)) coeffDiffs.push(i);
    else if (JSON.stringify(j.wires) !== JSON.stringify(r.wires)) wiringDiffs.push(i);
  }
}
if (diffs.length === 0 && jsooCircuit.gates.length === rustCircuit.gates.length) {
  console.log('\nWRAP GATES: FULL MATCH');
} else {
  console.log(`\n  divergent rows: ${diffs.length} (first: ${diffs[0]})`);
  console.log(
    `  by class: type=${typeDiffs.length} coeffs=${coeffDiffs.length} wiring=${wiringDiffs.length}`
  );
  printSegments('type', typeDiffs);
  printSegments('coeffs', coeffDiffs);
  printSegments('wiring', wiringDiffs);
  if (diffs.length > 0) {
    let i = diffs[0];
    console.log('  jsoo:', JSON.stringify(jsooCircuit.gates[i]).slice(0, 400));
    console.log('  rust:', JSON.stringify(rustCircuit.gates[i]).slice(0, 400));
  }
  console.log('\nfull dumps: /tmp/claude-1000/wrap-circuit-{jsoo,rust}.json');
}

function printSegments(label: string, rows: number[]) {
  if (rows.length === 0) return;
  let segments: string[] = [];
  let start = rows[0], prev = rows[0];
  for (let i = 1; i < rows.length; i++) {
    let row = rows[i];
    if (row === prev + 1) {
      prev = row;
      continue;
    }
    segments.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = row;
  }
  segments.push(start === prev ? `${start}` : `${start}-${prev}`);
  console.log(`  ${label} segments: ${segments.slice(0, 40).join(', ')}${segments.length > 40 ? ', ...' : ''}`);
}
