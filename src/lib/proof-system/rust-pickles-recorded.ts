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
import { Snarky, initializeBindings, wasm, withThreadPool } from '../../bindings.js';
import { flattenFieldVar } from '../../native/snarky.js';
import { getBackendPreference, getProofSystemBackend } from '../backend.js';
import {
  MinaRuntimeClient,
  type RecursiveN2ProofResponse,
  type RecursiveProofResponse,
  type RustProofResponse,
} from '../mina-runtime/backend.js';
import { FieldConst, FieldType, FieldVar } from '../provable/core/fieldvar.js';
import { snarkContext } from '../provable/core/provable-context.js';
import type { Field } from '../provable/field.js';
import { Cache, readCache, withVersion, writeCache, type CacheHeader } from './cache.js';

export {
  compileRecorded,
  compileRecordedN1Over,
  compileRecordedProgram,
  proveRecordedBaseCase,
  proveRecordedBaseCaseKeep,
  proveRecordedN,
  proveRecordedN1,
  proveRecordedN1Over,
  proveRecordedN2,
  proveRecordedStableN1,
  recordCircuit,
  releaseRecordedBaseProofHandle,
  verifyRecordedBaseCase,
  verifyRecordedBaseCaseViaMinaRuntime,
  verifyRecordedN1,
  verifyRecordedN2,
  verifyRecordedProofViaMinaRuntime,
  type RecordedBaseProofHandle,
  type RecordedCircuitJson,
  type RecordedCompiledCircuit,
  type RecordedCompiledN1Circuit,
  type RecordedN1ProofResult,
  type RecordedN2ProofResult,
  type RecordedProofHandle,
  type RecordedProofResult,
  type RecordedStableN1ProofResult,
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

type RecordedStableN1ProofResult = RecordedN1ProofResult & {
  stableCycles: number;
};

type RecordedN2ProofResult = RecordedProofResult & {
  challengePolynomialCommitments: [string, string][];
  oldBulletproofChallenges: string[][];
  dlogPlonkIndex: [string, string][];
};

/**
 * A base-case proof kept alive in native memory for chaining: the full proof
 * (not just the envelope) stays on the Rust side behind the opaque `handle`,
 * so a later {@link proveRecordedN1Over} call can recursively verify it. The
 * envelope fields mirror {@link RecordedProofResult} and verify with
 * {@link verifyRecordedBaseCase}.
 */
type RecordedBaseProofHandle = RecordedProofResult & {
  handle: MinaRuntimeBaseHandle | unknown;
};

type RecordedN1ProofHandle = RecordedN1ProofResult & {
  handle: MinaRuntimeBaseHandle;
};

type RecordedProofHandle = RecordedBaseProofHandle | RecordedN1ProofHandle;

type RecordedCompiledCircuit = {
  circuit: RecordedCircuitJson;
  witness: string[];
  /** Canonical Mina side-loaded VK (base64 data + account hash), when the
   * bindings expose it — bit-identical to jsoo's for width-0 circuits. */
  verificationKey?: CanonicalVkEnvelope;
  proveBaseCase(): Promise<RecordedProofResult>;
  proveBaseCaseWithWitness(witness: string[]): Promise<RecordedProofResult>;
  proveBaseCaseKeep(): Promise<RecordedBaseProofHandle>;
  proveBaseCaseKeepWithWitness(witness: string[]): Promise<RecordedBaseProofHandle>;
  proveN1OverWithWitness(
    previous: RecordedProofHandle,
    witness: string[]
  ): Promise<RecordedN1ProofResult>;
  proveN1OverKeepWithWitness(
    previous: RecordedProofHandle,
    witness: string[]
  ): Promise<RecordedN1ProofHandle>;
  proveN2OverWithWitness(
    first: RecordedBaseProofHandle,
    second: RecordedBaseProofHandle,
    witness: string[]
  ): Promise<RecordedN2ProofResult>;
  proveN1(): Promise<RecordedN1ProofResult>;
  proveStableN1(additionalStableCycles?: number): Promise<RecordedStableN1ProofResult>;
  proveN(recursiveCycles: number): Promise<RecordedN1ProofResult | RecordedStableN1ProofResult>;
  proveN2With(
    second: RecordedCompiledCircuit,
    appState: Field[] | string[]
  ): Promise<RecordedN2ProofResult>;
  verifyBaseCase(result: RecordedProofResult): Promise<boolean>;
  verifyN1(result: RecordedN1ProofResult): Promise<boolean>;
  verifyN2(result: RecordedN2ProofResult): Promise<boolean>;
  dispose(): void;
};

type RecordedCompiledN1Circuit = {
  circuit: RecordedCircuitJson;
  witness: string[];
  prove(): Promise<RecordedN1ProofResult>;
  proveWithWitness(witness: string[]): Promise<RecordedN1ProofResult>;
  dispose(): void;
};

type DirectRustCompiled = {
  bindings: RustPicklesBindings;
  handle: unknown;
  n1Handle?: unknown;
  n2Handle?: unknown;
  verificationKey?: CanonicalVkEnvelope;
};

type CanonicalVkEnvelope = { data: string; hash: string };
type MinaRuntimeCompiled = {
  client: MinaRuntimeClient;
  circuitId: number;
  verificationKey?: CanonicalVkEnvelope;
};
type MinaRuntimeBaseHandle = {
  kind: 'mina-runtime';
  proofKind: 'base' | 'n1';
  client: MinaRuntimeClient;
  proofId: number;
};
let minaRuntimeClientPromise: Promise<MinaRuntimeClient> | undefined;

function useMinaRuntimeBackend() {
  return getProofSystemBackend() === 'rust' && getBackendPreference() === 'native';
}

async function minaRuntimeClient() {
  minaRuntimeClientPromise ??= import('../../native/native.js').then(
    ({ createMinaRuntime }) => new MinaRuntimeClient(createMinaRuntime())
  );
  return minaRuntimeClientPromise;
}

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
  f: () => Field[] | Promise<Field[]>,
  { validateWitness = true } = {}
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
    if (validateWitness) return original.assertEqual.call(field, x, y);
  };
  field.assertMul = (x, y, z) => {
    recorder.constraints.push({
      kind: 'r1cs',
      a: recorder.lc(x),
      b: recorder.lc(y),
      c: recorder.lc(z),
    });
    if (validateWitness) return original.assertMul.call(field, x, y, z);
  };
  field.assertSquare = (x, y) => {
    recorder.constraints.push({ kind: 'square', v: recorder.lc(x), square: recorder.lc(y) });
    if (validateWitness) return original.assertSquare.call(field, x, y);
  };
  field.assertBoolean = (x) => {
    recorder.constraints.push({ kind: 'boolean', v: recorder.lc(x) });
    if (validateWitness) return original.assertBoolean.call(field, x);
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

type RustPicklesBindings = {
  rust_pickles_compile_recorded_base?: (circuit: string, witness: string[]) => unknown;
  rust_pickles_compile_recorded_base_bytes?: (circuit: string, witness: Uint8Array) => unknown;
  rust_pickles_recorded_base_cache_key?: (circuit: string) => string;
  rust_pickles_recorded_base_cache_bytes?: (compiled: unknown) => Uint8Array;
  rust_pickles_compile_recorded_base_from_cache_bytes?: (
    circuit: string,
    witness: Uint8Array,
    cache: Uint8Array
  ) => unknown;
  rust_pickles_prove_recorded_base_keep_compiled?: (
    compiled: unknown,
    witness: string[]
  ) => unknown;
  rust_pickles_prove_recorded_base_keep_compiled_bytes?: (
    compiled: unknown,
    witness: Uint8Array
  ) => unknown;
  rust_pickles_recorded_base_donor_handle_bytes?: (
    compiled: unknown,
    witness: Uint8Array
  ) => unknown;
  rust_pickles_recorded_base_vk_envelope?: (compiled: unknown) => string;
  rust_pickles_prove_recorded_n2_over_base_handles?: (
    first: unknown,
    second: unknown,
    circuit: string,
    witness: string[]
  ) => string;
  rust_pickles_prove_recorded_n2_over_base_handles_bytes?: (
    first: unknown,
    second: unknown,
    circuit: string,
    witness: Uint8Array
  ) => string;
  rust_pickles_compile_recorded_n1?: (
    previous: unknown,
    circuit: string,
    witness: string[]
  ) => unknown;
  rust_pickles_compile_recorded_n1_bytes?: (
    previous: unknown,
    circuit: string,
    witness: Uint8Array
  ) => unknown;
  rust_pickles_compile_recorded_n2_bytes?: (
    first: unknown,
    second: unknown,
    circuit: string,
    witness: Uint8Array
  ) => unknown;
  rust_pickles_prove_recorded_n2_compiled_bytes?: (
    compiled: unknown,
    first: unknown,
    second: unknown,
    witness: Uint8Array
  ) => string;
  rust_pickles_prove_recorded_n1_compiled?: (
    compiled: unknown,
    previous: unknown,
    witness: string[]
  ) => string;
  rust_pickles_prove_recorded_n1_compiled_bytes?: (
    compiled: unknown,
    previous: unknown,
    witness: Uint8Array
  ) => string;
  rust_pickles_prove_recorded_n1_compiled_keep?: (
    compiled: unknown,
    previous: unknown,
    witness: string[]
  ) => unknown;
  rust_pickles_prove_recorded_n1_compiled_keep_bytes?: (
    compiled: unknown,
    previous: unknown,
    witness: Uint8Array
  ) => unknown;
  rust_pickles_recorded_n1_envelope?: (handle: unknown) => string;
  rust_pickles_prove_recorded_base?: (circuit: string, witness: string[]) => string;
  rust_pickles_prove_recorded_base_keep?: (circuit: string, witness: string[]) => unknown;
  rust_pickles_recorded_base_envelope?: (handle: unknown) => string;
  rust_pickles_prove_recorded_n1?: (circuit: string, witness: string[]) => string;
  rust_pickles_prove_recorded_stable_n1?: (
    circuit: string,
    witness: string[],
    additionalStableCycles: number
  ) => string;
  rust_pickles_prove_recorded_n2?: (
    circuit: string,
    firstWitness: string[],
    secondWitness: string[],
    appState: string[]
  ) => string;
  rust_pickles_prove_recorded_n1_over?: (
    handle: unknown,
    circuit: string,
    witness: string[]
  ) => string;
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

type WasmRustPicklesBindings = Omit<
  RustPicklesBindings,
  'rust_pickles_verify_side_loaded' | 'rust_pickles_verify_side_loaded_with_step_vk'
> & {
  rust_pickles_verify_side_loaded?: (
    appState: string[],
    commitmentsJson: string,
    challengesJson: string,
    proof: string
  ) => boolean;
  rust_pickles_verify_side_loaded_with_step_vk?: (
    appState: string[],
    dlogPlonkIndexJson: string,
    commitmentsJson: string,
    challengesJson: string,
    proof: string
  ) => boolean;
};

async function rustPicklesBindings(): Promise<RustPicklesBindings> {
  if (getBackendPreference() === 'wasm') {
    await initializeBindings();
    let rustWasm = wasm as unknown as WasmRustPicklesBindings;
    if (typeof rustWasm.rust_pickles_prove_recorded_base !== 'function') {
      throw Error(
        'Rust Pickles WASM backend is not available: rebuild kimchi-wasm from ' +
          'proof-systems/pickle-rs and install the generated Node WASM artifacts.'
      );
    }
    let verify = rustWasm.rust_pickles_verify_side_loaded;
    let verifyWithStepVk = rustWasm.rust_pickles_verify_side_loaded_with_step_vk;
    return {
      ...rustWasm,
      rust_pickles_verify_side_loaded:
        verify === undefined
          ? undefined
          : (appState, commitments, challenges, proof) =>
              verify(appState, JSON.stringify(commitments), JSON.stringify(challenges), proof),
      rust_pickles_verify_side_loaded_with_step_vk:
        verifyWithStepVk === undefined
          ? undefined
          : (appState, dlogPlonkIndex, commitments, challenges, proof) =>
              verifyWithStepVk(
                appState,
                JSON.stringify(dlogPlonkIndex),
                JSON.stringify(commitments),
                JSON.stringify(challenges),
                proof
              ),
    };
  }
  let { default: native } = await import('../../native/native.js');
  if (!native) {
    throw Error(
      'Rust Pickles backend is not available: build @o1js/native from proof-systems ' +
        '(PROOF_SYSTEMS_ROOT=... npm run build:native).'
    );
  }
  return native as RustPicklesBindings;
}

async function runRustPickles<T>(run: () => T | Promise<T>): Promise<T> {
  if (getBackendPreference() !== 'wasm') return run();
  return withThreadPool(async () => run());
}

function circuitJsonOf(compiled: Pick<RecordedCompiledCircuit, 'circuit'>): string {
  return JSON.stringify(compiled.circuit);
}

function appStateToDecimal(appState: Field[] | string[]): string[] {
  return appState.map((field) => (typeof field === 'string' ? field : field.toString()));
}

function fpWitnessToBytes(witness: string[]): Uint8Array {
  let bytes = new Uint8Array(32 * witness.length);
  for (let i = 0; i < witness.length; i++) {
    let value = BigInt(witness[i]);
    if (value < 0n) throw Error('Rust Pickles witness must be a canonical non-negative Fp');
    for (let j = 0; j < 32; j++) {
      bytes[32 * i + j] = Number(value & 0xffn);
      value >>= 8n;
    }
    if (value !== 0n) throw Error('Rust Pickles witness does not fit in 32 bytes');
  }
  return bytes;
}

async function proveRecordedBaseCaseCompiled(
  compiled: Pick<RecordedCompiledCircuit, 'circuit' | 'witness'> & {
    minaRuntime?: MinaRuntimeCompiled;
    directRust?: DirectRustCompiled;
  }
): Promise<RecordedProofResult> {
  if (useMinaRuntimeBackend()) {
    let client = compiled.minaRuntime?.client ?? (await minaRuntimeClient());
    let temporary = compiled.minaRuntime === undefined;
    let circuitId =
      compiled.minaRuntime?.circuitId ??
      client.compileCircuit(compiled.circuit, compiled.witness, 0).circuitId;
    try {
      return (await client.proveCircuit(circuitId, compiled.witness)) as RecordedProofResult;
    } finally {
      if (temporary) client.dropCircuit(circuitId);
    }
  }
  if (compiled.directRust !== undefined) {
    let { bindings, handle } = compiled.directRust;
    if (
      !bindings.rust_pickles_prove_recorded_base_keep_compiled ||
      !bindings.rust_pickles_recorded_base_envelope
    ) {
      throw Error('Rust Pickles bindings do not expose compiled base proving.');
    }
    let proofHandle = await runRustPickles(() =>
      bindings.rust_pickles_prove_recorded_base_keep_compiled_bytes
        ? bindings.rust_pickles_prove_recorded_base_keep_compiled_bytes(
            handle,
            fpWitnessToBytes(compiled.witness)
          )
        : bindings.rust_pickles_prove_recorded_base_keep_compiled!(handle, compiled.witness)
    );
    return JSON.parse(bindings.rust_pickles_recorded_base_envelope(proofHandle));
  }
  let native = await rustPicklesBindings();
  if (!native.rust_pickles_prove_recorded_base) {
    throw Error('@o1js/native does not expose rust_pickles_prove_recorded_base — rebuild it.');
  }
  return JSON.parse(
    await runRustPickles(() =>
      native.rust_pickles_prove_recorded_base!(circuitJsonOf(compiled), compiled.witness)
    )
  );
}

async function proveRecordedBaseCaseKeepCompiled(
  compiled: Pick<RecordedCompiledCircuit, 'circuit' | 'witness'> & {
    minaRuntime?: MinaRuntimeCompiled;
    directRust?: DirectRustCompiled;
  }
): Promise<RecordedBaseProofHandle> {
  if (useMinaRuntimeBackend()) {
    let client = compiled.minaRuntime?.client ?? (await minaRuntimeClient());
    let temporary = compiled.minaRuntime === undefined;
    let circuitId =
      compiled.minaRuntime?.circuitId ??
      client.compileCircuit(compiled.circuit, compiled.witness, 0).circuitId;
    try {
      let { proofId, appState, proof } = await client.proveCircuitKeep(circuitId, compiled.witness);
      return {
        appState,
        proof,
        handle: { kind: 'mina-runtime', proofKind: 'base', client, proofId },
      };
    } finally {
      if (temporary) client.dropCircuit(circuitId);
    }
  }
  if (compiled.directRust !== undefined) {
    let { bindings, handle } = compiled.directRust;
    if (
      !bindings.rust_pickles_prove_recorded_base_keep_compiled ||
      !bindings.rust_pickles_recorded_base_envelope
    ) {
      throw Error('Rust Pickles bindings do not expose compiled base proving.');
    }
    let proofHandle = await runRustPickles(() =>
      bindings.rust_pickles_prove_recorded_base_keep_compiled_bytes
        ? bindings.rust_pickles_prove_recorded_base_keep_compiled_bytes(
            handle,
            fpWitnessToBytes(compiled.witness)
          )
        : bindings.rust_pickles_prove_recorded_base_keep_compiled!(handle, compiled.witness)
    );
    let envelope = JSON.parse(bindings.rust_pickles_recorded_base_envelope(proofHandle));
    return { handle: proofHandle, ...envelope };
  }
  let native = await rustPicklesBindings();
  if (
    !native.rust_pickles_prove_recorded_base_keep ||
    !native.rust_pickles_recorded_base_envelope
  ) {
    throw Error('@o1js/native does not expose rust_pickles_prove_recorded_base_keep — rebuild it.');
  }
  let handle = await runRustPickles(() =>
    native.rust_pickles_prove_recorded_base_keep!(circuitJsonOf(compiled), compiled.witness)
  );
  let envelope = JSON.parse(native.rust_pickles_recorded_base_envelope(handle));
  return { handle, ...envelope };
}

async function proveRecordedN1OverCompiled(
  previous: RecordedProofHandle,
  compiled: Pick<RecordedCompiledCircuit, 'circuit' | 'witness'> & {
    minaRuntime?: MinaRuntimeCompiled;
  }
): Promise<RecordedN1ProofResult> {
  if (isMinaRuntimeBaseHandle(previous.handle)) {
    let { client, proofId } = previous.handle;
    let temporary = compiled.minaRuntime === undefined;
    let circuitId =
      compiled.minaRuntime?.circuitId ??
      client.compileCircuit(compiled.circuit, compiled.witness, 1).circuitId;
    try {
      return await client.proveCircuitN1Over(circuitId, proofId, compiled.witness);
    } finally {
      if (temporary) client.dropCircuit(circuitId);
    }
  }
  let native = await rustPicklesBindings();
  if (!native.rust_pickles_prove_recorded_n1_over) {
    throw Error('@o1js/native does not expose rust_pickles_prove_recorded_n1_over — rebuild it.');
  }
  return JSON.parse(
    await runRustPickles(() =>
      native.rust_pickles_prove_recorded_n1_over!(
        previous.handle,
        circuitJsonOf(compiled),
        compiled.witness
      )
    )
  );
}

async function proveRecordedN1OverKeepCompiled(
  previous: RecordedProofHandle,
  compiled: Pick<RecordedCompiledCircuit, 'circuit' | 'witness'> & {
    minaRuntime?: MinaRuntimeCompiled;
    directRust?: DirectRustCompiled;
  }
): Promise<RecordedN1ProofHandle> {
  if (!isMinaRuntimeBaseHandle(previous.handle)) {
    let bindings = compiled.directRust?.bindings ?? (await rustPicklesBindings());
    if (
      !bindings.rust_pickles_compile_recorded_n1 ||
      !bindings.rust_pickles_prove_recorded_n1_compiled_keep ||
      !bindings.rust_pickles_recorded_n1_envelope
    ) {
      throw Error('Rust Pickles bindings do not expose retained compiled N1 proving.');
    }
    let witnessBytes = fpWitnessToBytes(compiled.witness);
    let temporary = compiled.directRust?.n1Handle === undefined;
    let compiledN1 =
      compiled.directRust?.n1Handle ??
      (await runRustPickles(() =>
        bindings.rust_pickles_compile_recorded_n1_bytes
          ? bindings.rust_pickles_compile_recorded_n1_bytes(
              previous.handle,
              circuitJsonOf(compiled),
              witnessBytes
            )
          : bindings.rust_pickles_compile_recorded_n1!(
              previous.handle,
              circuitJsonOf(compiled),
              compiled.witness
            )
      ));
    try {
      let handle = await runRustPickles(() =>
        bindings.rust_pickles_prove_recorded_n1_compiled_keep_bytes
          ? bindings.rust_pickles_prove_recorded_n1_compiled_keep_bytes(
              compiledN1,
              previous.handle,
              witnessBytes
            )
          : bindings.rust_pickles_prove_recorded_n1_compiled_keep!(
              compiledN1,
              previous.handle,
              compiled.witness
            )
      );
      return { handle, ...JSON.parse(bindings.rust_pickles_recorded_n1_envelope(handle)) };
    } finally {
      if (temporary) (compiledN1 as { free?: () => void }).free?.();
    }
  }
  if (!isMinaRuntimeBaseHandle(previous.handle)) {
    throw Error('retained recursive N1 handles require the mina-runtime backend');
  }
  let { client, proofId } = previous.handle;
  let temporary = compiled.minaRuntime === undefined;
  let circuitId =
    compiled.minaRuntime?.circuitId ??
    client.compileCircuit(compiled.circuit, compiled.witness, 1).circuitId;
  try {
    let { proofId: nextProofId, ...result } = await client.proveCircuitN1Over(
      circuitId,
      proofId,
      compiled.witness
    );
    return {
      ...result,
      handle: { kind: 'mina-runtime', proofKind: 'n1', client, proofId: nextProofId },
    };
  } finally {
    if (temporary) client.dropCircuit(circuitId);
  }
}

async function proveRecordedN2OverCompiled(
  first: RecordedBaseProofHandle,
  second: RecordedBaseProofHandle,
  compiled: Pick<RecordedCompiledCircuit, 'circuit' | 'witness'> & {
    minaRuntime?: MinaRuntimeCompiled;
    directRust?: DirectRustCompiled;
  }
): Promise<RecordedN2ProofResult> {
  if (!isMinaRuntimeBaseHandle(first.handle) && !isMinaRuntimeBaseHandle(second.handle)) {
    let bindings = compiled.directRust?.bindings ?? (await rustPicklesBindings());
    if (
      compiled.directRust?.n2Handle !== undefined &&
      bindings.rust_pickles_prove_recorded_n2_compiled_bytes
    ) {
      return JSON.parse(
        await runRustPickles(() =>
          bindings.rust_pickles_prove_recorded_n2_compiled_bytes!(
            compiled.directRust!.n2Handle,
            first.handle,
            second.handle,
            fpWitnessToBytes(compiled.witness)
          )
        )
      );
    }
    if (!bindings.rust_pickles_prove_recorded_n2_over_base_handles) {
      throw Error(
        '@o1js/native does not expose retained-base N2 proving — rebuild the Rust bindings.'
      );
    }
    return JSON.parse(
      await runRustPickles(() =>
        bindings.rust_pickles_prove_recorded_n2_over_base_handles_bytes
          ? bindings.rust_pickles_prove_recorded_n2_over_base_handles_bytes(
              first.handle,
              second.handle,
              circuitJsonOf(compiled),
              fpWitnessToBytes(compiled.witness)
            )
          : bindings.rust_pickles_prove_recorded_n2_over_base_handles!(
              first.handle,
              second.handle,
              circuitJsonOf(compiled),
              compiled.witness
            )
      )
    );
  }
  if (
    !isMinaRuntimeBaseHandle(first.handle) ||
    !isMinaRuntimeBaseHandle(second.handle) ||
    first.handle.proofKind !== 'base' ||
    second.handle.proofKind !== 'base'
  ) {
    throw Error('regular N2 currently requires two retained base proofs');
  }
  let client = first.handle.client;
  if (second.handle.client !== client) {
    throw Error('regular N2 proof handles must belong to the same mina-runtime instance');
  }
  let temporary = compiled.minaRuntime === undefined;
  let circuitId =
    compiled.minaRuntime?.circuitId ??
    client.compileCircuit(compiled.circuit, compiled.witness, 2).circuitId;
  try {
    return await client.proveCircuitN2Over(
      circuitId,
      first.handle.proofId,
      second.handle.proofId,
      compiled.witness
    );
  } finally {
    if (temporary) client.dropCircuit(circuitId);
  }
}

function isMinaRuntimeBaseHandle(value: unknown): value is MinaRuntimeBaseHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as MinaRuntimeBaseHandle).kind === 'mina-runtime'
  );
}

