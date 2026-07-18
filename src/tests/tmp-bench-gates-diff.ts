/**
 * Multi-branch gate-level parity diff between the OCaml (jsoo) Pickles
 * circuits of a recursive ZkProgram (the zkapp-rust Add shape: init pv0,
 * update pv1, merge pv2) and the Rust shared-wrap program circuits.
 *
 * Two passes (the proof-system backend locks at first compile):
 *   MODE=jsoo  ./run src/tests/rust-pickles-program-gates-diff.ts
 *     compiles through jsoo, captures the per-method step proving keys and
 *     the shared wrap key through the cache, dumps them as JSON.
 *   MODE=rust  ./run src/tests/rust-pickles-program-gates-diff.ts
 *     compiles through the rust backend with O1JS_DUMP_PROGRAM_BRANCHES,
 *     dumps the RecordedCompiledProgram circuits via napi, diffs both dumps.
 */
import { Field, SelfProof, ZkProgram, type CacheHeader } from '../index.js';
import { Pickles, wasm } from '../bindings.js';
import { writeFileSync, readFileSync } from 'node:fs';

const DUMP_DIR = '/tmp/claude-1000';
const JSOO_DUMP = `${DUMP_DIR}/bench-gates-jsoo.json`;
const BRANCHES_DUMP = `${DUMP_DIR}/bench-branches.json`;

