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
});
