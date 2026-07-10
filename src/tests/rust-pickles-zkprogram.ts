/**
 * Smoke test: prove a ZkProgram method through the experimental direct Rust
 * Pickles path.
 *
 * Run: ./run src/tests/rust-pickles-zkprogram.ts
 */
import { Field, Provable, ZkProgram } from '../index.js';

const Program = ZkProgram({
  name: 'RustPicklesZkProgramSmoke',
  publicOutput: Field,
  methods: {
    compute: {
      privateInputs: [],
      method() {
        let x = Provable.witness(Field, () => Field(3));
        let x2 = x.mul(x);
        x2.assertEquals(x.square());
        let out = x2.square().add(7);
        out.assertEquals(Field(88));
        return { publicOutput: out };
      },
    },
  },
});

console.log('proving ZkProgram.compute via experimental Rust Pickles...');
let t0 = Date.now();
let proof = await Program.experimentalRustPickles.proveBaseCase('compute');
console.log(`zkprogram rust proof in ${Date.now() - t0}ms, appState =`, proof.appState);
if (proof.appState[0] !== '88') throw Error('wrong app state');
if (!(await Program.experimentalRustPickles.verifyBaseCase(proof))) {
  throw Error('ZkProgram Rust Pickles proof verification failed');
}
console.log('OK');
