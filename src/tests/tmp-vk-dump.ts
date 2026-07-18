/**
 * Compile-only VK dump of the bench program on one backend.
 * BENCH_BACKEND=rust|jsoo ./run src/tests/tmp-vk-dump.ts
 * Writes /tmp/claude-1000/bench-vk-<backend>.json
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

let { verificationKey } = await Program.compile({ cache: Cache.None });
writeFileSync(
  `/tmp/claude-1000/bench-vk-${backend}.json`,
  JSON.stringify({ hash: verificationKey.hash.toString(), data: verificationKey.data })
);
console.log(`wrote /tmp/claude-1000/bench-vk-${backend}.json (hash ${verificationKey.hash.toString()})`);
