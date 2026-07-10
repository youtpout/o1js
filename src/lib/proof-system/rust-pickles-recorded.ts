/**
 * Records an o1js circuit into the Rust `RecordedCircuit` JSON envelope and
 * proves it through the Rust Pickles backend (`@o1js/native`, kimchi-napi).
 *
 * Recording runs the circuit once in witness-generation mode with the
 * constraint-emitting `Snarky.field.*` / `Snarky.gates.*` calls intercepted:
 * every constraint is captured as linear combinations over a dense witness
 * vector whose values are read live via `Snarky.field.readVar`. The result is
 * exactly what `rust_pickles_prove_recorded_base` / `_n1` consume — no
 * host-language callback re-enters Rust during proving.
 *
 * Supported constraints so far: the basic snarky constraints (equal, square,
 * r1cs, boolean), generic gates and Poseidon permutations.
 * EC addition, range checks and lookups. Other gates throw during recording
 * until their recorder is wired up.
 */
import { Snarky, initializeBindings } from '../../bindings.js';
import type { Field } from '../provable/field.js';
import { FieldType, FieldVar, FieldConst } from '../provable/core/fieldvar.js';
import { flattenFieldVar } from '../../native/snarky.js';
import { snarkContext } from '../provable/core/provable-context.js';

export {
  recordCircuit,
  proveRecordedBaseCase,
  proveRecordedN1,
  verifyRecordedBaseCase,
  verifyRecordedN1,
  type RecordedCircuitJson,
  type RecordedProofResult,
  type RecordedN1ProofResult,
};

type RecordedLinCombJson = { constant?: string; terms?: [string, number][] };

type RecordedConstraintJson =
  | { kind: 'boolean'; v: RecordedLinCombJson }
  | { kind: 'equal'; l: RecordedLinCombJson; r: RecordedLinCombJson }
  | { kind: 'square'; v: RecordedLinCombJson; square: RecordedLinCombJson }
  | { kind: 'r1cs'; a: RecordedLinCombJson; b: RecordedLinCombJson; c: RecordedLinCombJson }
  | {
      kind: 'generic';
      cl: string;
      l: RecordedLinCombJson;
      cr: string;
      r: RecordedLinCombJson;
      co: string;
      o: RecordedLinCombJson;
      m: string;
      c: string;
    }
  | {
      kind: 'poseidon';
      states: RecordedLinCombJson[][];
      last: RecordedLinCombJson[];
    }
  | {
      kind: 'ec_add_complete';
      p1: [RecordedLinCombJson, RecordedLinCombJson];
      p2: [RecordedLinCombJson, RecordedLinCombJson];
      p3: [RecordedLinCombJson, RecordedLinCombJson];
      inf: RecordedLinCombJson;
      same_x: RecordedLinCombJson;
      slope: RecordedLinCombJson;
      inf_z: RecordedLinCombJson;
      x21_inv: RecordedLinCombJson;
    }
  | { kind: 'range_check0'; row: RecordedLinCombJson[]; compact: string }
  | { kind: 'range_check1'; row: RecordedLinCombJson[]; next: RecordedLinCombJson[] }
  | {
      kind: 'lookup';
      row: RecordedLinCombJson[];
    };

type RecordedCircuitJson = {
  aux_count: number;
  output: RecordedLinCombJson[];
  constraints: RecordedConstraintJson[];
};

type RecordedProofResult = {
  appState: string[];
  proof: unknown;
};

type RecordedN1ProofResult = RecordedProofResult & {
  challengePolynomialCommitment: [string, string];
  oldBulletproofChallenges: string[];
  dlogPlonkIndex: [string, string][];
};

/** The gates the recorder does not capture yet — calling one during recording is an error. */
const unsupportedGates = [
  'ecScale',
  'ecEndoscale',
  'ecEndoscalar',
  'xor',
  'rotate',
  'foreignFieldAdd',
  'foreignFieldMul',
  'raw',
] as const;

function mlArrayToArray<T>(array: { length: number; [index: number]: T }): T[] {
  return Array.prototype.slice.call(array, 1);
}

function mlTupleToArray<T>(tuple: { length: number; [index: number]: T }): T[] {
  return Array.prototype.slice.call(tuple, 1);
}

