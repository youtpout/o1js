import {
  rustPicklesProofFromJSON,
  rustPicklesProofFromJSONString,
  rustPicklesProofToJSON,
  rustPicklesProofToJSONString,
  type RustPicklesJsonProof,
} from './rust-pickles';

const jsonProof: RustPicklesJsonProof = {
  version: 1,
  statement: ['0', '1', '123456789012345678901234567890'],
  wrap_wire_proof_base64: 'AQIDBA==',
  side_loaded_verification_key_base58: 'zCn74ATqgFmWy2ZRcMCw3Abss4TU1z52p57NMP31kxFbaLryxEj7',
};

test('Rust Pickles proof JSON round-trips', () => {
  let proof = rustPicklesProofFromJSON(jsonProof);
  expect(proof).toEqual({
    statement: jsonProof.statement,
    wrapWireProofBase64: jsonProof.wrap_wire_proof_base64,
    sideLoadedVerificationKeyBase58: jsonProof.side_loaded_verification_key_base58,
  });
  expect(rustPicklesProofToJSON(proof)).toEqual(jsonProof);

  let jsonString = rustPicklesProofToJSONString(proof);
  expect(rustPicklesProofFromJSONString(jsonString)).toEqual(proof);
});

test('Rust Pickles proof JSON rejects malformed envelopes', () => {
  expect(() => rustPicklesProofFromJSON({ ...jsonProof, version: 2 as 1 })).toThrow(
    'unsupported version'
  );
  expect(() => rustPicklesProofFromJSON({ ...jsonProof, statement: ['01'] })).toThrow(
    'statement[0]'
  );
  expect(() =>
    rustPicklesProofFromJSON({ ...jsonProof, wrap_wire_proof_base64: 'not base64' })
  ).toThrow('standard base64');
  expect(() =>
    rustPicklesProofFromJSON({
      ...jsonProof,
      side_loaded_verification_key_base58: 'contains_0_or_underscore',
    })
  ).toThrow('Base58');
  expect(() => rustPicklesProofFromJSONString('{')).toThrow('expected valid JSON');
});
