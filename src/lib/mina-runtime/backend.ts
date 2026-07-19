import type { RustPicklesJsonProof } from '../proof-system/rust-pickles.js';

export {
  MinaRuntimeClient,
  type BackendInfo,
  type CompiledCircuit,
  type CompiledProgram,
  type KeptProofResponse,
  type MinaRuntimeTransport,
  type RecordedCircuit,
  type RecursiveN2ProofResponse,
  type RecursiveProofResponse,
  type RustProofResponse,
};

type Versioned<T> = { version: 1; payload: T };
type WireSuccess<T> = { status: 'ok'; value: T };
type WireFailure = { status: 'error'; value: { code: string; message: string } };

type BackendInfo = {
  backendApiVersion: number;
  wireFormatVersion: number;
  minaRustVersion: string;
  proofSystem: string;
  capabilities: string[];
};

type RecordedLinComb = { constant?: string; terms?: [string, number][] };
type RecordedCircuit = {
  aux_count: number;
  output: RecordedLinComb[];
  constraints: unknown[];
};

type CompiledCircuit = {
  circuitId: number;
  verificationKeyBase64?: string;
  verificationKeyHash?: string;
  circuitDigest: string;
  witnessSize: number;
  publicOutputSize: number;
};

type CompiledProgram = {
  branches: CompiledCircuit[];
  cacheBytesBase64?: string;
  restoredFromCache?: boolean;
};

type RustProofResponse = {
  appState: string[];
  proof: RustPicklesJsonProof;
};

type KeptProofResponse = RustProofResponse & { proofId: number };

type RecursiveProofResponse = RustProofResponse & {
  proofId: number;
  challengePolynomialCommitment: [string, string];
  oldBulletproofChallenges: string[];
  dlogPlonkIndex: [string, string][];
};

type RecursiveN2ProofResponse = RustProofResponse & {
  challengePolynomialCommitments: [string, string][];
  oldBulletproofChallenges: string[][];
  dlogPlonkIndex: [string, string][];
};

type MinaRuntimeTransport = {
  execute(request: string): string;
  executeAsync(request: string, signal?: AbortSignal): Promise<string>;
  readonly info: string;
};

/** Stable client for mina-rust's versioned JSON boundary. */
class MinaRuntimeClient {
  #transport: MinaRuntimeTransport;
  #info: BackendInfo;

  constructor(transport: MinaRuntimeTransport) {
    this.#transport = transport;
    this.#info = parseJson(transport.info, 'backend info');
    if (this.#info.backendApiVersion !== 1 || this.#info.wireFormatVersion !== 1) {
      throw Error(
        `Incompatible mina-rust backend: API ${this.#info.backendApiVersion}, ` +
          `wire format ${this.#info.wireFormatVersion}; o1js requires 1/1.`
      );
    }
  }

  get info() {
    return this.#info;
  }

