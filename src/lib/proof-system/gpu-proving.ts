export {
  setGpuProver,
  getGpuProver,
  clearGpuProver,
  setGpuMsmRunner,
  getGpuMsmRunner,
  clearGpuMsmRunner,
  isGpuProvingEnabled,
  runGpuMsm,
  withGpuProvingScope,
};
export type { GpuProver, GpuProverContext, GpuMsmRunner, GpuMsmContext };

type GpuProverContext = {
  prover: unknown;
  lazyProof: unknown;
  proverData: {
    transaction: unknown;
    accountUpdate: unknown;
    index: number;
  };
  publicInput: unknown;
  publicInputFields: unknown;
  cpuFallback: () => Promise<unknown>;
};

type GpuMsmContext = {
  curve: 'pallas' | 'vesta' | 'unknown';
  msmKind: string;
  scalars?: bigint[];
  points?: ({ x: bigint; y: bigint } | null)[];
  metadata?: Record<string, unknown>;
  cpuFallback?: () => Promise<unknown>;
};

type GpuProver = ((context: GpuProverContext) => Promise<unknown>) | undefined;
type GpuMsmRunner = ((context: GpuMsmContext) => Promise<unknown>) | undefined;

let gpuProver: GpuProver;
let gpuMsmRunner: GpuMsmRunner;
let gpuProvingScopeDepth = 0;

type GpuProvingGlobals = typeof globalThis & {
  __o1js_gpu_prover?: GpuProver;
  __o1js_gpu_msm_runner?: GpuMsmRunner;
  __o1js_is_gpu_proving_enabled?: () => boolean;
};

let gpuGlobals = globalThis as GpuProvingGlobals;
gpuGlobals.__o1js_is_gpu_proving_enabled = () => gpuProvingScopeDepth > 0;

function setGpuProver(prover: GpuProver) {
  gpuProver = prover;
  gpuGlobals.__o1js_gpu_prover = prover;
}

function getGpuProver() {
  return gpuProver;
}

function clearGpuProver() {
  gpuProver = undefined;
  gpuGlobals.__o1js_gpu_prover = undefined;
}

function setGpuMsmRunner(runner: GpuMsmRunner) {
  gpuMsmRunner = runner;
  gpuGlobals.__o1js_gpu_msm_runner = runner;
}

function getGpuMsmRunner() {
  return gpuMsmRunner;
}

function clearGpuMsmRunner() {
  gpuMsmRunner = undefined;
  gpuGlobals.__o1js_gpu_msm_runner = undefined;
}

function isGpuProvingEnabled() {
  return gpuProvingScopeDepth > 0;
}

async function runGpuMsm(context: GpuMsmContext) {
  if (!isGpuProvingEnabled()) return undefined;
  let runner = getGpuMsmRunner();
  if (runner === undefined) return undefined;
  return await runner(context);
}

async function withGpuProvingScope<T>(enabled: boolean, fn: () => Promise<T> | T): Promise<T> {
  if (!enabled) return await fn();
  gpuProvingScopeDepth += 1;
  try {
    return await fn();
  } finally {
    gpuProvingScopeDepth -= 1;
  }
}
