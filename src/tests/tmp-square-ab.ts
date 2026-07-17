import { Cache, Field, Provable, ZkProgram, setBackend, setProofSystemBackend } from '../index.js';
const backend = process.env.BENCH_BACKEND ?? 'jsoo';
if (backend === 'rust') { setBackend('native'); setProofSystemBackend('rust'); }
const WithArg = ZkProgram({
  name: 'square-program',
  publicOutput: Field,
  methods: { compute: { privateInputs: [Field], async method(x: Field) {
    return { publicOutput: x.mul(x) }; } } },
});
const NoArg = ZkProgram({
  name: 'square-program',
  publicOutput: Field,
  methods: { compute: { privateInputs: [], async method() {
    let x = Provable.witness(Field, () => Field(3));
    return { publicOutput: x.mul(x) }; } } },
});
let a = await WithArg.compile({ cache: Cache.None });
console.log(`${backend} WITH-arg  VK_HASH=` + a.verificationKey.hash.toString());
let b = await NoArg.compile({ cache: Cache.None });
console.log(`${backend} NO-arg    VK_HASH=` + b.verificationKey.hash.toString());
