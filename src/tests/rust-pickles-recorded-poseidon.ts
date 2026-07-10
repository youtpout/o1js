/**
 * Smoke test: record a real o1js Poseidon circuit and prove it through the
 * Rust Pickles backend, then verify standalone.
 *
 * Run: ./run src/tests/rust-pickles-recorded-poseidon.ts
 */
import { Field, Poseidon, Provable } from '../index.js';
import {
  proveRecordedBaseCase,
  verifyRecordedBaseCase,
} from '../lib/proof-system/rust-pickles-recorded.js';

function circuit() {
  let x = Provable.witness(Field, () => Field(3));
  let y = Provable.witness(Field, () => Field(5));
  let hash = Poseidon.hash([x, y]);
  hash.assertEquals(Poseidon.hash([Field(3), Field(5)]));
  return [hash];
}

console.log('recording + proving Poseidon base case...');
let t0 = Date.now();
let proof = await proveRecordedBaseCase(circuit);
console.log(`poseidon base proof in ${Date.now() - t0}ms, appState =`, proof.appState);
if (!(await verifyRecordedBaseCase(proof))) throw Error('Poseidon proof verification failed');
console.log('OK');