function fieldVarsFromMlArray(name: string, values: unknown, length?: number): FieldVar[] {
  let array = mlArrayToArray<FieldVar>(values as { length: number; [index: number]: FieldVar });
  if (length !== undefined) assertLength(name, array, length);
  return array;
}

function fieldVarsFromMlTuple(name: string, values: unknown, length: number): FieldVar[] {
  return assertLength(
    name,
    mlTupleToArray<FieldVar>(values as { length: number; [index: number]: FieldVar }),
    length
  );
}

function assertLength<T>(name: string, values: T[], length: number): T[] {
  if (values.length !== length) {
    throw Error(`Rust Pickles recorder: ${name} expected ${length} values, got ${values.length}`);
  }
  return values;
}

class CircuitRecorder {
  /** jsoo variable index -> dense recorded index */
  varIndex = new Map<number, number>();
  /** witness values, in dense allocation order (decimal strings) */
  witness: string[] = [];
  constraints: RecordedConstraintJson[] = [];

  private readVarValue(jsooIndex: number): string {
    // reading a variable's value is prover code, so run it in an asProver block
    let value: bigint | undefined;
    Snarky.run.asProver(() => {
      value = FieldConst.toBigint(Snarky.field.readVar([FieldType.Var, jsooIndex]));
    });
    if (value === undefined) throw Error('Rust Pickles recorder: could not read witness value');
    return value.toString();
  }

  /** Flattens a FieldVar and remaps its variables into the dense witness. */
  lc(x: FieldVar): RecordedLinCombJson {
    let { constant, terms } = flattenFieldVar(x);
    let out: RecordedLinCombJson = {};
    if (constant !== undefined) out.constant = constant.toString();
    if (terms.length > 0) {
      out.terms = terms.map(([coeff, jsooIndex]) => {
        let dense = this.varIndex.get(jsooIndex);
        if (dense === undefined) {
          dense = this.witness.length;
          this.varIndex.set(jsooIndex, dense);
          this.witness.push(this.readVarValue(jsooIndex));
        }
        return [coeff.toString(), dense];
      });
    }
    return out;
  }

  circuit(output: RecordedLinCombJson[]): RecordedCircuitJson {
    return {
      aux_count: this.witness.length,
      output,
      constraints: this.constraints,
    };
  }
}

/**
 * Runs `f` once in witness-generation mode with constraint recording on, and
 * returns the recorded circuit plus its witness values. `f` returns the
 * `Field`s forming the application state bound by the proof.
 */
