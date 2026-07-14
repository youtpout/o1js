/** Regular recursive ZkProgram API smoke test over mina-runtime. */
import {
  Cache,
  Field,
  SelfProof,
  ZkProgram,
  setBackend,
  setProofSystemBackend,
  verify,
} from '../index.js';

setBackend('native');
setProofSystemBackend('rust');

const Program = ZkProgram({
  name: 'MinaRuntimeRegularApiN1',
  publicInput: Field,
  publicOutput: Field,
  methods: {
    base: {
      privateInputs: [Field],
      async method(publicInput: Field, value: Field) {
        publicInput.assertEquals(0);
        return { publicOutput: value };
      },
    },
    step: {
      privateInputs: [SelfProof, Field],
      async method(publicInput: Field, earlier: SelfProof<Field, Field>, increment: Field) {
        earlier.verify();
        earlier.publicOutput.add(increment).assertEquals(publicInput);
        return { publicOutput: publicInput };
      },
    },
  },
});

let { verificationKey } = await Program.compile({ cache: Cache.None });
if (!verificationKey.data.startsWith('mina-runtime-v1:')) {
  throw Error('regular recursive compile did not return a mina-runtime verification key');
}

let { proof: base } = await Program.base(Field(0), Field(3));
if (!(await Program.verify(base))) throw Error('regular mina-runtime base proof was rejected');

let restoredBase = await Program.Proof.fromJSON(base.toJSON());
let rejectedSerializedContinuation = false;
try {
  await Program.step(Field(5), restoredBase, Field(2));
} catch (error) {
  rejectedSerializedContinuation = String(error).includes('cannot continue this recursive chain');
}
if (!rejectedSerializedContinuation) {
  throw Error('serialized base proof unexpectedly retained native recursive continuation state');
}

let { proof: recursive } = await Program.step(Field(5), base, Field(2));
if (!(await Program.verify(recursive))) {
  throw Error('regular mina-runtime recursive proof was rejected');
}

let { proof: secondRecursive } = await Program.step(Field(8), recursive, Field(3));
if (!(await Program.verify(secondRecursive))) {
  throw Error('regular mina-runtime chained recursive proof was rejected');
}

let json = secondRecursive.toJSON();
if (!(await verify(json, verificationKey))) {
  throw Error('global verify() rejected a serialized recursive mina-runtime proof');
}
let restored = await Program.Proof.fromJSON(json);
if (!(await Program.verify(restored))) {
  throw Error('serialized recursive mina-runtime proof was rejected');
}

let tampered = await Program.Proof.fromJSON({ ...json, publicOutput: ['6'] });
if (await Program.verify(tampered)) {
  throw Error('tampered recursive mina-runtime proof was accepted');
}

Program.dispose();
console.log('regular recursive ZkProgram base/N1/verify/JSON via mina-runtime: OK');
