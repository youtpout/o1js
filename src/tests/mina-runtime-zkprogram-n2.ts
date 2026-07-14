/** Regular width-2 recursive ZkProgram API smoke test over mina-runtime. */
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
  name: 'MinaRuntimeRegularApiN2',
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
    merge: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        publicInput: Field,
        first: SelfProof<Field, Field>,
        second: SelfProof<Field, Field>
      ) {
        first.verify();
        second.verify();
        first.publicOutput.add(second.publicOutput).assertEquals(publicInput);
        return { publicOutput: publicInput };
      },
    },
  },
});

let { verificationKey } = await Program.compile({ cache: Cache.None });
let { proof: first } = await Program.base(Field(0), Field(3));
let { proof: second } = await Program.base(Field(0), Field(4));
let { proof: merged } = await Program.merge(Field(7), first, second);

if (!(await Program.verify(merged))) throw Error('regular mina-runtime N2 proof was rejected');
let json = merged.toJSON();
if (!(await verify(json, verificationKey))) {
  throw Error('global verify() rejected a serialized mina-runtime N2 proof');
}
let restored = await Program.Proof.fromJSON(json);
if (!(await Program.verify(restored))) {
  throw Error('serialized mina-runtime N2 proof was rejected');
}
let tampered = await Program.Proof.fromJSON({ ...json, publicOutput: ['8'] });
if (await Program.verify(tampered)) throw Error('tampered mina-runtime N2 proof was accepted');

Program.dispose();
console.log('regular width-2 ZkProgram base/base/N2/verify/JSON via mina-runtime: OK');
