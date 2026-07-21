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
import { existsOne } from '../provable/core/exists.js';
import { setAllowEmptyUnconstrained } from '../provable/types/unconstrained.js';
import { Fp } from '../../bindings/crypto/finite-field.js';
import { poseidonParamsKimchiFp } from '../../bindings/crypto/constants.js';
import { snarkContext } from '../provable/core/provable-context.js';
import type { Field } from '../provable/field.js';
import { Cache, readCache, withVersion, writeCache, type CacheHeader } from './cache.js';

export {
  compileRecorded,
  declareRecordedPreviousState,
  declareRecordedPreviousProofWidths,
  declareRecordedSideLoadedVks,
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
  | {
      kind: 'endoscalar';
      input: RecordedLinCombJson;
      output: RecordedLinCombJson;
      num_bits: number;
    }
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
  | { kind: 'side_loaded_vk'; proof: number; vk_hash: RecordedLinCombJson }
  | {
      kind: 'lookup';
      row: RecordedLinCombJson[];
    }
  | { kind: 'xor16'; row: RecordedLinCombJson[] }
  | { kind: 'rot64'; row: RecordedLinCombJson[]; two_to_rot: string }
  | { kind: 'raw'; gate_type: number; row: RecordedLinCombJson[]; coeffs: string[] }
  | { kind: 'foreign_field_add'; row: RecordedLinCombJson[]; coeffs: string[] }
  | {
      kind: 'foreign_field_mul';
      curr: RecordedLinCombJson[];
      next: RecordedLinCombJson[];
      coeffs: string[];
    }
  | {
      kind: 'ec_scale';
      rounds: {
        accs: [RecordedLinCombJson, RecordedLinCombJson][];
        bits: RecordedLinCombJson[];
        ss: RecordedLinCombJson[];
        base: [RecordedLinCombJson, RecordedLinCombJson];
        n_prev: RecordedLinCombJson;
        n_next: RecordedLinCombJson;
      }[];
    };

type RecordedCircuitJson = {
  aux_count: number;
  output: RecordedLinCombJson[];
  constraints: RecordedConstraintJson[];
  /** `[denseIndex, prevStateFlatIndex]` pairs binding auxiliary slots to the
   * previous proofs' statement fields. OCaml hands the SAME cvars to the
   * rule's main and to the verification machinery; the Rust replay uses
   * these bindings to reuse the pre-witnessed statement vars instead of
   * allocating value-equal copies (which would split permutation classes). */
  previous_state_slots: [number, number][];
  /** Per previous proof (logical order), the verified proof's own program
   * width — OCaml's per-tag `max_proofs_verified` (a DynamicProof's declared
   * bound, a SelfProof's own program width). */
  previous_proof_widths?: number[];
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
  /** Shared-wrap program: every branch proves through ONE compiled program. */
  program?: unknown;
  branchIndex?: number;
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
const unsupportedGates = ['ecScale', 'ecEndoscale', 'ecEndoscalar'] as const;

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

/**
 * True while recording a structure-only (compile) pass: the circuit runs in
 * constraint-system mode so witness callbacks (async fetches, `this.sender`,
 * state-dependent asserts, `Unconstrained` reads) never execute. Only the
 * constraint structure is captured, which is all the VK depends on.
 */
let structureOnlyPass = false;

class CircuitRecorder {
  /** jsoo variable index -> dense recorded index */
  varIndex = new Map<number, number>();
  /** witness values, in dense allocation order (decimal strings) */
  witness: string[] = [];
  constraints: RecordedConstraintJson[] = [];

  private readVarValue(jsooIndex: number): string {
    // A structure-only compile pass runs in constraint-system mode with no
    // witness, so there is no value to read. The VK depends only on the
    // circuit structure (verified: zeroing the witness leaves the VK
    // unchanged), so a dummy 0 is sound here.
    if (structureOnlyPass) return '0';
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
      // NOTE: some gadgets (e.g. foreign-field `assertLessThan` reached through
      // `Group.scale` -> `isOddAndHigh`) push constraints AFTER this point, so
      // `aux_count` is finalized by the caller once all lc's have run.
      aux_count: this.witness.length,
      output,
      constraints: this.constraints,
      previous_state_slots: [],
    };
  }
}

let recordedPreviousStateFields: Field[] | undefined;
let recordedSideLoadedVks: { proof: number; vkHash: Field }[] | undefined;
let recordedPreviousProofWidths: number[] | undefined;

/**
 * Declares the previous proofs' own program widths (OCaml per-tag
 * `max_proofs_verified`) for the recording in progress. Recorded into the
 * circuit by BOTH the compile and the prove re-recording, so the shape
 * comparison stays stable.
 */
function declareRecordedPreviousProofWidths(widths: number[]) {
  recordedPreviousProofWidths = widths;
}

/**
 * Declares the side-loaded verification keys used by `DynamicProof.verify`
 * in the recording in progress (one entry per dynamic previous proof, in
 * logical order). The recorder appends `side_loaded_vk` marker constraints
 * at the position OCaml emits the key witness + digest gadget (after the
 * method body), and the Rust replay expands them faithfully.
 */
function declareRecordedSideLoadedVks(vks: { proof: number; vkHash: Field }[]) {
  recordedSideLoadedVks = vks;
}

/**
 * Declares the previous proofs' statement fields (flattened, in proof order)
 * for the recording in progress. The recorder translates their variable ids
 * into dense auxiliary indices and emits them as `previous_state_slots`, so
 * the Rust replay can bind those slots to the machinery's pre-witnessed
 * statement vars — OCaml passes the same cvars to the rule's main.
 */
function declareRecordedPreviousState(fields: Field[]) {
  recordedPreviousStateFields = fields;
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
  // Loaded lazily (proof-system -> provable would be a static import cycle);
  // by the time the circuit runs these are fully initialized.
  const { Field } = await import('../provable/field.js');
  const { Bool } = await import('../provable/bool.js');
  const { Provable } = await import('../provable/provable.js');
  let recorder = new CircuitRecorder();
  recordedPreviousStateFields = undefined;
  recordedSideLoadedVks = undefined;
  recordedPreviousProofWidths = undefined;

  let field = Snarky.field;
  let gates = Snarky.gates;
  let originalTruncateToBits16 = (
    field as unknown as {
      truncateToBits16: (lengthDiv16: number, x: FieldVar) => FieldVar;
    }
  ).truncateToBits16;
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
    xor: gates.xor,
    rotate: gates.rotate,
    raw: gates.raw,
    foreignFieldAdd: gates.foreignFieldAdd,
    foreignFieldMul: gates.foreignFieldMul,
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
  // `Snarky.field.truncateToBits16` (OCaml `Scalar_challenge.to_field_checked'`,
  // used by every UInt range check) emits `EndoMulScalar` rows entirely in
  // OCaml — invisible to the gate hooks above. Always run the original to get
  // the recomposed value the circuit consumes, and record an `endoscalar`
  // constraint the rust backend re-emits (so recorded SmartContracts match
  // jsoo's Step circuit instead of silently dropping these rows).
  (
    field as unknown as {
      truncateToBits16: (lengthDiv16: number, x: FieldVar) => FieldVar;
    }
  ).truncateToBits16 = (lengthDiv16, x) => {
    let result = originalTruncateToBits16.call(field, lengthDiv16, x);
    recorder.constraints.push({
      kind: 'endoscalar',
      input: recorder.lc(x),
      output: recorder.lc(result),
      num_bits: lengthDiv16 * 16,
    });
    return result;
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

  // `Poseidon.hash`/`hashWithPrefix` go through `Snarky.poseidon.update`,
  // whose gate emission happens INSIDE OCaml — invisible to the
  // `gates.poseidon` hook above. Record the permutation ourselves: witness
  // every round state (as OCaml `block_cipher` does) and emit the recorded
  // `poseidon` constraint; the kimchi layout chunks the 55 pre-round states
  // into 11 Poseidon rows plus the final Zero output row
  // (snarky constraint_system.rs Poseidon2).
  // Dense witness indices must follow ALLOCATION order (jsoo variable
  // order), not first-appearance-in-a-constraint order: `reduce_lincom`
  // sorts terms by variable index, so a var witnessed early but constrained
  // late would otherwise land in the wrong operand slot (observed as
  // swapped l/r in the sponge absorb adds). Register every fresh var at
  // allocation.
  let run = Snarky.run as unknown as {
    enterAsProver: (size: number) => (values: unknown) => unknown;
  };
  let originalEnterAsProver = run.enterAsProver;
  run.enterAsProver = (size: number) => {
    let finish = originalEnterAsProver.call(run, size);
    return (values: unknown) => {
      let fieldVars = finish(values);
      for (let v of mlArrayToArray<FieldVar>(
        fieldVars as { length: number; [index: number]: FieldVar }
      )) {
        recorder.lc(v);
      }
      return fieldVars;
    };
  };

  let poseidonApi = Snarky.poseidon as {
    update: (state: unknown, input: unknown) => unknown;
    hashToGroup: (input: unknown) => unknown;
    sponge: {
      create: (isChecked: unknown) => unknown;
      absorb: (sponge: unknown, x: unknown) => unknown;
      squeeze: (sponge: unknown) => unknown;
    };
  };
  let originalPoseidon = {
    update: poseidonApi.update,
    hashToGroup: poseidonApi.hashToGroup,
    spongeCreate: poseidonApi.sponge.create,
    spongeAbsorb: poseidonApi.sponge.absorb,
    spongeSqueeze: poseidonApi.sponge.squeeze,
  };
  const POSEIDON_RATE = 2;
  let poseidonRc = poseidonParamsKimchiFp.roundConstants.map((row) => row.map(BigInt));
  let poseidonMds = poseidonParamsKimchiFp.mds.map((row) => row.map(BigInt));
  let poseidonRounds = poseidonParamsKimchiFp.fullRounds;
  let readVarBigint = (x: FieldVar): bigint => {
    // Structure-only compile: no witness, so intermediate poseidon states
    // cannot (and need not) be computed. The gate's variable layout is still
    // allocated below, which is all the VK depends on.
    if (structureOnlyPass) return 0n;
    let value: bigint | undefined;
    Snarky.run.asProver(() => {
      value = FieldConst.toBigint(Snarky.field.readVar(x));
    });
    if (value === undefined) {
      throw Error('Rust Pickles recorder: could not read a poseidon input value');
    }
    return value;
  };
  let poseidonSbox = (x: bigint) => {
    let x2 = Fp.mul(x, x);
    let x4 = Fp.mul(x2, x2);
    return Fp.mul(Fp.mul(x4, x2), x);
  };
  let recordPermutation = (state: FieldVar[]): FieldVar[] => {
    let values = state.map(readVarBigint);
    let stateRows = [state.map((x) => recorder.lc(x))];
    let current = values;
    let outVars: FieldVar[] = [];
    for (let round = 0; round < poseidonRounds; round++) {
      let old = current.map(poseidonSbox);
      current = poseidonMds.map((row, i) =>
        Fp.add(
          row.reduce((acc, m, j) => Fp.add(acc, Fp.mul(m, old[j])), 0n),
          poseidonRc[round][i]
        )
      );
      let snapshot = current;
      let vars = snapshot.map((v) => existsOne(() => v).value as FieldVar);
      if (round < poseidonRounds - 1) stateRows.push(vars.map((x) => recorder.lc(x)));
      else outVars = vars;
    }
    recorder.constraints.push({
      kind: 'poseidon',
      states: stateRows,
      last: outVars.map((x) => recorder.lc(x)),
    });
    return outVars;
  };
  poseidonApi.update = (mlState: unknown, mlInput: unknown) => {
    let state = fieldVarsFromMlArray('poseidon.update.state', mlState, 3);
    let input = fieldVarsFromMlArray('poseidon.update.input', mlInput);
    if (input.length === 0) {
      state = recordPermutation(state);
    } else {
      let padded = input.slice();
      while (padded.length % POSEIDON_RATE !== 0) padded.push(FieldVar.constant(0n));
      for (let block = 0; block < padded.length; block += POSEIDON_RATE) {
        for (let i = 0; i < POSEIDON_RATE; i++) {
          state[i] = FieldVar.add(state[i], padded[block + i]);
        }
        state = recordPermutation(state);
      }
    }
    return [0, ...state];
  };
  // Group map non-residue: the smallest i >= 2 that is not a square in Fp
  // (OCaml `Aux.non_residue`).
  let groupMapNonResidue = (() => {
    let i = 2n;
    while (Fp.isSquare(i)) i += 1n;
    return i;
  })();
  // Reimplements `Poseidon.hashToGroup` (snarky_bindings `hash_to_group` =
  // `Random_oracle.Checked.hash` + `Group_map.Checked.to_group`) via the hooked
  // primitives, so the app-circuit constraints are recorded. Group-map algorithm
  // = checked_map.ml `wrap` + the Pallas conic map (elliptic-curve.ts).
  poseidonApi.hashToGroup = (mlInput: unknown) => {
    let inputVars = fieldVarsFromMlArray('hashToGroup.input', mlInput);
    // hash = Poseidon.hash(input) = update([0,0,0], input).state[0]
    let zero = () => FieldVar.constant(0n);
    let updated = poseidonApi.update(
      [0, zero(), zero(), zero()],
      [0, ...inputVars]
    ) as [number, FieldVar, FieldVar, FieldVar];
    let t = new Field(updated[1]);

    // --- group map (checked_map.ml) ---
    const conic_c = 3n;
    const z0 = 12196889842669319921865617096620076994180062626450149327690483414064673774441n;
    const y0 = 1n; // projection_point.y
    const u = 2n;
    const u_over_2 = 1n;
    const bParam = 5n; // spec.b (a = 0)
    const m = groupMapNonResidue;

    // field_to_conic(t): OCaml `s = of_int 2 * ((ct*y0)+z0) / ((ct*t)+one)`
    // is left-associative => `s = (2 * numInner) / denom` (scale numerator
    // BEFORE the divide, so the constant 2 folds into the numerator lincom).
    let ct = t.mul(conic_c);
    let numInner = ct.mul(y0).add(z0);
    let denom = ct.mul(t).add(1n);
    let s = numInner.mul(2n).div(denom);
    let conic_z = Field.from(z0).sub(s);
    let conic_y = Field.from(y0).sub(s.mul(t));
    // conic_to_s(conic)
    let dd = conic_z.div(conic_y);
    let v = dd.sub(u_over_2);
    // sToVTruncated: x1 = v, x2 = -(u+v), x3 = u + y^2. OCaml `u + (y*y)` uses a
    // plain Field mul (Generic gate), NOT `Field.square` (which would emit a
    // dedicated Square gate and drop this term out of the Generic stream).
    let x1 = v;
    let x2 = v.add(u).neg();
    let x3 = conic_y.mul(conic_y).add(u);

    // y_squared(x) = x^3 + b, then sqrt_flagged
    let ySquared = (x: InstanceType<typeof Field>) => x.mul(x).mul(x).add(bParam);
    let sqrtFlagged = (ysq: InstanceType<typeof Field>): [InstanceType<typeof Field>, InstanceType<typeof Bool>] => {
      // OCaml `sqrt_exn (Field.if_ is_square ~then_:ysq ~else_:(scale ysq m))`:
      // a SINGLE R1CS `assert_r1cs is_square (ysq - m*ysq) (z - m*ysq)`. Routing
      // through Snarky.field.assertMul (recorded as `r1cs`) makes the rust
      // reduce_lincom seal `(z - m*ysq)` EXACTLY like OCaml's plonk_constraint_
      // system (o1js `Provable.if` instead seals `z` itself, an equivalent but
      // opposite-signed layout). Values are read only inside witness callbacks.
      let isSquare = Provable.witness(Bool, () => new Bool(Fp.isSquare(ysq.toBigInt())));
      let elseV = ysq.mul(m);
      let z = Provable.witness(Field, () => {
        let v = ysq.toBigInt();
        return Field.from(Fp.isSquare(v) ? v : Fp.mul(m, v));
      });
      Snarky.field.assertMul(isSquare.value, ysq.sub(elseV).value, z.sub(elseV).value);
      let y = Provable.witness(Field, () => Field.from(Fp.sqrt(z.toBigInt()) ?? 0n));
      Snarky.field.assertSquare(y.value, z.value);
      return [y, isSquare];
    };
    // sqrt_flagged is emitted for branch 1, then 2, then 3 (x3 processed last).
    let [y1, b1] = sqrtFlagged(ySquared(x1));
    let [y2, b2] = sqrtFlagged(ySquared(x2));
    let [y3, b3] = sqrtFlagged(ySquared(x3));
    // OCaml `Boolean.Assert.any [b1;b2;b3]` = `assert_non_zero (b1+b2+b3)` =
    // ONE constraint `numTrue * inv = 1` (not an or-chain + assertTrue). Use the
    // raw lincom + existsOne (no seal), matching OCaml `exists`.
    let numTrue = FieldVar.add(FieldVar.add(b1.value, b2.value), b3.value);
    let invTrue = existsOne(() => {
      let n = readVarBigint(numTrue);
      return n === 0n ? 0n : Fp.inverse(n) ?? 0n;
    }).value;
    Snarky.field.assertMul(numTrue, invTrue, FieldVar.constant(1n));
    // x1_is_first = b1, x2_is_first = (not b1) && b2, x3_is_first = (not b1) &&
    // (not b2) && b3 — the flag AND-bindings are emitted left-to-right (x1,x2,x3).
    let x1f = b1.toField();
    let x2f = b1.not().and(b2).toField();
    // OCaml `&&` is RIGHT-associative: `(not b1) && (not b2) && b3` parses as
    // `(not b1) && ((not b2) && b3)`, which interleaves the not-seal and the AND
    // (LIN,MUL,LIN,MUL) instead of grouping them (LIN,LIN,MUL,MUL).
    let x3f = b1.not().and(b2.not().and(b3)).toField();
    // The result tuple `(gx, gy)` is evaluated right-to-left (gy first), and each
    // sum `a*x1 + b*x2 + c*x3` right-to-left (x3 term first).
    let gy = x3f.mul(y3).add(x2f.mul(y2)).add(x1f.mul(y1));
    let gx = x3f.mul(x3).add(x2f.mul(x2)).add(x1f.mul(x1));
    return [0, gx.value, gy.value];
  };
  poseidonApi.sponge.create = () => {
    throw Error('Rust Pickles recorder: Poseidon.Sponge is not supported yet');
  };
  poseidonApi.sponge.absorb = () => {
    throw Error('Rust Pickles recorder: Poseidon.Sponge is not supported yet');
  };
  poseidonApi.sponge.squeeze = () => {
    throw Error('Rust Pickles recorder: Poseidon.Sponge is not supported yet');
  };

  // `Group.scale` (used by `Signature.verify`, side-loaded VK checks, ...) calls
  // the native `Snarky.group.scaleFastUnpack` = the VarBaseMul (`EcScale`)
  // gadget: computes `(2*s + 1 + 2^numBits) * P` and returns the proven LSB-first
  // bits of s. Port of pickles' `scale_fast_unpack` / `scale_fast_core`
  // (plonk_curve_ops.rs) so the rust backend re-emits the identical VarBaseMul
  // rows (the surrounding shift/edge-case TS in native-curve.ts is recorded
  // through the normal Field hooks).
  let groupApi = Snarky.group as {
    scaleFastUnpack: (P: unknown, shiftedValue: unknown, numBits: number) => unknown;
  };
  let originalScaleFastUnpack = groupApi.scaleFastUnpack;
  const BITS_PER_CHUNK = 5;
  let fpInv = (x: bigint) => Fp.inverse(x) ?? 0n;
  let sealFieldVar = (fv: FieldVar): FieldVar => new Field(fv).seal().value;
  // Records a kimchi `CompleteAdd` gate for p1 + p2 (handles doubling), in
  // OCaml add_fast's exists order (same_x, inf_z, x21_inv, slope, x3, y3), inf=0.
  let recordAddComplete = (
    p1: [FieldVar, FieldVar],
    p2: [FieldVar, FieldVar]
  ): { x: FieldVar; y: FieldVar } => {
    let w = () => {
      let x1 = readVarBigint(p1[0]);
      let y1 = readVarBigint(p1[1]);
      let x2 = readVarBigint(p2[0]);
      let y2 = readVarBigint(p2[1]);
      let sameX = x1 === x2;
      let x21Inv = sameX ? 0n : fpInv(Fp.sub(x2, x1));
      let slope = sameX
        ? Fp.mul(Fp.mul(Fp.mul(x1, x1), 3n), fpInv(Fp.add(y1, y1)))
        : Fp.mul(Fp.sub(y2, y1), x21Inv);
      let infZ = y1 === y2 ? 0n : sameX ? fpInv(Fp.sub(y1, y2)) : 0n;
      let x3 = Fp.sub(Fp.sub(Fp.square(slope), x1), x2);
      let y3 = Fp.sub(Fp.mul(slope, Fp.sub(x1, x3)), y1);
      return { sameX: sameX ? 1n : 0n, infZ, x21Inv, slope, x3, y3 };
    };
    let sameX = existsOne(() => w().sameX).value;
    let inf = FieldVar.constant(0n);
    let infZ = existsOne(() => w().infZ).value;
    let x21Inv = existsOne(() => w().x21Inv).value;
    let slope = existsOne(() => w().slope).value;
    let x3 = existsOne(() => w().x3).value;
    let y3 = existsOne(() => w().y3).value;
    recorder.constraints.push({
      kind: 'ec_add_complete',
      p1: [recorder.lc(p1[0]), recorder.lc(p1[1])],
      p2: [recorder.lc(p2[0]), recorder.lc(p2[1])],
      p3: [recorder.lc(x3), recorder.lc(y3)],
      inf: recorder.lc(inf),
      same_x: recorder.lc(sameX),
      slope: recorder.lc(slope),
      inf_z: recorder.lc(infZ),
      x21_inv: recorder.lc(x21Inv),
    });
    return { x: x3, y: y3 };
  };
  groupApi.scaleFastUnpack = (Pml, shiftedMl, numBits) => {
    let [baseXraw, baseYraw] = fieldVarsFromMlArray('scaleFastUnpack.P', Pml, 2);
    let [scalar] = fieldVarsFromMlArray('scaleFastUnpack.shifted', shiftedMl, 1);
    // witness the MSB-first bits of the scalar
    let bitVars: FieldVar[] = [];
    for (let i = 0; i < numBits; i++) {
      let idx = numBits - 1 - i;
      bitVars.push(existsOne(() => (readVarBigint(scalar) >> BigInt(idx)) & 1n).value);
    }
    // add_fast seals both points (y before x); base is used as both operands
    let yBase = sealFieldVar(baseYraw);
    let xBase = sealFieldVar(baseXraw);
    // acc = 2 * base
    let acc = recordAddComplete([xBase, yBase], [xBase, yBase]);
    let nAcc: FieldVar = FieldVar.constant(0n);
    let rounds: {
      accs: [RecordedLinCombJson, RecordedLinCombJson][];
      bits: RecordedLinCombJson[];
      ss: RecordedLinCombJson[];
      base: [RecordedLinCombJson, RecordedLinCombJson];
      n_prev: RecordedLinCombJson;
      n_next: RecordedLinCombJson;
    }[] = [];
    let chunks = numBits / BITS_PER_CHUNK;
    for (let chunk = 0; chunk < chunks; chunk++) {
      let bs = bitVars.slice(chunk * BITS_PER_CHUNK, (chunk + 1) * BITS_PER_CHUNK);
      let nAccPrev = nAcc;
      nAcc = existsOne(() => {
        let n = readVarBigint(nAccPrev);
        for (let b of bs) n = Fp.add(Fp.add(n, n), readVarBigint(b));
        return n;
      }).value;
      let accs: [FieldVar, FieldVar][] = [[acc.x, acc.y]];
      let slopes: FieldVar[] = [];
      for (let b of bs) {
        let xAcc = acc.x;
        let yAcc = acc.y;
        // acc' = 2*acc + (2b - 1)*base, via two slopes as in the VarBaseMul gate
        let s1 = existsOne(() => {
          let ya = readVarBigint(yAcc);
          let yb = readVarBigint(yBase);
          let bb = readVarBigint(b);
          let xa = readVarBigint(xAcc);
          let xb = readVarBigint(xBase);
          return Fp.mul(Fp.sub(ya, Fp.mul(yb, Fp.sub(Fp.add(bb, bb), 1n))), fpInv(Fp.sub(xa, xb)));
        }).value;
        let s1sq = existsOne(() => Fp.square(readVarBigint(s1))).value;
        let s2 = existsOne(() => {
          let ya = readVarBigint(yAcc);
          let xa = readVarBigint(xAcc);
          let xb = readVarBigint(xBase);
          let s1s = readVarBigint(s1sq);
          let s1v = readVarBigint(s1);
          return Fp.sub(
            Fp.mul(Fp.add(ya, ya), fpInv(Fp.sub(Fp.add(Fp.add(xa, xa), xb), s1s))),
            s1v
          );
        }).value;
        let xRes = existsOne(() => {
          let xb = readVarBigint(xBase);
          let s2v = readVarBigint(s2);
          let s1s = readVarBigint(s1sq);
          return Fp.sub(Fp.add(xb, Fp.square(s2v)), s1s);
        }).value;
        let yRes = existsOne(() => {
          let xa = readVarBigint(xAcc);
          let xr = readVarBigint(xRes);
          let s2v = readVarBigint(s2);
          let ya = readVarBigint(yAcc);
          return Fp.sub(Fp.mul(Fp.sub(xa, xr), s2v), ya);
        }).value;
        acc = { x: xRes, y: yRes };
        accs.push([acc.x, acc.y]);
        slopes.push(s1);
      }
      rounds.push({
        accs: accs.map(([x, y]) => [recorder.lc(x), recorder.lc(y)]),
        bits: bs.map((bb) => recorder.lc(bb)),
        ss: slopes.map((s) => recorder.lc(s)),
        base: [recorder.lc(xBase), recorder.lc(yBase)],
        n_prev: recorder.lc(nAccPrev),
        n_next: recorder.lc(nAcc),
      });
    }
    recorder.constraints.push({ kind: 'ec_scale', rounds });
    // the VarBaseMul gadget also constrains the recomposed scalar
    Snarky.field.assertEqual(nAcc, scalar);
    let bitsLsb = bitVars.slice().reverse();
    return [0, [0, acc.x, acc.y], [0, ...bitsLsb]];
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
  // Xor16 gate row: [in1, in2, out, in1_0..3, in2_0..3, out_0..3] (15 vars).
  gates.xor = (
    in1,
    in2,
    out,
    in1_0,
    in1_1,
    in1_2,
    in1_3,
    in2_0,
    in2_1,
    in2_2,
    in2_3,
    out0,
    out1,
    out2,
    out3
  ) => {
    let row = [
      in1, in2, out,
      in1_0, in1_1, in1_2, in1_3,
      in2_0, in2_1, in2_2, in2_3,
      out0, out1, out2, out3,
    ];
    recorder.constraints.push({ kind: 'xor16', row: row.map((cell) => recorder.lc(cell)) });
    return original.xor.call(
      gates,
      in1, in2, out,
      in1_0, in1_1, in1_2, in1_3,
      in2_0, in2_1, in2_2, in2_3,
      out0, out1, out2, out3
    );
  };
  // Rot64 gate row: [word, rotated, excess, bound_limb0..3, bound_crumb0..7]
  // (15 vars) + the 2^rot coefficient. `limbs`/`crumbs` arrive as MlArrays.
  gates.rotate = (field_, rotated, excess, limbs, crumbs, two_to_rot) => {
    let limbsArr = fieldVarsFromMlArray('rotate.limbs', limbs, 4);
    let crumbsArr = fieldVarsFromMlArray('rotate.crumbs', crumbs, 8);
    let row = [field_, rotated, excess, ...limbsArr, ...crumbsArr];
    recorder.constraints.push({
      kind: 'rot64',
      row: row.map((cell) => recorder.lc(cell)),
      two_to_rot: FieldConst.toBigint(two_to_rot).toString(),
    });
    return original.rotate.call(gates, field_, rotated, excess, limbs, crumbs, two_to_rot);
  };
  // Raw gate (o1js `Gates.raw`): an explicit KimchiGateType tag with its (padded
  // to 15) values and coefficients. Used e.g. for the trailing `Zero` row of an
  // XOR chain.
  gates.raw = (kind, values, coefficients) => {
    let row = fieldVarsFromMlArray('raw.values', values);
    let coeffs = mlArrayToArray<FieldConst>(
      coefficients as { length: number; [index: number]: FieldConst }
    );
    recorder.constraints.push({
      kind: 'raw',
      gate_type: kind as number,
      row: row.map((cell) => recorder.lc(cell)),
      coeffs: coeffs.map((c) => FieldConst.toBigint(c).toString()),
    });
    return original.raw.call(gates, kind, values, coefficients);
  };
  // ForeignFieldAdd row: [left0..2, right0..2, field_overflow, carry], coeffs
  // [modulus0..2, sign].
  gates.foreignFieldAdd = (left, right, overflow, carry, modulus, sign) => {
    let l = fieldVarsFromMlTuple('ffadd.left', left, 3);
    let r = fieldVarsFromMlTuple('ffadd.right', right, 3);
    let row = [...l, ...r, overflow, carry] as FieldVar[];
    let modArr = mlTupleToArray<FieldConst>(
      modulus as { length: number; [index: number]: FieldConst }
    );
    recorder.constraints.push({
      kind: 'foreign_field_add',
      row: row.map((cell) => recorder.lc(cell)),
      coeffs: [
        ...modArr.map((c) => FieldConst.toBigint(c).toString()),
        FieldConst.toBigint(sign as FieldConst).toString(),
      ],
    });
    return original.foreignFieldAdd.call(gates, left, right, overflow, carry, modulus, sign);
  };
  // ForeignFieldMul: current row + trailing Zero row, in the kimchi column
  // layout (plonk_constraint_system.ml). coeffs [modulus2, negModulus0..2].
  gates.foreignFieldMul = (
    left,
    right,
    remainder,
    quotient,
    quotientHiBound,
    product1,
    carry0,
    carry1p,
    carry1c,
    mod2,
    negMod
  ) => {
    let l = fieldVarsFromMlTuple('ffmul.left', left, 3);
    let r = fieldVarsFromMlTuple('ffmul.right', right, 3);
    let rem = fieldVarsFromMlTuple('ffmul.remainder', remainder, 2);
    let q = fieldVarsFromMlTuple('ffmul.quotient', quotient, 3);
    let p1 = fieldVarsFromMlTuple('ffmul.product1', product1, 3);
    let c1p = fieldVarsFromMlTuple('ffmul.carry1p', carry1p, 7);
    let c1c = fieldVarsFromMlTuple('ffmul.carry1c', carry1c, 4);
    let curr = [
      l[0], l[1], l[2], r[0], r[1], r[2], p1[0],
      c1p[0], c1p[1], c1p[2], c1p[3], c1c[0], c1c[1], c1c[2], c1c[3],
    ] as FieldVar[];
    let next = [
      rem[0], rem[1], q[0], q[1], q[2], quotientHiBound, p1[1], p1[2],
      c1p[4], c1p[5], c1p[6], carry0,
    ] as FieldVar[];
    recorder.constraints.push({
      kind: 'foreign_field_mul',
      curr: curr.map((cell) => recorder.lc(cell)),
      next: next.map((cell) => recorder.lc(cell)),
      coeffs: [
        FieldConst.toBigint(mod2 as FieldConst).toString(),
        ...mlTupleToArray<FieldConst>(
          negMod as { length: number; [index: number]: FieldConst }
        ).map((c) => FieldConst.toBigint(c).toString()),
      ],
    });
    return original.foreignFieldMul.call(
      gates,
      left, right, remainder, quotient, quotientHiBound, product1,
      carry0, carry1p, carry1c, mod2, negMod
    );
  };
  for (let name of unsupportedGates) {
    let gate = (gates as Record<string, unknown>)[name];
    if (typeof gate !== 'function') continue;
    originalGates.set(name, gate);
    (gates as Record<string, unknown>)[name] = (...args: unknown[]) => {
      // Inventory mode: collect every unsupported gate a circuit uses instead
      // of aborting at the first, then fall through to the original gate so
      // recording continues. Enabled by setting globalThis.__missingGates.
      let inventory = (globalThis as Record<string, unknown>).__missingGates as
        | Set<string>
        | undefined;
      if (inventory instanceof Set) {
        if (!inventory.has(name)) {
          inventory.add(name);
          console.error('[missing-gate]', name);
        }
        return (gate as (...a: unknown[]) => unknown).call(gates, ...args);
      }
      throw Error(
        `Rust Pickles recorder: the '${name}' gate is not supported yet — ` +
          'this circuit cannot be recorded for the Rust backend.'
      );
    };
  }

  // A compile pass (validateWitness=false) only needs the constraint
  // structure. Run it in constraint-system mode so no witness callback runs —
  // no async fetch, `this.sender`, state-dependent assert or `Unconstrained`
  // read executes, which is exactly what breaks real contracts at compile.
  // The VK is unaffected: it depends only on the structure (verified — zeroing
  // the witness leaves the VK unchanged).
  let structureOnly = !validateWitness;
  structureOnlyPass = structureOnly;
  if (structureOnly) setAllowEmptyUnconstrained(true);
  let id = snarkContext.enter(
    structureOnly
      ? { inAnalyze: true, inCheckedComputation: true }
      : { inCheckedComputation: true }
  );
  try {
    let finish = structureOnly
      ? Snarky.run.enterConstraintSystem()
      : Snarky.run.enterGenerateWitness();
    let outputs = await f();
    let output = outputs.map((x) => recorder.lc(x.value));
    finish();
    let previous_state_slots: [number, number][] = [];
    ((recordedPreviousStateFields as Field[] | undefined) ?? []).forEach((field, flat) => {
      let value = field.value;
      if (value[0] !== FieldType.Var) return;
      let dense = recorder.varIndex.get(value[1]);
      if (dense !== undefined) previous_state_slots.push([dense, flat]);
    });
    recordedPreviousStateFields = undefined;
    for (let { proof, vkHash } of (recordedSideLoadedVks as
      | { proof: number; vkHash: Field }[]
      | undefined) ?? []) {
      recorder.constraints.push({
        kind: 'side_loaded_vk',
        proof,
        vk_hash: recorder.lc(vkHash.value),
      });
    }
    recordedSideLoadedVks = undefined;
    let circuit = recorder.circuit(output);
    circuit.previous_state_slots = previous_state_slots;
    circuit.previous_proof_widths = (recordedPreviousProofWidths as number[] | undefined) ?? [];
    recordedPreviousProofWidths = undefined;
    // Deferred gadgets (foreign-field assertLessThan via Group.scale, ...) can
    // lc new vars after `recorder.circuit()` ran; finalize aux_count now that
    // every constraint has been recorded.
    circuit.aux_count = recorder.witness.length;
    return { circuit, witness: recorder.witness };
  } finally {
    structureOnlyPass = false;
    setAllowEmptyUnconstrained(false);
    snarkContext.leave(id);
    field.assertEqual = original.assertEqual;
    field.assertMul = original.assertMul;
    field.assertSquare = original.assertSquare;
    field.assertBoolean = original.assertBoolean;
    (
      field as unknown as {
        truncateToBits16: (lengthDiv16: number, x: FieldVar) => FieldVar;
      }
    ).truncateToBits16 = originalTruncateToBits16;
    gates.generic = original.generic;
    gates.poseidon = original.poseidon;
    run.enterAsProver = originalEnterAsProver;
    poseidonApi.update = originalPoseidon.update;
    poseidonApi.hashToGroup = originalPoseidon.hashToGroup;
    poseidonApi.sponge.create = originalPoseidon.spongeCreate;
    poseidonApi.sponge.absorb = originalPoseidon.spongeAbsorb;
    poseidonApi.sponge.squeeze = originalPoseidon.spongeSqueeze;
    groupApi.scaleFastUnpack = originalScaleFastUnpack;
    gates.ecAdd = original.ecAdd;
    gates.rangeCheck0 = original.rangeCheck0;
    gates.rangeCheck1 = original.rangeCheck1;
    gates.lookup = original.lookup;
    // These were previously NOT restored, so the hook leaked across
    // recordCircuit calls: the next branch captured this branch's hook as its
    // `original.*` and called it, appending the next branch's gates to THIS
    // branch's constraint array — corrupting the FIRST branch of any
    // multi-method program that uses xor/rot/foreign-field gates (e.g. a
    // SmartContract whose signature verify pulls in foreign-field mul).
    gates.xor = original.xor;
    gates.rotate = original.rotate;
    gates.raw = original.raw;
    gates.foreignFieldAdd = original.foreignFieldAdd;
    gates.foreignFieldMul = original.foreignFieldMul;
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
  rust_pickles_compile_recorded_program?: (
    branchesJson: string
  ) => [unknown, unknown | null, unknown | null][];
  rust_pickles_compile_recorded_program_shared?: (branchesJson: string) => unknown;
  rust_pickles_recorded_program_vk_envelope?: (program: unknown) => string;
  rust_pickles_program_prove_n0_bytes?: (
    program: unknown,
    branchIndex: number,
    witness: Uint8Array
  ) => unknown;
  rust_pickles_program_prove_n1_bytes?: (
    program: unknown,
    branchIndex: number,
    previous: unknown,
    witness: Uint8Array
  ) => unknown;
  rust_pickles_program_prove_n2_bytes?: (
    program: unknown,
    branchIndex: number,
    first: unknown,
    second: unknown,
    witness: Uint8Array
  ) => unknown;
  rust_pickles_recorded_program_n1_envelope?: (handle: unknown) => string;
  rust_pickles_recorded_program_n2_envelope?: (handle: unknown) => string;
  rust_pickles_seed_lagrange_basis?: (curve: string, domainLog2: number, bytes: Uint8Array) => boolean;
  rust_pickles_export_lagrange_basis?: (curve: string, domainLog2: number) => Uint8Array;
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
    let { bindings, handle, program, branchIndex } = compiled.directRust;
    if (program !== undefined) {
      if (
        !bindings.rust_pickles_program_prove_n0_bytes ||
        !bindings.rust_pickles_recorded_base_envelope
      ) {
        throw Error('Rust Pickles bindings do not expose shared program proving.');
      }
      let proofHandle = await runRustPickles(() =>
        bindings.rust_pickles_program_prove_n0_bytes!(
          program,
          branchIndex!,
          fpWitnessToBytes(compiled.witness)
        )
      );
      try {
        return JSON.parse(bindings.rust_pickles_recorded_base_envelope(proofHandle));
      } finally {
        (proofHandle as { free?: () => void }).free?.();
      }
    }
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
    let { bindings, handle, program, branchIndex } = compiled.directRust;
    if (program !== undefined) {
      if (
        !bindings.rust_pickles_program_prove_n0_bytes ||
        !bindings.rust_pickles_recorded_base_envelope
      ) {
        throw Error('Rust Pickles bindings do not expose shared program proving.');
      }
      let proofHandle = await runRustPickles(() =>
        bindings.rust_pickles_program_prove_n0_bytes!(
          program,
          branchIndex!,
          fpWitnessToBytes(compiled.witness)
        )
      );
      let envelope = JSON.parse(bindings.rust_pickles_recorded_base_envelope(proofHandle));
      return { handle: proofHandle, ...envelope };
    }
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
  let direct = (compiled as { directRust?: DirectRustCompiled }).directRust;
  if (direct?.program !== undefined) {
    let bindings = direct.bindings;
    if (
      !bindings.rust_pickles_program_prove_n1_bytes ||
      !bindings.rust_pickles_recorded_program_n1_envelope
    ) {
      throw Error('Rust Pickles bindings do not expose shared program N1 proving.');
    }
    let handle = await runRustPickles(() =>
      bindings.rust_pickles_program_prove_n1_bytes!(
        direct.program,
        direct.branchIndex!,
        previous.handle,
        fpWitnessToBytes(compiled.witness)
      )
    );
    try {
      return JSON.parse(bindings.rust_pickles_recorded_program_n1_envelope(handle));
    } finally {
      (handle as { free?: () => void }).free?.();
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
    if (compiled.directRust?.program !== undefined) {
      if (
        !bindings.rust_pickles_program_prove_n1_bytes ||
        !bindings.rust_pickles_recorded_program_n1_envelope
      ) {
        throw Error('Rust Pickles bindings do not expose shared program N1 proving.');
      }
      let debugN1 =
        typeof process !== 'undefined' ? process.env.O1JS_DEBUG_N1_STAGE : undefined;
      if (debugN1 !== undefined) {
        let bisect = (
          bindings as unknown as {
            rust_pickles_program_debug_prove_n1?: (
              program: unknown,
              b: number,
              prev: unknown,
              w: Uint8Array,
              stage: number
            ) => string;
          }
        ).rust_pickles_program_debug_prove_n1;
        if (bisect === undefined) throw Error('n1 debug bindings missing');
        let report = await runRustPickles(() =>
          bisect(
            compiled.directRust!.program,
            compiled.directRust!.branchIndex!,
            previous.handle,
            fpWitnessToBytes(compiled.witness),
            Number(debugN1)
          )
        );
        console.error(`[n1-debug] ${report}`);
        throw Error('n1 prove debug done');
      }
      let handle = await runRustPickles(() =>
        bindings.rust_pickles_program_prove_n1_bytes!(
          compiled.directRust!.program,
          compiled.directRust!.branchIndex!,
          previous.handle,
          fpWitnessToBytes(compiled.witness)
        )
      );
      return {
        handle,
        ...JSON.parse(bindings.rust_pickles_recorded_program_n1_envelope(handle)),
      };
    }
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
    if (compiled.directRust?.program !== undefined) {
      if (
        !bindings.rust_pickles_program_prove_n2_bytes ||
        !bindings.rust_pickles_recorded_program_n2_envelope
      ) {
        throw Error('Rust Pickles bindings do not expose shared program N2 proving.');
      }
      let handle = await runRustPickles(() =>
        bindings.rust_pickles_program_prove_n2_bytes!(
          compiled.directRust!.program,
          compiled.directRust!.branchIndex!,
          first.handle,
          second.handle,
          fpWitnessToBytes(compiled.witness)
        )
      );
      try {
        return JSON.parse(bindings.rust_pickles_recorded_program_n2_envelope(handle));
      } finally {
        (handle as { free?: () => void }).free?.();
      }
    }
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

// ---------------------------------------------------------------------------
// SRS / Lagrange-basis cache — the exact jsoo entries, via the o1js `Cache`.
//
// jsoo persists the SRS and Lagrange bases through the `Cache` object
// (`srs-fp-65536`, `lagrange-basis-fp-16384`, ... — JSON `OrInfinity`
// payloads, version 1). The rust backends read and write those identical
// entries with the identical gating: `Cache.None` yields no reads and
// `canWrite: false` blocks writes, so nothing is persisted; a cache warmed
// by jsoo warms rust and vice versa.
// ---------------------------------------------------------------------------

const srsCacheVersion = 1;

/** fp ↔ Vesta (tick, 2^16), fq ↔ Pallas (tock, 2^15) — jsoo's SRS entries. */
const SRS_CACHE_ENTRIES = [
  ['fp', 'vesta', 16],
  ['fq', 'pallas', 15],
] as const;

/**
 * Domains a compile may materialize Lagrange bases for: wrap domains
 * 2^13..2^15 plus step domains up to the full 2^16. Reading probes every
 * candidate (a miss is one failed file read); writing persists only bases
 * the backend actually computed.
 */
const LAGRANGE_CACHE_DOMAINS = [
  ['fp', 'vesta', [9, 10, 11, 12, 13, 14, 15, 16]],
  ['fq', 'pallas', [13, 14, 15]],
] as const;

function srsCacheHeader(f: 'fp' | 'fq', size: number): CacheHeader {
  let id = `srs-${f}-${size}`;
  return withVersion(
    { kind: 'srs', persistentId: id, uniqueId: id, dataType: 'string' },
    srsCacheVersion
  );
}
function lagrangeBasisCacheHeader(f: 'fp' | 'fq', domainSize: number): CacheHeader {
  let id = `lagrange-basis-${f}-${domainSize}`;
  return withVersion(
    { kind: 'lagrange-basis', persistentId: id, uniqueId: id, dataType: 'string' },
    srsCacheVersion
  );
}

type SrsCacheSeed = [curve: 'vesta' | 'pallas', domainLog2: number, bytes: Uint8Array];

/**
 * Reads every present SRS/Lagrange entry from the o1js cache. The SRS
 * payloads come first (`domainLog2 = -1` sentinel): any other seed or
 * compile creates the SRS if absent, which is the expensive serial group
 * map in wasm.
 */
function readSrsCacheSeeds(cache: Cache): SrsCacheSeed[] {
  let seeds: SrsCacheSeed[] = [];
  for (let [f, curve, srsLog2] of SRS_CACHE_ENTRIES) {
    let bytes = readCache(cache, srsCacheHeader(f, 1 << srsLog2));
    if (bytes !== undefined) seeds.push([curve, -1, bytes]);
  }
  for (let [f, curve, domains] of LAGRANGE_CACHE_DOMAINS) {
    for (let domainLog2 of domains) {
      let bytes = readCache(cache, lagrangeBasisCacheHeader(f, 1 << domainLog2));
      if (bytes !== undefined) seeds.push([curve, domainLog2, bytes]);
    }
  }
  return seeds;
}

/**
 * wasm has no filesystem: seed the wasm-side caches from pre-read cache
 * entries. The first seed call materializes the tick/tock SRS, so this must
 * run inside the worker pool where the parallel SRS creation has threads to
 * spread over.
 */
function seedLagrangeCaches(bindings: RustPicklesBindings, seeds: SrsCacheSeed[]) {
  if (seeds.length === 0) return;
  let b = bindings as unknown as {
    rust_pickles_seed_srs?: (curve: string, bytes: Uint8Array) => boolean;
    rust_pickles_seed_srs_cache_batch?: (entriesJson: string, payloads: Uint8Array[]) => number;
  };
  // One wasm call for every entry: entering the worker pool costs ~200ms of
  // coordination per call, which would dwarf the decode itself.
  if (b.rust_pickles_seed_srs_cache_batch !== undefined) {
    b.rust_pickles_seed_srs_cache_batch(
      JSON.stringify(seeds.map(([curve, domainLog2]) => ({ curve, domainLog2 }))),
      seeds.map(([, , bytes]) => bytes)
    );
    return;
  }
  for (let [curve, domainLog2, bytes] of seeds) {
    if (domainLog2 === -1) {
      b.rust_pickles_seed_srs?.(curve, bytes);
    } else {
      bindings.rust_pickles_seed_lagrange_basis?.(curve, domainLog2, bytes);
    }
  }
}

/**
 * Persists freshly computed SRS/Lagrange payloads the way jsoo does: only
 * through a writable cache, and only entries not already present.
 */
function persistSrsCacheEntries(
  cache: Cache,
  exportPayload: (curve: 'vesta' | 'pallas', domainLog2: number) => Uint8Array | undefined
) {
  if (!cache.canWrite) return;
  for (let [f, curve, srsLog2] of SRS_CACHE_ENTRIES) {
    let header = srsCacheHeader(f, 1 << srsLog2);
    if (readCache(cache, header) !== undefined) continue;
    let bytes = exportPayload(curve, -1);
    if (bytes === undefined || bytes.length === 0) continue;
    writeCache(cache, header, bytes);
  }
  for (let [f, curve, domains] of LAGRANGE_CACHE_DOMAINS) {
    for (let domainLog2 of domains) {
      let header = lagrangeBasisCacheHeader(f, 1 << domainLog2);
      if (readCache(cache, header) !== undefined) continue;
      let bytes = exportPayload(curve, domainLog2);
      if (bytes === undefined || bytes.length === 0) continue;
      writeCache(cache, header, bytes);
    }
  }
}

/** wasm-backend flavor of [`persistSrsCacheEntries`]. */
function persistLagrangeCaches(bindings: RustPicklesBindings, cache: Cache) {
  if (bindings.rust_pickles_export_lagrange_basis === undefined) return;
  let b = bindings as unknown as {
    rust_pickles_export_srs?: (curve: string) => Uint8Array;
  };
  persistSrsCacheEntries(cache, (curve, domainLog2) =>
    domainLog2 === -1
      ? b.rust_pickles_export_srs?.(curve)
      : bindings.rust_pickles_export_lagrange_basis!(curve, domainLog2)
  );
}

async function compileRecordedProgram(
  branches: {
    circuit: () => Field[] | Promise<Field[]>;
    proofsVerified: 0 | 1 | 2;
  }[],
  cache: Cache = Cache.FileSystemDefault
): Promise<RecordedCompiledCircuit[]> {
  let profile = typeof process !== 'undefined' && process.env.O1JS_PROFILE_COMPILE !== undefined;
  let tRecord = performance.now();
  let recorded: Awaited<ReturnType<typeof recordCircuit>>[] = [];
  for (let branch of branches) {
    // `previous_proof_widths` come from the recording itself
    // (`declareRecordedPreviousProofWidths`), so the compile and the prove
    // re-recording produce byte-identical circuit JSON.
    recorded.push(await recordCircuit(branch.circuit, { validateWitness: false }));
  }
  // Deferred gadgets (foreign-field `assertLessThan` reached through
  // `Group.scale` -> `isOddAndHigh`) lc new witness vars after each branch's
  // `recorder.circuit()` ran — the `witness` arrays keep growing. Finalize
  // aux_count now that every branch (and its deferred constraints) is recorded.
  for (let entry of recorded) entry.circuit.aux_count = entry.witness.length;
  if (profile) console.error(`[o1js compile] recording: ${(performance.now() - tRecord).toFixed(0)}ms`);
  let branchDump =
    typeof process !== 'undefined' ? process.env.O1JS_DUMP_PROGRAM_BRANCHES : undefined;
  if (branchDump !== undefined) {
    let { writeFileSync } = await import('node:fs');
    writeFileSync(
      branchDump,
      JSON.stringify(
        recorded.map((entry, i) => ({
          circuit: entry.circuit,
          witness: entry.witness,
          proofsVerified: branches[i].proofsVerified,
        }))
      )
    );
    console.error(`[o1js compile] program branches dumped to ${branchDump}`);
  }
  if (!useMinaRuntimeBackend()) {
    let tPhase = performance.now();
    let bindings = await rustPicklesBindings();
    if (profile)
      console.error(`[o1js compile] wasm bindings init: ${(performance.now() - tPhase).toFixed(0)}ms`);
    tPhase = performance.now();
    // Read the cache entries on the main thread, but run the wasm-side
    // seeding inside the worker pool: the first seed call materializes the
    // tick/tock SRS, whose parallel creation needs pool threads (and the
    // main thread must not block in browsers).
    let lagrangeSeeds = readSrsCacheSeeds(cache);
    let seedInPool = () => seedLagrangeCaches(bindings, lagrangeSeeds);
    if (profile)
      console.error(`[o1js compile] read srs cache entries: ${(performance.now() - tPhase).toFixed(0)}ms`);
    let hasRecursion = branches.some((branch) => branch.proofsVerified > 0);
    if (hasRecursion && bindings.rust_pickles_compile_recorded_program_shared !== undefined) {
      // OCaml `Pickles.compile` shape: ONE shared wrap circuit and canonical
      // verification key for the whole program. Programs without recursion
      // keep the width-0 per-branch path, whose wrap (2^13) is already
      // bit-identical to jsoo's.
      tPhase = performance.now();
      let branchesJson = JSON.stringify(
        recorded.map((entry, i) => ({
          circuit: entry.circuit,
          witness: entry.witness,
          proofsVerified: branches[i].proofsVerified,
        }))
      );
      if (profile)
        console.error(
          `[o1js compile] branches JSON: ${(performance.now() - tPhase).toFixed(0)}ms (${(branchesJson.length / 1e6).toFixed(1)}MB)`
        );
      let debugProbe =
        typeof process !== 'undefined' ? process.env.O1JS_DEBUG_PROBE : undefined;
      if (debugProbe !== undefined) {
        let [branchIndex, mode] = debugProbe.split(',').map(Number);
        let probe = (
          bindings as unknown as {
            rust_pickles_debug_probe_branch?: (json: string, b: number, m: number) => string;
          }
        ).rust_pickles_debug_probe_branch;
        if (probe === undefined) throw Error('probe debug bindings missing');
        let report = await runRustPickles(() => probe(branchesJson, branchIndex, mode));
        console.error(`[probe-debug] branch ${branchIndex} ${report}`);
        throw Error(`probe debug done`);
      }
      let debugStage =
        typeof process !== 'undefined' ? process.env.O1JS_DEBUG_PROGRAM_STAGE : undefined;
      if (debugStage !== undefined) {
        let bisect = (
          bindings as unknown as {
            rust_pickles_debug_program_stage?: (json: string, stage: number) => string;
          }
        ).rust_pickles_debug_program_stage;
        if (bisect === undefined) throw Error('debug bindings missing');
        let report = await runRustPickles(() => {
          seedInPool();
          return bisect(branchesJson, Number(debugStage));
        });
        console.error(`[program-debug] ${report}`);
        throw Error(`program compile debug stage ${debugStage} done`);
      }
      tPhase = performance.now();
      let b = bindings as unknown as {
        rust_pickles_recorded_program_cache_key?: (json: string) => string;
        rust_pickles_recorded_program_cache_bytes?: (program: unknown) => Uint8Array;
        rust_pickles_compile_recorded_program_from_cache_bytes?: (
          json: string,
          bytes: Uint8Array
        ) => unknown;
      };
      let programCacheKey = b.rust_pickles_recorded_program_cache_key?.(branchesJson);
      let programCacheHeader =
        programCacheKey === undefined
          ? undefined
          : withVersion({
              kind: 'step-pk',
              persistentId: programCacheKey,
              uniqueId: programCacheKey,
              dataType: 'bytes',
              programName: 'rust-pickles-program',
              methodName: programCacheKey,
              methodIndex: 0,
              hash: programCacheKey,
            } as Omit<CacheHeader, 'version'>);
      let program: unknown | undefined;
      let restoredFromCache = false;
      let cachedProgramBytes =
        programCacheHeader === undefined ? undefined : readCache(cache, programCacheHeader);
      if (
        cachedProgramBytes !== undefined &&
        b.rust_pickles_compile_recorded_program_from_cache_bytes !== undefined
      ) {
        try {
          program = await runRustPickles(() => {
            seedInPool();
            return b.rust_pickles_compile_recorded_program_from_cache_bytes!(
              branchesJson,
              cachedProgramBytes
            );
          });
          restoredFromCache = true;
        } catch {
          program = undefined; // stale/corrupt cache entry: recompile
        }
      }
      if (program === undefined) {
        program = await runRustPickles(() => {
          seedInPool();
          return bindings.rust_pickles_compile_recorded_program_shared!(branchesJson);
        });
      }
      if (
        !restoredFromCache &&
        programCacheHeader !== undefined &&
        cache.canWrite &&
        b.rust_pickles_recorded_program_cache_bytes !== undefined
      ) {
        try {
          let bytes = b.rust_pickles_recorded_program_cache_bytes(program);
          cache.write(programCacheHeader, bytes);
        } catch {
          // caching is best-effort
        }
      }
      if (profile)
        console.error(
          `[o1js compile] rust shared program ${restoredFromCache ? 'cache restore' : 'compile'} (incl. seed): ${(performance.now() - tPhase).toFixed(0)}ms`
        );
      tPhase = performance.now();
      let verificationKey: CanonicalVkEnvelope | undefined;
      if (bindings.rust_pickles_recorded_program_vk_envelope !== undefined) {
        let envelope = JSON.parse(
          bindings.rust_pickles_recorded_program_vk_envelope(program)
        ) as { base64: string; hash: string };
        verificationKey = { data: envelope.base64, hash: envelope.hash };
      }
      if (profile)
        console.error(`[o1js compile] vk envelope: ${(performance.now() - tPhase).toFixed(0)}ms`);
      tPhase = performance.now();
      persistLagrangeCaches(bindings, cache);
      if (profile)
        console.error(`[o1js compile] persist lagrange: ${(performance.now() - tPhase).toFixed(0)}ms`);
      tPhase = performance.now();
      let envelopes = await Promise.all(
        recorded.map((entry, i) =>
          compileRecordedEnvelope(entry, cache, branches[i].proofsVerified, undefined, {
            bindings,
            handle: undefined,
            program,
            branchIndex: i,
            verificationKey,
          })
        )
      );
      if (profile)
        console.error(
          `[o1js compile] branch envelopes: ${(performance.now() - tPhase).toFixed(0)}ms`
        );
      return envelopes;
    }
    if (bindings.rust_pickles_compile_recorded_program !== undefined) {
      // One call compiling every branch (sequentially inside the rayon pool —
      // each branch parallelizes internally); per-method calls serialize
      // across the wasm boundary.
      let branchesJson = JSON.stringify(
        recorded.map((entry, i) => ({
          circuit: entry.circuit,
          witness: entry.witness,
          proofsVerified: branches[i].proofsVerified,
        }))
      );
      let compiledHandles = await runRustPickles(() => {
        seedInPool();
        return bindings.rust_pickles_compile_recorded_program!(branchesJson);
      });
      if (profile) console.error(`[o1js compile] rust batch compile done`);
      persistLagrangeCaches(bindings, cache);
      // A non-recursive program with several distinct branches (every branch
      // `proofsVerified === 0`) has ONE shared width-0 wrap VK in OCaml
      // `Pickles.compile`, not one wrap per branch. Compute it once and stamp
      // it on every branch so a SmartContract's canonical-VK check sees a
      // single key. Single-branch programs already match jsoo per-branch.
      let sharedBaseVk: CanonicalVkEnvelope | undefined;
      let wantsSharedBaseVk =
        recorded.length > 1 && branches.every((branch) => branch.proofsVerified === 0);
      // The batch compile appends the shared base VK as a trailing element
      // (index `recorded.length`), reusing the Step verifiers it already built.
      // This avoids a second full Step compile of every branch, which fits in
      // native memory but overruns wasm32's 4 GB linear memory and thrashes
      // (a 12-branch SmartContract like Lumina's PoolFactory hung for minutes).
      if (wantsSharedBaseVk && compiledHandles.length > recorded.length) {
        let envelope = JSON.parse(compiledHandles[recorded.length] as unknown as string) as {
          base64: string;
          hash: string;
        };
        sharedBaseVk = { data: envelope.base64, hash: envelope.hash };
      } else if (wantsSharedBaseVk) {
        // Fallback for runtimes whose batch compile predates the appended VK:
        // the standalone binding recompiles every branch's Step circuit.
        let sharedBaseVkBinding = (
          bindings as unknown as {
            rust_pickles_compile_recorded_program_base_shared_vk?: (json: string) => string;
          }
        ).rust_pickles_compile_recorded_program_base_shared_vk;
        if (sharedBaseVkBinding !== undefined) {
          let envelope = JSON.parse(
            await runRustPickles(() => {
              seedInPool();
              return sharedBaseVkBinding!(branchesJson);
            })
          ) as { base64: string; hash: string };
          sharedBaseVk = { data: envelope.base64, hash: envelope.hash };
        }
      }
      return Promise.all(
        recorded.map((entry, i) => {
          let [handle, n1Handle, n2Handle] = compiledHandles[i];
          return compileRecordedEnvelope(entry, cache, branches[i].proofsVerified, undefined, {
            bindings,
            handle,
            n1Handle: n1Handle ?? undefined,
            n2Handle: n2Handle ?? undefined,
            verificationKey: sharedBaseVk,
          });
        })
      );
    }
    await runRustPickles(() => seedInPool());
    return Promise.all(
      recorded.map((entry, i) => compileRecordedEnvelope(entry, cache, branches[i].proofsVerified))
    );
  }
  // OCaml `Pickles.compile` gives an all-N0 program the width-0 wrap
  // (2^13, maxProofsVerified = 0). The shared program pipeline bootstraps
  // width-2 machinery and reports a wider wrap, so route non-recursive
  // programs through the per-branch width-0 path — the same rule the
  // non-runtime branch above applies.
  if (!branches.some((branch) => branch.proofsVerified > 0)) {
    return Promise.all(
      recorded.map((entry, i) => compileRecordedEnvelope(entry, cache, branches[i].proofsVerified))
    );
  }
  let client = await minaRuntimeClient();
  let tRust = performance.now();
  // SRS/Lagrange cache: same entries and gating as jsoo (best-effort — an
  // older runtime without the seed/export ops just recomputes).
  try {
    for (let [curve, domainLog2, bytes] of readSrsCacheSeeds(cache)) {
      client.seedSrsCache(
        curve,
        Buffer.from(bytes).toString('base64'),
        domainLog2 === -1 ? undefined : domainLog2
      );
    }
  } catch {
    // seeding is best-effort
  }
  let runtimeBranches = recorded.map((entry, i) => ({
    circuit: entry.circuit,
    witness: entry.witness,
    proofsVerified: branches[i].proofsVerified,
  }));
  // Prover-key cache, same semantics as jsoo: read -> restore; miss ->
  // compile and persist (best-effort).
  let runtimeCacheKey: string | undefined;
  try {
    runtimeCacheKey = client.programCacheKey(runtimeBranches);
  } catch {
    runtimeCacheKey = undefined;
  }
  let runtimeCacheHeader =
    runtimeCacheKey === undefined
      ? undefined
      : withVersion({
          kind: 'step-pk',
          persistentId: runtimeCacheKey,
          uniqueId: runtimeCacheKey,
          dataType: 'bytes',
          programName: 'rust-pickles-program',
          methodName: runtimeCacheKey,
          methodIndex: 0,
          hash: runtimeCacheKey,
        } as Omit<CacheHeader, 'version'>);
  let cachedRuntimeBytes =
    runtimeCacheHeader === undefined ? undefined : readCache(cache, runtimeCacheHeader);
  let compiled = client.compileProgram(runtimeBranches, {
    cacheBytesBase64:
      cachedRuntimeBytes === undefined
        ? undefined
        : Buffer.from(cachedRuntimeBytes).toString('base64'),
    wantCacheBytes: runtimeCacheHeader !== undefined && cache.canWrite,
  });
  if (
    compiled.cacheBytesBase64 !== undefined &&
    runtimeCacheHeader !== undefined &&
    cache.canWrite
  ) {
    try {
      cache.write(runtimeCacheHeader, Buffer.from(compiled.cacheBytesBase64, 'base64'));
    } catch {
      // caching is best-effort
    }
  }
  try {
    persistSrsCacheEntries(cache, (curve, domainLog2) => {
      let { payloadBase64 } = client.exportSrsCache(
        curve,
        domainLog2 === -1 ? undefined : domainLog2
      );
      return payloadBase64 == null ? undefined : new Uint8Array(Buffer.from(payloadBase64, 'base64'));
    });
  } catch {
    // persisting is best-effort
  }
  if (profile)
    console.error(
      `[o1js compile] rust compileProgram (${compiled.restoredFromCache ? 'cache restore' : 'cold'}): ${(performance.now() - tRust).toFixed(0)}ms`
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
  precompiledRuntime?: MinaRuntimeCompiled,
  precompiledDirect?: DirectRustCompiled
): Promise<RecordedCompiledCircuit> {
  let minaRuntime: MinaRuntimeCompiled | undefined;
  let directRust: DirectRustCompiled | undefined;
  if (precompiledDirect !== undefined) {
    directRust = precompiledDirect;
    if (
      directRust.verificationKey === undefined &&
      directRust.handle !== undefined &&
      directRust.bindings.rust_pickles_recorded_base_vk_envelope !== undefined
    ) {
      let envelope = JSON.parse(
        directRust.bindings.rust_pickles_recorded_base_vk_envelope(directRust.handle)
      ) as { base64: string; hash: string };
      directRust.verificationKey = { data: envelope.base64, hash: envelope.hash };
    }
  } else if (precompiledRuntime !== undefined) {
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
        (compiled.directRust.handle as { free?: () => void } | undefined)?.free?.();
        // Shared-wrap program handles are owned by the first branch only:
        // free once, the other branches see it already cleared.
        if (compiled.directRust.branchIndex === 0) {
          (compiled.directRust.program as { free?: () => void } | undefined)?.free?.();
        }
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