async function recordCircuit(
  f: () => Field[] | Promise<Field[]>
): Promise<{ circuit: RecordedCircuitJson; witness: string[] }> {
  await initializeBindings();
  let recorder = new CircuitRecorder();

  let field = Snarky.field;
  let gates = Snarky.gates;
  let original = {
    assertEqual: field.assertEqual,
    assertMul: field.assertMul,
    assertSquare: field.assertSquare,
    assertBoolean: field.assertBoolean,
    generic: gates.generic,
    poseidon: gates.poseidon,
    ecAdd: gates.ecAdd,
    rangeCheck0: gates.rangeCheck0,
    rangeCheck1: gates.rangeCheck1,
    lookup: gates.lookup,
  };
  let originalGates = new Map<string, unknown>();

  field.assertEqual = (x, y) => {
    recorder.constraints.push({ kind: 'equal', l: recorder.lc(x), r: recorder.lc(y) });
    return original.assertEqual.call(field, x, y);
  };
  field.assertMul = (x, y, z) => {
    recorder.constraints.push({
      kind: 'r1cs',
      a: recorder.lc(x),
      b: recorder.lc(y),
      c: recorder.lc(z),
    });
    return original.assertMul.call(field, x, y, z);
  };
  field.assertSquare = (x, y) => {
    recorder.constraints.push({ kind: 'square', v: recorder.lc(x), square: recorder.lc(y) });
    return original.assertSquare.call(field, x, y);
  };
  field.assertBoolean = (x) => {
    recorder.constraints.push({ kind: 'boolean', v: recorder.lc(x) });
    return original.assertBoolean.call(field, x);
  };
  gates.generic = (cl, l, cr, r, co, o, m, c) => {
    recorder.constraints.push({
      kind: 'generic',
      cl: FieldConst.toBigint(cl).toString(),
      l: recorder.lc(l),
      cr: FieldConst.toBigint(cr).toString(),
      r: recorder.lc(r),
      co: FieldConst.toBigint(co).toString(),
      o: recorder.lc(o),
      m: FieldConst.toBigint(m).toString(),
      c: FieldConst.toBigint(c).toString(),
    });
    return original.generic.call(gates, cl, l, cr, r, co, o, m, c);
  };
  gates.poseidon = (state) => {
    let states = mlArrayToArray<unknown>(state as { length: number; [index: number]: unknown }).map(
      (row) => fieldVarsFromMlTuple('poseidon.state', row, 3).map((cell) => recorder.lc(cell))
    );
    if (states.length === 0) throw Error('Rust Pickles recorder: empty Poseidon state');
    let last = states[states.length - 1];
    recorder.constraints.push({
      kind: 'poseidon',
      states: states.slice(0, -1),
      last,
    });
    return original.poseidon.call(gates, state);
  };
  gates.ecAdd = (p1, p2, p3, inf, same_x, slope, inf_z, x21_inv) => {
    let [p1x, p1y] = fieldVarsFromMlTuple('ecAdd.p1', p1, 2);
    let [p2x, p2y] = fieldVarsFromMlTuple('ecAdd.p2', p2, 2);
    let [p3x, p3y] = fieldVarsFromMlTuple('ecAdd.p3', p3, 2);
    recorder.constraints.push({
      kind: 'ec_add_complete',
      p1: [recorder.lc(p1x), recorder.lc(p1y)],
      p2: [recorder.lc(p2x), recorder.lc(p2y)],
      p3: [recorder.lc(p3x), recorder.lc(p3y)],
      inf: recorder.lc(inf),
      same_x: recorder.lc(same_x),
      slope: recorder.lc(slope),
      inf_z: recorder.lc(inf_z),
      x21_inv: recorder.lc(x21_inv),
    });
    return original.ecAdd.call(gates, p1, p2, p3, inf, same_x, slope, inf_z, x21_inv);
  };
  gates.rangeCheck0 = (v0, v0p, v0c, compact) => {
    let row = [
      v0,
      ...fieldVarsFromMlTuple('rangeCheck0.v0p', v0p, 6),
      ...fieldVarsFromMlTuple('rangeCheck0.v0c', v0c, 8),
    ];
    recorder.constraints.push({
      kind: 'range_check0',
      row: row.map((cell) => recorder.lc(cell)),
      compact: FieldConst.toBigint(compact).toString(),
    });
    return original.rangeCheck0.call(gates, v0, v0p, v0c, compact);
  };
  gates.rangeCheck1 = (v2, v12, vCurr, vNext) => {
    let row = [v2, v12, ...fieldVarsFromMlTuple('rangeCheck1.vCurr', vCurr, 13)];
    let next = fieldVarsFromMlTuple('rangeCheck1.vNext', vNext, 15);
    recorder.constraints.push({
      kind: 'range_check1',
      row: row.map((cell) => recorder.lc(cell)),
      next: next.map((cell) => recorder.lc(cell)),
    });
    return original.rangeCheck1.call(gates, v2, v12, vCurr, vNext);
  };
  gates.lookup = (input) => {
    let row = fieldVarsFromMlTuple('lookup', input, 7);
    recorder.constraints.push({ kind: 'lookup', row: row.map((cell) => recorder.lc(cell)) });
    return original.lookup.call(gates, input);
  };
  for (let name of unsupportedGates) {
    let gate = (gates as Record<string, unknown>)[name];
    if (typeof gate !== 'function') continue;
    originalGates.set(name, gate);
    (gates as Record<string, unknown>)[name] = () => {
      throw Error(
        `Rust Pickles recorder: the '${name}' gate is not supported yet — ` +
          'this circuit cannot be recorded for the Rust backend.'
      );
    };
  }

  let id = snarkContext.enter({ inCheckedComputation: true });
  try {
    let finish = Snarky.run.enterGenerateWitness();
    let outputs = await f();
    let output = outputs.map((x) => recorder.lc(x.value));
    finish();
    return { circuit: recorder.circuit(output), witness: recorder.witness };
  } finally {
    snarkContext.leave(id);
    field.assertEqual = original.assertEqual;
    field.assertMul = original.assertMul;
    field.assertSquare = original.assertSquare;
    field.assertBoolean = original.assertBoolean;
    gates.generic = original.generic;
    gates.poseidon = original.poseidon;
    gates.ecAdd = original.ecAdd;
    gates.rangeCheck0 = original.rangeCheck0;
    gates.rangeCheck1 = original.rangeCheck1;
    gates.lookup = original.lookup;
    for (let [name, gate] of originalGates) {
      (gates as Record<string, unknown>)[name] = gate;
    }
  }
}