function releaseRecordedBaseProofHandle(previous: RecordedProofHandle) {
  if (isMinaRuntimeBaseHandle(previous.handle)) {
    previous.handle.client.dropProof(previous.handle.proofId);
    return;
  }
  (previous.handle as { free?: () => void }).free?.();
}

async function proveRecordedN1Compiled(
  compiled: Pick<RecordedCompiledCircuit, 'circuit' | 'witness'>
): Promise<RecordedN1ProofResult> {
  let native = await rustPicklesBindings();
  if (!native.rust_pickles_prove_recorded_n1) {
    throw Error('@o1js/native does not expose rust_pickles_prove_recorded_n1 — rebuild it.');
  }
  return JSON.parse(
    await runRustPickles(() =>
      native.rust_pickles_prove_recorded_n1!(circuitJsonOf(compiled), compiled.witness)
    )
  );
}

async function proveRecordedStableN1Compiled(
  compiled: Pick<RecordedCompiledCircuit, 'circuit' | 'witness'>,
  additionalStableCycles = 0
): Promise<RecordedStableN1ProofResult> {
  if (!Number.isInteger(additionalStableCycles) || additionalStableCycles < 0) {
    throw Error('additionalStableCycles must be a non-negative integer');
  }
  let native = await rustPicklesBindings();
  if (!native.rust_pickles_prove_recorded_stable_n1) {
    throw Error('@o1js/native does not expose rust_pickles_prove_recorded_stable_n1 — rebuild it.');
  }
  return JSON.parse(
    await runRustPickles(() =>
      native.rust_pickles_prove_recorded_stable_n1!(
        circuitJsonOf(compiled),
        compiled.witness,
        additionalStableCycles
      )
    )
  );
}

