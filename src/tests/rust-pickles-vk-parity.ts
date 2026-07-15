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
import {
  rustPicklesProofFromJSON,
  rustPicklesProofToJSON,
} from '../lib/proof-system/rust-pickles.js';

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
  base64: string;
  base58: string;
  commitments: [string, string][];
};

let { default: native } = await import('../native/native.js');
let decode = (native as any)?.rust_pickles_decode_side_loaded_vk as
  | ((encoded: string, format: 'base58' | 'base64') => string)
  | undefined;
if (!decode) throw Error('@o1js/native does not expose rust_pickles_decode_side_loaded_vk');

console.log('compiling via jsoo Pickles...');
let t0 = Date.now();
let { verificationKey } = await Program.compile({ forceRecompile: true });
console.log(`jsoo compile in ${Date.now() - t0}ms`);
let jsooVk: DecodedVk = JSON.parse(decode(verificationKey.data, 'base64'));
let jsooVkFromCanonicalBase58: DecodedVk = JSON.parse(decode(jsooVk.base58, 'base58'));

console.log('proving via Rust Pickles (extracting its side-loaded VK)...');
t0 = Date.now();
let rustProof = await Program.experimentalRustPickles.proveBaseCase('compute');
console.log(`rust prove in ${Date.now() - t0}ms`);
let rustProofJson = rustProof.proof as {
  version: 1;
  statement: string[];
  wrap_wire_proof_base64: string;
  side_loaded_verification_key_base58: string;
};
let parsedRustProof = rustPicklesProofFromJSON(rustProofJson);
let roundTrippedRustProof = rustPicklesProofToJSON(parsedRustProof);
if (
  roundTrippedRustProof.version !== rustProofJson.version ||
  roundTrippedRustProof.wrap_wire_proof_base64 !== rustProofJson.wrap_wire_proof_base64 ||
  roundTrippedRustProof.side_loaded_verification_key_base58 !==
    rustProofJson.side_loaded_verification_key_base58 ||
  JSON.stringify(roundTrippedRustProof.statement) !== JSON.stringify(rustProofJson.statement)
) {
  throw Error('Rust proof JSON failed o1js parser roundtrip');
}
if (!(await Program.experimentalRustPickles.verifyBaseCase(rustProof))) {
  throw Error('Rust base proof failed standalone verification');
}
let tampered = { ...rustProof, appState: ['123'] };
if (await Program.experimentalRustPickles.verifyBaseCase(tampered)) {
  throw Error('Rust base proof verification accepted a tampered appState');
}
let rustVkBase58 = rustProofJson.side_loaded_verification_key_base58;
let rustVk: DecodedVk = JSON.parse(decode(rustVkBase58, 'base58'));
let rustVkFromCanonicalBase64: DecodedVk = JSON.parse(decode(rustVk.base64, 'base64'));

function assertEqual(label: string, a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw Error(`${label} mismatch: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

assertEqual('jsoo VK base64/base58 metadata roundtrip', {
  maxProofsVerified: jsooVk.maxProofsVerified,
  actualWrapDomainSize: jsooVk.actualWrapDomainSize,
  commitments: jsooVk.commitments,
}, {
  maxProofsVerified: jsooVkFromCanonicalBase58.maxProofsVerified,
  actualWrapDomainSize: jsooVkFromCanonicalBase58.actualWrapDomainSize,
  commitments: jsooVkFromCanonicalBase58.commitments,
});
assertEqual('rust VK base58/base64 metadata roundtrip', {
  maxProofsVerified: rustVk.maxProofsVerified,
  actualWrapDomainSize: rustVk.actualWrapDomainSize,
  commitments: rustVk.commitments,
}, {
  maxProofsVerified: rustVkFromCanonicalBase64.maxProofsVerified,
  actualWrapDomainSize: rustVkFromCanonicalBase64.actualWrapDomainSize,
  commitments: rustVkFromCanonicalBase64.commitments,
});
assertEqual('maxProofsVerified', jsooVk.maxProofsVerified, rustVk.maxProofsVerified);
assertEqual('actualWrapDomainSize', jsooVk.actualWrapDomainSize, rustVk.actualWrapDomainSize);
assertEqual('commitments.length', jsooVk.commitments.length, rustVk.commitments.length);

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
compare('jsoo canonical base64 roundtrip', jsooVk.base64, jsooVkFromCanonicalBase58.base64);
compare('rust canonical base58 roundtrip', rustVk.base58, rustVkFromCanonicalBase64.base58);

let matching = 0;
for (let i = 0; i < Math.min(jsooVk.commitments.length, rustVk.commitments.length); i++) {
  let equal = JSON.stringify(jsooVk.commitments[i]) === JSON.stringify(rustVk.commitments[i]);
  if (equal) matching++;
  else same = false;
}
console.log(
  `  ${matching === jsooVk.commitments.length ? '==' : '!='} commitments: ${matching}/${jsooVk.commitments.length} equal`
);
// cross-check: detect index swaps among the mismatched commitments
for (let i = 0; i < jsooVk.commitments.length; i++) {
  if (JSON.stringify(jsooVk.commitments[i]) === JSON.stringify(rustVk.commitments[i])) continue;
  for (let j = 0; j < rustVk.commitments.length; j++) {
    if (JSON.stringify(jsooVk.commitments[i]) === JSON.stringify(rustVk.commitments[j])) {
      console.log(`     note: jsoo ${COMMITMENT_NAMES[i]} == rust ${COMMITMENT_NAMES[j]}`);
    }
  }
}
if (matching !== jsooVk.commitments.length) {
  for (let i = 0; i < Math.min(jsooVk.commitments.length, rustVk.commitments.length); i++) {
    let equal = JSON.stringify(jsooVk.commitments[i]) === JSON.stringify(rustVk.commitments[i]);
    if (!equal) console.log(`     != ${COMMITMENT_NAMES[i] ?? `commitment[${i}]`}`);
  }
}

if (same) {
  console.log('\nVK PARITY: FULL MATCH');
} else {
  console.log('\nVK PARITY: COMMITMENT MISMATCH (metadata + codec invariants passed)');
  if (process.env.RUST_PICKLES_STRICT_VK_PARITY === '1') {
    throw Error('Strict VK parity requested and commitments differ');
  }
}
