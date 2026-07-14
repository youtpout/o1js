import { expect } from 'expect';
import { describe, it } from 'node:test';
import { MinaRuntimeClient, type MinaRuntimeTransport } from './backend.js';

function transport(
  execute: (request: any) => unknown = () => ({ operation: 'getInfo', output: {} })
): MinaRuntimeTransport {
  let run = (request: string) =>
    JSON.stringify({
      version: 1,
      payload: { status: 'ok', value: execute(JSON.parse(request).payload) },
    });
  return {
    info: JSON.stringify({
      backendApiVersion: 1,
      wireFormatVersion: 1,
      minaRustVersion: 'test',
      proofSystem: 'proof-systems/pickle-rs',
      capabilities: [],
    }),
    execute: run,
    executeAsync: async (request) => run(request),
  };
}

describe('MinaRuntimeClient', () => {
  it('sends the versioned compile contract without translation', async () => {
    let seen: unknown;
    let client = new MinaRuntimeClient(
      transport((request) => {
        seen = request;
        return {
          operation: 'circuitCompiled',
          output: {
            circuitId: 7,
            circuitDigest: 'abc',
            witnessSize: 0,
            publicOutputSize: 0,
          },
        };
      })
    );
    let circuit = { aux_count: 0, output: [], constraints: [] };

    expect(client.compileCircuit(circuit)).toMatchObject({ circuitId: 7 });
    expect(seen).toEqual({ operation: 'compileCircuit', input: { circuit } });
  });

  it('rejects incompatible wire versions before executing requests', () => {
    let incompatible = {
      ...transport(),
      info: JSON.stringify({
        backendApiVersion: 2,
        wireFormatVersion: 1,
        minaRustVersion: 'test',
        proofSystem: 'test',
        capabilities: [],
      }),
    };
    expect(() => new MinaRuntimeClient(incompatible)).toThrow('requires 1/1');
  });

  it('turns structured backend failures into stable JavaScript errors', async () => {
    let failing = transport();
    failing.executeAsync = async () =>
      JSON.stringify({
        version: 1,
        payload: {
          status: 'error',
          value: { code: 'resourceNotFound', message: 'missing circuit' },
        },
      });
    let client = new MinaRuntimeClient(failing);

    await expect(client.proveCircuit(99, [])).rejects.toThrow(
      'mina-rust resourceNotFound: missing circuit'
    );
  });

  it('preserves the recursive proof resource contract on the wire', async () => {
    let seen: unknown[] = [];
    let client = new MinaRuntimeClient(
      transport((request) => {
        seen.push(request);
        return { operation: request.operation, output: { valid: true } };
      })
    );
    let proof = {
      version: 1 as const,
      statement: [],
      wrap_wire_proof_base64: '',
      side_loaded_verification_key_base58: '1',
    };
    let recursive = {
      proofId: 10,
      appState: ['3'],
      proof,
      challengePolynomialCommitment: ['4', '5'] as [string, string],
      oldBulletproofChallenges: ['6'],
      dlogPlonkIndex: [['7', '8']] as [string, string][],
    };
    let recursiveN2 = {
      appState: ['9'],
      proof,
      challengePolynomialCommitments: [
        ['10', '11'],
        ['12', '13'],
      ] as [string, string][],
      oldBulletproofChallenges: [['14'], ['15']],
      dlogPlonkIndex: [['16', '17']] as [string, string][],
    };

    await client.proveCircuitKeep(2, ['3']);
    await client.proveCircuitN1Over(4, 9, ['5']);
    await client.proveCircuitN2Over(6, 9, 10, ['7']);
    await client.verifyRecursiveProof(recursive);
    await client.verifyRecursiveProof(recursiveN2);
    client.dropProof(9);

    expect(seen).toEqual([
      { operation: 'proveCircuitKeep', input: { circuitId: 2, witness: ['3'] } },
      {
        operation: 'proveCircuitN1Over',
        input: { circuitId: 4, previousProofId: 9, witness: ['5'] },
      },
      {
        operation: 'proveCircuitN2Over',
        input: { circuitId: 6, firstProofId: 9, secondProofId: 10, witness: ['7'] },
      },
      {
        operation: 'verifyRecursiveProof',
        input: {
          appState: ['3'],
          proof,
          challengePolynomialCommitments: [['4', '5']],
          oldBulletproofChallenges: [['6']],
          dlogPlonkIndex: [['7', '8']],
        },
      },
      {
        operation: 'verifyRecursiveProof',
        input: {
          appState: ['9'],
          proof,
          challengePolynomialCommitments: [
            ['10', '11'],
            ['12', '13'],
          ],
          oldBulletproofChallenges: [['14'], ['15']],
          dlogPlonkIndex: [['16', '17']],
        },
      },
      { operation: 'dropProof', input: { proof_id: 9 } },
    ]);
  });
});