async function proveRecordedNCompiled(
  compiled: Pick<RecordedCompiledCircuit, 'circuit' | 'witness'>,
  recursiveCycles: number
): Promise<RecordedN1ProofResult | RecordedStableN1ProofResult> {
  if (!Number.isInteger(recursiveCycles) || recursiveCycles < 1) {
    throw Error('recursiveCycles must be a positive integer');
  }
  if (recursiveCycles === 1) return proveRecordedN1Compiled(compiled);
  return proveRecordedStableN1Compiled(compiled, recursiveCycles - 2);
}

async function proveRecordedN2Compiled(
  first: Pick<RecordedCompiledCircuit, 'circuit' | 'witness'>,
  second: Pick<RecordedCompiledCircuit, 'circuit' | 'witness'>,
  appState: Field[] | string[]
): Promise<RecordedN2ProofResult> {
  let native = await rustPicklesBindings();
  if (!native.rust_pickles_prove_recorded_n2) {
    throw Error('@o1js/native does not expose rust_pickles_prove_recorded_n2 — rebuild it.');
  }
  let circuitJson = circuitJsonOf(first);
  if (circuitJsonOf(second) !== circuitJson) {
    throw Error('proveRecordedN2 expects both executions to record the same circuit shape');
  }
  return JSON.parse(
    await runRustPickles(() =>
      native.rust_pickles_prove_recorded_n2!(
        circuitJson,
        first.witness,
        second.witness,
        appStateToDecimal(appState)
      )
    )
  );
}

