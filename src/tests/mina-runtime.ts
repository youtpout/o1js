/**
 * End-to-end smoke test for the production dependency direction:
 * o1js -> mina-rust adapter -> proof-systems.
 *
 * Run:
 * O1JS_MINA_RUNTIME_PATH=/tmp/mina_runtime_napi.node \
 *   ./run src/tests/mina-runtime.ts
 */
import { MinaRuntimeClient, type RecordedCircuit } from '../lib/mina-runtime/backend.js';
import { createMinaRuntime } from '../native/native.js';

let client = new MinaRuntimeClient(createMinaRuntime(8));
if (client.info.proofSystem !== 'proof-systems/pickle-rs') {
  throw Error(`Unexpected proof system: ${client.info.proofSystem}`);
}

let circuit: RecordedCircuit = {
  aux_count: 2,
  output: [{ terms: [['1', 1]] }],
  constraints: [
    {
      kind: 'square',
      v: { terms: [['1', 0]] },
      square: { terms: [['1', 1]] },
    },
  ],
};

let compiled = client.compileCircuit(circuit, ['6', '36'], 0);
let proved = await client.proveCircuit(compiled.circuitId, ['6', '36']);
let verified = await client.verifyProof(proved.appState, proved.proof);
if (!verified.valid) throw Error(`mina-rust rejected its proof: ${verified.reason}`);

let tampered = await client.verifyProof(['37'], proved.proof);
if (tampered.valid) throw Error('mina-rust accepted a tampered public statement');

client.dropCircuit(compiled.circuitId);
console.log('o1js -> mina-rust -> proof-systems: compile/prove/verify OK');
