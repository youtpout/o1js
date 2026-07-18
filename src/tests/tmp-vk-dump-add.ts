/**
 * Compile-only VK dump of the reference 3-branch add program (the aligned one).
 * BENCH_BACKEND=rust|jsoo ./run src/tests/tmp-vk-dump-add.ts
 * Writes /tmp/claude-1000/addprog-vk-<backend>.json
 */
import { writeFileSync } from 'node:fs';
import { Cache, Field, SelfProof, ZkProgram, setBackend, setProofSystemBackend } from '../index.js';

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
writeFileSync(
  `/tmp/claude-1000/addprog-vk-${backend}.json`,
  JSON.stringify({ hash: verificationKey.hash.toString(), data: verificationKey.data })
);
console.log(`wrote /tmp/claude-1000/addprog-vk-${backend}.json (hash ${verificationKey.hash.toString()})`);
