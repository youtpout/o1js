export {
  getBackendPreference,
  getProofSystemBackend,
  lockBackend,
  lockProofSystemBackend,
  setBackend,
  setProofSystemBackend,
};
export type { Backend, ProofSystemBackend };

type Backend = 'wasm' | 'native';
type ProofSystemBackend = 'jsoo' | 'rust' | 'compare';

let locked = false;
let proofSystemLocked = false;

// eagerly set the backend preference from env var so that
// node_backend.js (which reads globalThis directly) picks it up
if ((globalThis as any).__o1js_backend_preference === undefined) {
  let env = getBackendFromEnv();
  if (env !== undefined) {
    (globalThis as any).__o1js_backend_preference = env;
  }
}

if ((globalThis as any).__o1js_proof_system_backend === undefined) {
  let env = getProofSystemBackendFromEnv();
  if (env !== undefined) {
    (globalThis as any).__o1js_proof_system_backend = env;
  }
}

/**
 * Set the backend to use for cryptographic operations such as proving.
 *
 * Must be called **before** `initializeBindings()`. The default backend is `'wasm'`.
 *
 * _Note:_ In browser environments, only the 'wasm' backend is available.
 * Attempting to set the backend to 'native' in such environments will result in a no-op with a console warning.
 *
 * @example
 * ```ts
 * import { setBackend, initializeBindings } from 'o1js';
 *
 * setBackend('native');
 *
 * // must be called after setBackend, most of the o1js functions do this internally
 * await initializeBindings();
 * ```
 */
function setBackend(backend: Backend) {
  if (locked) {
    throw new Error(
      'setBackend() must be called before initializeBindings(). ' +
        'The backend has already been locked in!'
    );
  }
  if (backend !== 'wasm' && backend !== 'native') {
    throw new Error(`Invalid backend '${backend}'. Must be 'wasm' or 'native'.`);
  }
  if (backend === 'native' && typeof window !== 'undefined') {
    console.error(
      "No-op: `setBackend()`:The native backend is not available in the browser. Only 'wasm' is supported. Falling back to 'wasm' backend."
    );
    (globalThis as any).__o1js_backend_preference = 'wasm';
  }
  (globalThis as any).__o1js_backend_preference = backend;
}
/**
 * Retrieve the currently set backend preference.
 * @returns The backend preference, either 'wasm' or 'native'.
 */
function getBackendPreference(): Backend {
  return (globalThis as any).__o1js_backend_preference ?? 'wasm';
}

/**
 * Selects the implementation used by ZkProgram and SmartContract proving.
 * This is independent from {@link setBackend}: `native`/`wasm` chooses the
 * transport, while `jsoo`/`rust` chooses the Pickles implementation.
 *
 * `compare` executes the canonical jsoo path and additionally asks the Rust
 * backend for deterministic artifacts when a parity hook is installed.
 */
function setProofSystemBackend(backend: ProofSystemBackend) {
  if (proofSystemLocked) {
    throw Error(
      'setProofSystemBackend() must be called before the first ZkProgram compilation. ' +
        'The proof-system backend has already been locked in!'
    );
  }
  if (backend !== 'jsoo' && backend !== 'rust' && backend !== 'compare') {
    throw Error(`Invalid proof-system backend '${backend}'. Must be 'jsoo', 'rust', or 'compare'.`);
  }
  (globalThis as any).__o1js_proof_system_backend = backend;
}

function getProofSystemBackend(): ProofSystemBackend {
  return (globalThis as any).__o1js_proof_system_backend ?? 'jsoo';
}

function getBackendFromEnv(): Backend | undefined {
  let value = typeof process !== 'undefined' ? process.env.O1JS_BACKEND : undefined;
  if (value === 'wasm' || value === 'native') return value;
  return undefined;
}

function getProofSystemBackendFromEnv(): ProofSystemBackend | undefined {
  let value = typeof process !== 'undefined' ? process.env.O1JS_PROOF_SYSTEM : undefined;
  if (value === 'jsoo' || value === 'rust' || value === 'compare') return value;
  return undefined;
}

function lockBackend() {
  locked = true;
}

function lockProofSystemBackend() {
  proofSystemLocked = true;
}
