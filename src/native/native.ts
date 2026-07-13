import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { platform, arch } = process;
const slug = `@o1js/native-${platform}-${arch}`;

type MinaRuntimeConstructor = new (maxResources?: number) => {
  execute(request: string): string;
  executeAsync(request: string, signal?: AbortSignal): Promise<string>;
  readonly info: string;
};

export default (() => {
  try {
    return require(slug);
  } catch (e) {
    if (process.env.O1JS_REQUIRE_NATIVE_BINDINGS) {
      throw e;
    }
  }
})();

/**
 * Loads mina-rust's high-level o1js adapter. Development builds can point at a
 * local `.node` file with `O1JS_MINA_RUNTIME_PATH`; published packages use
 * the platform-specific optional dependency.
 */
export function createMinaRuntime(maxResources = 64) {
  let modulePath = process.env.O1JS_MINA_RUNTIME_PATH;
  let minaRuntimeSlug = `@o1js/mina-runtime-${platform}-${arch}`;
  let binding: { MinaRuntime?: MinaRuntimeConstructor };
  try {
    binding = require(modulePath ?? minaRuntimeSlug);
  } catch (error) {
    let reason = error instanceof Error ? ` ${error.message}` : '';
    throw Error(
      `Rust proof-system backend requested, but mina-rust NAPI could not be loaded from '${
        modulePath ?? minaRuntimeSlug
      }'. Build mina-runtime-napi or set O1JS_MINA_RUNTIME_PATH.${reason}`
    );
  }
  if (typeof binding.MinaRuntime !== 'function') {
    throw Error('mina-runtime NAPI does not export MinaRuntime; rebuild the adapter package.');
  }
  return new binding.MinaRuntime(maxResources);
}
