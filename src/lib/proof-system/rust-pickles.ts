/**
 * JSON envelope emitted by the Rust Pickles backend in proof-systems.
 *
 * This is intentionally separate from {@link JsonProof}: o1js' existing
 * `JsonProof.proof` is the OCaml Pickles base64 representation, while this
 * envelope carries Rust's Mina `Wrap_wire_proof.Stable.V1` bin_prot bytes.
 */
type RustPicklesJsonProof = {
  version: 1;
  statement: string[];
  wrap_wire_proof_base64: string;
  side_loaded_verification_key_base58: string;
};

type RustPicklesProof = {
  statement: string[];
  wrapWireProofBase64: string;
  sideLoadedVerificationKeyBase58: string;
};

const decimalFieldRegex = /^(0|[1-9][0-9]*)$/;
const standardBase64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;

function rustPicklesProofFromJSON(json: RustPicklesJsonProof): RustPicklesProof {
  assertRustPicklesJsonProof(json);
  return {
    statement: [...json.statement],
    wrapWireProofBase64: json.wrap_wire_proof_base64,
    sideLoadedVerificationKeyBase58: json.side_loaded_verification_key_base58,
  };
}

function rustPicklesProofToJSON(proof: RustPicklesProof): RustPicklesJsonProof {
  let json = {
    version: 1,
    statement: [...proof.statement],
    wrap_wire_proof_base64: proof.wrapWireProofBase64,
    side_loaded_verification_key_base58: proof.sideLoadedVerificationKeyBase58,
  } as const;
  assertRustPicklesJsonProof(json);
  return json;
}

function rustPicklesProofFromJSONString(json: string): RustPicklesProof {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw Error('Invalid Rust Pickles proof JSON: expected valid JSON');
  }
  assertRustPicklesJsonProof(value);
  return rustPicklesProofFromJSON(value);
}

function rustPicklesProofToJSONString(proof: RustPicklesProof): string {
  return JSON.stringify(rustPicklesProofToJSON(proof));
}

function assertRustPicklesJsonProof(value: unknown): asserts value is RustPicklesJsonProof {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw Error('Invalid Rust Pickles proof JSON: expected object');
  }
  let proof = value as Partial<RustPicklesJsonProof>;
  if (proof.version !== 1) {
    throw Error('Invalid Rust Pickles proof JSON: unsupported version');
  }
  if (!Array.isArray(proof.statement)) {
    throw Error('Invalid Rust Pickles proof JSON: expected statement array');
  }
  for (let [index, field] of proof.statement.entries()) {
    if (typeof field !== 'string' || !decimalFieldRegex.test(field)) {
      throw Error(`Invalid Rust Pickles proof JSON: statement[${index}] is not a decimal field`);
    }
  }
  if (
    typeof proof.wrap_wire_proof_base64 !== 'string' ||
    proof.wrap_wire_proof_base64.length === 0 ||
    !standardBase64Regex.test(proof.wrap_wire_proof_base64)
  ) {
    throw Error('Invalid Rust Pickles proof JSON: expected standard base64 wrap proof');
  }
  if (
    typeof proof.side_loaded_verification_key_base58 !== 'string' ||
    proof.side_loaded_verification_key_base58.length === 0 ||
    !base58Regex.test(proof.side_loaded_verification_key_base58)
  ) {
    throw Error('Invalid Rust Pickles proof JSON: expected Base58 side-loaded verification key');
  }
}

export {
  assertRustPicklesJsonProof,
  rustPicklesProofFromJSON,
  rustPicklesProofFromJSONString,
  rustPicklesProofToJSON,
  rustPicklesProofToJSONString,
};
export type { RustPicklesJsonProof, RustPicklesProof };
