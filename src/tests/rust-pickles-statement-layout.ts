/**
 * Ground-truth check of the Mina wrap-statement layout: proves a minimal
 * ZkProgram through jsoo Pickles, decodes the resulting side-loaded proof
 * with the Rust bin_prot codec, and reports the flattened statement's shape
 * (slot count, IPA rounds, message shapes) against the 40-slot layout the
 * Rust port targets.
 *
 * Run: ./run src/tests/rust-pickles-statement-layout.ts
 */
import { Field, Provable, ZkProgram } from '../index.js';

const Program = ZkProgram({
  name: 'RustPicklesStatementLayout',
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

let { default: native } = await import('../native/native.js');
let decode = (native as any)?.rust_pickles_decode_mina_proof_base64 as
  | ((base64: string) => string)
  | undefined;
if (!decode) throw Error('@o1js/native does not expose rust_pickles_decode_mina_proof_base64');

console.log('compiling + proving via jsoo Pickles...');
let t0 = Date.now();
await Program.compile();
let { proof } = await Program.compute();
console.log(`jsoo compile+prove in ${Date.now() - t0}ms`);

let json = proof.toJSON();
let decoded = JSON.parse(decode(json.proof)) as {
  statement: string[];
  wrapIpaRounds: number;
  messagesForNextWrap: { oldBulletproofChallenges: number[] };
  messagesForNextStep: {
    challengePolynomialCommitments: number;
    oldBulletproofChallenges: number[];
  };
};

console.log('\n=== jsoo proof structure (via Rust codec) ===');
console.log(`  statement slots: ${decoded.statement.length}`);
console.log(`  wrap IPA rounds: ${decoded.wrapIpaRounds}`);
console.log(`  next-wrap old challenges: ${JSON.stringify(decoded.messagesForNextWrap.oldBulletproofChallenges)}`);
console.log(`  next-step: ${decoded.messagesForNextStep.challengePolynomialCommitments} commitments, challenges ${JSON.stringify(decoded.messagesForNextStep.oldBulletproofChallenges)}`);

// classify the slots against the documented 40-slot layout
const p = 28948022309329048855892746252171976963363056481941560715954676764349967630337n; // Fq modulus? (Pallas base = Fp; wrap statement over Fq)
let s = decoded.statement.map(BigInt);
function show(i: number, label: string) {
  let v = s[i];
  let compact = v < 2n ** 130n ? v.toString(16) : '0x' + v.toString(16).slice(0, 10) + '…';
  console.log(`  [${String(i).padStart(2)}] ${label}: ${compact}`);
}
if (s.length === 40) {
  const labels = [
    'cip', 'b', 'zeta_to_srs_length', 'zeta_to_domain_size', 'perm',
    'beta', 'gamma', 'alpha', 'zeta', 'xi',
    'sponge_digest', 'msgs_next_wrap', 'msgs_next_step',
    ...Array.from({ length: 16 }, (_, i) => `bp[${i}]`),
    'branch_data',
    ...Array.from({ length: 8 }, (_, i) => `flag[${i}]`),
    'joint_combiner_flag', 'joint_combiner',
  ];
  console.log('\n=== slot classification (assumed layout) ===');
  labels.forEach((label, i) => show(i, label));
} else {
  console.log('\nstatement is not 40 slots — dump:');
  s.forEach((v, i) => console.log(`  [${i}] ${v.toString(16).slice(0, 12)}…`));
}
