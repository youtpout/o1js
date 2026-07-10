/**
 * Smoke test: record an o1js range-check circuit into the Rust Pickles
 * RecordedCircuit envelope.
 *
 * Note: proving range-check circuits still needs optional-gate plumbing in the
 * Rust wrap verifier; this test intentionally validates the recorder boundary.
 *
 * Run: ./run src/tests/rust-pickles-recorded-range-check.ts
 */
import { Field, Gadgets, Provable } from '../index.js';
import { recordCircuit } from '../lib/proof-system/rust-pickles-recorded.js';

function circuit() {
  let x = Provable.witness(Field, () => Field((1n << 63n) + 17n));
  Gadgets.rangeCheck64(x);
  return [x];
}

console.log('recording range-check circuit...');
let t0 = Date.now();
let { circuit: recorded, witness } = await recordCircuit(circuit);
console.log(`range-check circuit recorded in ${Date.now() - t0}ms`, {
  auxCount: recorded.aux_count,
  constraints: recorded.constraints.map((constraint) => constraint.kind),
  witness,
});
if (!recorded.constraints.some((constraint) => constraint.kind === 'range_check0')) {
  throw Error('range_check0 was not recorded');
}
console.log('OK');