/**
 * Records a circuit once and returns a reusable compile/prove/verify facade.
 * This avoids re-running the o1js recorder when trying base/N1/stable/N2
 * proving variants for the same witness.
 */
async function compileRecorded(
  f: () => Field[] | Promise<Field[]>,
  cache: Cache = Cache.FileSystemDefault,
  proofsVerified: 0 | 1 | 2 = 0
): Promise<RecordedCompiledCircuit> {
  let recorded = await recordCircuit(f, { validateWitness: false });
  return compileRecordedEnvelope(recorded, cache, proofsVerified);
}

async function compileRecordedProgram(
  branches: {
    circuit: () => Field[] | Promise<Field[]>;
    proofsVerified: 0 | 1 | 2;
  }[],
  cache: Cache = Cache.FileSystemDefault
): Promise<RecordedCompiledCircuit[]> {
  let recorded: Awaited<ReturnType<typeof recordCircuit>>[] = [];
  for (let branch of branches) {
    recorded.push(await recordCircuit(branch.circuit, { validateWitness: false }));
  }
  if (!useMinaRuntimeBackend()) {
    return Promise.all(
      recorded.map((entry, i) => compileRecordedEnvelope(entry, cache, branches[i].proofsVerified))
    );
  }
  let client = await minaRuntimeClient();
  let compiled = client.compileProgram(
    recorded.map((entry, i) => ({
      circuit: entry.circuit,
      witness: entry.witness,
      proofsVerified: branches[i].proofsVerified,
    }))
  );
  return Promise.all(
    recorded.map((entry, i) =>
      compileRecordedEnvelope(entry, cache, branches[i].proofsVerified, {
        client,
        circuitId: compiled.branches[i].circuitId,
        verificationKey:
          compiled.branches[i].verificationKeyBase64 !== undefined &&
          compiled.branches[i].verificationKeyHash !== undefined
            ? {
                data: compiled.branches[i].verificationKeyBase64!,
                hash: compiled.branches[i].verificationKeyHash!,
              }
            : undefined,
      })
    )
  );
}

