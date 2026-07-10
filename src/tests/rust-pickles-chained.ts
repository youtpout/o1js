/**
 * Smoke test: chained recursive proving through the experimental direct Rust
 * Pickles path — a ZkProgram method's proof is kept alive and recursively
 * verified by a *different* method's proof (the SelfProof shape).
 *
 * Run: ./run src/tests/rust-pickles-chained.ts
 */
import { Field, Poseidon, Provable, ZkProgram } from '../index.js';

const Program = ZkProgram({
  name: 'RustPicklesChainedSmoke',
  publicOutput: Field,
  methods: {
    square: {
      privateInputs: [],
      async method() {
        let x = Provable.witness(Field, () => Field(5));
        let out = x.mul(x);
        out.assertEquals(Field(25));
        return { publicOutput: out };
      },
    },
    hashStep: {
      privateInputs: [],
      async method() {
        let x = Provable.witness(Field, () => Field(7));
        let out = Poseidon.hash([x, x.add(1)]);
        return { publicOutput: out };
      },
    },
  },
});

console.log('proving base case (square), keeping the proof for chaining...');
let t0 = Date.now();
let base = await Program.experimentalRustPickles.proveBaseCaseKeep('square');
console.log(`base proof in ${Date.now() - t0}ms, appState =`, base.appState);
if (base.appState[0] !== '25') throw Error('wrong base app state');
if (!(await Program.experimentalRustPickles.verifyBaseCase(base))) {
  throw Error('base proof verification failed');
}

console.log('proving chained N1 (hashStep verifies the square proof)...');
t0 = Date.now();
let chained = await Program.experimentalRustPickles.proveN1Over(base, 'hashStep');
console.log(`chained N1 proof in ${Date.now() - t0}ms, appState =`, chained.appState);
if (chained.appState[0] === base.appState[0]) {
  throw Error('chained proof should bind the new app state, not the base one');
}
if (!(await Program.experimentalRustPickles.verifyN1(chained))) {
  throw Error('chained N1 proof verification failed');
}

// tampering with the app state must be rejected
let tampered = { ...chained, appState: ['42'] };
if (await Program.experimentalRustPickles.verifyN1(tampered)) {
  throw Error('tampered app state was accepted');
}
console.log('OK');
