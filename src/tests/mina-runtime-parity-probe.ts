/** One side of the native jsoo/mina-runtime release-gate comparison. */
import { Cache, Field, ZkProgram, getProofSystemBackend, setBackend, verify } from '../index.js';

let transport = process.env.O1JS_BACKEND === 'wasm' ? 'wasm' : 'native';
setBackend(transport);
let backend = getProofSystemBackend();

const Program = ZkProgram({
  name: 'MinaRuntimeParityProbe',
  publicInput: Field,
  publicOutput: Field,
  methods: {
    multiply: {
      privateInputs: [Field],
      async method(publicInput: Field, privateInput: Field) {
        return { publicOutput: publicInput.mul(privateInput) };
      },
    },
  },
});

let memoryBefore = process.memoryUsage();
console.log(`[mina-runtime parity:${backend}] compile`);
let started = performance.now();
let { verificationKey } = await Program.compile({ cache: Cache.None });
let compileMs = performance.now() - started;

console.log(`[mina-runtime parity:${backend}] prove`);
started = performance.now();
let { proof } = await Program.multiply(Field(4), Field(5));
let proveMs = performance.now() - started;

console.log(`[mina-runtime parity:${backend}] verify`);
started = performance.now();
let valid = await Program.verify(proof);
let verifyMs = performance.now() - started;

let json = proof.toJSON();
let restored = await Program.Proof.fromJSON(json);
let roundTrip = await Program.verify(restored);
let globalVerify = await verify(json, verificationKey);
let tampered = await Program.Proof.fromJSON({ ...json, publicOutput: ['21'] });
let rejectsTamper = !(await Program.verify(tampered));
let analysis = (await Program.analyzeMethods()).multiply;

Program.dispose();
let memoryAfter = process.memoryUsage();

let gateHistogram: Record<string, number> = {};
for (let gate of analysis.gates) {
  gateHistogram[gate.type] = (gateHistogram[gate.type] ?? 0) + 1;
}

console.log(
  'MINA_RUNTIME_PARITY=' +
    JSON.stringify({
      backend,
      transport,
      valid,
      roundTrip,
      globalVerify,
      rejectsTamper,
      compileMs,
      proveMs,
      verifyMs,
      memory: {
        heapUsedBefore: memoryBefore.heapUsed,
        heapUsedAfterDispose: memoryAfter.heapUsed,
        rssBefore: memoryBefore.rss,
        rssAfterDispose: memoryAfter.rss,
      },
      method: {
        digest: analysis.digest,
        rows: analysis.rows,
        gateHistogram,
      },
      verificationKey: {
        hash: verificationKey.hash.toString(),
        bytes: verificationKey.data.length,
        format: verificationKey.data.startsWith('mina-runtime-v1:')
          ? 'mina-runtime-v1'
          : 'mina-pickles-base64',
      },
      proof: {
        bytes: json.proof.length,
        maxProofsVerified: json.maxProofsVerified,
        format: json.proof.startsWith('mina-runtime-pickles-v1:')
          ? 'mina-runtime-pickles-v1'
          : 'mina-pickles-base64',
      },
    })
);