async function compileRecordedEnvelope(
  recorded: Awaited<ReturnType<typeof recordCircuit>>,
  cache: Cache,
  proofsVerified: 0 | 1 | 2,
  precompiledRuntime?: MinaRuntimeCompiled
): Promise<RecordedCompiledCircuit> {
  let minaRuntime: MinaRuntimeCompiled | undefined;
  let directRust: DirectRustCompiled | undefined;
  if (precompiledRuntime !== undefined) {
    minaRuntime = precompiledRuntime;
  } else if (useMinaRuntimeBackend()) {
    let client = await minaRuntimeClient();
    let compiledCircuit = client.compileCircuit(recorded.circuit, recorded.witness, proofsVerified);
    minaRuntime = {
      client,
      circuitId: compiledCircuit.circuitId,
      verificationKey:
        compiledCircuit.verificationKeyBase64 !== undefined &&
        compiledCircuit.verificationKeyHash !== undefined
          ? {
              data: compiledCircuit.verificationKeyBase64,
              hash: compiledCircuit.verificationKeyHash,
            }
          : undefined,
    };
  } else {
    let bindings = await rustPicklesBindings();
    if (!bindings.rust_pickles_compile_recorded_base) {
      throw Error('Rust Pickles bindings do not expose reusable compiled indexes.');
    }
    let circuitJson = JSON.stringify(recorded.circuit);
    let witnessBytes = fpWitnessToBytes(recorded.witness);
    let cacheKey = bindings.rust_pickles_recorded_base_cache_key?.(circuitJson);
    let cacheHeader =
      cacheKey === undefined
        ? undefined
        : withVersion({
            kind: 'step-pk',
            persistentId: cacheKey,
            uniqueId: cacheKey,
            dataType: 'bytes',
            programName: 'rust-pickles-recorded',
            methodName: cacheKey,
            methodIndex: 0,
            hash: cacheKey,
          } as Omit<CacheHeader, 'version'>);
    let handle: unknown | undefined;
    let restoredFromCache = false;
    let cachedBytes = cacheHeader === undefined ? undefined : readCache(cache, cacheHeader);
    if (cachedBytes !== undefined && bindings.rust_pickles_compile_recorded_base_from_cache_bytes) {
      try {
        handle = await runRustPickles(() =>
          bindings.rust_pickles_compile_recorded_base_from_cache_bytes!(
            circuitJson,
            witnessBytes,
            cachedBytes
          )
        );
        restoredFromCache = true;
      } catch {
        // Invalid cache data is only a miss. Rust compares the complete
        // reconstructed constraint system before accepting an index.
      }
    }
    handle ??= await runRustPickles(() =>
      bindings.rust_pickles_compile_recorded_base_bytes
        ? bindings.rust_pickles_compile_recorded_base_bytes(circuitJson, witnessBytes)
        : bindings.rust_pickles_compile_recorded_base!(circuitJson, recorded.witness)
    );
    if (
      !restoredFromCache &&
      cache.canWrite &&
      cacheHeader !== undefined &&
      bindings.rust_pickles_recorded_base_cache_bytes
    ) {
      writeCache(cache, cacheHeader, bindings.rust_pickles_recorded_base_cache_bytes(handle));
    }
    let direct: DirectRustCompiled = { bindings, handle };
    if (bindings.rust_pickles_recorded_base_vk_envelope !== undefined) {
      let envelope = JSON.parse(bindings.rust_pickles_recorded_base_vk_envelope(handle)) as {
        base64: string;
        hash: string;
      };
      direct.verificationKey = { data: envelope.base64, hash: envelope.hash };
    }
    if (proofsVerified > 0) {
      // Prefer the proof-free donor template (no prover runs at compile time;
      // proven index-equivalent in pickles). Fall back to proving one.
      let proveTemplate =
        bindings.rust_pickles_recorded_base_donor_handle_bytes ??
        bindings.rust_pickles_prove_recorded_base_keep_compiled_bytes;
      if (proveTemplate === undefined) {
        throw Error('Rust Pickles bindings cannot synthesize the compile-time proof template.');
      }
      let template = await runRustPickles(() => proveTemplate(handle, witnessBytes));
      try {
        if (proofsVerified === 1) {
          let compileN1 = bindings.rust_pickles_compile_recorded_n1_bytes;
          if (compileN1 === undefined) throw Error('Rust Pickles bindings lack eager N1 compile.');
          direct.n1Handle = await runRustPickles(() =>
            compileN1(template, circuitJson, witnessBytes)
          );
        } else {
          let compileN2 = bindings.rust_pickles_compile_recorded_n2_bytes;
          if (compileN2 === undefined) throw Error('Rust Pickles bindings lack eager N2 compile.');
          direct.n2Handle = await runRustPickles(() =>
            compileN2(template, template, circuitJson, witnessBytes)
          );
        }
      } finally {
        (template as { free?: () => void }).free?.();
      }
    }
    directRust = direct;
  }
  let compiled: RecordedCompiledCircuit & {
    minaRuntime?: MinaRuntimeCompiled;
    directRust?: DirectRustCompiled;
  } = {
    ...recorded,
    verificationKey: directRust?.verificationKey ?? minaRuntime?.verificationKey,
    minaRuntime,
    directRust,
    proveBaseCase: () => proveRecordedBaseCaseCompiled(compiled),
    proveBaseCaseWithWitness: (witness) => proveRecordedBaseCaseCompiled({ ...compiled, witness }),
    proveBaseCaseKeep: () => proveRecordedBaseCaseKeepCompiled(compiled),
    proveBaseCaseKeepWithWitness: (witness) =>
      proveRecordedBaseCaseKeepCompiled({ ...compiled, witness }),
    proveN1OverWithWitness: (previous, witness) =>
      proveRecordedN1OverCompiled(previous, { ...compiled, witness }),
    proveN1OverKeepWithWitness: (previous, witness) =>
      proveRecordedN1OverKeepCompiled(previous, { ...compiled, witness }),
    proveN2OverWithWitness: (first, second, witness) =>
      proveRecordedN2OverCompiled(first, second, { ...compiled, witness }),
    proveN1: () => proveRecordedN1Compiled(compiled),
    proveStableN1: (additionalStableCycles = 0) =>
      proveRecordedStableN1Compiled(compiled, additionalStableCycles),
    proveN: (recursiveCycles: number) => proveRecordedNCompiled(compiled, recursiveCycles),
    proveN2With: (second: RecordedCompiledCircuit, appState: Field[] | string[]) =>
      proveRecordedN2Compiled(compiled, second, appState),
    verifyBaseCase: verifyRecordedBaseCase,
    verifyN1: verifyRecordedN1,
    verifyN2: verifyRecordedN2,
    dispose() {
      if (compiled.minaRuntime !== undefined) {
        compiled.minaRuntime.client.dropCircuit(compiled.minaRuntime.circuitId);
        compiled.minaRuntime = undefined;
      }
      if (compiled.directRust !== undefined) {
        (compiled.directRust.n1Handle as { free?: () => void } | undefined)?.free?.();
        (compiled.directRust.n2Handle as { free?: () => void } | undefined)?.free?.();
        let disposable = compiled.directRust.handle as { free?: () => void };
        disposable.free?.();
        compiled.directRust = undefined;
      }
    },
  };
  return compiled;
}

