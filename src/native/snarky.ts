/**
 * Typed wrapper over the native (Rust) snarky constraint system exposed by
 * `@o1js/native` (proof-systems' kimchi-napi, snarky-rs branch).
 *
 * This is the replacement for the js_of_ocaml `Snarky.*` constraint-building
 * path: circuits are accumulated in a Rust `SnarkyConstraintSystem`, which
 * owns reduction, gate layout and witness computation. See RUST_MIGRATION.md.
 *
 * Linear combinations cross the FFI as flat parallel buffers (napi-rs cannot
 * extract typed arrays nested inside JS objects):
 * sizes[], hasConstant[], constants, coeffs (32 bytes per element), indices[].
 */
import native from './native.js';
import { FieldType, FieldVar, FieldConst } from '../lib/provable/core/fieldvar.js';
import { Fp } from '../bindings/crypto/finite-field.js';

export {
  NativeFpConstraintSystem,
  KimchiGateType,
  fieldToBytes,
  bytesToField,
  flattenFieldVar,
  type LinComb,
};

/** Kimchi gate types, in the declaration order of Rust's `GateType`. */
enum KimchiGateType {
  Zero,
  Generic,
  Poseidon,
  CompleteAdd,
  VarBaseMul,
  EndoMul,
  EndoMulScalar,
  Lookup,
  RangeCheck0,
  RangeCheck1,
  ForeignFieldAdd,
  ForeignFieldMul,
  Xor16,
  Rot64,
}

const FIELD_SIZE = 32;

/** Serializes a field element to its 32-byte little-endian representation. */
function fieldToBytes(x: bigint): Uint8Array {
  let bytes = new Uint8Array(FIELD_SIZE);
  let v = Fp.mod(x);
  for (let i = 0; i < FIELD_SIZE; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

function bytesToField(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]!);
  }
  return v;
}

/** A flattened `FieldVar`: an optional constant plus (coefficient, variable index) terms. */
type LinComb = { constant?: bigint; terms: [bigint, number][] };

/**
 * Flattens a `FieldVar` tree into a linear combination, the same reduction
 * as OCaml's `Cvar.to_constant_and_terms` (which the Rust side expects).
 */
function flattenFieldVar(x: FieldVar): LinComb {
  let constant = 0n;
  let hasConstant = false;
  let terms = new Map<number, bigint>();

  function go(scale: bigint, x: FieldVar): void {
    switch (x[0]) {
      case FieldType.Constant: {
        constant = Fp.add(constant, Fp.mul(scale, FieldConst.toBigint(x[1])));
        hasConstant = true;
        break;
      }
      case FieldType.Var: {
        let i = x[1];
        terms.set(i, Fp.add(terms.get(i) ?? 0n, scale));
        break;
      }
      case FieldType.Add: {
        go(scale, x[1]);
        go(scale, x[2]);
        break;
      }
      case FieldType.Scale: {
        go(Fp.mul(scale, FieldConst.toBigint(x[1])), x[2]);
        break;
      }
    }
  }
  go(1n, x);

  return {
    constant: hasConstant ? constant : undefined,
    terms: [...terms.entries()].map(([i, c]) => [c, i]),
  };
}

/** The flat batch encoding of a list of linear combinations. */
type LinCombBatch = [
  sizes: Uint32Array,
  hasConstant: Uint8Array,
  constants: Uint8Array,
  coeffs: Uint8Array,
  indices: Uint32Array,
];

function encodeBatch(lincoms: LinComb[]): LinCombBatch {
  let nTerms = lincoms.reduce((n, l) => n + l.terms.length, 0);
  let nConstants = lincoms.reduce((n, l) => n + (l.constant === undefined ? 0 : 1), 0);
  let sizes = new Uint32Array(lincoms.length);
  let hasConstant = new Uint8Array(lincoms.length);
  let constants = new Uint8Array(nConstants * FIELD_SIZE);
  let coeffs = new Uint8Array(nTerms * FIELD_SIZE);
  let indices = new Uint32Array(nTerms);

  let iConst = 0;
  let iTerm = 0;
  lincoms.forEach((l, k) => {
    sizes[k] = l.terms.length;
    if (l.constant !== undefined) {
      hasConstant[k] = 1;
      constants.set(fieldToBytes(l.constant), iConst * FIELD_SIZE);
      iConst++;
    }
    for (let [c, i] of l.terms) {
      coeffs.set(fieldToBytes(c), iTerm * FIELD_SIZE);
      indices[iTerm] = i;
      iTerm++;
    }
  });
  return [sizes, hasConstant, constants, coeffs, indices];
}

function batchOfVars(vars: FieldVar[]): LinCombBatch {
  return encodeBatch(vars.map(flattenFieldVar));
}

enum BasicKind {
  Boolean = 0,
  Equal = 1,
  Square = 2,
  R1cs = 3,
}

/**
 * The Rust constraint system for circuits over Fp (Vesta-proved circuits —
 * the o1js "step" side).
 */
class NativeFpConstraintSystem {
  cs: unknown;

  constructor() {
    this.cs = native.caml_fp_snarky_cs_create();
  }

  setPrimaryInputSize(n: number) {
    native.caml_fp_snarky_cs_set_primary_input_size(this.cs, n);
  }

