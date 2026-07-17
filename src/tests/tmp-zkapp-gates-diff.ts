/**
 * Gate-level parity diff for a SmartContract method circuit (the zkApp
 * account-update machinery) between jsoo Pickles and the rust recorder.
 *
 * Two passes (the proof-system backend locks at first compile):
 *   MODE=jsoo ./run src/tests/tmp-zkapp-gates-diff.ts   (dump jsoo step)
 *   MODE=rust ./run src/tests/tmp-zkapp-gates-diff.ts   (dump rust + diff)
 *
 * The zkApp VK is the width-0 wrap key, and that wrap is already
 * byte-identical to jsoo (the square gate is green) — so the VK divergence
 * lives in the STEP circuit, whose digest the wrap absorbs. Only the step
 * is diffed here.
 */
import { Cache, Field, SmartContract, State, method, state, type CacheHeader } from '../index.js';
import { Pickles, wasm } from '../bindings.js';
import { writeFileSync, readFileSync } from 'node:fs';

const DUMP_DIR = '/tmp/claude-1000';
const JSOO_DUMP = `${DUMP_DIR}/zkapp-gates-jsoo.json`;
const BRANCHES_DUMP = `${DUMP_DIR}/zkapp-branches.json`;

class SimpleZkapp extends SmartContract {
  @state(Field) x = State<Field>();

  init() {
    super.init();
    this.x.set(Field(1));
  }

  @method async update(y: Field) {
    const x = this.x.getAndRequireEquals();
    this.x.set(x.add(y));
  }
}

type CircuitJson = {
  public_input_size: number;
  gates: { typ: string; wires: unknown; coeffs: string[] }[];
};

const mode = process.env.MODE ?? 'rust';

if (mode === 'jsoo') {
  let stepPks = new Map<string, Uint8Array>();
  let interceptCache = {
    canWrite: true,
    read(_header: CacheHeader): Uint8Array | undefined {
      return undefined;
    },
    write(header: CacheHeader, value: Uint8Array): void {
      if (header.kind === 'step-pk') {
        stepPks.set((header as any).methodName ?? String(stepPks.size), value.slice());
      }
    },
  };
  console.log('compiling SimpleZkapp via jsoo Pickles (capturing step pk)...');
  await SimpleZkapp.compile({ cache: interceptCache as any, forceRecompile: true });
  if (stepPks.size === 0) throw Error('no step pk captured');
  let steps: Record<string, CircuitJson> = {};
  for (let [methodName, bytes] of stepPks) {
    let index = wasm.caml_pasta_fp_plonk_index_decode(bytes, Pickles.loadSrsFp());
    steps[methodName] = JSON.parse(wasm.prover_to_json(index));
    console.log(
      `  step ${methodName}: ${steps[methodName].gates.length} gates, pi=${steps[methodName].public_input_size}`
    );
  }
  writeFileSync(JSOO_DUMP, JSON.stringify({ steps }));
  console.log(`jsoo zkapp step dumped to ${JSOO_DUMP}`);
} else {
  let { setProofSystemBackend } = await import('../lib/backend.js');
  setProofSystemBackend('rust');
  process.env.O1JS_DUMP_PROGRAM_BRANCHES = BRANCHES_DUMP;
  console.log('compiling SimpleZkapp via the rust backend (dumping branches)...');
  await SimpleZkapp.compile({ cache: Cache.None, forceRecompile: true });

  let branches: { circuit: unknown }[] = JSON.parse(readFileSync(BRANCHES_DUMP, 'utf8'));
  let { default: native } = await import('../native/native.js');
  let dump = (native as any)?.rust_pickles_recorded_step_circuit_json as
    | ((circuit: string) => string)
    | undefined;
  if (!dump) throw Error('@o1js/native does not expose rust_pickles_recorded_step_circuit_json');
  let rust: CircuitJson = JSON.parse(dump(JSON.stringify(branches[0].circuit)));
  writeFileSync(`${DUMP_DIR}/zkapp-gates-rust.json`, JSON.stringify({ steps: { update: rust } }));

  let jsoo: { steps: Record<string, CircuitJson> } = JSON.parse(readFileSync(JSOO_DUMP, 'utf8'));
  let a = Object.values(jsoo.steps)[0];
  let b = rust;

  let histogram = (c: CircuitJson) => {
    let h: Record<string, number> = {};
    for (let g of c.gates) h[g.typ] = (h[g.typ] ?? 0) + 1;
    return h;
  };
  console.log(`\n=== zkApp step 'update' ===`);
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
  console.log(
    firstDiff === -1 && a.gates.length === b.gates.length ? 'ZKAPP STEP: FULL MATCH' : 'ZKAPP STEP: DIVERGES'
  );
}
