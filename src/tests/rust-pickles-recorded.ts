/**
 * Smoke test: record a real o1js circuit (Field ops) and prove it through
 * the Rust Pickles backend, then verify standalone.
 *
 * Run: ./run src/tests/rust-pickles-recorded.ts
 */
import { Field, Provable } from '../index.js';
import {
  proveRecordedBaseCase,
  proveRecordedN,
  proveRecordedN1,
  verifyRecordedBaseCase,
  verifyRecordedN1,
} from '../lib/proof-system/rust-pickles-recorded.js';

// x is a secret; the app state is x^4 + 7 (mul, square and constant arithmetic)
function circuit() {
  let x = Provable.witness(Field, () => Field(3));
  let x2 = x.mul(x);
  x2.assertEquals(x.square());
  let x4 = x2.square();
  let out = x4.add(7);
  out.assertEquals(Field(88));
  return [out];
}

console.log('recording + proving base case...');
let t0 = Date.now();
let base = await proveRecordedBaseCase(circuit);
console.log(`base proof in ${Date.now() - t0}ms, appState =`, base.appState);
if (base.appState[0] !== '88') throw Error('wrong app state');
console.log('standalone verify:', await verifyRecordedBaseCase(base));
if (!(await verifyRecordedBaseCase(base))) throw Error('verification failed');

console.log('recording + proving N1 cycle...');
t0 = Date.now();
let n1 = await proveRecordedN1(circuit);
console.log(`n1 proof in ${Date.now() - t0}ms, appState =`, n1.appState);
console.log('standalone verify (n1):', await verifyRecordedN1(n1));
if (!(await verifyRecordedN1(n1))) throw Error('n1 verification failed');

console.log('recording + proving N2 stable cycle...');
t0 = Date.now();
let n2 = await proveRecordedN(circuit, 2);
console.log(`n2 proof in ${Date.now() - t0}ms, appState =`, n2.appState);
console.log('standalone verify (n2):', await verifyRecordedN1(n2));
if (!(await verifyRecordedN1(n2))) throw Error('n2 verification failed');
console.log('OK');