async function compileRecordedN1Over(
  previous: RecordedBaseProofHandle,
  f: () => Field[] | Promise<Field[]>
): Promise<RecordedCompiledN1Circuit> {
  let recorded = await recordCircuit(f, { validateWitness: false });
  if (isMinaRuntimeBaseHandle(previous.handle)) {
    let { client } = previous.handle;
    let { circuitId } = client.compileCircuit(recorded.circuit, recorded.witness, 1);
    let minaRuntime = { client, circuitId };
    let compiled: RecordedCompiledN1Circuit = {
      ...recorded,
      prove: () => compiled.proveWithWitness(compiled.witness),
      proveWithWitness: (witness) =>
        proveRecordedN1OverCompiled(previous, { ...recorded, witness, minaRuntime }),
      dispose: () => client.dropCircuit(circuitId),
    };
    return compiled;
  }
  let bindings = await rustPicklesBindings();
  if (
    !bindings.rust_pickles_compile_recorded_n1 ||
    !bindings.rust_pickles_prove_recorded_n1_compiled
  ) {
    throw Error('Rust Pickles bindings do not expose reusable compiled N1 indexes.');
  }
  let circuitJson = JSON.stringify(recorded.circuit);
  let handle = await runRustPickles(() =>
    bindings.rust_pickles_compile_recorded_n1_bytes
      ? bindings.rust_pickles_compile_recorded_n1_bytes(
          previous.handle,
          circuitJson,
          fpWitnessToBytes(recorded.witness)
        )
      : bindings.rust_pickles_compile_recorded_n1!(previous.handle, circuitJson, recorded.witness)
  );
  let compiled: RecordedCompiledN1Circuit = {
    ...recorded,
    prove: () => compiled.proveWithWitness(compiled.witness),
    async proveWithWitness(witness) {
      return JSON.parse(
        await runRustPickles(() =>
          bindings.rust_pickles_prove_recorded_n1_compiled_bytes
            ? bindings.rust_pickles_prove_recorded_n1_compiled_bytes(
                handle,
                previous.handle,
                fpWitnessToBytes(witness)
              )
            : bindings.rust_pickles_prove_recorded_n1_compiled!(handle, previous.handle, witness)
        )
      );
    },
    dispose() {
      (handle as { free?: () => void }).free?.();
    },
  };
  return compiled;
}

