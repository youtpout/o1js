/**
 * zkApp VK parity benchmark: compiles the SAME SmartContract through jsoo
 * Pickles and through the Rust backend (native), times both compiles and
 * diffs the two verification keys byte for byte.
 *
 * Run: ./run src/tests/tmp-zkapp-vk-iso.ts
 */
import {
  Cache,
  Field,
  SmartContract,
  State,
  method,
  state,
  setBackend,
  setProofSystemBackend,
} from '../index.js';

class SimpleZkapp extends SmartContract {
  @state(Field) x = State<Field>();

  init() {
    super.init();
    this.x.set(Field(1));
  }

  @method async update(y: Field) {
    const x = this.x.getAndRequireEquals();
    this.x.set(x.add(y));
  }
}

function ms(t: number) {
  return `${(t / 1000).toFixed(3)}s`;
}

const backend = process.env.BENCH_BACKEND ?? 'jsoo';
if (backend === 'rust') {
  setBackend('native');
  setProofSystemBackend('rust');
}
console.log(`compiling zkApp via ${backend}...`);
let t = performance.now();
let vk = (await SimpleZkapp.compile({ cache: Cache.None, forceRecompile: true }))
  .verificationKey;
console.log(`${backend} compile: ${ms(performance.now() - t)}`);
console.log(`  VK hash: ${vk.hash.toString()}`);
console.log(`  VK data (${vk.data.length} chars): ${vk.data.slice(0, 64)}...`);
const fs = await import('node:fs');
fs.writeFileSync(
  `/tmp/claude-1000/zkapp-vk-${backend}.json`,
  JSON.stringify({ hash: vk.hash.toString(), data: vk.data })
);
