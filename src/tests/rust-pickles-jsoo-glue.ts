/**
 * Isolates the OCaml Pickles step-circuit "glue" from the application rows:
 * dumps the jsoo step circuits of two programs whose methods differ in a
 * recognizable way and aligns them.
 *
 * Run: ./run src/tests/rust-pickles-jsoo-glue.ts
 */
import { Field, Provable, ZkProgram, type CacheHeader } from '../index.js';
import { Pickles, wasm } from '../bindings.js';
import { writeFileSync } from 'node:fs';

function makeProgram(name: string, muls: number) {
  return ZkProgram({
    name,
    publicOutput: Field,
    methods: {
      compute: {
        privateInputs: [],
        async method() {
          let x = Provable.witness(Field, () => Field(3));
          let out = x;
          for (let i = 0; i < muls; i++) out = out.mul(x);
          return { publicOutput: out };
        },
      },
    },
  });
}

async function dumpStepCircuit(program: { compile(opts?: any): Promise<any> }) {
  let stepPkBytes: Uint8Array | undefined;
  let cache = {
    canWrite: true,
    read: (_h: CacheHeader) => undefined,
    write(header: CacheHeader, value: Uint8Array) {
      if (header.kind === 'step-pk') stepPkBytes = value.slice();
    },
  };
  await program.compile({ cache: cache as any, forceRecompile: true });
  if (!stepPkBytes) throw Error('step proving key not captured');
  let index = wasm.caml_pasta_fp_plonk_index_decode(stepPkBytes, Pickles.loadSrsFp());
  return JSON.parse(wasm.prover_to_json(index)) as {
    public_input_size: number;
    gates: { typ: string; coeffs: string[] }[];
  };
}

let small = await dumpStepCircuit(makeProgram('GlueSmall', 1));
let big = await dumpStepCircuit(makeProgram('GlueBig', 24));
writeFileSync('/tmp/claude-1000/step-glue-small.json', JSON.stringify(small, null, 1));
writeFileSync('/tmp/claude-1000/step-glue-big.json', JSON.stringify(big, null, 1));

console.log(`small: ${small.gates.length} gates, big: ${big.gates.length} gates`);
// find the first row where they diverge and the first row after which they
// re-align (the app block boundary)
let n = Math.min(small.gates.length, big.gates.length);
let first = -1;
for (let i = 0; i < n; i++) {
  if (JSON.stringify(small.gates[i]) !== JSON.stringify(big.gates[i])) {
    first = i;
    break;
  }
}
console.log(`first divergent row: ${first}`);
// align from the end
let last = -1;
for (let i = 0; i < n; i++) {
  let a = small.gates[small.gates.length - 1 - i];
  let b = big.gates[big.gates.length - 1 - i];
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    last = i;
    break;
  }
}
console.log(`rows identical from the end: ${last}`);
console.log(
  `=> app block: rows ${first}..${small.gates.length - last - 1} (small) / ${first}..${big.gates.length - last - 1} (big)`
);