/** Records `f` and proves it through the Rust base-case Pickles pipeline. */
async function proveRecordedBaseCase(
  f: () => Field[] | Promise<Field[]>
): Promise<RecordedProofResult> {
  return proveRecordedBaseCaseCompiled(await recordCircuit(f));
}

/**
 * Records `f` and proves it through the Rust base-case pipeline, keeping the
 * full proof alive in native memory so {@link proveRecordedN1Over} can later
 * recursively verify it (the ZkProgram `SelfProof` shape).
 */
async function proveRecordedBaseCaseKeep(
  f: () => Field[] | Promise<Field[]>
): Promise<RecordedBaseProofHandle> {
  return proveRecordedBaseCaseKeepCompiled(await recordCircuit(f));
}

/**
 * Records `f` as a *new* circuit and proves one recursive (N1) Pickles cycle
 * whose step runs it while verifying the kept base proof. The resulting
 * digest binds the new circuit's `appState` together with the verified
 * proof's accumulator — verify with {@link verifyRecordedN1}.
 */
async function proveRecordedN1Over(
  previous: RecordedBaseProofHandle,
  f: () => Field[] | Promise<Field[]>
): Promise<RecordedN1ProofResult> {
  let { circuit, witness } = await recordCircuit(f);
  return proveRecordedN1OverCompiled(previous, { circuit, witness });
}

