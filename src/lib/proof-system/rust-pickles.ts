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

type RustPicklesProofPayload = {
  appState: string[];
  proof: RustPicklesJsonProof;
  recursion?: RustPicklesRecursion;
};

type RustPicklesRecursion = RustPicklesRecursionN1 | RustPicklesRecursionN2;

type RustPicklesRecursionN1 = {
  kind: 'n1';
  challengePolynomialCommitment: [string, string];
  oldBulletproofChallenges: string[];
  dlogPlonkIndex: [string, string][];
};

type RustPicklesRecursionN2 = {
  kind: 'n2';
  challengePolynomialCommitments: [string, string][];
  oldBulletproofChallenges: string[][];
  dlogPlonkIndex: [string, string][];
};

type RustPicklesProofResource = {
  kind: 'proof';
  value: unknown;
  drop(): void;
};

const rustProofPrefix = 'mina-runtime-pickles-v1:';
const rustProofPayloads = new WeakMap<object, RustPicklesProofPayload>();
const rustProofResources = new WeakMap<object, RustPicklesProofResource>();

function attachRustPicklesProof(target: object, payload: RustPicklesProofPayload) {
  assertRustPicklesJsonProof(payload.proof);
  rustProofPayloads.set(target, payload);
}

function getRustPicklesProof(target: object) {
  return rustProofPayloads.get(target);
}

function attachRustPicklesProofResource(target: object, resource: RustPicklesProofResource) {
  rustProofResources.set(target, resource);
}

function getRustPicklesProofResource(target: object) {
  return rustProofResources.get(target);
}

function encodeRustPicklesProof(payload: RustPicklesProofPayload): string {
  assertRustPicklesJsonProof(payload.proof);
  return rustProofPrefix + JSON.stringify(payload);
}

function decodeRustPicklesProof(value: string): RustPicklesProofPayload | undefined {
  if (!value.startsWith(rustProofPrefix)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(value.slice(rustProofPrefix.length));
  } catch {
    throw Error('Invalid mina-runtime Pickles proof: expected JSON payload');
  }
  if (typeof payload !== 'object' || payload === null) {
    throw Error('Invalid mina-runtime Pickles proof payload');
  }
  let result = payload as Partial<RustPicklesProofPayload>;
  if (
    !Array.isArray(result.appState) ||
    result.appState.some((field) => typeof field !== 'string')
  ) {
    throw Error('Invalid mina-runtime Pickles proof application state');
  }
  assertRustPicklesJsonProof(result.proof);
  let recursion = parseRecursion(result.recursion);
  return { appState: [...result.appState], proof: result.proof, recursion };
}

function parseRecursion(value: unknown): RustPicklesRecursion | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw Error('Invalid mina-runtime Pickles recursion metadata');
  }
  let recursion = value as Record<string, unknown>;
  if (recursion.kind === 'n2') {
    let commitments = recursion.challengePolynomialCommitments;
    let challenges = recursion.oldBulletproofChallenges;
    let index = recursion.dlogPlonkIndex;
    if (
      !Array.isArray(commitments) ||
      !commitments.every(isPoint) ||
      !Array.isArray(challenges) ||
      !challenges.every(isFields) ||
      !Array.isArray(index) ||
      !index.every(isPoint)
    ) {
      throw Error('Invalid mina-runtime Pickles N2 metadata');
    }
    return {
      kind: 'n2',
      challengePolynomialCommitments: commitments.map((point) => [...point]),
      oldBulletproofChallenges: challenges.map((fields) => [...fields]),
      dlogPlonkIndex: index.map((point) => [...point]),
    };
  }
  let commitment = recursion.challengePolynomialCommitment;
  let challenges = recursion.oldBulletproofChallenges;
  let index = recursion.dlogPlonkIndex;
  if (
    recursion.kind !== 'n1' ||
    !isPoint(commitment) ||
    !isFields(challenges) ||
    !Array.isArray(index) ||
    !index.every(isPoint)
  ) {
    throw Error('Invalid mina-runtime Pickles N1 metadata');
  }
  return {
    kind: 'n1',
    challengePolynomialCommitment: [...commitment],
    oldBulletproofChallenges: [...challenges],
    dlogPlonkIndex: index.map((point) => [...point]),
  };
}

function isFields(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((field) => typeof field === 'string');
}

function isPoint(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  );
}

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

async function rustPicklesProveSquareBaseCase(witness: bigint | number | string) {
  let { initializeBindings, wasm } = await import('../../bindings.js');
  await initializeBindings();
  let prove = (
    wasm as unknown as { rust_pickles_square_base_proof_json?: (witness: string) => string }
  ).rust_pickles_square_base_proof_json;
  if (typeof prove !== 'function') {
    throw Error(
      'Rust Pickles native backend is not available. Call setBackend("native") before initializeBindings() and build @o1js/native from proof-systems.'
    );
  }
  return rustPicklesProofFromJSONString(prove(witness.toString()));
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
  attachRustPicklesProof,
  attachRustPicklesProofResource,
  decodeRustPicklesProof,
  encodeRustPicklesProof,
  getRustPicklesProof,
  getRustPicklesProofResource,
  rustPicklesProofFromJSON,
  rustPicklesProofFromJSONString,
  rustPicklesProofToJSON,
  rustPicklesProofToJSONString,
  rustPicklesProveSquareBaseCase,
};
export type {
  RustPicklesJsonProof,
  RustPicklesProof,
  RustPicklesProofPayload,
  RustPicklesProofResource,
  RustPicklesRecursion,
};
