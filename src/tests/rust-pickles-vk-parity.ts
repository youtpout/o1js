/**
 * Verification-key parity report: compiles the same ZkProgram method through
 * jsoo Pickles (`Program.compile`) and through the direct Rust Pickles path,
 * decodes both side-loaded verification keys with the Rust codec, and diffs
 * them field by field. This is the on-chain compatibility criterion for the
 * Rust backend: a Rust proof is network-acceptable once the two keys agree.
 *
 * Run: ./run src/tests/rust-pickles-vk-parity.ts
 */
import { Field, Provable, ZkProgram } from '../index.js';

const Program = ZkProgram({
  name: 'RustPicklesVkParity',
  publicOutput: Field,
  methods: {
    compute: {
      privateInputs: [],
      async method() {
        let x = Provable.witness(Field, () => Field(3));
        let out = x.mul(x);
        out.assertEquals(x.square());
        return { publicOutput: out };
      },
    },
  },
});

type DecodedVk = {
  maxProofsVerified: number;
  actualWrapDomainSize: number;
  commitments: [string, string][];
};

let { default: native } = await import('../native/native.js');
let decode = (native as any)?.rust_pickles_decode_side_loaded_vk as
  | ((encoded: string, format: 'base58' | 'base64') => string)
  | undefined;
if (!decode) throw Error('@o1js/native does not expose rust_pickles_decode_side_loaded_vk');

console.log('compiling via jsoo Pickles...');
let t0 = Date.now();
let { verificationKey } = await Program.compile();
console.log(`jsoo compile in ${Date.now() - t0}ms`);
let jsooVk: DecodedVk = JSON.parse(decode(verificationKey.data, 'base64'));

console.log('proving via Rust Pickles (extracting its side-loaded VK)...');
t0 = Date.now();
let rustProof = await Program.experimentalRustPickles.proveBaseCase('compute');
console.log(`rust prove in ${Date.now() - t0}ms`);
let rustVkBase58 = (rustProof.proof as { side_loaded_verification_key_base58: string })
  .side_loaded_verification_key_base58;
let rustVk: DecodedVk = JSON.parse(decode(rustVkBase58, 'base58'));

// -- report ------------------------------------------------------------

const COMMITMENT_NAMES = [
  ...Array.from({ length: 7 }, (_, i) => `sigma[${i}]`),
  ...Array.from({ length: 15 }, (_, i) => `coefficients[${i}]`),
  'generic',
  'psm',
  'complete_add',
  'mul',
  'emul',
  'endomul_scalar',
];

console.log('\n=== VK parity report (jsoo vs rust) ===');
let same = true;
function compare(label: string, a: unknown, b: unknown) {
  let equal = JSON.stringify(a) === JSON.stringify(b);
  if (!equal) same = false;
  console.log(`${equal ? '  ==' : '  !='} ${label}: jsoo=${JSON.stringify(a)} rust=${JSON.stringify(b)}`);
}
compare('maxProofsVerified', jsooVk.maxProofsVerified, rustVk.maxProofsVerified);
compare('actualWrapDomainSize', jsooVk.actualWrapDomainSize, rustVk.actualWrapDomainSize);
compare('commitments.length', jsooVk.commitments.length, rustVk.commitments.length);

let matching = 0;
for (let i = 0; i < Math.min(jsooVk.commitments.length, rustVk.commitments.length); i++) {
  let equal = JSON.stringify(jsooVk.commitments[i]) === JSON.stringify(rustVk.commitments[i]);
  if (equal) matching++;
  else same = false;
}
console.log(
  `  ${matching === jsooVk.commitments.length ? '==' : '!='} commitments: ${matching}/${jsooVk.commitments.length} equal`
);
if (matching !== jsooVk.commitments.length) {
  for (let i = 0; i < Math.min(jsooVk.commitments.length, rustVk.commitments.length); i++) {
    let equal = JSON.stringify(jsooVk.commitments[i]) === JSON.stringify(rustVk.commitments[i]);
    if (!equal) console.log(`     != ${COMMITMENT_NAMES[i] ?? `commitment[${i}]`}`);
  }
}

console.log(same ? '\nVK PARITY: FULL MATCH' : '\nVK PARITY: MISMATCH (expected while wrap_main layout differs)');