const AddProgram = ZkProgram({
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

type CircuitJson = {
  public_input_size: number;
  gates: { typ: string; wires: unknown; coeffs: string[] }[];
};

const mode = process.env.MODE ?? 'rust';

if (mode === 'jsoo') {
  // -- capture the OCaml circuits through the compile cache ---------------
  let stepPks = new Map<string, Uint8Array>();
  let wrapPkBytes: Uint8Array | undefined;
  let interceptCache = {
    canWrite: true,
    read(_header: CacheHeader): Uint8Array | undefined {
      return undefined; // force generation
    },
    write(header: CacheHeader, value: Uint8Array): void {
      if (header.kind === 'step-pk') {
        stepPks.set((header as any).methodName ?? String(stepPks.size), value.slice());
      }
      if (header.kind === 'wrap-pk') wrapPkBytes = value.slice();
    },
  };

  console.log('compiling the Bench program via jsoo Pickles (capturing pks)...');
  await AddProgram.compile({ cache: interceptCache as any, forceRecompile: true });
  if (stepPks.size === 0 || !wrapPkBytes) {
    throw Error(`captured ${stepPks.size} step pks, wrap=${wrapPkBytes !== undefined}`);
  }
  console.log(`captured step pks: ${[...stepPks.keys()].join(', ')}`);

  let steps: Record<string, CircuitJson> = {};
  for (let [method, bytes] of stepPks) {
    let index = wasm.caml_pasta_fp_plonk_index_decode(bytes, Pickles.loadSrsFp());
    steps[method] = JSON.parse(wasm.prover_to_json(index));
  }
  let wrapIndex = wasm.caml_pasta_fq_plonk_index_decode(wrapPkBytes, Pickles.loadSrsFq());
  let wrap: CircuitJson = JSON.parse(wasm.fq_prover_to_json(wrapIndex));

  writeFileSync(JSOO_DUMP, JSON.stringify({ steps, wrap }));
  console.log(`jsoo circuits dumped to ${JSOO_DUMP}`);
  for (let [m, c] of Object.entries(steps)) {
    console.log(`  step ${m}: ${c.gates.length} gates, pi=${c.public_input_size}`);
  }
  console.log(`  wrap: ${wrap.gates.length} gates, pi=${wrap.public_input_size}`);
} else {
  // -- rust pass: record branches via the real compile, dump, diff --------
  let { setProofSystemBackend } = await import('../lib/backend.js');
  setProofSystemBackend('rust');
  process.env.O1JS_DUMP_PROGRAM_BRANCHES = BRANCHES_DUMP;
  console.log('compiling the Bench program via the rust backend (dumping branches)...');
  await AddProgram.compile({ forceRecompile: true });

  let branchesJson = readFileSync(BRANCHES_DUMP, 'utf8');
  let { default: native } = await import('../native/native.js');
  let dump = (native as any)?.rust_pickles_recorded_program_circuits_json as
    | ((branches: string) => string)
    | undefined;
  if (!dump) {
    throw Error('@o1js/native does not expose rust_pickles_recorded_program_circuits_json');
  }
  console.log('compiling + dumping the Rust program circuits...');
  let rustProgram: { steps: CircuitJson[]; wrap: CircuitJson } = JSON.parse(dump(branchesJson));
  writeFileSync(`${DUMP_DIR}/bench-gates-rust.json`, JSON.stringify(rustProgram));

  let jsoo: { steps: Record<string, CircuitJson>; wrap: CircuitJson } = JSON.parse(
    readFileSync(JSOO_DUMP, 'utf8')
  );

  function histogram(circuit: CircuitJson) {
    let h: Record<string, number> = {};
    for (let g of circuit.gates) h[g.typ] = (h[g.typ] ?? 0) + 1;
    return h;
  }

  function diff(name: string, a: CircuitJson, b: CircuitJson): boolean {
    console.log(`\n=== ${name} ===`);
    console.log(`  public_input_size: jsoo=${a.public_input_size} rust=${b.public_input_size}`);
    console.log(`  gates: jsoo=${a.gates.length} rust=${b.gates.length}`);
    console.log(`  histogram jsoo: ${JSON.stringify(histogram(a))}`);
    console.log(`  histogram rust: ${JSON.stringify(histogram(b))}`);
    let n = Math.min(a.gates.length, b.gates.length);
    let firstDiff = -1;
    let diffs = 0;
    for (let i = 0; i < n; i++) {
      let ga = a.gates[i];
      let gb = b.gates[i];
      if (
        ga.typ !== gb.typ ||
        JSON.stringify(ga.coeffs) !== JSON.stringify(gb.coeffs) ||
        JSON.stringify(ga.wires) !== JSON.stringify(gb.wires)
      ) {
        if (firstDiff === -1) firstDiff = i;
        diffs++;
      }
    }
    if (firstDiff !== -1) {
      console.log(`  differing rows: ${diffs}, first at ${firstDiff}`);
      console.log(`   jsoo[${firstDiff}]: ${a.gates[firstDiff].typ}`);
      console.log(`   rust[${firstDiff}]: ${b.gates[firstDiff].typ}`);
    }
    let match =
      firstDiff === -1 &&
      a.gates.length === b.gates.length &&
      a.public_input_size === b.public_input_size;
    console.log(match ? '  FULL MATCH' : '  DIVERGES');
    return match;
  }

  // Branch order follows analyzeMethods, not declaration order: map by
  // proofsVerified (init=0, update=1, merge=2).
  let branchesMeta: { proofsVerified: number }[] = JSON.parse(branchesJson);
  let byPv = new Map<number, number>();
  branchesMeta.forEach((b, i) => byPv.set(b.proofsVerified, i));
  let methods: [string, number][] = [
    ['init', 0],
    ['update', 1],
    ['merge', 2],
  ];
  let allMatch = true;
  for (let [method, pv] of methods) {
    let a = jsoo.steps[method];
    let idx = byPv.get(pv);
    if (!a || idx === undefined) {
      console.log(`\n=== step ${method} === MISSING capture (jsoo=${!!a} rust=${idx})`);
      allMatch = false;
      continue;
    }
    allMatch = diff(`step ${method} (pv=${pv})`, a, rustProgram.steps[idx]) && allMatch;
  }
  allMatch = diff('shared wrap', jsoo.wrap, rustProgram.wrap) && allMatch;

  console.log(allMatch ? '\nPROGRAM GATES: FULL MATCH' : '\nPROGRAM GATES: DIVERGES');
}