  rowsLen(): number {
    return native.caml_fp_snarky_cs_get_rows_len(this.cs);
  }

  // basic snarky constraints

  assertBoolean(x: FieldVar) {
    native.caml_fp_snarky_cs_add_basic_constraint(this.cs, BasicKind.Boolean, ...batchOfVars([x]));
  }

  assertEqual(x: FieldVar, y: FieldVar) {
    native.caml_fp_snarky_cs_add_basic_constraint(this.cs, BasicKind.Equal, ...batchOfVars([x, y]));
  }

  assertSquare(x: FieldVar, xx: FieldVar) {
    native.caml_fp_snarky_cs_add_basic_constraint(this.cs, BasicKind.Square, ...batchOfVars([x, xx]));
  }

  assertMul(x: FieldVar, y: FieldVar, z: FieldVar) {
    native.caml_fp_snarky_cs_add_basic_constraint(this.cs, BasicKind.R1cs, ...batchOfVars([x, y, z]));
  }

  // kimchi gates

  /** Generic gate: `sl*l + sr*r + so*o + m*l*r + c = 0`. */
  generic(
    sl: bigint,
    l: FieldVar,
    sr: bigint,
    r: FieldVar,
    so: bigint,
    o: FieldVar,
    m: bigint,
    c: bigint
  ) {
    let scalars = new Uint8Array(5 * FIELD_SIZE);
    [sl, sr, so, m, c].forEach((s, k) => scalars.set(fieldToBytes(s), k * FIELD_SIZE));
    native.caml_fp_snarky_cs_add_generic(this.cs, scalars, ...batchOfVars([l, r, o]));
  }

  /** A full poseidon permutation: 56 states of 3 variables, row-major. */
  poseidon(state: FieldVar[][]) {
    native.caml_fp_snarky_cs_add_poseidon(this.cs, ...batchOfVars(state.flat()));
  }

  /** Complete EC addition: `[x1, y1, x2, y2, x3, y3, inf, same_x, slope, inf_z, x21_inv]`. */
  ecAddComplete(vars: FieldVar[]) {
    native.caml_fp_snarky_cs_add_ec_add_complete(this.cs, ...batchOfVars(vars));
  }

  /** 88-bit range check row: 15 variables in column order. */
  rangeCheck0(vars: FieldVar[], compact: bigint) {
    native.caml_fp_snarky_cs_add_range_check0(
      this.cs,
      fieldToBytes(compact),
      ...batchOfVars(vars)
    );
  }

  /** RangeCheck1 gate: 30 variables (current row then next row). */
  rangeCheck1(vars: FieldVar[]) {
    native.caml_fp_snarky_cs_add_range_check1(this.cs, ...batchOfVars(vars));
  }

  /** Lookup row: 7 variables `[w0..w6]`. */
  lookup(vars: FieldVar[]) {
    native.caml_fp_snarky_cs_add_lookup(this.cs, ...batchOfVars(vars));
  }

  /**
   * Escape hatch: one row with an arbitrary gate type; `cells` holds the
   * row's 15 cells (or fewer), missing/unused cells as `undefined`.
   * Covers Xor16, Rot64 and the foreign field rows.
   */
  addRow(gate: KimchiGateType, cells: (FieldVar | undefined)[], coeffs: bigint[]) {
    let present = Uint8Array.from(cells.map((c) => (c === undefined ? 0 : 1)));
    let gateCoeffs = new Uint8Array(coeffs.length * FIELD_SIZE);
    coeffs.forEach((c, k) => gateCoeffs.set(fieldToBytes(c), k * FIELD_SIZE));
    let vars = cells.filter((c): c is FieldVar => c !== undefined);
    native.caml_fp_snarky_cs_add_row(this.cs, gate, present, gateCoeffs, ...batchOfVars(vars));
  }

  // compilation & witness

  finalize() {
    native.caml_fp_snarky_cs_finalize(this.cs);
  }

  digest(): Uint8Array {
    return native.caml_fp_snarky_cs_digest(this.cs);
  }

  /** The finalized gates as a native kimchi gate vector (for index creation). */
  toGateVector(): unknown {
    return native.caml_fp_snarky_cs_to_gate_vector(this.cs);
  }

  /** The circuit as JSON (via the existing kimchi serializer), for parity tests. */
  toJson(publicInputSize: number): string {
    return native.caml_pasta_fp_plonk_circuit_serialize(publicInputSize, this.toGateVector());
  }

  /** Computes the witness columns from public + private input values. */
  computeWitness(publicInputs: bigint[], privateInputs: bigint[]): bigint[][] {
    let pack = (xs: bigint[]) => {
      let bytes = new Uint8Array(xs.length * FIELD_SIZE);
      xs.forEach((x, k) => bytes.set(fieldToBytes(x), k * FIELD_SIZE));
      return bytes;
    };
    let cols: Uint8Array[] = native.caml_fp_snarky_cs_compute_witness(
      this.cs,
      pack(publicInputs),
      pack(privateInputs)
    );
    return cols.map((col) => {
      let out: bigint[] = [];
      for (let i = 0; i < col.length; i += FIELD_SIZE) {
        out.push(bytesToField(col.subarray(i, i + FIELD_SIZE)));
      }
      return out;
    });
  }
}