/** Records `f` and proves it plus one recursive (N1) Pickles cycle. */
async function proveRecordedN1(
  f: () => Field[] | Promise<Field[]>
): Promise<RecordedN1ProofResult> {
  return proveRecordedN1Compiled(await recordCircuit(f));
}

/**
 * Records `f` and proves it through the stable same-field N1 recursion loop.
 * `additionalStableCycles = 0` means two recursive cycles after the base
 * proof; each increment adds one more stable recursive cycle.
 */
async function proveRecordedStableN1(
  f: () => Field[] | Promise<Field[]>,
  additionalStableCycles = 0
): Promise<RecordedStableN1ProofResult> {
  return proveRecordedStableN1Compiled(await recordCircuit(f), additionalStableCycles);
}

/**
 * Records `f` and proves it with `recursiveCycles` recursive Pickles cycles
 * after the base proof. `1` uses the existing N1 path; `2+` uses the stable
 * same-field recursion loop.
 */
async function proveRecordedN(
  f: () => Field[] | Promise<Field[]>,
  recursiveCycles: number
): Promise<RecordedN1ProofResult | RecordedStableN1ProofResult> {
  return proveRecordedNCompiled(await recordCircuit(f), recursiveCycles);
}

/**
 * Records the same circuit twice with two witnesses and proves a true
 * width-2 (`N2`) recursive Pickles step over both base proofs. `appState` is
 * the public state bound by the N2 digest; this low-level API does not derive
 * an aggregation relation from the two previous app states.
 */
async function proveRecordedN2(
  first: () => Field[] | Promise<Field[]>,
  second: () => Field[] | Promise<Field[]>,
  appState: Field[] | string[]
): Promise<RecordedN2ProofResult> {
  return proveRecordedN2Compiled(await recordCircuit(first), await recordCircuit(second), appState);
}

/** Verifies a base-case recorded proof standalone against its embedded side-loaded key. */
async function verifyRecordedBaseCase(result: RecordedProofResult): Promise<boolean> {
  if (useMinaRuntimeBackend()) {
    return verifyRecordedBaseCaseViaMinaRuntime(result);
  }
  let native = await rustPicklesBindings();
  if (!native.rust_pickles_verify_side_loaded) {
    throw Error('@o1js/native does not expose rust_pickles_verify_side_loaded — rebuild it.');
  }
  return runRustPickles(() =>
    native.rust_pickles_verify_side_loaded!(result.appState, [], [], JSON.stringify(result.proof))
  );
}

async function verifyRecordedBaseCaseViaMinaRuntime(result: RecordedProofResult): Promise<boolean> {
  let verified = await (
    await minaRuntimeClient()
  ).verifyProof(result.appState, result.proof as RustProofResponse['proof']);
  return verified.valid;
}

async function verifyRecordedProofViaMinaRuntime(
  result: RecordedProofResult | RecordedN1ProofResult | RecordedN2ProofResult
): Promise<boolean> {
  if ('challengePolynomialCommitments' in result) {
    let verified = await (
      await minaRuntimeClient()
    ).verifyRecursiveProof(result as RecursiveN2ProofResponse);
    return verified.valid;
  }
  if ('challengePolynomialCommitment' in result) {
    let verified = await (
      await minaRuntimeClient()
    ).verifyRecursiveProof(result as RecursiveProofResponse);
    return verified.valid;
  }
  return verifyRecordedBaseCaseViaMinaRuntime(result);
}

/** Verifies an N2 recorded proof standalone, binding both recursion messages. */
async function verifyRecordedN2(result: RecordedN2ProofResult): Promise<boolean> {
  let native = await rustPicklesBindings();
  if (!native.rust_pickles_verify_side_loaded_with_step_vk) {
    throw Error(
      '@o1js/native does not expose rust_pickles_verify_side_loaded_with_step_vk — rebuild it.'
    );
  }
  return runRustPickles(() =>
    native.rust_pickles_verify_side_loaded_with_step_vk!(
      result.appState,
      result.dlogPlonkIndex,
      result.challengePolynomialCommitments,
      result.oldBulletproofChallenges,
      JSON.stringify(result.proof)
    )
  );
}

/** Verifies an N1 recorded proof standalone, binding its recursion messages. */
async function verifyRecordedN1(result: RecordedN1ProofResult): Promise<boolean> {
  let native = await rustPicklesBindings();
  if (!native.rust_pickles_verify_side_loaded_with_step_vk) {
    throw Error(
      '@o1js/native does not expose rust_pickles_verify_side_loaded_with_step_vk — rebuild it.'
    );
  }
  return runRustPickles(() =>
    native.rust_pickles_verify_side_loaded_with_step_vk!(
      result.appState,
      result.dlogPlonkIndex,
      [result.challengePolynomialCommitment],
      [result.oldBulletproofChallenges],
      JSON.stringify(result.proof)
    )
  );
}