type NativePickles = {
  rust_pickles_prove_recorded_base?: (circuit: string, witness: string[]) => string;
  rust_pickles_prove_recorded_n1?: (circuit: string, witness: string[]) => string;
  rust_pickles_verify_side_loaded?: (
    appState: string[],
    commitments: string[][],
    challenges: string[][],
    proof: string
  ) => boolean;
  rust_pickles_verify_side_loaded_with_step_vk?: (
    appState: string[],
    dlogPlonkIndex: string[][],
    commitments: string[][],
    challenges: string[][],
    proof: string
  ) => boolean;
};

async function nativePickles(): Promise<NativePickles> {
  let { default: native } = await import('../../native/native.js');
  if (!native) {
    throw Error(
      'Rust Pickles backend is not available: build @o1js/native from proof-systems ' +
        '(PROOF_SYSTEMS_ROOT=... npm run build:native).'
    );
  }
  return native as NativePickles;
}

/** Records `f` and proves it through the Rust base-case Pickles pipeline. */
async function proveRecordedBaseCase(
  f: () => Field[] | Promise<Field[]>
): Promise<RecordedProofResult> {
  let native = await nativePickles();
  if (!native.rust_pickles_prove_recorded_base) {
    throw Error('@o1js/native does not expose rust_pickles_prove_recorded_base — rebuild it.');
  }
  let { circuit, witness } = await recordCircuit(f);
  return JSON.parse(native.rust_pickles_prove_recorded_base(JSON.stringify(circuit), witness));
}

/** Records `f` and proves it plus one recursive (N1) Pickles cycle. */
async function proveRecordedN1(
  f: () => Field[] | Promise<Field[]>
): Promise<RecordedN1ProofResult> {
  let native = await nativePickles();
  if (!native.rust_pickles_prove_recorded_n1) {
    throw Error('@o1js/native does not expose rust_pickles_prove_recorded_n1 — rebuild it.');
  }
  let { circuit, witness } = await recordCircuit(f);
  return JSON.parse(native.rust_pickles_prove_recorded_n1(JSON.stringify(circuit), witness));
}

/** Verifies a base-case recorded proof standalone against its embedded side-loaded key. */
async function verifyRecordedBaseCase(result: RecordedProofResult): Promise<boolean> {
  let native = await nativePickles();
  if (!native.rust_pickles_verify_side_loaded) {
    throw Error('@o1js/native does not expose rust_pickles_verify_side_loaded — rebuild it.');
  }
  return native.rust_pickles_verify_side_loaded(
    result.appState,
    [],
    [],
    JSON.stringify(result.proof)
  );
}

/** Verifies an N1 recorded proof standalone, binding its recursion messages. */
async function verifyRecordedN1(result: RecordedN1ProofResult): Promise<boolean> {
  let native = await nativePickles();
  if (!native.rust_pickles_verify_side_loaded_with_step_vk) {
    throw Error(
      '@o1js/native does not expose rust_pickles_verify_side_loaded_with_step_vk — rebuild it.'
    );
  }
  return native.rust_pickles_verify_side_loaded_with_step_vk(
    result.appState,
    result.dlogPlonkIndex,
    [result.challengePolynomialCommitment],
    [result.oldBulletproofChallenges],
    JSON.stringify(result.proof)
  );
}
