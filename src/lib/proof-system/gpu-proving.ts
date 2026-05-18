export { setGpuProver, getGpuProver, clearGpuProver };
export type { GpuProver, GpuProverContext };

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
};

type GpuProver = ((context: GpuProverContext) => Promise<unknown>) | undefined;

let gpuProver: GpuProver;

function setGpuProver(prover: GpuProver) {
  gpuProver = prover;
}

function getGpuProver() {
  return gpuProver;
}

function clearGpuProver() {
  gpuProver = undefined;
}
