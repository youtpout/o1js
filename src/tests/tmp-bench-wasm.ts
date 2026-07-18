/**
 * Same benchmark as tmp-bench-native.ts but parameterized over the transport:
 * BENCH_BACKEND=rust-wasm   -> wasm backend + rust proof system
 * BENCH_BACKEND=rust-native -> native addon + rust proof system
 * BENCH_BACKEND=jsoo        -> default pipeline (wasm crypto + jsoo pickles)
 *
 * Run: BENCH_BACKEND=rust-wasm ./run src/tests/tmp-bench-wasm.ts
 */
import {
  Cache,
  Field,
  SelfProof,
  ZkProgram,
  setBackend,
  setProofSystemBackend,
  verify,
} from '../index.js';

const backend = process.env.BENCH_BACKEND ?? 'rust-wasm';
if (backend === 'rust-wasm') {
  setBackend('wasm');
  setProofSystemBackend('rust');
} else if (backend === 'rust-native') {
  setBackend('native');
  setProofSystemBackend('rust');
} else if (backend !== 'jsoo') {
  throw Error(`unknown BENCH_BACKEND '${backend}'`);
}

const Program = ZkProgram({
  name: 'BenchNativeProgram',
  publicInput: Field,
  publicOutput: Field,
  methods: {
    init: {
      privateInputs: [Field],
      async method(publicInput: Field, value: Field) {
        publicInput.assertEquals(0);
        return { publicOutput: value };
      },
    },
    update: {
      privateInputs: [SelfProof, Field],
      async method(publicInput: Field, prev: SelfProof<Field, Field>, delta: Field) {
        prev.verify();
        prev.publicOutput.add(delta).assertEquals(publicInput);
        return { publicOutput: publicInput };
      },
    },
    merge: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        publicInput: Field,
        first: SelfProof<Field, Field>,
        second: SelfProof<Field, Field>
      ) {
        first.verify();
        second.verify();
        first.publicOutput.add(second.publicOutput).assertEquals(publicInput);
        return { publicOutput: publicInput };
      },
    },
  },
});

function ms(t: number) {
  return `${(t / 1000).toFixed(3)}s`;
}

console.log(`== bench backend=${backend} ==`);

const cacheOpt =
  process.env.BENCH_CACHE === 'default' ? {} : { cache: Cache.None };
let t = performance.now();
let { verificationKey } = await Program.compile(cacheOpt);
let tCompile = performance.now() - t;
console.log(`compile (3 methods, no cache): ${ms(tCompile)}`);

if (process.env.BENCH_SKIP_PROVE === '1') {
  console.log(`VK hash: ${verificationKey.hash.toString()}`);
  process.exit(0);
}

t = performance.now();
let { proof: p0 } = await Program.init(Field(0), Field(3));
let tInit = performance.now() - t;
console.log(`prove init  (N0): ${ms(tInit)}`);

t = performance.now();
let { proof: p1 } = await Program.update(Field(8), p0, Field(5));
let tUpdate = performance.now() - t;
console.log(`prove update (N1): ${ms(tUpdate)}`);

t = performance.now();
let { proof: p0b } = await Program.init(Field(0), Field(2));
let tInit2 = performance.now() - t;

t = performance.now();
let { proof: p2 } = await Program.merge(Field(5), p0, p0b);
let tMerge = performance.now() - t;
console.log(`prove merge  (N2, base+base): ${ms(tMerge)}  (2nd init: ${ms(tInit2)})`);

t = performance.now();
let ok = await verify(p2.toJSON(), verificationKey);
let tVerify = performance.now() - t;
console.log(`verify merge proof: ${ms(tVerify)}  ->`, ok);
t = performance.now();
let okN1 = await verify(p1.toJSON(), verificationKey);
console.log(`verify update proof: ${ms(performance.now() - t)}  ->`, okN1);
t = performance.now();
let okN0 = await verify(p0.toJSON(), verificationKey);
console.log(`verify init proof: ${ms(performance.now() - t)}  ->`, okN0);

console.log(
  `TOTAL compile+3 proofs+verify: ${ms(tCompile + tInit + tUpdate + tInit2 + tMerge + tVerify)}`
);
console.log(`VK hash: ${verificationKey.hash.toString()}`);
process.exit(0);
