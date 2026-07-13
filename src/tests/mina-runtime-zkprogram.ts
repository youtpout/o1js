/** Regular ZkProgram API smoke test over mina-runtime (no experimental calls). */
import { Cache, Field, ZkProgram, setBackend, setProofSystemBackend, verify } from '../index.js';

setBackend('native');
setProofSystemBackend('rust');

const Program = ZkProgram({
  name: 'MinaRuntimeRegularApi',
  publicInput: Field,
  publicOutput: Field,
  methods: {
    multiply: {
      privateInputs: [Field],
      async method(publicInput: Field, privateInput: Field) {
        let publicOutput = publicInput.mul(privateInput);
        publicOutput.assertEquals(20);
        return { publicOutput };
      },
    },
  },
});

let { verificationKey } = await Program.compile({ cache: Cache.None });
if (!verificationKey.data.startsWith('mina-runtime-v1:')) {
  throw Error('regular compile did not return a mina-runtime verification key');
}

let { proof } = await Program.multiply(Field(4), Field(5));
if (!(await Program.verify(proof))) throw Error('regular mina-runtime proof was rejected');

let json = proof.toJSON();
if (!(await verify(json, verificationKey))) {
  throw Error('global verify() rejected a serialized mina-runtime proof');
}
let restored = await Program.Proof.fromJSON(json);
if (!(await Program.verify(restored))) {
  throw Error('serialized mina-runtime proof was rejected');
}

let tampered = await Program.Proof.fromJSON({ ...json, publicOutput: ['21'] });
if (await Program.verify(tampered)) throw Error('tampered mina-runtime proof was accepted');

Program.dispose();
console.log('regular ZkProgram compile/prove/verify/JSON via mina-runtime: OK');
