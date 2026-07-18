/**
 * Cross-backend proof verification for the reference add program.
 *
 * PHASE=prove  BENCH_BACKEND=rust|jsoo  -> compile + prove init/update, dump
 *   /tmp/claude-1000/cross-proof-<backend>.json
 * PHASE=verify BENCH_BACKEND=rust|jsoo PROOF_FILE=<path> -> verify that proof
 *   JSON against this backend's freshly compiled VK.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  Cache,
  Field,
  SelfProof,
  ZkProgram,
  setBackend,
  setProofSystemBackend,
  verify,
} from '../index.js';

const backend = process.env.BENCH_BACKEND ?? 'rust';
if (backend === 'rust') {
  setBackend('native');
  setProofSystemBackend('rust');
} else if (backend !== 'jsoo') {
  throw Error(`unknown BENCH_BACKEND '${backend}'`);
}

const AddProgram = ZkProgram({
  name: 'add-program',
  publicInput: Field,
  publicOutput: Field,
  methods: {
    init: {
      privateInputs: [],
      async method(initialState: Field) {
        return { publicOutput: initialState };
      },
    },
    update: {
      privateInputs: [SelfProof],
      async method(initialState: Field, previousProof: SelfProof<Field, Field>) {
        previousProof.verify();
        initialState.assertEquals(previousProof.publicInput);
        return { publicOutput: previousProof.publicOutput.add(1) };
      },
    },
    merge: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        initialState: Field,
        first: SelfProof<Field, Field>,
        second: SelfProof<Field, Field>
      ) {
        first.verify();
        second.verify();
        initialState.assertEquals(first.publicInput);
        initialState.assertEquals(second.publicInput);
        return { publicOutput: first.publicOutput.add(second.publicOutput) };
      },
    },
  },
});

let { verificationKey } = await AddProgram.compile({ cache: Cache.None });
console.log(`[${backend}] VK hash: ${verificationKey.hash.toString()}`);

const phase = process.env.PHASE ?? 'prove';
if (phase === 'prove') {
  let { proof: p0 } = await AddProgram.init(Field(5));
  let { proof: p1 } = await AddProgram.update(Field(5), p0);
  writeFileSync(`/tmp/claude-1000/cross-proof-${backend}.json`, JSON.stringify(p1.toJSON()));
  console.log(`[${backend}] wrote update proof -> cross-proof-${backend}.json`);
  console.log(`[${backend}] self-verify:`, await verify(p1.toJSON(), verificationKey));
} else {
  const file = process.env.PROOF_FILE!;
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const ok = await verify(json, verificationKey);
  console.log(`[${backend}] verify(${file}):`, ok);
  if (!ok) process.exit(1);
}