  compileCircuit(circuit: RecordedCircuit, witness: string[], proofsVerified: 0 | 1 | 2) {
    return this.#execute<CompiledCircuit>('compileCircuit', {
      circuit,
      witness,
      proofsVerified,
    });
  }

  compileProgram(
    branches: { circuit: RecordedCircuit; witness: string[]; proofsVerified: 0 | 1 | 2 }[],
    options?: { cacheBytesBase64?: string; wantCacheBytes?: boolean }
  ) {
    return this.#execute<CompiledProgram>('compileProgram', {
      branches,
      ...(options?.cacheBytesBase64 !== undefined
        ? { cacheBytesBase64: options.cacheBytesBase64 }
        : {}),
      ...(options?.wantCacheBytes ? { wantCacheBytes: true } : {}),
    });
  }

  programCacheKey(
    branches: { circuit: RecordedCircuit; witness: string[]; proofsVerified: 0 | 1 | 2 }[]
  ) {
    return this.#execute<string>('programCacheKey', { branches });
  }

  /** Seeds the runtime's in-process SRS or Lagrange-basis cache from an o1js
   * `Cache` entry payload (jsoo JSON, base64). `domainLog2` absent seeds the
   * SRS itself. */
  seedSrsCache(curve: 'vesta' | 'pallas', payloadBase64: string, domainLog2?: number) {
    return this.#execute<boolean>('seedSrsCache', { curve, payloadBase64, domainLog2 });
  }

  /** Exports the runtime's in-process SRS (`domainLog2` absent) or a
   * Lagrange basis as an o1js `Cache` entry payload (jsoo JSON, base64);
   * `payloadBase64` is null-ish when not materialized yet. */
  exportSrsCache(curve: 'vesta' | 'pallas', domainLog2?: number) {
    return this.#execute<{ payloadBase64?: string | null }>('exportSrsCache', {
      curve,
      domainLog2,
    });
  }

  proveCircuit(circuitId: number, witness: string[], signal?: AbortSignal) {
    return this.#executeAsync<RustProofResponse>('proveCircuit', { circuitId, witness }, signal);
  }

  proveCircuitKeep(circuitId: number, witness: string[], signal?: AbortSignal) {
    return this.#executeAsync<KeptProofResponse>(
      'proveCircuitKeep',
      { circuitId, witness },
      signal
    );
  }

  proveCircuitN1Over(
    circuitId: number,
    previousProofId: number,
    witness: string[],
    signal?: AbortSignal
  ) {
    return this.#executeAsync<RecursiveProofResponse>(
      'proveCircuitN1Over',
      { circuitId, previousProofId, witness },
      signal
    );
  }

  proveCircuitN2Over(
    circuitId: number,
    firstProofId: number,
    secondProofId: number,
    witness: string[],
    signal?: AbortSignal
  ) {
    return this.#executeAsync<RecursiveN2ProofResponse>(
      'proveCircuitN2Over',
      { circuitId, firstProofId, secondProofId, witness },
      signal
    );
  }

  verifyProof(appState: string[], proof: RustPicklesJsonProof, signal?: AbortSignal) {
    return this.#executeAsync<{ valid: boolean; reason?: string }>(
      'verifyProof',
      { appState, proof },
      signal
    );
  }

  verifyRecursiveProof(
    result: RecursiveProofResponse | RecursiveN2ProofResponse,
    signal?: AbortSignal
  ) {
    return this.#executeAsync<{ valid: boolean; reason?: string }>(
      'verifyRecursiveProof',
      {
        appState: result.appState,
        proof: result.proof,
        challengePolynomialCommitments:
          'challengePolynomialCommitment' in result
            ? [result.challengePolynomialCommitment]
            : result.challengePolynomialCommitments,
        oldBulletproofChallenges:
          'challengePolynomialCommitment' in result
            ? [result.oldBulletproofChallenges]
            : result.oldBulletproofChallenges,
        dlogPlonkIndex: result.dlogPlonkIndex,
      },
      signal
    );
  }

  executeOperation<T>(operation: string, input?: unknown, signal?: AbortSignal) {
    return this.#executeAsync<T>(operation, input, signal);
  }

  dropCircuit(circuitId: number) {
    // Inline enum fields keep Rust's snake_case spelling in serde; named
    // request structs use camelCase.
    return this.#execute<undefined>('dropCircuit', { circuit_id: circuitId });
  }

  dropProof(proofId: number) {
    return this.#execute<undefined>('dropProof', { proof_id: proofId });
  }

  #execute<T>(operation: string, input?: unknown): T {
    return unwrap<T>(this.#transport.execute(request(operation, input)));
  }

  async #executeAsync<T>(operation: string, input?: unknown, signal?: AbortSignal): Promise<T> {
    return unwrap<T>(await this.#transport.executeAsync(request(operation, input), signal));
  }
}

function request(operation: string, input?: unknown) {
  return JSON.stringify({
    version: 1,
    payload: input === undefined ? { operation } : { operation, input },
  });
}

function unwrap<T>(json: string): T {
  let response = parseJson<Versioned<WireSuccess<{ operation: string; output: T }> | WireFailure>>(
    json,
    'backend response'
  );
  if (response.version !== 1) {
    throw Error(`Unsupported mina-rust response version ${response.version}.`);
  }
  if (response.payload.status === 'error') {
    let { code, message } = response.payload.value;
    throw Error(`mina-rust ${code}: ${message}`);
  }
  return response.payload.value.output;
}

function parseJson<T>(json: string, description: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    let reason = error instanceof Error ? ` ${error.message}` : '';
    throw Error(`Invalid mina-rust ${description}: expected JSON.${reason}`);
  }
}
